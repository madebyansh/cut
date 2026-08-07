import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import sharp from "sharp";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR, IRNode, IRValue } from "../lib/language/ir";
import { applyCutLock, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { divideRational, multiplyRational, rational } from "../lib/language/rational";
import {
  ReferenceVideoConfigError,
  referenceVideoConfig,
} from "../lib/runtime/reference/video-config";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

const exec = promisify(execFile);

function source(body: string, duration = "1s", setup = "") {
  return `cut 0.4;
project "video contract proof";
import { Video, Rect } from "cut:visual";
asset footage: VideoAsset = video("media/colors.mkv");
${setup}
timeline main(duration: ${duration}, fps: 4, width: 16px, height: 16px, sampleRate: 48khz) {
  scene only(duration: ${duration}) { ${body} }
}
export out = render(main, width: 16px, height: 16px, codec: "h264");`;
}

function parse(value: string) {
  const parsed = parseCutLanguage(value);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  return parsed.module;
}

function compile(value: string) {
  const cutModule = parse(value), checked = checkCutModule(cutModule);
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), []);
  return compileCutModule(cutModule).ir;
}

function video(ir: CutAVIR) {
  const node = Object.values(ir.nodes).find((candidate) => candidate.op === "cut.visual.video");
  assert.ok(node);
  return node;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function fixtureRoot() {
  const root = await mkdtemp(resolve(tmpdir(), "cut-video-contract-")), media = resolve(root, "media");
  await mkdir(media);
  const colors = [
    { r: 224, g: 32, b: 24 },
    { r: 24, g: 208, b: 48 },
    { r: 24, g: 48, b: 224 },
    { r: 232, g: 232, b: 232 },
  ];
  await Promise.all(colors.map((background, index) => sharp({
    create: { width: 16, height: 8, channels: 4, background: { ...background, alpha: 1 } },
  }).png().toFile(resolve(media, `frame-${index}.png`))));
  await exec("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error", "-framerate", "4", "-start_number", "0",
    "-i", resolve(media, "frame-%d.png"), "-frames:v", "4", "-c:v", "ffv1", "-pix_fmt", "bgra",
    resolve(media, "colors.mkv"),
  ]);
  return root;
}

async function locked(root: string, body: string, duration = "1s") {
  const ir = compile(source(body, duration)), lock = await createCutLock(ir, root);
  await applyCutLock(ir, lock, root);
  return ir;
}

function pixel(frame: { data: Buffer; width: number }, x: number, y: number) {
  const offset = (y * frame.width + x) * 4;
  return [...frame.data.subarray(offset, offset + 4)] as [number, number, number, number];
}

function predominantly(actual: readonly number[], channel: 0 | 1 | 2) {
  assert.ok(actual[channel] > 150, `expected channel ${channel} to dominate: ${actual}`);
  for (const other of [0, 1, 2] as const) if (other !== channel) assert.ok(actual[channel] > actual[other] + 80, `expected channel ${channel} to dominate: ${actual}`);
  assert.equal(actual[3], 255);
}

function brightNeutral(actual: readonly number[]) {
  assert.ok(actual[0] > 180 && actual[1] > 180 && actual[2] > 180, `expected a bright neutral pixel: ${actual}`);
  assert.ok(Math.max(actual[0], actual[1], actual[2]) - Math.min(actual[0], actual[1], actual[2]) < 25, `expected a neutral pixel: ${actual}`);
  assert.equal(actual[3], 255);
}

async function frames(ir: CutAVIR, root: string, indexes: readonly number[]) {
  const { composition } = validateReferenceSession(ir, "out"), scene = ir.scenes[composition.sceneIds[0]];
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, ".cut", "video-contract-cache"));
  try {
    await renderer.prepare();
    const result = [];
    for (const index of indexes) result.push(await renderer.sceneFrame(scene, index));
    return result;
  } finally { renderer.close(); }
}

test("Video public source API rejects invalid types, enums, and no-op playback combinations", () => {
  const cases: Array<[string, string]> = [
    ['Video(source: footage, fit: "diagonal");', "CUT2068"],
    ['Video(source: footage, endBehavior: "black");', "CUT2068"],
    ["Video(source: footage, loop: 1);", "CUT2029"],
    ['Video(source: footage, loop: true, endBehavior: "hold");', "CUT2080"],
  ];
  for (const [body, code] of cases) {
    const cutModule = parse(source(body)), diagnostics = checkCutModule(cutModule).diagnostics;
    assert.ok(diagnostics.some((item) => item.code === code && item.span.start.line > 0 && item.span.start.column > 0), `${code}: ${JSON.stringify(diagnostics)}`);
  }
});

test("one shared Video config closes source, exact range, fit, loop, end behavior, and transparent contain semantics", { timeout: 30_000 }, async () => {
  const root = await fixtureRoot(), ir = await locked(root, 'Video(source: footage, range: 250ms ..< 750ms, fit: "contain", endBehavior: "error");', "500ms");
  const config = referenceVideoConfig(ir, ir.compositions[0], video(ir));
  assert.deepEqual(config && {
    resourceId: config.resourceId,
    streamIndex: config.streamIndex,
    sourceStart: config.sourceStart,
    sourceEnd: config.sourceEnd,
    sourceDuration: config.sourceDuration,
    decodeDuration: config.decodeDuration,
    selectedFrameRate: config.selectedFrameRate,
    fit: config.fit,
    containBackground: config.containBackground,
    loop: config.loop,
    endBehavior: config.endBehavior,
  }, {
    resourceId: "footage",
    streamIndex: 0,
    sourceStart: rational(1, 4),
    sourceEnd: rational(3, 4),
    sourceDuration: rational(1, 2),
    decodeDuration: rational(1, 2),
    selectedFrameRate: rational(4),
    fit: "contain",
    containBackground: "transparent",
    loop: false,
    endBehavior: "error",
  });
});

test("hostile loaded Video IR fails preflight with stable source-located diagnostics", { timeout: 30_000 }, async () => {
  const root = await fixtureRoot(), base = await locked(root, 'Video(source: footage, range: 250ms ..< 750ms, fit: "contain", endBehavior: "error");', "500ms");
  const selected = referenceVideoConfig(base, base.compositions[0], video(base))!, timeBase = selected.selectedTimeBase;
  const offGrid = rational(BigInt(timeBase.numerator), BigInt(timeBase.denominator) * 2n);
  const offFrame = rational(1, 8);
  assert.equal(divideRational(offFrame, timeBase).denominator, "1", "125ms fixture must be legal on the codec time base");
  assert.equal(multiplyRational(offFrame, selected.selectedFrameRate).denominator, "2", "125ms fixture must be illegal at 4fps");
  const time = (value: ReturnType<typeof rational>): IRValue => ({ kind: "quantity", dimension: "time", unit: "s", magnitude: value });
  const cases: Array<[string, (node: IRNode, ir: CutAVIR) => void, ReferenceVideoConfigError["code"]]> = [
    ["non-resource source", (node) => { node.inputs.source = { kind: "string", value: "media/colors.mkv" }; }, "CUT_VIDEO_SOURCE"],
    ["wrong resource kind", (_node, ir) => { ir.resources.footage.kind = "audio"; }, "CUT_VIDEO_SOURCE"],
    ["missing selected stream", (_node, ir) => {
      const probe = ir.resources.footage.metadata?.probe as { selected?: { video?: unknown } };
      if (probe.selected) delete probe.selected.video;
    }, "CUT_VIDEO_SOURCE"],
    ["missing source frame rate", (_node, ir) => {
      const probe = ir.resources.footage.metadata?.probe as { identity?: { streams?: Array<{ type?: string; frameRate?: unknown }> } };
      const stream = probe.identity?.streams?.find((candidate) => candidate.type === "video");
      if (stream) delete stream.frameRate;
    }, "CUT_VIDEO_SOURCE"],
    ["range type", (node) => { node.inputs.range = { kind: "string", value: "0..<1" }; }, "CUT_VIDEO_INPUT_TYPE"],
    ["inclusive range", (node) => { if (node.inputs.range?.kind === "range") node.inputs.range.exclusive = false; }, "CUT_VIDEO_INPUT_COMBINATION"],
    ["range endpoint type", (node) => { if (node.inputs.range?.kind === "range") node.inputs.range.start = { kind: "quantity", dimension: "length", unit: "px", magnitude: rational(1) }; }, "CUT_VIDEO_INPUT_TYPE"],
    ["negative range", (node) => { if (node.inputs.range?.kind === "range") node.inputs.range.start = time(rational(-1, 4)); }, "CUT_VIDEO_VALUE_RANGE"],
    ["range overrun", (node) => { if (node.inputs.range?.kind === "range") node.inputs.range.end = time(rational(2)); }, "CUT_VIDEO_VALUE_RANGE"],
    ["source time grid", (node) => { if (node.inputs.range?.kind === "range") node.inputs.range.start = time(offGrid); }, "CUT_VIDEO_TIME_GRID"],
    ["source frame grid", (node) => { if (node.inputs.range?.kind === "range") node.inputs.range.start = time(offFrame); }, "CUT_VIDEO_TIME_GRID"],
    ["loop type", (node) => { node.inputs.loop = { kind: "string", value: "yes" }; }, "CUT_VIDEO_INPUT_TYPE"],
    ["fit enum", (node) => { node.inputs.fit = { kind: "string", value: "inside" }; }, "CUT_VIDEO_INPUT_ENUM"],
    ["end enum", (node) => { node.inputs.endBehavior = { kind: "string", value: "black" }; }, "CUT_VIDEO_INPUT_ENUM"],
    ["trimmed loop", (node) => { node.inputs.loop = { kind: "boolean", value: true }; }, "CUT_VIDEO_INPUT_COMBINATION"],
  ];
  for (const [name, mutate, code] of cases) {
    const ir = clone(base), node = video(ir); mutate(node, ir);
    assert.throws(() => validateReferenceSession(ir, "out"), (error: unknown) => {
      assert.ok(error instanceof ReferenceVideoConfigError, name);
      assert.equal(error.code, code, name);
      assert.match(error.message, /project\.cut:\d+:\d+/, name);
      return true;
    }, name);
  }

  const looping = await locked(root, "Video(source: footage, loop: true);", "1500ms"), loopNode = video(looping);
  loopNode.inputs.endBehavior = { kind: "string", value: "hold" };
  assert.throws(() => validateReferenceSession(looping, "out"), (error: unknown) => error instanceof ReferenceVideoConfigError && error.code === "CUT_VIDEO_INPUT_COMBINATION" && /project\.cut:\d+:\d+/.test(error.message));

  const offDestination = clone(base), offNode = video(offDestination);
  offNode.interval.start = rational(1, 8);
  offNode.interval.duration = rational(1, 8);
  assert.equal(multiplyRational(offNode.interval.start, offDestination.compositions[0].fps).denominator, "2");
  assert.throws(() => validateReferenceSession(offDestination, "out"), (error: unknown) => error instanceof ReferenceVideoConfigError && error.code === "CUT_VIDEO_TIME_GRID" && /destination start/.test(error.message));
});

test("trim, full-source loop, and final-frame hold execute exact visible frame timing", { timeout: 30_000 }, async () => {
  const root = await fixtureRoot();

  const trimmed = await locked(root, 'Video(source: footage, range: 250ms ..< 750ms, fit: "fill");', "500ms");
  const [green, blue] = await frames(trimmed, root, [0, 1]);
  predominantly(pixel(green, 8, 8), 1);
  predominantly(pixel(blue, 8, 8), 2);

  const looped = await locked(root, 'Video(source: footage, fit: "fill", loop: true);', "1500ms");
  const loopFrames = await frames(looped, root, [0, 1, 2, 3, 4, 5]);
  predominantly(pixel(loopFrames[0], 8, 8), 0);
  predominantly(pixel(loopFrames[1], 8, 8), 1);
  predominantly(pixel(loopFrames[2], 8, 8), 2);
  brightNeutral(pixel(loopFrames[3], 8, 8));
  predominantly(pixel(loopFrames[4], 8, 8), 0);
  predominantly(pixel(loopFrames[5], 8, 8), 1);

  const held = await locked(root, 'Video(source: footage, range: 250ms ..< 500ms, fit: "fill", endBehavior: "hold");', "750ms");
  for (const frame of await frames(held, root, [0, 1, 2])) predominantly(pixel(frame, 8, 8), 1);

  const heldFullSource = await locked(root, 'Video(source: footage, fit: "fill", endBehavior: "hold");', "1250ms");
  const [sourceLast, heldLast] = await frames(heldFullSource, root, [3, 4]);
  brightNeutral(pixel(sourceLast, 8, 8));
  brightNeutral(pixel(heldLast, 8, 8));
});

test("contain preserves transparent letterbox pixels so lower layers remain visible", { timeout: 30_000 }, async () => {
  const root = await fixtureRoot();
  const ir = await locked(root, 'Rect(width: 16px, height: 16px, fill: #254fdc); Video(source: footage, range: 0s ..< 250ms, fit: "contain");', "250ms");
  const [frame] = await frames(ir, root, [0]);
  predominantly(pixel(frame, 8, 1), 2);
  predominantly(pixel(frame, 8, 8), 0);
});
