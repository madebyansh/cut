import { hash } from "../core/stable";
import type {
  CutAVIR,
  IREditorial,
  IRNode,
  IRTranscriptBindingV1,
} from "./ir";
import {
  addRational,
  compareRational,
  divideRational,
  subtractRational,
  type Rational,
  zeroRational,
} from "./rational";
import {
  executeTimelineEditPlan,
  TimelineEditError,
} from "./timeline-edit-operations";

export const cutTranscriptTimelineCaptionContract = Object.freeze({
  version: 1 as const,
  policy: "canonical-transcript-timeline-caption-projection-v1" as const,
});

export type CutTranscriptTimelineCaptionWord = Readonly<{
  id: string;
  start: Rational;
  end: Rational;
  text: string;
  join: "none" | "space";
  speaker?: string;
  destinationStart: Rational;
  destinationEnd: Rational;
}>;

export type CutTranscriptTimelineCaptionProjection = Readonly<{
  version: 1;
  policy: typeof cutTranscriptTimelineCaptionContract.policy;
  bindingId: string;
  edited: boolean;
  planId?: string;
  trackId?: string;
  materializationId?: string;
  words: readonly CutTranscriptTimelineCaptionWord[];
  identity: string;
}>;

export class CutTranscriptTimelineCaptionError extends Error {
  readonly code = "CUT_TRANSCRIPT_TIMELINE_CAPTION" as const;

  constructor(message: string) {
    super(`${"CUT_TRANSCRIPT_TIMELINE_CAPTION"}: ${message}`);
    this.name = "CutTranscriptTimelineCaptionError";
  }
}

type AudioTrackNode = IRNode & {
  editorial: Extract<IREditorial, { kind: "audio-track" }>;
};

function stringInput(node: IRNode | undefined, name: string) {
  const value = node?.inputs[name];
  return value?.kind === "string" ? value.value : undefined;
}

function sameOrAfter(left: Rational, right: Rational) {
  return compareRational(left, right) >= 0;
}

function sameOrBefore(left: Rational, right: Rational) {
  return compareRational(left, right) <= 0;
}

function overlaps(
  left: Readonly<{ start: Rational; end: Rational }>,
  right: Readonly<{ start: Rational; end: Rational }>,
) {
  return compareRational(left.start, right.end) < 0
    && compareRational(left.end, right.start) > 0;
}

function baseCaptionIdentityContent(binding: IRTranscriptBindingV1) {
  return {
    selectedIdsSha256: binding.selectedIdsSha256,
    text: binding.text,
    words: binding.words,
    sourceRange: binding.sourceRange,
    destinationRange: binding.destinationRange,
  };
}

function directProjection(binding: IRTranscriptBindingV1) {
  return binding.words.map((word) => ({
    ...word,
    destinationStart: addRational(
      binding.destinationRange.start,
      subtractRational(word.start, binding.sourceRange.start),
    ),
    destinationEnd: addRational(
      binding.destinationRange.start,
      subtractRational(word.end, binding.sourceRange.start),
    ),
  }));
}

function audioTrackOwners(ir: CutAVIR, binding: IRTranscriptBindingV1) {
  return Object.values(ir.nodes).filter((node): node is AudioTrackNode =>
    node.sceneId === binding.sceneId
    && node.editorial?.kind === "audio-track"
    && node.editorial.items.some((item) =>
      stringInput(ir.nodes[item.nodeId], "transcriptBindingId") === binding.id));
}

/**
 * Project one immutable TranscriptEdit word ledger through the same canonical
 * TimelineEdit result that owns its audio. No edit is inferred from rendered
 * text or media bytes. A structural edit that cuts through a locked word is
 * rejected instead of inventing a partial token or a second caption editor.
 */
export function cutTranscriptTimelineCaptionProjection(
  ir: CutAVIR,
  binding: IRTranscriptBindingV1,
): CutTranscriptTimelineCaptionProjection {
  const owners = audioTrackOwners(ir, binding);
  const candidates = owners.flatMap((track) => {
    const trackId = track.editorial.trackId;
    if (!trackId) return [];
    return (ir.timelineEdits ?? [])
      .filter((plan) => plan.sceneId === binding.sceneId
        && plan.compositionId === binding.compositionId
        && plan.tracks.some((candidate) =>
          candidate.domain === "audio" && candidate.trackId === trackId))
      .map((plan) => ({ track, trackId, plan }));
  });
  if (!candidates.length) {
    const words = directProjection(binding);
    const content = {
      version: cutTranscriptTimelineCaptionContract.version,
      policy: cutTranscriptTimelineCaptionContract.policy,
      bindingId: binding.id,
      edited: false,
      words,
    } as const;
    return { ...content, identity: hash(content) };
  }
  if (candidates.length !== 1) {
    throw new CutTranscriptTimelineCaptionError(
      `binding ${JSON.stringify(binding.id)} must resolve to at most one canonical audio TimelineEdit; found ${candidates.length}.`,
    );
  }
  const { track, trackId, plan } = candidates[0]!;
  if (plan.operations.some((operation) =>
    operation.kind !== "split"
    && operation.kind !== "trim"
    && operation.kind !== "ripple-delete")) {
    throw new CutTranscriptTimelineCaptionError(
      `binding ${JSON.stringify(binding.id)} admits only canonical split, trim, and ripple-delete caption projection.`,
    );
  }
  const originIds = new Set(
    track.editorial.items.flatMap((item) =>
      stringInput(ir.nodes[item.nodeId], "transcriptBindingId") === binding.id
        && item.editId
        ? [item.editId]
        : []),
  );
  if (originIds.size !== 1) {
    throw new CutTranscriptTimelineCaptionError(
      `binding ${JSON.stringify(binding.id)} must preserve exactly one authenticated audio origin; found ${originIds.size}.`,
    );
  }
  let execution;
  try {
    execution = executeTimelineEditPlan(plan);
  } catch (error) {
    if (!(error instanceof TimelineEditError)) throw error;
    throw new CutTranscriptTimelineCaptionError(error.message);
  }
  const resultTrack = execution.tracks.find((candidate) =>
    candidate.domain === "audio" && candidate.trackId === trackId);
  if (!resultTrack) {
    throw new CutTranscriptTimelineCaptionError(
      `binding ${JSON.stringify(binding.id)} lost canonical audio track ${JSON.stringify(trackId)}.`,
    );
  }
  const originId = [...originIds][0]!;
  const segments = resultTrack.items
    .filter((item) => item.originId === originId)
    .map((item) => {
      if (item.sourceView.kind !== "audio") {
        throw new CutTranscriptTimelineCaptionError(
          `binding ${JSON.stringify(binding.id)} changed its authenticated audio origin kind.`,
        );
      }
      if (compareRational(item.sourceView.rate, zeroRational) <= 0) {
        throw new CutTranscriptTimelineCaptionError(
          `binding ${JSON.stringify(binding.id)} has a non-positive audio rate.`,
        );
      }
      return {
        source: item.sourceView.source,
        sourceEnd: addRational(
          item.sourceView.source.start,
          item.sourceView.source.duration,
        ),
        destination: item.destination,
        rate: item.sourceView.rate,
      };
    });
  const words: CutTranscriptTimelineCaptionWord[] = [];
  for (const word of binding.words) {
    const wordInterval = { start: word.start, end: word.end };
    const containing = segments.filter((segment) =>
      sameOrAfter(word.start, segment.source.start)
      && sameOrBefore(word.end, segment.sourceEnd));
    const intersecting = segments.filter((segment) => overlaps(wordInterval, {
      start: segment.source.start,
      end: segment.sourceEnd,
    }));
    if (intersecting.length && containing.length !== 1) {
      throw new CutTranscriptTimelineCaptionError(
        `canonical edit cuts through locked transcript word ${JSON.stringify(word.id)}; edit boundaries must preserve whole selected words.`,
      );
    }
    if (!containing.length) continue;
    if (containing.length !== 1) {
      throw new CutTranscriptTimelineCaptionError(
        `canonical edit maps locked transcript word ${JSON.stringify(word.id)} more than once.`,
      );
    }
    const segment = containing[0]!;
    words.push({
      ...word,
      destinationStart: addRational(
        segment.destination.start,
        divideRational(
          subtractRational(word.start, segment.source.start),
          segment.rate,
        ),
      ),
      destinationEnd: addRational(
        segment.destination.start,
        divideRational(
          subtractRational(word.end, segment.source.start),
          segment.rate,
        ),
      ),
    });
  }
  words.sort((left, right) =>
    compareRational(left.destinationStart, right.destinationStart)
    || left.id.localeCompare(right.id));
  for (let index = 1; index < words.length; index += 1) {
    if (compareRational(
      words[index]!.destinationStart,
      words[index - 1]!.destinationEnd,
    ) < 0) {
      throw new CutTranscriptTimelineCaptionError(
        `canonical edit produces overlapping destination words for binding ${JSON.stringify(binding.id)}.`,
      );
    }
  }
  const semantic = {
    version: cutTranscriptTimelineCaptionContract.version,
    policy: cutTranscriptTimelineCaptionContract.policy,
    bindingId: binding.id,
    edited: true,
    planId: plan.id,
    trackId,
    materializationId: execution.materializationId,
    words,
  } as const;
  return { ...semantic, identity: hash(semantic) };
}

/** Persisted caption identity: legacy direct bindings remain byte-compatible;
 * canonical TimelineEdit captions additionally bind the exact projection. */
export function cutTranscriptCaptionIdentity(
  ir: CutAVIR,
  binding: IRTranscriptBindingV1,
) {
  const base = baseCaptionIdentityContent(binding);
  const projection = cutTranscriptTimelineCaptionProjection(ir, binding);
  return projection.edited
    ? hash({ ...base, timelineEditProjectionIdentity: projection.identity })
    : hash(base);
}
