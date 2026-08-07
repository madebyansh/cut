import { hash, stableJsonStringify } from "../../core/stable";
import type { LockedResourceProbe } from "../../language/lock";
import type {
  CutAVIR,
  IREditorial,
  IREditorialInterval,
  IRNode,
  IRPictureTimeMap,
  IRProvenance,
} from "../../language/ir";
import {
  isTimelineEditStaticPrecompOperand,
  timelineEditProcessedGraphAuthority,
  timelineEditSourceAuthority,
} from "../../language/timeline-edit-ir-adapter";
import { timelineEditAudioEvaluationEnvelopeV1 } from "../../language/timeline-edit-ir-materializer";
import {
  timelineEditAudioOriginAuthorityContent,
  timelineEditAudioOriginAuthorityId,
  timelineEditExecutableIdentity,
  type TimelineEditAudioEvaluationEnvelopeV1,
} from "../../language/timeline-edit-identity";
import type { AudioEditTrackTransition } from "../../language/audio-edit-operations";
import { cutTimelineAudioEvaluationLimits } from "../../language/timeline-edit-audio-origin-contract";
import { referencePrecompConfig } from "./precomp-config";
import {
  executeTimelineEditPlan,
  timelineEditAudioPresentationOriginKey,
  timelineEditAudioPresentationOriginId,
  timelineEditAudioPresentationOriginTrackId,
  TimelineEditError,
  type TimelineEditErrorCode,
  type TimelineEditExecutionV1,
  type TimelineEditItemV1,
  type TimelineEditPlanV1,
  type TimelineEditSourceView,
  type TimelineEditTrackV1,
  type TimelineEditTransitionV1,
} from "../../language/timeline-edit-operations";
import {
  addRational,
  compareRational,
  divideRational,
  multiplyRational,
  rational,
  subtractRational,
  type Rational,
  zeroRational,
} from "../../language/rational";

type EditorialTrack = Extract<IREditorial, { kind: "picture-track" | "audio-track" }>;
type EditorialTrackNode = IRNode & { editorial: EditorialTrack };
type EditorialTrackItem = EditorialTrack["items"][number];

function encodedSourceNodeId(item: EditorialTrackItem) {
  return "sourceNodeId" in item ? item.sourceNodeId : undefined;
}

function encodedPictureTimeMap(item: EditorialTrackItem) {
  return "timeMap" in item ? item.timeMap : undefined;
}

export type ReferenceTimelineEditTrackOwnership = Readonly<{
  planId: string;
  compositionId: string;
  sceneId: string;
  trackId: string;
  domain: "picture" | "audio";
}>;

export type ReferenceTimelineEditMaterializationReceipt = Readonly<{
  version: 1;
  planId: string;
  materializationId: string;
  trackBindings: readonly Readonly<{
    trackId: string;
    trackNodeId: string;
    domain: "picture" | "audio";
    items: number;
    transitions: number;
  }>[];
}>;

export type ReferenceTimelineEditValidation = Readonly<{
  version: 1;
  plans: readonly ReferenceTimelineEditMaterializationReceipt[];
  audioEvaluation?: Readonly<{
    origins: readonly Readonly<{
      originNodeId: string;
      evaluationPolicy: TimelineEditAudioEvaluationEnvelopeV1["evaluationPolicy"];
      sourceSamples: number;
      processingSamples: number;
      processorCount: number;
      processorSampleWork: number;
    }>[];
    aggregateSourceSamples: number;
    aggregateProcessorSampleWork: number;
  }>;
  validationId: string;
}>;

export class ReferenceTimelineEditMaterializationError extends Error {
  readonly source: {
    module: string;
    line: number;
    column: number;
    planId: string;
    trackId?: string;
    nodeId?: string;
  };

  constructor(
    readonly code: TimelineEditErrorCode,
    readonly path: string,
    readonly planId: string,
    message: string,
    provenance: IRProvenance,
    readonly trackId?: string,
    readonly nodeId?: string,
  ) {
    super(`${code}: ${message} at ${provenance.module}:${provenance.span.start.line}:${provenance.span.start.column}.`);
    this.name = "ReferenceTimelineEditMaterializationError";
    this.source = {
      module: provenance.module,
      line: provenance.span.start.line,
      column: provenance.span.start.column,
      planId,
      ...(trackId ? { trackId } : {}),
      ...(nodeId ? { nodeId } : {}),
    };
  }
}

function fail(
  plan: TimelineEditPlanV1,
  code: TimelineEditErrorCode,
  path: string,
  message: string,
  provenance: IRProvenance = plan.provenance,
  trackId?: string,
  nodeId?: string,
): never {
  throw new ReferenceTimelineEditMaterializationError(
    code,
    path,
    plan.id,
    message,
    provenance,
    trackId,
    nodeId,
  );
}

function same(left: Rational, right: Rational) {
  return compareRational(left, right) === 0;
}

function sameValue(left: unknown, right: unknown) {
  if (left === undefined || right === undefined) return left === right;
  return stableJsonStringify(left) === stableJsonStringify(right);
}

function relativeInterval(interval: IREditorialInterval, origin: Rational) {
  return {
    start: subtractRational(interval.start, origin),
    duration: interval.duration,
  };
}

function timeInput(node: IRNode, name: string) {
  const value = node.inputs[name];
  return value?.kind === "quantity" && value.dimension === "time"
    ? value.magnitude
    : zeroRational;
}

function rateInput(node: IRNode, name: string) {
  const value = node.inputs[name];
  return value?.kind === "quantity" && value.dimension === "scalar"
    ? value.magnitude
    : zeroRational;
}

function stringInput(node: IRNode, name: string) {
  const value = node.inputs[name];
  return value?.kind === "string" ? value.value : undefined;
}

function nodeRefInput(node: IRNode, name: string) {
  const value = node.inputs[name];
  return value?.kind === "node-ref" ? value.id : undefined;
}

function exactRangeInput(node: IRNode, name: string) {
  const value = node.inputs[name];
  if (value?.kind !== "range"
    || !value.exclusive
    || value.start.kind !== "quantity"
    || value.start.dimension !== "time"
    || value.end.kind !== "quantity"
    || value.end.dimension !== "time") return undefined;
  return {
    start: value.start.magnitude,
    duration: subtractRational(value.end.magnitude, value.start.magnitude),
  };
}

function materializedAudioEvaluationEnvelope(
  node: IRNode,
): TimelineEditAudioEvaluationEnvelopeV1 | undefined {
  const source = exactRangeInput(node, "evaluationSource");
  const presentationZeroInput = node.inputs.presentationZero;
  const fadeAnchorPolicy = stringInput(node, "fadeAnchorPolicy");
  const evaluationPolicy = stringInput(node, "evaluationPolicy");
  const present = Number(source !== undefined)
    + Number(presentationZeroInput !== undefined)
    + Number(fadeAnchorPolicy !== undefined)
    + Number(evaluationPolicy !== undefined);
  if (!present) return undefined;
  if (present !== 4
    || presentationZeroInput?.kind !== "quantity"
    || presentationZeroInput.dimension !== "time"
    || fadeAnchorPolicy !== "origin-relative-at-presentation-zero"
    || (evaluationPolicy !== "selected-source-union-v1"
      && evaluationPolicy !== "full-declared-handle-domain-v1")) return undefined;
  return {
    source: source!,
    presentationZero: presentationZeroInput.magnitude,
    fadeAnchorPolicy,
    evaluationPolicy,
  };
}

function directSourceResourceId(node: IRNode | undefined) {
  const source = node?.inputs.source;
  return source?.kind === "resource-ref" ? source.id : undefined;
}

function lockedAudioSampleRate(ir: CutAVIR, sourceLeaf: IRNode) {
  const resourceId = directSourceResourceId(sourceLeaf);
  if (!resourceId) return undefined;
  const resource = ir.resources[resourceId];
  if (resource?.state !== "locked") return undefined;
  const probe = resource.metadata?.probe as LockedResourceProbe | undefined;
  const selected = probe?.kind === "media" ? probe.selected.audio : undefined;
  if (!selected || probe?.kind !== "media") return null;
  const stream = probe.identity.streams.find((candidate) =>
    candidate.type === "audio" && candidate.index === selected.streamIndex);
  return stream?.type === "audio" ? stream.sampleRate ?? null : null;
}

function normalizedPictureTimeMap(map: IRPictureTimeMap | undefined): IRPictureTimeMap {
  return map ?? { kind: "constant", direction: "forward", rate: rational(1) };
}

function normalizedItemMetadata(
  item: EditorialTrack["items"][number],
) {
  return item.metadata ?? {};
}

function actualTrackNodes(ir: CutAVIR, plan: TimelineEditPlanV1) {
  return Object.values(ir.nodes)
    .filter((node): node is EditorialTrackNode =>
      node.sceneId === plan.sceneId
      && (node.editorial?.kind === "picture-track" || node.editorial?.kind === "audio-track")
      && node.editorial.trackId !== undefined);
}

function pictureTrackOrder(ir: CutAVIR, sceneId: string) {
  const result = new Map<string, number>();
  const sequences = Object.values(ir.nodes)
    .filter((node): node is IRNode & { editorial: Extract<IREditorial, { kind: "sequence" }> } =>
      node.sceneId === sceneId && node.editorial?.kind === "sequence")
    .sort((left, right) => left.id.localeCompare(right.id));
  let base = 0;
  for (const sequence of sequences) {
    for (const track of sequence.editorial.tracks) result.set(track.nodeId, base + track.order);
    base += sequence.editorial.tracks.length;
  }
  return result;
}

function orderedActualTracks(
  ir: CutAVIR,
  plan: TimelineEditPlanV1,
  tracks: readonly EditorialTrackNode[],
) {
  const pictureOrders = pictureTrackOrder(ir, plan.sceneId);
  const scene = ir.scenes[plan.sceneId]!;
  const sceneOrder = new Map(scene.items.map((item, index) => [item.id, index]));
  return [...tracks].sort((left, right) => {
    const leftPicture = left.editorial.kind === "picture-track";
    const rightPicture = right.editorial.kind === "picture-track";
    if (leftPicture !== rightPicture) return leftPicture ? -1 : 1;
    const leftOrder = leftPicture
      ? pictureOrders.get(left.id) ?? Number.MAX_SAFE_INTEGER
      : sceneOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = rightPicture
      ? pictureOrders.get(right.id) ?? Number.MAX_SAFE_INTEGER
      : sceneOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || left.id.localeCompare(right.id);
  });
}

function expectedNodeIds(view: TimelineEditSourceView) {
  if (view.kind === "gap" || view.kind === "picture" || view.kind === "audio" || view.kind === "nested") return [];
  if (view.kind === "processed-audio") {
    return [view.regionId, view.sourceNodeId, ...view.processorNodeIds];
  }
  return [];
}

function assertSourceReferences(
  ir: CutAVIR,
  plan: TimelineEditPlanV1,
  track: TimelineEditTrackV1,
  item: TimelineEditItemV1,
  itemPath: string,
) {
  for (const id of expectedNodeIds(item.sourceView)) {
    const node = ir.nodes[id];
    if (!node) {
      fail(
        plan,
        "CUT_TIMELINE_EDIT_REFERENCE",
        `${itemPath}.sourceView`,
        `authorized source node ${JSON.stringify(id)} is missing from the live IR`,
        item.provenance,
        track.trackId,
        id,
      );
    }
    if (node.sceneId !== plan.sceneId) {
      fail(
        plan,
        "CUT_TIMELINE_EDIT_REFERENCE",
        `${itemPath}.sourceView`,
        `authorized source node ${JSON.stringify(id)} escaped the owning scene`,
        item.provenance,
        track.trackId,
        id,
      );
    }
  }
}

function actualSourceLeaf(
  ir: CutAVIR,
  encoded: EditorialTrackItem,
  child: IRNode,
) {
  const sourceNodeId = encodedSourceNodeId(encoded);
  return sourceNodeId ? ir.nodes[sourceNodeId] : child;
}

function assertTimelineAudioView(
  ir: CutAVIR,
  plan: TimelineEditPlanV1,
  execution: TimelineEditExecutionV1,
  expectedTrack: TimelineEditTrackV1,
  expected: TimelineEditItemV1,
  encoded: EditorialTrackItem,
  child: IRNode,
  itemPath: string,
) {
  const view = expected.sourceView;
  if (view.kind !== "audio" && view.kind !== "processed-audio") {
    fail(plan, "CUT_TIMELINE_EDIT_RESULT", itemPath, "timeline audio view received a non-audio source view", expected.provenance, expectedTrack.trackId, child.id);
  }
  const originId = nodeRefInput(child, "origin");
  const origin = originId ? ir.nodes[originId] : undefined;
  const sourceRoot = origin?.children.length === 1 ? ir.nodes[origin.children[0]!] : undefined;
  const expectedSourceRootId = view.kind === "processed-audio" ? view.regionId : view.nodeId;
  const expectedSourceNodeId = view.kind === "processed-audio" ? view.sourceNodeId : view.nodeId;
  const encodedSourceId = encodedSourceNodeId(encoded);
  if (child.op !== "cut.edit.timeline_audio_view"
    || child.ownership !== "child"
    || child.children.length !== 0
    || !origin
    || origin.op !== "cut.edit.timeline_audio_origin"
    || origin.ownership !== "reference"
    || origin.sceneId !== child.sceneId
    || !sourceRoot
    || sourceRoot.id !== expectedSourceRootId
    || encodedSourceId !== expectedSourceNodeId) {
    fail(plan, "CUT_TIMELINE_EDIT_RESULT", itemPath, "materialized timeline audio view lost its unique origin owner or exact source graph", expected.provenance, expectedTrack.trackId, child.id);
  }
  const authorityOriginId = timelineEditAudioPresentationOriginId(expected);
  const authorityTrackId = timelineEditAudioPresentationOriginTrackId(expected);
  const baseTrack = plan.tracks.find((track) =>
    track.trackId === authorityTrackId);
  const baseItem = baseTrack?.items.find((item) => item.originId === authorityOriginId);
  const executionTrack = execution.tracks.find((track) =>
    track.trackId === expectedTrack.trackId);
  const originItems = executionTrack?.items.filter((item) =>
    (item.sourceView.kind === "audio" || item.sourceView.kind === "processed-audio")
    && timelineEditAudioPresentationOriginKey(item)
      === timelineEditAudioPresentationOriginKey(expected)) ?? [];
  if (!baseItem || (baseItem.sourceView.kind !== "audio"
    && baseItem.sourceView.kind !== "processed-audio")) {
    fail(plan, "CUT_TIMELINE_EDIT_RESULT", itemPath, "materialized timeline audio view lost its canonical base origin", expected.provenance, expectedTrack.trackId, child.id);
  }
  const expectedEnvelope = timelineEditAudioEvaluationEnvelopeV1(
    baseItem,
    originItems,
    execution.transitions.filter((transition) =>
      transition.trackId === expectedTrack.trackId),
  );
  if (!sameValue(origin.interval, sourceRoot.interval)) {
    fail(
      plan,
      "CUT_TIMELINE_EDIT_RESULT",
      itemPath,
      "materialized timeline audio origin changed its authored placement; evaluation is a private zero-based buffer",
      expected.provenance,
      expectedTrack.trackId,
      origin.id,
    );
  }
  const wantedAuthority = timelineEditAudioOriginAuthorityId(
    timelineEditAudioOriginAuthorityContent(
      plan.id,
      timelineEditExecutableIdentity(plan).semanticMaterializationId,
      authorityTrackId,
      timelineEditAudioPresentationOriginId(expected),
      sourceRoot.id,
      view,
      expectedEnvelope,
    ),
  );
  const expectedKind = view.kind === "processed-audio" ? "processed-audio" : "direct-audio";
  const mirrored = [origin, child];
  for (const [index, owner] of mirrored.entries()) {
    const ownerPath = index === 0 ? `${itemPath}.origin` : `${itemPath}.nodeId`;
    const expectedOriginTrackInput = index === 0
      || authorityTrackId === expectedTrack.trackId
      ? undefined
      : authorityTrackId;
    if (stringInput(owner, "originKind") !== expectedKind
      || stringInput(owner, "originTrackId")
        !== expectedOriginTrackInput
      || stringInput(owner, "originAuthorityId") !== wantedAuthority
      || stringInput(owner, "sourceAuthorityId") !== view.authorityId
      || stringInput(owner, "graphAuthorityId") !== (view.kind === "processed-audio" ? view.graphAuthorityId : undefined)
      || !same(timeInput(owner, "originDuration"), view.presentationClock.originDuration)
      || !same(rateInput(owner, "rate"), view.rate)
      || stringInput(owner, "statePolicy") !== "single-authorized-evaluation"
      || !sameValue(
        materializedAudioEvaluationEnvelope(owner),
        expectedEnvelope,
      )) {
      fail(plan, "CUT_TIMELINE_EDIT_RESULT", ownerPath, "timeline audio origin/view authority mirror disagrees with canonical replay", expected.provenance, expectedTrack.trackId, owner.id);
    }
  }
  if (!same(timeInput(child, "sliceOffset"), view.presentationClock.sliceOffset)
    || !sameValue(exactRangeInput(child, "source"), view.source)
    || stringInput(child, "link") !== expected.linkId) {
    fail(plan, "CUT_TIMELINE_EDIT_RESULT", itemPath, "timeline audio view source slice, origin clock, or link disagrees with canonical replay", expected.provenance, expectedTrack.trackId, child.id);
  }
  if (view.kind === "processed-audio") {
    let graph: ReturnType<typeof timelineEditProcessedGraphAuthority>;
    try {
      graph = timelineEditProcessedGraphAuthority(ir, sourceRoot, view.sourceNodeId);
    } catch (error) {
      if (!(error instanceof TimelineEditError)) throw error;
      fail(plan, error.code, itemPath, error.message.replace(/^[A-Z0-9_]+:\s*/u, ""), expected.provenance, expectedTrack.trackId, sourceRoot.id);
    }
    if (graph.graphAuthorityId !== view.graphAuthorityId
      || !sameValue(graph.processors, view.processorNodeIds)) {
      fail(plan, "CUT_TIMELINE_EDIT_RESULT", itemPath, "timeline audio origin processor authority changed after materialization", expected.provenance, expectedTrack.trackId, sourceRoot.id);
    }
  } else if (sourceRoot.op !== "cut.audio.clip"
    || timelineEditSourceAuthority(ir, sourceRoot) !== view.authorityId) {
    fail(plan, "CUT_TIMELINE_EDIT_RESULT", itemPath, "timeline direct-audio origin source authority changed after materialization", expected.provenance, expectedTrack.trackId, sourceRoot.id);
  }
  return expectedEnvelope;
}

function assertMappedSource(
  ir: CutAVIR,
  plan: TimelineEditPlanV1,
  expectedTrack: TimelineEditTrackV1,
  expected: TimelineEditItemV1,
  encoded: EditorialTrackItem,
  child: IRNode,
  itemPath: string,
  execution?: TimelineEditExecutionV1,
) {
  const view = expected.sourceView;
  if (view.kind === "gap") {
    if (encoded.kind !== "gap" || encoded.source !== undefined || encodedSourceNodeId(encoded) !== undefined) {
      fail(plan, "CUT_TIMELINE_EDIT_RESULT", itemPath, "materialized gap disagrees with the replayed result", expected.provenance, expectedTrack.trackId, child.id);
    }
    return;
  }
  const expectedKind = expectedTrack.domain === "picture" ? "picture" : "audio";
  if (encoded.kind !== expectedKind || !encoded.source || !sameValue(encoded.source, view.source)) {
    fail(plan, "CUT_TIMELINE_EDIT_RESULT", itemPath, "materialized media kind/source interval disagrees with the replayed result", expected.provenance, expectedTrack.trackId, child.id);
  }
  if (view.kind === "nested") {
    const owner = ir.compositions.find((candidate) => candidate.id === plan.compositionId);
    const config = owner ? referencePrecompConfig(ir, owner, child) : undefined;
    const livePlacementPolicy = isTimelineEditStaticPrecompOperand(child)
      ? "static-same-track-copy"
      : "structural-only";
    if (expectedTrack.domain !== "picture"
      || child.op !== "cut.visual.precomp"
      || (view.placementPolicy !== undefined
        && view.placementPolicy !== livePlacementPolicy)
      || !config
      || config.kind !== "visual"
      || config.sourceCompositionId !== view.compositionId
      || !same(config.sourceRange.start, view.source.start)
      || !same(config.sourceRange.end, addRational(view.source.start, view.source.duration))
      || !same(config.duration, expected.destination.duration)
      || !same(view.rate, rational(1))
      || view.sharedClock !== true
      || timelineEditSourceAuthority(ir, child) !== view.authorityId) {
      fail(
        plan,
        "CUT_TIMELINE_EDIT_RESULT",
        itemPath,
        "materialized Precomp lost its exact source composition, selected range, 1:1 clock, or edit-invariant authority",
        expected.provenance,
        expectedTrack.trackId,
        child.id,
      );
    }
    return;
  }
  if (child.op === "cut.edit.timeline_audio_view") {
    if (!execution) {
      fail(plan, "CUT_TIMELINE_EDIT_RESULT", itemPath, "timeline audio view validation lost its canonical execution", expected.provenance, expectedTrack.trackId, child.id);
    }
    const expectedEnvelope = assertTimelineAudioView(
      ir,
      plan,
      execution,
      expectedTrack,
      expected,
      encoded,
      child,
      itemPath,
    );
    const view = expected.sourceView;
    if (view.kind !== "audio" && view.kind !== "processed-audio") {
      fail(plan, "CUT_TIMELINE_EDIT_RESULT", itemPath, "timeline audio view received a non-audio replay item", expected.provenance, expectedTrack.trackId, child.id);
    }
    const sourceNodeId = encodedSourceNodeId(encoded)!;
    const sourceLeaf = ir.nodes[sourceNodeId];
    const originId = nodeRefInput(child, "origin");
    const origin = originId ? ir.nodes[originId] : undefined;
    const sourceRoot = origin?.children.length === 1 ? ir.nodes[origin.children[0]!] : undefined;
    const originSourceRange = sourceLeaf
      ? exactRangeInput(sourceLeaf, "range")
      : undefined;
    if (!sourceLeaf || !originSourceRange) {
      fail(plan, "CUT_TIMELINE_EDIT_RESULT", itemPath, "timeline audio view lost its authenticated origin source interval", expected.provenance, expectedTrack.trackId, child.id);
    }
    const originSourceStart = originSourceRange.start;
    const originSourceDuration = multiplyRational(
      view.presentationClock.originDuration,
      view.rate,
    );
    const handleOwner = view.kind === "processed-audio" ? sourceRoot : sourceLeaf;
    const authoredHeadHandle = handleOwner
      ? timeInput(handleOwner, "headHandle")
      : zeroRational;
    const authoredTailHandle = handleOwner
      ? timeInput(handleOwner, "tailHandle")
      : zeroRational;
    const availableStart = subtractRational(originSourceStart, authoredHeadHandle);
    const availableEnd = addRational(
      addRational(originSourceStart, originSourceDuration),
      authoredTailHandle,
    );
    const expectedDerivedHead = subtractRational(view.source.start, availableStart);
    const expectedDerivedTail = subtractRational(
      availableEnd,
      addRational(view.source.start, view.source.duration),
    );
    const selectedBounds = expectedEnvelope?.source ?? originSourceRange;
    const selectedEnd = addRational(view.source.start, view.source.duration);
    const selectedBoundsEnd = addRational(
      selectedBounds.start,
      selectedBounds.duration,
    );
    const presentationLower = expectedEnvelope
      ? subtractRational(zeroRational, expectedEnvelope.presentationZero)
      : zeroRational;
    const presentationUpper = expectedEnvelope
      ? subtractRational(
          divideRational(expectedEnvelope.source.duration, view.rate),
          expectedEnvelope.presentationZero,
        )
      : view.presentationClock.originDuration;
    const sourceSampleRate = lockedAudioSampleRate(ir, sourceLeaf);
    if (expectedEnvelope) {
      if (typeof sourceSampleRate !== "number") {
        fail(
          plan,
          "CUT_TIMELINE_EDIT_TIME",
          `${itemPath}.sourceView.source`,
          "locked external audio evaluation lost its selected native sample clock",
          expected.provenance,
          expectedTrack.trackId,
          child.id,
        );
      }
      const sourceStartSamples = multiplyRational(
        expectedEnvelope.source.start,
        rational(sourceSampleRate),
      );
      const sourceEndSamples = multiplyRational(
        addRational(
          expectedEnvelope.source.start,
          expectedEnvelope.source.duration,
        ),
        rational(sourceSampleRate),
      );
      if (sourceStartSamples.denominator !== "1"
        || sourceEndSamples.denominator !== "1") {
        fail(
          plan,
          "CUT_TIMELINE_EDIT_TIME",
          `${itemPath}.sourceView.source`,
          `authenticated audio evaluation envelope does not land on the locked ${sourceSampleRate} Hz source sample grid`,
          expected.provenance,
          expectedTrack.trackId,
          child.id,
        );
      }
    }
    if (!same(originSourceRange.duration, originSourceDuration)
      || directSourceResourceId(sourceLeaf) === undefined
      || timelineEditSourceAuthority(ir, sourceLeaf) !== view.authorityId
      || !same(divideRational(view.source.duration, expected.destination.duration), view.rate)
      || !same(timeInput(child, "headHandle"), view.handles.head)
      || !same(timeInput(child, "tailHandle"), view.handles.tail)
      || !same(view.handles.head, expectedDerivedHead)
      || !same(view.handles.tail, expectedDerivedTail)
      || !same(timeInput(sourceLeaf, "fadeIn"), view.fadeIn)
      || !same(timeInput(sourceLeaf, "fadeOut"), view.fadeOut)
      || compareRational(view.source.start, selectedBounds.start) < 0
      || compareRational(selectedEnd, selectedBoundsEnd) > 0
      || compareRational(
        view.source.start,
        addRational(
          originSourceStart,
          multiplyRational(view.presentationClock.sliceOffset, view.rate),
        ),
      ) !== 0
      || compareRational(
        view.presentationClock.sliceOffset,
        presentationLower,
      ) < 0
      || compareRational(
        addRational(view.presentationClock.sliceOffset, expected.destination.duration),
        presentationUpper,
      ) > 0) {
      fail(plan, "CUT_TIMELINE_EDIT_RESULT", itemPath, "timeline audio view source/rate/fade presentation changed after materialization", expected.provenance, expectedTrack.trackId, child.id);
    }
    return;
  }
  const materializedSource = actualSourceLeaf(ir, encoded, child);
  if (!materializedSource
    || directSourceResourceId(materializedSource) === undefined
    || timelineEditSourceAuthority(ir, materializedSource) !== view.authorityId) {
    fail(plan, "CUT_TIMELINE_EDIT_RESULT", itemPath, "materialized media source does not preserve its edit-invariant source/resource authority", expected.provenance, expectedTrack.trackId, child.id);
  }
  if (view.kind === "picture") {
    if (child.op !== "cut.edit.picture_clip"
      || !sameValue(normalizedPictureTimeMap(encodedPictureTimeMap(encoded)), view.timeMap)
      || !same(timeInput(child, "headHandle"), view.handles.head)
      || !same(timeInput(child, "tailHandle"), view.handles.tail)) {
      fail(plan, "CUT_TIMELINE_EDIT_RESULT", itemPath, "materialized picture time map or source handles disagree with the replayed result", expected.provenance, expectedTrack.trackId, child.id);
    }
    return;
  }
  if (view.kind !== "audio" && view.kind !== "processed-audio") {
    fail(plan, "CUT_TIMELINE_EDIT_UNSUPPORTED", itemPath, "nested audiovisual source reached a picture/audio materialization", expected.provenance, expectedTrack.trackId, child.id);
  }
  const sourceNodeId = encodedSourceNodeId(encoded);
  if (view.kind === "processed-audio") {
    let graph: ReturnType<typeof timelineEditProcessedGraphAuthority>;
    try {
      graph = timelineEditProcessedGraphAuthority(ir, child, view.sourceNodeId);
    } catch (error) {
      if (!(error instanceof TimelineEditError)) throw error;
      fail(plan, error.code, itemPath, error.message.replace(/^[A-Z0-9_]+:\s*/u, ""), expected.provenance, expectedTrack.trackId, child.id);
    }
    if (child.op !== "cut.edit.audio_region"
      || child.id !== view.regionId
      || sourceNodeId !== view.sourceNodeId
      || graph.graphAuthorityId !== view.graphAuthorityId
      || !sameValue(graph.processors, view.processorNodeIds)) {
      fail(plan, "CUT_TIMELINE_EDIT_RESULT", itemPath, "materialized processed-audio ownership disagrees with its exact source leaf", expected.provenance, expectedTrack.trackId, child.id);
    }
  } else if (child.op !== "cut.audio.clip" || sourceNodeId !== undefined) {
    fail(plan, "CUT_TIMELINE_EDIT_RESULT", itemPath, "materialized direct-audio ownership disagrees with the replayed result", expected.provenance, expectedTrack.trackId, child.id);
  }
  const rate = divideRational(view.source.duration, expected.destination.duration);
  const handleOwner = view.kind === "processed-audio" ? child : materializedSource!;
  if (!same(rate, view.rate)
    || !same(timeInput(handleOwner, "headHandle"), view.handles.head)
    || !same(timeInput(handleOwner, "tailHandle"), view.handles.tail)
    || !same(timeInput(materializedSource!, "fadeIn"), view.fadeIn)
    || !same(timeInput(materializedSource!, "fadeOut"), view.fadeOut)) {
    fail(plan, "CUT_TIMELINE_EDIT_RESULT", itemPath, "materialized audio rate, handles, or fades disagree with the replayed origin-clock view", expected.provenance, expectedTrack.trackId, child.id);
  }
  if (compareRational(
    addRational(view.presentationClock.sliceOffset, expected.destination.duration),
    view.presentationClock.originDuration,
  ) > 0) {
    fail(plan, "CUT_TIMELINE_EDIT_RESULT", itemPath, "materialized audio presentation clock exceeds its authorized origin", expected.provenance, expectedTrack.trackId, child.id);
  }
}

function assertItem(
  ir: CutAVIR,
  plan: TimelineEditPlanV1,
  expectedTrack: TimelineEditTrackV1,
  track: EditorialTrackNode,
  expected: TimelineEditItemV1,
  index: number,
  childParents: ReadonlyMap<string, readonly string[]>,
  execution: TimelineEditExecutionV1,
) {
  const encoded = track.editorial.items[index];
  const itemPath = `$.timelineEdits.${plan.id}.tracks.${expectedTrack.trackId}.items[${index}]`;
  if (!encoded || encoded.order !== index || track.children[index] !== encoded.nodeId) {
    fail(plan, "CUT_TIMELINE_EDIT_RESULT", itemPath, "materialized item order/count disagrees with the replayed result", expected.provenance, expectedTrack.trackId, track.id);
  }
  const child = ir.nodes[encoded.nodeId];
  if (!child || child.sceneId !== plan.sceneId || child.ownership !== "child") {
    fail(plan, "CUT_TIMELINE_EDIT_REFERENCE", `${itemPath}.nodeId`, "materialized item does not own one live same-scene child", expected.provenance, expectedTrack.trackId, encoded.nodeId);
  }
  const parents = childParents.get(child.id) ?? [];
  if (parents.length !== 1 || parents[0] !== track.id) {
    fail(plan, "CUT_TIMELINE_EDIT_REFERENCE", `${itemPath}.nodeId`, "materialized item child must have exactly one live parent and that parent must be its terminal track", expected.provenance, expectedTrack.trackId, child.id);
  }
  const destination = relativeInterval(encoded.destination, track.interval.start);
  if (!sameValue(destination, expected.destination)) {
    fail(plan, "CUT_TIMELINE_EDIT_RESULT", `${itemPath}.destination`, "materialized destination disagrees with the replayed result", expected.provenance, expectedTrack.trackId, child.id);
  }
  if (encoded.editId !== expected.originId) {
    fail(plan, "CUT_TIMELINE_EDIT_RESULT", `${itemPath}.editId`, "materialized editId lost its authored origin identity", expected.provenance, expectedTrack.trackId, child.id);
  }
  if (encoded.linkId !== expected.linkId) {
    fail(plan, "CUT_TIMELINE_EDIT_LINK", `${itemPath}.linkId`, "materialized link identity disagrees with the replayed result", expected.provenance, expectedTrack.trackId, child.id);
  }
  const childLink = child.inputs.link;
  if ((childLink === undefined ? undefined : childLink.kind === "string" ? childLink.value : null)
    !== expected.linkId) {
    fail(plan, "CUT_TIMELINE_EDIT_LINK", `${itemPath}.nodeId.inputs.link`, "materialized child link identity disagrees with the replayed terminal item", expected.provenance, expectedTrack.trackId, child.id);
  }
  if (encoded.role !== expected.role || !sameValue(normalizedItemMetadata(encoded), expected.metadata)) {
    fail(plan, "CUT_TIMELINE_EDIT_RESULT", `${itemPath}.metadata`, "materialized item role or metadata disagrees with the replayed result", expected.provenance, expectedTrack.trackId, child.id);
  }
  if (!sameValue(child.provenance, expected.provenance)) {
    fail(plan, "CUT_TIMELINE_EDIT_RESULT", `${itemPath}.provenance`, "materialized child provenance disagrees with the causative edit", expected.provenance, expectedTrack.trackId, child.id);
  }
  assertSourceReferences(ir, plan, expectedTrack, expected, itemPath);
  assertMappedSource(ir, plan, expectedTrack, expected, encoded, child, itemPath, execution);
}

function assertTransition(
  plan: TimelineEditPlanV1,
  expectedTrack: TimelineEditTrackV1,
  track: EditorialTrackNode,
  expected: TimelineEditTransitionV1,
  index: number,
) {
  const actual = track.editorial.transitions?.[index];
  const path = `$.timelineEdits.${plan.id}.transitions[${index}]`;
  if (!actual) {
    fail(plan, "CUT_TIMELINE_EDIT_RESULT", path, "materialized transition is missing", plan.provenance, expectedTrack.trackId, track.id);
  }
  const outgoingIndex = expectedTrack.items.findIndex((item) => item.segmentId === expected.outgoingSegmentId);
  const incomingIndex = expectedTrack.items.findIndex((item) => item.segmentId === expected.incomingSegmentId);
  if (outgoingIndex < 0 || incomingIndex < 0) {
    fail(plan, "CUT_TIMELINE_EDIT_RESULT", path, "replayed transition lost its terminal segment identities", plan.provenance, expectedTrack.trackId, track.id);
  }
  const operation = plan.operations.find((candidate) => candidate.id === expected.operationId);
  const normalized = {
    cut: subtractRational(actual.cut, track.interval.start),
    duration: actual.duration,
    overlap: relativeInterval(actual.overlap, track.interval.start),
    outgoingNodeId: actual.outgoingNodeId,
    incomingNodeId: actual.incomingNodeId,
    outgoingSource: actual.outgoingSource,
    incomingSource: actual.incomingSource,
    style: "style" in actual ? actual.style : undefined,
    audio: "curve" in actual ? { curve: actual.curve } : undefined,
    provenance: actual.provenance,
  };
  const wanted = {
    cut: expected.cut,
    duration: expected.duration,
    overlap: expected.overlap,
    outgoingNodeId: track.editorial.items[outgoingIndex]?.nodeId,
    incomingNodeId: track.editorial.items[incomingIndex]?.nodeId,
    outgoingSource: expected.outgoingSource,
    incomingSource: expected.incomingSource,
    style: expected.picture,
    audio: expected.audio,
    provenance: operation?.provenance,
  };
  if (!sameValue(normalized, wanted)) {
    fail(plan, "CUT_TIMELINE_EDIT_TRANSITION", path, "materialized transition disagrees with exact replayed cut, handles, style, or child ownership", operation?.provenance ?? plan.provenance, expectedTrack.trackId, track.id);
  }
}

function validatePlan(
  ir: CutAVIR,
  plan: TimelineEditPlanV1,
  claimedTrackNodeIds: Set<string>,
  childParents: ReadonlyMap<string, readonly string[]>,
): ReferenceTimelineEditMaterializationReceipt {
  const composition = ir.compositions.find((candidate) => candidate.id === plan.compositionId);
  const scene = ir.scenes[plan.sceneId];
  if (!composition || !scene || !composition.sceneIds.includes(plan.sceneId)) {
    fail(plan, "CUT_TIMELINE_EDIT_REFERENCE", `$.timelineEdits.${plan.id}`, "plan does not belong to one live composition scene");
  }
  if (!same(plan.initialDuration, scene.duration) || !same(plan.finalDuration, scene.duration)) {
    fail(plan, "CUT_TIMELINE_EDIT_TIME", `$.timelineEdits.${plan.id}`, "plan duration disagrees with its live owning scene");
  }
  let execution: TimelineEditExecutionV1;
  try {
    execution = executeTimelineEditPlan(plan);
  } catch (error) {
    if (!(error instanceof TimelineEditError)) throw error;
    fail(
      plan,
      error.code,
      `$.timelineEdits.${plan.id}${error.path === "$" ? "" : error.path.slice(1)}`,
      error.message.replace(/^[A-Z0-9_]+:\s*/u, ""),
      plan.operations[error.operationIndex ?? -1]?.provenance ?? plan.provenance,
    );
  }
  const live = actualTrackNodes(ir, plan);
  const selected: EditorialTrackNode[] = [];
  for (const expected of execution.tracks) {
    if (expected.domain === "audiovisual") {
      fail(plan, "CUT_TIMELINE_EDIT_UNSUPPORTED", `$.timelineEdits.${plan.id}.tracks.${expected.trackId}`, "the reference runtime does not yet materialize conceptual audiovisual tracks; use explicit picture/audio tracks with shared link identity", plan.provenance, expected.trackId);
    }
    const matches = live.filter((node) => node.editorial.trackId === expected.trackId);
    if (matches.length !== 1) {
      fail(plan, "CUT_TIMELINE_EDIT_REFERENCE", `$.timelineEdits.${plan.id}.tracks.${expected.trackId}`, `expected exactly one live authored track and found ${matches.length}`, plan.provenance, expected.trackId);
    }
    const track = matches[0]!;
    if (claimedTrackNodeIds.has(track.id)) {
      fail(plan, "CUT_TIMELINE_EDIT_REFERENCE", `$.timelineEdits.${plan.id}.tracks.${expected.trackId}`, "live track is claimed by more than one TimelineEdit plan", track.provenance, expected.trackId, track.id);
    }
    claimedTrackNodeIds.add(track.id);
    const kind = expected.domain === "picture" ? "picture-track" : "audio-track";
    const op = expected.domain === "picture" ? "cut.edit.picture_track" : "cut.edit.audio_track";
    if (track.editorial.kind !== kind || track.op !== op || (expected.domain === "picture" ? track.domain !== "visual" : track.domain !== "audio")) {
      fail(plan, "CUT_TIMELINE_EDIT_RESULT", `$.timelineEdits.${plan.id}.tracks.${expected.trackId}`, "live track domain/kernel disagrees with the replayed result", track.provenance, expected.trackId, track.id);
    }
    if (track.editorial.operationPlan !== undefined) {
      fail(plan, "CUT_TIMELINE_EDIT_RESULT", `$.nodes.${track.id}.editorial.operationPlan`, "timeline-owned track cannot carry a second legacy edit-plan authority", track.provenance, expected.trackId, track.id);
    }
    if (!same(track.interval.start, zeroRational)
      || !same(track.interval.duration, expected.duration)
      || track.editorial.role !== expected.role
      || !sameValue(track.editorial.metadata ?? {}, expected.metadata)) {
      fail(plan, "CUT_TIMELINE_EDIT_RESULT", `$.timelineEdits.${plan.id}.tracks.${expected.trackId}`, "live track timing, role, or metadata disagrees with the replayed result", track.provenance, expected.trackId, track.id);
    }
    if (track.children.length !== expected.items.length || track.editorial.items.length !== expected.items.length) {
      fail(plan, "CUT_TIMELINE_EDIT_RESULT", `$.timelineEdits.${plan.id}.tracks.${expected.trackId}.items`, "live materialized item count disagrees with the replayed result", track.provenance, expected.trackId, track.id);
    }
    expected.items.forEach((item, index) => assertItem(ir, plan, expected, track, item, index, childParents, execution));
    const transitions = execution.transitions.filter((candidate) => candidate.trackId === expected.trackId);
    if ((track.editorial.transitions?.length ?? 0) !== transitions.length) {
      fail(plan, "CUT_TIMELINE_EDIT_RESULT", `$.timelineEdits.${plan.id}.tracks.${expected.trackId}.transitions`, "live transition count disagrees with the replayed result", track.provenance, expected.trackId, track.id);
    }
    transitions.forEach((transition, index) => assertTransition(plan, expected, track, transition, index));
    selected.push(track);
  }
  const ordered = orderedActualTracks(ir, plan, selected);
  for (const [index, expected] of execution.tracks.entries()) {
    if (expected.order !== index || ordered[index]?.editorial.trackId !== expected.trackId) {
      fail(plan, "CUT_TIMELINE_EDIT_RESULT", `$.timelineEdits.${plan.id}.tracks[${index}].order`, "live picture/audio track order disagrees with the canonical replay order", plan.provenance, expected.trackId, ordered[index]?.id);
    }
  }
  return Object.freeze({
    version: 1,
    planId: plan.id,
    materializationId: execution.materializationId,
    trackBindings: Object.freeze(execution.tracks.map((expected) => {
      const track = selected.find((candidate) => candidate.editorial.trackId === expected.trackId)!;
      return Object.freeze({
        trackId: expected.trackId,
        trackNodeId: track.id,
        domain: expected.domain as "picture" | "audio",
        items: expected.items.length,
        transitions: execution.transitions.filter((candidate) => candidate.trackId === expected.trackId).length,
      });
    })),
  });
}

/**
 * Return the unique plan ownership declaration used by legacy track
 * validators to avoid rejecting TimelineEdit-owned transitions as
 * unauthorised legacy materialization. Full semantic authorization remains in
 * `validateReferenceTimelineEditMaterializations`.
 */
export function referenceTimelineEditTrackOwnership(
  ir: CutAVIR,
  track: IRNode,
): ReferenceTimelineEditTrackOwnership | undefined {
  const editorial = track.editorial;
  if (!ir.timelineEdits?.length
    || (editorial?.kind !== "picture-track" && editorial?.kind !== "audio-track")
    || !editorial.trackId
    || !track.sceneId) return undefined;
  const authoredTrackId = editorial.trackId;
  const domain = editorial.kind === "picture-track" ? "picture" as const : "audio" as const;
  const matches = ir.timelineEdits.flatMap((plan) =>
    plan.sceneId === track.sceneId
      ? plan.tracks
        .filter((candidate) => candidate.trackId === authoredTrackId && candidate.domain === domain)
        .map(() => ({
          planId: plan.id,
          compositionId: plan.compositionId,
          sceneId: plan.sceneId,
          trackId: authoredTrackId,
          domain,
        }))
      : []);
  if (matches.length > 1) {
    const plan = ir.timelineEdits.find((candidate) => candidate.id === matches[0]!.planId)!;
    fail(plan, "CUT_TIMELINE_EDIT_REFERENCE", `$.nodes.${track.id}.editorial.trackId`, "live track is claimed by more than one TimelineEdit plan", track.provenance, authoredTrackId, track.id);
  }
  return matches[0] ? Object.freeze(matches[0]) : undefined;
}

/**
 * Project one canonical TimelineEdit audio result into the existing
 * sample-domain transition law. This replays TimelineEdit; it does not create
 * a second edit authority or flatten processed operands.
 */
export function referenceTimelineEditAudioTrackTransitions(
  ir: CutAVIR,
  track: IRNode,
): readonly AudioEditTrackTransition[] | undefined {
  const ownership = referenceTimelineEditTrackOwnership(ir, track);
  if (!ownership || ownership.domain !== "audio") return undefined;
  const plan = ir.timelineEdits?.find((candidate) => candidate.id === ownership.planId);
  if (!plan) return undefined;
  let execution: TimelineEditExecutionV1;
  try {
    execution = executeTimelineEditPlan(plan);
  } catch (error) {
    if (!(error instanceof TimelineEditError)) throw error;
    fail(
      plan,
      error.code,
      `$.timelineEdits.${plan.id}${error.path === "$" ? "" : error.path.slice(1)}`,
      error.message.replace(/^[A-Z0-9_]+:\s*/u, ""),
      plan.operations[error.operationIndex ?? -1]?.provenance ?? plan.provenance,
      ownership.trackId,
      track.id,
    );
  }
  const result = execution.tracks.find((candidate) =>
    candidate.domain === "audio" && candidate.trackId === ownership.trackId);
  if (!result) {
    fail(
      plan,
      "CUT_TIMELINE_EDIT_REFERENCE",
      `$.timelineEdits.${plan.id}.tracks.${ownership.trackId}`,
      "canonical audio-track owner disappeared during transition replay",
      track.provenance,
      ownership.trackId,
      track.id,
    );
  }
  return Object.freeze(execution.transitions
    .filter((transition) => transition.domain === "audio" && transition.trackId === ownership.trackId)
    .map((transition): AudioEditTrackTransition => {
      const outgoingIndex = result.items.findIndex((item) => item.segmentId === transition.outgoingSegmentId);
      const incomingIndex = result.items.findIndex((item) => item.segmentId === transition.incomingSegmentId);
      const operation = plan.operations.find((candidate) => candidate.id === transition.operationId);
      if (outgoingIndex < 0 || incomingIndex < 0 || !operation || !transition.audio) {
        fail(
          plan,
          "CUT_TIMELINE_EDIT_TRANSITION",
          `$.timelineEdits.${plan.id}.transitions.${transition.operationId}`,
          "canonical audio transition lost its terminal segments, operation provenance, or curve",
          operation?.provenance ?? plan.provenance,
          ownership.trackId,
          track.id,
        );
      }
      return Object.freeze({
        cut: transition.cut,
        duration: transition.duration,
        overlap: transition.overlap,
        outgoingIndex,
        incomingIndex,
        outgoingOrigin: result.items[outgoingIndex]!.originId,
        incomingOrigin: result.items[incomingIndex]!.originId,
        outgoingSource: transition.outgoingSource,
        incomingSource: transition.incomingSource,
        curve: transition.audio.curve,
        provenance: operation.provenance,
      });
    }));
}

/**
 * Replay every TimelineEdit plan and correlate its canonical terminal result
 * to live track nodes before picture or PCM allocation.
 */
export function validateReferenceTimelineEditMaterializations(
  ir: CutAVIR,
): ReferenceTimelineEditValidation {
  const privateNodes = Object.values(ir.nodes).filter((node) =>
    node.op === "cut.edit.timeline_audio_origin"
    || node.op === "cut.edit.timeline_audio_view");
  if (!ir.timelineEdits?.length) {
    if (privateNodes.length) {
      const node = privateNodes[0]!;
      throw new ReferenceTimelineEditMaterializationError(
        "CUT_TIMELINE_EDIT_REFERENCE",
        `$.nodes.${node.id}`,
        "<unclaimed>",
        "compiler-private timeline audio materialization requires exactly one live canonical TimelineEdit plan",
        node.provenance,
        undefined,
        node.id,
      );
    }
    return Object.freeze({
      version: 1,
      plans: Object.freeze([]),
      validationId: hash({ format: "cut-reference-timeline-edit-validation", version: 1, plans: [] }),
    });
  }
  const mutableParents = new Map<string, string[]>();
  for (const parent of Object.values(ir.nodes)) {
    for (const childId of parent.children) {
      const parents = mutableParents.get(childId) ?? [];
      parents.push(parent.id);
      mutableParents.set(childId, parents);
    }
  }
  const childParents = new Map(
    [...mutableParents].map(([childId, parents]) =>
      [childId, Object.freeze(parents)] as const),
  );
  const claimed = new Set<string>();
  const plans = ir.timelineEdits.map((plan) =>
    validatePlan(ir, plan, claimed, childParents));
  const referencedOrigins = new Set<string>();
  for (const node of privateNodes) {
    if (node.op !== "cut.edit.timeline_audio_view") continue;
    const parents = childParents.get(node.id) ?? [];
    const origin = node.inputs.origin;
    const plan = ir.timelineEdits[0]!;
    if (parents.length !== 1 || !claimed.has(parents[0]!)
      || origin?.kind !== "node-ref") {
      fail(plan, "CUT_TIMELINE_EDIT_REFERENCE", `$.nodes.${node.id}`, "timeline audio view must be the exclusive child of one live canonical TimelineEdit-owned track", node.provenance, undefined, node.id);
    }
    referencedOrigins.add(origin.id);
  }
  for (const node of privateNodes) {
    if (node.op === "cut.edit.timeline_audio_origin"
      && !referencedOrigins.has(node.id)) {
      fail(ir.timelineEdits[0]!, "CUT_TIMELINE_EDIT_REFERENCE", `$.nodes.${node.id}`, "timeline audio origin has no live canonical TimelineEdit view claim", node.provenance, undefined, node.id);
    }
  }
  const audioEvaluationOrigins = privateNodes
    .filter((node) => node.op === "cut.edit.timeline_audio_origin")
    .flatMap((origin) => {
      const envelope = materializedAudioEvaluationEnvelope(origin);
      if (!envelope) return [];
      let current = ir.nodes[origin.children[0]!];
      const seen = new Set<string>();
      let processorCount = 0;
      let timeStretchCount = 0;
      while (current && current.op !== "cut.audio.clip") {
        if (seen.has(current.id) || current.children.length !== 1 || seen.size >= 64) {
          fail(ir.timelineEdits![0]!, "CUT_TIMELINE_EDIT_LIMIT", `$.nodes.${origin.id}.children`, "audio evaluation graph is not one bounded unary source chain", origin.provenance, undefined, origin.id);
        }
        seen.add(current.id);
        if (current.op !== "cut.edit.audio_region") {
          processorCount += 1;
          if (current.op === "cut.audio.time_stretch") {
            timeStretchCount += 1;
            if (ir.nodes[current.children[0]!]?.op !== "cut.audio.clip") {
              fail(ir.timelineEdits![0]!, "CUT_TIMELINE_EDIT_UNSUPPORTED", `$.nodes.${origin.id}.children`, "retimed external evaluation requires one innermost TimeStretch directly above AudioClip", origin.provenance, undefined, origin.id);
            }
          }
        }
        current = ir.nodes[current.children[0]!];
      }
      if (!current || current.op !== "cut.audio.clip") {
        fail(ir.timelineEdits![0]!, "CUT_TIMELINE_EDIT_REFERENCE", `$.nodes.${origin.id}.children`, "audio evaluation lost its terminal AudioClip", origin.provenance, undefined, origin.id);
      }
      const sourceSampleRate = lockedAudioSampleRate(ir, current);
      if (typeof sourceSampleRate !== "number") {
        fail(ir.timelineEdits![0]!, "CUT_TIMELINE_EDIT_TIME", `$.nodes.${origin.id}.inputs.evaluationSource`, "audio evaluation lost its locked native source clock", origin.provenance, undefined, origin.id);
      }
      const samples = multiplyRational(envelope.source.duration, rational(sourceSampleRate));
      if (samples.denominator !== "1") {
        fail(ir.timelineEdits![0]!, "CUT_TIMELINE_EDIT_TIME", `$.nodes.${origin.id}.inputs.evaluationSource`, `audio evaluation does not land on the locked ${sourceSampleRate} Hz source grid`, origin.provenance, undefined, origin.id);
      }
      const sourceSamples = Number(samples.numerator);
      const composition = ir.compositions.find((candidate) =>
        origin.sceneId !== undefined && candidate.sceneIds.includes(origin.sceneId));
      if (!composition) {
        fail(ir.timelineEdits![0]!, "CUT_TIMELINE_EDIT_REFERENCE", `$.nodes.${origin.id}.sceneId`, "audio evaluation lost its owning composition clock", origin.provenance, undefined, origin.id);
      }
      const rateInput = origin.inputs.rate;
      if (rateInput?.kind !== "quantity" || rateInput.dimension !== "scalar"
        || compareRational(rateInput.magnitude, zeroRational) <= 0
        || timeStretchCount > 1
        || (compareRational(rateInput.magnitude, rational(1)) !== 0
          && timeStretchCount !== 1)) {
        fail(ir.timelineEdits![0]!, "CUT_TIMELINE_EDIT_UNSUPPORTED", `$.nodes.${origin.id}.inputs.rate`, "retimed processed evaluation requires one exact positive rate and exactly one innermost TimeStretch", origin.provenance, undefined, origin.id);
      }
      const sourceClockProcessing = multiplyRational(
        envelope.source.duration,
        rational(composition.sampleRate),
      );
      const destinationClockProcessing = multiplyRational(
        divideRational(envelope.source.duration, rateInput.magnitude),
        rational(composition.sampleRate),
      );
      if (sourceClockProcessing.denominator !== "1"
        || destinationClockProcessing.denominator !== "1") {
        fail(ir.timelineEdits![0]!, "CUT_TIMELINE_EDIT_TIME", `$.nodes.${origin.id}.inputs.evaluationSource`, `audio evaluation does not land on the owning ${composition.sampleRate} Hz processing grid`, origin.provenance, undefined, origin.id);
      }
      const sourceClockProcessingSamples = Number(sourceClockProcessing.numerator);
      const processingSamples = Number(destinationClockProcessing.numerator);
      // The source decode is charged on the locked native clock. Every static
      // processor runs after resampling and is therefore charged on the owning
      // composition clock; using the native rate here would undercount high-
      // rate timelines.
      const destinationClockProcessorCount = processorCount - timeStretchCount;
      const processorSampleWork = sourceSamples
        + sourceClockProcessingSamples * timeStretchCount
        + processingSamples * destinationClockProcessorCount;
      if (!Number.isSafeInteger(sourceSamples) || sourceSamples < 1
        || sourceSamples > cutTimelineAudioEvaluationLimits.maximumSourceSamplesPerOrigin
        || !Number.isSafeInteger(sourceClockProcessingSamples) || sourceClockProcessingSamples < 1
        || !Number.isSafeInteger(processingSamples) || processingSamples < 1
        || !Number.isSafeInteger(processorSampleWork)) {
        fail(ir.timelineEdits![0]!, "CUT_TIMELINE_EDIT_LIMIT", `$.nodes.${origin.id}.inputs.evaluationSource`, `audio evaluation exceeds maximumSourceSamplesPerOrigin=${cutTimelineAudioEvaluationLimits.maximumSourceSamplesPerOrigin}`, origin.provenance, undefined, origin.id);
      }
      return [Object.freeze({
        originNodeId: origin.id,
        evaluationPolicy: envelope.evaluationPolicy,
        sourceSamples,
        processingSamples,
        processorCount,
        processorSampleWork,
      })];
    })
    .sort((left, right) => left.originNodeId.localeCompare(right.originNodeId));
  const aggregateSourceSamples = audioEvaluationOrigins.reduce((sum, item) => sum + item.sourceSamples, 0);
  const aggregateProcessorSampleWork = audioEvaluationOrigins.reduce((sum, item) => sum + item.processorSampleWork, 0);
  if (!Number.isSafeInteger(aggregateSourceSamples)
    || aggregateSourceSamples > cutTimelineAudioEvaluationLimits.maximumAggregateSourceSamples
    || !Number.isSafeInteger(aggregateProcessorSampleWork)
    || aggregateProcessorSampleWork > cutTimelineAudioEvaluationLimits.maximumAggregateProcessorSampleWork) {
    fail(
      ir.timelineEdits[0]!,
      "CUT_TIMELINE_EDIT_LIMIT",
      "$.nodes",
      `audio evaluation aggregate exceeds source=${cutTimelineAudioEvaluationLimits.maximumAggregateSourceSamples} or processor-work=${cutTimelineAudioEvaluationLimits.maximumAggregateProcessorSampleWork}`,
      ir.timelineEdits[0]!.provenance,
    );
  }
  const audioEvaluation = audioEvaluationOrigins.length
    ? Object.freeze({
        origins: Object.freeze(audioEvaluationOrigins),
        aggregateSourceSamples,
        aggregateProcessorSampleWork,
      })
    : undefined;
  const validationContent = {
    format: "cut-reference-timeline-edit-validation",
    version: 1,
    plans,
    ...(audioEvaluation ? { audioEvaluation } : {}),
  };
  return Object.freeze({
    version: 1,
    plans: Object.freeze(plans),
    ...(audioEvaluation ? { audioEvaluation } : {}),
    validationId: hash(validationContent),
  });
}
