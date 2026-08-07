import { hash } from "../core/stable";
import {
  executeTimelineEditPlan,
  type TimelineEditSourceView,
  type TimelineEditExecutionV1,
  type TimelineEditPlanV1,
} from "./timeline-edit-operations";
import type { Rational } from "./rational";
import type { IREditorialInterval } from "./ir";
import type { CutTimelineAudioEvaluationPolicy } from "./timeline-edit-audio-origin-contract";

function withoutProvenance(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutProvenance);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== "provenance")
        .map(([key, item]) => [key, withoutProvenance(item)]),
    );
  }
  return value;
}

/**
 * Canonical authored TimelineEdit meaning. Source spans are retained in
 * CutAVIR evidence and diagnostics but cannot make an otherwise identical
 * edit miss semantic/build/cache identity.
 */
export function timelineEditPlanSemanticIdentity(plan: TimelineEditPlanV1) {
  return withoutProvenance(plan) as Omit<TimelineEditPlanV1, "provenance">;
}

/**
 * Identity available while a loaded plan is still being validated. It binds
 * every authored executable degree of freedom without replaying the plan.
 * Replay remains a separate fail-closed runtime/inspect boundary: graph hash
 * finalization must be able to seal hostile test artifacts so the strict
 * loader can issue the intended source-specific diagnostic.
 */
export function timelineEditGraphIdentity(plan: TimelineEditPlanV1) {
  const semantic = Object.freeze({
    format: "cut-timeline-edit-graph-identity" as const,
    version: 1 as const,
    plan: timelineEditPlanSemanticIdentity(plan),
  });
  return Object.freeze({ ...semantic, identity: hash(semantic) });
}

function timelineEditExecutionSemanticIdentity(execution: TimelineEditExecutionV1) {
  const semantic = withoutProvenance(execution) as Record<string, unknown>;
  // The public materializationId historically includes operation/item source
  // provenance. Derive the cache/build identity from the closed semantic
  // execution instead of laundering source-location evidence through it.
  delete semantic.materializationId;
  return semantic;
}

/**
 * One exact plan/result identity used by graph and localized cache projection.
 * Replaying here is intentional: invalid or forged plans fail before an
 * identity can authorize reuse.
 */
export function timelineEditExecutableIdentity(plan: TimelineEditPlanV1) {
  const execution = executeTimelineEditPlan(plan);
  const semantic = Object.freeze({
    format: "cut-timeline-edit-executable-identity" as const,
    version: 1 as const,
    plan: timelineEditPlanSemanticIdentity(plan),
    execution: timelineEditExecutionSemanticIdentity(execution),
  });
  return Object.freeze({
    ...semantic,
    semanticMaterializationId: hash(semantic),
  });
}

export type TimelineEditAudioOriginAuthorityContentV1 = Readonly<{
  planId: string;
  materializationId: string;
  trackId: string;
  originId: string;
  sourceRootId: string;
  sourceAuthorityId: string;
  graphAuthorityId?: string;
  originDuration: Rational;
  fadeIn: Rational;
  fadeOut: Rational;
  rate: Rational;
  evaluationEnvelope?: TimelineEditAudioEvaluationEnvelopeV1;
}>;

export type TimelineEditAudioEvaluationEnvelopeV1 = Readonly<{
  /** Exact source-clock interval evaluated once for the immutable origin. */
  source: IREditorialInterval;
  /** Destination-clock distance from evaluation start to authored fade zero. */
  presentationZero: Rational;
  fadeAnchorPolicy: "origin-relative-at-presentation-zero";
  evaluationPolicy: CutTimelineAudioEvaluationPolicy;
}>;

/**
 * One shared compiler/runtime identity for a single-evaluation audio origin.
 * Segment placement, source slice and link identity deliberately live on
 * views; changing any origin graph, fade, rate, or source authority creates a
 * different preparation/cache authority.
 */
export function timelineEditAudioOriginAuthorityId(
  value: TimelineEditAudioOriginAuthorityContentV1,
) {
  return hash({
    format: "cut-timeline-edit-audio-origin-authority",
    version: 1,
    ...value,
  });
}

export function timelineEditAudioOriginAuthorityContent(
  planId: string,
  materializationId: string,
  trackId: string,
  originId: string,
  sourceRootId: string,
  view: Extract<TimelineEditSourceView, { kind: "audio" | "processed-audio" }>,
  evaluationEnvelope?: TimelineEditAudioEvaluationEnvelopeV1,
): TimelineEditAudioOriginAuthorityContentV1 {
  return Object.freeze({
    planId,
    materializationId,
    trackId,
    originId,
    sourceRootId,
    sourceAuthorityId: view.authorityId,
    ...(view.kind === "processed-audio"
      ? { graphAuthorityId: view.graphAuthorityId }
      : {}),
    originDuration: view.presentationClock.originDuration,
    fadeIn: view.fadeIn,
    fadeOut: view.fadeOut,
    rate: view.rate,
    ...(evaluationEnvelope ? { evaluationEnvelope } : {}),
  });
}
