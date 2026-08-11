import assert from "node:assert/strict";
import test from "node:test";
import { analyzeCutAudioPcm, cutAudioDspLimits, CutAudioDspError } from "../lib/audio-intelligence/dsp";

const sampleRate = 48_000;
const policy = Object.freeze({ sampleRate, windowSamples: 2_400, hopSamples: 1_200, tempoMinBpm: 60, tempoMaxBpm: 180 });

function clickTrack(bpm: number, seconds: number) {
  const result = new Float32Array(sampleRate * seconds);
  const interval = Math.round((60 * sampleRate) / bpm);
  for (let start = 0; start < result.length; start += interval) {
    for (let offset = 0; offset < 240 && start + offset < result.length; offset += 1) {
      result[start + offset] = (1 - offset / 240) * 0.8;
    }
  }
  return result;
}

test("audio intelligence PCM analysis is deterministic, integer-only, and detects a 120 BPM click track", () => {
  const input = clickTrack(120, 12), before = Buffer.from(input.buffer.slice(0));
  const first = analyzeCutAudioPcm(input, policy), second = analyzeCutAudioPcm(input, policy);
  assert.deepEqual(first, second);
  assert.deepEqual(Buffer.from(input.buffer), before);
  assert.ok(first.windows.some((window) => window.onsetStrengthPpm === 1_000_000));
  assert.ok(first.tempoCandidates.length > 0);
  assert.ok(Math.abs(first.tempoCandidates[0].bpmMilli - 120_000) <= 1_000, JSON.stringify(first.tempoCandidates));
  assert.ok(first.beatSamples.length >= 20);
  assert.ok(first.windows.every((window) => Number.isInteger(window.rmsDbfsMilli)
    && Number.isInteger(window.peakDbfsMilli)
    && Number.isInteger(window.onsetStrengthPpm)));
});

test("silence emits the exact floor, one bounded span, and no invented tempo", () => {
  const result = analyzeCutAudioPcm(new Float32Array(sampleRate * 2), policy);
  assert.ok(result.windows.every((window) => window.rmsDbfsMilli === -120_000 && window.peakDbfsMilli === -120_000));
  assert.deepEqual(result.silenceSpans, [{ startSample: 0, endSample: sampleRate * 2 }]);
  assert.deepEqual(result.tempoCandidates, []);
  assert.deepEqual(result.beatSamples, []);
});

test("partial terminal windows remain bounded by the exact duration", () => {
  const result = analyzeCutAudioPcm(new Float32Array(5_001).fill(0.25), {
    sampleRate: 16_000,
    windowSamples: 2_000,
    hopSamples: 1_000,
  });
  assert.equal(result.windows.at(-1)?.startSample, 5_000);
  assert.equal(result.windows.at(-1)?.endSample, 5_001);
  assert.ok(result.windows.every((window) => window.startSample < window.endSample && window.endSample <= 5_001));
});

test("invalid policies and hostile PCM fail closed", () => {
  for (const [samples, candidate] of [
    [new Float32Array(), policy],
    [new Float32Array([Number.NaN]), policy],
    [new Float32Array([1.01]), policy],
    [new Float32Array(100), { ...policy, sampleRate: 1 }],
    [new Float32Array(100), { ...policy, windowSamples: 101 }],
    [new Float32Array(100), { ...policy, windowSamples: 100, hopSamples: 101 }],
    [new Float32Array(100), { ...policy, tempoMinBpm: 180, tempoMaxBpm: 60 }],
  ] as const) {
    assert.throws(() => analyzeCutAudioPcm(samples, candidate), (error: unknown) => error instanceof CutAudioDspError);
  }
});

test("tempo confidence is absolute correlation rather than a mechanically normalized winner", () => {
  const input = new Float32Array(sampleRate * 8);
  for (let sample = 0; sample < input.length; sample += 1) {
    input[sample] = Math.sin(sample * 0.017) * (sample % 9_973 === 0 ? 0.7 : 0.01);
  }
  const result = analyzeCutAudioPcm(input, policy);
  assert.ok(result.tempoCandidates.length > 0);
  assert.ok(result.tempoCandidates[0]!.confidencePpm < 1_000_000, JSON.stringify(result.tempoCandidates));
});

test("tempo correlation work is accounted exactly and refuses quadratic policies before the loop", () => {
  const input = new Float32Array(8_192);
  for (let index = 0; index < input.length; index += 2) input[index] = index % 8 === 0 ? 0.8 : 0.1;
  assert.throws(
    () => analyzeCutAudioPcm(input, {
      sampleRate: 8_000,
      windowSamples: 3,
      hopSamples: 2,
      tempoMinBpm: 20,
      tempoMaxBpm: 400,
    }),
    (error: unknown) => error instanceof CutAudioDspError
      && error.code === "CUT_AUDIO_DSP_WORK"
      && error.message.includes(String(cutAudioDspLimits.maximumTempoCorrelationEvaluations)),
  );
});
