import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import type { CutAVIR, IRNode, IRValue } from "../lib/language/ir";
import { loadCutAvIr } from "../lib/language/ir-loader";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";
import { diffCutAVIR } from "../lib/language/semantic-diff";
import { createIncrementalRenderPlan, finalizeGraphHashes } from "../lib/runtime/graph";
import { inspectCutIr } from "../lib/runtime/inspect";
import {
  prepareReferenceCubicTrace,
  prepareReferenceTraceNode,
  referenceCubicTraceFlattening,
  referenceTracePrefixWithTangent,
  ReferenceTraceError,
} from "../lib/runtime/reference/trace";
import { validateReferenceSession } from "../lib/runtime/reference/validate";
import { ReferenceVisualRenderer } from "../lib/runtime/reference/visual";

function program(body: string, duration = "2s") {
  return `cut 0.4;
project "cubic trace";
import { Group, Trace, cubicTo, traceArrow } from "cut:visual";
timeline main(duration: ${duration}, fps: 10, width: 72px, height: 64px, sampleRate: 48khz) {
  scene only(duration: ${duration}) { ${body} }
}
export out = render(main, width: 72px, height: 64px, codec: "h264");`;
}

const cubicBody = `Trace(
  stroke: #00ff00,
  width: 2px,
  duration: 1s,
  delay: 200ms,
  start: { x: 8px, y: 48px },
  curves: [cubicTo(
    control1: { x: 8px, y: 16px },
    control2: { x: 56px, y: 16px },
    to: { x: 56px, y: 48px }
  )],
  arrow: traceArrow(length: 16px, width: 8px, color: #ff0000)
);`;

function parse(source: string) {
  const parsed = parseCutLanguage(source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  return parsed.module;
}

function compile(body = cubicBody) {
  const result = compileCutModule(parse(program(body)));
  assert.deepEqual(result.check.diagnostics, []);
  return result.ir;
}

function traceNode(ir: CutAVIR) {
  const node = Object.values(ir.nodes).find((candidate) => candidate.op === "cut.visual.trace");
  assert.ok(node);
  return node;
}

function lockedHostile(mutate: (node: IRNode, ir: CutAVIR) => void) {
  const ir = compile();
  ir.determinism.semantic = "locked";
  mutate(traceNode(ir), ir);
  finalizeGraphHashes(ir);
  return loadCutAvIr(JSON.stringify(ir));
}

const px = (value: number): IRValue => ({ kind: "quantity", dimension: "length", magnitude: rational(value), unit: "px" });
const point = (x: number, y: number): IRValue => ({ kind: "object", entries: { x: px(x), y: px(y) } });

function sourceDiagnostics(body: string) {
  return checkCutModule(parse(program(body))).diagnostics;
}

test("Trace exposes one concise typed cubic/arrow form without changing old polyline IR", () => {
  const ir = compile(), node = traceNode(ir), plan = prepareReferenceTraceNode(node);
  assert.ok(plan);
  assert.equal(plan.geometry, "cubic");
  assert.equal(plan.authoredSegments, 1);
  assert.ok(plan.trace.points.length > 2, "the public cubic must lower to bounded runtime geometry, not one straight chord");
  assert.deepEqual(plan.arrow, { length: 16, width: 8, color: "#ff0000" });
  assert.deepEqual(Object.keys(node.inputs).sort(), ["arrow", "curves", "delay", "duration", "start", "stroke", "width"]);
  assert.deepEqual(Object.keys((node.inputs.curves as Extract<IRValue, { kind: "array" }>).items[0]).sort(), ["entries", "kind"]);

  const oldSource = `Trace(points: [{ x: 8px, y: 32px }, { x: 56px, y: 32px }], stroke: #ffffff, width: 2px, duration: 1s);`;
  const old = compile(oldSource), respelled = compile(`// formatting must not change identity\n${oldSource}`);
  const oldNode = traceNode(old);
  assert.deepEqual(Object.keys(oldNode.inputs).sort(), ["duration", "points", "stroke", "width"]);
  assert.equal(oldNode.contentHash, traceNode(respelled).contentHash);
  assert.equal(old.buildId, respelled.buildId);
  assert.deepEqual(diffCutAVIR(old, respelled).changes, []);
});

test("source diagnostics close geometry selection, record types, and endpoint-marker conflicts", () => {
  const base = `stroke: #ffffff, width: 2px, duration: 1s`;
  const cases: Array<[string, string, RegExp]> = [
    [`Trace(${base});`, "CUT_TRACE_GEOMETRY", /requires points.*complete start.*curves/],
    [`Trace(points: [{ x: 0px, y: 0px }, { x: 8px, y: 0px }], start: { x: 0px, y: 0px }, curves: [cubicTo(control1: { x: 1px, y: 1px }, control2: { x: 2px, y: 2px }, to: { x: 3px, y: 3px })], ${base});`, "CUT_TRACE_GEOMETRY", /exactly one geometry form/],
    [`Trace(start: { x: 0px, y: 0px }, ${base});`, "CUT_TRACE_GEOMETRY", /complete start.*curves/],
    [`Trace(curves: [cubicTo(control1: { x: 1px, y: 1px }, control2: { x: 2px, y: 2px }, to: { x: 3px, y: 3px })], ${base});`, "CUT_TRACE_GEOMETRY", /complete start.*curves/],
    [`Trace(start: { x: 0px, y: 0px }, curves: [{ control1: { x: 1px, y: 1px }, control2: { x: 2px, y: 2px }, to: { x: 3px, y: 3px } }], ${base});`, "CUT2029", /expects List<CubicPathSegment>/],
    [`Trace(start: { x: 0px, y: 0px }, curves: [cubicTo(control1: { x: 1px, y: 1px }, control2: { x: 2px, y: 2px }, to: { x: 3px, y: 3px })], arrow: traceArrow(length: 8px, width: 6px, color: #ffffff), headRadius: 2px, ${base});`, "CUT_TRACE_ARROW", /mutually exclusive/],
  ];
  for (const [body, code, expected] of cases) {
    const diagnostic = sourceDiagnostics(body).find((candidate) => candidate.code === code);
    assert.ok(diagnostic, `${code}: ${body}`);
    assert.match(diagnostic.message, expected);
    assert.ok(diagnostic.span.start.line > 0 && diagnostic.span.start.column > 0);
  }

  const expressionConflict = program(cubicBody.replace("arrow: traceArrow", "headRadius: 1px + 1px,\n  arrow: traceArrow"));
  assert.throws(() => compileCutModule(parse(expressionConflict)), (error: unknown) => {
    assert.ok(error instanceof CutCompileError);
    const diagnostic = error.result.diagnostics.find((candidate) => candidate.code === "CUT_TRACE_ARROW");
    assert.ok(diagnostic);
    assert.match(diagnostic.message, /mutually exclusive/);
    assert.ok(diagnostic.span.start.line > 0);
    return true;
  });
});

test("cubic flattening and arc-length tangent sampling are deterministic and bounded", () => {
  assert.equal(referenceCubicTraceFlattening.version, 1);
  assert.ok(referenceCubicTraceFlattening.tolerancePx * referenceCubicTraceFlattening.directTraceScaleEnvelope <= referenceCubicTraceFlattening.maximumDirectTraceErrorPx);
  const segments = [{ control1: { x: 0, y: -32 }, control2: { x: 48, y: -32 }, to: { x: 48, y: 0 } }];
  const first = prepareReferenceCubicTrace({ x: 0, y: 0 }, segments);
  const replay = prepareReferenceCubicTrace({ x: 0, y: 0 }, segments);
  assert.deepEqual(first, replay);
  assert.ok(first.points.length > 2 && first.points.length <= referenceCubicTraceFlattening.maxFlattenedPoints);
  assert.deepEqual(first.points[0], { x: 0, y: 0 });
  assert.deepEqual(first.points.at(-1), { x: 48, y: 0 });
  const start = referenceTracePrefixWithTangent(first, 0), middle = referenceTracePrefixWithTangent(first, .5), end = referenceTracePrefixWithTangent(first, 1);
  assert.ok(start.tangent.y < -.99, JSON.stringify(start.tangent));
  assert.ok(Math.abs(end.tangent.x) < .02 && end.tangent.y > .99, JSON.stringify(end.tangent));
  assert.ok(Math.abs(Math.hypot(middle.tangent.x, middle.tangent.y) - 1) < 1e-12);
  assert.ok(Math.abs(first.cumulativeLengths[Math.floor(first.cumulativeLengths.length / 2)] - first.totalLength / 2) < 2);

  const overshoot = prepareReferenceCubicTrace({ x: 0, y: 0 }, [{ control1: { x: 100, y: 0 }, control2: { x: -100, y: 0 }, to: { x: 10, y: 0 } }]);
  assert.ok(overshoot.points.length > 2, "collinear overshoot/backtracking must not collapse to its endpoint chord");
  assert.ok(overshoot.totalLength > 10, "arc length must retain the collinear reversal");
});

test("hostile loaded IR cannot bypass closed cubic geometry, arrow, or kernel inputs", () => {
  const cases: Array<[(node: IRNode, ir: CutAVIR) => void, string, RegExp]> = [
    [(node) => { node.inputs.points = { kind: "array", items: [point(0, 0), point(2, 2)] }; }, "CUT_TRACE_GEOMETRY", /exactly one geometry form/],
    [(node) => { const curves = node.inputs.curves as Extract<IRValue, { kind: "array" }>; (curves.items[0] as Extract<IRValue, { kind: "object" }>).entries.extra = px(1); }, "CUT_TRACE_GEOMETRY", /curves\[0\].*exactly control1, control2, to/],
    [(node) => { node.inputs.curves = { kind: "array", items: [] }; }, "CUT_TRACE_LIMIT", /1 through 256/],
    [(node) => { node.inputs.start = point(65_537, 0); }, "CUT_TRACE_GEOMETRY", /coordinate limit/],
    [(node) => { const curves = node.inputs.curves as Extract<IRValue, { kind: "array" }>; const segment = curves.items[0] as Extract<IRValue, { kind: "object" }>; segment.entries.control1 = point(8, 48); segment.entries.control2 = point(8, 48); segment.entries.to = point(8, 48); }, "CUT_TRACE_GEOMETRY", /positive-length path/],
    [(node) => { (node.inputs.arrow as Extract<IRValue, { kind: "object" }>).entries.extra = px(1); }, "CUT_TRACE_ARROW", /exactly length, width, color/],
    [(node) => { (node.inputs.arrow as Extract<IRValue, { kind: "object" }>).entries.length = px(0); }, "CUT_TRACE_ARROW", /greater than 0px/],
    [(node) => { node.inputs.headRadius = px(2); }, "CUT_TRACE_ARROW", /mutually exclusive/],
  ];
  for (const [mutate, code, expected] of cases) {
    assert.throws(() => validateReferenceSession(lockedHostile(mutate)), (error: unknown) => {
      assert.ok(error instanceof ReferenceTraceError);
      assert.equal(error.code, code);
      assert.match(error.message, expected);
      assert.equal(error.source.module, "project.cut");
      assert.ok(error.source.line > 0 && error.source.column > 0);
      return true;
    });
  }

  assert.throws(() => lockedHostile((node) => { node.inputs.dash = px(4); }), /CUT_IR_UNKNOWN_FIELD.*inputs\.dash/);
  assert.throws(() => compile(cubicBody.replace("#ff0000", "#ff000000")), (error: unknown) => (
    error instanceof CutCompileError
    && error.result.diagnostics.some((diagnostic) => diagnostic.code === "CUT2085" && /arrow\.color cannot be fully transparent/.test(diagnostic.message))
  ));
});

type Surface = { data: Uint8Array; width: number; height: number };

function redBounds(surface: Surface) {
  let left = surface.width, right = -1, top = surface.height, bottom = -1;
  for (let y = 0; y < surface.height; y += 1) for (let x = 0; x < surface.width; x += 1) {
    const offset = (y * surface.width + x) * 4, red = surface.data[offset], green = surface.data[offset + 1], blue = surface.data[offset + 2];
    if (red > 120 && red > green * 1.6 && red > blue * 1.6) { left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); }
  }
  assert.ok(right >= left && bottom >= top, "expected arrow pixels");
  return { left, right, top, bottom, width: right - left + 1, height: bottom - top + 1 };
}

async function frames(body: string, indices: number[]) {
  const ir = compile(body);
  ir.determinism.semantic = "locked";
  const { composition } = validateReferenceSession(ir);
  const root = await mkdtemp(resolve(tmpdir(), "cut-cubic-trace-"));
  const renderer = new ReferenceVisualRenderer(ir, composition, root, resolve(root, "cache"));
  await renderer.prepare();
  try {
    const scene = ir.scenes[composition.sceneIds[0]];
    const surfaces: Surface[] = [];
    for (const frame of indices) surfaces.push(await renderer.sceneFrame(scene, frame, false));
    return surfaces;
  } finally { renderer.close(); }
}

test("cubic pixels reveal continuously and the tangent arrow rotates and persists", async () => {
  const [before, middle, complete, held] = await frames(cubicBody, [1, 7, 12, 18]);
  assert.ok(before.data.every((value, index) => index % 4 !== 3 || value === 0), "delay must leave a transparent frame");
  assert.notDeepEqual(middle.data, complete.data, "arc-length reveal must change pixels before completion");
  const vertical = redBounds(complete), persisted = redBounds(held);
  assert.ok(vertical.height > vertical.width, JSON.stringify(vertical));
  assert.deepEqual(persisted, vertical, "arrow must remain at the terminal tangent after completion");

  const horizontalBody = cubicBody
    .replace("{ x: 8px, y: 48px }", "{ x: 8px, y: 32px }")
    .replace("{ x: 8px, y: 16px }", "{ x: 24px, y: 32px }")
    .replace("{ x: 56px, y: 16px }", "{ x: 40px, y: 32px }")
    .replace("{ x: 56px, y: 48px }", "{ x: 56px, y: 32px }");
  const [horizontalSurface] = await frames(horizontalBody, [12]);
  const horizontal = redBounds(horizontalSurface);
  assert.ok(horizontal.width > horizontal.height, JSON.stringify(horizontal));
});

test("nested raster scale remains deterministic without claiming a final-space error envelope", async () => {
  const scaledTrace = cubicBody
    .replace("  start:", "  scale: 1.5,\n  start:")
    .replaceAll("{ x: 8px, y: 48px }", "{ x: 32px, y: 36px }")
    .replace("{ x: 8px, y: 16px }", "{ x: 32px, y: 26px }")
    .replace("{ x: 56px, y: 16px }", "{ x: 40px, y: 26px }")
    .replace("{ x: 56px, y: 48px }", "{ x: 40px, y: 36px }");
  const nested = `Group(scale: 1.5) { ${scaledTrace} }`;
  const [first] = await frames(nested, [12]), [replay] = await frames(nested, [12]);
  assert.deepEqual(first.data, replay.data);
  assert.ok(redBounds(first).width > 0);
});

test("inspect, semantic diff, and build identity expose cubic geometry edits", () => {
  const before = compile(), after = compile(cubicBody.replace("{ x: 56px, y: 16px }", "{ x: 52px, y: 20px }"));
  assert.notEqual(before.buildId, after.buildId);
  const change = diffCutAVIR(before, after).changes.find((candidate) => candidate.entity === "node" && candidate.id === traceNode(before).id);
  assert.ok(change && change.operation === "modify");
  if (change.operation === "modify") assert.ok(change.fields.some((field) => field.path.includes("/inputs/curves")));

  const report = inspectCutIr(before, "main.cut") as ReturnType<typeof inspectCutIr> & { graph: { nodes: Array<{ trace?: Record<string, unknown> }> } };
  const trace = report.graph.nodes.find((node) => node.trace)?.trace;
  assert.deepEqual(trace, {
    geometry: "cubic",
    authoredSegments: 1,
    flattenedPoints: prepareReferenceTraceNode(traceNode(before))!.trace.points.length,
    totalLengthPx: prepareReferenceTraceNode(traceNode(before))!.trace.totalLength,
    flatteningVersion: 1,
    arrow: { length: 16, width: 8, color: "#ff0000", orientation: "terminal-tangent", persistence: "held" },
  });
});

function cacheProgram(controlX: number, arrowLength: number) {
  return `cut 0.4;
project "cubic trace cache locality";
import { Rect, Trace, cubicTo, traceArrow } from "cut:visual";
timeline main(duration: 2s, fps: 24, width: 72px, height: 64px, sampleRate: 48khz) {
  scene route(duration: 1s) {
    Trace(start: { x: 8px, y: 48px }, curves: [cubicTo(control1: { x: 8px, y: 16px }, control2: { x: ${controlX}px, y: 16px }, to: { x: 56px, y: 48px })], stroke: #00ff00, width: 2px, duration: 1s, arrow: traceArrow(length: ${arrowLength}px, width: 8px, color: #ff0000));
  }
  scene unrelated(duration: 1s) { Rect(width: 12px, height: 12px, x: 36px, y: 32px, fill: #334455); }
}
export out = render(main, width: 72px, height: 64px, codec: "h264");`;
}

function compileProgram(source: string) {
  const result = compileCutModule(parse(source));
  assert.deepEqual(result.check.diagnostics, []);
  return result.ir;
}

test("cubic controls and arrow edits invalidate only their dependent node and scene", () => {
  const before = compileProgram(cacheProgram(56, 16));
  const previous = createIncrementalRenderPlan(before, "main").manifest;
  for (const after of [compileProgram(cacheProgram(52, 16)), compileProgram(cacheProgram(56, 12))]) {
    const trace = traceNode(after), rect = Object.values(after.nodes).find((node) => node.op === "cut.visual.rect");
    assert.ok(rect);
    const plan = createIncrementalRenderPlan(after, "main", previous);
    assert.equal(plan.nodes.find((node) => node.id === trace.id)?.status, "miss");
    assert.equal(plan.nodes.find((node) => node.id === rect.id)?.status, "hit");
    assert.deepEqual(plan.scenes.map((scene) => scene.status), ["miss", "hit"]);
  }
});
