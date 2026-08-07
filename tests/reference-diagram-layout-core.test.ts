import assert from "node:assert/strict";
import test from "node:test";
import { hash } from "../lib/core/stable";
import {
  CutDiagramContractError,
  cutDiagramLimits,
  decodeCutDiagramState,
  type CutDiagramEdgeContract,
  type CutDiagramLayoutContract,
  type CutDiagramNodeContract,
  type CutDiagramStateContract,
} from "../lib/language/diagram-contract";
import type { IRNode, IRValue } from "../lib/language/ir";
import { rational, type Rational } from "../lib/language/rational";
import {
  planReferenceDiagramLayout,
  referenceDiagramLayoutAlgorithmVersion,
  referenceDiagramLayoutFrameAt,
  referenceDiagramLayoutQ16Scale,
  referenceDiagramTransitionSamplesAtOutputFrames,
} from "../lib/runtime/reference/diagram-layout";

const q = referenceDiagramLayoutQ16Scale;

function irNode(id: string, children: readonly string[] = [`${id}_content`], contentHash = hash({ id, paint: "base" })): IRNode {
  return {
    id,
    op: "cut.diagram.node",
    domain: "visual",
    ownership: "child",
    interval: { start: rational(0), duration: rational(1) },
    inputs: {},
    children: [...children],
    properties: {},
    effects: ["pure"],
    contentHash,
    provenance: { module: "project.cut", span: { start: { offset: 0, line: 1, column: 1 }, end: { offset: 1, line: 1, column: 2 } } },
  } as IRNode;
}

function diagramNode(id: string, width = 40, height = 20, rank?: number, contentHash?: string): CutDiagramNodeContract {
  return Object.freeze({ id, width: rational(width), height: rational(height), ...(rank === undefined ? {} : { rank }), node: irNode(`ir_${id}`, [`visual_${id}`], contentHash) });
}

function edge(id: string, from: string, to: string, overrides: Partial<CutDiagramEdgeContract> = {}): CutDiagramEdgeContract {
  const normalized = {
    id,
    from,
    to,
    fromPort: "auto" as const,
    toPort: "auto" as const,
    stroke: "#224466ff",
    width: rational(2),
    ...overrides,
  };
  return Object.freeze({ ...normalized, semanticIdentity: hash({ ...normalized, semanticIdentity: undefined }) });
}

function state(id: string, nodes: readonly string[], edges: readonly CutDiagramEdgeContract[] = []): CutDiagramStateContract {
  return Object.freeze({ id, nodes: Object.freeze([...nodes]), edges: Object.freeze([...edges]), semanticIdentity: hash({ id, nodes, edges }) });
}

function layout(
  state_: CutDiagramStateContract,
  nodes: readonly CutDiagramNodeContract[],
  overrides: Partial<CutDiagramLayoutContract> = {},
): CutDiagramLayoutContract {
  const node = { ...irNode("layout", nodes.map((item) => item.node.id)), op: "cut.diagram.layout", ownership: "root" as const };
  return Object.freeze({
    id: node.id,
    direction: "auto" as const,
    x: rational(0), y: rational(0), safeX: rational(0), safeY: rational(0),
    nodeGap: rational(16), rankGap: rational(48), edgeGap: rational(6), edgeClearance: rational(4),
    state: state_, nodes: Object.freeze([...nodes]), node,
    ...overrides,
  });
}

function expectCode(code: CutDiagramContractError["code"], path?: RegExp) {
  return (error: unknown) => error instanceof CutDiagramContractError && error.code === code && (path === undefined || path.test(error.path));
}

function string(value: string): IRValue { return { kind: "string", value }; }
function color(value: string): IRValue { return { kind: "color", value }; }
function px(value: number): IRValue { return { kind: "quantity", dimension: "length", unit: "px", magnitude: rational(value) }; }
function edgeValue(id: string, from: string, to: string): IRValue {
  return { kind: "object", entries: { id: string(id), from: string(from), to: string(to), stroke: color("#224466ff"), width: px(2) } };
}
function stateValue(id: string, nodes: readonly string[], edges: readonly IRValue[]): IRValue {
  return { kind: "object", entries: { id: string(id), nodes: { kind: "array", items: nodes.map(string) }, edges: { kind: "array", items: [...edges] } } };
}

test("horizontal, vertical, and auto layouts pack exact Q16 centers without hidden scaling", () => {
  const nodes = [diagramNode("a"), diagramNode("b")];
  const graph = state("two", ["a", "b"], [edge("a-b", "a", "b")]);
  const horizontal = planReferenceDiagramLayout(layout(graph, nodes, { direction: "horizontal" }), { canvasWidth: 400, canvasHeight: 200 });
  assert.equal(horizontal.algorithm, referenceDiagramLayoutAlgorithmVersion);
  assert.equal(horizontal.direction, "horizontal");
  assert.deepEqual(horizontal.toEndpoint.nodes.map((node) => node.centerQ16), [
    { xQ16: 156 * q, yQ16: 100 * q },
    { xQ16: 244 * q, yQ16: 100 * q },
  ]);
  assert.equal(horizontal.toEndpoint.edges[0].pointsQ16.length, 5);
  assert.ok(horizontal.toEndpoint.edges[0].pointsQ16.every((point, index, values) => index === 0 || point.xQ16 === values[index - 1].xQ16 || point.yQ16 === values[index - 1].yQ16));

  const vertical = planReferenceDiagramLayout(layout(graph, nodes, { direction: "vertical" }), { canvasWidth: 400, canvasHeight: 200 });
  assert.equal(vertical.direction, "vertical");
  assert.deepEqual(vertical.toEndpoint.nodes.map((node) => node.centerQ16), [
    { xQ16: 200 * q, yQ16: 66 * q },
    { xQ16: 200 * q, yQ16: 134 * q },
  ]);

  assert.equal(planReferenceDiagramLayout(layout(graph, nodes), { canvasWidth: 400, canvasHeight: 200 }).direction, "horizontal");
  assert.equal(planReferenceDiagramLayout(layout(graph, nodes), { canvasWidth: 200, canvasHeight: 400 }).direction, "vertical");
  assert.equal(planReferenceDiagramLayout(layout(graph, nodes), { canvasWidth: 200, canvasHeight: 200 }).direction, "horizontal", "square auto tie is horizontal");
});

test("authored ranks and exactly four stable median sweeps preserve ties and reduce a crossed ordering", () => {
  const nodes = [diagramNode("a", 30, 20, 0), diagramNode("b", 30, 20, 0), diagramNode("c", 30, 20, 1), diagramNode("d", 30, 20, 1)];
  const crossed = state("crossed", ["a", "b", "c", "d"], [edge("a-d", "a", "d"), edge("b-c", "b", "c")]);
  const plan = planReferenceDiagramLayout(layout(crossed, nodes, { direction: "horizontal" }), { canvasWidth: 400, canvasHeight: 220 });
  assert.equal(plan.toEndpoint.work.orderingSweeps, 4);
  assert.deepEqual(plan.toEndpoint.ranks, [{ rank: 0, nodeIds: ["a", "b"] }, { rank: 1, nodeIds: ["d", "c"] }]);

  const ties = state("ties", ["b", "a", "d", "c"], []);
  const allRanked = nodes.map((node, index) => ({ ...node, rank: index < 2 ? 0 : 1 } as CutDiagramNodeContract));
  const tiedPlan = planReferenceDiagramLayout(layout(ties, allRanked, { direction: "horizontal" }), { canvasWidth: 400, canvasHeight: 220 });
  assert.deepEqual(tiedPlan.toEndpoint.ranks, [{ rank: 0, nodeIds: ["b", "a"] }, { rank: 1, nodeIds: ["d", "c"] }], "undefined/equal medians retain state order");
});

test("packing and bounded routing fail explicitly instead of shrinking, overlapping, or drawing through obstacles", () => {
  const tooLarge = diagramNode("huge", 180, 80);
  assert.throws(
    () => planReferenceDiagramLayout(layout(state("huge", ["huge"]), [tooLarge]), { canvasWidth: 100, canvasHeight: 100 }),
    expectCode("CUT_DIAGRAM_LAYOUT_UNSAT", /states\.huge/u),
  );

  const nodes = [diagramNode("a"), diagramNode("b")];
  const graph = state("tight", ["a", "b"], [edge("a-b", "a", "b")]);
  assert.throws(
    () => planReferenceDiagramLayout(layout(graph, nodes, { direction: "horizontal", rankGap: rational(10) }), { canvasWidth: 140, canvasHeight: 100 }),
    expectCode("CUT_DIAGRAM_ROUTE_UNSAT", /edges\.a-b/u),
  );
});

test("receipts are byte-stable and topology, geometry, and paint identities invalidate independently", () => {
  const firstNodes = [diagramNode("a"), diagramNode("b")];
  const graph = state("identity", ["a", "b"], [edge("a-b", "a", "b")]);
  const first = planReferenceDiagramLayout(layout(graph, firstNodes), { canvasWidth: 400, canvasHeight: 200 });
  const repeated = planReferenceDiagramLayout(layout(graph, firstNodes), { canvasWidth: 400, canvasHeight: 200 });
  assert.deepEqual(repeated, first);
  assert.match(first.receiptIdentity, /^[0-9a-f]{64}$/u);
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.displayFrame.nodes));

  const changedNodes = [diagramNode("a", 40, 20, undefined, hash("changed-pixels")), firstNodes[1]];
  const paintChange = planReferenceDiagramLayout(layout(graph, changedNodes), { canvasWidth: 400, canvasHeight: 200 });
  assert.equal(paintChange.topologyIdentity, first.topologyIdentity);
  assert.equal(paintChange.geometryIdentity, first.geometryIdentity);
  assert.notEqual(paintChange.paintIdentity, first.paintIdentity);
  assert.notEqual(paintChange.receiptIdentity, first.receiptIdentity);

  const context = first.descendantContexts[0];
  assert.deepEqual({ kind: context.contextKind, width: context.width, height: context.height, origin: context.origin }, { kind: "diagram-node", width: 40, height: 20, origin: "center" });
  assert.deepEqual(context.originQ16, { xQ16: 20 * q, yQ16: 10 * q });
  assert.deepEqual(context.configChildIds, ["visual_a"]);
});

test("the shared contract rejects duplicate identities and directed cycles before planning", () => {
  assert.throws(
    () => decodeCutDiagramState(stateValue("duplicate", ["a", "a"], [])),
    expectCode("CUT_DIAGRAM_IDENTITY", /nodes\[1\]/u),
  );
  assert.throws(
    () => decodeCutDiagramState(stateValue("cycle", ["a", "b"], [edgeValue("a-b", "a", "b"), edgeValue("b-a", "b", "a")])),
    expectCode("CUT_DIAGRAM_GRAPH", /edges/u),
  );
});

test("exact transition preflight catches an intermediate collision even though both endpoint layouts are safe", () => {
  const nodes = [diagramNode("a", 40, 20, 0), diagramNode("b", 40, 20, 0)];
  const from = state("from", ["a", "b"]), to = state("to", ["b", "a"]);
  const fromStatic = planReferenceDiagramLayout(layout(from, nodes), { canvasWidth: 240, canvasHeight: 120 });
  const toStatic = planReferenceDiagramLayout(layout(to, nodes), { canvasWidth: 240, canvasHeight: 120 });
  const overlaps = (plan: typeof fromStatic) => plan.displayFrame.nodes.some((left, index, all) => all.slice(index + 1).some((right) =>
    left.displayRectQ16.rightQ16 > right.displayRectQ16.leftQ16 && right.displayRectQ16.rightQ16 > left.displayRectQ16.leftQ16
    && left.displayRectQ16.bottomQ16 > right.displayRectQ16.topQ16 && right.displayRectQ16.bottomQ16 > left.displayRectQ16.topQ16));
  assert.equal(overlaps(fromStatic), false);
  assert.equal(overlaps(toStatic), false);

  const transition = layout(to, nodes, { fromState: from, progress: rational(1, 2) });
  assert.throws(
    () => planReferenceDiagramLayout(transition, {
      canvasWidth: 240,
      canvasHeight: 120,
      transitionSamples: [{ at: rational(0), progress: rational(0) }, { at: rational(1, 2), progress: rational(1, 2) }, { at: rational(1), progress: rational(1) }],
    }),
    expectCode("CUT_DIAGRAM_TRANSITION_COLLISION", /transition\.nodes/u),
  );
});

test("safe state transitions expose display geometry, progressive edge trim, and terminal tangent for the retained renderer", () => {
  const nodes = [diagramNode("a", 40, 20, 0), diagramNode("b", 40, 20, 1)];
  const from = state("one", ["a", "b"]), to = state("two", ["a", "b"], [edge("a-b", "a", "b")]);
  const fullGrid = Array.from({ length: 24 }, (_, frame) => ({ at: rational(frame, 24), progress: rational(frame, 23) }));
  const plan = planReferenceDiagramLayout(layout(to, nodes, { fromState: from, progress: rational(1, 2) }), {
    canvasWidth: 400,
    canvasHeight: 200,
    transitionSamples: fullGrid,
  });
  assert.equal(plan.work.transitionSamples, 24, "every admitted output-frame sample, including partial final-segment trims, preflights safely");
  const middle = referenceDiagramLayoutFrameAt(plan, { at: rational(1, 2), progress: rational(1, 2) });
  assert.equal(middle.nodes.find((node) => node.id === "a")?.phase, "persistent");
  assert.equal(middle.nodes.find((node) => node.id === "b")?.opacityQ16, q);
  const entering = middle.edges[0];
  assert.equal(entering.phase, "entering");
  assert.equal(entering.trimEndQ16, q / 2);
  assert.ok(entering.visiblePointsQ16.length >= 2);
  assert.ok(Math.abs(entering.terminalTangentQ16.xQ16) + Math.abs(entering.terminalTangentQ16.yQ16) === q);
  assert.equal(plan.displayFrame.geometryIdentity, middle.geometryIdentity);
  assert.notEqual(plan.displayFrame.receiptIdentity, middle.receiptIdentity, "sample time remains receipt evidence without poisoning geometry identity");
});

test("a transition may deterministically exit the final retained node into an empty target state", () => {
  const nodes = [diagramNode("a")], from = state("visible", ["a"]), to = state("empty", []);
  const plan = planReferenceDiagramLayout(layout(to, nodes, { fromState: from, progress: rational(1, 2) }), {
    canvasWidth: 200,
    canvasHeight: 100,
    transitionSamples: [{ at: rational(0), progress: rational(0) }, { at: rational(1), progress: rational(1) }],
  });
  assert.equal(plan.toEndpoint.nodes.length, 0);
  assert.equal(plan.displayFrame.nodes[0].phase, "exiting");
  assert.equal(plan.displayFrame.nodes[0].opacityQ16, q / 2);
});

test("transition sample values are canonical, ordered, bounded, and required for transition planning", () => {
  const nodes = [diagramNode("a"), diagramNode("b")];
  const from = state("one", ["a"]), to = state("two", ["a", "b"], [edge("a-b", "a", "b")]);
  const transitioning = layout(to, nodes, { fromState: from, progress: rational(1, 2) });
  assert.throws(() => planReferenceDiagramLayout(transitioning, { canvasWidth: 400, canvasHeight: 200 }), expectCode("CUT_DIAGRAM_TYPE", /transitionSamples/u));
  assert.throws(() => planReferenceDiagramLayout(transitioning, {
    canvasWidth: 400, canvasHeight: 200,
    transitionSamples: [{ at: rational(1), progress: rational(0) }, { at: rational(0), progress: rational(1) }],
  }), expectCode("CUT_DIAGRAM_TYPE", /\[1\]\.at/u));
  const invalidProgress: Rational = { numerator: "2", denominator: "1" };
  assert.throws(() => planReferenceDiagramLayout(transitioning, {
    canvasWidth: 400, canvasHeight: 200,
    transitionSamples: [{ at: rational(0), progress: invalidProgress }],
  }), expectCode("CUT_DIAGRAM_BOUNDS", /progress/u));
});

test("one exact half-open output-grid helper owns ceil admission and the 4096-sample bound", () => {
  const samples = referenceDiagramTransitionSamplesAtOutputFrames({
    intervalStart: rational(1, 100),
    intervalDuration: rational(1, 10),
    fps: rational(30),
    progressAt: (at) => at,
    layoutId: "grid",
  });
  assert.deepEqual(samples, [
    { at: rational(1, 30), progress: rational(1, 30) },
    { at: rational(1, 15), progress: rational(1, 15) },
    { at: rational(1, 10), progress: rational(1, 10) },
  ]);
  assert.ok(Object.isFrozen(samples));
  assert.deepEqual(referenceDiagramTransitionSamplesAtOutputFrames({
    intervalStart: rational(0), intervalDuration: rational(1), fps: rational(1),
    progressAt: () => ({ numerator: "50", denominator: "100" }), layoutId: "evaluated-signal",
  }), [{ at: rational(0), progress: rational(1, 2) }], "exact signal fractions normalize once at the retained sample boundary");
  assert.throws(() => referenceDiagramTransitionSamplesAtOutputFrames({
    intervalStart: rational(0), intervalDuration: rational(4_097), fps: rational(1), progressAt: () => rational(0), layoutId: "grid",
  }), expectCode("CUT_DIAGRAM_LIMIT", /interval/u));
});

test("per-sample limits do not falsely become cumulative, while the composition budget is cumulative", () => {
  const nodes = [diagramNode("a", 20, 20, 0), diagramNode("b", 20, 20, 0), diagramNode("c", 20, 20, 0)];
  const from = state("same-from", ["a", "b", "c"]), to = state("same-to", ["a", "b", "c"]);
  const samples = Array.from({ length: 1_400 }, (_, index) => ({ at: rational(index), progress: rational(index, 1_399) }));
  const plan = planReferenceDiagramLayout(layout(to, nodes, { fromState: from, progress: rational(1) }), {
    canvasWidth: 240, canvasHeight: 160, transitionSamples: samples,
  });
  assert.equal(plan.work.nodePairTests, 4_200, "three tests per sample may exceed the per-sample bound in aggregate");
  assert.equal(plan.validationBudget.consumedValidationTests, plan.work.validationTests);

  const routedNodes = [diagramNode("x"), diagramNode("y")];
  const routed = state("routed", ["x", "y"], [edge("x-y", "x", "y")]);
  assert.throws(() => planReferenceDiagramLayout(layout(routed, routedNodes), {
    canvasWidth: 400,
    canvasHeight: 200,
    priorValidationTests: cutDiagramLimits.validationTestsPerComposition,
  }), expectCode("CUT_DIAGRAM_LIMIT", /validation/u));
});

test("frame geometry identity depends on executed Q16 geometry, not sample time", () => {
  const nodes = [diagramNode("a", 40, 20, 0), diagramNode("b", 40, 20, 1)];
  const from = state("one", ["a", "b"]), to = state("two", ["a", "b"], [edge("a-b", "a", "b")]);
  const plan = planReferenceDiagramLayout(layout(to, nodes, { fromState: from, progress: rational(1, 2) }), {
    canvasWidth: 400,
    canvasHeight: 200,
    transitionSamples: [{ at: rational(0), progress: rational(1, 2) }],
  });
  const early = referenceDiagramLayoutFrameAt(plan, { at: rational(1), progress: rational(1, 2) });
  const late = referenceDiagramLayoutFrameAt(plan, { at: rational(99), progress: rational(1, 2) });
  assert.equal(early.geometryIdentity, late.geometryIdentity);
  assert.notEqual(early.receiptIdentity, late.receiptIdentity);
});

test("a bounded five-point route may not leave and then re-enter either endpoint rectangle", () => {
  const nodes = [diagramNode("a"), diagramNode("b")];
  const backwardsPorts = state("backwards-ports", ["a", "b"], [edge("a-b", "a", "b", { fromPort: "left", toPort: "right" })]);
  assert.throws(
    () => planReferenceDiagramLayout(layout(backwardsPorts, nodes, { direction: "horizontal" }), { canvasWidth: 400, canvasHeight: 200 }),
    expectCode("CUT_DIAGRAM_ROUTE_UNSAT", /a-b/u),
  );
});

test("canonical routing exhausts internal gutters before using a bounded safe-frame perimeter gutter", () => {
  const nodes = [
    diagramNode("a", 63, 43, 1),
    diagramNode("b", 72, 40, 0),
    diagramNode("c", 76, 20, 2),
    diagramNode("d", 20, 47, 0),
  ];
  const graph = state("perimeter", ["d", "b", "a", "c"], [
    edge("a-c", "a", "c"),
    edge("b-c", "b", "c"),
    edge("d-c", "d", "c"),
  ]);
  const plan = planReferenceDiagramLayout(layout(graph, nodes, {
    direction: "horizontal", nodeGap: rational(31), rankGap: rational(50), edgeGap: rational(7), edgeClearance: rational(0),
  }), { canvasWidth: 500, canvasHeight: 300 });
  const routed = plan.toEndpoint.edges.find((item) => item.id === "b-c")!;
  const baseQ16 = 8 * q; // 0px clearance + 1px half-stroke + 7px edge gap.
  assert.ok(routed.pointsQ16[2].xQ16 > routed.pointsQ16[4].xQ16 - baseQ16, "selected lane is beyond the internal source/destination gutter");
  assert.equal(routed.pointsQ16[2].xQ16, plan.frame.contentQ16.rightQ16 - baseQ16, "first safe perimeter candidate wins exactly");
  assert.ok(plan.toEndpoint.work.routeCandidates > graph.edges.length, "receipt retains rejected bounded candidates");
  assert.ok(plan.toEndpoint.work.validationTests > plan.toEndpoint.work.routeNodeTests, "edge/edge candidate comparisons consume the total validation budget too");
});

test("transition route/node preflight executes authored edgeClearance, not only half the stroke width", () => {
  const nodes = [
    diagramNode("a", 68, 43, 0), diagramNode("b", 49, 50, 2), diagramNode("c", 28, 16, 0),
    diagramNode("d", 51, 50, 0), diagramNode("e", 43, 21, 1), diagramNode("f", 23, 42, 0),
  ];
  const edges = [edge("a-e", "a", "e"), edge("c-e", "c", "e"), edge("d-b", "d", "b"), edge("f-e", "f", "e")];
  const from = state("clearance-from", ["c", "b", "e", "f", "a", "d"], edges);
  const to = state("clearance-to", ["b", "f", "a", "c", "d", "e"], edges);
  const base = { fromState: from, progress: rational(1, 2), direction: "horizontal" as const, nodeGap: rational(19), rankGap: rational(57), edgeGap: rational(5) };
  const context = { canvasWidth: 500, canvasHeight: 300, transitionSamples: [{ at: rational(0), progress: rational(1, 2) }] };
  assert.doesNotThrow(() => planReferenceDiagramLayout(layout(to, nodes, { ...base, edgeClearance: rational(0) }), context));
  assert.throws(
    () => planReferenceDiagramLayout(layout(to, nodes, { ...base, edgeClearance: rational(8) }), context),
    expectCode("CUT_DIAGRAM_TRANSITION_COLLISION", /transition\.routes/u),
  );
});
