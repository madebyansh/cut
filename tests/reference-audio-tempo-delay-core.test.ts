import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  compileReferenceTempoDelayPlan,
  compileReferenceTempoMap,
  processReferenceTempoDelayStereo,
  referenceTempoBeatAtFrame,
  referenceTempoDelayLimits,
  referenceTempoDelayNonClaims,
  referenceTempoDelaySourceFrameAt,
  referenceTempoFrameAtBeat,
  ReferenceTempoDelayError,
} from "../lib/runtime/reference/audio-tempo-delay";
import { rational } from "../lib/language/rational";

const point = (atNumerator: number, atDenominator: number, bpmNumerator: number, bpmDenominator = 1) => ({
  at: rational(atNumerator, atDenominator),
  bpm: rational(bpmNumerator, bpmDenominator),
});

function assertError(action: () => unknown, code: ReferenceTempoDelayError["code"], message: RegExp) {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ReferenceTempoDelayError);
    assert.equal(error.code, code);
    assert.match(error.message, message);
    return true;
  });
}

test("piecewise tempo map has exact boundary ownership and invertible beat positions", () => {
  const tempo = compileReferenceTempoMap({
    sampleRate: 48_000,
    totalFrames: 144_000,
    points: [point(0, 1, 120), point(1, 1, 60), point(2, 1, 240)],
  });
  assert.equal(tempo.format, "cut-reference-tempo-map");
  assert.equal(tempo.version, 1);
  assert.deepEqual(tempo.segments.map((segment) => ({
    frames: [segment.startFrame, segment.endFrame],
    beats: [segment.startBeat, segment.endBeat],
    bpm: segment.bpm,
  })), [
    { frames: [0, 48_000], beats: [rational(0), rational(2)], bpm: rational(120) },
    { frames: [48_000, 96_000], beats: [rational(2), rational(3)], bpm: rational(60) },
    { frames: [96_000, 144_000], beats: [rational(3), rational(7)], bpm: rational(240) },
  ]);
  assert.deepEqual(referenceTempoBeatAtFrame(tempo, 47_999), rational(47_999, 24_000));
  assert.deepEqual(referenceTempoBeatAtFrame(tempo, 48_000), rational(2));
  assert.deepEqual(referenceTempoBeatAtFrame(tempo, 48_001), rational(96_001, 48_000));
  assert.deepEqual(referenceTempoBeatAtFrame(tempo, 96_000), rational(3));
  assert.deepEqual(referenceTempoBeatAtFrame(tempo, 144_000), rational(7));
  assert.deepEqual(referenceTempoFrameAtBeat(tempo, rational(2)), rational(48_000));
  assert.deepEqual(referenceTempoFrameAtBeat(tempo, rational(3)), rational(96_000));
  assert.deepEqual(referenceTempoFrameAtBeat(tempo, rational(7)), rational(144_000));
  assert.equal(referenceTempoFrameAtBeat(tempo, rational(8)), undefined);

  const repeated = compileReferenceTempoMap({
    sampleRate: 48_000,
    totalFrames: 144_000,
    points: [point(0, 1, 120), point(1, 1, 60), point(2, 1, 240)],
  });
  assert.equal(tempo.integrity, repeated.integrity);
  assert.notEqual(tempo.integrity, compileReferenceTempoMap({
    sampleRate: 48_000,
    totalFrames: 144_000,
    points: [point(0, 1, 120), point(1, 1, 61), point(2, 1, 240)],
  }).integrity);
});

test("tempo delay exact lookup crosses both destination and source tempo boundaries without restart", () => {
  const tempo = compileReferenceTempoMap({
    sampleRate: 48_000,
    totalFrames: 144_000,
    points: [point(0, 1, 120), point(1, 1, 60), point(2, 1, 240)],
  });
  const plan = compileReferenceTempoDelayPlan({ tempo, delayBeats: rational(1), feedback: 0.5, mix: 0.4 });
  assert.equal(plan.firstEchoFrame, 24_000);
  assert.deepEqual(referenceTempoDelaySourceFrameAt(plan, 23_999), undefined);
  assert.deepEqual(referenceTempoDelaySourceFrameAt(plan, 24_000), rational(0));
  assert.deepEqual(referenceTempoDelaySourceFrameAt(plan, 47_999), rational(23_999));
  assert.deepEqual(referenceTempoDelaySourceFrameAt(plan, 48_000), rational(24_000));
  assert.deepEqual(referenceTempoDelaySourceFrameAt(plan, 95_999), rational(95_999, 2));
  assert.deepEqual(referenceTempoDelaySourceFrameAt(plan, 96_000), rational(48_000));
  // Destination now advances four times faster than the 60 BPM source segment.
  assert.deepEqual(referenceTempoDelaySourceFrameAt(plan, 96_001), rational(48_004));
  assert.deepEqual(referenceTempoDelaySourceFrameAt(plan, 107_999), rational(95_996));
  // target beat 3 is owned by the 240 BPM source segment at its exact boundary.
  assert.deepEqual(referenceTempoDelaySourceFrameAt(plan, 108_000), rational(96_000));
  assert.deepEqual(referenceTempoDelaySourceFrameAt(plan, 108_001), rational(96_001));
  assert.equal(plan.spans.some((span) => span.destinationTempoIndex === 2 && span.sourceTempoIndex === 1), true);
  assert.equal(plan.spans.some((span) => span.destinationTempoIndex === 2 && span.sourceTempoIndex === 2), true);
});

test("constant tempo delay matches the exact one-tap ordinary-delay equation and bounded recursive repeats", () => {
  const frames = 2_400, sampleRate = 48_000;
  const tempo = compileReferenceTempoMap({ sampleRate, totalFrames: frames, points: [point(0, 1, 120)] });
  // 1/50 beat at 120 BPM is exactly 10 ms = 480 samples.
  const oneTap = compileReferenceTempoDelayPlan({ tempo, delayBeats: rational(1, 50), feedback: 0, mix: 1 });
  const impulse = new Float32Array(frames * 2);
  impulse[0] = 0.75; impulse[1] = -0.25;
  const delayed = processReferenceTempoDelayStereo(impulse, oneTap);
  assert.equal(oneTap.firstEchoFrame, 480);
  assert.equal(delayed.samples[0], 0);
  assert.equal(delayed.samples[1], 0);
  assert.equal(delayed.samples[480 * 2], 0.75);
  assert.equal(delayed.samples[480 * 2 + 1], -0.25);
  for (let frame = 0; frame < frames; frame += 1) {
    for (const channel of [0, 1]) {
      const expected = frame === 480 ? impulse[channel]! : 0;
      assert.equal(delayed.samples[frame * 2 + channel], expected, `ordinary one-tap parity ${frame}:${channel}`);
    }
  }

  const recursive = processReferenceTempoDelayStereo(impulse, compileReferenceTempoDelayPlan({
    tempo,
    delayBeats: rational(1, 50),
    feedback: 0.5,
    mix: 1,
  }));
  assert.equal(recursive.samples[480 * 2], 0.75);
  assert.equal(recursive.samples[960 * 2], 0.375);
  assert.equal(recursive.samples[1_440 * 2], 0.1875);
  assert.equal(recursive.samples[480 * 2 + 1], -0.25);
  assert.equal(recursive.samples[960 * 2 + 1], -0.125);
  assert.equal(recursive.samples[1_440 * 2 + 1], -0.0625);
  assert.equal(recursive.delayedFrames, frames - 480);
  assert.equal(recursive.integrity, processReferenceTempoDelayStereo(impulse, compileReferenceTempoDelayPlan({
    tempo,
    delayBeats: rational(1, 50),
    feedback: 0.5,
    mix: 1,
  })).integrity);
  assert.equal(createHash("sha256").update(recursive.samples).digest("hex"), "a5f668e45928e2814e2918c102d2202eb644032c0f9da8f124027ff92b625f5e");
});

test("authored tempo change moves later repeats while samples before the boundary remain exact", () => {
  const sampleRate = 48_000, frames = 60_000;
  const slow = compileReferenceTempoMap({ sampleRate, totalFrames: frames, points: [point(0, 1, 120)] });
  const accelerated = compileReferenceTempoMap({ sampleRate, totalFrames: frames, points: [point(0, 1, 120), point(1, 2, 240)] });
  const input = new Float32Array(frames * 2); input[0] = input[1] = 1;
  const settings = { delayBeats: rational(1), feedback: 0.5, mix: 1 };
  const baseline = processReferenceTempoDelayStereo(input, compileReferenceTempoDelayPlan({ tempo: slow, ...settings }));
  const changed = processReferenceTempoDelayStereo(input, compileReferenceTempoDelayPlan({ tempo: accelerated, ...settings }));
  const boundary = 24_000;
  for (let index = 0; index <= boundary * 2 + 1; index += 1) assert.equal(changed.samples[index], baseline.samples[index], `pre-boundary sample ${index}`);
  assert.equal(changed.samples[boundary * 2], 1, "first echo lands on the shared tempo boundary");
  assert.equal(changed.samples[36_000 * 2], 0.5, "faster post-boundary beat clock moves repeat two to 750 ms");
  assert.equal(baseline.samples[36_000 * 2], 0, "constant 120 BPM has no repeat at 750 ms");
  assert.equal(baseline.samples[48_000 * 2], 0.5, "constant 120 BPM repeat two remains at 1 s");
  assert.equal(changed.samples[48_000 * 2], 0.25, "accelerated map reaches repeat three at 1 s instead of retaining the old repeat-two timing");
});

test("tempo map and delay fail closed for hostile types, order, grid, inert mix, causality, and resource limits", () => {
  assertError(() => compileReferenceTempoMap({ sampleRate: 48_000, totalFrames: 1_000, points: [] }), "CUT_AUDIO_TEMPO_MAP_VALUE", /1 through 256 points/);
  assertError(() => compileReferenceTempoMap({ sampleRate: 48_000, totalFrames: 1_000, points: [point(1, 48_000, 120)] }), "CUT_AUDIO_TEMPO_MAP_ORDER", /begin.*0s/);
  assertError(() => compileReferenceTempoMap({ sampleRate: 48_000, totalFrames: 1_000, points: [point(0, 1, 120), point(1, 10_000, 140)] }), "CUT_AUDIO_TEMPO_MAP_SAMPLE_GRID", /sample grid/);
  assertError(() => compileReferenceTempoMap({ sampleRate: 48_000, totalFrames: 1_000, points: [point(0, 1, 401)] }), "CUT_AUDIO_TEMPO_MAP_VALUE", /between 20 and 400/);
  assertError(() => compileReferenceTempoMap({ sampleRate: 48_000, totalFrames: 1_000, points: [point(0, 1, 120), point(0, 1, 140)] }), "CUT_AUDIO_TEMPO_MAP_ORDER", /strictly later/);

  const tempo = compileReferenceTempoMap({ sampleRate: 48_000, totalFrames: 48_000, points: [point(0, 1, 120)] });
  assertError(() => compileReferenceTempoDelayPlan({ tempo, delayBeats: rational(0), feedback: 0.5, mix: 0.25 }), "CUT_AUDIO_TEMPO_DELAY_VALUE", /greater than zero/);
  assertError(() => compileReferenceTempoDelayPlan({ tempo, delayBeats: rational(17), feedback: 0.5, mix: 0.25 }), "CUT_AUDIO_TEMPO_DELAY_VALUE", /at most 16/);
  assertError(() => compileReferenceTempoDelayPlan({ tempo, delayBeats: rational(1), feedback: 0.951, mix: 0.25 }), "CUT_AUDIO_TEMPO_DELAY_VALUE", /0 through 0.95/);
  assertError(() => compileReferenceTempoDelayPlan({ tempo, delayBeats: rational(1), feedback: 0.5, mix: 0 }), "CUT_AUDIO_TEMPO_DELAY_VALUE", /mix/);
  assertError(() => compileReferenceTempoDelayPlan({ tempo, delayBeats: rational(1, 1_000_000), feedback: 0.5, mix: 0.25 }), "CUT_AUDIO_TEMPO_DELAY_CAUSALITY", /at least one destination sample/);
  assertError(() => compileReferenceTempoDelayPlan({ tempo, delayBeats: rational(2), feedback: 0.5, mix: 0.25 }), "CUT_AUDIO_TEMPO_DELAY_VALUE", /no audible echo/);

  const plan = compileReferenceTempoDelayPlan({ tempo, delayBeats: rational(1), feedback: 0.5, mix: 0.25 });
  const hostile = { ...plan, mix: 0.8 };
  assertError(() => processReferenceTempoDelayStereo(new Float32Array(96_000), hostile), "CUT_AUDIO_TEMPO_DELAY_TYPE", /integrity/);
  const nonFinite = new Float32Array(96_000); nonFinite[7] = Number.NaN;
  assertError(() => processReferenceTempoDelayStereo(nonFinite, plan), "CUT_AUDIO_TEMPO_DELAY_PCM", /finite/);
  assert.deepEqual(referenceTempoDelayLimits.maximumFeedback, 0.95);
  assert.ok(referenceTempoDelayNonClaims.includes("tempo detection"));
  assert.ok(referenceTempoDelayNonClaims.includes("groove, shuffle, or swing timing"));
});
