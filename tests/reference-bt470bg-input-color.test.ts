import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import { loadCutAvIr } from "../lib/language/ir-loader";
import { applyCutLock, createCutLock, CutProxyMediaError } from "../lib/language/lock";
import { packageSymbol } from "../lib/language/packages";
import { parseCutLanguage } from "../lib/language/parser";
import { diffCutAVIR } from "../lib/language/semantic-diff";
import { createIncrementalRenderPlan, finalizeGraphHashes } from "../lib/runtime/graph";
import { inspectCutIr } from "../lib/runtime/inspect";
import { referenceMasterAudioRootIds, renderReferenceAudioSelection } from "../lib/runtime/reference/audio";
import {
  convertReferenceBt470bgSmpte170mInputToSrgb,
  ReferenceColorManagementError,
  referenceBt470bgSmpte170mInputContract,
} from "../lib/runtime/reference/color-management";
import { runFfmpeg } from "../lib/runtime/reference/ffmpeg";
import { selectReferenceMediaProfile } from "../lib/runtime/reference/media-profile";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { referenceVideoInputColorConfig } from "../lib/runtime/reference/video-config";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

const profile = "bt470bg-smpte170m-limited" as const;

function compile(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics)); assert.deepEqual(parsed.diagnostics, []);
  return compileCutModule(parsed.module).ir;
}

function videoSource(inputColor: string | undefined, proxy?: string) {
  return `cut 0.4;
project "bt470bg input";
import { Video } from "cut:visual";
asset source: VideoAsset = video("media/source.mkv"${proxy ? `, proxy: "${proxy}"` : ""});
timeline main(duration: 1s, fps: 1, width: 2px, height: 2px, sampleRate: 8khz) {
  scene managed(duration: 1s) { Video(source: source, range: 0s..<1s${inputColor ? `, inputColor: "${inputColor}"` : ""}); }
}
export out = render(main, width: 2px, height: 2px, codec: "h264", color: "rec709-limited");`;
}

function linkedSource(inputColor: string | undefined) {
  return `cut 0.4;
project "bt470bg linked input";
import { Clip } from "@cut/edit";
asset source: VideoAsset = video("media/source.mkv");
timeline main(duration: 1s, fps: 1, width: 2px, height: 2px, sampleRate: 8khz) {
  scene linked(duration: 1s) { Clip(source: source, range: 0s..<1s, duration: 1s${inputColor ? `, inputColor: "${inputColor}"` : ""}); }
}
export out = render(main);`;
}

function cacheSource(inputColor: string | undefined) {
  return `cut 0.4;
project "bt470bg cache locality";
import { Rect, Video } from "cut:visual";
asset source: VideoAsset = video("media/source.mkv");
timeline main(duration: 2s, fps: 1, width: 2px, height: 2px, sampleRate: 8khz) {
  scene managed(duration: 1s) { Video(source: source, range: 0s..<1s${inputColor ? `, inputColor: "${inputColor}"` : ""}); }
  scene unrelated(duration: 1s) { Rect(width: 2px, height: 2px, fill: #d9a328); }
}
export out = render(main);`;
}

function operatedSource() {
  return `cut 0.4;
project "bt470bg operated input";
import { PictureClip, PictureTrack, Sequence, editClip, replace } from "@cut/edit";
asset source: VideoAsset = video("media/source.mkv");
timeline main(duration: 1s, fps: 1, width: 2px, height: 2px, sampleRate: 8khz) {
  scene operated(duration: 1s) {
    Sequence(duration: 1s) {
      PictureTrack(sourceDuration: 1s, edits: [
        replace(range: 0s..<1s, item: editClip(source: source, range: 0s..<1s, duration: 1s, inputColor: "${profile}"))
      ]) { PictureClip(source: source, range: 0s..<1s, duration: 1s); }
    }
  }
}
export out = render(main);`;
}

const exactYuv444 = Uint8Array.from([
  64, 128, 192, 100,
  90, 128, 200, 160,
  240, 128, 50, 100,
]);

async function writeTaggedFixture(root: string, options: {
  name?: string;
  bytes?: Uint8Array;
  width?: number;
  height?: number;
  pixelFormat?: "yuv420p" | "yuv444p";
  primaries?: string;
  transfer?: string;
  matrix?: string;
  range?: "tv" | "pc";
  withAudio?: boolean;
} = {}) {
  await mkdir(resolve(root, "media"), { recursive: true });
  const name = options.name ?? "source.mkv", width = options.width ?? 2, height = options.height ?? 2;
  const pixelFormat = options.pixelFormat ?? "yuv444p", primaries = options.primaries ?? "bt470bg";
  const transfer = options.transfer ?? "smpte170m", matrix = options.matrix ?? "bt470bg", range = options.range ?? "tv";
  const bytes = options.bytes ?? exactYuv444, raw = resolve(root, "media", `${name}.yuv`), output = resolve(root, "media", name);
  await writeFile(raw, bytes);
  const withAudio = options.withAudio ?? true;
  await runFfmpeg([
    "-y", "-v", "error", "-f", "rawvideo", "-pixel_format", pixelFormat, "-video_size", `${width}x${height}`, "-framerate", "1", "-i", raw,
    ...(withAudio ? ["-f", "lavfi", "-i", "sine=frequency=220:sample_rate=8000:duration=1", "-map", "0:v:0", "-map", "1:a:0"] : ["-map", "0:v:0"]),
    "-c:v", "libx264", "-qp", "0", "-pix_fmt", pixelFormat,
    "-x264-params", `colorprim=${primaries}:transfer=${transfer}:colormatrix=${matrix}:fullrange=${range === "pc" ? "on" : "off"}`,
    "-color_range", range, "-colorspace", matrix, "-color_trc", transfer, "-color_primaries", primaries,
    ...(withAudio ? ["-c:a", "pcm_s16le", "-shortest"] : []), output,
  ]);
}

function center(surface: { data: Uint8Array; width: number; height: number }) {
  const offset = (Math.floor(surface.height / 2) * surface.width + Math.floor(surface.width / 2)) * 4;
  return [...surface.data.subarray(offset, offset + 4)];
}

async function firstFrame(ir: ReturnType<typeof compile>, root: string, cache: string) {
  const { composition } = validateReferenceSession(ir), renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, cache));
  await renderer.prepare();
  try { return await renderer.sceneFrame(ir.scenes[composition.sceneIds[0]], 0, false); }
  finally { renderer.close(); }
}

type Matrix3 = [[number, number, number], [number, number, number], [number, number, number]];
function inverse(matrix: Matrix3): Matrix3 {
  const [[a, b, c], [d, e, f], [g, h, i]] = matrix;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const D = -(b * i - c * h), E = a * i - c * g, F = -(a * h - b * g);
  const G = b * f - c * e, H = -(a * f - c * d), I = a * e - b * d, determinant = a * A + b * B + c * C;
  return [[A / determinant, D / determinant, G / determinant], [B / determinant, E / determinant, H / determinant], [C / determinant, F / determinant, I / determinant]];
}
function multiply(left: Matrix3, right: Matrix3): Matrix3 {
  return left.map((row) => right[0].map((_, column) => row.reduce((sum, value, index) => sum + value * right[index][column], 0))) as Matrix3;
}
function rgbToXyz(primaries: [[number, number], [number, number], [number, number]]): Matrix3 {
  const columns = primaries.map(([x, y]) => [x / y, 1, (1 - x - y) / y]);
  const matrix = [[columns[0][0], columns[1][0], columns[2][0]], [1, 1, 1], [columns[0][2], columns[1][2], columns[2][2]]] as Matrix3;
  const white = [0.3127 / 0.3290, 1, (1 - 0.3127 - 0.3290) / 0.3290];
  const scale = inverse(matrix).map((row) => row.reduce((sum, value, index) => sum + value * white[index], 0));
  return matrix.map((row) => row.map((value, index) => value * scale[index])) as Matrix3;
}
function independentWorkingPixel(yCode: number, cbCode: number, crCode: number) {
  const y = (yCode - 16) / 219, cb = (cbCode - 128) / 224, cr = (crCode - 128) / 224;
  const encoded = [y + 1.402 * cr, y - 0.344136 * cb - 0.714136 * cr, y + 1.772 * cb].map((value) => Math.max(0, Math.min(1, value)));
  const decode170m = (value: number) => value < 0.081 ? value / 4.5 : ((value + 0.099) / 1.099) ** (1 / 0.45);
  // The v1 decoder contract first creates a rounded full-range RGBA8
  // intermediate; construct that quantization independently from Y'CbCr.
  const linear470 = encoded.map((value) => decode170m(Math.round(value * 255) / 255));
  const conversion = multiply(
    inverse(rgbToXyz([[0.64, 0.33], [0.30, 0.60], [0.15, 0.06]])),
    rgbToXyz([[0.64, 0.33], [0.29, 0.60], [0.15, 0.06]]),
  );
  const linear709 = conversion.map((row) => row.reduce((sum, value, index) => sum + value * linear470[index], 0));
  const encodeSrgb = (value: number) => {
    const bounded = Math.max(0, Math.min(1, value));
    return Math.round(255 * (bounded <= 0.0031308 ? 12.92 * bounded : 1.055 * bounded ** (1 / 2.4) - 0.055));
  };
  return linear709.map(encodeSrgb);
}

test("the exact BT.470BG/SMPTE-170M profile is input-only public syntax across all four video consumers", () => {
  const expected = ["srgb", "linear-srgb", "rec709-full", "rec709-limited", profile];
  assert.deepEqual(packageSymbol("cut:visual", "Video")?.parameters?.find((item) => item.name === "inputColor")?.values, expected);
  for (const symbol of ["Clip", "PictureClip", "editClip"]) {
    assert.deepEqual(packageSymbol("@cut/edit", symbol)?.parameters?.find((item) => item.name === "inputColor")?.values, expected);
  }
  assert.deepEqual(packageSymbol("cut:visual", "ColorConvert")?.parameters?.find((item) => item.name === "from")?.values, expected.slice(0, 4));
  assert.deepEqual(packageSymbol("cut:core", "render")?.parameters?.find((item) => item.name === "color")?.values, expected.slice(0, 4));

  const video = compile(videoSource(profile));
  assert.deepEqual(Object.values(video.nodes).find((node) => node.op === "cut.visual.video")?.inputs.inputColor, { kind: "string", value: profile });
  const linked = compile(linkedSource(profile));
  assert.deepEqual(Object.values(linked.nodes).find((node) => node.op === "cut.edit.clip")?.inputs.inputColor, { kind: "string", value: profile });
  const operated = compile(operatedSource());
  const picture = Object.values(operated.nodes).find((node) => node.op === "cut.edit.picture_clip");
  assert.deepEqual(picture?.inputs.inputColor, { kind: "string", value: profile });
  const track = Object.values(operated.nodes).find((node) => node.op === "cut.edit.picture_track");
  assert.equal(track?.editorial?.kind, "picture-track");
  if (track?.editorial?.kind === "picture-track") {
    const operation = track.editorial.operationPlan?.operations[0];
    assert.ok(operation && "item" in operation);
    if (operation && "item" in operation) assert.deepEqual(operation.item.inputs.inputColor, { kind: "string", value: profile });
  }

  const bad = parseCutLanguage(`cut 0.4; project "not an output profile"; import { ColorConvert, Rect } from "cut:visual"; timeline main(duration: 1s, fps: 1, width: 2px, height: 2px, sampleRate: 8khz) { scene only(duration: 1s) { ColorConvert(from: "${profile}", to: "srgb") { Rect(width: 2px, height: 2px); } } } export out = render(main);`);
  assert.ok(bad.module);
  assert.throws(() => compileCutModule(bad.module!), (error: unknown) => error instanceof CutCompileError && error.result.diagnostics.some((item) => /must be one of/.test(item.message)));
});

test("the versioned CPU conversion matches independently derived matrix/transfer vectors and preserves straight alpha", () => {
  assert.deepEqual(referenceBt470bgSmpte170mInputContract, {
    id: "cut-input-bt470bg-smpte170m-limited-v1", version: 1, profile,
    lockedTuple: { colorRange: "tv", colorSpace: "bt470bg", colorTransfer: "smpte170m", colorPrimaries: "bt470bg" },
    pixelFormats: ["yuv420p", "yuv422p", "yuv444p"],
    decoderIntermediate: "straight-rgba8-full-bt470bg-smpte170m", workingSurface: "straight-rgba8-full-srgb",
    yuvExpansion: { matrix: "bt601", inputRange: "tv", outputRange: "pc" },
    primaryMatrix: referenceBt470bgSmpte170mInputContract.primaryMatrix,
    rounding: "nearest-uint8-after-clamp",
  });
  const intermediate = Uint8Array.from([235, 0, 0, 17, 130, 130, 130, 0, 80, 240, 255, 255, 53, 108, 162, 127]);
  const converted = convertReferenceBt470bgSmpte170mInputToSrgb({ data: intermediate, width: 2, height: 2 });
  const expected = [
    ...independentWorkingPixel(64, 90, 240), 17,
    ...independentWorkingPixel(128, 128, 128), 0,
    ...independentWorkingPixel(192, 200, 50), 255,
    ...independentWorkingPixel(100, 160, 100), 127,
  ];
  assert.deepEqual([...converted.data], expected);
  assert.deepEqual(expected, [242, 0, 0, 17, 142, 142, 142, 0, 80, 242, 255, 255, 65, 121, 171, 127]);
});

test("exact locked metadata drives deterministic decode, inspect/diff/cache identity, and differs from legacy", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-bt470bg-input-"));
  try {
    await writeTaggedFixture(root);
    const explicit = compile(videoSource(profile)), lock = await createCutLock(explicit, root);
    const locked = lock.resources.source.probe;
    assert.equal(locked.kind, "media");
    if (locked.kind !== "media") return;
    const selected = locked.identity.streams.find((stream) => stream.index === locked.selected.video?.streamIndex)!;
    assert.deepEqual({ pixel: selected.pixelFormat, range: selected.colorRange, matrix: selected.colorSpace, transfer: selected.colorTransfer, primaries: selected.colorPrimaries }, {
      pixel: "yuv444p", range: "tv", matrix: "bt470bg", transfer: "smpte170m", primaries: "bt470bg",
    });
    await applyCutLock(explicit, lock, root);
    const managedFrame = await firstFrame(explicit, root, "managed-cache");
    assert.deepEqual([...managedFrame.data], [242, 0, 0, 255, 142, 142, 142, 255, 80, 242, 255, 255, 65, 121, 171, 255]);

    const legacy = compile(videoSource(undefined)); await applyCutLock(legacy, await createCutLock(legacy, root), root);
    const legacyFrame = await firstFrame(legacy, root, "legacy-cache");
    assert.notDeepEqual(managedFrame.data, legacyFrame.data);

    const report = inspectCutIr(explicit, "main.cut");
    const node = report.graph.nodes.find((item) => item.op === "cut.visual.video") as { videoInputColor?: { profile: string; backendContract?: string } } | undefined;
    assert.deepEqual(node?.videoInputColor, { profile, backendContract: referenceBt470bgSmpte170mInputContract.id });
    const semantic = diffCutAVIR(compile(videoSource(undefined)), compile(videoSource(profile)));
    assert.ok(semantic.changes.some((change) => change.entity === "node" && change.operation === "modify" && change.fields.some((field) => field.path.includes("inputColor"))));
    const previous = createIncrementalRenderPlan(compile(cacheSource(undefined)), "main").manifest;
    const plan = createIncrementalRenderPlan(compile(cacheSource(profile)), "main", previous);
    assert.deepEqual(plan.scenes.map((scene) => scene.status), ["miss", "hit"]);

    const videoNode = Object.values(compile(videoSource(profile)).nodes).find((item) => item.op === "cut.visual.video")!;
    const baseSelection = { streamIndex: 0, duration: { numerator: "1", denominator: "1" }, start: { numerator: "0", denominator: "1" }, timeBase: { numerator: "1", denominator: "1000" }, frameRate: { numerator: "1", denominator: "1" } } as const;
    const exact = { pixelFormat: "yuv444p", colorRange: "tv", colorSpace: "bt470bg", colorTransfer: "smpte170m", colorPrimaries: "bt470bg" };
    for (const [field, value, expectedText] of [
      ["pixelFormat", "yuv420p10le", "pixelFormat"], ["colorRange", "pc", "range"], ["colorSpace", "bt709", "matrix"],
      ["colorTransfer", "bt709", "transfer"], ["colorPrimaries", "bt709", "primaries"],
    ] as const) {
      assert.throws(
        () => referenceVideoInputColorConfig(compile(videoSource(profile)), videoNode, { ...baseSelection, color: { ...exact, [field]: value } }),
        (error: unknown) => error instanceof ReferenceColorManagementError && error.code === "CUT_COLOR_METADATA" && error.source?.nodeId === videoNode.id && error.message.includes(expectedText),
      );
    }

    const hostile = structuredClone(explicit), hostileNode = Object.values(hostile.nodes).find((item) => item.op === "cut.visual.video")!;
    hostileNode.inputs.inputColor = { kind: "string", value: "pq" }; finalizeGraphHashes(hostile);
    const loaded = loadCutAvIr(JSON.stringify(hostile));
    assert.throws(() => validateReferenceSession(loaded), (error: unknown) => error instanceof ReferenceColorManagementError && error.code === "CUT_COLOR_PROFILE" && error.source?.nodeId === hostileNode.id);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("linked input conversion preserves source audio samples and structural edit materialization", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-bt470bg-linked-"));
  try {
    await writeTaggedFixture(root);
    const managed = compile(linkedSource(profile)); await applyCutLock(managed, await createCutLock(managed, root), root);
    const legacy = compile(linkedSource(undefined)); await applyCutLock(legacy, await createCutLock(legacy, root), root);
    assert.notDeepEqual((await firstFrame(managed, root, "linked-managed")).data, (await firstFrame(legacy, root, "linked-legacy")).data);
    const renderAudio = async (ir: typeof managed, name: string) => {
      const { composition } = validateReferenceSession(ir), output = resolve(root, `${name}.f32le`);
      await renderReferenceAudioSelection(ir, composition, root, output, referenceMasterAudioRootIds(ir, composition), { outputFormat: "raw-stereo-f32le" });
      return readFile(output);
    };
    const managedAudio = await renderAudio(managed, "managed"), legacyAudio = await renderAudio(legacy, "legacy");
    assert.equal(managedAudio.byteLength, 8_000 * 2 * 4); assert.deepEqual(managedAudio, legacyAudio);

    const operated = compile(operatedSource()); await applyCutLock(operated, await createCutLock(operated, root), root);
    const materialized = Object.values(operated.nodes).find((node) => node.op === "cut.edit.picture_clip");
    assert.deepEqual(materialized?.inputs.inputColor, { kind: "string", value: profile });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("master/proxy variants independently satisfy the exact tuple and a second unrelated fixture renders through the same public runtime", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-bt470bg-proxy-"));
  try {
    const uniform420 = (width: number, height: number, y: number, cb: number, cr: number) => Uint8Array.from([
      ...Array(width * height).fill(y), ...Array(width * height / 4).fill(cb), ...Array(width * height / 4).fill(cr),
    ]);
    await writeTaggedFixture(root, { width: 16, height: 16, pixelFormat: "yuv420p", bytes: uniform420(16, 16, 100, 160, 100) });
    await writeTaggedFixture(root, { name: "proxy.mkv", width: 8, height: 8, pixelFormat: "yuv420p", bytes: uniform420(8, 8, 100, 160, 100) });
    const source = videoSource(profile, "media/proxy.mkv").replace("width: 2px, height: 2px", "width: 8px, height: 8px").replace("width: 2px, height: 2px", "width: 8px, height: 8px");
    const canonical = compile(source), lock = await createCutLock(canonical, root); assert.ok(lock.resources.source.proxy);
    await applyCutLock(canonical, lock, root);
    const master = selectReferenceMediaProfile(canonical, "master"), proxy = selectReferenceMediaProfile(canonical, "proxy");
    assert.equal(proxy.evidence.selectedProxyResources, 1); assert.notEqual(master.ir.buildId, proxy.ir.buildId);
    assert.deepEqual(center(await firstFrame(master.ir, root, "master-profile")), center(await firstFrame(proxy.ir, root, "proxy-profile")));

    await writeTaggedFixture(root, { name: "second.mkv", width: 16, height: 16, pixelFormat: "yuv420p", bytes: uniform420(16, 16, 180, 90, 170) });
    const secondSource = source.replace("media/source.mkv", "media/second.mkv").replace(", proxy: \"media/proxy.mkv\"", "").replace('project "bt470bg input"', 'project "unrelated warm fixture"');
    const second = compile(secondSource); await applyCutLock(second, await createCutLock(second, root), root);
    assert.notDeepEqual(center(await firstFrame(second, root, "second-profile")), center(await firstFrame(master.ir, root, "master-profile-2")));

    await writeTaggedFixture(root, { name: "proxy.mkv", width: 8, height: 8, pixelFormat: "yuv420p", bytes: uniform420(8, 8, 100, 160, 100), transfer: "bt709" });
    await assert.rejects(() => createCutLock(compile(source), root), (error: unknown) => error instanceof CutProxyMediaError && error.code === "CUT_PROXY_COLOR_MAPPING");
  } finally { await rm(root, { recursive: true, force: true }); }
});
