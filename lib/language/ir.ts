import type { SourceSpan } from "./ast";
import type { EffectKind, NodeDomain } from "./packages";
import type { Rational } from "./rational";
import type { IRPictureTrackOperationPlan, IRPictureTrackTransitionStyle } from "./picture-edit-operations";
import type { AudioEditCrossfadeCurve, AudioEditOperationPlan } from "./audio-edit-operations";
import type { EditorialAnnotations, EditorialMarker, EditorialRegion } from "./editorial-annotations";
import type { cutAnchoredSpatialOps } from "./anchored-path-contract";
import type { ReferenceComplexTextBackendIdentity } from "./dependency-identity";
import type { TimelineEditPlanV1 } from "./timeline-edit-operations";
import type { CutTypedDataAssetAuthorityV1 } from "./typed-data-asset";
import {
  type CutTimelineAudioFadeAnchorPolicy,
  type CutTimelineAudioEvaluationPolicy,
  cutTimelineAudioOriginOp,
  cutTimelineAudioViewOp,
  type CutTimelineAudioOriginKind,
  type CutTimelineAudioStatePolicy,
} from "./timeline-edit-audio-origin-contract";

export type IRProvenance = {
  module: string;
  span: SourceSpan;
  symbol?: string;
  expandedFrom?: Array<{ module: string; span: SourceSpan; symbol: string }>;
};

export type IRTimelineMarker = EditorialMarker<IRProvenance>;
export type IRTimelineRegion = EditorialRegion<IRProvenance>;
export type IRTimelineAnnotations = EditorialAnnotations<IRProvenance>;

/**
 * One scene-local retained subject admitted to the bounded semantic-match v1
 * contract. `id` is compiler-owned; `authoredId` is the opaque public handle
 * used by MatchTransition. The basis is copied from the subject's sole direct
 * LocalSpace child so a loaded IR cannot substitute inferred pixel bounds.
 */
export type IRSemanticMatchSubjectV1 = {
  id: string;
  version: 1;
  kind: "semantic-match-subject";
  compositionId: string;
  sceneId: string;
  authoredId: string;
  cameraNodeId: string;
  localSpaceNodeId: string;
  basis: {
    width: number;
    height: number;
    origin: { x: Rational; y: Rational };
  };
  provenance: IRProvenance;
};

/** One centered, visual-only match across an exact adjacent-scene hard cut. */
export type IRSemanticMatchTransitionV1 = {
  id: string;
  version: 1;
  kind: "semantic-match-transition";
  compositionId: string;
  authoredId: string;
  cut: Rational;
  duration: Rational;
  outgoingWindow: IREditorialInterval;
  incomingWindow: IREditorialInterval;
  outgoing: {
    sceneId: string;
    subjectId: string;
    cameraNodeId: string;
    localSpaceNodeId: string;
  };
  incoming: {
    sceneId: string;
    subjectId: string;
    cameraNodeId: string;
    localSpaceNodeId: string;
  };
  target: {
    x: Rational;
    y: Rational;
    scale: Rational;
    rotation: Rational;
    color?: string;
  };
  easing: "linear" | "inCubic" | "outCubic" | "inOutCubic";
  velocity?: "settle" | "carry";
  provenance: IRProvenance;
};

/** Optional as a whole; an empty section is never canonical. */
export type IRSemanticMatchesV1 = {
  version: 1;
  subjects: IRSemanticMatchSubjectV1[];
  transitions: IRSemanticMatchTransitionV1[];
};

/**
 * One non-rendering, scene-scoped transaction that atomically materializes a
 * shared destination trim on an explicitly linked picture/audio pair.
 */
export type IRLinkedTrim = {
  id: string;
  version: 1;
  kind: "linked-trim";
  compositionId: string;
  sceneId: string;
  linkId: string;
  /** Scene-local half-open destination interval retained on both tracks. */
  keep: IREditorialInterval;
  pictureTrackId: string;
  audioTrackId: string;
  provenance: IRProvenance;
};

/**
 * One fixed-duration ripple closure. The compiler resolves `range` from the
 * complete direct linked pair; authors cannot supply a second competing range.
 * Two correlated operations per track insert tail closure before deleting this
 * scene-local interval, so later material shifts while scene duration is fixed.
 */
export type IRLinkedRippleDeleteV1 = {
  id: string;
  version: 1;
  kind: "linked-ripple-delete";
  compositionId: string;
  sceneId: string;
  linkId: string;
  /** Scene-local half-open destination interval removed from both tracks. */
  range: IREditorialInterval;
  pictureTrackId: string;
  audioTrackId: string;
  provenance: IRProvenance;
};

/**
 * One partial, J/L-aware linked ripple deletion. The authored link remains the
 * relationship group; the two deterministic segment identities correlate the
 * surviving picture/audio fragments on either side of the removed range.
 */
export type IRLinkedRippleDeleteV2 = {
  id: string;
  version: 2;
  kind: "linked-ripple-delete";
  compositionId: string;
  sceneId: string;
  linkId: string;
  /** Scene-local strict proper subrange removed from both linked members. */
  range: IREditorialInterval;
  linkSegmentIds: { before: string; after: string };
  pictureTrackId: string;
  audioTrackId: string;
  provenance: IRProvenance;
};

export type IRLinkedRippleDelete = IRLinkedRippleDeleteV1 | IRLinkedRippleDeleteV2;

export type IRLinkedEdit = IRLinkedTrim | IRLinkedRippleDelete;

export type IRCallValue = {
  kind: "call";
  op: string;
  positional: IRValue[];
  named: Record<string, IRValue>;
  effect: EffectKind;
};

export type IRValue =
  | { kind: "null" }
  | { kind: "boolean"; value: boolean }
  | { kind: "string"; value: string }
  | { kind: "color"; value: string }
  | { kind: "quantity"; dimension: string; magnitude: Rational; unit: string }
  | { kind: "array"; items: IRValue[] }
  | { kind: "object"; entries: Record<string, IRValue> }
  | { kind: "range"; start: IRValue; end: IRValue; exclusive: boolean }
  | { kind: "node-ref"; id: string }
  | { kind: "resource-ref"; id: string }
  | { kind: "timeline-ref"; id: string }
  | { kind: "symbol"; name: string }
  | { kind: "unary"; operator: string; value: IRValue }
  | { kind: "binary"; operator: string; left: IRValue; right: IRValue }
  | { kind: "member"; object: IRValue; property: string }
  | { kind: "index"; object: IRValue; index: IRValue }
  | IRCallValue;

/**
 * Compiler-authenticated public ImageSequenceAsset value. The manifest and
 * every member remain ordinary independently locked resources; this closed
 * value supplies their exact order and declared picture clock without adding
 * a filename-pattern or host-directory interpretation to CutAVIR.
 */
export type IRImageSequenceAssetV1 = Extract<IRValue, { kind: "object" }> & {
  entries: {
    format: Extract<IRValue, { kind: "string" }> & { value: "cut-image-sequence-source" };
    version: Extract<IRValue, { kind: "quantity" }>;
    manifest: Extract<IRValue, { kind: "resource-ref" }>;
    frames: Extract<IRValue, { kind: "array" }> & { items: Array<Extract<IRValue, { kind: "resource-ref" }>> };
    width: Extract<IRValue, { kind: "quantity" }>;
    height: Extract<IRValue, { kind: "quantity" }>;
    frameRate: Extract<IRValue, { kind: "quantity" }>;
    frameCount: Extract<IRValue, { kind: "quantity" }>;
  };
};

type IRNodeReferenceValue = Extract<IRValue, { kind: "node-ref" }>;
type IRArrayValue = Extract<IRValue, { kind: "array" }>;
type IRLengthValue = Extract<IRValue, { kind: "quantity" }>;

export type IRSpatialVec2V1 = Extract<IRValue, { kind: "object" }> & {
  entries: { x: IRLengthValue; y: IRLengthValue };
};

/** Persisted public v1 spatial values. These remain ordinary IRValue calls so
 * graph traversal, semantic diff, cache identity, and inspect all see the
 * owner node reference recursively without a private side table. */
export type IRVisualAnchorV1 = IRCallValue & {
  op: typeof cutAnchoredSpatialOps.visualAnchor;
  positional: [];
  named: { owner: IRNodeReferenceValue; local: IRValue };
  effect: "pure";
};

export type IRCompositionOffsetV1 = IRCallValue & {
  op: typeof cutAnchoredSpatialOps.compositionOffset;
  positional: [];
  named: { point: IRSpatialPointV1; by: IRValue };
  effect: "pure";
};

export type IRSpatialPointV1 = IRSpatialVec2V1 | IRVisualAnchorV1 | IRCompositionOffsetV1;

export type IRAnchoredLinePathSegmentV1 = IRCallValue & {
  op: typeof cutAnchoredSpatialOps.anchoredLineTo;
  positional: [];
  named: { to: IRSpatialPointV1 };
  effect: "pure";
};

export type IRAnchoredCubicPathSegmentV1 = IRCallValue & {
  op: typeof cutAnchoredSpatialOps.anchoredCubicTo;
  positional: [];
  named: { control1: IRSpatialPointV1; control2: IRSpatialPointV1; to: IRSpatialPointV1 };
  effect: "pure";
};

export type IRAnchoredPathSegmentV1 = IRAnchoredLinePathSegmentV1 | IRAnchoredCubicPathSegmentV1;

export type IRAnchoredPathGeometryV1 = IRCallValue & {
  op: typeof cutAnchoredSpatialOps.anchoredPath;
  positional: [];
  named: {
    start: IRSpatialPointV1;
    segments: IRArrayValue & { items: IRAnchoredPathSegmentV1[] };
    closed: Extract<IRValue, { kind: "boolean" }>;
  };
  effect: "pure";
};

export type IRResource = {
  id: string;
  name: string;
  kind: "video" | "audio" | "image" | "font" | "data";
  /**
   * Optional compiler-owned semantic contract for caption/transcript/LUT
   * bytes. The outer kind stays `data`; legacy data() omits this field.
   */
  byteAuthority?: CutTypedDataAssetAuthorityV1;
  locator: string;
  /** Explicit absolute ffprobe/ffmpeg stream indexes for the authored master. */
  streamSelection?: { video?: number; audio?: number };
  /** Authored project-relative preview variant; only valid for video/audio. */
  proxy?: { locator: string; streamSelection?: { video?: number; audio?: number } };
  state: "unlocked" | "locked";
  sha256?: string;
  metadata?: Record<string, unknown>;
  provenance: IRProvenance;
};

export type IREditorialInterval = { start: Rational; duration: Rational };

/** One selected word copied from an authenticated cut-transcript v1 sidecar. */
export type IRTranscriptWordV1 = {
  id: string;
  start: Rational;
  end: Rational;
  text: string;
  /** Separator before this word in the source transcript. */
  join: "none" | "space";
  speaker?: string;
};

/** Media authority copied from the selected transcript sidecar. */
export type IRTranscriptMediaV1 = {
  sha256: string;
  audioStreamIndex: number;
  audioSampleRate: number;
  duration: Rational;
  /** Optional video provenance is an all-or-nothing pair, not a word-time grid. */
  videoStreamIndex?: number;
  videoFrameRate?: Rational;
  /** Optional independent selected-video duration authority. */
  videoDuration?: Rational;
  /**
   * Exact audio presentation anchor minus video presentation anchor.
   * Absence is canonical zero; a persisted value must be nonzero.
   */
  audioVideoPresentationDelta?: Rational;
};

/**
 * Authenticated affine relationship between one transcript/audio clock and an
 * independently declared video clock. It is compile-time authority only:
 * executable picture remains an ordinary locked PictureClip.
 */
export type IRTranscriptMediaAuthorityV1 = {
  id: string;
  identity: string;
  version: 1;
  kind: "transcript-media-authority";
  compositionId: string;
  sceneId: string;
  transcriptResourceId: string;
  audioResourceId: string;
  audioStreamIndex: number;
  videoResourceId: string;
  videoStreamIndex: number;
  videoFrameRate: Rational;
  videoDuration: Rational;
  /** Audio-clock anchor in seconds. */
  audioAt: Rational;
  /** Video-clock anchor in seconds. */
  videoAt: Rational;
  /** Video-clock seconds per audio-clock second. */
  videoRate: Rational;
  provenance: IRProvenance;
};

/**
 * One deterministic inclusive transcript selection. It is non-rendering
 * typed evidence shared by later public audio and caption consumers.
 */
export type IRTranscriptBindingV1 = {
  id: string;
  version: 1;
  kind: "transcript-edit";
  compositionId: string;
  sceneId: string;
  transcriptResourceId: string;
  audioResourceId: string;
  from: string;
  through: string;
  selectedWordCount: number;
  selectedIdsSha256: string;
  text: string;
  words: IRTranscriptWordV1[];
  sourceRange: IREditorialInterval;
  /** Scene-local destination interval. */
  destinationRange: IREditorialInterval;
  linkId?: string;
  /** Optional independent picture-clock authority; omission is legacy v1. */
  mediaAuthorityId?: string;
  media: IRTranscriptMediaV1;
  provenance: IRProvenance;
};

export type IRPictureTimeMap =
  | { kind: "constant"; direction: "forward" | "reverse"; rate: Rational; frameSelection?: "nearest" | "frame-blend" }
  | { kind: "freeze"; at: Rational; frameSelection?: "frame-blend" }
  | {
      kind: "speed-ramp";
      interpolation: "linear-rate";
      frameSelection: "floor" | "nearest" | "frame-blend";
      points: Array<{ at: Rational; rate: Rational }>;
    };

export type IREditorial =
  | {
      kind: "sequence";
      tracks: Array<{ nodeId: string; order: number; destination: IREditorialInterval }>;
    }
  | {
      kind: "picture-track";
      /** Stable authored selector identity; omission preserves legacy track IR. */
      trackId?: string;
      /** Optional closed editorial role and string metadata. */
      role?: string;
      metadata?: Readonly<Record<string, string>>;
      operationPlan?: IRPictureTrackOperationPlan;
      transitions?: Array<{
        cut: Rational;
        duration: Rational;
        overlap: IREditorialInterval;
        outgoingNodeId: string;
        incomingNodeId: string;
        outgoingSource: IREditorialInterval;
        incomingSource: IREditorialInterval;
        style: IRPictureTrackTransitionStyle;
        provenance: IRProvenance;
      }>;
      items: Array<{
        nodeId: string;
        order: number;
        kind: "picture" | "gap";
        destination: IREditorialInterval;
        source?: IREditorialInterval;
        timeMap?: IRPictureTimeMap;
        linkId?: string;
        /** Stable authored selection identity; omission preserves legacy item IR. */
        editId?: string;
        role?: string;
        metadata?: Readonly<Record<string, string>>;
        /** Compiler-derived pair identity within one authored link group. */
        linkSegmentId?: string;
      }>;
    }
  | {
      kind: "audio-track";
      /** Stable authored selector identity; omission preserves legacy track IR. */
      trackId?: string;
      /** Optional closed editorial role and string metadata. */
      role?: string;
      metadata?: Readonly<Record<string, string>>;
      operationPlan?: AudioEditOperationPlan;
      transitions?: Array<{
        cut: Rational;
        duration: Rational;
        overlap: IREditorialInterval;
        outgoingNodeId: string;
        incomingNodeId: string;
        outgoingSource: IREditorialInterval;
        incomingSource: IREditorialInterval;
        curve: AudioEditCrossfadeCurve;
        provenance: IRProvenance;
      }>;
      items: Array<{
        nodeId: string;
        /** Exact media leaf for processed regions; omitted only when nodeId is the direct AudioClip. */
        sourceNodeId?: string;
        order: number;
        kind: "audio" | "gap";
        destination: IREditorialInterval;
        source?: IREditorialInterval;
        linkId?: string;
        /** Stable authored selection identity; omission preserves legacy item IR. */
        editId?: string;
        role?: string;
        metadata?: Readonly<Record<string, string>>;
        /** Compiler-derived pair identity within one authored link group. */
        linkSegmentId?: string;
      }>;
    };

export type IRNode = {
  id: string;
  op: string;
  domain: NodeDomain;
  ownership: "root" | "child" | "reference" | "detached";
  sceneId?: string;
  interval: { start: Rational; duration: Rational };
  editorial?: IREditorial;
  inputs: Record<string, IRValue>;
  children: string[];
  properties: Record<string, IRValue | { signal: string }>;
  effects: EffectKind[];
  contentHash: string;
  provenance: IRProvenance;
};

type IRStringValue = Extract<IRValue, { kind: "string" }>;
type IRTimeQuantityValue = Extract<IRValue, { kind: "quantity" }> & {
  dimension: "time";
  unit: "s";
};
type IRScalarQuantityValue = Extract<IRValue, { kind: "quantity" }> & {
  dimension: "scalar";
  unit: "scalar";
};
type IRTimeRangeValue = Extract<IRValue, { kind: "range" }> & {
  start: IRTimeQuantityValue;
  end: IRTimeQuantityValue;
  exclusive: true;
};

/**
 * One immutable compiler-owned audio origin. It structurally owns the exact
 * original AudioClip or AudioRegion graph and is reached only by node-ref from
 * materialized destination views. It is not a public CUT package symbol.
 */
export type IRTimelineAudioOriginNodeV1 = Omit<
  IRNode,
  "op" | "domain" | "ownership" | "inputs" | "children" | "properties"
> & {
  op: typeof cutTimelineAudioOriginOp;
  domain: "audio";
  ownership: "reference";
  inputs: {
    originKind: IRStringValue & { value: CutTimelineAudioOriginKind };
    originAuthorityId: IRStringValue;
    sourceAuthorityId: IRStringValue;
    graphAuthorityId?: IRStringValue;
    originDuration: IRTimeQuantityValue;
    rate: IRScalarQuantityValue;
    statePolicy: IRStringValue & { value: CutTimelineAudioStatePolicy };
    evaluationSource?: IRTimeRangeValue;
    presentationZero?: IRTimeQuantityValue;
    fadeAnchorPolicy?: IRStringValue & { value: CutTimelineAudioFadeAnchorPolicy };
    evaluationPolicy?: IRStringValue & { value: CutTimelineAudioEvaluationPolicy };
  };
  children: [string];
  properties: Record<string, never>;
};

/**
 * One unique compiler-owned AudioTrack child view into an immutable origin.
 * The node interval is the exact destination authority; inputs retain the
 * independently authenticated source slice and origin-relative state clock.
 */
export type IRTimelineAudioViewNodeV1 = Omit<
  IRNode,
  "op" | "domain" | "ownership" | "inputs" | "children" | "properties"
> & {
  op: typeof cutTimelineAudioViewOp;
  domain: "audio";
  ownership: "child";
  inputs: {
    origin: IRNodeReferenceValue;
    originKind: IRStringValue & { value: CutTimelineAudioOriginKind };
    originAuthorityId: IRStringValue;
    sourceAuthorityId: IRStringValue;
    graphAuthorityId?: IRStringValue;
    originDuration: IRTimeQuantityValue;
    rate: IRScalarQuantityValue;
    sliceOffset: IRTimeQuantityValue;
    headHandle: IRTimeQuantityValue;
    tailHandle: IRTimeQuantityValue;
    source: IRTimeRangeValue;
    statePolicy: IRStringValue & { value: CutTimelineAudioStatePolicy };
    link?: IRStringValue;
    evaluationSource?: IRTimeRangeValue;
    presentationZero?: IRTimeQuantityValue;
    fadeAnchorPolicy?: IRStringValue & { value: CutTimelineAudioFadeAnchorPolicy };
    evaluationPolicy?: IRStringValue & { value: CutTimelineAudioEvaluationPolicy };
  };
  children: [];
  properties: Record<string, never>;
};

export type IRSignalEvent =
  | { kind: "set"; time: Rational; value: IRValue }
  | { kind: "animate"; start: Rational; end: Rational; from: IRValue; to: IRValue; curve: IRValue };

/**
 * Closed public producer for one causal amplitude-derived property track.
 * `at` is scene-local while `range` addresses the selected source. Runtime
 * preparation resolves both against the explicitly named composition/scene;
 * no project name, node kind, or renderer-private payload is involved.
 */
export type IRAudioAmplitudeProducer = {
  format: "cut-audio-amplitude-producer";
  version: 1;
  source: { kind: "resource-ref"; id: string };
  scope: { compositionId: string; sceneId: string };
  /** Half-open selected source interval. */
  range: { start: Rational; end: Rational };
  /** Scene-local placement of range.start. */
  at: Rational;
  detector: "peak" | "rms";
  window: Rational;
  hop: Rational;
  attack: Rational;
  release: Rational;
  /** Exact detector-linear amplitude bounds. */
  floor: Rational;
  ceiling: Rational;
  mapping: { kind: "linear"; from: IRValue; to: IRValue };
};

export type IRSignal =
  | { id: string; kind: "constant"; valueType: string; value: IRValue; contentHash: string; provenance: IRProvenance }
  | { id: string; kind: "step"; valueType: string; points: Array<{ time: Rational; value: IRValue }>; contentHash: string; provenance: IRProvenance }
  | { id: string; kind: "keyframes"; valueType: string; keyframes: Array<{ time: Rational; value: IRValue; curve: IRValue }>; contentHash: string; provenance: IRProvenance }
  | { id: string; kind: "track"; valueType: string; initial: IRValue; events: IRSignalEvent[]; producer?: IRAudioAmplitudeProducer; contentHash: string; provenance: IRProvenance };

export type IRScene = {
  id: string;
  name: string;
  start: Rational;
  duration: Rational;
  rootVisualIds: string[];
  rootAudioIds: string[];
  rootAVIds: string[];
  items: Array<{ id: string; domain: NodeDomain }>;
  provenance: IRProvenance;
};

export type IRComposition = {
  id: string;
  name: string;
  width: number;
  height: number;
  fps: Rational;
  sampleRate: number;
  duration: Rational;
  sceneIds: string[];
  rootVisualIds: string[];
  rootAudioIds: string[];
  rootAVIds: string[];
  items: Array<{ kind: "scene"; id: string } | { kind: "node"; id: string; domain: NodeDomain }>;
  provenance: IRProvenance;
};

export type IRAssertion = { id: string; expression: IRValue; message?: string; status: "pass" | "fail" | "deferred"; provenance: IRProvenance };
export type IREffectJob = { id: string; effect: Exclude<EffectKind, "pure" | "read">; op: string; inputs: Record<string, IRValue>; state: "unresolved" | "locked"; artifactHash?: string; provenance: IRProvenance };
export type IROutput = { id: string; name: string; op: string; timelineId: string; parameters: Record<string, IRValue>; provenance: IRProvenance };

export type CutAVIR = {
  format: "cut-av-ir";
  version: 3;
  language: "0.4";
  compiler: string;
  project: string;
  sourceHash: string;
  buildId: string;
  determinism: {
    semantic: "locked" | "unlocked";
    decodedMedia: "unverified" | "verified";
    bitstream: "unverified" | "verified";
  };
  timebase: { defaultFps: Rational; audioSampleRate: number };
  modules: Array<{ specifier: string; version: string; integrity: string }>;
  /** Exact user-authored module bytes; absent preserves legacy single-file IR encoding. */
  sourceModules?: Array<{ specifier: string; sha256: string; bytes: number }>;
  /**
   * Feature-scoped executable authorities. Absence is canonical so projects
   * without the feature retain the historical five-package backend record.
   */
  features?: {
    complexTextShaping: ReferenceComplexTextBackendIdentity;
  };
  resources: Record<string, IRResource>;
  compositions: IRComposition[];
  scenes: Record<string, IRScene>;
  nodes: Record<string, IRNode>;
  signals: Record<string, IRSignal>;
  jobs: IREffectJob[];
  outputs: IROutput[];
  assertions: IRAssertion[];
  /**
   * Typed non-rendering timeline annotations. Absence is canonical for sources
   * without Marker/Region statements so pre-extension IR identity is stable.
   */
  annotations?: IRTimelineAnnotations;
  /**
   * Typed non-rendering linked editorial transactions. Absence is canonical;
   * an empty collection must never be serialized.
   */
  linkedEdits?: IRLinkedEdit[];
  /**
   * Canonical scene-local nonlinear edit plans. Absence is canonical; an empty
   * collection must never be serialized so legacy projects retain omission
   * compatibility.
   */
  timelineEdits?: TimelineEditPlanV1[];
  /**
   * Typed, non-rendering semantic-match declarations. Absence is canonical so
   * projects that do not use the feature retain their pre-extension identity.
   */
  semanticMatches?: IRSemanticMatchesV1;
  /**
   * Typed transcript selections shared by public editorial consumers.
   * Absence is canonical; an empty collection must never be serialized.
   */
  transcriptBindings?: IRTranscriptBindingV1[];
  /**
   * Authenticated independent transcript/audio/video clock transforms.
   * Absence is canonical; an empty collection must never be serialized.
   */
  transcriptMediaAuthorities?: IRTranscriptMediaAuthorityV1[];
};
