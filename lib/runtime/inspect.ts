import type { CutAVIR, IRNode, IRProvenance, IRValue } from "../language/ir";
import { evaluateCutDomainAssertion } from "../language/domain-assertions";
import { hash } from "../core/stable";
import { assertCutGraphExecutionBudget, compositionNodeRoots } from "./graph";
import { referenceTrack2DConfig } from "./reference/tracking-2d";
import { referencePlanarTrackConfig } from "./reference/planar-tracking";
import { referencePlanarTrackMatteConfig } from "./reference/planar-track-matte";
import { prepareReferenceTraceNode, referenceCubicTraceFlattening, referenceLocalTraceAlgorithmVersion } from "./reference/trace";
import {
  prepareReferenceAnchoredMotionPathNode,
  prepareReferenceMotionPathNode,
  referenceMotionPathInspect,
} from "./reference/motion-path";
import {
  observedLockedVideoColor,
  referenceBt470bgSmpte170mInputContract,
  referenceVideoColorInterpretationContract,
  referenceVideoColorProfileContractId,
  referenceVideoInputColorDeclaration,
  type ReferenceObservedVideoColor,
  type ReferenceVideoColorInterpretationProfile,
} from "./reference/color-management";
import type { LockedResourceProbe, LockedResourceVariant } from "../language/lock";
import { referenceMediaProfileResourceState } from "./reference/media-profile-state";
import {
  prepareReferenceAnchoredVectorPathNode,
  prepareReferenceVectorPathNode,
  referenceVectorPathInspect,
  validateReferenceAnchoredVectorPathStructuralWork,
  type ReferenceAnchoredVectorPathStructuralWork,
} from "./reference/vector-path";
import {
  decodeReferenceAnchoredPathGeometry,
  isReferenceAnchoredPathGeometryValue,
  referenceAnchoredPathInspect,
  validateReferenceAnchoredPathGeometry,
  type ReferenceAnchoredPathOwnerBinding,
} from "./reference/anchored-path";
import { referenceFlowTextConfig, referenceFlowTextInspect } from "./reference/text-flow";
import { referenceParallaxCameraInspect, validateReferenceParallaxCameraGraph } from "./reference/parallax-camera";
import {
  referenceMapCameraGeoAnnotationInspect,
  referenceMapCameraInspectPlan,
  validateReferenceMapCameraGeoAnnotations,
  validateReferenceMapCameraGraph,
} from "./reference/map-camera";
import { referenceGeoAnnotationInspect, validateReferenceGeoAnnotationGraph } from "./reference/geo-annotation";
import {
  referenceCalloutInspect,
  validateReferenceCalloutGraph,
} from "./reference/callout";
import {
  createReferenceLocalSpaceStructuralValidationIndex,
  referenceLocalSpaceDescendantContexts,
  referenceLocalSpaceInspect,
  referenceLocalMotionPathAlgorithmVersion,
  referenceLocalSpaceRasterOrigin,
  referenceLocalSpaceTextLayoutContext,
  validateReferenceLocalSpaceGraph,
  type ReferenceLocalSpaceConfig,
} from "./reference/local-space";
import { referenceCamera2DLocalSpaceInspect } from "./reference/camera2d-local-space";
import {
  referenceComponentFragmentLocalSpaceInspect,
} from "./reference/component-fragment-local-space";
import { referenceCamera3DInspect, validateReferenceCamera3DGraph } from "./reference/camera3d";
import {
  referenceMediaCamera2DAnchorPlanFromFramePlan,
  referenceMediaCamera2DFramePlanAt,
  validateReferenceMediaCamera2DGraph,
  type ReferenceMediaCamera2DPlan,
} from "./reference/media-camera2d";
import { referenceSemanticMatchInspect } from "./reference/semantic-match";
import {
  referenceResponsiveStackDescendantContexts,
  referenceResponsiveStackInspect,
  referenceResponsiveStackMediaPlacementAlgorithm,
  referenceResponsiveStackTextLayoutContext,
  validateReferenceResponsiveStackGraph,
  type ReferenceResponsiveStackLocalContext,
} from "./reference/responsive-layout";
import {
  referenceIdentityComponentFragmentInspect,
  validateReferenceIdentityComponentFragments,
} from "./reference/identity-component-fragment";
import { referenceMotionBlurConfig } from "./reference/motion-blur";
import {
  prepareReferenceMotionBlurBoundary,
  referenceMotionBlurBoundaryInspect,
} from "./reference/motion-blur-boundary";
import { compareRational, divideRational, rational, subtractRational, zeroRational, type Rational } from "../language/rational";
import { referenceReachableCompositionNodes } from "./reference/validate";
import {
  referenceRetainedPathBackendIdentity,
  referenceRetainedPathChainAlgorithmVersion,
  referenceRetainedPathChainExecutionAt,
  referenceRetainedPathChainInspection,
  referenceRetainedPathChainInspectionTime,
  referenceRetainedPathChainsFromRoots,
} from "./reference/retained-path-chain";
import {
  referenceTempoDelayConfig,
  referenceTempoDelayInspect,
} from "./reference/audio-tempo-delay-config";
import { referenceLinkedClipAudioExecutionPlan } from "./reference/linked-av-presentation";
import {
  CutDiagramContractError,
  cutDiagramOps,
  decodeCutDiagramLayout,
} from "../language/diagram-contract";
import {
  planReferenceDiagramLayout,
  referenceDiagramTransitionSamplesAtOutputFrames,
} from "./reference/diagram-layout";
import { propertyAt, ReferencePreparedSignalResolver } from "./reference/signals";
import {
  executeTimelineEditPlan,
  type TimelineEditAVTime,
  type TimelineEditOperationV1,
  type TimelineEditPlanV1,
} from "../language/timeline-edit-operations";
import {
  timelineEditExecutableIdentity,
  timelineEditPlanSemanticIdentity,
} from "../language/timeline-edit-identity";
import {
  cutTimelineAudioOriginOp,
  cutTimelineAudioViewOp,
} from "../language/timeline-edit-audio-origin-contract";

function countBy<T>(items: readonly T[], key: (item: T) => string) {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
}

function valueNodeReferences(value: IRValue, result: Set<string>) {
  if (value.kind === "node-ref") result.add(value.id);
  else if (value.kind === "array") value.items.forEach((item) => valueNodeReferences(item, result));
  else if (value.kind === "object") Object.values(value.entries).forEach((item) => valueNodeReferences(item, result));
  else if (value.kind === "range") {
    valueNodeReferences(value.start, result);
    valueNodeReferences(value.end, result);
  } else if (value.kind === "unary") valueNodeReferences(value.value, result);
  else if (value.kind === "binary") {
    valueNodeReferences(value.left, result);
    valueNodeReferences(value.right, result);
  } else if (value.kind === "member") valueNodeReferences(value.object, result);
  else if (value.kind === "index") {
    valueNodeReferences(value.object, result);
    valueNodeReferences(value.index, result);
  } else if (value.kind === "call") {
    value.positional.forEach((item) => valueNodeReferences(item, result));
    Object.values(value.named).forEach((item) => valueNodeReferences(item, result));
  }
}

function nodeReferences(node: IRNode) {
  const references = new Set<string>();
  Object.values(node.inputs).forEach((value) => valueNodeReferences(value, references));
  for (const value of Object.values(node.properties)) if (!("signal" in value)) valueNodeReferences(value, references);
  return [...references].sort();
}

/** Inspect only authored control identity. Owner-dependent values are sampled
 * by the renderer's exact preflight, never guessed by `cut inspect`. */
function authoredNodeControl(ir: CutAVIR, node: IRNode, name: string) {
  const property = node.properties[name];
  if (property) {
    if ("signal" in property) {
      return Object.freeze({
        kind: "signal" as const,
        signalId: property.signal,
        contentHash: ir.signals[property.signal]?.contentHash ?? null,
      });
    }
    return Object.freeze({ kind: "constant-property" as const, value: property });
  }
  const input = node.inputs[name];
  return input === undefined
    ? Object.freeze({ kind: "runtime-default" as const })
    : Object.freeze({ kind: "static-input" as const, value: input });
}

function anchoredPreRenderInspection() {
  return Object.freeze({
    status: "validated-requires-exact-owner-placement" as const,
    requiresExactOwnerPlacement: true as const,
    coordinateEvidence: "not-sampled-by-cut-inspect" as const,
    ownerAwarePreflight: "required-before-dependent-pixel-allocation" as const,
    track2DPolicy: Object.freeze({
      hold: "resolves-held-placement" as const,
      hide: "suppresses-dependent-geometry" as const,
      fail: "aborts-render" as const,
    }),
  });
}

type CutAnchoredPathInspectionBase = Readonly<{
  compositionId: string;
  geometry: ReturnType<typeof referenceAnchoredPathInspect>;
  ownerBindings: readonly ReferenceAnchoredPathOwnerBinding[];
  validationIdentity: string;
  requiresExactOwnerPlacement: true;
  preRender: ReturnType<typeof anchoredPreRenderInspection>;
}>;

type CutAnchoredPathInspection = CutAnchoredPathInspectionBase & Readonly<{
  consumer: "Path";
  plan: Readonly<{ geometryKind: "anchored-v1"; authoredSegments: number; closed: boolean; frameDynamic: true }>;
  paint: Readonly<{
    stroke?: string;
    strokeWidth?: number;
    fill?: string;
    fillRule?: string;
    dash?: readonly number[];
    lineCap: string;
    lineJoin: string;
  }>;
  controls: Readonly<{
    animatedProperties: readonly string[];
    trimRangeDynamic: boolean;
    trimStart: ReturnType<typeof authoredNodeControl>;
    trimEnd: ReturnType<typeof authoredNodeControl>;
    dashOffset: ReturnType<typeof authoredNodeControl>;
  }>;
  structuralWork: ReferenceAnchoredVectorPathStructuralWork;
}>;

type CutAnchoredMotionPathInspection = CutAnchoredPathInspectionBase & Readonly<{
  consumer: "MotionPath";
  plan: Readonly<{ pathForm: "anchored-geometry"; authoredSegments: number; closed: boolean; flatteningVersion: number }>;
  paint: Readonly<{ kind: "subject-placement-no-self-paint" }>;
  controls: Readonly<{
    progress: ReturnType<typeof authoredNodeControl>;
    orientToPath: ReturnType<typeof authoredNodeControl>;
  }>;
  structuralWork: Readonly<{
    status: "owner-aware-frame-work-deferred-to-pre-render";
    authoredSegments: number;
    spatialPointCount: number;
    ownerCount: number;
  }>;
}>;

type CutAnchoredConsumerInspection = CutAnchoredPathInspection | CutAnchoredMotionPathInspection;

function sourceOf(node: IRNode) {
  return {
    module: node.provenance.module,
    line: node.provenance.span.start.line,
    column: node.provenance.span.start.column,
  };
}

function interpretedDifferences(observed: ReferenceObservedVideoColor, profile: ReferenceVideoColorInterpretationProfile) {
  const target = referenceVideoColorInterpretationContract.profiles[profile].tuple;
  const fields = ["range", "matrix", "transfer", "primaries"] as const;
  return fields.flatMap((field) => observed[field] === target[field]
    ? []
    : [{ field, observed: observed[field] ?? null, interpretedAs: target[field] }]);
}

function selectedVideoObservation(probe: LockedResourceProbe | undefined, variant: "master" | "proxy") {
  if (probe?.kind !== "media" || !probe.selected.video) return undefined;
  const selection = probe.selected.video;
  const stream = probe.identity.streams.find((candidate) => candidate.type === "video" && candidate.index === selection.streamIndex);
  if (!stream) return undefined;
  const observed = observedLockedVideoColor({
    pixelFormat: stream.pixelFormat,
    fieldOrder: stream.fieldOrder,
    colorRange: stream.colorRange,
    colorSpace: stream.colorSpace,
    colorTransfer: stream.colorTransfer,
    colorPrimaries: stream.colorPrimaries,
  });
  return {
    variant,
    streamIndex: selection.streamIndex,
    observation: observed,
  };
}

function lockedResourceVideoObservations(ir: CutAVIR, resource: CutAVIR["resources"][string]) {
  const metadata = resource.metadata as { probe?: LockedResourceProbe; proxy?: LockedResourceVariant } | undefined;
  const selectedState = referenceMediaProfileResourceState(ir, resource.id);
  if (selectedState) {
    const selected = selectedVideoObservation(metadata?.probe, selectedState.selected);
    return selected ? { [selectedState.selected]: selected } : undefined;
  }
  const master = selectedVideoObservation(metadata?.probe, "master");
  const proxy = selectedVideoObservation(metadata?.proxy?.probe, "proxy");
  return master ? { master, ...(proxy ? { proxy } : {}) } : undefined;
}

function selectedMediaAuthority(probe: LockedResourceProbe | undefined, variant: "master" | "proxy") {
  if (probe?.kind !== "media") return undefined;
  const project = (kind: "video" | "audio") => {
    const selection = probe.selected[kind];
    if (!selection) return undefined;
    const stream = probe.identity.streams.find((candidate) => candidate.index === selection.streamIndex && candidate.type === kind);
    if (!stream) return undefined;
    return {
      streamIndex: selection.streamIndex,
      duration: selection.duration,
      durationSource: selection.durationSource,
      timeBase: selection.timeBase,
      ...(stream.start ? { start: stream.start } : {}),
      ...(kind === "video" && (probe.selected.video?.frameRate ?? stream.frameRate) ? { frameRate: probe.selected.video?.frameRate ?? stream.frameRate } : {}),
      ...(kind === "audio" && stream.sampleRate ? { sampleRate: stream.sampleRate } : {}),
      ...(kind === "video" && probe.selected.video?.decodedVideoCadence ? { decodedVideoCadence: probe.selected.video.decodedVideoCadence } : {}),
      ...(kind === "audio" && probe.selected.audio?.decodedAudioSamples ? { decodedAudioSamples: probe.selected.audio.decodedAudioSamples } : {}),
    };
  };
  const video = project("video"), audio = project("audio");
  return video || audio ? { variant, ...(video ? { video } : {}), ...(audio ? { audio } : {}) } : undefined;
}

function lockedResourceMediaAuthorities(ir: CutAVIR, resource: CutAVIR["resources"][string]) {
  const metadata = resource.metadata as {
    probe?: LockedResourceProbe;
    proxy?: LockedResourceVariant;
    audioProxyAlignment?: unknown;
    videoProxyAlignment?: unknown;
  } | undefined;
  const selectedState = referenceMediaProfileResourceState(ir, resource.id);
  if (selectedState) {
    const selected = selectedMediaAuthority(metadata?.probe, selectedState.selected);
    return selected ? { [selectedState.selected]: {
      ...selected,
      ...(selectedState.selected === "proxy" && metadata?.audioProxyAlignment ? { audioProxyAlignment: metadata.audioProxyAlignment } : {}),
      ...(selectedState.selected === "proxy" && metadata?.videoProxyAlignment ? { videoProxyAlignment: metadata.videoProxyAlignment } : {}),
    } } : undefined;
  }
  const master = selectedMediaAuthority(metadata?.probe, "master"), proxy = selectedMediaAuthority(metadata?.proxy?.probe, "proxy");
  return master ? {
    master,
    ...(proxy ? {
      proxy: {
        ...proxy,
        ...(metadata?.proxy?.audioAlignment ? { audioProxyAlignment: metadata.proxy.audioAlignment } : {}),
        ...(metadata?.proxy?.videoAlignment ? { videoProxyAlignment: metadata.proxy.videoAlignment } : {}),
      },
    } : {}),
  } : undefined;
}

function compositionOfNode(ir: CutAVIR, node: IRNode) {
  if (node.sceneId) {
    const sceneOwner = ir.compositions.find((composition) => composition.sceneIds.includes(node.sceneId!));
    if (sceneOwner) return sceneOwner;
  }
  return ir.compositions.find((composition) => composition.rootVisualIds.includes(node.id)
    || composition.rootAudioIds.includes(node.id)
    || composition.rootAVIds.includes(node.id)
    || composition.items.some((item) => item.kind === "node" && item.id === node.id));
}

function audioRegionRetime(ir: CutAVIR, region: IRNode) {
  if (region.op !== "cut.edit.audio_region" || region.children.length !== 1) return undefined;
  const visited = new Set<string>();
  let current = ir.nodes[region.children[0]];
  for (let depth = 0; current && depth <= 32 && !visited.has(current.id); depth += 1) {
    visited.add(current.id);
    if (current.op === "cut.audio.time_stretch") {
      return {
        nodeId: current.id,
        sourceDuration: current.inputs.sourceDuration,
        duration: current.inputs.duration,
        pitch: current.inputs.pitch,
        quality: current.inputs.quality,
      };
    }
    if (current.children.length !== 1) return undefined;
    current = ir.nodes[current.children[0]];
  }
  return undefined;
}

function annotationSource(provenance: IRProvenance) {
  return {
    module: provenance.module,
    line: provenance.span.start.line,
    column: provenance.span.start.column,
  };
}

function timelineEditClockSemantics(value: TimelineEditAVTime) {
  if (value.picture === undefined || value.audio === undefined) return undefined;
  const ordering = compareRational(value.audio, value.picture);
  return Object.freeze({
    picture: Object.freeze({ ...value.picture }),
    audio: Object.freeze({ ...value.audio }),
    relationship: ordering < 0
      ? "j-cut" as const
      : ordering > 0
        ? "l-cut" as const
        : "aligned" as const,
  });
}

function timelineEditOperationClockSemantics(operation: TimelineEditOperationV1) {
  const at = "at" in operation ? timelineEditClockSemantics(operation.at) : undefined;
  const by = "by" in operation ? timelineEditClockSemantics(operation.by) : undefined;
  const duration = "duration" in operation ? timelineEditClockSemantics(operation.duration) : undefined;
  return at || by || duration
    ? Object.freeze({
        operationId: operation.id,
        kind: operation.kind,
        ...(at ? { at } : {}),
        ...(by ? { by } : {}),
        ...(duration ? { duration } : {}),
      })
    : undefined;
}

function timelineAudioMaterializationInput<K extends IRValue["kind"]>(
  node: IRNode,
  name: string,
  expected: K,
): Extract<IRValue, { kind: K }> {
  const value = node.inputs[name];
  if (!value || value.kind !== expected) {
    throw new Error(
      `CUT inspect expected ${node.op} ${node.id}.${name} to be ${expected}.`,
    );
  }
  return value as Extract<IRValue, { kind: K }>;
}

/**
 * Closed inspection for compiler-internal TimelineEdit audio materialization.
 * The origin owner authenticates one immutable source/processor evaluation;
 * each view retains the exact source/origin clocks without flattening or
 * restarting that graph. Source spans remain separate evidence and are never
 * included in this semantic projection.
 */
function timelineAudioMaterializationInspection(node: IRNode) {
  if (node.op !== cutTimelineAudioOriginOp
    && node.op !== cutTimelineAudioViewOp) return undefined;
  const originKind = timelineAudioMaterializationInput(node, "originKind", "string");
  const originAuthorityId =
    timelineAudioMaterializationInput(node, "originAuthorityId", "string");
  const sourceAuthorityId =
    timelineAudioMaterializationInput(node, "sourceAuthorityId", "string");
  const originDuration =
    timelineAudioMaterializationInput(node, "originDuration", "quantity");
  const rate =
    timelineAudioMaterializationInput(node, "rate", "quantity");
  const statePolicy =
    timelineAudioMaterializationInput(node, "statePolicy", "string");
  const graphAuthority = node.inputs.graphAuthorityId;
  if (graphAuthority && graphAuthority.kind !== "string") {
    throw new Error(
      `CUT inspect expected ${node.op} ${node.id}.graphAuthorityId to be string.`,
    );
  }
  const evaluationSource = node.inputs.evaluationSource;
  const presentationZero = node.inputs.presentationZero;
  const fadeAnchorPolicy = node.inputs.fadeAnchorPolicy;
  const evaluationPolicy = node.inputs.evaluationPolicy;
  const envelopeFields = [evaluationSource, presentationZero, fadeAnchorPolicy, evaluationPolicy]
    .filter((value) => value !== undefined).length;
  if (envelopeFields !== 0 && (envelopeFields !== 4
    || evaluationSource?.kind !== "range"
    || evaluationSource.exclusive !== true
    || evaluationSource.start.kind !== "quantity"
    || evaluationSource.start.dimension !== "time"
    || evaluationSource.end.kind !== "quantity"
    || evaluationSource.end.dimension !== "time"
    || presentationZero?.kind !== "quantity"
    || presentationZero.dimension !== "time"
    || fadeAnchorPolicy?.kind !== "string"
    || fadeAnchorPolicy.value !== "origin-relative-at-presentation-zero"
    || evaluationPolicy?.kind !== "string"
    || (evaluationPolicy.value !== "selected-source-union-v1"
      && evaluationPolicy.value !== "full-declared-handle-domain-v1"))) {
    throw new Error(
      `CUT inspect expected ${node.op} ${node.id} to carry one closed audio evaluation envelope.`,
    );
  }
  const evaluationRange = envelopeFields === 4
    ? evaluationSource as Extract<IRValue, { kind: "range" }>
    : undefined;
  const evaluationStart = evaluationRange?.start.kind === "quantity"
    ? evaluationRange.start.magnitude
    : undefined;
  const evaluationEnd = evaluationRange?.end.kind === "quantity"
    ? evaluationRange.end.magnitude
    : undefined;
  if (envelopeFields === 4 && (!evaluationStart || !evaluationEnd)) {
    throw new Error(
      `CUT inspect expected ${node.op} ${node.id}.evaluationSource to use exact Time endpoints.`,
    );
  }
  const shared = {
    originKind: originKind.value,
    originAuthorityId: originAuthorityId.value,
    sourceAuthorityId: sourceAuthorityId.value,
    ...(graphAuthority ? { graphAuthorityId: graphAuthority.value } : {}),
    originDuration: { ...originDuration.magnitude },
    rate: { ...rate.magnitude },
    statePolicy: statePolicy.value,
    ...(envelopeFields === 4
      ? {
          evaluationEnvelope: {
            source: {
              start: { ...evaluationStart! },
              duration: subtractRational(
                evaluationEnd!,
                evaluationStart!,
              ),
            },
            presentationZero: {
              ...(presentationZero as Extract<IRValue, { kind: "quantity" }>).magnitude,
            },
            fadeAnchorPolicy: (fadeAnchorPolicy as Extract<IRValue, { kind: "string" }>).value,
            evaluationPolicy: (evaluationPolicy as Extract<IRValue, { kind: "string" }>).value,
          },
        }
      : {}),
  };
  if (node.op === cutTimelineAudioOriginOp) {
    return Object.freeze({
      kind: "origin" as const,
      originNodeId: node.id,
      childNodeId: node.children[0]!,
      ...shared,
    });
  }
  const origin = timelineAudioMaterializationInput(node, "origin", "node-ref");
  const sliceOffset =
    timelineAudioMaterializationInput(node, "sliceOffset", "quantity");
  const headHandle =
    timelineAudioMaterializationInput(node, "headHandle", "quantity");
  const tailHandle =
    timelineAudioMaterializationInput(node, "tailHandle", "quantity");
  const source = timelineAudioMaterializationInput(node, "source", "range");
  if (source.start.kind !== "quantity" || source.end.kind !== "quantity") {
    throw new Error(
      `CUT inspect expected ${node.op} ${node.id}.source to contain time quantities.`,
    );
  }
  const link = node.inputs.link;
  if (link && link.kind !== "string") {
    throw new Error(`CUT inspect expected ${node.op} ${node.id}.link to be string.`);
  }
  return Object.freeze({
    kind: "view" as const,
    segmentNodeId: node.id,
    originNodeId: origin.id,
    ...shared,
    sliceOffset: { ...sliceOffset.magnitude },
    handles: Object.freeze({
      head: { ...headHandle.magnitude },
      tail: { ...tailHandle.magnitude },
    }),
    source: Object.freeze({
      start: { ...source.start.magnitude },
      end: { ...source.end.magnitude },
    }),
    destination: Object.freeze({
      start: { ...node.interval.start },
      duration: { ...node.interval.duration },
    }),
    ...(link ? { link: link.value } : {}),
  });
}

function timelineEditInspection(plan: TimelineEditPlanV1) {
  const execution = executeTimelineEditPlan(plan);
  const executableIdentity = timelineEditExecutableIdentity(plan);
  const semantic = timelineEditPlanSemanticIdentity(plan);
  const transitionGroups = new Map<string, typeof execution.transitions>();
  for (const transition of execution.transitions) {
    transitionGroups.set(
      transition.operationId,
      Object.freeze([...(transitionGroups.get(transition.operationId) ?? []), transition]),
    );
  }
  const linkedBoundaries = [...transitionGroups.entries()].flatMap(([operationId, transitions]) => {
    const picture = transitions.find((transition) => transition.domain === "picture");
    const audio = transitions.find((transition) => transition.domain === "audio");
    if (!picture || !audio) return [];
    const ordering = compareRational(audio.cut, picture.cut);
    return [Object.freeze({
      operationId,
      pictureCut: Object.freeze({ ...picture.cut }),
      audioCut: Object.freeze({ ...audio.cut }),
      relationship: ordering < 0
        ? "j-cut" as const
        : ordering > 0
          ? "l-cut" as const
          : "aligned" as const,
    })];
  });
  return Object.freeze({
    version: plan.version,
    id: plan.id,
    compositionId: plan.compositionId,
    sceneId: plan.sceneId,
    initialDuration: Object.freeze({ ...plan.initialDuration }),
    finalDuration: Object.freeze({ ...plan.finalDuration }),
    tracks: semantic.tracks,
    operations: semantic.operations,
    operationClocks: Object.freeze(plan.operations.flatMap((operation) => {
      const clocks = timelineEditOperationClockSemantics(operation);
      return clocks ? [clocks] : [];
    })),
    execution: Object.freeze({
      tracks: execution.tracks,
      transitions: execution.transitions,
      linkedBoundaries: Object.freeze(linkedBoundaries),
      materializationId: execution.materializationId,
      semanticMaterializationId: executableIdentity.semanticMaterializationId,
    }),
    identities: Object.freeze({
      plan: hash(semantic),
      executable: executableIdentity.semanticMaterializationId,
    }),
    source: annotationSource(plan.provenance),
  });
}

function audioTrackEditorial(node: IRNode) {
  if (node.editorial?.kind !== "audio-track") return undefined;
  const processedPlan = node.editorial.operationPlan?.version === 2 ? node.editorial.operationPlan : undefined;
  return {
    kind: "audio-track" as const,
    ...(node.editorial.trackId ? { trackId: node.editorial.trackId } : {}),
    ...(node.editorial.role ? { role: node.editorial.role } : {}),
    ...(node.editorial.metadata ? { metadata: { ...node.editorial.metadata } } : {}),
    items: node.editorial.items.map((item) => ({
      nodeId: item.nodeId,
      ...(item.sourceNodeId ? { sourceNodeId: item.sourceNodeId } : {}),
      order: item.order,
      kind: item.kind,
      destination: {
        start: { ...item.destination.start },
        duration: { ...item.destination.duration },
      },
      ...(item.source ? {
        source: {
          start: { ...item.source.start },
          duration: { ...item.source.duration },
        },
      } : {}),
      ...(item.linkId ? { linkId: item.linkId } : {}),
      ...(item.linkSegmentId ? { linkSegmentId: item.linkSegmentId } : {}),
      ...(item.editId ? { editId: item.editId } : {}),
      ...(item.role ? { role: item.role } : {}),
      ...(item.metadata ? { metadata: { ...item.metadata } } : {}),
    })),
    ...(processedPlan ? {
      processedCrossfadePlan: {
        version: 2 as const,
        sourceDuration: processedPlan.sourceDuration,
        participants: processedPlan.baseItems.map((item) => ({
          regionId: item.regionId,
          sourceNodeId: item.sourceNodeId,
          processorNodeIds: [...item.processorNodeIds],
          source: item.source,
          destination: item.destination,
          resourceId: item.inputs.resourceId,
          ...(item.inputs.linkId ? { linkId: item.inputs.linkId } : {}),
          headHandle: item.inputs.headHandle ?? { numerator: "0", denominator: "1" },
          tailHandle: item.inputs.tailHandle ?? { numerator: "0", denominator: "1" },
          sourceLocation: annotationSource(item.provenance),
        })),
        operations: processedPlan.operations.map((operation) => ({
          kind: operation.kind,
          at: operation.at,
          duration: operation.duration,
          curve: operation.curve,
          sourceLocation: annotationSource(operation.provenance),
        })),
        transitions: (node.editorial.transitions ?? []).map((transition) => ({
          cut: transition.cut,
          duration: transition.duration,
          overlap: transition.overlap,
          outgoingRegionId: transition.outgoingNodeId,
          incomingRegionId: transition.incomingNodeId,
          outgoingSource: transition.outgoingSource,
          incomingSource: transition.incomingSource,
          curve: transition.curve,
          sourceLocation: annotationSource(transition.provenance),
        })),
      },
    } : {}),
  };
}

function pictureTrackEditorial(node: IRNode) {
  if (node.editorial?.kind !== "picture-track") return undefined;
  return {
    kind: "picture-track" as const,
    ...(node.editorial.trackId ? { trackId: node.editorial.trackId } : {}),
    ...(node.editorial.role ? { role: node.editorial.role } : {}),
    ...(node.editorial.metadata ? { metadata: { ...node.editorial.metadata } } : {}),
    items: node.editorial.items.map((item) => ({
      nodeId: item.nodeId,
      order: item.order,
      kind: item.kind,
      destination: { start: { ...item.destination.start }, duration: { ...item.destination.duration } },
      ...(item.source ? { source: { start: { ...item.source.start }, duration: { ...item.source.duration } } } : {}),
      ...(item.linkId ? { linkId: item.linkId } : {}),
      ...(item.linkSegmentId ? { linkSegmentId: item.linkSegmentId } : {}),
      ...(item.editId ? { editId: item.editId } : {}),
      ...(item.role ? { role: item.role } : {}),
      ...(item.metadata ? { metadata: { ...item.metadata } } : {}),
      ...(item.timeMap ? { timeMap: item.timeMap } : {}),
    })),
  };
}

type DiagramLayoutInspection = Readonly<{
  compositionId: string;
  status: "planned" | "runtime-signal-preparation-required";
  algorithm: "cut-reference-diagram-layout-v1";
  states: Readonly<{ from?: string; to: string }>;
  progress: Readonly<{
    authoredInput?: IRValue;
    execution: Readonly<{ kind: "static-input" } | { kind: "signal"; signalId: string; preparedByRuntime: boolean }>;
  }>;
  contract: Readonly<{
    direction: string;
    frame: Readonly<{ width?: Rational; height?: Rational; x: Rational; y: Rational; safeX: Rational; safeY: Rational }>;
    gaps: Readonly<{ node: Rational; rank: Rational; edge: Rational; clearance: Rational }>;
    nodes: readonly Readonly<{ id: string; irNodeId: string; width: Rational; height: Rational; rank?: number; childIds: readonly string[] }>[];
    edges: readonly Readonly<{ stateId: string; id: string; from: string; to: string; fromPort: string; toPort: string; semanticIdentity: string }>[];
  }>;
  preflight?: Readonly<{
    samples: number;
    first?: Readonly<{ at: Rational; progress: Rational }>;
    last?: Readonly<{ at: Rational; progress: Rational }>;
    plan: ReturnType<typeof planReferenceDiagramLayout>;
  }>;
}>;

function sourceLocatedDiagramError(node: IRNode, error: unknown): never {
  if (!(error instanceof CutDiagramContractError)) throw error;
  const prefix = `${error.code}: `;
  const detail = error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message;
  throw new CutDiagramContractError(
    error.code,
    error.path,
    `${node.op} at ${node.provenance.module}:${node.provenance.span.start.line}:${node.provenance.span.start.column} ${detail}`,
    error.nodeId ?? node.id,
  );
}

/** Build composition-bound DiagramLayout decisions for `cut inspect`. A
 * produced signal deliberately remains a preparation receipt instead of being
 * replaced with its unprepared initial value; exact produced-signal planning
 * belongs to the verified async renderer session. */
function diagramInspections(ir: CutAVIR) {
  const layouts = new Map<string, DiagramLayoutInspection[]>();
  const diagramNodes = new Map<string, Array<Readonly<{
    compositionId: string;
    layoutNodeId: string;
    diagramNodeId: string;
    dimensions: Readonly<{ width: Rational; height: Rational }>;
    rank?: number;
    childIds: readonly string[];
  }>>>();
  const resolver = new ReferencePreparedSignalResolver(ir);
  try {
    for (const composition of ir.compositions) {
      const reachable = [...referenceReachableCompositionNodes(ir, composition)].sort();
      let priorValidationTests = 0;
      for (const nodeId of reachable) {
        const node = ir.nodes[nodeId];
        if (!node || node.op !== cutDiagramOps.layout) continue;
        try {
          const contract = decodeCutDiagramLayout(ir, node);
          const progressProperty = node.properties.progress;
          const progressSignalId = progressProperty && "signal" in progressProperty ? progressProperty.signal : undefined;
          const progressSignal = progressSignalId ? ir.signals[progressSignalId] : undefined;
          const requiresRuntimePreparation = progressSignal?.kind === "track" && progressSignal.producer !== undefined;
          const contractEvidence = Object.freeze({
            direction: contract.direction,
            frame: Object.freeze({
              ...(contract.width ? { width: contract.width } : {}),
              ...(contract.height ? { height: contract.height } : {}),
              x: contract.x,
              y: contract.y,
              safeX: contract.safeX,
              safeY: contract.safeY,
            }),
            gaps: Object.freeze({ node: contract.nodeGap, rank: contract.rankGap, edge: contract.edgeGap, clearance: contract.edgeClearance }),
            nodes: Object.freeze(contract.nodes.map((item) => Object.freeze({
              id: item.id,
              irNodeId: item.node.id,
              width: item.width,
              height: item.height,
              ...(item.rank === undefined ? {} : { rank: item.rank }),
              childIds: Object.freeze([...item.node.children]),
            }))),
            edges: Object.freeze([contract.fromState, contract.state].filter((state): state is NonNullable<typeof state> => state !== undefined)
              .flatMap((state) => state.edges.map((edge) => Object.freeze({
                stateId: state.id,
                id: edge.id,
                from: edge.from,
                to: edge.to,
                fromPort: edge.fromPort,
                toPort: edge.toPort,
                semanticIdentity: edge.semanticIdentity,
              })))),
          });
          let inspection: DiagramLayoutInspection;
          if (requiresRuntimePreparation) {
            inspection = Object.freeze({
              compositionId: composition.id,
              status: "runtime-signal-preparation-required" as const,
              algorithm: "cut-reference-diagram-layout-v1" as const,
              states: Object.freeze({ ...(contract.fromState ? { from: contract.fromState.id } : {}), to: contract.state.id }),
              progress: Object.freeze({
                ...(node.inputs.progress ? { authoredInput: node.inputs.progress } : {}),
                execution: Object.freeze({ kind: "signal" as const, signalId: progressSignalId!, preparedByRuntime: true }),
              }),
              contract: contractEvidence,
            });
          } else {
            const transitionSamples = contract.fromState
              ? referenceDiagramTransitionSamplesAtOutputFrames({
                intervalStart: node.interval.start,
                intervalDuration: node.interval.duration,
                fps: composition.fps,
                layoutId: node.id,
                path: `$.nodes.${JSON.stringify(node.id)}.interval`,
                progressAt: (at) => {
                  const value = propertyAt(ir, node, "progress", at, resolver) ?? node.inputs.progress;
                  if (value?.kind !== "quantity" || value.dimension !== "ratio" || value.unit !== "ratio") {
                    throw new CutDiagramContractError("CUT_DIAGRAM_TYPE", `$.nodes.${JSON.stringify(node.id)}.properties.progress`, "must evaluate to an exact Ratio", node.id);
                  }
                  return rational(value.magnitude.numerator, value.magnitude.denominator);
                },
              })
              : undefined;
            const plan = planReferenceDiagramLayout(contract, {
              canvasWidth: composition.width,
              canvasHeight: composition.height,
              priorValidationTests,
              ...(transitionSamples ? { transitionSamples } : {}),
            });
            priorValidationTests = plan.validationBudget.totalValidationTests;
            inspection = Object.freeze({
              compositionId: composition.id,
              status: "planned" as const,
              algorithm: plan.algorithm,
              states: Object.freeze({ ...(contract.fromState ? { from: contract.fromState.id } : {}), to: contract.state.id }),
              progress: Object.freeze({
                ...(node.inputs.progress ? { authoredInput: node.inputs.progress } : {}),
                execution: progressSignalId
                  ? Object.freeze({ kind: "signal" as const, signalId: progressSignalId, preparedByRuntime: false })
                  : Object.freeze({ kind: "static-input" as const }),
              }),
              contract: contractEvidence,
              preflight: Object.freeze({
                samples: plan.frames.length,
                ...(plan.frames[0] ? { first: Object.freeze({ at: plan.frames[0].at, progress: plan.frames[0].progress }) } : {}),
                ...(plan.frames.at(-1) ? { last: Object.freeze({ at: plan.frames.at(-1)!.at, progress: plan.frames.at(-1)!.progress }) } : {}),
                plan,
              }),
            });
          }
          const existing = layouts.get(node.id) ?? [];
          existing.push(inspection);
          layouts.set(node.id, existing);
          for (const diagramNode of contract.nodes) {
            const rows = diagramNodes.get(diagramNode.node.id) ?? [];
            rows.push(Object.freeze({
              compositionId: composition.id,
              layoutNodeId: node.id,
              diagramNodeId: diagramNode.id,
              dimensions: Object.freeze({ width: diagramNode.width, height: diagramNode.height }),
              ...(diagramNode.rank === undefined ? {} : { rank: diagramNode.rank }),
              childIds: Object.freeze([...diagramNode.node.children]),
            }));
            diagramNodes.set(diagramNode.node.id, rows);
          }
        } catch (error) {
          sourceLocatedDiagramError(node, error);
        }
      }
    }
  } finally {
    resolver.close();
  }
  return { layouts, diagramNodes };
}

/**
 * Build the stable machine-facing graph report used by `cut inspect --json`.
 * It reports executable IR only: no model plan, hidden project graph, or
 * machine-local temporary path participates in this view.
 */
export function inspectCutIr(ir: CutAVIR, program: string) {
  const nodes = Object.values(ir.nodes).sort((left, right) => left.id.localeCompare(right.id));
  const signals = Object.values(ir.signals).sort((left, right) => left.id.localeCompare(right.id));
  const resources = Object.values(ir.resources).sort((left, right) => left.id.localeCompare(right.id));
  const diagram = diagramInspections(ir);
  const compositions = ir.compositions.map((composition) => {
    const selected = compositionNodeRoots(ir, composition.id);
    if (!selected) throw new Error(`CUT inspect could not resolve composition ${composition.id}.`);
    const graph = assertCutGraphExecutionBudget(ir, selected.roots);
    const markerIds = ir.annotations?.markers.filter((marker) => marker.compositionId === composition.id).map((marker) => marker.id) ?? [];
    const regionIds = ir.annotations?.regions.filter((region) => region.compositionId === composition.id).map((region) => region.id) ?? [];
    const semanticMatchSubjectIds = ir.semanticMatches?.subjects.filter((subject) => subject.compositionId === composition.id).map((subject) => subject.id) ?? [];
    const semanticMatchTransitionIds = ir.semanticMatches?.transitions.filter((transition) => transition.compositionId === composition.id).map((transition) => transition.id) ?? [];
    const transcriptMediaAuthorityIds = ir.transcriptMediaAuthorities?.filter((authority) => authority.compositionId === composition.id).map((authority) => authority.id) ?? [];
    const transcriptBindingIds = ir.transcriptBindings?.filter((binding) => binding.compositionId === composition.id).map((binding) => binding.id) ?? [];
    const timelineEditIds = ir.timelineEdits?.filter((plan) => plan.compositionId === composition.id).map((plan) => plan.id) ?? [];
    return {
      id: composition.id,
      name: composition.name,
      canvas: { width: composition.width, height: composition.height },
      duration: composition.duration,
      fps: composition.fps,
      sampleRate: composition.sampleRate,
      scenes: [...composition.sceneIds],
      roots: {
        visual: [...composition.rootVisualIds],
        audio: [...composition.rootAudioIds],
        audiovisual: [...composition.rootAVIds],
      },
      graph,
      ...(markerIds.length || regionIds.length ? { annotations: { markers: markerIds, regions: regionIds } } : {}),
      ...(semanticMatchSubjectIds.length || semanticMatchTransitionIds.length ? {
        semanticMatches: { subjects: semanticMatchSubjectIds, transitions: semanticMatchTransitionIds },
      } : {}),
      ...(transcriptMediaAuthorityIds.length
        ? { transcriptMediaAuthorities: transcriptMediaAuthorityIds }
        : {}),
      ...(transcriptBindingIds.length ? { transcriptBindings: transcriptBindingIds } : {}),
      ...(timelineEditIds.length ? { timelineEdits: timelineEditIds } : {}),
    };
  });
  const retainedPathInspections = new Map<string, unknown[]>();
  const anchoredPathInspections = new Map<string, CutAnchoredConsumerInspection>();
  const parallaxCameraInspections = new Map<string, ReturnType<typeof referenceParallaxCameraInspect>>();
  const camera3DInspections = new Map<string, ReturnType<typeof referenceCamera3DInspect>>();
  const mediaCamera2DInspections = new Map<string, unknown>();
  const mapCameraInspections = new Map<string, ReturnType<typeof referenceMapCameraInspectPlan>>();
  const geoAnnotationInspections = new Map<string, unknown>();
  const calloutLayerInspections = new Map<string, ReturnType<typeof referenceCalloutInspect>>();
  const calloutInspections = new Map<
    string,
    ReturnType<typeof referenceCalloutInspect>["callouts"][number]
  >();
  const localSpaceInspections = new Map<string, ReturnType<typeof referenceLocalSpaceInspect>>();
  const componentFragmentLocalSpaceInspections = new Map<string, ReturnType<typeof referenceComponentFragmentLocalSpaceInspect>>();
  const localSpaceConfigsByNode = new Map<string, ReferenceLocalSpaceConfig>();
  const localSpaceContextByNode = new Map<string, ReferenceLocalSpaceConfig>();
  const responsiveStackInspections = new Map<string, ReturnType<typeof referenceResponsiveStackInspect>>();
  const identityComponentFragmentInspections =
    new Map<string, ReturnType<typeof referenceIdentityComponentFragmentInspect>>();
  const responsiveSlotInspections = new Map<string, ReturnType<typeof referenceResponsiveStackInspect>["slots"][number]>();
  const responsiveContextByNode = new Map<string, ReferenceResponsiveStackLocalContext>();
  const motionBlurInspections = new Map<string, ReturnType<typeof referenceMotionBlurBoundaryInspect>>();
  const semanticMatchInspections = new Map<string, ReturnType<typeof referenceSemanticMatchInspect>>();
  const compositionByNodeId = new Map<string, ReturnType<typeof compositionOfNode>>();
  const localSpaceStructuralIndex = createReferenceLocalSpaceStructuralValidationIndex(ir);
  const componentFragmentAdmissionIndex = localSpaceStructuralIndex.componentFragmentAdmissionIndex;
  for (const composition of ir.compositions) {
    const selected = compositionNodeRoots(ir, composition.id);
    if (!selected) continue;
    assertCutGraphExecutionBudget(ir, selected.roots);
    const reachable = referenceReachableCompositionNodes(ir, composition);
    for (const nodeId of reachable) if (!compositionByNodeId.has(nodeId)) compositionByNodeId.set(nodeId, composition);
    const localSpaceConfigs = validateReferenceLocalSpaceGraph(ir, composition, reachable, {
      structuralIndex: localSpaceStructuralIndex,
    });
    const identityComponentFragments = validateReferenceIdentityComponentFragments(
      ir,
      composition,
      reachable,
      componentFragmentAdmissionIndex,
    );
    for (const [nodeId, config] of identityComponentFragments) {
      identityComponentFragmentInspections.set(
        nodeId,
        referenceIdentityComponentFragmentInspect(config),
      );
    }
    const mediaCameraPlans = new Map<string, ReferenceMediaCamera2DPlan>();
    const mediaCameraResolver = new ReferencePreparedSignalResolver(ir);
    try {
      for (const [nodeId, plan] of validateReferenceMediaCamera2DGraph(ir, composition, reachable)) {
        mediaCameraPlans.set(nodeId, plan);
        const camera = ir.nodes[nodeId];
        if (!camera) throw new Error(`CUT inspect MediaCamera2D ${nodeId} has no source node.`);
        const firstFrame = referenceMediaCamera2DFramePlanAt(ir, composition, plan, zeroRational, mediaCameraResolver);
        const firstAnchor = referenceMediaCamera2DAnchorPlanFromFramePlan(
          ir,
          plan,
          firstFrame,
        );
        mediaCamera2DInspections.set(nodeId, Object.freeze({
          algorithmVersion: plan.algorithmVersion,
          backendIdentity: plan.backendIdentity,
          source: plan.source,
          leaf: Object.freeze({
            nodeId: plan.leafNodeId,
            kind: plan.leafKind,
            ...(plan.gradeNodeId ? { gradeNodeId: plan.gradeNodeId } : {}),
          }),
          framing: Object.freeze({
            fit: plan.fit,
            ...(plan.crop ? { crop: plan.crop } : {}),
            native: plan.native,
            decodedCrop: plan.decodedCrop,
            output: plan.output,
            outputContext: plan.outputContext,
            edge: plan.edge,
            transformOrder: plan.transformOrder,
          }),
          controls: Object.freeze({
            focusX: authoredNodeControl(ir, camera, "focusX"),
            focusY: authoredNodeControl(ir, camera, "focusY"),
            zoom: authoredNodeControl(ir, camera, "zoom"),
            rotation: authoredNodeControl(ir, camera, "rotation"),
            opacity: authoredNodeControl(ir, camera, "opacity"),
          }),
          sampling: Object.freeze({
            mode: plan.decodePlan.resample,
            sourceResolutionDecode: true as const,
            compositionPrerasterCount: 0 as const,
            geometricResampleCount: "zero-when-opacity-zero-otherwise-one" as const,
            ...(plan.outputContext.kind === "responsive-slot" ? {
              responsiveStackPlacement: Object.freeze({
                algorithmVersion: referenceResponsiveStackMediaPlacementAlgorithm,
                geometricResampleCount: 0 as const,
                placementSurfaceCount: "zero-when-opacity-zero-otherwise-one" as const,
                clip: plan.outputContext.clip,
                stackNodeId: plan.outputContext.stackNodeId,
                slotNodeId: plan.outputContext.slotNodeId,
              }),
            } : {}),
            ...(firstAnchor.responsiveSlotComposition ? {
              visualAnchorComposition: Object.freeze({
                status: "supported-exact-chain" as const,
                algorithmVersion: firstAnchor.responsiveSlotComposition.algorithmVersion,
                pixelPlacementAlgorithmVersion:
                  firstAnchor.responsiveSlotComposition.pixelPlacementAlgorithmVersion,
                coordinateChain: Object.freeze([
                  "post-crop-source-pixel-centres",
                  "responsive-slot-pixel-centres",
                  "integer-slot-placement",
                  "composition-pixel-centres",
                ] as const),
                sourceToSlotQ16: firstAnchor.responsiveSlotComposition.sourceToSlotQ16,
                slotToCompositionQ16:
                  firstAnchor.responsiveSlotComposition.slotToCompositionQ16,
                sourceToCompositionQ16: firstAnchor.sourceToDeliveryQ16,
                placementPlanIdentity:
                  firstAnchor.responsiveSlotComposition.placementPlanIdentity,
                affineIdentity: firstAnchor.affineIdentity,
                geometricResampleCount: 0 as const,
              }),
            } : {}),
            ...(plan.nativeEffectChain ? {
              nativeEffectPlacement: plan.nativeEffectChain.order,
            } : {}),
          }),
          ...(plan.nativeEffectChain ? {
            nativeEffectChain: Object.freeze({
              algorithmVersion: plan.nativeEffectChain.algorithmVersion,
              basis: plan.nativeEffectChain.basis,
              order: plan.nativeEffectChain.order,
              inspectionOrder: Object.freeze(
                [...plan.nativeEffectChain.operations]
                  .sort((left, right) => left.inspectionOrder - right.inspectionOrder)
                  .map((operation) => Object.freeze({
                    inspectionOrder: operation.inspectionOrder,
                    nodeId: operation.nodeId,
                    op: operation.op,
                  })),
              ),
              executionOrder: Object.freeze(plan.nativeEffectChain.operations.map((operation) => Object.freeze({
                executionOrder: operation.executionOrder,
                nodeId: operation.nodeId,
                op: operation.op,
                maximumPixelWork: operation.maximumPixelWork,
                maximumOutputSurfaces: operation.maximumOutputSurfaces,
                maximumOutputRgbaBytes: operation.maximumOutputRgbaBytes,
                semanticIdentity: operation.semanticIdentity,
              }))),
              maximumPixelWork: plan.nativeEffectChain.maximumPixelWork,
              maximumOutputSurfaces: plan.nativeEffectChain.maximumOutputSurfaces,
              maximumOutputRgbaBytes: plan.nativeEffectChain.maximumOutputRgbaBytes,
              semanticIdentity: plan.nativeEffectChain.semanticIdentity,
              firstFrame: firstFrame.nativeEffectChain,
            }),
          } : {}),
          observability: plan.observability,
          firstFrame: Object.freeze({
            status: firstFrame.status,
            exactTime: firstFrame.exactTime,
            controls: firstFrame.controls,
            geometry: firstFrame.geometry,
            work: firstFrame.work,
            planIdentity: firstFrame.planIdentity,
          }),
          maximumStaticWork: plan.maximumStaticWork,
          semanticIdentity: plan.semanticIdentity,
        }));
      }
    } finally {
      mediaCameraResolver.close();
    }
    for (const [nodeId, config] of validateReferenceCalloutGraph(
      ir,
      composition,
      reachable,
      localSpaceConfigs,
      mediaCameraPlans,
      {},
      identityComponentFragments,
    )) {
      const inspection = referenceCalloutInspect(config);
      calloutLayerInspections.set(nodeId, inspection);
      for (const callout of inspection.callouts) calloutInspections.set(callout.nodeId, callout);
    }
    semanticMatchInspections.set(composition.id, referenceSemanticMatchInspect(ir, composition, localSpaceConfigs));
    for (const [nodeId, config] of localSpaceConfigs) {
      localSpaceInspections.set(nodeId, referenceLocalSpaceInspect(config));
      localSpaceConfigsByNode.set(nodeId, config);
      if (config.owner === "component-fragment" && config.ownerNodeId) {
        const owner = ir.nodes[config.ownerNodeId];
        if (!owner) throw new Error(`CUT inspect component-fragment LocalSpace ${nodeId} references missing owner ${config.ownerNodeId}.`);
        componentFragmentLocalSpaceInspections.set(owner.id, referenceComponentFragmentLocalSpaceInspect(ir, composition, owner, config, componentFragmentAdmissionIndex));
      }
    }
    for (const [nodeId, config] of referenceLocalSpaceDescendantContexts(ir, localSpaceConfigs)) localSpaceContextByNode.set(nodeId, config);
    for (const nodeId of reachable) {
      const node = ir.nodes[nodeId];
      if (!node || !isReferenceAnchoredPathGeometryValue(node.inputs.geometry)) continue;
      if (node.op !== "cut.visual.path" && node.op !== "cut.visual.motion_path") {
        throw new Error(`CUT inspect found anchored geometry on unsupported consumer ${node.op} at ${node.provenance.module}:${node.provenance.span.start.line}:${node.provenance.span.start.column}.`);
      }
      const decoded = decodeReferenceAnchoredPathGeometry(node, node.inputs.geometry, "geometry");
      const validated = validateReferenceAnchoredPathGeometry(
        ir,
        composition,
        node,
        decoded,
        localSpaceConfigs,
        mediaCameraPlans,
        identityComponentFragments,
      );
      const geometry = referenceAnchoredPathInspect(validated);
      const ownerBindings = validated.ownerBindings.map((binding) => ({ ...binding }));
      const preRender = anchoredPreRenderInspection();
      if (node.op === "cut.visual.path") {
        const plan = prepareReferenceAnchoredVectorPathNode(ir, node, validated);
        if (!plan) throw new Error(`CUT inspect could not prepare anchored Path ${node.id}.`);
        const structuralWork = validateReferenceAnchoredVectorPathStructuralWork(composition, node, plan);
        anchoredPathInspections.set(node.id, {
          consumer: "Path",
          compositionId: composition.id,
          geometry,
          ownerBindings,
          validationIdentity: validated.validationIdentity,
          requiresExactOwnerPlacement: true,
          preRender,
          plan: Object.freeze({
            geometryKind: plan.geometryKind,
            authoredSegments: plan.authoredSegments,
            closed: plan.closed,
            frameDynamic: plan.frameDynamic,
          }),
          paint: Object.freeze({
            ...(plan.stroke ? { stroke: plan.stroke, strokeWidth: plan.strokeWidth } : {}),
            ...(plan.fill ? { fill: plan.fill, fillRule: plan.fillRule } : {}),
            ...(plan.dash ? { dash: [...plan.dash] } : {}),
            lineCap: plan.lineCap,
            lineJoin: plan.lineJoin,
          }),
          controls: Object.freeze({
            animatedProperties: [...plan.animatedProperties],
            trimRangeDynamic: plan.trimRangeDynamic,
            trimStart: authoredNodeControl(ir, node, "trimStart"),
            trimEnd: authoredNodeControl(ir, node, "trimEnd"),
            dashOffset: authoredNodeControl(ir, node, "dashOffset"),
          }),
          structuralWork,
        });
      } else {
        const plan = prepareReferenceAnchoredMotionPathNode(node, validated);
        if (!plan) throw new Error(`CUT inspect could not prepare anchored MotionPath ${node.id}.`);
        anchoredPathInspections.set(node.id, {
          consumer: "MotionPath",
          compositionId: composition.id,
          geometry,
          ownerBindings,
          validationIdentity: validated.validationIdentity,
          requiresExactOwnerPlacement: true,
          preRender,
          plan: Object.freeze({
            pathForm: plan.pathForm,
            authoredSegments: plan.authoredSegments,
            closed: plan.closed,
            flatteningVersion: plan.flatteningVersion,
          }),
          paint: Object.freeze({ kind: "subject-placement-no-self-paint" as const }),
          controls: Object.freeze({
            progress: authoredNodeControl(ir, node, "progress"),
            orientToPath: authoredNodeControl(ir, node, "orientToPath"),
          }),
          structuralWork: Object.freeze({
            status: "owner-aware-frame-work-deferred-to-pre-render" as const,
            authoredSegments: plan.authoredSegments,
            spatialPointCount: validated.spatialPointCount,
            ownerCount: validated.ownerNodeIds.length,
          }),
        });
      }
    }
    const responsiveConfigs = validateReferenceResponsiveStackGraph(
      ir,
      composition,
      reachable,
      identityComponentFragments,
    );
    for (const [nodeId, config] of responsiveConfigs) {
      const inspection = referenceResponsiveStackInspect(config);
      responsiveStackInspections.set(nodeId, inspection);
      for (const slot of inspection.slots) responsiveSlotInspections.set(slot.slotNodeId, slot);
    }
    for (const [nodeId, config] of referenceResponsiveStackDescendantContexts(responsiveConfigs)) responsiveContextByNode.set(nodeId, config);
    const parallaxConfigs = validateReferenceParallaxCameraGraph(ir, composition, reachable);
    for (const [nodeId, config] of parallaxConfigs) {
      parallaxCameraInspections.set(nodeId, referenceParallaxCameraInspect(ir, composition, config));
    }
    for (const [nodeId, config] of validateReferenceCamera3DGraph(ir, composition, reachable, localSpaceConfigs)) {
      camera3DInspections.set(nodeId, referenceCamera3DInspect(ir, composition, config));
    }
    for (const [cameraId, config] of validateReferenceGeoAnnotationGraph(ir, composition, parallaxConfigs, reachable, localSpaceConfigs)) {
      const camera = parallaxConfigs.get(cameraId);
      if (!camera) throw new Error(`CUT inspect GeoAnnotation camera ${cameraId} has no ParallaxCamera configuration.`);
      for (const [nodeId, inspection] of referenceGeoAnnotationInspect(ir, composition, config, camera)) geoAnnotationInspections.set(nodeId, inspection);
    }
    const mapCameraConfigs = validateReferenceMapCameraGraph(ir, composition, reachable);
    for (const [nodeId, config] of mapCameraConfigs) {
      mapCameraInspections.set(nodeId, referenceMapCameraInspectPlan(ir, composition, config));
      const annotations = validateReferenceMapCameraGeoAnnotations(ir, composition, config);
      if (annotations) for (const [annotationId, inspection] of referenceMapCameraGeoAnnotationInspect(ir, composition, config, annotations)) {
        geoAnnotationInspections.set(annotationId, inspection);
      }
    }
    for (const nodeId of reachable) {
      const node = ir.nodes[nodeId], config = node ? referenceMotionBlurConfig(node) : undefined;
      if (!node || !config) continue;
      const child = ir.nodes[node.children[0]];
      if (!child) throw new Error(`CUT inspect MotionBlur ${node.id} has no direct child.`);
      const boundary = prepareReferenceMotionBlurBoundary(node, child, divideRational(rational(1), composition.fps), config);
      motionBlurInspections.set(node.id, referenceMotionBlurBoundaryInspect(node, child, boundary));
    }
  }
  for (const composition of ir.compositions) {
    const selected = compositionNodeRoots(ir, composition.id);
    if (!selected) continue;
    for (const chain of referenceRetainedPathChainsFromRoots(ir, selected.roots)) {
      const time = referenceRetainedPathChainInspectionTime(ir, chain);
      const path = ir.nodes[chain.pathId];
      const anchored = path && isReferenceAnchoredPathGeometryValue(path.inputs.geometry);
      const inspection = chain.requiresTrack2D
        ? {
          status: "runtime-track-required" as const,
          algorithmVersion: referenceRetainedPathChainAlgorithmVersion,
          backendIdentity: referenceRetainedPathBackendIdentity,
          exactTime: { ...time },
          rootId: chain.rootId,
          pathId: chain.pathId,
          nodeIds: [...chain.nodeIds],
          wrapperOps: [...chain.wrapperOps],
          reason: "Track2D composed matrix requires its locked prepared observation at runtime.",
          boundariesStillMaterialized: ["multi-child", "effects", "mask", "clip-path", "stack", "non-normal-blend", "precomposition"],
        }
        : anchored
          ? {
            status: "exact-owner-placement-required" as const,
            algorithmVersion: referenceRetainedPathChainAlgorithmVersion,
            backendIdentity: referenceRetainedPathBackendIdentity,
            exactTime: { ...time },
            rootId: chain.rootId,
            pathId: chain.pathId,
            nodeIds: [...chain.nodeIds],
            wrapperOps: [...chain.wrapperOps],
            reason: "AnchoredPathGeometry is validated structurally by inspect; retained-chain coordinates require exact renderer owner placement.",
            coordinates: "not-sampled-by-cut-inspect" as const,
            boundariesStillMaterialized: ["multi-child", "effects", "mask", "clip-path", "stack", "non-normal-blend", "precomposition"],
          }
        : (() => {
          const plan = path ? prepareReferenceVectorPathNode(ir, path) : undefined;
          if (!path || !plan) throw new Error(`CUT inspect retained chain ${chain.rootId} has no prepared Path leaf.`);
          return referenceRetainedPathChainInspection(referenceRetainedPathChainExecutionAt(ir, composition, chain, plan, time), time);
        })();
      const existing = retainedPathInspections.get(chain.pathId) ?? [];
      existing.push({ compositionId: composition.id, ...inspection });
      retainedPathInspections.set(chain.pathId, existing);
    }
  }
  const assertionCounts = countBy(ir.assertions, (assertion) => assertion.status);
  return {
    format: "cut-inspect-report" as const,
    version: 1 as const,
    status: "pass" as const,
    program,
    project: ir.project,
    compiler: ir.compiler,
    buildId: ir.buildId,
    determinism: { ...ir.determinism },
    timebase: { ...ir.timebase },
    summary: {
      compositions: ir.compositions.length,
      scenes: Object.keys(ir.scenes).length,
      nodes: nodes.length,
      signals: signals.length,
      resources: resources.length,
      lockedResources: resources.filter((resource) => resource.state === "locked").length,
      modules: ir.modules.length,
      sourceModules: ir.sourceModules?.length ?? 0,
      jobs: ir.jobs.length,
      outputs: ir.outputs.length,
      assertions: ir.assertions.length,
      linkedEdits: ir.linkedEdits?.length ?? 0,
      semanticMatchSubjects: ir.semanticMatches?.subjects.length ?? 0,
      semanticMatchTransitions: ir.semanticMatches?.transitions.length ?? 0,
      transcriptMediaAuthorities: ir.transcriptMediaAuthorities?.length ?? 0,
      transcriptBindings: ir.transcriptBindings?.length ?? 0,
      ...(ir.timelineEdits ? { timelineEdits: ir.timelineEdits.length } : {}),
      diagramLayouts: nodes.filter((node) => node.op === cutDiagramOps.layout).length,
      diagramNodes: nodes.filter((node) => node.op === cutDiagramOps.node).length,
      ...(ir.annotations ? { markers: ir.annotations.markers.length, regions: ir.annotations.regions.length } : {}),
    },
    counts: {
      nodeDomains: countBy(nodes, (node) => node.domain),
      nodeOperations: countBy(nodes, (node) => node.op),
      nodeOwnership: countBy(nodes, (node) => node.ownership),
      signalKinds: countBy(signals, (signal) => signal.kind),
      resourceKinds: countBy(resources, (resource) => resource.kind),
      resourceStates: countBy(resources, (resource) => resource.state),
      assertionStates: assertionCounts,
    },
    compositions,
    graph: {
      nodes: nodes.map((node) => {
        const editorial = audioTrackEditorial(node);
        const pictureEditorial = pictureTrackEditorial(node);
        const regionRetime = audioRegionRetime(ir, node);
        const timelineAudioMaterialization =
          timelineAudioMaterializationInspection(node);
        const tracking2D = referenceTrack2DConfig(ir, node);
        const trackingLocalSpace = tracking2D && node.children.length === 1
          ? localSpaceConfigsByNode.get(node.children[0]!)
          : undefined;
        const planarTrack = referencePlanarTrackConfig(ir, node);
        const planarTrackMatte = planarTrack ? referencePlanarTrackMatteConfig(ir, node) : undefined;
        const planarTrackOpacityProperty = planarTrack ? node.properties.opacity : undefined;
        const planarLocalSpace = planarTrack && node.children.length === 1
          ? localSpaceConfigsByNode.get(node.children[0]!)
          : undefined;
        const camera2DLocalSpace = node.op === "cut.visual.camera2d" && node.children.length === 1
          ? localSpaceConfigsByNode.get(node.children[0]!)
          : undefined;
        const componentFragmentLocalSpace = componentFragmentLocalSpaceInspections.get(node.id);
        const identityComponentFragment =
          identityComponentFragmentInspections.get(node.id);
        const trace = prepareReferenceTraceNode(node);
        const vectorPath = prepareReferenceVectorPathNode(ir, node);
        const anchoredPath = anchoredPathInspections.get(node.id);
        const nodeComposition = compositionByNodeId.get(node.id) ?? compositionOfNode(ir, node);
        const linkedPresentationSource = node.op === "cut.edit.clip" && node.inputs.source?.kind === "resource-ref"
          ? ir.resources[node.inputs.source.id]
          : undefined;
        const linkedAvAudioExecution = nodeComposition && linkedPresentationSource?.state === "locked"
          ? referenceLinkedClipAudioExecutionPlan(ir, nodeComposition, node)
          : undefined;
        const tempoDelay = nodeComposition ? referenceTempoDelayConfig(ir, nodeComposition, node) : undefined;
        const motionPathPlan = nodeComposition && node.op === "cut.visual.motion_path" && !anchoredPath
          ? prepareReferenceMotionPathNode(node)
          : undefined;
        const localSpaceContext = localSpaceContextByNode.get(node.id), responsiveContext = responsiveContextByNode.get(node.id);
        const boundedContext = localSpaceContext ?? responsiveContext;
        const motionPathInspection = motionPathPlan && nodeComposition
          ? (() => {
              const executionComposition = localSpaceContext
                ? { ...nodeComposition, width: localSpaceContext.width, height: localSpaceContext.height }
                : nodeComposition;
              const inspected = referenceMotionPathInspect(ir, executionComposition, node, motionPathPlan);
              if (!localSpaceContext) return inspected;
              const authoredLocalAtActiveStart = Object.freeze({
                time: Object.freeze({ ...inspected.executedAtActiveStart.time }),
                progress: inspected.executedAtActiveStart.progress,
                x: inspected.executedAtActiveStart.x + localSpaceContext.width / 2,
                y: inspected.executedAtActiveStart.y + localSpaceContext.height / 2,
                rotation: inspected.executedAtActiveStart.rotation,
              });
              return Object.freeze({
                ...inspected,
                localExecution: Object.freeze({
                  algorithmVersion: referenceLocalMotionPathAlgorithmVersion,
                  localSpaceNodeId: localSpaceContext.nodeId,
                  dimensions: Object.freeze({ width: localSpaceContext.width, height: localSpaceContext.height }),
                  rasterOriginQ16: Object.freeze({ ...localSpaceContext.rasterOriginQ16 }),
                  coordinateBasis: "authored-local-pixel-edges" as const,
                  transformOrder: Object.freeze([
                    "local-path-position",
                    "tangent-orientation",
                    "authored-motion-path-transform",
                    "local-half-open-clip",
                    "source-over",
                  ] as const),
                  deliveryCanvasFallback: "forbidden" as const,
                  localTileSemanticIdentity: localSpaceContext.semanticIdentity,
                  authoredLocalAtActiveStart,
                  semanticIdentity: hash({
                    algorithm: referenceLocalMotionPathAlgorithmVersion,
                    motionPathContentHash: node.contentHash,
                    localTileSemanticIdentity: localSpaceContext.semanticIdentity,
                    authoredLocalAtActiveStart,
                    coordinateBasis: "authored-local-pixel-edges",
                    transformOrder: [
                      "local-path-position",
                      "tangent-orientation",
                      "authored-motion-path-transform",
                      "local-half-open-clip",
                      "source-over",
                    ],
                  }),
                }),
              });
            })()
          : undefined;
        const flowText = nodeComposition
          ? referenceFlowTextConfig(
              node,
              ir,
              boundedContext ? { ...nodeComposition, width: boundedContext.width, height: boundedContext.height } : nodeComposition,
              localSpaceContext ? referenceLocalSpaceTextLayoutContext(localSpaceContext) : responsiveContext ? referenceResponsiveStackTextLayoutContext(responsiveContext) : undefined,
            )
          : undefined;
        const parallaxCamera = parallaxCameraInspections.get(node.id);
        const camera3D = camera3DInspections.get(node.id);
        const mediaCamera2D = mediaCamera2DInspections.get(node.id);
        const mapCamera = mapCameraInspections.get(node.id);
        const geoAnnotation = geoAnnotationInspections.get(node.id);
        const calloutLayer = calloutLayerInspections.get(node.id);
        const callout = calloutInspections.get(node.id);
        const localSpace = localSpaceInspections.get(node.id);
        const responsiveStack = responsiveStackInspections.get(node.id);
        const responsiveSlot = responsiveSlotInspections.get(node.id);
        const motionBlur = motionBlurInspections.get(node.id);
        const diagramLayouts = diagram.layouts.get(node.id);
        const diagramNodes = diagram.diagramNodes.get(node.id);
        const inputColor = ["cut.visual.video", "cut.edit.clip", "cut.edit.picture_clip"].includes(node.op)
          && node.inputs.inputColor?.kind === "string"
          ? node.inputs.inputColor.value
          : undefined;
        const inputColorDeclaration = ["cut.visual.video", "cut.edit.clip", "cut.edit.picture_clip"].includes(node.op)
          ? referenceVideoInputColorDeclaration(node)
          : undefined;
        const interpretedInputColor = inputColorDeclaration?.mode === "interpreted" ? inputColorDeclaration : undefined;
        return {
          id: node.id,
          op: node.op,
          domain: node.domain,
          ownership: node.ownership,
          ...(node.sceneId ? { sceneId: node.sceneId } : {}),
          interval: node.interval,
          children: [...node.children],
          references: nodeReferences(node),
          ...(inputColor ? { videoInputColor: {
            profile: inputColor,
            ...(inputColor === referenceBt470bgSmpte170mInputContract.profile
              ? { backendContract: referenceBt470bgSmpte170mInputContract.id }
              : {}),
          } } : {}),
          ...(interpretedInputColor ? { videoInputColorInterpretation: {
            mode: interpretedInputColor.mode,
            profile: interpretedInputColor.inputColor,
            authority: interpretedInputColor.authority,
            contract: interpretedInputColor.contract,
            decoderContract: referenceVideoColorProfileContractId(interpretedInputColor.inputColor),
            observed: {
              master: interpretedInputColor.interpretation.master,
              ...(interpretedInputColor.interpretation.proxy ? { proxy: interpretedInputColor.interpretation.proxy } : {}),
            },
            differences: {
              master: interpretedDifferences(interpretedInputColor.interpretation.master, interpretedInputColor.inputColor),
              ...(interpretedInputColor.interpretation.proxy ? { proxy: interpretedDifferences(interpretedInputColor.interpretation.proxy, interpretedInputColor.inputColor) } : {}),
            },
          } } : {}),
          ...(node.op === "cut.edit.audio_region" && (node.inputs.headHandle || node.inputs.tailHandle) ? {
            audioRegionHandleAvailability: {
              ...(node.inputs.headHandle ? { headHandle: node.inputs.headHandle } : {}),
              ...(node.inputs.tailHandle ? { tailHandle: node.inputs.tailHandle } : {}),
            },
          } : {}),
          ...(regionRetime ? { audioRegionRetime: regionRetime } : {}),
          ...(timelineAudioMaterialization
            ? { timelineAudioMaterialization }
            : {}),
          ...(editorial ? { editorial } : {}),
          ...(pictureEditorial ? { pictureEditorial } : {}),
          ...(linkedAvAudioExecution ? {
            linkedAvPresentation: linkedAvAudioExecution.presentation,
            linkedAvAudioExecution,
          } : {}),
          ...(tracking2D ? { tracking2D: {
            sourceId: tracking2D.sourceId,
            interpolation: tracking2D.interpolation,
            minConfidence: tracking2D.minConfidence,
            policies: {
              lowConfidence: tracking2D.lowConfidence,
              occluded: tracking2D.occluded,
              outOfFrame: tracking2D.outOfFrame,
            },
            bindScale: tracking2D.bindScale,
            bindRotation: tracking2D.bindRotation,
            ...(trackingLocalSpace?.owner === "track-2d" && trackingLocalSpace.ownerNodeId === node.id ? {
              directLocalSpace: {
                nodeId: trackingLocalSpace.nodeId,
                dimensions: { width: trackingLocalSpace.width, height: trackingLocalSpace.height },
                rasterOriginQ16: { ...trackingLocalSpace.rasterOriginQ16 },
                semanticIdentity: trackingLocalSpace.semanticIdentity,
                rendererHandoff: "connected-reference-visual-renderer" as const,
                sampledPlacement: "requires-locked-runtime-data" as const,
              },
            } : {}),
          } } : {}),
          ...(planarTrack ? { planarTrack: {
            sourceId: planarTrack.sourceId,
            interpolation: planarTrack.interpolation,
            minConfidence: planarTrack.minConfidence,
            policies: {
              lowConfidence: planarTrack.lowConfidence,
              occluded: planarTrack.occluded,
              outOfFrame: planarTrack.outOfFrame,
            },
            opacity: {
              authoredInput: planarTrack.opacity,
              execution: planarTrackOpacityProperty === undefined
                ? { kind: "static-input" as const }
                : "signal" in planarTrackOpacityProperty
                  ? { kind: "signal" as const, signalId: planarTrackOpacityProperty.signal }
                  : { kind: "constant-property" as const, value: planarTrackOpacityProperty },
            },
            coordinateSpace: "composition-pixel-edges" as const,
            projectiveMaterialization: "isolated-reference-projective-warp" as const,
            ...(planarTrackMatte ? {
              partialOcclusionMatte: {
                algorithmVersion: planarTrackMatte.algorithmVersion,
                maskNodeId: planarTrackMatte.maskNodeId,
                targetNodeId: planarTrackMatte.targetNodeId,
                matteNodeId: planarTrackMatte.matteNodeId,
                mode: planarTrackMatte.mode,
                coordinateSpace: planarTrackMatte.coordinateSpace,
                evaluationStage: planarTrackMatte.evaluationStage,
                authoring: planarTrackMatte.authoring,
                semanticIdentity: planarTrackMatte.semanticIdentity,
                ...(planarLocalSpace ? {
                  localCompositingPlanIdentity: planarLocalSpace.localCompositing.semanticIdentity,
                  operationSemanticIdentity: planarLocalSpace.localCompositing.operations
                    .find((operation) => operation.nodeId === planarTrackMatte.maskNodeId)?.semanticIdentity,
                } : {}),
              },
            } : {}),
            ...(planarLocalSpace?.owner === "planar-track" && planarLocalSpace.ownerNodeId === node.id ? {
              directLocalSpace: {
                nodeId: planarLocalSpace.nodeId,
                dimensions: { width: planarLocalSpace.width, height: planarLocalSpace.height },
                rasterOriginQ16: { ...planarLocalSpace.rasterOriginQ16 },
                semanticIdentity: planarLocalSpace.semanticIdentity,
                rendererHandoff: "connected-reference-projective-renderer" as const,
                sampledQuad: "requires-locked-runtime-data" as const,
              },
            } : {}),
          } } : {}),
          ...(trace ? { trace: {
            geometry: trace.geometry,
            authoredSegments: trace.authoredSegments,
            flattenedPoints: trace.trace.points.length,
            totalLengthPx: trace.trace.totalLength,
            ...(trace.geometry === "cubic" ? { flatteningVersion: referenceCubicTraceFlattening.version } : {}),
            ...(trace.arrow ? { arrow: { ...trace.arrow, orientation: "terminal-tangent" as const, persistence: "held" as const } } : {}),
            ...(localSpaceContext ? { localExecution: {
              algorithmVersion: referenceLocalTraceAlgorithmVersion,
              localSpaceNodeId: localSpaceContext.nodeId,
              dimensions: { width: localSpaceContext.width, height: localSpaceContext.height },
              rasterOriginQ16: { ...localSpaceContext.rasterOriginQ16 },
              clip: "declared-half-open-local-tile" as const,
              deliveryCanvasFallback: "forbidden" as const,
              localTileSemanticIdentity: localSpaceContext.semanticIdentity,
            } } : {}),
          } } : {}),
          ...(vectorPath ? { vectorPath: {
            ...referenceVectorPathInspect(ir, node, vectorPath),
            ...(retainedPathInspections.has(node.id) ? { retainedCompositor: { instances: retainedPathInspections.get(node.id)! } } : {}),
          } } : {}),
          ...(anchoredPath ? { anchoredPath: {
            ...anchoredPath,
            ...(retainedPathInspections.has(node.id) ? { retainedCompositor: { instances: retainedPathInspections.get(node.id)! } } : {}),
          } } : {}),
          ...(motionPathInspection ? { motionPath: motionPathInspection } : {}),
          ...(flowText ? { flowText: referenceFlowTextInspect(flowText) } : {}),
          ...(parallaxCamera ? { parallaxCamera } : {}),
          ...(camera3D ? { camera3D } : {}),
          ...(mediaCamera2D ? { mediaCamera2D } : {}),
          ...(mapCamera ? { mapCamera } : {}),
          ...(camera2DLocalSpace?.owner === "camera-2d" && camera2DLocalSpace.ownerNodeId === node.id
            ? { camera2D: referenceCamera2DLocalSpaceInspect(node, camera2DLocalSpace) }
            : {}),
          ...(componentFragmentLocalSpace ? { componentFragmentLocalSpace } : {}),
          ...(identityComponentFragment ? { identityComponentFragment } : {}),
          ...(geoAnnotation ? { geoAnnotation } : {}),
          ...(calloutLayer ? { calloutLayer } : {}),
          ...(callout ? { callout } : {}),
          ...(localSpace ? { localSpace } : {}),
          ...(responsiveStack ? { responsiveStack } : {}),
          ...(responsiveSlot ? { responsiveSlot } : {}),
          ...(motionBlur ? { motionBlur } : {}),
          ...(diagramLayouts ? { diagramLayout: { instances: diagramLayouts } } : {}),
          ...(diagramNodes ? { diagramNode: { instances: diagramNodes } } : {}),
          ...(tempoDelay ? { tempoDelay: referenceTempoDelayInspect(tempoDelay) } : {}),
          effects: [...node.effects],
          contentHash: node.contentHash,
          source: sourceOf(node),
        };
      }),
      signals: signals.map((signal) => ({
        id: signal.id,
        kind: signal.kind,
        valueType: signal.valueType,
        entries: signal.kind === "constant" ? 1 : signal.kind === "step" ? signal.points.length : signal.kind === "keyframes" ? signal.keyframes.length : signal.events.length,
        ...(signal.kind === "track" && signal.producer ? {
          producer: {
            format: signal.producer.format,
            version: signal.producer.version,
            source: signal.producer.source,
            scope: signal.producer.scope,
            range: signal.producer.range,
            at: signal.producer.at,
            detector: signal.producer.detector,
            window: signal.producer.window,
            hop: signal.producer.hop,
            attack: signal.producer.attack,
            release: signal.producer.release,
            floor: signal.producer.floor,
            ceiling: signal.producer.ceiling,
            mapping: signal.producer.mapping,
            clock: "composition-sample-analysis-to-scene-local-track",
            preparation: "verified-locked-audio-required",
            authoredIdentity: signal.contentHash,
          },
        } : {}),
        contentHash: signal.contentHash,
      })),
    },
    resources: resources.map((resource) => ({
      id: resource.id,
      name: resource.name,
      kind: resource.kind,
      locator: resource.locator,
      ...(resource.byteAuthority ? { byteAuthority: resource.byteAuthority } : {}),
      ...(resource.streamSelection ? { authoredStreamSelection: { ...resource.streamSelection } } : {}),
      ...(resource.proxy ? {
        proxy: {
          locator: resource.proxy.locator,
          ...(resource.proxy.streamSelection ? { authoredStreamSelection: { ...resource.proxy.streamSelection } } : {}),
          ...((resource.metadata?.proxy && typeof resource.metadata.proxy === "object")
            ? (() => {
                const locked = resource.metadata!.proxy as Record<string, unknown>;
                return {
                  ...(typeof locked.sha256 === "string" ? { sha256: locked.sha256 } : {}),
                  ...(typeof locked.bytes === "number" ? { bytes: locked.bytes } : {}),
                  ...(locked.audioAlignment && typeof locked.audioAlignment === "object" ? { audioAlignment: locked.audioAlignment } : {}),
                };
              })()
            : {}),
        },
      } : {}),
      state: resource.state,
      ...(resource.sha256 ? { sha256: resource.sha256 } : {}),
      ...(lockedResourceMediaAuthorities(ir, resource) ? { selectedMedia: lockedResourceMediaAuthorities(ir, resource) } : {}),
      ...(lockedResourceVideoObservations(ir, resource) ? { selectedVideo: lockedResourceVideoObservations(ir, resource) } : {}),
    })),
    modules: ir.modules.map((module) => ({ ...module })),
    sourceModules: ir.sourceModules?.map((module) => ({ ...module })) ?? [],
    jobs: ir.jobs.map((job) => ({ id: job.id, op: job.op, effect: job.effect, state: job.state, ...(job.artifactHash ? { artifactHash: job.artifactHash } : {}) })),
    outputs: ir.outputs.map((output) => ({ id: output.id, name: output.name, op: output.op, timelineId: output.timelineId, parameters: output.parameters })),
    assertions: ir.assertions.map((assertion) => ({
      id: assertion.id,
      status: assertion.status,
      predicates: evaluateCutDomainAssertion(ir, assertion).predicates,
      ...(assertion.message ? { message: assertion.message } : {}),
    })),
    linkedEdits: (ir.linkedEdits ?? []).map((edit) => ({
      id: edit.id,
      version: edit.version,
      kind: edit.kind,
      compositionId: edit.compositionId,
      sceneId: edit.sceneId,
      linkId: edit.linkId,
      ...(edit.kind === "linked-trim" ? { keep: edit.keep } : { range: edit.range }),
      ...(edit.kind === "linked-ripple-delete" && edit.version === 2 ? { linkSegmentIds: { ...edit.linkSegmentIds } } : {}),
      pictureTrackId: edit.pictureTrackId,
      audioTrackId: edit.audioTrackId,
      source: annotationSource(edit.provenance),
    })),
    ...(ir.timelineEdits ? { timelineEdits: ir.timelineEdits.map(timelineEditInspection) } : {}),
    ...(ir.semanticMatches ? {
      semanticMatches: {
        version: ir.semanticMatches.version,
        subjects: ir.semanticMatches.subjects.map((subject) => ({
          id: subject.id,
          authoredId: subject.authoredId,
          compositionId: subject.compositionId,
          sceneId: subject.sceneId,
          cameraNodeId: subject.cameraNodeId,
          localSpaceNodeId: subject.localSpaceNodeId,
          basis: subject.basis,
          source: annotationSource(subject.provenance),
        })),
        transitions: ir.compositions.flatMap((composition) => semanticMatchInspections.get(composition.id) ?? []),
      },
    } : {}),
    transcriptMediaAuthorities: (ir.transcriptMediaAuthorities ?? []).map((authority) => ({
      id: authority.id,
      version: authority.version,
      kind: authority.kind,
      compositionId: authority.compositionId,
      sceneId: authority.sceneId,
      transcriptResourceId: authority.transcriptResourceId,
      audioResourceId: authority.audioResourceId,
      audioStreamIndex: authority.audioStreamIndex,
      videoResourceId: authority.videoResourceId,
      videoStreamIndex: authority.videoStreamIndex,
      videoFrameRate: authority.videoFrameRate,
      videoDuration: authority.videoDuration,
      audioAt: authority.audioAt,
      videoAt: authority.videoAt,
      videoRate: authority.videoRate,
      identity: authority.identity,
      source: annotationSource(authority.provenance),
    })),
    transcriptBindings: (ir.transcriptBindings ?? []).map((binding) => ({
      id: binding.id,
      version: binding.version,
      kind: binding.kind,
      compositionId: binding.compositionId,
      sceneId: binding.sceneId,
      transcriptResourceId: binding.transcriptResourceId,
      audioResourceId: binding.audioResourceId,
      from: binding.from,
      through: binding.through,
      selectedWordCount: binding.selectedWordCount,
      selectedIdsSha256: binding.selectedIdsSha256,
      text: binding.text,
      words: binding.words.map((word) => ({ ...word })),
      sourceRange: { ...binding.sourceRange },
      destinationRange: { ...binding.destinationRange },
      ...(binding.linkId === undefined ? {} : { linkId: binding.linkId }),
      ...(binding.mediaAuthorityId === undefined
        ? {}
        : { mediaAuthorityId: binding.mediaAuthorityId }),
      media: { ...binding.media },
      source: annotationSource(binding.provenance),
    })),
    ...(ir.annotations ? {
      annotations: {
        markers: ir.annotations.markers.map((marker) => ({
          id: marker.id,
          compositionId: marker.compositionId,
          ...(marker.sceneId ? { sceneId: marker.sceneId } : {}),
          at: marker.at,
          name: marker.name,
          color: marker.color,
          role: marker.role,
          comment: marker.comment,
          grid: marker.grid,
          source: annotationSource(marker.provenance),
        })),
        regions: ir.annotations.regions.map((region) => ({
          id: region.id,
          compositionId: region.compositionId,
          ...(region.sceneId ? { sceneId: region.sceneId } : {}),
          range: region.range,
          name: region.name,
          color: region.color,
          role: region.role,
          comment: region.comment,
          grid: region.grid,
          source: annotationSource(region.provenance),
        })),
      },
    } : {}),
  };
}
