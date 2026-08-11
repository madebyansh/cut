import assert from "node:assert/strict";
import test from "node:test";
import {
  CutAudioSemanticPromptPolicyError,
  cutAudioClapPromptPolicyV1,
  cutAudioSemanticPromptMoods,
  cutAudioSemanticPromptPolicySha256,
  cutAudioSemanticPromptRoles,
  cutAudioSemanticScoreToPpm,
  parseCutAudioSemanticPromptPolicy,
} from "../lib/audio-intelligence";

type MutablePromptPolicy = {
  format: string;
  version: number;
  backendFamily: string;
  groups: Array<{ id: string; prompts: Array<{ label: string; prompt: string }> }>;
  normalization: {
    text: string;
    audioEmbedding: string;
    textEmbedding: string;
    comparison: string;
    groupScores: string;
  };
  scoreToPpm: string;
  window: {
    sampleRate: number;
    channels: number;
    windowSamples: number;
    hopSamples: number;
    channelMix: string;
    terminalWindow: string;
  };
  policySha256: string;
};

function mutablePolicy() {
  return JSON.parse(JSON.stringify(cutAudioClapPromptPolicyV1)) as MutablePromptPolicy;
}

function expectPolicyFailure(value: unknown, code?: string) {
  assert.throws(
    () => parseCutAudioSemanticPromptPolicy(value),
    (error: unknown) => error instanceof CutAudioSemanticPromptPolicyError && (code === undefined || error.code === code),
  );
}

test("CLAP prompt policy binds exact separated role and mood groups, scoring law, and window law", () => {
  const parsed = parseCutAudioSemanticPromptPolicy(mutablePolicy());
  assert.deepEqual(parsed, cutAudioClapPromptPolicyV1);
  assert.deepEqual(parsed.groups.map((group) => group.id), ["role", "mood"]);
  assert.deepEqual(parsed.groups[0]?.prompts, cutAudioSemanticPromptRoles);
  assert.deepEqual(parsed.groups[1]?.prompts, cutAudioSemanticPromptMoods);
  assert.equal(parsed.groups[0]?.prompts.length, 5);
  assert.equal(parsed.groups[1]?.prompts.length, 10);
  assert.equal(parsed.window.windowSamples, 480_000);
  assert.equal(parsed.window.hopSamples, 480_000);
  assert.equal(parsed.policySha256, "aac1cc356488779b2d5564b81ad9f10f7f4405357a77fcde55fa4ac2db8ae201");
  const { policySha256: _ignored, ...body } = parsed;
  assert.equal(cutAudioSemanticPromptPolicySha256(body), parsed.policySha256);
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.groups) && Object.isFrozen(parsed.groups[0]?.prompts));
});

test("CLAP prompt policy rejects unknown fields, reordered groups/prompts, and duplicate labels", () => {
  const unknown = mutablePolicy();
  Object.assign(unknown, { hiddenCalibration: "host-dependent" });
  expectPolicyFailure(unknown, "CUT_AUDIO_PROMPT_POLICY_UNKNOWN_FIELD");

  const groupOrder = mutablePolicy();
  groupOrder.groups.reverse();
  expectPolicyFailure(groupOrder, "CUT_AUDIO_PROMPT_POLICY_VALUE");

  const promptOrder = mutablePolicy();
  promptOrder.groups[0]!.prompts.reverse();
  expectPolicyFailure(promptOrder, "CUT_AUDIO_PROMPT_POLICY_VALUE");

  const duplicate = mutablePolicy();
  duplicate.groups[0]!.prompts[1]!.label = duplicate.groups[0]!.prompts[0]!.label;
  expectPolicyFailure(duplicate, "CUT_AUDIO_PROMPT_POLICY_DUPLICATE");
});

test("CLAP prompt text, normalization, rounding, and window policies cannot drift", () => {
  const decomposed = mutablePolicy();
  decomposed.groups[1]!.prompts[0]!.prompt = "This audio feels calme\u0301.";
  expectPolicyFailure(decomposed, "CUT_AUDIO_PROMPT_POLICY_VALUE");

  const control = mutablePolicy();
  control.groups[0]!.prompts[0]!.prompt = "This audio contains\nspoken human voice.";
  expectPolicyFailure(control, "CUT_AUDIO_PROMPT_POLICY_VALUE");

  for (const mutate of [
    (value: MutablePromptPolicy) => { value.normalization.text = "unicode-nfkc-v1"; },
    (value: MutablePromptPolicy) => { value.normalization.groupScores = "one-softmax-across-all-labels-v1"; },
    (value: MutablePromptPolicy) => { value.scoreToPpm = "round-to-even-v1"; },
    (value: MutablePromptPolicy) => { value.window.windowSamples = 479_999; },
    (value: MutablePromptPolicy) => { value.window.terminalWindow = "drop-v1"; },
  ]) {
    const value = mutablePolicy();
    mutate(value);
    expectPolicyFailure(value, "CUT_AUDIO_PROMPT_POLICY_VALUE");
  }
});

test("semantic score quantization is bounded and uses the exact half-up ppm law", () => {
  assert.equal(cutAudioSemanticScoreToPpm(0), 0);
  assert.equal(cutAudioSemanticScoreToPpm(0.000_000_49), 0);
  assert.equal(cutAudioSemanticScoreToPpm(0.000_000_5), 1);
  assert.equal(cutAudioSemanticScoreToPpm(0.123_456_5), 123_457);
  assert.equal(cutAudioSemanticScoreToPpm(1), 1_000_000);
  for (const invalid of [-Number.EPSILON, 1 + Number.EPSILON, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => cutAudioSemanticScoreToPpm(invalid), /CUT_AUDIO_PROMPT_POLICY_SCORE/u);
  }
});

test("CLAP prompt policy canonical identity rejects body and digest mutation", () => {
  const hash = mutablePolicy();
  hash.policySha256 = "0".repeat(64);
  expectPolicyFailure(hash, "CUT_AUDIO_PROMPT_POLICY_IDENTITY");

  const body = mutablePolicy();
  body.backendFamily = "another-zero-shot-model-v1";
  expectPolicyFailure(body, "CUT_AUDIO_PROMPT_POLICY_VALUE");
});
