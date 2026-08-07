import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  compileReferenceDeEsserPlan,
  createReferenceDeEsserState,
  defaultReferenceDeEsserConfig,
  planReferenceDeEsserBatch,
  planReferenceDeEsserWork,
  processReferenceDeEsserFrame,
  processReferenceDeEsserPcm,
  referenceDeEsserCoreLimits,
  referenceDeEsserCoreNonClaims,
  ReferenceDeEsserCoreError,
  type ReferenceDeEsserConfig,
  type ReferenceDeEsserControls,
} from "../lib/runtime/reference/audio-deesser";

type IndependentState = { lowLeft: number; lowRight: number; envelope: number };

function independentFrame(
  left: number,
  right: number,
  controls: ReferenceDeEsserControls,
  config: ReferenceDeEsserConfig,
  state: IndependentState,
) {
  const crossover = Math.exp(-2 * Math.PI * config.crossoverHz / config.sampleRate);
  const attack = Math.exp(-1 / (config.attackSeconds * config.sampleRate));
  const release = Math.exp(-1 / (config.releaseSeconds * config.sampleRate));
  const lowLeft = (1 - crossover) * left + crossover * state.lowLeft;
  const lowRight = (1 - crossover) * right + crossover * state.lowRight;
  const highLeft = left - lowLeft, highRight = right - lowRight;
  const detector = Math.max(Math.abs(highLeft), Math.abs(highRight));
  const coefficient = detector > state.envelope ? attack : release;
  const envelope = coefficient * state.envelope + (1 - coefficient) * detector;
  state.lowLeft = Math.abs(lowLeft) < 1e-30 ? 0 : lowLeft;
  state.lowRight = Math.abs(lowRight) < 1e-30 ? 0 : lowRight;
  state.envelope = Math.abs(envelope) < 1e-30 ? 0 : envelope;
  const thresholdDb = config.leastSensitiveThresholdDb
    + controls.intensity * (config.mostSensitiveThresholdDb - config.leastSensitiveThresholdDb);
  const depthDb = config.maximumReductionDb * controls.intensity * controls.amount;
  const envelopeDb = state.envelope > 1e-30 ? 20 * Math.log10(state.envelope) : -600;
  const activity = Math.max(0, Math.min(1, (envelopeDb - thresholdDb) / -thresholdDb));
  const reductionDb = -depthDb * activity, gain = 10 ** (reductionDb / 20);
  const bypass = controls.intensity === 0 || controls.amount === 0 || reductionDb === 0;
  return {
    left: bypass ? left : lowLeft + highLeft * gain,
    right: bypass ? right : lowRight + highRight * gain,
    detector,
    envelope: state.envelope,
    thresholdDb,
    reductionDb,
    highBandGain: gain,
  };
}

function independentPcm(
  input: Float64Array,
  controls: readonly ReferenceDeEsserControls[],
  config: ReferenceDeEsserConfig,
  resetAt?: number,
) {
  let state: IndependentState = { lowLeft: 0, lowRight: 0, envelope: 0 };
  const output = new Float64Array(input.length), frames = [];
  for (let frame = 0; frame < input.length / 2; frame += 1) {
    if (frame === resetAt) state = { lowLeft: 0, lowRight: 0, envelope: 0 };
    const result = independentFrame(input[frame * 2], input[frame * 2 + 1], controls[frame], config, state);
    output[frame * 2] = result.left;
    output[frame * 2 + 1] = result.right;
    frames.push(result);
  }
  return { output, frames, state };
}

function pcm24Hash(samples: Float64Array) {
  const bytes = Buffer.alloc(samples.length * 3);
  samples.forEach((sample, index) => {
    const bounded = Math.max(-1, Math.min(1 - 1 / 0x800000, sample));
    let value = Math.round(bounded * 0x800000);
    if (value < 0) value += 0x1000000;
    bytes[index * 3] = value & 0xff;
    bytes[index * 3 + 1] = value >> 8 & 0xff;
    bytes[index * 3 + 2] = value >> 16 & 0xff;
  });
  return createHash("sha256").update(bytes).digest("hex");
}

function expectCoreError(action: () => unknown, code: ReferenceDeEsserCoreError["code"], message: RegExp) {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ReferenceDeEsserCoreError);
    assert.equal(error.code, code);
    assert.match(error.message, message);
    assert.ok(error.message.length < 512, "diagnostic must remain bounded");
    return true;
  });
}

test("default DeEsser topology compiles to one closed deterministic plan", () => {
  const config = defaultReferenceDeEsserConfig(48_000), plan = compileReferenceDeEsserPlan(config);
  assert.deepEqual(config, {
    sampleRate: 48_000,
    crossoverHz: 5_500,
    attackSeconds: 0.0005,
    releaseSeconds: 0.05,
    leastSensitiveThresholdDb: -6,
    mostSensitiveThresholdDb: -48,
    maximumReductionDb: 18,
  });
  assert.equal(plan.format, "cut-reference-deesser-plan");
  assert.equal(plan.version, 1);
  assert.ok(plan.crossoverCoefficient > 0 && plan.crossoverCoefficient < 1);
  assert.ok(plan.attackCoefficient > 0 && plan.attackCoefficient < 1);
  assert.ok(plan.releaseCoefficient > plan.attackCoefficient && plan.releaseCoefficient < 1);
  assert.ok(Object.isFrozen(config) && Object.isFrozen(plan));

  const lowRate = compileReferenceDeEsserPlan(defaultReferenceDeEsserConfig(8_000));
  assert.equal(lowRate.crossoverHz, 3_200, "crossover must remain below Nyquist at the minimum sample rate");
});

test("dynamic intensity and amount match an independent scalar model and a frozen PCM24 golden", () => {
  const config = defaultReferenceDeEsserConfig(8_000), plan = compileReferenceDeEsserPlan(config);
  const frames = 64, input = new Float64Array(frames * 2), controls: ReferenceDeEsserControls[] = [];
  for (let frame = 0; frame < frames; frame += 1) {
    const low = 0.16 * Math.sin(2 * Math.PI * 500 * frame / config.sampleRate);
    const burst = frame >= 8 && frame < 48 ? 0.58 : 0.08;
    const high = (frame % 2 === 0 ? 1 : -1) * burst;
    input[frame * 2] = low + high;
    input[frame * 2 + 1] = low * 0.7 - high * 0.55;
    controls.push(frame < 8
      ? { intensity: 0, amount: 1 }
      : frame < 32
        ? { intensity: 0.55, amount: 0.7 }
        : { intensity: 1, amount: frame < 48 ? 1 : 0.35 });
  }
  const actual = processReferenceDeEsserPcm(input, controls, plan), expected = independentPcm(input, controls, config);
  for (let sample = 0; sample < input.length; sample += 1) {
    assert.ok(Math.abs(actual.output[sample] - expected.output[sample]) < 1e-12, `sample ${sample}`);
  }
  assert.deepEqual(actual.state, { ...expected.state, framesProcessed: frames });
  assert.equal(pcm24Hash(actual.output), "e86b9b13c7caef292dc14b46e6e9f657a5e4a2cb60dc61606c69398fe3819288");
});

test("zero controls are exact bypass while warming state for a later exact-sample event", () => {
  const config = defaultReferenceDeEsserConfig(48_000), plan = compileReferenceDeEsserPlan(config);
  const frames = 160, event = 48, input = new Float64Array(frames * 2), controls: ReferenceDeEsserControls[] = [];
  for (let frame = 0; frame < frames; frame += 1) {
    const high = (frame % 2 === 0 ? 0.7 : -0.7), low = 0.1 * Math.sin(2 * Math.PI * 300 * frame / config.sampleRate);
    input[frame * 2] = high + low;
    input[frame * 2 + 1] = -high * 0.4 + low;
    controls.push(frame < event ? { intensity: 1, amount: 0 } : { intensity: 1, amount: 1 });
  }
  const actual = processReferenceDeEsserPcm(input, controls, plan), continuous = independentPcm(input, controls, config), reset = independentPcm(input, controls, config, event);
  assert.deepEqual(actual.output.slice(0, event * 2), input.slice(0, event * 2), "zero amount must be byte-value exact bypass");
  let continuousError = 0, resetError = 0;
  for (let sample = event * 2; sample < actual.output.length; sample += 1) {
    continuousError += (actual.output[sample] - continuous.output[sample]) ** 2;
    resetError += (actual.output[sample] - reset.output[sample]) ** 2;
  }
  assert.ok(continuousError < 1e-24, String(continuousError));
  assert.ok(resetError > 1e-3, `reset model unexpectedly matched warm state: ${resetError}`);
  assert.notEqual(actual.output[event * 2], input[event * 2], "the first active frame did not execute its authored controls");
});

test("streamed chunks preserve exactly the same crossover and envelope state", () => {
  const config = defaultReferenceDeEsserConfig(48_000), plan = compileReferenceDeEsserPlan(config);
  const frames = 256, split = 91, input = new Float64Array(frames * 2), controls: ReferenceDeEsserControls[] = [];
  for (let frame = 0; frame < frames; frame += 1) {
    input[frame * 2] = 0.5 * Math.sin(2 * Math.PI * 7_500 * frame / config.sampleRate);
    input[frame * 2 + 1] = 0.35 * Math.sin(2 * Math.PI * 6_500 * frame / config.sampleRate + 0.3);
    controls.push({ intensity: frame / (frames - 1), amount: 0.2 + 0.8 * (frame % 17) / 16 });
  }
  const whole = processReferenceDeEsserPcm(input, controls, plan);
  const shared = createReferenceDeEsserState();
  const first = processReferenceDeEsserPcm(input.slice(0, split * 2), controls.slice(0, split), plan, shared);
  const second = processReferenceDeEsserPcm(input.slice(split * 2), controls.slice(split), plan, shared);
  const joined = new Float64Array(input.length); joined.set(first.output); joined.set(second.output, split * 2);
  assert.deepEqual(joined, whole.output);
  assert.deepEqual(second.state, whole.state);
});

test("one linked detector is invariant under channel exchange", () => {
  const config = defaultReferenceDeEsserConfig(48_000), plan = compileReferenceDeEsserPlan(config);
  const leftState = createReferenceDeEsserState(), swappedState = createReferenceDeEsserState();
  let observedReduction = false;
  for (let frame = 0; frame < 256; frame += 1) {
    const left = frame % 2 === 0 ? 0.8 : -0.8;
    const right = 0.1 * Math.sin(2 * Math.PI * 7_000 * frame / config.sampleRate);
    const controls = { intensity: 1, amount: 1 };
    const original = processReferenceDeEsserFrame(left, right, controls, plan, leftState);
    const swapped = processReferenceDeEsserFrame(right, left, controls, plan, swappedState);
    assert.equal(original.left, swapped.right);
    assert.equal(original.right, swapped.left);
    assert.equal(original.detector, swapped.detector);
    assert.equal(original.highBandGain, swapped.highBandGain);
    observedReduction ||= original.highBandGain < 0.95;
  }
  assert.ok(observedReduction, "sibilant fixture never drove the linked gain");
});

function rms(samples: Float64Array, channel: 0 | 1, startFrame: number) {
  let energy = 0, count = 0;
  for (let frame = startFrame; frame < samples.length / 2; frame += 1) {
    energy += samples[frame * 2 + channel] ** 2; count += 1;
  }
  return Math.sqrt(energy / count);
}

test("the complementary split attenuates sibilant energy more than low-frequency programme", () => {
  const config = defaultReferenceDeEsserConfig(48_000), plan = compileReferenceDeEsserPlan(config), frames = 4_800;
  const low = new Float64Array(frames * 2), high = new Float64Array(frames * 2);
  for (let frame = 0; frame < frames; frame += 1) {
    low[frame * 2] = low[frame * 2 + 1] = 0.6 * Math.sin(2 * Math.PI * 400 * frame / config.sampleRate);
    high[frame * 2] = high[frame * 2 + 1] = 0.6 * Math.sin(2 * Math.PI * 8_000 * frame / config.sampleRate);
  }
  const controls = { intensity: 1, amount: 1 }, lowOutput = processReferenceDeEsserPcm(low, controls, plan).output, highOutput = processReferenceDeEsserPcm(high, controls, plan).output;
  const lowRatio = rms(lowOutput, 0, 2_400) / rms(low, 0, 2_400), highRatio = rms(highOutput, 0, 2_400) / rms(high, 0, 2_400);
  assert.ok(lowRatio > 0.95, `low programme changed too much: ${lowRatio}`);
  assert.ok(highRatio < 0.67, `sibilant fixture was not materially attenuated: ${highRatio}`);
  assert.ok(lowRatio - highRatio > 0.3, `frequency selectivity was too weak: low=${lowRatio} high=${highRatio}`);
});

test("silence, control endpoints, and sample-rate endpoints stay finite and exact", () => {
  for (const sampleRate of [referenceDeEsserCoreLimits.minimumSampleRate, referenceDeEsserCoreLimits.maximumSampleRate]) {
    const plan = compileReferenceDeEsserPlan(defaultReferenceDeEsserConfig(sampleRate));
    const silence = processReferenceDeEsserPcm(new Float64Array(64), { intensity: 1, amount: 1 }, plan);
    assert.deepEqual(silence.output, new Float64Array(64));
    assert.deepEqual(silence.state, { lowLeft: 0, lowRight: 0, envelope: 0, framesProcessed: 32 });
    const state = createReferenceDeEsserState(), zero = processReferenceDeEsserFrame(1, -1, { intensity: 0, amount: 1 }, plan, state);
    assert.deepEqual([zero.left, zero.right], [1, -1]);
    const full = processReferenceDeEsserFrame(-1, 1, { intensity: 1, amount: 1 }, plan, state);
    assert.ok(Number.isFinite(full.left) && Number.isFinite(full.right) && full.highBandGain > 0 && full.highBandGain <= 1);
  }
});

test("configuration, controls, state, and PCM fail closed with stable bounded codes", () => {
  const config = defaultReferenceDeEsserConfig(48_000), plan = compileReferenceDeEsserPlan(config);
  for (const [candidate, message] of [
    [{ ...config, surprise: 1 }, /exactly/],
    [{ ...config, sampleRate: 48_000.5 }, /integer/],
    [{ ...config, crossoverHz: 30_000 }, /crossoverHz/],
    [{ ...config, mostSensitiveThresholdDb: -5 }, /must be lower/],
    [{ ...config, maximumReductionDb: Number.NaN }, /finite/],
  ] as const) expectCoreError(() => compileReferenceDeEsserPlan(candidate as ReferenceDeEsserConfig), "CUT_AUDIO_DEESSER_CONFIG", message);

  const state = createReferenceDeEsserState();
  for (const controls of [
    { intensity: -0.1, amount: 1 },
    { intensity: 1, amount: 1.1 },
    { intensity: Number.NaN, amount: 1 },
    { intensity: 1, amount: 1, ignored: 1 },
  ]) expectCoreError(() => processReferenceDeEsserFrame(0.1, -0.1, controls as ReferenceDeEsserControls, plan, state), "CUT_AUDIO_DEESSER_CONTROL", /controls|intensity|amount/);

  expectCoreError(() => processReferenceDeEsserFrame(Number.NaN, 0, { intensity: 1, amount: 1 }, plan, createReferenceDeEsserState()), "CUT_AUDIO_DEESSER_PCM", /finite/);
  expectCoreError(() => processReferenceDeEsserFrame(referenceDeEsserCoreLimits.maximumAbsoluteInputSample + 1, 0, { intensity: 1, amount: 1 }, plan, createReferenceDeEsserState()), "CUT_AUDIO_DEESSER_PCM", /bounded/);
  expectCoreError(() => processReferenceDeEsserPcm(new Float64Array(3), { intensity: 1, amount: 1 }, plan), "CUT_AUDIO_DEESSER_PCM", /interleaved stereo/);
  expectCoreError(() => processReferenceDeEsserPcm(new Float64Array(4), [{ intensity: 1, amount: 1 }], plan), "CUT_AUDIO_DEESSER_CONTROL", /exactly 2/);
  expectCoreError(() => processReferenceDeEsserFrame(0, 0, { intensity: 1, amount: 1 }, plan, { lowLeft: 65, lowRight: 0, envelope: 0, framesProcessed: 0 }), "CUT_AUDIO_DEESSER_STATE", /bounded/);
  expectCoreError(() => processReferenceDeEsserFrame(0, 0, { intensity: 1, amount: 1 }, plan, { lowLeft: 0, lowRight: 0, envelope: 0, framesProcessed: Number.MAX_SAFE_INTEGER }), "CUT_AUDIO_DEESSER_STATE", /incrementable/);
  expectCoreError(() => processReferenceDeEsserFrame(0, 0, { intensity: 1, amount: 1 }, { ...plan, attackCoefficient: 0 }, createReferenceDeEsserState()), "CUT_AUDIO_DEESSER_CONFIG", /canonical/);
});

test("closed data boundaries reject accessors, symbols, hidden keys, and tampered derived plan fields", () => {
  const config = defaultReferenceDeEsserConfig(48_000), plan = compileReferenceDeEsserPlan(config), controls = { intensity: 1, amount: 1 };
  let getterCalls = 0;

  const accessorConfig = { ...config } as Record<string, unknown>;
  Object.defineProperty(accessorConfig, "attackSeconds", { enumerable: true, get() { getterCalls += 1; return 0.001; } });
  expectCoreError(() => compileReferenceDeEsserPlan(accessorConfig as ReferenceDeEsserConfig), "CUT_AUDIO_DEESSER_CONFIG", /enumerable data/);
  assert.equal(getterCalls, 0, "configuration getter executed");

  const accessorPlan = { ...plan } as Record<string, unknown>;
  Object.defineProperty(accessorPlan, "releaseCoefficient", { enumerable: true, get() { getterCalls += 1; return plan.releaseCoefficient; } });
  expectCoreError(() => processReferenceDeEsserFrame(0, 0, controls, accessorPlan as unknown as typeof plan, createReferenceDeEsserState()), "CUT_AUDIO_DEESSER_CONFIG", /enumerable data/);
  assert.equal(getterCalls, 0, "plan getter executed");

  const accessorControls = { amount: 1 } as Record<string, unknown>;
  Object.defineProperty(accessorControls, "intensity", { enumerable: true, get() { getterCalls += 1; return 1; } });
  expectCoreError(() => processReferenceDeEsserFrame(0, 0, accessorControls as ReferenceDeEsserControls, plan, createReferenceDeEsserState()), "CUT_AUDIO_DEESSER_CONTROL", /enumerable data/);
  assert.equal(getterCalls, 0, "control getter executed");

  const accessorState = createReferenceDeEsserState() as unknown as Record<string, unknown>;
  Object.defineProperty(accessorState, "lowLeft", { enumerable: true, get() { getterCalls += 1; return 0; } });
  expectCoreError(() => processReferenceDeEsserFrame(0, 0, controls, plan, accessorState as unknown as ReturnType<typeof createReferenceDeEsserState>), "CUT_AUDIO_DEESSER_STATE", /enumerable data/);
  assert.equal(getterCalls, 0, "state getter executed");
  expectCoreError(() => processReferenceDeEsserFrame(0, 0, controls, plan, Object.freeze(createReferenceDeEsserState())), "CUT_AUDIO_DEESSER_STATE", /writable data/);

  const symbolConfig = { ...config, [Symbol("hidden")]: 1 };
  expectCoreError(() => compileReferenceDeEsserPlan(symbolConfig), "CUT_AUDIO_DEESSER_CONFIG", /symbol/);
  const hiddenConfig = { ...config };
  Object.defineProperty(hiddenConfig, "crossoverHz", { value: config.crossoverHz, enumerable: false });
  expectCoreError(() => compileReferenceDeEsserPlan(hiddenConfig), "CUT_AUDIO_DEESSER_CONFIG", /enumerable data/);

  for (const candidate of [
    { ...plan, crossoverCoefficient: plan.crossoverCoefficient * 0.99 },
    { ...plan, attackCoefficient: (plan.attackCoefficient + plan.releaseCoefficient) / 2 },
    { ...plan, releaseCoefficient: (plan.releaseCoefficient + 1) / 2 },
    { ...plan, crossoverHz: 5_000 },
    { ...plan, attackSeconds: 0.001 },
    { ...plan, releaseSeconds: 0.1 },
  ]) expectCoreError(() => processReferenceDeEsserFrame(0, 0, controls, candidate, createReferenceDeEsserState()), "CUT_AUDIO_DEESSER_CONFIG", /canonical/);

  const hostile = Object.create(null) as Record<PropertyKey, unknown>;
  Object.assign(hostile, config);
  hostile[`bad\0\n${"x".repeat(20_000)}😀`] = 1;
  assert.throws(() => compileReferenceDeEsserPlan(hostile as unknown as ReferenceDeEsserConfig), (error: unknown) => {
    assert.ok(error instanceof ReferenceDeEsserCoreError);
    assert.equal(error.code, "CUT_AUDIO_DEESSER_CONFIG");
    assert.ok(error.message.length < 512);
    assert.doesNotMatch(error.message, /[\0\n]/u);
    return true;
  });
});

test("time-varying control arrays are dense ordinary data and never execute accessors", () => {
  const plan = compileReferenceDeEsserPlan(defaultReferenceDeEsserConfig(48_000)), input = new Float64Array(4), value = { intensity: 1, amount: 1 };
  const sparse = new Array<ReferenceDeEsserControls>(2); sparse[0] = value;
  expectCoreError(() => processReferenceDeEsserPcm(input, sparse, plan), "CUT_AUDIO_DEESSER_CONTROL", /dense/);

  let getterCalls = 0;
  const accessorEntries = [value, value];
  Object.defineProperty(accessorEntries, "1", { enumerable: true, get() { getterCalls += 1; return value; } });
  expectCoreError(() => processReferenceDeEsserPcm(input, accessorEntries, plan), "CUT_AUDIO_DEESSER_CONTROL", /enumerable data/);
  assert.equal(getterCalls, 0, "array entry getter executed");

  const accessorValue = { amount: 1 } as Record<string, unknown>;
  Object.defineProperty(accessorValue, "intensity", { enumerable: true, get() { getterCalls += 1; return 1; } });
  expectCoreError(() => processReferenceDeEsserPcm(input, [value, accessorValue as ReferenceDeEsserControls], plan), "CUT_AUDIO_DEESSER_CONTROL", /enumerable data/);
  assert.equal(getterCalls, 0, "control value getter executed");

  const extra = [value, value] as Array<ReferenceDeEsserControls> & { extra?: number };
  extra.extra = 1;
  expectCoreError(() => processReferenceDeEsserPcm(input, extra, plan), "CUT_AUDIO_DEESSER_CONTROL", /non-index/);
  const symbol = [value, value]; Object.defineProperty(symbol, Symbol("hidden"), { value: 1, enumerable: true });
  expectCoreError(() => processReferenceDeEsserPcm(input, symbol, plan), "CUT_AUDIO_DEESSER_CONTROL", /symbol|non-index/);
  const hidden = [value, value]; Object.defineProperty(hidden, "1", { value, enumerable: false });
  expectCoreError(() => processReferenceDeEsserPcm(input, hidden, plan), "CUT_AUDIO_DEESSER_CONTROL", /enumerable data/);
});

test("composition and in-memory work budgets pass exactly at their boundaries", () => {
  const nodes = referenceDeEsserCoreLimits.maximumNodesPerComposition;
  const boundaryFrames = referenceDeEsserCoreLimits.maximumChannelSamplesPerComposition / (2 * nodes);
  assert.deepEqual(planReferenceDeEsserWork(boundaryFrames, nodes), {
    frames: boundaryFrames,
    nodes,
    channelSamples: referenceDeEsserCoreLimits.maximumChannelSamplesPerComposition,
  });
  expectCoreError(() => planReferenceDeEsserWork(boundaryFrames + 1, nodes), "CUT_AUDIO_DEESSER_WORK_LIMIT", /channel-samples/);
  expectCoreError(() => planReferenceDeEsserWork(1, nodes + 1), "CUT_AUDIO_DEESSER_WORK_LIMIT", /nodes/);
  expectCoreError(() => planReferenceDeEsserWork(Number.MAX_SAFE_INTEGER, 1), "CUT_AUDIO_DEESSER_WORK_LIMIT", /unsafe number|channel-samples/);
  assert.equal(planReferenceDeEsserBatch(referenceDeEsserCoreLimits.maximumBatchFrames).frames, referenceDeEsserCoreLimits.maximumBatchFrames);
  expectCoreError(() => planReferenceDeEsserBatch(referenceDeEsserCoreLimits.maximumBatchFrames + 1), "CUT_AUDIO_DEESSER_WORK_LIMIT", /in-memory/);
});

test("the core publishes explicit non-claims instead of implying a complete dialogue processor", () => {
  assert.ok(Object.isFrozen(referenceDeEsserCoreNonClaims));
  assert.deepEqual(referenceDeEsserCoreNonClaims, [
    "dialogue-or-phoneme classification",
    "lookahead or linear-phase crossover",
    "multiband dynamics or key equalization",
    "true-peak or loudness mastering",
    "portable floating-point byte identity",
    "production dialogue listening approval",
  ]);
});
