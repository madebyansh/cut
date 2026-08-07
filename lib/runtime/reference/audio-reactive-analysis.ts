import { createHash } from "node:crypto";
import { hash } from "../../core/stable";
import {
  compareRational,
  rational,
  rationalToNumber,
  type Rational,
  zeroRational,
} from "../../language/rational";

const planFormat = "cut-reference-audio-reactive-analysis-plan" as const;
const planVersion = 1 as const;
const contentFormat = "cut-reference-audio-reactive-analysis-content" as const;
const contentVersion = 1 as const;
const cacheKeyFormat = "cut-reference-audio-reactive-analysis-cache-key" as const;
const cacheKeyVersion = 1 as const;
const algorithm = "causal-trailing-window-stereo-linked-linear-envelope-v1" as const;
const windowAlignment = "trailing-full-window-end-exclusive" as const;
const channelMode = "stereo-linked" as const;
const ratioResolution = 1_000_000;

export const referenceAudioReactiveAnalysisLimits = Object.freeze({
  minimumSampleRate: 8_000,
  maximumSampleRate: 192_000,
  maximumSelectedStreamIndex: 4_095,
  maximumInputFrames: 28_800_000,
  maximumOutputWindows: 131_072,
  maximumDetectorChannelSamples: 268_435_456,
  maximumWindowSeconds: 10,
  maximumAttackSeconds: 10,
  maximumReleaseSeconds: 30,
  maximumAbsoluteInputSample: 64,
  ratioResolution,
});

/** Deliberately absent semantics. Do not advertise these as detector modes. */
export const referenceAudioReactiveAnalysisNonClaims = Object.freeze([
  "frequency-band analysis",
  "onset, beat, or tempo detection",
  "post-mix or live audio-graph analysis",
  "look-ahead or centered-window visual control",
  "portable floating-point byte identity across JavaScript engines",
] as const);

export type ReferenceAudioReactiveDetector = "peak" | "rms";

export type ReferenceAudioReactiveNormalization = Readonly<{
  kind: "peak-linear" | "rms-linear";
  floor: Rational;
  ceiling: Rational;
}>;

export type ReferenceAudioReactiveSmoothing = Readonly<{
  kind: "attack-release-one-pole";
  attackFrames: number;
  releaseFrames: number;
}>;

export type ReferenceAudioReactiveLockedSource = Readonly<{
  activeVariant: "master" | "proxy";
  lockedResourceSha256: string;
  selectedStreamIndex: number;
  selectedStreamSampleRate: number;
  selectedStreamIdentitySha256: string;
  decoderIntegritySha256: string;
}>;

export type ReferenceAudioReactiveAnalysisPlanInput = Readonly<{
  source: ReferenceAudioReactiveLockedSource;
  sampleRate: number;
  range: Readonly<{ startFrame: number; endFrame: number }>;
  compositionStartFrame: number;
  windowFrames: number;
  hopFrames: number;
  detector: ReferenceAudioReactiveDetector;
  channelMode: typeof channelMode;
  normalization: ReferenceAudioReactiveNormalization;
  smoothing: ReferenceAudioReactiveSmoothing;
}>;

export type ReferenceAudioReactiveAnalysisPlan = Readonly<{
  format: typeof planFormat;
  version: typeof planVersion;
  algorithm: typeof algorithm;
  source: ReferenceAudioReactiveLockedSource;
  pcm: Readonly<{
    format: "raw-stereo-f32le";
    layout: "interleaved";
    channels: 2;
    sampleRate: number;
  }>;
  range: Readonly<{ startFrame: number; endFrame: number }>;
  compositionStartFrame: number;
  windowFrames: number;
  hopFrames: number;
  detector: ReferenceAudioReactiveDetector;
  channelMode: typeof channelMode;
  normalization: ReferenceAudioReactiveNormalization;
  smoothing: ReferenceAudioReactiveSmoothing;
  windowAlignment: typeof windowAlignment;
  windowCount: number;
  detectorWorkChannelSamples: number;
  outputRatioResolution: typeof ratioResolution;
  integrity: string;
}>;

export type ReferenceAudioReactiveRatioValue = Readonly<{
  kind: "quantity";
  dimension: "ratio";
  magnitude: Rational;
  unit: "ratio";
}>;

export type ReferenceAudioReactiveAnalysisWindow = Readonly<{
  index: number;
  sourceStartFrame: number;
  sourceEndFrame: number;
  compositionFrame: number;
  compositionTime: Rational;
  detectorAmplitude: number;
  smoothedAmplitude: number;
  ratioUnits: number;
  value: ReferenceAudioReactiveRatioValue;
}>;

export type ReferenceAudioReactiveRatioTrack = Readonly<{
  clock: Readonly<{ kind: "composition-sample"; sampleRate: number }>;
  kind: "track";
  valueType: "Ratio";
  initial: ReferenceAudioReactiveRatioValue;
  events: readonly Readonly<{
    kind: "set";
    time: Rational;
    value: ReferenceAudioReactiveRatioValue;
  }>[];
}>;

export type ReferenceAudioReactiveWindowVariation = "silence" | "constant" | "varying";

export type ReferenceAudioReactiveAnalysisResult = Readonly<{
  format: typeof contentFormat;
  version: typeof contentVersion;
  planIntegrity: string;
  cacheKey: string;
  inputPcmSha256: string;
  signalSha256: string;
  contentIntegrity: string;
  windowCount: number;
  windows: readonly ReferenceAudioReactiveAnalysisWindow[];
  signal: ReferenceAudioReactiveRatioTrack;
  windowVariation: ReferenceAudioReactiveWindowVariation;
  hasMeasuredModulation: boolean;
  maximumDetectorAmplitude: number;
  maximumSmoothedAmplitude: number;
  processedChannelSamples: number;
}>;

export type ReferenceAudioReactiveAnalysisErrorCode =
  | "CUT_AUDIO_REACTIVE_TYPE"
  | "CUT_AUDIO_REACTIVE_VALUE"
  | "CUT_AUDIO_REACTIVE_RANGE"
  | "CUT_AUDIO_REACTIVE_NOOP"
  | "CUT_AUDIO_REACTIVE_RESOURCE"
  | "CUT_AUDIO_REACTIVE_PCM"
  | "CUT_AUDIO_REACTIVE_IDENTITY";

export class ReferenceAudioReactiveAnalysisError extends Error {
  constructor(readonly code: ReferenceAudioReactiveAnalysisErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "ReferenceAudioReactiveAnalysisError";
  }
}

function fail(code: ReferenceAudioReactiveAnalysisErrorCode, message: string): never {
  throw new ReferenceAudioReactiveAnalysisError(code, message);
}

function plainRecord(
  value: unknown,
  keys: readonly string[],
  code: ReferenceAudioReactiveAnalysisErrorCode,
  label: string,
) {
  let prototype: object | null;
  let ownKeys: PropertyKey[];
  let descriptors: PropertyDescriptorMap;
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(code, `${label} must be one plain data object.`);
    prototype = Object.getPrototypeOf(value);
    ownKeys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch (error) {
    if (error instanceof ReferenceAudioReactiveAnalysisError) throw error;
    fail(code, `${label} could not be inspected as plain data.`);
  }
  if (prototype !== Object.prototype && prototype !== null) fail(code, `${label} must have a plain or null prototype.`);
  if (ownKeys.some((key) => typeof key !== "string")) fail(code, `${label} cannot contain symbol properties.`);
  const actual = (ownKeys as string[]).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(code, `${label} must contain exactly ${expected.join(", ")}; unknown or missing properties are refused.`);
  }
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of expected) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !("value" in descriptor)) fail(code, `${label}.${key} must be an enumerable data property.`);
    result[key] = descriptor.value;
  }
  return result;
}

function enumValue<const T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    fail("CUT_AUDIO_REACTIVE_VALUE", `${label} must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

function safeInteger(value: unknown, minimum: number, maximum: number, code: ReferenceAudioReactiveAnalysisErrorCode, label: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(code, `${label} must be a safe integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function digest(value: unknown, label: string) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    fail("CUT_AUDIO_REACTIVE_IDENTITY", `${label} must be one lowercase SHA-256 digest.`);
  }
  return value;
}

function exactRational(value: unknown, label: string) {
  const record = plainRecord(value, ["numerator", "denominator"], "CUT_AUDIO_REACTIVE_TYPE", label);
  if (typeof record.numerator !== "string" || !/^-?(?:0|[1-9][0-9]*)$/u.test(record.numerator)) {
    fail("CUT_AUDIO_REACTIVE_TYPE", `${label}.numerator must be a canonical integer string.`);
  }
  if (typeof record.denominator !== "string" || !/^[1-9][0-9]*$/u.test(record.denominator)) {
    fail("CUT_AUDIO_REACTIVE_TYPE", `${label}.denominator must be a positive canonical integer string.`);
  }
  if (record.numerator.length > 256 || record.denominator.length > 256) {
    fail("CUT_AUDIO_REACTIVE_RESOURCE", `${label} exceeds the 256-digit exact-rational budget.`);
  }
  let normalized: Rational;
  try {
    normalized = rational(record.numerator, record.denominator);
  } catch {
    fail("CUT_AUDIO_REACTIVE_TYPE", `${label} is not one valid exact rational.`);
  }
  if (normalized.numerator !== record.numerator || normalized.denominator !== record.denominator) {
    fail("CUT_AUDIO_REACTIVE_TYPE", `${label} must be reduced to canonical form.`);
  }
  return normalized;
}

function lockedSource(value: unknown): ReferenceAudioReactiveLockedSource {
  const record = plainRecord(value, [
    "activeVariant",
    "lockedResourceSha256",
    "selectedStreamIndex",
    "selectedStreamSampleRate",
    "selectedStreamIdentitySha256",
    "decoderIntegritySha256",
  ], "CUT_AUDIO_REACTIVE_TYPE", "audio-reactive source identity");
  return Object.freeze({
    activeVariant: enumValue(record.activeVariant, ["master", "proxy"] as const, "source.activeVariant"),
    lockedResourceSha256: digest(record.lockedResourceSha256, "source.lockedResourceSha256"),
    selectedStreamIndex: safeInteger(record.selectedStreamIndex, 0, referenceAudioReactiveAnalysisLimits.maximumSelectedStreamIndex, "CUT_AUDIO_REACTIVE_VALUE", "source.selectedStreamIndex"),
    selectedStreamSampleRate: safeInteger(record.selectedStreamSampleRate, referenceAudioReactiveAnalysisLimits.minimumSampleRate, referenceAudioReactiveAnalysisLimits.maximumSampleRate, "CUT_AUDIO_REACTIVE_VALUE", "source.selectedStreamSampleRate"),
    selectedStreamIdentitySha256: digest(record.selectedStreamIdentitySha256, "source.selectedStreamIdentitySha256"),
    decoderIntegritySha256: digest(record.decoderIntegritySha256, "source.decoderIntegritySha256"),
  });
}

function normalization(value: unknown, detector: ReferenceAudioReactiveDetector): ReferenceAudioReactiveNormalization {
  const record = plainRecord(value, ["kind", "floor", "ceiling"], "CUT_AUDIO_REACTIVE_TYPE", "audio-reactive normalization");
  const expectedKind = detector === "peak" ? "peak-linear" as const : "rms-linear" as const;
  const kind = enumValue(record.kind, ["peak-linear", "rms-linear"] as const, "normalization.kind");
  if (kind !== expectedKind) {
    fail("CUT_AUDIO_REACTIVE_VALUE", `${detector} detection requires normalization.kind ${expectedKind}; cross-detector normalization is refused.`);
  }
  const floor = exactRational(record.floor, "normalization.floor");
  const ceiling = exactRational(record.ceiling, "normalization.ceiling");
  const maximum = rational(referenceAudioReactiveAnalysisLimits.maximumAbsoluteInputSample);
  if (compareRational(floor, zeroRational) < 0 || compareRational(ceiling, maximum) > 0) {
    fail("CUT_AUDIO_REACTIVE_VALUE", `normalization bounds must stay between 0 and ${referenceAudioReactiveAnalysisLimits.maximumAbsoluteInputSample} linear amplitude.`);
  }
  if (compareRational(floor, ceiling) >= 0) {
    fail("CUT_AUDIO_REACTIVE_NOOP", "normalization.ceiling must be strictly greater than normalization.floor; an empty mapping cannot modulate a property.");
  }
  const floorNumber = rationalToNumber(floor), ceilingNumber = rationalToNumber(ceiling);
  if (!Number.isFinite(floorNumber) || !Number.isFinite(ceilingNumber) || ceilingNumber <= floorNumber) {
    fail("CUT_AUDIO_REACTIVE_VALUE", "normalization bounds must remain finite and distinct in the reference IEEE-754 analysis kernel.");
  }
  return Object.freeze({ kind, floor: Object.freeze({ ...floor }), ceiling: Object.freeze({ ...ceiling }) });
}

function smoothing(value: unknown, sampleRate: number): ReferenceAudioReactiveSmoothing {
  const record = plainRecord(value, ["kind", "attackFrames", "releaseFrames"], "CUT_AUDIO_REACTIVE_TYPE", "audio-reactive smoothing");
  const kind = enumValue(record.kind, ["attack-release-one-pole"] as const, "smoothing.kind");
  const attackFrames = safeInteger(record.attackFrames, 1, sampleRate * referenceAudioReactiveAnalysisLimits.maximumAttackSeconds, "CUT_AUDIO_REACTIVE_VALUE", "smoothing.attackFrames");
  const releaseFrames = safeInteger(record.releaseFrames, 1, sampleRate * referenceAudioReactiveAnalysisLimits.maximumReleaseSeconds, "CUT_AUDIO_REACTIVE_VALUE", "smoothing.releaseFrames");
  return Object.freeze({ kind, attackFrames, releaseFrames });
}

function planSemantic(plan: Omit<ReferenceAudioReactiveAnalysisPlan, "integrity">) {
  return plan;
}

/**
 * Compile the complete offline analysis contract without allocating PCM-sized
 * storage. `range` is expressed on the decoded source clock at `sampleRate`;
 * `compositionStartFrame` maps range.startFrame to the composition clock.
 */
export function compileReferenceAudioReactiveAnalysisPlan(input: ReferenceAudioReactiveAnalysisPlanInput): ReferenceAudioReactiveAnalysisPlan {
  const record = plainRecord(input, [
    "source",
    "sampleRate",
    "range",
    "compositionStartFrame",
    "windowFrames",
    "hopFrames",
    "detector",
    "channelMode",
    "normalization",
    "smoothing",
  ], "CUT_AUDIO_REACTIVE_TYPE", "audio-reactive analysis plan input");
  const source = lockedSource(record.source);
  const sampleRate = safeInteger(record.sampleRate, referenceAudioReactiveAnalysisLimits.minimumSampleRate, referenceAudioReactiveAnalysisLimits.maximumSampleRate, "CUT_AUDIO_REACTIVE_VALUE", "analysis sampleRate");
  const rangeRecord = plainRecord(record.range, ["startFrame", "endFrame"], "CUT_AUDIO_REACTIVE_TYPE", "analysis range");
  const startFrame = safeInteger(rangeRecord.startFrame, 0, Number.MAX_SAFE_INTEGER, "CUT_AUDIO_REACTIVE_RANGE", "range.startFrame");
  const endFrame = safeInteger(rangeRecord.endFrame, 1, Number.MAX_SAFE_INTEGER, "CUT_AUDIO_REACTIVE_RANGE", "range.endFrame");
  if (endFrame <= startFrame) fail("CUT_AUDIO_REACTIVE_NOOP", "analysis range must be a non-empty half-open source-frame interval.");
  const rangeFrames = endFrame - startFrame;
  if (!Number.isSafeInteger(rangeFrames) || rangeFrames > referenceAudioReactiveAnalysisLimits.maximumInputFrames) {
    fail("CUT_AUDIO_REACTIVE_RESOURCE", `analysis range exceeds maxInputFrames=${referenceAudioReactiveAnalysisLimits.maximumInputFrames}.`);
  }
  if (rangeFrames < 2) {
    fail("CUT_AUDIO_REACTIVE_NOOP", "analysis range must leave room for a full causal window and a later in-range event.");
  }
  const compositionStartFrame = safeInteger(record.compositionStartFrame, 0, Number.MAX_SAFE_INTEGER, "CUT_AUDIO_REACTIVE_RANGE", "compositionStartFrame");
  if (!Number.isSafeInteger(compositionStartFrame + rangeFrames)) {
    fail("CUT_AUDIO_REACTIVE_RANGE", "analysis range has an unsafe composition-clock end frame.");
  }
  const maximumWindowFrames = Math.min(rangeFrames - 1, sampleRate * referenceAudioReactiveAnalysisLimits.maximumWindowSeconds);
  const windowFrames = safeInteger(record.windowFrames, 1, Math.max(0, maximumWindowFrames), "CUT_AUDIO_REACTIVE_VALUE", "windowFrames");
  const hopFrames = safeInteger(record.hopFrames, 1, windowFrames, "CUT_AUDIO_REACTIVE_VALUE", "hopFrames");
  const detector = enumValue(record.detector, ["peak", "rms"] as const, "detector");
  const mode = enumValue(record.channelMode, [channelMode] as const, "channelMode");
  const normalized = normalization(record.normalization, detector);
  const smoothed = smoothing(record.smoothing, sampleRate);

  // Full causal windows end at range.start + window, then advance by hop.
  // The strict `< range.end` event condition keeps every measured value inside
  // the active range; the final sub-hop interval intentionally holds the last
  // known causal value rather than observing samples from its future.
  const windowCount = Math.floor((rangeFrames - 1 - windowFrames) / hopFrames) + 1;
  if (!Number.isSafeInteger(windowCount) || windowCount < 1) {
    fail("CUT_AUDIO_REACTIVE_NOOP", "analysis range must contain at least one full causal window whose event occurs before range.endFrame.");
  }
  if (windowCount > referenceAudioReactiveAnalysisLimits.maximumOutputWindows) {
    fail("CUT_AUDIO_REACTIVE_RESOURCE", `analysis would emit ${windowCount} windows; maximum is ${referenceAudioReactiveAnalysisLimits.maximumOutputWindows}.`);
  }
  const work = BigInt(windowCount) * BigInt(windowFrames) * 2n;
  if (work > BigInt(referenceAudioReactiveAnalysisLimits.maximumDetectorChannelSamples)) {
    fail("CUT_AUDIO_REACTIVE_RESOURCE", `analysis detector work exceeds maximumDetectorChannelSamples=${referenceAudioReactiveAnalysisLimits.maximumDetectorChannelSamples}.`);
  }
  const detectorWorkChannelSamples = Number(work);
  const base = Object.freeze({
    format: planFormat,
    version: planVersion,
    algorithm,
    source,
    pcm: Object.freeze({ format: "raw-stereo-f32le" as const, layout: "interleaved" as const, channels: 2 as const, sampleRate }),
    range: Object.freeze({ startFrame, endFrame }),
    compositionStartFrame,
    windowFrames,
    hopFrames,
    detector,
    channelMode: mode,
    normalization: normalized,
    smoothing: smoothed,
    windowAlignment,
    windowCount,
    detectorWorkChannelSamples,
    outputRatioResolution: ratioResolution,
  });
  return Object.freeze({ ...base, integrity: hash(planSemantic(base)) });
}

function checkedPlan(value: unknown): ReferenceAudioReactiveAnalysisPlan {
  const record = plainRecord(value, [
    "format",
    "version",
    "algorithm",
    "source",
    "pcm",
    "range",
    "compositionStartFrame",
    "windowFrames",
    "hopFrames",
    "detector",
    "channelMode",
    "normalization",
    "smoothing",
    "windowAlignment",
    "windowCount",
    "detectorWorkChannelSamples",
    "outputRatioResolution",
    "integrity",
  ], "CUT_AUDIO_REACTIVE_TYPE", "compiled audio-reactive analysis plan");
  if (record.format !== planFormat || record.version !== planVersion || record.algorithm !== algorithm || record.windowAlignment !== windowAlignment) {
    fail("CUT_AUDIO_REACTIVE_IDENTITY", "compiled analysis plan has an unsupported format, version, algorithm, or window alignment.");
  }
  const pcm = plainRecord(record.pcm, ["format", "layout", "channels", "sampleRate"], "CUT_AUDIO_REACTIVE_TYPE", "compiled analysis PCM contract");
  if (pcm.format !== "raw-stereo-f32le" || pcm.layout !== "interleaved" || pcm.channels !== 2) {
    fail("CUT_AUDIO_REACTIVE_TYPE", "compiled analysis PCM must be interleaved raw stereo f32le.");
  }
  const rebuilt = compileReferenceAudioReactiveAnalysisPlan({
    source: record.source as ReferenceAudioReactiveLockedSource,
    sampleRate: pcm.sampleRate as number,
    range: record.range as { startFrame: number; endFrame: number },
    compositionStartFrame: record.compositionStartFrame as number,
    windowFrames: record.windowFrames as number,
    hopFrames: record.hopFrames as number,
    detector: record.detector as ReferenceAudioReactiveDetector,
    channelMode: record.channelMode as typeof channelMode,
    normalization: record.normalization as ReferenceAudioReactiveNormalization,
    smoothing: record.smoothing as ReferenceAudioReactiveSmoothing,
  });
  if (record.windowCount !== rebuilt.windowCount
    || record.detectorWorkChannelSamples !== rebuilt.detectorWorkChannelSamples
    || record.outputRatioResolution !== rebuilt.outputRatioResolution
    || record.integrity !== rebuilt.integrity) {
    fail("CUT_AUDIO_REACTIVE_IDENTITY", "compiled analysis plan does not match its canonical derived fields and integrity identity.");
  }
  return rebuilt;
}

/** Pre-decode cache lookup identity. Exact decoded content is verified separately. */
export function referenceAudioReactiveAnalysisCacheKey(planInput: ReferenceAudioReactiveAnalysisPlan) {
  const plan = checkedPlan(planInput);
  return hash({ format: cacheKeyFormat, version: cacheKeyVersion, planIntegrity: plan.integrity });
}

function isSharedBuffer(buffer: ArrayBufferLike) {
  return typeof SharedArrayBuffer !== "undefined" && buffer instanceof SharedArrayBuffer;
}

function canonicalF32LeSha256(input: Float32Array) {
  const digestValue = createHash("sha256");
  const chunkSamples = 16_384;
  const chunk = Buffer.allocUnsafe(chunkSamples * 4);
  for (let offset = 0; offset < input.length; offset += chunkSamples) {
    const count = Math.min(chunkSamples, input.length - offset);
    for (let index = 0; index < count; index += 1) chunk.writeFloatLE(input[offset + index]!, index * 4);
    digestValue.update(chunk.subarray(0, count * 4));
  }
  return digestValue.digest("hex");
}

function normalizedPcm(value: unknown, plan: ReferenceAudioReactiveAnalysisPlan) {
  let candidate: Float32Array;
  try {
    if (!(value instanceof Float32Array)
      || Object.getPrototypeOf(value) !== Float32Array.prototype
      || isSharedBuffer(value.buffer)) {
      fail("CUT_AUDIO_REACTIVE_PCM", "analysis PCM must be one direct non-shared interleaved Float32Array.");
    }
    if (value.length % 2 !== 0) fail("CUT_AUDIO_REACTIVE_PCM", "analysis PCM must contain complete interleaved stereo frames.");
    const expectedFrames = plan.range.endFrame - plan.range.startFrame;
    if (value.length !== expectedFrames * 2) {
      fail("CUT_AUDIO_REACTIVE_PCM", `analysis PCM must contain exactly ${expectedFrames} stereo frames for the selected half-open range.`);
    }
    if (value.length > referenceAudioReactiveAnalysisLimits.maximumInputFrames * 2) {
      fail("CUT_AUDIO_REACTIVE_RESOURCE", "analysis PCM exceeds the channel-sample allocation bound.");
    }
    candidate = new Float32Array(value);
  } catch (error) {
    if (error instanceof ReferenceAudioReactiveAnalysisError) throw error;
    fail("CUT_AUDIO_REACTIVE_PCM", "analysis PCM could not be snapshotted safely.");
  }
  for (let index = 0; index < candidate.length; index += 1) {
    const sample = candidate[index]!;
    if (!Number.isFinite(sample) || Math.abs(sample) > referenceAudioReactiveAnalysisLimits.maximumAbsoluteInputSample) {
      const frame = Math.floor(index / 2), channel = index % 2 === 0 ? "left" : "right";
      fail("CUT_AUDIO_REACTIVE_PCM", `analysis PCM ${channel} sample at range-relative frame ${frame} must be finite and within ±${referenceAudioReactiveAnalysisLimits.maximumAbsoluteInputSample}.`);
    }
  }
  return Object.freeze({ samples: candidate, sha256: canonicalF32LeSha256(candidate) });
}

function ratioValue(units: number): ReferenceAudioReactiveRatioValue {
  return Object.freeze({
    kind: "quantity",
    dimension: "ratio",
    magnitude: Object.freeze({ ...rational(units, ratioResolution) }),
    unit: "ratio",
  });
}

function detectorAmplitude(input: Float32Array, startFrame: number, endFrame: number, detector: ReferenceAudioReactiveDetector) {
  if (detector === "peak") {
    let peak = 0;
    for (let frame = startFrame; frame < endFrame; frame += 1) {
      peak = Math.max(peak, Math.abs(input[frame * 2]!), Math.abs(input[frame * 2 + 1]!));
    }
    return peak;
  }
  let sumSquares = 0;
  for (let frame = startFrame; frame < endFrame; frame += 1) {
    const left = input[frame * 2]!, right = input[frame * 2 + 1]!;
    sumSquares += left * left + right * right;
  }
  return Math.sqrt(sumSquares / ((endFrame - startFrame) * 2));
}

function outputRatioUnits(amplitude: number, floor: number, ceiling: number) {
  const normalized = Math.max(0, Math.min(1, (amplitude - floor) / (ceiling - floor)));
  return Math.max(0, Math.min(ratioResolution, Math.round(normalized * ratioResolution)));
}

function variationOf(units: readonly number[]): ReferenceAudioReactiveWindowVariation {
  if (units.every((value) => value === 0)) return "silence";
  const first = units[0]!;
  return units.every((value) => value === first) ? "constant" : "varying";
}

/**
 * Analyze an exact selected-range snapshot into a typed composition-clock
 * Ratio track. Each window is `[event-window, event)`: the event never reads
 * the sample at its own time or any future sample. Signal events are emitted
 * only when the quantized Ratio changes, plus one nonredundant zero reset at
 * the selected range end when necessary.
 */
export function analyzeReferenceAudioReactiveStereo(
  interleavedStereoF32: Float32Array,
  planInput: ReferenceAudioReactiveAnalysisPlan,
): ReferenceAudioReactiveAnalysisResult {
  const plan = checkedPlan(planInput);
  const input = normalizedPcm(interleavedStereoF32, plan);
  const floor = rationalToNumber(plan.normalization.floor);
  const ceiling = rationalToNumber(plan.normalization.ceiling);
  const attackCoefficient = Math.exp(-plan.hopFrames / plan.smoothing.attackFrames);
  const releaseCoefficient = Math.exp(-plan.hopFrames / plan.smoothing.releaseFrames);
  if (!Number.isFinite(attackCoefficient) || !Number.isFinite(releaseCoefficient)) {
    fail("CUT_AUDIO_REACTIVE_VALUE", "analysis smoothing coefficients are not finite.");
  }

  const windows: ReferenceAudioReactiveAnalysisWindow[] = [];
  const units: number[] = [];
  let envelope: number | undefined;
  let maximumDetectorAmplitude = 0;
  let maximumSmoothedAmplitude = 0;
  for (let index = 0; index < plan.windowCount; index += 1) {
    const relativeEnd = plan.windowFrames + index * plan.hopFrames;
    const relativeStart = relativeEnd - plan.windowFrames;
    const measured = detectorAmplitude(input.samples, relativeStart, relativeEnd, plan.detector);
    if (!Number.isFinite(measured)) fail("CUT_AUDIO_REACTIVE_PCM", `analysis detector produced a non-finite value at window ${index}.`);
    if (envelope === undefined) envelope = measured;
    else {
      const coefficient = measured > envelope ? attackCoefficient : releaseCoefficient;
      envelope = coefficient * envelope + (1 - coefficient) * measured;
    }
    if (!Number.isFinite(envelope)) fail("CUT_AUDIO_REACTIVE_PCM", `analysis smoother produced a non-finite value at window ${index}.`);
    const ratioUnits = outputRatioUnits(envelope, floor, ceiling);
    const compositionFrame = plan.compositionStartFrame + relativeEnd;
    const value = ratioValue(ratioUnits);
    windows.push(Object.freeze({
      index,
      sourceStartFrame: plan.range.startFrame + relativeStart,
      sourceEndFrame: plan.range.startFrame + relativeEnd,
      compositionFrame,
      compositionTime: Object.freeze({ ...rational(compositionFrame, plan.pcm.sampleRate) }),
      detectorAmplitude: measured,
      smoothedAmplitude: envelope,
      ratioUnits,
      value,
    }));
    units.push(ratioUnits);
    maximumDetectorAmplitude = Math.max(maximumDetectorAmplitude, measured);
    maximumSmoothedAmplitude = Math.max(maximumSmoothedAmplitude, envelope);
  }

  const zero = ratioValue(0);
  const events: Array<{ kind: "set"; time: Rational; value: ReferenceAudioReactiveRatioValue }> = [];
  let currentUnits = 0;
  for (const window of windows) {
    if (window.ratioUnits === currentUnits) continue;
    events.push(Object.freeze({ kind: "set", time: window.compositionTime, value: window.value }));
    currentUnits = window.ratioUnits;
  }
  if (currentUnits !== 0) {
    const compositionEndFrame = plan.compositionStartFrame + (plan.range.endFrame - plan.range.startFrame);
    events.push(Object.freeze({
      kind: "set",
      time: Object.freeze({ ...rational(compositionEndFrame, plan.pcm.sampleRate) }),
      value: zero,
    }));
  }
  const signal = Object.freeze({
    clock: Object.freeze({ kind: "composition-sample" as const, sampleRate: plan.pcm.sampleRate }),
    kind: "track" as const,
    valueType: "Ratio" as const,
    initial: zero,
    events: Object.freeze(events),
  });
  const signalSha256 = hash(signal);
  const windowVariation = variationOf(units);
  const cacheKey = referenceAudioReactiveAnalysisCacheKey(plan);
  const contentSemantic = Object.freeze({
    format: contentFormat,
    version: contentVersion,
    planIntegrity: plan.integrity,
    inputPcmSha256: input.sha256,
    signalSha256,
    windowCount: windows.length,
    windowVariation,
  });
  return Object.freeze({
    ...contentSemantic,
    cacheKey,
    contentIntegrity: hash(contentSemantic),
    windows: Object.freeze(windows),
    signal,
    hasMeasuredModulation: windowVariation === "varying",
    maximumDetectorAmplitude,
    maximumSmoothedAmplitude,
    processedChannelSamples: plan.detectorWorkChannelSamples,
  });
}
