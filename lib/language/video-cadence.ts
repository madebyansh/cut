import {
  addRational,
  compareRational,
  divideRational,
  multiplyRational,
  rational,
  type Rational,
  zeroRational,
} from "./rational";

/**
 * A bounded full-stream decode scan proving one exact constant-rate picture
 * cadence when the container exposes no selected-stream duration.
 *
 * The summary is deliberately reproducible from the locked bytes. It is not a
 * declaration that a container-wide duration belongs to this stream.
 */
export type CutDecodedVideoCadence = {
  format: "cut-decoded-video-cadence";
  version: 2;
  method: "ffprobe-show-frames-cfr-v2";
  quantization: "phase-floor";
  /** Exact phase numerator in [0, frame-period denominator). */
  phaseNumerator: string;
  streamIndex: number;
  firstPts: string;
  lastPts: string;
  quantizedEndPts: string;
  frameCount: string;
  durationPresentCount: string;
  durationCoverage: "complete" | "partial" | "none";
  recordsSha256: string;
  timeBase: Rational;
  frameRate: Rational;
};

export type CutDecodedVideoCadenceStream = {
  index: number;
  start?: Rational;
  timeBase?: Rational;
  frameRate?: Rational;
  averageFrameRate?: Rational;
};

const canonicalInteger = /^-?(?:0|[1-9]\d*)$/u;
const canonicalPositiveInteger = /^[1-9]\d*$/u;
export const maximumDecodedVideoCadenceFrames = 200_000n;
const sha256 = /^[a-f0-9]{64}$/u;
export const decodedVideoCadenceQuantizations = ["phase-floor"] as const;

export function quantizedVideoCadenceOffset(index: bigint, numerator: bigint, denominator: bigint, mode: CutDecodedVideoCadence["quantization"]) {
  if (index < 0n || numerator <= 0n || denominator <= 0n) throw new Error("quantized cadence inputs must be positive");
  if (mode !== "phase-floor") throw new Error("unsupported decoded cadence quantization");
  return valuePhaseQuantizedVideoCadenceOffset(index, numerator, denominator, 0n);
}

export function valuePhaseQuantizedVideoCadenceOffset(index: bigint, numerator: bigint, denominator: bigint, phaseNumerator: bigint) {
  if (index < 0n || numerator <= 0n || denominator <= 0n || phaseNumerator < 0n || phaseNumerator >= denominator) {
    throw new Error("phase-quantized cadence inputs are outside their exact bounds");
  }
  return (phaseNumerator + index * numerator) / denominator;
}

function exactInteger(value: string, positive: boolean) {
  if (!(positive ? canonicalPositiveInteger : canonicalInteger).test(value) || value.length > 256) {
    throw new Error(positive ? "must be a canonical positive integer" : "must be a canonical integer");
  }
  return BigInt(value);
}

function exactPositiveRational(value: Rational, label: string) {
  const exact = rational(value.numerator, value.denominator);
  if (exact.numerator !== value.numerator || exact.denominator !== value.denominator || compareRational(exact, zeroRational) <= 0) {
    throw new Error(`${label} must be one canonical positive rational`);
  }
  return exact;
}

/**
 * Revalidate a stored cadence summary and return its stream-relative duration.
 * Every decoded-frame continuity assertion is made while producing the
 * witness; this pure check proves the retained summary is internally exact and
 * still belongs to the selected stream metadata.
 */
export function decodedVideoCadenceDuration(
  witness: CutDecodedVideoCadence,
  stream: CutDecodedVideoCadenceStream,
): Rational {
  if (witness.format !== "cut-decoded-video-cadence" || witness.version !== 2 || witness.method !== "ffprobe-show-frames-cfr-v2" || !decodedVideoCadenceQuantizations.includes(witness.quantization)) {
    throw new Error("requires cut-decoded-video-cadence v2 from ffprobe-show-frames-cfr-v2");
  }
  if (!Number.isSafeInteger(witness.streamIndex) || witness.streamIndex < 0 || witness.streamIndex !== stream.index) {
    throw new Error("streamIndex must match the selected video stream");
  }
  if (!stream.start || compareRational(stream.start, zeroRational) < 0) {
    throw new Error("selected video stream must expose one exact non-negative start");
  }
  if (!stream.timeBase || (!stream.frameRate && !stream.averageFrameRate)) {
    throw new Error("selected video stream must expose exact timeBase and frameRate metadata");
  }
  const timeBase = exactPositiveRational(witness.timeBase, "witness timeBase");
  const frameRate = exactPositiveRational(witness.frameRate, "witness frameRate");
  const rateMatches = [stream.frameRate, stream.averageFrameRate].some((candidate) => candidate && compareRational(frameRate, candidate) === 0);
  if (compareRational(timeBase, stream.timeBase) !== 0 || !rateMatches) {
    throw new Error("witness timeBase and frameRate must match one retained selected-stream rate candidate");
  }

  const firstPts = exactInteger(witness.firstPts, false);
  const lastPts = exactInteger(witness.lastPts, false);
  const quantizedEndPts = exactInteger(witness.quantizedEndPts, false);
  const phaseNumerator = exactInteger(witness.phaseNumerator, false);
  const frameCount = exactInteger(witness.frameCount, true);
  const durationPresentCount = exactInteger(witness.durationPresentCount, false);
  if (durationPresentCount < 0n || durationPresentCount > frameCount) throw new Error("durationPresentCount must be between zero and frameCount");
  const expectedCoverage = durationPresentCount === 0n ? "none" : durationPresentCount === frameCount ? "complete" : "partial";
  if (witness.durationCoverage !== expectedCoverage) throw new Error("durationCoverage must match durationPresentCount");
  if (!sha256.test(witness.recordsSha256)) throw new Error("recordsSha256 must be one lowercase SHA-256 digest");
  if (frameCount > maximumDecodedVideoCadenceFrames) throw new Error(`decoded cadence exceeds the ${maximumDecodedVideoCadenceFrames}-frame provenance bound`);
  const first = multiplyRational(rational(firstPts), timeBase);
  if (compareRational(first, stream.start) !== 0) {
    throw new Error("first decoded frame PTS must equal the selected video stream start");
  }
  const framePeriodTicks = divideRational(divideRational(rational(1), frameRate), timeBase);
  const periodNumerator = BigInt(framePeriodTicks.numerator), periodDenominator = BigInt(framePeriodTicks.denominator);
  if (periodNumerator / periodDenominator < 1n) throw new Error("ideal frame period must span at least one codec time-base tick");
  if (phaseNumerator < 0n || phaseNumerator >= periodDenominator) throw new Error("phaseNumerator must be within one exact frame-period denominator");
  const expectedLastPts = firstPts + valuePhaseQuantizedVideoCadenceOffset(frameCount - 1n, periodNumerator, periodDenominator, phaseNumerator);
  if (lastPts !== expectedLastPts) {
    throw new Error("last decoded frame PTS must close the retained quantized ideal cadence");
  }
  const expectedEndPts = firstPts + valuePhaseQuantizedVideoCadenceOffset(frameCount, periodNumerator, periodDenominator, phaseNumerator);
  if (quantizedEndPts !== expectedEndPts) throw new Error("quantizedEndPts must close the semantic frame-count duration");
  const finalGap = quantizedEndPts - lastPts, floorGap = periodNumerator / periodDenominator, ceilGap = (periodNumerator + periodDenominator - 1n) / periodDenominator;
  if (finalGap !== floorGap && finalGap !== ceilGap) throw new Error("final quantized cadence gap must be floor or ceil of one ideal frame period");
  return divideRational(rational(frameCount), frameRate);
}

export function decodedVideoCadenceEnd(witness: CutDecodedVideoCadence, stream: CutDecodedVideoCadenceStream) {
  return addRational(stream.start!, decodedVideoCadenceDuration(witness, stream));
}
