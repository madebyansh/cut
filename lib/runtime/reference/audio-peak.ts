import { createReadStream } from "node:fs";
import { mkdtemp, open, rename, rm, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";

export type ReferenceAudioPeakErrorCode =
  | "CUT_AUDIO_CLIPPING"
  | "CUT_AUDIO_NONFINITE"
  | "CUT_AUDIO_PEAK_STRUCTURE"
  | "CUT_AUDIO_PEAK_RESOURCE_LIMIT";

export type ReferenceAudioPeakSource = Readonly<{
  module: string;
  line: number;
  column: number;
  nodeId?: string;
}>;

export type ReferenceAudioPeakChannel = 0 | 1;

export type ReferenceAudioPeakErrorDetail = Readonly<{
  kind: "clipping" | "nonfinite" | "structure" | "resource";
  reason?: string;
  expectedFrames?: number;
  expectedBytes?: number;
  observedBytes?: number;
  frame?: number;
  channel?: ReferenceAudioPeakChannel;
  channelName?: "left" | "right";
  sample?: number;
  absoluteSample?: number;
  sampleDbfs?: number;
  thresholdDbfs?: number;
  thresholdLinear?: number;
}>;

export class ReferenceAudioPeakError extends Error {
  readonly source: ReferenceAudioPeakSource;
  readonly detail: ReferenceAudioPeakErrorDetail;

  constructor(
    readonly code: ReferenceAudioPeakErrorCode,
    source: ReferenceAudioPeakSource,
    message: string,
    detail: ReferenceAudioPeakErrorDetail,
  ) {
    super(`${code}: ${message}`);
    this.name = "ReferenceAudioPeakError";
    this.source = Object.freeze({ ...source });
    this.detail = Object.freeze({ ...detail });
  }
}

const stereoChannels = 2;
const bytesPerFloatSample = 4;
const bytesPerStereoFrame = stereoChannels * bytesPerFloatSample;

// Canonical PCM24 WAVE has six data bytes per stereo frame and a 32-bit RIFF
// chunk size. Keeping the float boundary below the corresponding frame count
// means this scanner can feed a later canonical PCM24 WAVE quantizer without a
// hidden RF64 transition or an unsafe integer conversion.
const maximumCanonicalPcm24Frames = Math.floor((0xffff_ffff - 36) / 6);

export const referenceAudioPeakLimits = Object.freeze({
  channels: stereoChannels,
  bytesPerSample: bytesPerFloatSample,
  bytesPerFrame: bytesPerStereoFrame,
  minimumThresholdDbfs: -600,
  maximumThresholdDbfs: 0,
  maximumFrames: maximumCanonicalPcm24Frames,
  maximumChunkBytes: 1_048_576,
  maximumChunks: 1_000_000,
  fileReadChunkBytes: 65_536,
  minimumPcm24SampleRate: 8_000,
  maximumPcm24SampleRate: 384_000,
});

export type ReferenceAudioPeakScanOptions = Readonly<{
  expectedFrames: number;
  source: ReferenceAudioPeakSource;
  thresholdDbfs?: number;
}>;

export type ReferenceAudioPeakScan = Readonly<{
  format: "cut-reference-audio-peak-scan";
  version: 1;
  sampleFormat: "f32le";
  channels: 2;
  expectedFrames: number;
  observedFrames: number;
  expectedBytes: number;
  observedBytes: number;
  thresholdDbfs: number;
  thresholdLinear: number;
  silent: boolean;
  peakLinear: number;
  peakDbfs: number | null;
  peakFrame: number | null;
  peakChannel: ReferenceAudioPeakChannel | null;
  peakChannelName: "left" | "right" | null;
  peakSample: number | null;
}>;

export type ReferencePcm24WaveQuantizationOptions = ReferenceAudioPeakScanOptions & Readonly<{
  sampleRate: number;
}>;

export type ReferencePcm24WaveQuantization = Readonly<{
  format: "cut-reference-pcm24-wave";
  version: 1;
  channels: 2;
  bitsPerSample: 24;
  sampleRate: number;
  frames: number;
  dataBytes: number;
  outputBytes: number;
  peak: ReferenceAudioPeakScan;
}>;

type ReferenceAudioByteStream = AsyncIterable<Uint8Array> | Iterable<Uint8Array>;

type NormalizedContract = {
  expectedFrames: number;
  expectedSamples: number;
  expectedBytes: number;
  thresholdDbfs: number;
  thresholdLinear: number;
  source: ReferenceAudioPeakSource;
};

type SampleLocation = {
  frame: number;
  channel: ReferenceAudioPeakChannel;
  channelName: "left" | "right";
  sample: number;
  absoluteSample: number;
};

function stableNumber(value: number) {
  if (Object.is(value, -0)) return "-0";
  if (Number.isInteger(value)) return String(value);
  return value.toPrecision(12).replace(/(?:\.0+|(?:(\.\d*?[1-9])0+))(?=e|$)/u, "$1");
}

function fail(
  code: ReferenceAudioPeakErrorCode,
  source: ReferenceAudioPeakSource,
  message: string,
  detail: ReferenceAudioPeakErrorDetail,
): never {
  throw new ReferenceAudioPeakError(code, source, message, detail);
}

/** Convert an authored dBFS ceiling to its exact runtime linear comparison. */
export function referenceDbfsToLinear(dbfs: number) {
  if (
    !Number.isFinite(dbfs)
    || dbfs < referenceAudioPeakLimits.minimumThresholdDbfs
    || dbfs > referenceAudioPeakLimits.maximumThresholdDbfs
  ) {
    throw new RangeError(`dBFS must be finite and between ${referenceAudioPeakLimits.minimumThresholdDbfs} and ${referenceAudioPeakLimits.maximumThresholdDbfs}.`);
  }
  return 10 ** (dbfs / 20);
}

function normalizeContract(options: ReferenceAudioPeakScanOptions): NormalizedContract {
  const { expectedFrames, source } = options;
  if (!Number.isSafeInteger(expectedFrames) || expectedFrames < 0) {
    fail(
      "CUT_AUDIO_PEAK_STRUCTURE",
      source,
      `expectedFrames must be a non-negative safe integer; received ${stableNumber(expectedFrames)}.`,
      { kind: "structure", reason: "invalid-expected-frames", expectedFrames },
    );
  }
  if (expectedFrames > referenceAudioPeakLimits.maximumFrames) {
    fail(
      "CUT_AUDIO_PEAK_RESOURCE_LIMIT",
      source,
      `expectedFrames ${expectedFrames} exceeds the bounded stereo f32le limit ${referenceAudioPeakLimits.maximumFrames}.`,
      { kind: "resource", reason: "frame-budget", expectedFrames },
    );
  }

  const thresholdDbfs = options.thresholdDbfs ?? 0;
  if (
    !Number.isFinite(thresholdDbfs)
    || thresholdDbfs < referenceAudioPeakLimits.minimumThresholdDbfs
    || thresholdDbfs > referenceAudioPeakLimits.maximumThresholdDbfs
  ) {
    fail(
      "CUT_AUDIO_PEAK_STRUCTURE",
      source,
      `thresholdDbfs must be finite and between ${referenceAudioPeakLimits.minimumThresholdDbfs} and ${referenceAudioPeakLimits.maximumThresholdDbfs}; received ${stableNumber(thresholdDbfs)}.`,
      { kind: "structure", reason: "invalid-threshold", thresholdDbfs },
    );
  }
  const thresholdLinear = referenceDbfsToLinear(thresholdDbfs);
  if (!Number.isFinite(thresholdLinear) || thresholdLinear <= 0 || thresholdLinear > 1) {
    fail(
      "CUT_AUDIO_PEAK_STRUCTURE",
      source,
      `thresholdDbfs ${stableNumber(thresholdDbfs)} did not reduce to a finite linear ceiling in (0, 1].`,
      { kind: "structure", reason: "invalid-linear-threshold", thresholdDbfs, thresholdLinear },
    );
  }

  const expectedSamples = expectedFrames * stereoChannels;
  const expectedBytes = expectedFrames * bytesPerStereoFrame;
  return { expectedFrames, expectedSamples, expectedBytes, thresholdDbfs, thresholdLinear, source };
}

function sampleLocation(sampleIndex: number, sample: number): SampleLocation {
  const channel = sampleIndex % stereoChannels as ReferenceAudioPeakChannel;
  return {
    frame: Math.floor(sampleIndex / stereoChannels),
    channel,
    channelName: channel === 0 ? "left" : "right",
    sample,
    absoluteSample: Math.abs(sample),
  };
}

function structuralEndFailure(contract: NormalizedContract, observedBytes: number): never {
  const common = {
    kind: "structure" as const,
    expectedFrames: contract.expectedFrames,
    expectedBytes: contract.expectedBytes,
    observedBytes,
  };
  if (observedBytes % bytesPerFloatSample !== 0) {
    fail(
      "CUT_AUDIO_PEAK_STRUCTURE",
      contract.source,
      `raw stereo f32le ended inside a 4-byte sample: expected ${contract.expectedBytes} bytes, observed ${observedBytes}.`,
      { ...common, reason: "partial-sample" },
    );
  }
  if (observedBytes % bytesPerStereoFrame !== 0) {
    fail(
      "CUT_AUDIO_PEAK_STRUCTURE",
      contract.source,
      `raw stereo f32le ended after only one channel of a stereo frame: expected ${contract.expectedBytes} bytes, observed ${observedBytes}.`,
      { ...common, reason: "partial-stereo-frame" },
    );
  }
  fail(
    "CUT_AUDIO_PEAK_STRUCTURE",
    contract.source,
    `raw stereo f32le was truncated: expected ${contract.expectedBytes} bytes for ${contract.expectedFrames} frames, observed ${observedBytes}.`,
    { ...common, reason: "truncated" },
  );
}

/**
 * Scan an exact interleaved stereo raw f32le boundary without buffering it.
 *
 * Structural reconciliation takes precedence over sample diagnostics so an
 * extra/truncated stream cannot become valid merely because chunk boundaries
 * expose clipping first. Within an exact stream, non-finite refusal takes
 * precedence because a peak measurement over NaN/Infinity is undefined.
 */
export async function scanReferenceStereoF32Le(
  input: ReferenceAudioByteStream,
  options: ReferenceAudioPeakScanOptions,
): Promise<ReferenceAudioPeakScan> {
  const contract = normalizeContract(options);
  const carry = new Uint8Array(bytesPerFloatSample);
  let carryLength = 0;
  let observedBytes = 0;
  let sampleIndex = 0;
  let chunkCount = 0;
  let peak: SampleLocation | undefined;
  let firstClipping: SampleLocation | undefined;
  let firstNonfinite: SampleLocation | undefined;

  const inspect = (sample: number) => {
    const location = sampleLocation(sampleIndex, sample);
    sampleIndex += 1;
    if (!Number.isFinite(sample)) {
      firstNonfinite ??= location;
      return;
    }
    if (!peak || location.absoluteSample > peak.absoluteSample) peak = location;
    if (location.absoluteSample > contract.thresholdLinear) firstClipping ??= location;
  };

  for await (const authoredChunk of input) {
    chunkCount += 1;
    if (chunkCount > referenceAudioPeakLimits.maximumChunks) {
      fail(
        "CUT_AUDIO_PEAK_RESOURCE_LIMIT",
        contract.source,
        `raw stereo f32le exceeded the ${referenceAudioPeakLimits.maximumChunks}-chunk scan budget.`,
        {
          kind: "resource",
          reason: "chunk-count-budget",
          expectedFrames: contract.expectedFrames,
          expectedBytes: contract.expectedBytes,
          observedBytes,
        },
      );
    }
    if (!(authoredChunk instanceof Uint8Array)) {
      fail(
        "CUT_AUDIO_PEAK_STRUCTURE",
        contract.source,
        "raw stereo f32le yielded a non-byte chunk.",
        {
          kind: "structure",
          reason: "invalid-chunk",
          expectedFrames: contract.expectedFrames,
          expectedBytes: contract.expectedBytes,
          observedBytes,
        },
      );
    }
    if (authoredChunk.byteLength > referenceAudioPeakLimits.maximumChunkBytes) {
      fail(
        "CUT_AUDIO_PEAK_RESOURCE_LIMIT",
        contract.source,
        `raw stereo f32le chunk has ${authoredChunk.byteLength} bytes; maximum is ${referenceAudioPeakLimits.maximumChunkBytes}.`,
        {
          kind: "resource",
          reason: "chunk-size-budget",
          expectedFrames: contract.expectedFrames,
          expectedBytes: contract.expectedBytes,
          observedBytes,
        },
      );
    }
    if (authoredChunk.byteLength > contract.expectedBytes - observedBytes) {
      fail(
        "CUT_AUDIO_PEAK_STRUCTURE",
        contract.source,
        `raw stereo f32le contains bytes beyond the exact ${contract.expectedBytes}-byte boundary for ${contract.expectedFrames} frames.`,
        {
          kind: "structure",
          reason: "extra-bytes",
          expectedFrames: contract.expectedFrames,
          expectedBytes: contract.expectedBytes,
          observedBytes: contract.expectedBytes + 1,
        },
      );
    }

    observedBytes += authoredChunk.byteLength;
    let offset = 0;
    if (carryLength > 0) {
      const needed = bytesPerFloatSample - carryLength;
      const copied = Math.min(needed, authoredChunk.byteLength);
      carry.set(authoredChunk.subarray(0, copied), carryLength);
      carryLength += copied;
      offset = copied;
      if (carryLength === bytesPerFloatSample) {
        inspect(new DataView(carry.buffer, carry.byteOffset, carry.byteLength).getFloat32(0, true));
        carryLength = 0;
      }
    }

    const completeBytes = authoredChunk.byteLength - offset - ((authoredChunk.byteLength - offset) % bytesPerFloatSample);
    if (completeBytes > 0) {
      const view = new DataView(authoredChunk.buffer, authoredChunk.byteOffset + offset, completeBytes);
      for (let localOffset = 0; localOffset < completeBytes; localOffset += bytesPerFloatSample) {
        inspect(view.getFloat32(localOffset, true));
      }
      offset += completeBytes;
    }
    if (offset < authoredChunk.byteLength) {
      const remainder = authoredChunk.subarray(offset);
      carry.set(remainder, 0);
      carryLength = remainder.byteLength;
    }
  }

  if (observedBytes !== contract.expectedBytes) structuralEndFailure(contract, observedBytes);
  if (carryLength !== 0 || sampleIndex !== contract.expectedSamples) {
    fail(
      "CUT_AUDIO_PEAK_STRUCTURE",
      contract.source,
      `raw stereo f32le decoded ${sampleIndex} samples but the exact frame contract requires ${contract.expectedSamples}.`,
      {
        kind: "structure",
        reason: "decoded-sample-mismatch",
        expectedFrames: contract.expectedFrames,
        expectedBytes: contract.expectedBytes,
        observedBytes,
      },
    );
  }

  if (firstNonfinite) {
    const label = Number.isNaN(firstNonfinite.sample)
      ? "NaN"
      : firstNonfinite.sample > 0 ? "+Infinity" : "-Infinity";
    fail(
      "CUT_AUDIO_NONFINITE",
      contract.source,
      `sample at frame ${firstNonfinite.frame}, ${firstNonfinite.channelName} channel is ${label}; pre-master stereo f32le must contain only finite samples.`,
      {
        kind: "nonfinite",
        reason: "nonfinite-sample",
        expectedFrames: contract.expectedFrames,
        expectedBytes: contract.expectedBytes,
        observedBytes,
        frame: firstNonfinite.frame,
        channel: firstNonfinite.channel,
        channelName: firstNonfinite.channelName,
        sample: firstNonfinite.sample,
      },
    );
  }

  if (firstClipping) {
    const sampleDbfs = 20 * Math.log10(firstClipping.absoluteSample);
    fail(
      "CUT_AUDIO_CLIPPING",
      contract.source,
      `sample at frame ${firstClipping.frame}, ${firstClipping.channelName} channel has magnitude ${stableNumber(firstClipping.absoluteSample)} (${stableNumber(sampleDbfs)} dBFS), exceeding the ${stableNumber(contract.thresholdDbfs)} dBFS ceiling.`,
      {
        kind: "clipping",
        reason: "sample-peak-ceiling",
        expectedFrames: contract.expectedFrames,
        expectedBytes: contract.expectedBytes,
        observedBytes,
        frame: firstClipping.frame,
        channel: firstClipping.channel,
        channelName: firstClipping.channelName,
        sample: firstClipping.sample,
        absoluteSample: firstClipping.absoluteSample,
        sampleDbfs,
        thresholdDbfs: contract.thresholdDbfs,
        thresholdLinear: contract.thresholdLinear,
      },
    );
  }

  const peakLinear = peak?.absoluteSample ?? 0;
  return Object.freeze({
    format: "cut-reference-audio-peak-scan",
    version: 1,
    sampleFormat: "f32le",
    channels: 2,
    expectedFrames: contract.expectedFrames,
    observedFrames: sampleIndex / stereoChannels,
    expectedBytes: contract.expectedBytes,
    observedBytes,
    thresholdDbfs: contract.thresholdDbfs,
    thresholdLinear: contract.thresholdLinear,
    silent: peakLinear === 0,
    peakLinear,
    peakDbfs: peakLinear === 0 ? null : 20 * Math.log10(peakLinear),
    peakFrame: peak?.frame ?? null,
    peakChannel: peak?.channel ?? null,
    peakChannelName: peak?.channelName ?? null,
    peakSample: peak?.sample ?? null,
  });
}

/** Scan a raw file using the same bounded chunk contract as the iterable API. */
export async function scanReferenceStereoF32LeFile(
  path: string,
  options: ReferenceAudioPeakScanOptions,
): Promise<ReferenceAudioPeakScan> {
  const stream = createReadStream(path, { highWaterMark: referenceAudioPeakLimits.fileReadChunkBytes });
  try {
    return await scanReferenceStereoF32Le(stream, options);
  } catch (error) {
    if (error instanceof ReferenceAudioPeakError) throw error;
    const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code.slice(0, 64)
      : "UNKNOWN";
    fail(
      "CUT_AUDIO_PEAK_STRUCTURE",
      options.source,
      `raw stereo f32le input could not be read (${code}).`,
      { kind: "structure", reason: "input-read-failure", expectedFrames: options.expectedFrames },
    );
  } finally {
    stream.destroy();
  }
}

function validatePcm24SampleRate(sampleRate: number, source: ReferenceAudioPeakSource) {
  if (
    !Number.isSafeInteger(sampleRate)
    || sampleRate < referenceAudioPeakLimits.minimumPcm24SampleRate
    || sampleRate > referenceAudioPeakLimits.maximumPcm24SampleRate
  ) {
    fail(
      "CUT_AUDIO_PEAK_STRUCTURE",
      source,
      `PCM24 WAVE sampleRate must be an integer between ${referenceAudioPeakLimits.minimumPcm24SampleRate} and ${referenceAudioPeakLimits.maximumPcm24SampleRate}; received ${stableNumber(sampleRate)}.`,
      { kind: "structure", reason: "invalid-sample-rate" },
    );
  }
  return sampleRate;
}

function pcm24WaveHeader(expectedFrames: number, sampleRate: number) {
  const dataBytes = expectedFrames * 6;
  const result = Buffer.alloc(44);
  result.write("RIFF", 0, "ascii");
  result.writeUInt32LE(36 + dataBytes, 4);
  result.write("WAVE", 8, "ascii");
  result.write("fmt ", 12, "ascii");
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(2, 22);
  result.writeUInt32LE(sampleRate, 24);
  result.writeUInt32LE(sampleRate * 6, 28);
  result.writeUInt16LE(6, 32);
  result.writeUInt16LE(24, 34);
  result.write("data", 36, "ascii");
  result.writeUInt32LE(dataBytes, 40);
  return result;
}

function roundTiesToEven(value: number) {
  const lower = Math.floor(value), fraction = value - lower;
  if (fraction < 0.5) return lower;
  if (fraction > 0.5) return lower + 1;
  return lower % 2 === 0 ? lower : lower + 1;
}

/** Canonical, undithered, round-to-nearest-ties-to-even signed PCM24 mapping. */
function referenceFloat32ToPcm24Integer(sample: number) {
  if (!Number.isFinite(sample)) return 0;
  if (sample <= -1) return -0x80_0000;
  if (sample >= 1) return 0x7f_ffff;
  // The greatest float32 below +1 is exactly halfway between the two top
  // signed PCM24 codes after 2^23 scaling. Ties-to-even would otherwise
  // produce +0x800000, which is not representable and would wrap to negative
  // full scale when serialized as 24-bit two's complement.
  return Math.max(-0x80_0000, Math.min(0x7f_ffff, roundTiesToEven(sample * 0x80_0000)));
}

function quantizeF32Samples(bytes: Uint8Array) {
  const samples = bytes.byteLength / bytesPerFloatSample;
  const output = Buffer.allocUnsafe(samples * 3);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let sampleIndex = 0; sampleIndex < samples; sampleIndex += 1) {
    const value = referenceFloat32ToPcm24Integer(view.getFloat32(sampleIndex * bytesPerFloatSample, true));
    const encoded = value < 0 ? value + 0x100_0000 : value;
    output[sampleIndex * 3] = encoded & 0xff;
    output[sampleIndex * 3 + 1] = encoded >>> 8 & 0xff;
    output[sampleIndex * 3 + 2] = encoded >>> 16 & 0xff;
  }
  return output;
}

async function writeAll(handle: FileHandle, bytes: Uint8Array) {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, null);
    if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0) throw new Error("zero-byte-write");
    offset += result.bytesWritten;
  }
}

async function* quantizingByteStream(
  input: AsyncIterable<Uint8Array>,
  output: FileHandle,
): AsyncGenerator<Uint8Array> {
  const carry = new Uint8Array(bytesPerFloatSample);
  let carryLength = 0;
  for await (const chunk of input) {
    if (chunk instanceof Uint8Array) {
      let offset = 0;
      if (carryLength > 0) {
        const copied = Math.min(bytesPerFloatSample - carryLength, chunk.byteLength);
        carry.set(chunk.subarray(0, copied), carryLength);
        carryLength += copied;
        offset = copied;
        if (carryLength === bytesPerFloatSample) {
          await writeAll(output, quantizeF32Samples(carry));
          carryLength = 0;
        }
      }
      const completeBytes = chunk.byteLength - offset - ((chunk.byteLength - offset) % bytesPerFloatSample);
      if (completeBytes > 0) {
        await writeAll(output, quantizeF32Samples(chunk.subarray(offset, offset + completeBytes)));
        offset += completeBytes;
      }
      if (offset < chunk.byteLength) {
        const remainder = chunk.subarray(offset);
        carry.set(remainder);
        carryLength = remainder.byteLength;
      }
    }
    yield chunk;
  }
  // The scanner owns the stable structural diagnostic for a partial sample.
  // Any bytes retained here therefore remain unpublished when it refuses.
}

/**
 * Atomically quantize one validated raw stereo f32le file to canonical PCM24
 * WAVE. The temporary WAVE may receive saturated placeholder bytes while the
 * scanner is still running, but it is never published unless the complete
 * float stream passes structure, finite-value and sample-peak validation.
 */
export async function quantizeReferenceStereoF32LeFileToPcm24Wave(
  inputPath: string,
  outputPath: string,
  options: ReferencePcm24WaveQuantizationOptions,
): Promise<ReferencePcm24WaveQuantization> {
  const sampleRate = validatePcm24SampleRate(options.sampleRate, options.source);
  const contract = normalizeContract(options);
  const outputDirectory = dirname(outputPath);
  let temporaryDirectory: string | undefined;
  let output: FileHandle | undefined;
  let input: ReturnType<typeof createReadStream> | undefined;
  let phase: "prepare" | "read" | "publish" = "prepare";
  try {
    temporaryDirectory = await mkdtemp(join(outputDirectory, ".cut-pcm24-"));
    const temporaryPath = join(temporaryDirectory, "audio.wav");
    output = await open(temporaryPath, "wx", 0o600);
    await writeAll(output, pcm24WaveHeader(contract.expectedFrames, sampleRate));
    input = createReadStream(inputPath, { highWaterMark: referenceAudioPeakLimits.fileReadChunkBytes });
    phase = "read";
    const peak = await scanReferenceStereoF32Le(quantizingByteStream(input, output), options);
    await output.sync();
    await output.close();
    output = undefined;
    input.destroy();
    input = undefined;
    phase = "publish";
    await rename(temporaryPath, outputPath);
    const dataBytes = contract.expectedFrames * 6;
    return Object.freeze({
      format: "cut-reference-pcm24-wave",
      version: 1,
      channels: 2,
      bitsPerSample: 24,
      sampleRate,
      frames: contract.expectedFrames,
      dataBytes,
      outputBytes: 44 + dataBytes,
      peak,
    });
  } catch (error) {
    if (error instanceof ReferenceAudioPeakError) throw error;
    const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code.slice(0, 64)
      : "UNKNOWN";
    return fail(
      "CUT_AUDIO_PEAK_STRUCTURE",
      options.source,
      `canonical PCM24 WAVE ${phase} failed (${code}).`,
      {
        kind: "structure",
        reason: phase === "read" ? "input-read-failure" : phase === "publish" ? "output-publish-failure" : "output-prepare-failure",
        expectedFrames: options.expectedFrames,
        expectedBytes: contract.expectedBytes,
      },
    );
  } finally {
    input?.destroy();
    if (output) await output.close().catch(() => undefined);
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}
