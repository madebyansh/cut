import { constants as fsConstants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import type { ReferenceAudioPeakSource } from "./audio-peak";
import { referenceAudioPeakLimits } from "./audio-peak";

export type ReferenceAudioTruePeakErrorCode =
  | "CUT_AUDIO_TRUE_PEAK_EXCEEDED"
  | "CUT_AUDIO_TRUE_PEAK_NONFINITE"
  | "CUT_AUDIO_TRUE_PEAK_STRUCTURE"
  | "CUT_AUDIO_TRUE_PEAK_SAMPLE_RATE_UNSUPPORTED"
  | "CUT_AUDIO_TRUE_PEAK_RESOURCE_LIMIT";

export type ReferenceAudioTruePeakChannel = 0 | 1;

export type ReferenceAudioTruePeakErrorDetail = Readonly<{
  kind: "true-peak" | "nonfinite" | "structure" | "resource";
  reason: string;
  expectedFrames?: number;
  expectedBytes?: number;
  observedBytes?: number;
  frame?: number;
  channel?: ReferenceAudioTruePeakChannel;
  channelName?: "left" | "right";
  sample?: number;
  oversampledIndex?: number;
  oversamplePhase?: 0 | 1 | 2 | 3;
  peakLinear?: number;
  peakDbtp?: number;
  thresholdDbtp?: number;
  thresholdLinear?: number;
  peakKind?: "sample" | "intersample";
  /** Group-delay-compensated position in source-frame units, numerator / 8. */
  peakTimeEighthFrames?: string;
  firMultiplyAdds?: number;
  firMultiplyAddLimit?: number;
}>;

export class ReferenceAudioTruePeakError extends Error {
  readonly source: ReferenceAudioPeakSource;
  readonly detail: ReferenceAudioTruePeakErrorDetail;

  constructor(
    readonly code: ReferenceAudioTruePeakErrorCode,
    source: ReferenceAudioPeakSource,
    message: string,
    detail: ReferenceAudioTruePeakErrorDetail,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "ReferenceAudioTruePeakError";
    this.source = Object.freeze({ ...source });
    this.detail = Object.freeze({ ...detail });
  }
}

export const referenceAudioTruePeakIdentity =
  "cut.true-peak/itu-r-bs.1770-5-annex-2-f32le-stereo-48khz-fir48-4x-zero-extended-sample-floor-first-tie-v2";

/** SHA-256 of JSON.stringify(referenceAudioTruePeakCoefficients). */
export const referenceAudioTruePeakCoefficientFingerprint =
  "sha256:2140fb1d2d303b567fb5786df874cc18a23390c163f6310f96ae54a9c75588a6";

/**
 * The 48-order, four-phase interpolating FIR published in ITU-R BS.1770-5,
 * Annex 2. Rows are successive input-frame delays and columns are the four
 * output phases. Decimal values are dyadic rationals, so JavaScript represents
 * every coefficient exactly before the deterministic multiply/add sequence.
 */
export const referenceAudioTruePeakCoefficients = Object.freeze([
  Object.freeze([0.001708984375, -0.0291748046875, -0.0189208984375, -0.00830078125]),
  Object.freeze([0.010986328125, 0.029296875, 0.0330810546875, 0.014892578125]),
  Object.freeze([-0.0196533203125, -0.0517578125, -0.0582275390625, -0.026611328125]),
  Object.freeze([0.033203125, 0.089111328125, 0.1015625, 0.047607421875]),
  Object.freeze([-0.0594482421875, -0.16650390625, -0.2003173828125, -0.102294921875]),
  Object.freeze([0.1373291015625, 0.465087890625, 0.77978515625, 0.97216796875]),
  Object.freeze([0.97216796875, 0.77978515625, 0.465087890625, 0.1373291015625]),
  Object.freeze([-0.102294921875, -0.2003173828125, -0.16650390625, -0.0594482421875]),
  Object.freeze([0.047607421875, 0.1015625, 0.089111328125, 0.033203125]),
  Object.freeze([-0.026611328125, -0.0582275390625, -0.0517578125, -0.0196533203125]),
  Object.freeze([0.014892578125, 0.0330810546875, 0.029296875, 0.010986328125]),
  Object.freeze([-0.00830078125, -0.0189208984375, -0.0291748046875, 0.001708984375]),
] as const);

const channels = 2;
const bytesPerSample = 4;
const bytesPerFrame = channels * bytesPerSample;
const phases = 4;
const tapsPerPhase = referenceAudioTruePeakCoefficients.length;
const firMultiplyAddsPerFrame = channels * phases * tapsPerPhase;
const supportedSampleRate = 48_000;
// A separate 2^32 MAC ceiling keeps one in-process JavaScript scan operationally
// bounded instead of inheriting only the much larger PCM byte boundary. At
// 48 kHz this is about 15.5 minutes of stereo programme. Longer programmes are
// an explicit pre-1.0 limitation until CUT has a proven native/WASM streaming
// implementation; silently starting tens of billions of scalar operations is
// not a useful resource contract.
const maximumFirMultiplyAdds = 2 ** 32;

export const referenceAudioTruePeakLimits = Object.freeze({
  channels,
  bytesPerFrame,
  oversampleFactor: phases,
  tapsPerPhase,
  supportedSampleRate,
  minimumThresholdDbtp: -600,
  // Authored Meter targets remain closed to -9..0 dBTP. The separate assertion
  // helper permits a positive diagnostic ceiling for bounded internal uses.
  maximumThresholdDbtp: 60,
  maximumFrames: referenceAudioPeakLimits.maximumFrames,
  firMultiplyAddsPerFrame,
  maximumFirMultiplyAdds,
  maximumChunkBytes: referenceAudioPeakLimits.maximumChunkBytes,
  maximumChunks: referenceAudioPeakLimits.maximumChunks,
  fileReadChunkBytes: referenceAudioPeakLimits.fileReadChunkBytes,
});

export type ReferenceAudioTruePeakScanOptions = Readonly<{
  expectedFrames: number;
  sampleRate: number;
  source: ReferenceAudioPeakSource;
}>;

export type ReferenceAudioTruePeakAssertionOptions = Readonly<{
  thresholdDbtp: number;
  source: ReferenceAudioPeakSource;
}>;

export type ReferenceAudioTruePeakScan = Readonly<{
  format: "cut-reference-audio-true-peak-scan";
  version: 2;
  algorithm: typeof referenceAudioTruePeakIdentity;
  coefficientFingerprint: typeof referenceAudioTruePeakCoefficientFingerprint;
  sampleFormat: "f32le";
  channels: 2;
  sampleRate: number;
  expectedFrames: number;
  observedFrames: number;
  expectedBytes: number;
  observedBytes: number;
  oversampleFactor: 4;
  tapsPerPhase: 12;
  firMultiplyAdds: number;
  silent: boolean;
  samplePeakLinear: number;
  samplePeakDbfs: number | null;
  firPeakLinear: number;
  truePeakLinear: number;
  truePeakDbtp: number | null;
  peakKind: "sample" | "intersample" | null;
  peakFrame: number | null;
  peakChannel: ReferenceAudioTruePeakChannel | null;
  peakChannelName: "left" | "right" | null;
  oversampledIndex: number | null;
  oversamplePhase: 0 | 1 | 2 | 3 | null;
  /** Group-delay-compensated position in source-frame units, numerator / 8. */
  peakTimeEighthFrames: string | null;
}>;

type ReferenceAudioByteStream = AsyncIterable<Uint8Array> | Iterable<Uint8Array>;

type Contract = Readonly<{
  expectedFrames: number;
  expectedBytes: number;
  sampleRate: number;
  firMultiplyAdds: number;
  source: ReferenceAudioPeakSource;
}>;

type SamplePeak = Readonly<{
  linear: number;
  frame: number;
  channel: ReferenceAudioTruePeakChannel;
}>;

type FirPeak = Readonly<{
  linear: number;
  oversampledIndex: number;
  phase: 0 | 1 | 2 | 3;
  channel: ReferenceAudioTruePeakChannel;
}>;

function stableNumber(value: unknown) {
  if (typeof value !== "number") {
    if (value === null) return "null";
    if (typeof value === "string") return value.length <= 64 ? JSON.stringify(value) : '"<string>"';
    if (typeof value === "boolean" || typeof value === "undefined") return String(value);
    // BigInts, Symbols, cyclic objects, hostile toJSON methods and accessors
    // must never become uncoded failures or diagnostic-amplification vectors.
    return `<${typeof value}>`;
  }
  if (Object.is(value, -0)) return "-0";
  if (Number.isInteger(value)) return String(value);
  return value.toPrecision(12).replace(/(?:\.0+|(?:(\.\d*?[1-9])0+))(?=e|$)/u, "$1");
}

const fallbackSource: ReferenceAudioPeakSource = Object.freeze({
  module: "<true-peak-runtime>",
  line: 1,
  column: 1,
});

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function normalizedSource(value: unknown): ReferenceAudioPeakSource {
  const source = record(value);
  if (!source
    || typeof source.module !== "string"
    || source.module.length === 0
    || source.module.length > 4_096
    || !Number.isSafeInteger(source.line)
    || (source.line as number) <= 0
    || !Number.isSafeInteger(source.column)
    || (source.column as number) <= 0
    || (source.nodeId !== undefined && (typeof source.nodeId !== "string" || source.nodeId.length > 4_096))) {
    return fallbackSource;
  }
  return Object.freeze({
    module: source.module,
    line: source.line as number,
    column: source.column as number,
    ...(typeof source.nodeId === "string" ? { nodeId: source.nodeId } : {}),
  });
}

function fail(
  code: ReferenceAudioTruePeakErrorCode,
  contract: Pick<Contract, "source">,
  message: string,
  detail: ReferenceAudioTruePeakErrorDetail,
  cause?: unknown,
): never {
  throw new ReferenceAudioTruePeakError(
    code,
    contract.source,
    message,
    detail,
    cause === undefined ? undefined : { cause },
  );
}

function normalizeContract(authoredOptions: ReferenceAudioTruePeakScanOptions): Contract {
  const options = record(authoredOptions);
  const source = normalizedSource(options?.source);
  if (!options) {
    fail(
      "CUT_AUDIO_TRUE_PEAK_STRUCTURE",
      { source },
      "true-peak scan options must be an object.",
      { kind: "structure", reason: "invalid-options" },
    );
  }
  if (source === fallbackSource && options.source !== fallbackSource) {
    fail(
      "CUT_AUDIO_TRUE_PEAK_STRUCTURE",
      { source },
      "true-peak source must contain a bounded module and positive integer line/column.",
      { kind: "structure", reason: "invalid-source" },
    );
  }
  const expectedFrames = options.expectedFrames;
  if (!Number.isSafeInteger(expectedFrames) || (expectedFrames as number) < 0) {
    fail(
      "CUT_AUDIO_TRUE_PEAK_STRUCTURE",
      { source },
      `expectedFrames must be a non-negative safe integer; received ${stableNumber(expectedFrames)}.`,
      { kind: "structure", reason: "invalid-expected-frames", ...(typeof expectedFrames === "number" ? { expectedFrames } : {}) },
    );
  }
  if ((expectedFrames as number) > referenceAudioTruePeakLimits.maximumFrames) {
    fail(
      "CUT_AUDIO_TRUE_PEAK_RESOURCE_LIMIT",
      { source },
      `expectedFrames ${expectedFrames} exceeds the bounded true-peak frame limit ${referenceAudioTruePeakLimits.maximumFrames}.`,
      { kind: "resource", reason: "frame-budget", expectedFrames: expectedFrames as number },
    );
  }
  const sampleRate = options.sampleRate;
  if (!Number.isSafeInteger(sampleRate) || (sampleRate as number) <= 0) {
    fail(
      "CUT_AUDIO_TRUE_PEAK_STRUCTURE",
      { source },
      `sampleRate must be a positive safe integer; received ${stableNumber(sampleRate)}.`,
      { kind: "structure", reason: "invalid-sample-rate", expectedFrames: expectedFrames as number },
    );
  }
  if (sampleRate !== supportedSampleRate) {
    fail(
      "CUT_AUDIO_TRUE_PEAK_SAMPLE_RATE_UNSUPPORTED",
      { source },
      `the BS.1770-5 Annex 2 CUT scanner supports exactly ${supportedSampleRate} Hz; received ${sampleRate} Hz.`,
      { kind: "structure", reason: "unsupported-sample-rate", expectedFrames: expectedFrames as number },
    );
  }
  const firMultiplyAdds = ((expectedFrames as number) + tapsPerPhase - 1) * firMultiplyAddsPerFrame;
  if (!Number.isSafeInteger(firMultiplyAdds)
    || firMultiplyAdds > referenceAudioTruePeakLimits.maximumFirMultiplyAdds) {
    fail(
      "CUT_AUDIO_TRUE_PEAK_RESOURCE_LIMIT",
      { source },
      `true-peak scan requires ${stableNumber(firMultiplyAdds)} FIR multiply-adds; maximum is ${referenceAudioTruePeakLimits.maximumFirMultiplyAdds}.`,
      {
        kind: "resource",
        reason: "fir-work-budget",
        expectedFrames: expectedFrames as number,
        firMultiplyAdds,
        firMultiplyAddLimit: referenceAudioTruePeakLimits.maximumFirMultiplyAdds,
      },
    );
  }
  return {
    expectedFrames: expectedFrames as number,
    expectedBytes: (expectedFrames as number) * bytesPerFrame,
    sampleRate: sampleRate as number,
    firMultiplyAdds,
    source,
  };
}

/** Validate rate, exact boundary and DSP work before any decoder/backend work. */
export function assertReferenceAudioTruePeakScanContract(options: ReferenceAudioTruePeakScanOptions): void {
  normalizeContract(options);
}

function channelName(channel: ReferenceAudioTruePeakChannel) {
  return channel === 0 ? "left" as const : "right" as const;
}

function errorCode(error: unknown) {
  try {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    return typeof code === "string" && /^[A-Z0-9_]{1,32}$/u.test(code) ? code : "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}

/**
 * Estimate the maximum continuous-time peak of exact stereo f32le PCM using
 * the published BS.1770-5 four-times FIR. The input sample peak is retained as
 * a conservative floor because an estimated true peak cannot physically be
 * below a sample through which the reconstructed waveform passes.
 */
async function scanReferenceStereoF32LeTruePeakContract(
  input: ReferenceAudioByteStream,
  contract: Contract,
): Promise<ReferenceAudioTruePeakScan> {
  const history = [new Float64Array(tapsPerPhase), new Float64Array(tapsPerPhase)] as const;
  let pending = Buffer.alloc(0);
  let observedBytes = 0;
  let observedFrames = 0;
  let chunkCount = 0;
  let samplePeak: SamplePeak | undefined;
  let firPeak: FirPeak | undefined;
  let firstNonfinite: { frame: number; channel: ReferenceAudioTruePeakChannel; sample: number } | undefined;
  let emittedOversampledFrames = 0;

  const processFrame = (left: number, right: number) => {
    const values = [left, right] as const;
    for (const channel of [0, 1] as const) {
      const sample = values[channel];
      if (!Number.isFinite(sample)) {
        firstNonfinite ??= { frame: observedFrames, channel, sample };
      } else {
        const absolute = Math.abs(sample);
        if (!samplePeak || absolute > samplePeak.linear) {
          samplePeak = { linear: absolute, frame: observedFrames, channel };
        }
      }
      history[channel].copyWithin(1, 0, tapsPerPhase - 1);
      history[channel][0] = Number.isFinite(sample) ? sample : 0;
    }
    for (const phase of [0, 1, 2, 3] as const) {
      for (const channel of [0, 1] as const) {
        let interpolated = 0;
        for (let tap = 0; tap < tapsPerPhase; tap += 1) {
          interpolated += history[channel][tap] * referenceAudioTruePeakCoefficients[tap][phase];
        }
        const absolute = Math.abs(interpolated);
        if (!firPeak || absolute > firPeak.linear) {
          firPeak = {
            linear: absolute,
            oversampledIndex: emittedOversampledFrames + phase,
            phase,
            channel,
          };
        }
      }
    }
    emittedOversampledFrames += phases;
    observedFrames += 1;
  };

  try {
    for await (const authoredChunk of input) {
      chunkCount += 1;
      if (!(authoredChunk instanceof Uint8Array)) {
        fail(
          "CUT_AUDIO_TRUE_PEAK_STRUCTURE",
          contract,
          "raw stereo f32le yielded a non-byte chunk during true-peak scanning.",
          { kind: "structure", reason: "invalid-chunk", expectedFrames: contract.expectedFrames, expectedBytes: contract.expectedBytes, observedBytes },
        );
      }
      // Exact authored boundaries take precedence over resource diagnostics. A
      // too-large chunk cannot disguise bytes that were never in the contract.
      if (authoredChunk.byteLength > contract.expectedBytes - observedBytes) {
        fail(
          "CUT_AUDIO_TRUE_PEAK_STRUCTURE",
          contract,
          `raw stereo f32le contains bytes beyond the exact ${contract.expectedBytes}-byte true-peak boundary.`,
          { kind: "structure", reason: "extra-bytes", expectedFrames: contract.expectedFrames, expectedBytes: contract.expectedBytes, observedBytes: observedBytes + authoredChunk.byteLength },
        );
      }
      if (chunkCount > referenceAudioTruePeakLimits.maximumChunks) {
        fail(
          "CUT_AUDIO_TRUE_PEAK_RESOURCE_LIMIT",
          contract,
          `raw stereo f32le exceeded the ${referenceAudioTruePeakLimits.maximumChunks}-chunk true-peak budget.`,
          { kind: "resource", reason: "chunk-count-budget", expectedFrames: contract.expectedFrames, expectedBytes: contract.expectedBytes, observedBytes },
        );
      }
      if (authoredChunk.byteLength > referenceAudioTruePeakLimits.maximumChunkBytes) {
        fail(
          "CUT_AUDIO_TRUE_PEAK_RESOURCE_LIMIT",
          contract,
          `raw stereo f32le chunk has ${authoredChunk.byteLength} bytes; maximum is ${referenceAudioTruePeakLimits.maximumChunkBytes}.`,
          { kind: "resource", reason: "chunk-size-budget", expectedFrames: contract.expectedFrames, expectedBytes: contract.expectedBytes, observedBytes },
        );
      }
      observedBytes += authoredChunk.byteLength;
      const bytes = pending.byteLength
        ? Buffer.concat([pending, Buffer.from(authoredChunk)])
        : Buffer.from(authoredChunk);
      let offset = 0;
      while (offset + bytesPerFrame <= bytes.byteLength) {
        processFrame(bytes.readFloatLE(offset), bytes.readFloatLE(offset + bytesPerSample));
        offset += bytesPerFrame;
      }
      pending = Buffer.from(bytes.subarray(offset));
    }
  } catch (error) {
    if (error instanceof ReferenceAudioTruePeakError) throw error;
    fail(
      "CUT_AUDIO_TRUE_PEAK_STRUCTURE",
      contract,
      `raw stereo f32le input stream failed during true-peak scanning (${errorCode(error)}).`,
      { kind: "structure", reason: "input-stream-failure", expectedFrames: contract.expectedFrames, expectedBytes: contract.expectedBytes, observedBytes },
    );
  }

  if (observedBytes !== contract.expectedBytes || pending.byteLength !== 0 || observedFrames !== contract.expectedFrames) {
    const reason = observedBytes % bytesPerSample !== 0
      ? "partial-sample"
      : observedBytes % bytesPerFrame !== 0
        ? "partial-stereo-frame"
        : "truncated";
    fail(
      "CUT_AUDIO_TRUE_PEAK_STRUCTURE",
      contract,
      `raw stereo f32le true-peak boundary is ${reason}; expected ${contract.expectedBytes} bytes, observed ${observedBytes}.`,
      { kind: "structure", reason, expectedFrames: contract.expectedFrames, expectedBytes: contract.expectedBytes, observedBytes },
    );
  }
  if (firstNonfinite) {
    fail(
      "CUT_AUDIO_TRUE_PEAK_NONFINITE",
      contract,
      `raw stereo f32le contains a non-finite sample at frame ${firstNonfinite.frame}, ${channelName(firstNonfinite.channel)} channel.`,
      {
        kind: "nonfinite",
        reason: "nonfinite-sample",
        expectedFrames: contract.expectedFrames,
        expectedBytes: contract.expectedBytes,
        observedBytes,
        frame: firstNonfinite.frame,
        channel: firstNonfinite.channel,
        channelName: channelName(firstNonfinite.channel),
        sample: firstNonfinite.sample,
      },
    );
  }

  // Flush the finite FIR tail. This makes chunking and file termination unable
  // to hide a boundary overshoot produced by the authored final samples.
  const inputFrames = observedFrames;
  for (let frame = 0; frame < tapsPerPhase - 1; frame += 1) processFrame(0, 0);
  observedFrames = inputFrames;

  const sampleLinear = samplePeak?.linear ?? 0;
  const firLinear = firPeak?.linear ?? 0;
  const peakKind = sampleLinear === 0 && firLinear === 0
    ? null
    : firLinear > sampleLinear
      ? "intersample" as const
      : "sample" as const;
  const truePeakLinear = Math.max(sampleLinear, firLinear);
  const truePeakDbtp = truePeakLinear === 0 ? null : 20 * Math.log10(truePeakLinear);
  const selectedChannel = peakKind === "intersample" ? firPeak!.channel : peakKind === "sample" ? samplePeak!.channel : null;
  const selectedFrame = peakKind === "sample"
    ? samplePeak!.frame
    : peakKind === "intersample"
      ? Math.floor((firPeak!.oversampledIndex - 47 / 2) / phases)
      : null;
  const selectedOversampledIndex = peakKind === "intersample" ? firPeak!.oversampledIndex : null;
  const peakTimeEighthFrames = peakKind === "sample"
    ? String(samplePeak!.frame * 8)
    : peakKind === "intersample"
      ? String(2 * firPeak!.oversampledIndex - 47)
      : null;

  return Object.freeze({
    format: "cut-reference-audio-true-peak-scan",
    version: 2,
    algorithm: referenceAudioTruePeakIdentity,
    coefficientFingerprint: referenceAudioTruePeakCoefficientFingerprint,
    sampleFormat: "f32le",
    channels: 2,
    sampleRate: contract.sampleRate,
    expectedFrames: contract.expectedFrames,
    observedFrames,
    expectedBytes: contract.expectedBytes,
    observedBytes,
    oversampleFactor: 4,
    tapsPerPhase: 12,
    firMultiplyAdds: contract.firMultiplyAdds,
    silent: truePeakLinear === 0,
    samplePeakLinear: sampleLinear,
    samplePeakDbfs: sampleLinear === 0 ? null : 20 * Math.log10(sampleLinear),
    firPeakLinear: firLinear,
    truePeakLinear,
    truePeakDbtp,
    peakKind,
    peakFrame: selectedFrame,
    peakChannel: selectedChannel,
    peakChannelName: selectedChannel === null ? null : channelName(selectedChannel),
    oversampledIndex: selectedOversampledIndex,
    oversamplePhase: peakKind === "intersample" ? firPeak!.phase : null,
    peakTimeEighthFrames,
  });
}

/** Measure an exact 48 kHz stereo f32le boundary without applying a ceiling. */
export async function scanReferenceStereoF32LeTruePeak(
  input: ReferenceAudioByteStream,
  options: ReferenceAudioTruePeakScanOptions,
) {
  return scanReferenceStereoF32LeTruePeakContract(input, normalizeContract(options));
}

/** Explicit pure-measurement spelling used by delivery inspection. */
export async function measureReferenceStereoF32LeTruePeak(
  input: ReferenceAudioByteStream,
  options: ReferenceAudioTruePeakScanOptions,
) {
  return scanReferenceStereoF32LeTruePeak(input, options);
}

function normalizeAssertion(authoredOptions: ReferenceAudioTruePeakAssertionOptions) {
  const options = record(authoredOptions);
  const source = normalizedSource(options?.source);
  if (!options) {
    fail(
      "CUT_AUDIO_TRUE_PEAK_STRUCTURE",
      { source },
      "true-peak assertion options must be an object.",
      { kind: "structure", reason: "invalid-assertion-options" },
    );
  }
  if (source === fallbackSource && options.source !== fallbackSource) {
    fail(
      "CUT_AUDIO_TRUE_PEAK_STRUCTURE",
      { source },
      "true-peak assertion source must contain a bounded module and positive integer line/column.",
      { kind: "structure", reason: "invalid-source" },
    );
  }
  const thresholdDbtp = options.thresholdDbtp;
  if (typeof thresholdDbtp !== "number"
    || !Number.isFinite(thresholdDbtp)
    || thresholdDbtp < referenceAudioTruePeakLimits.minimumThresholdDbtp
    || thresholdDbtp > referenceAudioTruePeakLimits.maximumThresholdDbtp) {
    fail(
      "CUT_AUDIO_TRUE_PEAK_STRUCTURE",
      { source },
      `thresholdDbtp must be finite and between ${referenceAudioTruePeakLimits.minimumThresholdDbtp} and ${referenceAudioTruePeakLimits.maximumThresholdDbtp}; received ${stableNumber(thresholdDbtp)}.`,
      { kind: "structure", reason: "invalid-threshold", ...(typeof thresholdDbtp === "number" ? { thresholdDbtp } : {}) },
    );
  }
  return { source, thresholdDbtp, thresholdLinear: 10 ** (thresholdDbtp / 20) };
}

/** Apply an authored ceiling to an already complete, pure true-peak scan. */
export function assertReferenceAudioTruePeak(
  scan: ReferenceAudioTruePeakScan,
  authoredOptions: ReferenceAudioTruePeakAssertionOptions,
) {
  const assertion = normalizeAssertion(authoredOptions);
  if (scan.format !== "cut-reference-audio-true-peak-scan"
    || scan.version !== 2
    || scan.algorithm !== referenceAudioTruePeakIdentity
    || scan.coefficientFingerprint !== referenceAudioTruePeakCoefficientFingerprint
    || scan.sampleRate !== supportedSampleRate
    || !Number.isFinite(scan.truePeakLinear)
    || scan.truePeakLinear < 0
    || (scan.truePeakLinear === 0) !== (scan.truePeakDbtp === null)
    || (scan.truePeakDbtp !== null && !Number.isFinite(scan.truePeakDbtp))) {
    fail(
      "CUT_AUDIO_TRUE_PEAK_STRUCTURE",
      assertion,
      "true-peak assertion requires a complete compatible CUT true-peak scan.",
      { kind: "structure", reason: "invalid-scan" },
    );
  }
  if (scan.truePeakDbtp === null || scan.truePeakDbtp <= assertion.thresholdDbtp) return scan;
  fail(
    "CUT_AUDIO_TRUE_PEAK_EXCEEDED",
    assertion,
    `estimated true peak ${stableNumber(scan.truePeakDbtp)} dBTP exceeds the authored ${stableNumber(assertion.thresholdDbtp)} dBTP ceiling.`,
    {
      kind: "true-peak",
      reason: "true-peak-ceiling",
      expectedFrames: scan.expectedFrames,
      expectedBytes: scan.expectedBytes,
      observedBytes: scan.observedBytes,
      ...(scan.peakFrame === null ? {} : { frame: scan.peakFrame }),
      ...(scan.peakChannel === null ? {} : { channel: scan.peakChannel, channelName: scan.peakChannelName! }),
      ...(scan.oversampledIndex === null ? {} : { oversampledIndex: scan.oversampledIndex, oversamplePhase: scan.oversamplePhase! }),
      ...(scan.peakKind === null ? {} : { peakKind: scan.peakKind }),
      ...(scan.peakTimeEighthFrames === null ? {} : { peakTimeEighthFrames: scan.peakTimeEighthFrames }),
      peakLinear: scan.truePeakLinear,
      peakDbtp: scan.truePeakDbtp,
      thresholdDbtp: assertion.thresholdDbtp,
      thresholdLinear: assertion.thresholdLinear,
      firMultiplyAdds: scan.firMultiplyAdds,
      firMultiplyAddLimit: referenceAudioTruePeakLimits.maximumFirMultiplyAdds,
    },
  );
}

export async function scanReferenceStereoF32LeTruePeakFile(
  path: string,
  options: ReferenceAudioTruePeakScanOptions,
) {
  // Validate before acquiring a stream. Constructing a ReadStream first can
  // otherwise emit an unhandled open error after a synchronous contract error.
  const contract = normalizeContract(options);
  if (typeof path !== "string" || path.length === 0) {
    fail(
      "CUT_AUDIO_TRUE_PEAK_STRUCTURE",
      contract,
      "true-peak input path must be a non-empty string.",
      { kind: "structure", reason: "invalid-input-path", expectedFrames: contract.expectedFrames, expectedBytes: contract.expectedBytes },
    );
  }
  let handle: FileHandle | undefined;
  let stream: ReturnType<FileHandle["createReadStream"]> | undefined;
  let result: ReferenceAudioTruePeakScan | undefined;
  let failure: unknown;
  try {
    if (typeof fsConstants.O_NOFOLLOW !== "number") {
      fail(
        "CUT_AUDIO_TRUE_PEAK_STRUCTURE",
        contract,
        "this platform cannot open a true-peak input with no-follow semantics.",
        { kind: "structure", reason: "no-follow-unavailable", expectedFrames: contract.expectedFrames, expectedBytes: contract.expectedBytes },
      );
    }
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      fail(
        "CUT_AUDIO_TRUE_PEAK_STRUCTURE",
        contract,
        "true-peak input must be a regular file.",
        { kind: "structure", reason: "input-not-regular-file", expectedFrames: contract.expectedFrames, expectedBytes: contract.expectedBytes },
      );
    }
    stream = handle.createReadStream({
      autoClose: false,
      highWaterMark: referenceAudioTruePeakLimits.fileReadChunkBytes,
    });
    result = await scanReferenceStereoF32LeTruePeakContract(stream, contract);
  } catch (error) {
    failure = error;
  }
  stream?.destroy();
  if (handle) {
    try {
      await handle.close();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) {
    if (failure instanceof ReferenceAudioTruePeakError) throw failure;
    fail(
      "CUT_AUDIO_TRUE_PEAK_STRUCTURE",
      contract,
      `could not read raw stereo f32le for true-peak scanning (${errorCode(failure)}).`,
      { kind: "structure", reason: "input-read-failure", expectedFrames: contract.expectedFrames, expectedBytes: contract.expectedBytes },
    );
  }
  return result!;
}
