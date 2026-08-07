import test from "node:test";
import assert from "node:assert/strict";
import {
  ReferenceAudioLimiterError,
  assertReferenceAudioLimiterWorkContract,
  deriveReferenceAudioLimiterTruePeakEnvelope,
  processReferenceAudioLimiter,
  processReferenceAudioLimiterEnvelope,
  referenceAudioLimiterGuardDb,
  referenceAudioLimiterLimits,
  type ReferenceAudioLimiterProcessOptions,
} from "../lib/runtime/reference/audio-limiter";
import {
  createReferenceAudioLimiterCoreEvidence,
  isReferenceAudioLimiterCoreEvidence,
} from "../lib/runtime/reference/audio-limiter-preparation";
import { referenceAudioTruePeakCoefficients } from "../lib/runtime/reference/audio-true-peak";

const sampleRate = 48_000;
const source = Object.freeze({ module: "limiter-core.cut", line: 7, column: 3, nodeId: "master.limit" });

function stereo(frames: readonly (readonly [number, number])[]) {
  return new Float32Array(frames.flatMap(([left, right]) => [left, right]));
}

function controls(
  ceilingDbtp: (frame: number) => number = () => -1,
  releaseSeconds: (frame: number) => number = () => 0.05,
  lookaheadSamples = 0,
): ReferenceAudioLimiterProcessOptions {
  return { sampleRate, lookaheadSamples, ceilingDbtp, releaseSeconds, source };
}

function limiterError(action: () => unknown, code: ReferenceAudioLimiterError["code"]) {
  try {
    action();
    assert.fail("expected ReferenceAudioLimiterError");
  } catch (error) {
    assert.ok(error instanceof ReferenceAudioLimiterError);
    assert.equal(error.code, code);
    assert.ok(Object.isFrozen(error.source));
    assert.ok(Object.isFrozen(error.detail));
    assert.ok(error.message.length < 512);
    return error;
  }
}

function independentlyBinnedEnvelope(input: Float32Array) {
  const frames = input.length / 2;
  const flat = referenceAudioTruePeakCoefficients.flat();
  const outputLength = frames * 4 + flat.length - 4;
  const oversampled = [new Float64Array(outputLength), new Float64Array(outputLength)] as const;
  const envelope = new Float64Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    for (const channel of [0, 1] as const) {
      const sample = input[frame * 2 + channel];
      envelope[frame] = Math.max(envelope[frame], Math.abs(sample));
      flat.forEach((coefficient, coefficientIndex) => {
        oversampled[channel][frame * 4 + coefficientIndex] += sample * coefficient;
      });
    }
  }
  for (let index = 0; index < outputLength; index += 1) {
    const compensatedFrame = Math.max(0, Math.min(frames - 1, Math.floor((2 * index - 47) / 8)));
    envelope[compensatedFrame] = Math.max(
      envelope[compensatedFrame],
      Math.abs(oversampled[0][index]),
      Math.abs(oversampled[1][index]),
    );
  }
  return envelope;
}

test("the 48 kHz Annex 2 envelope is group-delay compensated, exact-length, and detects intersample overshoot", () => {
  const input = stereo([
    [0.9, 0],
    [0.9, 0],
    [-0.9, 0],
    [-0.9, 0],
  ]);
  const actual = deriveReferenceAudioLimiterTruePeakEnvelope(input, { sampleRate, source });
  const oracle = independentlyBinnedEnvelope(input);
  assert.equal(actual.length, input.length / 2);
  assert.deepEqual([...actual], [...oracle]);
  assert.ok(Math.max(...actual) > 1.2, JSON.stringify([...actual]));

  let state = 0x5eed_1234;
  const random = stereo(Array.from({ length: 37 }, () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const left = (state / 0xffff_ffff - 0.5) * 1.8;
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const right = (state / 0xffff_ffff - 0.5) * 1.8;
    return [left, right] as const;
  }));
  for (const boundaryCase of [stereo([[0.75, -0.25]]), stereo([[0, 0], [1, 0]]), random]) {
    assert.deepEqual(
      [...deriveReferenceAudioLimiterTruePeakEnvelope(boundaryCase, { sampleRate, source })],
      [...independentlyBinnedEnvelope(boundaryCase)],
    );
  }
  assert.equal(referenceAudioLimiterLimits.groupDelayEighthFrames, 47);
  assert.equal(referenceAudioLimiterLimits.oversampleFactor, 4);
});

test("instantaneous downward gain and release use the documented scalar recurrence", () => {
  const input = stereo(Array.from({ length: 5 }, () => [0.25, -0.25] as const));
  const envelope = new Float64Array([2, 0.25, 0.25, 0.25, 0.25]);
  const releaseSeconds = 0.001;
  const result = processReferenceAudioLimiterEnvelope(input, envelope, controls(() => 0, () => releaseSeconds));
  const guardedCeiling = 10 ** (-referenceAudioLimiterGuardDb / 20);
  const coefficient = Math.exp(-1 / (releaseSeconds * sampleRate));
  const expected = [guardedCeiling / 2];
  for (let frame = 1; frame < envelope.length; frame += 1) {
    expected.push(coefficient * expected[frame - 1] + (1 - coefficient));
  }
  expected.forEach((gain, frame) => assert.ok(Math.abs(result.appliedGain[frame] - gain) < 1e-14));
  assert.equal(result.requiredGain[0], guardedCeiling / 2);
  assert.equal(result.requiredGain[1], 1);
  assert.equal(result.guardDb, 0.5);
});

test("bounded future-window reduction starts exactly lookaheadSamples before a transient", () => {
  const input = stereo(Array.from({ length: 6 }, () => [0.25, 0.25] as const));
  const envelope = new Float64Array([0.25, 0.25, 0.25, 2, 0.25, 0.25]);
  const result = processReferenceAudioLimiterEnvelope(input, envelope, controls(() => 0, () => 0.05, 2));
  const transientGain = 10 ** (-referenceAudioLimiterGuardDb / 20) / 2;
  assert.equal(result.appliedGain[0], 1);
  assert.equal(result.appliedGain[1], transientGain);
  assert.equal(result.appliedGain[2], transientGain);
  assert.equal(result.appliedGain[3], transientGain);
  assert.ok(result.appliedGain[4] > transientGain);
  assert.equal(result.output.length, input.length);
});

test("lookahead anticipates future audio but never a future ceiling event", () => {
  const input = stereo(Array.from({ length: 7 }, () => [0.1, -0.1] as const));
  const envelope = new Float64Array(Array.from({ length: 7 }, () => 0.8));
  const eventFrame = 4;
  const result = processReferenceAudioLimiterEnvelope(
    input,
    envelope,
    controls((frame) => frame < eventFrame ? 0 : -12, () => 0.05, 3),
  );
  for (let frame = 0; frame < eventFrame; frame += 1) {
    assert.equal(result.requiredGain[frame], 1, `ceiling event leaked backward to frame ${frame}`);
    assert.equal(result.appliedGain[frame], 1, `ceiling event reduced frame ${frame}`);
  }
  assert.ok(result.requiredGain[eventFrame] < 1);
  assert.equal(result.appliedGain[eventFrame], result.requiredGain[eventFrame]);
  assert.equal(result.reconciliationFactor, 1);
});

test("ceiling and release callbacks take effect on their exact sample boundary", () => {
  const input = stereo(Array.from({ length: 5 }, () => [0.2, -0.2] as const));
  const flatEnvelope = new Float64Array([1, 1, 1, 1, 1]);
  const ceilingFrames: number[] = [];
  const releaseFrames: number[] = [];
  const automated = processReferenceAudioLimiterEnvelope(input, flatEnvelope, controls(
    (frame) => {
      ceilingFrames.push(frame);
      return frame < 2 ? 0 : -6;
    },
    (frame) => {
      releaseFrames.push(frame);
      return 0.05;
    },
  ));
  assert.deepEqual(ceilingFrames, [0, 1, 2, 3, 4]);
  assert.deepEqual(releaseFrames, [0, 1, 2, 3, 4]);
  assert.equal(automated.ceilingMode, "dynamic");
  assert.equal(automated.minimumCeilingDbtp, -6);
  assert.equal(automated.maximumCeilingDbtp, 0);
  assert.equal(automated.requiredGain[1], 10 ** (-referenceAudioLimiterGuardDb / 20));
  assert.equal(automated.requiredGain[2], 10 ** ((-6 - referenceAudioLimiterGuardDb) / 20));
  assert.equal(automated.appliedGain[1], automated.requiredGain[1]);
  assert.equal(automated.appliedGain[2], automated.requiredGain[2]);

  const releaseEnvelope = new Float64Array([2, 0.1, 0.1, 0.1, 0.1]);
  const fastAtOne = processReferenceAudioLimiterEnvelope(input, releaseEnvelope, controls(() => 0, (frame) => frame === 0 ? 1 : 0.001));
  const slowAtOne = processReferenceAudioLimiterEnvelope(input, releaseEnvelope, controls(() => 0, () => 1));
  assert.equal(fastAtOne.appliedGain[0], slowAtOne.appliedGain[0]);
  assert.ok(fastAtOne.appliedGain[1] > slowAtOne.appliedGain[1]);
});

test("one gain curve links stereo without collapsing channel balance", () => {
  const input = stereo([
    [0.8, 0.2],
    [0.1, -0.3],
  ]);
  const result = processReferenceAudioLimiterEnvelope(input, new Float64Array([2, 0.3]), controls(() => 0, () => 0.1));
  for (let frame = 0; frame < 2; frame += 1) {
    const gain = result.appliedGain[frame];
    assert.ok(Math.abs(result.output[frame * 2] - Math.fround(input[frame * 2] * gain)) < 1e-7);
    assert.ok(Math.abs(result.output[frame * 2 + 1] - Math.fround(input[frame * 2 + 1] * gain)) < 1e-7);
  }
  assert.ok(Math.abs(result.output[0] / result.output[1] - 4) < 1e-6);
});

test("silence and onset retain exact programme length and sample position", () => {
  const input = stereo([
    [0, 0],
    [0, 0],
    [0, 0],
    [0, 0],
    [0.9, 0.45],
    [0.9, 0.45],
    [-0.9, -0.45],
    [-0.9, -0.45],
  ]);
  const result = processReferenceAudioLimiter(input, controls(() => -1, () => 0.05, 4));
  assert.equal(result.frames, 8);
  assert.equal(result.output.length, input.length);
  assert.deepEqual([...result.output.subarray(0, 8)], Array.from({ length: 8 }, () => 0));
  assert.notEqual(result.output[8], 0);
  assert.equal(result.truePeakEnvelope.length, 8);
  assert.equal(result.requiredGain.length, 8);
  assert.equal(result.appliedGain.length, 8);
  assert.equal(result.outputTruePeakEnvelope.length, 8);
});

test("the guarded core reduces a proven intersample fixture below its authored ceiling", () => {
  const input = stereo(Array.from({ length: 8 }, (_, frame) => frame % 4 < 2 ? [0.9, -0.45] as const : [-0.9, 0.45] as const));
  const ceilingDbtp = -1;
  const result = processReferenceAudioLimiter(input, controls(() => ceilingDbtp, () => 0.05, 16));
  const outputEnvelope = deriveReferenceAudioLimiterTruePeakEnvelope(result.output, { sampleRate, source });
  const authoredCeilingLinear = 10 ** (ceilingDbtp / 20);
  assert.ok(Math.max(...result.truePeakEnvelope) > 1);
  assert.ok(Math.max(...outputEnvelope) <= authoredCeilingLinear, JSON.stringify({ outputEnvelope: [...outputEnvelope], gains: [...result.appliedGain] }));
});

test("zero-lookahead reconstruction misses are uniformly reconciled and exposed", () => {
  const input = new Float32Array([
    0, 0,
    0.6675620675086975, -1.3456135988235474,
    1.3896294832229614, 1.8730218410491943,
    0.6350957751274109, 1.7300646305084229,
    0.7005090713500977, -0.19993992149829865,
    -0.061311110854148865, -0.935623049736023,
    1.0199644565582275, 1.2565211057662964,
    0, 0,
  ]);
  const ceilingDbtp = -5;
  const result = processReferenceAudioLimiter(input, controls(() => ceilingDbtp, () => 0.05, 0));
  const ceilingLinear = 10 ** (ceilingDbtp / 20);
  assert.equal(result.version, 3);
  assert.equal(result.ceilingMode, "static");
  assert.equal(result.minimumCeilingDbtp, ceilingDbtp);
  assert.equal(result.maximumCeilingDbtp, ceilingDbtp);
  assert.ok(result.reconciliationFactor < 1, JSON.stringify(result));
  assert.equal(result.minimumFinalGain, result.minimumAppliedGain * result.reconciliationFactor);
  assert.equal(result.output.length, input.length);
  assert.deepEqual([...result.output.subarray(0, 2)], [0, 0]);
  assert.deepEqual([...result.output.subarray(-2)], [0, 0]);
  assert.ok([...result.outputTruePeakEnvelope].every((peak) => peak <= ceilingLinear));
  assert.deepEqual(
    [...deriveReferenceAudioLimiterTruePeakEnvelope(result.output, { sampleRate, source })],
    [...result.outputTruePeakEnvelope],
  );
  const maximumOutputTruePeakLinear = Math.max(...result.outputTruePeakEnvelope);
  assert.equal(result.maximumOutputTruePeakLinear, maximumOutputTruePeakLinear);
  assert.equal(result.maximumOutputTruePeakDbtp, 20 * Math.log10(maximumOutputTruePeakLinear));
  assert.equal(result.maximumOutputTruePeakFrame, result.outputTruePeakEnvelope.indexOf(maximumOutputTruePeakLinear));

  const evidence = createReferenceAudioLimiterCoreEvidence(result);
  assert.equal(isReferenceAudioLimiterCoreEvidence(evidence), true);
  assert.equal(isReferenceAudioLimiterCoreEvidence(JSON.parse(JSON.stringify(evidence))), true);
  assert.equal(JSON.stringify(evidence).includes("project.cut"), false);
  assert.equal(JSON.stringify(evidence).includes("node-"), false);
  assert.equal(isReferenceAudioLimiterCoreEvidence({ ...evidence, unknown: true }), false);
  assert.equal(isReferenceAudioLimiterCoreEvidence({ ...evidence, integrity: "0".repeat(64) }), false);
});

test("an automated ceiling that would need non-causal reconciliation is refused stably", () => {
  const input = new Float32Array([
    0.2, -0.1,
    0.6675620675086975, -1.3456135988235474,
    1.3896294832229614, 1.8730218410491943,
    0.6350957751274109, 1.7300646305084229,
    0.7005090713500977, -0.19993992149829865,
    -0.061311110854148865, -0.935623049736023,
    1.0199644565582275, 1.2565211057662964,
    0, 0,
  ]);
  const boundary = 2;
  const error = limiterError(
    () => processReferenceAudioLimiter(input, controls((frame) => frame < boundary ? -1 : -5, () => 0.05, 0)),
    "CUT_AUDIO_LIMITER_RECONCILIATION",
  );
  assert.equal(error.detail.reason, "dynamic-ceiling-reconciliation-unsupported");
  assert.ok((error.detail.frame ?? -1) >= boundary);
  assert.ok((error.detail.reconciliationFactor ?? 1) < 1);
});

test("deterministic adversarial zero/one-sample lookahead with dynamic releases always verifies", () => {
  let state = 0x91e1_0da5;
  const random = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0xffff_ffff;
  };
  let reconciliations = 0;
  for (let fixture = 0; fixture < 256; fixture += 1) {
    const frames = 2 + Math.floor(random() * 31);
    const input = new Float32Array(frames * 2);
    for (let sample = 0; sample < input.length; sample += 1) input[sample] = Math.fround((random() * 2 - 1) * 2);
    const ceilingDbtp = -1 - Math.floor(random() * 15);
    const releases = Float64Array.from({ length: frames }, () => 0.001 + random() * 1.999);
    const ceiling: (frame: number) => number = () => ceilingDbtp;
    const result = processReferenceAudioLimiter(input, controls(ceiling, (frame) => releases[frame], fixture % 2));
    if (result.reconciliationFactor < 1) reconciliations += 1;
    assert.equal(result.output.length, input.length);
    for (let frame = 0; frame < frames; frame += 1) {
      assert.ok(
        result.outputTruePeakEnvelope[frame] <= 10 ** (ceilingDbtp / 20),
        JSON.stringify({ fixture, frame, peak: result.outputTruePeakEnvelope[frame], ceiling: ceilingDbtp, factor: result.reconciliationFactor }),
      );
    }
  }
  assert.ok(reconciliations > 0);
});

test("hostile PCM, envelopes, controls, and option accessors produce stable diagnostics", () => {
  const nonfinite = limiterError(
    () => deriveReferenceAudioLimiterTruePeakEnvelope(new Float32Array([Number.NaN, 0]), { sampleRate, source }),
    "CUT_AUDIO_LIMITER_NONFINITE",
  );
  assert.equal(nonfinite.detail.frame, 0);
  assert.equal(nonfinite.detail.channelName, "left");

  limiterError(
    () => deriveReferenceAudioLimiterTruePeakEnvelope(new Float32Array([65, 0]), { sampleRate, source }),
    "CUT_AUDIO_LIMITER_BOUNDS",
  );
  limiterError(
    () => deriveReferenceAudioLimiterTruePeakEnvelope(new Float32Array([0]), { sampleRate, source }),
    "CUT_AUDIO_LIMITER_STRUCTURE",
  );

  const input = stereo([[0.1, 0.1]]);
  limiterError(
    () => processReferenceAudioLimiterEnvelope(input, new Float64Array([Number.POSITIVE_INFINITY]), controls()),
    "CUT_AUDIO_LIMITER_NONFINITE",
  );
  const callbackError = limiterError(
    () => processReferenceAudioLimiterEnvelope(input, new Float64Array([0.1]), controls(() => { throw new Error("sensitive callback payload"); })),
    "CUT_AUDIO_LIMITER_CONTROL",
  );
  assert.equal(callbackError.message.includes("sensitive callback payload"), false);
  limiterError(
    () => processReferenceAudioLimiterEnvelope(input, new Float64Array([0.1]), controls(() => Number.POSITIVE_INFINITY)),
    "CUT_AUDIO_LIMITER_NONFINITE",
  );
  limiterError(
    () => processReferenceAudioLimiterEnvelope(input, new Float64Array([0.1]), controls(() => 0, () => 2.001)),
    "CUT_AUDIO_LIMITER_BOUNDS",
  );
  limiterError(
    () => processReferenceAudioLimiterEnvelope(input, new Float64Array([0.1]), controls(() => 0, (() => 1n) as unknown as (frame: number) => number)),
    "CUT_AUDIO_LIMITER_STRUCTURE",
  );

  const hostile = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(hostile, "sampleRate", { get() { throw new Error("getter escaped"); }, enumerable: true });
  limiterError(
    () => processReferenceAudioLimiter(input, hostile as unknown as ReferenceAudioLimiterProcessOptions),
    "CUT_AUDIO_LIMITER_STRUCTURE",
  );
});

test("sample-rate, lookahead, and FIR work bounds fail before programme allocation", () => {
  const exact = assertReferenceAudioLimiterWorkContract({
    expectedFrames: referenceAudioLimiterLimits.maximumFrames,
    sampleRate,
    lookaheadSamples: referenceAudioLimiterLimits.maximumLookaheadSamples,
    source,
  });
  assert.equal(
    exact.firMultiplyAdds,
    exact.expectedFrames * referenceAudioLimiterLimits.firMultiplyAddsPerFrame * referenceAudioLimiterLimits.maximumFirPasses,
  );
  assert.ok(exact.firMultiplyAdds <= referenceAudioLimiterLimits.maximumFirMultiplyAdds);

  const work = limiterError(
    () => assertReferenceAudioLimiterWorkContract({
      expectedFrames: referenceAudioLimiterLimits.maximumFrames + 1,
      sampleRate,
      lookaheadSamples: 0,
      source,
    }),
    "CUT_AUDIO_LIMITER_WORK_LIMIT",
  );
  assert.equal(work.detail.reason, "fir-multiply-adds");

  limiterError(
    () => assertReferenceAudioLimiterWorkContract({ expectedFrames: 1, sampleRate, lookaheadSamples: 961, source }),
    "CUT_AUDIO_LIMITER_BOUNDS",
  );
  limiterError(
    () => assertReferenceAudioLimiterWorkContract({ expectedFrames: 1, sampleRate: 44_100, lookaheadSamples: 0, source }),
    "CUT_AUDIO_LIMITER_SAMPLE_RATE_UNSUPPORTED",
  );
  limiterError(
    () => assertReferenceAudioLimiterWorkContract({ expectedFrames: 1, sampleRate: Number.NaN, lookaheadSamples: 0, source }),
    "CUT_AUDIO_LIMITER_NONFINITE",
  );
});
