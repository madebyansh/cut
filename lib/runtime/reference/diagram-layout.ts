import { hash } from "../../core/stable";
import {
  CutDiagramContractError,
  cutDiagramLimits,
  type CutDiagramDiagnosticCode,
  type CutDiagramEdgeContract,
  type CutDiagramLayoutContract,
  type CutDiagramNodeContract,
  type CutDiagramStateContract,
} from "../../language/diagram-contract";
import {
  addRational,
  compareRational,
  divideRational,
  multiplyRational,
  rational,
  subtractRational,
  type Rational,
} from "../../language/rational";

export { CutDiagramContractError };
export type { CutDiagramDiagnosticCode };

export const referenceDiagramLayoutAlgorithmVersion = "cut-reference-diagram-layout-v1" as const;
export const referenceDiagramLayoutQ16Scale = 65_536 as const;

export type ReferenceDiagramPointQ16 = Readonly<{ xQ16: number; yQ16: number }>;
export type ReferenceDiagramRectQ16 = Readonly<{
  leftQ16: number;
  topQ16: number;
  rightQ16: number;
  bottomQ16: number;
  widthQ16: number;
  heightQ16: number;
}>;

export type ReferenceDiagramFrameBounds = Readonly<{
  outerQ16: ReferenceDiagramRectQ16;
  contentQ16: ReferenceDiagramRectQ16;
  width: number;
  height: number;
}>;

export type ReferenceDiagramNodeRasterContext = Readonly<{
  contextKind: "diagram-node";
  width: number;
  height: number;
  origin: "center";
  originQ16: ReferenceDiagramPointQ16;
  localBoundsQ16: ReferenceDiagramRectQ16;
  layoutNodeId: string;
  diagramNodeIrId: string;
  diagramNodeId: string;
  configChildIds: readonly string[];
  semanticIdentity: string;
}>;

export type ReferenceDiagramEndpointNode = Readonly<{
  id: string;
  irNodeId: string;
  childIds: readonly string[];
  rank: number;
  order: number;
  width: number;
  height: number;
  centerQ16: ReferenceDiagramPointQ16;
  rectQ16: ReferenceDiagramRectQ16;
  localRasterContext: ReferenceDiagramNodeRasterContext;
  paintIdentity: string;
}>;

export type ReferenceDiagramEdgePaint = Readonly<{
  stroke: string;
  widthQ16: number;
  arrow?: Readonly<{ lengthQ16: number; widthQ16: number; color: string }>;
}>;

export type ReferenceDiagramEndpointEdge = Readonly<{
  id: string;
  from: string;
  to: string;
  fromPort: "top" | "right" | "bottom" | "left";
  toPort: "top" | "right" | "bottom" | "left";
  pointsQ16: readonly [
    ReferenceDiagramPointQ16,
    ReferenceDiagramPointQ16,
    ReferenceDiagramPointQ16,
    ReferenceDiagramPointQ16,
    ReferenceDiagramPointQ16,
  ];
  crossings: number;
  paint: ReferenceDiagramEdgePaint;
  semanticIdentity: string;
}>;

export type ReferenceDiagramWorkReceipt = Readonly<{
  orderingSweeps: number;
  routeCandidates: number;
  routeNodeTests: number;
  nodePairTests: number;
  transitionSamples: number;
  validationTests: number;
}>;

export type ReferenceDiagramEndpointPlan = Readonly<{
  format: "cut-reference-diagram-endpoint-plan";
  version: 1;
  algorithm: typeof referenceDiagramLayoutAlgorithmVersion;
  stateId: string;
  direction: "horizontal" | "vertical";
  frame: ReferenceDiagramFrameBounds;
  ranks: readonly Readonly<{ rank: number; nodeIds: readonly string[] }>[];
  nodes: readonly ReferenceDiagramEndpointNode[];
  edges: readonly ReferenceDiagramEndpointEdge[];
  work: ReferenceDiagramWorkReceipt;
  topologyIdentity: string;
  geometryIdentity: string;
  paintIdentity: string;
  receiptIdentity: string;
}>;

export type ReferenceDiagramTransitionSample = Readonly<{ at: Rational; progress: Rational }>;
export type ReferenceDiagramNodePhase = "persistent" | "entering" | "exiting";

export type ReferenceDiagramFrameNode = Readonly<{
  id: string;
  irNodeId: string;
  childIds: readonly string[];
  phase: ReferenceDiagramNodePhase;
  width: number;
  height: number;
  fromCenterQ16?: ReferenceDiagramPointQ16;
  toCenterQ16?: ReferenceDiagramPointQ16;
  displayCenterQ16: ReferenceDiagramPointQ16;
  displayRectQ16: ReferenceDiagramRectQ16;
  opacityQ16: number;
  localRasterContext: ReferenceDiagramNodeRasterContext;
  paintIdentity: string;
}>;

export type ReferenceDiagramFrameEdge = Readonly<{
  id: string;
  from: string;
  to: string;
  fromPort: "top" | "right" | "bottom" | "left";
  toPort: "top" | "right" | "bottom" | "left";
  phase: ReferenceDiagramNodePhase;
  pointsQ16: readonly [
    ReferenceDiagramPointQ16,
    ReferenceDiagramPointQ16,
    ReferenceDiagramPointQ16,
    ReferenceDiagramPointQ16,
    ReferenceDiagramPointQ16,
  ];
  visiblePointsQ16: readonly ReferenceDiagramPointQ16[];
  trimEndQ16: number;
  terminalTangentQ16: ReferenceDiagramPointQ16;
  crossings: number;
  paint: ReferenceDiagramEdgePaint;
  semanticIdentity: string;
}>;

export type ReferenceDiagramFramePlan = Readonly<{
  format: "cut-reference-diagram-frame-plan";
  version: 1;
  algorithm: typeof referenceDiagramLayoutAlgorithmVersion;
  layoutId: string;
  at: Rational;
  progress: Rational;
  progressQ16: number;
  direction: "horizontal" | "vertical";
  frame: ReferenceDiagramFrameBounds;
  nodes: readonly ReferenceDiagramFrameNode[];
  edges: readonly ReferenceDiagramFrameEdge[];
  topologyIdentity: string;
  geometryIdentity: string;
  paintIdentity: string;
  receiptIdentity: string;
}>;

export type ReferenceDiagramLayoutPlan = Readonly<{
  format: "cut-reference-diagram-layout-plan";
  version: 1;
  algorithm: typeof referenceDiagramLayoutAlgorithmVersion;
  layoutId: string;
  direction: "horizontal" | "vertical";
  frame: ReferenceDiagramFrameBounds;
  edgeClearanceQ16: number;
  fromEndpoint?: ReferenceDiagramEndpointPlan;
  toEndpoint: ReferenceDiagramEndpointPlan;
  frames: readonly ReferenceDiagramFramePlan[];
  displayFrame: ReferenceDiagramFramePlan;
  descendantContexts: readonly ReferenceDiagramNodeRasterContext[];
  work: ReferenceDiagramWorkReceipt;
  validationBudget: Readonly<{
    priorValidationTests: number;
    consumedValidationTests: number;
    totalValidationTests: number;
    limit: typeof cutDiagramLimits.validationTestsPerComposition;
  }>;
  topologyIdentity: string;
  geometryIdentity: string;
  paintIdentity: string;
  receiptIdentity: string;
}>;

export type ReferenceDiagramLayoutContext = Readonly<{
  canvasWidth: number;
  canvasHeight: number;
  transitionSamples?: readonly ReferenceDiagramTransitionSample[];
  /** Validation tests already consumed by earlier DiagramLayout nodes in the
   * same composition, in stable composition traversal order. */
  priorValidationTests?: number;
}>;

export type ReferenceDiagramOutputSampleContext = Readonly<{
  intervalStart: Rational;
  intervalDuration: Rational;
  fps: Rational;
  progressAt: (at: Rational) => Rational;
  path?: string;
  layoutId?: string;
}>;

type MutableWork = {
  orderingSweeps: number;
  routeCandidates: number;
  routeNodeTests: number;
  nodePairTests: number;
  transitionSamples: number;
  validationTests: number;
};

type ValidationBudget = { used: number; prior: number; layoutId: string };

type Segment = Readonly<{ a: ReferenceDiagramPointQ16; b: ReferenceDiagramPointQ16; index: number }>;

function fail(code: CutDiagramDiagnosticCode, path: string, message: string, nodeId?: string): never {
  throw new CutDiagramContractError(code, path, message, nodeId);
}

function frozen<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) frozen(child);
  return value;
}

function emptyWork(): MutableWork {
  return { orderingSweeps: 0, routeCandidates: 0, routeNodeTests: 0, nodePairTests: 0, transitionSamples: 0, validationTests: 0 };
}

function workReceipt(work: MutableWork): ReferenceDiagramWorkReceipt {
  return frozen({ ...work });
}

function addWork(...items: readonly ReferenceDiagramWorkReceipt[]): MutableWork {
  const result = emptyWork();
  for (const item of items) for (const key of Object.keys(result) as (keyof MutableWork)[]) result[key] += item[key];
  return result;
}

function validation(work: MutableWork, budget: ValidationBudget, kind?: "route" | "node"): void {
  budget.used += 1;
  if (budget.used > cutDiagramLimits.validationTestsPerComposition) {
    fail("CUT_DIAGRAM_LIMIT", "$.layout.validation", `exceeds the composition-wide ${cutDiagramLimits.validationTestsPerComposition}-test validation budget`, budget.layoutId);
  }
  work.validationTests += 1;
  if (kind === "route") {
    work.routeNodeTests += 1;
  } else if (kind === "node") {
    work.nodePairTests += 1;
  }
}

function canonicalRational(value: Rational, path: string): Rational {
  if (!value || !/^-?(?:0|[1-9][0-9]*)$/u.test(value.numerator) || !/^(?:[1-9][0-9]*)$/u.test(value.denominator)) {
    fail("CUT_DIAGRAM_TYPE", path, "must be a canonical exact rational");
  }
  const result = rational(value.numerator, value.denominator);
  if (result.numerator !== value.numerator || result.denominator !== value.denominator) {
    fail("CUT_DIAGRAM_TYPE", path, "must be a canonical reduced exact rational");
  }
  return result;
}

function normalizeEvaluatedRational(value: Rational, path: string): Rational {
  if (!value || !/^-?(?:0|[1-9][0-9]*)$/u.test(value.numerator) || !/^(?:[1-9][0-9]*)$/u.test(value.denominator)) {
    fail("CUT_DIAGRAM_TYPE", path, "must evaluate to an exact rational");
  }
  return rational(value.numerator, value.denominator);
}

function ceilNonnegativeRational(value: Rational, path: string, nodeId?: string): bigint {
  canonicalRational(value, path);
  const numerator = BigInt(value.numerator), denominator = BigInt(value.denominator);
  if (numerator < 0n) fail("CUT_DIAGRAM_BOUNDS", path, "must be non-negative", nodeId);
  return (numerator + denominator - 1n) / denominator;
}

/** The single normative enumeration of exact half-open output-frame samples
 * used by renderer, inspect, and transition collision preflight. */
export function referenceDiagramTransitionSamplesAtOutputFrames(
  context: ReferenceDiagramOutputSampleContext,
): readonly ReferenceDiagramTransitionSample[] {
  const path = context.path ?? "$.layout.interval";
  const start = canonicalRational(context.intervalStart, `${path}.start`);
  const duration = canonicalRational(context.intervalDuration, `${path}.duration`);
  const fps = canonicalRational(context.fps, `${path}.fps`);
  if (compareRational(start, rational(0)) < 0 || compareRational(duration, rational(0)) <= 0) {
    fail("CUT_DIAGRAM_BOUNDS", path, "must be a non-negative start and positive duration", context.layoutId);
  }
  if (compareRational(fps, rational(0)) <= 0) fail("CUT_DIAGRAM_BOUNDS", `${path}.fps`, "must be positive", context.layoutId);
  const startFrame = ceilNonnegativeRational(multiplyRational(start, fps), `${path}.start`, context.layoutId);
  const endFrame = ceilNonnegativeRational(multiplyRational(addRational(start, duration), fps), `${path}.duration`, context.layoutId);
  const count = endFrame - startFrame;
  if (count < 1n || count > BigInt(cutDiagramLimits.transitionSamplesPerLayout)) {
    fail(
      count > BigInt(cutDiagramLimits.transitionSamplesPerLayout) ? "CUT_DIAGRAM_LIMIT" : "CUT_DIAGRAM_BOUNDS",
      path,
      `requires ${count.toString()} exact active output samples; DiagramLayout supports 1 through ${cutDiagramLimits.transitionSamplesPerLayout}`,
      context.layoutId,
    );
  }
  const samples: ReferenceDiagramTransitionSample[] = [];
  for (let outputFrame = startFrame; outputFrame < endFrame; outputFrame += 1n) {
    const at = rational(outputFrame * BigInt(fps.denominator), fps.numerator);
    // Signal interpolation can produce an unreduced but still exact fraction;
    // normalize it at this boundary before the canonical sample is retained.
    const progress = normalizeEvaluatedRational(context.progressAt(at), `${path}.progressAt(${at.numerator}/${at.denominator})`);
    if (compareRational(progress, rational(0)) < 0 || compareRational(progress, rational(1)) > 0) {
      fail("CUT_DIAGRAM_BOUNDS", `${path}.progress`, "must be in the closed 0..1 range", context.layoutId);
    }
    samples.push(frozen({ at, progress }));
  }
  return frozen(samples);
}

function divideRoundHalfEven(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error("positive denominator invariant");
  const sign = numerator < 0n ? -1n : 1n, absolute = numerator < 0n ? -numerator : numerator;
  let quotient = absolute / denominator;
  const remainder = absolute % denominator, twice = remainder * 2n;
  if (twice > denominator || (twice === denominator && quotient % 2n === 1n)) quotient += 1n;
  return quotient * sign;
}

function rationalToQ16(value: Rational, path: string): number {
  canonicalRational(value, path);
  const result = Number(divideRoundHalfEven(BigInt(value.numerator) * BigInt(referenceDiagramLayoutQ16Scale), BigInt(value.denominator)));
  if (!Number.isSafeInteger(result)) fail("CUT_DIAGRAM_BOUNDS", path, "does not fit the Q16.16 runtime boundary");
  return result;
}

function multiplyDivideRoundHalfEven(value: number, numerator: number, denominator: number): number {
  const result = Number(divideRoundHalfEven(BigInt(value) * BigInt(numerator), BigInt(denominator)));
  if (!Number.isSafeInteger(result)) throw new Error("Q16 interpolation overflow");
  return result;
}

function point(xQ16: number, yQ16: number): ReferenceDiagramPointQ16 {
  return frozen({ xQ16, yQ16 });
}

function rect(leftQ16: number, topQ16: number, widthQ16: number, heightQ16: number): ReferenceDiagramRectQ16 {
  return frozen({ leftQ16, topQ16, rightQ16: leftQ16 + widthQ16, bottomQ16: topQ16 + heightQ16, widthQ16, heightQ16 });
}

function rectAt(center: ReferenceDiagramPointQ16, widthQ16: number, heightQ16: number): ReferenceDiagramRectQ16 {
  return rect(center.xQ16 - Math.floor(widthQ16 / 2), center.yQ16 - Math.floor(heightQ16 / 2), widthQ16, heightQ16);
}

function assertCanvas(value: number, path: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > cutDiagramLimits.maximumCoordinatePixels) {
    fail("CUT_DIAGRAM_BOUNDS", path, `must be a whole pixel from 1 through ${cutDiagramLimits.maximumCoordinatePixels}`);
  }
}

function deriveFrame(layout: CutDiagramLayoutContract, context: ReferenceDiagramLayoutContext): ReferenceDiagramFrameBounds {
  assertCanvas(context.canvasWidth, "$.context.canvasWidth");
  assertCanvas(context.canvasHeight, "$.context.canvasHeight");
  const frameWidth = layout.width ?? rational(context.canvasWidth), frameHeight = layout.height ?? rational(context.canvasHeight);
  if (frameWidth.denominator !== "1" || frameHeight.denominator !== "1") fail("CUT_DIAGRAM_TYPE", "$.layout.frame", "frame width and height must be whole pixels", layout.id);
  const width = Number(frameWidth.numerator), height = Number(frameHeight.numerator);
  assertCanvas(width, "$.layout.width"); assertCanvas(height, "$.layout.height");
  const left = addRational(divideRational(subtractRational(rational(context.canvasWidth), frameWidth), rational(2)), layout.x);
  const top = addRational(divideRational(subtractRational(rational(context.canvasHeight), frameHeight), rational(2)), layout.y);
  const right = addRational(left, frameWidth), bottom = addRational(top, frameHeight);
  if (compareRational(left, rational(0)) < 0 || compareRational(top, rational(0)) < 0
    || compareRational(right, rational(context.canvasWidth)) > 0 || compareRational(bottom, rational(context.canvasHeight)) > 0) {
    fail("CUT_DIAGRAM_BOUNDS", "$.layout.frame", "translated DiagramLayout frame must remain inside the delivery canvas", layout.id);
  }
  const insetX = multiplyRational(frameWidth, layout.safeX), insetY = multiplyRational(frameHeight, layout.safeY);
  const contentWidth = subtractRational(frameWidth, multiplyRational(insetX, rational(2)));
  const contentHeight = subtractRational(frameHeight, multiplyRational(insetY, rational(2)));
  if (compareRational(contentWidth, rational(0)) <= 0 || compareRational(contentHeight, rational(0)) <= 0) {
    fail("CUT_DIAGRAM_BOUNDS", "$.layout.safe", "safe insets must leave positive content bounds", layout.id);
  }
  const outerLeft = rationalToQ16(left, "$.layout.frame.left"), outerTop = rationalToQ16(top, "$.layout.frame.top");
  const outerWidth = rationalToQ16(frameWidth, "$.layout.width"), outerHeight = rationalToQ16(frameHeight, "$.layout.height");
  const contentLeft = rationalToQ16(addRational(left, insetX), "$.layout.safeX"), contentTop = rationalToQ16(addRational(top, insetY), "$.layout.safeY");
  return frozen({
    outerQ16: rect(outerLeft, outerTop, outerWidth, outerHeight),
    contentQ16: rect(contentLeft, contentTop, rationalToQ16(contentWidth, "$.layout.safeX"), rationalToQ16(contentHeight, "$.layout.safeY")),
    width,
    height,
  });
}

function utf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function graphRanks(state: CutDiagramStateContract, nodes: ReadonlyMap<string, CutDiagramNodeContract>, layoutId: string) {
  const sourceOrder = new Map(state.nodes.map((id, index) => [id, index]));
  const incoming = new Map(state.nodes.map((id) => [id, [] as string[]]));
  const outgoing = new Map(state.nodes.map((id) => [id, [] as string[]]));
  for (const edge of state.edges) {
    if (!incoming.has(edge.to) || !outgoing.has(edge.from)) fail("CUT_DIAGRAM_GRAPH", `$.states.${state.id}.edges.${edge.id}`, "references a missing endpoint", layoutId);
    incoming.get(edge.to)!.push(edge.from); outgoing.get(edge.from)!.push(edge.to);
  }
  const indegree = new Map([...incoming].map(([id, values]) => [id, values.length]));
  const ready = state.nodes.filter((id) => indegree.get(id) === 0);
  const topo: string[] = [];
  while (ready.length) {
    ready.sort((a, b) => (sourceOrder.get(a)! - sourceOrder.get(b)!) || utf8Compare(a, b));
    const current = ready.shift()!; topo.push(current);
    for (const next of outgoing.get(current) ?? []) {
      const value = indegree.get(next)! - 1; indegree.set(next, value); if (value === 0) ready.push(next);
    }
  }
  if (topo.length !== state.nodes.length) fail("CUT_DIAGRAM_GRAPH", `$.states.${state.id}.edges`, "contains a directed cycle", layoutId);
  const rank = new Map<string, number>();
  for (const id of topo) {
    const minimum = Math.max(0, ...(incoming.get(id) ?? []).map((prior) => rank.get(prior)! + 1));
    const authored = nodes.get(id)?.rank;
    if (authored !== undefined && authored < minimum) {
      fail("CUT_DIAGRAM_GRAPH", `$.nodes.${id}.rank`, `authored rank ${authored} violates minimum directed rank ${minimum}`, nodes.get(id)?.node.id ?? layoutId);
    }
    rank.set(id, authored ?? minimum);
  }
  for (const edge of state.edges) if (rank.get(edge.from)! >= rank.get(edge.to)!) {
    fail("CUT_DIAGRAM_GRAPH", `$.states.${state.id}.edges.${edge.id}`, `edge violates ranks ${rank.get(edge.from)} -> ${rank.get(edge.to)}`, layoutId);
  }
  return { sourceOrder, incoming, outgoing, rank };
}

function medianKey(neighbors: readonly string[], positions: ReadonlyMap<string, number>): number | undefined {
  const values = neighbors.map((id) => positions.get(id)).filter((value): value is number => value !== undefined).sort((a, b) => a - b);
  if (!values.length) return undefined;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] * 2 : values[middle - 1] + values[middle];
}

function orderedRanks(state: CutDiagramStateContract, graph: ReturnType<typeof graphRanks>, work: MutableWork) {
  const groups = new Map<number, string[]>();
  for (const id of state.nodes) {
    const rank = graph.rank.get(id)!; const group = groups.get(rank) ?? []; group.push(id); groups.set(rank, group);
  }
  const ranks = [...groups.keys()].sort((a, b) => a - b);
  for (let sweep = 0; sweep < cutDiagramLimits.orderingSweeps; sweep += 1) {
    work.orderingSweeps += 1;
    const forward = sweep % 2 === 0, iteration = forward ? ranks : [...ranks].reverse();
    const positions = new Map<string, number>();
    for (const ids of groups.values()) ids.forEach((id, index) => positions.set(id, index));
    for (const rank of iteration) {
      const ids = groups.get(rank)!;
      const before = new Map(ids.map((id, index) => [id, index]));
      ids.sort((left, right) => {
        const leftMedian = medianKey(forward ? graph.incoming.get(left)! : graph.outgoing.get(left)!, positions);
        const rightMedian = medianKey(forward ? graph.incoming.get(right)! : graph.outgoing.get(right)!, positions);
        if (leftMedian === undefined || rightMedian === undefined || leftMedian === rightMedian) return before.get(left)! - before.get(right)!;
        return leftMedian - rightMedian;
      });
      ids.forEach((id, index) => positions.set(id, index));
    }
  }
  return { ranks, groups };
}

function nodeRasterContext(layout: CutDiagramLayoutContract, node: CutDiagramNodeContract): ReferenceDiagramNodeRasterContext {
  const width = Number(node.width.numerator), height = Number(node.height.numerator);
  const widthQ16 = width * referenceDiagramLayoutQ16Scale, heightQ16 = height * referenceDiagramLayoutQ16Scale;
  const childIds = frozen([...node.node.children]);
  const identity = hash({
    algorithm: referenceDiagramLayoutAlgorithmVersion,
    contextKind: "diagram-node",
    width,
    height,
    layoutNodeId: layout.node.id,
    diagramNodeIrId: node.node.id,
    diagramNodeId: node.id,
    configChildIds: childIds,
    nodeContentHash: node.node.contentHash,
  });
  return frozen({
    contextKind: "diagram-node",
    width,
    height,
    origin: "center",
    originQ16: point(Math.floor(widthQ16 / 2), Math.floor(heightQ16 / 2)),
    localBoundsQ16: rect(-Math.floor(widthQ16 / 2), -Math.floor(heightQ16 / 2), widthQ16, heightQ16),
    layoutNodeId: layout.node.id,
    diagramNodeIrId: node.node.id,
    diagramNodeId: node.id,
    configChildIds: childIds,
    semanticIdentity: identity,
  });
}

/** Constructor-safe ownership seam. It derives only bounded local raster
 * contexts and never pretends that a signal-driven transition was preflighted. */
export function referenceDiagramNodeRasterContexts(
  layout: CutDiagramLayoutContract,
): readonly ReferenceDiagramNodeRasterContext[] {
  return frozen(layout.nodes.map((node) => nodeRasterContext(layout, node)));
}

function packNodes(
  layout: CutDiagramLayoutContract,
  state: CutDiagramStateContract,
  direction: "horizontal" | "vertical",
  frame: ReferenceDiagramFrameBounds,
  graph: ReturnType<typeof graphRanks>,
  ordering: ReturnType<typeof orderedRanks>,
  nodes: ReadonlyMap<string, CutDiagramNodeContract>,
): ReferenceDiagramEndpointNode[] {
  if (ordering.ranks.length === 0) return [];
  const nodeGap = rationalToQ16(layout.nodeGap, "$.layout.nodeGap"), rankGap = rationalToQ16(layout.rankGap, "$.layout.rankGap");
  const mainExtents = new Map<number, number>(), crossExtents = new Map<number, number>();
  for (const rank of ordering.ranks) {
    const members = ordering.groups.get(rank)!;
    const dimensions = members.map((id) => {
      const node = nodes.get(id)!;
      return direction === "horizontal"
        ? { main: Number(node.width.numerator) * referenceDiagramLayoutQ16Scale, cross: Number(node.height.numerator) * referenceDiagramLayoutQ16Scale }
        : { main: Number(node.height.numerator) * referenceDiagramLayoutQ16Scale, cross: Number(node.width.numerator) * referenceDiagramLayoutQ16Scale };
    });
    mainExtents.set(rank, Math.max(...dimensions.map((item) => item.main)));
    crossExtents.set(rank, dimensions.reduce((sum, item) => sum + item.cross, 0) + Math.max(0, dimensions.length - 1) * nodeGap);
  }
  let requiredMain = [...mainExtents.values()].reduce((sum, value) => sum + value, 0);
  for (let index = 1; index < ordering.ranks.length; index += 1) requiredMain += rankGap * (ordering.ranks[index] - ordering.ranks[index - 1]);
  const requiredCross = Math.max(...crossExtents.values());
  const availableMain = direction === "horizontal" ? frame.contentQ16.widthQ16 : frame.contentQ16.heightQ16;
  const availableCross = direction === "horizontal" ? frame.contentQ16.heightQ16 : frame.contentQ16.widthQ16;
  if (requiredMain > availableMain || requiredCross > availableCross) {
    fail("CUT_DIAGRAM_LAYOUT_UNSAT", `$.states.${state.id}`, `packed extent ${requiredMain}/${requiredCross} Q16 exceeds safe frame ${availableMain}/${availableCross} Q16`, layout.id);
  }
  const contentMainStart = direction === "horizontal" ? frame.contentQ16.leftQ16 : frame.contentQ16.topQ16;
  const contentCrossStart = direction === "horizontal" ? frame.contentQ16.topQ16 : frame.contentQ16.leftQ16;
  let mainCursor = contentMainStart + Math.floor((availableMain - requiredMain) / 2);
  const result: ReferenceDiagramEndpointNode[] = [];
  ordering.ranks.forEach((rank, rankIndex) => {
    const mainExtent = mainExtents.get(rank)!;
    const members = ordering.groups.get(rank)!;
    let crossCursor = contentCrossStart + Math.floor((availableCross - crossExtents.get(rank)!) / 2);
    members.forEach((id, order) => {
      const config = nodes.get(id)!;
      const width = Number(config.width.numerator), height = Number(config.height.numerator);
      const widthQ16 = width * referenceDiagramLayoutQ16Scale, heightQ16 = height * referenceDiagramLayoutQ16Scale;
      const nodeCross = direction === "horizontal" ? heightQ16 : widthQ16;
      const centerMain = mainCursor + Math.floor(mainExtent / 2), centerCross = crossCursor + Math.floor(nodeCross / 2);
      const center = direction === "horizontal" ? point(centerMain, centerCross) : point(centerCross, centerMain);
      const localRasterContext = nodeRasterContext(layout, config);
      result.push(frozen({
        id,
        irNodeId: config.node.id,
        childIds: localRasterContext.configChildIds,
        rank,
        order,
        width,
        height,
        centerQ16: center,
        rectQ16: rectAt(center, widthQ16, heightQ16),
        localRasterContext,
        paintIdentity: hash({ nodeContentHash: config.node.contentHash, localRasterIdentity: localRasterContext.semanticIdentity }),
      }));
      crossCursor += nodeCross + nodeGap;
    });
    mainCursor += mainExtent;
    if (rankIndex + 1 < ordering.ranks.length) mainCursor += rankGap * (ordering.ranks[rankIndex + 1] - rank);
  });
  const resultOrder = new Map(state.nodes.map((id, index) => [id, index]));
  result.sort((a, b) => resultOrder.get(a.id)! - resultOrder.get(b.id)!);
  return result;
}

function edgePaint(edge: CutDiagramEdgeContract): ReferenceDiagramEdgePaint {
  let arrow: ReferenceDiagramEdgePaint["arrow"];
  if (edge.arrow?.kind === "object") {
    const length = edge.arrow.entries.length, width = edge.arrow.entries.width, color = edge.arrow.entries.color;
    if (length?.kind === "quantity" && width?.kind === "quantity" && color?.kind === "color") arrow = frozen({
      lengthQ16: rationalToQ16(length.magnitude, `$.edges.${edge.id}.arrow.length`),
      widthQ16: rationalToQ16(width.magnitude, `$.edges.${edge.id}.arrow.width`),
      color: color.value,
    });
  }
  return frozen({ stroke: edge.stroke, widthQ16: rationalToQ16(edge.width, `$.edges.${edge.id}.width`), ...(arrow ? { arrow } : {}) });
}

function portPoint(node: ReferenceDiagramEndpointNode, port: "top" | "right" | "bottom" | "left"): ReferenceDiagramPointQ16 {
  switch (port) {
    case "top": return point(node.centerQ16.xQ16, node.rectQ16.topQ16);
    case "right": return point(node.rectQ16.rightQ16, node.centerQ16.yQ16);
    case "bottom": return point(node.centerQ16.xQ16, node.rectQ16.bottomQ16);
    case "left": return point(node.rectQ16.leftQ16, node.centerQ16.yQ16);
  }
}

function leadPoint(boundary: ReferenceDiagramPointQ16, port: "top" | "right" | "bottom" | "left", distance: number): ReferenceDiagramPointQ16 {
  switch (port) {
    case "top": return point(boundary.xQ16, boundary.yQ16 - distance);
    case "right": return point(boundary.xQ16 + distance, boundary.yQ16);
    case "bottom": return point(boundary.xQ16, boundary.yQ16 + distance);
    case "left": return point(boundary.xQ16 - distance, boundary.yQ16);
  }
}

function segments(points: readonly ReferenceDiagramPointQ16[]): Segment[] {
  return points.slice(0, -1).map((a, index) => frozen({ a, b: points[index + 1], index })).filter((segment) => segment.a.xQ16 !== segment.b.xQ16 || segment.a.yQ16 !== segment.b.yQ16);
}

function withinFrame(candidate: readonly ReferenceDiagramPointQ16[], frame: ReferenceDiagramRectQ16): boolean {
  return candidate.every((item) => item.xQ16 >= frame.leftQ16 && item.xQ16 <= frame.rightQ16 && item.yQ16 >= frame.topQ16 && item.yQ16 <= frame.bottomQ16);
}

function segmentIntersectsRect(segment: Segment, box: ReferenceDiagramRectQ16): boolean {
  if (segment.a.yQ16 === segment.b.yQ16) {
    const left = Math.min(segment.a.xQ16, segment.b.xQ16), right = Math.max(segment.a.xQ16, segment.b.xQ16);
    return segment.a.yQ16 >= box.topQ16 && segment.a.yQ16 <= box.bottomQ16 && right >= box.leftQ16 && left <= box.rightQ16;
  }
  if (segment.a.xQ16 === segment.b.xQ16) {
    const top = Math.min(segment.a.yQ16, segment.b.yQ16), bottom = Math.max(segment.a.yQ16, segment.b.yQ16);
    return segment.a.xQ16 >= box.leftQ16 && segment.a.xQ16 <= box.rightQ16 && bottom >= box.topQ16 && top <= box.bottomQ16;
  }
  return true;
}

function inflated(box: ReferenceDiagramRectQ16, amount: number): ReferenceDiagramRectQ16 {
  return rect(box.leftQ16 - amount, box.topQ16 - amount, box.widthQ16 + amount * 2, box.heightQ16 + amount * 2);
}

function positiveCollinearOverlap(left: Segment, right: Segment): boolean {
  if (left.a.yQ16 === left.b.yQ16 && right.a.yQ16 === right.b.yQ16 && left.a.yQ16 === right.a.yQ16) {
    return Math.min(Math.max(left.a.xQ16, left.b.xQ16), Math.max(right.a.xQ16, right.b.xQ16))
      > Math.max(Math.min(left.a.xQ16, left.b.xQ16), Math.min(right.a.xQ16, right.b.xQ16));
  }
  if (left.a.xQ16 === left.b.xQ16 && right.a.xQ16 === right.b.xQ16 && left.a.xQ16 === right.a.xQ16) {
    return Math.min(Math.max(left.a.yQ16, left.b.yQ16), Math.max(right.a.yQ16, right.b.yQ16))
      > Math.max(Math.min(left.a.yQ16, left.b.yQ16), Math.min(right.a.yQ16, right.b.yQ16));
  }
  return false;
}

function properCrossing(left: Segment, right: Segment): boolean {
  const horizontal = left.a.yQ16 === left.b.yQ16 ? left : right.a.yQ16 === right.b.yQ16 ? right : undefined;
  const vertical = left.a.xQ16 === left.b.xQ16 ? left : right.a.xQ16 === right.b.xQ16 ? right : undefined;
  if (!horizontal || !vertical || horizontal === vertical) return false;
  const x = vertical.a.xQ16, y = horizontal.a.yQ16;
  return x > Math.min(horizontal.a.xQ16, horizontal.b.xQ16) && x < Math.max(horizontal.a.xQ16, horizontal.b.xQ16)
    && y > Math.min(vertical.a.yQ16, vertical.b.yQ16) && y < Math.max(vertical.a.yQ16, vertical.b.yQ16);
}

function routeCandidates(
  edge: CutDiagramEdgeContract,
  from: ReferenceDiagramEndpointNode,
  to: ReferenceDiagramEndpointNode,
  direction: "horizontal" | "vertical",
  base: number,
  edgeGap: number,
  frame: ReferenceDiagramRectQ16,
): readonly (readonly [ReferenceDiagramPointQ16, ReferenceDiagramPointQ16, ReferenceDiagramPointQ16, ReferenceDiagramPointQ16, ReferenceDiagramPointQ16])[] {
  const fromPort = edge.fromPort === "auto" ? (direction === "horizontal" ? "right" : "bottom") : edge.fromPort;
  const toPort = edge.toPort === "auto" ? (direction === "horizontal" ? "left" : "top") : edge.toPort;
  const start = portPoint(from, fromPort), end = portPoint(to, toPort);
  const canonical = (direction === "horizontal" && fromPort === "right" && toPort === "left")
    || (direction === "vertical" && fromPort === "bottom" && toPort === "top");
  const result: (readonly [ReferenceDiagramPointQ16, ReferenceDiagramPointQ16, ReferenceDiagramPointQ16, ReferenceDiagramPointQ16, ReferenceDiagramPointQ16])[] = [];
  if (canonical) {
    const sourceLead = leadPoint(start, fromPort, base), destinationLead = leadPoint(end, toPort, base);
    const minimum = direction === "horizontal" ? sourceLead.xQ16 : sourceLead.yQ16;
    const maximum = direction === "horizontal" ? destinationLead.xQ16 : destinationLead.yQ16;
    const center = Math.floor((minimum + maximum) / 2);
    const factors = [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6];
    const lanes: number[] = [];
    for (const factor of factors) {
      const lane = center + factor * edgeGap;
      if (lane < minimum || lane > maximum) continue;
      if (!lanes.includes(lane)) lanes.push(lane);
    }
    const perimeter = direction === "horizontal"
      ? [frame.leftQ16 + base, frame.rightQ16 - base, frame.leftQ16 + base + edgeGap, frame.rightQ16 - base - edgeGap]
      : [frame.topQ16 + base, frame.bottomQ16 - base, frame.topQ16 + base + edgeGap, frame.bottomQ16 - base - edgeGap];
    for (const lane of perimeter) if (!lanes.includes(lane)) lanes.push(lane);
    for (const lane of lanes.slice(0, cutDiagramLimits.routeCandidatesPerEdge)) {
      const laneStart = direction === "horizontal" ? point(lane, sourceLead.yQ16) : point(sourceLead.xQ16, lane);
      const laneEnd = direction === "horizontal" ? point(lane, destinationLead.yQ16) : point(destinationLead.xQ16, lane);
      result.push(frozen([start, sourceLead, laneStart, laneEnd, end] as const));
    }
  } else {
    for (let level = 0; level < 8; level += 1) {
      const distance = base + level * edgeGap;
      const sourceLead = leadPoint(start, fromPort, distance), destinationLead = leadPoint(end, toPort, distance);
      result.push(frozen([start, sourceLead, point(destinationLead.xQ16, sourceLead.yQ16), destinationLead, end] as const));
      result.push(frozen([start, sourceLead, point(sourceLead.xQ16, destinationLead.yQ16), destinationLead, end] as const));
    }
  }
  return result.slice(0, cutDiagramLimits.routeCandidatesPerEdge);
}

function routeEdges(
  layout: CutDiagramLayoutContract,
  state: CutDiagramStateContract,
  direction: "horizontal" | "vertical",
  frame: ReferenceDiagramFrameBounds,
  nodes: readonly ReferenceDiagramEndpointNode[],
  work: MutableWork,
  budget: ValidationBudget,
): ReferenceDiagramEndpointEdge[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const admitted: { edge: CutDiagramEdgeContract; route: ReferenceDiagramEndpointEdge }[] = [];
  const edgeGap = rationalToQ16(layout.edgeGap, "$.layout.edgeGap"), clearance = rationalToQ16(layout.edgeClearance, "$.layout.edgeClearance");
  let routeNodeTests = 0;
  for (const edge of state.edges) {
    const from = byId.get(edge.from), to = byId.get(edge.to);
    if (!from || !to) fail("CUT_DIAGRAM_GRAPH", `$.states.${state.id}.edges.${edge.id}`, "references missing laid-out endpoint", layout.id);
    const paint = edgePaint(edge), base = clearance + Math.floor(paint.widthQ16 / 2) + edgeGap;
    const candidates = routeCandidates(edge, from, to, direction, base, edgeGap, frame.contentQ16);
    let accepted: ReferenceDiagramEndpointEdge | undefined;
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
      if (candidateIndex >= cutDiagramLimits.routeCandidatesPerEdge) fail("CUT_DIAGRAM_LIMIT", `$.states.${state.id}.edges.${edge.id}`, "exceeds route candidate limit", layout.id);
      work.routeCandidates += 1;
      const candidate = candidates[candidateIndex], candidateSegments = segments(candidate);
      if (!withinFrame(candidate, frame.contentQ16)) continue;
      let invalid = false;
      for (const segment of candidateSegments) for (const node of nodes) {
        if (node.id === edge.from && segment.index === 0) continue;
        if (node.id === edge.to && segment.index === 3) continue;
        routeNodeTests += 1;
        if (routeNodeTests > cutDiagramLimits.routeNodeTestsPerSample) {
          fail("CUT_DIAGRAM_LIMIT", `$.states.${state.id}.edges`, `exceeds ${cutDiagramLimits.routeNodeTestsPerSample} endpoint route/node tests`, layout.id);
        }
        validation(work, budget, "route");
        if (segmentIntersectsRect(segment, inflated(node.rectQ16, clearance + Math.floor(paint.widthQ16 / 2)))) invalid = true;
      }
      if (invalid) continue;
      let crossings = 0;
      for (const prior of admitted) for (const left of candidateSegments) for (const right of segments(prior.route.pointsQ16)) {
        validation(work, budget);
        if (positiveCollinearOverlap(left, right)) {
          const sharedSourceTerminal = edge.from === prior.edge.from && left.index === 0 && right.index === 0;
          const sharedDestinationTerminal = edge.to === prior.edge.to && left.index === 3 && right.index === 3;
          if (!sharedSourceTerminal && !sharedDestinationTerminal) invalid = true;
        } else if (properCrossing(left, right)) crossings += 1;
      }
      if (invalid) continue;
      const fromPort = edge.fromPort === "auto" ? (direction === "horizontal" ? "right" : "bottom") : edge.fromPort;
      const toPort = edge.toPort === "auto" ? (direction === "horizontal" ? "left" : "top") : edge.toPort;
      accepted = frozen({
        id: edge.id, from: edge.from, to: edge.to, fromPort, toPort,
        pointsQ16: candidate,
        crossings,
        paint,
        semanticIdentity: edge.semanticIdentity,
      });
      break;
    }
    if (!accepted) fail("CUT_DIAGRAM_ROUTE_UNSAT", `$.states.${state.id}.edges.${edge.id}`, `no bounded five-point route satisfies frame, clearance, and overlap constraints`, layout.id);
    admitted.push({ edge, route: accepted });
  }
  return admitted.map((item) => item.route);
}

function endpointPlan(
  layout: CutDiagramLayoutContract,
  state: CutDiagramStateContract,
  direction: "horizontal" | "vertical",
  frame: ReferenceDiagramFrameBounds,
  budget: ValidationBudget,
): ReferenceDiagramEndpointPlan {
  if (state.nodes.length > cutDiagramLimits.nodesPerLayout || state.edges.length > cutDiagramLimits.edgesPerState) {
    fail("CUT_DIAGRAM_LIMIT", `$.states.${state.id}`, "exceeds diagram state node or edge limits", layout.id);
  }
  const configs = new Map(layout.nodes.map((node) => [node.id, node]));
  for (const id of state.nodes) if (!configs.has(id)) fail("CUT_DIAGRAM_IDENTITY", `$.states.${state.id}.nodes`, `references missing DiagramNode ${JSON.stringify(id)}`, layout.id);
  const work = emptyWork(), graph = graphRanks(state, configs, layout.id), ordering = orderedRanks(state, graph, work);
  const nodes = packNodes(layout, state, direction, frame, graph, ordering, configs);
  const edges = routeEdges(layout, state, direction, frame, nodes, work, budget);
  const ranks = frozen(ordering.ranks.map((rank) => frozen({ rank, nodeIds: frozen([...ordering.groups.get(rank)!]) })));
  const topologyIdentity = hash({ algorithm: referenceDiagramLayoutAlgorithmVersion, state: state.id, ranks, nodes: nodes.map((node) => ({ id: node.id, rank: node.rank, order: node.order })), edges: edges.map((edge) => ({ id: edge.id, from: edge.from, to: edge.to })) });
  const geometryIdentity = hash({ algorithm: referenceDiagramLayoutAlgorithmVersion, direction, frame, nodes: nodes.map((node) => ({ id: node.id, rectQ16: node.rectQ16 })), edges: edges.map((edge) => ({ id: edge.id, pointsQ16: edge.pointsQ16, widthQ16: edge.paint.widthQ16 })) });
  const paintIdentity = hash({ nodes: nodes.map((node) => ({ id: node.id, paintIdentity: node.paintIdentity })), edges: edges.map((edge) => ({ id: edge.id, paint: edge.paint })) });
  const receipt = workReceipt(work);
  const receiptIdentity = hash({ algorithm: referenceDiagramLayoutAlgorithmVersion, state: state.id, direction, frame, ranks, nodes, edges, work: receipt, topologyIdentity, geometryIdentity, paintIdentity });
  return frozen({
    format: "cut-reference-diagram-endpoint-plan",
    version: 1,
    algorithm: referenceDiagramLayoutAlgorithmVersion,
    stateId: state.id,
    direction,
    frame,
    ranks,
    nodes: frozen(nodes),
    edges: frozen(edges),
    work: receipt,
    topologyIdentity,
    geometryIdentity,
    paintIdentity,
    receiptIdentity,
  });
}

function interpolate(from: number, to: number, progressQ16: number): number {
  return from + multiplyDivideRoundHalfEven(to - from, progressQ16, referenceDiagramLayoutQ16Scale);
}

function interpolatePoint(from: ReferenceDiagramPointQ16, to: ReferenceDiagramPointQ16, progressQ16: number): ReferenceDiagramPointQ16 {
  return point(interpolate(from.xQ16, to.xQ16, progressQ16), interpolate(from.yQ16, to.yQ16, progressQ16));
}

function trimPoints(pointsQ16: readonly ReferenceDiagramPointQ16[], trimEndQ16: number) {
  const parts = segments(pointsQ16), total = parts.reduce((sum, item) => sum + Math.abs(item.b.xQ16 - item.a.xQ16) + Math.abs(item.b.yQ16 - item.a.yQ16), 0);
  if (!pointsQ16.length) return { visible: [] as ReferenceDiagramPointQ16[], tangent: point(0, 0) };
  if (trimEndQ16 <= 0 || total === 0) return { visible: [pointsQ16[0]], tangent: point(0, 0) };
  let remaining = multiplyDivideRoundHalfEven(total, trimEndQ16, referenceDiagramLayoutQ16Scale);
  const visible: ReferenceDiagramPointQ16[] = [pointsQ16[0]];
  for (const part of parts) {
    const length = Math.abs(part.b.xQ16 - part.a.xQ16) + Math.abs(part.b.yQ16 - part.a.yQ16);
    if (remaining >= length) { visible.push(part.b); remaining -= length; continue; }
    if (remaining > 0) {
      const x = part.a.xQ16 === part.b.xQ16 ? part.a.xQ16 : part.a.xQ16 + Math.sign(part.b.xQ16 - part.a.xQ16) * remaining;
      const y = part.a.yQ16 === part.b.yQ16 ? part.a.yQ16 : part.a.yQ16 + Math.sign(part.b.yQ16 - part.a.yQ16) * remaining;
      visible.push(point(x, y));
    }
    break;
  }
  let tangent = point(0, 0);
  for (let index = visible.length - 1; index > 0; index -= 1) {
    const dx = visible[index].xQ16 - visible[index - 1].xQ16, dy = visible[index].yQ16 - visible[index - 1].yQ16;
    if (dx !== 0 || dy !== 0) { tangent = point(Math.sign(dx) * referenceDiagramLayoutQ16Scale, Math.sign(dy) * referenceDiagramLayoutQ16Scale); break; }
  }
  return { visible: frozen(visible), tangent };
}

function frameNodes(plan: ReferenceDiagramLayoutPlan, progressQ16: number): ReferenceDiagramFrameNode[] {
  const from = plan.fromEndpoint, toById = new Map(plan.toEndpoint.nodes.map((node) => [node.id, node]));
  if (!from) return plan.toEndpoint.nodes.map((node) => frozen({
    id: node.id, irNodeId: node.irNodeId, childIds: node.childIds, phase: "persistent" as const,
    width: node.width, height: node.height, toCenterQ16: node.centerQ16, displayCenterQ16: node.centerQ16,
    displayRectQ16: node.rectQ16, opacityQ16: referenceDiagramLayoutQ16Scale,
    localRasterContext: node.localRasterContext, paintIdentity: node.paintIdentity,
  }));
  const result: ReferenceDiagramFrameNode[] = [];
  const fromIds = new Set(from.nodes.map((node) => node.id));
  for (const oldNode of from.nodes) {
    const target = toById.get(oldNode.id), phase: ReferenceDiagramNodePhase = target ? "persistent" : "exiting";
    const displayCenter = target ? interpolatePoint(oldNode.centerQ16, target.centerQ16, progressQ16) : oldNode.centerQ16;
    result.push(frozen({
      id: oldNode.id, irNodeId: oldNode.irNodeId, childIds: oldNode.childIds, phase,
      width: oldNode.width, height: oldNode.height,
      fromCenterQ16: oldNode.centerQ16, ...(target ? { toCenterQ16: target.centerQ16 } : {}),
      displayCenterQ16: displayCenter,
      displayRectQ16: rectAt(displayCenter, oldNode.rectQ16.widthQ16, oldNode.rectQ16.heightQ16),
      opacityQ16: target ? referenceDiagramLayoutQ16Scale : referenceDiagramLayoutQ16Scale - progressQ16,
      localRasterContext: oldNode.localRasterContext,
      paintIdentity: oldNode.paintIdentity,
    }));
  }
  for (const target of plan.toEndpoint.nodes) if (!fromIds.has(target.id)) result.push(frozen({
    id: target.id, irNodeId: target.irNodeId, childIds: target.childIds, phase: "entering" as const,
    width: target.width, height: target.height, toCenterQ16: target.centerQ16,
    displayCenterQ16: target.centerQ16, displayRectQ16: target.rectQ16, opacityQ16: progressQ16,
    localRasterContext: target.localRasterContext, paintIdentity: target.paintIdentity,
  }));
  return result;
}

function frameEdges(plan: ReferenceDiagramLayoutPlan, progressQ16: number): ReferenceDiagramFrameEdge[] {
  const from = plan.fromEndpoint, toById = new Map(plan.toEndpoint.edges.map((edge) => [edge.id, edge]));
  const create = (edge: ReferenceDiagramEndpointEdge, phase: ReferenceDiagramNodePhase, pointsQ16: ReferenceDiagramEndpointEdge["pointsQ16"], trimEndQ16: number) => {
    const trimmed = trimPoints(pointsQ16, trimEndQ16);
    return frozen({
      id: edge.id, from: edge.from, to: edge.to, phase, pointsQ16,
      fromPort: edge.fromPort, toPort: edge.toPort,
      visiblePointsQ16: trimmed.visible, trimEndQ16, terminalTangentQ16: trimmed.tangent,
      crossings: edge.crossings, paint: edge.paint, semanticIdentity: edge.semanticIdentity,
    });
  };
  if (!from) return plan.toEndpoint.edges.map((edge) => create(edge, "persistent", edge.pointsQ16, referenceDiagramLayoutQ16Scale));
  const result: ReferenceDiagramFrameEdge[] = [], fromIds = new Set(from.edges.map((edge) => edge.id));
  for (const oldEdge of from.edges) {
    const target = toById.get(oldEdge.id);
    if (target) {
      const points = frozen(oldEdge.pointsQ16.map((item, index) => interpolatePoint(item, target.pointsQ16[index], progressQ16)) as unknown as ReferenceDiagramEndpointEdge["pointsQ16"]);
      result.push(create(oldEdge, "persistent", points, referenceDiagramLayoutQ16Scale));
    } else result.push(create(oldEdge, "exiting", oldEdge.pointsQ16, referenceDiagramLayoutQ16Scale - progressQ16));
  }
  for (const target of plan.toEndpoint.edges) if (!fromIds.has(target.id)) result.push(create(target, "entering", target.pointsQ16, progressQ16));
  return result;
}

function strictRectOverlap(left: ReferenceDiagramRectQ16, right: ReferenceDiagramRectQ16): boolean {
  return Math.min(left.rightQ16, right.rightQ16) > Math.max(left.leftQ16, right.leftQ16)
    && Math.min(left.bottomQ16, right.bottomQ16) > Math.max(left.topQ16, right.topQ16);
}

function pointIsLegitimateTerminal(
  node: ReferenceDiagramFrameNode,
  terminal: ReferenceDiagramPointQ16,
  port: "top" | "right" | "bottom" | "left",
): boolean {
  const box = node.displayRectQ16;
  if (port === "top" || port === "bottom") {
    return terminal.yQ16 === (port === "top" ? box.topQ16 : box.bottomQ16)
      && terminal.xQ16 >= box.leftQ16 && terminal.xQ16 <= box.rightQ16;
  }
  return terminal.xQ16 === (port === "left" ? box.leftQ16 : box.rightQ16)
    && terminal.yQ16 >= box.topQ16 && terminal.yQ16 <= box.bottomQ16;
}

function validateTransitionFrame(
  nodes: readonly ReferenceDiagramFrameNode[],
  edges: readonly ReferenceDiagramFrameEdge[],
  work: MutableWork,
  budget: ValidationBudget,
  layoutId: string,
  at: Rational,
  edgeClearanceQ16: number,
): void {
  let nodeTests = 0, routeTests = 0;
  const visibleNodes = nodes.filter((node) => node.opacityQ16 > 0);
  for (let left = 0; left < visibleNodes.length; left += 1) for (let right = left + 1; right < visibleNodes.length; right += 1) {
    nodeTests += 1;
    if (nodeTests > cutDiagramLimits.nodePairTestsPerSample) fail("CUT_DIAGRAM_LIMIT", "$.transition.nodes", "exceeds per-sample node-pair tests", layoutId);
    validation(work, budget, "node");
    if (strictRectOverlap(visibleNodes[left].displayRectQ16, visibleNodes[right].displayRectQ16)) {
      fail("CUT_DIAGRAM_TRANSITION_COLLISION", "$.transition.nodes", `nodes ${JSON.stringify(visibleNodes[left].id)} and ${JSON.stringify(visibleNodes[right].id)} overlap at ${at.numerator}/${at.denominator}`, layoutId);
    }
  }
  for (const edge of edges) {
    if (edge.trimEndQ16 <= 0) continue;
    const visibleSegments = segments(edge.visiblePointsQ16);
    const fullEnd = edge.pointsQ16[edge.pointsQ16.length - 1];
    const finalLogicalSegmentIndex = segments(edge.pointsQ16).length - 1;
    const legitimateDestination = visibleNodes.find((node) => node.id === edge.to);
    const hasLegitimateDestination = legitimateDestination !== undefined
      && pointIsLegitimateTerminal(legitimateDestination, fullEnd, edge.toPort);
    for (const segment of visibleSegments) for (const node of visibleNodes) {
      if (node.id === edge.from && segment.index === 0 && pointIsLegitimateTerminal(node, segment.a, edge.fromPort)) continue;
      // A partially trimmed path may already occupy its final logical segment
      // before its visible head reaches the endpoint. Exempt that segment only
      // when the full route terminates on the current destination boundary.
      if (node.id === edge.to && segment.index === finalLogicalSegmentIndex && hasLegitimateDestination) continue;
      routeTests += 1;
      if (routeTests > cutDiagramLimits.routeNodeTestsPerSample) fail("CUT_DIAGRAM_LIMIT", "$.transition.routes", "exceeds per-sample route/node tests", layoutId);
      validation(work, budget, "route");
      const clearance = edgeClearanceQ16 + Math.floor(edge.paint.widthQ16 / 2);
      if (segmentIntersectsRect(segment, inflated(node.displayRectQ16, clearance))) {
        fail("CUT_DIAGRAM_TRANSITION_COLLISION", "$.transition.routes", `edge ${JSON.stringify(edge.id)} intersects node ${JSON.stringify(node.id)} at ${at.numerator}/${at.denominator}`, layoutId);
      }
    }
  }
}

function normalizeSample(sample: ReferenceDiagramTransitionSample, path: string): ReferenceDiagramTransitionSample {
  const at = canonicalRational(sample.at, `${path}.at`), progress = canonicalRational(sample.progress, `${path}.progress`);
  if (compareRational(progress, rational(0)) < 0 || compareRational(progress, rational(1)) > 0) fail("CUT_DIAGRAM_BOUNDS", `${path}.progress`, "must be in the closed 0..1 range");
  return frozen({ at, progress });
}

function frameFor(plan: ReferenceDiagramLayoutPlan, sample: ReferenceDiagramTransitionSample, work?: MutableWork, budget?: ValidationBudget): ReferenceDiagramFramePlan {
  const normalized = normalizeSample(sample, "$.sample"), progressQ16 = rationalToQ16(normalized.progress, "$.sample.progress");
  const nodes = frozen(frameNodes(plan, progressQ16)), edges = frozen(frameEdges(plan, progressQ16));
  if (work && budget) validateTransitionFrame(nodes, edges, work, budget, plan.layoutId, normalized.at, plan.edgeClearanceQ16);
  const topologyIdentity = hash({ plan: plan.topologyIdentity, states: [plan.fromEndpoint?.stateId, plan.toEndpoint.stateId], phases: { nodes: nodes.map((node) => [node.id, node.phase]), edges: edges.map((edge) => [edge.id, edge.phase]) } });
  const geometryIdentity = hash({ plan: plan.geometryIdentity, nodes: nodes.map((node) => ({ id: node.id, center: node.displayCenterQ16, opacityQ16: node.opacityQ16 })), edges: edges.map((edge) => ({ id: edge.id, points: edge.pointsQ16, trimEndQ16: edge.trimEndQ16 })) });
  const paintIdentity = plan.paintIdentity;
  const receiptIdentity = hash({ algorithm: referenceDiagramLayoutAlgorithmVersion, layoutId: plan.layoutId, at: normalized.at, progress: normalized.progress, progressQ16, topologyIdentity, geometryIdentity, paintIdentity });
  return frozen({
    format: "cut-reference-diagram-frame-plan", version: 1, algorithm: referenceDiagramLayoutAlgorithmVersion,
    layoutId: plan.layoutId, at: normalized.at, progress: normalized.progress, progressQ16,
    direction: plan.direction, frame: plan.frame, nodes, edges,
    topologyIdentity, geometryIdentity, paintIdentity, receiptIdentity,
  });
}

export function referenceDiagramLayoutFrameAt(plan: ReferenceDiagramLayoutPlan, sample: ReferenceDiagramTransitionSample): ReferenceDiagramFramePlan {
  const work = emptyWork(), budget = { prior: 0, used: 0, layoutId: plan.layoutId };
  return frameFor(plan, sample, work, budget);
}

export function planReferenceDiagramLayout(layout: CutDiagramLayoutContract, context: ReferenceDiagramLayoutContext): ReferenceDiagramLayoutPlan {
  const priorValidationTests = context.priorValidationTests ?? 0;
  if (!Number.isSafeInteger(priorValidationTests) || priorValidationTests < 0 || priorValidationTests > cutDiagramLimits.validationTestsPerComposition) {
    fail("CUT_DIAGRAM_LIMIT", "$.context.priorValidationTests", `must be a safe integer from 0 through ${cutDiagramLimits.validationTestsPerComposition}`, layout.id);
  }
  const budget: ValidationBudget = { prior: priorValidationTests, used: priorValidationTests, layoutId: layout.id };
  const frame = deriveFrame(layout, context);
  const direction = layout.direction === "auto"
    ? (frame.contentQ16.widthQ16 >= frame.contentQ16.heightQ16 ? "horizontal" : "vertical")
    : layout.direction;
  const edgeClearanceQ16 = rationalToQ16(layout.edgeClearance, "$.layout.edgeClearance");
  const fromEndpoint = layout.fromState ? endpointPlan(layout, layout.fromState, direction, frame, budget) : undefined;
  const toEndpoint = endpointPlan(layout, layout.state, direction, frame, budget);
  const topologyIdentity = hash({ algorithm: referenceDiagramLayoutAlgorithmVersion, layoutId: layout.id, direction, from: fromEndpoint?.topologyIdentity, to: toEndpoint.topologyIdentity });
  const geometryIdentity = hash({ algorithm: referenceDiagramLayoutAlgorithmVersion, layoutId: layout.id, direction, frame, from: fromEndpoint?.geometryIdentity, to: toEndpoint.geometryIdentity });
  const paintIdentity = hash({ algorithm: referenceDiagramLayoutAlgorithmVersion, layoutId: layout.id, from: fromEndpoint?.paintIdentity, to: toEndpoint.paintIdentity });
  const temporary = {
    format: "cut-reference-diagram-layout-plan" as const, version: 1 as const, algorithm: referenceDiagramLayoutAlgorithmVersion,
    layoutId: layout.id, direction, frame, edgeClearanceQ16, ...(fromEndpoint ? { fromEndpoint } : {}), toEndpoint,
    frames: [] as readonly ReferenceDiagramFramePlan[], displayFrame: undefined as unknown as ReferenceDiagramFramePlan,
    descendantContexts: referenceDiagramNodeRasterContexts(layout),
    work: workReceipt(addWork(...[fromEndpoint?.work, toEndpoint.work].filter((item): item is ReferenceDiagramWorkReceipt => item !== undefined))),
    validationBudget: frozen({
      priorValidationTests,
      consumedValidationTests: budget.used - priorValidationTests,
      totalValidationTests: budget.used,
      limit: cutDiagramLimits.validationTestsPerComposition,
    }),
    topologyIdentity, geometryIdentity, paintIdentity, receiptIdentity: "",
  };
  if (fromEndpoint && (!context.transitionSamples || context.transitionSamples.length === 0)) {
    fail("CUT_DIAGRAM_TYPE", "$.context.transitionSamples", "must contain every exact output sample for a state transition", layout.id);
  }
  const rawSamples = context.transitionSamples ?? [frozen({ at: rational(0), progress: rational(1) })];
  if (rawSamples.length > cutDiagramLimits.transitionSamplesPerLayout) fail("CUT_DIAGRAM_LIMIT", "$.context.transitionSamples", `exceeds ${cutDiagramLimits.transitionSamplesPerLayout} exact samples`, layout.id);
  const samples = rawSamples.map((sample, index) => normalizeSample(sample, `$.context.transitionSamples[${index}]`));
  for (let index = 1; index < samples.length; index += 1) if (compareRational(samples[index - 1].at, samples[index].at) >= 0) {
    fail("CUT_DIAGRAM_TYPE", `$.context.transitionSamples[${index}].at`, "sample times must be strictly increasing", layout.id);
  }
  const transitionWork = emptyWork(), shell = temporary as ReferenceDiagramLayoutPlan;
  const frames = samples.map((sample) => {
    transitionWork.transitionSamples += 1;
    return frameFor(shell, sample, transitionWork, budget);
  });
  const requestedProgress = layout.progress ?? rational(1);
  const displayFrame = frameFor(shell, { at: rational(0), progress: requestedProgress });
  const aggregate = addWork(temporary.work, workReceipt(transitionWork));
  const work = workReceipt(aggregate);
  const validationBudget = frozen({
    priorValidationTests,
    consumedValidationTests: budget.used - priorValidationTests,
    totalValidationTests: budget.used,
    limit: cutDiagramLimits.validationTestsPerComposition,
  });
  const receiptIdentity = hash({ algorithm: referenceDiagramLayoutAlgorithmVersion, layoutId: layout.id, direction, frame, from: fromEndpoint?.receiptIdentity, to: toEndpoint.receiptIdentity, samples, frames: frames.map((item) => item.receiptIdentity), work, validationBudget, topologyIdentity, geometryIdentity, paintIdentity });
  return frozen({ ...temporary, frames: frozen(frames), displayFrame, work, validationBudget, receiptIdentity });
}
