import { hash, stableJsonStringify } from "../core/stable";
import type {
  CutAVIR,
  IRComposition,
  IREditorial,
  IREditorialInterval,
  IRNode,
  IRValue,
} from "./ir";
import { canonicalPictureTimeMapInputs } from "./picture-time-map";
import { cutTranscriptPictureSegmentIdentity } from "./transcript-contract";
import {
  addRational,
  compareRational,
  divideRational,
  rational,
  subtractRational,
  type Rational,
  zeroRational,
} from "./rational";
import {
  isTimelineEditStaticPrecompOperand,
  type TimelineEditIrStageV1,
  type TimelineEditIrTrackBindingV1,
} from "./timeline-edit-ir-adapter";
import {
  timelineEditAudioPresentationOriginKey,
  timelineEditAudioPresentationOriginId,
  timelineEditAudioPresentationOriginTrackId,
  TimelineEditError,
  type TimelineEditItemV1,
  type TimelineEditTrackV1,
  type TimelineEditTransitionV1,
} from "./timeline-edit-operations";
import {
  timelineEditAudioOriginAuthorityContent,
  timelineEditAudioOriginAuthorityId,
  timelineEditExecutableIdentity,
  type TimelineEditAudioEvaluationEnvelopeV1,
} from "./timeline-edit-identity";
import { cutTimelineProcessedExternalHandleProcessorOps } from "./timeline-edit-audio-origin-contract";

export type TimelineEditIrTrackPatchV1 = Readonly<{
  trackNodeId: string;
  removeNodeIds: readonly string[];
  children: readonly string[];
  nodes: readonly IRNode[];
  editorial: Extract<IREditorial, { kind: "picture-track" | "audio-track" }>;
}>;

export type TimelineEditIrMaterializationV1 = Readonly<{
  version: 1;
  planId: string;
  materializationId: string;
  patches: readonly TimelineEditIrTrackPatchV1[];
  addedNodeCount: number;
  removedNodeCount: number;
  identity: string;
}>;

function fail(path: string, message: string): never {
  throw new TimelineEditError("CUT_TIMELINE_EDIT_UNSUPPORTED", message, path);
}

function timeValue(value: Rational): IRValue {
  return {
    kind: "quantity",
    dimension: "time",
    magnitude: value,
    unit: "s",
  };
}

function rateValue(value: Rational): IRValue {
  return {
    kind: "quantity",
    dimension: "scalar",
    magnitude: value,
    unit: "scalar",
  };
}

function intervalValue(value: IREditorialInterval): IRValue {
  const end = {
    numerator: (
      BigInt(value.start.numerator) * BigInt(value.duration.denominator)
      + BigInt(value.duration.numerator) * BigInt(value.start.denominator)
    ).toString(),
    denominator: (
      BigInt(value.start.denominator) * BigInt(value.duration.denominator)
    ).toString(),
  };
  // `rational` owns normalization and the hostile integer budget.
  const normalizedEnd = rational(BigInt(end.numerator), BigInt(end.denominator));
  return {
    kind: "range",
    start: timeValue(value.start),
    end: timeValue(normalizedEnd),
    exclusive: true,
  };
}

function zeroTimeInput(node: IRNode, name: "fadeIn" | "fadeOut") {
  const value = node.inputs[name];
  return value === undefined
    || (value.kind === "quantity"
      && value.dimension === "time"
      && compareRational(value.magnitude, zeroRational) === 0);
}

function withHandleInputs(
  inputs: Record<string, IRValue>,
  handles: Readonly<{ head: Rational; tail: Rational }>,
) {
  const result = { ...inputs };
  delete result.headHandle;
  delete result.tailHandle;
  if (compareRational(handles.head, zeroRational) > 0) {
    result.headHandle = timeValue(handles.head);
  }
  if (compareRational(handles.tail, zeroRational) > 0) {
    result.tailHandle = timeValue(handles.tail);
  }
  return result;
}

function withTerminalLink(
  inputs: Record<string, IRValue>,
  linkId: string | undefined,
) {
  const result = { ...inputs };
  delete result.link;
  if (linkId !== undefined) {
    result.link = { kind: "string", value: linkId };
  }
  return result;
}

function exactGrid(value: Rational, rate: Rational, path: string) {
  const numerator = BigInt(value.numerator) * BigInt(rate.numerator);
  const denominator = BigInt(value.denominator) * BigInt(rate.denominator);
  if (denominator <= 0n || numerator % denominator !== 0n) {
    throw new TimelineEditError(
      "CUT_TIMELINE_EDIT_TIME",
      `does not land on the exact ${rate.numerator}/${rate.denominator} destination grid.`,
      path,
    );
  }
}

function assertTrackGrid(
  track: TimelineEditTrackV1,
  transitions: readonly TimelineEditTransitionV1[],
  composition: IRComposition,
) {
  const rate = track.domain === "picture"
    ? composition.fps
    : track.domain === "audio"
      ? rational(composition.sampleRate)
      : undefined;
  if (!rate) fail(`$.tracks.${track.trackId}`, "nested audiovisual track materialization is not yet an executable v1 compiler surface.");
  for (const [index, item] of track.items.entries()) {
    exactGrid(item.destination.start, rate, `$.tracks.${track.trackId}.items[${index}].destination.start`);
    exactGrid(item.destination.duration, rate, `$.tracks.${track.trackId}.items[${index}].destination.duration`);
  }
  for (const [index, transition] of transitions.entries()) {
    exactGrid(transition.cut, rate, `$.tracks.${track.trackId}.transitions[${index}].cut`);
    exactGrid(transition.duration, rate, `$.tracks.${track.trackId}.transitions[${index}].duration`);
    exactGrid(transition.overlap.start, rate, `$.tracks.${track.trackId}.transitions[${index}].overlap.start`);
  }
}

function materializedNodeId(
  stage: TimelineEditIrStageV1,
  trackId: string,
  item: TimelineEditItemV1,
  index: number,
) {
  return `timeline_item_${hash({
    format: "cut-timeline-edit-item",
    version: 1,
    planId: stage.plan.id,
    materializationId: stage.execution.materializationId,
    trackId,
    segmentId: item.segmentId,
    index,
  }).slice(0, 24)}`;
}

function materializedAudioOriginNodeId(
  stage: TimelineEditIrStageV1,
  originTrackId: string,
  authorityOriginId: string,
  sourceRootId: string,
) {
  return `timeline_audio_origin_${hash({
    format: "cut-timeline-edit-audio-origin",
    version: 1,
    planId: stage.plan.id,
    semanticMaterializationId:
      timelineEditExecutableIdentity(stage.plan).semanticMaterializationId,
    trackId: originTrackId,
    authorityOriginId,
    sourceRootId,
  }).slice(0, 24)}`;
}

function materializedAudioViewNodeId(
  stage: TimelineEditIrStageV1,
  trackId: string,
  item: TimelineEditItemV1,
  index: number,
) {
  return `timeline_audio_view_${hash({
    format: "cut-timeline-edit-audio-view",
    version: 1,
    planId: stage.plan.id,
    semanticMaterializationId:
      timelineEditExecutableIdentity(stage.plan).semanticMaterializationId,
    trackId,
    segmentId: item.segmentId,
    originId: item.originId,
    index,
  }).slice(0, 24)}`;
}

type OriginClockAudioView = Extract<
  TimelineEditItemV1["sourceView"],
  { kind: "audio" | "processed-audio" }
>;

function originClockAudioView(item: TimelineEditItemV1): OriginClockAudioView | undefined {
  const view = item.sourceView;
  return view.kind === "audio" || view.kind === "processed-audio" ? view : undefined;
}

function hasAuthoredFade(view: OriginClockAudioView) {
  return compareRational(view.fadeIn, zeroRational) > 0
    || compareRational(view.fadeOut, zeroRational) > 0;
}

function requiresAudioOriginView(item: TimelineEditItemV1) {
  const view = originClockAudioView(item);
  return view !== undefined
    && (view.kind === "processed-audio" || hasAuthoredFade(view));
}

function intervalEnd(value: IREditorialInterval) {
  return addRational(value.start, value.duration);
}

function minimumRational(left: Rational, right: Rational) {
  return compareRational(left, right) <= 0 ? left : right;
}

function maximumRational(left: Rational, right: Rational) {
  return compareRational(left, right) >= 0 ? left : right;
}

const processedExternalHandleProcessorOps = new Set<string>(
  cutTimelineProcessedExternalHandleProcessorOps,
);

function assertProcessedExternalHandleGraph(
  ir: CutAVIR,
  base: TimelineEditItemV1,
  envelope: TimelineEditAudioEvaluationEnvelopeV1,
  path: string,
) {
  const view = originClockAudioView(base);
  if (view?.kind !== "processed-audio"
    || envelope.evaluationPolicy !== "full-declared-handle-domain-v1") return;
  const region = ir.nodes[view.regionId];
  const source = ir.nodes[view.sourceNodeId];
  if (!region || region.op !== "cut.edit.audio_region"
    || Object.keys(region.properties).length
    || !source || source.op !== "cut.audio.clip"
    || Object.keys(source.properties).length) {
    fail(path, "processed external handles require one static AudioRegion and AudioClip leaf.");
  }
  if (!view.processorNodeIds.length) {
    fail(path, "processed external handles require one non-empty static unary processor chain.");
  }
  let timeStretchIndex = -1;
  for (const [index, processorId] of view.processorNodeIds.entries()) {
    const processor = ir.nodes[processorId];
    if (!processor
      || !processedExternalHandleProcessorOps.has(processor.op)
      || processor.children.length !== 1
      || Object.keys(processor.properties).length) {
      fail(
        `${path}.processorNodeIds[${index}]`,
        "processed external handles admit only static Gain, Pan, ParametricEQ, HighPass, LowPass, Compressor, DeEsser, and one constrained TimeStretch; automation, routing, and tail-producing effects remain fail-closed.",
      );
    }
    if (processor.op === "cut.audio.time_stretch") {
      if (timeStretchIndex >= 0
        || index !== view.processorNodeIds.length - 1
        || processor.children[0] !== view.sourceNodeId) {
        fail(
          `${path}.processorNodeIds[${index}]`,
          "retimed external handles require exactly one innermost TimeStretch directly above AudioClip.",
        );
      }
      const sourceDuration = processor.inputs.sourceDuration;
      const duration = processor.inputs.duration;
      if (sourceDuration?.kind !== "quantity" || sourceDuration.dimension !== "time"
        || duration?.kind !== "quantity" || duration.dimension !== "time"
        || compareRational(sourceDuration.magnitude, view.source.duration) !== 0
        || compareRational(duration.magnitude, view.presentationClock.originDuration) !== 0
        || compareRational(
          divideRational(sourceDuration.magnitude, duration.magnitude),
          view.rate,
        ) !== 0) {
        fail(
          `${path}.processorNodeIds[${index}]`,
          "TimeStretch sourceDuration, duration, and the canonical source clock must agree exactly.",
        );
      }
      timeStretchIndex = index;
    }
  }
  if (compareRational(view.rate, rational(1)) !== 0 && timeStretchIndex < 0) {
    fail(path, "retimed processed external handles require one authenticated constant TimeStretch.");
  }
}

/**
 * Derive the smallest immutable source interval that preserves the complete
 * authored origin and every final externally handled view. Omission is
 * intentional: an edit wholly inside the authored source retains the exact
 * pre-envelope origin bytes and runtime path.
 */
export function timelineEditAudioEvaluationEnvelopeV1(
  base: TimelineEditItemV1,
  items: readonly TimelineEditItemV1[],
  transitions: readonly TimelineEditTransitionV1[],
): TimelineEditAudioEvaluationEnvelopeV1 | undefined {
  const view = originClockAudioView(base);
  if (!view) return undefined;
  const availableStart = subtractRational(view.source.start, view.handles.head);
  const availableEnd = addRational(intervalEnd(view.source), view.handles.tail);
  let start = view.source.start, end = intervalEnd(view.source);
  const bySegment = new Map(items.map((item) => [item.segmentId, item] as const));
  for (const item of items) {
    const candidate = originClockAudioView(item);
    if (!candidate) continue;
    start = minimumRational(start, candidate.source.start);
    end = maximumRational(end, intervalEnd(candidate.source));
  }
  for (const transition of transitions) {
    const outgoing = bySegment.get(transition.outgoingSegmentId);
    const incoming = bySegment.get(transition.incomingSegmentId);
    if (outgoing && timelineEditAudioPresentationOriginKey(outgoing)
      === timelineEditAudioPresentationOriginKey(base)) {
      start = minimumRational(start, transition.outgoingSource.start);
      end = maximumRational(end, intervalEnd(transition.outgoingSource));
    }
    if (incoming && timelineEditAudioPresentationOriginKey(incoming)
      === timelineEditAudioPresentationOriginKey(base)) {
      start = minimumRational(start, transition.incomingSource.start);
      end = maximumRational(end, intervalEnd(transition.incomingSource));
    }
  }
  if (compareRational(start, availableStart) < 0
    || compareRational(end, availableEnd) > 0) {
    throw new TimelineEditError(
      "CUT_TIMELINE_EDIT_HANDLE",
      "materialized audio evaluation envelope exceeds the declared source handles.",
      `$.tracks.${base.trackId}.origins.${timelineEditAudioPresentationOriginId(base)}`,
    );
  }
  const usesExternalHandle = compareRational(start, view.source.start) !== 0
    || compareRational(end, intervalEnd(view.source)) !== 0;
  if (!usesExternalHandle) return undefined;
  if (view.kind !== "processed-audio"
    && compareRational(view.rate, rational(1)) !== 0) {
    throw new TimelineEditError(
      "CUT_TIMELINE_EDIT_UNSUPPORTED",
      "direct faded audio external-handle evaluation currently requires an exact 1x source clock.",
      `$.tracks.${base.trackId}.origins.${timelineEditAudioPresentationOriginId(base)}`,
    );
  }
  if (view.kind === "processed-audio") {
    // A stateful processor cannot begin at a view-dependent source position:
    // doing so changes its history. Evaluate the complete declared handle
    // domain, once, so every canonical edit over this origin sees one stable
    // causal clock.
    start = availableStart;
    end = availableEnd;
  }
  return Object.freeze({
    source: Object.freeze({
      start,
      duration: subtractRational(end, start),
    }),
    presentationZero: divideRational(
      subtractRational(view.source.start, start),
      view.rate,
    ),
    fadeAnchorPolicy: "origin-relative-at-presentation-zero" as const,
    evaluationPolicy: view.kind === "processed-audio"
      ? "full-declared-handle-domain-v1" as const
      : "selected-source-union-v1" as const,
  });
}

function stringValue(value: string): IRValue {
  return { kind: "string", value };
}

function audioOriginAuthorityId(
  stage: TimelineEditIrStageV1,
  item: TimelineEditItemV1,
  sourceRoot: IRNode,
  evaluationEnvelope?: TimelineEditAudioEvaluationEnvelopeV1,
) {
  const view = originClockAudioView(item);
  if (!view) fail(`$.tracks.${item.trackId}.sourceView`, "lost its origin-clock audio view.");
  return timelineEditAudioOriginAuthorityId(
    timelineEditAudioOriginAuthorityContent(
      stage.plan.id,
      timelineEditExecutableIdentity(stage.plan).semanticMaterializationId,
      timelineEditAudioPresentationOriginTrackId(item),
      timelineEditAudioPresentationOriginId(item),
      sourceRoot.id,
      view,
      evaluationEnvelope,
    ),
  );
}

function audioOriginInputs(
  stage: TimelineEditIrStageV1,
  item: TimelineEditItemV1,
  sourceRoot: IRNode,
  evaluationEnvelope?: TimelineEditAudioEvaluationEnvelopeV1,
) {
  const view = originClockAudioView(item);
  if (!view) fail(`$.tracks.${item.trackId}.sourceView`, "lost its origin-clock audio view.");
  return {
    originKind: stringValue(view.kind === "processed-audio" ? "processed-audio" : "direct-audio"),
    ...(timelineEditAudioPresentationOriginTrackId(item) === item.trackId
      ? {}
      : {
          originTrackId: stringValue(
            timelineEditAudioPresentationOriginTrackId(item),
          ),
        }),
    originAuthorityId: stringValue(audioOriginAuthorityId(stage, item, sourceRoot, evaluationEnvelope)),
    sourceAuthorityId: stringValue(view.authorityId),
    ...(view.kind === "processed-audio"
      ? { graphAuthorityId: stringValue(view.graphAuthorityId) }
      : {}),
    originDuration: timeValue(view.presentationClock.originDuration),
    rate: rateValue(view.rate),
    statePolicy: stringValue("single-authorized-evaluation"),
    ...(evaluationEnvelope
      ? {
          evaluationSource: intervalValue(evaluationEnvelope.source),
          presentationZero: timeValue(evaluationEnvelope.presentationZero),
          fadeAnchorPolicy: stringValue(evaluationEnvelope.fadeAnchorPolicy),
          evaluationPolicy: stringValue(evaluationEnvelope.evaluationPolicy),
        }
      : {}),
  } satisfies Record<string, IRValue>;
}

function audioOriginNode(
  stage: TimelineEditIrStageV1,
  trackNode: IRNode,
  item: TimelineEditItemV1,
  sourceRoot: IRNode,
  evaluationEnvelope?: TimelineEditAudioEvaluationEnvelopeV1,
): IRNode {
  const id = materializedAudioOriginNodeId(
    stage,
    timelineEditAudioPresentationOriginTrackId(item),
    timelineEditAudioPresentationOriginId(item),
    sourceRoot.id,
  );
  const node: IRNode = {
    id,
    op: "cut.edit.timeline_audio_origin",
    domain: "audio",
    ownership: "reference",
    ...(trackNode.sceneId ? { sceneId: trackNode.sceneId } : {}),
    // The evaluation envelope is an authenticated private zero-based buffer,
    // not a timeline placement. Each view owns its exact destination clock.
    interval: structuredClone(sourceRoot.interval),
    inputs: audioOriginInputs(stage, item, sourceRoot, evaluationEnvelope),
    children: [sourceRoot.id],
    properties: {},
    effects: ["pure"],
    contentHash: "",
    provenance: structuredClone(item.provenance),
  };
  node.contentHash = hash({ ...node, contentHash: undefined });
  return node;
}

function audioOriginViewNode(
  stage: TimelineEditIrStageV1,
  trackNode: IRNode,
  item: TimelineEditItemV1,
  index: number,
  sourceRoot: IRNode,
  originNode: IRNode,
  evaluationEnvelope?: TimelineEditAudioEvaluationEnvelopeV1,
): IRNode {
  const view = originClockAudioView(item);
  if (!view) fail(`$.tracks.${item.trackId}.items[${index}].sourceView`, "lost its origin-clock audio view.");
  const id = materializedAudioViewNodeId(stage, item.trackId, item, index);
  const interval = {
    start: rational(
      BigInt(trackNode.interval.start.numerator) * BigInt(item.destination.start.denominator)
        + BigInt(item.destination.start.numerator) * BigInt(trackNode.interval.start.denominator),
      BigInt(trackNode.interval.start.denominator) * BigInt(item.destination.start.denominator),
    ),
    duration: item.destination.duration,
  };
  const inputs: Record<string, IRValue> = {
    origin: { kind: "node-ref", id: originNode.id },
    ...audioOriginInputs(stage, item, sourceRoot, evaluationEnvelope),
    sliceOffset: timeValue(view.presentationClock.sliceOffset),
    source: intervalValue(view.source),
    headHandle: timeValue(view.handles.head),
    tailHandle: timeValue(view.handles.tail),
    ...(item.linkId ? { link: stringValue(item.linkId) } : {}),
  };
  const node: IRNode = {
    id,
    op: "cut.edit.timeline_audio_view",
    domain: "audio",
    ownership: "child",
    ...(trackNode.sceneId ? { sceneId: trackNode.sceneId } : {}),
    interval,
    inputs,
    children: [],
    properties: {},
    effects: ["pure"],
    contentHash: "",
    provenance: structuredClone(item.provenance),
  };
  node.contentHash = hash({ ...node, contentHash: undefined });
  return node;
}

function clonedNode(
  stage: TimelineEditIrStageV1,
  trackNode: IRNode,
  item: TimelineEditItemV1,
  index: number,
  sourceNode: IRNode | undefined,
): IRNode {
  const id = materializedNodeId(stage, item.trackId, item, index);
  const interval = {
    start: {
      numerator: (
        BigInt(trackNode.interval.start.numerator) * BigInt(item.destination.start.denominator)
        + BigInt(item.destination.start.numerator) * BigInt(trackNode.interval.start.denominator)
      ).toString(),
      denominator: (
        BigInt(trackNode.interval.start.denominator) * BigInt(item.destination.start.denominator)
      ).toString(),
    },
    duration: item.destination.duration,
  };
  interval.start = rational(BigInt(interval.start.numerator), BigInt(interval.start.denominator));
  if (item.sourceView.kind === "gap") {
    const node: IRNode = {
      id,
      op: item.domain === "picture" ? "cut.edit.gap" : "cut.edit.audio_gap",
      domain: item.domain === "picture" ? "visual" : "audio",
      ownership: "child",
      ...(trackNode.sceneId ? { sceneId: trackNode.sceneId } : {}),
      interval,
      inputs: item.domain === "picture"
        ? { duration: timeValue(item.destination.duration) }
        : { destination: intervalValue(item.destination) },
      children: [],
      properties: {},
      effects: ["pure"],
      contentHash: "",
      provenance: structuredClone(item.provenance),
    };
    node.contentHash = hash({ ...node, contentHash: undefined });
    return node;
  }
  if (!sourceNode) {
    fail(`$.tracks.${item.trackId}.items[${index}].sourceView`, "lost its exact source node before atomic materialization.");
  }
  if (requiresAudioOriginView(item)) {
    fail(
      `$.tracks.${item.trackId}.items[${index}].sourceView`,
      "origin-clock audio must be materialized through its single-evaluation origin/view boundary.",
    );
  }
  if (sourceNode.children.length || Object.keys(sourceNode.properties).length) {
    fail(
      `$.tracks.${item.trackId}.items[${index}].sourceView`,
      "compiler materialization currently admits only direct property-free media leaves; processed and animated operands remain fail-closed.",
    );
  }
  if (item.sourceView.kind === "nested") {
    const source = sourceNode.inputs.source;
    if (item.domain !== "picture"
      || sourceNode.op !== "cut.visual.precomp"
      || source?.kind !== "timeline-ref"
      || source.id !== item.sourceView.compositionId
      || compareRational(item.sourceView.rate, rational(1)) !== 0
      || item.linkId !== undefined) {
      fail(
        `$.tracks.${item.trackId}.items[${index}].sourceView`,
        "nested picture materialization requires one unlinked static Precomp with the exact authenticated source composition and 1:1 clock.",
      );
    }
    const node: IRNode = {
      ...structuredClone(sourceNode),
      id,
      ownership: "child",
      interval,
      inputs: {
        ...sourceNode.inputs,
        range: intervalValue(item.sourceView.source),
      },
      contentHash: "",
      provenance: structuredClone(item.provenance),
    };
    node.contentHash = hash({ ...node, contentHash: undefined });
    return node;
  }
  if (item.sourceView.kind === "picture") {
    if (sourceNode.op !== "cut.edit.picture_clip") {
      fail(`$.tracks.${item.trackId}.items[${index}].sourceView.nodeId`, "does not identify a direct PictureClip.");
    }
    const inputs = withTerminalLink(
      withHandleInputs(canonicalPictureTimeMapInputs({
          ...sourceNode.inputs,
          range: intervalValue(item.sourceView.source),
          duration: timeValue(item.destination.duration),
        }, item.sourceView.timeMap),
        item.sourceView.handles),
      item.linkId,
    );
    if (sourceNode.inputs.transcriptMediaAuthorityId !== undefined) {
      const origin = sourceNode.inputs.transcriptPictureOriginIdentity;
      if (origin?.kind !== "string"
        || sourceNode.inputs.transcriptBindingId?.kind !== "string"
        || sourceNode.inputs.transcriptPictureSegmentIdentity?.kind !== "string") {
        fail(
          `$.tracks.${item.trackId}.items[${index}].sourceView`,
          "authority-backed TranscriptPicture lost its closed origin/segment lineage before materialization.",
        );
      }
      inputs.transcriptPictureSegmentIdentity = {
        kind: "string",
        value: cutTranscriptPictureSegmentIdentity({
          transcriptPictureOriginIdentity: origin.value,
          sourceRange: item.sourceView.source,
          destinationRange: item.destination,
          timeMap: item.sourceView.timeMap,
        }),
      };
    } else if (sourceNode.inputs.transcriptBindingId !== undefined) {
      fail(
        `$.tracks.${item.trackId}.items[${index}].sourceView`,
        "legacy co-located TranscriptPicture has no segment-lineage authority and cannot be structurally rewritten by TimelineEdit.",
      );
    }
    const node: IRNode = {
      ...structuredClone(sourceNode),
      id,
      ownership: "child",
      interval,
      inputs,
      contentHash: "",
      provenance: structuredClone(item.provenance),
    };
    node.contentHash = hash({ ...node, contentHash: undefined });
    return node;
  }
  if (item.sourceView.kind !== "audio") {
    fail(
      `$.tracks.${item.trackId}.items[${index}].sourceView.kind`,
      "processed-audio execution requires its separately authenticated runtime bridge and cannot silently flatten to a direct clip.",
    );
  }
  if (sourceNode.op !== "cut.audio.clip") {
    fail(`$.tracks.${item.trackId}.items[${index}].sourceView.nodeId`, "does not identify a direct AudioClip.");
  }
  if (compareRational(item.sourceView.rate, rational(1)) !== 0) {
    fail(`$.tracks.${item.trackId}.items[${index}].sourceView.rate`, "direct AudioClip retime is not executable without an explicit quality/pitch policy.");
  }
  if (!zeroTimeInput(sourceNode, "fadeIn") || !zeroTimeInput(sourceNode, "fadeOut")) {
    fail(
      `$.tracks.${item.trackId}.items[${index}].sourceView.presentationClock`,
      "structurally sliced faded audio requires the origin-clock presentation bridge and cannot restart a clip-local fade.",
    );
  }
  const node: IRNode = {
    ...structuredClone(sourceNode),
    id,
    ownership: "child",
    interval,
    inputs: withTerminalLink(
      withHandleInputs({
        ...sourceNode.inputs,
        range: intervalValue(item.sourceView.source),
        destination: intervalValue(item.destination),
      }, item.sourceView.handles),
      item.linkId,
    ),
    contentHash: "",
    provenance: structuredClone(item.provenance),
  };
  node.contentHash = hash({ ...node, contentHash: undefined });
  return node;
}

function sourceNodeId(item: TimelineEditItemV1) {
  if (item.sourceView.kind === "picture" || item.sourceView.kind === "audio" || item.sourceView.kind === "nested") {
    return item.sourceView.nodeId;
  }
  if (item.sourceView.kind === "processed-audio") return item.sourceView.regionId;
  return undefined;
}

function isUnchangedBase(
  item: TimelineEditItemV1,
  base: TimelineEditItemV1 | undefined,
) {
  return base !== undefined
    && item.segmentId === base.segmentId
    && stableJsonStringify(item) === stableJsonStringify(base);
}

function itemEditorialMetadata(item: TimelineEditItemV1) {
  return {
    ...(item.role ? { role: item.role } : {}),
    ...(Object.keys(item.metadata).length ? { metadata: { ...item.metadata } } : {}),
  };
}

function transitionEditorial(
  stage: TimelineEditIrStageV1,
  trackNode: IRNode,
  transition: TimelineEditTransitionV1,
  segmentNodes: ReadonlyMap<string, string>,
) {
  const outgoingNodeId = segmentNodes.get(transition.outgoingSegmentId);
  const incomingNodeId = segmentNodes.get(transition.incomingSegmentId);
  if (!outgoingNodeId || !incomingNodeId) {
    fail(`$.transitions.${transition.operationId}`, "lost one adjacent materialized segment.");
  }
  const absolute = (value: Rational) => rational(
    BigInt(trackNode.interval.start.numerator) * BigInt(value.denominator)
      + BigInt(value.numerator) * BigInt(trackNode.interval.start.denominator),
    BigInt(trackNode.interval.start.denominator) * BigInt(value.denominator),
  );
  const common = {
    cut: absolute(transition.cut),
    duration: transition.duration,
    overlap: {
      start: absolute(transition.overlap.start),
      duration: transition.overlap.duration,
    },
    outgoingNodeId,
    incomingNodeId,
    outgoingSource: transition.outgoingSource,
    incomingSource: transition.incomingSource,
    provenance: structuredClone(
      stage.plan.operations.find((operation) => operation.id === transition.operationId)?.provenance
        ?? trackNode.provenance,
    ),
  };
  return transition.domain === "picture"
    ? { ...common, style: transition.picture! }
    : { ...common, curve: transition.audio!.curve };
}

type SharedAudioOriginMaterialization = Readonly<{
  ownerTrackId: string;
  sourceRoot: IRNode;
  originNode: IRNode;
  evaluationEnvelope?: TimelineEditAudioEvaluationEnvelopeV1;
}>;

function patchTrack(
  ir: CutAVIR,
  stage: TimelineEditIrStageV1,
  binding: TimelineEditIrTrackBindingV1,
  result: TimelineEditTrackV1,
  sharedAudioOrigins: ReadonlyMap<string, SharedAudioOriginMaterialization>,
) {
  const trackNode = ir.nodes[binding.trackNodeId];
  if (!trackNode || trackNode.editorial?.kind !== binding.kind) {
    fail(`$.trackBindings.${binding.trackId}`, "lost its exact owning track.");
  }
  const base = stage.plan.tracks.find((track) => track.trackId === binding.trackId);
  if (!base || base.domain !== result.domain || base.items.length !== trackNode.editorial.items.length) {
    fail(`$.tracks.${binding.trackId}`, "does not correlate to the staged base track.");
  }
  const originalBySegment = new Map(base.items.map((item, index) => [
    item.segmentId,
    trackNode.editorial!.kind === binding.kind
      ? trackNode.editorial!.items[index]?.nodeId
      : undefined,
  ]));
  const baseByOrigin = new Map(stage.plan.tracks.flatMap((track) =>
    track.items
      .filter(requiresAudioOriginView)
      .map((item) => [timelineEditAudioPresentationOriginKey(item), item] as const)));
  const resultByPresentationOrigin = new Map<string, TimelineEditItemV1[]>();
  for (const item of result.items) {
    if (!requiresAudioOriginView(item)) continue;
    const authorityOriginId = timelineEditAudioPresentationOriginKey(item);
    const items = resultByPresentationOrigin.get(authorityOriginId) ?? [];
    items.push(item);
    resultByPresentationOrigin.set(authorityOriginId, items);
  }
  const virtualizedPresentationOrigins = new Set<string>();
  const evaluationEnvelopes = new Map<string, TimelineEditAudioEvaluationEnvelopeV1>();
  const trackTransitions = stage.execution.transitions.filter((transition) =>
    transition.trackId === result.trackId);
  const transitionSegments = new Set(trackTransitions.flatMap((transition) => [
    transition.outgoingSegmentId,
    transition.incomingSegmentId,
  ]));
  for (const [authorityOriginId, items] of resultByPresentationOrigin) {
    const baseItem = baseByOrigin.get(authorityOriginId);
    const shared = sharedAudioOrigins.get(authorityOriginId);
    const unchanged = shared === undefined && baseItem !== undefined
      && items.length === 1
      && items[0]!.segmentId === baseItem.segmentId
      && stableJsonStringify(items[0]) === stableJsonStringify(baseItem)
      && !items.some((item) => transitionSegments.has(item.segmentId));
    if (!unchanged) {
      virtualizedPresentationOrigins.add(authorityOriginId);
      if (shared?.evaluationEnvelope) {
        evaluationEnvelopes.set(
          authorityOriginId,
          shared.evaluationEnvelope,
        );
      } else if (baseItem) {
        const envelope = timelineEditAudioEvaluationEnvelopeV1(baseItem, items, trackTransitions);
        if (envelope) {
          assertProcessedExternalHandleGraph(
            ir,
            baseItem,
            envelope,
            `$.tracks.${binding.trackId}.origins.${authorityOriginId}`,
          );
          evaluationEnvelopes.set(authorityOriginId, envelope);
        }
      }
    }
  }
  const nodes: IRNode[] = [];
  const children: string[] = [];
  const segmentNodes = new Map<string, string>();
  const originNodes = new Map<string, IRNode>();
  const retainedOriginRoots = new Set<string>();
  const items = result.items.map((item, index) => {
    const baseItem = base.items.find((candidate) => candidate.segmentId === item.segmentId);
    const authorityOriginId = timelineEditAudioPresentationOriginKey(item);
    let nodeId: string;
    if (virtualizedPresentationOrigins.has(authorityOriginId)) {
      const shared = sharedAudioOrigins.get(authorityOriginId);
      const sourceId = sourceNodeId(item);
      const source = shared?.sourceRoot
        ?? (sourceId ? ir.nodes[sourceId] : undefined);
      if (!source) {
        fail(`$.tracks.${binding.trackId}.items[${index}].sourceView`, "lost its exact origin audio graph before atomic materialization.");
      }
      let origin = originNodes.get(authorityOriginId) ?? shared?.originNode;
      const evaluationEnvelope = evaluationEnvelopes.get(authorityOriginId);
      if (!origin) {
        origin = audioOriginNode(stage, trackNode, item, source, evaluationEnvelope);
        originNodes.set(authorityOriginId, origin);
        retainedOriginRoots.add(source.id);
        nodes.push(origin);
      } else if (shared && !originNodes.has(authorityOriginId)) {
        originNodes.set(authorityOriginId, origin);
        if (binding.trackId === shared.ownerTrackId) {
          retainedOriginRoots.add(source.id);
          nodes.push(origin);
        }
      }
      const node = audioOriginViewNode(
        stage,
        trackNode,
        item,
        index,
        source,
        origin,
        evaluationEnvelope,
      );
      nodes.push(node);
      nodeId = node.id;
    } else if (isUnchangedBase(item, baseItem)) {
      const original = originalBySegment.get(item.segmentId);
      if (!original || !ir.nodes[original]) {
        fail(`$.tracks.${binding.trackId}.items[${index}]`, "lost one unchanged base node.");
      }
      nodeId = original;
    } else {
      const sourceId = sourceNodeId(item);
      const source = sourceId ? ir.nodes[sourceId] : undefined;
      const node = clonedNode(stage, trackNode, item, index, source);
      nodes.push(node);
      nodeId = node.id;
    }
    children.push(nodeId);
    segmentNodes.set(item.segmentId, nodeId);
    const common = {
      nodeId,
      order: index,
      kind: item.sourceView.kind === "gap"
        ? "gap" as const
        : binding.kind === "picture-track"
          ? "picture" as const
          : "audio" as const,
      destination: {
        start: rational(
          BigInt(trackNode.interval.start.numerator) * BigInt(item.destination.start.denominator)
            + BigInt(item.destination.start.numerator) * BigInt(trackNode.interval.start.denominator),
          BigInt(trackNode.interval.start.denominator) * BigInt(item.destination.start.denominator),
        ),
        duration: item.destination.duration,
      },
      editId: item.originId,
      ...itemEditorialMetadata(item),
    };
    if (item.sourceView.kind === "gap") return common;
    return {
      ...common,
      source: item.sourceView.source,
      ...(item.linkId ? { linkId: item.linkId } : {}),
      ...(item.sourceView.kind === "picture"
        && !(item.sourceView.timeMap.kind === "constant"
          && item.sourceView.timeMap.direction === "forward"
          && compareRational(item.sourceView.timeMap.rate, rational(1)) === 0)
        ? { timeMap: item.sourceView.timeMap }
        : {}),
      ...(item.sourceView.kind === "processed-audio"
        ? { sourceNodeId: item.sourceView.sourceNodeId }
        : virtualizedPresentationOrigins.has(authorityOriginId) && item.sourceView.kind === "audio"
          ? { sourceNodeId: item.sourceView.nodeId }
        : {}),
    };
  });
  const transitions = trackTransitions
    .map((transition) => transitionEditorial(stage, trackNode, transition, segmentNodes));
  const editorial = binding.kind === "picture-track"
    ? {
        kind: "picture-track" as const,
        trackId: result.trackId,
        ...(result.role ? { role: result.role } : {}),
        ...(Object.keys(result.metadata).length ? { metadata: { ...result.metadata } } : {}),
        items: items as Extract<IREditorial, { kind: "picture-track" }>["items"],
        ...(transitions.length
          ? { transitions: transitions as NonNullable<Extract<IREditorial, { kind: "picture-track" }>["transitions"]> }
          : {}),
      }
    : {
        kind: "audio-track" as const,
        trackId: result.trackId,
        ...(result.role ? { role: result.role } : {}),
        ...(Object.keys(result.metadata).length ? { metadata: { ...result.metadata } } : {}),
        items: items as Extract<IREditorial, { kind: "audio-track" }>["items"],
        ...(transitions.length
          ? { transitions: transitions as NonNullable<Extract<IREditorial, { kind: "audio-track" }>["transitions"]> }
          : {}),
      };
  const retained = new Set([...children, ...retainedOriginRoots]);
  const removedRoots = trackNode.children.filter((id) => !retained.has(id));
  const removeNodeIds: string[] = [];
  const collectRemoved = (id: string) => {
    if (retained.has(id) || removeNodeIds.includes(id)) return;
    removeNodeIds.push(id);
    ir.nodes[id]?.children.forEach(collectRemoved);
  };
  removedRoots.forEach(collectRemoved);
  return Object.freeze({
    trackNodeId: trackNode.id,
    removeNodeIds: Object.freeze(removeNodeIds),
    children: Object.freeze(children),
    nodes: Object.freeze(nodes),
    editorial,
  });
}

/**
 * Pure, fail-closed graph staging. No caller-visible IR byte is mutated until
 * every selected track, source authority, grid, transition and node identity
 * has passed. The compiler owns the single commit point.
 */
export function stageTimelineEditIrMaterializationV1(
  ir: CutAVIR,
  composition: IRComposition,
  stage: TimelineEditIrStageV1,
): TimelineEditIrMaterializationV1 {
  const hasNestedPictureOperand = stage.plan.tracks.some((track) =>
    track.items.some((item) => item.sourceView.kind === "nested"));
  if (hasNestedPictureOperand) {
    const nestedBaseItems = stage.plan.tracks.flatMap((track) =>
      track.items
        .filter((item) => item.sourceView.kind === "nested")
        .map((item) => ({ track, item })));
    for (const [operationIndex, operation] of stage.plan.operations.entries()) {
      if (operation.kind !== "insert" && operation.kind !== "overwrite") continue;
      const nestedParts = operation.operand.parts.flatMap((part) =>
        nestedBaseItems.filter(({ item }) =>
          item.domain === part.domain
          && item.originId === part.sourceOriginId));
      if (!nestedParts.length) continue;
      if (operation.operand.parts.length !== 1
        || nestedParts.length !== 1
        || operation.operand.parts[0]?.domain !== "picture"
        || operation.targets.picture?.trackIds.length !== 1
        || operation.targets.audio !== undefined
        || operation.targets.audiovisual !== undefined) {
        throw new TimelineEditError(
          "CUT_TIMELINE_EDIT_UNSUPPORTED",
          "nested Precomp insert/overwrite currently requires exactly one unlinked picture operand and one same-track picture target.",
          `$.operations[${operationIndex}]`,
          operationIndex,
        );
      }
      const source = nestedParts[0]!;
      if (source.item.sourceView.kind !== "nested"
        || source.item.sourceView.placementPolicy !== "static-same-track-copy") {
        throw new TimelineEditError(
          "CUT_TIMELINE_EDIT_UNSUPPORTED",
          "nested Precomp insert/overwrite requires an authenticated static same-track copy policy.",
          `$.operations[${operationIndex}].operand.parts[0].sourceOriginId`,
          operationIndex,
        );
      }
      const sourceNode = ir.nodes[source.item.sourceView.kind === "nested"
        ? source.item.sourceView.nodeId
        : ""];
      if (!sourceNode || !isTimelineEditStaticPrecompOperand(sourceNode)) {
        throw new TimelineEditError(
          "CUT_TIMELINE_EDIT_UNSUPPORTED",
          "nested Precomp insert/overwrite requires one childless, property-static, effect-free 1:1 source instance whose executable inputs are limited to source/range and the static x/y/scale/rotation/opacity presentation contract; dynamic, child-bearing, effectful, or unknown-input instances remain fail-closed.",
          `$.operations[${operationIndex}].operand.parts[0].sourceOriginId`,
          operationIndex,
        );
      }
      if (source.track.trackId !== operation.targets.picture.trackIds[0]) {
        throw new TimelineEditError(
          "CUT_TIMELINE_EDIT_UNSUPPORTED",
          "nested Precomp insert/overwrite must copy one complete initial-plan nested item within its owning PictureTrack.",
          `$.operations[${operationIndex}].operand.parts[0].sourceOriginId`,
          operationIndex,
        );
      }
    }
  }
  const baseByTrack = new Map(stage.plan.tracks.map((track) => [track.trackId, track]));
  const changedOriginClockAudio = stage.execution.tracks.some((track) => {
    const baseTrack = baseByTrack.get(track.trackId);
    if (!baseTrack) return false;
    const resultByOrigin = new Map<string, TimelineEditItemV1[]>();
    for (const item of track.items) {
      if (!requiresAudioOriginView(item)) continue;
      const authorityOriginId = timelineEditAudioPresentationOriginKey(item);
      const entries = resultByOrigin.get(authorityOriginId) ?? [];
      entries.push(item);
      resultByOrigin.set(authorityOriginId, entries);
    }
    const changedBase = baseTrack.items.some((baseItem) => {
      if (!requiresAudioOriginView(baseItem)) return false;
      const resultItems = resultByOrigin.get(
        timelineEditAudioPresentationOriginKey(baseItem),
      ) ?? [];
      return resultItems.length !== 1
        || resultItems[0]!.segmentId !== baseItem.segmentId
        || stableJsonStringify(resultItems[0]) !== stableJsonStringify(baseItem);
    });
    if (changedBase) return true;
    if ([...resultByOrigin.keys()].some((authorityOriginId) =>
      !baseTrack.items.some((item) =>
        requiresAudioOriginView(item)
        && timelineEditAudioPresentationOriginKey(item) === authorityOriginId))) return true;
    const transitionSegments = new Set(stage.execution.transitions
      .filter((transition) => transition.trackId === track.trackId)
      .flatMap((transition) => [
        transition.outgoingSegmentId,
        transition.incomingSegmentId,
      ]));
    return track.items.some((item) =>
      requiresAudioOriginView(item) && transitionSegments.has(item.segmentId));
  });
  if (changedOriginClockAudio) {
    const supported = new Set([
      "split",
      "trim",
      "ripple-delete",
      "lift",
      "extract",
      "transition",
      "insert",
      "overwrite",
      "slip",
      "slide",
      "boundary-adjust",
    ]);
    const unsupported = stage.plan.operations.findIndex((operation) =>
      !supported.has(operation.kind));
    if (unsupported >= 0) {
      throw new TimelineEditError(
        "CUT_TIMELINE_EDIT_UNSUPPORTED",
        "origin-clock audio views currently execute split, trim, ripple-delete, lift, extract, complete-origin same-track or cross-track insert/overwrite, one coupled direct-picture plus complete-origin audio placement, authenticated constant-rate transitions, slip, slide, and boundary-adjust without restarting fades or processor state; faded-direct and static unary processed source handles use authenticated evaluation envelopes, including one innermost constant TimeStretch, while multiple stateful or nested operands and variable retime remain fail-closed.",
        `$.operations[${unsupported}]`,
        unsupported,
      );
    }
    const audioTracks = new Map(stage.execution.tracks
      .filter((track) => track.domain === "audio")
      .map((track) => [track.trackId, track] as const));
    const baseOrigins = new Map(stage.plan.tracks
      .filter((track) => track.domain === "audio")
      .flatMap((track) => track.items
        .filter((item) => item.sourceView.kind === "audio" || item.sourceView.kind === "processed-audio")
        .map((item) => [
          timelineEditAudioPresentationOriginKey(item),
          item,
        ] as const)));
    const sourceEnd = (interval: IREditorialInterval) => rational(
      BigInt(interval.start.numerator) * BigInt(interval.duration.denominator)
        + BigInt(interval.duration.numerator) * BigInt(interval.start.denominator),
      BigInt(interval.start.denominator) * BigInt(interval.duration.denominator),
    );
    for (const track of stage.execution.tracks.filter((candidate) =>
      candidate.domain === "audio")) {
      for (const [itemIndex, item] of track.items.entries()) {
        if (!requiresAudioOriginView(item)) continue;
        const view = originClockAudioView(item)!;
        const authorityOriginId = timelineEditAudioPresentationOriginId(item);
        const base = baseOrigins.get(timelineEditAudioPresentationOriginKey(item));
        if (!base
          || (base.sourceView.kind !== "audio"
            && base.sourceView.kind !== "processed-audio")) {
          fail(
            `$.tracks.${track.trackId}.items[${itemIndex}].sourceView`,
            "lost its authenticated unsliced audio origin.",
          );
        }
        const availableStart = subtractRational(
          base.sourceView.source.start,
          base.sourceView.handles.head,
        );
        const availableEnd = addRational(
          sourceEnd(base.sourceView.source),
          base.sourceView.handles.tail,
        );
        if (compareRational(view.source.start, availableStart) < 0
          || compareRational(sourceEnd(view.source), availableEnd) > 0) {
          throw new TimelineEditError(
            "CUT_TIMELINE_EDIT_HANDLE",
            "source-changing origin-clock audio edit exceeds its authenticated declared media handles.",
            `$.tracks.${track.trackId}.items[${itemIndex}].sourceView.source`,
          );
        }
        const presentationEnd = addRational(
          view.presentationClock.sliceOffset,
          item.destination.duration,
        );
        const availablePresentationStart = divideRational(
          subtractRational(availableStart, base.sourceView.source.start),
          base.sourceView.rate,
        );
        const availablePresentationEnd = addRational(
          base.sourceView.presentationClock.originDuration,
          divideRational(base.sourceView.handles.tail, base.sourceView.rate),
        );
        if (compareRational(
          view.presentationClock.sliceOffset,
          availablePresentationStart,
        ) < 0
          || compareRational(
            presentationEnd,
            availablePresentationEnd,
          ) > 0) {
          throw new TimelineEditError(
            "CUT_TIMELINE_EDIT_HANDLE",
            "origin-clock audio edit exceeds its authenticated handled presentation envelope.",
            `$.tracks.${track.trackId}.items[${itemIndex}].sourceView.presentationClock`,
          );
        }
      }
    }
    for (const transition of stage.execution.transitions.filter((candidate) => candidate.domain === "audio")) {
      const track = audioTracks.get(transition.trackId);
      const outgoing = track?.items.find((item) => item.segmentId === transition.outgoingSegmentId);
      const incoming = track?.items.find((item) => item.segmentId === transition.incomingSegmentId);
      if (!outgoing || !incoming
        || outgoing.sourceView.kind === "gap" || outgoing.sourceView.kind === "picture" || outgoing.sourceView.kind === "nested"
        || incoming.sourceView.kind === "gap" || incoming.sourceView.kind === "picture" || incoming.sourceView.kind === "nested") {
        fail(`$.transitions.${transition.operationId}`, "lost one authenticated constant-rate audio view.");
      }
      for (const [side, item, consumed] of [
        ["outgoing", outgoing, transition.outgoingSource],
        ["incoming", incoming, transition.incomingSource],
      ] as const) {
        const base = baseOrigins.get(
          timelineEditAudioPresentationOriginKey(item),
        );
        if (!base || (base.sourceView.kind !== "audio" && base.sourceView.kind !== "processed-audio")) {
          fail(`$.transitions.${transition.operationId}.${side}Source`, "lost its authenticated unsliced audio origin.");
        }
        if ((compareRational(consumed.start, base.sourceView.source.start) < 0
          || compareRational(sourceEnd(consumed), sourceEnd(base.sourceView.source)) > 0)
          && compareRational(base.sourceView.rate, rational(1)) !== 0
          && base.sourceView.kind !== "processed-audio") {
          throw new TimelineEditError(
            "CUT_TIMELINE_EDIT_UNSUPPORTED",
            "retimed direct-audio transitions cannot consume external media handles; use one authenticated processed AudioRegion with an innermost constant TimeStretch.",
            `$.transitions.${transition.operationId}.${side}Source`,
          );
        }
      }
    }
  }
  const transcriptSources = stage.plan.tracks.flatMap((track) =>
    track.items.flatMap((item) => {
      if (item.sourceView.kind !== "picture" && item.sourceView.kind !== "audio") return [];
      const node = ir.nodes[item.sourceView.nodeId];
      return node?.inputs.transcriptBindingId === undefined ? [] : [node];
    }));
  if (transcriptSources.length) {
    for (const [operationIndex, operation] of stage.plan.operations.entries()) {
      if (operation.kind !== "split"
        && operation.kind !== "trim"
        && operation.kind !== "ripple-delete") {
        throw new TimelineEditError(
          "CUT_TIMELINE_EDIT_UNSUPPORTED",
          "transcript-selected picture/audio currently admit canonical linked split, trim, and ripple-delete; slip, slide, boundary, transition, insertion, overwrite, and source-changing edits require separately authenticated transcript-origin or media-handle semantics.",
          `$.operations[${operationIndex}]`,
          operationIndex,
        );
      }
    }
    for (const node of transcriptSources) {
      if (node.op === "cut.edit.picture_clip"
        && node.inputs.transcriptMediaAuthorityId === undefined) {
        throw new TimelineEditError(
          "CUT_TIMELINE_EDIT_UNSUPPORTED",
          "legacy co-located TranscriptPicture cannot enter canonical TimelineEdit because it has no independently authenticated segment-lineage authority.",
          "$.tracks",
        );
      }
    }
  }
  for (const track of stage.execution.tracks) {
    assertTrackGrid(
      track,
      stage.execution.transitions.filter((transition) => transition.trackId === track.trackId),
      composition,
    );
  }
  const executionAudioItemsByOrigin = new Map<string, TimelineEditItemV1[]>();
  const crossTrackAudioOrigins = new Set<string>();
  for (const track of stage.execution.tracks) {
    for (const item of track.items) {
      if (!requiresAudioOriginView(item)) continue;
      const key = timelineEditAudioPresentationOriginKey(item);
      const entries = executionAudioItemsByOrigin.get(key) ?? [];
      entries.push(item);
      executionAudioItemsByOrigin.set(key, entries);
      if (timelineEditAudioPresentationOriginTrackId(item) !== item.trackId) {
        crossTrackAudioOrigins.add(key);
      }
    }
  }
  const baseAudioOrigins = new Map(stage.plan.tracks.flatMap((track) =>
    track.items
      .filter(requiresAudioOriginView)
      .map((item) => [timelineEditAudioPresentationOriginKey(item), item] as const)));
  const bindingByTrack = new Map(stage.trackBindings.map((binding) =>
    [binding.trackId, binding] as const));
  const sharedAudioOrigins = new Map<string, SharedAudioOriginMaterialization>();
  for (const key of crossTrackAudioOrigins) {
    const baseItem = baseAudioOrigins.get(key);
    const items = executionAudioItemsByOrigin.get(key) ?? [];
    if (!baseItem || !items.length) {
      fail("$.tracks", `cross-track audio origin ${JSON.stringify(key)} lost its canonical base or views.`);
    }
    const ownerTrackId = timelineEditAudioPresentationOriginTrackId(baseItem);
    const ownerBinding = bindingByTrack.get(ownerTrackId);
    const ownerTrackNode = ownerBinding ? ir.nodes[ownerBinding.trackNodeId] : undefined;
    const sourceId = sourceNodeId(baseItem);
    const sourceRoot = sourceId ? ir.nodes[sourceId] : undefined;
    if (!ownerTrackNode || !sourceRoot) {
      fail(
        `$.tracks.${ownerTrackId}`,
        "cross-track audio origin lost its exact owner track or source graph.",
      );
    }
    const participatingSegments = new Set(items.map((item) => item.segmentId));
    const transitions = stage.execution.transitions.filter((transition) =>
      transition.domain === "audio"
      && (participatingSegments.has(transition.outgoingSegmentId)
        || participatingSegments.has(transition.incomingSegmentId)));
    const evaluationEnvelope = timelineEditAudioEvaluationEnvelopeV1(
      baseItem,
      items,
      transitions,
    );
    if (evaluationEnvelope) {
      assertProcessedExternalHandleGraph(
        ir,
        baseItem,
        evaluationEnvelope,
        `$.tracks.${ownerTrackId}.origins.${timelineEditAudioPresentationOriginId(baseItem)}`,
      );
    }
    sharedAudioOrigins.set(key, Object.freeze({
      ownerTrackId,
      sourceRoot,
      originNode: audioOriginNode(
        stage,
        ownerTrackNode,
        baseItem,
        sourceRoot,
        evaluationEnvelope,
      ),
      ...(evaluationEnvelope ? { evaluationEnvelope } : {}),
    }));
  }
  const patches = stage.trackBindings.map((binding) => {
    const result = stage.execution.tracks.find((track) => track.trackId === binding.trackId);
    if (!result) fail(`$.trackBindings.${binding.trackId}`, "has no final execution track.");
    return patchTrack(ir, stage, binding, result, sharedAudioOrigins);
  });
  const removed = new Set(patches.flatMap((patch) => patch.removeNodeIds));
  const added = patches.flatMap((patch) => patch.nodes);
  if (new Set(added.map((node) => node.id)).size !== added.length) {
    throw new TimelineEditError("CUT_TIMELINE_EDIT_RESULT", "materialized node identities are not unique.", "$.materialization");
  }
  for (const node of added) {
    if (ir.nodes[node.id] && !removed.has(node.id)) {
      throw new TimelineEditError("CUT_TIMELINE_EDIT_RESULT", `materialized node identity ${node.id} collides with the live graph.`, "$.materialization");
    }
  }
  return Object.freeze({
    version: 1,
    planId: stage.plan.id,
    materializationId: stage.execution.materializationId,
    patches: Object.freeze(patches),
    addedNodeCount: added.length,
    removedNodeCount: removed.size,
    identity: hash({
      format: "cut-timeline-edit-ir-materialization-stage",
      version: 1,
      plan: stage.plan,
      execution: stage.execution,
      patches,
    }),
  });
}
