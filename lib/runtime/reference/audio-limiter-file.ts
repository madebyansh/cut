import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, rename, rm, type FileHandle } from "node:fs/promises";
import {
  ReferenceAudioLimiterError,
  referenceAudioLimiterGuardDb,
  referenceAudioLimiterIdentity,
  referenceAudioLimiterLimits,
  referenceAudioLimiterReconciliationSafetyDb,
  type ReferenceAudioLimiterControls,
  type ReferenceAudioLimiterErrorCode,
  type ReferenceAudioLimiterProducerAuthority,
  type ReferenceAudioLimiterSummary,
} from "./audio-limiter";
import type { ReferenceAudioPeakSource } from "./audio-peak";
import { referenceAudioTruePeakCoefficients } from "./audio-true-peak";

const channels = 2;
const bytesPerFrame = 8;
const phases = referenceAudioLimiterLimits.oversampleFactor;
const tapsPerPhase = referenceAudioLimiterLimits.tapsPerPhase;
const firOrder = phases * tapsPerPhase - 1;
const supportedSampleRate = referenceAudioLimiterLimits.supportedSampleRate;
const chunkFrames = 65_536;
const maximumFrames = supportedSampleRate * 60 * 5;
const maximumAggregateFirMultiplyAdds = 2 ** 34;
const reconciliationSafetyLinear = 10 ** (-referenceAudioLimiterReconciliationSafetyDb / 20);
const maximumEnvelopeLinear = referenceAudioLimiterLimits.maximumEnvelopeLinear;

/**
 * A separate bounded domain for the file-backed adapter. The original 2^30
 * in-memory work ceiling is unchanged: long-form work is admitted only when
 * every programme-sized allocation has been replaced by a fixed-size chunk.
 */
export const referenceAudioLimiterFileLimits = Object.freeze({
  chunkFrames,
  maximumFrames,
  maximumDurationSeconds: maximumFrames / supportedSampleRate,
  maximumBytes: maximumFrames * bytesPerFrame,
  maximumChunks: Math.ceil(maximumFrames / chunkFrames),
  maximumAggregateFirMultiplyAdds,
});

export type ReferenceAudioLimiterFileWorkOptions = Readonly<{
  expectedFrames: number;
  sampleRate: number;
  lookaheadSamples: number;
  source: ReferenceAudioPeakSource;
}>;

export type ReferenceAudioLimiterFileProcessOptions =
  Readonly<ReferenceAudioLimiterFileWorkOptions & ReferenceAudioLimiterControls>;

export type ReferenceAudioLimiterUniformFileCorrectionResult = Readonly<{
  format: "cut-reference-audio-limiter-uniform-file-correction";
  version: 1;
  algorithm: typeof referenceAudioLimiterIdentity;
  sampleRate: typeof supportedSampleRate;
  frames: number;
  bytes: number;
  factor: number;
  inputSha256: string;
  outputSha256: string;
  truePeakLinear: number;
  truePeakDbtp: number | null;
  truePeakFrame: number | null;
}>;

const summaryProducerAuthorities = new WeakMap<object, ReferenceAudioLimiterProducerAuthority>();
const correctionProducerAuthorities =
  new WeakMap<object, ReferenceAudioLimiterUniformFileCorrectionResult>();

export function referenceAudioLimiterFileSummaryProducerAuthority(
  value: unknown,
): ReferenceAudioLimiterProducerAuthority | undefined {
  return typeof value === "object" && value !== null
    ? summaryProducerAuthorities.get(value)
    : undefined;
}

export function referenceAudioLimiterUniformFileCorrectionProducerAuthority(
  value: unknown,
): ReferenceAudioLimiterUniformFileCorrectionResult | undefined {
  return typeof value === "object" && value !== null
    ? correctionProducerAuthorities.get(value)
    : undefined;
}

type BoundFile = Readonly<{
  handle: FileHandle;
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;

function fail(
  code: ReferenceAudioLimiterErrorCode,
  source: ReferenceAudioPeakSource,
  message: string,
  detail: ConstructorParameters<typeof ReferenceAudioLimiterError>[3],
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

function systemCode(error: unknown) {
  const code = typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
  return typeof code === "string" && /^[A-Z0-9_]{1,64}$/u.test(code) ? code : "UNKNOWN";
}

function stableNumber(value: unknown) {
  if (typeof value !== "number") return `<${typeof value}>`;
  if (Object.is(value, -0)) return "-0";
  if (Number.isInteger(value)) return String(value);
  return value.toPrecision(12).replace(/(?:\.0+|(?:(\.\d*?[1-9])0+))(?=e|$)/u, "$1");
}

function validSource(source: ReferenceAudioPeakSource) {
  return typeof source?.module === "string"
    && source.module.length > 0
    && source.module.length <= 4_096
    && Number.isSafeInteger(source.line)
    && source.line > 0
    && Number.isSafeInteger(source.column)
    && source.column > 0
    && (source.nodeId === undefined || typeof source.nodeId === "string" && source.nodeId.length <= 4_096);
}

export function assertReferenceAudioLimiterFileWorkContract(
  options: ReferenceAudioLimiterFileWorkOptions,
) {
  const source = validSource(options?.source)
    ? Object.freeze({ ...options.source })
    : Object.freeze({ module: "<limiter-file-runtime>", line: 1, column: 1 });
  if (!options || !validSource(options.source)) {
    fail(
      "CUT_AUDIO_LIMITER_STRUCTURE",
      source,
      "file-backed limiter work options require one valid source location.",
      { kind: "structure", reason: "invalid-file-work-options" },
    );
  }
  if (!Number.isSafeInteger(options.expectedFrames) || options.expectedFrames < 1) {
    fail(
      "CUT_AUDIO_LIMITER_STRUCTURE",
      source,
      `expectedFrames must be one positive safe integer; received ${stableNumber(options.expectedFrames)}.`,
      { kind: "structure", reason: "invalid-frame-count" },
    );
  }
  if (!Number.isFinite(options.sampleRate)) {
    fail(
      "CUT_AUDIO_LIMITER_NONFINITE",
      source,
      "sampleRate must be finite.",
      { kind: "nonfinite", reason: "sample-rate", expectedFrames: options.expectedFrames, value: options.sampleRate },
    );
  }
  if (options.sampleRate !== supportedSampleRate) {
    fail(
      "CUT_AUDIO_LIMITER_SAMPLE_RATE_UNSUPPORTED",
      source,
      `the file-backed limiter supports exactly ${supportedSampleRate} Hz; received ${stableNumber(options.sampleRate)} Hz.`,
      { kind: "sample-rate", reason: "unsupported", expectedFrames: options.expectedFrames, value: options.sampleRate },
    );
  }
  if (!Number.isSafeInteger(options.lookaheadSamples) || options.lookaheadSamples < 0) {
    fail(
      "CUT_AUDIO_LIMITER_STRUCTURE",
      source,
      `lookaheadSamples must be one non-negative safe integer; received ${stableNumber(options.lookaheadSamples)}.`,
      { kind: "structure", reason: "invalid-lookahead", expectedFrames: options.expectedFrames },
    );
  }
  if (options.lookaheadSamples > referenceAudioLimiterLimits.maximumLookaheadSamples) {
    fail(
      "CUT_AUDIO_LIMITER_BOUNDS",
      source,
      `lookaheadSamples ${options.lookaheadSamples} exceeds the bound ${referenceAudioLimiterLimits.maximumLookaheadSamples}.`,
      {
        kind: "bounds",
        reason: "lookahead",
        expectedFrames: options.expectedFrames,
        lookaheadSamples: options.lookaheadSamples,
      },
    );
  }
  const firMultiplyAdds = options.expectedFrames
    * referenceAudioLimiterLimits.firMultiplyAddsPerFrame
    * referenceAudioLimiterLimits.maximumFirPasses;
  if (options.expectedFrames > maximumFrames
    || !Number.isSafeInteger(firMultiplyAdds)
    || firMultiplyAdds > maximumAggregateFirMultiplyAdds) {
    fail(
      "CUT_AUDIO_LIMITER_WORK_LIMIT",
      source,
      `file-backed limiter work requires ${stableNumber(firMultiplyAdds)} FIR multiply-adds across ${options.expectedFrames} frames; the five-minute bounded domain permits at most ${maximumAggregateFirMultiplyAdds}.`,
      {
        kind: "work",
        reason: "file-fir-multiply-adds",
        expectedFrames: options.expectedFrames,
        lookaheadSamples: options.lookaheadSamples,
        firMultiplyAdds,
        firMultiplyAddLimit: maximumAggregateFirMultiplyAdds,
      },
    );
  }
  return Object.freeze({
    expectedFrames: options.expectedFrames,
    sampleRate: supportedSampleRate,
    lookaheadSamples: options.lookaheadSamples,
    firMultiplyAdds,
    chunks: Math.ceil(options.expectedFrames / chunkFrames),
    source,
  });
}

async function openExactInput(path: string, expectedFrames: number, source: ReferenceAudioPeakSource): Promise<BoundFile> {
  const expectedBytes = BigInt(expectedFrames * bytesPerFrame);
  let handle: FileHandle | undefined;
  try {
    if (typeof fsConstants.O_NOFOLLOW !== "number") {
      fail(
        "CUT_AUDIO_LIMITER_STRUCTURE",
        source,
        "platform cannot bind the file-backed limiter input to a no-follow handle.",
        { kind: "structure", reason: "no-follow-unavailable", expectedFrames },
      );
    }
    const pathMetadata = await lstat(path, { bigint: true });
    if (pathMetadata.isSymbolicLink() || !pathMetadata.isFile() || pathMetadata.size !== expectedBytes) {
      fail(
        "CUT_AUDIO_LIMITER_STRUCTURE",
        source,
        `file-backed limiter input must be one direct ${expectedBytes}-byte stereo f32le file.`,
        { kind: "structure", reason: "invalid-file-boundary", expectedFrames },
      );
    }
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const metadata = await handle.stat({ bigint: true });
    if (!metadata.isFile()
      || metadata.dev !== pathMetadata.dev
      || metadata.ino !== pathMetadata.ino
      || metadata.size !== pathMetadata.size
      || metadata.mtimeNs !== pathMetadata.mtimeNs
      || metadata.ctimeNs !== pathMetadata.ctimeNs) {
      fail(
        "CUT_AUDIO_LIMITER_STRUCTURE",
        source,
        "file-backed limiter path and no-follow handle do not identify the same immutable input.",
        { kind: "structure", reason: "path-handle-mismatch", expectedFrames },
      );
    }
    return Object.freeze({
      handle,
      dev: metadata.dev,
      ino: metadata.ino,
      size: metadata.size,
      mtimeNs: metadata.mtimeNs,
      ctimeNs: metadata.ctimeNs,
    });
  } catch (error) {
    if (error instanceof ReferenceAudioLimiterError) throw error;
    await handle?.close().catch(() => undefined);
    fail(
      "CUT_AUDIO_LIMITER_STRUCTURE",
      source,
      `file-backed limiter input could not be opened (${systemCode(error)}).`,
      { kind: "structure", reason: "input-open-failed", expectedFrames },
      error,
    );
  }
}

async function verifyBoundFile(
  path: string,
  bound: BoundFile,
  expectedFrames: number,
  source: ReferenceAudioPeakSource,
) {
  try {
    const after = await bound.handle.stat({ bigint: true });
    const afterPath = await lstat(path, { bigint: true });
    if (!after.isFile()
      || after.dev !== bound.dev
      || after.ino !== bound.ino
      || after.size !== bound.size
      || after.mtimeNs !== bound.mtimeNs
      || after.ctimeNs !== bound.ctimeNs
      || afterPath.dev !== bound.dev
      || afterPath.ino !== bound.ino
      || afterPath.size !== bound.size
      || afterPath.mtimeNs !== bound.mtimeNs
      || afterPath.ctimeNs !== bound.ctimeNs) {
      fail(
        "CUT_AUDIO_LIMITER_STRUCTURE",
        source,
        "file-backed limiter input changed while CUT processed its exact boundary.",
        { kind: "structure", reason: "input-changed", expectedFrames },
      );
    }
  } catch (error) {
    if (error instanceof ReferenceAudioLimiterError) throw error;
    fail(
      "CUT_AUDIO_LIMITER_STRUCTURE",
      source,
      `file-backed limiter could not reconcile its input identity (${systemCode(error)}).`,
      { kind: "structure", reason: "input-reconciliation-failed", expectedFrames },
      error,
    );
  }
}

async function readExact(
  handle: FileHandle,
  position: number,
  bytes: number,
  source: ReferenceAudioPeakSource,
  expectedFrames: number,
) {
  const buffer = Buffer.allocUnsafe(bytes);
  let offset = 0;
  while (offset < bytes) {
    const read = await handle.read(buffer, offset, bytes - offset, position + offset);
    if (read.bytesRead <= 0) break;
    offset += read.bytesRead;
  }
  if (offset !== bytes) {
    fail(
      "CUT_AUDIO_LIMITER_STRUCTURE",
      source,
      `file-backed limiter input was truncated at byte ${position + offset}.`,
      { kind: "structure", reason: "truncated-read", expectedFrames },
    );
  }
  return buffer;
}

async function writeExact(
  handle: FileHandle,
  buffer: Buffer,
  position: number,
  source: ReferenceAudioPeakSource,
  expectedFrames: number,
) {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const write = await handle.write(buffer, offset, buffer.byteLength - offset, position + offset);
    if (write.bytesWritten <= 0) break;
    offset += write.bytesWritten;
  }
  if (offset !== buffer.byteLength) {
    fail(
      "CUT_AUDIO_LIMITER_STRUCTURE",
      source,
      `file-backed limiter output stopped at byte ${position + offset}.`,
      { kind: "structure", reason: "short-write", expectedFrames },
    );
  }
}

function decodeStereo(
  bytes: Buffer,
  startFrame: number,
  source: ReferenceAudioPeakSource,
) {
  const samples = new Float32Array(bytes.byteLength / 4);
  let anyNonzero = false;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = bytes.readFloatLE(index * 4);
    const frame = startFrame + Math.floor(index / channels);
    const channel = index % channels as 0 | 1;
    if (!Number.isFinite(sample)) {
      fail(
        "CUT_AUDIO_LIMITER_NONFINITE",
        source,
        `file-backed limiter input contains a non-finite ${channel === 0 ? "left" : "right"} sample at frame ${frame}.`,
        { kind: "nonfinite", reason: "pcm-sample", frame, channel, channelName: channel === 0 ? "left" : "right", sample },
      );
    }
    if (Math.abs(sample) > referenceAudioLimiterLimits.maximumAbsoluteInputSample) {
      fail(
        "CUT_AUDIO_LIMITER_BOUNDS",
        source,
        `file-backed limiter input sample at frame ${frame} exceeds the magnitude bound ${referenceAudioLimiterLimits.maximumAbsoluteInputSample}.`,
        { kind: "bounds", reason: "pcm-sample", frame, channel, channelName: channel === 0 ? "left" : "right", sample },
      );
    }
    samples[index] = sample;
    if (sample !== 0) anyNonzero = true;
  }
  return { samples, anyNonzero };
}

function encodeStereo(samples: Float32Array) {
  const bytes = Buffer.allocUnsafe(samples.length * 4);
  for (let index = 0; index < samples.length; index += 1) bytes.writeFloatLE(samples[index], index * 4);
  return bytes;
}

function firstOversampledIndex(rangeStart: number) {
  return rangeStart === 0 ? 0 : Math.ceil((8 * rangeStart + firOrder) / 2);
}

function endOversampledIndex(rangeEnd: number, totalFrames: number) {
  return rangeEnd === totalFrames
    ? totalFrames * phases + firOrder - (phases - 1)
    : 4 * rangeEnd + 24;
}

function envelopeReadWindow(totalFrames: number, rangeStart: number, rangeEnd: number) {
  const oversampledStart = firstOversampledIndex(rangeStart);
  const oversampledEnd = endOversampledIndex(rangeEnd, totalFrames);
  const convolutionStart = Math.max(0, Math.ceil((oversampledStart - firOrder) / phases));
  const convolutionEnd = Math.min(totalFrames, Math.floor((oversampledEnd - 1) / phases) + 1);
  return Object.freeze({
    oversampledStart,
    oversampledEnd,
    readStart: Math.min(rangeStart, convolutionStart),
    readEnd: Math.max(rangeEnd, convolutionEnd),
  });
}

function deriveDecodedEnvelopeRange(
  decoded: ReturnType<typeof decodeStereo>,
  totalFrames: number,
  rangeStart: number,
  rangeEnd: number,
  readStart: number,
  oversampledStart: number,
  oversampledEnd: number,
  source: ReferenceAudioPeakSource,
) {
  const envelope = new Float64Array(rangeEnd - rangeStart);
  for (let frame = rangeStart; frame < rangeEnd; frame += 1) {
    const local = (frame - readStart) * channels;
    envelope[frame - rangeStart] = Math.max(
      Math.abs(decoded.samples[local]),
      Math.abs(decoded.samples[local + 1]),
    );
  }
  if (!decoded.anyNonzero) return envelope;

  // Both admitted oversampled boundaries are exact phase boundaries. Traverse
  // base input frames and phases directly so the frozen scalar multiply/add
  // order is unchanged while avoiding per-sample division, modulo, and
  // coefficient-index reconstruction.
  for (
    let baseFrame = oversampledStart / phases;
    baseFrame < oversampledEnd / phases;
    baseFrame += 1
  ) {
    const firstInputFrame = Math.max(0, baseFrame - (tapsPerPhase - 1));
    const lastInputFrame = Math.min(totalFrames - 1, baseFrame);
    const sourceFrame = Math.max(0, Math.min(totalFrames - 1, baseFrame - 6));
    for (let phase = 0; phase < phases; phase += 1) {
      let left = 0;
      let right = 0;
      let coefficientRow = baseFrame - firstInputFrame;
      for (
        let inputFrame = firstInputFrame;
        inputFrame <= lastInputFrame;
        inputFrame += 1, coefficientRow -= 1
      ) {
        const local = (inputFrame - readStart) * channels;
        const inputLeft = decoded.samples[local];
        const inputRight = decoded.samples[local + 1];
        if (inputLeft === 0 && inputRight === 0) continue;
        const coefficient = referenceAudioTruePeakCoefficients[coefficientRow][phase];
        left += inputLeft * coefficient;
        right += inputRight * coefficient;
      }
      if (sourceFrame < rangeStart || sourceFrame >= rangeEnd) continue;
      const peak = Math.max(Math.abs(left), Math.abs(right));
      if (peak > maximumEnvelopeLinear) {
        fail(
          "CUT_AUDIO_LIMITER_BOUNDS",
          source,
          `file-backed limiter true-peak envelope at frame ${sourceFrame} exceeds the bounded domain.`,
          { kind: "bounds", reason: "envelope", expectedFrames: totalFrames, frame: sourceFrame, value: peak },
        );
      }
      if (peak > envelope[sourceFrame - rangeStart]) envelope[sourceFrame - rangeStart] = peak;
    }
  }
  return envelope;
}

async function deriveEnvelopeRange(
  handle: FileHandle,
  totalFrames: number,
  rangeStart: number,
  rangeEnd: number,
  source: ReferenceAudioPeakSource,
) {
  const length = rangeEnd - rangeStart;
  if (length === 0) return new Float64Array();
  const { oversampledStart, oversampledEnd, readStart, readEnd } = envelopeReadWindow(totalFrames, rangeStart, rangeEnd);
  const decoded = decodeStereo(
    await readExact(handle, readStart * bytesPerFrame, (readEnd - readStart) * bytesPerFrame, source, totalFrames),
    readStart,
    source,
  );
  return deriveDecodedEnvelopeRange(
    decoded,
    totalFrames,
    rangeStart,
    rangeEnd,
    readStart,
    oversampledStart,
    oversampledEnd,
    source,
  );
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
      `${control} value at frame ${frame} is outside ${minimum}..${maximum}.`,
      { kind: "bounds", reason: "control-value", frame, control, value },
    );
  }
  return value;
}

type PeakScan = Readonly<{
  maximumLinear: number;
  maximumFrame: number | null;
  reconciliationFactor: number;
  reconciliationFrame: number | null;
}>;

async function readCeilings(
  handle: FileHandle,
  startFrame: number,
  frames: number,
  expectedFrames: number,
  source: ReferenceAudioPeakSource,
) {
  const bytes = await readExact(handle, startFrame * 8, frames * 8, source, expectedFrames);
  const values = new Float64Array(frames);
  for (let index = 0; index < frames; index += 1) values[index] = bytes.readDoubleLE(index * 8);
  return values;
}

function encodeCeilings(values: Float64Array) {
  const bytes = Buffer.allocUnsafe(values.length * 8);
  for (let index = 0; index < values.length; index += 1) bytes.writeDoubleLE(values[index], index * 8);
  return bytes;
}

async function scanOutput(
  outputPath: string,
  ceilingPath: string,
  expectedFrames: number,
  source: ReferenceAudioPeakSource,
): Promise<PeakScan> {
  const output = await openExactInput(outputPath, expectedFrames, source);
  let ceilings: FileHandle | undefined;
  try {
    ceilings = await open(ceilingPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const ceilingStat = await ceilings.stat({ bigint: true });
    if (!ceilingStat.isFile() || ceilingStat.size !== BigInt(expectedFrames * 8)) {
      fail(
        "CUT_AUDIO_LIMITER_STRUCTURE",
        source,
        "file-backed limiter control boundary has an invalid exact length.",
        { kind: "structure", reason: "control-boundary", expectedFrames },
      );
    }
    let maximumLinear = 0;
    let maximumFrame: number | null = null;
    let reconciliationFactor = 1;
    let reconciliationFrame: number | null = null;
    for (let start = 0; start < expectedFrames; start += chunkFrames) {
      const end = Math.min(expectedFrames, start + chunkFrames);
      const envelope = await deriveEnvelopeRange(output.handle, expectedFrames, start, end, source);
      const authoredCeilings = await readCeilings(ceilings, start, end - start, expectedFrames, source);
      for (let index = 0; index < envelope.length; index += 1) {
        const frame = start + index;
        const peak = envelope[index];
        if (peak > maximumLinear) {
          maximumLinear = peak;
          maximumFrame = frame;
        }
        if (peak > authoredCeilings[index]) {
          const candidate = authoredCeilings[index] / peak;
          if (candidate < reconciliationFactor) {
            reconciliationFactor = candidate;
            reconciliationFrame = frame;
          }
        }
      }
    }
    await verifyBoundFile(outputPath, output, expectedFrames, source);
    return Object.freeze({
      maximumLinear,
      maximumFrame,
      reconciliationFactor,
      reconciliationFrame,
    });
  } finally {
    await ceilings?.close().catch(() => undefined);
    await output.handle.close().catch(() => undefined);
  }
}

async function applyUniformGain(
  inputPath: string,
  outputPath: string,
  expectedFrames: number,
  factor: number,
  source: ReferenceAudioPeakSource,
) {
  if (!Number.isFinite(factor) || factor <= 0 || factor >= 1) {
    fail(
      "CUT_AUDIO_LIMITER_RECONCILIATION",
      source,
      "file-backed limiter correction must be finite, downward, and greater than zero.",
      { kind: "reconciliation", reason: "invalid-correction-factor", expectedFrames, reconciliationFactor: factor },
    );
  }
  const input = await openExactInput(inputPath, expectedFrames, source);
  const inputDigest = createHash("sha256");
  const outputDigest = createHash("sha256");
  let output: FileHandle | undefined;
  try {
    output = await open(outputPath, "wx", 0o600);
    for (let start = 0; start < expectedFrames; start += chunkFrames) {
      const frames = Math.min(chunkFrames, expectedFrames - start);
      const inputBytes = await readExact(
        input.handle,
        start * bytesPerFrame,
        frames * bytesPerFrame,
        source,
        expectedFrames,
      );
      inputDigest.update(inputBytes);
      const decoded = decodeStereo(inputBytes, start, source).samples;
      for (let index = 0; index < decoded.length; index += 1) {
        decoded[index] = Math.fround(decoded[index] * factor);
        if (!Number.isFinite(decoded[index])) {
          fail(
            "CUT_AUDIO_LIMITER_NONFINITE",
            source,
            `file-backed limiter correction produced a non-finite sample at frame ${start + Math.floor(index / channels)}.`,
            {
              kind: "nonfinite",
              reason: "correction-sample",
              frame: start + Math.floor(index / channels),
              channel: index % channels as 0 | 1,
              channelName: index % channels === 0 ? "left" : "right",
              sample: decoded[index],
            },
          );
        }
      }
      const outputBytes = encodeStereo(decoded);
      outputDigest.update(outputBytes);
      await writeExact(output, outputBytes, start * bytesPerFrame, source, expectedFrames);
    }
    await output.sync();
    const outputStat = await output.stat({ bigint: true });
    if (!outputStat.isFile() || outputStat.size !== BigInt(expectedFrames * bytesPerFrame)) {
      fail(
        "CUT_AUDIO_LIMITER_STRUCTURE",
        source,
        "file-backed limiter correction did not preserve the exact frame boundary.",
        { kind: "structure", reason: "correction-boundary", expectedFrames },
      );
    }
    await verifyBoundFile(inputPath, input, expectedFrames, source);
    return Object.freeze({
      inputSha256: inputDigest.digest("hex"),
      outputSha256: outputDigest.digest("hex"),
    });
  } catch (error) {
    await rm(outputPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await output?.close().catch(() => undefined);
    await input.handle.close().catch(() => undefined);
  }
}

/**
 * Apply one externally authorized static compatibility correction without
 * materializing the programme. This is intentionally not a general gain API.
 */
export async function applyReferenceAudioLimiterUniformFileCorrection(
  inputPath: string,
  outputPath: string,
  options: Readonly<{ expectedFrames: number; factor: number; source: ReferenceAudioPeakSource }>,
) {
  assertReferenceAudioLimiterFileWorkContract({
    expectedFrames: options.expectedFrames,
    sampleRate: supportedSampleRate,
    lookaheadSamples: 0,
    source: options.source,
  });
  try {
    const boundary = await applyUniformGain(
      inputPath,
      outputPath,
      options.expectedFrames,
      options.factor,
      options.source,
    );
    const peak = await measureReferenceAudioLimiterFileTruePeak(outputPath, {
      expectedFrames: options.expectedFrames,
      sampleRate: supportedSampleRate,
      source: options.source,
    });
    const result = Object.freeze({
      format: "cut-reference-audio-limiter-uniform-file-correction" as const,
      version: 1 as const,
      algorithm: referenceAudioLimiterIdentity,
      sampleRate: supportedSampleRate,
      frames: options.expectedFrames,
      bytes: options.expectedFrames * bytesPerFrame,
      factor: options.factor,
      inputSha256: boundary.inputSha256,
      outputSha256: boundary.outputSha256,
      truePeakLinear: peak.maximumLinear,
      truePeakDbtp: peak.maximumDbtp,
      truePeakFrame: peak.maximumFrame,
    });
    correctionProducerAuthorities.set(result, result);
    return result;
  } catch (error) {
    await rm(outputPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Measure a long exact boundary with the same chunk/halo FIR used by processing. */
export async function measureReferenceAudioLimiterFileTruePeak(
  path: string,
  options: Readonly<{ expectedFrames: number; sampleRate: number; source: ReferenceAudioPeakSource }>,
) {
  const contract = assertReferenceAudioLimiterFileWorkContract({
    expectedFrames: options.expectedFrames,
    sampleRate: options.sampleRate,
    lookaheadSamples: 0,
    source: options.source,
  });
  const input = await openExactInput(path, contract.expectedFrames, contract.source);
  try {
    let maximumLinear = 0;
    let maximumFrame: number | null = null;
    for (let start = 0; start < contract.expectedFrames; start += chunkFrames) {
      const end = Math.min(contract.expectedFrames, start + chunkFrames);
      const envelope = await deriveEnvelopeRange(input.handle, contract.expectedFrames, start, end, contract.source);
      for (let index = 0; index < envelope.length; index += 1) {
        if (envelope[index] > maximumLinear) {
          maximumLinear = envelope[index];
          maximumFrame = start + index;
        }
      }
    }
    await verifyBoundFile(path, input, contract.expectedFrames, contract.source);
    return Object.freeze({
      maximumLinear,
      maximumDbtp: maximumLinear === 0 ? null : 20 * Math.log10(maximumLinear),
      maximumFrame,
    });
  } finally {
    await input.handle.close().catch(() => undefined);
  }
}

/**
 * Measure an already snapshotted exact boundary without a second path read.
 * Compatibility reconciliation uses this so CUT and the independent meter
 * consume the same immutable bytes even for long programmes.
 */
export function measureReferenceAudioLimiterSnapshotTruePeak(
  bytes: Buffer,
  options: Readonly<{ expectedFrames: number; sampleRate: number; source: ReferenceAudioPeakSource }>,
) {
  const contract = assertReferenceAudioLimiterFileWorkContract({
    expectedFrames: options.expectedFrames,
    sampleRate: options.sampleRate,
    lookaheadSamples: 0,
    source: options.source,
  });
  if (!Buffer.isBuffer(bytes) || bytes.byteLength !== contract.expectedFrames * bytesPerFrame) {
    fail(
      "CUT_AUDIO_LIMITER_STRUCTURE",
      contract.source,
      "snapshotted limiter boundary must be one exact stereo f32le Buffer.",
      { kind: "structure", reason: "snapshot-boundary", expectedFrames: contract.expectedFrames },
    );
  }
  let maximumLinear = 0;
  let maximumFrame: number | null = null;
  for (let start = 0; start < contract.expectedFrames; start += chunkFrames) {
    const end = Math.min(contract.expectedFrames, start + chunkFrames);
    const { oversampledStart, oversampledEnd, readStart, readEnd } = envelopeReadWindow(
      contract.expectedFrames,
      start,
      end,
    );
    const decoded = decodeStereo(
      bytes.subarray(readStart * bytesPerFrame, readEnd * bytesPerFrame),
      readStart,
      contract.source,
    );
    const envelope = deriveDecodedEnvelopeRange(
      decoded,
      contract.expectedFrames,
      start,
      end,
      readStart,
      oversampledStart,
      oversampledEnd,
      contract.source,
    );
    for (let index = 0; index < envelope.length; index += 1) {
      if (envelope[index] > maximumLinear) {
        maximumLinear = envelope[index];
        maximumFrame = start + index;
      }
    }
  }
  return Object.freeze({
    maximumLinear,
    maximumDbtp: maximumLinear === 0 ? null : 20 * Math.log10(maximumLinear),
    maximumFrame,
  });
}

/**
 * Execute the CUT limiter over one exact private stereo f32le boundary.
 *
 * Pass 1 derives true-peak windows with exact FIR halos, applies the linked
 * control law and carries release state across chunks. Pass 2 rescans the
 * actual Float32 output. A static programme needing reconciliation receives
 * one uniform correction and one final verification pass. All temporary files
 * are removed on success or failure.
 */
export async function processReferenceAudioLimiterFile(
  inputPath: string,
  outputPath: string,
  authoredOptions: ReferenceAudioLimiterFileProcessOptions,
): Promise<ReferenceAudioLimiterSummary> {
  const contract = assertReferenceAudioLimiterFileWorkContract(authoredOptions);
  if (typeof authoredOptions.ceilingDbtp !== "function" || typeof authoredOptions.releaseSeconds !== "function") {
    fail(
      "CUT_AUDIO_LIMITER_STRUCTURE",
      contract.source,
      "ceilingDbtp and releaseSeconds must be per-frame callbacks.",
      { kind: "structure", reason: "invalid-control-callbacks", expectedFrames: contract.expectedFrames },
    );
  }
  const unreconciledPath = `${outputPath}.unreconciled`;
  const correctedPath = `${outputPath}.corrected`;
  const ceilingPath = `${outputPath}.ceilings`;
  const input = await openExactInput(inputPath, contract.expectedFrames, contract.source);
  let outputReservation: FileHandle | undefined;
  try {
    outputReservation = await open(outputPath, "wx", 0o600);
  } catch (error) {
    await input.handle.close().catch(() => undefined);
    fail(
      "CUT_AUDIO_LIMITER_STRUCTURE",
      contract.source,
      `file-backed limiter could not reserve its exact output (${systemCode(error)}).`,
      { kind: "structure", reason: "output-reservation-failed", expectedFrames: contract.expectedFrames },
      error,
    );
  }
  let unreconciled: FileHandle | undefined;
  let ceilings: FileHandle | undefined;
  let published = false;
  try {
    unreconciled = await open(unreconciledPath, "wx", 0o600);
    ceilings = await open(ceilingPath, "wx", 0o600);
    let previousGain = 1;
    let minimumAppliedGain = 1;
    let firstCeilingDbtp: number | undefined;
    let constantCeiling = true;
    let minimumCeilingDbtp = Infinity;
    let maximumCeilingDbtp = -Infinity;
    const guardLinear = 10 ** (-referenceAudioLimiterGuardDb / 20);
    const unreconciledDigest = createHash("sha256");

    for (let start = 0; start < contract.expectedFrames; start += chunkFrames) {
      const end = Math.min(contract.expectedFrames, start + chunkFrames);
      const windowEnd = Math.min(contract.expectedFrames, end + contract.lookaheadSamples);
      const envelope = await deriveEnvelopeRange(
        input.handle,
        contract.expectedFrames,
        start,
        windowEnd,
        contract.source,
      );
      const inputFrames = decodeStereo(
        await readExact(
          input.handle,
          start * bytesPerFrame,
          (end - start) * bytesPerFrame,
          contract.source,
          contract.expectedFrames,
        ),
        start,
        contract.source,
      ).samples;
      const outputFrames = new Float32Array(inputFrames.length);
      const authoredCeilings = new Float64Array(end - start);
      const queue = new Int32Array(envelope.length);
      let queueHead = 0;
      let queueTail = 0;
      let lastAdded = -1;

      for (let localFrame = 0; localFrame < end - start; localFrame += 1) {
        const frame = start + localFrame;
        const ceiling = controlValue(authoredOptions.ceilingDbtp, "ceilingDbtp", frame, contract.source);
        const release = controlValue(authoredOptions.releaseSeconds, "releaseSeconds", frame, contract.source);
        if (frame === 0) firstCeilingDbtp = ceiling;
        else if (ceiling !== firstCeilingDbtp) constantCeiling = false;
        if (ceiling < minimumCeilingDbtp) minimumCeilingDbtp = ceiling;
        if (ceiling > maximumCeilingDbtp) maximumCeilingDbtp = ceiling;
        const authoredCeilingLinear = 10 ** (ceiling / 20);
        authoredCeilings[localFrame] = authoredCeilingLinear;

        const futureEnd = Math.min(envelope.length - 1, localFrame + contract.lookaheadSamples);
        while (lastAdded < futureEnd) {
          lastAdded += 1;
          while (queueTail > queueHead && envelope[queue[queueTail - 1]] <= envelope[lastAdded]) queueTail -= 1;
          queue[queueTail] = lastAdded;
          queueTail += 1;
        }
        while (queueHead < queueTail && queue[queueHead] < localFrame) queueHead += 1;
        const guardedCeiling = authoredCeilingLinear * guardLinear;
        const futurePeak = envelope[queue[queueHead]];
        const requiredGain = futurePeak > guardedCeiling ? guardedCeiling / futurePeak : 1;
        const releaseCoefficient = Math.exp(-1 / (release * supportedSampleRate));
        const releasedGain = releaseCoefficient * previousGain + (1 - releaseCoefficient);
        const gain = Math.max(0, Math.min(1, requiredGain, releasedGain));
        previousGain = gain;
        if (gain < minimumAppliedGain) minimumAppliedGain = gain;
        outputFrames[localFrame * channels] = Math.fround(inputFrames[localFrame * channels] * gain);
        outputFrames[localFrame * channels + 1] = Math.fround(inputFrames[localFrame * channels + 1] * gain);
      }

      const outputBytes = encodeStereo(outputFrames);
      unreconciledDigest.update(outputBytes);
      await writeExact(unreconciled, outputBytes, start * bytesPerFrame, contract.source, contract.expectedFrames);
      await writeExact(
        ceilings,
        encodeCeilings(authoredCeilings),
        start * 8,
        contract.source,
        contract.expectedFrames,
      );
    }
    await unreconciled.sync();
    await ceilings.sync();
    await unreconciled.close();
    unreconciled = undefined;
    await ceilings.close();
    ceilings = undefined;
    await verifyBoundFile(inputPath, input, contract.expectedFrames, contract.source);
    await input.handle.close();

    const unreconciledSha256 = unreconciledDigest.digest("hex");
    let finalSha256 = unreconciledSha256;
    let scan = await scanOutput(unreconciledPath, ceilingPath, contract.expectedFrames, contract.source);
    let reconciliationFactor = 1;
    let finalPath = unreconciledPath;
    if (scan.reconciliationFactor < 1) {
      if (!constantCeiling) {
        const frame = scan.reconciliationFrame ?? 0;
        const authoredCeiling = (await (async () => {
          const handle = await open(ceilingPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
          try {
            return (await readCeilings(handle, frame, 1, contract.expectedFrames, contract.source))[0];
          } finally {
            await handle.close().catch(() => undefined);
          }
        })());
        fail(
          "CUT_AUDIO_LIMITER_RECONCILIATION",
          contract.source,
          `dynamic ceiling output requires unsupported reconciliation at frame ${frame}.`,
          {
            kind: "reconciliation",
            reason: "dynamic-ceiling-reconciliation-unsupported",
            expectedFrames: contract.expectedFrames,
            frame,
            peakLinear: scan.maximumLinear,
            thresholdLinear: authoredCeiling,
            reconciliationFactor: scan.reconciliationFactor,
          },
        );
      }
      reconciliationFactor = scan.reconciliationFactor * reconciliationSafetyLinear;
      const correctedBoundary = await applyUniformGain(
        unreconciledPath,
        correctedPath,
        contract.expectedFrames,
        reconciliationFactor,
        contract.source,
      );
      if (correctedBoundary.inputSha256 !== unreconciledSha256) {
        fail(
          "CUT_AUDIO_LIMITER_STRUCTURE",
          contract.source,
          "file-backed limiter correction did not consume the exact unreconciled boundary.",
          { kind: "structure", reason: "correction-input-identity", expectedFrames: contract.expectedFrames },
        );
      }
      finalSha256 = correctedBoundary.outputSha256;
      scan = await scanOutput(
        correctedPath,
        ceilingPath,
        contract.expectedFrames,
        contract.source,
      );
      if (scan.reconciliationFactor < 1) {
        const frame = scan.reconciliationFrame ?? 0;
        fail(
          "CUT_AUDIO_LIMITER_RECONCILIATION",
          contract.source,
          `verified file-backed limiter output still exceeds the authored ceiling at frame ${frame}.`,
          {
            kind: "reconciliation",
            reason: "post-reconciliation-ceiling",
            expectedFrames: contract.expectedFrames,
            frame,
            peakLinear: scan.maximumLinear,
            reconciliationFactor,
          },
        );
      }
      finalPath = correctedPath;
    }
    await outputReservation.sync();
    const reservation = await outputReservation.stat({ bigint: true });
    const reservationPath = await lstat(outputPath, { bigint: true });
    if (!reservation.isFile()
      || reservation.size !== 0n
      || reservation.dev !== reservationPath.dev
      || reservation.ino !== reservationPath.ino
      || reservation.mtimeNs !== reservationPath.mtimeNs
      || reservation.ctimeNs !== reservationPath.ctimeNs) {
      fail(
        "CUT_AUDIO_LIMITER_STRUCTURE",
        contract.source,
        "file-backed limiter output reservation changed before publication.",
        { kind: "structure", reason: "output-reservation-changed", expectedFrames: contract.expectedFrames },
      );
    }
    await outputReservation.close();
    outputReservation = undefined;
    await rm(outputPath);
    await rename(finalPath, outputPath);
    const publishedMetadata = await lstat(outputPath);
    if (!publishedMetadata.isFile()
      || publishedMetadata.isSymbolicLink()
      || publishedMetadata.size !== contract.expectedFrames * bytesPerFrame) {
      fail(
        "CUT_AUDIO_LIMITER_STRUCTURE",
        contract.source,
        "file-backed limiter publication did not preserve the exact output boundary.",
        { kind: "structure", reason: "published-boundary", expectedFrames: contract.expectedFrames },
      );
    }
    const summary: ReferenceAudioLimiterSummary = Object.freeze({
      format: "cut-reference-audio-limiter-result",
      version: 3,
      algorithm: referenceAudioLimiterIdentity,
      sampleRate: supportedSampleRate,
      frames: contract.expectedFrames,
      lookaheadSamples: contract.lookaheadSamples,
      guardDb: referenceAudioLimiterGuardDb,
      ceilingMode: constantCeiling ? "static" : "dynamic",
      minimumCeilingDbtp,
      maximumCeilingDbtp,
      minimumAppliedGain,
      reconciliationFactor,
      minimumFinalGain: minimumAppliedGain * reconciliationFactor,
      maximumOutputTruePeakLinear: scan.maximumLinear,
      maximumOutputTruePeakDbtp: scan.maximumLinear === 0 ? null : 20 * Math.log10(scan.maximumLinear),
      maximumOutputTruePeakFrame: scan.maximumFrame,
    });
    if (summary.ceilingMode === "static") {
      summaryProducerAuthorities.set(summary, Object.freeze({
        algorithm: summary.algorithm,
        sampleRate: summary.sampleRate,
        frames: summary.frames,
        bytes: summary.frames * bytesPerFrame,
        sha256: finalSha256,
        truePeakLinear: summary.maximumOutputTruePeakLinear,
        truePeakDbtp: summary.maximumOutputTruePeakDbtp,
        truePeakFrame: summary.maximumOutputTruePeakFrame,
      }));
    }
    published = true;
    return summary;
  } catch (error) {
    if (!published) await rm(outputPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await outputReservation?.close().catch(() => undefined);
    await unreconciled?.close().catch(() => undefined);
    await ceilings?.close().catch(() => undefined);
    await input.handle.close().catch(() => undefined);
    if (!published) await rm(outputPath, { force: true }).catch(() => undefined);
    await Promise.all([
      rm(unreconciledPath, { force: true }).catch(() => undefined),
      rm(correctedPath, { force: true }).catch(() => undefined),
      rm(ceilingPath, { force: true }).catch(() => undefined),
    ]);
  }
}
