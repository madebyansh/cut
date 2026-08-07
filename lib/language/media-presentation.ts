import type { CutDecodedAudioSamples } from "./audio-sample-witness";
import type { IRNode } from "./ir";
import {
  addRational,
  compareRational,
  multiplyRational,
  rational,
  subtractRational,
  type Rational,
  zeroRational,
} from "./rational";

export type CutMediaVariant = "master" | "proxy";

export type CutLinkedAvPresentationPlan = Readonly<{
  format: "cut-linked-av-presentation-plan";
  version: 1;
  method: "picture-relative-audio-intersection-v1";
  variant: CutMediaVariant;
  videoAnchor: Rational;
  audioAnchor: Rational;
  delta: Rational;
  pictureSource: Readonly<{ start: Rational; duration: Rational; end: Rational }>;
  audioCoverage: Readonly<{ start: Rational; duration: Rational; end: Rational }>;
  intersection: Readonly<{ start: Rational; duration: Rational; end: Rational; hasMedia: boolean }>;
  leadingSilence: Rational;
  trailingSilence: Rational;
  media: Readonly<{
    decoderSourceStart: Rational;
    decoderSourceDuration: Rational;
    decoderSourceEnd: Rational;
    destinationStart: Rational;
    destinationDuration: Rational;
    destinationEnd: Rational;
  }> | null;
  samples: Readonly<{
    sourceSampleRate: number;
    destinationSampleRate: number;
    deltaSourceSamples: string;
    deltaDestinationSamples: string;
    pictureDurationDestinationSamples: string;
    leadingSilenceDestinationSamples: string;
    mediaDestinationSamples: string;
    trailingSilenceDestinationSamples: string;
    decoderSourceStartSamples: string | null;
    decoderSourceEndSamples: string | null;
  }>;
}>;

export type CutMediaPresentationPlanErrorCode =
  | "CUT_MEDIA_PRESENTATION_OFFSET_METADATA"
  | "CUT_MEDIA_PRESENTATION_OFFSET_GRID"
  | "CUT_MEDIA_PRESENTATION_OFFSET_LIMIT";

/** Stable, source-located refusal for malformed or unrepresentable offsets. */
export class CutMediaPresentationPlanError extends Error {
  readonly source: { module: string; line: number; column: number; nodeId: string; resourceId?: string };

  constructor(
    readonly code: CutMediaPresentationPlanErrorCode,
    readonly node: IRNode,
    readonly variant: CutMediaVariant,
    message: string,
  ) {
    const { module, span } = node.provenance;
    const authoredSource = node.inputs.source;
    const resourceId = authoredSource?.kind === "resource-ref" ? authoredSource.id : undefined;
    super(`${code}: Linked Clip selected ${variant} ${message} at ${module}:${span.start.line}:${span.start.column}.`);
    this.name = "CutMediaPresentationPlanError";
    this.source = { module, line: span.start.line, column: span.start.column, nodeId: node.id, ...(resourceId ? { resourceId } : {}) };
  }
}

function planFail(node: IRNode, variant: CutMediaVariant, code: CutMediaPresentationPlanErrorCode, message: string): never {
  throw new CutMediaPresentationPlanError(code, node, variant, message);
}

function canonicalRational(node: IRNode, variant: CutMediaVariant, value: Rational, label: string, positive = false) {
  try {
    const canonical = rational(value.numerator, value.denominator);
    if (canonical.numerator !== value.numerator || canonical.denominator !== value.denominator
      || (positive && compareRational(canonical, zeroRational) <= 0)) throw new Error("not canonical");
    return canonical;
  } catch {
    return planFail(node, variant, "CUT_MEDIA_PRESENTATION_OFFSET_METADATA", `${label} is not one canonical${positive ? " positive" : ""} exact rational`);
  }
}

function exactSampleCount(
  node: IRNode,
  variant: CutMediaVariant,
  value: Rational,
  sampleRate: number,
  label: string,
  allowNegative = false,
) {
  const exact = multiplyRational(value, rational(sampleRate));
  if (exact.denominator !== "1") {
    planFail(node, variant, "CUT_MEDIA_PRESENTATION_OFFSET_GRID", `${label} ${value.numerator}/${value.denominator}s does not land on the ${sampleRate} Hz sample grid`);
  }
  const count = BigInt(exact.numerator);
  if ((!allowNegative && count < 0n) || count > BigInt(Number.MAX_SAFE_INTEGER) || count < BigInt(Number.MIN_SAFE_INTEGER)) {
    planFail(node, variant, "CUT_MEDIA_PRESENTATION_OFFSET_LIMIT", `${label} has an unsafe ${sampleRate} Hz sample position`);
  }
  return String(count);
}

function later(left: Rational, right: Rational) { return compareRational(left, right) >= 0 ? left : right; }
function earlier(left: Rational, right: Rational) { return compareRational(left, right) <= 0 ? left : right; }

/**
 * Derive linked source-audio coverage on the picture-relative source clock.
 * No media is invented outside the exact intersection: uncovered samples are
 * deterministic silence and the Clip's authored destination length is fixed.
 */
export function linkedAvPresentationPlan(input: Readonly<{
  node: IRNode;
  variant: CutMediaVariant;
  videoAnchor: Rational;
  audioWitness: CutDecodedAudioSamples;
  audioDuration: Rational;
  pictureSourceStart: Rational;
  pictureDuration: Rational;
  destinationSampleRate: number;
}>): CutLinkedAvPresentationPlan {
  const { node, variant, audioWitness } = input;
  const videoAnchor = canonicalRational(node, variant, input.videoAnchor, "video presentation anchor");
  const audioTimeBase = canonicalRational(node, variant, audioWitness.timeBase, "audio witness time base", true);
  const audioDuration = canonicalRational(node, variant, input.audioDuration, "decoded audio duration", true);
  const pictureStart = canonicalRational(node, variant, input.pictureSourceStart, "picture source start");
  const pictureDuration = canonicalRational(node, variant, input.pictureDuration, "picture duration", true);
  if (compareRational(pictureStart, zeroRational) < 0) {
    planFail(node, variant, "CUT_MEDIA_PRESENTATION_OFFSET_METADATA", "picture source start cannot be negative");
  }
  if (!Number.isSafeInteger(audioWitness.sampleRate) || audioWitness.sampleRate < 1
    || !Number.isSafeInteger(input.destinationSampleRate) || input.destinationSampleRate < 1) {
    planFail(node, variant, "CUT_MEDIA_PRESENTATION_OFFSET_METADATA", "requires positive safe source and destination sample rates");
  }
  if (!/^-?(?:0|[1-9]\d*)$/u.test(audioWitness.firstPts) || audioWitness.firstPts === "-0"
    || !/^[1-9]\d*$/u.test(audioWitness.decodedSampleCount)) {
    planFail(node, variant, "CUT_MEDIA_PRESENTATION_OFFSET_METADATA", "audio witness PTS/sample count is not canonical");
  }
  const witnessedDuration = rational(audioWitness.decodedSampleCount, audioWitness.sampleRate);
  if (compareRational(witnessedDuration, audioDuration) !== 0) {
    planFail(node, variant, "CUT_MEDIA_PRESENTATION_OFFSET_METADATA", "decoded audio duration does not equal decodedSampleCount/sampleRate");
  }

  const audioAnchor = multiplyRational(rational(audioWitness.firstPts), audioTimeBase);
  const delta = subtractRational(audioAnchor, videoAnchor);
  const pictureEnd = addRational(pictureStart, pictureDuration);
  const coverageEnd = addRational(delta, audioDuration);
  exactSampleCount(node, variant, delta, audioWitness.sampleRate, "delta(audio-video)", true);
  exactSampleCount(node, variant, delta, input.destinationSampleRate, "delta(audio-video)", true);
  exactSampleCount(node, variant, pictureStart, input.destinationSampleRate, "picture source start");
  const pictureDurationDestinationSamples = exactSampleCount(node, variant, pictureDuration, input.destinationSampleRate, "picture duration");

  const candidateStart = later(pictureStart, delta), candidateEnd = earlier(pictureEnd, coverageEnd);
  const hasMedia = compareRational(candidateStart, candidateEnd) < 0;
  let intersectionStart: Rational, intersectionEnd: Rational, leadingSilence: Rational, trailingSilence: Rational;
  if (hasMedia) {
    intersectionStart = candidateStart; intersectionEnd = candidateEnd;
    leadingSilence = subtractRational(intersectionStart, pictureStart);
    trailingSilence = subtractRational(pictureEnd, intersectionEnd);
  } else if (compareRational(delta, pictureEnd) >= 0) {
    intersectionStart = pictureEnd; intersectionEnd = pictureEnd;
    leadingSilence = pictureDuration; trailingSilence = zeroRational;
  } else {
    intersectionStart = pictureStart; intersectionEnd = pictureStart;
    leadingSilence = zeroRational; trailingSilence = pictureDuration;
  }
  const intersectionDuration = subtractRational(intersectionEnd, intersectionStart);
  exactSampleCount(node, variant, intersectionStart, input.destinationSampleRate, "audio intersection start");
  exactSampleCount(node, variant, intersectionEnd, input.destinationSampleRate, "audio intersection end");
  const leadingSilenceDestinationSamples = exactSampleCount(node, variant, leadingSilence, input.destinationSampleRate, "leading silence");
  const mediaDestinationSamples = exactSampleCount(node, variant, intersectionDuration, input.destinationSampleRate, "intersected audio duration");
  const trailingSilenceDestinationSamples = exactSampleCount(node, variant, trailingSilence, input.destinationSampleRate, "trailing silence");

  let media: CutLinkedAvPresentationPlan["media"] = null;
  let decoderSourceStartSamples: string | null = null, decoderSourceEndSamples: string | null = null;
  if (hasMedia) {
    const decoderSourceStart = subtractRational(intersectionStart, delta);
    const decoderSourceEnd = subtractRational(intersectionEnd, delta);
    const destinationStart = leadingSilence, destinationEnd = addRational(destinationStart, intersectionDuration);
    decoderSourceStartSamples = exactSampleCount(node, variant, decoderSourceStart, audioWitness.sampleRate, "decoder source start");
    decoderSourceEndSamples = exactSampleCount(node, variant, decoderSourceEnd, audioWitness.sampleRate, "decoder source end");
    if (compareRational(decoderSourceStart, zeroRational) < 0 || compareRational(decoderSourceEnd, audioDuration) > 0) {
      planFail(node, variant, "CUT_MEDIA_PRESENTATION_OFFSET_METADATA", "derived decoder source intersection lies outside decoded audio");
    }
    media = Object.freeze({
      decoderSourceStart,
      decoderSourceDuration: intersectionDuration,
      decoderSourceEnd,
      destinationStart,
      destinationDuration: intersectionDuration,
      destinationEnd,
    });
  }
  if (BigInt(leadingSilenceDestinationSamples) + BigInt(mediaDestinationSamples) + BigInt(trailingSilenceDestinationSamples)
    !== BigInt(pictureDurationDestinationSamples)) {
    planFail(node, variant, "CUT_MEDIA_PRESENTATION_OFFSET_METADATA", "derived silence and media sample counts do not close over the Clip duration");
  }

  return Object.freeze({
    format: "cut-linked-av-presentation-plan",
    version: 1,
    method: "picture-relative-audio-intersection-v1",
    variant,
    videoAnchor,
    audioAnchor,
    delta,
    pictureSource: Object.freeze({ start: pictureStart, duration: pictureDuration, end: pictureEnd }),
    audioCoverage: Object.freeze({ start: delta, duration: audioDuration, end: coverageEnd }),
    intersection: Object.freeze({ start: intersectionStart, duration: intersectionDuration, end: intersectionEnd, hasMedia }),
    leadingSilence,
    trailingSilence,
    media,
    samples: Object.freeze({
      sourceSampleRate: audioWitness.sampleRate,
      destinationSampleRate: input.destinationSampleRate,
      deltaSourceSamples: exactSampleCount(node, variant, delta, audioWitness.sampleRate, "delta(audio-video)", true),
      deltaDestinationSamples: exactSampleCount(node, variant, delta, input.destinationSampleRate, "delta(audio-video)", true),
      pictureDurationDestinationSamples,
      leadingSilenceDestinationSamples,
      mediaDestinationSamples,
      trailingSilenceDestinationSamples,
      decoderSourceStartSamples,
      decoderSourceEndSamples,
    }),
  });
}
