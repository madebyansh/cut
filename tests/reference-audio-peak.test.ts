import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cutDiagnosticsFromError } from "../lib/runtime/diagnostics";
import {
  ReferenceAudioPeakError,
  quantizeReferenceStereoF32LeFileToPcm24Wave,
  referenceAudioPeakLimits,
  referenceDbfsToLinear,
  scanReferenceStereoF32Le,
  scanReferenceStereoF32LeFile,
  type ReferenceAudioPeakScanOptions,
} from "../lib/runtime/reference/audio-peak";

const source = Object.freeze({ module: "peak-proof.cut", line: 7, column: 11, nodeId: "node.meter" });

function f32le(samples: readonly number[]) {
  const result = Buffer.alloc(samples.length * 4);
  samples.forEach((sample, index) => result.writeFloatLE(sample, index * 4));
  return result;
}

function splitBytes(bytes: Uint8Array, widths: readonly number[]) {
  const result: Uint8Array[] = [];
  let offset = 0, widthIndex = 0;
  while (offset < bytes.byteLength) {
    const width = widths[widthIndex % widths.length];
    assert.ok(Number.isSafeInteger(width) && width > 0);
    const end = Math.min(bytes.byteLength, offset + width);
    result.push(bytes.subarray(offset, end));
    offset = end;
    widthIndex += 1;
  }
  return result;
}

function nextPositiveF32(value: number, direction: "up" | "down") {
  const bits = Buffer.alloc(4);
  bits.writeFloatLE(value);
  const encoded = bits.readUInt32LE();
  bits.writeUInt32LE(direction === "up" ? encoded + 1 : encoded - 1);
  return bits.readFloatLE();
}

async function peakError(
  action: () => Promise<unknown>,
  code?: ReferenceAudioPeakError["code"],
) {
  try {
    await action();
    assert.fail("expected ReferenceAudioPeakError");
  } catch (error) {
    assert.ok(error instanceof ReferenceAudioPeakError);
    if (code) assert.equal(error.code, code);
    assert.ok(error.message.length < 512, `diagnostic amplified to ${error.message.length} characters`);
    assert.deepEqual(error.source, source);
    assert.ok(Object.isFrozen(error.source));
    assert.ok(Object.isFrozen(error.detail));
    return error;
  }
}

function options(expectedFrames: number, thresholdDbfs = 0): ReferenceAudioPeakScanOptions {
  return { expectedFrames, thresholdDbfs, source };
}

test("dBFS conversion, silence and the inclusive 0 dBFS boundary are exact", async () => {
  assert.equal(referenceDbfsToLinear(0), 1);
  assert.equal(referenceDbfsToLinear(-20), 0.1);
  assert.ok(Math.abs(referenceDbfsToLinear(-6) - 0.5011872336272722) < 1e-15);
  assert.throws(() => referenceDbfsToLinear(Number.NaN), RangeError);
  assert.throws(() => referenceDbfsToLinear(0.001), RangeError);

  const empty = await scanReferenceStereoF32Le([], options(0));
  assert.deepEqual(empty, {
    format: "cut-reference-audio-peak-scan",
    version: 1,
    sampleFormat: "f32le",
    channels: 2,
    expectedFrames: 0,
    observedFrames: 0,
    expectedBytes: 0,
    observedBytes: 0,
    thresholdDbfs: 0,
    thresholdLinear: 1,
    silent: true,
    peakLinear: 0,
    peakDbfs: null,
    peakFrame: null,
    peakChannel: null,
    peakChannelName: null,
    peakSample: null,
  });
  assert.ok(Object.isFrozen(empty));

  const below = nextPositiveF32(1, "down");
  const boundary = await scanReferenceStereoF32Le(
    splitBytes(f32le([1, -1, below, -below]), [1, 2, 7, 3]),
    options(2),
  );
  assert.equal(boundary.peakLinear, 1);
  assert.equal(boundary.peakDbfs, 0);
  assert.equal(boundary.peakFrame, 0);
  assert.equal(boundary.peakChannelName, "left", "equal-magnitude ties must retain the first sample");
  assert.equal(boundary.peakSample, 1);
});

test("the adjacent float32 above an inclusive ceiling is refused at its exact channel", async () => {
  const above = nextPositiveF32(1, "up");
  const error = await peakError(
    () => scanReferenceStereoF32Le(splitBytes(f32le([0.25, above]), [3, 1, 2]), options(1)),
    "CUT_AUDIO_CLIPPING",
  );
  assert.deepEqual(error.detail, {
    kind: "clipping",
    reason: "sample-peak-ceiling",
    expectedFrames: 1,
    expectedBytes: 8,
    observedBytes: 8,
    frame: 0,
    channel: 1,
    channelName: "right",
    sample: above,
    absoluteSample: above,
    sampleDbfs: 20 * Math.log10(above),
    thresholdDbfs: 0,
    thresholdLinear: 1,
  });
  assert.match(error.message, /frame 0, right channel/);
});

test("a non-zero dBFS threshold accepts its exact linear boundary and rejects the adjacent float", async () => {
  const halfDbfs = 20 * Math.log10(0.5);
  assert.equal(referenceDbfsToLinear(halfDbfs), 0.5);
  const below = nextPositiveF32(0.5, "down"), above = nextPositiveF32(0.5, "up");
  const accepted = await scanReferenceStereoF32Le([f32le([0.5, below])], options(1, halfDbfs));
  assert.equal(accepted.peakLinear, 0.5);
  const error = await peakError(
    () => scanReferenceStereoF32Le([f32le([above, 0])], options(1, halfDbfs)),
    "CUT_AUDIO_CLIPPING",
  );
  assert.equal(error.detail.frame, 0);
  assert.equal(error.detail.channel, 0);
  assert.equal(error.detail.sample, above);
});

test("chunk boundaries cannot change a passing scan or the first clipping diagnostic", async () => {
  const passingBytes = f32le([0.1, -0.2, 0.7, -0.4, -0, 0, 0.2, -0.7]);
  const whole = await scanReferenceStereoF32Le([passingBytes], options(4));
  for (const widths of [[1], [3, 5, 2, 7], [7, 1, 9]] as const) {
    const streamed = await scanReferenceStereoF32Le(splitBytes(passingBytes, widths), options(4));
    assert.deepEqual(streamed, whole);
  }

  const first = nextPositiveF32(1, "up"), later = nextPositiveF32(first, "up");
  const failingBytes = f32le([0.1, -0.2, 0.5, -first, later, 0, 0, 0]);
  const errors = [];
  for (const widths of [[failingBytes.byteLength], [1], [5, 2, 9, 3]] as const) {
    errors.push(await peakError(
      () => scanReferenceStereoF32Le(splitBytes(failingBytes, widths), options(4)),
      "CUT_AUDIO_CLIPPING",
    ));
  }
  assert.equal(errors[0].detail.frame, 1);
  assert.equal(errors[0].detail.channelName, "right");
  assert.deepEqual(errors[1].detail, errors[0].detail);
  assert.deepEqual(errors[2].detail, errors[0].detail);
  assert.equal(errors[1].message, errors[0].message);
  assert.equal(errors[2].message, errors[0].message);
});

test("NaN and infinities refuse finite peak evidence with deterministic precedence", async () => {
  const bytes = f32le([0.2, 0.3, Number.POSITIVE_INFINITY, Number.NaN, Number.NEGATIVE_INFINITY, 0]);
  const error = await peakError(
    () => scanReferenceStereoF32Le(splitBytes(bytes, [1, 6, 3]), options(3)),
    "CUT_AUDIO_NONFINITE",
  );
  assert.deepEqual(error.detail, {
    kind: "nonfinite",
    reason: "nonfinite-sample",
    expectedFrames: 3,
    expectedBytes: 24,
    observedBytes: 24,
    frame: 1,
    channel: 0,
    channelName: "left",
    sample: Number.POSITIVE_INFINITY,
  });
  assert.match(error.message, /\+Infinity/);

  const laterNonfinite = await peakError(
    () => scanReferenceStereoF32Le([f32le([1.25, 0, Number.NaN, 0])], options(2)),
    "CUT_AUDIO_NONFINITE",
  );
  assert.equal(laterNonfinite.detail.frame, 1, "non-finite data must invalidate an otherwise measurable clipping result");
});

test("truncated, partial-sample, partial-frame and extra streams have stable structural errors", async () => {
  const complete = f32le([0.1, 0.2, 0.3, 0.4]);
  const cases = [
    { bytes: complete.subarray(0, 8), reason: "truncated", message: /truncated/ },
    { bytes: complete.subarray(0, 10), reason: "partial-sample", message: /inside a 4-byte sample/ },
    { bytes: complete.subarray(0, 12), reason: "partial-stereo-frame", message: /only one channel/ },
  ] as const;
  for (const item of cases) {
    const error = await peakError(
      () => scanReferenceStereoF32Le(splitBytes(item.bytes, [1, 3, 2]), options(2)),
      "CUT_AUDIO_PEAK_STRUCTURE",
    );
    assert.equal(error.detail.reason, item.reason);
    assert.equal(error.detail.observedBytes, item.bytes.byteLength);
    assert.match(error.message, item.message);
  }

  const extra = Buffer.concat([complete.subarray(0, 8), Buffer.from([0])]);
  const wholeExtra = await peakError(
    () => scanReferenceStereoF32Le([extra], options(1)),
    "CUT_AUDIO_PEAK_STRUCTURE",
  );
  const splitExtra = await peakError(
    () => scanReferenceStereoF32Le([extra.subarray(0, 8), extra.subarray(8)], options(1)),
    "CUT_AUDIO_PEAK_STRUCTURE",
  );
  assert.equal(wholeExtra.detail.reason, "extra-bytes");
  assert.deepEqual(splitExtra.detail, wholeExtra.detail);
  assert.equal(splitExtra.message, wholeExtra.message);
});

test("contract and resource budgets fail before scanning hostile content", async () => {
  for (const expectedFrames of [-1, 0.5, Number.NaN]) {
    const error = await peakError(
      () => scanReferenceStereoF32Le([], options(expectedFrames)),
      "CUT_AUDIO_PEAK_STRUCTURE",
    );
    assert.equal(error.detail.reason, "invalid-expected-frames");
  }
  const frameBudget = await peakError(
    () => scanReferenceStereoF32Le([], options(referenceAudioPeakLimits.maximumFrames + 1)),
    "CUT_AUDIO_PEAK_RESOURCE_LIMIT",
  );
  assert.equal(frameBudget.detail.reason, "frame-budget");

  for (const threshold of [0.0001, -601, Number.POSITIVE_INFINITY, Number.NaN]) {
    const error = await peakError(
      () => scanReferenceStereoF32Le([], options(0, threshold)),
      "CUT_AUDIO_PEAK_STRUCTURE",
    );
    assert.equal(error.detail.reason, "invalid-threshold");
  }

  const hostileChunk = new Uint8Array(referenceAudioPeakLimits.maximumChunkBytes + 1);
  const chunkBudget = await peakError(
    () => scanReferenceStereoF32Le([hostileChunk], options(Math.ceil(hostileChunk.byteLength / 8))),
    "CUT_AUDIO_PEAK_RESOURCE_LIMIT",
  );
  assert.equal(chunkBudget.detail.reason, "chunk-size-budget");

  const invalidChunk = await peakError(
    () => scanReferenceStereoF32Le(["not bytes"] as unknown as Uint8Array[], options(1)),
    "CUT_AUDIO_PEAK_STRUCTURE",
  );
  assert.equal(invalidChunk.detail.reason, "invalid-chunk");
});

test("runtime JSON diagnostics retain the exact authored source", async () => {
  const error = await peakError(
    () => scanReferenceStereoF32Le([f32le([2, 0])], options(1)),
    "CUT_AUDIO_CLIPPING",
  );
  const diagnostics = cutDiagnosticsFromError(error);
  assert.equal(diagnostics.length, 1);
  assert.deepEqual(diagnostics[0], {
    code: "CUT_AUDIO_CLIPPING",
    severity: "error",
    message: error.message.slice("CUT_AUDIO_CLIPPING: ".length),
    source,
  });
  assert.ok(Buffer.byteLength(JSON.stringify(diagnostics)) < 1_024);
});

test("file scanning uses the same exact contract and translates I/O failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cut-audio-peak-"));
  const path = join(directory, "master.f32le");
  try {
    const bytes = f32le([0.1, -0.2, 0.4, -0.8]);
    await writeFile(path, bytes);
    const fileScan = await scanReferenceStereoF32LeFile(path, options(2));
    const iterableScan = await scanReferenceStereoF32Le(splitBytes(bytes, [1, 2, 5]), options(2));
    assert.deepEqual(fileScan, iterableScan);

    const missing = await peakError(
      () => scanReferenceStereoF32LeFile(join(directory, "missing.f32le"), options(2)),
      "CUT_AUDIO_PEAK_STRUCTURE",
    );
    assert.equal(missing.detail.reason, "input-read-failure");
    assert.match(missing.message, /\(ENOENT\)/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("canonical PCM24 quantization is exact, bounded and byte-repeatable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cut-audio-pcm24-"));
  const input = join(directory, "master.f32le"), first = join(directory, "first.wav"), second = join(directory, "second.wav");
  try {
    await writeFile(input, f32le([-1, 1, 0.5, -0.5]));
    const firstResult = await quantizeReferenceStereoF32LeFileToPcm24Wave(input, first, {
      ...options(2),
      sampleRate: 48_000,
    });
    const secondResult = await quantizeReferenceStereoF32LeFileToPcm24Wave(input, second, {
      ...options(2),
      sampleRate: 48_000,
    });
    assert.deepEqual(secondResult, firstResult);
    assert.deepEqual(firstResult, {
      format: "cut-reference-pcm24-wave",
      version: 1,
      channels: 2,
      bitsPerSample: 24,
      sampleRate: 48_000,
      frames: 2,
      dataBytes: 12,
      outputBytes: 56,
      peak: {
        format: "cut-reference-audio-peak-scan",
        version: 1,
        sampleFormat: "f32le",
        channels: 2,
        expectedFrames: 2,
        observedFrames: 2,
        expectedBytes: 16,
        observedBytes: 16,
        thresholdDbfs: 0,
        thresholdLinear: 1,
        silent: false,
        peakLinear: 1,
        peakDbfs: 0,
        peakFrame: 0,
        peakChannel: 0,
        peakChannelName: "left",
        peakSample: -1,
      },
    });

    const firstBytes = await readFile(first), secondBytes = await readFile(second);
    assert.deepEqual(secondBytes, firstBytes);
    assert.equal(firstBytes.subarray(0, 4).toString("ascii"), "RIFF");
    assert.equal(firstBytes.readUInt32LE(4), 48);
    assert.equal(firstBytes.subarray(8, 12).toString("ascii"), "WAVE");
    assert.equal(firstBytes.subarray(12, 16).toString("ascii"), "fmt ");
    assert.equal(firstBytes.readUInt32LE(16), 16);
    assert.equal(firstBytes.readUInt16LE(20), 1);
    assert.equal(firstBytes.readUInt16LE(22), 2);
    assert.equal(firstBytes.readUInt32LE(24), 48_000);
    assert.equal(firstBytes.readUInt32LE(28), 288_000);
    assert.equal(firstBytes.readUInt16LE(32), 6);
    assert.equal(firstBytes.readUInt16LE(34), 24);
    assert.equal(firstBytes.subarray(36, 40).toString("ascii"), "data");
    assert.equal(firstBytes.readUInt32LE(40), 12);
    assert.equal(firstBytes.subarray(44).toString("hex"), "000080ffff7f0000400000c0");

    const tiesInput = join(directory, "ties.f32le"), tiesOutput = join(directory, "ties.wav");
    await writeFile(tiesInput, f32le([
      0.5 / 0x80_0000,
      1.5 / 0x80_0000,
      -0.5 / 0x80_0000,
      -1.5 / 0x80_0000,
    ]));
    await quantizeReferenceStereoF32LeFileToPcm24Wave(tiesInput, tiesOutput, { ...options(2), sampleRate: 48_000 });
    assert.equal((await readFile(tiesOutput)).subarray(44).toString("hex"), "000000020000000000feffff");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the greatest float32 below +1 quantizes to positive PCM24 full scale without sign wrap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cut-audio-pcm24-positive-edge-"));
  const input = join(directory, "edge.f32le"), output = join(directory, "edge.wav");
  try {
    const belowOne = nextPositiveF32(1, "down");
    await writeFile(input, f32le([belowOne, -belowOne]));
    await quantizeReferenceStereoF32LeFileToPcm24Wave(input, output, {
      ...options(1),
      sampleRate: 48_000,
    });
    const wave = await readFile(output);
    assert.deepEqual([...wave.subarray(44, 47)], [0xff, 0xff, 0x7f]);
    assert.deepEqual([...wave.subarray(47, 50)], [0x00, 0x00, 0x80]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("PCM24 publication is atomic across clipping, non-finite, structure and I/O refusal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cut-audio-pcm24-atomic-"));
  const input = join(directory, "master.f32le"), output = join(directory, "master.wav");
  const sentinel = Buffer.from("existing validated output", "utf8");
  try {
    const rejectedInputs = [
      { bytes: f32le([1.25, 0]), code: "CUT_AUDIO_CLIPPING" as const, reason: "sample-peak-ceiling" },
      { bytes: f32le([Number.NaN, 0]), code: "CUT_AUDIO_NONFINITE" as const, reason: "nonfinite-sample" },
      { bytes: f32le([0.25]), code: "CUT_AUDIO_PEAK_STRUCTURE" as const, reason: "partial-stereo-frame" },
    ];
    for (const item of rejectedInputs) {
      await writeFile(input, item.bytes);
      await writeFile(output, sentinel);
      const error = await peakError(
        () => quantizeReferenceStereoF32LeFileToPcm24Wave(input, output, { ...options(1), sampleRate: 48_000 }),
        item.code,
      );
      assert.equal(error.detail.reason, item.reason);
      assert.deepEqual(await readFile(output), sentinel, `${item.code} replaced an existing validated output`);
      assert.deepEqual((await readdir(directory)).filter((name) => name.startsWith(".cut-pcm24-")), []);
    }

    const invalidRate = await peakError(
      () => quantizeReferenceStereoF32LeFileToPcm24Wave(input, output, { ...options(1), sampleRate: 44_100.5 }),
      "CUT_AUDIO_PEAK_STRUCTURE",
    );
    assert.equal(invalidRate.detail.reason, "invalid-sample-rate");
    assert.deepEqual(await readFile(output), sentinel);

    const missingInput = await peakError(
      () => quantizeReferenceStereoF32LeFileToPcm24Wave(join(directory, "missing.f32le"), output, { ...options(1), sampleRate: 48_000 }),
      "CUT_AUDIO_PEAK_STRUCTURE",
    );
    assert.equal(missingInput.detail.reason, "input-read-failure");
    assert.deepEqual(await readFile(output), sentinel);
    assert.deepEqual((await readdir(directory)).filter((name) => name.startsWith(".cut-pcm24-")), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
