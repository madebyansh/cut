import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR, IRNode, IRValue } from "../lib/language/ir";
import { loadCutAvIr } from "../lib/language/ir-loader";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { cutSignalContentHash, finalizeGraphHashes } from "../lib/runtime/graph";
import { prepareReferenceTrace, referenceTracePrefix } from "../lib/runtime/reference/trace";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

function program(body: string, duration = "2s") {
  return `cut 0.4;
project "reference trace";
import { Trace } from "cut:visual";
timeline main(duration: ${duration}, fps: 10, width: 64px, height: 64px, sampleRate: 48khz) {
  scene only(duration: ${duration}) { ${body} }
}
export out = render(main, width: 64px, height: 64px, codec: "h264");`;
}

const canonicalBody = `Trace(
  points: [{ x: 8px, y: 48px }, { x: 16px, y: 48px }, { x: 16px, y: 16px }],
  stroke: #00ff00,
  width: 2px,
  duration: 1s,
  delay: 200ms,
  headRadius: 4px,
  headColor: #ff0000,
  headFade: 200ms,
  easing: "linear",
  opacity: 100%,
  scale: 1,
  rotation: 0deg
) as trace;
animate trace.x from 0px to 4px over 1s;`;

function parse(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  return parsed.module;
}

function compiledIr(mutate?: (node: IRNode, ir: CutAVIR) => void) {
  const ir = compileCutModule(parse(program(canonicalBody))).ir;
  ir.determinism.semantic = "locked";
  const node = Object.values(ir.nodes).find((item) => item.op === "cut.visual.trace");
  assert.ok(node);
  mutate?.(node, ir);
  for (const signal of Object.values(ir.signals)) signal.contentHash = cutSignalContentHash(signal);
  finalizeGraphHashes(ir);
  return ir;
}

function canonicalIr(mutate?: (node: IRNode, ir: CutAVIR) => void) { return loadCutAvIr(JSON.stringify(compiledIr(mutate))); }

const quantity = (dimension: string, value: number, unit: string): IRValue => ({ kind: "quantity", dimension, magnitude: rational(value), unit });
const px = (value: number) => quantity("length", value, "px");
const seconds = (value: number) => quantity("time", value, "s");
const ratio = (value: number) => quantity("ratio", value, "ratio");
const scalar = (value: number) => quantity("scalar", value, "scalar");
const degrees = (value: number) => quantity("angle", value, "deg");
const point = (x: IRValue, y: IRValue, extra?: IRValue): IRValue => ({ kind: "object", entries: { x, y, ...(extra ? { extra } : {}) } });

function pixel(surface: { data: Uint8Array; width: number }, x: number, y: number) {
  const offset = (y * surface.width + x) * 4;
  return [...surface.data.subarray(offset, offset + 4)];
}

function isBackground(value: number[]) { return value[0] < 20 && value[1] < 25 && value[2] < 30; }
function isGreen(value: number[]) { return value[1] > 150 && value[1] > value[0] * 2 && value[1] > value[2] * 2; }
function isRed(value: number[]) { return value[0] > 150 && value[0] > value[1] * 2 && value[0] > value[2] * 2; }

async function renderFrames(body: string, frames: number[]) {
  const ir = compileCutModule(parse(program(body))).ir;
  ir.determinism.semantic = "locked";
  const { composition } = validateReferenceSession(ir);
  const root = await mkdtemp(resolve(tmpdir(), "cut-reference-trace-"));
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "cache"));
  await renderer.prepare();
  try {
    const scene = ir.scenes[composition.sceneIds[0]];
    const rendered = [];
    for (const frame of frames) rendered.push(await renderer.sceneFrame(scene, frame));
    return rendered;
  } finally {
    renderer.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("Trace has a closed typed source contract and standard visual properties", () => {
  const cutModule = parse(program(canonicalBody));
  assert.deepEqual(checkCutModule(cutModule).diagnostics.filter((item) => item.severity === "error"), []);
  const ir = compileCutModule(cutModule).ir, node = Object.values(ir.nodes).find((item) => item.op === "cut.visual.trace");
  assert.ok(node);
  assert.deepEqual(Object.keys(node.inputs).sort(), ["delay", "duration", "easing", "headColor", "headFade", "headRadius", "opacity", "points", "rotation", "scale", "stroke", "width"]);
  assert.deepEqual(Object.keys(node.properties), ["x"]);

  const unknown = checkCutModule(parse(program(`${canonicalBody}\nTrace(points: [{ x: 0px, y: 0px }, { x: 1px, y: 1px }], stroke: #ffffff, width: 1px, duration: 1s, blur: 4px);`))).diagnostics;
  assert.ok(unknown.some((item) => item.code === "CUT2059" && /does not execute input.*blur/.test(item.message)));
  const namedPosition = checkCutModule(parse(program('Trace(points: [{ x: 0px, y: 0px }, { x: 1px, y: 1px }], stroke: #ffffff, width: 1px, duration: 1s, x: 4px);'))).diagnostics;
  assert.ok(namedPosition.some((item) => item.code === "CUT2059" && /does not execute input.*x/.test(item.message)));
});

test("Trace prefix follows cumulative arc length across unequal segments", () => {
  const points = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 30 }];
  const trace = prepareReferenceTrace(points);
  assert.deepEqual(trace.cumulativeLengths, [0, 10, 40]);
  assert.deepEqual(referenceTracePrefix(trace, 0), { points: [{ x: 0, y: 0 }], head: { x: 0, y: 0 } });
  assert.deepEqual(referenceTracePrefix(trace, .5), { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], head: { x: 10, y: 10 } });
  assert.deepEqual(referenceTracePrefix(trace, 1), { points, head: { x: 10, y: 30 } });
});

test("loaded Trace IR rejects malformed geometry, paints, timing, easing, and interval overflow", () => {
  const cases: Array<[(node: IRNode, ir: CutAVIR) => void, RegExp]> = [
    [(node) => { node.inputs.points = { kind: "string", value: "not points" }; }, /points must be a List<Vec2>/],
    [(node) => { node.inputs.points = { kind: "array", items: [point(px(1), px(2))] }; }, /between 2 and 4096/],
    [(node) => { node.inputs.points = { kind: "array", items: Array.from({ length: 4_097 }, () => point(px(1), px(2))) }; }, /between 2 and 4096/],
    [(node) => { node.inputs.points = { kind: "array", items: [point(px(1), px(2), px(3)), point(px(3), px(4))] }; }, /closed Vec2 with exactly x and y/],
    [(node) => { node.inputs.points = { kind: "array", items: [point(scalar(1), px(2)), point(px(3), px(4))] }; }, /points\[0\]\.x must be an exact Length/],
    [(node) => { node.inputs.points = { kind: "array", items: [point(px(-65_537), px(2)), point(px(3), px(4))] }; }, /65536px coordinate limit/],
    [(node) => { delete node.inputs.width; }, /width is required/],
    [(node) => { node.inputs.width = px(0); }, /width must be greater than 0px/],
    [(node) => { node.inputs.width = px(4_097); }, /width must be greater than 0px and at most 4096px/],
    [(node) => { delete node.inputs.stroke; }, /stroke is required/],
    [(node) => { node.inputs.stroke = { kind: "string", value: `#fff\"/><script>` }; }, /stroke must be a canonical Color/],
    [(node) => { delete node.inputs.duration; }, /duration must be an exact Time/],
    [(node) => { node.inputs.duration = scalar(1); }, /duration must be an exact Time/],
    [(node) => { node.inputs.duration = seconds(0); }, /duration must be greater than 0s/],
    [(node) => { node.inputs.delay = scalar(1); }, /delay must be an exact Time/],
    [(node) => { node.inputs.delay = seconds(-1); }, /delay cannot be negative/],
    [(node) => { node.inputs.headRadius = scalar(1); }, /headRadius must be an exact Length/],
    [(node) => { node.inputs.headRadius = px(-1); }, /headRadius must be between 0px and 4096px/],
    [(node) => { node.inputs.headRadius = px(4_097); }, /headRadius must be between 0px and 4096px/],
    [(node) => { node.inputs.headColor = { kind: "string", value: "url(evil)" }; }, /headColor must be a canonical Color/],
    [(node) => { node.inputs.headFade = scalar(1); }, /headFade must be an exact Time/],
    [(node) => { node.inputs.headFade = seconds(-1); }, /headFade cannot be negative/],
    [(node) => { node.inputs.easing = { kind: "string", value: "elastic" }; }, /easing must be one of: linear, inCubic, outCubic, inOutCubic/],
    [(node) => { node.inputs.easing = { kind: "symbol", name: "cut:intrinsic#linear" }; }, /easing must be one of: linear, inCubic, outCubic, inOutCubic/],
    [(node) => { node.inputs.opacity = { kind: "string", value: "100%" }; }, /input “opacity”.*canonical ratio quantity in ratio/],
    [(node) => { node.inputs.opacity = ratio(-1); }, /input “opacity”.*between 0% and 100%/],
    [(node) => { node.inputs.opacity = ratio(2); }, /input “opacity”.*between 0% and 100%/],
    [(node) => { node.inputs.scale = { kind: "string", value: "1" }; }, /input “scale”.*canonical scalar quantity in scalar/],
    [(node) => { node.inputs.scale = quantity("scalar", 1, ""); }, /canonical scalar quantities must use "scalar"/],
    [(node) => { node.inputs.scale = scalar(0); }, /input “scale”.*between 0.001 and 64/],
    [(node) => { node.inputs.scale = scalar(65); }, /input “scale”.*between 0.001 and 64/],
    [(node) => { node.inputs.rotation = { kind: "string", value: "0deg" }; }, /input “rotation”.*canonical angle quantity in deg/],
    [(node) => { node.inputs.rotation = degrees(360_001); }, /input “rotation”.*within ±360000deg/],
    [(node, ir) => {
      const previous = node.properties.x;
      if (previous && "signal" in previous) delete ir.signals[previous.signal];
      node.properties.x = { kind: "string", value: "0px" };
    }, /property “x”.*canonical length quantity in px/],
    [(node) => { node.inputs.delay = seconds(1); }, /delay \+ duration \+ headFade must fit its owning interval/],
  ];
  for (const [mutate, expected] of cases) assert.throws(() => validateReferenceSession(canonicalIr(mutate)), expected);

  assert.doesNotThrow(() => validateReferenceSession(canonicalIr((node) => {
    delete node.inputs.headRadius;
    delete node.inputs.headColor;
    delete node.inputs.headFade;
    node.inputs.delay = seconds(1);
  })));
});

test("Trace transform tracks validate every executed value while preserving the canonical pre-event baseline", () => {
  assert.doesNotThrow(() => validateReferenceSession(canonicalIr()), "compiler track initial carries the authored/default value until the first write");

  assert.throws(() => validateReferenceSession(canonicalIr((node, ir) => {
    const reference = node.properties.x;
    if (!reference || !("signal" in reference)) throw new Error("expected x signal");
    const signal = ir.signals[reference.signal];
    if (signal?.kind !== "track") throw new Error("expected x track");
    const event = signal.events[0];
    if (!event || event.kind !== "animate") throw new Error("expected x animation");
    event.from = { kind: "string", value: "0px" };
  })), /CUT_IR_TYPE at \$\.signals\..*\.events\[0\]\.from: Length signal payload must be a canonical length quantity in "px"/);

  assert.throws(() => validateReferenceSession(canonicalIr((node, ir) => {
    const reference = node.properties.x;
    if (!reference || !("signal" in reference)) throw new Error("expected x signal");
    node.properties.scale = reference;
    delete node.properties.x;
    const signal = ir.signals[reference.signal];
    if (signal?.kind !== "track") throw new Error("expected scale track");
    signal.valueType = "Number";
    signal.initial = scalar(1);
    const event = signal.events[0];
    if (!event || event.kind !== "animate") throw new Error("expected scale animation");
    event.from = scalar(1);
    event.to = scalar(65);
  })), /property “scale” signal .*events\[0\]\.to.*between 0.001 and 64/);
});

test("reference validation independently rejects reachable scene-clock interval overflow", () => {
  const ir = canonicalIr(), node = Object.values(ir.nodes).find((item) => item.op === "cut.visual.trace");
  assert.ok(node?.sceneId);
  node.interval.start = ir.scenes[node.sceneId].duration;
  assert.throws(() => validateReferenceSession(ir), /interval.*remain inside its owning scene or timeline/);
});

test("reachable Trace work is bounded exactly per node and across a composition", () => {
  const manyPoints = () => ({ kind: "array" as const, items: Array.from({ length: 4_096 }, (_, index) => point(px(index % 64), px(Math.floor(index / 64)))) });
  const perNode = canonicalIr((node, ir) => {
    const composition = ir.compositions[0], scene = ir.scenes[composition.sceneIds[0]];
    composition.duration = rational(7_200); composition.fps = rational(120); scene.duration = rational(7_200);
    node.interval = { start: rational(0), duration: rational(7_200) };
    node.inputs.points = manyPoints();
  });
  assert.throws(() => validateReferenceSession(perNode), /costs 3538944000 point-frames; the per-node limit is 25000000/);

  const aggregate = canonicalIr((node, ir) => {
    const composition = ir.compositions[0], scene = ir.scenes[composition.sceneIds[0]];
    composition.duration = rational(50); composition.fps = rational(120); scene.duration = rational(50);
    node.interval = { start: rational(0), duration: rational(50) };
    node.inputs.points = manyPoints();
    for (let index = 1; index < 5; index += 1) {
      const copy = structuredClone(node), id = `${node.id}_copy_${index}`;
      copy.id = id; ir.nodes[id] = copy; scene.rootVisualIds.push(id); scene.items.push({ id, domain: "visual" });
    }
  });
  assert.throws(() => validateReferenceSession(aggregate), /Reachable Trace nodes cost 122880000 point-frames; the composition limit is 100000000/);
});

test("Trace pixels obey delay, cumulative prefix, head fade, retained stroke, and replay determinism", async () => {
  const [before, start, corner, later, complete, fading, retained] = await renderFrames(canonicalBody.replace("animate trace.x from 0px to 4px over 1s;", ""), [1, 2, 7, 9, 12, 13, 14]);
  assert.ok(isBackground(pixel(before, 8, 48)), "nothing is visible before delay");
  assert.ok(isRed(pixel(start, 8, 48)), "head starts at the first point when delay elapses");
  assert.ok(isRed(pixel(corner, 16, 36)), "half of unequal total arc length has turned the corner");
  assert.ok(isBackground(pixel(corner, 16, 28)), "the unrevealed suffix stays transparent");
  assert.ok(isRed(pixel(later, 16, 28)), "the head advances along the second segment");
  assert.ok(isBackground(pixel(later, 16, 20)), "future geometry remains hidden");
  assert.ok(isRed(pixel(complete, 16, 16)), "head reaches the endpoint at completion");
  assert.ok(pixel(fading, 16, 16)[0] < pixel(complete, 16, 16)[0], "head alpha decreases during headFade");
  assert.ok(isGreen(pixel(retained, 16, 16)), "only the head disappears; the completed stroke remains");
  assert.ok(isGreen(pixel(retained, 12, 48)), "the full earlier stroke remains after completion");

  const [replay] = await renderFrames(canonicalBody.replace("animate trace.x from 0px to 4px over 1s;", ""), [14]);
  assert.deepEqual(retained.data, replay.data);
});

test("Trace timing stays exact below Number precision", async () => {
  const epsilon = `0.${"0".repeat(180)}1s`;
  const delayed = `Trace(points: [{ x: 8px, y: 32px }, { x: 40px, y: 32px }], stroke: #00ff00, width: 2px, duration: 500ms, delay: 1s + ${epsilon}, headRadius: 3px, headColor: #ff0000);`;
  const [atRoundedBoundary, nextFrame] = await renderFrames(delayed, [10, 11]);
  assert.ok(isBackground(pixel(atRoundedBoundary, 8, 32)), "an exact delay infinitesimally after 1s must not start at 1s");
  assert.ok(!isBackground(pixel(nextFrame, 8, 32)), "the trace starts on the next sampled frame");

  const fading = `Trace(points: [{ x: 8px, y: 32px }, { x: 40px, y: 32px }], stroke: #00ff00, width: 2px, duration: 1s, headRadius: 4px, headColor: #ff0000, headFade: ${epsilon});`;
  const [completion, afterFade] = await renderFrames(fading, [10, 11]);
  assert.ok(isRed(pixel(completion, 40, 32)), "a positive exact head fade includes the completion instant");
  assert.ok(isGreen(pixel(afterFade, 40, 32)), "the retained stroke remains after the sub-frame head fade");
});

test("Trace easing and standard x transform change executed pixels", async () => {
  const base = canonicalBody.replace("animate trace.x from 0px to 4px over 1s;", "");
  const [linear] = await renderFrames(base, [7]);
  const [outCubic] = await renderFrames(base.replace('easing: "linear"', 'easing: "outCubic"'), [7]);
  assert.ok(isBackground(pixel(linear, 16, 24)));
  assert.ok(!isBackground(pixel(outCubic, 16, 24)), "outCubic reveals more cumulative distance at half time");

  const transformedBody = `Trace(points: [{ x: 8px, y: 32px }, { x: 24px, y: 32px }], stroke: #00ff00, width: 2px, duration: 100ms, opacity: 100%, scale: 1, rotation: 0deg) as moving;
  animate moving.x from 0px to 16px over 1s;`;
  const [early, late] = await renderFrames(transformedBody, [2, 9]);
  assert.ok(isGreen(pixel(early, 12, 32)));
  assert.ok(isBackground(pixel(late, 12, 32)));
  assert.ok(isBackground(pixel(early, 36, 32)));
  assert.ok(isGreen(pixel(late, 36, 32)));
});
