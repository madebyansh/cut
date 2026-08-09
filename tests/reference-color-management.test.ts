import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import { checkCutModule } from "../lib/language/checker";
import { loadCutAvIr } from "../lib/language/ir-loader";
import { parseCutLanguage } from "../lib/language/parser";
import { packageSymbol } from "../lib/language/packages";
import { editClipParameterNames } from "../lib/language/picture-edit-signature";
import { applyCutLock, createCutLock, type CutLockfile } from "../lib/language/lock";
import { CutOutputContractError } from "../lib/language/output-contract";
import { createIncrementalRenderPlan, finalizeGraphHashes } from "../lib/runtime/graph";
import {
  convertReferenceColorSurface,
  inspectReferenceColorSurface,
  ReferenceColorManagementError,
  referenceColorProfiles,
  referenceColorConvertConfig,
  type ReferenceColorProfile,
} from "../lib/runtime/reference/color-management";
import { referenceH264ColorEncoderArgs, runFfmpeg, runFfprobeCapture } from "../lib/runtime/reference/ffmpeg";
import { referenceMasterAudioRootIds, renderReferenceAudioSelection } from "../lib/runtime/reference/audio";
import { renderReferenceIr } from "./reference-render-test-helper";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

function compile(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  return compileCutModule(parsed.module).ir;
}

function program(body: string, color?: string, sampleRate = "8khz") {
  return `cut 0.4;
project "managed color";
import { ColorConvert, Composite, Rect } from "cut:visual";
timeline main(duration: 1s, fps: 1, width: 8px, height: 8px, sampleRate: ${sampleRate}) {
  scene only(duration: 1s) { ${body} }
}
export out = render(main${color ? `, color: "${color}"` : ""});`;
}

async function frame(body: string) {
  const ir = compile(program(body)), { composition } = validateReferenceSession(ir);
  const root = await mkdtemp(resolve(tmpdir(), "cut-color-frame-"));
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "cache"));
  await renderer.prepare();
  try {
    return await renderer.sceneFrame(ir.scenes[composition.sceneIds[0]], 0, false);
  } finally {
    renderer.close();
    await rm(root, { recursive: true, force: true });
  }
}

function center(surface: { data: Uint8Array; width: number; height: number }) {
  const offset = (Math.floor(surface.height / 2) * surface.width + Math.floor(surface.width / 2)) * 4;
  return [...surface.data.subarray(offset, offset + 4)];
}

test("bounded SDR transfer/range math has exact byte vectors and preserves straight alpha plus hidden RGB", () => {
  const source = { data: Uint8Array.from([64, 128, 192, 127, 64, 128, 192, 0]), width: 2, height: 1 };
  assert.deepEqual([...convertReferenceColorSurface(source, "srgb", "linear-srgb").data], [13, 55, 134, 127, 13, 55, 134, 0]);
  assert.deepEqual([...convertReferenceColorSurface({ data: Uint8Array.from([64, 128, 192, 127]), width: 1, height: 1 }, "linear-srgb", "srgb").data], [137, 188, 225, 127]);
  assert.deepEqual([...convertReferenceColorSurface({ data: Uint8Array.from([64, 128, 192, 127]), width: 1, height: 1 }, "srgb", "rec709-full").data], [48, 115, 185, 127]);
  assert.deepEqual([...convertReferenceColorSurface({ data: Uint8Array.from([64, 128, 192, 127]), width: 1, height: 1 }, "rec709-full", "srgb").data], [79, 140, 198, 127]);
  assert.deepEqual([...convertReferenceColorSurface({ data: Uint8Array.from([0, 128, 255, 127]), width: 1, height: 1 }, "rec709-full", "rec709-limited").data], [16, 126, 235, 127]);
  assert.deepEqual([...convertReferenceColorSurface({ data: Uint8Array.from([16, 126, 235, 127]), width: 1, height: 1 }, "rec709-limited", "rec709-full").data], [0, 128, 255, 127]);
  assert.throws(
    () => convertReferenceColorSurface({ data: Uint8Array.from([15, 126, 236, 255]), width: 1, height: 1 }, "rec709-limited", "srgb"),
    (error: unknown) => error instanceof ReferenceColorManagementError && error.code === "CUT_COLOR_RANGE",
  );
  assert.throws(
    () => convertReferenceColorSurface({ data: Uint8Array.from([10, 20, 30, 128]), width: 1, height: 1, alphaMode: "premultiplied" }, "srgb", "linear-srgb"),
    (error: unknown) => error instanceof ReferenceColorManagementError && error.code === "CUT_COLOR_ALPHA",
  );
});

test("cached RGBA8 transfer tables are exhaustive scalar-law parity and preserve input ownership", () => {
  const metadata = {
    srgb: { transfer: "srgb", range: "full" },
    "linear-srgb": { transfer: "linear", range: "full" },
    "rec709-full": { transfer: "bt709", range: "full" },
    "rec709-limited": { transfer: "bt709", range: "limited" },
  } as const;
  const decodeTransfer = (encoded: number, transfer: "srgb" | "linear" | "bt709") => {
    const value = Math.max(0, Math.min(1, encoded));
    if (transfer === "linear") return value;
    if (transfer === "srgb") return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    return value < 0.081 ? value / 4.5 : ((value + 0.099) / 1.099) ** (1 / 0.45);
  };
  const encodeTransfer = (linear: number, transfer: "srgb" | "linear" | "bt709") => {
    const value = Math.max(0, Math.min(1, linear));
    if (transfer === "linear") return value;
    if (transfer === "srgb") return value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
    return value < 0.018 ? 4.5 * value : 1.099 * value ** 0.45 - 0.099;
  };
  for (const from of referenceColorProfiles) {
    const validCodes = from === "rec709-limited"
      ? Array.from({ length: 220 }, (_unused, index) => index + 16)
      : Array.from({ length: 256 }, (_unused, index) => index);
    for (const to of referenceColorProfiles) {
      const input = Uint8Array.from(validCodes.flatMap((code) => [code, code, code, code]));
      const before = Buffer.from(input);
      const result = convertReferenceColorSurface({ data: input, width: validCodes.length, height: 1 }, from, to);
      assert.deepEqual(Buffer.from(input), before, `${from} -> ${to} must not mutate the caller's bytes`);
      if (from === to) assert.equal(result.data, input, `${from} identity conversion retains ownership`);
      validCodes.forEach((code, index) => {
        const source = metadata[from], destination = metadata[to];
        const encoded = source.range === "limited" ? (code - 16) / 219 : code / 255;
        const converted = encodeTransfer(decodeTransfer(encoded, source.transfer), destination.transfer);
        const expected = Math.round(destination.range === "limited" ? 16 + converted * 219 : converted * 255);
        assert.deepEqual(
          [...result.data.subarray(index * 4, index * 4 + 4)],
          [expected, expected, expected, code],
          `${from} -> ${to} code ${code}`,
        );
      });
    }
  }
});

test("legal-range inspection reports violations, clipping boundaries, and transparency without mutating pixels", () => {
  const surface = { data: Uint8Array.from([15, 16, 235, 0, 236, 16, 235, 255]), width: 2, height: 1 };
  assert.deepEqual(inspectReferenceColorSurface(surface, "rec709-limited"), {
    profile: "rec709-limited",
    pixels: 2,
    transparentPixels: 1,
    lowerLegalViolations: 1,
    upperLegalViolations: 1,
    clippedBlackChannels: 2,
    clippedWhiteChannels: 2,
  });
  assert.deepEqual([...surface.data], [15, 16, 235, 0, 236, 16, 235, 255]);
});

test("ColorConvert is public typed CUT syntax and lowers to one closed executable kernel", () => {
  const ir = compile(program('ColorConvert(from: "srgb", to: "linear-srgb") { Rect(width: 8px, height: 8px, fill: #4080c080); }', "rec709-limited"));
  const node = Object.values(ir.nodes).find((candidate) => candidate.op === "cut.visual.color_convert");
  assert.ok(node);
  assert.deepEqual(referenceColorConvertConfig(node), { nodeId: node.id, from: "srgb", to: "linear-srgb", alpha: "straight" });
  assert.equal(node.children.length, 1);
  assert.deepEqual(validateReferenceSession(ir).outputContract, { width: 8, height: 8, codec: "h264", color: "rec709-limited" });

  const bad = parseCutLanguage(program('ColorConvert(from: "pq", to: "srgb") { Rect(width: 8px, height: 8px, fill: #ffffff); }'));
  assert.ok(bad.module);
  assert.throws(() => compileCutModule(bad.module!), (error: unknown) => error instanceof CutCompileError && error.result.diagnostics.some((item) => /must be one of/.test(item.message)));
});

test("loaded IR profile, alpha, graph, and output tampering fail with stable source-located codes", () => {
  const base = compile(program('ColorConvert(from: "srgb", to: "linear-srgb") { Rect(width: 8px, height: 8px, fill: #4080c0); }'));
  const mutateNode = (mutate: (node: (typeof base.nodes)[string]) => void) => {
    const ir = structuredClone(base), node = Object.values(ir.nodes).find((candidate) => candidate.op === "cut.visual.color_convert")!;
    mutate(node);
    return () => validateReferenceSession(ir);
  };
  assert.throws(mutateNode((node) => { node.inputs.from = { kind: "string", value: "pq" }; }), (error: unknown) => error instanceof ReferenceColorManagementError && error.code === "CUT_COLOR_PROFILE" && error.source?.line === 5 && error.source.column > 0);
  assert.throws(mutateNode((node) => { node.inputs.alpha = { kind: "string", value: "premultiplied" }; }), (error: unknown) => error instanceof ReferenceColorManagementError && error.code === "CUT_COLOR_ALPHA");
  assert.throws(mutateNode((node) => { node.children = []; }), (error: unknown) => error instanceof Error && "code" in error && error.code === "CUT_NODE_NOOP" && /project\.cut:5:/.test(error.message));
  const badOutput = structuredClone(base); badOutput.outputs[0].parameters.color = { kind: "string", value: "hlg" };
  assert.throws(() => validateReferenceSession(badOutput), (error: unknown) => error instanceof CutOutputContractError && error.code === "CUT_OUTPUT_COLOR" && /project\.cut:7:/.test(error.message));
});

test("ColorConvert pixels execute at their authored graph position, so compositing order is explicit", async () => {
  const converted = await frame('ColorConvert(from: "srgb", to: "linear-srgb") { Rect(width: 8px, height: 8px, fill: #4080c080); }');
  assert.deepEqual(center(converted), [13, 54, 133, 128]);

  const afterComposite = await frame('ColorConvert(from: "srgb", to: "linear-srgb") { Composite() { Rect(width: 8px, height: 8px, fill: #0000ff); Rect(width: 8px, height: 8px, fill: #ff000080); } }');
  const beforeComposite = await frame('Composite() { ColorConvert(from: "srgb", to: "linear-srgb") { Rect(width: 8px, height: 8px, fill: #0000ff); } ColorConvert(from: "srgb", to: "linear-srgb") { Rect(width: 8px, height: 8px, fill: #ff000080); } }');
  assert.notDeepEqual(center(afterComposite), center(beforeComposite));
  assert.deepEqual(center(afterComposite), [128, 0, 127, 255]);

  await assert.rejects(
    () => frame('ColorConvert(from: "rec709-limited", to: "srgb") { Rect(width: 8px, height: 8px, fill: #000000); }'),
    (error: unknown) => error instanceof ReferenceColorManagementError && error.code === "CUT_COLOR_RANGE" && error.source?.line === 5,
  );
});

function cacheProgram(to: "linear-srgb" | "rec709-full") {
  return compile(`cut 0.4;
project "color cache locality";
import { ColorConvert, Rect } from "cut:visual";
timeline main(duration: 2s, fps: 1, width: 8px, height: 8px, sampleRate: 8khz) {
  scene managed(duration: 1s) { ColorConvert(from: "srgb", to: "${to}") { Rect(width: 8px, height: 8px, fill: #4080c0); } }
  scene unrelated(duration: 1s) { Rect(width: 8px, height: 8px, fill: #ffcc00); }
}
export out = render(main);`);
}

test("profile edits invalidate only the wrapper, its ancestors, and its containing scene", () => {
  const before = cacheProgram("linear-srgb"), previous = createIncrementalRenderPlan(before, "main").manifest;
  const after = cacheProgram("rec709-full"), plan = createIncrementalRenderPlan(after, "main", previous);
  const wrapper = Object.values(after.nodes).find((node) => node.op === "cut.visual.color_convert")!;
  const child = Object.values(after.nodes).find((node) => node.op === "cut.visual.rect" && node.sceneId === wrapper.sceneId)!;
  assert.equal(plan.nodes.find((item) => item.id === child.id)?.status, "hit");
  assert.equal(plan.nodes.find((item) => item.id === wrapper.id)?.status, "miss");
  assert.deepEqual(plan.scenes.map((item) => item.status), ["miss", "hit"]);

  const explicitOutput = createIncrementalRenderPlan(before, "main", previous, undefined, undefined, "rec709-limited");
  assert.ok(explicitOutput.scenes.every((item) => item.status === "miss"), "delivery color participates in the picture target identity");
  assert.equal(previous.target.color, undefined, "legacy omission preserves the pre-managed cache target shape");
  assert.deepEqual(referenceH264ColorEncoderArgs("legacy"), ["-pix_fmt", "yuv420p"]);
});

async function managedVideoFixture(root: string) {
  await mkdir(resolve(root, "media"));
  await runFfmpeg([
    "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=#cc8844:s=64x64:r=4:d=1",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-x264-params", "colorprim=bt709:transfer=bt709:colormatrix=bt709:fullrange=off",
    resolve(root, "media/source.mp4"),
  ]);
}

async function managedAvFixture(root: string) {
  await mkdir(resolve(root, "media"));
  await runFfmpeg([
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "color=c=#cc8844:s=64x64:r=4:d=1",
    "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=8000:duration=1",
    "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-x264-params", "colorprim=bt709:transfer=bt709:colormatrix=bt709:fullrange=off",
    "-c:a", "pcm_s16le",
    resolve(root, "media/source.mkv"),
  ]);
}

function videoProgram(inputColor: ReferenceColorProfile | undefined) {
  return compile(`cut 0.4;
project "locked input color";
import { Video } from "cut:visual";
asset source: VideoAsset = video("media/source.mp4");
timeline main(duration: 1s, fps: 4, width: 64px, height: 64px, sampleRate: 8khz) {
  scene only(duration: 1s) { Video(source: source${inputColor ? `, inputColor: "${inputColor}"` : ""}); }
}
export out = render(main);`);
}

function pictureClipProgram(inputColor: ReferenceColorProfile | undefined) {
  return compile(`cut 0.4;
project "locked editorial input color";
import { PictureClip, PictureTrack, Sequence } from "@cut/edit";
asset source: VideoAsset = video("media/source.mp4");
timeline main(duration: 1s, fps: 4, width: 64px, height: 64px, sampleRate: 8khz) {
  scene only(duration: 1s) {
    Sequence(duration: 1s) {
      PictureTrack() {
        PictureClip(source: source, range: 0s ..< 1s, duration: 1s${inputColor ? `, inputColor: "${inputColor}"` : ""});
      }
    }
  }
}
export out = render(main);`);
}

function operatedPictureClipProgram() {
  return compile(`cut 0.4;
project "operated editorial input color";
import { PictureClip, PictureTrack, Sequence, editClip, replace } from "@cut/edit";
asset source: VideoAsset = video("media/source.mp4");
timeline main(duration: 1s, fps: 4, width: 64px, height: 64px, sampleRate: 8khz) {
  scene only(duration: 1s) {
    Sequence(duration: 1s) {
      PictureTrack(sourceDuration: 1s, edits: [
        replace(range: 0s ..< 1s, item: editClip(source: source, range: 0s ..< 1s, duration: 1s, inputColor: "rec709-limited"))
      ]) {
        PictureClip(source: source, range: 0s ..< 1s, duration: 1s);
      }
    }
  }
}
export out = render(main);`);
}

function supersededOperatedPictureClipProgram() {
  return compile(`cut 0.4;
project "superseded editorial input color";
import { PictureClip, PictureTrack, Sequence, editClip, editGap, replace } from "@cut/edit";
asset source: VideoAsset = video("media/source.mp4");
timeline main(duration: 1s, fps: 4, width: 64px, height: 64px, sampleRate: 8khz) {
  scene only(duration: 1s) {
    Sequence(duration: 1s) {
      PictureTrack(sourceDuration: 1s, edits: [
        replace(range: 0s ..< 1s, item: editClip(source: source, range: 0s ..< 1s, duration: 1s, inputColor: "rec709-limited")),
        replace(range: 0s ..< 1s, item: editGap(duration: 1s))
      ]) {
        PictureClip(source: source, range: 0s ..< 1s, duration: 1s);
      }
    }
  }
}
export out = render(main);`);
}

function linkedClipProgram(inputColor: ReferenceColorProfile | undefined) {
  return compile(`cut 0.4;
project "locked linked input color";
import { Clip } from "@cut/edit";
asset source: VideoAsset = video("media/source.mkv");
timeline main(duration: 1s, fps: 4, width: 64px, height: 64px, sampleRate: 8khz) {
  scene only(duration: 1s) {
    Clip(source: source, range: 0s ..< 1s, duration: 1s${inputColor ? `, inputColor: "${inputColor}"` : ""});
  }
}
export out = render(main);`);
}

test("video color inputs extend Video/Clip/PictureClip/editClip without remapping frozen positional parameters", () => {
  assert.deepEqual(packageSymbol("cut:visual", "Video")?.parameters?.map((parameter) => parameter.name), [
    "source", "range", "fit", "loop", "endBehavior", "inputColor", "opacity", "scale", "rotation", "inputColorInterpretation", "crop", "x", "y",
  ]);
  assert.deepEqual(packageSymbol("@cut/edit", "Clip")?.parameters?.map((parameter) => parameter.name), [
    "source", "range", "duration", "fadeIn", "fadeOut", "opacity", "scale", "rotation", "inputColor", "inputColorInterpretation",
  ]);
  assert.deepEqual(packageSymbol("@cut/edit", "PictureClip")?.parameters?.map((parameter) => parameter.name), [
    "source", "range", "duration", "headHandle", "tailHandle", "playback", "rate", "freezeAt",
    "speedRamp", "fit", "opacity", "scale", "rotation", "link", "inputColor",
    "inputColorInterpretation", "frameSelection", "editId", "role", "metadata",
  ]);
  assert.deepEqual(packageSymbol("@cut/edit", "editClip")?.parameters?.map((parameter) => parameter.name).slice(-6), [
    "opacity", "scale", "rotation", "inputColor", "inputColorInterpretation", "frameSelection",
  ]);
  assert.deepEqual(
    editClipParameterNames,
    packageSymbol("@cut/edit", "editClip")?.parameters?.map((parameter) => parameter.name),
    "the public signature and operation-value positional lowerer share one canonical order",
  );

  const legacyVideo = compile(`cut 0.4;
project "positional Video compatibility";
import { Video } from "cut:visual";
asset media: VideoAsset = video("media/source.mp4");
timeline main(duration: 1s, fps: 4, width: 64px, height: 64px, sampleRate: 8khz) {
  scene only(duration: 1s) { Video(media, 0s ..< 1s, "contain", false, "error", "rec709-limited", 50%, 1.2, 5deg); }
}
export out = render(main);`);
  const legacyVideoNode = Object.values(legacyVideo.nodes).find((node) => node.op === "cut.visual.video");
  assert.deepEqual(legacyVideoNode?.inputs.inputColor, { kind: "string", value: "rec709-limited" });
  assert.deepEqual(legacyVideoNode?.inputs.opacity, { kind: "quantity", dimension: "ratio", magnitude: { numerator: "1", denominator: "2" }, unit: "ratio" });
  assert.deepEqual(legacyVideoNode?.inputs.scale, { kind: "quantity", dimension: "scalar", magnitude: { numerator: "6", denominator: "5" }, unit: "scalar" });
  assert.deepEqual(legacyVideoNode?.inputs.rotation, { kind: "quantity", dimension: "angle", magnitude: { numerator: "5", denominator: "1" }, unit: "deg" });

  const positional = (inputColor = "") => `cut 0.4;
project "positional linked color compatibility";
import { Clip } from "@cut/edit";
asset media: VideoAsset = video("media/source.mkv");
timeline main(duration: 1s, fps: 4, width: 64px, height: 64px, sampleRate: 8khz) {
  scene only(duration: 1s) { Clip(media, 0s ..< 1s, 1s, 0s, 0s, 100%, 1, 0deg${inputColor}); }
}
export out = render(main);`;
  for (const [suffix, expected] of [["", undefined], [', "rec709-limited"', "rec709-limited"]] as const) {
    const parsed = parseCutLanguage(positional(suffix));
    assert.ok(parsed.module);
    assert.deepEqual(checkCutModule(parsed.module).diagnostics.filter((item) => item.severity === "error"), []);
    const node = Object.values(compileCutModule(parsed.module).ir.nodes).find((candidate) => candidate.op === "cut.edit.clip");
    assert.ok(node);
    assert.equal(node.inputs.opacity?.kind, "quantity");
    assert.equal(node.inputs.scale?.kind, "quantity");
    assert.equal(node.inputs.rotation?.kind, "quantity");
    assert.equal(node.inputs.inputColor?.kind === "string" ? node.inputs.inputColor.value : undefined, expected);
  }

  const mixedSource = (operation: boolean) => `cut 0.4;
project "mixed positional picture compatibility";
import { Gap, PictureClip, PictureTrack, Sequence, editClip, overwrite } from "@cut/edit";
asset media: VideoAsset = video("media/source.mp4");
timeline main(duration: 1s, fps: 4, width: 64px, height: 64px, sampleRate: 8khz) {
  scene only(duration: 1s) {
    Sequence(duration: 1s) {
      PictureTrack(${operation ? 'sourceDuration: 1s, edits: [overwrite(range: 0s ..< 1s, item: editClip(media, 0s ..< 1s, 1s, 0s, 0s, "normal", 1, fit: "contain", opacity: 50%, scale: 1.2, rotation: 5deg, inputColor: "rec709-limited"))]' : ""}) {
        ${operation ? "Gap(duration: 1s);" : 'PictureClip(media, 0s ..< 1s, 1s, 0s, 0s, "normal", 1, fit: "contain", opacity: 50%, scale: 1.2, rotation: 5deg, inputColor: "rec709-limited");'}
      }
    }
  }
}
export out = render(main);`;
  for (const operation of [false, true]) {
    const ir = compile(mixedSource(operation));
    const node = Object.values(ir.nodes).find((candidate) => candidate.op === "cut.edit.picture_clip");
    assert.ok(node, operation ? "editClip must materialize PictureClip" : "direct PictureClip must lower");
    assert.deepEqual(node.inputs.fit, { kind: "string", value: "contain" });
    assert.deepEqual(node.inputs.opacity, { kind: "quantity", dimension: "ratio", magnitude: { numerator: "1", denominator: "2" }, unit: "ratio" });
    assert.deepEqual(node.inputs.scale, { kind: "quantity", dimension: "scalar", magnitude: { numerator: "6", denominator: "5" }, unit: "scalar" });
    assert.deepEqual(node.inputs.rotation, { kind: "quantity", dimension: "angle", magnitude: { numerator: "5", denominator: "1" }, unit: "deg" });
    assert.deepEqual(node.inputs.inputColor, { kind: "string", value: "rec709-limited" });
  }
});

test("Video.inputColor is checked against lock-selected ffprobe metadata and managed decode changes transfer, while omission stays legacy", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-color-input-"));
  try {
    await managedVideoFixture(root);
    const managed = videoProgram("rec709-limited"), lock = await createCutLock(managed, root);
    const probe = lock.resources.source.probe;
    assert.equal(probe.kind, "media");
    if (probe.kind !== "media") return;
    const stream = probe.identity.streams.find((candidate) => candidate.index === probe.selected.video?.streamIndex)!;
    assert.deepEqual({ range: stream.colorRange, matrix: stream.colorSpace, transfer: stream.colorTransfer, primaries: stream.colorPrimaries }, { range: "tv", matrix: "bt709", transfer: "bt709", primaries: "bt709" });
    await applyCutLock(managed, lock, root);

    const legacy = videoProgram(undefined); await applyCutLock(legacy, await createCutLock(legacy, root), root);
    const renderPixel = async (ir: typeof managed) => {
      const { composition } = validateReferenceSession(ir), renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, `.cut/test-${Math.random()}`));
      await renderer.prepare();
      try { return center(await renderer.sceneFrame(ir.scenes[composition.sceneIds[0]], 0, false)); }
      finally { renderer.close(); }
    };
    const managedPixel = await renderPixel(managed), legacyPixel = await renderPixel(legacy);
    assert.notDeepEqual(managedPixel, legacyPixel);

    await assert.rejects(
      () => createCutLock(videoProgram("srgb"), root),
      (error: unknown) => error instanceof ReferenceColorManagementError && error.code === "CUT_COLOR_METADATA" && /expected iec61966-2-1/.test(error.message),
    );

    const tampered = structuredClone(lock) as CutLockfile;
    const tamperedProbe = tampered.resources.source.probe;
    if (tamperedProbe.kind === "media") tamperedProbe.identity.streams[0].colorTransfer = "iec61966-2-1";
    const fresh = videoProgram("rec709-limited");
    await assert.rejects(() => applyCutLock(fresh, tampered, root), /CUT_LOCK_METADATA/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PictureClip.inputColor shares the locked decoder contract, changes pixels/cache identity, and survives edit materialization", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-picture-color-input-"));
  try {
    await managedVideoFixture(root);
    const managed = pictureClipProgram("rec709-limited");
    await applyCutLock(managed, await createCutLock(managed, root), root);
    const legacy = pictureClipProgram(undefined);
    await applyCutLock(legacy, await createCutLock(legacy, root), root);

    const renderPixel = async (ir: typeof managed) => {
      const { composition } = validateReferenceSession(ir);
      const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, `.cut/picture-${Math.random()}`));
      await renderer.prepare();
      try { return center(await renderer.sceneFrame(ir.scenes[composition.sceneIds[0]], 0, false)); }
      finally { renderer.close(); }
    };
    assert.notDeepEqual(await renderPixel(managed), await renderPixel(legacy));

    await assert.rejects(
      () => createCutLock(pictureClipProgram("srgb"), root),
      (error: unknown) => error instanceof ReferenceColorManagementError
        && error.code === "CUT_COLOR_METADATA"
        && error.source?.line === 9,
    );

    const before = pictureClipProgram(undefined);
    const previous = createIncrementalRenderPlan(before, "main").manifest;
    const changed = createIncrementalRenderPlan(pictureClipProgram("rec709-limited"), "main", previous);
    assert.deepEqual(changed.scenes.map((scene) => scene.status), ["miss"]);

    const operated = operatedPictureClipProgram();
    const materialized = Object.values(operated.nodes).find((node) => node.op === "cut.edit.picture_clip");
    assert.deepEqual(materialized?.inputs.inputColor, { kind: "string", value: "rec709-limited" });
    const plan = Object.values(operated.nodes).find((node) => node.op === "cut.edit.picture_track")?.editorial;
    assert.equal(plan?.kind, "picture-track");
    if (plan?.kind === "picture-track") {
      assert.deepEqual(plan.operationPlan?.operations[0].kind, "replace");
      const replacement = plan.operationPlan?.operations[0];
      assert.ok(replacement && "item" in replacement);
      if (replacement && "item" in replacement) assert.deepEqual(replacement.item.inputs.inputColor, { kind: "string", value: "rec709-limited" });
    }

    const hostile = structuredClone(managed);
    const clip = Object.values(hostile.nodes).find((node) => node.op === "cut.edit.picture_clip")!;
    clip.inputs.inputColor = { kind: "string", value: "pq" };
    assert.throws(
      () => validateReferenceSession(hostile),
      (error: unknown) => error instanceof ReferenceColorManagementError
        && error.code === "CUT_COLOR_PROFILE"
        && error.source?.nodeId === clip.id,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("strictly loaded superseded editClip operands still validate every authored inputColor", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-superseded-color-input-"));
  try {
    await managedVideoFixture(root);
    const hostile = supersededOperatedPictureClipProgram();
    await applyCutLock(hostile, await createCutLock(hostile, root), root);
    const track = Object.values(hostile.nodes).find((node) => node.op === "cut.edit.picture_track");
    assert.equal(track?.editorial?.kind, "picture-track");
    if (track?.editorial?.kind !== "picture-track") return;
    const first = track.editorial.operationPlan?.operations[0];
    assert.ok(first && "item" in first && first.item.kind === "picture");
    if (!first || !("item" in first) || first.item.kind !== "picture") return;
    first.item.inputs.inputColor = { kind: "string", value: "pq" };
    finalizeGraphHashes(hostile);
    const loaded = loadCutAvIr(JSON.stringify(hostile));
    assert.throws(
      () => validateReferenceSession(loaded),
      (error: unknown) => error instanceof ReferenceColorManagementError
        && error.code === "CUT_COLOR_PROFILE"
        && error.source?.line === 9,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("linked Clip.inputColor executes the same managed picture path without changing its source-audio contract", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-linked-color-input-"));
  try {
    await managedAvFixture(root);
    const managed = linkedClipProgram("rec709-limited");
    await applyCutLock(managed, await createCutLock(managed, root), root);
    const legacy = linkedClipProgram(undefined);
    await applyCutLock(legacy, await createCutLock(legacy, root), root);
    const renderPixel = async (ir: typeof managed) => {
      const { composition } = validateReferenceSession(ir);
      const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, `.cut/linked-${Math.random()}`));
      await renderer.prepare();
      try { return center(await renderer.sceneFrame(ir.scenes[composition.sceneIds[0]], 0, false)); }
      finally { renderer.close(); }
    };
    assert.notDeepEqual(await renderPixel(managed), await renderPixel(legacy));

    const renderAudio = async (ir: typeof managed, name: string) => {
      const { composition } = validateReferenceSession(ir), output = resolve(root, `${name}.f32le`);
      await renderReferenceAudioSelection(ir, composition, root, output, referenceMasterAudioRootIds(ir, composition), { outputFormat: "raw-stereo-f32le" });
      return readFile(output);
    };
    const managedAudio = await renderAudio(managed, "managed-linked-audio");
    const legacyAudio = await renderAudio(legacy, "legacy-linked-audio");
    assert.equal(managedAudio.byteLength, 8_000 * 2 * 4);
    assert.deepEqual(managedAudio, legacyAudio, "picture-only inputColor must preserve every decoded linked source-audio sample");

    const mismatch = linkedClipProgram("srgb");
    await assert.rejects(
      () => createCutLock(mismatch, root),
      (error: unknown) => error instanceof ReferenceColorManagementError
        && error.code === "CUT_COLOR_METADATA"
        && error.source?.nodeId === Object.values(mismatch.nodes).find((node) => node.op === "cut.edit.clip")?.id,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("each explicit delivery profile writes and re-verifies exact H.264 ffprobe tags; legacy remains the old untagged path", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-color-output-"));
  try {
    const expectations: Array<[ReferenceColorProfile, { color_range: string; color_space: string; color_transfer: string; color_primaries: string }]> = [
      ["srgb", { color_range: "pc", color_space: "bt709", color_transfer: "iec61966-2-1", color_primaries: "bt709" }],
      ["linear-srgb", { color_range: "pc", color_space: "bt709", color_transfer: "linear", color_primaries: "bt709" }],
      ["rec709-full", { color_range: "pc", color_space: "bt709", color_transfer: "bt709", color_primaries: "bt709" }],
      ["rec709-limited", { color_range: "tv", color_space: "bt709", color_transfer: "bt709", color_primaries: "bt709" }],
    ];
    for (const [profile, expected] of expectations) {
      const ir = compile(program('Rect(width: 8px, height: 8px, fill: #4080c0);', profile, "48khz")), output = resolve(root, `${profile}.mp4`);
      const manifest = await renderReferenceIr(ir, root, output);
      assert.equal(manifest.color.delivery, profile);
      assert.deepEqual(manifest.color.ffprobe, {
        colorRange: expected.color_range,
        colorSpace: expected.color_space,
        colorTransfer: expected.color_transfer,
        colorPrimaries: expected.color_primaries,
      });
      const probe = await runFfprobeCapture(["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=color_range,color_space,color_transfer,color_primaries", "-of", "json", output]);
      assert.deepEqual((JSON.parse(probe.stdout) as { streams: unknown[] }).streams[0], expected);
    }

    const legacyIr = compile(program('Rect(width: 8px, height: 8px, fill: #4080c0);', undefined, "48khz")), legacy = await renderReferenceIr(legacyIr, root, resolve(root, "legacy.mp4"));
    assert.equal(legacy.color.delivery, "legacy-untagged");
    assert.equal(legacy.color.ffprobe.colorTransfer, undefined);
    assert.equal(legacy.color.ffprobe.colorPrimaries, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
