import type { IRNode, IRValue } from "../../language/ir";
import { rationalToNumber } from "../../language/rational";

export type ReferenceTracePoint = Readonly<{ x: number; y: number }>;

export type ReferenceCubicTraceSegment = Readonly<{
  control1: ReferenceTracePoint;
  control2: ReferenceTracePoint;
  to: ReferenceTracePoint;
}>;

export type ReferenceTraceArrow = Readonly<{
  length: number;
  width: number;
  color: string;
}>;

export type PreparedReferenceTrace = Readonly<{
  points: readonly ReferenceTracePoint[];
  cumulativeLengths: readonly number[];
  totalLength: number;
}>;

export type PreparedReferenceTraceNode = Readonly<{
  geometry: "polyline" | "cubic";
  trace: PreparedReferenceTrace;
  authoredSegments: number;
  arrow?: ReferenceTraceArrow;
}>;

export const referenceLocalTraceAlgorithmVersion = "cut-reference-local-trace-v1" as const;

export const referenceCubicTraceFlattening = Object.freeze({
  version: 1,
  maximumDirectTraceErrorPx: 0.35,
  directTraceScaleEnvelope: 64,
  tolerancePx: 0.35 / 64,
  maxDepth: 14,
  maxSegments: 256,
  maxFlattenedPoints: 65_536,
});

export const referenceTraceLimits = Object.freeze({
  maxPointFramesPerNode: 25_000_000,
  maxPointFramesPerComposition: 100_000_000,
  maxAbsolutePosition: 65_536,
  minScale: 0.001,
  maxScale: 64,
  maxAbsoluteRotationDegrees: 360_000,
});

export const referenceTraceEasings = ["linear", "inCubic", "outCubic", "inOutCubic"] as const;
export type ReferenceTraceEasing = typeof referenceTraceEasings[number];

export type ReferenceTraceErrorCode = "CUT_TRACE_GEOMETRY" | "CUT_TRACE_ARROW" | "CUT_TRACE_LIMIT";

export class ReferenceTraceError extends Error {
  readonly source: { module: string; line: number; column: number; nodeId: string };

  constructor(readonly code: ReferenceTraceErrorCode, readonly node: IRNode, message: string) {
    const { module, span } = node.provenance;
    super(`${code}: Trace ${message} at ${module}:${span.start.line}:${span.start.column}.`);
    this.name = "ReferenceTraceError";
    this.source = { module, line: span.start.line, column: span.start.column, nodeId: node.id };
  }
}

function fail(code: ReferenceTraceErrorCode, node: IRNode, message: string): never {
  throw new ReferenceTraceError(code, node, message);
}

function clampUnit(value: number) { return Math.max(0, Math.min(1, value)); }

export function easeReferenceTrace(progress: number, easing: ReferenceTraceEasing) {
  const value = clampUnit(progress);
  if (easing === "inCubic") return value ** 3;
  if (easing === "outCubic") return 1 - (1 - value) ** 3;
  if (easing === "inOutCubic") return value < .5 ? 4 * value ** 3 : 1 - (-2 * value + 2) ** 3 / 2;
  return value;
}

/**
 * Precompute immutable cumulative geometry once per node. Frame evaluation can
 * then locate the active segment with a binary search instead of recomputing
 * every segment length.
 */
export function prepareReferenceTrace(points: readonly ReferenceTracePoint[]): PreparedReferenceTrace {
  if (points.length < 2) throw new Error("Reference Trace needs at least two points.");
  const copied = points.map((point) => {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error("Reference Trace points must be finite.");
    return Object.freeze({ x: point.x, y: point.y });
  });
  const cumulativeLengths = [0];
  for (let index = 1; index < copied.length; index += 1) {
    cumulativeLengths.push(cumulativeLengths[index - 1] + Math.hypot(copied[index].x - copied[index - 1].x, copied[index].y - copied[index - 1].y));
  }
  const totalLength = cumulativeLengths.at(-1)!;
  if (!Number.isFinite(totalLength)) throw new Error("Reference Trace cumulative length must be finite.");
  return Object.freeze({ points: Object.freeze(copied), cumulativeLengths: Object.freeze(cumulativeLengths), totalLength });
}

function midpoint(left: ReferenceTracePoint, right: ReferenceTracePoint): ReferenceTracePoint {
  return { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
}

function pointLineDistanceSquared(point: ReferenceTracePoint, start: ReferenceTracePoint, end: ReferenceTracePoint) {
  const dx = end.x - start.x, dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return (point.x - start.x) ** 2 + (point.y - start.y) ** 2;
  const cross = dy * point.x - dx * point.y + end.x * start.y - end.y * start.x;
  return cross * cross / lengthSquared;
}

function cubicIsFlatEnough(
  start: ReferenceTracePoint,
  control1: ReferenceTracePoint,
  control2: ReferenceTracePoint,
  end: ReferenceTracePoint,
) {
  const toleranceSquared = referenceCubicTraceFlattening.tolerancePx ** 2;
  const chordLength = Math.hypot(end.x - start.x, end.y - start.y);
  const controlPolygonLength = Math.hypot(control1.x - start.x, control1.y - start.y)
    + Math.hypot(control2.x - control1.x, control2.y - control1.y)
    + Math.hypot(end.x - control2.x, end.y - control2.y);
  return controlPolygonLength - chordLength <= referenceCubicTraceFlattening.tolerancePx && Math.max(
    pointLineDistanceSquared(control1, start, end),
    pointLineDistanceSquared(control2, start, end),
  ) <= toleranceSquared;
}

/**
 * Deterministically flatten cubic Bezier segments by fixed-tolerance De
 * Casteljau subdivision. The algorithm is versioned because its output points
 * participate in frame pixels and work accounting, while authored controls
 * remain the canonical IR/cache identity.
 */
export function prepareReferenceCubicTrace(
  start: ReferenceTracePoint,
  segments: readonly ReferenceCubicTraceSegment[],
): PreparedReferenceTrace {
  if (!segments.length || segments.length > referenceCubicTraceFlattening.maxSegments) {
    throw new Error(`Reference cubic Trace needs 1 through ${referenceCubicTraceFlattening.maxSegments} segments.`);
  }
  const points: ReferenceTracePoint[] = [{ ...start }];
  let cursor = start;
  const append = (
    from: ReferenceTracePoint,
    control1: ReferenceTracePoint,
    control2: ReferenceTracePoint,
    to: ReferenceTracePoint,
    depth: number,
  ): void => {
    if (cubicIsFlatEnough(from, control1, control2, to)) {
      if (points.length >= referenceCubicTraceFlattening.maxFlattenedPoints) {
        throw new Error(`Reference cubic Trace exceeds ${referenceCubicTraceFlattening.maxFlattenedPoints} flattened points.`);
      }
      points.push({ ...to });
      return;
    }
    if (depth >= referenceCubicTraceFlattening.maxDepth) {
      throw new Error(`Reference cubic Trace cannot meet its v${referenceCubicTraceFlattening.version} local tolerance within maxDepth ${referenceCubicTraceFlattening.maxDepth}.`);
    }
    const a = midpoint(from, control1), b = midpoint(control1, control2), c = midpoint(control2, to);
    const d = midpoint(a, b), e = midpoint(b, c), middle = midpoint(d, e);
    append(from, a, d, middle, depth + 1);
    append(middle, e, c, to, depth + 1);
  };
  for (const segment of segments) {
    append(cursor, segment.control1, segment.control2, segment.to, 0);
    cursor = segment.to;
  }
  return prepareReferenceTrace(points);
}

function closedObject(value: IRValue | undefined, fields: readonly string[], node: IRNode, label: string) {
  if (value?.kind !== "object") fail("CUT_TRACE_GEOMETRY", node, `${label} must be a closed record.`);
  const keys = Object.keys(value.entries);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) {
    fail("CUT_TRACE_GEOMETRY", node, `${label} must contain exactly ${fields.join(", ")}.`);
  }
  return value.entries;
}

function length(value: IRValue | undefined, node: IRNode, label: string, code: ReferenceTraceErrorCode = "CUT_TRACE_GEOMETRY") {
  if (value?.kind !== "quantity" || value.dimension !== "length" || value.unit !== "px") {
    fail(code, node, `${label} must be an exact Length quantity in px.`);
  }
  let number: number;
  try { number = rationalToNumber(value.magnitude); }
  catch { return fail(code, node, `${label} must be a finite exact Length.`); }
  if (!Number.isFinite(number)) fail(code, node, `${label} must be finite.`);
  return number;
}

function tracePoint(value: IRValue | undefined, node: IRNode, label: string): ReferenceTracePoint {
  if (value?.kind !== "object" || Object.keys(value.entries).length !== 2 || !Object.hasOwn(value.entries, "x") || !Object.hasOwn(value.entries, "y")) {
    fail("CUT_TRACE_GEOMETRY", node, `${label} must be a closed Vec2 with exactly x and y.`);
  }
  const entries = value.entries;
  const point = { x: length(entries.x, node, `${label}.x`), y: length(entries.y, node, `${label}.y`) };
  for (const [axis, coordinate] of Object.entries(point)) {
    if (Math.abs(coordinate) > referenceTraceLimits.maxAbsolutePosition) {
      fail("CUT_TRACE_GEOMETRY", node, `${label}.${axis} exceeds the ${referenceTraceLimits.maxAbsolutePosition}px coordinate limit.`);
    }
  }
  return Object.freeze(point);
}

function traceArrow(value: IRValue | undefined, node: IRNode): ReferenceTraceArrow | undefined {
  if (value === undefined) return undefined;
  if (value.kind !== "object") fail("CUT_TRACE_ARROW", node, "arrow must be a closed TraceArrowhead record.");
  const keys = Object.keys(value.entries), fields = ["length", "width", "color"];
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) {
    fail("CUT_TRACE_ARROW", node, `arrow must contain exactly ${fields.join(", ")}.`);
  }
  const arrowLength = length(value.entries.length, node, "arrow.length", "CUT_TRACE_ARROW");
  const arrowWidth = length(value.entries.width, node, "arrow.width", "CUT_TRACE_ARROW");
  if (arrowLength <= 0 || arrowLength > 4_096) fail("CUT_TRACE_ARROW", node, "arrow.length must be greater than 0px and at most 4096px.");
  if (arrowWidth <= 0 || arrowWidth > 4_096) fail("CUT_TRACE_ARROW", node, "arrow.width must be greater than 0px and at most 4096px.");
  const color = value.entries.color;
  if (color?.kind !== "color" || !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/.test(color.value)) {
    fail("CUT_TRACE_ARROW", node, "arrow.color must be a canonical Color.");
  }
  return Object.freeze({ length: arrowLength, width: arrowWidth, color: color.value });
}

/** Decode and prepare the closed Trace geometry contract from typed IR. */
export function prepareReferenceTraceNode(node: IRNode): PreparedReferenceTraceNode | undefined {
  if (node.op !== "cut.visual.trace") return undefined;
  const hasPoints = node.inputs.points !== undefined;
  const hasStart = node.inputs.start !== undefined;
  const hasCurves = node.inputs.curves !== undefined;
  if (hasPoints && (hasStart || hasCurves)) {
    fail("CUT_TRACE_GEOMETRY", node, "must use exactly one geometry form: points, or start with curves; the forms cannot be mixed.");
  }
  if (!hasPoints && (!hasStart || !hasCurves)) {
    fail("CUT_TRACE_GEOMETRY", node, "requires points, or the complete start with curves geometry form.");
  }

  let geometry: "polyline" | "cubic";
  let trace: PreparedReferenceTrace;
  let authoredSegments: number;
  if (hasPoints) {
    const points = node.inputs.points;
    if (points?.kind !== "array") fail("CUT_TRACE_GEOMETRY", node, "points must be a List<Vec2>.");
    if (points.items.length < 2 || points.items.length > 4_096) fail("CUT_TRACE_GEOMETRY", node, "points must contain between 2 and 4096 coordinates.");
    const decoded = points.items.map((point, index) => tracePoint(point, node, `points[${index}]`));
    geometry = "polyline";
    authoredSegments = decoded.length - 1;
    trace = prepareReferenceTrace(decoded);
  } else {
    const start = tracePoint(node.inputs.start, node, "start");
    const curves = node.inputs.curves;
    if (curves?.kind !== "array") fail("CUT_TRACE_GEOMETRY", node, "curves must be a List<CubicPathSegment>.");
    if (!curves.items.length || curves.items.length > referenceCubicTraceFlattening.maxSegments) {
      fail("CUT_TRACE_LIMIT", node, `curves must contain 1 through ${referenceCubicTraceFlattening.maxSegments} cubicTo segments.`);
    }
    const decoded = curves.items.map((value, index): ReferenceCubicTraceSegment => {
      const entries = closedObject(value, ["control1", "control2", "to"], node, `curves[${index}]`);
      return Object.freeze({
        control1: tracePoint(entries.control1, node, `curves[${index}].control1`),
        control2: tracePoint(entries.control2, node, `curves[${index}].control2`),
        to: tracePoint(entries.to, node, `curves[${index}].to`),
      });
    });
    geometry = "cubic";
    authoredSegments = decoded.length;
    try { trace = prepareReferenceCubicTrace(start, decoded); }
    catch (error) { return fail("CUT_TRACE_LIMIT", node, error instanceof Error ? error.message : String(error)); }
  }
  if (geometry === "cubic" && !(trace.totalLength > 0)) fail("CUT_TRACE_GEOMETRY", node, "geometry must describe a positive-length path.");

  const arrow = traceArrow(node.inputs.arrow, node);
  const headRadius = node.inputs.headRadius === undefined ? 0 : length(node.inputs.headRadius, node, "headRadius", "CUT_TRACE_ARROW");
  if (arrow && headRadius > 0) fail("CUT_TRACE_ARROW", node, "arrow and a positive legacy headRadius are mutually exclusive endpoint markers.");
  return Object.freeze({ geometry, trace, authoredSegments, ...(arrow ? { arrow } : {}) });
}

function tangentBetween(start: ReferenceTracePoint, end: ReferenceTracePoint) {
  const dx = end.x - start.x, dy = end.y - start.y, magnitude = Math.hypot(dx, dy);
  return magnitude > 0 ? { x: dx / magnitude, y: dy / magnitude } : undefined;
}

function nearestTangent(points: readonly ReferenceTracePoint[], startIndex: number, direction: 1 | -1) {
  for (let index = startIndex; index >= 0 && index + 1 < points.length; index += direction) {
    const tangent = tangentBetween(points[index], points[index + 1]);
    if (tangent) return tangent;
  }
  return { x: 1, y: 0 };
}

function tracePrefix(trace: PreparedReferenceTrace, progress: number) {
  const { points, cumulativeLengths, totalLength } = trace;
  const bounded = clampUnit(progress), first = points[0];
  if (bounded <= 0) return { points: [first], head: first, tangent: nearestTangent(points, 0, 1) };
  if (bounded >= 1 || totalLength === 0) return { points: [...points], head: points.at(-1)!, tangent: nearestTangent(points, points.length - 2, -1) };

  const target = totalLength * bounded;
  let lower = 1, upper = cumulativeLengths.length - 1;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (cumulativeLengths[middle] >= target) upper = middle;
    else lower = middle + 1;
  }
  const endIndex = lower, startIndex = endIndex - 1;
  const startLength = cumulativeLengths[startIndex], segmentLength = cumulativeLengths[endIndex] - startLength;
  const start = points[startIndex], end = points[endIndex];
  const local = segmentLength === 0 ? 1 : (target - startLength) / segmentLength;
  const head = { x: start.x + (end.x - start.x) * local, y: start.y + (end.y - start.y) * local };
  const tangent = tangentBetween(start, end) ?? nearestTangent(points, startIndex, 1);
  return { points: [...points.slice(0, endIndex), head], head, tangent };
}

/**
 * Return an open polyline prefix measured by cumulative Euclidean arc length.
 * The endpoint is shared by the optional moving head, so stroke and head cannot
 * disagree at corners or across unequal segment lengths.
 */
export function referenceTracePrefix(trace: PreparedReferenceTrace, progress: number) {
  const { points, head } = tracePrefix(trace, progress);
  return { points, head };
}

/** Runtime-only prefix sample whose unit tangent matches the displayed terminal segment. */
export function referenceTracePrefixWithTangent(trace: PreparedReferenceTrace, progress: number) {
  return tracePrefix(trace, progress);
}
