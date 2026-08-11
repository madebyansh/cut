import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import Ajv from "ajv";
import { stableJsonStringify } from "../lib/core/stable";
import {
  CutAudioAnalysisError,
  cutAudioClapPromptPolicyV1,
  cutAudioAnalysisLimits,
  cutAudioSemanticInferenceKind,
  cutAudioAnalysisSemanticStatus,
  cutAudioAnalysisSha256,
  parseCutAudioAnalysis,
} from "../lib/audio-intelligence";

const sha = (digit: string) => digit.repeat(64);
const digest = (value: unknown) => createHash("sha256").update(stableJsonStringify(value)).digest("hex");

function sign<T extends Record<string, unknown>>(value: T) {
  const { analysisSha256: _ignored, ...body } = value;
  return { ...body, analysisSha256: digest(body) };
}

function fixture() {
  return sign({
    format: "cut-audio-analysis",
    version: 1,
    semanticStatus: cutAudioAnalysisSemanticStatus,
    source: {
      locator: "assets/interview.wav", bytes: 576044, sha256: sha("1"), streamIndex: 0,
      sampleRate: 48000, channels: 2, durationSamples: 96000, normalizedPcmSha256: sha("2"),
    },
    backend: {
      provider: "local", model: "example/audio-understanding-small", revision: "v1.0.0", adapterSha256: sha("3"),
      modelFiles: [
        { locator: "config.json", bytes: 2048, sha256: sha("4"), license: "Apache-2.0" },
        { locator: "model.onnx", bytes: 2000000, sha256: sha("5"), license: "Apache-2.0" },
      ],
    },
    policy: { windowSamples: 24000, hopSamples: 24000, taxonomyId: "cut-audio-taxonomy-v1", tempoMinBpm: 60, tempoMaxBpm: 180 },
    windows: [
      { range: { startSample: 0, endSample: 24000 }, rmsDbfsMilli: -22000, peakDbfsMilli: -7000, onsetStrengthPpm: 120000, labels: [{ label: "speech", scorePpm: 900000 }, { label: "reflective", scorePpm: 500000 }] },
      { range: { startSample: 24000, endSample: 48000 }, rmsDbfsMilli: -20000, peakDbfsMilli: -6000, onsetStrengthPpm: 360000, labels: [{ label: "speech", scorePpm: 850000 }, { label: "reflective", scorePpm: 450000 }] },
      { range: { startSample: 48000, endSample: 72000 }, rmsDbfsMilli: -18000, peakDbfsMilli: -5000, onsetStrengthPpm: 720000, labels: [{ label: "music", scorePpm: 800000 }, { label: "energetic", scorePpm: 700000 }] },
      { range: { startSample: 72000, endSample: 96000 }, rmsDbfsMilli: -24000, peakDbfsMilli: -9000, onsetStrengthPpm: 80000, labels: [{ label: "ambience", scorePpm: 820000 }, { label: "calm", scorePpm: 650000 }] },
    ],
    global: {
      tempoCandidates: [{ bpmMilli: 120000, scorePpm: 800000 }, { bpmMilli: 90000, scorePpm: 200000 }],
      beats: [{ sample: 12000, scorePpm: 700000 }, { sample: 36000, scorePpm: 750000 }, { sample: 60000, scorePpm: 720000 }],
    },
    sections: [
      { range: { startSample: 0, endSample: 48000 }, role: "speech", mood: "reflective", confidencePpm: 880000 },
      { range: { startSample: 48000, endSample: 72000 }, role: "music", mood: "energetic", confidencePpm: 810000 },
      { range: { startSample: 72000, endSample: 96000 }, role: "ambience", mood: "calm", confidencePpm: 800000 },
    ],
  });
}

function expectCode(value: unknown, code: string) {
  assert.throws(
    () => parseCutAudioAnalysis(JSON.stringify(value)),
    (error: unknown) => error instanceof CutAudioAnalysisError && error.code === code,
  );
}

function schemaValidator() {
  const schema = JSON.parse(readFileSync(resolve("schemas/cut-audio-analysis-v1.schema.json"), "utf8"));
  return new Ajv({ schemaId: "auto", meta: false, validateSchema: false, allErrors: true }).compile(schema);
}

test("audio-analysis v1 parses one canonical sample-domain report and marks semantics as suggestions", () => {
  assert.equal(schemaValidator()(fixture()), true);
  const first = parseCutAudioAnalysis(JSON.stringify(fixture())), second = parseCutAudioAnalysis(JSON.stringify(fixture()));
  assert.equal(first.analysisSha256, fixture().analysisSha256);
  assert.equal(first.analysisSha256, second.analysisSha256);
  assert.equal(first.semanticStatus, "editorial-suggestions-not-ground-truth");
  assert.equal(first.windows[2]!.range.startSample, 48000);
  assert.equal(first.global.tempoCandidates[0]!.bpmMilli, 120000);
  assert.equal(first.sections[0]!.mood, "reflective");
  assert.equal(Object.hasOwn(first.backend, "semanticInference"), false);
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.windows) && Object.isFrozen(first.windows[0]!.labels));
  const { analysisSha256: _ignored, ...body } = first;
  assert.equal(cutAudioAnalysisSha256(body), first.analysisSha256);
});

test("audio-analysis optionally binds prompt-based semantic inference without changing omission", () => {
  const validate = schemaValidator();
  const base = fixture();
  const signed = sign({
    ...base,
    backend: {
      ...base.backend,
      semanticInference: {
        kind: cutAudioSemanticInferenceKind,
        promptPolicy: structuredClone(cutAudioClapPromptPolicyV1),
      },
    },
  });
  assert.equal(validate(signed), true, JSON.stringify(validate.errors));
  const parsed = parseCutAudioAnalysis(JSON.stringify(signed));
  assert.equal(parsed.backend.semanticInference?.promptPolicy.policySha256, cutAudioClapPromptPolicyV1.policySha256);
  assert.notEqual(parsed.analysisSha256, fixture().analysisSha256);

  const policyMutation = structuredClone(signed);
  const mutableNormalization = policyMutation.backend.semanticInference.promptPolicy.normalization as { groupScores: string };
  mutableNormalization.groupScores = "global-softmax-v1";
  const resigned = sign(policyMutation);
  assert.equal(validate(resigned), false, JSON.stringify(validate.errors));
  assert.throws(() => parseCutAudioAnalysis(JSON.stringify(resigned)), /CUT_AUDIO_PROMPT_POLICY_VALUE/u);

  const promptMutation = structuredClone(signed);
  const mutablePrompt = promptMutation.backend.semanticInference.promptPolicy.groups[0]!.prompts[0] as { prompt: string };
  mutablePrompt.prompt = "This audio probably contains speech.";
  const resignedPrompt = sign(promptMutation);
  assert.equal(validate(resignedPrompt), false, JSON.stringify(validate.errors));
  assert.throws(() => parseCutAudioAnalysis(JSON.stringify(resignedPrompt)), /CUT_AUDIO_PROMPT_POLICY_VALUE/u);

  const unknown = structuredClone(signed);
  Object.assign(unknown.backend.semanticInference, { hostPrompt: "cinematic" });
  const resignedUnknown = sign(unknown);
  assert.equal(validate(resignedUnknown), false, JSON.stringify(validate.errors));
  assert.throws(() => parseCutAudioAnalysis(JSON.stringify(resignedUnknown)), /CUT_AUDIO_ANALYSIS_UNKNOWN_FIELD/u);
});

test("audio-analysis schema and runtime agree on closed trimmed text and locator boundaries", () => {
  const validate = schemaValidator();
  for (const mutate of [
    (value: ReturnType<typeof fixture>) => { value.backend.provider = " local "; },
    (value: ReturnType<typeof fixture>) => { value.backend.model = "model\nname"; },
    (value: ReturnType<typeof fixture>) => { value.backend.revision = "v1 "; },
    (value: ReturnType<typeof fixture>) => { value.backend.modelFiles[0]!.license = " MIT"; },
    (value: ReturnType<typeof fixture>) => { value.source.locator = " assets/interview.wav"; },
  ]) {
    const value = fixture();
    mutate(value);
    const signed = sign(value);
    assert.equal(validate(signed), false, JSON.stringify(validate.errors));
    assert.throws(() => parseCutAudioAnalysis(JSON.stringify(signed)), CutAudioAnalysisError);
  }
  const decomposed = fixture();
  decomposed.backend.model = "mode\u0301l";
  assert.equal(validate(sign(decomposed)), true, "JSON Schema cannot express Unicode NFC normalization");
  expectCode(sign(decomposed), "CUT_AUDIO_ANALYSIS_TEXT");
});

test("audio-analysis v1 rejects hash tampering, unknown fields, and non-strict JSON", () => {
  const tampered = structuredClone(fixture());
  tampered.windows[0]!.onsetStrengthPpm += 1;
  expectCode(tampered, "CUT_AUDIO_ANALYSIS_IDENTITY");

  expectCode({ ...fixture(), hiddenPrompt: "trust me" }, "CUT_AUDIO_ANALYSIS_UNKNOWN_FIELD");
  const duplicate = JSON.stringify(fixture()).replace('"format":"cut-audio-analysis"', '"format":"cut-audio-analysis","format":"forged"');
  assert.throws(
    () => parseCutAudioAnalysis(duplicate),
    (error: unknown) => error instanceof CutAudioAnalysisError && error.code === "CUT_AUDIO_ANALYSIS_JSON",
  );
  expectCode({ ...fixture(), semanticStatus: "model-ground-truth" }, "CUT_AUDIO_ANALYSIS_SEMANTIC_STATUS");
});

test("audio-analysis sample ranges, ordering, grid, and collection limits fail closed", () => {
  const overlap = structuredClone(fixture());
  overlap.windows[1]!.range = { startSample: 0, endSample: 24000 };
  expectCode(sign(overlap), "CUT_AUDIO_ANALYSIS_ORDER");

  const offGrid = structuredClone(fixture());
  offGrid.windows[1]!.range = { startSample: 12000, endSample: 36000 };
  expectCode(sign(offGrid), "CUT_AUDIO_ANALYSIS_GRID");

  const badSectionOrder = structuredClone(fixture());
  badSectionOrder.sections[1]!.range = { startSample: 24000, endSample: 48000 };
  expectCode(sign(badSectionOrder), "CUT_AUDIO_ANALYSIS_ORDER");

  const tooManyFiles = structuredClone(fixture());
  tooManyFiles.backend.modelFiles = Array.from({ length: cutAudioAnalysisLimits.maximumModelFiles + 1 }, (_, index) => ({
    locator: `models/${String(index).padStart(3, "0")}.onnx`, bytes: 1, sha256: sha((index % 10).toString()), license: "MIT",
  }));
  expectCode(sign(tooManyFiles), "CUT_AUDIO_ANALYSIS_LIMIT");

  const unsafeLocator = structuredClone(fixture());
  unsafeLocator.source.locator = "../outside.wav";
  expectCode(sign(unsafeLocator), "CUT_AUDIO_ANALYSIS_LOCATOR");
});

test("audio-analysis admits only the exact bounded terminal partial window", () => {
  const value = structuredClone(fixture());
  value.source.durationSamples = 36_001;
  value.windows = value.windows.slice(0, 1);
  value.windows.push({
    range: { startSample: 24_000, endSample: 36_001 },
    rmsDbfsMilli: -18_000,
    peakDbfsMilli: -9_000,
    onsetStrengthPpm: 20_000,
    labels: [{ label: "music", scorePpm: 800_000 }],
  });
  value.global.beats = value.global.beats.filter((beat) => beat.sample < 36_001);
  value.sections = [{ range: { startSample: 0, endSample: 36_001 }, role: "speech", mood: "reflective", confidencePpm: 880_000 }];
  const parsed = parseCutAudioAnalysis(JSON.stringify(sign(value)));
  assert.deepEqual(parsed.windows.at(-1)?.range, { startSample: 24_000, endSample: 36_001 });

  const shortInterior = structuredClone(fixture());
  shortInterior.windows[0].range.endSample = 23_999;
  assert.throws(() => parseCutAudioAnalysis(JSON.stringify(sign(shortInterior))), /CUT_AUDIO_ANALYSIS_GRID/u);
});

test("audio-analysis role and mood labels use a closed, ranked, bounded taxonomy", () => {
  const unknown = structuredClone(fixture());
  unknown.windows[0]!.labels[0]!.label = "cinematic";
  expectCode(sign(unknown), "CUT_AUDIO_ANALYSIS_TAXONOMY");

  const excessive = structuredClone(fixture());
  excessive.windows[0]!.labels[0]!.scorePpm = 1000001;
  expectCode(sign(excessive), "CUT_AUDIO_ANALYSIS_NUMBER");

  const duplicate = structuredClone(fixture());
  duplicate.windows[0]!.labels = [{ label: "speech", scorePpm: 900000 }, { label: "speech", scorePpm: 500000 }];
  expectCode(sign(duplicate), "CUT_AUDIO_ANALYSIS_DUPLICATE");

  const moodOnly = structuredClone(fixture());
  moodOnly.windows[0]!.labels = [{ label: "reflective", scorePpm: 500000 }];
  expectCode(sign(moodOnly), "CUT_AUDIO_ANALYSIS_TAXONOMY");

  const unsorted = structuredClone(fixture());
  unsorted.windows[0]!.labels = [{ label: "speech", scorePpm: 500000 }, { label: "reflective", scorePpm: 900000 }];
  expectCode(sign(unsorted), "CUT_AUDIO_ANALYSIS_ORDER");
});

test("audio-analysis tempo, beat, and backend identities cannot drift silently", () => {
  const beatOrder = structuredClone(fixture());
  beatOrder.global.beats[1]!.sample = beatOrder.global.beats[0]!.sample;
  expectCode(sign(beatOrder), "CUT_AUDIO_ANALYSIS_ORDER");

  const tempoRange = structuredClone(fixture());
  tempoRange.global.tempoCandidates[0]!.bpmMilli = 181000;
  expectCode(sign(tempoRange), "CUT_AUDIO_ANALYSIS_NUMBER");

  const backendTamper = structuredClone(fixture());
  backendTamper.backend.model = "different/model";
  expectCode(backendTamper, "CUT_AUDIO_ANALYSIS_IDENTITY");
  const resignedBackend = parseCutAudioAnalysis(JSON.stringify(sign(backendTamper)));
  assert.notEqual(resignedBackend.analysisSha256, fixture().analysisSha256);

  const modelByteTamper = structuredClone(fixture());
  modelByteTamper.backend.modelFiles[1]!.sha256 = sha("f");
  expectCode(modelByteTamper, "CUT_AUDIO_ANALYSIS_IDENTITY");

  const modelOrder = structuredClone(fixture());
  modelOrder.backend.modelFiles.reverse();
  expectCode(sign(modelOrder), "CUT_AUDIO_ANALYSIS_ORDER");
});
