import { hash } from "../../core/stable";
import { cutAnchoredPathLimits, cutAnchoredSpatialOps } from "../../language/anchored-path-contract";
import type { CutAVIR, IRComposition, IRNode, IRValue } from "../../language/ir";
import {
  addRational,
  compareRational,
  rational,
  rationalToNumber,
  type Rational,
} from "../../language/rational";
import {
  ReferenceLocalSpaceAffineError,
  referenceLocalSpaceAuthoredPointAffinePlan,
} from "./local-space-affine";
import type { ReferenceLocalSpaceConfig, ReferenceLocalSpacePlacement } from "./local-space";
import {
  assertReferenceMediaCamera2DPlanAuthority,
  isAuthorizedReferenceMediaCamera2DAnchorPlan,
  referenceMediaCamera2DAnchorBasis,
  type ReferenceMediaCamera2DAnchorPlan,
  type ReferenceMediaCamera2DPlan,
  type ReferenceMediaCamera2DResponsiveSlotAnchorPlacement,
} from "./media-camera2d";
import {
  referenceIdentityComponentFragmentChildBinding,
  referenceIdentityComponentFragmentForChild,
  validateReferenceIdentityComponentFragments,
  type ReferenceIdentityComponentFragmentChildBinding,
  type ReferenceIdentityComponentFragmentConfig,
} from "./identity-component-fragment";
import { transformReferencePoint, type ReferenceAffine2D } from "./retained-visual";
import type {
  ReferenceVectorPathGeometry,
  ReferenceVectorPathSegment,
} from "./vector-path";

export const referenceAnchoredPathAlgorithmVersion = "cut-reference-anchored-path-v1" as const;
export const referenceMediaCamera2DAnchoredPathAlgorithmVersion =
  "cut-reference-anchored-path-media-camera-v2" as const;
export type ReferenceAnchoredPathAlgorithmVersion =
  | typeof referenceAnchoredPathAlgorithmVersion
  | typeof referenceMediaCamera2DAnchoredPathAlgorithmVersion;

export type ReferenceAnchoredPathErrorCode =
  | "CUT_ANCHORED_PATH_TYPE"
  | "CUT_ANCHORED_PATH_SHAPE"
  | "CUT_ANCHORED_PATH_REFERENCE"
  | "CUT_ANCHORED_PATH_GRAPH"
  | "CUT_ANCHORED_PATH_RANGE"
  | "CUT_ANCHORED_PATH_LIMIT"
  | "CUT_ANCHORED_PATH_UNSUPPORTED"
  | "CUT_ANCHORED_PATH_RESOLUTION";

export class ReferenceAnchoredPathError extends Error {
  readonly source: Readonly<{ module: string; line: number; column: number; nodeId: string }>;

  constructor(
    readonly code: ReferenceAnchoredPathErrorCode,
    readonly node: IRNode,
    readonly detail: string,
    readonly execution?: Readonly<{ time: Rational; frame?: bigint }>,
  ) {
    const { module, span } = node.provenance;
    const exact = execution
      ? ` at exact time ${execution.time.numerator}/${execution.time.denominator}s${execution.frame === undefined ? "" : ` (output frame ${execution.frame})`}`
      : "";
    super(`${code}: anchored geometry ${detail}${exact} at ${module}:${span.start.line}:${span.start.column}.`);
    this.name = "ReferenceAnchoredPathError";
    this.source = Object.freeze({ module, line: span.start.line, column: span.start.column, nodeId: node.id });
  }
}

function fail(
  code: ReferenceAnchoredPathErrorCode,
  node: IRNode,
  detail: string,
  execution?: Readonly<{ time: Rational; frame?: bigint }>,
): never {
  throw new ReferenceAnchoredPathError(code, node, detail, execution);
}

export type ReferenceAnchoredCompositionPoint = Readonly<{
  kind: "composition-point";
  point: Readonly<{ x: number; y: number }>;
}>;

export type ReferenceVisualAnchor = Readonly<{
  kind: "visual-anchor";
  ownerNodeId: string;
  local: Readonly<{ x: number; y: number }>;
}>;

export type ReferenceCompositionOffset = Readonly<{
  kind: "composition-offset";
  point: ReferenceSpatialPoint;
  by: Readonly<{ x: number; y: number }>;
}>;

/** A raw Vec2 is already in composition pixels. Owner-bound points and their
 * composition-space offsets remain symbolic until one exact renderer sample. */
export type ReferenceSpatialPoint =
  | ReferenceAnchoredCompositionPoint
  | ReferenceVisualAnchor
  | ReferenceCompositionOffset;

const referenceVisualAnchorExactLocals =
  new WeakMap<ReferenceVisualAnchor, Readonly<{ x: Rational; y: Rational }>>();

export type ReferenceAnchoredPathSegment =
  | Readonly<{ kind: "line"; to: ReferenceSpatialPoint }>
  | Readonly<{
    kind: "cubic";
    control1: ReferenceSpatialPoint;
    control2: ReferenceSpatialPoint;
    to: ReferenceSpatialPoint;
  }>;

export type ReferenceAnchoredPathGeometry = Readonly<{
  geometryKind: "anchored";
  start: ReferenceSpatialPoint;
  segments: readonly ReferenceAnchoredPathSegment[];
  closed: boolean;
  spatialPointCount: number;
  visualAnchorCount: number;
  ownerNodeIds: readonly string[];
  semanticIdentity: string;
}>;

export type ReferenceAnchoredPathLocalSpaceOwnerBinding = Readonly<{
  ownerNodeId: string;
  localSpaceNodeId: string;
  ownerKind: ReferenceLocalSpaceConfig["owner"];
  localSpaceSemanticIdentity: string;
}>;

export type ReferenceAnchoredPathMediaCameraOwnerBinding = Readonly<{
  ownerNodeId: string;
  ownerKind: "media-camera-2d";
  basisKind: "post-crop-source-pixel-centres";
  basisNodeId: string;
  basisWidth: number;
  basisHeight: number;
  basisSemanticIdentity: string;
  /** Absent for the historical direct scene-root camera contract. */
  responsiveSlotComposition?: Readonly<{
    compositionId: string;
    stackNodeId: string;
    slotNodeId: string;
    index: number;
    compilerContextIdentity: string;
    outputContextIdentity: string;
    responsivePlanIdentity: string;
    rasterSlot: ReferenceMediaCamera2DResponsiveSlotAnchorPlacement["rasterSlot"];
    clip: "half-open-raster-slot";
  }>;
}>;

export type ReferenceAnchoredPathOwnerBinding =
  | ReferenceAnchoredPathLocalSpaceOwnerBinding
  | ReferenceAnchoredPathMediaCameraOwnerBinding;

export type ReferenceValidatedAnchoredPathGeometry = ReferenceAnchoredPathGeometry & Readonly<{
  ownerBindings: readonly ReferenceAnchoredPathOwnerBinding[];
  identityComponentFragment?: ReferenceIdentityComponentFragmentChildBinding;
  /** Absent on historical manually materialized v1 plans. */
  resolutionAlgorithmVersion?: ReferenceAnchoredPathAlgorithmVersion;
  validationIdentity: string;
}>;

type IRCall = Extract<IRValue, { kind: "call" }>;

export function isReferenceAnchoredPathGeometryValue(
  value: IRValue | undefined,
): value is IRCall {
  return value?.kind === "call" && value.op === cutAnchoredSpatialOps.anchoredPath;
}

function exactKeys(
  node: IRNode,
  value: object,
  expected: readonly string[],
  label: string,
) {
  if (Array.isArray(value)) fail("CUT_ANCHORED_PATH_SHAPE", node, `${label} must be a plain closed record`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("CUT_ANCHORED_PATH_SHAPE", node, `${label} must have a plain or null prototype`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) {
    fail("CUT_ANCHORED_PATH_SHAPE", node, `${label} cannot contain symbol fields`);
  }
  const keys = ownKeys as string[];
  const unknown = keys.find((key) => !expected.includes(key));
  const missing = expected.find((key) => !Object.hasOwn(value, key));
  if (unknown !== undefined || missing !== undefined || keys.length !== expected.length) {
    fail(
      "CUT_ANCHORED_PATH_SHAPE",
      node,
      `${label} must contain exactly ${expected.join(", ")}${unknown === undefined ? "" : `; found unsupported ${unknown}`}${missing === undefined ? "" : `; missing ${missing}`}`,
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const invalid = expected.find((key) => !descriptors[key]?.enumerable || !("value" in descriptors[key]!));
  if (invalid !== undefined) {
    fail("CUT_ANCHORED_PATH_SHAPE", node, `${label}.${invalid} must be one enumerable data field`);
  }
}

function exactDenseArray(node: IRNode, value: unknown, label: string) {
  if (!Array.isArray(value)) fail("CUT_ANCHORED_PATH_TYPE", node, `${label} must be an array`);
  const extra = Reflect.ownKeys(value).find((key) => {
    if (key === "length") return false;
    if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key)) return true;
    const index = Number(key);
    return !Number.isSafeInteger(index) || index < 0 || index >= value.length;
  });
  if (extra !== undefined) fail("CUT_ANCHORED_PATH_SHAPE", node, `${label} contains unsupported array field ${String(extra)}`);
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) fail("CUT_ANCHORED_PATH_SHAPE", node, `${label} must be dense; missing index ${index}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      fail("CUT_ANCHORED_PATH_SHAPE", node, `${label}[${index}] must be one enumerable data item`);
    }
  }
  return value;
}

function exactCall(
  node: IRNode,
  value: IRValue | undefined,
  expectedOp: string,
  namedFields: readonly string[],
  label: string,
) {
  if (value?.kind !== "call") {
    fail("CUT_ANCHORED_PATH_TYPE", node, `${label} must be the versioned pure call ${expectedOp}; generic object lookalikes are unsupported`);
  }
  exactKeys(node, value, ["kind", "op", "positional", "named", "effect"], label);
  if (value.op !== expectedOp) fail("CUT_ANCHORED_PATH_TYPE", node, `${label}.op must be exactly ${expectedOp}; found ${value.op}`);
  if (value.effect !== "pure") fail("CUT_ANCHORED_PATH_TYPE", node, `${label}.effect must be pure`);
  const positional = exactDenseArray(node, value.positional, `${label}.positional`);
  if (positional.length !== 0) {
    fail("CUT_ANCHORED_PATH_SHAPE", node, `${label}.positional must be empty`);
  }
  exactKeys(node, value.named, namedFields, `${label}.named`);
  return value.named;
}

function exactLengthValue(node: IRNode, value: IRValue | undefined, label: string) {
  if (value?.kind !== "quantity" || value.dimension !== "length" || value.unit !== "px") {
    fail("CUT_ANCHORED_PATH_TYPE", node, `${label} must be one exact Length quantity in px`);
  }
  exactKeys(node, value, ["kind", "dimension", "magnitude", "unit"], label);
  if (typeof value.magnitude !== "object" || value.magnitude === null) {
    fail("CUT_ANCHORED_PATH_TYPE", node, `${label}.magnitude must be one canonical Rational`);
  }
  exactKeys(node, value.magnitude, ["numerator", "denominator"], `${label}.magnitude`);
  let canonical: Rational;
  try { canonical = rational(value.magnitude.numerator, value.magnitude.denominator); }
  catch { return fail("CUT_ANCHORED_PATH_RANGE", node, `${label}.magnitude must be one canonical finite Rational`); }
  if (canonical.numerator !== value.magnitude.numerator || canonical.denominator !== value.magnitude.denominator) {
    fail("CUT_ANCHORED_PATH_TYPE", node, `${label}.magnitude must use canonical reduced Rational spelling`);
  }
  let number: number;
  try { number = rationalToNumber(value.magnitude); }
  catch { return fail("CUT_ANCHORED_PATH_RANGE", node, `${label} must be finite`); }
  if (!Number.isFinite(number)) fail("CUT_ANCHORED_PATH_RANGE", node, `${label} must be finite`);
  if (Math.abs(number) > cutAnchoredPathLimits.maximumAbsoluteCoordinatePx) {
    fail("CUT_ANCHORED_PATH_LIMIT", node, `${label} exceeds the +/-${cutAnchoredPathLimits.maximumAbsoluteCoordinatePx}px coordinate envelope`);
  }
  return Object.freeze({
    number: Object.is(number, -0) ? 0 : number,
    rational: Object.freeze({ ...canonical }),
  });
}

function exactLength(node: IRNode, value: IRValue | undefined, label: string) {
  return exactLengthValue(node, value, label).number;
}

function exactVec2(node: IRNode, value: IRValue | undefined, label: string) {
  if (value?.kind !== "object") fail("CUT_ANCHORED_PATH_TYPE", node, `${label} must be a closed Vec2 with exactly x and y`);
  exactKeys(node, value, ["kind", "entries"], label);
  exactKeys(node, value.entries, ["x", "y"], `${label}.entries`);
  return Object.freeze({
    x: exactLength(node, value.entries.x, `${label}.x`),
    y: exactLength(node, value.entries.y, `${label}.y`),
  });
}

function exactVec2Value(node: IRNode, value: IRValue | undefined, label: string) {
  if (value?.kind !== "object") fail("CUT_ANCHORED_PATH_TYPE", node, `${label} must be a closed Vec2 with exactly x and y`);
  exactKeys(node, value, ["kind", "entries"], label);
  exactKeys(node, value.entries, ["x", "y"], `${label}.entries`);
  const x = exactLengthValue(node, value.entries.x, `${label}.x`);
  const y = exactLengthValue(node, value.entries.y, `${label}.y`);
  return Object.freeze({
    point: Object.freeze({ x: x.number, y: y.number }),
    rational: Object.freeze({ x: x.rational, y: y.rational }),
  });
}

function exactBoolean(node: IRNode, value: IRValue | undefined, label: string) {
  if (value?.kind !== "boolean" || typeof value.value !== "boolean") fail("CUT_ANCHORED_PATH_TYPE", node, `${label} must be Boolean`);
  exactKeys(node, value, ["kind", "value"], label);
  return value.value;
}

type DecodeState = {
  spatialPointCount: number;
  visualAnchorCount: number;
  ownerNodeIds: Set<string>;
};

function accumulatedOffset(point: ReferenceSpatialPoint): Readonly<{ x: number; y: number }> {
  if (point.kind !== "composition-offset") return Object.freeze({ x: 0, y: 0 });
  const nested = accumulatedOffset(point.point);
  return Object.freeze({ x: nested.x + point.by.x, y: nested.y + point.by.y });
}

function decodeSpatialPoint(
  node: IRNode,
  value: IRValue | undefined,
  label: string,
  state: DecodeState,
  offsetDepth = 0,
  countPointBearingOccurrence = true,
): ReferenceSpatialPoint {
  if (countPointBearingOccurrence) {
    state.spatialPointCount += 1;
    if (state.spatialPointCount > cutAnchoredPathLimits.maximumSpatialPoints) {
      fail("CUT_ANCHORED_PATH_LIMIT", node, `${label} exceeds ${cutAnchoredPathLimits.maximumSpatialPoints} point-bearing path values`);
    }
  }
  if (offsetDepth > cutAnchoredPathLimits.maximumOffsetDepth) {
    fail("CUT_ANCHORED_PATH_LIMIT", node, `${label} exceeds compositionOffset depth ${cutAnchoredPathLimits.maximumOffsetDepth}`);
  }
  if (value?.kind === "object") {
    return Object.freeze({ kind: "composition-point" as const, point: exactVec2(node, value, label) });
  }
  if (value?.kind !== "call") {
    fail("CUT_ANCHORED_PATH_TYPE", node, `${label} must be a raw composition Vec2, visualAnchor, or compositionOffset`);
  }
  if (value.op === cutAnchoredSpatialOps.visualAnchor) {
    const named = exactCall(node, value, cutAnchoredSpatialOps.visualAnchor, ["owner", "local"], label);
    const owner = named.owner;
    if (owner?.kind !== "node-ref" || typeof owner.id !== "string" || owner.id.length === 0) {
      fail("CUT_ANCHORED_PATH_REFERENCE", node, `${label}.owner must be one direct visual node reference`);
    }
    exactKeys(node, owner, ["kind", "id"], `${label}.owner`);
    state.visualAnchorCount += 1;
    state.ownerNodeIds.add(owner.id);
    if (state.ownerNodeIds.size > cutAnchoredPathLimits.maximumUniqueOwners) {
      fail("CUT_ANCHORED_PATH_LIMIT", node, `${label} exceeds ${cutAnchoredPathLimits.maximumUniqueOwners} unique owners`);
    }
    const local = exactVec2Value(node, named.local, `${label}.local`);
    const anchor = Object.freeze({
      kind: "visual-anchor" as const,
      ownerNodeId: owner.id,
      local: local.point,
    });
    referenceVisualAnchorExactLocals.set(anchor, local.rational);
    return anchor;
  }
  if (value.op === cutAnchoredSpatialOps.compositionOffset) {
    const named = exactCall(node, value, cutAnchoredSpatialOps.compositionOffset, ["point", "by"], label);
    // compositionOffset wraps one point-bearing occurrence; wrapper depth has
    // its own independent resource bound and must not consume another segment
    // point slot merely because the spelling is nested.
    const point = decodeSpatialPoint(node, named.point, `${label}.point`, state, offsetDepth + 1, false);
    const by = exactVec2(node, named.by, `${label}.by`);
    if (by.x === 0 && by.y === 0) {
      fail("CUT_ANCHORED_PATH_SHAPE", node, `${label} is a zero compositionOffset and cannot affect geometry`);
    }
    const nested = accumulatedOffset(point), net = { x: nested.x + by.x, y: nested.y + by.y };
    if (net.x === 0 && net.y === 0) {
      fail("CUT_ANCHORED_PATH_SHAPE", node, `${label} compositionOffset chain has a zero net offset and cannot affect geometry`);
    }
    return Object.freeze({ kind: "composition-offset" as const, point, by });
  }
  fail(
    "CUT_ANCHORED_PATH_TYPE",
    node,
    `${label}.op must be ${cutAnchoredSpatialOps.visualAnchor} or ${cutAnchoredSpatialOps.compositionOffset}; found ${value.op}`,
  );
}

function pointIdentity(point: ReferenceSpatialPoint) {
  let current = point, offsetX = 0, offsetY = 0;
  while (current.kind === "composition-offset") {
    offsetX += current.by.x;
    offsetY += current.by.y;
    current = current.point;
  }
  return hash(current.kind === "composition-point"
    ? { kind: current.kind, x: current.point.x + offsetX, y: current.point.y + offsetY }
    : { kind: current.kind, ownerNodeId: current.ownerNodeId, local: current.local, compositionOffset: { x: offsetX, y: offsetY } });
}

function segmentEndpoint(segment: ReferenceAnchoredPathSegment) {
  return segment.to;
}

/**
 * Decode one public SpatialPoint through the same closed wire contract used by
 * anchoredPath without requiring a path segment. Generic callout/layout
 * consumers use this zero-segment carrier so owner binding, exact Rational
 * source coordinates, Track2D policy and MediaCamera2D authority remain one
 * implementation rather than drifting into a second coordinate system.
 *
 * The carrier is runtime-internal: it is never serialized as anchoredPath and
 * therefore does not weaken anchoredPath's public one-or-more segment rule.
 */
export function decodeReferenceSpatialPointGeometry(
  node: IRNode,
  value: IRValue | undefined,
  label: string,
): ReferenceAnchoredPathGeometry {
  const state: DecodeState = {
    spatialPointCount: 0,
    visualAnchorCount: 0,
    ownerNodeIds: new Set(),
  };
  const start = decodeSpatialPoint(node, value, label, state);
  const ownerNodeIds = Object.freeze([...state.ownerNodeIds].sort());
  const canonical = Object.freeze({
    geometryKind: "anchored" as const,
    start,
    segments: Object.freeze([]) as readonly ReferenceAnchoredPathSegment[],
    closed: false,
    spatialPointCount: state.spatialPointCount,
    visualAnchorCount: state.visualAnchorCount,
    ownerNodeIds,
  });
  return Object.freeze({
    ...canonical,
    semanticIdentity: hash({
      algorithm: referenceAnchoredPathAlgorithmVersion,
      consumer: "spatial-point",
      ...canonical,
    }),
  });
}

/** Decode the persisted v1 anchored geometry without sampling any owner. */
export function decodeReferenceAnchoredPathGeometry(
  node: IRNode,
  value: IRValue | undefined,
  label: string,
): ReferenceAnchoredPathGeometry {
  const named = exactCall(node, value, cutAnchoredSpatialOps.anchoredPath, ["start", "segments", "closed"], label);
  const state: DecodeState = { spatialPointCount: 0, visualAnchorCount: 0, ownerNodeIds: new Set() };
  const start = decodeSpatialPoint(node, named.start, `${label}.start`, state);
  if (named.segments?.kind !== "array") {
    fail("CUT_ANCHORED_PATH_TYPE", node, `${label}.segments must be a List<AnchoredPathSegment>`);
  }
  exactKeys(node, named.segments, ["kind", "items"], `${label}.segments`);
  const segmentItems = exactDenseArray(node, named.segments.items, `${label}.segments.items`) as IRValue[];
  if (segmentItems.length < 1 || segmentItems.length > cutAnchoredPathLimits.maximumSegments) {
    fail(
      "CUT_ANCHORED_PATH_LIMIT",
      node,
      `${label}.segments must contain 1 through ${cutAnchoredPathLimits.maximumSegments} anchored segments`,
    );
  }
  let cursor = start;
  const segments = segmentItems.map((item, index): ReferenceAnchoredPathSegment => {
    const segmentLabel = `${label}.segments[${index}]`;
    if (item.kind !== "call") fail("CUT_ANCHORED_PATH_TYPE", node, `${segmentLabel} must be an anchored line/cubic call`);
    let segment: ReferenceAnchoredPathSegment;
    if (item.op === cutAnchoredSpatialOps.anchoredLineTo) {
      const fields = exactCall(node, item, cutAnchoredSpatialOps.anchoredLineTo, ["to"], segmentLabel);
      segment = Object.freeze({ kind: "line" as const, to: decodeSpatialPoint(node, fields.to, `${segmentLabel}.to`, state) });
      if (pointIdentity(cursor) === pointIdentity(segment.to)) {
        fail("CUT_ANCHORED_PATH_SHAPE", node, `${segmentLabel} is a determinable zero-length line`);
      }
    } else if (item.op === cutAnchoredSpatialOps.anchoredCubicTo) {
      const fields = exactCall(
        node,
        item,
        cutAnchoredSpatialOps.anchoredCubicTo,
        ["control1", "control2", "to"],
        segmentLabel,
      );
      segment = Object.freeze({
        kind: "cubic" as const,
        control1: decodeSpatialPoint(node, fields.control1, `${segmentLabel}.control1`, state),
        control2: decodeSpatialPoint(node, fields.control2, `${segmentLabel}.control2`, state),
        to: decodeSpatialPoint(node, fields.to, `${segmentLabel}.to`, state),
      });
      const identity = pointIdentity(cursor);
      if (identity === pointIdentity(segment.control1)
        && identity === pointIdentity(segment.control2)
        && identity === pointIdentity(segment.to)) {
        fail("CUT_ANCHORED_PATH_SHAPE", node, `${segmentLabel} is a determinable zero-length cubic`);
      }
    } else {
      fail(
        "CUT_ANCHORED_PATH_TYPE",
        node,
        `${segmentLabel}.op must be ${cutAnchoredSpatialOps.anchoredLineTo} or ${cutAnchoredSpatialOps.anchoredCubicTo}; found ${item.op}`,
      );
    }
    cursor = segmentEndpoint(segment);
    return segment;
  });
  const closed = exactBoolean(node, named.closed, `${label}.closed`);
  if (closed && pointIdentity(start) === pointIdentity(cursor)) {
    fail("CUT_ANCHORED_PATH_SHAPE", node, `${label} redundantly repeats its start as the final endpoint before closed: true`);
  }
  if (state.visualAnchorCount < 1) {
    fail("CUT_ANCHORED_PATH_SHAPE", node, `${label} must contain at least one visualAnchor; use vectorPath for composition-only geometry`);
  }
  const ownerNodeIds = Object.freeze([...state.ownerNodeIds].sort());
  const canonical = Object.freeze({
    geometryKind: "anchored" as const,
    start,
    segments: Object.freeze(segments),
    closed,
    spatialPointCount: state.spatialPointCount,
    visualAnchorCount: state.visualAnchorCount,
    ownerNodeIds,
  });
  return Object.freeze({ ...canonical, semanticIdentity: hash({ algorithm: referenceAnchoredPathAlgorithmVersion, ...canonical }) });
}

function intervalContains(parent: IRNode, child: IRNode) {
  return compareRational(child.interval.start, parent.interval.start) >= 0
    && compareRational(addRational(child.interval.start, child.interval.duration), addRational(parent.interval.start, parent.interval.duration)) <= 0;
}

function compositionReachableNodes(ir: CutAVIR, composition: IRComposition) {
  const pending: string[] = [];
  for (const item of composition.items) {
    if (item.kind === "node") pending.push(item.id);
    else {
      const scene = ir.scenes[item.id];
      if (scene) pending.push(...scene.items.map((entry) => entry.id));
    }
  }
  const reachable = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    const current = ir.nodes[id];
    if (current) pending.push(...current.children);
  }
  return reachable;
}

function structurallyReaches(ir: CutAVIR, fromNodeId: string, targetNodeId: string) {
  const pending = [fromNodeId], seen = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (id === targetNodeId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const current = ir.nodes[id];
    if (current) pending.push(...current.children);
  }
  return false;
}

function containingLocalSpaceIds(
  ir: CutAVIR,
  nodeId: string,
  localSpaceConfigs: ReadonlyMap<string, ReferenceLocalSpaceConfig>,
) {
  return [...localSpaceConfigs.values()]
    .filter((config) => config.childIds.some((childId) => structurallyReaches(ir, childId, nodeId)))
    .map((config) => config.nodeId)
    .sort();
}

function anchoredPoints(geometry: ReferenceAnchoredPathGeometry) {
  const points: ReferenceSpatialPoint[] = [geometry.start];
  for (const segment of geometry.segments) {
    if (segment.kind === "cubic") points.push(segment.control1, segment.control2);
    points.push(segment.to);
  }
  return points;
}

function visualAnchors(point: ReferenceSpatialPoint): readonly ReferenceVisualAnchor[] {
  if (point.kind === "visual-anchor") return Object.freeze([point]);
  if (point.kind === "composition-offset") return visualAnchors(point.point);
  return Object.freeze([]);
}

function ownerLocalSpaceCandidates(
  owner: IRNode,
  localSpaceConfigs: ReadonlyMap<string, ReferenceLocalSpaceConfig>,
) {
  return [...localSpaceConfigs.values()].filter((config) => owner.op === "cut.visual.local_space"
    ? config.nodeId === owner.id
    : config.ownerNodeId === owner.id || (config.owner === "scene-root" && config.nodeId === owner.id));
}

function anchorInsideView(anchor: ReferenceVisualAnchor, localSpace: ReferenceLocalSpaceConfig) {
  const view = localSpace.view;
  return anchor.local.x >= rationalToNumber(view.minX)
    && anchor.local.x <= rationalToNumber(view.maxX)
    && anchor.local.y >= rationalToNumber(view.minY)
    && anchor.local.y <= rationalToNumber(view.maxY);
}

function anchorInsideMediaCameraBasis(
  anchor: ReferenceVisualAnchor,
  basis: Pick<ReferenceAnchoredPathMediaCameraOwnerBinding, "basisWidth" | "basisHeight">,
) {
  const exact = referenceVisualAnchorExactLocals.get(anchor);
  if (!exact) return false;
  return compareRational(exact.x, rational(0)) >= 0
    && compareRational(exact.x, rational(basis.basisWidth - 1)) <= 0
    && compareRational(exact.y, rational(0)) >= 0
    && compareRational(exact.y, rational(basis.basisHeight - 1)) <= 0;
}

function exactVisualAnchorLocalLabel(anchor: ReferenceVisualAnchor) {
  const exact = referenceVisualAnchorExactLocals.get(anchor);
  return !exact
    ? `(${anchor.local.x}, ${anchor.local.y})`
    : `(${exact.x.numerator}/${exact.x.denominator}, ${exact.y.numerator}/${exact.y.denominator})`;
}

const supportedAnchoredPathAffineOwnerKinds: ReadonlySet<ReferenceLocalSpaceConfig["owner"]> = new Set([
  "scene-root",
  "component-fragment",
  "group",
  "camera-2d",
  "track-2d",
]);

/** Bind every referenced owner to its one validated retained LocalSpace.
 * This is deliberately separate from decoding so topology-only tooling can
 * inspect persisted source without manufacturing renderer state. */
export function validateReferenceAnchoredPathGeometry(
  ir: CutAVIR,
  composition: IRComposition,
  node: IRNode,
  geometry: ReferenceAnchoredPathGeometry,
  localSpaceConfigs: ReadonlyMap<string, ReferenceLocalSpaceConfig>,
  mediaCameraPlans: ReadonlyMap<string, ReferenceMediaCamera2DPlan> = new Map(),
  identityComponentFragments:
    ReadonlyMap<string, ReferenceIdentityComponentFragmentConfig> =
      validateReferenceIdentityComponentFragments(ir, composition),
): ReferenceValidatedAnchoredPathGeometry {
  const reachable = compositionReachableNodes(ir, composition);
  if (!reachable.has(node.id)) {
    fail("CUT_ANCHORED_PATH_GRAPH", node, `consumer ${node.id} is not structurally reachable from composition ${composition.id}`);
  }
  const containingLocalSpaces = containingLocalSpaceIds(ir, node.id, localSpaceConfigs);
  if (containingLocalSpaces.length) {
    fail(
      "CUT_ANCHORED_PATH_UNSUPPORTED",
      node,
      `consumer is nested under LocalSpace ${containingLocalSpaces.join(", ")}; v1 resolves anchored geometry in composition pixels and refuses a second retained local transform`,
    );
  }
  const directConsumerRoot = node.op === "cut.visual.path" || node.op === "cut.visual.motion_path"
    ? node
    : Object.values(ir.nodes).find((candidate) =>
        candidate.op === "cut.visual.callout_layer"
        && candidate.sceneId === node.sceneId
        && candidate.children.includes(node.id));
  const identityComponentFragment = directConsumerRoot
    ? referenceIdentityComponentFragmentForChild(
      identityComponentFragments,
      directConsumerRoot.id,
    )
    : undefined;
  const bindings: ReferenceAnchoredPathOwnerBinding[] = [];
  const mediaAnchorExactCoordinates: Array<Readonly<{
    ownerNodeId: string;
    x: Rational;
    y: Rational;
  }>> = [];
  let resolutionAlgorithmVersion: ReferenceAnchoredPathAlgorithmVersion =
    referenceAnchoredPathAlgorithmVersion;
  for (const ownerNodeId of geometry.ownerNodeIds) {
    const owner = ir.nodes[ownerNodeId];
    if (!owner) fail("CUT_ANCHORED_PATH_REFERENCE", node, `references missing visual owner ${ownerNodeId}`);
    if (owner.id === node.id) fail("CUT_ANCHORED_PATH_GRAPH", node, "cannot anchor geometry to its own consumer node");
    if (owner.domain !== "visual") fail("CUT_ANCHORED_PATH_REFERENCE", node, `owner ${owner.id} must have visual domain; found ${owner.domain}`);
    if (owner.sceneId !== node.sceneId || !reachable.has(owner.id)) {
      fail("CUT_ANCHORED_PATH_GRAPH", node, `owner ${owner.id} and consumer must belong to the same reachable scene/composition scope`);
    }
    if (!intervalContains(owner, node)) {
      fail("CUT_ANCHORED_PATH_RANGE", node, `consumer interval must be contained by owner ${owner.id} interval`);
    }
    if (structurallyReaches(ir, owner.id, node.id) || structurallyReaches(ir, node.id, owner.id)) {
      fail("CUT_ANCHORED_PATH_GRAPH", node, `owner ${owner.id} and consumer ${node.id} have a structural ancestor/descendant dependency cycle`);
    }
    if (owner.provenance.module !== node.provenance.module) {
      fail("CUT_ANCHORED_PATH_GRAPH", node, `owner ${owner.id} must be bound earlier in the same source module as its anchored geometry consumer`);
    }
    if (owner.provenance.span.start.offset >= node.provenance.span.start.offset) {
      fail("CUT_ANCHORED_PATH_GRAPH", node, `owner ${owner.id} must be bound earlier than its anchored geometry consumer`);
    }
    const anchors = anchoredPoints(geometry).flatMap((point) => visualAnchors(point))
      .filter((anchor) => anchor.ownerNodeId === owner.id);
    if (owner.op === "cut.visual.media_camera2d") {
      const cameraPlan = mediaCameraPlans.get(owner.id);
      const scene = owner.sceneId ? ir.scenes[owner.sceneId] : undefined;
      if (!cameraPlan
        || cameraPlan.cameraNodeId !== owner.id
        || cameraPlan.compositionId !== composition.id
        || cameraPlan.sceneId !== owner.sceneId) {
        fail(
          "CUT_ANCHORED_PATH_GRAPH",
          node,
          `MediaCamera2D owner ${owner.id} has no matching locked source-coordinate plan`,
        );
      }
      try {
        assertReferenceMediaCamera2DPlanAuthority(ir, composition, cameraPlan);
      } catch (error) {
        fail(
          "CUT_ANCHORED_PATH_GRAPH",
          node,
          `MediaCamera2D owner ${owner.id} has a forged, detached, or stale locked source-coordinate plan: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!scene) {
        fail("CUT_ANCHORED_PATH_GRAPH", node, `MediaCamera2D owner ${owner.id} references missing scene ${owner.sceneId}`);
      }
      const rootMembership = scene.items.filter((item) => item.id === owner.id).length;
      let responsiveSlotComposition:
        ReferenceAnchoredPathMediaCameraOwnerBinding["responsiveSlotComposition"];
      if (cameraPlan.outputContext.kind === "composition") {
        if (owner.ownership !== "root" || rootMembership !== 1) {
          fail(
            "CUT_ANCHORED_PATH_GRAPH",
            node,
            `MediaCamera2D owner ${owner.id} must be one direct scene root; found ownership ${owner.ownership} and ${rootMembership} scene-root memberships`,
          );
        }
      } else {
        const output = cameraPlan.outputContext;
        const stack = ir.nodes[output.stackNodeId];
        const slot = ir.nodes[output.slotNodeId];
        const stackSourceOrder = scene.items.findIndex((item) => item.id === output.stackNodeId);
        const consumerSourceOrder = directConsumerRoot
          ? scene.items.findIndex((item) => item.id === directConsumerRoot.id)
          : -1;
        const fragmentStackIndex = identityComponentFragment
          ?.childNodeIds.indexOf(output.stackNodeId) ?? -1;
        const fragmentConsumerIndex = directConsumerRoot && identityComponentFragment
          ? identityComponentFragment.childNodeIds.indexOf(directConsumerRoot.id)
          : -1;
        const directRootChain = stack?.ownership === "root"
          && scene.items.filter((item) => item.id === stack.id).length === 1
          && directConsumerRoot?.ownership === "root"
          && stackSourceOrder >= 0
          && consumerSourceOrder >= 0
          && stackSourceOrder < consumerSourceOrder;
        const identityFragmentChain = identityComponentFragment !== undefined
          && identityComponentFragment.stackNodeId === output.stackNodeId
          && identityComponentFragment.cameraNodeId === owner.id
          && stack?.ownership === "child"
          && directConsumerRoot?.ownership === "child"
          && scene.items.filter((item) => item.id === stack.id).length === 0
          && scene.items.filter((item) => item.id === directConsumerRoot.id).length === 0
          && fragmentStackIndex === 0
          && fragmentConsumerIndex > fragmentStackIndex;
        if (!stack
          || !slot
          || stack.op !== "cut.visual.responsive_stack"
          || slot.op !== "cut.visual.responsive_slot"
          || stack.sceneId !== scene.id
          || slot.sceneId !== scene.id
          || slot.ownership !== "child"
          || owner.ownership !== "child"
          || rootMembership !== 0
          || stack.children[output.index] !== slot.id
          || slot.children.length !== 1
          || slot.children[0] !== owner.id
          || !directConsumerRoot
          || (!directRootChain && !identityFragmentChain)) {
          fail(
            "CUT_ANCHORED_PATH_GRAPH",
            node,
            `MediaCamera2D owner ${owner.id} must retain one exact camera -> ResponsiveSlot -> earlier ResponsiveStack -> later consumer chain, either as direct scene roots or inside one admitted identity component fragment in scene ${scene.id}`,
          );
        }
        responsiveSlotComposition = Object.freeze({
          compositionId: output.compositionId,
          stackNodeId: output.stackNodeId,
          slotNodeId: output.slotNodeId,
          index: output.index,
          compilerContextIdentity: output.compilerContextIdentity,
          outputContextIdentity: output.semanticIdentity,
          responsivePlanIdentity: output.planIdentity,
          rasterSlot: output.rasterSlot,
          clip: output.clip,
        });
      }
      const basis = referenceMediaCamera2DAnchorBasis(cameraPlan);
      const binding: ReferenceAnchoredPathMediaCameraOwnerBinding = Object.freeze({
        ownerNodeId: owner.id,
        ownerKind: "media-camera-2d",
        basisKind: basis.kind,
        basisNodeId: owner.id,
        basisWidth: basis.width,
        basisHeight: basis.height,
        basisSemanticIdentity: basis.semanticIdentity,
        ...(responsiveSlotComposition ? { responsiveSlotComposition } : {}),
      });
      const outside = anchors.find((anchor) => !anchorInsideMediaCameraBasis(anchor, binding));
      if (outside) {
        fail(
          "CUT_ANCHORED_PATH_RANGE",
          node,
          `MediaCamera2D owner ${owner.id} exact source point ${exactVisualAnchorLocalLabel(outside)} lies outside locked post-crop pixel-centre bounds [0, ${basis.width - 1}] x [0, ${basis.height - 1}]`,
        );
      }
      for (const anchor of anchors) {
        const exact = referenceVisualAnchorExactLocals.get(anchor);
        if (!exact) {
          fail("CUT_ANCHORED_PATH_TYPE", node, `MediaCamera2D owner ${owner.id} anchor lost its exact Rational source coordinate`);
        }
        mediaAnchorExactCoordinates.push(Object.freeze({
          ownerNodeId: owner.id,
          x: exact.x,
          y: exact.y,
        }));
      }
      bindings.push(binding);
      resolutionAlgorithmVersion = referenceMediaCamera2DAnchoredPathAlgorithmVersion;
      continue;
    }
    const candidates = ownerLocalSpaceCandidates(owner, localSpaceConfigs);
    if (candidates.length !== 1) {
      fail(
        "CUT_ANCHORED_PATH_GRAPH",
        node,
        `owner ${owner.id} must expose exactly one validated LocalSpace coordinate basis; found ${candidates.length}`,
      );
    }
    const localSpace = candidates[0]!;
    if (!supportedAnchoredPathAffineOwnerKinds.has(localSpace.owner)) {
      fail(
        "CUT_ANCHORED_PATH_UNSUPPORTED",
        node,
        `owner ${owner.id} uses unsupported ${localSpace.owner} coordinates; anchored paths v1 allow only scene-root, component-fragment, group, camera-2d, and track-2d affine bases`,
      );
    }
    const localNode = ir.nodes[localSpace.nodeId];
    if (!localNode || !intervalContains(localNode, node)) {
      fail("CUT_ANCHORED_PATH_RANGE", node, `consumer interval must be contained by owner ${owner.id} LocalSpace ${localSpace.nodeId}`);
    }
    const outside = anchors.find((anchor) => !anchorInsideView(anchor, localSpace));
    if (outside) {
      fail(
        "CUT_ANCHORED_PATH_RANGE",
        node,
        `owner ${owner.id} local point (${outside.local.x}, ${outside.local.y}) lies outside LocalSpace ${localSpace.nodeId}'s closed authored view`,
      );
    }
    bindings.push(Object.freeze({
      ownerNodeId: owner.id,
      localSpaceNodeId: localSpace.nodeId,
      ownerKind: localSpace.owner,
      localSpaceSemanticIdentity: localSpace.semanticIdentity,
    }));
  }
  const ownerBindings = Object.freeze(bindings.sort((left, right) => left.ownerNodeId.localeCompare(right.ownerNodeId)));
  return Object.freeze({
    ...geometry,
    ownerBindings,
    ...(identityComponentFragment && directConsumerRoot ? {
      identityComponentFragment: referenceIdentityComponentFragmentChildBinding(
        identityComponentFragment,
        directConsumerRoot.id,
      ),
    } : {}),
    resolutionAlgorithmVersion,
    validationIdentity: hash({
      algorithm: resolutionAlgorithmVersion,
      compositionId: composition.id,
      consumerNodeId: node.id,
      geometrySemanticIdentity: geometry.semanticIdentity,
      ...(identityComponentFragment && directConsumerRoot ? {
        identityComponentFragment: referenceIdentityComponentFragmentChildBinding(
          identityComponentFragment,
          directConsumerRoot.id,
        ),
      } : {}),
      ...(resolutionAlgorithmVersion === referenceMediaCamera2DAnchoredPathAlgorithmVersion
        ? { mediaAnchorExactCoordinates }
        : {}),
      ownerBindings: ownerBindings.map((binding) => "localSpaceNodeId" in binding
        ? {
          ownerNodeId: binding.ownerNodeId,
          localSpaceNodeId: binding.localSpaceNodeId,
          ownerKind: binding.ownerKind,
        }
        : {
          ownerNodeId: binding.ownerNodeId,
          ownerKind: binding.ownerKind,
          basisKind: binding.basisKind,
          basisNodeId: binding.basisNodeId,
          basisWidth: binding.basisWidth,
          basisHeight: binding.basisHeight,
          basisSemanticIdentity: binding.basisSemanticIdentity,
          ...(binding.responsiveSlotComposition
            ? { responsiveSlotComposition: binding.responsiveSlotComposition }
            : {}),
        }),
    }),
  });
}

export type ReferenceAnchoredPathResolvedOwner = Readonly<{
  status: "visible" | "opacity-zero";
  ownerNodeId: string;
  localSpace: ReferenceLocalSpaceConfig;
  placement: ReferenceLocalSpacePlacement;
  /** Audit-only. Opaque owner content/grade/opacity identity is forbidden from
   * geometry and cache identities. */
  ownerPlanIdentity: string;
}>;

export type ReferenceAnchoredPathResolvedMediaCameraOwner = Readonly<{
  status: "visible" | "opacity-zero";
  ownerNodeId: string;
  ownerKind: "media-camera-2d";
  coordinatePlan: ReferenceMediaCamera2DAnchorPlan;
  basis: ReferenceMediaCamera2DAnchorPlan["basis"];
  sourceToComposition: ReferenceAffine2D;
  affineIdentity: string;
  responsiveSlotComposition?: ReferenceMediaCamera2DResponsiveSlotAnchorPlacement;
  /** Audit-only. Opaque camera/grade/media/opacity identity is forbidden from
   * geometry and cache identities. */
  ownerPlanIdentity: string;
}>;

export type ReferenceAnchoredPathPolicyHiddenOwner = Readonly<{
  status: "policy-hidden";
  ownerNodeId: string;
  ownerKind: "track-2d";
  localSpaceNodeId: string;
  /** Audit-only; deliberately excluded from execution/cache identity. */
  ownerPlanIdentity: string;
}>;

export type ReferenceAnchoredPathOwnerResolution =
  | ReferenceAnchoredPathResolvedOwner
  | ReferenceAnchoredPathResolvedMediaCameraOwner
  | ReferenceAnchoredPathPolicyHiddenOwner;

export type ReferenceAnchoredPathOwnerResolver = (
  ownerNodeId: string,
  exactTime: Rational,
) => ReferenceAnchoredPathOwnerResolution;

export type ReferenceAnchoredPathAnchorEvidence = Readonly<{
  occurrence: number;
  ownerNodeId: string;
  ownerStatus: "visible" | "opacity-zero";
  localPoint: Readonly<{ x: number; y: number }>;
  compositionPoint: Readonly<{ x: number; y: number }>;
  affineIdentity: string;
  /** Evidence-only; not part of geometryIdentity or executionIdentity. */
  ownerPlanIdentity: string;
}> & (
  | Readonly<{
    basisKind?: never;
    localSpaceNodeId: string;
  }>
  | Readonly<{
    basisKind: "post-crop-source-pixel-centres";
    basisNodeId: string;
    basisWidth: number;
    basisHeight: number;
    basisSemanticIdentity: string;
    responsiveSlotComposition?: Readonly<{
      algorithmVersion: ReferenceMediaCamera2DResponsiveSlotAnchorPlacement["algorithmVersion"];
      pixelPlacementAlgorithmVersion: ReferenceMediaCamera2DResponsiveSlotAnchorPlacement["pixelPlacementAlgorithmVersion"];
      compositionId: string;
      stackNodeId: string;
      slotNodeId: string;
      index: number;
      compilerContextIdentity: string;
      outputContextIdentity: string;
      responsivePlanIdentity: string;
      sourceToSlotQ16: ReferenceMediaCamera2DResponsiveSlotAnchorPlacement["sourceToSlotQ16"];
      sourceToSlotAffineIdentity: string;
      slotBasis: ReferenceMediaCamera2DResponsiveSlotAnchorPlacement["slotBasis"];
      slotToCompositionQ16: ReferenceMediaCamera2DResponsiveSlotAnchorPlacement["slotToCompositionQ16"];
      compositionBasis: ReferenceMediaCamera2DResponsiveSlotAnchorPlacement["compositionBasis"];
      rasterSlot: ReferenceMediaCamera2DResponsiveSlotAnchorPlacement["rasterSlot"];
      clip: "half-open-raster-slot";
      placementPlanIdentity: string;
      sourceToCompositionQ16: ReferenceMediaCamera2DAnchorPlan["sourceToDeliveryQ16"];
    }>;
    localSpaceNodeId?: never;
  }>
);

export type ReferenceAnchoredPathResolvedGeometry = Readonly<{
  status: "resolved";
  algorithmVersion?: typeof referenceMediaCamera2DAnchoredPathAlgorithmVersion;
  exactTime: Rational;
  frame?: bigint;
  geometry: ReferenceVectorPathGeometry;
  geometryIdentity: string;
  executionIdentity: string;
  anchors: readonly ReferenceAnchoredPathAnchorEvidence[];
}>;

export type ReferenceAnchoredPathPolicyHiddenResolution = Readonly<{
  status: "policy-hidden";
  algorithmVersion?: typeof referenceMediaCamera2DAnchoredPathAlgorithmVersion;
  exactTime: Rational;
  frame?: bigint;
  suppressedBy: readonly Readonly<{
    ownerNodeId: string;
    ownerKind: "track-2d";
    localSpaceNodeId: string;
    ownerPlanIdentity: string;
  }>[];
  zeroWork: Readonly<{
    kind: "anchored-path-policy-hidden-no-raster";
    geometryPreparations: 0;
    rasterRequests: 0;
    ownerPolicySkips: 1;
  }>;
  executionIdentity: string;
}>;

export type ReferenceAnchoredPathResolution =
  | ReferenceAnchoredPathResolvedGeometry
  | ReferenceAnchoredPathPolicyHiddenResolution;

export type ReferenceAnchoredPathPolicySuppressionIdentity = Readonly<{
  ownerNodeId: string;
  ownerKind: "track-2d";
  localSpaceNodeId: string;
}>;

/** Canonical identity shared by the exact owner resolver and any downstream
 * no-raster admission boundary. Keeping this derivation public inside the
 * reference runtime lets a later boundary authenticate that a claimed
 * transitive MotionPath skip belongs to this geometry, time, and Track2D
 * owner graph instead of trusting an arbitrary 64-hex receipt. */
export function referenceAnchoredPathPolicyHiddenExecutionIdentity(
  geometrySemanticIdentity: string,
  time: Rational,
  suppressedBy: readonly ReferenceAnchoredPathPolicySuppressionIdentity[],
  algorithmVersion: ReferenceAnchoredPathAlgorithmVersion = referenceAnchoredPathAlgorithmVersion,
) {
  return hash({
    algorithm: algorithmVersion,
    status: "policy-hidden",
    geometrySemanticIdentity,
    exactTime: `${time.numerator}/${time.denominator}`,
    suppressedBy,
  });
}

type PreparedOwner = Readonly<{
  sample: ReferenceAnchoredPathResolvedOwner | ReferenceAnchoredPathResolvedMediaCameraOwner;
  affine: ReferenceAffine2D;
  affineIdentity: string;
}>;

function validateResolvedOwner(
  node: IRNode,
  ownerNodeId: string,
  resolution: ReferenceAnchoredPathOwnerResolution,
  execution: Readonly<{ time: Rational; frame?: bigint }>,
  binding?: ReferenceAnchoredPathOwnerBinding,
) {
  if (resolution.ownerNodeId !== ownerNodeId) {
    fail("CUT_ANCHORED_PATH_RESOLUTION", node, `resolver returned owner ${resolution.ownerNodeId} while resolving ${ownerNodeId}`, execution);
  }
  if (resolution.status === "policy-hidden" && resolution.ownerKind !== "track-2d") {
    fail("CUT_ANCHORED_PATH_RESOLUTION", node, `only Track2D may suppress dependent geometry with policy-hidden`, execution);
  }
  if (resolution.status !== "policy-hidden" && "ownerKind" in resolution && resolution.ownerKind === "media-camera-2d") {
    if (!binding || binding.ownerKind !== "media-camera-2d") {
      fail("CUT_ANCHORED_PATH_RESOLUTION", node, `MediaCamera2D owner ${ownerNodeId} has no validated media coordinate binding`, execution);
    }
    if (!isAuthorizedReferenceMediaCamera2DAnchorPlan(
      resolution.coordinatePlan,
      ownerNodeId,
      execution.time,
    )) {
      fail("CUT_ANCHORED_PATH_RESOLUTION", node, `MediaCamera2D owner ${ownerNodeId} returned a cloned, forged, stale, or wrong-time coordinate plan`, execution);
    }
    if (resolution.status !== resolution.coordinatePlan.status
      || resolution.basis !== resolution.coordinatePlan.basis
      || resolution.sourceToComposition !== resolution.coordinatePlan.sourceToDelivery
      || resolution.responsiveSlotComposition !== resolution.coordinatePlan.responsiveSlotComposition
      || resolution.affineIdentity !== resolution.coordinatePlan.affineIdentity) {
      fail("CUT_ANCHORED_PATH_RESOLUTION", node, `MediaCamera2D owner ${ownerNodeId} returned fields that diverge from its authorized coordinate plan`, execution);
    }
    if (resolution.basis.kind !== "post-crop-source-pixel-centres"
      || !Number.isSafeInteger(resolution.basis.width)
      || !Number.isSafeInteger(resolution.basis.height)
      || resolution.basis.width < 1
      || resolution.basis.height < 1
      || typeof resolution.basis.semanticIdentity !== "string"
      || !/^[0-9a-f]{64}$/u.test(resolution.basis.semanticIdentity)
      || resolution.basis.width !== binding.basisWidth
      || resolution.basis.height !== binding.basisHeight
      || resolution.basis.semanticIdentity !== binding.basisSemanticIdentity
      || binding.basisNodeId !== ownerNodeId) {
      fail("CUT_ANCHORED_PATH_RESOLUTION", node, `MediaCamera2D owner ${ownerNodeId} returned an invalid post-crop source basis`, execution);
    }
    const components = Object.values(resolution.sourceToComposition);
    const determinant = resolution.sourceToComposition.a * resolution.sourceToComposition.d
      - resolution.sourceToComposition.b * resolution.sourceToComposition.c;
    if (components.some((value) => !Number.isFinite(value))
      || !Number.isFinite(determinant)
      || Math.abs(determinant) <= 1e-12
      || typeof resolution.affineIdentity !== "string"
      || !/^[0-9a-f]{64}$/u.test(resolution.affineIdentity)) {
      fail("CUT_ANCHORED_PATH_RESOLUTION", node, `MediaCamera2D owner ${ownerNodeId} returned an invalid source-to-composition affine`, execution);
    }
    const authoredSlot = binding.responsiveSlotComposition;
    const plannedSlot = resolution.responsiveSlotComposition;
    if ((authoredSlot === undefined) !== (plannedSlot === undefined)) {
      fail("CUT_ANCHORED_PATH_RESOLUTION", node, `MediaCamera2D owner ${ownerNodeId} changed its validated root/ResponsiveSlot coordinate context`, execution);
    }
    if (authoredSlot && plannedSlot) {
      const expectedTx = String(BigInt(plannedSlot.sourceToSlotQ16.tx) + BigInt(plannedSlot.slotToCompositionQ16.tx));
      const expectedTy = String(BigInt(plannedSlot.sourceToSlotQ16.ty) + BigInt(plannedSlot.slotToCompositionQ16.ty));
      if (plannedSlot.compositionId !== authoredSlot.compositionId
        || plannedSlot.stackNodeId !== authoredSlot.stackNodeId
        || plannedSlot.slotNodeId !== authoredSlot.slotNodeId
        || plannedSlot.index !== authoredSlot.index
        || plannedSlot.compilerContextIdentity !== authoredSlot.compilerContextIdentity
        || plannedSlot.outputContextIdentity !== authoredSlot.outputContextIdentity
        || plannedSlot.responsivePlanIdentity !== authoredSlot.responsivePlanIdentity
        || plannedSlot.clip !== authoredSlot.clip
        || JSON.stringify(plannedSlot.rasterSlot) !== JSON.stringify(authoredSlot.rasterSlot)
        || plannedSlot.slotBasis.width !== authoredSlot.rasterSlot.width
        || plannedSlot.slotBasis.height !== authoredSlot.rasterSlot.height
        || plannedSlot.slotToCompositionQ16.tx !== String(BigInt(authoredSlot.rasterSlot.left) * 65_536n)
        || plannedSlot.slotToCompositionQ16.ty !== String(BigInt(authoredSlot.rasterSlot.top) * 65_536n)
        || resolution.coordinatePlan.sourceToDeliveryQ16.a !== plannedSlot.sourceToSlotQ16.a
        || resolution.coordinatePlan.sourceToDeliveryQ16.b !== plannedSlot.sourceToSlotQ16.b
        || resolution.coordinatePlan.sourceToDeliveryQ16.c !== plannedSlot.sourceToSlotQ16.c
        || resolution.coordinatePlan.sourceToDeliveryQ16.d !== plannedSlot.sourceToSlotQ16.d
        || resolution.coordinatePlan.sourceToDeliveryQ16.tx !== expectedTx
        || resolution.coordinatePlan.sourceToDeliveryQ16.ty !== expectedTy) {
        fail("CUT_ANCHORED_PATH_RESOLUTION", node, `MediaCamera2D owner ${ownerNodeId} returned a forged, transplanted, or contradictory ResponsiveSlot composition placement`, execution);
      }
    }
    return;
  }
  if (resolution.status === "opacity-zero" && resolution.placement.opacity !== 0) {
    fail("CUT_ANCHORED_PATH_RESOLUTION", node, `owner ${ownerNodeId} claimed opacity-zero with nonzero placement opacity`, execution);
  }
  if (resolution.status === "visible" && resolution.placement.opacity === 0) {
    fail("CUT_ANCHORED_PATH_RESOLUTION", node, `owner ${ownerNodeId} claimed visible with zero placement opacity`, execution);
  }
}

function resolvedCoordinate(
  node: IRNode,
  point: Readonly<{ x: number; y: number }>,
  label: string,
  execution: Readonly<{ time: Rational; frame?: bigint }>,
) {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    fail("CUT_ANCHORED_PATH_RESOLUTION", node, `${label} resolved to a non-finite composition coordinate`, execution);
  }
  if (Math.abs(point.x) > cutAnchoredPathLimits.maximumAbsoluteCoordinatePx
    || Math.abs(point.y) > cutAnchoredPathLimits.maximumAbsoluteCoordinatePx) {
    fail(
      "CUT_ANCHORED_PATH_LIMIT",
      node,
      `${label} resolved outside the +/-${cutAnchoredPathLimits.maximumAbsoluteCoordinatePx}px composition envelope`,
      execution,
    );
  }
  return Object.freeze({ x: Object.is(point.x, -0) ? 0 : point.x, y: Object.is(point.y, -0) ? 0 : point.y });
}

/** Resolve one exact frame/sample from already-sampled owner placements. This
 * function never reads a signal, tracking resource, media frame, or private
 * compositor map. The renderer supplies its sole preflight result. */
export function resolveReferenceAnchoredPathGeometryAt(
  node: IRNode,
  geometry: ReferenceAnchoredPathGeometry | ReferenceValidatedAnchoredPathGeometry,
  time: Rational,
  resolveOwner: ReferenceAnchoredPathOwnerResolver,
  frame?: bigint,
): ReferenceAnchoredPathResolution {
  const execution = Object.freeze({ time: Object.freeze({ ...time }), ...(frame === undefined ? {} : { frame }) });
  const algorithmVersion = ("resolutionAlgorithmVersion" in geometry
    ? geometry.resolutionAlgorithmVersion
    : undefined) ?? referenceAnchoredPathAlgorithmVersion;
  const ownerSamples = new Map<string, ReferenceAnchoredPathOwnerResolution>();
  for (const ownerNodeId of geometry.ownerNodeIds) {
    // Tracking fail-policy diagnostics are already source-located upstream and
    // must propagate unchanged. Only a successful sampled owner result enters
    // this module's closed resolver-result validation.
    const sample = resolveOwner(ownerNodeId, time);
    const binding = "ownerBindings" in geometry
      ? geometry.ownerBindings.find((candidate) => candidate.ownerNodeId === ownerNodeId)
      : undefined;
    validateResolvedOwner(node, ownerNodeId, sample, execution, binding);
    ownerSamples.set(ownerNodeId, sample);
  }
  const suppressed = [...ownerSamples.values()]
    .filter((sample): sample is ReferenceAnchoredPathPolicyHiddenOwner => sample.status === "policy-hidden")
    .sort((left, right) => left.ownerNodeId.localeCompare(right.ownerNodeId));
  if (suppressed.length) {
    const suppressedBy = Object.freeze(suppressed.map((sample) => Object.freeze({
      ownerNodeId: sample.ownerNodeId,
      ownerKind: sample.ownerKind,
      localSpaceNodeId: sample.localSpaceNodeId,
      ownerPlanIdentity: sample.ownerPlanIdentity,
    })));
    const identitySuppressions = suppressedBy.map(({ ownerNodeId, ownerKind, localSpaceNodeId }) => ({
      ownerNodeId,
      ownerKind,
      localSpaceNodeId,
    }));
    return Object.freeze({
      status: "policy-hidden" as const,
      ...(algorithmVersion === referenceMediaCamera2DAnchoredPathAlgorithmVersion
        ? { algorithmVersion }
        : {}),
      exactTime: execution.time,
      ...(frame === undefined ? {} : { frame }),
      suppressedBy,
      zeroWork: Object.freeze({
        kind: "anchored-path-policy-hidden-no-raster" as const,
        geometryPreparations: 0 as const,
        rasterRequests: 0 as const,
        ownerPolicySkips: 1 as const,
      }),
      executionIdentity: referenceAnchoredPathPolicyHiddenExecutionIdentity(
        geometry.semanticIdentity,
        time,
        identitySuppressions,
        algorithmVersion,
      ),
    });
  }

  const preparedOwners = new Map<string, PreparedOwner>();
  for (const [ownerNodeId, sample] of ownerSamples) {
    if (sample.status === "policy-hidden") continue;
    if ("ownerKind" in sample && sample.ownerKind === "media-camera-2d") {
      preparedOwners.set(ownerNodeId, Object.freeze({
        sample,
        affine: sample.sourceToComposition,
        affineIdentity: sample.affineIdentity,
      }));
      continue;
    }
    if (sample.localSpace.ownerNodeId !== ownerNodeId
      && !(sample.localSpace.owner === "scene-root" && sample.localSpace.nodeId === ownerNodeId)
      && sample.localSpace.nodeId !== ownerNodeId) {
      fail("CUT_ANCHORED_PATH_GRAPH", node, `resolver bound owner ${ownerNodeId} to unrelated LocalSpace ${sample.localSpace.nodeId}`, execution);
    }
    try {
      const affine = referenceLocalSpaceAuthoredPointAffinePlan(sample.localSpace, sample.placement);
      preparedOwners.set(ownerNodeId, Object.freeze({ sample, affine: affine.affine, affineIdentity: affine.affineIdentity }));
    } catch (error) {
      if (error instanceof ReferenceLocalSpaceAffineError) {
        fail("CUT_ANCHORED_PATH_RESOLUTION", node, `${error.code} while resolving owner ${ownerNodeId}: ${error.message}`, execution);
      }
      throw error;
    }
  }

  const anchors: ReferenceAnchoredPathAnchorEvidence[] = [];
  const resolvePoint = (point: ReferenceSpatialPoint, label: string): Readonly<{ x: number; y: number }> => {
    if (point.kind === "composition-point") return resolvedCoordinate(node, point.point, label, execution);
    if (point.kind === "composition-offset") {
      const base = resolvePoint(point.point, `${label}.point`);
      return resolvedCoordinate(node, { x: base.x + point.by.x, y: base.y + point.by.y }, label, execution);
    }
    const prepared = preparedOwners.get(point.ownerNodeId);
    if (!prepared) fail("CUT_ANCHORED_PATH_RESOLUTION", node, `${label} has no resolved affine owner ${point.ownerNodeId}`, execution);
    const mediaCamera = "ownerKind" in prepared.sample
      && prepared.sample.ownerKind === "media-camera-2d"
      ? prepared.sample
      : undefined;
    const localOwner = mediaCamera
      ? undefined
      : prepared.sample as ReferenceAnchoredPathResolvedOwner;
    if (mediaCamera) {
      if (point.local.x < 0
        || point.local.x > mediaCamera.basis.width - 1
        || point.local.y < 0
        || point.local.y > mediaCamera.basis.height - 1) {
        fail(
          "CUT_ANCHORED_PATH_RANGE",
          node,
          `${label} source point (${point.local.x}, ${point.local.y}) lies outside MediaCamera2D ${point.ownerNodeId}'s locked post-crop pixel-centre bounds [0, ${mediaCamera.basis.width - 1}] x [0, ${mediaCamera.basis.height - 1}]`,
          execution,
        );
      }
    } else if (!anchorInsideView(point, localOwner!.localSpace)) {
      fail(
        "CUT_ANCHORED_PATH_RANGE",
        node,
        `${label} local point (${point.local.x}, ${point.local.y}) lies outside LocalSpace ${localOwner!.localSpace.nodeId}'s closed authored view`,
        execution,
      );
    }
    const compositionPoint = resolvedCoordinate(
      node,
      transformReferencePoint(prepared.affine, point.local.x, point.local.y),
      label,
      execution,
    );
    const evidenceBase = {
      occurrence: anchors.length,
      ownerNodeId: point.ownerNodeId,
      ownerStatus: prepared.sample.status,
      localPoint: point.local,
      compositionPoint,
      affineIdentity: prepared.affineIdentity,
      ownerPlanIdentity: prepared.sample.ownerPlanIdentity,
    };
    anchors.push(Object.freeze(mediaCamera ? {
      ...evidenceBase,
      basisKind: mediaCamera.basis.kind,
      basisNodeId: mediaCamera.ownerNodeId,
      basisWidth: mediaCamera.basis.width,
      basisHeight: mediaCamera.basis.height,
      basisSemanticIdentity: mediaCamera.basis.semanticIdentity,
      ...(mediaCamera.responsiveSlotComposition ? {
        responsiveSlotComposition: Object.freeze({
          ...mediaCamera.responsiveSlotComposition,
          sourceToCompositionQ16: mediaCamera.coordinatePlan.sourceToDeliveryQ16,
        }),
      } : {}),
    } : {
      ...evidenceBase,
      localSpaceNodeId: localOwner!.localSpace.nodeId,
    }));
    return compositionPoint;
  };

  const start = resolvePoint(geometry.start, "start");
  const segments = geometry.segments.map((segment, index): ReferenceVectorPathSegment => segment.kind === "line"
    ? Object.freeze({ kind: "line" as const, to: resolvePoint(segment.to, `segments[${index}].to`) })
    : Object.freeze({
      kind: "cubic" as const,
      control1: resolvePoint(segment.control1, `segments[${index}].control1`),
      control2: resolvePoint(segment.control2, `segments[${index}].control2`),
      to: resolvePoint(segment.to, `segments[${index}].to`),
    }));
  const resolvedGeometry = Object.freeze({ start, segments: Object.freeze(segments), closed: geometry.closed });
  const spatialBases = Object.freeze([...preparedOwners.entries()]
    .map(([ownerNodeId, prepared]) => ({ ownerNodeId, affineIdentity: prepared.affineIdentity }))
    .sort((left, right) => left.ownerNodeId.localeCompare(right.ownerNodeId)));
  const authoredGeometryIdentity = algorithmVersion === referenceMediaCamera2DAnchoredPathAlgorithmVersion
    && "validationIdentity" in geometry
    ? geometry.validationIdentity
    : geometry.semanticIdentity;
  const geometryIdentity = hash({
    algorithm: algorithmVersion,
    geometrySemanticIdentity: authoredGeometryIdentity,
    spatialBases,
    geometry: resolvedGeometry,
  });
  return Object.freeze({
    status: "resolved" as const,
    ...(algorithmVersion === referenceMediaCamera2DAnchoredPathAlgorithmVersion
      ? { algorithmVersion }
      : {}),
    exactTime: execution.time,
    ...(frame === undefined ? {} : { frame }),
    geometry: resolvedGeometry,
    geometryIdentity,
    executionIdentity: hash({
      algorithm: algorithmVersion,
      status: "resolved",
      geometryIdentity,
      exactTime: `${time.numerator}/${time.denominator}`,
    }),
    anchors: Object.freeze(anchors),
  });
}

export function referenceAnchoredPathInspect(
  geometry: ReferenceAnchoredPathGeometry | ReferenceValidatedAnchoredPathGeometry,
) {
  const mediaBindings = "ownerBindings" in geometry
    ? geometry.ownerBindings.filter(
      (binding): binding is ReferenceAnchoredPathMediaCameraOwnerBinding =>
        binding.ownerKind === "media-camera-2d",
    )
    : [];
  return Object.freeze({
    algorithmVersion: referenceAnchoredPathAlgorithmVersion,
    ...(mediaBindings.length ? {
      resolutionAlgorithmVersion: referenceMediaCamera2DAnchoredPathAlgorithmVersion,
      mediaCameraBases: Object.freeze(mediaBindings.map((binding) => Object.freeze({
        ownerNodeId: binding.ownerNodeId,
        basisKind: binding.basisKind,
        basisNodeId: binding.basisNodeId,
        width: binding.basisWidth,
        height: binding.basisHeight,
        semanticIdentity: binding.basisSemanticIdentity,
        ...(binding.responsiveSlotComposition ? {
          responsiveSlotComposition: binding.responsiveSlotComposition,
          coordinateChain: Object.freeze([
            "post-crop-source-pixel-centres",
            "responsive-slot-pixel-centres",
            "integer-slot-placement",
            "composition-pixel-centres",
          ] as const),
        } : {}),
      }))),
    } : {}),
    geometryKind: geometry.geometryKind,
    segments: geometry.segments.length,
    spatialPointCount: geometry.spatialPointCount,
    visualAnchorCount: geometry.visualAnchorCount,
    ownerNodeIds: Object.freeze([...geometry.ownerNodeIds]),
    closed: geometry.closed,
    semanticIdentity: geometry.semanticIdentity,
    resolution: "exact-frame-owner-placement" as const,
    policy: Object.freeze({
      opacityZero: "coordinate-remains-resolvable" as const,
      trackPolicyHidden: "suppresses-dependent-geometry" as const,
      projectiveOwners: "unsupported-v1" as const,
      ...(mediaBindings.length ? {
        mediaCameraOpacity: "coordinate-remains-resolvable-before-camera-opacity" as const,
        mediaCameraTracking: "not-claimed-source-coordinate-binding-only" as const,
        ...(mediaBindings.some((binding) => binding.responsiveSlotComposition) ? {
          responsiveSlotPlacement: "authenticated-integer-translation-no-resample" as const,
        } : {}),
      } : {}),
    }),
  });
}
