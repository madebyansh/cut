import { hash } from "../core/stable";
import type { CutAVIR, IRNode, IRValue } from "./ir";
import { compareRational, rational, type Rational } from "./rational";

export const cutDiagramOps = Object.freeze({
  layout: "cut.diagram.layout",
  node: "cut.diagram.node",
} as const);

export const cutDiagramPorts = Object.freeze(["auto", "top", "right", "bottom", "left"] as const);
export const cutDiagramDirections = Object.freeze(["auto", "horizontal", "vertical"] as const);

export const cutDiagramLimits = Object.freeze({
  layoutsPerComposition: 32,
  nodesPerLayout: 64,
  edgesPerState: 128,
  activeStatesPerLayout: 2,
  orderingSweeps: 4,
  routeCandidatesPerEdge: 16,
  transitionSamplesPerLayout: 4_096,
  nodePairTestsPerSample: 4_096,
  routeNodeTestsPerSample: 131_072,
  validationTestsPerComposition: 50_000_000,
  maximumCoordinatePixels: 65_536,
  aggregateNodePixelsPerLayout: 16_777_216,
  maximumIdentityBytes: 128,
  maximumRationalDigits: 256,
} as const);

export type CutDiagramDiagnosticCode =
  | "CUT_DIAGRAM_TYPE"
  | "CUT_DIAGRAM_IDENTITY"
  | "CUT_DIAGRAM_GRAPH"
  | "CUT_DIAGRAM_BOUNDS"
  | "CUT_DIAGRAM_LAYOUT_UNSAT"
  | "CUT_DIAGRAM_ROUTE_UNSAT"
  | "CUT_DIAGRAM_TRANSITION_COLLISION"
  | "CUT_DIAGRAM_LIMIT"
  | "CUT_DIAGRAM_NOOP";

export class CutDiagramContractError extends Error {
  constructor(
    readonly code: CutDiagramDiagnosticCode,
    readonly path: string,
    message: string,
    readonly nodeId?: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "CutDiagramContractError";
  }
}

type IRString = Extract<IRValue, { kind: "string" }>;
type IRColor = Extract<IRValue, { kind: "color" }>;
type IRQuantity = Extract<IRValue, { kind: "quantity" }>;

export type IRDiagramEdgeValue = {
  kind: "object";
  entries: {
    id: IRString;
    from: IRString;
    to: IRString;
    fromPort?: IRString;
    toPort?: IRString;
    stroke: IRColor;
    width: IRQuantity;
    arrow?: IRValue;
  } & Record<string, IRValue>;
};

export type IRDiagramStateValue = {
  kind: "object";
  entries: {
    id: IRString;
    nodes: Extract<IRValue, { kind: "array" }>;
    edges: Extract<IRValue, { kind: "array" }>;
  } & Record<string, IRValue>;
};

export type CutDiagramEdgeContract = Readonly<{
  id: string;
  from: string;
  to: string;
  fromPort: typeof cutDiagramPorts[number];
  toPort: typeof cutDiagramPorts[number];
  stroke: string;
  width: Rational;
  arrow?: IRValue;
  semanticIdentity: string;
}>;

export type CutDiagramStateContract = Readonly<{
  id: string;
  nodes: readonly string[];
  edges: readonly CutDiagramEdgeContract[];
  semanticIdentity: string;
}>;

function fail(code: CutDiagramDiagnosticCode, path: string, message: string, nodeId?: string): never {
  throw new CutDiagramContractError(code, path, message, nodeId);
}

function closedObject(value: IRValue | undefined, path: string, required: readonly string[], optional: readonly string[] = []) {
  if (value?.kind !== "object") fail("CUT_DIAGRAM_TYPE", path, "must be one closed object");
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(value.entries).find((key) => !allowed.has(key));
  if (unknown) fail("CUT_DIAGRAM_TYPE", `${path}.${unknown}`, "is not an accepted field");
  const missing = required.find((key) => value.entries[key] === undefined);
  if (missing) fail("CUT_DIAGRAM_TYPE", `${path}.${missing}`, "is required");
  return value.entries;
}

function text(value: IRValue | undefined, path: string) {
  if (value?.kind !== "string") fail("CUT_DIAGRAM_TYPE", path, "must be String");
  return value.value;
}

function identity(value: IRValue | undefined, path: string) {
  const result = text(value, path);
  if (!result.length
    || result !== result.trim()
    || Buffer.byteLength(result, "utf8") > cutDiagramLimits.maximumIdentityBytes
    || /[\u0000-\u001f\u007f]/u.test(result)) {
    fail("CUT_DIAGRAM_IDENTITY", path, `must be a non-empty trimmed String no larger than ${cutDiagramLimits.maximumIdentityBytes} UTF-8 bytes without control characters`);
  }
  return result;
}

function exactQuantity(value: IRValue | undefined, dimension: string, unit: string, path: string) {
  if (value?.kind !== "quantity" || value.dimension !== dimension || value.unit !== unit) {
    fail("CUT_DIAGRAM_TYPE", path, `must be ${dimension === "length" ? "a pixel Length" : dimension === "ratio" ? "Ratio" : "Number"}`);
  }
  if (!/^-?(?:0|[1-9][0-9]*)$/u.test(value.magnitude.numerator)
    || !/^(?:[1-9][0-9]*)$/u.test(value.magnitude.denominator)) {
    fail("CUT_DIAGRAM_TYPE", `${path}.magnitude`, "must be a canonical reduced exact rational");
  }
  if (value.magnitude.numerator.replace(/^-/, "").length > cutDiagramLimits.maximumRationalDigits
    || value.magnitude.denominator.length > cutDiagramLimits.maximumRationalDigits) {
    fail("CUT_DIAGRAM_LIMIT", `${path}.magnitude`, `exceeds the ${cutDiagramLimits.maximumRationalDigits}-digit exact-rational budget`);
  }
  const canonical = rational(value.magnitude.numerator, value.magnitude.denominator);
  if (canonical.numerator !== value.magnitude.numerator || canonical.denominator !== value.magnitude.denominator) {
    fail("CUT_DIAGRAM_TYPE", `${path}.magnitude`, "must be a canonical reduced exact rational");
  }
  return value.magnitude;
}

function boundedLength(value: IRValue | undefined, path: string, allowZero = false) {
  const length = exactQuantity(value, "length", "px", path);
  const minimum = allowZero ? rational(0) : rational(1);
  if (compareRational(length, minimum) < 0 || compareRational(length, rational(cutDiagramLimits.maximumCoordinatePixels)) > 0) {
    fail("CUT_DIAGRAM_BOUNDS", path, `must be ${allowZero ? "non-negative" : "at least 1px"} and no larger than ${cutDiagramLimits.maximumCoordinatePixels}px`);
  }
  return length;
}

function boundedWholePixelLength(value: IRValue | undefined, path: string) {
  const length = boundedLength(value, path);
  if (length.denominator !== "1") {
    fail("CUT_DIAGRAM_TYPE", path, "must be a positive whole-pixel Length; diagram raster bounds are never implicitly quantized");
  }
  return length;
}

function boundedRatio(value: IRValue | undefined, path: string, maximum = rational(1)) {
  const ratio = exactQuantity(value, "ratio", "ratio", path);
  if (compareRational(ratio, rational(0)) < 0 || compareRational(ratio, maximum) > 0) {
    fail("CUT_DIAGRAM_BOUNDS", path, "is outside its closed ratio range");
  }
  return ratio;
}

function port(value: IRValue | undefined, path: string) {
  if (value === undefined) return "auto" as const;
  const result = text(value, path);
  if (!(cutDiagramPorts as readonly string[]).includes(result)) {
    fail("CUT_DIAGRAM_TYPE", path, `must be one of: ${cutDiagramPorts.join(", ")}`);
  }
  return result as typeof cutDiagramPorts[number];
}

function visibleColor(value: IRValue | undefined, path: string) {
  if (value?.kind !== "color") fail("CUT_DIAGRAM_TYPE", path, "must be Color");
  if (value.value.length === 9 && value.value.slice(-2).toLowerCase() === "00") {
    fail("CUT_DIAGRAM_NOOP", path, "must not be fully transparent because the accepted diagram paint would be inert");
  }
  return value.value;
}

function arrow(value: IRValue | undefined, path: string) {
  if (value === undefined) return undefined;
  const entries = closedObject(value, path, ["length", "width", "color"]);
  boundedLength(entries.length, `${path}.length`);
  boundedLength(entries.width, `${path}.width`);
  visibleColor(entries.color, `${path}.color`);
  return value;
}

export function decodeCutDiagramEdge(value: IRValue | undefined, path = "$.edge"): CutDiagramEdgeContract {
  const entries = closedObject(value, path, ["id", "from", "to", "stroke", "width"], ["fromPort", "toPort", "arrow"]);
  const id = identity(entries.id, `${path}.id`), from = identity(entries.from, `${path}.from`), to = identity(entries.to, `${path}.to`);
  if (from === to) fail("CUT_DIAGRAM_GRAPH", `${path}.to`, `edge ${JSON.stringify(id)} cannot connect a node to itself`);
  const fromPort = port(entries.fromPort, `${path}.fromPort`), toPort = port(entries.toPort, `${path}.toPort`);
  const stroke = visibleColor(entries.stroke, `${path}.stroke`);
  const width = boundedLength(entries.width, `${path}.width`), arrow_ = arrow(entries.arrow, `${path}.arrow`);
  const semanticIdentity = hash({ from, to, fromPort, toPort, stroke, width, ...(arrow_ ? { arrow: arrow_ } : {}) });
  return Object.freeze({ id, from, to, fromPort, toPort, stroke, width, ...(arrow_ ? { arrow: arrow_ } : {}), semanticIdentity });
}

function assertAcyclic(stateId: string, nodes: readonly string[], edges: readonly CutDiagramEdgeContract[], path: string) {
  const order = new Map(nodes.map((id, index) => [id, index]));
  const incoming = new Map(nodes.map((id) => [id, 0]));
  const outgoing = new Map(nodes.map((id) => [id, [] as string[]]));
  for (const edge of edges) {
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    outgoing.get(edge.from)?.push(edge.to);
  }
  const ready = nodes.filter((id) => incoming.get(id) === 0);
  let visited = 0;
  while (ready.length) {
    ready.sort((left, right) => (order.get(left)! - order.get(right)!) || Buffer.compare(Buffer.from(left), Buffer.from(right)));
    const current = ready.shift()!;
    visited += 1;
    for (const next of outgoing.get(current) ?? []) {
      const count = (incoming.get(next) ?? 0) - 1;
      incoming.set(next, count);
      if (count === 0) ready.push(next);
    }
  }
  if (visited !== nodes.length) fail("CUT_DIAGRAM_GRAPH", `${path}.edges`, `diagramState ${JSON.stringify(stateId)} contains a directed cycle`);
}

export function decodeCutDiagramState(value: IRValue | undefined, path = "$.state"): CutDiagramStateContract {
  const entries = closedObject(value, path, ["id", "nodes", "edges"]), id = identity(entries.id, `${path}.id`);
  if (entries.nodes?.kind !== "array") fail("CUT_DIAGRAM_TYPE", `${path}.nodes`, "must be List<String>");
  if (entries.nodes.items.length > cutDiagramLimits.nodesPerLayout) fail("CUT_DIAGRAM_LIMIT", `${path}.nodes`, `exceeds ${cutDiagramLimits.nodesPerLayout} nodes`);
  const nodes = entries.nodes.items.map((item, index) => identity(item, `${path}.nodes[${index}]`));
  const nodeIds = new Set<string>();
  nodes.forEach((node, index) => {
    if (nodeIds.has(node)) fail("CUT_DIAGRAM_IDENTITY", `${path}.nodes[${index}]`, `duplicates node ID ${JSON.stringify(node)}`);
    nodeIds.add(node);
  });
  if (entries.edges?.kind !== "array") fail("CUT_DIAGRAM_TYPE", `${path}.edges`, "must be List<DiagramEdge>");
  if (entries.edges.items.length > cutDiagramLimits.edgesPerState) fail("CUT_DIAGRAM_LIMIT", `${path}.edges`, `exceeds ${cutDiagramLimits.edgesPerState} edges`);
  const edges = entries.edges.items.map((item, index) => decodeCutDiagramEdge(item, `${path}.edges[${index}]`));
  const edgeIds = new Set<string>();
  edges.forEach((edge, index) => {
    if (edgeIds.has(edge.id)) fail("CUT_DIAGRAM_IDENTITY", `${path}.edges[${index}].id`, `duplicates edge ID ${JSON.stringify(edge.id)}`);
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.from)) fail("CUT_DIAGRAM_GRAPH", `${path}.edges[${index}].from`, `references missing state node ${JSON.stringify(edge.from)}`);
    if (!nodeIds.has(edge.to)) fail("CUT_DIAGRAM_GRAPH", `${path}.edges[${index}].to`, `references missing state node ${JSON.stringify(edge.to)}`);
  });
  assertAcyclic(id, nodes, edges, path);
  return Object.freeze({ id, nodes: Object.freeze(nodes), edges: Object.freeze(edges), semanticIdentity: hash({ id, nodes, edges }) });
}

export type CutDiagramNodeContract = Readonly<{
  id: string;
  width: Rational;
  height: Rational;
  rank?: number;
  /** Compiler/runtime ownership witness; consumers must not mutate it. */
  node: IRNode;
}>;

export function decodeCutDiagramNode(node: IRNode, path = `$.nodes.${JSON.stringify(node.id)}`): CutDiagramNodeContract {
  const allowed = new Set(["id", "width", "height", "rank"]), unknown = Object.keys(node.inputs).find((key) => !allowed.has(key));
  if (unknown) fail("CUT_DIAGRAM_TYPE", `${path}.inputs.${unknown}`, "is not an accepted DiagramNode field", node.id);
  if (node.op !== cutDiagramOps.node) fail("CUT_DIAGRAM_TYPE", `${path}.op`, `must be ${cutDiagramOps.node}`, node.id);
  const id = identity(node.inputs.id, `${path}.inputs.id`), width = boundedWholePixelLength(node.inputs.width, `${path}.inputs.width`), height = boundedWholePixelLength(node.inputs.height, `${path}.inputs.height`);
  let rank_: number | undefined;
  if (node.inputs.rank !== undefined) {
    const rank = exactQuantity(node.inputs.rank, "scalar", "scalar", `${path}.inputs.rank`);
    if (rank.denominator !== "1") fail("CUT_DIAGRAM_TYPE", `${path}.inputs.rank`, "must be a whole Number", node.id);
    rank_ = Number(rank.numerator);
    if (!Number.isSafeInteger(rank_) || rank_ < 0 || rank_ > 31) fail("CUT_DIAGRAM_GRAPH", `${path}.inputs.rank`, "must be an integer from 0 through 31", node.id);
  }
  if (node.children.length < 1 || node.children.length > 256) fail("CUT_DIAGRAM_BOUNDS", `${path}.children`, "must contain 1 through 256 visual children", node.id);
  return Object.freeze({ id, width, height, ...(rank_ === undefined ? {} : { rank: rank_ }), node });
}

type CutDiagramDirection = typeof cutDiagramDirections[number];

export type CutDiagramLayoutContract = Readonly<{
  id: string;
  direction: CutDiagramDirection;
  width?: Rational;
  height?: Rational;
  x: Rational;
  y: Rational;
  safeX: Rational;
  safeY: Rational;
  nodeGap: Rational;
  rankGap: Rational;
  edgeGap: Rational;
  edgeClearance: Rational;
  progress?: Rational;
  state: CutDiagramStateContract;
  fromState?: CutDiagramStateContract;
  nodes: readonly CutDiagramNodeContract[];
  node: IRNode;
}>;

function decodeLayoutInputs(node: IRNode, path: string) {
  const required = ["state"], optional = ["fromState", "progress", "direction", "width", "height", "x", "y", "safeX", "safeY", "nodeGap", "rankGap", "edgeGap", "edgeClearance"];
  const allowed = new Set([...required, ...optional]), unknown = Object.keys(node.inputs).find((key) => !allowed.has(key));
  if (unknown) fail("CUT_DIAGRAM_TYPE", `${path}.inputs.${unknown}`, "is not an accepted DiagramLayout field", node.id);
  if (node.inputs.state === undefined) fail("CUT_DIAGRAM_TYPE", `${path}.inputs.state`, "is required", node.id);
  const hasFrameWidth = node.inputs.width !== undefined, hasFrameHeight = node.inputs.height !== undefined;
  if (hasFrameWidth !== hasFrameHeight) fail("CUT_DIAGRAM_TYPE", `${path}.inputs.${hasFrameWidth ? "width" : "height"}`, "DiagramLayout width and height must be supplied together", node.id);
  const hasFromState = node.inputs.fromState !== undefined, hasProgress = node.inputs.progress !== undefined;
  if (hasFromState !== hasProgress) fail("CUT_DIAGRAM_TYPE", `${path}.inputs.${hasFromState ? "fromState" : "progress"}`, "DiagramLayout fromState and progress must be supplied together", node.id);
  const width = hasFrameWidth ? boundedWholePixelLength(node.inputs.width, `${path}.inputs.width`) : undefined;
  const height = hasFrameHeight ? boundedWholePixelLength(node.inputs.height, `${path}.inputs.height`) : undefined;
  const position = { x: rational(0), y: rational(0) };
  for (const axis of ["x", "y"] as const) if (node.inputs[axis] !== undefined) {
    const value = exactQuantity(node.inputs[axis], "length", "px", `${path}.inputs.${axis}`), magnitude = Math.abs(Number(value.numerator) / Number(value.denominator));
    if (!Number.isFinite(magnitude) || magnitude > cutDiagramLimits.maximumCoordinatePixels) fail("CUT_DIAGRAM_BOUNDS", `${path}.inputs.${axis}`, `magnitude exceeds ${cutDiagramLimits.maximumCoordinatePixels}px`, node.id);
    position[axis] = value;
  }
  const safe = { safeX: rational(0), safeY: rational(0) };
  for (const axis of ["safeX", "safeY"] as const) if (node.inputs[axis] !== undefined) {
    const inset = boundedRatio(node.inputs[axis], `${path}.inputs.${axis}`, rational(1, 2));
    if (compareRational(inset, rational(1, 2)) === 0) fail("CUT_DIAGRAM_BOUNDS", `${path}.inputs.${axis}`, "cannot consume the complete frame", node.id);
    safe[axis] = inset;
  }
  const gaps = {
    nodeGap: node.inputs.nodeGap === undefined ? rational(16) : boundedLength(node.inputs.nodeGap, `${path}.inputs.nodeGap`),
    rankGap: node.inputs.rankGap === undefined ? rational(48) : boundedLength(node.inputs.rankGap, `${path}.inputs.rankGap`),
    edgeGap: node.inputs.edgeGap === undefined ? rational(6) : boundedLength(node.inputs.edgeGap, `${path}.inputs.edgeGap`),
    edgeClearance: node.inputs.edgeClearance === undefined ? rational(4) : boundedLength(node.inputs.edgeClearance, `${path}.inputs.edgeClearance`, true),
  };
  const progress = node.inputs.progress === undefined ? undefined : boundedRatio(node.inputs.progress, `${path}.inputs.progress`);
  let direction: CutDiagramDirection = "auto";
  if (node.inputs.direction !== undefined) {
    const authored = text(node.inputs.direction, `${path}.inputs.direction`);
    if (!(cutDiagramDirections as readonly string[]).includes(authored)) fail("CUT_DIAGRAM_TYPE", `${path}.inputs.direction`, `must be one of: ${cutDiagramDirections.join(", ")}`, node.id);
    direction = authored as CutDiagramDirection;
  }
  return Object.freeze({ direction, ...(width ? { width } : {}), ...(height ? { height } : {}), ...position, ...safe, ...gaps, ...(progress ? { progress } : {}) });
}

export function decodeCutDiagramLayout(ir: CutAVIR, layout: IRNode, path = `$.nodes.${JSON.stringify(layout.id)}`): CutDiagramLayoutContract {
  if (layout.op !== cutDiagramOps.layout) fail("CUT_DIAGRAM_TYPE", `${path}.op`, `must be ${cutDiagramOps.layout}`, layout.id);
  const inputs = decodeLayoutInputs(layout, path);
  if (layout.children.length < 1 || layout.children.length > cutDiagramLimits.nodesPerLayout) {
    fail("CUT_DIAGRAM_LIMIT", `${path}.children`, `must contain 1 through ${cutDiagramLimits.nodesPerLayout} direct DiagramNode children`, layout.id);
  }
  const children = layout.children.map((id, index) => {
    const child = ir.nodes[id];
    if (!child || child.op !== cutDiagramOps.node) fail("CUT_DIAGRAM_BOUNDS", `${path}.children[${index}]`, "must be a direct DiagramNode", child?.id ?? layout.id);
    return decodeCutDiagramNode(child, `$.nodes.${JSON.stringify(child.id)}`);
  });
  const byId = new Map<string, CutDiagramNodeContract>();
  let declaredPixels = 0;
  children.forEach((child) => {
    if (byId.has(child.id)) fail("CUT_DIAGRAM_IDENTITY", `$.nodes.${JSON.stringify(child.node.id)}.inputs.id`, `duplicates DiagramNode ID ${JSON.stringify(child.id)}`, child.node.id);
    byId.set(child.id, child);
    declaredPixels += (Number(child.width.numerator) / Number(child.width.denominator)) * (Number(child.height.numerator) / Number(child.height.denominator));
  });
  if (!Number.isFinite(declaredPixels) || declaredPixels > cutDiagramLimits.aggregateNodePixelsPerLayout) {
    fail("CUT_DIAGRAM_LIMIT", `${path}.children`, `aggregate declared node pixels exceed ${cutDiagramLimits.aggregateNodePixelsPerLayout}`, layout.id);
  }
  const state = decodeCutDiagramState(layout.inputs.state, `${path}.inputs.state`);
  const fromState = layout.inputs.fromState === undefined ? undefined : decodeCutDiagramState(layout.inputs.fromState, `${path}.inputs.fromState`);
  if (fromState?.id === state.id) {
    if (fromState.semanticIdentity === state.semanticIdentity) fail("CUT_DIAGRAM_NOOP", `${path}.inputs.fromState`, "fromState and state are semantically identical", layout.id);
    fail("CUT_DIAGRAM_IDENTITY", `${path}.inputs.fromState.id`, `active states reuse ID ${JSON.stringify(state.id)} with different semantics`, layout.id);
  }
  const used = new Set([...(fromState?.nodes ?? []), ...state.nodes]);
  for (const nodeId of used) if (!byId.has(nodeId)) fail("CUT_DIAGRAM_IDENTITY", `${path}.inputs.state.nodes`, `state references missing DiagramNode ${JSON.stringify(nodeId)}`, layout.id);
  for (const childId of byId.keys()) if (!used.has(childId)) fail("CUT_DIAGRAM_IDENTITY", `${path}.children`, `DiagramNode ${JSON.stringify(childId)} is unused by every active state`, byId.get(childId)!.node.id);
  for (const active of [fromState, state].filter((item): item is CutDiagramStateContract => item !== undefined)) {
    for (const edge of active.edges) {
      const fromRank = byId.get(edge.from)?.rank, toRank = byId.get(edge.to)?.rank;
      if (fromRank !== undefined && toRank !== undefined && fromRank >= toRank) {
        fail("CUT_DIAGRAM_GRAPH", `${path}.inputs.${active === state ? "state" : "fromState"}.edges`, `edge ${JSON.stringify(edge.id)} violates authored ranks ${fromRank} -> ${toRank}`, layout.id);
      }
    }
  }
  if (fromState) {
    const oldEdges = new Map(fromState.edges.map((edge) => [edge.id, edge]));
    state.edges.forEach((edge, index) => {
      const prior = oldEdges.get(edge.id);
      if (prior && prior.semanticIdentity !== edge.semanticIdentity) {
        fail("CUT_DIAGRAM_IDENTITY", `${path}.inputs.state.edges[${index}].id`, `shared edge ID ${JSON.stringify(edge.id)} changed endpoints, ports, or paint contract`, layout.id);
      }
    });
  }
  return Object.freeze({ id: layout.id, ...inputs, state, ...(fromState ? { fromState } : {}), nodes: Object.freeze(children), node: layout });
}

function compositionReachableNodes(ir: CutAVIR, compositionId: string) {
  const composition = ir.compositions.find((candidate) => candidate.id === compositionId);
  if (!composition) return new Set<string>();
  const roots = [...composition.rootVisualIds, ...composition.rootAudioIds, ...composition.rootAVIds];
  for (const sceneId of composition.sceneIds) {
    const scene = ir.scenes[sceneId];
    if (scene) roots.push(...scene.rootVisualIds, ...scene.rootAudioIds, ...scene.rootAVIds);
  }
  const reachable = new Set<string>(), pending = [...roots];
  while (pending.length) {
    const id = pending.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    const node = ir.nodes[id];
    if (node) pending.push(...node.children);
  }
  return reachable;
}

/** Compiler-side closure for the public Diagram records/ownership seam. The
 * strict loaded-IR and raster contracts intentionally remain a later vertical. */
export function validateCutDiagramLanguageIR(ir: CutAVIR) {
  const parents = new Map<string, string[]>();
  for (const node of Object.values(ir.nodes)) for (const child of node.children) {
    const values = parents.get(child) ?? [];
    values.push(node.id);
    parents.set(child, values);
  }
  for (const composition of ir.compositions) {
    const reachable = compositionReachableNodes(ir, composition.id);
    const layouts = [...reachable].map((id) => ir.nodes[id]).filter((node): node is IRNode => node?.op === cutDiagramOps.layout);
    if (layouts.length > cutDiagramLimits.layoutsPerComposition) {
      fail("CUT_DIAGRAM_LIMIT", `$.compositions.${JSON.stringify(composition.id)}`, `exceeds ${cutDiagramLimits.layoutsPerComposition} DiagramLayout nodes per composition`, layouts[cutDiagramLimits.layoutsPerComposition]?.id);
    }
    for (const layout of layouts) {
      const pending = [...(parents.get(layout.id) ?? [])], visited = new Set<string>();
      while (pending.length) {
        const parentId = pending.pop()!;
        if (visited.has(parentId)) continue;
        visited.add(parentId);
        const parent = ir.nodes[parentId];
        if (parent?.op === cutDiagramOps.layout || parent?.op === cutDiagramOps.node) {
          fail("CUT_DIAGRAM_BOUNDS", `$.nodes.${JSON.stringify(layout.id)}`, "DiagramLayout cannot be nested inside another DiagramLayout or DiagramNode subtree", layout.id);
        }
        pending.push(...(parents.get(parentId) ?? []));
      }
      decodeCutDiagramLayout(ir, layout, `$.nodes.${JSON.stringify(layout.id)}`);
    }
  }
  for (const node of Object.values(ir.nodes)) {
    if (node.op !== cutDiagramOps.node) continue;
    const owners = (parents.get(node.id) ?? []).filter((id) => ir.nodes[id]?.op === cutDiagramOps.layout);
    if (owners.length !== 1 || (parents.get(node.id) ?? []).length !== 1) {
      fail("CUT_DIAGRAM_BOUNDS", `$.nodes.${JSON.stringify(node.id)}`, "DiagramNode must have exactly one direct DiagramLayout owner", node.id);
    }
  }
}
