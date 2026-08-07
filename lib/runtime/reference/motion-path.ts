import type { CutAVIR, IRComposition, IRNode, IRSignal, IRValue } from "../../language/ir";
import {
  addRational,
  divideRational,
  multiplyRational,
  rational,
  rationalToNumber,
  type Rational,
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
import {
  prepareReferenceTrace,
  referenceCubicTraceFlattening,
  referenceTracePrefixWithTangent,
  type PreparedReferenceTrace,
} from "./trace";
import {
  decodeReferenceVectorPathGeometry,
  prepareReferenceVectorPathGeometry,
  ReferenceVectorPathError,
} from "./vector-path";

export const referenceMotionPathLimits = Object.freeze({
  minimumPoints: 2,
  maximumPoints: 1_024,
  maximumAbsoluteCoordinate: 65_536,
  maximumArcLength: 16_777_216,
  maximumControlEffectFrameSamples: 4_096,
});

export const referenceAnchoredMotionPathLimits = Object.freeze({
  maximumPreflightFrames: 60_000,
  maximumAuthoredSegmentFramesPerNode: 25_000_000,
  maximumAuthoredSegmentFramesPerComposition: 100_000_000,
  maximumFlattenedPointFramesPerNode: 12_000_000,
  maximumFlattenedPointFramesPerComposition: 48_000_000,
  maximumSpatialPointFramesPerNode: 48_000_000,
  maximumSpatialPointFramesPerComposition: 192_000_000,
  maximumOwnerSampleFramesPerNode: 48_000_000,
  maximumOwnerSampleFramesPerComposition: 192_000_000,
});

export type ReferenceMotionPathErrorCode =
  | "CUT_MOTION_PATH_TYPE"
  | "CUT_MOTION_PATH_RANGE"
  | "CUT_MOTION_PATH_SHAPE"
  | "CUT_MOTION_PATH_GEOMETRY"
  | "CUT_MOTION_PATH_NOOP"
  | "CUT_MOTION_PATH_LIMIT";

export class ReferenceMotionPathError extends Error {
  constructor(readonly code: ReferenceMotionPathErrorCode, readonly nodeId: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ReferenceMotionPathError";
  }
}

type Point = { x: number; y: number };
type Segment = { from: Point; dx: number; dy: number; length: number };

export type ReferenceMotionPathPlan = Readonly<{
  nodeId: string;
  pathForm: "points" | "geometry";
  trace: PreparedReferenceTrace;
  /** Executed nonzero polyline edges, or authored line/cubic geometry segments. */
  authoredSegments: number;
  closed: boolean;
  /** Present only when adaptive cubic flattening can participate. */
  flatteningVersion?: number;
}>;

export type ReferenceAnchoredMotionPathPlan = Readonly<{
  nodeId: string;
  pathForm: "anchored-geometry";
  geometry: ReferenceAnchoredPathGeometry | ReferenceValidatedAnchoredPathGeometry;
  authoredSegments: number;
  closed: boolean;
  flatteningVersion: number;
}>;

export type ReferenceAnchoredMotionPathResolution =
  | Readonly<{
    status: "resolved";
    sample: ReferenceMotionPathSample;
    trace: PreparedReferenceTrace;
    geometryIdentity: string;
    executionIdentity: string;
    anchored: Extract<ReferenceAnchoredPathResolution, { status: "resolved" }>;
  }>
  | Readonly<{
    status: "policy-hidden";
    executionIdentity: string;
    anchored: Extract<ReferenceAnchoredPathResolution, { status: "policy-hidden" }>;
  }>;

function location(node: IRNode) {
  return `${node.provenance.module}:${node.provenance.span.start.line}:${node.provenance.span.start.column}`;
}

function fail(node: IRNode, code: ReferenceMotionPathErrorCode, message: string): never {
  throw new ReferenceMotionPathError(code, node.id, `cut.visual.motion_path at ${location(node)} ${message}`);
}

function exactLength(node: IRNode, value: IRValue | undefined, label: string) {
  if (value?.kind !== "quantity" || value.dimension !== "length" || value.unit !== "px") {
    fail(node, "CUT_MOTION_PATH_TYPE", `${label} must be a canonical Length in px.`);
  }
  const result = rationalToNumber(value.magnitude);
  if (!Number.isFinite(result)) fail(node, "CUT_MOTION_PATH_RANGE", `${label} must be finite.`);
  if (Math.abs(result) > referenceMotionPathLimits.maximumAbsoluteCoordinate) {
    fail(node, "CUT_MOTION_PATH_RANGE", `${label} exceeds the ${referenceMotionPathLimits.maximumAbsoluteCoordinate}px coordinate limit.`);
  }
  return result;
}

function booleanInput(node: IRNode, name: string, fallback: boolean) {
  const value = node.inputs[name];
  if (value === undefined) return fallback;
  if (value.kind !== "boolean") fail(node, "CUT_MOTION_PATH_TYPE", `input “${name}” must be Boolean.`);
  return value.value;
}

function ratio(node: IRNode, value: IRValue | undefined, label: string, allowNull: boolean) {
  if (value?.kind === "null" && allowNull) return undefined;
  if (value?.kind !== "quantity" || value.dimension !== "ratio" || value.unit !== "ratio") {
    fail(node, "CUT_MOTION_PATH_TYPE", `${label} must be a canonical Ratio.`);
  }
  const result = rationalToNumber(value.magnitude);
  if (!Number.isFinite(result) || result < 0 || result > 1) {
    fail(node, "CUT_MOTION_PATH_RANGE", `${label} must be between 0% and 100%.`);
  }
  return result;
}

function signalValues(signal: IRSignal) {
  if (signal.kind === "constant") return [{ value: signal.value, label: ".value", allowNull: false }];
  if (signal.kind === "step") return signal.points.map((point, index) => ({ value: point.value, label: `.points[${index}].value`, allowNull: false }));
  if (signal.kind === "keyframes") return signal.keyframes.map((keyframe, index) => ({ value: keyframe.value, label: `.keyframes[${index}].value`, allowNull: false }));
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

function decodePoints(node: IRNode) {
  const value = node.inputs.points;
  if (value?.kind !== "array") fail(node, "CUT_MOTION_PATH_TYPE", "input “points” must be a List<Vec2>.");
  if (value.items.length < referenceMotionPathLimits.minimumPoints || value.items.length > referenceMotionPathLimits.maximumPoints) {
    fail(node, "CUT_MOTION_PATH_LIMIT", `input “points” must contain ${referenceMotionPathLimits.minimumPoints} through ${referenceMotionPathLimits.maximumPoints} coordinates.`);
  }
  return value.items.map((item, index) => {
    if (item.kind !== "object" || Object.keys(item.entries).length !== 2 || !Object.hasOwn(item.entries, "x") || !Object.hasOwn(item.entries, "y")) {
      fail(node, "CUT_MOTION_PATH_SHAPE", `input “points”[${index}] must be a closed Vec2 with exactly x and y.`);
    }
    return {
      x: exactLength(node, item.entries.x, `input “points”[${index}].x`),
      y: exactLength(node, item.entries.y, `input “points”[${index}].y`),
    };
  });
}

function decodeGeometry(node: IRNode) {
  if (node.inputs.geometry === undefined) return undefined;
  try {
    const geometry = decodeReferenceVectorPathGeometry(node, node.inputs.geometry, "input “geometry”");
    const trace = prepareReferenceVectorPathGeometry(node, geometry);
    if (trace.totalLength > referenceMotionPathLimits.maximumArcLength) {
      fail(node, "CUT_MOTION_PATH_LIMIT", `cumulative arc length exceeds ${referenceMotionPathLimits.maximumArcLength}px.`);
    }
    return { geometry, trace };
  } catch (error) {
    if (error instanceof ReferenceMotionPathError) throw error;
    if (!(error instanceof ReferenceVectorPathError)) throw error;
    const code: ReferenceMotionPathErrorCode = error.code === "CUT_VECTOR_PATH_LIMIT"
      ? "CUT_MOTION_PATH_LIMIT"
      : "CUT_MOTION_PATH_GEOMETRY";
    fail(node, code, error.detail);
  }
}

function geometryChoice(node: IRNode) {
  const hasPoints = node.inputs.points !== undefined, hasGeometry = node.inputs.geometry !== undefined;
  if (hasPoints === hasGeometry) {
    fail(node, "CUT_MOTION_PATH_GEOMETRY", "requires exactly one path form: input “points” or input “geometry”.");
  }
  if (hasGeometry && node.inputs.closed !== undefined) {
    fail(node, "CUT_MOTION_PATH_GEOMETRY", "input “closed” cannot be authored with input “geometry” because VectorPathGeometry owns its closure.");
  }
  if (hasPoints && node.inputs.closed?.kind === "boolean" && !node.inputs.closed.value) {
    fail(node, "CUT_MOTION_PATH_NOOP", "input “closed: false” is the points-form default and cannot affect execution; omit it.");
  }
  if (node.inputs.orientToPath?.kind === "boolean" && !node.inputs.orientToPath.value) {
    fail(node, "CUT_MOTION_PATH_NOOP", "input “orientToPath: false” is the default and cannot affect execution; omit it.");
  }
  return hasGeometry ? "geometry" as const : "points" as const;
}

function preparePolylineTrace(node: IRNode, points: readonly Point[], closed: boolean) {
  const path = segments(node, points, closed);
  const first = path.segments[0]!.from;
  return {
    path,
    trace: prepareReferenceTrace([
      first,
      ...path.segments.map((segment) => ({ x: segment.from.x + segment.dx, y: segment.from.y + segment.dy })),
    ]),
  };
}

export function prepareReferenceAnchoredMotionPathNode(
  node: IRNode,
  validatedGeometry?: ReferenceValidatedAnchoredPathGeometry,
): ReferenceAnchoredMotionPathPlan | undefined {
  if (node.op !== "cut.visual.motion_path" || !isReferenceAnchoredPathGeometryValue(node.inputs.geometry)) return undefined;
  if (node.inputs.points !== undefined) fail(node, "CUT_MOTION_PATH_GEOMETRY", "cannot combine input “points” with AnchoredPathGeometry.");
  if (node.inputs.closed !== undefined) {
    fail(node, "CUT_MOTION_PATH_GEOMETRY", "input “closed” cannot be authored with input “geometry” because AnchoredPathGeometry owns its closure.");
  }
  if (node.inputs.orientToPath?.kind === "boolean" && !node.inputs.orientToPath.value) {
    fail(node, "CUT_MOTION_PATH_NOOP", "input “orientToPath: false” is the default and cannot affect execution; omit it.");
  }
  const geometry = validatedGeometry ?? decodeReferenceAnchoredPathGeometry(node, node.inputs.geometry, "input “geometry”");
  return Object.freeze({
    nodeId: node.id,
    pathForm: "anchored-geometry" as const,
    geometry,
    authoredSegments: geometry.segments.length,
    closed: geometry.closed,
    flatteningVersion: referenceCubicTraceFlattening.version,
  });
}

/** Decode and prepare the complete immutable spatial meaning of one MotionPath. */
export function prepareReferenceMotionPathNode(node: IRNode): ReferenceMotionPathPlan {
  if (node.op !== "cut.visual.motion_path") fail(node, "CUT_MOTION_PATH_TYPE", "cannot prepare a different kernel.");
  if (isReferenceAnchoredPathGeometryValue(node.inputs.geometry)) {
    fail(node, "CUT_MOTION_PATH_GEOMETRY", "AnchoredPathGeometry requires the owner-resolved MotionPath preparation API.");
  }
  const choice = geometryChoice(node);
  if (choice === "geometry") {
    const prepared = decodeGeometry(node)!;
    return Object.freeze({
      nodeId: node.id,
      pathForm: "geometry" as const,
      trace: prepared.trace,
      authoredSegments: prepared.geometry.segments.length,
      closed: prepared.geometry.closed,
      flatteningVersion: referenceCubicTraceFlattening.version,
    });
  }
  const points = decodePoints(node), closed = booleanInput(node, "closed", false);
  const prepared = preparePolylineTrace(node, points, closed);
  return Object.freeze({
    nodeId: node.id,
    pathForm: "points" as const,
    trace: prepared.trace,
    authoredSegments: prepared.path.segments.length,
    closed,
  });
}

function segments(node: IRNode, points: readonly Point[], closed: boolean) {
  const result: Segment[] = [];
  const count = points.length - 1 + (closed ? 1 : 0);
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    const from = points[index % points.length];
    const to = points[(index + 1) % points.length];
    const dx = to.x - from.x, dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    if (length === 0) continue;
    total += length;
    if (!Number.isFinite(total) || total > referenceMotionPathLimits.maximumArcLength) {
      fail(node, "CUT_MOTION_PATH_LIMIT", `cumulative arc length exceeds ${referenceMotionPathLimits.maximumArcLength}px.`);
    }
    result.push({ from, dx, dy, length });
  }
  if (!result.length) fail(node, "CUT_MOTION_PATH_SHAPE", "input “points” must describe a positive-length path.");
  return { segments: result, total };
}

export function validateReferenceMotionPath(ir: CutAVIR, node: IRNode) {
  if (node.op !== "cut.visual.motion_path") return;
  const anchored = prepareReferenceAnchoredMotionPathNode(node);
  const prepared = anchored ? undefined : prepareReferenceMotionPathNode(node);
  booleanInput(node, "orientToPath", false);
  const direct = node.inputs.progress;
  if (direct !== undefined) ratio(node, direct, "input “progress”", false);
  const property = node.properties.progress;
  if (property && !("signal" in property)) {
    ratio(node, property, "property “progress”", false);
  } else if (property) {
    const signal = ir.signals[property.signal];
    if (!signal) fail(node, "CUT_MOTION_PATH_TYPE", `property “progress” references missing signal ${property.signal}.`);
    if (signal.valueType !== "Ratio") fail(node, "CUT_MOTION_PATH_TYPE", `property “progress” signal ${signal.id} must declare valueType Ratio.`);
    for (const item of signalValues(signal)) ratio(node, item.value, `property “progress” signal ${signal.id}${item.label}`, item.allowNull);
  }
  // Owner-resolved tangents do not exist until exact placement sampling. The
  // renderer must call validateReferenceAnchoredMotionPathFrameStates before
  // its first dependent pixel allocation; the legacy proof remains unchanged.
  if (prepared) validateMotionPathControlEffects(ir, node, prepared);
}

function compositionContainsNode(ir: CutAVIR, composition: IRComposition, nodeId: string) {
  const pending = [...composition.rootVisualIds, ...composition.rootAVIds];
  const visited = new Set<string>();
  while (pending.length) {
    const current = pending.pop()!;
    if (current === nodeId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    const currentNode = ir.nodes[current];
    if (currentNode) pending.push(...currentNode.children);
  }
  return false;
}

function owningCompositions(ir: CutAVIR, node: IRNode) {
  return ir.compositions.filter((composition) => node.sceneId
    ? composition.sceneIds.includes(node.sceneId)
    : compositionContainsNode(ir, composition, node.id));
}

function sampledFrameSpan(node: IRNode, composition: IRComposition) {
  try {
    const scaledStart = multiplyRational(node.interval.start, composition.fps);
    const scaledEnd = multiplyRational(addRational(node.interval.start, node.interval.duration), composition.fps);
    const startNumerator = BigInt(scaledStart.numerator), startDenominator = BigInt(scaledStart.denominator);
    const endNumerator = BigInt(scaledEnd.numerator), endDenominator = BigInt(scaledEnd.denominator);
    if (startNumerator < 0n || endNumerator < 0n || startDenominator <= 0n || endDenominator <= 0n) return undefined;
    const first = (startNumerator + startDenominator - 1n) / startDenominator;
    const last = (endNumerator + endDenominator - 1n) / endDenominator - 1n;
    return first <= last ? { first, last } : undefined;
  } catch {
    // The ordinary rational and interval validators own malformed hostile IR.
    return undefined;
  }
}

function withoutInput(node: IRNode, input: "closed" | "orientToPath") {
  const inputs = { ...node.inputs };
  delete inputs[input];
  return { ...node, inputs };
}

function samplesDiffer(left: ReferenceMotionPathSample, right: ReferenceMotionPathSample) {
  return left.x !== right.x || left.y !== right.y || left.rotation !== right.rotation;
}

/**
 * Prove that each authored opt-in control changes the executed MotionPath
 * transform on at least one exact reachable output frame. The proof compares
 * against the public omission/default counterfactual and is deliberately
 * bounded. A path longer than the bound is accepted only when a changing frame
 * is found within the bound; otherwise CUT fails closed instead of silently
 * accepting an unproved control.
 */
function validateMotionPathControlEffects(ir: CutAVIR, node: IRNode, prepared: ReferenceMotionPathPlan) {
  const controls: Array<{ input: "closed" | "orientToPath"; label: string }> = [];
  if (prepared.pathForm === "points" && node.inputs.closed?.kind === "boolean" && node.inputs.closed.value) {
    controls.push({ input: "closed", label: "closed: true" });
  }
  if (node.inputs.orientToPath?.kind === "boolean" && node.inputs.orientToPath.value) {
    controls.push({ input: "orientToPath", label: "orientToPath: true" });
  }
  if (!controls.length) return;

  const compositions = owningCompositions(ir, node);
  if (!compositions.length) {
    fail(node, "CUT_MOTION_PATH_NOOP", "has authored MotionPath controls but no reachable output-frame sample on which they can execute.");
  }

  for (const control of controls) {
    const counterfactual = withoutInput(node, control.input);
    const counterfactualPlan = control.input === "closed"
      ? prepareReferenceMotionPathNode(counterfactual)
      : prepared;
    let samples = 0;
    let sawReachableSample = false;
    let changed = false;
    for (const composition of compositions) {
      const span = sampledFrameSpan(node, composition);
      if (!span) continue;
      sawReachableSample = true;
      for (let frame = span.first; frame <= span.last; frame += 1n) {
        if (samples >= referenceMotionPathLimits.maximumControlEffectFrameSamples) {
          fail(
            node,
            "CUT_MOTION_PATH_LIMIT",
            `cannot prove input “${control.label}” affects an output frame within the ${referenceMotionPathLimits.maximumControlEffectFrameSamples}-sample control-effect bound; shorten the active interval or make the effect occur earlier.`,
          );
        }
        samples += 1;
        const time = divideRational(rational(frame), composition.fps);
        if (samplesDiffer(
          referenceMotionPathAt(ir, composition, node, time, prepared),
          referenceMotionPathAt(ir, composition, counterfactual, time, counterfactualPlan),
        )) {
          changed = true;
          break;
        }
      }
      if (changed) break;
    }
    if (!sawReachableSample || !changed) {
      fail(
        node,
        "CUT_MOTION_PATH_NOOP",
        `input “${control.label}” never changes position or executed tangent orientation versus omitting it on any exact reachable output-frame sample.`,
      );
    }
  }
}

export type ReferenceMotionPathSample = {
  /** Centre-relative destination used by the common retained transform. */
  x: number;
  y: number;
  /** Clockwise degrees in screen coordinates, or zero when orientation is disabled. */
  rotation: number;
};

/** Every executable path-tangent rotation, for validation before rendering. */
export function referenceMotionPathTangentRotations(node: IRNode, prepared?: ReferenceMotionPathPlan): readonly number[] {
  if (node.op !== "cut.visual.motion_path") fail(node, "CUT_MOTION_PATH_TYPE", "cannot inspect tangents for a different kernel.");
  if (!booleanInput(node, "orientToPath", false)) return [0];
  const plan = prepared ?? prepareReferenceMotionPathNode(node);
  if (plan.nodeId !== node.id) fail(node, "CUT_MOTION_PATH_GEOMETRY", `prepared plan belongs to ${plan.nodeId}, not ${node.id}.`);
  const trace = plan.trace;
  const rotations: number[] = [];
  for (let index = 1; index < trace.points.length; index += 1) {
    const from = trace.points[index - 1]!, to = trace.points[index]!;
    const dx = to.x - from.x, dy = to.y - from.y;
    if (dx !== 0 || dy !== 0) rotations.push(Math.atan2(dy, dx) * 180 / Math.PI);
  }
  return [...new Set(rotations)];
}

/** Sample one bounded polyline or typed vector geometry at constant cumulative-arc-length speed. */
export function referenceMotionPathAt(
  ir: CutAVIR,
  composition: IRComposition,
  node: IRNode,
  time: Rational,
  prepared?: ReferenceMotionPathPlan,
): ReferenceMotionPathSample {
  if (node.op !== "cut.visual.motion_path") fail(node, "CUT_MOTION_PATH_TYPE", "cannot sample a different kernel.");
  const plan = prepared ?? prepareReferenceMotionPathNode(node);
  if (plan.nodeId !== node.id) fail(node, "CUT_MOTION_PATH_GEOMETRY", `prepared plan belongs to ${plan.nodeId}, not ${node.id}.`);
  const sampled = propertyAt(ir, node, "progress", time) ?? node.inputs.progress;
  const progress = ratio(node, sampled ?? { kind: "quantity", dimension: "ratio", magnitude: { numerator: "0", denominator: "1" }, unit: "ratio" }, "executed progress", false)!;
  const { head, tangent } = referenceTracePrefixWithTangent(plan.trace, progress);
  return {
    x: head.x - composition.width / 2,
    y: head.y - composition.height / 2,
    rotation: booleanInput(node, "orientToPath", false) ? Math.atan2(tangent.y, tangent.x) * 180 / Math.PI : 0,
  };
}

/** Sample a symbolic owner-resolved route at one exact time. Track2D hide is
 * propagated as an explicit non-error result so the dependent subject cannot
 * accidentally render at a stale/default coordinate. */
export function referenceAnchoredMotionPathResolutionAt(
  ir: CutAVIR,
  composition: IRComposition,
  node: IRNode,
  time: Rational,
  plan: ReferenceAnchoredMotionPathPlan,
  resolveOwner: ReferenceAnchoredPathOwnerResolver,
  frame?: bigint,
): ReferenceAnchoredMotionPathResolution {
  if (node.op !== "cut.visual.motion_path") fail(node, "CUT_MOTION_PATH_TYPE", "cannot sample a different kernel.");
  if (plan.nodeId !== node.id) fail(node, "CUT_MOTION_PATH_GEOMETRY", `prepared anchored plan belongs to ${plan.nodeId}, not ${node.id}.`);
  if (!("validationIdentity" in plan.geometry)) {
    fail(node, "CUT_MOTION_PATH_GEOMETRY", "anchored execution requires the validated same-composition owner/LocalSpace graph plan.");
  }
  const anchored = resolveReferenceAnchoredPathGeometryAt(node, plan.geometry, time, resolveOwner, frame);
  if (anchored.status === "policy-hidden") {
    return Object.freeze({ status: "policy-hidden" as const, executionIdentity: anchored.executionIdentity, anchored });
  }
  let trace: PreparedReferenceTrace;
  try { trace = prepareReferenceVectorPathGeometry(node, anchored.geometry); }
  catch (error) {
    if (!(error instanceof ReferenceVectorPathError)) throw error;
    const code: ReferenceMotionPathErrorCode = error.code === "CUT_VECTOR_PATH_LIMIT"
      ? "CUT_MOTION_PATH_LIMIT"
      : "CUT_MOTION_PATH_GEOMETRY";
    const exact = ` at exact time ${time.numerator}/${time.denominator}s${frame === undefined ? "" : ` (output frame ${frame})`}`;
    fail(node, code, `${error.detail}${exact}.`);
  }
  if (trace.totalLength > referenceMotionPathLimits.maximumArcLength) {
    const exact = ` at exact time ${time.numerator}/${time.denominator}s${frame === undefined ? "" : ` (output frame ${frame})`}`;
    fail(node, "CUT_MOTION_PATH_LIMIT", `cumulative arc length exceeds ${referenceMotionPathLimits.maximumArcLength}px${exact}.`);
  }
  const sampled = propertyAt(ir, node, "progress", time) ?? node.inputs.progress;
  const progress = ratio(node, sampled ?? { kind: "quantity", dimension: "ratio", magnitude: { numerator: "0", denominator: "1" }, unit: "ratio" }, "executed progress", false)!;
  const { head, tangent } = referenceTracePrefixWithTangent(trace, progress);
  const sample = Object.freeze({
    x: head.x - composition.width / 2,
    y: head.y - composition.height / 2,
    rotation: booleanInput(node, "orientToPath", false) ? Math.atan2(tangent.y, tangent.x) * 180 / Math.PI : 0,
  });
  return Object.freeze({
    status: "resolved" as const,
    sample,
    trace,
    geometryIdentity: anchored.geometryIdentity,
    executionIdentity: anchored.executionIdentity,
    anchored,
  });
}

export type ReferenceAnchoredMotionPathWork = Readonly<{
  authoredSegmentFrames: number;
  spatialPointFrames: number;
  ownerSampleFrames: number;
  flattenedPointFrames: number;
  resolvedFrames: number;
  policyHiddenFrames: number;
  orientControlChanged: boolean;
}>;

/** Exact owner-aware preflight. It both bounds cumulative geometry work and
 * proves orientToPath:true has a real effect on at least one reachable,
 * non-hidden output frame before a dependent subject can allocate pixels. */
export function validateReferenceAnchoredMotionPathFrameStates(
  ir: CutAVIR,
  composition: IRComposition,
  node: IRNode,
  plan: ReferenceAnchoredMotionPathPlan,
  resolveOwner: ReferenceAnchoredPathOwnerResolver,
): ReferenceAnchoredMotionPathWork {
  const span = sampledFrameSpan(node, composition);
  if (!span) fail(node, "CUT_MOTION_PATH_RANGE", "has no exact reachable output-frame sample in its active interval.");
  const frames = span.last - span.first + 1n;
  if (frames > BigInt(referenceAnchoredMotionPathLimits.maximumPreflightFrames)) {
    fail(node, "CUT_MOTION_PATH_LIMIT", `anchored preflight requires ${frames} output-frame samples, exceeding the ${referenceAnchoredMotionPathLimits.maximumPreflightFrames}-sample bound.`);
  }
  const authoredSegmentFrames = BigInt(plan.authoredSegments) * frames;
  if (authoredSegmentFrames > BigInt(referenceAnchoredMotionPathLimits.maximumAuthoredSegmentFramesPerNode)) {
    fail(node, "CUT_MOTION_PATH_LIMIT", `anchored authored segment-frame work exceeds ${referenceAnchoredMotionPathLimits.maximumAuthoredSegmentFramesPerNode}.`);
  }
  const spatialPointFrames = BigInt(plan.geometry.spatialPointCount) * frames;
  if (spatialPointFrames > BigInt(referenceAnchoredMotionPathLimits.maximumSpatialPointFramesPerNode)) {
    fail(node, "CUT_MOTION_PATH_LIMIT", `anchored spatial-point-frame work exceeds ${referenceAnchoredMotionPathLimits.maximumSpatialPointFramesPerNode}.`);
  }
  const ownerSampleFrames = BigInt(plan.geometry.ownerNodeIds.length) * frames;
  if (ownerSampleFrames > BigInt(referenceAnchoredMotionPathLimits.maximumOwnerSampleFramesPerNode)) {
    fail(node, "CUT_MOTION_PATH_LIMIT", `anchored owner-sample-frame work exceeds ${referenceAnchoredMotionPathLimits.maximumOwnerSampleFramesPerNode}.`);
  }
  let flattenedPointFrames = 0n, resolvedFrames = 0n, policyHiddenFrames = 0n;
  let orientControlChanged = false;
  for (let frame = span.first; frame <= span.last; frame += 1n) {
    const time = divideRational(rational(frame), composition.fps);
    const resolution = referenceAnchoredMotionPathResolutionAt(ir, composition, node, time, plan, resolveOwner, frame);
    if (resolution.status === "policy-hidden") {
      policyHiddenFrames += 1n;
      continue;
    }
    resolvedFrames += 1n;
    flattenedPointFrames += BigInt(resolution.trace.points.length);
    if (flattenedPointFrames > BigInt(referenceAnchoredMotionPathLimits.maximumFlattenedPointFramesPerNode)) {
      fail(node, "CUT_MOTION_PATH_LIMIT", `anchored flattened point-frame work exceeds ${referenceAnchoredMotionPathLimits.maximumFlattenedPointFramesPerNode}.`);
    }
    if (resolution.sample.rotation !== 0) orientControlChanged = true;
  }
  if (booleanInput(node, "orientToPath", false) && !orientControlChanged) {
    fail(
      node,
      "CUT_MOTION_PATH_NOOP",
      `input “orientToPath: true” never changes executed rotation on ${resolvedFrames} resolved output frames; ${policyHiddenFrames} frames were suppressed by owner policy.`,
    );
  }
  return Object.freeze({
    authoredSegmentFrames: Number(authoredSegmentFrames),
    spatialPointFrames: Number(spatialPointFrames),
    ownerSampleFrames: Number(ownerSampleFrames),
    flattenedPointFrames: Number(flattenedPointFrames),
    resolvedFrames: Number(resolvedFrames),
    policyHiddenFrames: Number(policyHiddenFrames),
    orientControlChanged,
  });
}

export function validateReferenceAnchoredMotionPathCompositionWork(
  nodeWork: readonly { node: IRNode; work: ReferenceAnchoredMotionPathWork }[],
) {
  const total = nodeWork.reduce((sum, item) => ({
    authoredSegmentFrames: sum.authoredSegmentFrames + item.work.authoredSegmentFrames,
    spatialPointFrames: sum.spatialPointFrames + item.work.spatialPointFrames,
    ownerSampleFrames: sum.ownerSampleFrames + item.work.ownerSampleFrames,
    flattenedPointFrames: sum.flattenedPointFrames + item.work.flattenedPointFrames,
  }), { authoredSegmentFrames: 0, spatialPointFrames: 0, ownerSampleFrames: 0, flattenedPointFrames: 0 });
  const exceeded = total.authoredSegmentFrames > referenceAnchoredMotionPathLimits.maximumAuthoredSegmentFramesPerComposition
    ? `composition anchored MotionPath authored segment-frame work exceeds ${referenceAnchoredMotionPathLimits.maximumAuthoredSegmentFramesPerComposition}`
    : total.flattenedPointFrames > referenceAnchoredMotionPathLimits.maximumFlattenedPointFramesPerComposition
      ? `composition anchored MotionPath flattened point-frame work exceeds ${referenceAnchoredMotionPathLimits.maximumFlattenedPointFramesPerComposition}`
      : total.spatialPointFrames > referenceAnchoredMotionPathLimits.maximumSpatialPointFramesPerComposition
        ? `composition anchored MotionPath spatial-point-frame work exceeds ${referenceAnchoredMotionPathLimits.maximumSpatialPointFramesPerComposition}`
        : total.ownerSampleFrames > referenceAnchoredMotionPathLimits.maximumOwnerSampleFramesPerComposition
          ? `composition anchored MotionPath owner-sample-frame work exceeds ${referenceAnchoredMotionPathLimits.maximumOwnerSampleFramesPerComposition}`
          : undefined;
  if (!exceeded) return Object.freeze(total);
  const owner = nodeWork[0]?.node;
  if (!owner) throw new Error("CUT anchored MotionPath composition work cannot overflow without a MotionPath node.");
  fail(owner, "CUT_MOTION_PATH_LIMIT", exceeded);
}

/** Stable user-facing inspect projection of the prepared path and its first executed state. */
export function referenceMotionPathInspect(
  ir: CutAVIR,
  composition: IRComposition,
  node: IRNode,
  prepared?: ReferenceMotionPathPlan,
) {
  const plan = prepared ?? prepareReferenceMotionPathNode(node);
  if (plan.nodeId !== node.id) fail(node, "CUT_MOTION_PATH_GEOMETRY", `prepared plan belongs to ${plan.nodeId}, not ${node.id}.`);
  const time = node.interval.start;
  const sampledProgress = propertyAt(ir, node, "progress", time) ?? node.inputs.progress;
  const progress = ratio(
    node,
    sampledProgress ?? { kind: "quantity", dimension: "ratio", magnitude: { numerator: "0", denominator: "1" }, unit: "ratio" },
    "executed progress",
    false,
  )!;
  const sample = referenceMotionPathAt(ir, composition, node, time, plan);
  const property = node.properties.progress;
  const progressSignal = property && "signal" in property ? ir.signals[property.signal] : undefined;
  return Object.freeze({
    pathForm: plan.pathForm,
    authoredSegments: plan.authoredSegments,
    flattenedPoints: plan.trace.points.length,
    totalLengthPx: plan.trace.totalLength,
    closed: plan.closed,
    ...(plan.flatteningVersion === undefined ? {} : { flatteningVersion: plan.flatteningVersion }),
    orientToPath: booleanInput(node, "orientToPath", false),
    ...(progressSignal ? { progressSignal: { id: progressSignal.id, contentHash: progressSignal.contentHash } } : {}),
    executedAtActiveStart: { time, progress, ...sample },
  });
}
