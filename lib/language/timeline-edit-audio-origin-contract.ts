/**
 * Compiler-internal persisted kernels used by canonical TimelineEdit audio
 * materialization. They are deliberately absent from the public package
 * symbol tables: authors select AudioClip/AudioRegion operands, while the
 * compiler lowers their immutable origin and unique destination views.
 */
export const cutTimelineAudioOriginOp = "cut.edit.timeline_audio_origin" as const;
export const cutTimelineAudioViewOp = "cut.edit.timeline_audio_view" as const;

export const cutTimelineAudioOriginKinds = [
  "direct-audio",
  "processed-audio",
] as const;
export type CutTimelineAudioOriginKind =
  typeof cutTimelineAudioOriginKinds[number];

export const cutTimelineAudioStatePolicies = [
  "single-authorized-evaluation",
] as const;
export type CutTimelineAudioStatePolicy =
  typeof cutTimelineAudioStatePolicies[number];

export const cutTimelineAudioFadeAnchorPolicies = [
  "origin-relative-at-presentation-zero",
] as const;
export type CutTimelineAudioFadeAnchorPolicy =
  typeof cutTimelineAudioFadeAnchorPolicies[number];

/**
 * Direct clips need only the exact union selected by the canonical result.
 * A stateful processed origin is different: changing the evaluation start can
 * change every later sample. It therefore evaluates the complete declared
 * handle domain whenever an edit consumes media outside the authored source.
 */
export const cutTimelineAudioEvaluationPolicies = [
  "selected-source-union-v1",
  "full-declared-handle-domain-v1",
] as const;
export type CutTimelineAudioEvaluationPolicy =
  typeof cutTimelineAudioEvaluationPolicies[number];

/** Closed static unary inserts admitted by the processed external-handle path.
 * TimeStretch is additionally constrained to one innermost constant processor
 * directly above AudioClip; every other entry may appear only outside it. */
export const cutTimelineProcessedExternalHandleProcessorOps = Object.freeze([
  "cut.audio.gain",
  "cut.audio.pan",
  "cut.audio.eq",
  "cut.audio.highpass",
  "cut.audio.lowpass",
  "cut.audio.compressor",
  "cut.audio.deesser",
  "cut.audio.time_stretch",
] as const);

export const cutTimelineAudioEvaluationLimits = Object.freeze({
  maximumSourceSamplesPerOrigin: 16_777_216,
  maximumAggregateSourceSamples: 67_108_864,
  maximumAggregateProcessorSampleWork: 268_435_456,
});

export const cutTimelineAudioOriginInputs = [
  "originKind",
  "originTrackId",
  "originAuthorityId",
  "sourceAuthorityId",
  "graphAuthorityId",
  "originDuration",
  "rate",
  "statePolicy",
  "evaluationSource",
  "presentationZero",
  "fadeAnchorPolicy",
  "evaluationPolicy",
] as const;

export const cutTimelineAudioViewInputs = [
  "origin",
  "originKind",
  "originTrackId",
  "originAuthorityId",
  "sourceAuthorityId",
  "graphAuthorityId",
  "originDuration",
  "rate",
  "sliceOffset",
  "headHandle",
  "tailHandle",
  "source",
  "statePolicy",
  "link",
  "evaluationSource",
  "presentationZero",
  "fadeAnchorPolicy",
  "evaluationPolicy",
] as const;
