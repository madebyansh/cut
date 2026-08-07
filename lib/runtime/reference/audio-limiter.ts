import { createHash } from "node:crypto";
import type { ReferenceAudioPeakSource } from "./audio-peak";
import { referenceAudioTruePeakCoefficients } from "./audio-true-peak";

export type ReferenceAudioLimiterErrorCode =
  | "CUT_AUDIO_LIMITER_STRUCTURE"
  | "CUT_AUDIO_LIMITER_SAMPLE_RATE_UNSUPPORTED"
  | "CUT_AUDIO_LIMITER_NONFINITE"
  | "CUT_AUDIO_LIMITER_BOUNDS"
  | "CUT_AUDIO_LIMITER_WORK_LIMIT"
  | "CUT_AUDIO_LIMITER_CONTROL"
  | "CUT_AUDIO_LIMITER_RECONCILIATION";

export type ReferenceAudioLimiterErrorDetail = Readonly<{
  kind: "structure" | "sample-rate" | "nonfinite" | "bounds" | "work" | "control" | "reconciliation";
  reason: string;
  expectedFrames?: number;
  frame?: number;
  channel?: 0 | 1;
  channelName?: "left" | "right";
  control?: "ceilingDbtp" | "releaseSeconds";
  sample?: number;
  value?: number;
  lookaheadSamples?: number;
  firMultiplyAdds?: number;
  firMultiplyAddLimit?: number;
  peakLinear?: number;
  thresholdLinear?: number;
  reconciliationFactor?: number;
}>;

export class ReferenceAudioLimiterError extends Error {
  readonly source: ReferenceAudioPeakSource;
  readonly detail: ReferenceAudioLimiterErrorDetail;

  constructor(
    readonly code: ReferenceAudioLimiterErrorCode,
    source: ReferenceAudioPeakSource,
    message: string,
    detail: ReferenceAudioLimiterErrorDetail,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "ReferenceAudioLimiterError";
    this.source = Object.freeze({ ...source });
    this.detail = Object.freeze({ ...detail });
  }
}

/**
 * The pure core remains deliberately narrow: stereo f32 at 48 kHz, the frozen
 * BS.1770-5 Annex 2 4x FIR, and one bounded in-memory programme. The runtime
 * also has a bounded file/chunk adapter for long-form programmes; both execute
 * this same gain law and share this semantic identity.
 */
export const referenceAudioLimiterIdentity =
  "cut.reference-limiter/alpha-48khz-stereo-f32-bs1770-5-annex2-4x-linked-lookahead-reconciled-chunked-v3";

export const referenceAudioLimiterGuardDb = 0.5 as const;
export const referenceAudioLimiterReconciliationSafetyDb = 0.01 as const;

const channels = 2;
const supportedSampleRate = 48_000;
const phases = 4;
const tapsPerPhase = referenceAudioTruePeakCoefficients.length;
const firOrder = phases * tapsPerPhase - 1;
const firMultiplyAddsPerFrame = channels * phases * tapsPerPhase;
// Input derivation, output verification, and the one possible reconciled
// verification are all charged before programme-sized arrays are allocated.
const maximumFirPasses = 3;
const maximumFirMultiplyAdds = 2 ** 30;
const maximumFrames = Math.floor(maximumFirMultiplyAdds / (firMultiplyAddsPerFrame * maximumFirPasses));
const maximumAbsoluteInputSample = 64;
const reconciliationSafetyLinear = 10 ** (-referenceAudioLimiterReconciliationSafetyDb / 20);
const coefficientAbsoluteSum = referenceAudioTruePeakCoefficients
  .flat()
  .reduce((sum, coefficient) => sum + Math.abs(coefficient), 0);
const maximumEnvelopeLinear = maximumAbsoluteInputSample * Math.max(1, coefficientAbsoluteSum);

export const referenceAudioLimiterLimits = Object.freeze({
  channels,
  supportedSampleRate,
  oversampleFactor: phases,
  tapsPerPhase,
  groupDelayEighthFrames: firOrder,
  guardDb: referenceAudioLimiterGuardDb,
  reconciliationSafetyDb: referenceAudioLimiterReconciliationSafetyDb,
  minimumCeilingDbtp: -23.5,
  maximumCeilingDbtp: 0,
  minimumReleaseSeconds: 0.001,
  maximumReleaseSeconds: 2,
  maximumLookaheadSamples: 960,
  maximumAbsoluteInputSample,
  maximumEnvelopeLinear,
  firMultiplyAddsPerFrame,
  maximumFirPasses,
  maximumFirMultiplyAdds,
  maximumFrames,
});

export type ReferenceAudioLimiterControls = Readonly<{
  ceilingDbtp: (frame: number) => number;
  releaseSeconds: (frame: number) => number;
}>;

export type ReferenceAudioLimiterEnvelopeOptions = Readonly<{
  sampleRate: number;
  source: ReferenceAudioPeakSource;
}>;

export type ReferenceAudioLimiterProcessOptions = Readonly<ReferenceAudioLimiterEnvelopeOptions & ReferenceAudioLimiterControls & {
  lookaheadSamples: number;
}>;

export type ReferenceAudioLimiterWorkOptions = Readonly<{
  expectedFrames: number;
  sampleRate: number;
  lookaheadSamples: number;
  source: ReferenceAudioPeakSource;
}>;

export type ReferenceAudioLimiterWorkContract = Readonly<{
  expectedFrames: number;
  sampleRate: typeof supportedSampleRate;
  lookaheadSamples: number;
  firMultiplyAdds: number;
  source: ReferenceAudioPeakSource;
}>;

export type ReferenceAudioLimiterResult = Readonly<{
  format: "cut-reference-audio-limiter-result";
  version: 3;
  algorithm: typeof referenceAudioLimiterIdentity;
  sampleRate: typeof supportedSampleRate;
  frames: number;
  lookaheadSamples: number;
  guardDb: typeof referenceAudioLimiterGuardDb;
  ceilingMode: "static" | "dynamic";
  minimumCeilingDbtp: number | null;
  maximumCeilingDbtp: number | null;
  output: Float32Array;
  truePeakEnvelope: Float64Array;
  outputTruePeakEnvelope: Float64Array;
  requiredGain: Float64Array;
  appliedGain: Float64Array;
  minimumAppliedGain: number;
  reconciliationFactor: number;
  minimumFinalGain: number;
  maximumOutputTruePeakLinear: number;
  maximumOutputTruePeakDbtp: number | null;
  maximumOutputTruePeakFrame: number | null;
}>;

/**
 * Path-free result fields persisted as execution evidence. The in-memory core
 * additionally returns its programme arrays; the chunk-backed adapter returns
 * this bounded summary after reconciling and verifying the exact output file.
 */
export type ReferenceAudioLimiterSummary = Readonly<Omit<
  ReferenceAudioLimiterResult,
  "output" | "truePeakEnvelope" | "outputTruePeakEnvelope" | "requiredGain" | "appliedGain"
>>;

export type ReferenceAudioLimiterProducerAuthority = Readonly<{
  algorithm: typeof referenceAudioLimiterIdentity;
  sampleRate: typeof supportedSampleRate;
  frames: number;
  bytes: number;
  sha256: string;
  truePeakLinear: number;
  truePeakDbtp: number | null;
  truePeakFrame: number | null;
}>;

const resultProducerAuthorities = new WeakMap<object, ReferenceAudioLimiterProducerAuthority>();

function hashStereoF32Le(samples: Float32Array) {
  const digest = createHash("sha256");
  const chunkSamples = 65_536;
  for (let start = 0; start < samples.length; start += chunkSamples) {
    const end = Math.min(samples.length, start + chunkSamples);
    const bytes = Buffer.allocUnsafe((end - start) * 4);
    for (let index = start; index < end; index += 1) {
      bytes.writeFloatLE(samples[index], (index - start) * 4);
    }
    digest.update(bytes);
  }
  return digest.digest("hex");
}

/**
 * Return producer-authenticated output facts only for the exact object emitted
 * by the in-memory limiter. Clones and caller-authored lookalikes have no
 * authority, even when all enumerable fields are identical.
 */
export function referenceAudioLimiterResultProducerAuthority(
  value: unknown,
): ReferenceAudioLimiterProducerAuthority | undefined {
  return typeof value === "object" && value !== null
    ? resultProducerAuthorities.get(value)
    : undefined;
}

const fallbackSource: ReferenceAudioPeakSource = Object.freeze({
  module: "<limiter-runtime>",
  line: 1,
  column: 1,
});

function stableNumber(value: unknown) {
  if (typeof value !== "number") return `<${typeof value}>`;
  if (Object.is(value, -0)) return "-0";
  if (Number.isInteger(value)) return String(value);
  return value.toPrecision(12).replace(/(?:\.0+|(?:(\.\d*?[1-9])0+))(?=e|$)/u, "$1");
}

function dataRecord(value: unknown, allowed: readonly string[]) {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    if (Object.getOwnPropertySymbols(value).length !== 0) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors);
    if (keys.some((key) => !allowed.includes(key))) return undefined;
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!("value" in descriptor)) return undefined;
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return undefined;
  }
}

function sourceOrFallback(value: unknown) {
  const source = dataRecord(value, ["module", "line", "column", "nodeId"]);
  if (!source
    || typeof source.module !== "string"
    || source.module.length === 0
    || source.module.length > 4_096
    || typeof source.line !== "number"
    || !Number.isSafeInteger(source.line)
    || source.line <= 0
    || typeof source.column !== "number"
    || !Number.isSafeInteger(source.column)
    || source.column <= 0
    || (source.nodeId !== undefined && (typeof source.nodeId !== "string" || source.nodeId.length > 4_096))) {
    return undefined;
  }
  return Object.freeze({
    module: source.module,
    line: source.line,
    column: source.column,
    ...(typeof source.nodeId === "string" ? { nodeId: source.nodeId } : {}),
  });
}

function fail(
  code: ReferenceAudioLimiterErrorCode,
  source: ReferenceAudioPeakSource,
  message: string,
  detail: ReferenceAudioLimiterErrorDetail,
  cause?: unknown,
): never {
  throw new ReferenceAudioLimiterError(
    code,
    source,
    message,
    detail,
    cause === undefined ? undefined : { cause },
  );
}

function normalizedWorkOptions(value: unknown): ReferenceAudioLimiterWorkContract {
  const options = dataRecord(value, ["expectedFrames", "sampleRate", "lookaheadSamples", "source"]);
  const source = sourceOrFallback(options?.source) ?? fallbackSource;
  if (!options || !sourceOrFallback(options.source)) {
    fail(
      "CUT_AUDIO_LIMITER_STRUCTURE",
      source,
      "limiter work options and source must be closed plain data objects.",
      { kind: "structure", reason: "invalid-work-options" },
    );
  }

  const { expectedFrames, sampleRate, lookaheadSamples } = options;
  if (typeof expectedFrames !== "number" || !Number.isSafeInteger(expectedFrames) || expectedFrames < 0) {
    fail(
      "CUT_AUDIO_LIMITER_STRUCTURE",
      source,
      `expectedFrames must be one non-negative safe integer; received ${stableNumber(expectedFrames)}.`,
      { kind: "structure", reason: "invalid-frame-count" },
    );
  }
  if (typeof sampleRate !== "number") {
    fail(
      "CUT_AUDIO_LIMITER_STRUCTURE",
      source,
      "sampleRate must be a finite numeric value.",
      { kind: "structure", reason: "invalid-sample-rate", expectedFrames },
    );
  }
  if (!Number.isFinite(sampleRate)) {
    fail(
      "CUT_AUDIO_LIMITER_NONFINITE",
      source,
      "sampleRate must be finite.",
      { kind: "nonfinite", reason: "sample-rate", expectedFrames, value: sampleRate },
    );
  }
  if (sampleRate !== supportedSampleRate) {
    fail(
      "CUT_AUDIO_LIMITER_SAMPLE_RATE_UNSUPPORTED",
      source,
      `the alpha limiter supports exactly ${supportedSampleRate} Hz; received ${stableNumber(sampleRate)} Hz.`,
      { kind: "sample-rate", reason: "unsupported", expectedFrames, value: sampleRate },
    );
  }
  if (typeof lookaheadSamples !== "number" || !Number.isSafeInteger(lookaheadSamples) || lookaheadSamples < 0) {
    fail(
      "CUT_AUDIO_LIMITER_STRUCTURE",
      source,
      `lookaheadSamples must be one non-negative safe integer; received ${stableNumber(lookaheadSamples)}.`,
      { kind: "structure", reason: "invalid-lookahead", expectedFrames },
    );
  }
  if (lookaheadSamples > referenceAudioLimiterLimits.maximumLookaheadSamples) {
    fail(
      "CUT_AUDIO_LIMITER_BOUNDS",
      source,
      `lookaheadSamples ${lookaheadSamples} exceeds the alpha bound ${referenceAudioLimiterLimits.maximumLookaheadSamples}.`,
      { kind: "bounds", reason: "lookahead", expectedFrames, lookaheadSamples },
    );
  }

  const firMultiplyAdds = expectedFrames * firMultiplyAddsPerFrame * maximumFirPasses;
  if (expectedFrames > maximumFrames || firMultiplyAdds > maximumFirMultiplyAdds) {
    fail(
      "CUT_AUDIO_LIMITER_WORK_LIMIT",
      source,
      `limiter true-peak derivation requires ${stableNumber(firMultiplyAdds)} FIR multiply-adds; maximum is ${maximumFirMultiplyAdds}.`,
      {
        kind: "work",
        reason: "fir-multiply-adds",
        expectedFrames,
        lookaheadSamples,
        firMultiplyAdds,
        firMultiplyAddLimit: maximumFirMultiplyAdds,
      },
    );
  }

  return Object.freeze({
    expectedFrames,
    sampleRate: supportedSampleRate,
    lookaheadSamples,
    firMultiplyAdds,
    source,
  });
}

/** Validate work before allocating programme-sized envelope or gain arrays. */
export function assertReferenceAudioLimiterWorkContract(options: ReferenceAudioLimiterWorkOptions) {
  return normalizedWorkOptions(options);
}

function normalizedEnvelopeOptions(value: unknown, expectedFrames: number) {
  const options = dataRecord(value, ["sampleRate", "source"]);
  const source = sourceOrFallback(options?.source) ?? fallbackSource;
  if (!options || !sourceOrFallback(options.source)) {
    fail(
      "CUT_AUDIO_LIMITER_STRUCTURE",
      source,
      "limiter envelope options and source must be closed plain data objects.",
      { kind: "structure", reason: "invalid-envelope-options", expectedFrames },
    );
  }
  return normalizedWorkOptions({
    expectedFrames,
    sampleRate: options.sampleRate,
    lookaheadSamples: 0,
    source,
  });
}

function normalizedProcessOptions(value: unknown, expectedFrames: number) {
  const options = dataRecord(value, ["sampleRate", "lookaheadSamples", "ceilingDbtp", "releaseSeconds", "source"]);
  const source = sourceOrFallback(options?.source) ?? fallbackSource;
  if (!options || !sourceOrFallback(options.source)) {
    fail(
      "CUT_AUDIO_LIMITER_STRUCTURE",
      source,
      "limiter process options and source must be closed plain data objects.",
      { kind: "structure", reason: "invalid-process-options", expectedFrames },
    );
  }
  if (typeof options.ceilingDbtp !== "function" || typeof options.releaseSeconds !== "function") {
    fail(
      "CUT_AUDIO_LIMITER_STRUCTURE",
      source,
      "ceilingDbtp and releaseSeconds must be per-frame callbacks.",
      { kind: "structure", reason: "invalid-control-callbacks", expectedFrames },
    );
  }
  const contract = normalizedWorkOptions({
    expectedFrames,
    sampleRate: options.sampleRate,
    lookaheadSamples: options.lookaheadSamples,
    source,
  });
  return Object.freeze({
    contract,
    ceilingDbtp: options.ceilingDbtp as (frame: number) => number,
    releaseSeconds: options.releaseSeconds as (frame: number) => number,
  });
}

function isSharedBuffer(buffer: ArrayBufferLike) {
  return typeof SharedArrayBuffer !== "undefined" && buffer instanceof SharedArrayBuffer;
}

function normalizedPcm(value: unknown, source: ReferenceAudioPeakSource) {
  let input: Float32Array;
  try {
    if (!(value instanceof Float32Array)
      || Object.getPrototypeOf(value) !== Float32Array.prototype
      || isSharedBuffer(value.buffer)) {
      fail(
        "CUT_AUDIO_LIMITER_STRUCTURE",
        source,
        "limiter PCM must be a direct non-shared interleaved Float32Array.",
        { kind: "structure", reason: "invalid-pcm" },
      );
    }
    input = new Float32Array(value);
  } catch (error) {
    if (error instanceof ReferenceAudioLimiterError) throw error;
    fail(
      "CUT_AUDIO_LIMITER_STRUCTURE",
      source,
      "limiter PCM could not be snapshotted safely.",
      { kind: "structure", reason: "invalid-pcm" },
      error,
    );
  }
  if (input.length % channels !== 0) {
    fail(
      "CUT_AUDIO_LIMITER_STRUCTURE",
      source,
      "limiter PCM must contain complete interleaved stereo frames.",
      { kind: "structure", reason: "partial-frame" },
    );
  }
  for (let sampleIndex = 0; sampleIndex < input.length; sampleIndex += 1) {
    const sample = input[sampleIndex];
    const frame = Math.floor(sampleIndex / channels);
    const channel = sampleIndex % channels as 0 | 1;
    if (!Number.isFinite(sample)) {
      fail(
        "CUT_AUDIO_LIMITER_NONFINITE",
        source,
        `limiter PCM contains a non-finite ${channel === 0 ? "left" : "right"} sample at frame ${frame}.`,
        { kind: "nonfinite", reason: "pcm-sample", frame, channel, channelName: channel === 0 ? "left" : "right", sample },
      );
    }
    if (Math.abs(sample) > maximumAbsoluteInputSample) {
      fail(
        "CUT_AUDIO_LIMITER_BOUNDS",
        source,
        `limiter PCM sample at frame ${frame} exceeds the alpha magnitude bound ${maximumAbsoluteInputSample}.`,
        { kind: "bounds", reason: "pcm-sample", frame, channel, channelName: channel === 0 ? "left" : "right", sample },
      );
    }
  }
  return input;
}

function normalizedEnvelope(value: unknown, expectedFrames: number, source: ReferenceAudioPeakSource) {
  let envelope: Float64Array;
  try {
    if (!(value instanceof Float64Array)
      || Object.getPrototypeOf(value) !== Float64Array.prototype
      || isSharedBuffer(value.buffer)) {
      fail(
        "CUT_AUDIO_LIMITER_STRUCTURE",
        source,
        "limiter true-peak envelope must be a direct non-shared Float64Array.",
        { kind: "structure", reason: "invalid-envelope", expectedFrames },
      );
    }
    envelope = new Float64Array(value);
  } catch (error) {
    if (error instanceof ReferenceAudioLimiterError) throw error;
    fail(
      "CUT_AUDIO_LIMITER_STRUCTURE",
      source,
      "limiter true-peak envelope could not be snapshotted safely.",
      { kind: "structure", reason: "invalid-envelope", expectedFrames },
      error,
    );
  }
  if (envelope.length !== expectedFrames) {
    fail(
      "CUT_AUDIO_LIMITER_STRUCTURE",
      source,
      `limiter true-peak envelope must contain exactly ${expectedFrames} source-frame values.`,
      { kind: "structure", reason: "envelope-frame-count", expectedFrames },
    );
  }
  for (let frame = 0; frame < envelope.length; frame += 1) {
    const valueAtFrame = envelope[frame];
    if (!Number.isFinite(valueAtFrame)) {
      fail(
        "CUT_AUDIO_LIMITER_NONFINITE",
        source,
        `limiter true-peak envelope contains a non-finite value at frame ${frame}.`,
        { kind: "nonfinite", reason: "envelope", expectedFrames, frame, value: valueAtFrame },
      );
    }
    if (valueAtFrame < 0 || valueAtFrame > maximumEnvelopeLinear) {
      fail(
        "CUT_AUDIO_LIMITER_BOUNDS",
        source,
        `limiter true-peak envelope value at frame ${frame} is outside the alpha bound.`,
        { kind: "bounds", reason: "envelope", expectedFrames, frame, value: valueAtFrame },
      );
    }
  }
  return envelope;
}

function deriveEnvelope(input: Float32Array) {
  const frames = input.length / channels;
  const envelope = new Float64Array(frames);
  if (frames === 0) return envelope;

  // Retain the authored sample peak as a conservative floor, exactly as the
  // CUT true-peak scanner does.
  for (let frame = 0; frame < frames; frame += 1) {
    envelope[frame] = Math.max(Math.abs(input[frame * 2]), Math.abs(input[frame * 2 + 1]));
  }

  // Direct convolution avoids a 4x programme-sized temporary. FIR output j
  // has compensated position (2*j - 47)/8 source frames: 47/8 is the exact
  // group delay of the 48-tap linear-phase 4x interpolator. Fractional points
  // are assigned to the containing source frame; zero-extended head/tail
  // responses are clamped into the first/last real frame so no boundary peak
  // disappears from the exact-frame-count envelope.
  const oversampledLength = frames * phases + firOrder - (phases - 1);
  for (let oversampledIndex = 0; oversampledIndex < oversampledLength; oversampledIndex += 1) {
    const firstInputFrame = Math.max(0, Math.ceil((oversampledIndex - firOrder) / phases));
    const lastInputFrame = Math.min(frames - 1, Math.floor(oversampledIndex / phases));
    let left = 0;
    let right = 0;
    for (let inputFrame = firstInputFrame; inputFrame <= lastInputFrame; inputFrame += 1) {
      const coefficientIndex = oversampledIndex - inputFrame * phases;
      const coefficient = referenceAudioTruePeakCoefficients[Math.floor(coefficientIndex / phases)][coefficientIndex % phases];
      left += input[inputFrame * 2] * coefficient;
      right += input[inputFrame * 2 + 1] * coefficient;
    }
    const compensatedEighthFrames = 2 * oversampledIndex - firOrder;
    const sourceFrame = Math.max(0, Math.min(frames - 1, Math.floor(compensatedEighthFrames / 8)));
    const peak = Math.max(Math.abs(left), Math.abs(right));
    if (peak > envelope[sourceFrame]) envelope[sourceFrame] = peak;
  }
  return envelope;
}

/**
 * Derive one stereo-linked, group-delay-compensated true-peak value per real
 * source frame. The output has exactly input.length / 2 values and includes
 * zero-extended FIR boundary responses without adding programme frames.
 */
export function deriveReferenceAudioLimiterTruePeakEnvelope(
  interleavedStereoF32: Float32Array,
  options: ReferenceAudioLimiterEnvelopeOptions,
) {
  const provisionalSource = sourceOrFallback(dataRecord(options, ["sampleRate", "source"])?.source) ?? fallbackSource;
  const input = normalizedPcm(interleavedStereoF32, provisionalSource);
  const contract = normalizedEnvelopeOptions(options, input.length / channels);
  // Contract validation intentionally precedes the programme-sized envelope.
  void contract;
  return deriveEnvelope(input);
}

function controlValue(
  callback: (frame: number) => number,
  control: "ceilingDbtp" | "releaseSeconds",
  frame: number,
  source: ReferenceAudioPeakSource,
) {
  let value: unknown;
  try {
    value = callback(frame);
  } catch (error) {
    fail(
      "CUT_AUDIO_LIMITER_CONTROL",
      source,
      `${control} callback failed at frame ${frame}.`,
      { kind: "control", reason: "callback-failed", frame, control },
      error,
    );
  }
  if (typeof value !== "number") {
    fail(
      "CUT_AUDIO_LIMITER_STRUCTURE",
      source,
      `${control} callback must return a number at frame ${frame}.`,
      { kind: "structure", reason: "control-type", frame, control },
    );
  }
  if (!Number.isFinite(value)) {
    fail(
      "CUT_AUDIO_LIMITER_NONFINITE",
      source,
      `${control} callback returned a non-finite value at frame ${frame}.`,
      { kind: "nonfinite", reason: "control-value", frame, control, value },
    );
  }
  const minimum = control === "ceilingDbtp"
    ? referenceAudioLimiterLimits.minimumCeilingDbtp
    : referenceAudioLimiterLimits.minimumReleaseSeconds;
  const maximum = control === "ceilingDbtp"
    ? referenceAudioLimiterLimits.maximumCeilingDbtp
    : referenceAudioLimiterLimits.maximumReleaseSeconds;
  if (value < minimum || value > maximum) {
    fail(
      "CUT_AUDIO_LIMITER_BOUNDS",
      source,
      `${control} value at frame ${frame} is outside ${stableNumber(minimum)}..${stableNumber(maximum)}.`,
      { kind: "bounds", reason: "control-value", frame, control, value },
    );
  }
  return value;
}

/**
 * Apply the CUT limiter control law to a precomputed per-frame envelope.
 * Controls are evaluated once, in ascending order, for their exact output
 * frame. A monotonic queue computes the maximum future audio peak over the
 * inclusive [frame, frame + lookaheadSamples] window in linear time; the
 * ceiling for the current frame is then applied to that peak. Consequently a
 * future transient is anticipated, but a future control event never changes
 * an earlier frame. Downward gain changes are instantaneous; upward motion
 * follows one stereo-linked release recurrence toward unity.
 */
export function processReferenceAudioLimiterEnvelope(
  interleavedStereoF32: Float32Array,
  truePeakEnvelope: Float64Array,
  options: ReferenceAudioLimiterProcessOptions,
): ReferenceAudioLimiterResult {
  const provisionalSource = sourceOrFallback(dataRecord(options, ["sampleRate", "lookaheadSamples", "ceilingDbtp", "releaseSeconds", "source"])?.source) ?? fallbackSource;
  const input = normalizedPcm(interleavedStereoF32, provisionalSource);
  const frames = input.length / channels;
  const normalized = normalizedProcessOptions(options, frames);
  const { contract, ceilingDbtp, releaseSeconds } = normalized;
  const envelope = normalizedEnvelope(truePeakEnvelope, frames, contract.source);

  const requiredGain = new Float64Array(frames);
  const releaseCoefficients = new Float64Array(frames);
  const authoredCeilingLinear = new Float64Array(frames);
  const guardedCeilingLinear = new Float64Array(frames);
  let firstCeilingDbtp: number | undefined;
  let constantCeiling = true;
  let minimumCeilingDbtp = Infinity;
  let maximumCeilingDbtp = -Infinity;
  for (let frame = 0; frame < frames; frame += 1) {
    const ceiling = controlValue(ceilingDbtp, "ceilingDbtp", frame, contract.source);
    const release = controlValue(releaseSeconds, "releaseSeconds", frame, contract.source);
    if (frame === 0) firstCeilingDbtp = ceiling;
    else if (ceiling !== firstCeilingDbtp) constantCeiling = false;
    if (ceiling < minimumCeilingDbtp) minimumCeilingDbtp = ceiling;
    if (ceiling > maximumCeilingDbtp) maximumCeilingDbtp = ceiling;
    authoredCeilingLinear[frame] = 10 ** (ceiling / 20);
    guardedCeilingLinear[frame] = authoredCeilingLinear[frame] * 10 ** (-referenceAudioLimiterGuardDb / 20);
    releaseCoefficients[frame] = Math.exp(-1 / (release * supportedSampleRate));
  }

  const output = new Float32Array(input.length);
  const appliedGain = new Float64Array(frames);
  // A decreasing deque yields the maximum audio peak in each future window.
  // Control values are intentionally absent from this queue: they belong to
  // the exact current output frame and cannot be anticipated retroactively.
  const queue = new Int32Array(frames);
  let queueHead = 0;
  let queueTail = 0;
  let lastAdded = -1;
  for (let frame = 0; frame < frames; frame += 1) {
    const windowEnd = Math.min(frames - 1, frame + contract.lookaheadSamples);
    while (lastAdded < windowEnd) {
      lastAdded += 1;
      while (queueTail > queueHead && envelope[queue[queueTail - 1]] <= envelope[lastAdded]) queueTail -= 1;
      queue[queueTail] = lastAdded;
      queueTail += 1;
    }
    while (queueHead < queueTail && queue[queueHead] < frame) queueHead += 1;
    const futureWindowPeak = envelope[queue[queueHead]];
    requiredGain[frame] = futureWindowPeak > guardedCeilingLinear[frame]
      ? guardedCeilingLinear[frame] / futureWindowPeak
      : 1;
  }

  let previousGain = 1;
  let minimumAppliedGain = 1;
  for (let frame = 0; frame < frames; frame += 1) {
    const coefficient = releaseCoefficients[frame];
    const releasedGain = coefficient * previousGain + (1 - coefficient);
    const gain = Math.max(0, Math.min(1, requiredGain[frame], releasedGain));
    appliedGain[frame] = gain;
    previousGain = gain;
    if (gain < minimumAppliedGain) minimumAppliedGain = gain;
    output[frame * 2] = Math.fround(input[frame * 2] * gain);
    output[frame * 2 + 1] = Math.fround(input[frame * 2 + 1] * gain);
  }

  // Per-frame gain changes can themselves alter reconstruction between source
  // samples. CUT therefore verifies the actual Float32 output with the same
  // compensated Annex 2 envelope. If any dynamic authored ceiling is crossed,
  // a constant ceiling permits one programme-uniform factor that preserves the
  // complete local gain law and stereo balance while reconciling the worst
  // frame. An automated ceiling refuses that non-causal correction below. The
  // fixed 0.01 dB numerical safety absorbs Float32 rounding; a second miss is a
  // stable hard failure, never an unreported or iterative backend correction.
  let outputTruePeakEnvelope = deriveEnvelope(output);
  let reconciliationFactor = 1;
  let reconciliationFrame: number | undefined;
  for (let frame = 0; frame < frames; frame += 1) {
    if (outputTruePeakEnvelope[frame] > authoredCeilingLinear[frame]) {
      const candidate = authoredCeilingLinear[frame] / outputTruePeakEnvelope[frame];
      if (candidate < reconciliationFactor) {
        reconciliationFactor = candidate;
        reconciliationFrame = frame;
      }
    }
  }
  if (reconciliationFactor < 1) {
    // A programme-uniform correction is semantically transparent only for a
    // constant ceiling. With ceiling automation it would let a future event
    // alter earlier PCM, violating CUT's exact event boundary. Until a proven
    // causal/local reconciliation exists, refuse that case rather than
    // silently rewriting history.
    if (!constantCeiling) {
      const frame = reconciliationFrame ?? 0;
      fail(
        "CUT_AUDIO_LIMITER_RECONCILIATION",
        contract.source,
        `dynamic ceiling output requires unsupported reconciliation at frame ${frame}.`,
        {
          kind: "reconciliation",
          reason: "dynamic-ceiling-reconciliation-unsupported",
          expectedFrames: frames,
          frame,
          peakLinear: outputTruePeakEnvelope[frame],
          thresholdLinear: authoredCeilingLinear[frame],
          reconciliationFactor,
        },
      );
    }
    reconciliationFactor *= reconciliationSafetyLinear;
    for (let sampleIndex = 0; sampleIndex < output.length; sampleIndex += 1) {
      output[sampleIndex] = Math.fround(output[sampleIndex] * reconciliationFactor);
    }
    outputTruePeakEnvelope = deriveEnvelope(output);
  }
  for (let frame = 0; frame < frames; frame += 1) {
    if (outputTruePeakEnvelope[frame] > authoredCeilingLinear[frame]) {
      fail(
        "CUT_AUDIO_LIMITER_RECONCILIATION",
        contract.source,
        `verified limiter output still exceeds the authored ceiling at frame ${frame}.`,
        {
          kind: "reconciliation",
          reason: "post-reconciliation-ceiling",
          expectedFrames: frames,
          frame,
          peakLinear: outputTruePeakEnvelope[frame],
          thresholdLinear: authoredCeilingLinear[frame],
          reconciliationFactor,
        },
      );
    }
  }

  let maximumOutputTruePeakLinear = 0;
  let maximumOutputTruePeakFrame: number | null = null;
  for (let frame = 0; frame < outputTruePeakEnvelope.length; frame += 1) {
    const peak = outputTruePeakEnvelope[frame];
    if (peak > maximumOutputTruePeakLinear) {
      maximumOutputTruePeakLinear = peak;
      maximumOutputTruePeakFrame = frame;
    }
  }

  const result = Object.freeze({
    format: "cut-reference-audio-limiter-result",
    version: 3,
    algorithm: referenceAudioLimiterIdentity,
    sampleRate: supportedSampleRate,
    frames,
    lookaheadSamples: contract.lookaheadSamples,
    guardDb: referenceAudioLimiterGuardDb,
    ceilingMode: constantCeiling ? "static" : "dynamic",
    minimumCeilingDbtp: frames === 0 ? null : minimumCeilingDbtp,
    maximumCeilingDbtp: frames === 0 ? null : maximumCeilingDbtp,
    output,
    truePeakEnvelope: envelope,
    outputTruePeakEnvelope,
    requiredGain,
    appliedGain,
    minimumAppliedGain,
    reconciliationFactor,
    minimumFinalGain: minimumAppliedGain * reconciliationFactor,
    maximumOutputTruePeakLinear,
    maximumOutputTruePeakDbtp: maximumOutputTruePeakLinear === 0
      ? null
      : 20 * Math.log10(maximumOutputTruePeakLinear),
    maximumOutputTruePeakFrame,
  });
  if (result.ceilingMode === "static") {
    resultProducerAuthorities.set(result, Object.freeze({
      algorithm: result.algorithm,
      sampleRate: result.sampleRate,
      frames: result.frames,
      bytes: result.output.byteLength,
      sha256: hashStereoF32Le(result.output),
      truePeakLinear: result.maximumOutputTruePeakLinear,
      truePeakDbtp: result.maximumOutputTruePeakDbtp,
      truePeakFrame: result.maximumOutputTruePeakFrame,
    }));
  }
  return result;
}

/** Pure in-memory convenience wrapper for the two explicit core passes. */
export function processReferenceAudioLimiter(
  interleavedStereoF32: Float32Array,
  options: ReferenceAudioLimiterProcessOptions,
) {
  const data = dataRecord(options, ["sampleRate", "lookaheadSamples", "ceilingDbtp", "releaseSeconds", "source"]);
  const source = sourceOrFallback(data?.source) ?? fallbackSource;
  if (!data) {
    fail(
      "CUT_AUDIO_LIMITER_STRUCTURE",
      source,
      "limiter process options must be one closed plain data object.",
      { kind: "structure", reason: "invalid-process-options" },
    );
  }
  const envelope = deriveReferenceAudioLimiterTruePeakEnvelope(interleavedStereoF32, {
    sampleRate: data.sampleRate as number,
    source: data.source as ReferenceAudioPeakSource,
  });
  return processReferenceAudioLimiterEnvelope(interleavedStereoF32, envelope, options);
}
