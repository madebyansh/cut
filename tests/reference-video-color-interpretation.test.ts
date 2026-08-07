import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import { parseCutLanguage } from "../lib/language/parser";
import { packageSymbol } from "../lib/language/packages";
import { applyCutLock, createCutLock, CutLockError, validateCutLock, type CutLockfile } from "../lib/language/lock";
import { CutProxyLockStateError } from "../lib/language/locked-ir-state";
import { diffCutAVIR } from "../lib/language/semantic-diff";
import { createIncrementalRenderPlan, CutGraphError, finalizeGraphHashes } from "../lib/runtime/graph";
import { inspectCutIr } from "../lib/runtime/inspect";
import { createReferenceAudioCachePlan, createReferenceAudioToolchainIdentity } from "../lib/runtime/reference/audio-cache";
import { referenceMasterAudioRootIds, renderReferenceAudioSelection } from "../lib/runtime/reference/audio";
import {
  ReferenceColorManagementError,
  referenceVideoColorInterpretationContract,
  referenceVideoColorInterpretationWarnings,
  referenceVideoInputColorDeclaration,
} from "../lib/runtime/reference/color-management";
import { runFfmpeg } from "../lib/runtime/reference/ffmpeg";
import { selectReferenceMediaProfile } from "../lib/runtime/reference/media-profile";
import { ReferenceMediaProfileStateError } from "../lib/runtime/reference/media-profile-state";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { referenceVideoInputColorConfig } from "../lib/runtime/reference/video-config";
import { ReferenceVisualRenderer, referenceVideoDecoderColorPlan } from "../lib/runtime/reference/visual";

type Observation = {
  pixelFormat: string;
  fieldOrder: string;
  range?: string;
  matrix?: string;
  transfer?: string;
  primaries?: string;
};

const masterObservation: Observation = { pixelFormat: "yuv420p", fieldOrder: "progressive" };
const proxyObservation: Observation = { pixelFormat: "yuv420p", fieldOrder: "progressive", range: "tv", matrix: "bt470bg" };

function compile(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  return compileCutModule(parsed.module).ir;
}

function observation(value: Observation) {
  const optional = (["range", "matrix", "transfer", "primaries"] as const)
    .flatMap((field) => value[field] === undefined ? [] : [`${field}: ${JSON.stringify(value[field])}`]);
  return `observedVideoColor(pixelFormat: ${JSON.stringify(value.pixelFormat)}, fieldOrder: ${JSON.stringify(value.fieldOrder)}${optional.length ? `, ${optional.join(", ")}` : ""})`;
}

function interpretation(master = masterObservation, proxy?: Observation, profile = "rec709-limited") {
  return `interpretVideoColor(profile: ${JSON.stringify(profile)}, master: ${observation(master)}${proxy ? `, proxy: ${observation(proxy)}` : ""})`;
}

function videoSource(options: { master?: Observation; proxy?: Observation; profile?: string; duplicate?: boolean; locatorProxy?: boolean } = {}) {
  const master = options.master ?? masterObservation, proxy = options.proxy;
  return `cut 0.4;
project "interpreted video";
import { Composite, Video, interpretVideoColor, observedVideoColor } from "cut:visual";
asset source: VideoAsset = video("media/source.mkv"${options.locatorProxy ? ', proxy: "media/proxy.mkv"' : ""});
const observedMaster: ObservedVideoColor = ${observation(master)};
${proxy ? `const observedProxy: ObservedVideoColor = ${observation(proxy)};` : ""}
const color: VideoColorInterpretation = interpretVideoColor(profile: ${JSON.stringify(options.profile ?? "rec709-limited")}, master: observedMaster${proxy ? ", proxy: observedProxy" : ""});
timeline main(duration: 1s, fps: 4, width: 16px, height: 16px, sampleRate: 8khz) {
  scene only(duration: 1s) {
    ${options.duplicate ? "Composite() {" : ""}
    Video(source: source, range: 0s ..< 1s, inputColorInterpretation: color);
    ${options.duplicate ? "Video(source: source, range: 0s ..< 1s, opacity: 50%, inputColorInterpretation: color); }" : ""}
  }
}
export out = render(main);`;
}

function linkedSource(interpreted: boolean) {
  return `cut 0.4;
project "interpreted linked audio";
import { interpretVideoColor, observedVideoColor } from "cut:visual";
import { Clip } from "@cut/edit";
asset source: VideoAsset = video("media/source.mkv");
const color: VideoColorInterpretation = ${interpretation()};
timeline main(duration: 1s, fps: 4, width: 16px, height: 16px, sampleRate: 8khz) {
  scene only(duration: 1s) { Clip(source: source, range: 0s ..< 1s, duration: 1s${interpreted ? ", inputColorInterpretation: color" : ""}); }
}
export out = render(main);`;
}

function pictureClipSource() {
  return `cut 0.4;
project "interpreted picture clip";
import { interpretVideoColor, observedVideoColor } from "cut:visual";
import { PictureClip, PictureTrack, Sequence } from "@cut/edit";
asset source: VideoAsset = video("media/source.mkv");
const color: VideoColorInterpretation = ${interpretation()};
timeline main(duration: 1s, fps: 4, width: 16px, height: 16px, sampleRate: 8khz) {
  scene only(duration: 1s) {
    Sequence(duration: 1s) {
      PictureTrack() {
        PictureClip(source: source, range: 0s ..< 1s, duration: 1s, inputColorInterpretation: color);
      }
    }
  }
}
export out = render(main);`;
}

function audioOnlySource() {
  return `cut 0.4;
project "audio-only profile authority";
import { AudioClip } from "@cut/audio";
asset score: AudioAsset = audio("media/source.mkv");
timeline main(duration: 1s, fps: 4, width: 16px, height: 16px, sampleRate: 8khz) {
  scene only(duration: 1s) { AudioClip(source: score, range: 0s ..< 1s); }
}
export out = render(main);`;
}

function legacyProxySource() {
  return `cut 0.4;
project "legacy proxy authority";
import { Video } from "cut:visual";
asset source: VideoAsset = video("media/source.mkv", proxy: "media/proxy.mkv");
timeline main(duration: 1s, fps: 4, width: 16px, height: 16px, sampleRate: 8khz) {
  scene only(duration: 1s) { Video(source: source, range: 0s ..< 1s); }
}
export out = render(main);`;
}

function operatedSource(master = masterObservation, proxy = proxyObservation) {
  return `cut 0.4;
project "interpreted edit operation";
import { interpretVideoColor, observedVideoColor } from "cut:visual";
import { PictureClip, PictureTrack, Sequence, editClip, replace } from "@cut/edit";
asset source: VideoAsset = video("media/source.mkv", proxy: "media/proxy.mkv");
const color: VideoColorInterpretation = ${interpretation(master, proxy)};
timeline main(duration: 1s, fps: 4, width: 16px, height: 16px, sampleRate: 8khz) {
  scene only(duration: 1s) {
    Sequence(duration: 1s) {
      PictureTrack(sourceDuration: 1s, edits: [
        replace(range: 0s ..< 1s, item: editClip(source: source, range: 0s ..< 1s, duration: 1s, inputColorInterpretation: color))
      ]) { PictureClip(source: source, range: 0s ..< 1s, duration: 1s); }
    }
  }
}
export out = render(main);`;
}

function yuv420Frames(width: number, height: number) {
  const bytes: number[] = [];
  for (let frame = 0; frame < 4; frame += 1) bytes.push(
    ...Array(width * height).fill(100),
    ...Array(width * height / 4).fill(160),
    ...Array(width * height / 4).fill(100),
  );
  return Buffer.from(bytes);
}

async function writeFixture(root: string, name: "source" | "proxy", width: number, tags?: { range: "tv" | "pc"; matrix?: string }) {
  await mkdir(resolve(root, "media"), { recursive: true });
  const raw = resolve(root, "media", `${name}.yuv`), output = resolve(root, "media", `${name}.mkv`);
  await writeFile(raw, yuv420Frames(width, width));
  await runFfmpeg([
    "-y", "-v", "error",
    "-f", "rawvideo", "-pixel_format", "yuv420p", "-video_size", `${width}x${width}`, "-framerate", "4", "-i", raw,
    "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=8000:duration=1",
    "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "libx264", "-crf", "0", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    ...(tags ? ["-color_range", tags.range, ...(tags.matrix ? ["-colorspace", tags.matrix] : [])] : []),
    "-c:a", "pcm_s16le", "-shortest", "-movflags", "write_colr", "-f", "mov", output,
  ]);
}

async function fixtures(root: string, masterTags?: { range: "tv" | "pc"; matrix?: string }, proxyTags: { range: "tv" | "pc"; matrix?: string } = { range: "tv", matrix: "bt470bg" }) {
  await writeFixture(root, "source", 16, masterTags);
  await writeFixture(root, "proxy", 8, proxyTags);
}

async function frame(ir: ReturnType<typeof compile>, root: string, name: string) {
  const { composition } = validateReferenceSession(ir);
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, `.cut/${name}`));
  await renderer.prepare();
  try { return await renderer.sceneFrame(ir.scenes[composition.sceneIds[0]], 0, false); }
  finally { renderer.close(); }
}

function center(surface: { data: Uint8Array; width: number; height: number }) {
  const offset = (Math.floor(surface.height / 2) * surface.width + Math.floor(surface.width / 2)) * 4;
  return [...surface.data.subarray(offset, offset + 4)];
}

test("public helpers are typed, structurally distinguish absence, and fail closed before media work", async () => {
  assert.deepEqual(packageSymbol("cut:visual", "observedVideoColor")?.parameters?.map((item) => [item.name, Boolean(item.optional)]), [
    ["pixelFormat", false], ["fieldOrder", false], ["range", true], ["matrix", true], ["transfer", true], ["primaries", true],
  ]);
  const ir = compile(videoSource());
  const node = Object.values(ir.nodes).find((candidate) => candidate.op === "cut.visual.video")!;
  const declaration = referenceVideoInputColorDeclaration(node);
  assert.equal(declaration.mode, "interpreted");
  if (declaration.mode !== "interpreted") return;
  assert.deepEqual(declaration.interpretation.master, masterObservation);
  assert.equal(Object.hasOwn(declaration.interpretation.master, "matrix"), false, "absence must be an omitted property, not a magic String");
  assert.deepEqual(referenceVideoColorInterpretationContract, {
    id: "cut-video-color-interpretation-v1",
    version: 1,
    authority: "author-declared-unverified",
    profiles: referenceVideoColorInterpretationContract.profiles,
    pixelFormats: ["yuv420p", "yuv422p", "yuv444p"],
    fieldOrder: "progressive",
    absence: "omitted-property",
  });

  const tokenIr = compile(videoSource({ master: { ...masterObservation, matrix: "missing" } }));
  const tokenNode = Object.values(tokenIr.nodes).find((candidate) => candidate.op === "cut.visual.video")!;
  const tokenDeclaration = referenceVideoInputColorDeclaration(tokenNode);
  assert.equal(tokenDeclaration.mode === "interpreted" ? tokenDeclaration.interpretation.master.matrix : undefined, "missing", "a supplied token named missing remains a token");

  const fails = (source: string, code: string) => {
    const parsed = parseCutLanguage(source); assert.ok(parsed.module);
    assert.throws(() => compileCutModule(parsed.module!), (error: unknown) => error instanceof CutCompileError && error.result.diagnostics.some((item) => item.code === code));
  };
  fails(videoSource().replace("inputColorInterpretation: color", 'inputColor: "rec709-limited", inputColorInterpretation: color'), "CUT_COLOR_INPUT_COMBINATION");
  fails(videoSource({ master: { pixelFormat: "yuv420p", fieldOrder: "interlaced", range: "tv" } }), "CUT_COLOR_INTERPRETATION_SCAN");
  fails(videoSource({ profile: "bt470bg-smpte170m-limited", master: { pixelFormat: "yuv420p", fieldOrder: "interlaced", range: "tv", matrix: "bt470bg" } }), "CUT_COLOR_INTERPRETATION_SCAN");
  fails(videoSource({ master: { pixelFormat: "yuv420p10le", fieldOrder: "progressive", range: "tv" } }), "CUT_COLOR_INTERPRETATION_PIXEL_FORMAT");
  fails(videoSource({ master: { pixelFormat: "yuv420p", fieldOrder: "progressive", range: "tv", matrix: "bt709", transfer: "bt709", primaries: "bt709" } }), "CUT_COLOR_INTERPRETATION_REDUNDANT");

  const hostile = structuredClone(ir), hostileNode = Object.values(hostile.nodes).find((candidate) => candidate.op === "cut.visual.video")!;
  const interpreted = hostileNode.inputs.inputColorInterpretation;
  assert.equal(interpreted?.kind, "object");
  if (interpreted?.kind === "object" && interpreted.entries.master?.kind === "object") interpreted.entries.master.entries.ignored = { kind: "string", value: "x" };
  await assert.rejects(
    () => createCutLock(hostile, "/definitely/not/a/cut/project"),
    (error: unknown) => error instanceof ReferenceColorManagementError && error.code === "CUT_COLOR_INTERPRETATION_SHAPE" && /ignored/.test(error.message),
  );
});

test("direct PictureClip and linked Clip execute the same public interpretation in picture runtime", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-color-public-consumers-"));
  try {
    await writeFixture(root, "source", 16);
    const lock = async (source: string) => {
      const ir = compile(source);
      await applyCutLock(ir, await createCutLock(ir, root), root);
      return ir;
    };
    const video = await lock(videoSource()), picture = await lock(pictureClipSource()), linked = await lock(linkedSource(true));
    const pictureNode = Object.values(picture.nodes).find((node) => node.op === "cut.edit.picture_clip")!;
    const linkedNode = Object.values(linked.nodes).find((node) => node.op === "cut.edit.clip")!;
    assert.deepEqual(
      [referenceVideoInputColorConfig(picture, pictureNode)?.mode, referenceVideoInputColorConfig(linked, linkedNode)?.mode],
      ["interpreted", "interpreted"],
    );
    const expected = center(await frame(video, root, "video-consumer"));
    assert.deepEqual(center(await frame(picture, root, "picture-consumer")), expected, "direct PictureClip must decode through the interpreted profile");
    assert.deepEqual(center(await frame(linked, root, "linked-consumer")), expected, "linked Clip picture must decode through the interpreted profile");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("lock, CLI warning, inspect, exact proxy observations, selected decode, and hostile lock fields are executable evidence", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-color-interpretation-"));
  try {
    await fixtures(root);
    const source = videoSource({ proxy: proxyObservation, locatorProxy: true, duplicate: true }), ir = compile(source);
    const lock = await createCutLock(ir, root), media = lock.resources.source;
    assert.equal(media.probe.kind, "media"); assert.equal(media.proxy?.probe.kind, "media");
    if (media.probe.kind !== "media" || media.proxy?.probe.kind !== "media") return;
    const masterProbe = media.probe, proxyProbe = media.proxy.probe;
    const masterStream = masterProbe.identity.streams.find((candidate) => candidate.index === masterProbe.selected.video?.streamIndex)!;
    const proxyStream = proxyProbe.identity.streams.find((candidate) => candidate.index === proxyProbe.selected.video?.streamIndex)!;
    assert.equal(masterStream.fieldOrder, "progressive"); assert.equal(proxyStream.fieldOrder, "progressive");
    assert.deepEqual({ master: { range: masterStream.colorRange, matrix: masterStream.colorSpace }, proxy: { range: proxyStream.colorRange, matrix: proxyStream.colorSpace } }, {
      master: { range: undefined, matrix: undefined }, proxy: { range: "tv", matrix: "bt470bg" },
    });

    await applyCutLock(ir, lock, root);
    const warnings = referenceVideoColorInterpretationWarnings(ir);
    assert.equal(warnings.length, 1, "multiple consumers of one resource/profile must produce one warning");
    assert.deepEqual({ code: warnings[0].code, profile: warnings[0].profile, authority: warnings[0].authority, resourceId: warnings[0].resourceId }, {
      code: "CUTW_COLOR_INTERPRETATION_AUTHOR_DECLARED", profile: "rec709-limited", authority: "author-declared-unverified", resourceId: "source",
    });
    assert.ok(warnings[0].source.line > 0 && warnings[0].source.column > 0);

    const canonicalInspect = inspectCutIr(ir, "main.cut") as ReturnType<typeof inspectCutIr>;
    const interpretedNode = canonicalInspect.graph.nodes.find((item) => item.op === "cut.visual.video") as { videoInputColorInterpretation?: Record<string, unknown> } | undefined;
    assert.deepEqual(interpretedNode?.videoInputColorInterpretation, {
      mode: "interpreted",
      profile: "rec709-limited",
      authority: "author-declared-unverified",
      contract: "cut-video-color-interpretation-v1",
      decoderContract: "cut-input-rec709-limited-yuv-v1",
      observed: { master: masterObservation, proxy: proxyObservation },
      differences: {
        master: [
          { field: "range", observed: null, interpretedAs: "tv" },
          { field: "matrix", observed: null, interpretedAs: "bt709" },
          { field: "transfer", observed: null, interpretedAs: "bt709" },
          { field: "primaries", observed: null, interpretedAs: "bt709" },
        ],
        proxy: [
          { field: "matrix", observed: "bt470bg", interpretedAs: "bt709" },
          { field: "transfer", observed: null, interpretedAs: "bt709" },
          { field: "primaries", observed: null, interpretedAs: "bt709" },
        ],
      },
    });
    const inspectedResource = canonicalInspect.resources.find((resource) => resource.id === "source") as { selectedVideo?: Record<string, { variant: string; observation: Observation }> } | undefined;
    assert.deepEqual(inspectedResource?.selectedVideo, {
      master: { variant: "master", streamIndex: 0, observation: masterObservation },
      proxy: { variant: "proxy", streamIndex: 0, observation: proxyObservation },
    });

    const selectedMaster = selectReferenceMediaProfile(ir, "master").ir, selectedProxy = selectReferenceMediaProfile(ir, "proxy").ir;
    for (const [variant, selected] of [["master", selectedMaster], ["proxy", selectedProxy]] as const) {
      const selectedNode = Object.values(selected.nodes).find((candidate) => candidate.op === "cut.visual.video")!;
      const config = referenceVideoInputColorConfig(selected, selectedNode)!;
      assert.deepEqual({ variant, mode: config.mode, profile: config.inputColor }, { variant, mode: "interpreted", profile: "rec709-limited" });
      const report = inspectCutIr(selected, `${variant}.cut`);
      const resource = report.resources.find((item) => item.id === "source") as { selectedVideo?: Record<string, { variant: string }> } | undefined;
      assert.deepEqual(Object.keys(resource?.selectedVideo ?? {}), [variant]);
      assert.equal(resource?.selectedVideo?.[variant]?.variant, variant);
    }
    const masterPixel = center(await frame(selectedMaster, root, "master")), proxyPixel = center(await frame(selectedProxy, root, "proxy"));
    assert.ok(masterPixel.every((channel, index) => Math.abs(channel - proxyPixel[index]) <= 2), `same raw YUV interpreted through one target must remain pixel-equivalent within one codec/scale quantum: ${masterPixel} vs ${proxyPixel}`);

    const missingProxy = compile(videoSource({ locatorProxy: true }));
    await assert.rejects(() => createCutLock(missingProxy, root), (error: unknown) => error instanceof ReferenceColorManagementError && error.code === "CUT_COLOR_INTERPRETATION_OBSERVED" && /must declare/.test(error.message));
    const extraneousProxy = compile(videoSource({ proxy: proxyObservation }));
    await assert.rejects(() => createCutLock(extraneousProxy, root), (error: unknown) => error instanceof ReferenceColorManagementError && error.code === "CUT_COLOR_INTERPRETATION_OBSERVED" && /cannot be supplied/.test(error.message));
    const wrongObserved = compile(videoSource({ proxy: { ...proxyObservation, matrix: "smpte170m" }, locatorProxy: true }));
    await assert.rejects(() => createCutLock(wrongObserved, root), (error: unknown) => error instanceof ReferenceColorManagementError && error.code === "CUT_COLOR_INTERPRETATION_OBSERVED" && /matrix=bt470bg/.test(error.message));

    const hostileLock = structuredClone(lock) as CutLockfile;
    const audio = hostileLock.resources.source.probe.kind === "media" ? hostileLock.resources.source.probe.identity.streams.find((stream) => stream.type === "audio") : undefined;
    assert.ok(audio); (audio as typeof audio & { fieldOrder?: string }).fieldOrder = "progressive";
    assert.throws(() => validateCutLock(hostileLock), (error: unknown) => error instanceof CutLockError && error.code === "CUT_LOCK_METADATA" && error.path.endsWith(".fieldOrder"));

    await writeFile(resolve(root, "main.cut"), `${source}\n`);
    const cli = resolve("dist-cli/cli/cut.js"), environment = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };
    const json = spawnSync(process.execPath, [cli, "lock", "main.cut", "--out", "cli.lock", "--json"], { cwd: root, encoding: "utf8", env: environment, timeout: 60_000 });
    assert.equal(json.status, 0, json.stderr); const report = JSON.parse(json.stdout) as { diagnostics: Array<{ code: string; source: { module: string; line: number; column: number } }>; summary: { interpretedVideoResources: number } };
    assert.equal(report.summary.interpretedVideoResources, 1); assert.equal(report.diagnostics.length, 1); assert.equal(report.diagnostics[0].code, "CUTW_COLOR_INTERPRETATION_AUTHOR_DECLARED");
    assert.ok(report.diagnostics[0].source.line > 0 && report.diagnostics[0].source.column > 0);
    const human = spawnSync(process.execPath, [cli, "lock", "main.cut", "--out", "human.lock"], { cwd: root, encoding: "utf8", env: environment, timeout: 60_000 });
    assert.equal(human.status, 0, human.stderr); assert.match(human.stderr, /CUTW_COLOR_INTERPRETATION_AUTHOR_DECLARED project\.cut:\d+:\d+/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("edit materialization is preserved; selected variant cache identity is local; linked audio key and samples ignore picture interpretation", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-color-locality-"));
  try {
    await fixtures(root);
    const lockAndSelect = async (source: string) => {
      const ir = compile(source); await applyCutLock(ir, await createCutLock(ir, root), root);
      return { canonical: ir, master: selectReferenceMediaProfile(ir, "master").ir, proxy: selectReferenceMediaProfile(ir, "proxy").ir };
    };
    const first = await lockAndSelect(operatedSource());
    const materialized = Object.values(first.canonical.nodes).find((node) => node.op === "cut.edit.picture_clip");
    assert.equal(materialized?.inputs.inputColorInterpretation?.kind, "object");
    const track = Object.values(first.canonical.nodes).find((node) => node.op === "cut.edit.picture_track");
    assert.equal(track?.editorial?.kind, "picture-track");
    if (track?.editorial?.kind === "picture-track") {
      const operation = track.editorial.operationPlan?.operations[0];
      assert.ok(operation && "item" in operation && operation.item.inputs.inputColorInterpretation?.kind === "object");
    }
    const firstMasterPlan = createIncrementalRenderPlan(first.master, "main"), firstProxyPlan = createIncrementalRenderPlan(first.proxy, "main");

    await writeFixture(root, "proxy", 8, { range: "tv", matrix: "smpte170m" });
    const proxyChangedObservation = { ...proxyObservation, matrix: "smpte170m" };
    const second = await lockAndSelect(operatedSource(masterObservation, proxyChangedObservation));
    const proxyCanonicalDiff = diffCutAVIR(first.canonical, second.canonical), proxyCanonicalChanges = JSON.stringify(proxyCanonicalDiff.changes);
    assert.notEqual(second.canonical.buildId, first.canonical.buildId, "canonical identity must retain unselected proxy observations");
    assert.match(proxyCanonicalChanges, /inputColorInterpretation/u);
    assert.match(proxyCanonicalChanges, /smpte170m/u, "semantic diff must expose the authored proxy observation in materialized and operation-plan semantics");
    assert.ok(proxyCanonicalDiff.changes.some((change) => change.entity === "resource" && change.id === "source"), "canonical diff must expose changed proxy bytes/probe evidence");
    const masterAfterProxy = createIncrementalRenderPlan(second.master, "main", firstMasterPlan.manifest);
    const proxyAfterProxy = createIncrementalRenderPlan(second.proxy, "main", firstProxyPlan.manifest);
    assert.ok(masterAfterProxy.scenes.every((scene) => scene.status === "hit"), "proxy-only observation/bytes must preserve selected master scene artifacts");
    assert.ok(proxyAfterProxy.scenes.some((scene) => scene.status === "miss"));
    assert.equal(second.master.buildId, first.master.buildId, "unselected proxy evidence must not enter master execution identity");
    assert.notEqual(second.proxy.buildId, first.proxy.buildId);

    await writeFixture(root, "source", 16, { range: "tv", matrix: "bt470bg" });
    const changedMasterObservation = { ...masterObservation, range: "tv", matrix: "bt470bg" };
    const third = await lockAndSelect(operatedSource(changedMasterObservation, proxyChangedObservation));
    const masterCanonicalDiff = diffCutAVIR(second.canonical, third.canonical), masterCanonicalChanges = JSON.stringify(masterCanonicalDiff.changes);
    assert.notEqual(third.canonical.buildId, second.canonical.buildId, "canonical identity must retain unselected master observations");
    assert.match(masterCanonicalChanges, /inputColorInterpretation/u);
    assert.match(masterCanonicalChanges, /bt470bg/u, "semantic diff must expose the authored master observation in materialized and operation-plan semantics");
    assert.ok(masterCanonicalDiff.changes.some((change) => change.entity === "resource" && change.id === "source"), "canonical diff must expose changed master bytes/probe evidence");
    const proxyAfterMaster = createIncrementalRenderPlan(third.proxy, "main", proxyAfterProxy.manifest);
    const masterAfterMaster = createIncrementalRenderPlan(third.master, "main", masterAfterProxy.manifest);
    assert.ok(proxyAfterMaster.scenes.every((scene) => scene.status === "hit"), "master-only observation/bytes must preserve selected proxy scene artifacts");
    assert.ok(masterAfterMaster.scenes.some((scene) => scene.status === "miss"));
    assert.equal(third.proxy.buildId, second.proxy.buildId);
    assert.notEqual(third.master.buildId, second.master.buildId);

    // Return the master fixture to the observation used by the linked Clip.
    await writeFixture(root, "source", 16);
    const interpreted = compile(linkedSource(true)); await applyCutLock(interpreted, await createCutLock(interpreted, root), root);
    const legacy = compile(linkedSource(false)); await applyCutLock(legacy, await createCutLock(legacy, root), root);
    const toolchain = createReferenceAudioToolchainIdentity("ffmpeg version CUT-test\nconfiguration: deterministic", { platform: "darwin", architecture: "arm64", node: "v22.0.0", runtime: "cut-reference/0.4.0-alpha.2" });
    const interpretedComposition = interpreted.compositions[0], legacyComposition = legacy.compositions[0];
    const interpretedAudioPlan = createReferenceAudioCachePlan(interpreted, interpretedComposition, referenceMasterAudioRootIds(interpreted, interpretedComposition), toolchain);
    const legacyAudioPlan = createReferenceAudioCachePlan(legacy, legacyComposition, referenceMasterAudioRootIds(legacy, legacyComposition), toolchain);
    assert.equal(interpretedAudioPlan.key, legacyAudioPlan.key, "picture-only interpretation must not invalidate linked source audio PCM");
    const renderAudio = async (ir: typeof interpreted, name: string) => {
      const output = resolve(root, `${name}.f32le`), composition = ir.compositions[0];
      await renderReferenceAudioSelection(ir, composition, root, output, referenceMasterAudioRootIds(ir, composition), { outputFormat: "raw-stereo-f32le" });
      return readFile(output);
    };
    assert.deepEqual(await renderAudio(interpreted, "interpreted"), await renderAudio(legacy, "legacy"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("observed tokens never become subprocess syntax and selected execution authority cannot be serialized or mutated", { timeout: 60_000 }, async () => {
  const observed: Observation = { pixelFormat: "yuv420p", fieldOrder: "progressive", range: "range-probe-token", matrix: "movie-inject", transfer: "transfer-token", primaries: "primaries-token" };
  const ir = compile(videoSource({ master: observed })), node = Object.values(ir.nodes).find((candidate) => candidate.op === "cut.visual.video")!;
  const config = referenceVideoInputColorConfig(ir, node, {
    streamIndex: 0,
    duration: { numerator: "1", denominator: "1" },
    durationSource: "stream",
    start: { numerator: "0", denominator: "1" },
    timeBase: { numerator: "1", denominator: "1000" },
    frameRate: { numerator: "4", denominator: "1" },
    variant: "master",
    color: { pixelFormat: observed.pixelFormat, fieldOrder: observed.fieldOrder, colorRange: observed.range, colorSpace: observed.matrix, colorTransfer: observed.transfer, colorPrimaries: observed.primaries },
  })!;
  const decoder = referenceVideoDecoderColorPlan(config.inputColor), serialized = JSON.stringify(decoder);
  assert.equal(config.mode, "interpreted");
  for (const token of [observed.range, observed.matrix, observed.transfer, observed.primaries]) assert.doesNotMatch(serialized, new RegExp(token!));
  assert.equal(decoder.scaleSuffix, ":in_range=tv:out_range=pc:in_color_matrix=bt709:out_color_matrix=bt709");

  const root = await mkdtemp(resolve(tmpdir(), "cut-color-state-"));
  try {
    await fixtures(root); const canonical = compile(videoSource({ proxy: proxyObservation, locatorProxy: true }));
    await applyCutLock(canonical, await createCutLock(canonical, root), root);
    const selected = selectReferenceMediaProfile(canonical, "proxy").ir;
    const cloned = structuredClone(selected);
    assert.throws(() => finalizeGraphHashes(cloned), /CUT_PROXY_PROFILE_STATE/u);
    const mutated = selectReferenceMediaProfile(canonical, "proxy").ir;
    mutated.resources.source.metadata!.activeMediaVariant = "master";
    assert.throws(() => finalizeGraphHashes(mutated), /CUT_PROXY_PROFILE_STATE/u);
    const added = selectReferenceMediaProfile(canonical, "proxy").ir;
    added.resources.forged = structuredClone(added.resources.source); added.resources.forged.id = "forged";
    assert.throws(() => finalizeGraphHashes(added), /CUT_PROXY_PROFILE_STATE/u);
    const resourceMutated = selectReferenceMediaProfile(canonical, "proxy").ir;
    resourceMutated.resources.source.proxy = { locator: "media/forged-after-selection.mkv" };
    assert.throws(() => finalizeGraphHashes(resourceMutated), (error: unknown) => error instanceof ReferenceMediaProfileStateError && error.code === "CUT_PROXY_PROFILE_STATE");
    const rekeyed = selectReferenceMediaProfile(canonical, "proxy").ir;
    rekeyed.resources.renamed = rekeyed.resources.source; delete rekeyed.resources.source;
    assert.throws(() => finalizeGraphHashes(rekeyed), (error: unknown) => error instanceof ReferenceMediaProfileStateError && error.code === "CUT_PROXY_PROFILE_STATE");

    const nodeMutatedCanonical = compile(videoSource({ proxy: proxyObservation, locatorProxy: true }));
    await applyCutLock(nodeMutatedCanonical, await createCutLock(nodeMutatedCanonical, root), root);
    const executableNode = Object.values(nodeMutatedCanonical.nodes).find((candidate) => candidate.op === "cut.visual.video")!;
    executableNode.inputs.fit = { kind: "string", value: "contain" };
    assert.throws(() => selectReferenceMediaProfile(nodeMutatedCanonical, "proxy"), (error: unknown) => error instanceof CutProxyLockStateError && error.code === "CUT_PROXY_LOCK_STATE");

    const audioOnly = compile(audioOnlySource());
    await applyCutLock(audioOnly, await createCutLock(audioOnly, root), root);
    const serializedAudioSelection = structuredClone(selectReferenceMediaProfile(audioOnly, "master").ir);
    const audioToolchain = createReferenceAudioToolchainIdentity("ffmpeg version CUT-test\nconfiguration: deterministic", { platform: "darwin", architecture: "arm64", node: "v22.0.0", runtime: "cut-reference/0.4.0-alpha.2" });
    assert.throws(
      () => createReferenceAudioCachePlan(serializedAudioSelection, serializedAudioSelection.compositions[0], referenceMasterAudioRootIds(serializedAudioSelection, serializedAudioSelection.compositions[0]), audioToolchain),
      /CUT_PROXY_PROFILE_STATE/u,
      "audio-only cache planning must reject serialized selection authority",
    );

    const legacyCanonical = compile(legacyProxySource());
    await applyCutLock(legacyCanonical, await createCutLock(legacyCanonical, root), root);
    const laundered = structuredClone(selectReferenceMediaProfile(legacyCanonical, "proxy").ir);
    delete laundered.resources.source.metadata!.activeMediaVariant;
    delete laundered.resources.source.metadata!.authoredProxy;
    assert.throws(
      () => finalizeGraphHashes(laundered),
      (error: unknown) => error instanceof CutGraphError
        && error.code === "CUT_GRAPH_RESOURCE"
        && /video-proxy alignment evidence is valid only on a selected proxy/u.test(error.message),
      "a marker-stripped selected proxy must fail before it can rehash or reach verified-input authority",
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});
