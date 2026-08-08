import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR } from "../lib/language/ir";
import { CutAvIrValidationError, validateCutAvIr } from "../lib/language/ir-loader";
import { applyCutLock, createCutLock, CutLockError, CutProxyMediaError, validateCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { diffCutAVIR } from "../lib/language/semantic-diff";
import { createIncrementalRenderPlan } from "../lib/runtime/graph";
import { inspectCutIr } from "../lib/runtime/inspect";
import { referenceMasterAudioRootIds } from "../lib/runtime/reference/audio";
import { collectReferenceAudioToolchainIdentity, createReferenceAudioCachePlan } from "../lib/runtime/reference/audio-cache";
import { ReferenceMediaProfileRequestError, selectReferenceMediaProfile } from "../lib/runtime/reference/media-profile";

const exec = promisify(execFile);
const cli = resolve("dist-cli/cli/cut.js");

function compile(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual([...parsed.diagnostics, ...checkCutModule(parsed.module).diagnostics].filter((item) => item.severity === "error"), []);
  return compileCutModule(parsed.module).ir;
}

function diagnostics(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  return [...parsed.diagnostics, ...checkCutModule(parsed.module).diagnostics];
}

function projectSource(withFallback = true) {
  return `cut 0.4;
project "proxy vertical slice";
import { Video } from "cut:visual";
import { AudioClip } from "@cut/audio";
import { Clip } from "@cut/edit";

asset linked: VideoAsset = video("media/linked-master.mov", proxy: "media/linked-proxy.mov");
asset voice: AudioAsset = audio("media/voice-master.wav", proxy: "media/voice-proxy.wav");
${withFallback ? 'asset background: VideoAsset = video("media/linked-master.mov");' : ""}

timeline main(duration: 1s, fps: 4, width: 64px, height: 64px, sampleRate: 48khz) {
  scene only(duration: 1s) {
    ${withFallback ? "Video(source: background, range: 0s ..< 1s);" : ""}
    Clip(source: linked, range: 0s ..< 1s, duration: 1s);
    AudioClip(source: voice, range: 0s ..< 1s);
  }
}

export preview = render(main, width: 64px, height: 64px, codec: "h264");
export release = render(main, width: 64px, height: 64px, codec: "h264");`;
}

async function runCli(args: string[], cwd: string, expectedCode = 0) {
  return new Promise<{ stdout: string; stderr: string }>((accept, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" } });
    const stdout: Buffer[] = [], stderr: Buffer[] = []; let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      if (settled) return;
      settled = true;
      reject(new Error(`cut ${args.join(" ")} timed out`));
    }, 120_000);
    const finish = (error?: Error, result?: { stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else accept(result!);
    };
    child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.on("error", finish);
    child.on("exit", (code, signal) => {
      const result = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
      if (code === expectedCode) finish(undefined, result);
      else finish(new Error(`cut ${args.join(" ")} exited ${code ?? signal}, expected ${expectedCode}\n${result.stderr}${result.stdout}`));
    });
  });
}

async function generateLinked(path: string, color: string, size: number, profile: "master" | "proxy", revision?: string) {
  const video = profile === "master"
    ? ["-c:v", "prores_ks", "-profile:v", "0", "-pix_fmt", "yuv422p10le", "-video_track_timescale", "16384"]
    : ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-video_track_timescale", "32768"];
  await exec("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `color=c=${color}:s=${size}x${size}:r=4:d=1`,
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=1",
    "-shortest", ...video, "-c:a", "pcm_s24le",
    ...(revision ? ["-metadata", `comment=${revision}`] : []),
    path,
  ]);
}

async function generateLinkedProxy(master: string, proxy: string, crf = 23) {
  await exec("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error", "-i", master,
    "-map", "0:v:0", "-map", "0:a:0", "-vf", "scale=32:32:flags=lanczos",
    "-c:v", "libx264", "-crf", String(crf), "-pix_fmt", "yuv420p",
    "-video_track_timescale", "32768", "-c:a", "pcm_s24le", proxy,
  ]);
}

async function generateVoice(path: string, frequency: number, gain = 1) {
  await exec("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=48000:duration=1`, "-filter:a", `volume=${gain}`, "-ac", "1", "-c:a", "pcm_s24le", path]);
}

async function generateProjectMedia(root: string, values = { masterColor: "red", masterFrequency: 440, proxyFrequency: 440, masterGain: 1, proxyGain: .9 }) {
  const media = resolve(root, "media"); await mkdir(media, { recursive: true });
  const masterPath = resolve(media, "linked-master.mov"), proxyPath = resolve(media, "linked-proxy.mov");
  await generateLinked(masterPath, values.masterColor, 64, "master");
  await Promise.all([
    generateLinkedProxy(masterPath, proxyPath),
    generateVoice(resolve(media, "voice-master.wav"), values.masterFrequency, values.masterGain),
    generateVoice(resolve(media, "voice-proxy.wav"), values.proxyFrequency, values.proxyGain),
  ]);
}

async function decodedPixel(path: string, directory: string, name: string) {
  const raw = resolve(directory, `${name}.rgb`);
  await exec("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", path, "-frames:v", "1", "-vf", "scale=1:1,format=rgb24", "-f", "rawvideo", raw]);
  return [...(await readFile(raw)).subarray(0, 3)];
}

async function zeroCrossings(path: string, directory: string, name: string) {
  const raw = resolve(directory, `${name}.f32`);
  await exec("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", path, "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", raw]);
  const bytes = await readFile(raw); let previous = 0, crossings = 0;
  for (let sample = 4_000; sample < 24_000; sample += 1) {
    const value = bytes.readFloatLE(sample * 4); if (Math.abs(value) < .001) continue;
    if (previous && Math.sign(value) !== Math.sign(previous)) crossings += 1;
    previous = value;
  }
  return crossings;
}

test("video/audio proxy syntax is closed, typed, semantic, and strictly loaded", () => {
  const source = projectSource(false), ir = compile(source);
  assert.deepEqual(ir.resources.linked.proxy, { locator: "media/linked-proxy.mov" });
  assert.deepEqual(ir.resources.voice.proxy, { locator: "media/voice-proxy.wav" });
  assert.doesNotThrow(() => validateCutAvIr(ir));

  const changed = compile(source.replace("linked-proxy.mov", "alternate-proxy.mov"));
  assert.notEqual(changed.buildId, ir.buildId);
  const resourceChange = diffCutAVIR(ir, changed).changes.find((change) => change.entity === "resource" && change.id === "linked");
  assert.ok(resourceChange && resourceChange.operation === "modify");
  assert.ok(resourceChange.fields.some((field) => field.path === "/proxy/locator"));

  assert.ok(diagnostics('cut 0.4; project "unknown"; asset x: VideoAsset = video("a.mov", preview: "b.mp4"); timeline t(duration: 1s) {} export out = render(t);').some((item) => item.code === "CUT2027"));
  assert.ok(diagnostics('cut 0.4; project "type"; asset x: AudioAsset = audio("a.wav", proxy: 1); timeline t(duration: 1s) {} export out = render(t);').some((item) => item.code === "CUT2029"));
  assert.ok(diagnostics('cut 0.4; project "noop"; asset x: VideoAsset = video("a.mov", proxy: "a.mov"); timeline t(duration: 1s) {} export out = render(t);').some((item) => item.code === "CUT2084"));

  const hostile = structuredClone(ir) as CutAVIR & { resources: Record<string, CutAVIR["resources"][string] & { proxy?: { locator: string; ignored?: boolean } }> };
  hostile.resources.linked.proxy!.ignored = true;
  assert.throws(() => validateCutAvIr(hostile), (error) => error instanceof CutAvIrValidationError && error.code === "CUT_IR_UNKNOWN_FIELD" && error.path.endsWith(".proxy.ignored"));
  const wrongKind = structuredClone(ir); wrongKind.resources.linked.kind = "image";
  assert.throws(() => validateCutAvIr(wrongKind), (error) => error instanceof CutAvIrValidationError && error.code === "CUT_IR_TYPE" && error.path.endsWith(".proxy"));
  const noOp = structuredClone(ir); noOp.resources.linked.proxy!.locator = noOp.resources.linked.locator;
  assert.throws(() => validateCutAvIr(noOp), (error) => error instanceof CutAvIrValidationError && error.code === "CUT_IR_DETERMINISM" && error.path.endsWith(".proxy.locator"));
  assert.throws(
    () => selectReferenceMediaProfile(ir, "thumbnail" as "master"),
    (error) => error instanceof ReferenceMediaProfileRequestError && error.code === "CUT_PROXY_PROFILE" && error.requested === "thumbnail",
  );
});

test("cut.lock pins both variants, permits exact differing codec clocks, and rejects hostile/drifting proxies", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-proxy-lock-"));
  try {
    await generateProjectMedia(root);
    const ir = compile(projectSource(false)), lock = await createCutLock(ir, root), linked = lock.resources.linked;
    assert.ok(linked.proxy && linked.probe.kind === "media" && linked.proxy.probe.kind === "media");
    assert.notDeepEqual(linked.probe.selected.video?.timeBase, linked.proxy.probe.selected.video?.timeBase, "different exact codec time bases must be accepted");
    assert.ok(linked.probe.selected.audio && linked.proxy.probe.selected.audio, "linked VideoAsset audio must be locked in both variants");
    assert.notEqual(linked.sha256, linked.proxy.sha256);

    const unknown = structuredClone(lock) as typeof lock & { resources: Record<string, typeof linked & { proxy?: NonNullable<typeof linked.proxy> & { ignored?: boolean } }> };
    unknown.resources.linked.proxy!.ignored = true;
    assert.throws(() => validateCutLock(unknown), (error) => error instanceof CutLockError && error.code === "CUT_LOCK_UNKNOWN_FIELD" && error.path.endsWith(".proxy.ignored"));
    const noOpLock = structuredClone(lock);
    noOpLock.resources.linked.proxy!.locator = noOpLock.resources.linked.locator;
    noOpLock.resources.linked.proxy!.probe.identity.file.locator = noOpLock.resources.linked.locator;
    noOpLock.resources.linked.proxy!.probe.identity.file.basename = noOpLock.resources.linked.probe.identity.file.basename;
    assert.throws(() => validateCutLock(noOpLock), (error) => error instanceof CutLockError && error.code === "CUT_PROXY_NOOP" && error.path.endsWith(".proxy.locator"));

    const drift = structuredClone(lock);
    assert.equal(drift.resources.linked.proxy?.probe.kind, "media");
    if (drift.resources.linked.proxy?.probe.kind === "media") drift.resources.linked.proxy.probe.selected.video!.duration = { numerator: "5", denominator: "4" };
    assert.throws(() => validateCutLock(drift), (error) => error instanceof CutLockError && error.code === "CUT_LOCK_METADATA");

    await generateLinkedProxy(resolve(root, "media", "linked-master.mov"), resolve(root, "media", "linked-proxy.mov"));
    const badClock = compile(projectSource(false));
    // 30 fps cannot preserve the authored 4 fps frame map or exact duration.
    await exec("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=32x32:r=30:d=1", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono:d=1", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-video_track_timescale", "90000", "-c:a", "pcm_s24le", resolve(root, "media", "linked-proxy.mov")]);
    await assert.rejects(createCutLock(badClock, root), (error) => error instanceof CutProxyMediaError && error.code === "CUT_PROXY_FRAME_MAPPING" && error.source.line > 0);

    await generateLinkedProxy(resolve(root, "media", "linked-master.mov"), resolve(root, "media", "linked-proxy.mov"));
    await exec("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=44100:duration=1", "-ac", "1", "-c:a", "pcm_s24le", resolve(root, "media", "voice-proxy.wav")]);
    await assert.rejects(createCutLock(compile(projectSource(false)), root), (error) => error instanceof CutProxyMediaError && error.code === "CUT_PROXY_SAMPLE_MAPPING" && error.source.line > 0);
    await generateVoice(resolve(root, "media", "voice-proxy.wav"), 440, .9);

    const colorArgs = (path: string, range: "pc" | "tv", timescale: string) => ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=64x64:r=4:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-x264-params", `colorprim=bt709:transfer=bt709:colormatrix=bt709:fullrange=${range === "pc" ? "on" : "off"}`, "-video_track_timescale", timescale, "-color_range", range, "-colorspace", "bt709", "-color_trc", "bt709", "-color_primaries", "bt709", path];
    await exec("ffmpeg", colorArgs(resolve(root, "media", "color-master.mp4"), "pc", "16384"));
    await exec("ffmpeg", colorArgs(resolve(root, "media", "color-proxy.mp4"), "pc", "32768"));
    const managed = compile('cut 0.4; project "managed proxy"; import { Video } from "cut:visual"; asset picture: VideoAsset = video("media/color-master.mp4", proxy: "media/color-proxy.mp4"); timeline main(duration: 1s, fps: 4, width: 64px, height: 64px, sampleRate: 48khz) { Video(source: picture, range: 0s ..< 1s, inputColor: "rec709-full"); } export out = render(main, width: 64px, height: 64px, codec: "h264");');
    const colorEquivalent = await createCutLock(managed, root);
    assert.ok(colorEquivalent.resources.picture.proxy, "matching explicit managed color metadata must lock");
    const managedPictureClip = compile('cut 0.4; project "managed editorial proxy"; import { PictureClip, PictureTrack, Sequence } from "@cut/edit"; asset picture: VideoAsset = video("media/color-master.mp4", proxy: "media/color-proxy.mp4"); timeline main(duration: 1s, fps: 4, width: 64px, height: 64px, sampleRate: 48khz) { scene only(duration: 1s) { Sequence(duration: 1s) { PictureTrack() { PictureClip(source: picture, range: 0s ..< 1s, duration: 1s, inputColor: "rec709-full"); } } } } export out = render(main, width: 64px, height: 64px, codec: "h264");');
    const editorialColorEquivalent = await createCutLock(managedPictureClip, root);
    assert.ok(editorialColorEquivalent.resources.picture.proxy, "matching managed PictureClip metadata must lock");

    // The only managed consumer below is retained in operation history and is
    // superseded by a later gap. It must still activate cross-variant color
    // equivalence: both streams independently satisfy rec709-full, but RGB/gbr
    // versus YUV/bt709 would select different decode paths.
    await exec("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=64x64:r=4:d=1",
      "-c:v", "libx264rgb", "-pix_fmt", "rgb24", "-video_track_timescale", "32768", "-x264-params", "fullrange=on",
      "-bsf:v", "h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=0:video_full_range_flag=1",
      resolve(root, "media", "color-proxy.mp4"),
    ]);
    const supersededManaged = compile('cut 0.4; project "superseded managed proxy"; import { PictureClip, PictureTrack, Sequence, editClip, editGap, overwrite, replace } from "@cut/edit"; asset picture: VideoAsset = video("media/color-master.mp4", proxy: "media/color-proxy.mp4"); timeline main(duration: 1s, fps: 4, width: 64px, height: 64px, sampleRate: 48khz) { scene only(duration: 1s) { Sequence(duration: 1s) { PictureTrack(sourceDuration: 1s, edits: [overwrite(range: 0s ..< 1s, item: editClip(source: picture, range: 0s ..< 1s, duration: 1s, inputColor: "rec709-full")), replace(range: 0s ..< 1s, item: editGap(duration: 1s))]) { PictureClip(source: picture, range: 0s ..< 1s, duration: 1s); } } } } export out = render(main, width: 64px, height: 64px, codec: "h264");');
    assert.equal(Object.values(supersededManaged.nodes).some((node) => node.op === "cut.edit.picture_clip"), false, "managed operand must be present only in superseded typed operation history");
    await assert.rejects(
      createCutLock(supersededManaged, root),
      (error) => error instanceof CutProxyMediaError && error.code === "CUT_PROXY_COLOR_MAPPING",
    );

    await exec("ffmpeg", colorArgs(resolve(root, "media", "color-proxy.mp4"), "pc", "32768"));
    assert.ok((await createCutLock(supersededManaged, root)).resources.picture.proxy, "matching variants must still lock when the managed consumer survives only in typed operation history");
    await exec("ffmpeg", colorArgs(resolve(root, "media", "color-proxy.mp4"), "tv", "32768"));
    await assert.rejects(createCutLock(managed, root), (error) => error instanceof CutProxyMediaError && error.code === "CUT_PROXY_COLOR_MAPPING");
    await assert.rejects(createCutLock(managedPictureClip, root), (error) => error instanceof CutProxyMediaError && error.code === "CUT_PROXY_COLOR_MAPPING");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("CLI preview decodes proxies, render decodes masters, reports fallback, and rechecks unselected proxy bytes", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-proxy-cli-"));
  try {
    await generateProjectMedia(root); await writeFile(resolve(root, "main.cut"), `${projectSource(true)}\n`);
    const check = JSON.parse((await runCli(["check", "main.cut", "--json"], root)).stdout) as { status: string; diagnostics: unknown[] };
    assert.equal(check.status, "pass"); assert.deepEqual(check.diagnostics, []);
    const lockReport = JSON.parse((await runCli(["lock", "main.cut", "--out", "cut.lock", "--json"], root)).stdout) as { format: string; summary: { resources: number; proxies: number } };
    assert.equal(lockReport.format, "cut-lock-report"); assert.equal(lockReport.summary.proxies, 2);
    const inspect = JSON.parse((await runCli(["inspect", "main.cut", "--lock", "cut.lock", "--json"], root)).stdout) as ReturnType<typeof inspectCutIr>;
    const inspectedLinked = inspect.resources.find((resource) => resource.id === "linked") as { proxy?: { locator: string; sha256?: string; bytes?: number } } | undefined;
    assert.equal(inspectedLinked?.proxy?.locator, "media/linked-proxy.mov"); assert.match(inspectedLinked?.proxy?.sha256 ?? "", /^[a-f0-9]{64}$/); assert.ok((inspectedLinked?.proxy?.bytes ?? 0) > 0);

    const previewPath = resolve(root, "preview.mp4"), finalPath = resolve(root, "final.mp4");
    const preview = JSON.parse((await runCli(["preview", "main.cut", "--lock", "cut.lock", "--out", previewPath, "--json"], root)).stdout) as { format: string; manifest: { version: number; buildId: string; executionBuildId: string; media: { requested: string; selectedProxyResources: number; fallbackResources: number; resources: Array<{ resourceId: string; kind: string; requested: string; selected: string; fallback: boolean; locator: string; sha256: string }> } } };
    const final = JSON.parse((await runCli(["render", "main.cut", "--lock", "cut.lock", "--output", "release", "--out", finalPath, "--json"], root)).stdout) as typeof preview;
    assert.equal(preview.format, "cut-preview-report"); assert.equal(preview.manifest.version, 11); assert.equal(preview.manifest.media.requested, "proxy");
    assert.equal(preview.manifest.media.selectedProxyResources, 2); assert.equal(preview.manifest.media.fallbackResources, 1);
    const background = preview.manifest.media.resources.find((resource) => resource.resourceId === "background");
    assert.deepEqual({ kind: background?.kind, requested: background?.requested, selected: background?.selected, fallback: background?.fallback, locator: background?.locator }, { kind: "video", requested: "proxy", selected: "master", fallback: true, locator: "media/linked-master.mov" });
    assert.match(background?.sha256 ?? "", /^[a-f0-9]{64}$/);
    assert.equal(final.manifest.media.requested, "master"); assert.equal(final.manifest.media.selectedProxyResources, 0); assert.equal(final.manifest.media.fallbackResources, 0);
    assert.equal(preview.manifest.buildId, final.manifest.buildId, "canonical locked edit identity must reconcile across profiles");
    assert.notEqual(preview.manifest.executionBuildId, final.manifest.executionBuildId, "selected execution/cache identity must distinguish profiles");

    const [previewPixel, finalPixel, previewCrossings, finalCrossings] = await Promise.all([
      decodedPixel(previewPath, root, "preview"), decodedPixel(finalPath, root, "final"), zeroCrossings(previewPath, root, "preview"), zeroCrossings(finalPath, root, "final"),
    ]);
    assert.ok(previewPixel[0] > 240 && previewPixel[2] < 10, `preview did not decode the red same-source proxy: ${previewPixel}`);
    assert.ok(finalPixel[0] > 240 && finalPixel[2] < 10, `render did not decode red master: ${finalPixel}`);
    assert.ok(Math.abs(previewCrossings - finalCrossings) <= Math.max(2, finalCrossings * .02), `${previewCrossings} same-source proxy crossings versus ${finalCrossings} master crossings`);

    await generateVoice(resolve(root, "media", "voice-proxy.wav"), 660);
    const tampered = JSON.parse((await runCli(["render", "main.cut", "--lock", "cut.lock", "--output", "release", "--out", resolve(root, "tamper-must-fail.mp4"), "--json"], root, 1)).stdout) as { status: string; diagnostics: Array<{ code: string; source?: { module?: string; line?: number } }> };
    assert.equal(tampered.status, "fail"); assert.equal(tampered.diagnostics[0]?.code, "CUT_LOCK_INTEGRITY");

    await rm(resolve(root, "media", "voice-proxy.wav"));
    const missing = JSON.parse((await runCli(["render", "main.cut", "--lock", "cut.lock", "--output", "release", "--out", resolve(root, "must-fail.mp4"), "--json"], root, 1)).stdout) as { status: string; diagnostics: Array<{ code: string; source?: { module?: string; line?: number } }> };
    assert.equal(missing.status, "fail"); assert.equal(missing.diagnostics[0]?.code, "CUTP1015");
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function lockedIr(root: string) {
  const ir = compile(projectSource(false)), lock = await createCutLock(ir, root); await applyCutLock(ir, lock, root); return ir;
}

test("one proxied A/V resource can feed picture-only Video and linked Clip in the same proxy graph", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-proxy-mixed-consumers-"));
  try {
    await generateProjectMedia(root);
    const source = projectSource(false).replace(
      "    Clip(source: linked, range: 0s ..< 1s, duration: 1s);",
      "    Video(source: linked, range: 0s ..< 1s);\n    Clip(source: linked, range: 0s ..< 1s, duration: 1s);",
    );
    const canonical = compile(source), lock = await createCutLock(canonical, root);
    await applyCutLock(canonical, lock, root);
    const selected = selectReferenceMediaProfile(canonical, "proxy").ir;
    const composition = selected.compositions[0];
    const picture = createIncrementalRenderPlan(selected, composition.id);
    assert.equal(picture.scenes.length, 1);
    assert.ok(picture.scenes.every((scene) => scene.status === "miss"));
    const resource = selected.resources.linked;
    assert.equal((resource.metadata as { activeMediaVariant?: unknown }).activeMediaVariant, "proxy");
    assert.ok((resource.metadata as { audioProxyAlignment?: unknown }).audioProxyAlignment, "the resource retains validated pairwise authority for its linked consumer");
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function profilePlans(ir: CutAVIR) {
  const toolchain = await collectReferenceAudioToolchainIdentity();
  const plans = (profile: "master" | "proxy") => {
    const selected = selectReferenceMediaProfile(ir, profile).ir, composition = selected.compositions[0];
    return {
      ir: selected,
      picture: createIncrementalRenderPlan(selected, composition.id),
      audio: createReferenceAudioCachePlan(selected, composition, referenceMasterAudioRootIds(selected, composition), toolchain),
    };
  };
  return { master: plans("master"), proxy: plans("proxy") };
}

test("proxy and master edits invalidate only their selected picture/audio cache profiles", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-proxy-cache-"));
  try {
    await generateProjectMedia(root);
    const firstCanonical = await lockedIr(root), first = await profilePlans(firstCanonical);

    await Promise.all([
      generateLinkedProxy(resolve(root, "media", "linked-master.mov"), resolve(root, "media", "linked-proxy.mov"), 35),
      generateVoice(resolve(root, "media", "voice-proxy.wav"), 440, .75),
    ]);
    const proxyEditedCanonical = await lockedIr(root), proxyEdited = await profilePlans(proxyEditedCanonical);
    const finalAfterProxy = createIncrementalRenderPlan(proxyEdited.master.ir, proxyEdited.master.ir.compositions[0].id, first.master.picture.manifest);
    const previewAfterProxy = createIncrementalRenderPlan(proxyEdited.proxy.ir, proxyEdited.proxy.ir.compositions[0].id, first.proxy.picture.manifest);
    assert.ok(finalAfterProxy.scenes.every((scene) => scene.status === "hit"), "proxy-only edit must preserve final picture cache");
    assert.ok(previewAfterProxy.scenes.some((scene) => scene.status === "miss"), "proxy-only edit must invalidate preview picture cache");
    assert.equal(proxyEdited.master.audio.key, first.master.audio.key, "proxy-only edit must preserve final audio cache key");
    assert.notEqual(proxyEdited.proxy.audio.key, first.proxy.audio.key, "proxy-only edit must invalidate preview audio cache key");
    assert.equal(proxyEdited.master.ir.buildId, first.master.ir.buildId, "unselected proxy evidence must not enter master execution identity");
    assert.notEqual(proxyEdited.proxy.ir.buildId, first.proxy.ir.buildId);
    assert.notEqual(proxyEditedCanonical.buildId, firstCanonical.buildId, "proxy revision must still change canonical locked build identity");

    await Promise.all([
      generateLinked(resolve(root, "media", "linked-master.mov"), "red", 64, "master", "master-v2"),
      generateVoice(resolve(root, "media", "voice-master.wav"), 440, .65),
    ]);
    const masterEditedCanonical = await lockedIr(root), masterEdited = await profilePlans(masterEditedCanonical);
    const previewAfterMaster = createIncrementalRenderPlan(masterEdited.proxy.ir, masterEdited.proxy.ir.compositions[0].id, proxyEdited.proxy.picture.manifest);
    const finalAfterMaster = createIncrementalRenderPlan(masterEdited.master.ir, masterEdited.master.ir.compositions[0].id, proxyEdited.master.picture.manifest);
    assert.ok(previewAfterMaster.scenes.every((scene) => scene.status === "hit"), "master-only edit must preserve proxy picture cache");
    assert.ok(finalAfterMaster.scenes.some((scene) => scene.status === "miss"), "master-only edit must invalidate final picture cache");
    assert.equal(masterEdited.proxy.audio.key, proxyEdited.proxy.audio.key, "master-only edit must preserve preview audio cache key");
    assert.notEqual(masterEdited.master.audio.key, proxyEdited.master.audio.key, "master-only edit must invalidate final audio cache key");
    assert.equal(masterEdited.proxy.ir.buildId, proxyEdited.proxy.ir.buildId, "unselected master evidence must not enter proxy execution identity");
    assert.notEqual(masterEdited.master.ir.buildId, proxyEdited.master.ir.buildId);
    assert.notEqual(masterEditedCanonical.buildId, proxyEditedCanonical.buildId, "master revision must still change canonical locked build identity");
  } finally { await rm(root, { recursive: true, force: true }); }
});
