import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import type { CutAVIR, IRComposition, IRNode, IRSignal, IRValue } from "../lib/language/ir";
import { loadCutAvIr } from "../lib/language/ir-loader";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { diffCutAVIR } from "../lib/language/semantic-diff";
import { createIncrementalRenderPlan, finalizeGraphHashes } from "../lib/runtime/graph";
import { inspectCutIr } from "../lib/runtime/inspect";
import {
  prepareReferenceVectorPathNode,
  referenceVectorPathDashPolylines,
  referenceVectorPathFrameAt,
  referenceVectorPathRenderFrameAt,
  referenceVectorPathInspect,
  referenceVectorPathSlice,
  referenceVectorPathSvg,
  referenceVectorPathVisibleBounds,
  ReferenceVectorPathError,
  validateReferenceVectorPathFrameStates,
} from "../lib/runtime/reference/vector-path";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

const px = (value: number): IRValue => ({ kind: "quantity", dimension: "length", magnitude: rational(value), unit: "px" });
const ratio = (numerator: number, denominator = 1): IRValue => ({ kind: "quantity", dimension: "ratio", magnitude: rational(numerator, denominator), unit: "ratio" });
const point = (x: number, y: number): IRValue => ({ kind: "object", entries: { x: px(x), y: px(y) } });
const lineTo = (x: number, y: number): IRValue => ({ kind: "object", entries: { to: point(x, y) } });
const cubicTo = (c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): IRValue => ({
  kind: "object",
  entries: { control1: point(c1x, c1y), control2: point(c2x, c2y), to: point(x, y) },
});
const geometry = (start: IRValue, segments: IRValue[], closed = false): IRValue => ({
  kind: "object",
  entries: { start, segments: { kind: "array", items: segments }, closed: { kind: "boolean", value: closed } },
});

function pathNode(inputs: Record<string, IRValue>, properties: IRNode["properties"] = {}): IRNode {
  return {
    id: "path",
    op: "cut.visual.path",
    domain: "visual",
    ownership: "root",
    sceneId: "scene",
    interval: { start: rational(0), duration: rational(2) },
    inputs,
    children: [],
    properties,
    effects: ["pure"],
    contentHash: "0".repeat(64),
    provenance: { module: "main.cut", span: { start: { line: 7, column: 5, offset: 0 }, end: { line: 7, column: 9, offset: 4 } } },
  };
}

function ir(signals: Record<string, IRSignal> = {}): CutAVIR {
  return { signals } as unknown as CutAVIR;
}

function track(id: string, valueType: string, from: IRValue, to: IRValue): IRSignal {
  return {
    id,
    kind: "track",
    valueType,
    initial: from,
    events: [{ kind: "animate", start: rational(0), end: rational(1), from, to, curve: { kind: "symbol", name: "cut:intrinsic#linear" } }],
    contentHash: "1".repeat(64),
    provenance: { module: "main.cut", span: { start: { line: 8, column: 5, offset: 5 }, end: { line: 8, column: 9, offset: 9 } } },
  };
}

function constant(id: string, valueType: string, value: IRValue): IRSignal {
  return {
    id,
    kind: "constant",
    valueType,
    value,
    contentHash: "2".repeat(64),
    provenance: { module: "main.cut", span: { start: { line: 8, column: 5, offset: 5 }, end: { line: 8, column: 9, offset: 9 } } },
  };
}

function sourceProgram(body: string, duration = "2s", fps = 10) {
  return `cut 0.4;
project "retained vector path proof";
import { Group, MotionBlur, Path, Trace, cubicTo, lineTo, vectorPath } from "cut:visual";
timeline main(duration: ${duration}, fps: ${fps}, width: 80px, height: 64px, sampleRate: 48khz) {
  scene only(duration: ${duration}) { ${body} }
}
export out = render(main, width: 80px, height: 64px, codec: "h264");`;
}

function parsedSource(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  return parsed.module;
}

function compiledSource(body: string, duration = "2s", fps = 10) {
  const cutModule = parsedSource(sourceProgram(body, duration, fps));
  const checked = checkCutModule(cutModule);
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), []);
  return compileCutModule(cutModule).ir;
}

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function alphaBounds(data: Uint8Array, width: number, height: number) {
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] === 0) continue;
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
    }
  }
  assert.ok(right >= left && bottom >= top, "expected at least one covered pixel");
  return { left, top, right, bottom };
}

test("legacy Path points bypass retained preparation and keep the old renderer contract", () => {
  const node = pathNode({ points: { kind: "array", items: [point(0, 0), point(20, 0), point(20, 10)] } });
  assert.equal(prepareReferenceVectorPathNode(ir(), node), undefined);
  assert.throws(
    () => prepareReferenceVectorPathNode(ir(), pathNode({ ...node.inputs, trimEnd: ratio(1, 2) })),
    /trimEnd requires retained geometry/u,
  );
});

test("mixed retained line/cubic geometry owns exact trim and canonical odd dash phase", () => {
  const node = pathNode({
    geometry: geometry(point(0, 0), [lineTo(40, 0), cubicTo(55, 0, 55, 40, 80, 40)]),
    stroke: { kind: "color", value: "#ff3300" },
    width: px(3),
    trimStart: ratio(1, 4),
    trimEnd: ratio(3, 4),
    dash: { kind: "array", items: [px(6), px(3), px(2)] },
  });
  const plan = prepareReferenceVectorPathNode(ir(), node);
  assert.ok(plan);
  assert.deepEqual(plan.source.segments.map((segment) => segment.kind), ["line", "cubic"]);
  assert.ok(plan.sourcePrepared.points.length > 3, "cubic geometry must be deterministically flattened");
  assert.deepEqual(plan.dash, [6, 3, 2, 6, 3, 2]);
  const frame = referenceVectorPathFrameAt(ir(), node, plan, rational(0));
  assert.equal(frame.trimStart, .25);
  assert.equal(frame.trimEnd, .75);
  assert.ok(frame.strokePolylines.length > 1, "dash semantics must split visible geometry rather than remain metadata");
  assert.ok(frame.strokePolylines.every((polyline) => polyline.length >= 2));
  assert.ok(frame.strokePolylines.every((polyline, index) => polyline === frame.strokeFragments[index]?.points),
    "compatibility polylines must share the one immutable frame-owned point representation");
  assert.ok(frame.strokeFragments.every((fragment) => Object.isFrozen(fragment)
    && Object.isFrozen(fragment.points)
    && fragment.points.every(Object.isFrozen)),
  "shared stroke points must remain transitively immutable");
  const svg = referenceVectorPathSvg(frame, 100, 60);
  assert.match(svg, /stroke="#ff3300"/);
  assert.doesNotMatch(svg, /stroke-dasharray/u, "CUT, not the SVG rasterizer, must own dash segmentation");
});

test("arc-length slicing places both boundaries on the requested metric", () => {
  const node = pathNode({ geometry: geometry(point(0, 0), [lineTo(100, 0)]) });
  const plan = prepareReferenceVectorPathNode(ir(), node)!;
  assert.deepEqual(referenceVectorPathSlice(plan.sourcePrepared, 25, 75), [{ x: 25, y: 0 }, { x: 75, y: 0 }]);
  assert.deepEqual(referenceVectorPathDashPolylines(node, plan.sourcePrepared, 0, .3, [10, 5], 0), [
    [{ x: 0, y: 0 }, { x: 10, y: 0 }],
    [{ x: 15, y: 0 }, { x: 25, y: 0 }],
  ]);
});

test("complete undashed strokes share immutable prepared points while partial trims own their slice", () => {
  const complete = pathNode({
    geometry: geometry(point(0, 0), [lineTo(50, 0), lineTo(50, 30)]),
    stroke: { kind: "color", value: "#ffffff" },
    width: px(2),
  });
  const completePlan = prepareReferenceVectorPathNode(ir(), complete)!;
  const completeFrame = referenceVectorPathFrameAt(ir(), complete, completePlan, rational(0));
  assert.equal(completeFrame.strokeFragments[0]!.points, completePlan.staticPrepared.points);
  assert.ok(Object.isFrozen(completeFrame.strokeFragments[0]!.points));
  assert.ok(completeFrame.strokeFragments[0]!.points.every(Object.isFrozen));

  const partial = pathNode({
    geometry: geometry(point(0, 0), [lineTo(50, 0), lineTo(50, 30)]),
    stroke: { kind: "color", value: "#ffffff" },
    width: px(2),
    trimEnd: ratio(1, 2),
  });
  const partialPlan = prepareReferenceVectorPathNode(ir(), partial)!;
  const partialFrame = referenceVectorPathFrameAt(ir(), partial, partialPlan, rational(0));
  assert.notEqual(partialFrame.strokeFragments[0]!.points, partialPlan.staticPrepared.points);
  assert.ok(Object.isFrozen(partialFrame.strokeFragments[0]!.points));
});

test("renderer-owned vector frames preserve exact SVG while avoiding published freeze work", () => {
  const node = pathNode({
    geometry: geometry(point(0, 0), [lineTo(50, 0), lineTo(50, 30)]),
    stroke: { kind: "color", value: "#ffffff" },
    width: px(2),
    trimEnd: ratio(1, 2),
  });
  const runtime = ir();
  const plan = prepareReferenceVectorPathNode(runtime, node)!;
  const published = referenceVectorPathFrameAt(runtime, node, plan, rational(0));
  const rendering = referenceVectorPathRenderFrameAt(runtime, node, plan, rational(0));
  assert.equal(referenceVectorPathSvg(rendering, 100, 60), referenceVectorPathSvg(published, 100, 60));
  assert.deepEqual(rendering, published);
  assert.ok(Object.isFrozen(published));
  assert.ok(Object.isFrozen(published.strokeFragments));
  assert.equal(Object.isFrozen(rendering), false);
  assert.equal(Object.isFrozen(rendering.strokeFragments), false);
  assert.equal(Object.isFrozen(rendering.strokeFragments[0]!.points), false);
});

test("topology-safe morph fails closed on segment-kind or closure mismatch", () => {
  const source = geometry(point(0, 0), [lineTo(50, 0), lineTo(50, 50)]);
  const kindMismatch = pathNode({
    geometry: source,
    morphTo: geometry(point(0, 0), [cubicTo(10, 0, 40, 0, 50, 0), lineTo(50, 50)]),
    morph: ratio(1, 2),
  });
  assert.throws(() => prepareReferenceVectorPathNode(ir(), kindMismatch), (error: unknown) => {
    assert.ok(error instanceof ReferenceVectorPathError);
    assert.equal(error.code, "CUT_VECTOR_PATH_TOPOLOGY");
    assert.match(error.message, /segment 0 is line.*cubic/u);
    assert.deepEqual(error.source, { module: "main.cut", line: 7, column: 5, nodeId: "path" });
    return true;
  });

  const closureMismatch = pathNode({
    geometry: source,
    morphTo: geometry(point(0, 0), [lineTo(50, 0), lineTo(50, 50)], true),
    morph: ratio(1, 2),
  });
  assert.throws(() => prepareReferenceVectorPathNode(ir(), closureMismatch), /same closed state/u);
});

test("morph, trimEnd, and dashOffset signals change two exact frame states and SVG", () => {
  const signals = {
    morph: track("morph", "Ratio", ratio(0), ratio(1)),
    trim: track("trim", "Ratio", ratio(1, 4), ratio(1)),
    dash: track("dash", "Length", px(0), px(5)),
  };
  const runtime = ir(signals);
  const node = pathNode({
    geometry: geometry(point(5, 10), [cubicTo(20, 0, 40, 0, 55, 10)]),
    morphTo: geometry(point(5, 40), [cubicTo(20, 55, 40, 55, 55, 40)]),
    morph: ratio(0),
    trimEnd: ratio(1, 4),
    dash: { kind: "array", items: [px(8), px(4)] },
    dashOffset: px(0),
    stroke: { kind: "color", value: "#00aa88" },
    width: px(2),
  }, {
    morph: { signal: "morph" },
    trimEnd: { signal: "trim" },
    dashOffset: { signal: "dash" },
  });
  const plan = prepareReferenceVectorPathNode(runtime, node)!;
  const first = referenceVectorPathFrameAt(runtime, node, plan, rational(0));
  const second = referenceVectorPathFrameAt(runtime, node, plan, rational(1));
  assert.equal(first.geometry.points[0].y, 10);
  assert.equal(second.geometry.points[0].y, 40);
  assert.equal(first.trimEnd, .25);
  assert.equal(second.trimEnd, 1);
  assert.equal(first.dashOffset, 0);
  assert.equal(second.dashOffset, 5);
  assert.notEqual(referenceVectorPathSvg(first, 64, 64), referenceVectorPathSvg(second, 64, 64), "frame evaluation must not be metadata-only or frozen at the first cached state");

  const composition = { fps: rational(2) } as IRComposition;
  const work = validateReferenceVectorPathFrameStates(runtime, composition, node, plan);
  assert.equal(work.authoredSegmentFrames, 8);
  assert.ok(work.flattenedPointFrames > work.authoredSegmentFrames);
  assert.ok(work.visibleFragmentFrames > 0);
  const inspected = referenceVectorPathInspect(runtime, node, plan);
  assert.deepEqual(inspected.animatedProperties, ["morph", "trimEnd", "dashOffset"]);
  assert.deepEqual(inspected.morphTarget?.topology, ["cubic"]);
  assert.deepEqual(inspected.signals.morph, { id: "morph", contentHash: "1".repeat(64) });
});

test("dynamic trim may begin at exact zero, remains explicitly transparent, and must become visible on the output clock", () => {
  const runtime = ir({ trim: track("trim", "Ratio", ratio(0), ratio(1)) });
  const node = pathNode({
    geometry: geometry(point(4, 24), [lineTo(60, 24)]),
    stroke: { kind: "color", value: "#ff3300" },
    width: px(3),
    trimEnd: ratio(0),
  }, { trimEnd: { signal: "trim" } });
  const plan = prepareReferenceVectorPathNode(runtime, node)!;
  assert.equal(plan.trimRangeDynamic, true);
  const zero = referenceVectorPathFrameAt(runtime, node, plan, rational(0), 0n);
  const visible = referenceVectorPathFrameAt(runtime, node, plan, rational(1, 2), 1n);
  assert.equal(zero.visibility, "transparent-trim");
  assert.equal(zero.trimStart, zero.trimEnd);
  assert.deepEqual(zero.strokeFragments, []);
  assert.equal(referenceVectorPathVisibleBounds(zero, { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }), undefined);
  assert.equal(visible.visibility, "visible");
  assert.ok(visible.strokeFragments.length > 0);
  const work = validateReferenceVectorPathFrameStates(runtime, { fps: rational(2) } as IRComposition, node, plan);
  assert.equal(work.transparentTrimFrames, 1);
  assert.equal(work.visiblePaintFrames, 3);
  const inspected = referenceVectorPathInspect(runtime, node, plan);
  assert.equal(inspected.trimRangeDynamic, true);
  assert.equal(inspected.executedVisibilityAtActiveStart, "transparent-trim");

  const subframeOnly = pathNode({
    geometry: node.inputs.geometry!, stroke: { kind: "color", value: "#ff3300" }, width: px(3), trimEnd: ratio(0),
  }, { trimEnd: { signal: "trim" } });
  subframeOnly.interval.duration = rational(1);
  assert.throws(
    () => validateReferenceVectorPathFrameStates(runtime, { fps: rational(1) } as IRComposition, subframeOnly, prepareReferenceVectorPathNode(runtime, subframeOnly)!),
    /zero-length at all 1 exact active output frames.*permanently invisible/u,
  );
});

test("a closed fill remains visible while its dynamic stroke trim is exactly zero", () => {
  const runtime = ir({ trim: track("trim", "Ratio", ratio(0), ratio(1)) });
  const node = pathNode({
    geometry: geometry(point(10, 10), [lineTo(50, 10), lineTo(50, 50), lineTo(10, 50)], true),
    stroke: { kind: "color", value: "#ffffff" },
    fill: { kind: "color", value: "#224466" },
    width: px(2),
    trimEnd: ratio(0),
  }, { trimEnd: { signal: "trim" } });
  const plan = prepareReferenceVectorPathNode(runtime, node)!;
  const frame = referenceVectorPathFrameAt(runtime, node, plan, rational(0));
  assert.equal(frame.visibility, "visible");
  assert.deepEqual(frame.strokeFragments, []);
  assert.equal(frame.fillPoints.length, 4);
  assert.ok(referenceVectorPathVisibleBounds(frame, { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }));
  const work = validateReferenceVectorPathFrameStates(runtime, { fps: rational(2) } as IRComposition, node, plan);
  assert.equal(work.visiblePaintFrames, 4);
  assert.equal(work.transparentTrimFrames, 0);
});

test("inspect reports executed static morph, trim, and dashOffset values rather than only control names", () => {
  const node = pathNode({
    geometry: geometry(point(4, 8), [lineTo(56, 8)]),
    morphTo: geometry(point(4, 40), [lineTo(56, 40)]),
    morph: ratio(1, 2),
    trimStart: ratio(1, 10),
    trimEnd: ratio(4, 5),
    dash: { kind: "array", items: [px(8), px(4)] },
    dashOffset: px(5),
    stroke: { kind: "color", value: "#ffffff" },
    width: px(2),
  });
  const inspected = referenceVectorPathInspect(ir(), node, prepareReferenceVectorPathNode(ir(), node)!);
  assert.deepEqual(inspected.animatedProperties, []);
  assert.deepEqual(inspected.executedAtActiveStart, {
    time: rational(0), morph: .5, trimStart: .1, trimEnd: .8, dashOffsetPx: 5,
  });
  assert.deepEqual(inspected.staticValues, { morph: .5, trimStart: .1, trimEnd: .8, dashOffsetPx: 5 });
});

test("full closed strokes execute lineJoin through an explicit Z seam", async () => {
  const rasters: Buffer[] = [];
  for (const lineJoin of ["miter", "bevel", "round"] as const) {
    const node = pathNode({
      geometry: geometry(point(20, 8), [lineTo(54, 54), lineTo(8, 54)], true),
      stroke: { kind: "color", value: "#ffffff" },
      width: px(10),
      lineCap: { kind: "string", value: "butt" },
      lineJoin: { kind: "string", value: lineJoin },
    });
    const plan = prepareReferenceVectorPathNode(ir(), node)!;
    const frame = referenceVectorPathFrameAt(ir(), node, plan, rational(0));
    assert.equal(frame.strokeFragments.length, 1);
    assert.equal(frame.strokeFragments[0]?.closed, true);
    const svg = referenceVectorPathSvg(frame, 64, 64);
    assert.match(svg, /<path d="M .* Z"\/>/u);
    assert.doesNotMatch(svg, /<polyline/u, "the closure must not degrade into two coincident line caps");
    rasters.push(await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer());
  }
  assert.notDeepEqual(rasters[0], rasters[1], "miter and bevel must differ at the retained closed seam");
  assert.notDeepEqual(rasters[1], rasters[2], "bevel and round must differ at the retained closed seam");
});

test("default-only property signals and permanent morph endpoints are rejected as no-ops", () => {
  const base = geometry(point(0, 0), [lineTo(40, 0)]);
  const target = geometry(point(0, 10), [lineTo(40, 10)]);
  const cases: Array<[CutAVIR, IRNode, RegExp]> = [
    [ir({ offset: constant("offset", "Length", px(0)) }), pathNode({ geometry: base, dash: { kind: "array", items: [px(6), px(3)] }, dashOffset: px(5) }, { dashOffset: { signal: "offset" } }), /dashOffset is 0px modulo/u],
    [ir({ start: constant("start", "Ratio", ratio(0)) }), pathNode({ geometry: base, trimStart: ratio(1, 4) }, { trimStart: { signal: "start" } }), /trimStart remains the 0% default/u],
    [ir({ end: track("end", "Ratio", ratio(1), ratio(1)) }), pathNode({ geometry: base, trimEnd: ratio(1, 2) }, { trimEnd: { signal: "end" } }), /trimEnd remains the 100% default/u],
    [ir(), pathNode({ geometry: base, trimEnd: ratio(0) }), /permanently collapsing a static stroke/u],
    [ir(), pathNode({ geometry: base, trimStart: ratio(1, 2), trimEnd: ratio(1, 2) }), /permanently collapsing a static stroke/u],
    [ir({ morph: constant("morph", "Ratio", ratio(1)) }), pathNode({ geometry: base, morphTo: target, morph: ratio(0) }, { morph: { signal: "morph" } }), /remains 100%.*discards the source/u],
  ];
  for (const [runtime, node, expected] of cases) assert.throws(() => prepareReferenceVectorPathNode(runtime, node), expected);
});

test("zero-length authored segments and hostile flattened-point-frame work fail boundedly", () => {
  assert.throws(() => prepareReferenceVectorPathNode(ir(), pathNode({
    geometry: geometry(point(0, 0), [lineTo(0, 0), lineTo(20, 0)]),
  })), /zero-length lineTo/u);

  const hostile = pathNode({
    geometry: geometry(point(0, 0), [cubicTo(0, 64, 64, 64, 64, 0)]),
    stroke: { kind: "color", value: "#ffffff" },
    width: px(2),
  });
  hostile.interval.duration = rational(7_200);
  const plan = prepareReferenceVectorPathNode(ir(), hostile)!;
  assert.ok(plan.sourcePrepared.points.length > 16, "hostile proof needs real adaptive flattening work");
  assert.throws(
    () => validateReferenceVectorPathFrameStates(ir(), { fps: rational(120) } as IRComposition, hostile, plan),
    /flattened point-frame work exceeds/u,
  );
});

test("paint, trim, morph, dash, and closed-record no-op boundaries fail explicitly", () => {
  const open = geometry(point(0, 0), [lineTo(30, 0)]);
  const cases: Array<[IRNode, RegExp]> = [
    [pathNode({ geometry: open, fill: { kind: "color", value: "#ffffff" } }), /fill requires closed/u],
    [pathNode({ geometry: open, dashOffset: px(2) }), /requires a dash pattern/u],
    [pathNode({ geometry: open, trimStart: ratio(0) }), /remains the 0% default/u],
    [pathNode({ geometry: open, morphTo: geometry(point(0, 0), [lineTo(40, 0)]), morph: ratio(0) }), /remains 0%/u],
    [pathNode({ geometry: { kind: "object", entries: { start: point(0, 0), segments: { kind: "array", items: [lineTo(10, 0)] }, closed: { kind: "boolean", value: false }, extra: ratio(1) } } }), /must contain exactly start, segments, closed/u],
  ];
  for (const [node, expected] of cases) assert.throws(() => prepareReferenceVectorPathNode(ir(), node), expected);
});

test("a closed Path keeps its complete fill while trimming the stroke independently", async () => {
  const node = pathNode({
    geometry: geometry(point(10, 10), [lineTo(50, 10), lineTo(50, 50), lineTo(10, 50)], true),
    fill: { kind: "color", value: "#224466" },
    stroke: { kind: "color", value: "#ffffff" },
    width: px(2),
    trimEnd: ratio(1, 4),
  });
  const plan = prepareReferenceVectorPathNode(ir(), node)!;
  const frame = referenceVectorPathFrameAt(ir(), node, plan, rational(0));
  assert.deepEqual(frame.fillPoints, [{ x: 10, y: 10 }, { x: 50, y: 10 }, { x: 50, y: 50 }, { x: 10, y: 50 }]);
  assert.deepEqual(frame.strokeFragments, [{ points: [{ x: 10, y: 10 }, { x: 50, y: 10 }], closed: false }]);
  const svg = referenceVectorPathSvg(frame, 64, 64);
  assert.match(svg, /fill="#224466"/u);
  assert.match(svg, /<polyline points="10,10 50,10"\/>/u);
  const raster = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer();
  assert.ok([...raster].filter((value, index) => index % 4 === 3 && value > 0).length > 1_500);
});

test("exact vertex slices deduplicate boundaries and cyclic dashes join the closed seam", () => {
  const node = pathNode({
    geometry: geometry(point(0, 0), [lineTo(10, 0), lineTo(10, 10), lineTo(0, 10)], true),
    dash: { kind: "array", items: [px(25), px(5)] },
    lineCap: { kind: "string", value: "butt" },
    lineJoin: { kind: "string", value: "miter" },
  });
  const plan = prepareReferenceVectorPathNode(ir(), node)!;
  const exactVertex = referenceVectorPathSlice(plan.sourcePrepared, 10, 20);
  assert.deepEqual(exactVertex, [{ x: 10, y: 0 }, { x: 10, y: 10 }]);
  const frame = referenceVectorPathFrameAt(ir(), node, plan, rational(0));
  assert.equal(frame.strokeFragments.length, 1, "the on-run crossing the closure must be one joined fragment");
  assert.equal(frame.strokeFragments[0]?.closed, false, "a real off-run keeps the merged seam fragment open");
  assert.ok(frame.strokeFragments[0]!.points.some((item) => item.x === 0 && item.y === 0), "the merged fragment crosses the authored closure once");

  const fullLoop = pathNode({
    geometry: node.inputs.geometry!,
    dash: { kind: "array", items: [px(50), px(5)] },
  });
  const fullFrame = referenceVectorPathFrameAt(ir(), fullLoop, prepareReferenceVectorPathNode(ir(), fullLoop)!, rational(0));
  assert.equal(fullFrame.strokeFragments.length, 1);
  assert.equal(fullFrame.strokeFragments[0]?.closed, true, "one on-run covering a whole loop must retain Z closure");
});

test("dash offsets canonicalize modulo period and periodic no-ops fail", () => {
  const base = { geometry: geometry(point(0, 0), [lineTo(60, 0)]), dash: { kind: "array", items: [px(8), px(4)] } as IRValue };
  assert.throws(() => prepareReferenceVectorPathNode(ir(), pathNode({ ...base, dashOffset: px(12) })), /0px modulo the 12px canonical dash period/u);
  const negative = pathNode({ ...base, dashOffset: px(-1) });
  const plan = prepareReferenceVectorPathNode(ir(), negative)!;
  assert.equal(referenceVectorPathFrameAt(ir(), negative, plan, rational(0)).dashOffset, 11);
});

test("zero-area fills and fully gapped strokes fail before raster allocation", () => {
  const collinear = pathNode({
    geometry: geometry(point(0, 0), [lineTo(20, 0), lineTo(40, 0)], true),
    fill: { kind: "color", value: "#ff0000" },
  });
  const retraced = pathNode({
    geometry: geometry(point(0, 0), [lineTo(20, 0), lineTo(20, 20), lineTo(20, 0)], true),
    fill: { kind: "color", value: "#00ff00" },
  });
  assert.throws(() => prepareReferenceVectorPathNode(ir(), collinear), /zero visible coverage/u);
  assert.throws(() => prepareReferenceVectorPathNode(ir(), retraced), /zero visible coverage/u);

  const gapped = pathNode({
    geometry: geometry(point(0, 0), [lineTo(1, 0)]),
    dash: { kind: "array", items: [{ kind: "quantity", dimension: "length", magnitude: rational(1, 4), unit: "px" }, px(4_096)] },
    dashOffset: px(1),
  });
  assert.throws(() => prepareReferenceVectorPathNode(ir(), gapped), /emits no positive-length visible stroke fragment/u);
});

test("changes outside the active interval cannot make a default-only control meaningful", () => {
  const outsideStep: IRSignal = {
    id: "outside-step", kind: "step", valueType: "Ratio",
    points: [{ time: rational(0), value: ratio(0) }, { time: rational(3), value: ratio(1, 2) }],
    contentHash: "3".repeat(64), provenance: constant("x", "Ratio", ratio(0)).provenance,
  };
  const outsideKeys: IRSignal = {
    id: "outside-keys", kind: "keyframes", valueType: "Ratio",
    keyframes: [
      { time: rational(0), value: ratio(1), curve: { kind: "symbol", name: "cut:intrinsic#linear" } },
      { time: rational(3), value: ratio(1), curve: { kind: "symbol", name: "cut:intrinsic#linear" } },
      { time: rational(4), value: ratio(1, 2), curve: { kind: "symbol", name: "cut:intrinsic#linear" } },
    ],
    contentHash: "4".repeat(64), provenance: constant("x", "Ratio", ratio(0)).provenance,
  };
  const base = geometry(point(0, 0), [lineTo(40, 0)]);
  assert.throws(
    () => prepareReferenceVectorPathNode(ir({ "outside-step": outsideStep }), pathNode({ geometry: base, trimStart: ratio(0) }, { trimStart: { signal: "outside-step" } })),
    /trimStart remains the 0% default/u,
  );
  assert.throws(
    () => prepareReferenceVectorPathNode(ir({ "outside-keys": outsideKeys }), pathNode({ geometry: base, trimEnd: ratio(1) }, { trimEnd: { signal: "outside-keys" } })),
    /trimEnd remains the 100% default/u,
  );
});

test("dynamic preflight is bounded and executed failures identify exact frame and time", () => {
  const runtime = ir({ trim: track("trim", "Ratio", ratio(1, 4), ratio(3, 4)) });
  const node = pathNode({
    geometry: geometry(point(0, 0), [lineTo(100, 0)]),
    trimEnd: ratio(1, 4),
  }, { trimEnd: { signal: "trim" } });
  node.interval.duration = rational(3_000);
  const plan = prepareReferenceVectorPathNode(runtime, node)!;
  assert.equal(plan.frameDynamic, true);
  assert.throws(
    () => validateReferenceVectorPathFrameStates(runtime, { fps: rational(30) } as IRComposition, node, plan),
    /90000 output-frame samples.*60000-sample bound/u,
  );

  const invalidRuntime = ir({ start: constant("start", "Ratio", ratio(3, 4)) });
  const invalid = pathNode({ geometry: geometry(point(0, 0), [lineTo(20, 0)]), trimEnd: ratio(1, 2) }, { trimStart: { signal: "start" } });
  const validPlan = prepareReferenceVectorPathNode(ir(), pathNode({ geometry: invalid.inputs.geometry!, trimEnd: ratio(1, 2) }))!;
  assert.throws(
    () => referenceVectorPathFrameAt(invalidRuntime, invalid, validPlan, rational(7, 30), 7n),
    /exact time 7\/30s \(output frame 7\)/u,
  );
});

test("public source lowers mixed PathSegment lists order-independently while Trace remains cubic-only", () => {
  const line = "lineTo(to: { x: 42px, y: 8px })";
  const cubic = "cubicTo(control1: { x: 50px, y: 8px }, control2: { x: 58px, y: 24px }, to: { x: 66px, y: 24px })";
  for (const segments of [`[${line}, ${cubic}]`, `[${cubic}, ${line}]`]) {
    const ir = compiledSource(`Path(
      geometry: vectorPath(start: { x: 8px, y: 8px }, segments: ${segments}, closed: false),
      stroke: #ff3300, width: 3px, trimEnd: 75%, dash: [6px, 3px], x: 2px, y: 1px
    );`);
    const node = Object.values(ir.nodes).find((candidate) => candidate.op === "cut.visual.path")!;
    assert.equal(node.inputs.geometry.kind, "object");
    assert.doesNotThrow(() => validateReferenceSession(loadCutAvIr(JSON.stringify(ir))));
  }

  for (const segments of [`[${line}, ${cubic}]`, `[${cubic}, ${line}]`, `[${line}]`]) {
    const cutModule = parsedSource(sourceProgram(`Trace(start: { x: 8px, y: 8px }, curves: ${segments}, stroke: #ffffff, width: 2px, duration: 1s);`));
    const diagnostic = checkCutModule(cutModule).diagnostics.find((item) => item.code === "CUT2029");
    assert.ok(diagnostic, segments);
    assert.match(diagnostic.message, /expects List<CubicPathSegment>/u);
  }
});

test("strict loaded IR, session validation, inspect signal identity, and semantic locality cover the public slice", () => {
  const body = (dash: number, targetY = 48) => `Path(
    geometry: vectorPath(start: { x: 8px, y: 12px }, segments: [lineTo(to: { x: 36px, y: 12px }), cubicTo(control1: { x: 48px, y: 12px }, control2: { x: 54px, y: 30px }, to: { x: 68px, y: 30px })], closed: false),
    morphTo: vectorPath(start: { x: 8px, y: ${targetY}px }, segments: [lineTo(to: { x: 36px, y: ${targetY}px }), cubicTo(control1: { x: 48px, y: ${targetY}px }, control2: { x: 54px, y: 36px }, to: { x: 68px, y: 36px })], closed: false),
    morph: 0%, stroke: #00aa88, width: 2px, trimEnd: 25%, dash: [${dash}px, 4px], dashOffset: 1px
  ) as route;
  animate route.morph from 0% to 100% over 1s;
  animate route.trimEnd from 25% to 100% over 1s;
  animate route.dashOffset from 1px to 6px over 1s;`;
  const first = compiledSource(body(8)), geometryEdit = compiledSource(body(8, 44)), dashEdit = compiledSource(body(7));
  const loaded = loadCutAvIr(JSON.stringify(first));
  assert.doesNotThrow(() => validateReferenceSession(loaded));
  const inspected = inspectCutIr(loaded, "main.cut");
  const path = inspected.graph.nodes.find((node) => node.op === "cut.visual.path")!;
  assert.equal(path.vectorPath?.frameDynamic, true);
  assert.deepEqual(Object.keys(path.vectorPath?.signals ?? {}).sort(), ["dashOffset", "morph", "trimEnd"]);
  assert.ok(Object.values(path.vectorPath!.signals).every((signal) => signal.contentHash && signal.contentHash.length === 64));

  const semanticGeometry = diffCutAVIR(first, geometryEdit), semanticDash = diffCutAVIR(first, dashEdit);
  assert.ok(semanticGeometry.changes.some((change) => change.entity === "node"));
  assert.ok(semanticDash.changes.some((change) => change.entity === "node"));
  const baseline = createIncrementalRenderPlan(first, "main").manifest;
  assert.deepEqual(createIncrementalRenderPlan(geometryEdit, "main", baseline).scenes.map((scene) => scene.status), ["miss"]);
  assert.deepEqual(createIncrementalRenderPlan(dashEdit, "main", baseline).scenes.map((scene) => scene.status), ["miss"]);
});

test("public retained rendering changes morph/trim/dash pixels, honors nested placement, and never freezes dynamic cache", { timeout: 30_000 }, async () => {
  const body = `Group(x: 3px, y: 2px, scale: 1.05) {
    Path(
      geometry: vectorPath(start: { x: 8px, y: 12px }, segments: [lineTo(to: { x: 34px, y: 12px }), cubicTo(control1: { x: 46px, y: 12px }, control2: { x: 54px, y: 28px }, to: { x: 68px, y: 28px })], closed: false),
      morphTo: vectorPath(start: { x: 8px, y: 48px }, segments: [lineTo(to: { x: 34px, y: 48px }), cubicTo(control1: { x: 46px, y: 48px }, control2: { x: 54px, y: 34px }, to: { x: 68px, y: 34px })], closed: false),
      morph: 0%, stroke: #ff3300, width: 3px, trimEnd: 25%, dash: [8px, 4px], dashOffset: 1px, x: 2px, y: 1px
    ) as route;
    animate route.morph from 0% to 100% over 1s;
    animate route.trimEnd from 25% to 100% over 1s;
    animate route.dashOffset from 1px to 6px over 1s;
  }`;
  const ir = compiledSource(body);
  ir.determinism.semantic = "locked";
  finalizeGraphHashes(ir);
  const { composition } = validateReferenceSession(ir);
  const root = await mkdtemp(resolve(tmpdir(), "cut-retained-vector-"));
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "cache"));
  await renderer.prepare();
  try {
    const scene = ir.scenes[composition.sceneIds[0]]!;
    const first = await renderer.sceneFrame(scene, 0, false);
    const middle = await renderer.sceneFrame(scene, 5, false);
    const last = await renderer.sceneFrame(scene, 10, false);
    assert.notEqual(digest(first.data), digest(middle.data));
    assert.notEqual(digest(middle.data), digest(last.data));
    assert.notEqual(digest(first.data), digest(last.data));
  } finally { renderer.close(); }
});

test("legacy duplicate-point round dot remains byte-identical to the frozen SVG branch", async () => {
  const ir = compiledSource("Path(points: [{ x: 20px, y: 20px }, { x: 20px, y: 20px }], stroke: #ffffff, width: 4px);");
  ir.determinism.semantic = "locked";
  const { composition } = validateReferenceSession(ir);
  const root = await mkdtemp(resolve(tmpdir(), "cut-legacy-path-dot-"));
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "cache"));
  await renderer.prepare();
  try {
    const actual = await renderer.sceneFrame(ir.scenes[composition.sceneIds[0]]!, 0, false);
    const expected = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="64"><polyline points="20,20 20,20" fill="none" stroke="#ffffff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>')).ensureAlpha().raw().toBuffer();
    assert.deepEqual(actual.data, expected);
    assert.equal([...actual.data].filter((value, index) => index % 4 === 3 && value > 0).length, 16);
  } finally { renderer.close(); }
});

test("legacy Path(points:) x/y animation preserves its frozen public source and pixels with canonical track baselines", { timeout: 30_000 }, async () => {
  const source = `cut 0.4;
project "legacy Path x y regression";
import { Path } from "cut:visual";
timeline main(duration: 2s, fps: 10, width: 80px, height: 64px, sampleRate: 48khz) {
  scene only(duration: 2s) {
    Path(points: [{ x: 8px, y: 12px }, { x: 44px, y: 12px }, { x: 44px, y: 28px }], stroke: #ffffff, width: 4px) as legacy;
    animate legacy.x from 0px to 12px over 1s;
    animate legacy.y from 0px to 8px over 1s;
  }
}
export out = render(main, width: 80px, height: 64px, codec: "h264");`;
  assert.equal(digest(Buffer.from(source)), "bc896e53b7992b6dfd825ea4d3f7628810713ff90d25ed45a8ef7c97a03d3726");
  const cutModule = parsedSource(source), checked = checkCutModule(cutModule);
  assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), []);
  const built = compileCutModule(cutModule).ir;
  const node = Object.values(built.nodes).find((candidate) => candidate.op === "cut.visual.path")!;
  assert.deepEqual(Object.keys(node.inputs), ["points", "stroke", "width"]);
  assert.deepEqual(Object.keys(node.properties).sort(), ["x", "y"]);
  assert.equal(prepareReferenceVectorPathNode(built, node), undefined, "animated legacy placement must stay on the established Path(points:) renderer");
  const projection = {
    node: { op: node.op, interval: node.interval, inputs: node.inputs, properties: node.properties, effects: node.effects },
    signals: Object.fromEntries(["x", "y"].map((name) => {
      const binding = node.properties[name];
      assert.ok(binding && "signal" in binding);
      return [name, built.signals[binding.signal]];
    })),
  };
  assert.equal(digest(Buffer.from(JSON.stringify(projection))), "0ba1c5226f6528449af2e659c3f448dabff8095275f7f041bbf773bc61ec3733");
  const loaded = loadCutAvIr(JSON.stringify(built));
  assert.doesNotThrow(() => validateReferenceSession(loaded));
  loaded.determinism.semantic = "locked";
  finalizeGraphHashes(loaded);
  const { composition } = validateReferenceSession(loaded);
  const root = await mkdtemp(resolve(tmpdir(), "cut-legacy-path-xy-"));
  const renderer = new ReferenceVisualRenderer(loaded, composition, root, resolve(root, "cache"));
  await renderer.prepare();
  try {
    const scene = loaded.scenes[composition.sceneIds[0]]!;
    const first = await renderer.sceneFrame(scene, 0, false);
    const moved = await renderer.sceneFrame(scene, 10, false);
    assert.deepEqual(alphaBounds(first.data, first.width, first.height), { left: 6, top: 10, right: 45, bottom: 29 });
    assert.deepEqual(alphaBounds(moved.data, moved.width, moved.height), { left: 18, top: 18, right: 57, bottom: 37 });
    assert.equal(digest(first.data), "c92c43f752501e8be7308b754e7ed010a3254b102477f38c92166d3df298308b");
    assert.equal(digest(moved.data), "6b1a1b1d1d0d3b80e4db667dee647240b43864af48d803d37e3fbb0436b34ee2");
  } finally { renderer.close(); }
});

test("fill-rule-aware coverage accepts an evenodd bow-tie and rejects a twice-wound evenodd void", { timeout: 30_000 }, async () => {
  const twice = "[lineTo(to: { x: 34px, y: 10px }), lineTo(to: { x: 34px, y: 34px }), lineTo(to: { x: 10px, y: 34px }), lineTo(to: { x: 10px, y: 10px }), lineTo(to: { x: 34px, y: 10px }), lineTo(to: { x: 34px, y: 34px }), lineTo(to: { x: 10px, y: 34px })]";
  const renderOne = async (body: string, frame = 0) => {
    const ir = compiledSource(body); ir.determinism.semantic = "locked";
    const { composition } = validateReferenceSession(ir), root = await mkdtemp(resolve(tmpdir(), "cut-vector-pixels-"));
    const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "cache")); await renderer.prepare();
    try { return await renderer.sceneFrame(ir.scenes[composition.sceneIds[0]]!, frame, false); }
    finally { renderer.close(); }
  };
  const nonzero = await renderOne(`Path(geometry: vectorPath(start: { x: 10px, y: 10px }, segments: ${twice}, closed: true), fill: #ff3300, fillRule: "nonzero");`);
  assert.ok([...nonzero.data].some((value, index) => index % 4 === 3 && value > 0));
  await assert.rejects(
    () => renderOne(`Path(geometry: vectorPath(start: { x: 10px, y: 10px }, segments: ${twice}, closed: true), fill: #ff3300, fillRule: "evenodd");`),
    /zero visible coverage under fillRule “evenodd”/u,
  );
  const bowTie = await renderOne(`Path(geometry: vectorPath(start: { x: 10px, y: 10px }, segments: [lineTo(to: { x: 34px, y: 34px }), lineTo(to: { x: 10px, y: 34px }), lineTo(to: { x: 34px, y: 10px })], closed: true), fill: #00aa88, fillRule: "evenodd");`);
  assert.ok([...bowTie.data].filter((value, index) => index % 4 === 3 && value > 0).length > 200, "the two evenodd bow-tie lobes must rasterize");
});

test("a cubicBezier alias remains structurally dynamic and changes exact motion-blur shutter samples", { timeout: 30_000 }, async () => {
  const source = (blur: boolean) => `cut 0.4;
project "retained Path cubicBezier alias";
import { MotionBlur, Path, lineTo, vectorPath } from "cut:visual";
import { cubicBezier } from "@cut/motion";
const hold = cubicBezier(1, 0, 1, 0);
timeline main(duration: 2s, fps: 10, width: 80px, height: 64px, sampleRate: 48khz) {
  scene only(duration: 2s) {
    ${blur ? "MotionBlur(shutterAngle: 360deg, samples: 4) {" : ""}
      Path(geometry: vectorPath(start: { x: 8px, y: 12px }, segments: [lineTo(to: { x: 60px, y: 12px })], closed: false), morphTo: vectorPath(start: { x: 8px, y: 48px }, segments: [lineTo(to: { x: 60px, y: 48px })], closed: false), morph: 0%, stroke: #ffffff, width: 3px) as route;
      animate route.morph from 0% to 100% over 2s ease hold;
    ${blur ? "}" : ""}
  }
}
  export out = render(main, width: 80px, height: 64px, codec: "h264");`;
  const compile = (blur: boolean) => {
    const cutModule = parsedSource(source(blur)), checked = checkCutModule(cutModule);
    assert.deepEqual(checked.diagnostics.filter((item) => item.severity === "error"), []);
    const built = compileCutModule(cutModule).ir;
    const node = Object.values(built.nodes).find((candidate) => candidate.op === "cut.visual.path")!;
    const binding = node.properties.morph;
    assert.ok(binding && "signal" in binding);
    const signal = built.signals[binding.signal];
    assert.equal(signal.kind, "track");
    assert.equal(signal.kind === "track" && signal.events[0]?.kind === "animate" && signal.events[0].curve.kind === "call" ? signal.events[0].curve.op : undefined, "cut.motion.cubic_bezier");
    const plan = prepareReferenceVectorPathNode(built, node)!;
    assert.equal(plan.morphDynamic, true);
    assert.equal(plan.frameDynamic, true);
    built.determinism.semantic = "locked"; finalizeGraphHashes(built);
    return built;
  };
  const renderFrame = async (built: CutAVIR) => {
    const { composition } = validateReferenceSession(built), root = await mkdtemp(resolve(tmpdir(), "cut-vector-bezier-blur-"));
    const renderer = new ReferenceVisualRenderer(built, composition, root, resolve(root, "cache")); await renderer.prepare();
    try { return await renderer.sceneFrame(built.scenes[composition.sceneIds[0]]!, 19, false); }
    finally { renderer.close(); }
  };
  const center = await renderFrame(compile(false));
  const blurred = await renderFrame(compile(true));
  assert.notEqual(digest(center.data), digest(blurred.data), "exact nonconstant cubicBezier shutter samples must bypass the retained static surface cache");
});
