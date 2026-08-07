import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { cutDiagnosticsFromError } from "../lib/runtime/diagnostics";
import {
  ReferenceAudioTruePeakError,
  assertReferenceAudioTruePeak,
  referenceAudioTruePeakCoefficientFingerprint,
  referenceAudioTruePeakCoefficients,
  referenceAudioTruePeakIdentity,
  referenceAudioTruePeakLimits,
  scanReferenceStereoF32LeTruePeak,
  scanReferenceStereoF32LeTruePeakFile,
  type ReferenceAudioTruePeakScanOptions,
} from "../lib/runtime/reference/audio-true-peak";

const source = Object.freeze({ module: "true-peak.cut", line: 9, column: 5, nodeId: "node.master" });

function f32le(frames: readonly (readonly [number, number])[]) {
  const output = Buffer.alloc(frames.length * 8);
  frames.forEach(([left, right], frame) => {
    output.writeFloatLE(left, frame * 8);
    output.writeFloatLE(right, frame * 8 + 4);
  });
  return output;
}

function chunks(bytes: Uint8Array, widths: readonly number[]) {
  const result: Uint8Array[] = [];
  let offset = 0, index = 0;
  while (offset < bytes.byteLength) {
    const width = widths[index % widths.length];
    const end = Math.min(bytes.byteLength, offset + width);
    result.push(bytes.subarray(offset, end));
    offset = end;
    index += 1;
  }
  return result;
}

function options(expectedFrames: number): ReferenceAudioTruePeakScanOptions {
  return { expectedFrames, sampleRate: 48_000, source };
}

function assertCeiling(scan: Awaited<ReturnType<typeof scanReferenceStereoF32LeTruePeak>>, thresholdDbtp: number) {
  return assertReferenceAudioTruePeak(scan, { thresholdDbtp, source });
}

function directConvolutionOracle(frames: readonly (readonly [number, number])[]) {
  const coefficients = referenceAudioTruePeakCoefficients.flat();
  const outputs = [new Float64Array(frames.length * 4 + coefficients.length - 4), new Float64Array(frames.length * 4 + coefficients.length - 4)] as const;
  let samplePeak = { linear: 0, frame: 0, channel: 0 as 0 | 1 };
  frames.forEach((frame, frameIndex) => {
    ([0, 1] as const).forEach((channel) => {
      const sample = Math.fround(frame[channel]);
      if (Math.abs(sample) > samplePeak.linear) samplePeak = { linear: Math.abs(sample), frame: frameIndex, channel };
      coefficients.forEach((coefficient, coefficientIndex) => {
        outputs[channel][frameIndex * 4 + coefficientIndex] += sample * coefficient;
      });
    });
  });
  let fir = { linear: 0, oversampledIndex: 0, channel: 0 as 0 | 1 };
  for (let oversampledIndex = 0; oversampledIndex < outputs[0].length; oversampledIndex += 1) {
    for (const channel of [0, 1] as const) {
      const linear = Math.abs(outputs[channel][oversampledIndex]);
      if (linear > fir.linear) fir = { linear, oversampledIndex, channel };
    }
  }
  const peakKind = fir.linear > samplePeak.linear ? "intersample" as const : "sample" as const;
  return {
    fir,
    samplePeak,
    peakKind,
    truePeakLinear: Math.max(fir.linear, samplePeak.linear),
    peakTimeEighthFrames: peakKind === "sample"
      ? String(samplePeak.frame * 8)
      : String(2 * fir.oversampledIndex - 47),
  };
}

function ebuTaperedSine(frequency: number, amplitude: number, phaseDegrees: number) {
  const sampleRate = 48_000, frameCount = sampleRate, fadeFrames = sampleRate / 100;
  return Array.from({ length: frameCount }, (_, frame) => {
    const envelope = Math.max(0, Math.min(1, frame / fadeFrames, (frameCount - 1 - frame) / fadeFrames));
    const sample = Math.fround(amplitude * Math.sin(2 * Math.PI * frequency * frame / sampleRate + phaseDegrees * Math.PI / 180) * envelope);
    return [sample, sample] as const;
  });
}

async function truePeakError(
  action: () => Promise<unknown>,
  code: ReferenceAudioTruePeakError["code"],
) {
  try {
    await action();
    assert.fail("expected ReferenceAudioTruePeakError");
  } catch (error) {
    assert.ok(error instanceof ReferenceAudioTruePeakError);
    assert.equal(error.code, code);
    assert.deepEqual(error.source, source);
    assert.ok(Object.isFrozen(error.source));
    assert.ok(Object.isFrozen(error.detail));
    assert.ok(error.message.length < 512);
    return error;
  }
}

test("the frozen BS.1770-5 FIR table and silent result are explicit", async () => {
  assert.equal(referenceAudioTruePeakCoefficients.length, 12);
  assert.ok(referenceAudioTruePeakCoefficients.every((row) => row.length === 4 && Object.isFrozen(row)));
  assert.equal(referenceAudioTruePeakCoefficients[0][0], 0.001708984375);
  assert.equal(referenceAudioTruePeakCoefficients[5][3], 0.97216796875);
  assert.equal(referenceAudioTruePeakCoefficients[11][3], 0.001708984375);
  assert.equal(
    `sha256:${createHash("sha256").update(JSON.stringify(referenceAudioTruePeakCoefficients)).digest("hex")}`,
    referenceAudioTruePeakCoefficientFingerprint,
  );

  const scan = await scanReferenceStereoF32LeTruePeak([], options(0));
  assert.equal(scan.algorithm, referenceAudioTruePeakIdentity);
  assert.equal(scan.observedFrames, 0);
  assert.equal(scan.oversampleFactor, 4);
  assert.equal(scan.tapsPerPhase, 12);
  assert.equal(scan.silent, true);
  assert.equal(scan.samplePeakLinear, 0);
  assert.equal(scan.firPeakLinear, 0);
  assert.equal(scan.truePeakDbtp, null);
  assert.equal(scan.peakKind, null);
  assert.ok(Object.isFrozen(scan));
});

test("an intersample overshoot is detected above every authored sample", async () => {
  const frames = [
    [0.9, 0] as const,
    [0.9, 0] as const,
    [-0.9, 0] as const,
    [-0.9, 0] as const,
  ];
  const permissive = await scanReferenceStereoF32LeTruePeak([f32le(frames)], options(frames.length));
  assert.equal(permissive.samplePeakLinear, f32le([[0.9, 0]]).readFloatLE(0));
  assert.ok(permissive.firPeakLinear > 1.2, JSON.stringify(permissive));
  assert.equal(permissive.truePeakLinear, permissive.firPeakLinear);
  assert.equal(permissive.peakKind, "intersample");
  assert.equal(permissive.peakChannelName, "left");
  assert.ok(permissive.truePeakDbtp !== null && permissive.truePeakDbtp > 1.6);
  assert.ok(permissive.oversampledIndex !== null);
  assert.ok(permissive.oversamplePhase !== null);

  const error = await truePeakError(
    async () => assertCeiling(await scanReferenceStereoF32LeTruePeak([f32le(frames)], options(frames.length)), -1),
    "CUT_AUDIO_TRUE_PEAK_EXCEEDED",
  );
  assert.equal(error.detail.reason, "true-peak-ceiling");
  assert.equal(error.detail.channelName, "left");
  assert.ok((error.detail.peakDbtp ?? -Infinity) > 1.6);
  assert.equal(error.detail.thresholdDbtp, -1);
});

test("sample peak is a conservative floor when the finite FIR estimate is lower", async () => {
  const scan = await scanReferenceStereoF32LeTruePeak([f32le([[1, -0.25]])], options(1));
  assert.equal(scan.samplePeakLinear, 1);
  assert.ok(scan.firPeakLinear < 1);
  assert.equal(scan.truePeakLinear, 1);
  assert.equal(scan.truePeakDbtp, 0);
  assert.equal(scan.peakKind, "sample");
  assert.equal(scan.peakFrame, 0);
  assert.equal(scan.peakChannelName, "left");
  assert.equal(scan.oversampledIndex, null);
  assert.equal(scan.peakTimeEighthFrames, "0");
});

test("arbitrary byte chunking cannot change the FIR result or diagnostic", async () => {
  const bytes = f32le(Array.from({ length: 32 }, (_, index) => [
    Math.fround(0.82 * Math.sin(index * 2.3)),
    Math.fround(0.71 * Math.cos(index * 1.7)),
  ] as const));
  const whole = await scanReferenceStereoF32LeTruePeak([bytes], options(32));
  for (const widths of [[1], [3, 5, 2, 11], [7, 9, 1]] as const) {
    assert.deepEqual(await scanReferenceStereoF32LeTruePeak(chunks(bytes, widths), options(32)), whole);
  }

  const failures = [];
  for (const widths of [[bytes.byteLength], [1], [5, 13, 2]] as const) {
    failures.push(await truePeakError(
      async () => assertCeiling(await scanReferenceStereoF32LeTruePeak(chunks(bytes, widths), options(32)), -12),
      "CUT_AUDIO_TRUE_PEAK_EXCEEDED",
    ));
  }
  assert.deepEqual(failures[1].detail, failures[0].detail);
  assert.deepEqual(failures[2].detail, failures[0].detail);
  assert.equal(failures[1].message, failures[0].message);
});

test("structure and non-finite failures take precedence over a peak claim", async () => {
  const exact = f32le([[0.2, 0.3], [0.4, 0.5]]);
  const truncated = await truePeakError(
    () => scanReferenceStereoF32LeTruePeak(chunks(exact.subarray(0, 12), [1, 3]), options(2)),
    "CUT_AUDIO_TRUE_PEAK_STRUCTURE",
  );
  assert.equal(truncated.detail.reason, "partial-stereo-frame");

  const extra = await truePeakError(
    () => scanReferenceStereoF32LeTruePeak([Buffer.concat([exact, Buffer.from([0])])], options(2)),
    "CUT_AUDIO_TRUE_PEAK_STRUCTURE",
  );
  assert.equal(extra.detail.reason, "extra-bytes");

  const nonfinite = await truePeakError(
    () => scanReferenceStereoF32LeTruePeak([f32le([[2, 0], [Number.NaN, 0]])], options(2)),
    "CUT_AUDIO_TRUE_PEAK_NONFINITE",
  );
  assert.equal(nonfinite.detail.frame, 1);
  assert.equal(nonfinite.detail.channelName, "left");
});

test("contract bounds and machine diagnostics are stable and source-located", async () => {
  for (const invalid of [
    { ...options(-1) },
    { ...options(0), sampleRate: 48_000.5 },
  ]) {
    await truePeakError(
      () => scanReferenceStereoF32LeTruePeak([], invalid),
      "CUT_AUDIO_TRUE_PEAK_STRUCTURE",
    );
  }
  for (const unsupported of [8_000, 44_100, 96_000]) {
    const error = await truePeakError(
      () => scanReferenceStereoF32LeTruePeak([], { ...options(0), sampleRate: unsupported }),
      "CUT_AUDIO_TRUE_PEAK_SAMPLE_RATE_UNSUPPORTED",
    );
    assert.equal(error.detail.reason, "unsupported-sample-rate");
  }
  const work = await truePeakError(
    () => scanReferenceStereoF32LeTruePeak([], options(referenceAudioTruePeakLimits.maximumFrames)),
    "CUT_AUDIO_TRUE_PEAK_RESOURCE_LIMIT",
  );
  assert.equal(work.detail.reason, "fir-work-budget");
  assert.equal(work.detail.firMultiplyAddLimit, 2 ** 32);

  for (const invalidThreshold of [undefined, "-1", Number.NaN, 60.01]) {
    await truePeakError(
      async () => assertReferenceAudioTruePeak(
        await scanReferenceStereoF32LeTruePeak([], options(0)),
        { thresholdDbtp: invalidThreshold, source } as never,
      ),
      "CUT_AUDIO_TRUE_PEAK_STRUCTURE",
    );
  }
  const error = await truePeakError(
    async () => assertCeiling(await scanReferenceStereoF32LeTruePeak([f32le([[1, 0]])], options(1)), -6),
    "CUT_AUDIO_TRUE_PEAK_EXCEEDED",
  );
  const diagnostics = cutDiagnosticsFromError(error);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, "CUT_AUDIO_TRUE_PEAK_EXCEEDED");
  assert.deepEqual(diagnostics[0].source, source);
  assert.ok(Buffer.byteLength(JSON.stringify(diagnostics)) < 1_024);
});

test("file and iterable scanners are byte-identical and normalize I/O failure", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-true-peak-"));
  const path = resolve(root, "mix.f32le");
  try {
    const bytes = f32le(Array.from({ length: 64 }, (_, index) => [
      Math.fround(0.5 * Math.sin(index / 3)),
      Math.fround(0.25 * Math.cos(index / 5)),
    ] as const));
    await writeFile(path, bytes);
    const file = await scanReferenceStereoF32LeTruePeakFile(path, options(64));
    const iterable = await scanReferenceStereoF32LeTruePeak(chunks(await readFile(path), [1, 17, 4]), options(64));
    assert.deepEqual(file, iterable);

    const missing = await truePeakError(
      () => scanReferenceStereoF32LeTruePeakFile(resolve(root, "missing.f32le"), options(64)),
      "CUT_AUDIO_TRUE_PEAK_STRUCTURE",
    );
    assert.equal(missing.detail.reason, "input-read-failure");
    assert.match(missing.message, /\(ENOENT\)/);

    const link = resolve(root, "link.f32le");
    await symlink(path, link);
    const linked = await truePeakError(
      () => scanReferenceStereoF32LeTruePeakFile(link, options(64)),
      "CUT_AUDIO_TRUE_PEAK_STRUCTURE",
    );
    assert.equal(linked.detail.reason, "input-read-failure");

    // Contract validation happens before opening the owned file. This exact
    // combination previously left a missing-file ReadStream to crash Node.
    const invalidBeforeOpen = await truePeakError(
      () => scanReferenceStereoF32LeTruePeakFile(resolve(root, "also-missing.f32le"), { ...options(-1) }),
      "CUT_AUDIO_TRUE_PEAK_STRUCTURE",
    );
    assert.equal(invalidBeforeOpen.detail.reason, "invalid-expected-frames");
    await new Promise((accept) => setImmediate(accept));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("streaming polyphase output matches an independent direct 48-tap convolution", async () => {
  const fixtures = [
    [[0.5, -0.25], [-1, 0.75]] as const,
    [[0.9, 0], [0.9, 0], [-0.9, 0], [-0.9, 0]] as const,
    Array.from({ length: 17 }, (_, frame) => [
      Math.fround(0.83 * Math.sin(frame * 1.713)),
      Math.fround(0.61 * Math.cos(frame * 2.119)),
    ] as const),
  ];
  for (const frames of fixtures) {
    const oracle = directConvolutionOracle(frames);
    const scan = await scanReferenceStereoF32LeTruePeak(chunks(f32le(frames), [1, 11, 3]), options(frames.length));
    assert.equal(scan.firPeakLinear, oracle.fir.linear);
    assert.equal(scan.truePeakLinear, oracle.truePeakLinear);
    assert.equal(scan.peakKind, oracle.peakKind);
    assert.equal(scan.peakTimeEighthFrames, oracle.peakTimeEighthFrames);
    if (oracle.peakKind === "intersample") {
      assert.equal(scan.oversampledIndex, oracle.fir.oversampledIndex);
      assert.equal(scan.oversamplePhase, oracle.fir.oversampledIndex % 4);
      assert.equal(scan.peakChannel, oracle.fir.channel);
    } else {
      assert.equal(scan.peakFrame, oracle.samplePeak.frame);
      assert.equal(scan.peakChannel, oracle.samplePeak.channel);
    }
  }
});

test("generated EBU Tech 3341 minimum-requirement signals 15 through 19 meet tolerance", async () => {
  const cases = [
    { id: 15, frequency: 12_000, amplitude: 0.5, phase: 0, expectedDbtp: -6 },
    { id: 16, frequency: 12_000, amplitude: 0.5, phase: 45, expectedDbtp: -6 },
    { id: 17, frequency: 8_000, amplitude: 0.5, phase: 60, expectedDbtp: -6 },
    { id: 18, frequency: 6_000, amplitude: 0.5, phase: 67.5, expectedDbtp: -6 },
    { id: 19, frequency: 12_000, amplitude: 1.41, phase: 45, expectedDbtp: 3 },
  ];
  for (const item of cases) {
    const frames = ebuTaperedSine(item.frequency, item.amplitude, item.phase);
    const scan = await scanReferenceStereoF32LeTruePeak(chunks(f32le(frames), [65_536]), options(frames.length));
    assert.ok(scan.truePeakDbtp !== null);
    const residual = scan.truePeakDbtp - item.expectedDbtp;
    assert.ok(residual >= -0.4 && residual <= 0.2, `EBU ${item.id}: ${scan.truePeakDbtp} dBTP`);
  }
});

test("zero-extension boundaries, exact time, equality and first-tie rules are explicit", async () => {
  const beforeStart = await scanReferenceStereoF32LeTruePeak([f32le([[1, 1], [-1, -1]])], options(2));
  assert.equal(beforeStart.peakKind, "intersample");
  assert.equal(beforeStart.peakTimeEighthFrames, "-1");
  assert.equal(beforeStart.peakFrame, -1);
  assert.equal(beforeStart.peakChannelName, "left", "equal-channel FIR ties keep the first channel");
  assert.equal(assertCeiling(beforeStart, beforeStart.truePeakDbtp!), beforeStart, "exact dBTP equality passes");
  const beforeStartError = await truePeakError(
    async () => assertCeiling(beforeStart, beforeStart.truePeakDbtp! - 1e-9),
    "CUT_AUDIO_TRUE_PEAK_EXCEEDED",
  );
  assert.equal(beforeStartError.detail.peakTimeEighthFrames, "-1");
  assert.equal(beforeStartError.detail.frame, -1);

  const tail = await scanReferenceStereoF32LeTruePeak([f32le([[0.5, 0], [-1, 0]])], options(2));
  assert.equal(tail.peakKind, "intersample");
  assert.equal(tail.oversampledIndex, 28, "peak is emitted only after authored input ends");
  assert.equal(tail.peakTimeEighthFrames, "9");

  const sampleTie = await scanReferenceStereoF32LeTruePeak([f32le([[1, -1]])], options(1));
  assert.equal(sampleTie.peakKind, "sample");
  assert.equal(sampleTie.peakChannelName, "left");
  assert.equal(assertCeiling(sampleTie, 0), sampleTie);
  const silence = await scanReferenceStereoF32LeTruePeak([], options(0));
  assert.equal(assertCeiling(silence, -600), silence, "silence is a measured compliant peak");
});

test("hostile iterable and runtime option failures are sanitized and coded", async () => {
  async function* hostile() {
    yield new Uint8Array(0);
    const hostilePath = ["", "Users", "example", "private.raw"].join("/");
    throw Object.assign(new Error(`secret ${hostilePath}`), { code: `LEAK_${hostilePath}` });
  }
  const stream = await truePeakError(
    () => scanReferenceStereoF32LeTruePeak(hostile(), options(0)),
    "CUT_AUDIO_TRUE_PEAK_STRUCTURE",
  );
  assert.equal(stream.detail.reason, "input-stream-failure");
  assert.match(stream.message, /\(UNKNOWN\)/);
  assert.doesNotMatch(stream.message, /Users|private/);

  for (const invalid of [
    { expectedFrames: undefined, sampleRate: 48_000, source },
    { expectedFrames: 0, sampleRate: undefined, source },
  ]) {
    const error = await truePeakError(
      () => scanReferenceStereoF32LeTruePeak([], invalid as never),
      "CUT_AUDIO_TRUE_PEAK_STRUCTURE",
    );
    assert.ok(["invalid-expected-frames", "invalid-sample-rate"].includes(error.detail.reason));
  }

  const tooLargeAndExtra = await truePeakError(
    () => scanReferenceStereoF32LeTruePeak([new Uint8Array(referenceAudioTruePeakLimits.maximumChunkBytes + 1)], options(0)),
    "CUT_AUDIO_TRUE_PEAK_STRUCTURE",
  );
  assert.equal(tooLargeAndExtra.detail.reason, "extra-bytes", "exact boundary beats chunk resource diagnostics");
});
