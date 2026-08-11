import assert from "node:assert/strict";
import test from "node:test";
import {
  cutNormalizedPcmSha256,
  cutAudioClapPromptPolicyV1,
  cutAudioSemanticInferenceKind,
  materializeCutAudioAnalysis,
  parseCutAudioAnalysis,
} from "../lib/audio-intelligence";

const sha = (digit: string) => digit.repeat(64);

function input() {
  const pcm = new Float32Array(8_000);
  pcm.fill(0.1, 0, 4_000);
  pcm.fill(0.3, 4_000);
  return {
    source: {
      locator: "assets/source.wav", bytes: 32_044, sha256: sha("1"), streamIndex: 0,
      sampleRate: 8_000, channels: 1, durationSamples: pcm.length,
    },
    backend: {
      provider: "local-clap", model: "clap", revision: "v1", adapterSha256: sha("2"),
      modelFiles: [{ locator: "model.onnx", bytes: 100, sha256: sha("3"), license: "Apache-2.0" }],
    },
    policy: {
      windowSamples: 4_000, hopSamples: 4_000, taxonomyId: "cut-audio-taxonomy-v1" as const,
      tempoMinBpm: 60, tempoMaxBpm: 180,
    },
    normalizedMonoPcm: pcm,
    semanticWindows: [
      { startSample: 0, endSample: 4_000, labels: [{ label: "speech" as const, scorePpm: 900_000 }, { label: "reflective" as const, scorePpm: 500_000 }] },
      { startSample: 4_000, endSample: 8_000, labels: [{ label: "music" as const, scorePpm: 850_000 }, { label: "energetic" as const, scorePpm: 700_000 }] },
    ],
  };
}

test("materialization binds PCM bytes, exact observations, model estimates, and canonical identity", () => {
  const value = input(), first = materializeCutAudioAnalysis(value), second = materializeCutAudioAnalysis(value);
  assert.deepEqual(first, second);
  assert.equal(first.source.normalizedPcmSha256, cutNormalizedPcmSha256(value.normalizedMonoPcm));
  assert.equal(first.windows[0]?.labels[0]?.label, "speech");
  assert.equal(first.windows[1]?.labels[0]?.label, "music");
  assert.deepEqual(first.sections.map((section) => section.role), ["speech", "music"]);
  assert.deepEqual(parseCutAudioAnalysis(JSON.stringify(first)), first);
});

test("materialization carries feature-scoped semantic prompt authority into analysis identity", () => {
  const value = input();
  const result = materializeCutAudioAnalysis({
    ...value,
    backend: {
      ...value.backend,
      semanticInference: {
        kind: cutAudioSemanticInferenceKind,
        promptPolicy: cutAudioClapPromptPolicyV1,
      },
    },
  });
  assert.equal(result.backend.semanticInference?.kind, "clap-zero-shot-audio-text");
  assert.equal(result.backend.semanticInference?.promptPolicy.policySha256, cutAudioClapPromptPolicyV1.policySha256);

  const without = materializeCutAudioAnalysis(input());
  assert.notEqual(result.analysisSha256, without.analysisSha256);
});

test("materialization fails closed on clock, window, semantic, and hostile PCM drift", () => {
  const duration = input(); duration.source.durationSamples -= 1;
  assert.throws(() => materializeCutAudioAnalysis(duration), /durationSamples/u);

  const channel = input(); channel.source.channels = 2;
  assert.throws(() => materializeCutAudioAnalysis(channel), /one channel/u);

  const overlap = input(); overlap.policy.hopSamples = 2_000;
  assert.throws(() => materializeCutAudioAnalysis(overlap), /contiguous nonoverlapping/u);

  const missing = input(); missing.semanticWindows.pop();
  assert.throws(() => materializeCutAudioAnalysis(missing), /window count/u);

  const shifted = input(); shifted.semanticWindows[1].startSample = 3_999;
  assert.throws(() => materializeCutAudioAnalysis(shifted), /does not match/u);

  const nonfinite = input(); nonfinite.normalizedMonoPcm[10] = Number.NaN;
  assert.throws(() => materializeCutAudioAnalysis(nonfinite), /CUT_AUDIO_DSP_SAMPLE/u);
});

test("terminal partial PCM windows remain materializable without padding or dropped samples", () => {
  const value = input();
  value.normalizedMonoPcm = new Float32Array(10_000).fill(0.2);
  value.source.durationSamples = 10_000;
  value.semanticWindows.push({
    startSample: 8_000,
    endSample: 10_000,
    labels: [{ label: "music", scorePpm: 800_000 }],
  });
  const result = materializeCutAudioAnalysis(value);
  assert.deepEqual(result.windows.at(-1)?.range, { startSample: 8_000, endSample: 10_000 });
  assert.equal(result.sections.at(-1)?.range.endSample, 10_000);
});
