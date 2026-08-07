import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeReferenceAudioReactiveStereo,
  compileReferenceAudioReactiveAnalysisPlan,
  referenceAudioReactiveAnalysisCacheKey,
  referenceAudioReactiveAnalysisLimits,
  referenceAudioReactiveAnalysisNonClaims,
  ReferenceAudioReactiveAnalysisError,
  type ReferenceAudioReactiveAnalysisPlanInput,
  type ReferenceAudioReactiveDetector,
} from "../lib/runtime/reference/audio-reactive-analysis";
import { compareRational, rational, rationalToNumber } from "../lib/language/rational";

const sha = (digit: string) => digit.repeat(64);

function inputPlan(
  frames: number,
  detector: ReferenceAudioReactiveDetector = "peak",
  overrides: Partial<ReferenceAudioReactiveAnalysisPlanInput> = {},
): ReferenceAudioReactiveAnalysisPlanInput {
  return {
    source: {
      activeVariant: "master",
      lockedResourceSha256: sha("1"),
      selectedStreamIndex: 2,
      selectedStreamSampleRate: 8_000,
      selectedStreamIdentitySha256: sha("2"),
      decoderIntegritySha256: sha("3"),
    },
    sampleRate: 8_000,
    range: { startFrame: 80, endFrame: 80 + frames },
    compositionStartFrame: 40,
    windowFrames: 4,
    hopFrames: 2,
    detector,
    channelMode: "stereo-linked",
    normalization: {
      kind: detector === "peak" ? "peak-linear" : "rms-linear",
      floor: rational(0),
      ceiling: rational(1),
    },
    smoothing: { kind: "attack-release-one-pole", attackFrames: 4, releaseFrames: 8 },
    ...overrides,
  };
}

function stereo(frames: number, sample: (frame: number) => readonly [number, number]) {
  const result = new Float32Array(frames * 2);
  for (let frame = 0; frame < frames; frame += 1) {
    const [left, right] = sample(frame);
    result[frame * 2] = left;
    result[frame * 2 + 1] = right;
  }
  return result;
}

function assertError(
  action: () => unknown,
  code: ReferenceAudioReactiveAnalysisError["code"],
  message: RegExp,
) {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ReferenceAudioReactiveAnalysisError);
    assert.equal(error.code, code);
    assert.match(error.message, message);
    return true;
  });
}

test("causal windows use only complete past samples and retain exact source/composition clocks", () => {
  const frames = 12;
  const before = stereo(frames, (frame) => frame < 4 ? [0.25, -0.5] : [0, 0]);
  const changedAtEventAndFuture = stereo(frames, (frame) => frame < 4 ? [0.25, -0.5] : [1, -1]);
  const plan = compileReferenceAudioReactiveAnalysisPlan(inputPlan(frames));
  const first = analyzeReferenceAudioReactiveStereo(before, plan);
  const changed = analyzeReferenceAudioReactiveStereo(changedAtEventAndFuture, plan);

  assert.equal(plan.windowAlignment, "trailing-full-window-end-exclusive");
  assert.equal(plan.windowCount, 4);
  assert.deepEqual(first.windows[0], {
    index: 0,
    sourceStartFrame: 80,
    sourceEndFrame: 84,
    compositionFrame: 44,
    compositionTime: rational(11, 2_000),
    detectorAmplitude: 0.5,
    smoothedAmplitude: 0.5,
    ratioUnits: 500_000,
    value: { kind: "quantity", dimension: "ratio", magnitude: rational(1, 2), unit: "ratio" },
  });
  assert.deepEqual(changed.windows[0], first.windows[0], "the sample at event frame 4 and every later sample must not affect the event at frame 4");
  assert.notDeepEqual(changed.windows.slice(1), first.windows.slice(1), "later causal windows must still observe the changed future after their own boundaries");
  assert.equal(first.signal.clock.kind, "composition-sample");
  assert.equal(first.signal.clock.sampleRate, 8_000);
  assert.equal(first.signal.valueType, "Ratio");
});

test("peak and RMS are distinct stereo-linked linear-amplitude detectors with matching normalization kinds", () => {
  const frames = 10;
  const pcm = stereo(frames, () => [0.25, -0.75]);
  const peakPlan = compileReferenceAudioReactiveAnalysisPlan(inputPlan(frames, "peak"));
  const rmsPlan = compileReferenceAudioReactiveAnalysisPlan(inputPlan(frames, "rms"));
  const peak = analyzeReferenceAudioReactiveStereo(pcm, peakPlan);
  const rms = analyzeReferenceAudioReactiveStereo(pcm, rmsPlan);

  assert.equal(peakPlan.normalization.kind, "peak-linear");
  assert.equal(rmsPlan.normalization.kind, "rms-linear");
  assert.equal(peak.windows[0]!.detectorAmplitude, 0.75, "peak is max(abs(left), abs(right)) over the full window");
  assert.ok(Math.abs(rms.windows[0]!.detectorAmplitude - Math.sqrt(0.3125)) < 1e-15, "RMS averages both channel-samples before sqrt");
  assert.equal(peak.windows[0]!.ratioUnits, 750_000);
  assert.equal(rms.windows[0]!.ratioUnits, Math.round(Math.sqrt(0.3125) * 1_000_000));
  assert.notEqual(peakPlan.integrity, rmsPlan.integrity);
  assert.notEqual(peak.signalSha256, rms.signalSha256);

  const swapped = analyzeReferenceAudioReactiveStereo(stereo(frames, () => [-0.75, 0.25]), peakPlan);
  assert.deepEqual(swapped.windows.map((window) => window.ratioUnits), peak.windows.map((window) => window.ratioUnits), "stereo-linked peak is invariant to channel order");
  assert.equal(swapped.signalSha256, peak.signalSha256);
  assert.notEqual(swapped.inputPcmSha256, peak.inputPcmSha256, "exact content identity still distinguishes channel-swapped PCM");
  assert.notEqual(swapped.contentIntegrity, peak.contentIntegrity);
});

test("silence is exact and constant envelopes are identified without redundant hop events", () => {
  const frames = 12;
  const plan = compileReferenceAudioReactiveAnalysisPlan(inputPlan(frames));
  const silence = analyzeReferenceAudioReactiveStereo(new Float32Array(frames * 2), plan);
  assert.equal(silence.windowVariation, "silence");
  assert.equal(silence.hasMeasuredModulation, false);
  assert.equal(silence.maximumDetectorAmplitude, 0);
  assert.equal(silence.maximumSmoothedAmplitude, 0);
  assert.deepEqual(silence.windows.map((window) => window.ratioUnits), [0, 0, 0, 0]);
  assert.deepEqual(silence.signal.events, [], "silence is the canonical constant-zero Ratio track, not four fake modulation events");
  assert.deepEqual(silence.signal.initial, { kind: "quantity", dimension: "ratio", magnitude: rational(0), unit: "ratio" });

  const constant = analyzeReferenceAudioReactiveStereo(stereo(frames, () => [0.5, -0.5]), plan);
  assert.equal(constant.windowVariation, "constant");
  assert.equal(constant.hasMeasuredModulation, false);
  assert.deepEqual(constant.windows.map((window) => window.ratioUnits), [500_000, 500_000, 500_000, 500_000]);
  assert.equal(constant.signal.events.length, 2, "one value-change event plus one scope reset replaces repeated identical hop events");
  assert.equal(rationalToNumber(constant.signal.events[0]!.value.magnitude), 0.5);
  assert.deepEqual(constant.signal.events[1], {
    kind: "set",
    time: rational(13, 2_000),
    value: { kind: "quantity", dimension: "ratio", magnitude: rational(0), unit: "ratio" },
  });
  for (let index = 0; index < constant.signal.events.length; index += 1) {
    const event = constant.signal.events[index]!;
    assert.deepEqual(event.time, rational(event.time.numerator, event.time.denominator), "event time must be a reduced canonical rational");
    assert.deepEqual(event.value.magnitude, rational(event.value.magnitude.numerator, event.value.magnitude.denominator), "Ratio magnitude must be a reduced canonical rational");
    if (index === 0) continue;
    assert.equal(compareRational(event.time, constant.signal.events[index - 1]!.time) > 0, true, "canonical events must be strictly time-ordered");
    assert.notDeepEqual(event.value, constant.signal.events[index - 1]!.value, "canonical events must always change the held value");
  }
});

test("impulse and step fixtures exercise exact RMS/peak windows and attack/release state", () => {
  const frames = 16;
  const impulse = stereo(frames, (frame) => frame === 1 ? [1, 0] : [0, 0]);
  const rms = analyzeReferenceAudioReactiveStereo(impulse, compileReferenceAudioReactiveAnalysisPlan(inputPlan(frames, "rms")));
  assert.ok(Math.abs(rms.windows[0]!.detectorAmplitude - Math.sqrt(1 / 8)) < 1e-15);
  assert.equal(rms.windows[1]!.detectorAmplitude, 0);
  assert.ok(rms.windows[1]!.smoothedAmplitude > 0 && rms.windows[1]!.smoothedAmplitude < rms.windows[0]!.smoothedAmplitude, "release must retain and decay the impulse envelope");

  const step = stereo(frames, (frame) => frame >= 4 && frame < 8 ? [1, -1] : [0, 0]);
  const peak = analyzeReferenceAudioReactiveStereo(step, compileReferenceAudioReactiveAnalysisPlan(inputPlan(frames)));
  assert.deepEqual(peak.windows.map((window) => window.detectorAmplitude), [0, 1, 1, 1, 0, 0]);
  const attack = Math.exp(-2 / 4), release = Math.exp(-2 / 8);
  const expected = [
    0,
    1 - attack,
    1 - attack ** 2,
    1 - attack ** 3,
    (1 - attack ** 3) * release,
    (1 - attack ** 3) * release ** 2,
  ];
  peak.windows.forEach((window, index) => assert.ok(Math.abs(window.smoothedAmplitude - expected[index]!) < 1e-15, `window ${index} attack/release envelope`));
  assert.equal(peak.windowVariation, "varying");
  assert.equal(peak.hasMeasuredModulation, true);
});

test("plan, cache, decoded PCM, typed signal, and content identities repeat exactly", () => {
  const frames = 16;
  const pcm = stereo(frames, (frame) => [Math.fround(Math.sin(frame * 0.7) * 0.6), Math.fround(Math.cos(frame * 0.3) * 0.4)]);
  const firstPlan = compileReferenceAudioReactiveAnalysisPlan(inputPlan(frames, "rms"));
  const secondPlan = compileReferenceAudioReactiveAnalysisPlan(inputPlan(frames, "rms"));
  const first = analyzeReferenceAudioReactiveStereo(pcm, firstPlan);
  const second = analyzeReferenceAudioReactiveStereo(pcm, secondPlan);

  assert.equal(firstPlan.integrity, secondPlan.integrity);
  assert.equal(referenceAudioReactiveAnalysisCacheKey(firstPlan), referenceAudioReactiveAnalysisCacheKey(secondPlan));
  assert.deepEqual(first, second);
  assert.match(firstPlan.integrity, /^[a-f0-9]{64}$/u);
  assert.match(first.inputPcmSha256, /^[a-f0-9]{64}$/u);
  assert.match(first.signalSha256, /^[a-f0-9]{64}$/u);
  assert.match(first.contentIntegrity, /^[a-f0-9]{64}$/u);
  assert.equal(first.processedChannelSamples, firstPlan.windowCount * firstPlan.windowFrames * 2);
  assert.deepEqual({
    plan: firstPlan.integrity,
    cache: first.cacheKey,
    input: first.inputPcmSha256,
    signal: first.signalSha256,
    content: first.contentIntegrity,
  }, {
    plan: "a99ba18fa19963e868cb05b2c13e40c2e393bdab3dbd29e0960cbd320b095d65",
    cache: "c627c15f0a26c4be355abbada9bfe296e3987adcc39362a56e05ad9873f094db",
    input: "3f7bd98cba0bd5b043f5a56e9651c764abc0eadc510a3e2b3f1299cdf61f47e0",
    signal: "a2742f6eef4f61ea346dba4e2d4ca12baaf80c6f1549a9fd270312ffdada05ef",
    content: "e02148dfa834040e6d08e7d2e7528269ed02d308a021a1749036323c0ae2390d",
  });

  const sourceChanged = compileReferenceAudioReactiveAnalysisPlan(inputPlan(frames, "rms", {
    source: { ...inputPlan(frames).source, lockedResourceSha256: sha("4") },
  }));
  assert.notEqual(sourceChanged.integrity, firstPlan.integrity);
  assert.notEqual(referenceAudioReactiveAnalysisCacheKey(sourceChanged), first.cacheKey);
});

test("strict validators refuse malformed, inert, forged, non-finite, and over-budget inputs", () => {
  const frames = 12;
  const goodInput = inputPlan(frames);
  assertError(
    () => compileReferenceAudioReactiveAnalysisPlan(Object.assign(Object.create({ inherited: true }), goodInput)),
    "CUT_AUDIO_REACTIVE_TYPE",
    /plain or null prototype/,
  );
  const accessor = { ...goodInput } as Record<string, unknown>;
  Object.defineProperty(accessor, "detector", { enumerable: true, get: () => "peak" });
  assertError(() => compileReferenceAudioReactiveAnalysisPlan(accessor as unknown as ReferenceAudioReactiveAnalysisPlanInput), "CUT_AUDIO_REACTIVE_TYPE", /enumerable data property/);
  assertError(
    () => compileReferenceAudioReactiveAnalysisPlan({ ...goodInput, channelMode: "left" as "stereo-linked" }),
    "CUT_AUDIO_REACTIVE_VALUE",
    /channelMode/,
  );
  assertError(
    () => compileReferenceAudioReactiveAnalysisPlan({ ...goodInput, normalization: { kind: "rms-linear", floor: rational(0), ceiling: rational(1) } }),
    "CUT_AUDIO_REACTIVE_VALUE",
    /peak detection requires.*peak-linear/,
  );
  assertError(
    () => compileReferenceAudioReactiveAnalysisPlan({ ...goodInput, normalization: { kind: "peak-linear", floor: rational(1), ceiling: rational(1) } }),
    "CUT_AUDIO_REACTIVE_NOOP",
    /strictly greater/,
  );
  const indistinguishableDenominator = `1${"0".repeat(255)}`;
  assertError(
    () => compileReferenceAudioReactiveAnalysisPlan({
      ...goodInput,
      normalization: {
        kind: "peak-linear",
        floor: rational(1),
        ceiling: rational((BigInt(indistinguishableDenominator) + 1n).toString(), indistinguishableDenominator),
      },
    }),
    "CUT_AUDIO_REACTIVE_VALUE",
    /finite and distinct/,
  );
  assertError(
    () => compileReferenceAudioReactiveAnalysisPlan({ ...goodInput, range: { startFrame: 80, endFrame: 80 } }),
    "CUT_AUDIO_REACTIVE_NOOP",
    /non-empty/,
  );
  assertError(
    () => compileReferenceAudioReactiveAnalysisPlan({ ...goodInput, range: { startFrame: 80, endFrame: 81 } }),
    "CUT_AUDIO_REACTIVE_NOOP",
    /full causal window/,
  );
  assertError(
    () => compileReferenceAudioReactiveAnalysisPlan({ ...goodInput, windowFrames: frames }),
    "CUT_AUDIO_REACTIVE_VALUE",
    /windowFrames/,
  );
  assertError(
    () => compileReferenceAudioReactiveAnalysisPlan({ ...goodInput, hopFrames: 5 }),
    "CUT_AUDIO_REACTIVE_VALUE",
    /hopFrames/,
  );
  assertError(
    () => compileReferenceAudioReactiveAnalysisPlan({ ...goodInput, smoothing: { kind: "attack-release-one-pole", attackFrames: 0, releaseFrames: 8 } }),
    "CUT_AUDIO_REACTIVE_VALUE",
    /attackFrames/,
  );
  assertError(
    () => compileReferenceAudioReactiveAnalysisPlan({ ...goodInput, source: { ...goodInput.source, decoderIntegritySha256: "not-a-digest" } }),
    "CUT_AUDIO_REACTIVE_IDENTITY",
    /SHA-256/,
  );

  assertError(
    () => compileReferenceAudioReactiveAnalysisPlan(inputPlan(200_000, "peak", { windowFrames: 1, hopFrames: 1 })),
    "CUT_AUDIO_REACTIVE_RESOURCE",
    /emit .* windows/,
  );
  assertError(
    () => compileReferenceAudioReactiveAnalysisPlan(inputPlan(28_800_000, "peak", { windowFrames: 2_048, hopFrames: 256 })),
    "CUT_AUDIO_REACTIVE_RESOURCE",
    /detector work/,
  );

  const plan = compileReferenceAudioReactiveAnalysisPlan(goodInput);
  const forged = { ...plan, hopFrames: 1 };
  assertError(() => analyzeReferenceAudioReactiveStereo(new Float32Array(frames * 2), forged), "CUT_AUDIO_REACTIVE_IDENTITY", /canonical derived fields and integrity/);
  assertError(() => analyzeReferenceAudioReactiveStereo(new Float32Array(frames * 2 - 1), plan), "CUT_AUDIO_REACTIVE_PCM", /complete interleaved stereo/);
  assertError(() => analyzeReferenceAudioReactiveStereo(new Float32Array(frames * 2 - 2), plan), "CUT_AUDIO_REACTIVE_PCM", /exactly 12 stereo frames/);
  const nonFinite = new Float32Array(frames * 2); nonFinite[5] = Number.NaN;
  assertError(() => analyzeReferenceAudioReactiveStereo(nonFinite, plan), "CUT_AUDIO_REACTIVE_PCM", /finite/);
  class Float32Subclass extends Float32Array {}
  assertError(() => analyzeReferenceAudioReactiveStereo(new Float32Subclass(frames * 2), plan), "CUT_AUDIO_REACTIVE_PCM", /direct non-shared/);

  assert.equal(referenceAudioReactiveAnalysisLimits.maximumAbsoluteInputSample, 64);
  assert.ok(referenceAudioReactiveAnalysisNonClaims.includes("frequency-band analysis"));
  assert.ok(referenceAudioReactiveAnalysisNonClaims.includes("onset, beat, or tempo detection"));
});
