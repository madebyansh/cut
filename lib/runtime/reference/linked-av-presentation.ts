import type { LockedResourceProbe } from "../../language/lock";
import {
  CutMediaPresentationPlanError,
  linkedAvPresentationPlan,
  type CutLinkedAvPresentationPlan,
  type CutMediaVariant,
} from "../../language/media-presentation";
import { compareRational, rational, type Rational } from "../../language/rational";
import type { CutAVIR, IRComposition, IRNode } from "../../language/ir";

export type ReferenceLinkedClipAudioExecutionPlan = Readonly<{
  format: "cut-reference-linked-clip-audio-execution";
  version: 1;
  presentation: CutLinkedAvPresentationPlan;
  destinationSamples: string;
  decoderInput: Readonly<{
    resourceId: string;
    variant: CutMediaVariant;
    sourceStartSamples: string;
    sourceEndSamples: string;
    destinationStartSamples: string;
    destinationSamples: string;
  }> | null;
}>;

function fail(node: IRNode, variant: CutMediaVariant, message: string): never {
  throw new CutMediaPresentationPlanError("CUT_MEDIA_PRESENTATION_OFFSET_METADATA", node, variant, message);
}

function pictureSourceStart(node: IRNode, variant: CutMediaVariant): Rational {
  const range = node.inputs.range;
  if (range === undefined) return rational(0);
  if (range.kind !== "range" || !range.exclusive || range.start.kind !== "quantity" || range.start.dimension !== "time") {
    return fail(node, variant, "source range is not one exact half-open picture-relative Time interval");
  }
  return range.start.magnitude;
}

/** Resolve one locked selected variant into the canonical linked-A/V plan. */
export function referenceLinkedAvPresentationPlan(
  ir: CutAVIR,
  composition: IRComposition,
  node: IRNode,
): CutLinkedAvPresentationPlan {
  const source = node.inputs.source;
  const resource = source?.kind === "resource-ref" ? ir.resources[source.id] : undefined;
  const metadata = resource?.metadata as { probe?: LockedResourceProbe; activeMediaVariant?: unknown } | undefined;
  const variant: CutMediaVariant = metadata?.activeMediaVariant === "proxy" ? "proxy" : "master";
  if (node.op !== "cut.edit.clip" || source?.kind !== "resource-ref" || resource?.kind !== "video") {
    return fail(node, variant, "source must resolve to one locked VideoAsset");
  }
  if (metadata?.activeMediaVariant !== undefined && metadata.activeMediaVariant !== "master" && metadata.activeMediaVariant !== "proxy") {
    return fail(node, variant, "active media variant is not master or proxy");
  }
  const probe = metadata?.probe;
  if (probe?.kind !== "media" || !probe.selected.video || !probe.selected.audio) {
    return fail(node, variant, "requires one lock-selected picture stream and source-audio stream");
  }
  const video = probe.identity.streams.find((candidate) => candidate.type === "video" && candidate.index === probe.selected.video?.streamIndex);
  const audio = probe.identity.streams.find((candidate) => candidate.type === "audio" && candidate.index === probe.selected.audio?.streamIndex);
  const witness = probe.selected.audio.decodedAudioSamples;
  if (!video?.start || !audio?.timeBase || !audio.sampleRate || !witness) {
    return fail(node, variant, "requires exact video start plus decoded-audio presentation and duration evidence");
  }
  if (witness.streamIndex !== audio.index || witness.sampleRate !== audio.sampleRate
    || compareRational(witness.timeBase, audio.timeBase) !== 0
    || compareRational(probe.selected.audio.timeBase, audio.timeBase) !== 0) {
    return fail(node, variant, "decoded-audio presentation evidence does not match the selected audio stream");
  }
  return linkedAvPresentationPlan({
    node,
    variant,
    videoAnchor: video.start,
    audioWitness: witness,
    audioDuration: probe.selected.audio.duration,
    pictureSourceStart: pictureSourceStart(node, variant),
    pictureDuration: node.interval.duration,
    destinationSampleRate: composition.sampleRate,
  });
}

/**
 * Closed audio-backend handoff for one linked Clip. A null decoderInput is
 * executable all-silence, not a request to open and discard the media stream.
 * The reference audio renderer consumes this exact object.
 */
export function referenceLinkedClipAudioExecutionPlan(
  ir: CutAVIR,
  composition: IRComposition,
  node: IRNode,
): ReferenceLinkedClipAudioExecutionPlan {
  const presentation = referenceLinkedAvPresentationPlan(ir, composition, node);
  const source = node.inputs.source;
  if (source?.kind !== "resource-ref") return fail(node, presentation.variant, "source must resolve to one locked VideoAsset");
  const decoderInput = presentation.media ? Object.freeze({
    resourceId: source.id,
    variant: presentation.variant,
    sourceStartSamples: presentation.samples.decoderSourceStartSamples!,
    sourceEndSamples: presentation.samples.decoderSourceEndSamples!,
    destinationStartSamples: presentation.samples.leadingSilenceDestinationSamples,
    destinationSamples: presentation.samples.mediaDestinationSamples,
  }) : null;
  return Object.freeze({
    format: "cut-reference-linked-clip-audio-execution",
    version: 1,
    presentation,
    destinationSamples: presentation.samples.pictureDurationDestinationSamples,
    decoderInput,
  });
}
