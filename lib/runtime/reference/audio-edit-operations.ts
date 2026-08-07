import { stableJsonStringify } from "../../core/stable";
import {
  audioEditMaterializedNodeId,
  AudioEditOperationError,
  executeAudioEditOperationPlan,
  type AudioEditItem,
  type AudioEditOperation,
  type AudioEditOperationErrorCode,
} from "../../language/audio-edit-operations";
import type { CutAVIR, IRComposition, IREditorialInterval, IRNode, IRProvenance, IRValue } from "../../language/ir";
import type { LockedResourceProbe } from "../../language/lock";
import { addRational, compareRational, divideRational, multiplyRational, rational, subtractRational, type Rational } from "../../language/rational";
import { referenceAudioTrackTransitionPlans } from "./audio-track-transition";
import type { ReferenceLinkedEditSideAuthorization } from "./linked-edit";
import type { ReferenceLinkedRippleDeleteSideAuthorization } from "./linked-ripple-delete";
import { nodeReferences } from "../graph";
import {
  referenceTimelineEditAudioTrackTransitions,
  referenceTimelineEditTrackOwnership,
} from "./timeline-edit";

export class ReferenceAudioEditOperationError extends Error {
  readonly nodeId: string;
  readonly source: { module: string; line: number; column: number; nodeId: string };

  constructor(
    readonly code: AudioEditOperationErrorCode,
    node: IRNode,
    message: string,
    itemProvenance: IRProvenance = node.provenance,
  ) {
    super(`${code}: ${message} at ${itemProvenance.module}:${itemProvenance.span.start.line}:${itemProvenance.span.start.column}.`);
    this.name = "ReferenceAudioEditOperationError";
    this.nodeId = node.id;
    this.source = { module: itemProvenance.module, line: itemProvenance.span.start.line, column: itemProvenance.span.start.column, nodeId: node.id };
  }
}

function fail(node: IRNode, code: AudioEditOperationErrorCode, message: string, itemProvenance?: IRProvenance): never {
  throw new ReferenceAudioEditOperationError(code, node, message, itemProvenance);
}

function operationErrorProvenance(track: IRNode, plan: NonNullable<Extract<NonNullable<IRNode["editorial"]>, { kind: "audio-track" }>["operationPlan"]>, error: AudioEditOperationError) {
  if (error.operationIndex !== undefined) return plan.operations[error.operationIndex]?.provenance ?? track.provenance;
  const baseIndex = /^\$\.baseItems\[(\d+)\]/u.exec(error.path)?.[1];
  if (baseIndex !== undefined) return plan.baseItems[Number(baseIndex)]?.provenance ?? track.provenance;
  return track.provenance;
}

function same(left: Rational, right: Rational) { return compareRational(left, right) === 0; }
function end(interval: IREditorialInterval) { return addRational(interval.start, interval.duration); }
function timeValue(value: Rational): IRValue { return { kind: "quantity", dimension: "time", magnitude: value, unit: "s" }; }
function rangeValue(value: IREditorialInterval): IRValue { return { kind: "range", start: timeValue(value.start), end: timeValue(end(value)), exclusive: true }; }

function operationTimes(operation: AudioEditOperation) {
  const values: Rational[] = [];
  if ("at" in operation) values.push(operation.at);
  if ("range" in operation) values.push(operation.range.start, end(operation.range));
  if ("keep" in operation) values.push(operation.keep.start, end(operation.keep));
  // A slip delta moves only source time and is checked on the affected locked
  // stream after plan execution. A slide delta changes destination coverage.
  if (operation.kind === "slide") values.push(operation.by);
  if ("item" in operation) values.push(operation.item.destination.duration);
  if (operation.kind === "crossfade") {
    const half = divideRational(operation.duration, rational(2));
    values.push(operation.duration, subtractRational(operation.at, half), addRational(operation.at, half));
  }
  return values;
}

function exactDestinationSample(
  composition: IRComposition,
  track: IRNode,
  value: Rational,
  provenance: IRProvenance,
  label = "operation time",
) {
  if (multiplyRational(value, rational(composition.sampleRate)).denominator !== "1") {
    fail(track, "CUT_AUDIO_EDIT_TIME", `${label} ${value.numerator}/${value.denominator}s does not land on the ${composition.sampleRate} Hz destination sample grid`, provenance);
  }
}

function validateSourceItem(ir: CutAVIR, track: IRNode, item: Extract<AudioEditItem, { kind: "clip" }>) {
  const resource = ir.resources[item.inputs.resourceId];
  if (!resource || resource.kind !== "audio") fail(track, "CUT_AUDIO_EDIT_SHAPE", `${item.origin} source must reference a declared AudioAsset`, item.provenance);
  const probe = resource.metadata?.probe as LockedResourceProbe | undefined;
  const selected = probe?.kind === "media" ? probe.selected.audio : undefined;
  const stream = probe?.kind === "media" && selected ? probe.identity.streams.find((candidate) => candidate.index === selected.streamIndex && candidate.type === "audio") : undefined;
  const sampleRate = stream?.sampleRate;
  if (!selected || !sampleRate || !Number.isSafeInteger(sampleRate) || sampleRate <= 0) {
    fail(track, "CUT_AUDIO_EDIT_UNSUPPORTED", `${item.origin} locked selected audio stream needs a positive exact source sample rate`, item.provenance);
  }
  const sourceEnd = end(item.source);
  if (compareRational(sourceEnd, selected.duration) > 0) fail(track, "CUT_AUDIO_EDIT_TIME", `${item.origin} source range exceeds the locked selected audio duration`, item.provenance);
  for (const [label, value] of [["start", item.source.start], ["end", sourceEnd]] as const) {
    if (multiplyRational(value, rational(sampleRate)).denominator !== "1") {
      fail(track, "CUT_AUDIO_EDIT_TIME", `${item.origin} source ${label} does not land on the locked ${sampleRate} Hz source sample grid`, item.provenance);
    }
  }
  const headHandle = item.inputs.headHandle ?? rational(0), tailHandle = item.inputs.tailHandle ?? rational(0);
  const availableStart = subtractRational(item.source.start, headHandle), availableEnd = addRational(sourceEnd, tailHandle);
  if (compareRational(availableStart, rational(0)) < 0 || compareRational(availableEnd, selected.duration) > 0) {
    fail(track, "CUT_AUDIO_EDIT_TIME", `${item.origin} declared source handles exceed the locked selected audio duration`, item.provenance);
  }
  for (const [label, value, amount] of [["available start", availableStart, headHandle], ["available end", availableEnd, tailHandle]] as const) {
    if (compareRational(amount, rational(0)) === 0) continue;
    if (multiplyRational(value, rational(sampleRate)).denominator !== "1") {
      fail(track, "CUT_AUDIO_EDIT_TIME", `${item.origin} ${label} does not land on the locked ${sampleRate} Hz source sample grid`, item.provenance);
    }
  }
}

function validatePlanItem(
  ir: CutAVIR,
  composition: IRComposition,
  track: IRNode,
  item: AudioEditItem,
) {
  exactDestinationSample(composition, track, item.destination.start, item.provenance, `${item.origin} destination start`);
  exactDestinationSample(composition, track, end(item.destination), item.provenance, `${item.origin} destination end`);
  if (item.kind === "clip") {
    validateSourceItem(ir, track, item);
    if (item.inputs.linkId !== undefined && (!item.inputs.linkId || item.inputs.linkId !== item.inputs.linkId.trim() || item.inputs.linkId.length > 128 || /[\u0000-\u001f\u007f]/u.test(item.inputs.linkId))) {
      fail(track, "CUT_AUDIO_EDIT_SHAPE", `${item.origin} audio link must be one safe scene-local editorial identity`, item.provenance);
    }
    if (item.linkSegmentId !== undefined && (item.inputs.linkId === undefined
      || !item.linkSegmentId
      || item.linkSegmentId !== item.linkSegmentId.trim()
      || item.linkSegmentId.length > 512
      || /[\u0000-\u001f\u007f]/u.test(item.linkSegmentId))) {
      fail(track, "CUT_AUDIO_EDIT_SHAPE", `${item.origin} linked segment identity must be one safe compiler-owned id attached to a linked AudioClip`, item.provenance);
    }
  }
  else if (Object.keys(item.inputs).length) fail(track, "CUT_AUDIO_EDIT_SHAPE", `${item.origin} silence item cannot carry processor or source inputs`, item.provenance);
}

function normalizedFinal(
  item: Extract<NonNullable<IRNode["editorial"]>, { kind: "audio-track" }>["items"][number],
  trackOrigin: Rational,
) {
  return {
    kind: item.kind === "audio" ? "clip" : "gap",
    destination: { start: subtractRational(item.destination.start, trackOrigin), duration: item.destination.duration },
    ...(item.source ? { source: item.source } : {}),
  };
}

function expectedInputs(item: AudioEditItem): Record<string, IRValue> {
  if (item.kind === "gap") return { destination: rangeValue(item.destination) };
  return {
    source: { kind: "resource-ref", id: item.inputs.resourceId },
    range: rangeValue(item.source),
    destination: rangeValue(item.destination),
    ...(item.inputs.linkId ? { link: { kind: "string", value: item.inputs.linkId } as IRValue } : {}),
    ...(item.inputs.headHandle ? { headHandle: timeValue(item.inputs.headHandle) } : {}),
    ...(item.inputs.tailHandle ? { tailHandle: timeValue(item.inputs.tailHandle) } : {}),
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

/** Re-execute and reconcile the public AudioTrack plan before audio work. */
export function validateReferenceAudioTrackOperationPlan(
  ir: CutAVIR,
  composition: IRComposition,
  track: IRNode,
  authorizations: ReadonlyMap<string, ReferenceLinkedEditSideAuthorization> = new Map(),
) {
  if (track.op !== "cut.edit.audio_track" || track.editorial?.kind !== "audio-track") return;
  if (Object.hasOwn(track.inputs, "sourceDuration") || Object.hasOwn(track.inputs, "edits")) {
    fail(track, "CUT_AUDIO_EDIT_SHAPE", "compile-time edit operands must not leak into runtime AudioTrack inputs");
  }
  const plan = track.editorial.operationPlan;
  if (!plan) {
    const timelineTransitions = referenceTimelineEditAudioTrackTransitions(ir, track);
    if (timelineTransitions) {
      referenceAudioTrackTransitionPlans(
        ir,
        composition,
        track as IRNode & { editorial: Extract<NonNullable<IRNode["editorial"]>, { kind: "audio-track" }> },
        timelineTransitions,
      );
      return;
    }
    if (referenceTimelineEditTrackOwnership(ir, track)) return;
    if (track.editorial.transitions?.length) fail(track, "CUT_AUDIO_EDIT_RESULT", "materialized AudioTrack transitions require their closed operation plan");
    return;
  }
  if (plan.version === 2) {
    if (authorizations.size > 0 || ir.linkedEdits?.some((transaction) => transaction.audioTrackId === track.id)) {
      fail(track, "CUT_AUDIO_REGION_CROSSFADE_PLAN", "processed AudioRegion crossfades cannot be combined with linked-edit transactions", plan.operations[0]?.provenance ?? track.provenance);
    }
    let execution: ReturnType<typeof executeAudioEditOperationPlan>;
    try {
      execution = executeAudioEditOperationPlan(plan);
    } catch (error) {
      if (!(error instanceof AudioEditOperationError)) throw error;
      fail(track, error.code, error.message, operationErrorProvenance(track, plan, error));
    }
    referenceAudioTrackTransitionPlans(
      ir,
      composition,
      track as IRNode & { editorial: Extract<NonNullable<IRNode["editorial"]>, { kind: "audio-track" }> },
      execution.transitions,
    );
    if (!same(execution.duration, track.interval.duration) || !same(plan.sourceDuration, track.interval.duration)) {
      fail(track, "CUT_AUDIO_REGION_CROSSFADE_PLAN", "version-2 transition-only plan duration must exactly equal its owning AudioTrack duration");
    }
    return;
  }
  for (const [transactionId, authorization] of authorizations) {
    if (authorization.transactionId !== transactionId || authorization.trackId !== track.id || authorization.kind !== "audio") {
      fail(track, "CUT_AUDIO_EDIT_SHAPE", `linked-edit authorization ${transactionId} does not belong to this AudioTrack`);
    }
  }
  plan.baseItems.forEach((item) => validatePlanItem(ir, composition, track, item));
  plan.operations.forEach((operation, operationIndex) => {
    if ("item" in operation) validatePlanItem(ir, composition, track, operation.item);
    for (const value of operationTimes(operation)) exactDestinationSample(composition, track, value, operation.provenance);
    const transactionId = "transactionId" in operation ? operation.transactionId : undefined;
    const authorization = transactionId === undefined ? undefined : authorizations.get(transactionId);
    if (transactionId !== undefined && !authorization) {
      const kind = operation.kind === "trim" ? "LinkedTrim" : operation.kind === "ripple-insert" || operation.kind === "ripple-delete" ? "LinkedRippleDelete" : "linked-edit";
      fail(track, "CUT_AUDIO_EDIT_RESULT", `operation ${operationIndex} has a forged or unauthorized ${kind} transaction`, operation.provenance);
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
          fail(track, "CUT_AUDIO_EDIT_RESULT", `operation ${operationIndex} has a forged or mismatched LinkedRippleDelete insertion`, operation.provenance);
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
          fail(track, "CUT_AUDIO_EDIT_RESULT", `operation ${operationIndex} has a forged or mismatched LinkedRippleDelete deletion`, operation.provenance);
        }
      } else {
        fail(track, "CUT_AUDIO_EDIT_RESULT", `operation ${operationIndex} reuses LinkedRippleDelete transaction ${authorization.transactionId} outside its authorized pair`, operation.provenance);
      }
    } else if (authorization) {
      if (operation.kind !== "trim"
        || authorization.operationIndex !== operationIndex
        || !same(authorization.translatedKeep.start, operation.keep.start)
        || !same(authorization.translatedKeep.duration, operation.keep.duration)) {
        fail(track, "CUT_AUDIO_EDIT_RESULT", `trim operation ${operationIndex} has a forged or mismatched LinkedTrim transaction`, operation.provenance);
      }
    } else if ([...authorizations.values()].some((candidate) => authorizationOperationIndexes(candidate).includes(operationIndex))) {
      fail(track, "CUT_AUDIO_EDIT_RESULT", `operation ${operationIndex} dropped its authorized linked-edit transaction`, operation.provenance);
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
        fail(track, "CUT_AUDIO_EDIT_RESULT", `LinkedRippleDelete authorization ${authorization.transactionId} does not resolve to its declared operation pair`);
      }
    } else {
      const operation = plan.operations[authorization.operationIndex];
      if (operation?.kind !== "trim" || operation.transactionId !== authorization.transactionId) {
        fail(track, "CUT_AUDIO_EDIT_RESULT", `LinkedTrim authorization ${authorization.transactionId} does not resolve to its declared trim operation`);
      }
    }
  }
  if (authorizations.size === 0 && plan.operations.length > 0 && plan.baseItems.some((item) => item.kind === "clip" && item.inputs.linkId !== undefined)) {
    fail(track, "CUT_AUDIO_EDIT_UNSUPPORTED", "AudioTrack edit plans cannot mutate linked picture independently", plan.operations[0]?.provenance ?? track.provenance);
  }
  exactDestinationSample(composition, track, plan.sourceDuration, track.provenance);
  let execution: ReturnType<typeof executeAudioEditOperationPlan>;
  try {
    execution = executeAudioEditOperationPlan(plan, undefined, (step) => {
      step.items.forEach((item) => validatePlanItem(ir, composition, track, item));
    });
  }
  catch (error) {
    if (!(error instanceof AudioEditOperationError)) throw error;
    fail(track, error.code, error.message, operationErrorProvenance(track, plan, error));
  }
  execution.items.forEach((item) => validatePlanItem(ir, composition, track, item));
  referenceAudioTrackTransitionPlans(
    ir,
    composition,
    track as IRNode & { editorial: Extract<NonNullable<IRNode["editorial"]>, { kind: "audio-track" }> },
    execution.transitions,
  );
  if (execution.items.length !== track.editorial.items.length || execution.items.length !== track.children.length) {
    fail(track, "CUT_AUDIO_EDIT_RESULT", "materialized item count does not match the operation-plan result");
  }
  for (const [index, expected] of execution.items.entries()) {
    const encoded = track.editorial.items[index], expectedId = audioEditMaterializedNodeId(track.id, index, expected), child = ir.nodes[encoded.nodeId];
    if (track.children[index] !== expectedId || encoded.nodeId !== expectedId || child?.id !== expectedId) {
      fail(track, "CUT_AUDIO_EDIT_RESULT", `materialized item ${index} has non-canonical identity`, expected.provenance);
    }
    const expectedLink = expected.kind === "clip" ? expected.inputs.linkId : undefined;
    if (encoded.linkId !== expectedLink) fail(track, "CUT_AUDIO_EDIT_RESULT", `materialized item ${index} link metadata does not match its authorized operation-plan result`, expected.provenance);
    if (encoded.linkSegmentId !== (expected.kind === "clip" ? expected.linkSegmentId : undefined)) fail(track, "CUT_AUDIO_EDIT_RESULT", `materialized item ${index} segment metadata does not match its authorized operation-plan result`, expected.provenance);
    const actual = normalizedFinal(encoded, track.interval.start);
    const semanticExpected = { kind: expected.kind, destination: expected.destination, ...(expected.kind === "clip" ? { source: expected.source } : {}) };
    if (stableJsonStringify(actual) !== stableJsonStringify(semanticExpected)) {
      fail(track, "CUT_AUDIO_EDIT_RESULT", `materialized item ${index} timing metadata does not match the operation-plan result`, expected.provenance);
    }
    const expectedOp = expected.kind === "clip" ? "cut.audio.clip" : "cut.edit.audio_gap";
    if (child.op !== expectedOp || child.domain !== "audio" || stableJsonStringify(child.inputs) !== stableJsonStringify(expectedInputs(expected))) {
      fail(track, "CUT_AUDIO_EDIT_RESULT", `materialized item ${index} kernel inputs do not match the operation-plan result`, expected.provenance);
    }
  }
  if (!same(execution.duration, track.interval.duration)) fail(track, "CUT_AUDIO_EDIT_RESULT", "operation-plan result duration does not equal the owning AudioTrack duration");
}

/**
 * Reauthorize every reachable version-2 processed-region transition before a
 * caller can resolve media paths, consult a warm cache, or allocate output.
 */
export function validateReachableReferenceAudioRegionCrossfadePlans(
  ir: CutAVIR,
  composition: IRComposition,
  rootIds: readonly string[],
) {
  const visitedCompositions = new Set<string>();
  const visit = (owner: IRComposition, roots: readonly string[]) => {
    if (visitedCompositions.has(owner.id)) return;
    visitedCompositions.add(owner.id);
    const pending = [...roots], visited = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const node = ir.nodes[id];
      if (!node) continue;
      if (node.op === "cut.edit.audio_track"
        && node.editorial?.kind === "audio-track"
        && (node.editorial.operationPlan?.version === 2
          || referenceTimelineEditAudioTrackTransitions(ir, node) !== undefined)) {
        validateReferenceAudioTrackOperationPlan(ir, owner, node);
      }
      const nestedSource = node.op === "cut.edit.nested_sequence" ? node.inputs.source : undefined;
      if (nestedSource?.kind === "timeline-ref") {
        const nested = ir.compositions.find((candidate) => candidate.id === nestedSource.id);
        if (nested) {
          const nestedRoots = [...nested.rootAudioIds, ...nested.rootAVIds];
          for (const sceneId of nested.sceneIds) {
            const scene = ir.scenes[sceneId];
            if (scene) nestedRoots.push(...scene.rootAudioIds, ...scene.rootAVIds);
          }
          visit(nested, nestedRoots);
        }
      }
      pending.push(...nodeReferences(node));
    }
  };
  visit(composition, rootIds);
}
