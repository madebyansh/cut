import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  measureReferenceAudio,
  measureReferenceAudioAuthoredBoundary,
  ReferenceAudioLoudnessBoundaryError,
  referenceAudioLoudnessBoundaryLimits,
  type ReferenceAuthoredLoudnessBoundaryOptions,
} from "../lib/runtime/reference/audio";

const sampleRate = 48_000;

function floatWave(
  authoredFrames: number,
  paddingFrames: number,
  authoredAmplitude: number,
  paddingAmplitude: number,
) {
  const channels = 2, bytesPerSample = 4, bytesPerFrame = channels * bytesPerSample;
  const frames = authoredFrames + paddingFrames, dataBytes = frames * bytesPerFrame;
  const wave = Buffer.alloc(44 + dataBytes);
  wave.write("RIFF", 0, "ascii"); wave.writeUInt32LE(36 + dataBytes, 4);
  wave.write("WAVE", 8, "ascii"); wave.write("fmt ", 12, "ascii");
  wave.writeUInt32LE(16, 16); wave.writeUInt16LE(3, 20); wave.writeUInt16LE(channels, 22);
  wave.writeUInt32LE(sampleRate, 24); wave.writeUInt32LE(sampleRate * bytesPerFrame, 28);
  wave.writeUInt16LE(bytesPerFrame, 32); wave.writeUInt16LE(bytesPerSample * 8, 34);
  wave.write("data", 36, "ascii"); wave.writeUInt32LE(dataBytes, 40);
  for (let frame = 0; frame < frames; frame += 1) {
    const authored = frame < authoredFrames;
    const amplitude = authored ? authoredAmplitude : paddingAmplitude;
    const localFrame = authored ? frame : frame - authoredFrames;
    const left = authored
      ? amplitude * Math.sin(2 * Math.PI * 997 * localFrame / sampleRate)
      : amplitude;
    const right = authored
      ? amplitude * Math.sin(2 * Math.PI * 997 * localFrame / sampleRate + 0.31)
      : -amplitude;
    wave.writeFloatLE(left, 44 + frame * bytesPerFrame);
    wave.writeFloatLE(right, 44 + frame * bytesPerFrame + bytesPerSample);
  }
  return wave;
}

test("authored-boundary loudnorm excludes a different decoded padding suffix", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-loudness-boundary-padding-"));
  try {
    const authoredFrames = 48_000, paddingFrames = 1_024;
    const quietTail = resolve(root, "quiet-tail.wav"), loudTail = resolve(root, "loud-tail.wav");
    await Promise.all([
      writeFile(quietTail, floatWave(authoredFrames, paddingFrames, 0.02, 0)),
      writeFile(loudTail, floatWave(authoredFrames, paddingFrames, 0.02, 0.95)),
    ]);
    const options = { expectedFrames: authoredFrames, sampleRate };
    const [quietBoundary, loudBoundary, quietWhole, loudWhole] = await Promise.all([
      measureReferenceAudioAuthoredBoundary(quietTail, options),
      measureReferenceAudioAuthoredBoundary(loudTail, options),
      measureReferenceAudio(quietTail),
      measureReferenceAudio(loudTail),
    ]);

    assert.deepEqual(loudBoundary, quietBoundary, "bytes after expectedFrames must not affect any authored-domain loudnorm field");
    assert.ok(loudBoundary.truePeakDbtp !== null && loudBoundary.truePeakDbtp < -25, JSON.stringify(loudBoundary));
    assert.ok(quietWhole.truePeakDbtp !== null && loudWhole.truePeakDbtp !== null);
    assert.ok(loudWhole.truePeakDbtp > quietWhole.truePeakDbtp + 20, JSON.stringify({ quietWhole, loudWhole }));
    assert.ok(loudWhole.truePeakDbtp > loudBoundary.truePeakDbtp + 20, JSON.stringify({ loudBoundary, loudWhole }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a short silent authored boundary remains silence even when the decoded suffix is loud", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-loudness-boundary-silence-"));
  try {
    const input = resolve(root, "short-silence-with-padding.wav");
    await writeFile(input, floatWave(100, 924, 0, 0.95));
    const boundary = await measureReferenceAudioAuthoredBoundary(input, { expectedFrames: 100, sampleRate });
    const whole = await measureReferenceAudio(input);
    assert.deepEqual(boundary, {
      integratedLufs: null,
      truePeakDbtp: null,
      loudnessRangeLu: 0,
      thresholdLufs: -70,
    });
    assert.ok(whole.truePeakDbtp !== null && whole.truePeakDbtp > -2, JSON.stringify(whole));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("authored-boundary validation is stable, finite and completes before FFmpeg", async () => {
  const missing = "/definitely/not/a/cut-audio-fixture.wav";
  const cases: Array<{
    options: ReferenceAuthoredLoudnessBoundaryOptions;
    code: ReferenceAudioLoudnessBoundaryError["code"];
    reason: string;
  }> = [
    { options: { expectedFrames: 0, sampleRate }, code: "CUT_AUDIO_LOUDNESS_BOUNDARY_STRUCTURE", reason: "invalid-expected-frames" },
    { options: { expectedFrames: 0.5, sampleRate }, code: "CUT_AUDIO_LOUDNESS_BOUNDARY_STRUCTURE", reason: "invalid-expected-frames" },
    { options: { expectedFrames: referenceAudioLoudnessBoundaryLimits.maximumFrames + 1, sampleRate }, code: "CUT_AUDIO_LOUDNESS_BOUNDARY_RESOURCE_LIMIT", reason: "frame-budget" },
    { options: { expectedFrames: 1, sampleRate: 7_999 }, code: "CUT_AUDIO_LOUDNESS_BOUNDARY_STRUCTURE", reason: "invalid-sample-rate" },
    { options: { expectedFrames: 1, sampleRate: 384_001 }, code: "CUT_AUDIO_LOUDNESS_BOUNDARY_STRUCTURE", reason: "invalid-sample-rate" },
    { options: { expectedFrames: 1, sampleRate, targetLufs: Number.NaN }, code: "CUT_AUDIO_LOUDNESS_BOUNDARY_STRUCTURE", reason: "invalid-target-lufs" },
    { options: { expectedFrames: 1, sampleRate, truePeakDbtp: -9.01 }, code: "CUT_AUDIO_LOUDNESS_BOUNDARY_STRUCTURE", reason: "invalid-true-peak" },
    { options: { expectedFrames: 1, sampleRate, loudnessRangeLu: 50.01 }, code: "CUT_AUDIO_LOUDNESS_BOUNDARY_STRUCTURE", reason: "invalid-loudness-range" },
  ];
  for (const fixture of cases) {
    await assert.rejects(
      measureReferenceAudioAuthoredBoundary(missing, fixture.options),
      (error) => error instanceof ReferenceAudioLoudnessBoundaryError
        && error.code === fixture.code
        && error.detail.reason === fixture.reason,
    );
  }
  await assert.rejects(
    measureReferenceAudioAuthoredBoundary("", { expectedFrames: 1, sampleRate }),
    (error) => error instanceof ReferenceAudioLoudnessBoundaryError
      && error.code === "CUT_AUDIO_LOUDNESS_BOUNDARY_STRUCTURE"
      && error.detail.reason === "invalid-input-path",
  );
});

test("FFmpeg failures become bounded authored-boundary measurement errors", async () => {
  const privatePath = "/definitely/not/a/private-cut-marker-audio.wav";
  await assert.rejects(
    measureReferenceAudioAuthoredBoundary(privatePath, { expectedFrames: 48_000, sampleRate }),
    (error) => {
      assert.ok(error instanceof ReferenceAudioLoudnessBoundaryError, String(error));
      assert.equal(error.code, "CUT_AUDIO_LOUDNESS_BOUNDARY_MEASUREMENT");
      assert.equal(error.detail.reason, "process-failure");
      assert.equal(error.detail.expectedFrames, 48_000);
      assert.equal(error.detail.sampleRate, sampleRate);
      assert.equal(error.message.includes(privatePath), false);
      assert.ok(error.message.length < 256);
      return true;
    },
  );
});
