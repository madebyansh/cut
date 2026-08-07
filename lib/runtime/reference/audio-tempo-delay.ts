import { createHash } from "node:crypto";
import { hash } from "../../core/stable";
import {
  addRational,
  compareRational,
  divideRational,
  multiplyRational,
  rational,
  rationalToNumber,
  subtractRational,
  zeroRational,
  type Rational,
} from "../../language/rational";

const mapFormat = "cut-reference-tempo-map" as const;
const mapVersion = 1 as const;
const delayFormat = "cut-reference-tempo-delay-plan" as const;
const delayVersion = 1 as const;

export const referenceTempoDelayLimits = Object.freeze({
  minimumSampleRate: 8_000,
  maximumSampleRate: 192_000,
  maximumTempoPoints: 256,
  minimumBpm: 20,
  maximumBpm: 400,
  maximumDelayBeats: 16,
  maximumFeedback: 0.95,
  maximumNodesPerComposition: 16,
  maximumFrames: 28_800_000,
  maximumChannelSamples: 57_600_000,
  maximumTotalProcessedFrames: 57_600_000,
  maximumAbsoluteInputSample: 64,
  maximumAbsoluteInternalSample: 2_048,
});

export const referenceTempoDelayNonClaims = Object.freeze([
  "tempo detection",
  "beat or onset detection",
  "groove, shuffle, or swing timing",
  "pitch-synchronized echoes",
  "fractional-delay modulation or Doppler effects",
  "portable floating-point byte identity across JavaScript engines",
] as const);

export type ReferenceTempoPoint = Readonly<{
  at: Rational;
  bpm: Rational;
}>;

export type ReferenceTempoSegment = Readonly<{
  index: number;
  startFrame: number;
  endFrame: number;
  startTime: Rational;
  endTime: Rational;
  startBeat: Rational;
  endBeat: Rational;
  bpm: Rational;
}>;

export type ReferenceTempoMap = Readonly<{
  format: typeof mapFormat;
  version: typeof mapVersion;
  sampleRate: number;
  totalFrames: number;
  points: readonly ReferenceTempoPoint[];
  segments: readonly ReferenceTempoSegment[];
  integrity: string;
}>;

export type ReferenceTempoDelaySpan = Readonly<{
  startFrame: number;
  endFrame: number;
  destinationTempoIndex: number;
  sourceTempoIndex: number;
  sourceFrameAtStart: Rational;
  sourceFramesPerDestinationFrame: Rational;
}>;

export type ReferenceTempoDelayPlan = Readonly<{
  format: typeof delayFormat;
  version: typeof delayVersion;
  tempo: ReferenceTempoMap;
  delayBeats: Rational;
  feedback: number;
  mix: number;
  firstEchoFrame: number;
  spans: readonly ReferenceTempoDelaySpan[];
  algorithm: "causal-recursive-stereo-f32-linear-fractional-read-v1";
  integrity: string;
}>;

export type ReferenceTempoDelayResult = Readonly<{
  samples: Float32Array;
  frames: number;
  processedFrames: number;
  delayedFrames: number;
  maximumAbsoluteOutputSample: number;
  integrity: string;
}>;

export type ReferenceTempoDelayErrorCode =
  | "CUT_AUDIO_TEMPO_MAP_TYPE"
  | "CUT_AUDIO_TEMPO_MAP_VALUE"
  | "CUT_AUDIO_TEMPO_MAP_ORDER"
  | "CUT_AUDIO_TEMPO_MAP_SAMPLE_GRID"
  | "CUT_AUDIO_TEMPO_DELAY_TYPE"
  | "CUT_AUDIO_TEMPO_DELAY_VALUE"
  | "CUT_AUDIO_TEMPO_DELAY_CAUSALITY"
  | "CUT_AUDIO_TEMPO_DELAY_RESOURCE"
  | "CUT_AUDIO_TEMPO_DELAY_PCM";

export class ReferenceTempoDelayError extends Error {
  constructor(readonly code: ReferenceTempoDelayErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "ReferenceTempoDelayError";
  }
}

function fail(code: ReferenceTempoDelayErrorCode, message: string): never {
  throw new ReferenceTempoDelayError(code, message);
}

function plainRecord(value: unknown, keys: readonly string[], code: ReferenceTempoDelayErrorCode, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code, `${label} must be one plain data object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code, `${label} must have a plain or null prototype.`);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) fail(code, `${label} cannot contain symbol properties.`);
  const actual = (ownKeys as string[]).sort(), expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(code, `${label} must contain exactly ${expected.join(", ")}; unknown or missing properties are refused.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value), result = Object.create(null) as Record<string, unknown>;
  for (const key of expected) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !("value" in descriptor)) fail(code, `${label}.${key} must be an enumerable data property.`);
    result[key] = descriptor.value;
  }
  return result;
}

function exactRational(value: unknown, code: ReferenceTempoDelayErrorCode, label: string) {
  const record = plainRecord(value, ["numerator", "denominator"], code, label);
  if (typeof record.numerator !== "string" || !/^-?(?:0|[1-9][0-9]*)$/u.test(record.numerator)) fail(code, `${label}.numerator must be a canonical integer string.`);
  if (typeof record.denominator !== "string" || !/^[1-9][0-9]*$/u.test(record.denominator)) fail(code, `${label}.denominator must be a positive canonical integer string.`);
  let canonical: Rational;
  try { canonical = rational(record.numerator, record.denominator); }
  catch { fail(code, `${label} is not a valid exact rational.`); }
  if (canonical.numerator !== record.numerator || canonical.denominator !== record.denominator) fail(code, `${label} must be reduced to canonical form.`);
  return canonical;
}

function safeInteger(value: unknown, minimum: number, maximum: number, code: ReferenceTempoDelayErrorCode, label: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(code, `${label} must be a safe integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function finiteNumber(value: unknown, minimum: number, maximum: number, code: ReferenceTempoDelayErrorCode, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    fail(code, `${label} must be a finite number from ${minimum} through ${maximum}.`);
  }
  return value;
}

function exactFrame(value: Rational, sampleRate: number, code: ReferenceTempoDelayErrorCode, label: string) {
  const frames = multiplyRational(value, rational(sampleRate));
  if (frames.denominator !== "1") fail(code, `${label} does not land on the ${sampleRate} Hz destination sample grid.`);
  const frame = Number(frames.numerator);
  if (!Number.isSafeInteger(frame)) fail(code, `${label} has an unsafe destination sample position.`);
  return frame;
}

function ceilRational(value: Rational) {
  const numerator = BigInt(value.numerator), denominator = BigInt(value.denominator);
  const quotient = numerator / denominator, remainder = numerator % denominator;
  const result = remainder === 0n || numerator < 0n ? quotient : quotient + 1n;
  const number = Number(result);
  if (!Number.isSafeInteger(number)) fail("CUT_AUDIO_TEMPO_DELAY_RESOURCE", "tempo lookup produced an unsafe sample position.");
  return number;
}

function beatDelta(time: Rational, bpm: Rational) {
  return divideRational(multiplyRational(time, bpm), rational(60));
}

function timeDelta(beats: Rational, bpm: Rational) {
  return divideRational(multiplyRational(beats, rational(60)), bpm);
}

function segmentFrameAtBeat(segment: ReferenceTempoSegment, beat: Rational, sampleRate: number) {
  return addRational(
    rational(segment.startFrame),
    multiplyRational(timeDelta(subtractRational(beat, segment.startBeat), segment.bpm), rational(sampleRate)),
  );
}

/**
 * Compile a piecewise-constant destination-clock tempo map. The first point
 * must be exactly zero. A point owns the sample at its boundary: the previous
 * BPM integrates only over [previous.at, point.at), and the new BPM starts at
 * point.at. Tempo points are control metadata, never inferred from audio.
 */
export function compileReferenceTempoMap(input: Readonly<{
  sampleRate: number;
  totalFrames: number;
  points: readonly ReferenceTempoPoint[];
}>): ReferenceTempoMap {
  const record = plainRecord(input, ["sampleRate", "totalFrames", "points"], "CUT_AUDIO_TEMPO_MAP_TYPE", "tempo map");
  const sampleRate = safeInteger(record.sampleRate, referenceTempoDelayLimits.minimumSampleRate, referenceTempoDelayLimits.maximumSampleRate, "CUT_AUDIO_TEMPO_MAP_VALUE", "tempo map sampleRate");
  const totalFrames = safeInteger(record.totalFrames, 1, referenceTempoDelayLimits.maximumFrames, "CUT_AUDIO_TEMPO_DELAY_RESOURCE", "tempo map totalFrames");
  if (!Array.isArray(record.points)) fail("CUT_AUDIO_TEMPO_MAP_TYPE", "tempo map points must be one frozen-order list.");
  if (record.points.length < 1 || record.points.length > referenceTempoDelayLimits.maximumTempoPoints) {
    fail("CUT_AUDIO_TEMPO_MAP_VALUE", `tempo map must contain 1 through ${referenceTempoDelayLimits.maximumTempoPoints} points.`);
  }
  const points = record.points.map((candidate, index) => {
    const point = plainRecord(candidate, ["at", "bpm"], "CUT_AUDIO_TEMPO_MAP_TYPE", `tempo point ${index}`);
    const at = exactRational(point.at, "CUT_AUDIO_TEMPO_MAP_TYPE", `tempo point ${index}.at`);
    const bpm = exactRational(point.bpm, "CUT_AUDIO_TEMPO_MAP_TYPE", `tempo point ${index}.bpm`);
    const bpmNumber = rationalToNumber(bpm);
    if (!Number.isFinite(bpmNumber) || bpmNumber < referenceTempoDelayLimits.minimumBpm || bpmNumber > referenceTempoDelayLimits.maximumBpm) {
      fail("CUT_AUDIO_TEMPO_MAP_VALUE", `tempo point ${index}.bpm must stay between ${referenceTempoDelayLimits.minimumBpm} and ${referenceTempoDelayLimits.maximumBpm}.`);
    }
    const frame = exactFrame(at, sampleRate, "CUT_AUDIO_TEMPO_MAP_SAMPLE_GRID", `tempo point ${index}.at`);
    if (frame < 0 || frame >= totalFrames) fail("CUT_AUDIO_TEMPO_MAP_VALUE", `tempo point ${index}.at must lie inside the half-open composition sample range.`);
    return Object.freeze({ at, bpm, frame });
  });
  if (points[0]!.frame !== 0) fail("CUT_AUDIO_TEMPO_MAP_ORDER", "tempo map must begin with exactly one point at 0s.");
  for (let index = 1; index < points.length; index += 1) {
    if (points[index]!.frame <= points[index - 1]!.frame) fail("CUT_AUDIO_TEMPO_MAP_ORDER", `tempo point ${index}.at must be strictly later than the previous point.`);
  }

  let startBeat = zeroRational;
  const segments: ReferenceTempoSegment[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]!, next = points[index + 1];
    const endFrame = next?.frame ?? totalFrames;
    const endTime = rational(endFrame, sampleRate);
    const endBeat = addRational(startBeat, beatDelta(subtractRational(endTime, point.at), point.bpm));
    segments.push(Object.freeze({
      index,
      startFrame: point.frame,
      endFrame,
      startTime: point.at,
      endTime,
      startBeat,
      endBeat,
      bpm: point.bpm,
    }));
    startBeat = endBeat;
  }
  const publicPoints = points.map(({ at, bpm }) => Object.freeze({ at, bpm }));
  const semantic = { format: mapFormat, version: mapVersion, sampleRate, totalFrames, points: publicPoints, segments };
  return Object.freeze({ ...semantic, points: Object.freeze(publicPoints), segments: Object.freeze(segments), integrity: hash(semantic) });
}

function tempoSegmentAtFrame(tempo: ReferenceTempoMap, frame: number) {
  let low = 0, high = tempo.segments.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2), segment = tempo.segments[middle]!;
    if (frame < segment.startFrame) high = middle - 1;
    else if (frame >= segment.endFrame) low = middle + 1;
    else return segment;
  }
  return undefined;
}

function tempoSegmentAtBeat(tempo: ReferenceTempoMap, beat: Rational) {
  let low = 0, high = tempo.segments.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2), segment = tempo.segments[middle]!;
    if (compareRational(beat, segment.startBeat) < 0) high = middle - 1;
    else if (compareRational(beat, segment.endBeat) >= 0) low = middle + 1;
    else return segment;
  }
  return undefined;
}

/** Exact continuous beat position at a destination sample boundary. */
export function referenceTempoBeatAtFrame(tempo: ReferenceTempoMap, frame: number) {
  const checked = safeInteger(frame, 0, tempo.totalFrames, "CUT_AUDIO_TEMPO_MAP_VALUE", "destination frame");
  if (checked === tempo.totalFrames) return tempo.segments.at(-1)!.endBeat;
  const segment = tempoSegmentAtFrame(tempo, checked);
  if (!segment) fail("CUT_AUDIO_TEMPO_MAP_ORDER", `destination frame ${checked} is not covered by the tempo map.`);
  const elapsed = rational(checked - segment.startFrame, tempo.sampleRate);
  return addRational(segment.startBeat, beatDelta(elapsed, segment.bpm));
}

/** Exact fractional destination frame for one covered beat position. */
export function referenceTempoFrameAtBeat(tempo: ReferenceTempoMap, beatInput: Rational) {
  const beat = exactRational(beatInput, "CUT_AUDIO_TEMPO_MAP_TYPE", "beat position");
  if (compareRational(beat, zeroRational) < 0 || compareRational(beat, tempo.segments.at(-1)!.endBeat) > 0) return undefined;
  if (compareRational(beat, tempo.segments.at(-1)!.endBeat) === 0) return rational(tempo.totalFrames);
  const segment = tempoSegmentAtBeat(tempo, beat);
  return segment ? segmentFrameAtBeat(segment, beat, tempo.sampleRate) : undefined;
}

function validateTempoMapIntegrity(tempo: ReferenceTempoMap) {
  const candidate = compileReferenceTempoMap({ sampleRate: tempo.sampleRate, totalFrames: tempo.totalFrames, points: tempo.points });
  if (candidate.integrity !== tempo.integrity) fail("CUT_AUDIO_TEMPO_MAP_TYPE", "tempo map does not match its canonical integrity identity.");
  return candidate;
}

/**
 * Compile one causal recursive delay topology. For destination sample n, CUT
 * subtracts delayBeats from the exact destination beat clock, inverts that
 * beat through the same tempo map, and linearly reads the already-computed
 * stereo feedback state. Tempo changes therefore alter later delay spacing
 * without restarting the line or changing pre-boundary samples.
 */
export function compileReferenceTempoDelayPlan(input: Readonly<{
  tempo: ReferenceTempoMap;
  delayBeats: Rational;
  feedback: number;
  mix: number;
}>): ReferenceTempoDelayPlan {
  const record = plainRecord(input, ["tempo", "delayBeats", "feedback", "mix"], "CUT_AUDIO_TEMPO_DELAY_TYPE", "tempo delay");
  if (!record.tempo || typeof record.tempo !== "object") fail("CUT_AUDIO_TEMPO_DELAY_TYPE", "tempo delay tempo must be one compiled tempo map.");
  const tempo = validateTempoMapIntegrity(record.tempo as ReferenceTempoMap);
  const delayBeats = exactRational(record.delayBeats, "CUT_AUDIO_TEMPO_DELAY_TYPE", "tempo delay beats");
  if (compareRational(delayBeats, zeroRational) <= 0 || compareRational(delayBeats, rational(referenceTempoDelayLimits.maximumDelayBeats)) > 0) {
    fail("CUT_AUDIO_TEMPO_DELAY_VALUE", `tempo delay beats must be greater than zero and at most ${referenceTempoDelayLimits.maximumDelayBeats}.`);
  }
  const feedback = finiteNumber(record.feedback, 0, referenceTempoDelayLimits.maximumFeedback, "CUT_AUDIO_TEMPO_DELAY_VALUE", "tempo delay feedback");
  const mix = finiteNumber(record.mix, Number.MIN_VALUE, 1, "CUT_AUDIO_TEMPO_DELAY_VALUE", "tempo delay mix");
  const fastest = tempo.points.reduce((maximum, point) => compareRational(point.bpm, maximum) > 0 ? point.bpm : maximum, tempo.points[0]!.bpm);
  const minimumDelayFrames = multiplyRational(timeDelta(delayBeats, fastest), rational(tempo.sampleRate));
  if (compareRational(minimumDelayFrames, rational(1)) < 0) {
    fail("CUT_AUDIO_TEMPO_DELAY_CAUSALITY", "tempo delay must remain at least one destination sample behind the current output under every authored BPM.");
  }
  const finalBeat = tempo.segments.at(-1)!.endBeat;
  if (compareRational(delayBeats, finalBeat) >= 0) {
    fail("CUT_AUDIO_TEMPO_DELAY_VALUE", "tempo delay has no audible echo inside the composition; its first echo must precede the output boundary.");
  }

  const spans: ReferenceTempoDelaySpan[] = [];
  for (const destination of tempo.segments) {
    for (const source of tempo.segments) {
      const lowerBeat = addRational(source.startBeat, delayBeats);
      const upperBeat = addRational(source.endBeat, delayBeats);
      if (compareRational(upperBeat, destination.startBeat) <= 0 || compareRational(lowerBeat, destination.endBeat) >= 0) continue;
      const clippedLower = compareRational(lowerBeat, destination.startBeat) > 0 ? lowerBeat : destination.startBeat;
      const clippedUpper = compareRational(upperBeat, destination.endBeat) < 0 ? upperBeat : destination.endBeat;
      const startFrame = Math.max(destination.startFrame, ceilRational(segmentFrameAtBeat(destination, clippedLower, tempo.sampleRate)));
      const endFrame = Math.min(destination.endFrame, ceilRational(segmentFrameAtBeat(destination, clippedUpper, tempo.sampleRate)));
      if (startFrame >= endFrame) continue;
      const destinationBeat = referenceTempoBeatAtFrame(tempo, startFrame);
      const sourceBeat = subtractRational(destinationBeat, delayBeats);
      const sourceFrameAtStart = segmentFrameAtBeat(source, sourceBeat, tempo.sampleRate);
      const sourceFramesPerDestinationFrame = divideRational(destination.bpm, source.bpm);
      if (compareRational(sourceFrameAtStart, rational(startFrame - 1)) > 0) {
        fail("CUT_AUDIO_TEMPO_DELAY_CAUSALITY", `tempo span beginning at frame ${startFrame} can read an uncomputed current sample.`);
      }
      spans.push(Object.freeze({
        startFrame,
        endFrame,
        destinationTempoIndex: destination.index,
        sourceTempoIndex: source.index,
        sourceFrameAtStart,
        sourceFramesPerDestinationFrame,
      }));
    }
  }
  spans.sort((left, right) => left.startFrame - right.startFrame);
  for (let index = 1; index < spans.length; index += 1) {
    if (spans[index - 1]!.endFrame !== spans[index]!.startFrame) {
      fail("CUT_AUDIO_TEMPO_MAP_ORDER", "compiled tempo-delay lookup spans contain a gap or overlap after the first audible echo.");
    }
  }
  if (!spans.length) fail("CUT_AUDIO_TEMPO_DELAY_VALUE", "tempo delay produced no executable echo span.");
  const firstEchoFrame = spans[0]!.startFrame;
  const semantic = {
    format: delayFormat,
    version: delayVersion,
    tempoIntegrity: tempo.integrity,
    delayBeats,
    feedback,
    mix,
    firstEchoFrame,
    spans,
    algorithm: "causal-recursive-stereo-f32-linear-fractional-read-v1" as const,
  };
  return Object.freeze({
    format: delayFormat,
    version: delayVersion,
    tempo,
    delayBeats,
    feedback,
    mix,
    firstEchoFrame,
    spans: Object.freeze(spans),
    algorithm: semantic.algorithm,
    integrity: hash(semantic),
  });
}

function sourceFrameAt(span: ReferenceTempoDelaySpan, frame: number) {
  return addRational(
    span.sourceFrameAtStart,
    multiplyRational(rational(frame - span.startFrame), span.sourceFramesPerDestinationFrame),
  );
}

/** Exact lookup exposed for boundary/counterfactual tests and inspect evidence. */
export function referenceTempoDelaySourceFrameAt(plan: ReferenceTempoDelayPlan, frame: number) {
  const checked = safeInteger(frame, 0, plan.tempo.totalFrames - 1, "CUT_AUDIO_TEMPO_DELAY_VALUE", "tempo delay destination frame");
  let low = 0, high = plan.spans.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2), span = plan.spans[middle]!;
    if (checked < span.startFrame) high = middle - 1;
    else if (checked >= span.endFrame) low = middle + 1;
    else return sourceFrameAt(span, checked);
  }
  return undefined;
}

function interpolatedState(state: Float32Array, frame: number, channel: 0 | 1, currentFrame: number) {
  const lower = Math.floor(frame);
  if (!Number.isSafeInteger(lower) || lower < 0) fail("CUT_AUDIO_TEMPO_DELAY_CAUSALITY", "tempo delay produced an invalid historical read index.");
  const fraction = frame - lower;
  const upper = fraction === 0 ? lower : lower + 1;
  if (upper >= currentFrame) fail("CUT_AUDIO_TEMPO_DELAY_CAUSALITY", `tempo delay attempted to read uncomputed frame ${upper} while producing ${currentFrame}.`);
  const lowerValue = state[lower * 2 + channel]!;
  if (fraction === 0) return lowerValue;
  return Math.fround(lowerValue + (state[upper * 2 + channel]! - lowerValue) * fraction);
}

/** Execute the bounded recursive line in CUT-owned stereo float32. */
export function processReferenceTempoDelayStereo(input: Float32Array, planInput: ReferenceTempoDelayPlan): ReferenceTempoDelayResult {
  if (!(input instanceof Float32Array)) fail("CUT_AUDIO_TEMPO_DELAY_PCM", "tempo delay input must be one Float32Array.");
  const plan = compileReferenceTempoDelayPlan({
    tempo: planInput.tempo,
    delayBeats: planInput.delayBeats,
    feedback: planInput.feedback,
    mix: planInput.mix,
  });
  if (plan.integrity !== planInput.integrity) fail("CUT_AUDIO_TEMPO_DELAY_TYPE", "tempo delay plan does not match its canonical integrity identity.");
  const frames = input.length / 2;
  if (!Number.isSafeInteger(frames) || frames !== plan.tempo.totalFrames) {
    fail("CUT_AUDIO_TEMPO_DELAY_PCM", `tempo delay requires exactly ${plan.tempo.totalFrames} interleaved stereo frames.`);
  }
  const channelSamples = frames * 2;
  if (channelSamples > referenceTempoDelayLimits.maximumChannelSamples) {
    fail("CUT_AUDIO_TEMPO_DELAY_RESOURCE", `tempo delay requires ${channelSamples} channel-samples; maximum is ${referenceTempoDelayLimits.maximumChannelSamples}.`);
  }
  const state = new Float32Array(input.length), output = new Float32Array(input.length);
  // Exact rationals establish every span and its boundary. The hot sample
  // loop converts each affine span once to IEEE-754 and evaluates
  // start + delta * slope directly (never by cumulative addition), keeping
  // long-form rendering linear-time without boundary drift.
  const runtimeSpans = plan.spans.map((span) => ({
    ...span,
    sourceFrameAtStartNumber: rationalToNumber(span.sourceFrameAtStart),
    sourceFramesPerDestinationFrameNumber: rationalToNumber(span.sourceFramesPerDestinationFrame),
  }));
  let spanIndex = 0, delayedFrames = 0, maximumAbsoluteOutputSample = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    while (spanIndex < runtimeSpans.length && frame >= runtimeSpans[spanIndex]!.endFrame) spanIndex += 1;
    const span = runtimeSpans[spanIndex];
    const sourceFrame = span && frame >= span.startFrame && frame < span.endFrame
      ? span.sourceFrameAtStartNumber + (frame - span.startFrame) * span.sourceFramesPerDestinationFrameNumber
      : undefined;
    if (sourceFrame !== undefined) delayedFrames += 1;
    for (const channel of [0, 1] as const) {
      const inputSample = input[frame * 2 + channel]!;
      if (!Number.isFinite(inputSample) || Math.abs(inputSample) > referenceTempoDelayLimits.maximumAbsoluteInputSample) {
        fail("CUT_AUDIO_TEMPO_DELAY_PCM", `tempo delay input sample ${frame}:${channel} exceeds the finite ±${referenceTempoDelayLimits.maximumAbsoluteInputSample} PCM bound.`);
      }
      const delayed = sourceFrame === undefined ? 0 : interpolatedState(state, sourceFrame, channel, frame);
      const feedbackSample = Math.fround(inputSample + Math.fround(plan.feedback * delayed));
      if (!Number.isFinite(feedbackSample) || Math.abs(feedbackSample) > referenceTempoDelayLimits.maximumAbsoluteInternalSample) {
        fail("CUT_AUDIO_TEMPO_DELAY_PCM", `tempo delay feedback state exceeded the finite ±${referenceTempoDelayLimits.maximumAbsoluteInternalSample} PCM bound at ${frame}:${channel}.`);
      }
      state[frame * 2 + channel] = feedbackSample;
      const sample = Math.fround(Math.fround((1 - plan.mix) * inputSample) + Math.fround(plan.mix * delayed));
      if (!Number.isFinite(sample)) fail("CUT_AUDIO_TEMPO_DELAY_PCM", `tempo delay produced a non-finite output at ${frame}:${channel}.`);
      output[frame * 2 + channel] = sample;
      maximumAbsoluteOutputSample = Math.max(maximumAbsoluteOutputSample, Math.abs(sample));
    }
  }
  const outputBytes = Buffer.from(output.buffer, output.byteOffset, output.byteLength);
  const semantic = {
    algorithm: plan.algorithm,
    planIntegrity: plan.integrity,
    frames,
    processedFrames: frames,
    delayedFrames,
    maximumAbsoluteOutputSample,
    outputSha256: createHash("sha256").update(outputBytes).digest("hex"),
  };
  return Object.freeze({
    samples: output,
    frames,
    processedFrames: frames,
    delayedFrames,
    maximumAbsoluteOutputSample,
    integrity: hash(semantic),
  });
}
