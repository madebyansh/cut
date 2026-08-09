import type { CutAVIR, IRComposition, IRNode, IRSignal, IRValue } from "../../language/ir";
import {
  addRational,
  compareRational,
  divideRational,
  multiplyRational,
  rational,
  rationalToNumber,
  type Rational,
  zeroRational,
} from "../../language/rational";
import { propertyAt } from "./signals";
import {
  decodeReferenceAnchoredPathGeometry,
  isReferenceAnchoredPathGeometryValue,
  resolveReferenceAnchoredPathGeometryAt,
  type ReferenceAnchoredPathGeometry,
  type ReferenceAnchoredPathOwnerResolver,
  type ReferenceAnchoredPathResolution,
  type ReferenceValidatedAnchoredPathGeometry,
} from "./anchored-path";
import { canonicalIrValuesEqual } from "./noop-contract";
import {
  expandReferenceRect,
  referenceConservativeStrokeBounds,
  referenceRect,
  transformReferenceRect,
  unionReferenceRects,
  type ReferenceAffine2D,
  type ReferenceIntegerRasterBounds,
  type ReferenceRect,
} from "./retained-visual";
import {
  prepareReferenceCubicTrace,
  prepareReferenceTrace,
  referenceCubicTraceFlattening,
  type PreparedReferenceTrace,
  type ReferenceCubicTraceSegment,
  type ReferenceTracePoint,
} from "./trace";

export const referenceVectorPathLimits = Object.freeze({
  maxSegments: 256,
  maxFlattenedPoints: referenceCubicTraceFlattening.maxFlattenedPoints,
  maxAbsoluteCoordinate: 65_536,
  maxStrokeWidth: 4_096,
  maxDashEntries: 32,
  minDashEntryPx: 0.25,
  maxDashEntryPx: 4_096,
  maxDashPeriodPx: 65_536,
  maxDashFragmentsPerFrame: 16_384,
  maxSvgPointsPerFrame: 131_072,
  maxSvgBytesPerFrame: 4_194_304,
  maxDynamicPreflightFrames: 60_000,
  maxAbsoluteDashOffsetPx: 65_536,
  maxAuthoredSegmentFramesPerNode: 25_000_000,
  maxAuthoredSegmentFramesPerComposition: 100_000_000,
  maxFlattenedPointFramesPerNode: 12_000_000,
  maxFlattenedPointFramesPerComposition: 48_000_000,
  maxVisibleFragmentFramesPerNode: 2_000_000,
  maxVisibleFragmentFramesPerComposition: 8_000_000,
  maxAnchoredSpatialPointFramesPerNode: 48_000_000,
  maxAnchoredSpatialPointFramesPerComposition: 192_000_000,
  maxAnchoredOwnerSampleFramesPerNode: 48_000_000,
  maxAnchoredOwnerSampleFramesPerComposition: 192_000_000,
});

export type ReferenceVectorPathErrorCode =
  | "CUT_ANCHORED_PATH_MORPH"
  | "CUT_ANCHORED_PATH_VALIDATION"
  | "CUT_VECTOR_PATH_GEOMETRY"
  | "CUT_VECTOR_PATH_TOPOLOGY"
  | "CUT_VECTOR_PATH_PAINT"
  | "CUT_VECTOR_PATH_TRIM"
  | "CUT_VECTOR_PATH_DASH"
  | "CUT_VECTOR_PATH_SIGNAL"
  | "CUT_VECTOR_PATH_LIMIT";

export class ReferenceVectorPathError extends Error {
  readonly source: { module: string; line: number; column: number; nodeId: string };

  constructor(
    readonly code: ReferenceVectorPathErrorCode,
    readonly node: IRNode,
    readonly detail: string,
    readonly execution?: Readonly<{ time: Rational; frame?: bigint }>,
  ) {
    const { module, span } = node.provenance;
    const exact = execution
      ? ` at exact time ${execution.time.numerator}/${execution.time.denominator}s${execution.frame === undefined ? "" : ` (output frame ${execution.frame})`}`
      : "";
    super(`${code}: Path ${detail}${exact} at ${module}:${span.start.line}:${span.start.column}.`);
    this.name = "ReferenceVectorPathError";
    this.source = { module, line: span.start.line, column: span.start.column, nodeId: node.id };
  }
}

function fail(code: ReferenceVectorPathErrorCode, node: IRNode, detail: string): never {
  throw new ReferenceVectorPathError(code, node, detail);
}

export type ReferenceVectorPathSegment =
  | Readonly<{ kind: "line"; to: ReferenceTracePoint }>
  | Readonly<{ kind: "cubic"; control1: ReferenceTracePoint; control2: ReferenceTracePoint; to: ReferenceTracePoint }>;

export type ReferenceVectorPathGeometry = Readonly<{
  start: ReferenceTracePoint;
  segments: readonly ReferenceVectorPathSegment[];
  closed: boolean;
}>;

export type ReferenceVectorPathLineCap = "butt" | "round" | "square";
export type ReferenceVectorPathLineJoin = "miter" | "round" | "bevel";
export type ReferenceVectorPathFillRule = "nonzero" | "evenodd";

export type ReferenceVectorPathPlan = Readonly<{
  geometryKind: "retained";
  source: ReferenceVectorPathGeometry;
  target?: ReferenceVectorPathGeometry;
  sourcePrepared: PreparedReferenceTrace;
  targetPrepared?: PreparedReferenceTrace;
  /** Present when morph geometry is frame-invariant and can be retained. */
  staticPrepared: PreparedReferenceTrace;
  morphDynamic: boolean;
  stroke?: string;
  fill?: string;
  strokeWidth: number;
  dash?: readonly number[];
  lineCap: ReferenceVectorPathLineCap;
  lineJoin: ReferenceVectorPathLineJoin;
  fillRule: ReferenceVectorPathFillRule;
  animatedProperties: readonly string[];
  /** True only when trimStart/trimEnd can change inside the active interval.
   * Such a Path may intentionally cross an exact zero-length stroke frame. */
  trimRangeDynamic: boolean;
  frameDynamic: boolean;
}>;

/** An owner-resolved path deliberately has a separate plan type. The legacy
 * retained plan above remains byte-for-byte unchanged, including its static
 * prepared trace. Anchored geometry has no truthful numeric source until its
 * owners are sampled at one exact execution time. */
export type ReferenceAnchoredVectorPathPlan = Readonly<{
  geometryKind: "anchored-v1";
  geometry: ReferenceAnchoredPathGeometry | ReferenceValidatedAnchoredPathGeometry;
  authoredSegments: number;
  closed: boolean;
  stroke?: string;
  fill?: string;
  strokeWidth: number;
  dash?: readonly number[];
  lineCap: ReferenceVectorPathLineCap;
  lineJoin: ReferenceVectorPathLineJoin;
  fillRule: ReferenceVectorPathFillRule;
  animatedProperties: readonly string[];
  trimRangeDynamic: boolean;
  /** Owner placement can change even when all Path paint controls are static. */
  frameDynamic: true;
}>;

export type ReferenceAnchoredVectorPathFrameResolution =
  | Readonly<{
    status: "resolved";
    frame: ReferenceVectorPathFrame;
    geometryIdentity: string;
    executionIdentity: string;
    anchored: Extract<ReferenceAnchoredPathResolution, { status: "resolved" }>;
  }>
  | Readonly<{
    status: "policy-hidden";
    geometryIdentity?: never;
    executionIdentity: string;
    anchored: Extract<ReferenceAnchoredPathResolution, { status: "policy-hidden" }>;
  }>;

export type ReferenceVectorPathStrokeFragment = Readonly<{
  points: readonly ReferenceTracePoint[];
  closed: boolean;
}>;

export type ReferenceVectorPathFrame = Readonly<{
  geometry: PreparedReferenceTrace;
  morph: number;
  trimStart: number;
  trimEnd: number;
  dashOffset: number;
  strokeFragments: readonly ReferenceVectorPathStrokeFragment[];
  /** Compatibility/readability projection of strokeFragments. */
  strokePolylines: readonly (readonly ReferenceTracePoint[])[];
  fillPoints: readonly ReferenceTracePoint[];
  stroke?: string;
  fill?: string;
  strokeWidth: number;
  lineCap: ReferenceVectorPathLineCap;
  lineJoin: ReferenceVectorPathLineJoin;
  fillRule: ReferenceVectorPathFillRule;
  /** A dynamic zero-length stroke has no rasterizable paint unless a closed
   * fill remains independently visible. */
  visibility: "visible" | "transparent-trim";
}>;

function exactLength(node: IRNode, value: IRValue | undefined, label: string, code: ReferenceVectorPathErrorCode) {
  if (value?.kind !== "quantity" || value.dimension !== "length" || value.unit !== "px") {
    fail(code, node, `${label} must be an exact Length quantity in px`);
  }
  let result: number;
  try { result = rationalToNumber(value.magnitude); }
  catch { return fail(code, node, `${label} must be a finite exact Length`); }
  if (!Number.isFinite(result)) fail(code, node, `${label} must be finite`);
  return result;
}

function exactRatio(node: IRNode, value: IRValue | undefined, label: string, allowNull = false) {
  if (allowNull && value?.kind === "null") return undefined;
  if (value?.kind !== "quantity" || value.dimension !== "ratio" || value.unit !== "ratio") {
    fail("CUT_VECTOR_PATH_SIGNAL", node, `${label} must be an exact Ratio quantity`);
  }
  if (compareRational(value.magnitude, zeroRational) < 0 || compareRational(value.magnitude, rational(1)) > 0) {
    fail("CUT_VECTOR_PATH_SIGNAL", node, `${label} must be between 0% and 100%`);
  }
  return rationalToNumber(value.magnitude);
}

function exactPoint(node: IRNode, value: IRValue | undefined, label: string): ReferenceTracePoint {
  if (value?.kind !== "object" || Object.keys(value.entries).length !== 2 || !Object.hasOwn(value.entries, "x") || !Object.hasOwn(value.entries, "y")) {
    fail("CUT_VECTOR_PATH_GEOMETRY", node, `${label} must be a closed Vec2 with exactly x and y`);
  }
  const point = {
    x: exactLength(node, value.entries.x, `${label}.x`, "CUT_VECTOR_PATH_GEOMETRY"),
    y: exactLength(node, value.entries.y, `${label}.y`, "CUT_VECTOR_PATH_GEOMETRY"),
  };
  if (Math.abs(point.x) > referenceVectorPathLimits.maxAbsoluteCoordinate || Math.abs(point.y) > referenceVectorPathLimits.maxAbsoluteCoordinate) {
    fail("CUT_VECTOR_PATH_LIMIT", node, `${label} exceeds the ±${referenceVectorPathLimits.maxAbsoluteCoordinate}px coordinate envelope`);
  }
  return Object.freeze(point);
}

function exactBoolean(node: IRNode, value: IRValue | undefined, label: string) {
  if (value?.kind !== "boolean") fail("CUT_VECTOR_PATH_GEOMETRY", node, `${label} must be Boolean`);
  return value.value;
}

function closedEntries(node: IRNode, value: IRValue | undefined, fields: readonly string[], label: string) {
  if (value?.kind !== "object") fail("CUT_VECTOR_PATH_GEOMETRY", node, `${label} must be a closed record`);
  const keys = Object.keys(value.entries);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) {
    fail("CUT_VECTOR_PATH_GEOMETRY", node, `${label} must contain exactly ${fields.join(", ")}`);
  }
  return value.entries;
}

function samePoint(left: ReferenceTracePoint, right: ReferenceTracePoint) {
  return left.x === right.x && left.y === right.y;
}

/**
 * Decode the canonical public `VectorPathGeometry` record. This is exported so
 * every consumer (currently retained Path and MotionPath) executes one closed
 * geometry contract rather than maintaining subtly different record parsers.
 */
export function decodeReferenceVectorPathGeometry(node: IRNode, value: IRValue | undefined, label: string): ReferenceVectorPathGeometry {
  const entries = closedEntries(node, value, ["start", "segments", "closed"], label);
  const start = exactPoint(node, entries.start, `${label}.start`);
  if (entries.segments?.kind !== "array") fail("CUT_VECTOR_PATH_GEOMETRY", node, `${label}.segments must be a List<PathSegment>`);
  if (!entries.segments.items.length || entries.segments.items.length > referenceVectorPathLimits.maxSegments) {
    fail("CUT_VECTOR_PATH_LIMIT", node, `${label}.segments must contain 1 through ${referenceVectorPathLimits.maxSegments} lineTo/cubicTo records`);
  }
  const segments = entries.segments.items.map((item, index): ReferenceVectorPathSegment => {
    if (item.kind !== "object") fail("CUT_VECTOR_PATH_GEOMETRY", node, `${label}.segments[${index}] must be lineTo or cubicTo`);
    const keys = Object.keys(item.entries).sort();
    if (keys.length === 1 && keys[0] === "to") {
      return Object.freeze({ kind: "line" as const, to: exactPoint(node, item.entries.to, `${label}.segments[${index}].to`) });
    }
    if (keys.length === 3 && keys[0] === "control1" && keys[1] === "control2" && keys[2] === "to") {
      return Object.freeze({
        kind: "cubic" as const,
        control1: exactPoint(node, item.entries.control1, `${label}.segments[${index}].control1`),
        control2: exactPoint(node, item.entries.control2, `${label}.segments[${index}].control2`),
        to: exactPoint(node, item.entries.to, `${label}.segments[${index}].to`),
      });
    }
    fail("CUT_VECTOR_PATH_GEOMETRY", node, `${label}.segments[${index}] must contain exactly to for lineTo, or control1, control2, to for cubicTo`);
  });
  const closed = exactBoolean(node, entries.closed, `${label}.closed`);
  if (closed && samePoint(segments.at(-1)!.to, start)) {
    fail("CUT_VECTOR_PATH_GEOMETRY", node, `${label} redundantly ends at its start while closed is true`);
  }
  return Object.freeze({ start, segments: Object.freeze(segments), closed });
}

function segmentTopology(geometry: ReferenceVectorPathGeometry) {
  return geometry.segments.map((segment) => segment.kind);
}

function validateMorphTopology(node: IRNode, source: ReferenceVectorPathGeometry, target: ReferenceVectorPathGeometry) {
  if (source.closed !== target.closed) fail("CUT_VECTOR_PATH_TOPOLOGY", node, "morph source and target must have the same closed state");
  if (source.segments.length !== target.segments.length) {
    fail("CUT_VECTOR_PATH_TOPOLOGY", node, `morph source has ${source.segments.length} segments but target has ${target.segments.length}`);
  }
  source.segments.forEach((segment, index) => {
    if (segment.kind !== target.segments[index].kind) {
      fail("CUT_VECTOR_PATH_TOPOLOGY", node, `morph segment ${index} is ${segment.kind} in the source and ${target.segments[index].kind} in the target`);
    }
  });
}

function geometryCoordinates(geometry: ReferenceVectorPathGeometry) {
  return [
    geometry.start.x,
    geometry.start.y,
    ...geometry.segments.flatMap((segment) => segment.kind === "line"
      ? [segment.to.x, segment.to.y]
      : [segment.control1.x, segment.control1.y, segment.control2.x, segment.control2.y, segment.to.x, segment.to.y]),
  ];
}

function sameGeometry(left: ReferenceVectorPathGeometry, right: ReferenceVectorPathGeometry) {
  if (left.closed !== right.closed || segmentTopology(left).join("\0") !== segmentTopology(right).join("\0")) return false;
  const a = geometryCoordinates(left), b = geometryCoordinates(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function interpolatePoint(left: ReferenceTracePoint, right: ReferenceTracePoint, progress: number): ReferenceTracePoint {
  return { x: left.x + (right.x - left.x) * progress, y: left.y + (right.y - left.y) * progress };
}

function interpolateGeometry(source: ReferenceVectorPathGeometry, target: ReferenceVectorPathGeometry, progress: number): ReferenceVectorPathGeometry {
  return {
    start: interpolatePoint(source.start, target.start, progress),
    closed: source.closed,
    segments: source.segments.map((segment, index): ReferenceVectorPathSegment => {
      const other = target.segments[index];
      if (segment.kind === "line" && other.kind === "line") return { kind: "line", to: interpolatePoint(segment.to, other.to, progress) };
      if (segment.kind === "cubic" && other.kind === "cubic") return {
        kind: "cubic",
        control1: interpolatePoint(segment.control1, other.control1, progress),
        control2: interpolatePoint(segment.control2, other.control2, progress),
        to: interpolatePoint(segment.to, other.to, progress),
      };
      throw new Error("Validated CUT vector-path topology changed during interpolation.");
    }),
  };
}

export function prepareReferenceVectorPathGeometry(node: IRNode, geometry: ReferenceVectorPathGeometry): PreparedReferenceTrace {
  const points: ReferenceTracePoint[] = [{ ...geometry.start }];
  let cursor = geometry.start;
  try {
    for (const [index, segment] of geometry.segments.entries()) {
      if (segment.kind === "line") {
        if (samePoint(cursor, segment.to)) fail("CUT_VECTOR_PATH_GEOMETRY", node, `segment ${index} is a zero-length lineTo and cannot affect pixels`);
        points.push({ ...segment.to });
      }
      else {
        const cubic: ReferenceCubicTraceSegment = { control1: segment.control1, control2: segment.control2, to: segment.to };
        const prepared = prepareReferenceCubicTrace(cursor, [cubic]);
        if (!(prepared.totalLength > 0)) fail("CUT_VECTOR_PATH_GEOMETRY", node, `segment ${index} is a zero-length cubicTo and cannot affect pixels`);
        points.push(...prepared.points.slice(1).map((point) => ({ ...point })));
      }
      if (points.length > referenceVectorPathLimits.maxFlattenedPoints) {
        fail("CUT_VECTOR_PATH_LIMIT", node, `geometry exceeds ${referenceVectorPathLimits.maxFlattenedPoints} flattened points`);
      }
      cursor = segment.to;
    }
    if (geometry.closed) points.push({ ...geometry.start });
    if (points.length > referenceVectorPathLimits.maxFlattenedPoints) {
      fail("CUT_VECTOR_PATH_LIMIT", node, `closed geometry exceeds ${referenceVectorPathLimits.maxFlattenedPoints} flattened points`);
    }
    const prepared = prepareReferenceTrace(points);
    if (!(prepared.totalLength > 0)) fail("CUT_VECTOR_PATH_GEOMETRY", node, "geometry must describe a positive-length path");
    return prepared;
  } catch (error) {
    if (error instanceof ReferenceVectorPathError) throw error;
    fail("CUT_VECTOR_PATH_LIMIT", node, error instanceof Error ? error.message : String(error));
  }
}

function windingNumber(point: ReferenceTracePoint, polygon: readonly ReferenceTracePoint[]) {
  let winding = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const left = polygon[index]!, right = polygon[(index + 1) % polygon.length]!;
    const side = (right.x - left.x) * (point.y - left.y) - (point.x - left.x) * (right.y - left.y);
    if (left.y <= point.y && right.y > point.y && side > 0) winding += 1;
    else if (left.y > point.y && right.y <= point.y && side < 0) winding -= 1;
  }
  return winding;
}

function fillHasVisibleCoverage(points: readonly ReferenceTracePoint[], fillRule: ReferenceVectorPathFillRule) {
  const maximumMagnitude = Math.max(1, ...points.flatMap((point) => [Math.abs(point.x), Math.abs(point.y)]));
  for (let index = 0; index < points.length; index += 1) {
    const left = points[index]!, right = points[(index + 1) % points.length]!;
    const dx = right.x - left.x, dy = right.y - left.y, length = Math.hypot(dx, dy);
    if (!(length > 0)) continue;
    const middle = { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
    for (const scale of [1e-4, 1e-6, 1e-8, 1e-10, 1e-12]) {
      const distance = Math.max(Number.EPSILON * maximumMagnitude * 32, length * scale);
      for (const direction of [-1, 1]) {
        const candidate = { x: middle.x - direction * dy / length * distance, y: middle.y + direction * dx / length * distance };
        const winding = windingNumber(candidate, points);
        if (fillRule === "nonzero" ? winding !== 0 : Math.abs(winding) % 2 === 1) return true;
      }
    }
  }
  return false;
}

function validateVisibleFill(node: IRNode, geometry: PreparedReferenceTrace, label: string, fillRule: ReferenceVectorPathFillRule) {
  const points = samePoint(geometry.points[0]!, geometry.points.at(-1)!)
    ? geometry.points.slice(0, -1)
    : geometry.points;
  if (points.length < 3 || !fillHasVisibleCoverage(points, fillRule)) {
    fail("CUT_VECTOR_PATH_PAINT", node, `${label} has zero visible coverage under fillRule “${fillRule}” after deterministic flattening`);
  }
}

function color(node: IRNode, value: IRValue | undefined, label: string) {
  if (value?.kind !== "color" || !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/u.test(value.value)) {
    fail("CUT_VECTOR_PATH_PAINT", node, `${label} must be a canonical Color`);
  }
  if (value.value.length === 9 && value.value.slice(7) === "00") {
    fail("CUT_VECTOR_PATH_PAINT", node, `${label} cannot be fully transparent; omit the paint instead`);
  }
  return value.value;
}

function stringEnum<T extends string>(node: IRNode, value: IRValue | undefined, label: string, values: readonly T[], fallback: T) {
  if (value === undefined) return fallback;
  if (value.kind !== "string" || !values.includes(value.value as T)) fail("CUT_VECTOR_PATH_PAINT", node, `${label} must be one of: ${values.join(", ")}`);
  return value.value as T;
}

type SignalValue = { value: IRValue; label: string; allowNull: boolean };

function signalValues(signal: IRSignal): SignalValue[] {
  if (signal.kind === "constant") return [{ value: signal.value, label: ".value", allowNull: false }];
  if (signal.kind === "step") return signal.points.map((point, index) => ({ value: point.value, label: `.points[${index}].value`, allowNull: false }));
  if (signal.kind === "keyframes") return signal.keyframes.map((point, index) => ({ value: point.value, label: `.keyframes[${index}].value`, allowNull: false }));
  return [
    { value: signal.initial, label: ".initial", allowNull: true },
    ...signal.events.flatMap((event, index) => event.kind === "set"
      ? [{ value: event.value, label: `.events[${index}].value`, allowNull: false }]
      : [
        { value: event.from, label: `.events[${index}].from`, allowNull: false },
        { value: event.to, label: `.events[${index}].to`, allowNull: false },
      ]),
  ];
}

function authoredPropertyValues(ir: CutAVIR, node: IRNode, name: string, valueType: "Ratio" | "Length") {
  const property = node.properties[name];
  if (!property) return [];
  if (!("signal" in property)) return [{ value: property, label: `property “${name}”`, allowNull: false }];
  const signal = ir.signals[property.signal];
  if (!signal) fail("CUT_VECTOR_PATH_SIGNAL", node, `property “${name}” references missing signal ${property.signal}`);
  if (signal.valueType !== valueType) fail("CUT_VECTOR_PATH_SIGNAL", node, `property “${name}” signal ${signal.id} must declare valueType ${valueType}`);
  return signalValues(signal).map((item) => ({ ...item, label: `property “${name}” signal ${signal.id}${item.label}` }));
}

function validateRatioProperty(ir: CutAVIR, node: IRNode, name: string) {
  if (node.inputs[name] !== undefined) exactRatio(node, node.inputs[name], `input “${name}”`);
  const values = authoredPropertyValues(ir, node, name, "Ratio");
  values.forEach((item) => exactRatio(node, item.value, item.label, item.allowNull));
  return values;
}

function validateDashOffsetProperty(ir: CutAVIR, node: IRNode) {
  const validate = (value: IRValue, label: string, allowNull: boolean) => {
    if (allowNull && value.kind === "null") return;
    const amount = exactLength(node, value, label, "CUT_VECTOR_PATH_SIGNAL");
    if (Math.abs(amount) > referenceVectorPathLimits.maxAbsoluteDashOffsetPx) {
      fail("CUT_VECTOR_PATH_LIMIT", node, `${label} must remain within ±${referenceVectorPathLimits.maxAbsoluteDashOffsetPx}px`);
    }
  };
  if (node.inputs.dashOffset !== undefined) validate(node.inputs.dashOffset, "input “dashOffset”", false);
  const values = authoredPropertyValues(ir, node, "dashOffset", "Length");
  values.forEach((item) => validate(item.value, item.label, item.allowNull));
  return values;
}

function propertyValue(ir: CutAVIR, node: IRNode, name: string, time: Rational) {
  const value = propertyAt(ir, node, name, time);
  return value?.kind === "null" || value === undefined ? node.inputs[name] : value;
}

function frameRatio(ir: CutAVIR, node: IRNode, name: string, time: Rational, fallback: number) {
  const value = propertyValue(ir, node, name, time);
  return value === undefined ? fallback : exactRatio(node, value, `executed property “${name}”`)!;
}

function frameDashOffset(ir: CutAVIR, node: IRNode, time: Rational) {
  const value = propertyValue(ir, node, "dashOffset", time);
  if (value === undefined) return 0;
  const amount = exactLength(node, value, "executed property “dashOffset”", "CUT_VECTOR_PATH_SIGNAL");
  if (Math.abs(amount) > referenceVectorPathLimits.maxAbsoluteDashOffsetPx) {
    fail("CUT_VECTOR_PATH_LIMIT", node, `executed property “dashOffset” must remain within ±${referenceVectorPathLimits.maxAbsoluteDashOffsetPx}px`);
  }
  return amount;
}

function minimumRational(left: Rational, right: Rational) {
  return compareRational(left, right) <= 0 ? left : right;
}

function maximumRational(left: Rational, right: Rational) {
  return compareRational(left, right) >= 0 ? left : right;
}

function midpoint(left: Rational, right: Rational) {
  return divideRational(addRational(left, right), rational(2));
}

function rationalKey(value: Rational) {
  return `${value.numerator}/${value.denominator}`;
}

/** Exact times at which an attached signal can expose a distinct effective
 * value during this node's half-open active interval. Changes wholly before or
 * after the interval cannot justify an otherwise inert authored control. */
function activeSignalSampleTimes(node: IRNode, signal: IRSignal) {
  const activeStart = node.interval.start;
  const activeEnd = addRational(activeStart, node.interval.duration);
  const samples = new Map<string, Rational>();
  const add = (time: Rational) => {
    if (compareRational(time, activeStart) >= 0 && compareRational(time, activeEnd) < 0) samples.set(rationalKey(time), time);
  };
  add(activeStart);
  if (signal.kind === "step") {
    signal.points.forEach((point) => add(point.time));
  } else if (signal.kind === "keyframes") {
    signal.keyframes.forEach((keyframe) => add(keyframe.time));
    for (let index = 1; index < signal.keyframes.length; index += 1) {
      const left = signal.keyframes[index - 1]!, right = signal.keyframes[index]!;
      const overlapStart = maximumRational(activeStart, left.time);
      const overlapEnd = minimumRational(activeEnd, right.time);
      if (compareRational(overlapStart, overlapEnd) < 0) add(midpoint(overlapStart, overlapEnd));
    }
  } else if (signal.kind === "track") {
    for (const event of signal.events) {
      if (event.kind === "set") add(event.time);
      else {
        const overlapStart = maximumRational(activeStart, event.start);
        const overlapEnd = minimumRational(activeEnd, event.end);
        if (compareRational(overlapStart, overlapEnd) < 0) {
          add(overlapStart);
          add(midpoint(overlapStart, overlapEnd));
          add(event.end);
        }
      }
    }
  }
  return [...samples.values()].sort(compareRational);
}

function activePropertySampleTimes(ir: CutAVIR, node: IRNode, names: readonly string[]) {
  const samples = new Map<string, Rational>();
  samples.set(rationalKey(node.interval.start), node.interval.start);
  for (const name of names) {
    const property = node.properties[name];
    if (!property || !("signal" in property)) continue;
    const signal = ir.signals[property.signal];
    if (!signal) fail("CUT_VECTOR_PATH_SIGNAL", node, `property “${name}” references missing signal ${property.signal}`);
    for (const time of activeSignalSampleTimes(node, signal)) samples.set(rationalKey(time), time);
  }
  return [...samples.values()].sort(compareRational);
}

function intervalOverlapsNode(node: IRNode, start: Rational, end: Rational) {
  const activeEnd = addRational(node.interval.start, node.interval.duration);
  return compareRational(start, activeEnd) < 0 && compareRational(end, node.interval.start) > 0;
}

/** Structural dynamism is intentionally stronger than sampled-value
 * dynamism. A sharply delayed cubicBezier can quantize all preflight probes to
 * its baseline while still changing at a motion-blur shutter subframe. */
function propertyStructurallyDynamic(ir: CutAVIR, node: IRNode, name: string) {
  const property = node.properties[name];
  if (!property || !("signal" in property)) return false;
  const signal = ir.signals[property.signal];
  if (!signal) fail("CUT_VECTOR_PATH_SIGNAL", node, `property “${name}” references missing signal ${property.signal}`);
  const activeStart = node.interval.start, activeEnd = addRational(activeStart, node.interval.duration);
  if (signal.kind === "constant") return false;
  if (signal.kind === "step") {
    const baseline = propertyValue(ir, node, name, activeStart);
    return signal.points.some((point) => compareRational(point.time, activeStart) > 0
      && compareRational(point.time, activeEnd) < 0
      && baseline !== undefined
      && !canonicalIrValuesEqual(point.value, baseline));
  }
  if (signal.kind === "keyframes") {
    return signal.keyframes.slice(1).some((right, index) => {
      const left = signal.keyframes[index]!;
      return intervalOverlapsNode(node, left.time, right.time) && !canonicalIrValuesEqual(left.value, right.value);
    });
  }
  return signal.events.some((event) => event.kind === "animate"
    ? intervalOverlapsNode(node, event.start, event.end) && !canonicalIrValuesEqual(event.from, event.to)
    : compareRational(event.time, activeStart) > 0 && compareRational(event.time, activeEnd) < 0);
}

/** Values that can actually become authoritative inside the Path's active
 * interval. Full authored-value validation is separate and still rejects a
 * malformed dormant signal rather than hiding hostile IR. */
function effectiveActiveStates(
  ir: CutAVIR,
  node: IRNode,
  name: string,
  fallback: number,
  decode: (value: IRValue, label: string, allowNull: boolean) => number | undefined,
) {
  const direct = node.inputs[name];
  const directValue = direct === undefined ? fallback : decode(direct, `input “${name}”`, false)!;
  const property = node.properties[name];
  if (!property) return [directValue];
  if (!("signal" in property)) return [decode(property, `property “${name}”`, false)!];
  const signal = ir.signals[property.signal];
  if (!signal) fail("CUT_VECTOR_PATH_SIGNAL", node, `property “${name}” references missing signal ${property.signal}`);
  return activeSignalSampleTimes(node, signal).map((time) => {
    const value = propertyValue(ir, node, name, time);
    return value === undefined ? fallback : decode(value, `executed property “${name}”`, false)!;
  });
}

function dashPattern(node: IRNode): readonly number[] | undefined {
  const value = node.inputs.dash;
  if (value === undefined) return undefined;
  if (value.kind !== "array" || !value.items.length || value.items.length > referenceVectorPathLimits.maxDashEntries) {
    fail("CUT_VECTOR_PATH_DASH", node, `dash must contain 1 through ${referenceVectorPathLimits.maxDashEntries} positive Length entries`);
  }
  const authored = value.items.map((item, index) => {
    const amount = exactLength(node, item, `dash[${index}]`, "CUT_VECTOR_PATH_DASH");
    if (amount < referenceVectorPathLimits.minDashEntryPx || amount > referenceVectorPathLimits.maxDashEntryPx) {
      fail("CUT_VECTOR_PATH_DASH", node, `dash[${index}] must be from ${referenceVectorPathLimits.minDashEntryPx}px through ${referenceVectorPathLimits.maxDashEntryPx}px`);
    }
    return amount;
  });
  const canonical = authored.length % 2 === 0 ? authored : [...authored, ...authored];
  const period = canonical.reduce((sum, amount) => sum + amount, 0);
  if (!Number.isFinite(period) || period > referenceVectorPathLimits.maxDashPeriodPx) {
    fail("CUT_VECTOR_PATH_LIMIT", node, `canonical dash period exceeds ${referenceVectorPathLimits.maxDashPeriodPx}px`);
  }
  return Object.freeze(canonical);
}

function animatedProperties(node: IRNode) {
  return ["morph", "trimStart", "trimEnd", "dashOffset"].filter((name) => Object.hasOwn(node.properties, name));
}

/** Prepare paint and time controls for a symbolic owner-resolved geometry.
 * Geometry-dependent checks (positive length, visible fill, dash emission)
 * intentionally occur only after the exact owner placements are resolved. */
export function prepareReferenceAnchoredVectorPathNode(
  ir: CutAVIR,
  node: IRNode,
  validatedGeometry?: ReferenceValidatedAnchoredPathGeometry,
): ReferenceAnchoredVectorPathPlan | undefined {
  if (node.op !== "cut.visual.path" || !isReferenceAnchoredPathGeometryValue(node.inputs.geometry)) return undefined;
  const geometry = validatedGeometry ?? decodeReferenceAnchoredPathGeometry(node, node.inputs.geometry, "geometry");
  if (node.inputs.points !== undefined) {
    fail("CUT_VECTOR_PATH_GEOMETRY", node, "cannot combine legacy points with anchored geometry");
  }
  if (node.inputs.morphTo !== undefined || node.inputs.morph !== undefined || node.properties.morph !== undefined) {
    fail("CUT_ANCHORED_PATH_MORPH", node, "AnchoredPathGeometry cannot be combined with morphTo or morph in the v1 owner-resolved slice");
  }

  validateRatioProperty(ir, node, "trimStart");
  validateRatioProperty(ir, node, "trimEnd");
  validateDashOffsetProperty(ir, node);

  const explicitStroke = node.inputs.stroke === undefined ? undefined : color(node, node.inputs.stroke, "stroke");
  const fill = node.inputs.fill === undefined ? undefined : color(node, node.inputs.fill, "fill");
  const stroke = explicitStroke ?? (fill ? undefined : "#ffffff");
  if (fill && !geometry.closed) fail("CUT_VECTOR_PATH_PAINT", node, "fill requires closed anchored geometry");
  if (!stroke && !fill) fail("CUT_VECTOR_PATH_PAINT", node, "requires a visible stroke or fill");

  const strokeControls = ["width", "dash", "dashOffset", "trimStart", "trimEnd", "lineCap", "lineJoin"];
  if (!stroke) {
    const inert = strokeControls.find((name) => node.inputs[name] !== undefined || node.properties[name] !== undefined);
    if (inert) fail("CUT_VECTOR_PATH_PAINT", node, `${inert} requires a visible stroke`);
  }
  const strokeWidth = node.inputs.width === undefined ? 4 : exactLength(node, node.inputs.width, "width", "CUT_VECTOR_PATH_PAINT");
  if (stroke && (strokeWidth <= 0 || strokeWidth > referenceVectorPathLimits.maxStrokeWidth)) {
    fail("CUT_VECTOR_PATH_PAINT", node, `width must be greater than 0px and at most ${referenceVectorPathLimits.maxStrokeWidth}px`);
  }
  const dash = dashPattern(node);
  if (!dash && (node.inputs.dashOffset !== undefined || node.properties.dashOffset !== undefined)) {
    fail("CUT_VECTOR_PATH_DASH", node, "dashOffset requires a dash pattern");
  }
  const dashOffsetStates = effectiveActiveStates(ir, node, "dashOffset", 0, (value, label, allowNull) => {
    if (allowNull && value.kind === "null") return undefined;
    return exactLength(node, value, label, "CUT_VECTOR_PATH_SIGNAL");
  });
  const dashPeriod = dash?.reduce((sum, amount) => sum + amount, 0);
  const canonicalOffsetStates = dashPeriod === undefined
    ? dashOffsetStates
    : dashOffsetStates.map((value) => canonicalDashOffset(value, dashPeriod));
  const dashOffsetStructurallyDynamic = propertyStructurallyDynamic(ir, node, "dashOffset");
  if (dash && !dashOffsetStructurallyDynamic && (node.inputs.dashOffset !== undefined || node.properties.dashOffset !== undefined)
    && canonicalOffsetStates.every((value) => value === 0)) {
    fail("CUT_VECTOR_PATH_DASH", node, `dashOffset is 0px modulo the ${dashPeriod}px canonical dash period for every effective active state and cannot affect pixels`);
  }

  const trimStartStates = effectiveActiveStates(ir, node, "trimStart", 0, (value, label, allowNull) => exactRatio(node, value, label, allowNull));
  const trimEndStates = effectiveActiveStates(ir, node, "trimEnd", 1, (value, label, allowNull) => exactRatio(node, value, label, allowNull));
  const trimStartStructurallyDynamic = propertyStructurallyDynamic(ir, node, "trimStart");
  const trimEndStructurallyDynamic = propertyStructurallyDynamic(ir, node, "trimEnd");
  const trimRangeDynamic = trimStartStructurallyDynamic || trimEndStructurallyDynamic
    || new Set(trimStartStates).size > 1 || new Set(trimEndStates).size > 1;
  const trimStartChanges = trimStartStructurallyDynamic || trimStartStates.some((value) => value !== 0);
  const trimEndChanges = trimEndStructurallyDynamic || trimEndStates.some((value) => value !== 1);
  if ((node.inputs.trimStart !== undefined || node.properties.trimStart !== undefined) && !trimStartChanges) {
    fail("CUT_VECTOR_PATH_TRIM", node, "trimStart remains the 0% default for every effective authored state and cannot affect pixels");
  }
  if ((node.inputs.trimEnd !== undefined || node.properties.trimEnd !== undefined) && !trimEndChanges) {
    fail("CUT_VECTOR_PATH_TRIM", node, "trimEnd remains the 100% default for every effective authored state and cannot affect pixels");
  }
  for (const time of activePropertySampleTimes(ir, node, ["trimStart", "trimEnd"])) {
    const trimStart = frameRatio(ir, node, "trimStart", time, 0), trimEnd = frameRatio(ir, node, "trimEnd", time, 1);
    if (trimStart > trimEnd) fail("CUT_VECTOR_PATH_TRIM", node, `executed trimStart ${trimStart} must not exceed trimEnd ${trimEnd}`);
    if (trimStart === trimEnd && !trimRangeDynamic) {
      fail("CUT_VECTOR_PATH_TRIM", node, `executed trimStart ${trimStart} equals trimEnd ${trimEnd}, permanently collapsing a static stroke`);
    }
  }
  const fillRule = stringEnum(node, node.inputs.fillRule, "fillRule", ["nonzero", "evenodd"] as const, "nonzero");
  if (!fill && node.inputs.fillRule !== undefined) fail("CUT_VECTOR_PATH_PAINT", node, "fillRule requires fill");
  const lineCap = stringEnum(node, node.inputs.lineCap, "lineCap", ["butt", "round", "square"] as const, "round");
  const lineJoin = stringEnum(node, node.inputs.lineJoin, "lineJoin", ["miter", "round", "bevel"] as const, "round");

  return Object.freeze({
    geometryKind: "anchored-v1" as const,
    geometry,
    authoredSegments: geometry.segments.length,
    closed: geometry.closed,
    ...(stroke ? { stroke } : {}),
    ...(fill ? { fill } : {}),
    strokeWidth,
    ...(dash ? { dash } : {}),
    lineCap,
    lineJoin,
    fillRule,
    animatedProperties: Object.freeze(animatedProperties(node)),
    trimRangeDynamic,
    frameDynamic: true as const,
  });
}

export function prepareReferenceVectorPathNode(ir: CutAVIR, node: IRNode): ReferenceVectorPathPlan | undefined {
  if (node.op !== "cut.visual.path") return undefined;
  if (isReferenceAnchoredPathGeometryValue(node.inputs.geometry)) return undefined;
  const hasPoints = node.inputs.points !== undefined, hasGeometry = node.inputs.geometry !== undefined;
  const retainedOnlyControls = [
    "geometry", "morphTo", "morph", "trimStart", "trimEnd", "dash", "dashOffset", "fill", "fillRule", "lineCap", "lineJoin", "x", "y",
  ];
  if (hasPoints) {
    if (hasGeometry) fail("CUT_VECTOR_PATH_GEOMETRY", node, "cannot combine legacy points with retained geometry");
    const retained = retainedOnlyControls.find((name) => name !== "geometry"
      && (node.inputs[name] !== undefined || (!["x", "y"].includes(name) && node.properties[name] !== undefined)));
    if (retained) fail("CUT_VECTOR_PATH_GEOMETRY", node, `${retained} requires retained geometry; legacy points preserve the exact pre-0.4 renderer and cache contract`);
    return undefined;
  }
  if (!hasGeometry) fail("CUT_VECTOR_PATH_GEOMETRY", node, "requires legacy points or retained geometry");
  const source = decodeReferenceVectorPathGeometry(node, node.inputs.geometry, "geometry");
  const target = node.inputs.morphTo === undefined ? undefined : decodeReferenceVectorPathGeometry(node, node.inputs.morphTo, "morphTo");
  if (target) {
    validateMorphTopology(node, source, target);
    if (sameGeometry(source, target)) fail("CUT_VECTOR_PATH_TOPOLOGY", node, "morph source and target are identical and cannot affect pixels");
  }

  validateRatioProperty(ir, node, "morph");
  validateRatioProperty(ir, node, "trimStart");
  validateRatioProperty(ir, node, "trimEnd");
  validateDashOffsetProperty(ir, node);
  const hasMorphControl = node.inputs.morph !== undefined || node.properties.morph !== undefined;
  if (Boolean(target) !== hasMorphControl) {
    fail("CUT_VECTOR_PATH_TOPOLOGY", node, target ? "morphTo requires a morph input or property" : "morph requires morphTo geometry");
  }
  const morphStates = effectiveActiveStates(ir, node, "morph", 0, (value, label, allowNull) => exactRatio(node, value, label, allowNull));
  const morphStructurallyDynamic = propertyStructurallyDynamic(ir, node, "morph");
  if (target && !morphStructurallyDynamic && morphStates.every((value) => value === 0)) {
    fail("CUT_VECTOR_PATH_TOPOLOGY", node, "morph remains 0% for every effective authored state, so morphTo cannot affect pixels");
  }
  if (target && !morphStructurallyDynamic && morphStates.every((value) => value === 1)) {
    fail("CUT_VECTOR_PATH_TOPOLOGY", node, "morph remains 100% for every effective authored state and permanently discards the source geometry");
  }

  // Explicit transparent paint is always diagnosed before geometry-dependent
  // paint checks. A transparent accepted argument may never disappear behind
  // an independently visible sibling paint.
  const explicitStroke = node.inputs.stroke === undefined ? undefined : color(node, node.inputs.stroke, "stroke");
  const fill = node.inputs.fill === undefined ? undefined : color(node, node.inputs.fill, "fill");
  const stroke = explicitStroke ?? (fill ? undefined : "#ffffff");
  if (fill && !source.closed) fail("CUT_VECTOR_PATH_PAINT", node, "fill requires closed retained geometry");
  if (fill && target && !target.closed) fail("CUT_VECTOR_PATH_PAINT", node, "a filled morph target must remain closed");
  if (!stroke && !fill) fail("CUT_VECTOR_PATH_PAINT", node, "requires a visible stroke or fill");

  const strokeControls = ["width", "dash", "dashOffset", "trimStart", "trimEnd", "lineCap", "lineJoin"];
  if (!stroke) {
    const inert = strokeControls.find((name) => node.inputs[name] !== undefined || node.properties[name] !== undefined);
    if (inert) fail("CUT_VECTOR_PATH_PAINT", node, `${inert} requires a visible stroke`);
  }
  const strokeWidth = node.inputs.width === undefined ? 4 : exactLength(node, node.inputs.width, "width", "CUT_VECTOR_PATH_PAINT");
  if (stroke && (strokeWidth <= 0 || strokeWidth > referenceVectorPathLimits.maxStrokeWidth)) {
    fail("CUT_VECTOR_PATH_PAINT", node, `width must be greater than 0px and at most ${referenceVectorPathLimits.maxStrokeWidth}px`);
  }
  const dash = dashPattern(node);
  if (!dash && (node.inputs.dashOffset !== undefined || node.properties.dashOffset !== undefined)) {
    fail("CUT_VECTOR_PATH_DASH", node, "dashOffset requires a dash pattern");
  }
  const dashOffsetStates = effectiveActiveStates(ir, node, "dashOffset", 0, (value, label, allowNull) => {
    if (allowNull && value.kind === "null") return undefined;
    return exactLength(node, value, label, "CUT_VECTOR_PATH_SIGNAL");
  });
  const dashPeriod = dash?.reduce((sum, amount) => sum + amount, 0);
  const canonicalOffsetStates = dashPeriod === undefined
    ? dashOffsetStates
    : dashOffsetStates.map((value) => canonicalDashOffset(value, dashPeriod));
  const dashOffsetStructurallyDynamic = propertyStructurallyDynamic(ir, node, "dashOffset");
  if (dash && !dashOffsetStructurallyDynamic && (node.inputs.dashOffset !== undefined || node.properties.dashOffset !== undefined)
    && canonicalOffsetStates.every((value) => value === 0)) {
    fail("CUT_VECTOR_PATH_DASH", node, `dashOffset is 0px modulo the ${dashPeriod}px canonical dash period for every effective active state and cannot affect pixels`);
  }

  const trimStartStates = effectiveActiveStates(ir, node, "trimStart", 0, (value, label, allowNull) => exactRatio(node, value, label, allowNull));
  const trimEndStates = effectiveActiveStates(ir, node, "trimEnd", 1, (value, label, allowNull) => exactRatio(node, value, label, allowNull));
  const trimStartStructurallyDynamic = propertyStructurallyDynamic(ir, node, "trimStart");
  const trimEndStructurallyDynamic = propertyStructurallyDynamic(ir, node, "trimEnd");
  const trimRangeDynamic = trimStartStructurallyDynamic || trimEndStructurallyDynamic
    || new Set(trimStartStates).size > 1 || new Set(trimEndStates).size > 1;
  const trimStartChanges = trimStartStructurallyDynamic || trimStartStates.some((value) => value !== 0);
  const trimEndChanges = trimEndStructurallyDynamic || trimEndStates.some((value) => value !== 1);
  if ((node.inputs.trimStart !== undefined || node.properties.trimStart !== undefined) && !trimStartChanges) {
    fail("CUT_VECTOR_PATH_TRIM", node, "trimStart remains the 0% default for every effective authored state and cannot affect pixels");
  }
  if ((node.inputs.trimEnd !== undefined || node.properties.trimEnd !== undefined) && !trimEndChanges) {
    fail("CUT_VECTOR_PATH_TRIM", node, "trimEnd remains the 100% default for every effective authored state and cannot affect pixels");
  }
  const fillRule = stringEnum(node, node.inputs.fillRule, "fillRule", ["nonzero", "evenodd"] as const, "nonzero");
  if (!fill && node.inputs.fillRule !== undefined) fail("CUT_VECTOR_PATH_PAINT", node, "fillRule requires fill");
  const lineCap = stringEnum(node, node.inputs.lineCap, "lineCap", ["butt", "round", "square"] as const, "round");
  const lineJoin = stringEnum(node, node.inputs.lineJoin, "lineJoin", ["miter", "round", "bevel"] as const, "round");

  const sourcePrepared = prepareReferenceVectorPathGeometry(node, source);
  const targetPrepared = target ? prepareReferenceVectorPathGeometry(node, target) : undefined;
  const morphDynamic = morphStructurallyDynamic || new Set(morphStates).size > 1;
  const staticPrepared = target && !morphDynamic
    ? prepareReferenceVectorPathGeometry(node, interpolateGeometry(source, target, morphStates[0]))
    : sourcePrepared;
  if (fill) {
    validateVisibleFill(node, sourcePrepared, "fill source geometry", fillRule);
    if (targetPrepared) validateVisibleFill(node, targetPrepared, "fill target geometry", fillRule);
    validateVisibleFill(node, staticPrepared, "executed static fill geometry", fillRule);
  }
  const frameDynamic = morphDynamic
    || trimStartStructurallyDynamic || trimEndStructurallyDynamic || dashOffsetStructurallyDynamic
    || new Set(trimStartStates).size > 1
    || new Set(trimEndStates).size > 1
    || new Set(canonicalOffsetStates).size > 1;
  const plan = Object.freeze({
    geometryKind: "retained" as const,
    source,
    ...(target ? { target } : {}),
    sourcePrepared,
    ...(targetPrepared ? { targetPrepared } : {}),
    staticPrepared,
    morphDynamic,
    ...(stroke ? { stroke } : {}),
    ...(fill ? { fill } : {}),
    strokeWidth,
    ...(dash ? { dash } : {}),
    lineCap,
    lineJoin,
    fillRule,
    animatedProperties: Object.freeze(animatedProperties(node)),
    trimRangeDynamic,
    frameDynamic,
  });
  // Exercise each semantically relevant in-interval signal state before any
  // renderer allocation. This closes static zero-visible strokes, collapsed
  // morph fills, and crossed trim failures while admitting an explicit equal
  // boundary only for a genuinely dynamic trim. Runtime evaluation repeats
  // the checks for every exact frame/shutter sample; composition preflight
  // separately proves later visibility on the exact output-frame clock.
  for (const time of activePropertySampleTimes(ir, node, ["morph", "trimStart", "trimEnd", "dashOffset"])) {
    referenceVectorPathFrameAt(ir, node, plan, time);
  }
  return plan;
}

function pointAtDistance(trace: PreparedReferenceTrace, distance: number) {
  const bounded = Math.max(0, Math.min(trace.totalLength, distance));
  if (bounded <= 0) return { point: trace.points[0], endIndex: 1 };
  if (bounded >= trace.totalLength) return { point: trace.points.at(-1)!, endIndex: trace.points.length - 1 };
  let lower = 1, upper = trace.cumulativeLengths.length - 1;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (trace.cumulativeLengths[middle] >= bounded) upper = middle;
    else lower = middle + 1;
  }
  const endIndex = lower, startIndex = endIndex - 1;
  const startLength = trace.cumulativeLengths[startIndex], endLength = trace.cumulativeLengths[endIndex];
  const progress = endLength === startLength ? 1 : (bounded - startLength) / (endLength - startLength);
  const start = trace.points[startIndex], end = trace.points[endIndex];
  return { point: interpolatePoint(start, end, progress), endIndex };
}

export function referenceVectorPathSlice(trace: PreparedReferenceTrace, startDistance: number, endDistance: number) {
  const start = Math.max(0, Math.min(trace.totalLength, startDistance));
  const end = Math.max(start, Math.min(trace.totalLength, endDistance));
  const first = pointAtDistance(trace, start), last = pointAtDistance(trace, end);
  const points: ReferenceTracePoint[] = [];
  const push = (point: ReferenceTracePoint) => {
    if (!points.length || !samePoint(points.at(-1)!, point)) points.push({ ...point });
  };
  push(first.point);
  for (let index = first.endIndex; index < last.endIndex; index += 1) push(trace.points[index]!);
  push(last.point);
  if (points.length === 1) points.push({ ...last.point });
  return points;
}

function positiveModulo(value: number, divisor: number) {
  return ((value % divisor) + divisor) % divisor;
}

function canonicalDashOffset(value: number, period: number) {
  const canonical = positiveModulo(value, period);
  const tolerance = Math.max(1, period) * Number.EPSILON * 16;
  return canonical <= tolerance || period - canonical <= tolerance ? 0 : canonical;
}

function polylineLength(points: readonly ReferenceTracePoint[]) {
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    const left = points[index - 1]!, right = points[index]!;
    length += Math.hypot(right.x - left.x, right.y - left.y);
  }
  return length;
}

type MutableStrokeFragment = { points: ReferenceTracePoint[]; closed: boolean; start: number; end: number };

function referenceVectorPathStrokeFragments(
  node: IRNode,
  trace: PreparedReferenceTrace,
  trimStart: number,
  trimEnd: number,
  dash: readonly number[] | undefined,
  dashOffset: number,
  closed: boolean,
): ReferenceVectorPathStrokeFragment[] {
  const start = trace.totalLength * trimStart, end = trace.totalLength * trimEnd;
  const fullClosed = closed && trimStart === 0 && trimEnd === 1;
  if (!dash) return [{
    // A complete undashed stroke is exactly the immutable prepared trace.
    // Share it instead of cloning every point on every frame; partial trims
    // still own their interpolated slice and all published state stays frozen.
    points: start === 0 && end === trace.totalLength
      ? trace.points
      : referenceVectorPathSlice(trace, start, end),
    closed: fullClosed,
  }];
  const period = dash.reduce((sum, amount) => sum + amount, 0);
  let phase = positiveModulo(start + canonicalDashOffset(dashOffset, period), period), patternIndex = 0;
  while (phase >= dash[patternIndex]!) {
    phase -= dash[patternIndex]!;
    patternIndex = (patternIndex + 1) % dash.length;
  }
  let remaining = dash[patternIndex]! - phase, cursor = start;
  const result: MutableStrokeFragment[] = [];
  while (cursor < end) {
    const next = Math.min(end, cursor + remaining);
    if (patternIndex % 2 === 0 && next > cursor) {
      result.push({ points: referenceVectorPathSlice(trace, cursor, next), closed: false, start: cursor, end: next });
    }
    if (result.length > referenceVectorPathLimits.maxDashFragmentsPerFrame) {
      fail("CUT_VECTOR_PATH_LIMIT", node, `dash creates more than ${referenceVectorPathLimits.maxDashFragmentsPerFrame} visible fragments in one frame`);
    }
    cursor = next;
    patternIndex = (patternIndex + 1) % dash.length;
    remaining = dash[patternIndex]!;
  }
  if (fullClosed && result.length === 1 && result[0]!.start === 0 && result[0]!.end === trace.totalLength) {
    result[0]!.closed = true;
  } else if (fullClosed && result.length > 1 && result[0]!.start === 0 && result.at(-1)!.end === trace.totalLength) {
    const first = result.shift()!, last = result.pop()!;
    const points = [...last.points];
    for (const point of first.points) {
      if (!samePoint(points.at(-1)!, point)) points.push({ ...point });
    }
    result.unshift({ points, closed: false, start: last.start, end: first.end });
  }
  return result.map(({ points, closed: fragmentClosed }) => ({ points, closed: fragmentClosed }));
}

export function referenceVectorPathDashPolylines(
  node: IRNode,
  trace: PreparedReferenceTrace,
  trimStart: number,
  trimEnd: number,
  dash: readonly number[] | undefined,
  dashOffset: number,
  closed = false,
) {
  return referenceVectorPathStrokeFragments(node, trace, trimStart, trimEnd, dash, dashOffset, closed).map((fragment) => fragment.points);
}

function computeReferenceVectorPathFrame(
  ir: CutAVIR,
  node: IRNode,
  plan: ReferenceVectorPathPlan,
  time: Rational,
  immutable: boolean,
): ReferenceVectorPathFrame {
  const morph = frameRatio(ir, node, "morph", time, 0);
  const trimStart = frameRatio(ir, node, "trimStart", time, 0);
  const trimEnd = frameRatio(ir, node, "trimEnd", time, 1);
  const rawDashOffset = frameDashOffset(ir, node, time);
  const dashPeriod = plan.dash?.reduce((sum, amount) => sum + amount, 0);
  const dashOffset = dashPeriod === undefined ? rawDashOffset : canonicalDashOffset(rawDashOffset, dashPeriod);
  if (trimStart > trimEnd) fail("CUT_VECTOR_PATH_TRIM", node, `executed trimStart ${trimStart} must not exceed trimEnd ${trimEnd}`);
  const zeroLengthTrim = trimStart === trimEnd;
  if (zeroLengthTrim && !plan.trimRangeDynamic) {
    fail("CUT_VECTOR_PATH_TRIM", node, `executed trimStart ${trimStart} equals trimEnd ${trimEnd}, permanently collapsing a static stroke`);
  }
  let geometry = plan.staticPrepared;
  if (plan.target && plan.morphDynamic) {
    try { geometry = prepareReferenceVectorPathGeometry(node, interpolateGeometry(plan.source, plan.target, morph)); }
    catch (error) {
      if (error instanceof ReferenceVectorPathError) throw error;
      fail("CUT_VECTOR_PATH_LIMIT", node, error instanceof Error ? error.message : String(error));
    }
  }
  if (plan.fill) validateVisibleFill(node, geometry, "executed fill geometry", plan.fillRule);
  const strokeFragments = plan.stroke && !zeroLengthTrim
    ? referenceVectorPathStrokeFragments(node, geometry, trimStart, trimEnd, plan.dash, dashOffset, plan.source.closed)
    : [];
  if (plan.stroke && !zeroLengthTrim && !strokeFragments.some((fragment) => polylineLength(fragment.points) > 1e-8)) {
    fail("CUT_VECTOR_PATH_DASH", node, "executed trim/dash state emits no positive-length visible stroke fragment");
  }
  const emittedPoints = strokeFragments.reduce((sum, fragment) => sum + fragment.points.length, 0)
    + (plan.fill ? Math.max(0, geometry.points.length - 1) : 0);
  if (strokeFragments.length > referenceVectorPathLimits.maxDashFragmentsPerFrame) {
    fail("CUT_VECTOR_PATH_LIMIT", node, `executed state exceeds ${referenceVectorPathLimits.maxDashFragmentsPerFrame} SVG stroke fragments`);
  }
  if (emittedPoints > referenceVectorPathLimits.maxSvgPointsPerFrame) {
    fail("CUT_VECTOR_PATH_LIMIT", node, `executed state exceeds ${referenceVectorPathLimits.maxSvgPointsPerFrame} emitted SVG points`);
  }
  const fillPoints = plan.source.closed ? geometry.points.slice(0, -1) : geometry.points;
  const visibility = plan.fill || strokeFragments.length ? "visible" : "transparent-trim";
  // Stroke-fragment construction owns these arrays and points exclusively.
  // Published frame state freezes one representation and lets the legacy
  // projection share it. Bounded preflight consumes only counts, so it keeps
  // the same exact geometry/dash checks without freezing throwaway objects.
  const finalStrokeFragments: readonly ReferenceVectorPathStrokeFragment[] = immutable
    ? Object.freeze(strokeFragments.map((fragment) => {
      for (const point of fragment.points) Object.freeze(point);
      return Object.freeze({
        points: Object.freeze(fragment.points),
        closed: fragment.closed,
      });
    }))
    : strokeFragments;
  const frameState: ReferenceVectorPathFrame = {
    geometry,
    morph,
    trimStart,
    trimEnd,
    dashOffset,
    strokeFragments: finalStrokeFragments,
    strokePolylines: immutable
      ? Object.freeze(finalStrokeFragments.map((fragment) => fragment.points))
      : finalStrokeFragments.map((fragment) => fragment.points),
    fillPoints: immutable ? Object.freeze(fillPoints) : fillPoints,
    ...(plan.stroke ? { stroke: plan.stroke } : {}),
    ...(plan.fill ? { fill: plan.fill } : {}),
    strokeWidth: plan.strokeWidth,
    lineCap: plan.lineCap,
    lineJoin: plan.lineJoin,
    fillRule: plan.fillRule,
    visibility,
  };
  return immutable ? Object.freeze(frameState) : frameState;
}

function referenceVectorPathFrameAtMode(
  ir: CutAVIR,
  node: IRNode,
  plan: ReferenceVectorPathPlan,
  time: Rational,
  frame: bigint | undefined,
  immutable: boolean,
): ReferenceVectorPathFrame {
  try {
    return computeReferenceVectorPathFrame(ir, node, plan, time, immutable);
  } catch (error) {
    if (error instanceof ReferenceVectorPathError && !error.execution) {
      throw new ReferenceVectorPathError(error.code, node, error.detail, { time, ...(frame === undefined ? {} : { frame }) });
    }
    throw error;
  }
}

export function referenceVectorPathFrameAt(
  ir: CutAVIR,
  node: IRNode,
  plan: ReferenceVectorPathPlan,
  time: Rational,
  frame?: bigint,
): ReferenceVectorPathFrame {
  return referenceVectorPathFrameAtMode(ir, node, plan, time, frame, true);
}

/** Renderer-internal evaluation of the same exact frame law without publishing
 * or recursively freezing its short-lived arrays. The returned state is owned
 * by one render call and must never be cached, exposed as evidence, or mutated. */
export function referenceVectorPathRenderFrameAt(
  ir: CutAVIR,
  node: IRNode,
  plan: ReferenceVectorPathPlan,
  time: Rational,
  frame?: bigint,
): ReferenceVectorPathFrame {
  return referenceVectorPathFrameAtMode(ir, node, plan, time, frame, false);
}

/** Resolve symbolic owner-local points first, then execute the established
 * retained Path paint kernel against that exact numeric geometry. A tracking
 * hide policy is a first-class non-error result and suppresses all paint. */
export function referenceAnchoredVectorPathFrameResolutionAt(
  ir: CutAVIR,
  node: IRNode,
  plan: ReferenceAnchoredVectorPathPlan,
  time: Rational,
  resolveOwner: ReferenceAnchoredPathOwnerResolver,
  frame?: bigint,
): ReferenceAnchoredVectorPathFrameResolution {
  if (node.op !== "cut.visual.path") fail("CUT_VECTOR_PATH_GEOMETRY", node, "cannot execute anchored geometry for a different kernel");
  if (!isReferenceAnchoredPathGeometryValue(node.inputs.geometry)) {
    fail("CUT_VECTOR_PATH_GEOMETRY", node, "anchored execution requires a canonical AnchoredPathGeometry call");
  }
  if (!("validationIdentity" in plan.geometry)) {
    fail("CUT_ANCHORED_PATH_VALIDATION", node, "anchored execution requires the validated same-composition owner/LocalSpace graph plan");
  }
  const anchored = resolveReferenceAnchoredPathGeometryAt(node, plan.geometry, time, resolveOwner, frame);
  if (anchored.status === "policy-hidden") {
    return Object.freeze({ status: "policy-hidden" as const, executionIdentity: anchored.executionIdentity, anchored });
  }
  const sourcePrepared = prepareReferenceVectorPathGeometry(node, anchored.geometry);
  const executable: ReferenceVectorPathPlan = Object.freeze({
    geometryKind: "retained" as const,
    source: anchored.geometry,
    sourcePrepared,
    staticPrepared: sourcePrepared,
    morphDynamic: false,
    ...(plan.stroke ? { stroke: plan.stroke } : {}),
    ...(plan.fill ? { fill: plan.fill } : {}),
    strokeWidth: plan.strokeWidth,
    ...(plan.dash ? { dash: plan.dash } : {}),
    lineCap: plan.lineCap,
    lineJoin: plan.lineJoin,
    fillRule: plan.fillRule,
    animatedProperties: plan.animatedProperties,
    trimRangeDynamic: plan.trimRangeDynamic,
    frameDynamic: true,
  });
  const rendered = referenceVectorPathFrameAt(ir, node, executable, time, frame);
  return Object.freeze({
    status: "resolved" as const,
    frame: rendered,
    geometryIdentity: anchored.geometryIdentity,
    executionIdentity: anchored.executionIdentity,
    anchored,
  });
}

function svgNumber(value: number) {
  const normalized = Object.is(value, -0) ? 0 : value;
  return Number.isInteger(normalized) ? String(normalized) : normalized.toFixed(9).replace(/0+$/u, "").replace(/\.$/u, "");
}

function svgPoints(points: readonly ReferenceTracePoint[]) {
  return points.map((point) => `${svgNumber(point.x)},${svgNumber(point.y)}`).join(" ");
}

function pointBounds(points: readonly ReferenceTracePoint[]): ReferenceRect {
  if (!points.length) throw new Error("CUT retained Path visible bounds require at least one emitted point.");
  let minX = points[0]!.x, minY = points[0]!.y, maxX = minX, maxY = minY;
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index]!;
    minX = Math.min(minX, point.x); minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y);
  }
  return referenceRect(minX, minY, maxX, maxY);
}

/** Conservative visible bounds for the already-trimmed/dashed frame. Arc
 * length has been resolved in Path-local space before this affine is applied. */
export function referenceVectorPathVisibleBounds(frame: ReferenceVectorPathFrame, affine: ReferenceAffine2D): ReferenceRect | undefined {
  const bounds: ReferenceRect[] = [];
  if (frame.fill && frame.fillPoints.length) bounds.push(expandReferenceRect(transformReferenceRect(pointBounds(frame.fillPoints), affine), 1));
  if (frame.stroke && frame.strokeFragments.length) {
    const centerline = unionReferenceRects(frame.strokeFragments.map((fragment) => pointBounds(fragment.points)));
    bounds.push(referenceConservativeStrokeBounds(centerline, affine, {
      width: frame.strokeWidth,
      lineCap: frame.lineCap,
      lineJoin: frame.lineJoin,
      miterLimit: 4,
      antialiasGuard: 1,
    }));
  }
  if (!bounds.length) return undefined;
  return unionReferenceRects(bounds);
}

function referenceVectorPathMarkup(frame: ReferenceVectorPathFrame) {
  const fill = frame.fill
    ? `<path d="M ${svgPoints(frame.fillPoints)} Z" fill="${frame.fill}" fill-rule="${frame.fillRule}"/>`
    : "";
  const stroke = frame.stroke
    ? `<g fill="none" stroke="${frame.stroke}" stroke-width="${svgNumber(frame.strokeWidth)}" stroke-linecap="${frame.lineCap}" stroke-linejoin="${frame.lineJoin}" stroke-miterlimit="4">${frame.strokeFragments.map((fragment) => fragment.closed ? `<path d="M ${svgPoints(fragment.points.slice(0, -1))} Z"/>` : `<polyline points="${svgPoints(fragment.points)}"/>`).join("")}</g>`
    : "";
  return `${fill}${stroke}`;
}

function validateSvgBytes(svg: string, node?: IRNode) {
  if (node && Buffer.byteLength(svg, "utf8") > referenceVectorPathLimits.maxSvgBytesPerFrame) {
    fail("CUT_VECTOR_PATH_LIMIT", node, `executed state exceeds ${referenceVectorPathLimits.maxSvgBytesPerFrame} emitted SVG bytes`);
  }
  return svg;
}

/**
 * Produce a closed normalized SVG surface description. CUT has already owned
 * topology, morph interpolation, cubic flattening, arc-length trim, and dash
 * segmentation; the low-level SVG rasterizer receives only explicit geometry.
 */
export function referenceVectorPathSvg(frame: ReferenceVectorPathFrame, width: number, height: number, node?: IRNode) {
  return validateSvgBytes(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${referenceVectorPathMarkup(frame)}</svg>`, node);
}

/** One final-space vector raster description for a tight integer viewport. */
export function referenceVectorPathTransformedSvg(
  frame: ReferenceVectorPathFrame,
  bounds: ReferenceIntegerRasterBounds,
  affine: ReferenceAffine2D,
  opacity: number,
  node?: IRNode,
) {
  const matrix = [affine.a, affine.b, affine.c, affine.d, affine.tx, affine.ty].map(svgNumber).join(" ");
  const viewBox = [bounds.left, bounds.top, bounds.width, bounds.height].map(svgNumber).join(" ");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${bounds.width}" height="${bounds.height}" viewBox="${viewBox}" preserveAspectRatio="none"><g transform="matrix(${matrix})" opacity="${svgNumber(opacity)}">${referenceVectorPathMarkup(frame)}</g></svg>`;
  return validateSvgBytes(svg, node);
}

function activeFrameSpan(node: IRNode, composition: IRComposition) {
  const start = multiplyRational(node.interval.start, composition.fps);
  const end = multiplyRational(addRational(node.interval.start, node.interval.duration), composition.fps);
  if (start.denominator !== "1" || end.denominator !== "1") {
    fail("CUT_VECTOR_PATH_LIMIT", node, "active interval must land on exact composition frame boundaries");
  }
  return { first: BigInt(start.numerator), end: BigInt(end.numerator) };
}

/** Preflight every output-frame state, including independent trim tracks and
 * spring/cubic-Bezier overshoot, before a renderer allocates pixel surfaces. */
export type ReferenceVectorPathWork = Readonly<{
  authoredSegmentFrames: number;
  flattenedPointFrames: number;
  visibleFragmentFrames: number;
  visiblePaintFrames: number;
  transparentTrimFrames: number;
}>;

export function validateReferenceVectorPathFrameStates(ir: CutAVIR, composition: IRComposition, node: IRNode, plan: ReferenceVectorPathPlan) {
  const span = activeFrameSpan(node, composition), frames = span.end - span.first;
  if (plan.frameDynamic && frames > BigInt(referenceVectorPathLimits.maxDynamicPreflightFrames)) {
    fail("CUT_VECTOR_PATH_LIMIT", node, `dynamic preflight requires ${frames} output-frame samples, exceeding the ${referenceVectorPathLimits.maxDynamicPreflightFrames}-sample bound`);
  }
  const authoredSegments = BigInt(plan.source.segments.length + (plan.target?.segments.length ?? 0));
  const authoredSegmentFrames = authoredSegments * frames;
  if (authoredSegmentFrames > BigInt(referenceVectorPathLimits.maxAuthoredSegmentFramesPerNode)) {
    fail("CUT_VECTOR_PATH_LIMIT", node, `authored segment-frame work exceeds ${referenceVectorPathLimits.maxAuthoredSegmentFramesPerNode}`);
  }

  let flattenedPointFrames = 0n, visibleFragmentFrames = 0n, visiblePaintFrames = 0n, transparentTrimFrames = 0n;
  const charge = (state: ReferenceVectorPathFrame, count: bigint) => {
    flattenedPointFrames += BigInt(state.geometry.points.length) * count;
    visibleFragmentFrames += BigInt(state.strokePolylines.length) * count;
    if (state.visibility === "visible") visiblePaintFrames += count;
    else transparentTrimFrames += count;
    if (flattenedPointFrames > BigInt(referenceVectorPathLimits.maxFlattenedPointFramesPerNode)) {
      fail("CUT_VECTOR_PATH_LIMIT", node, `flattened point-frame work exceeds ${referenceVectorPathLimits.maxFlattenedPointFramesPerNode}`);
    }
    if (visibleFragmentFrames > BigInt(referenceVectorPathLimits.maxVisibleFragmentFramesPerNode)) {
      fail("CUT_VECTOR_PATH_LIMIT", node, `visible dash-fragment-frame work exceeds ${referenceVectorPathLimits.maxVisibleFragmentFramesPerNode}`);
    }
  };

  // Static retained paths receive an O(1) exact work check. Dynamic property
  // tracks must be sampled at every actual output frame because morph
  // flattening and dash fragmentation can vary non-monotonically.
  if (!plan.frameDynamic) {
    charge(referenceVectorPathFrameAtMode(
      ir,
      node,
      plan,
      divideRational(rational(span.first), composition.fps),
      span.first,
      false,
    ), frames);
  } else {
    for (let frame = span.first; frame < span.end; frame += 1n) {
      const time = divideRational(rational(frame), composition.fps);
      charge(referenceVectorPathFrameAtMode(ir, node, plan, time, frame, false), 1n);
    }
  }
  if (visiblePaintFrames === 0n) {
    fail(
      "CUT_VECTOR_PATH_TRIM",
      node,
      `dynamic trim is zero-length at all ${frames} exact active output frames, so the Path is permanently invisible on the output frame clock`,
    );
  }
  return Object.freeze({
    authoredSegmentFrames: Number(authoredSegmentFrames),
    flattenedPointFrames: Number(flattenedPointFrames),
    visibleFragmentFrames: Number(visibleFragmentFrames),
    visiblePaintFrames: Number(visiblePaintFrames),
    transparentTrimFrames: Number(transparentTrimFrames),
  }) satisfies ReferenceVectorPathWork;
}

export type ReferenceAnchoredVectorPathStructuralWork = Readonly<{
  authoredSegmentFrames: number;
  spatialPointFrames: number;
  ownerSampleFrames: number;
  activeFrames: number;
}>;

export type ReferenceAnchoredVectorPathWork = ReferenceVectorPathWork & ReferenceAnchoredVectorPathStructuralWork & Readonly<{
  resolvedFrames: number;
  policyHiddenFrames: number;
}>;

/** Establish the owner-independent bound during ordinary IR validation. The
 * exact flattened/paint work is deliberately not fabricated here; it is
 * established by the resolver-aware preflight below before pixel allocation. */
export function validateReferenceAnchoredVectorPathStructuralWork(
  composition: IRComposition,
  node: IRNode,
  plan: ReferenceAnchoredVectorPathPlan,
): ReferenceAnchoredVectorPathStructuralWork {
  const span = activeFrameSpan(node, composition), frames = span.end - span.first;
  if (frames > BigInt(referenceVectorPathLimits.maxDynamicPreflightFrames)) {
    fail("CUT_VECTOR_PATH_LIMIT", node, `anchored preflight requires ${frames} output-frame samples, exceeding the ${referenceVectorPathLimits.maxDynamicPreflightFrames}-sample bound`);
  }
  const authoredSegmentFrames = BigInt(plan.authoredSegments) * frames;
  if (authoredSegmentFrames > BigInt(referenceVectorPathLimits.maxAuthoredSegmentFramesPerNode)) {
    fail("CUT_VECTOR_PATH_LIMIT", node, `authored segment-frame work exceeds ${referenceVectorPathLimits.maxAuthoredSegmentFramesPerNode}`);
  }
  const spatialPointFrames = BigInt(plan.geometry.spatialPointCount) * frames;
  if (spatialPointFrames > BigInt(referenceVectorPathLimits.maxAnchoredSpatialPointFramesPerNode)) {
    fail("CUT_VECTOR_PATH_LIMIT", node, `anchored spatial-point-frame work exceeds ${referenceVectorPathLimits.maxAnchoredSpatialPointFramesPerNode}`);
  }
  const ownerSampleFrames = BigInt(plan.geometry.ownerNodeIds.length) * frames;
  if (ownerSampleFrames > BigInt(referenceVectorPathLimits.maxAnchoredOwnerSampleFramesPerNode)) {
    fail("CUT_VECTOR_PATH_LIMIT", node, `anchored owner-sample-frame work exceeds ${referenceVectorPathLimits.maxAnchoredOwnerSampleFramesPerNode}`);
  }
  return Object.freeze({
    authoredSegmentFrames: Number(authoredSegmentFrames),
    spatialPointFrames: Number(spatialPointFrames),
    ownerSampleFrames: Number(ownerSampleFrames),
    activeFrames: Number(frames),
  });
}

/** Resolve and charge every exact output frame before the renderer allocates a
 * dependent pixel surface. Hidden tracking-policy frames are zero geometry
 * work; resolved frames pay their real flattened/dash/fill work. */
export function validateReferenceAnchoredVectorPathFrameStates(
  ir: CutAVIR,
  composition: IRComposition,
  node: IRNode,
  plan: ReferenceAnchoredVectorPathPlan,
  resolveOwner: ReferenceAnchoredPathOwnerResolver,
): ReferenceAnchoredVectorPathWork {
  const span = activeFrameSpan(node, composition), structural = validateReferenceAnchoredVectorPathStructuralWork(composition, node, plan);
  let flattenedPointFrames = 0n, visibleFragmentFrames = 0n, visiblePaintFrames = 0n, transparentTrimFrames = 0n;
  let resolvedFrames = 0n, policyHiddenFrames = 0n;
  for (let frame = span.first; frame < span.end; frame += 1n) {
    const time = divideRational(rational(frame), composition.fps);
    const resolution = referenceAnchoredVectorPathFrameResolutionAt(ir, node, plan, time, resolveOwner, frame);
    if (resolution.status === "policy-hidden") {
      policyHiddenFrames += 1n;
      continue;
    }
    resolvedFrames += 1n;
    const state = resolution.frame;
    flattenedPointFrames += BigInt(state.geometry.points.length);
    visibleFragmentFrames += BigInt(state.strokePolylines.length);
    if (state.visibility === "visible") visiblePaintFrames += 1n;
    else transparentTrimFrames += 1n;
    if (flattenedPointFrames > BigInt(referenceVectorPathLimits.maxFlattenedPointFramesPerNode)) {
      fail("CUT_VECTOR_PATH_LIMIT", node, `anchored flattened point-frame work exceeds ${referenceVectorPathLimits.maxFlattenedPointFramesPerNode}`);
    }
    if (visibleFragmentFrames > BigInt(referenceVectorPathLimits.maxVisibleFragmentFramesPerNode)) {
      fail("CUT_VECTOR_PATH_LIMIT", node, `anchored visible dash-fragment-frame work exceeds ${referenceVectorPathLimits.maxVisibleFragmentFramesPerNode}`);
    }
  }
  if (resolvedFrames > 0n && visiblePaintFrames === 0n) {
    fail(
      "CUT_VECTOR_PATH_TRIM",
      node,
      `anchored trim is zero-length at all ${resolvedFrames} resolved output frames; ${policyHiddenFrames} additional frames were suppressed by owner policy`,
    );
  }
  return Object.freeze({
    authoredSegmentFrames: structural.authoredSegmentFrames,
    spatialPointFrames: structural.spatialPointFrames,
    ownerSampleFrames: structural.ownerSampleFrames,
    activeFrames: structural.activeFrames,
    flattenedPointFrames: Number(flattenedPointFrames),
    visibleFragmentFrames: Number(visibleFragmentFrames),
    visiblePaintFrames: Number(visiblePaintFrames),
    transparentTrimFrames: Number(transparentTrimFrames),
    resolvedFrames: Number(resolvedFrames),
    policyHiddenFrames: Number(policyHiddenFrames),
  });
}

/** Combined structural cap used before owner sampling so anchored Paths cannot
 * evade the composition-wide authored-segment budget. */
export function validateReferenceVectorPathCompositionAuthoredWork(
  nodeWork: readonly { node: IRNode; authoredSegmentFrames: number }[],
) {
  const total = nodeWork.reduce((sum, item) => sum + item.authoredSegmentFrames, 0);
  if (total <= referenceVectorPathLimits.maxAuthoredSegmentFramesPerComposition) return total;
  const owner = nodeWork[0]?.node;
  if (!owner) throw new Error("CUT vector-path composition authored work cannot overflow without a Path node.");
  fail("CUT_VECTOR_PATH_LIMIT", owner, `composition authored segment-frame work exceeds ${referenceVectorPathLimits.maxAuthoredSegmentFramesPerComposition}`);
}

export function validateReferenceAnchoredVectorPathCompositionStructuralWork(
  nodeWork: readonly { node: IRNode; work: ReferenceAnchoredVectorPathStructuralWork }[],
) {
  const total = nodeWork.reduce((sum, item) => ({
    spatialPointFrames: sum.spatialPointFrames + item.work.spatialPointFrames,
    ownerSampleFrames: sum.ownerSampleFrames + item.work.ownerSampleFrames,
  }), { spatialPointFrames: 0, ownerSampleFrames: 0 });
  const exceeded = total.spatialPointFrames > referenceVectorPathLimits.maxAnchoredSpatialPointFramesPerComposition
    ? `composition anchored spatial-point-frame work exceeds ${referenceVectorPathLimits.maxAnchoredSpatialPointFramesPerComposition}`
    : total.ownerSampleFrames > referenceVectorPathLimits.maxAnchoredOwnerSampleFramesPerComposition
      ? `composition anchored owner-sample-frame work exceeds ${referenceVectorPathLimits.maxAnchoredOwnerSampleFramesPerComposition}`
      : undefined;
  if (!exceeded) return Object.freeze(total);
  const owner = nodeWork[0]?.node;
  if (!owner) throw new Error("CUT anchored vector-path structural work cannot overflow without a Path node.");
  fail("CUT_VECTOR_PATH_LIMIT", owner, exceeded);
}

export function referenceVectorPathInspect(ir: CutAVIR, node: IRNode, plan: ReferenceVectorPathPlan) {
  const activeStart = referenceVectorPathFrameAt(ir, node, plan, node.interval.start);
  const dynamicControls = {
    morph: propertyStructurallyDynamic(ir, node, "morph"),
    trimStart: propertyStructurallyDynamic(ir, node, "trimStart"),
    trimEnd: propertyStructurallyDynamic(ir, node, "trimEnd"),
    dashOffset: propertyStructurallyDynamic(ir, node, "dashOffset"),
  };
  const signals = Object.fromEntries(plan.animatedProperties.flatMap((property) => {
    const binding = node.properties[property];
    if (!binding || !("signal" in binding)) return [];
    const signal = ir.signals[binding.signal];
    return [[property, { id: binding.signal, contentHash: signal?.contentHash ?? null }]];
  }));
  return {
    geometryKind: plan.geometryKind,
    closed: plan.source.closed,
    topology: segmentTopology(plan.source),
    authoredSegments: plan.source.segments.length,
    flattenedPoints: plan.staticPrepared.points.length,
    flatteningVersion: referenceCubicTraceFlattening.version,
    ...(plan.target ? {
      morphTarget: {
        closed: plan.target.closed,
        topology: segmentTopology(plan.target),
        authoredSegments: plan.target.segments.length,
        flattenedPoints: plan.targetPrepared!.points.length,
      },
    } : {}),
    trim: {
      start: "trimStart",
      end: "trimEnd",
      metric: "cumulative-arc-length",
    },
    ...(plan.dash ? { dash: { canonicalPatternPx: [...plan.dash], phaseOrigin: "untrimmed-path-start" } } : {}),
    paint: {
      ...(plan.stroke ? { stroke: plan.stroke, widthPx: plan.strokeWidth, lineCap: plan.lineCap, lineJoin: plan.lineJoin } : {}),
      ...(plan.fill ? { fill: plan.fill, fillRule: plan.fillRule } : {}),
    },
    animatedProperties: [...plan.animatedProperties],
    signals,
    frameDynamic: plan.frameDynamic,
    trimRangeDynamic: plan.trimRangeDynamic,
    executedVisibilityAtActiveStart: activeStart.visibility,
    executedAtActiveStart: {
      time: { ...node.interval.start },
      morph: activeStart.morph,
      trimStart: activeStart.trimStart,
      trimEnd: activeStart.trimEnd,
      dashOffsetPx: activeStart.dashOffset,
    },
    staticValues: {
      ...(!dynamicControls.morph ? { morph: activeStart.morph } : {}),
      ...(!dynamicControls.trimStart ? { trimStart: activeStart.trimStart } : {}),
      ...(!dynamicControls.trimEnd ? { trimEnd: activeStart.trimEnd } : {}),
      ...(!dynamicControls.dashOffset ? { dashOffsetPx: activeStart.dashOffset } : {}),
    },
  };
}

/** Sum the bounded per-node work reports after each reachable Path has been
 * preflighted. This remains separate so composition ownership can report one
 * stable aggregate limit before render construction. */
export function validateReferenceVectorPathCompositionWork(nodeWork: readonly { node: IRNode; work: ReferenceVectorPathWork }[]) {
  const total = nodeWork.reduce((sum, item) => ({
    authoredSegmentFrames: sum.authoredSegmentFrames + item.work.authoredSegmentFrames,
    flattenedPointFrames: sum.flattenedPointFrames + item.work.flattenedPointFrames,
    visibleFragmentFrames: sum.visibleFragmentFrames + item.work.visibleFragmentFrames,
    visiblePaintFrames: sum.visiblePaintFrames + item.work.visiblePaintFrames,
    transparentTrimFrames: sum.transparentTrimFrames + item.work.transparentTrimFrames,
  }), { authoredSegmentFrames: 0, flattenedPointFrames: 0, visibleFragmentFrames: 0, visiblePaintFrames: 0, transparentTrimFrames: 0 });
  const exceeded = total.authoredSegmentFrames > referenceVectorPathLimits.maxAuthoredSegmentFramesPerComposition
    ? `composition authored segment-frame work exceeds ${referenceVectorPathLimits.maxAuthoredSegmentFramesPerComposition}`
    : total.flattenedPointFrames > referenceVectorPathLimits.maxFlattenedPointFramesPerComposition
      ? `composition flattened point-frame work exceeds ${referenceVectorPathLimits.maxFlattenedPointFramesPerComposition}`
      : total.visibleFragmentFrames > referenceVectorPathLimits.maxVisibleFragmentFramesPerComposition
        ? `composition visible dash-fragment-frame work exceeds ${referenceVectorPathLimits.maxVisibleFragmentFramesPerComposition}`
        : undefined;
  if (!exceeded) return Object.freeze(total);
  const owner = nodeWork[0]?.node;
  if (!owner) throw new Error("CUT vector-path composition work cannot overflow without a Path node.");
  fail("CUT_VECTOR_PATH_LIMIT", owner, exceeded);
}
