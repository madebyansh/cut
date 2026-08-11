import { createHash } from "node:crypto";
import { stableJsonStringify } from "../core/stable";

const policyBody = Object.freeze({
  format: "cut-wave-normalize-policy" as const,
  version: 1 as const,
  input: Object.freeze({
    container: "riff-wave-pcm-integer-classic-or-extensible" as const,
    formatVariants: Object.freeze({
      classicPcm: Object.freeze({
        id: "classic-pcm" as const,
        formatTag: 1 as const,
        fmtChunkBytes: 16 as const,
      }),
      extensiblePcm: Object.freeze({
        id: "extensible-pcm" as const,
        formatTag: 0xfffe as const,
        fmtChunkBytes: 40 as const,
        cbSize: 22 as const,
        pcmSubformatGuidRiffBytes: "0100000000001000800000aa00389b71" as const,
        validBits: "must-equal-container-bits-v1" as const,
        standardSpeakerMask: 0x0003_ffff,
        channelMask: "zero-or-standard-speaker-bits-with-popcount-equal-to-channels-v1" as const,
      }),
    }),
    minimumSampleRate: 8_000,
    maximumSampleRate: 192_000,
    minimumChannels: 1,
    maximumChannels: 8,
    bitsPerSample: Object.freeze([16, 24, 32] as const),
    maximumDurationSeconds: 10,
    maximumWaveBytes: 64 * 1024 * 1024,
    acceptedChunksInOrder: Object.freeze(["fmt ", "data"] as const),
    oddChunkPadding: "one-zero-byte-v1" as const,
  }),
  output: Object.freeze({
    sampleFormat: "f32le" as const,
    sampleRate: 16_000 as const,
    channels: 1 as const,
    sampleCount: "ceil-source-frames-times-16000-over-source-rate-v1" as const,
    zero: "canonical-positive-zero-v1" as const,
  }),
  downmix: "equal-weight-arithmetic-mean-f64-v1" as const,
  resampler: Object.freeze({
    identityAtTargetRate: true,
    kernel: "32-tap-blackman-windowed-sinc-lowpass-v1" as const,
    taps: 32 as const,
    radiusSamples: 16 as const,
    nyquistGuardNumerator: 94 as const,
    nyquistGuardDenominator: 100 as const,
    phase: "left-edge-zero-based-rational-clock-v1" as const,
    boundary: "nearest-edge-extension-full-kernel-renormalization-v1" as const,
    outputClamp: "saturating-unit-interval-before-f32-v1" as const,
    accumulator: "ecmascript-number-f64-v1" as const,
    quantization: "ecmascript-math-fround-then-ieee754-f32le-v1" as const,
  }),
  authorityBoundary:
    "The caller supplies an expected byte count and SHA-256 for one in-memory byte view. CUT rejects SharedArrayBuffer input, copies the view once, and authenticates that private copy before parsing.",
  reproducibilityBoundary:
    "Exact repeat is claimed for the same authenticated bytes, CUT policy, and supported JavaScript runtime identity; cross-runtime libm bit identity is not claimed.",
});

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

export const cutWaveNormalizePolicy = Object.freeze({
  ...policyBody,
  policySha256: sha256(stableJsonStringify(policyBody)),
});

export type CutWaveMemoryAuthority = Readonly<{
  bytes: number;
  sha256: string;
}>;

export type CutWaveNormalizationEvidence = Readonly<{
  format: "cut-wave-normalization-evidence";
  version: 1;
  source: Readonly<{ bytes: number; sha256: string }>;
  wave: Readonly<{
    container: "RIFF/WAVE";
    audioFormat: 1;
    formatVariant: "classic-pcm" | "extensible-pcm";
    sampleRate: number;
    channels: number;
    bitsPerSample: 16 | 24 | 32;
    validBitsPerSample: 16 | 24 | 32;
    channelMask: number;
    blockAlign: number;
    byteRate: number;
    frames: number;
    dataBytes: number;
    dataPadBytes: 0 | 1;
    duration: Readonly<{ numeratorSamples: number; denominatorSampleRate: number }>;
  }>;
  policy: Readonly<{
    policySha256: string;
    downmix: typeof cutWaveNormalizePolicy.downmix;
    resampler: typeof cutWaveNormalizePolicy.resampler.kernel | "target-rate-identity-v1";
  }>;
  output: Readonly<{
    sampleFormat: "f32le";
    sampleRate: 16_000;
    channels: 1;
    samples: number;
    bytes: number;
    sha256: string;
  }>;
  work: Readonly<{
    inputFrames: number;
    channelSampleReads: number;
    downmixAdditions: number;
    outputSamples: number;
    candidateTapEvaluations: number;
    coefficientEvaluations: number;
    contributingCoefficients: number;
    boundaryExtendedTaps: number;
    multiplyAccumulateOperations: number;
    saturatedOutputSamples: number;
    float32Writes: number;
  }>;
  evidenceSha256: string;
}>;

export type CutWaveNormalizationResult = Readonly<{
  pcmBytes: Buffer;
  evidence: CutWaveNormalizationEvidence;
  evidenceBytes: Buffer;
}>;

export type CutWaveNativeRateDecodeLimits = Readonly<{
  maximumWaveBytes: number;
  maximumFrames: number;
  maximumChannelSampleReads: number;
}>;

export const cutDialogueProsodyWaveDecodeLimits: CutWaveNativeRateDecodeLimits = Object.freeze({
  maximumWaveBytes: 64 * 1024 * 1024,
  maximumFrames: 100_000_000,
  maximumChannelSampleReads: 100_000_000,
});

export type CutWaveNativeRateDecodeResult = Readonly<{
  pcm: Float32Array;
  source: Readonly<{ bytes: number; sha256: string }>;
  wave: Readonly<{
    container: "RIFF/WAVE";
    formatVariant: "classic-pcm" | "extensible-pcm";
    sampleRate: number;
    sourceChannels: number;
    outputChannels: 1;
    bitsPerSample: 16 | 24 | 32;
    validBitsPerSample: 16 | 24 | 32;
    channelMask: number;
    durationSamples: number;
  }>;
  work: Readonly<{
    channelSampleReads: number;
    downmixAdditions: number;
    float32Writes: number;
  }>;
}>;

export type CutWaveNormalizeErrorCode =
  | "CUT_WAVE_NORMALIZE_INPUT"
  | "CUT_WAVE_NORMALIZE_AUTHORITY"
  | "CUT_WAVE_NORMALIZE_RIFF"
  | "CUT_WAVE_NORMALIZE_FORMAT"
  | "CUT_WAVE_NORMALIZE_LIMIT"
  | "CUT_WAVE_NORMALIZE_RESAMPLER";

export class CutWaveNormalizeError extends Error {
  constructor(readonly code: CutWaveNormalizeErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "CutWaveNormalizeError";
  }
}

function fail(code: CutWaveNormalizeErrorCode, message: string): never {
  throw new CutWaveNormalizeError(code, message);
}

function boundedPositiveInteger(value: unknown, maximum: number, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    fail("CUT_WAVE_NORMALIZE_LIMIT", `${label} must be one positive safe integer no greater than ${maximum}.`);
  }
  return Number(value);
}

function snapshotAuthenticatedBytes(
  value: Uint8Array,
  authority: CutWaveMemoryAuthority,
  maximumWaveBytes = cutWaveNormalizePolicy.input.maximumWaveBytes,
) {
  if (!(value instanceof Uint8Array)) fail("CUT_WAVE_NORMALIZE_INPUT", "input must be one Uint8Array byte view.");
  if (typeof SharedArrayBuffer !== "undefined" && value.buffer instanceof SharedArrayBuffer) {
    fail("CUT_WAVE_NORMALIZE_INPUT", "SharedArrayBuffer input cannot provide one immutable in-memory snapshot.");
  }
  const claimedBytes = authority?.bytes;
  const claimedSha256 = authority?.sha256;
  if (!Number.isSafeInteger(claimedBytes) || Number(claimedBytes) < 1
    || typeof claimedSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(claimedSha256)) {
    fail("CUT_WAVE_NORMALIZE_AUTHORITY", "authority must contain a positive safe byte count and lowercase SHA-256.");
  }
  if (value.byteLength > maximumWaveBytes) {
    fail("CUT_WAVE_NORMALIZE_LIMIT", `input exceeds ${maximumWaveBytes} bytes.`);
  }
  const bytes = Buffer.from(value);
  const digest = sha256(bytes);
  if (bytes.byteLength !== claimedBytes || digest !== claimedSha256) {
    fail("CUT_WAVE_NORMALIZE_AUTHORITY", "the private input snapshot differs from its expected byte identity.");
  }
  return bytes;
}

type ParsedWave = Readonly<{
  formatVariant: "classic-pcm" | "extensible-pcm";
  sampleRate: number;
  channels: number;
  bitsPerSample: 16 | 24 | 32;
  validBitsPerSample: 16 | 24 | 32;
  channelMask: number;
  blockAlign: number;
  byteRate: number;
  frames: number;
  data: Buffer;
  dataPadBytes: 0 | 1;
}>;

function parseClassicWave(bytes: Buffer, maximumFrames?: number): ParsedWave {
  if (bytes.byteLength < 44 || bytes.toString("ascii", 0, 4) !== "RIFF"
    || bytes.toString("ascii", 8, 12) !== "WAVE" || bytes.readUInt32LE(4) + 8 !== bytes.byteLength) {
    fail("CUT_WAVE_NORMALIZE_RIFF", "input must be one complete classic RIFF/WAVE byte stream.");
  }
  let cursor = 12;
  let format: Omit<ParsedWave, "frames" | "data" | "dataPadBytes"> | undefined;
  let data: Buffer | undefined;
  let dataPadBytes: 0 | 1 = 0;
  for (let chunkIndex = 0; cursor < bytes.byteLength; chunkIndex += 1) {
    if (chunkIndex > 1 || cursor + 8 > bytes.byteLength) {
      fail("CUT_WAVE_NORMALIZE_RIFF", "input must contain exactly one fmt chunk followed by one data chunk.");
    }
    const id = bytes.toString("ascii", cursor, cursor + 4);
    const expectedId = cutWaveNormalizePolicy.input.acceptedChunksInOrder[chunkIndex];
    if (id !== expectedId) {
      fail("CUT_WAVE_NORMALIZE_RIFF", `chunk ${chunkIndex} must be ${JSON.stringify(expectedId)}; found ${JSON.stringify(id)}.`);
    }
    const size = bytes.readUInt32LE(cursor + 4);
    const body = cursor + 8;
    const end = body + size;
    const paddedEnd = end + (size & 1);
    if (end > bytes.byteLength || paddedEnd > bytes.byteLength) {
      fail("CUT_WAVE_NORMALIZE_RIFF", `${JSON.stringify(id)} chunk or its required padding is truncated.`);
    }
    if ((size & 1) !== 0 && bytes[end] !== 0) {
      fail("CUT_WAVE_NORMALIZE_RIFF", `${JSON.stringify(id)} chunk padding must be one zero byte.`);
    }
    if (id === "fmt ") {
      if (size !== cutWaveNormalizePolicy.input.formatVariants.classicPcm.fmtChunkBytes
        && size !== cutWaveNormalizePolicy.input.formatVariants.extensiblePcm.fmtChunkBytes) {
        fail("CUT_WAVE_NORMALIZE_FORMAT", "fmt chunk must be exactly 16-byte classic PCM or 40-byte WAVE_FORMAT_EXTENSIBLE PCM.");
      }
      const formatTag = bytes.readUInt16LE(body);
      const channels = bytes.readUInt16LE(body + 2);
      const sampleRate = bytes.readUInt32LE(body + 4);
      const byteRate = bytes.readUInt32LE(body + 8);
      const blockAlign = bytes.readUInt16LE(body + 12);
      const rawBits = bytes.readUInt16LE(body + 14);
      if (channels < cutWaveNormalizePolicy.input.minimumChannels
        || channels > cutWaveNormalizePolicy.input.maximumChannels
        || sampleRate < cutWaveNormalizePolicy.input.minimumSampleRate
        || sampleRate > cutWaveNormalizePolicy.input.maximumSampleRate
        || !cutWaveNormalizePolicy.input.bitsPerSample.includes(rawBits as 16 | 24 | 32)) {
        fail("CUT_WAVE_NORMALIZE_FORMAT", "input must be PCM integer at 8..192 kHz, 1..8 channels, and 16, 24, or 32 container bits.");
      }
      const bitsPerSample = rawBits as 16 | 24 | 32;
      let formatVariant: ParsedWave["formatVariant"];
      let validBitsPerSample = bitsPerSample;
      let channelMask = 0;
      if (size === cutWaveNormalizePolicy.input.formatVariants.classicPcm.fmtChunkBytes) {
        if (formatTag !== cutWaveNormalizePolicy.input.formatVariants.classicPcm.formatTag) {
          fail("CUT_WAVE_NORMALIZE_FORMAT", "16-byte fmt chunk must use integer PCM format tag 1.");
        }
        formatVariant = "classic-pcm";
      } else {
        const policy = cutWaveNormalizePolicy.input.formatVariants.extensiblePcm;
        if (formatTag !== policy.formatTag || bytes.readUInt16LE(body + 16) !== policy.cbSize) {
          fail("CUT_WAVE_NORMALIZE_FORMAT", "40-byte extensible fmt chunk must use WAVE_FORMAT_EXTENSIBLE and cbSize 22.");
        }
        const rawValidBits = bytes.readUInt16LE(body + 18);
        if (rawValidBits !== bitsPerSample) {
          fail("CUT_WAVE_NORMALIZE_FORMAT", "extensible validBitsPerSample must exactly equal its 16, 24, or 32 container bits.");
        }
        validBitsPerSample = rawValidBits as 16 | 24 | 32;
        channelMask = bytes.readUInt32LE(body + 20);
        if (bytes.subarray(body + 24, body + 40).toString("hex") !== policy.pcmSubformatGuidRiffBytes) {
          fail("CUT_WAVE_NORMALIZE_FORMAT", "extensible subformat must be the exact integer-PCM GUID in RIFF byte order.");
        }
        if (channelMask !== 0) {
          if ((channelMask & ~policy.standardSpeakerMask) !== 0) {
            fail("CUT_WAVE_NORMALIZE_FORMAT", "extensible channelMask contains a non-standard or reserved speaker bit.");
          }
          let remaining = channelMask >>> 0, speakerCount = 0;
          while (remaining !== 0) { remaining = (remaining & (remaining - 1)) >>> 0; speakerCount += 1; }
          if (speakerCount !== channels) {
            fail("CUT_WAVE_NORMALIZE_FORMAT", "nonzero extensible channelMask popcount must exactly equal channels.");
          }
        }
        formatVariant = "extensible-pcm";
      }
      const expectedBlockAlign = channels * bitsPerSample / 8;
      if (blockAlign !== expectedBlockAlign || byteRate !== sampleRate * blockAlign) {
        fail("CUT_WAVE_NORMALIZE_FORMAT", "fmt block alignment and byte rate must exactly match the declared PCM layout.");
      }
      format = Object.freeze({
        formatVariant,
        sampleRate,
        channels,
        bitsPerSample,
        validBitsPerSample,
        channelMask,
        blockAlign,
        byteRate,
      });
    } else {
      if (!format) fail("CUT_WAVE_NORMALIZE_RIFF", "data cannot precede fmt.");
      if (size < format.blockAlign || size % format.blockAlign !== 0) {
        fail("CUT_WAVE_NORMALIZE_FORMAT", "data must contain at least one complete interleaved PCM frame.");
      }
      data = bytes.subarray(body, end);
      dataPadBytes = (size & 1) as 0 | 1;
    }
    cursor = paddedEnd;
  }
  if (!format || !data || cursor !== bytes.byteLength) {
    fail("CUT_WAVE_NORMALIZE_RIFF", "input must end after exactly one fmt chunk and one data chunk.");
  }
  const frames = data.byteLength / format.blockAlign;
  if (maximumFrames !== undefined && frames > maximumFrames) {
    fail("CUT_WAVE_NORMALIZE_LIMIT", `input exceeds ${maximumFrames} PCM frames.`);
  }
  return Object.freeze({ ...format, frames, data, dataPadBytes });
}

function pcmIntegerValue(bytes: Buffer, offset: number, bits: 16 | 24 | 32) {
  if (bits === 16) return bytes.readInt16LE(offset) / 32_768;
  if (bits === 24) {
    let value = bytes[offset]! | bytes[offset + 1]! << 8 | bytes[offset + 2]! << 16;
    if ((value & 0x80_0000) !== 0) value -= 0x100_0000;
    return value / 8_388_608;
  }
  return bytes.readInt32LE(offset) / 2_147_483_648;
}

function downmix(wave: ParsedWave) {
  const mono = new Float64Array(wave.frames);
  const bytesPerSample = wave.bitsPerSample / 8;
  for (let frame = 0; frame < wave.frames; frame += 1) {
    let sum = 0;
    const frameOffset = frame * wave.blockAlign;
    for (let channel = 0; channel < wave.channels; channel += 1) {
      sum += pcmIntegerValue(wave.data, frameOffset + channel * bytesPerSample, wave.bitsPerSample);
    }
    const value = sum / wave.channels;
    if (!Number.isFinite(value)) fail("CUT_WAVE_NORMALIZE_FORMAT", "decoded PCM produced one non-finite sample.");
    mono[frame] = value;
  }
  return mono;
}

function nativeRateFloat32(mono: Float64Array) {
  const pcm = new Float32Array(mono.length);
  for (let index = 0; index < mono.length; index += 1) {
    let value = Math.fround(mono[index]!);
    if (!Number.isFinite(value)) fail("CUT_WAVE_NORMALIZE_FORMAT", "native-rate downmix produced one non-finite sample.");
    if (value === 0) value = 0;
    pcm[index] = value;
  }
  return pcm;
}

function sinc(value: number) {
  return value === 0 ? 1 : Math.sin(Math.PI * value) / (Math.PI * value);
}

function coefficient(distance: number, sourceRate: number) {
  const radius = cutWaveNormalizePolicy.resampler.radiusSamples;
  const cutoff = 0.5 * Math.min(1, cutWaveNormalizePolicy.output.sampleRate / sourceRate)
    * cutWaveNormalizePolicy.resampler.nyquistGuardNumerator
    / cutWaveNormalizePolicy.resampler.nyquistGuardDenominator;
  const window = 0.42 + 0.5 * Math.cos(Math.PI * distance / radius)
    + 0.08 * Math.cos(2 * Math.PI * distance / radius);
  return 2 * cutoff * sinc(2 * cutoff * distance) * window;
}

type ResampleWork = Readonly<{
  candidateTapEvaluations: number;
  coefficientEvaluations: number;
  contributingCoefficients: number;
  boundaryExtendedTaps: number;
  multiplyAccumulateOperations: number;
  saturatedOutputSamples: number;
}>;

function resample(mono: Float64Array, sourceRate: number): Readonly<{ samples: Float64Array; work: ResampleWork }> {
  if (sourceRate === cutWaveNormalizePolicy.output.sampleRate) {
    return Object.freeze({
      samples: mono,
      work: Object.freeze({
        candidateTapEvaluations: 0,
        coefficientEvaluations: 0,
        contributingCoefficients: 0,
        boundaryExtendedTaps: 0,
        multiplyAccumulateOperations: 0,
        saturatedOutputSamples: 0,
      }),
    });
  }
  const targetRate = cutWaveNormalizePolicy.output.sampleRate;
  const outputCount = Math.floor((mono.length * targetRate + sourceRate - 1) / sourceRate);
  const output = new Float64Array(outputCount);
  let contributingCoefficients = 0;
  let boundaryExtendedTaps = 0;
  let saturatedOutputSamples = 0;
  for (let outputIndex = 0; outputIndex < outputCount; outputIndex += 1) {
    const positionNumerator = outputIndex * sourceRate;
    const base = Math.floor(positionNumerator / targetRate);
    const fraction = (positionNumerator % targetRate) / targetRate;
    let weighted = 0;
    let weightSum = 0;
    for (let tap = 0; tap < cutWaveNormalizePolicy.resampler.taps; tap += 1) {
      const candidateIndex = base + tap - 15;
      const sourceIndex = Math.max(0, Math.min(mono.length - 1, candidateIndex));
      if (sourceIndex !== candidateIndex) boundaryExtendedTaps += 1;
      const weight = coefficient(tap - 15 - fraction, sourceRate);
      weighted += mono[sourceIndex]! * weight;
      weightSum += weight;
      contributingCoefficients += 1;
    }
    if (!Number.isFinite(weighted) || !Number.isFinite(weightSum) || Math.abs(weightSum) < 1e-12) {
      fail("CUT_WAVE_NORMALIZE_RESAMPLER", "bounded sinc coefficient normalization became non-finite or degenerate.");
    }
    const resampled = weighted / weightSum;
    if (resampled > 1) { output[outputIndex] = 1; saturatedOutputSamples += 1; }
    else if (resampled < -1) { output[outputIndex] = -1; saturatedOutputSamples += 1; }
    else output[outputIndex] = resampled;
  }
  const candidateTapEvaluations = outputCount * cutWaveNormalizePolicy.resampler.taps;
  return Object.freeze({
    samples: output,
    work: Object.freeze({
      candidateTapEvaluations,
      coefficientEvaluations: candidateTapEvaluations,
      contributingCoefficients,
      boundaryExtendedTaps,
      multiplyAccumulateOperations: contributingCoefficients,
      saturatedOutputSamples,
    }),
  });
}

function encodeFloat32Le(samples: Float64Array) {
  const bytes = Buffer.alloc(samples.length * 4);
  for (let index = 0; index < samples.length; index += 1) {
    let value = Math.fround(samples[index]!);
    if (!Number.isFinite(value)) fail("CUT_WAVE_NORMALIZE_RESAMPLER", "resampling produced one non-finite output sample.");
    if (value === 0) value = 0;
    bytes.writeFloatLE(value, index * 4);
  }
  return bytes;
}

/**
 * Normalize one authenticated in-memory RIFF/WAVE containing either exact
 * classic integer PCM or the strict WAVE_FORMAT_EXTENSIBLE integer-PCM subset
 * declared by cutWaveNormalizePolicy.
 */
export function normalizeCutWaveForYamnet(value: Uint8Array, authority: CutWaveMemoryAuthority): CutWaveNormalizationResult {
  const sourceBytes = snapshotAuthenticatedBytes(value, authority);
  const wave = parseClassicWave(sourceBytes);
  if (wave.frames > wave.sampleRate * cutWaveNormalizePolicy.input.maximumDurationSeconds) {
    fail("CUT_WAVE_NORMALIZE_LIMIT", `input duration exceeds ${cutWaveNormalizePolicy.input.maximumDurationSeconds} seconds.`);
  }
  const mono = downmix(wave);
  const normalized = resample(mono, wave.sampleRate);
  const pcmBytes = encodeFloat32Le(normalized.samples);
  const source = Object.freeze({ bytes: sourceBytes.byteLength, sha256: sha256(sourceBytes) });
  const evidenceBody = Object.freeze({
    format: "cut-wave-normalization-evidence" as const,
    version: 1 as const,
    source,
    wave: Object.freeze({
      container: "RIFF/WAVE" as const,
      audioFormat: 1 as const,
      formatVariant: wave.formatVariant,
      sampleRate: wave.sampleRate,
      channels: wave.channels,
      bitsPerSample: wave.bitsPerSample,
      validBitsPerSample: wave.validBitsPerSample,
      channelMask: wave.channelMask,
      blockAlign: wave.blockAlign,
      byteRate: wave.byteRate,
      frames: wave.frames,
      dataBytes: wave.data.byteLength,
      dataPadBytes: wave.dataPadBytes,
      duration: Object.freeze({ numeratorSamples: wave.frames, denominatorSampleRate: wave.sampleRate }),
    }),
    policy: Object.freeze({
      policySha256: cutWaveNormalizePolicy.policySha256,
      downmix: cutWaveNormalizePolicy.downmix,
      resampler: wave.sampleRate === cutWaveNormalizePolicy.output.sampleRate
        ? "target-rate-identity-v1" as const
        : cutWaveNormalizePolicy.resampler.kernel,
    }),
    output: Object.freeze({
      sampleFormat: "f32le" as const,
      sampleRate: 16_000 as const,
      channels: 1 as const,
      samples: normalized.samples.length,
      bytes: pcmBytes.byteLength,
      sha256: sha256(pcmBytes),
    }),
    work: Object.freeze({
      inputFrames: wave.frames,
      channelSampleReads: wave.frames * wave.channels,
      downmixAdditions: wave.frames * wave.channels,
      outputSamples: normalized.samples.length,
      ...normalized.work,
      float32Writes: normalized.samples.length,
    }),
  });
  const evidenceSha256 = sha256(stableJsonStringify(evidenceBody));
  const evidence = Object.freeze({ ...evidenceBody, evidenceSha256 });
  return Object.freeze({
    pcmBytes,
    evidence,
    evidenceBytes: Buffer.from(`${stableJsonStringify(evidence)}\n`, "utf8"),
  });
}

/**
 * Authenticate, decode, and equally downmix strict integer-PCM WAVE bytes
 * without resampling. The caller must provide a closed work ceiling; the
 * dialogue CLI uses cutDialogueProsodyWaveDecodeLimits.
 */
export function decodeCutWaveIntegerPcmNativeRate(
  value: Uint8Array,
  authority: CutWaveMemoryAuthority,
  limits: CutWaveNativeRateDecodeLimits,
): CutWaveNativeRateDecodeResult {
  const maximumWaveBytes = boundedPositiveInteger(
    limits?.maximumWaveBytes,
    cutDialogueProsodyWaveDecodeLimits.maximumWaveBytes,
    "maximumWaveBytes",
  );
  const maximumFrames = boundedPositiveInteger(
    limits?.maximumFrames,
    cutDialogueProsodyWaveDecodeLimits.maximumFrames,
    "maximumFrames",
  );
  const maximumChannelSampleReads = boundedPositiveInteger(
    limits?.maximumChannelSampleReads,
    cutDialogueProsodyWaveDecodeLimits.maximumChannelSampleReads,
    "maximumChannelSampleReads",
  );
  const sourceBytes = snapshotAuthenticatedBytes(value, authority, maximumWaveBytes);
  const wave = parseClassicWave(sourceBytes, maximumFrames);
  const channelSampleReads = wave.frames * wave.channels;
  if (!Number.isSafeInteger(channelSampleReads) || channelSampleReads > maximumChannelSampleReads) {
    fail("CUT_WAVE_NORMALIZE_LIMIT", `native-rate downmix exceeds ${maximumChannelSampleReads} channel-sample reads.`);
  }
  const pcm = nativeRateFloat32(downmix(wave));
  return Object.freeze({
    pcm,
    source: Object.freeze({ bytes: sourceBytes.byteLength, sha256: sha256(sourceBytes) }),
    wave: Object.freeze({
      container: "RIFF/WAVE" as const,
      formatVariant: wave.formatVariant,
      sampleRate: wave.sampleRate,
      sourceChannels: wave.channels,
      outputChannels: 1 as const,
      bitsPerSample: wave.bitsPerSample,
      validBitsPerSample: wave.validBitsPerSample,
      channelMask: wave.channelMask,
      durationSamples: wave.frames,
    }),
    work: Object.freeze({
      channelSampleReads,
      downmixAdditions: channelSampleReads,
      float32Writes: pcm.length,
    }),
  });
}
