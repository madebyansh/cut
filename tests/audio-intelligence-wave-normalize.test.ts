import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { stableJsonStringify } from "../lib/core/stable";
import {
  CutWaveNormalizeError,
  cutDialogueProsodyWaveDecodeLimits,
  cutWaveNormalizePolicy,
  decodeCutWaveIntegerPcmNativeRate,
  normalizeCutWaveForYamnet,
} from "../lib/audio-intelligence/wave-normalize";

type WaveOptions = Readonly<{
  sampleRate: number;
  channels: number;
  bits: 16 | 24 | 32;
  frames: readonly (readonly number[])[];
}>;

const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const PCM_SUBFORMAT_GUID_RIFF_BYTES = Buffer.from("0100000000001000800000aa00389b71", "hex");

function writePcm(bytes: Buffer, offset: number, bits: 16 | 24 | 32, sample: number) {
  const scale = bits === 16 ? 32_768 : bits === 24 ? 8_388_608 : 2_147_483_648;
  const maximum = scale - 1;
  const integer = Math.max(-scale, Math.min(maximum, Math.round(sample * scale)));
  if (bits === 16) bytes.writeInt16LE(integer, offset);
  else if (bits === 24) bytes.writeIntLE(integer, offset, 3);
  else bytes.writeInt32LE(integer, offset);
}

function wave(options: WaveOptions) {
  const bytesPerSample = options.bits / 8;
  const blockAlign = options.channels * bytesPerSample;
  const dataBytes = options.frames.length * blockAlign;
  const result = Buffer.alloc(44 + dataBytes + (dataBytes & 1));
  result.write("RIFF", 0, "ascii");
  result.writeUInt32LE(result.length - 8, 4);
  result.write("WAVEfmt ", 8, "ascii");
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(options.channels, 22);
  result.writeUInt32LE(options.sampleRate, 24);
  result.writeUInt32LE(options.sampleRate * blockAlign, 28);
  result.writeUInt16LE(blockAlign, 32);
  result.writeUInt16LE(options.bits, 34);
  result.write("data", 36, "ascii");
  result.writeUInt32LE(dataBytes, 40);
  for (let frame = 0; frame < options.frames.length; frame += 1) {
    assert.equal(options.frames[frame]!.length, options.channels);
    for (let channel = 0; channel < options.channels; channel += 1) {
      writePcm(result, 44 + frame * blockAlign + channel * bytesPerSample, options.bits, options.frames[frame]![channel]!);
    }
  }
  return result;
}

function extensibleWave(options: WaveOptions, channelMask = options.channels === 2 ? 3 : 0) {
  const bytesPerSample = options.bits / 8;
  const blockAlign = options.channels * bytesPerSample;
  const dataBytes = options.frames.length * blockAlign;
  const result = Buffer.alloc(68 + dataBytes + (dataBytes & 1));
  result.write("RIFF", 0, "ascii");
  result.writeUInt32LE(result.length - 8, 4);
  result.write("WAVEfmt ", 8, "ascii");
  result.writeUInt32LE(40, 16);
  result.writeUInt16LE(0xfffe, 20);
  result.writeUInt16LE(options.channels, 22);
  result.writeUInt32LE(options.sampleRate, 24);
  result.writeUInt32LE(options.sampleRate * blockAlign, 28);
  result.writeUInt16LE(blockAlign, 32);
  result.writeUInt16LE(options.bits, 34);
  result.writeUInt16LE(22, 36);
  result.writeUInt16LE(options.bits, 38);
  result.writeUInt32LE(channelMask, 40);
  PCM_SUBFORMAT_GUID_RIFF_BYTES.copy(result, 44);
  result.write("data", 60, "ascii");
  result.writeUInt32LE(dataBytes, 64);
  for (let frame = 0; frame < options.frames.length; frame += 1) {
    assert.equal(options.frames[frame]!.length, options.channels);
    for (let channel = 0; channel < options.channels; channel += 1) {
      writePcm(result, 68 + frame * blockAlign + channel * bytesPerSample, options.bits, options.frames[frame]![channel]!);
    }
  }
  return result;
}

function normalize(bytes: Buffer) {
  return normalizeCutWaveForYamnet(bytes, { bytes: bytes.byteLength, sha256: hash(bytes) });
}

function decodeNative(bytes: Buffer, limits = cutDialogueProsodyWaveDecodeLimits) {
  return decodeCutWaveIntegerPcmNativeRate(bytes, { bytes: bytes.byteLength, sha256: hash(bytes) }, limits);
}

function samples(bytes: Buffer) {
  const result: number[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 4) result.push(bytes.readFloatLE(offset));
  return result;
}

function expectError(action: () => unknown, code: string) {
  assert.throws(action, (error: unknown) => error instanceof CutWaveNormalizeError && error.code === code);
}

test("normalization policy binds the closed classic/extensible PCM and 32-tap sinc laws", () => {
  const { policySha256: _ignored, ...body } = cutWaveNormalizePolicy;
  assert.equal(cutWaveNormalizePolicy.policySha256, hash(stableJsonStringify(body)));
  assert.equal(cutWaveNormalizePolicy.policySha256, "e4b16bcc7255640330694aacd207a2a2cd644a1b4bb220a6f66970f76b78063d");
  assert.equal(cutWaveNormalizePolicy.resampler.taps, 32);
  assert.equal(cutWaveNormalizePolicy.resampler.kernel, "32-tap-blackman-windowed-sinc-lowpass-v1");
  assert.equal(cutWaveNormalizePolicy.output.sampleRate, 16_000);
  assert.deepEqual(cutWaveNormalizePolicy.input.acceptedChunksInOrder, ["fmt ", "data"]);
  assert.deepEqual(cutWaveNormalizePolicy.input.formatVariants, {
    classicPcm: { id: "classic-pcm", formatTag: 1, fmtChunkBytes: 16 },
    extensiblePcm: {
      id: "extensible-pcm", formatTag: 0xfffe, fmtChunkBytes: 40, cbSize: 22,
      pcmSubformatGuidRiffBytes: PCM_SUBFORMAT_GUID_RIFF_BYTES.toString("hex"),
      validBits: "must-equal-container-bits-v1", standardSpeakerMask: 0x0003_ffff,
      channelMask: "zero-or-standard-speaker-bits-with-popcount-equal-to-channels-v1",
    },
  });
  assert.ok(Object.isFrozen(cutWaveNormalizePolicy) && Object.isFrozen(cutWaveNormalizePolicy.resampler));
});

test("16/24/32-bit target-rate PCM decodes, equally downmixes, and emits exact identities and work", () => {
  for (const bits of [16, 24, 32] as const) {
    const source = wave({ sampleRate: 16_000, channels: 2, bits, frames: [[0.75, -0.25], [-1, 1 - 1 / (2 ** (bits - 1))], [0.5, 0.5]] });
    const result = normalize(source);
    const output = samples(result.pcmBytes);
    assert.ok(Math.abs(output[0]! - 0.25) <= 1 / (2 ** (bits - 1)));
    assert.ok(Math.abs(output[1]!) <= 1 / (2 ** (bits - 1)));
    assert.ok(Math.abs(output[2]! - 0.5) <= 1 / (2 ** (bits - 1)));
    assert.deepEqual(result.evidence.source, { bytes: source.byteLength, sha256: hash(source) });
    assert.equal(result.evidence.wave.audioFormat, 1);
    assert.equal(result.evidence.wave.formatVariant, "classic-pcm");
    assert.equal(result.evidence.wave.validBitsPerSample, bits);
    assert.equal(result.evidence.wave.channelMask, 0);
    assert.deepEqual(result.evidence.wave.duration, { numeratorSamples: 3, denominatorSampleRate: 16_000 });
    assert.equal(result.evidence.policy.resampler, "target-rate-identity-v1");
    assert.equal(result.evidence.output.sha256, hash(result.pcmBytes));
    assert.deepEqual(result.evidence.work, {
      inputFrames: 3, channelSampleReads: 6, downmixAdditions: 6, outputSamples: 3,
      candidateTapEvaluations: 0, coefficientEvaluations: 0, contributingCoefficients: 0,
      boundaryExtendedTaps: 0, multiplyAccumulateOperations: 0, saturatedOutputSamples: 0,
      float32Writes: 3,
    });
    const { evidenceSha256: _evidence, ...body } = result.evidence;
    assert.equal(result.evidence.evidenceSha256, hash(stableJsonStringify(body)));
    assert.equal(result.evidenceBytes.toString("utf8"), `${stableJsonStringify(result.evidence)}\n`);
  }
});

test("real-style extensible stereo 24/48k and 32/44.1k normalize exactly like classic PCM", () => {
  for (const fixture of [
    { sampleRate: 48_000, bits: 24 as const },
    { sampleRate: 44_100, bits: 32 as const },
  ]) {
    const options = {
      ...fixture,
      channels: 2,
      frames: Array.from({ length: 257 }, (_, index) => [
        0.7 * Math.sin(index / 11),
        0.35 * Math.cos(index / 17),
      ]),
    };
    const classic = normalize(wave(options));
    const extensible = normalize(extensibleWave(options, 3));
    assert.deepEqual(extensible.pcmBytes, classic.pcmBytes);
    assert.equal(extensible.evidence.output.sha256, classic.evidence.output.sha256);
    assert.deepEqual(extensible.evidence.work, classic.evidence.work);
    assert.equal(extensible.evidence.wave.audioFormat, 1);
    assert.equal(extensible.evidence.wave.formatVariant, "extensible-pcm");
    assert.equal(extensible.evidence.wave.bitsPerSample, fixture.bits);
    assert.equal(extensible.evidence.wave.validBitsPerSample, fixture.bits);
    assert.equal(extensible.evidence.wave.channelMask, 3);
    if (fixture.sampleRate === 48_000 && fixture.bits === 24) {
      assert.equal(hash(classic.pcmBytes), "eef654739884d229fa0b363c9cbb2e23bc868d55aee8af72ed25a192bcdb9f06");
      assert.equal(hash(classic.evidenceBytes), "976ac10223d4333f73f61dbc3cca7cce7e4d81903b99484dff1d174e73a63c03");
    }
    const { evidenceSha256: _evidence, ...body } = extensible.evidence;
    assert.equal(extensible.evidence.evidenceSha256, hash(stableJsonStringify(body)));
  }

  const maskOmitted = normalize(extensibleWave({
    sampleRate: 48_000, channels: 2, bits: 24, frames: [[0.25, -0.25], [0.5, 0.25]],
  }, 0));
  assert.equal(maskOmitted.evidence.wave.channelMask, 0);
  assert.equal(maskOmitted.evidence.wave.formatVariant, "extensible-pcm");
});

test("native-rate decode preserves the transcript sample clock and equally downmixes classic and extensible PCM", () => {
  const options = {
    sampleRate: 48_000,
    channels: 2,
    bits: 24 as const,
    frames: Array.from({ length: 481 }, (_, index) => [
      0.75 * Math.sin(index / 13),
      0.25 * Math.cos(index / 19),
    ]),
  };
  const classicBytes = wave(options), extensibleBytes = extensibleWave(options, 3);
  const classic = decodeNative(classicBytes), extensible = decodeNative(extensibleBytes);
  assert.deepEqual(classic.pcm, extensible.pcm);
  assert.deepEqual(classic.wave, {
    container: "RIFF/WAVE",
    formatVariant: "classic-pcm",
    sampleRate: 48_000,
    sourceChannels: 2,
    outputChannels: 1,
    bitsPerSample: 24,
    validBitsPerSample: 24,
    channelMask: 0,
    durationSamples: 481,
  });
  assert.deepEqual(extensible.wave, { ...classic.wave, formatVariant: "extensible-pcm", channelMask: 3 });
  assert.deepEqual(classic.work, { channelSampleReads: 962, downmixAdditions: 962, float32Writes: 481 });
  assert.deepEqual(classic.source, { bytes: classicBytes.byteLength, sha256: hash(classicBytes) });
  const retained = new Float32Array(classic.pcm);
  classicBytes.fill(0);
  assert.deepEqual(classic.pcm, retained);
});

test("native-rate decode has explicit byte, frame, and channel-read ceilings independent of the ten-second YAMNet window", () => {
  const elevenSeconds = wave({
    sampleRate: 8_000,
    channels: 1,
    bits: 16,
    frames: Array.from({ length: 80_001 }, () => [0.125]),
  });
  expectError(() => normalize(elevenSeconds), "CUT_WAVE_NORMALIZE_LIMIT");
  const decoded = decodeNative(elevenSeconds);
  assert.equal(decoded.pcm.length, 80_001);
  assert.equal(decoded.wave.sampleRate, 8_000);

  expectError(() => decodeNative(elevenSeconds, { maximumWaveBytes: elevenSeconds.length - 1, maximumFrames: 100_000, maximumChannelSampleReads: 100_000 }), "CUT_WAVE_NORMALIZE_LIMIT");
  expectError(() => decodeNative(elevenSeconds, { maximumWaveBytes: elevenSeconds.length, maximumFrames: 80_000, maximumChannelSampleReads: 100_000 }), "CUT_WAVE_NORMALIZE_LIMIT");
  expectError(() => decodeNative(elevenSeconds, { maximumWaveBytes: elevenSeconds.length, maximumFrames: 100_000, maximumChannelSampleReads: 80_000 }), "CUT_WAVE_NORMALIZE_LIMIT");
  expectError(() => decodeNative(elevenSeconds, { maximumWaveBytes: 0, maximumFrames: 100_000, maximumChannelSampleReads: 100_000 }), "CUT_WAVE_NORMALIZE_LIMIT");
});

test("extensible PCM fails closed on format, GUID, valid-bit, channel-mask, size, and truncation drift", () => {
  const source = extensibleWave({
    sampleRate: 48_000, channels: 2, bits: 24, frames: [[0.25, -0.25], [0.5, 0.125]],
  }, 3);
  const formatMutations: Array<Readonly<{ offset: number; value: number; bytes: 2 | 4 }>> = [
    { offset: 36, value: 21, bytes: 2 },
    { offset: 36, value: 23, bytes: 2 },
    { offset: 38, value: 20, bytes: 2 },
    { offset: 40, value: 1, bytes: 4 },
    { offset: 40, value: 7, bytes: 4 },
    { offset: 40, value: 0x0004_0003, bytes: 4 },
    { offset: 40, value: 0x8000_0003, bytes: 4 },
  ];
  for (const mutation of formatMutations) {
    const invalid = Buffer.from(source);
    if (mutation.bytes === 2) invalid.writeUInt16LE(mutation.value, mutation.offset);
    else invalid.writeUInt32LE(mutation.value, mutation.offset);
    expectError(() => normalize(invalid), "CUT_WAVE_NORMALIZE_FORMAT");
  }

  for (const subformatTag of [2, 3]) {
    const invalid = Buffer.from(source);
    invalid.writeUInt32LE(subformatTag, 44);
    expectError(() => normalize(invalid), "CUT_WAVE_NORMALIZE_FORMAT");
  }
  for (const fmtSize of [38, 42]) {
    const invalid = Buffer.from(source);
    invalid.writeUInt32LE(fmtSize, 16);
    expectError(() => normalize(invalid), "CUT_WAVE_NORMALIZE_FORMAT");
  }
  const classicTagWithExtensibleSize = Buffer.from(source);
  classicTagWithExtensibleSize.writeUInt16LE(1, 20);
  expectError(() => normalize(classicTagWithExtensibleSize), "CUT_WAVE_NORMALIZE_FORMAT");

  const classicWithExtensibleTag = wave({ sampleRate: 48_000, channels: 2, bits: 24, frames: [[0, 0]] });
  classicWithExtensibleTag.writeUInt16LE(0xfffe, 20);
  expectError(() => normalize(classicWithExtensibleTag), "CUT_WAVE_NORMALIZE_FORMAT");

  const truncatedFmt = Buffer.from(source.subarray(0, 59));
  truncatedFmt.writeUInt32LE(truncatedFmt.length - 8, 4);
  expectError(() => normalize(truncatedFmt), "CUT_WAVE_NORMALIZE_RIFF");
});

test("the admitted eight-channel boundary uses one equal-weight arithmetic mean", () => {
  const source = wave({ sampleRate: 16_000, channels: 8, bits: 32, frames: [[1, 0.75, 0.5, 0.25, 0, -0.25, -0.5, -0.75]] });
  const result = normalize(source);
  assert.ok(Math.abs(result.pcmBytes.readFloatLE(0) - 0.125) < 1e-9);
  assert.equal(result.evidence.wave.channels, 8);
  assert.equal(result.evidence.work.channelSampleReads, 8);
  assert.equal(result.evidence.work.downmixAdditions, 8);
});

test("one odd 24-bit data chunk admits exactly one zero pad byte", () => {
  const source = wave({ sampleRate: 16_000, channels: 1, bits: 24, frames: [[0.25]] });
  const result = normalize(source);
  assert.equal(result.evidence.wave.dataBytes, 3);
  assert.equal(result.evidence.wave.dataPadBytes, 1);
  assert.equal(result.pcmBytes.readFloatLE(0), 0.25);
  const bad = Buffer.from(source);
  bad[bad.length - 1] = 1;
  expectError(() => normalize(bad), "CUT_WAVE_NORMALIZE_RIFF");
});

test("rational output count and 32-tap work are exact for mismatched sample rates", () => {
  const source = wave({ sampleRate: 44_100, channels: 1, bits: 16, frames: Array.from({ length: 4_411 }, () => [0.125]) });
  const result = normalize(source);
  assert.equal(result.evidence.output.samples, Math.ceil(4_411 * 16_000 / 44_100));
  assert.equal(result.evidence.work.candidateTapEvaluations, result.evidence.output.samples * 32);
  assert.equal(result.evidence.work.coefficientEvaluations, result.evidence.work.candidateTapEvaluations);
  assert.equal(result.evidence.work.contributingCoefficients, result.evidence.work.candidateTapEvaluations);
  assert.ok(result.evidence.work.boundaryExtendedTaps > 0);
  assert.equal(result.evidence.work.multiplyAccumulateOperations, result.evidence.work.contributingCoefficients);
  assert.equal(result.pcmBytes.byteLength, result.evidence.output.samples * 4);
});

test("short near-target and upsampled alternating boundaries remain finite and unit-bounded", () => {
  for (const input of [
    wave({ sampleRate: 15_999, channels: 1, bits: 32, frames: [[1], [-1]] }),
    wave({ sampleRate: 8_000, channels: 1, bits: 32, frames: Array.from({ length: 32 }, (_, index) => [index % 2 === 0 ? 1 : -1]) }),
  ]) {
    const first = normalize(input), second = normalize(input);
    const output = samples(first.pcmBytes);
    assert.ok(output.every((sample) => Number.isFinite(sample) && sample >= -1 && sample <= 1));
    assert.ok(first.evidence.work.boundaryExtendedTaps > 0);
    assert.ok(first.evidence.work.saturatedOutputSamples > 0);
    assert.deepEqual(first.pcmBytes, second.pcmBytes);
    assert.deepEqual(first.evidenceBytes, second.evidenceBytes);
  }
});

test("the declared zero-based rational clock keeps an interior impulse on its exact phase", () => {
  const frames: number[][] = Array.from({ length: 192 }, () => [0]);
  frames[60] = [1];
  const result = normalize(wave({ sampleRate: 48_000, channels: 1, bits: 32, frames }));
  const output = samples(result.pcmBytes);
  const peakIndex = output.reduce((best, value, index) => Math.abs(value) > Math.abs(output[best]!) ? index : best, 0);
  assert.equal(peakIndex, 20);
  assert.ok(output[peakIndex]! > 0.25);
});

test("DC gain is preserved at boundaries and an aliased out-of-band tone is strongly rejected", () => {
  const frameCount = 48_000;
  const dc = normalize(wave({ sampleRate: 48_000, channels: 1, bits: 32, frames: Array.from({ length: frameCount }, () => [0.25]) }));
  for (const value of samples(dc.pcmBytes)) assert.ok(Math.abs(value - 0.25) < 1e-7);

  const tone = (frequency: number) => normalize(wave({
    sampleRate: 48_000,
    channels: 1,
    bits: 32,
    frames: Array.from({ length: frameCount }, (_, index) => [0.8 * Math.sin(2 * Math.PI * frequency * index / 48_000)]),
  }));
  const rms = (values: readonly number[]) => Math.sqrt(values.slice(64, -64).reduce((sum, value) => sum + value * value, 0) / (values.length - 128));
  const passband = rms(samples(tone(1_000).pcmBytes));
  const stopband = rms(samples(tone(12_000).pcmBytes));
  assert.ok(passband > 0.54 && passband < 0.59, `unexpected passband RMS ${passband}`);
  assert.ok(stopband < passband * 0.01, `stopband RMS ${stopband} is not at least 40 dB below passband ${passband}`);
});

test("normalization is byte-repeatable and source/output storage never aliases", () => {
  const source = wave({ sampleRate: 48_000, channels: 2, bits: 24, frames: Array.from({ length: 1_000 }, (_, index) => [Math.sin(index / 13) * 0.7, Math.cos(index / 17) * 0.2]) });
  const immutableSource = Buffer.from(source);
  const first = normalize(source);
  const expectedPcm = Buffer.from(first.pcmBytes);
  const expectedEvidence = Buffer.from(first.evidenceBytes);
  source.fill(0);
  assert.deepEqual(first.pcmBytes, expectedPcm);
  const second = normalize(immutableSource);
  assert.deepEqual(second.pcmBytes, expectedPcm);
  assert.deepEqual(second.evidenceBytes, expectedEvidence);
  second.pcmBytes.fill(0);
  second.evidenceBytes.fill(0);
  assert.notDeepEqual(second.pcmBytes, expectedPcm);
  assert.deepEqual(immutableSource, wave({ sampleRate: 48_000, channels: 2, bits: 24, frames: Array.from({ length: 1_000 }, (_, index) => [Math.sin(index / 13) * 0.7, Math.cos(index / 17) * 0.2]) }));
  const third = normalize(immutableSource);
  assert.deepEqual(third.pcmBytes, expectedPcm);
  assert.deepEqual(third.evidenceBytes, expectedEvidence);
  assert.equal(third.evidence.output.sha256, hash(expectedPcm));
});

test("authority and shared-memory ambiguity fail before parsing", () => {
  const source = wave({ sampleRate: 16_000, channels: 1, bits: 16, frames: [[0]] });
  expectError(() => normalizeCutWaveForYamnet(source, { bytes: source.length + 1, sha256: hash(source) }), "CUT_WAVE_NORMALIZE_AUTHORITY");
  expectError(() => normalizeCutWaveForYamnet(source, { bytes: source.length, sha256: "A".repeat(64) }), "CUT_WAVE_NORMALIZE_AUTHORITY");
  expectError(() => normalizeCutWaveForYamnet(source, { bytes: Number.NaN, sha256: hash(source) }), "CUT_WAVE_NORMALIZE_AUTHORITY");
  if (typeof SharedArrayBuffer !== "undefined") {
    const shared = new Uint8Array(new SharedArrayBuffer(source.length));
    shared.set(source);
    expectError(() => normalizeCutWaveForYamnet(shared, { bytes: shared.length, sha256: hash(source) }), "CUT_WAVE_NORMALIZE_INPUT");
  }
});

test("unknown, duplicate, reordered, truncated, trailing, and malformed RIFF structures fail closed", () => {
  const source = wave({ sampleRate: 16_000, channels: 1, bits: 16, frames: [[0], [0.25]] });
  const cases: Buffer[] = [];
  const unknown = Buffer.from(source); unknown.write("JUNK", 12, "ascii"); cases.push(unknown);
  const duplicate = Buffer.concat([source.subarray(0, 36), source.subarray(12, 36), source.subarray(36)]); duplicate.writeUInt32LE(duplicate.length - 8, 4); cases.push(duplicate);
  const reordered = Buffer.concat([source.subarray(0, 12), source.subarray(36), source.subarray(12, 36)]); reordered.writeUInt32LE(reordered.length - 8, 4); cases.push(reordered);
  cases.push(source.subarray(0, source.length - 1));
  const trailing = Buffer.concat([source, Buffer.from([0])]); trailing.writeUInt32LE(trailing.length - 8, 4); cases.push(trailing);
  const badRiffSize = Buffer.from(source); badRiffSize.writeUInt32LE(source.length - 9, 4); cases.push(badRiffSize);
  for (const malformed of cases) expectError(() => normalize(malformed), "CUT_WAVE_NORMALIZE_RIFF");
});

test("unsupported PCM layouts and incoherent rate/alignment metadata fail closed", () => {
  const source = wave({ sampleRate: 16_000, channels: 1, bits: 16, frames: [[0], [0.25]] });
  const mutations: Array<Readonly<{ offset: number; value: number; bytes: 2 | 4 }>> = [
    { offset: 20, value: 3, bytes: 2 },
    { offset: 22, value: 0, bytes: 2 },
    { offset: 22, value: 9, bytes: 2 },
    { offset: 24, value: 7_999, bytes: 4 },
    { offset: 24, value: 192_001, bytes: 4 },
    { offset: 28, value: 123, bytes: 4 },
    { offset: 32, value: 4, bytes: 2 },
    { offset: 34, value: 8, bytes: 2 },
  ];
  for (const mutation of mutations) {
    const invalid = Buffer.from(source);
    if (mutation.bytes === 2) invalid.writeUInt16LE(mutation.value, mutation.offset);
    else invalid.writeUInt32LE(mutation.value, mutation.offset);
    expectError(() => normalize(invalid), "CUT_WAVE_NORMALIZE_FORMAT");
  }
  const empty = wave({ sampleRate: 16_000, channels: 1, bits: 16, frames: [[0]] });
  empty.writeUInt32LE(0, 40); empty.writeUInt32LE(36, 4);
  expectError(() => normalize(empty.subarray(0, 44)), "CUT_WAVE_NORMALIZE_FORMAT");
});

test("the exact ten-second ceiling passes and one additional frame fails", () => {
  const allowed = wave({ sampleRate: 8_000, channels: 1, bits: 16, frames: Array.from({ length: 80_000 }, () => [0]) });
  assert.equal(normalize(allowed).evidence.output.samples, 160_000);
  const excessive = wave({ sampleRate: 8_000, channels: 1, bits: 16, frames: Array.from({ length: 80_001 }, () => [0]) });
  expectError(() => normalize(excessive), "CUT_WAVE_NORMALIZE_LIMIT");
});
