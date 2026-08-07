import {
  compareRational,
  divideRational,
  multiplyRational,
  rational,
  subtractRational,
  type Rational,
  zeroRational,
} from "./rational";

/**
 * Canonical proof of the sample-domain extent delivered by one exact decoded
 * audio stream. `decodedSampleCount` is post decoder priming/discard handling;
 * a short terminal packet duration may additionally remove encoded tail
 * padding that libav exposes in the last frame's duration but retains in
 * `nb_samples` (notably AAC in MP4).
 */
type CutDecodedAudioSamplesCommon = {
  format: "cut-decoded-audio-samples";
  phaseNumerator: string;
  streamIndex: number;
  firstPts: string;
  lastPts: string;
  frameCount: string;
  decoderOutputSampleCount: string;
  decoderPcmSha256: string;
  decodedSampleCount: string;
  terminalTrimSamples: string;
  durationPresentCount: string;
  durationCoverage: "complete" | "partial" | "none";
  recordsSha256: string;
  timeBase: Rational;
  sampleRate: number;
};

/**
 * Historical 0.4-alpha witness shape. It remains structurally readable for
 * bounded parsing and inspection, but no persisted v1 conformance fixture or
 * frozen v1 scanner exists in this repository. Current native verification
 * emits v2 and therefore requires the resource to be relocked before replay.
 */
export type CutDecodedAudioSamplesV1 = CutDecodedAudioSamplesCommon & {
  version: 1;
  method: "ffprobe-show-frames-audio-v1";
  quantization: "phase-floor";
  trimSemantics: "decoder-output-plus-terminal-duration";
};

/**
 * Current decoded-sample witness. Most decoders timestamp each AVFrame at the
 * first sample it contributes. Some valid variable-block codecs (notably
 * chained/concatenated Vorbis) instead emit a larger boundary frame whose
 * short presentation duration closes on the cumulative decoder-output clock.
 * Those extra, actually decoded samples fill the discontinuity immediately
 * before that frame's PTS; they are neither synthetic silence nor tail trim.
 */
export type CutDecodedAudioSamplesV2 = CutDecodedAudioSamplesCommon & {
  version: 2;
  method: "ffprobe-show-frames-audio-v2";
  quantization: "phase-floor-start-or-exact-end";
  trimSemantics: "decoder-output-sequence-plus-terminal-duration";
  leadingDiscontinuityFrameCount: string;
  leadingDiscontinuitySampleCount: string;
};

export type CutDecodedAudioSamples = CutDecodedAudioSamplesV1 | CutDecodedAudioSamplesV2;

export type CutDecodedAudioStream = {
  index: number;
  timeBase?: Rational;
  sampleRate?: number;
  duration?: Rational;
};

export const maximumDecodedAudioFrameRecords = 2_000_000n;
export const maximumDecodedAudioSamples = 2_147_483_647n;

const canonicalInteger = /^-?(?:0|[1-9]\d*)$/u;
const canonicalNonNegativeInteger = /^(?:0|[1-9]\d*)$/u;
const canonicalPositiveInteger = /^[1-9]\d*$/u;
const sha256 = /^[a-f0-9]{64}$/u;

function integer(value: string, label: string, positive = false, nonNegative = false) {
  const pattern = positive ? canonicalPositiveInteger : nonNegative ? canonicalNonNegativeInteger : canonicalInteger;
  if (!pattern.test(value) || value === "-0") throw new Error(`${label} must be one canonical ${positive ? "positive " : nonNegative ? "non-negative " : ""}integer`);
  return BigInt(value);
}

function exactEqual(left: Rational | undefined, right: Rational) {
  return left !== undefined && compareRational(left, right) === 0;
}

function absolute(value: Rational) {
  return compareRational(value, zeroRational) < 0
    ? rational((-BigInt(value.numerator)).toString(), value.denominator)
    : value;
}

/**
 * Validate a witness against the raw selected-stream identity and return its
 * authoritative decoded source duration. Raw stream duration is observation
 * only; when present it must corroborate the decoded authority within one
 * codec tick (or one sample when that is larger).
 */
export function decodedAudioSamplesDuration(
  witness: CutDecodedAudioSamples,
  stream: CutDecodedAudioStream,
): Rational {
  const historical = witness.format === "cut-decoded-audio-samples"
    && witness.version === 1
    && witness.method === "ffprobe-show-frames-audio-v1"
    && witness.quantization === "phase-floor"
    && witness.trimSemantics === "decoder-output-plus-terminal-duration";
  const current = witness.format === "cut-decoded-audio-samples"
    && witness.version === 2
    && witness.method === "ffprobe-show-frames-audio-v2"
    && witness.quantization === "phase-floor-start-or-exact-end"
    && witness.trimSemantics === "decoder-output-sequence-plus-terminal-duration";
  if (!historical && !current) {
    throw new Error("requires a supported cut-decoded-audio-samples witness");
  }
  if (!Number.isSafeInteger(witness.streamIndex) || witness.streamIndex < 0 || witness.streamIndex !== stream.index) {
    throw new Error("decoded audio witness stream index does not match the selected stream");
  }
  if (!Number.isSafeInteger(witness.sampleRate) || witness.sampleRate < 1 || witness.sampleRate !== stream.sampleRate) {
    throw new Error("decoded audio witness sample rate does not match the selected stream");
  }
  if (!stream.timeBase || compareRational(stream.timeBase, zeroRational) <= 0 || !exactEqual(stream.timeBase, witness.timeBase)) {
    throw new Error("decoded audio witness time base does not match the selected stream");
  }
  const frameCount = integer(witness.frameCount, "decoded audio frameCount", true);
  const decoderOutputSampleCount = integer(witness.decoderOutputSampleCount, "decoded audio decoderOutputSampleCount", true);
  const decodedSampleCount = integer(witness.decodedSampleCount, "decoded audio decodedSampleCount", true);
  const terminalTrimSamples = integer(witness.terminalTrimSamples, "decoded audio terminalTrimSamples", false, true);
  const durationPresentCount = integer(witness.durationPresentCount, "decoded audio durationPresentCount", false, true);
  const firstPts = integer(witness.firstPts, "decoded audio firstPts");
  const lastPts = integer(witness.lastPts, "decoded audio lastPts");
  const phaseNumerator = integer(witness.phaseNumerator, "decoded audio phaseNumerator", false, true);
  if (frameCount > maximumDecodedAudioFrameRecords) throw new Error(`decoded audio exceeds the ${maximumDecodedAudioFrameRecords}-frame provenance bound`);
  if (decodedSampleCount > maximumDecodedAudioSamples) throw new Error(`decoded audio exceeds the ${maximumDecodedAudioSamples}-sample provenance bound`);
  if (decoderOutputSampleCount > maximumDecodedAudioSamples) throw new Error(`decoded audio decoder output exceeds the ${maximumDecodedAudioSamples}-sample provenance bound`);
  if (terminalTrimSamples > maximumDecodedAudioSamples - decodedSampleCount) throw new Error("decoded audio terminal trim overflows its bounded sample domain");
  if (decodedSampleCount + terminalTrimSamples !== decoderOutputSampleCount) throw new Error("decoded audio retained samples plus terminal trim must equal independently decoded PCM samples");
  if (durationPresentCount > frameCount) throw new Error("decoded audio durationPresentCount exceeds frameCount");
  if (witness.version === 2) {
    const discontinuityFrames = integer(witness.leadingDiscontinuityFrameCount, "decoded audio leadingDiscontinuityFrameCount", false, true);
    const discontinuitySamples = integer(witness.leadingDiscontinuitySampleCount, "decoded audio leadingDiscontinuitySampleCount", false, true);
    if (discontinuityFrames > frameCount) throw new Error("decoded audio leadingDiscontinuityFrameCount exceeds frameCount");
    if (discontinuitySamples >= decoderOutputSampleCount) throw new Error("decoded audio leadingDiscontinuitySampleCount must be smaller than decoder output");
    if ((discontinuityFrames === 0n) !== (discontinuitySamples === 0n)) {
      throw new Error("decoded audio leading-discontinuity frame/sample counts must both be zero or both be positive");
    }
  }
  const expectedCoverage = durationPresentCount === 0n ? "none" : durationPresentCount === frameCount ? "complete" : "partial";
  if (witness.durationCoverage !== expectedCoverage) throw new Error("decoded audio durationCoverage does not match durationPresentCount");
  if (frameCount === 1n ? firstPts !== lastPts : firstPts >= lastPts) throw new Error("decoded audio first/last PTS order does not match frameCount");
  const phaseDenominator = BigInt(witness.sampleRate) * BigInt(witness.timeBase.numerator);
  if (phaseDenominator <= 0n || phaseNumerator >= phaseDenominator) throw new Error("decoded audio phase is outside one sample-grid quantization period");
  if (!sha256.test(witness.recordsSha256)) throw new Error("decoded audio recordsSha256 must be one lowercase SHA-256 digest");
  if (!sha256.test(witness.decoderPcmSha256)) throw new Error("decoded audio decoderPcmSha256 must be one lowercase SHA-256 digest");

  const duration = divideRational(rational(decodedSampleCount), rational(witness.sampleRate));
  if (stream.duration && compareRational(stream.duration, zeroRational) > 0) {
    const delta = absolute(subtractRational(stream.duration, duration));
    const samplePeriod = rational(1, witness.sampleRate);
    const tolerance = compareRational(stream.timeBase, samplePeriod) >= 0 ? stream.timeBase : samplePeriod;
    if (compareRational(delta, tolerance) > 0) {
      throw new Error("selected stream duration does not corroborate the decoded audio sample bound within one codec tick");
    }
  }
  // The multiplication is deliberately evaluated here: it catches malformed
  // rational implementations/inputs before this witness can enter cache or IR
  // identity even though equality was checked above.
  if (multiplyRational(duration, rational(witness.sampleRate)).denominator !== "1") {
    throw new Error("decoded audio duration does not land on its sample grid");
  }
  return duration;
}
