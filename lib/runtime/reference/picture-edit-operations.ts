import { stableJsonStringify } from "../../core/stable";
import type { CutAVIR, IRComposition, IRNode, IRPictureTimeMap, IRProvenance, IRValue } from "../../language/ir";
import {
  executePictureTrackOperationPlan,
  pictureEditMaterializedNodeId,
  PictureEditOperationError,
  type IRPictureEditItem,
  type IRPictureTrackOperation,
  type IRPictureTrackOperationPlan,
} from "../../language/picture-edit-operations";
import { authoredPictureTimeMap, canonicalPictureTimeMapInputs, isDefaultPictureTimeMap, PictureTimeMapInputError } from "../../language/picture-time-map";
import { addRational, compareRational, divideRational, multiplyRational, rational, subtractRational, type Rational, zeroRational } from "../../language/rational";
import type { LockedResourceProbe } from "../../language/lock";
import type { ReferenceLinkedEditSideAuthorization } from "./linked-edit";
import type { ReferenceLinkedRippleDeleteSideAuthorization } from "./linked-ripple-delete";
import { referenceVideoInputColorDeclaration } from "./color-management";
import { referenceTimelineEditTrackOwnership } from "./timeline-edit";

export class ReferencePictureEditOperationError extends Error {
  readonly code = "CUT_EDIT_OPERATION";
  readonly nodeId: string;
  readonly source: { module: string; line: number; column: number; nodeId: string };

  constructor(node: IRNode, message: string, provenance: IRProvenance = node.provenance) {
    super(`CUT_EDIT_OPERATION: ${message} at ${provenance.module}:${provenance.span.start.line}:${provenance.span.start.column}.`);
    this.name = "ReferencePictureEditOperationError";
    this.nodeId = node.id;
    this.source = { module: provenance.module, line: provenance.span.start.line, column: provenance.span.start.column, nodeId: node.id };
  }
}

function fail(node: IRNode, message: string, provenance?: IRProvenance): never { throw new ReferencePictureEditOperationError(node, message, provenance); }
function same(left: Rational, right: Rational) { return compareRational(left, right) === 0; }
function end(interval: { start: Rational; duration: Rational }) { return addRational(interval.start, interval.duration); }
function time(value: IRValue | undefined, label: string, node: IRNode, provenance?: IRProvenance) {
  if (value?.kind !== "quantity" || value.dimension !== "time" || value.unit !== "s") fail(node, `${label} must be a canonical exact Time value`, provenance);
  return value.magnitude;
}

function sameTimeMap(left: IRPictureTimeMap | undefined, right: IRPictureTimeMap | undefined) {
  if (left === undefined || right === undefined) return left === right;
  if (left.kind !== right.kind) return false;
  if (left.kind === "freeze" && right.kind === "freeze") {
    return same(left.at, right.at) && left.frameSelection === right.frameSelection;
  }
  if (left.kind === "speed-ramp" && right.kind === "speed-ramp") {
    return left.interpolation === right.interpolation
      && left.frameSelection === right.frameSelection
      && left.points.length === right.points.length
      && left.points.every((point, index) => same(point.at, right.points[index].at) && same(point.rate, right.points[index].rate));
  }
  return left.kind === "constant"
    && right.kind === "constant"
    && left.direction === right.direction
    && left.frameSelection === right.frameSelection
    && same(left.rate, right.rate);
}

function validatePlanItem(
  ir: CutAVIR,
  track: IRNode,
  item: IRPictureEditItem,
) {
  const duration = time(item.inputs.duration, `${item.origin} duration`, track, item.provenance);
  if (!same(duration, item.destination.duration) || compareRational(duration, zeroRational) <= 0) fail(track, `${item.origin} input duration must equal its positive destination duration`, item.provenance);
  if (item.kind === "gap") {
    if (Object.keys(item.inputs).length !== 1 || item.source !== undefined || item.timeMap !== undefined) fail(track, `${item.origin} Gap plan item may carry only its executed duration`, item.provenance);
    return;
  }
  const allowed = new Set([
    "source", "range", "duration", "headHandle", "tailHandle", "playback",
    "rate", "freezeAt", "speedRamp", "fit", "inputColor",
    "inputColorInterpretation", "opacity", "scale", "rotation", "link", "frameSelection",
    "transcriptBindingId", "transcriptMediaAuthorityId",
    "transcriptPictureOriginIdentity", "transcriptPictureSegmentIdentity",
  ]);
  for (const key of Object.keys(item.inputs)) if (!allowed.has(key)) fail(track, `${item.origin} PictureClip plan item contains unsupported input “${key}”`, item.provenance);
  const link = item.inputs.link;
  if (link !== undefined && (link.kind !== "string" || !link.value || link.value !== link.value.trim() || link.value.length > 128 || /[\u0000-\u001f\u007f]/u.test(link.value))) {
    fail(track, `${item.origin} PictureClip link must be one safe scene-local editorial identity`, item.provenance);
  }
  if (item.linkSegmentId !== undefined && (link?.kind !== "string"
    || !item.linkSegmentId
    || item.linkSegmentId !== item.linkSegmentId.trim()
    || item.linkSegmentId.length > 512
    || /[\u0000-\u001f\u007f]/u.test(item.linkSegmentId))) {
    fail(track, `${item.origin} linked segment identity must be one safe compiler-owned id attached to a linked PictureClip`, item.provenance);
  }
  const source = item.inputs.source;
  if (source?.kind !== "resource-ref" || ir.resources[source.id]?.kind !== "video") fail(track, `${item.origin} source must reference a declared VideoAsset`, item.provenance);
  // Operation history is executable evidence even when a later edit removes
  // this operand from the materialized track. Close every stored input rather
  // than validating only surviving PictureClip nodes.
  referenceVideoInputColorDeclaration({ ...track, op: "cut.edit.picture_clip", inputs: item.inputs, provenance: item.provenance });
  const range = item.inputs.range;
  if (range?.kind !== "range" || !range.exclusive) fail(track, `${item.origin} range must be half-open`, item.provenance);
  const sourceStart = time(range.start, `${item.origin} source start`, track, item.provenance), sourceEnd = time(range.end, `${item.origin} source end`, track, item.provenance);
  if (!item.source || !same(item.source.start, sourceStart) || !same(item.source.duration, subtractRational(sourceEnd, sourceStart))) fail(track, `${item.origin} source metadata does not match its range input`, item.provenance);
  const probe = ir.resources[source.id]?.metadata?.probe as LockedResourceProbe | undefined;
  const selected = probe?.kind === "media" ? probe.selected.video : undefined;
  const stream = probe?.kind === "media" && selected ? probe.identity.streams.find((candidate) => candidate.index === selected.streamIndex) : undefined;
  const frameRate = stream?.frameRate, timeBase = selected?.timeBase;
  if (!frameRate || compareRational(frameRate, zeroRational) <= 0 || !timeBase || compareRational(timeBase, zeroRational) <= 0) fail(track, `${item.origin} locked selected video stream needs positive exact frame-rate and time-base metadata`, item.provenance);
  const headHandle = item.inputs.headHandle === undefined ? zeroRational : time(item.inputs.headHandle, `${item.origin} headHandle`, track, item.provenance);
  const tailHandle = item.inputs.tailHandle === undefined ? zeroRational : time(item.inputs.tailHandle, `${item.origin} tailHandle`, track, item.provenance);
  if (compareRational(headHandle, zeroRational) < 0 || compareRational(tailHandle, zeroRational) < 0) fail(track, `${item.origin} source handles cannot be negative`, item.provenance);
  const availableStart = subtractRational(sourceStart, headHandle), availableEnd = addRational(sourceEnd, tailHandle);
  if (compareRational(availableStart, zeroRational) < 0) fail(track, `${item.origin} headHandle extends before source time zero`, item.provenance);
  if (selected && compareRational(availableEnd, selected.duration) > 0) fail(track, `${item.origin} tailHandle extends beyond the locked selected video duration`, item.provenance);
  for (const [label, value] of [["start", sourceStart], ["end", sourceEnd], ["available start", availableStart], ["available end", availableEnd]] as const) {
    if (multiplyRational(value, frameRate).denominator !== "1") fail(track, `${item.origin} source ${label} does not land on the locked ${frameRate.numerator}/${frameRate.denominator} fps grid`, item.provenance);
    if (multiplyRational(value, { numerator: timeBase.denominator, denominator: timeBase.numerator }).denominator !== "1") fail(track, `${item.origin} source ${label} does not land on the locked ${timeBase.numerator}/${timeBase.denominator}s time base`, item.provenance);
  }
  let authored: IRPictureTimeMap;
  try { authored = authoredPictureTimeMap(item.inputs, item.destination.duration); }
  catch (error) {
    if (!(error instanceof PictureTimeMapInputError)) throw error;
    fail(track, `${item.origin} ${error.message}`, item.provenance);
  }
  if (stableJsonStringify(canonicalPictureTimeMapInputs(item.inputs, authored)) !== stableJsonStringify(item.inputs)) fail(track, `${item.origin} picture time-map inputs are not canonical`, item.provenance);
  const encoded = isDefaultPictureTimeMap(authored) ? undefined : authored;
  if (!sameTimeMap(item.timeMap, encoded)) fail(track, `${item.origin} typed timeMap does not match its canonical inputs`, item.provenance);
}

function operationTimes(operation: IRPictureTrackOperation) {
  const result: Rational[] = [];
  if ("at" in operation) result.push(operation.at);
  if ("range" in operation) result.push(operation.range.start, end(operation.range));
  if ("keep" in operation) result.push(operation.keep.start, end(operation.keep));
  if ("by" in operation) result.push(operation.by);
  if ("item" in operation) result.push(operation.item.destination.duration);
  if ("item" in operation && operation.item.timeMap?.kind === "speed-ramp") result.push(...operation.item.timeMap.points.map((point) => point.at));
  if (operation.kind === "transition") {
    const half = divideRational(operation.duration, rational(2));
    result.push(operation.duration, subtractRational(operation.at, half), addRational(operation.at, half));
  }
  return result;
}

function validateGrid(composition: IRComposition, track: IRNode, plan: IRPictureTrackOperationPlan) {
  for (const operation of plan.operations) {
    if (operation.kind === "transition") {
      const frames = multiplyRational(operation.duration, composition.fps);
      if (frames.denominator !== "1" || BigInt(frames.numerator) < 2n || BigInt(frames.numerator) % 2n !== 0n) {
        fail(track, "transitionAt duration must span an even number of at least two composition frames", operation.provenance);
      }
    }
    for (const value of operationTimes(operation)) {
      if (multiplyRational(value, composition.fps).denominator !== "1") fail(track, `operation time ${value.numerator}/${value.denominator}s does not land on the ${composition.fps.numerator}/${composition.fps.denominator} fps picture grid`, operation.provenance);
    }
  }
}

function normalizedFinal(item: Extract<NonNullable<IRNode["editorial"]>, { kind: "picture-track" }>["items"][number], origin: Rational) {
  return {
    kind: item.kind,
    destination: { start: subtractRational(item.destination.start, origin), duration: item.destination.duration },
    ...(item.source ? { source: item.source } : {}),
    ...(item.timeMap ? { timeMap: item.timeMap } : {}),
  };
}

function isRippleAuthorization(
  authorization: ReferenceLinkedEditSideAuthorization,
): authorization is ReferenceLinkedRippleDeleteSideAuthorization {
  return "insertOperationIndex" in authorization;
}

function authorizationOperationIndexes(authorization: ReferenceLinkedEditSideAuthorization) {
  return isRippleAuthorization(authorization)
    ? [authorization.insertOperationIndex, authorization.deleteOperationIndex]
    : [authorization.operationIndex];
}

export function validateReferencePictureTrackOperationPlan(
  ir: CutAVIR,
  composition: IRComposition,
  track: IRNode,
  authorizations: ReadonlyMap<string, ReferenceLinkedEditSideAuthorization> = new Map(),
) {
  if (track.op !== "cut.edit.picture_track" || track.editorial?.kind !== "picture-track") return;
  if (Object.hasOwn(track.inputs, "sourceDuration") || Object.hasOwn(track.inputs, "edits")) fail(track, "compile-time edit operands must not leak into runtime PictureTrack inputs");
  const plan = track.editorial.operationPlan;
  if (!plan) {
    if (referenceTimelineEditTrackOwnership(ir, track)) return;
    if (track.editorial.transitions?.length) fail(track, "typed PictureTrack transitions require their canonical operation plan");
    return;
  }
  for (const [transactionId, authorization] of authorizations) {
    if (authorization.transactionId !== transactionId || authorization.trackId !== track.id || authorization.kind !== "picture") {
      fail(track, `linked-edit authorization ${transactionId} does not belong to this PictureTrack`);
    }
  }
  plan.baseItems.forEach((item) => validatePlanItem(ir, track, item));
  plan.operations.forEach((operation, operationIndex) => {
    if ("item" in operation) validatePlanItem(ir, track, operation.item);
    const transactionId = "transactionId" in operation ? operation.transactionId : undefined;
    const authorization = transactionId === undefined ? undefined : authorizations.get(transactionId);
    if (transactionId !== undefined && !authorization) {
      const kind = operation.kind === "trim" ? "LinkedTrim" : operation.kind === "ripple-insert" || operation.kind === "ripple-delete" ? "LinkedRippleDelete" : "linked-edit";
      fail(track, `operation ${operationIndex} has a forged or unauthorized ${kind} transaction`, operation.provenance);
    }
    if (authorization && isRippleAuthorization(authorization)) {
      const insertion = operationIndex === authorization.insertOperationIndex;
      const deletion = operationIndex === authorization.deleteOperationIndex;
      if (insertion) {
        if (operation.kind !== "ripple-insert"
          || operation.transactionId !== authorization.transactionId
          || !same(operation.at, authorization.insertionAt)
          || operation.item.kind !== "gap"
          || !same(operation.item.destination.duration, authorization.insertedGapDuration)) {
          fail(track, `operation ${operationIndex} has a forged or mismatched LinkedRippleDelete insertion`, operation.provenance);
        }
      } else if (deletion) {
        if (operation.kind !== "ripple-delete"
          || operation.transactionId !== authorization.transactionId
          || operation.transactionVersion !== authorization.version
          || !same(operation.range.start, authorization.translatedRange.start)
          || !same(operation.range.duration, authorization.translatedRange.duration)
          || (authorization.version === 1 && operation.linkSegmentIds !== undefined)
          || (authorization.version === 2 && (operation.linkSegmentIds?.before !== authorization.linkSegmentIds?.before
            || operation.linkSegmentIds?.after !== authorization.linkSegmentIds?.after))) {
          fail(track, `operation ${operationIndex} has a forged or mismatched LinkedRippleDelete deletion`, operation.provenance);
        }
      } else {
        fail(track, `operation ${operationIndex} reuses LinkedRippleDelete transaction ${authorization.transactionId} outside its authorized pair`, operation.provenance);
      }
    } else if (authorization) {
      if (operation.kind !== "trim"
        || authorization.operationIndex !== operationIndex
        || !same(authorization.translatedKeep.start, operation.keep.start)
        || !same(authorization.translatedKeep.duration, operation.keep.duration)) {
        fail(track, `trim operation ${operationIndex} has a forged or mismatched LinkedTrim transaction`, operation.provenance);
      }
    } else if ([...authorizations.values()].some((candidate) => authorizationOperationIndexes(candidate).includes(operationIndex))) {
      fail(track, `operation ${operationIndex} dropped its authorized linked-edit transaction`, operation.provenance);
    }
  });
  for (const authorization of authorizations.values()) {
    if (isRippleAuthorization(authorization)) {
      const insertion = plan.operations[authorization.insertOperationIndex];
      const deletion = plan.operations[authorization.deleteOperationIndex];
      if (insertion?.kind !== "ripple-insert"
        || insertion.transactionId !== authorization.transactionId
        || deletion?.kind !== "ripple-delete"
        || deletion.transactionId !== authorization.transactionId) {
        fail(track, `LinkedRippleDelete authorization ${authorization.transactionId} does not resolve to its declared operation pair`);
      }
    } else {
      const operation = plan.operations[authorization.operationIndex];
      if (operation?.kind !== "trim" || operation.transactionId !== authorization.transactionId) {
        fail(track, `LinkedTrim authorization ${authorization.transactionId} does not resolve to its declared trim operation`);
      }
    }
  }
  if (authorizations.size === 0 && plan.operations.length > 0 && plan.baseItems.some((item) => item.kind === "picture" && item.inputs.link !== undefined)) {
    fail(track, "PictureTrack edit plans cannot mutate linked audio independently", plan.operations[0]?.provenance ?? track.provenance);
  }
  validateGrid(composition, track, plan);
  let execution: ReturnType<typeof executePictureTrackOperationPlan>;
  try { execution = executePictureTrackOperationPlan(plan); }
  catch (error) {
    if (!(error instanceof PictureEditOperationError)) throw error;
    fail(track, error.message, plan.operations[error.operationIndex ?? 0]?.provenance);
  }
  const result = execution.items;
  if (result.length !== track.editorial.items.length || result.length !== track.children.length) fail(track, "materialized item count does not match operation-plan result");
  for (const [index, expected] of result.entries()) {
    const encoded = track.editorial.items[index], child = ir.nodes[encoded.nodeId], expectedId = pictureEditMaterializedNodeId(track.id, index, expected);
    if (track.children[index] !== expectedId || encoded.nodeId !== expectedId || child?.id !== expectedId) fail(track, `materialized item ${index} has non-canonical identity`);
    const actual = normalizedFinal(encoded, track.interval.start);
    const semanticExpected = { kind: expected.kind, destination: expected.destination, ...(expected.source ? { source: expected.source } : {}), ...(expected.timeMap ? { timeMap: expected.timeMap } : {}) };
    if (stableJsonStringify(actual) !== stableJsonStringify(semanticExpected)) fail(track, `materialized item ${index} timing metadata does not match operation-plan result`, expected.provenance);
    const expectedLink = expected.kind === "picture" && expected.inputs.link?.kind === "string" ? expected.inputs.link.value : undefined;
    if (encoded.linkId !== expectedLink) fail(track, `materialized item ${index} link metadata does not match its authorized operation-plan result`, expected.provenance);
    if (encoded.linkSegmentId !== expected.linkSegmentId) fail(track, `materialized item ${index} segment metadata does not match its authorized operation-plan result`, expected.provenance);
    if (child.op !== (expected.kind === "picture" ? "cut.edit.picture_clip" : "cut.edit.gap") || stableJsonStringify(child.inputs) !== stableJsonStringify(expected.inputs)) fail(track, `materialized item ${index} kernel inputs do not match operation-plan result`, expected.provenance);
  }
  const resultDuration = result.length ? end(result.at(-1)!.destination) : zeroRational;
  if (!same(resultDuration, track.interval.duration)) fail(track, "operation-plan result duration does not equal owning PictureTrack duration");
  const actualTransitions = track.editorial.transitions ?? [];
  if (actualTransitions.length !== execution.transitions.length) fail(track, "materialized transition count does not match operation-plan result");
  for (const [index, expected] of execution.transitions.entries()) {
    const actual = actualTransitions[index];
    const normalizedActual = {
      cut: subtractRational(actual.cut, track.interval.start),
      duration: actual.duration,
      overlap: { start: subtractRational(actual.overlap.start, track.interval.start), duration: actual.overlap.duration },
      outgoingIndex: track.children.indexOf(actual.outgoingNodeId),
      incomingIndex: track.children.indexOf(actual.incomingNodeId),
      outgoingOrigin: expected.outgoingOrigin,
      incomingOrigin: expected.incomingOrigin,
      outgoingSource: actual.outgoingSource,
      incomingSource: actual.incomingSource,
      style: actual.style,
    };
    const normalizedExpected = { ...expected } as Record<string, unknown>;
    delete normalizedExpected.provenance;
    if (stableJsonStringify(normalizedActual) !== stableJsonStringify(normalizedExpected)) {
      fail(track, `materialized transition ${index} does not match the resolved operation-plan handles, timing, style, or node ownership`, expected.provenance);
    }
  }
}
