import { createHash } from "node:crypto";
import { stableJsonStringify } from "../core/stable";

export const cutAudioSemanticPromptPolicyFormat = "cut-audio-semantic-prompt-policy" as const;
export const cutAudioSemanticPromptPolicyVersion = 1 as const;
export const cutAudioSemanticInferenceKind = "clap-zero-shot-audio-text" as const;

export const cutAudioSemanticPromptRoles = Object.freeze([
  Object.freeze({ label: "speech", prompt: "This audio contains spoken human voice." }),
  Object.freeze({ label: "music", prompt: "This audio contains music." }),
  Object.freeze({ label: "ambience", prompt: "This audio contains environmental ambience." }),
  Object.freeze({ label: "sfx", prompt: "This audio contains a distinct sound effect." }),
  Object.freeze({ label: "silence", prompt: "This audio is silence or near-silence." }),
] as const);

export const cutAudioSemanticPromptMoods = Object.freeze([
  Object.freeze({ label: "calm", prompt: "This audio feels calm." }),
  Object.freeze({ label: "tense", prompt: "This audio feels tense." }),
  Object.freeze({ label: "hopeful", prompt: "This audio feels hopeful." }),
  Object.freeze({ label: "energetic", prompt: "This audio feels energetic." }),
  Object.freeze({ label: "reflective", prompt: "This audio feels reflective." }),
  Object.freeze({ label: "somber", prompt: "This audio feels somber." }),
  Object.freeze({ label: "joyful", prompt: "This audio feels joyful." }),
  Object.freeze({ label: "ominous", prompt: "This audio feels ominous." }),
  Object.freeze({ label: "intimate", prompt: "This audio feels intimate." }),
  Object.freeze({ label: "triumphant", prompt: "This audio feels triumphant." }),
] as const);

export const cutAudioSemanticPromptPolicyIds = Object.freeze({
  backendFamily: "clap-zero-shot-audio-text-v1",
  textNormalization: "unicode-nfc-control-free-exact-utf8-v1",
  audioEmbeddingNormalization: "l2-f32-unit-vector-v1",
  textEmbeddingNormalization: "l2-f32-unit-vector-v1",
  comparison: "model-logit-scale-cosine-dot-f32-v1",
  groupScores: "stable-softmax-f64-independent-per-group-v1",
  scoreToPpm: "unit-interval-round-half-up-to-ppm-v1",
  channelMix: "arithmetic-mean-f32-v1",
  terminalWindow: "right-zero-pad-to-window-v1",
} as const);

export type CutAudioSemanticPrompt = Readonly<{ label: string; prompt: string }>;
export type CutAudioSemanticPromptGroup = Readonly<{
  id: "role" | "mood";
  prompts: readonly CutAudioSemanticPrompt[];
}>;
export type CutAudioSemanticPromptPolicyBody = Readonly<{
  format: typeof cutAudioSemanticPromptPolicyFormat;
  version: typeof cutAudioSemanticPromptPolicyVersion;
  backendFamily: typeof cutAudioSemanticPromptPolicyIds.backendFamily;
  groups: readonly CutAudioSemanticPromptGroup[];
  normalization: Readonly<{
    text: typeof cutAudioSemanticPromptPolicyIds.textNormalization;
    audioEmbedding: typeof cutAudioSemanticPromptPolicyIds.audioEmbeddingNormalization;
    textEmbedding: typeof cutAudioSemanticPromptPolicyIds.textEmbeddingNormalization;
    comparison: typeof cutAudioSemanticPromptPolicyIds.comparison;
    groupScores: typeof cutAudioSemanticPromptPolicyIds.groupScores;
  }>;
  scoreToPpm: typeof cutAudioSemanticPromptPolicyIds.scoreToPpm;
  window: Readonly<{
    sampleRate: 48_000;
    channels: 1;
    windowSamples: 480_000;
    hopSamples: 480_000;
    channelMix: typeof cutAudioSemanticPromptPolicyIds.channelMix;
    terminalWindow: typeof cutAudioSemanticPromptPolicyIds.terminalWindow;
  }>;
}>;
export type CutAudioSemanticPromptPolicy = CutAudioSemanticPromptPolicyBody & Readonly<{ policySha256: string }>;

export class CutAudioSemanticPromptPolicyError extends Error {
  constructor(readonly code: string, readonly path: string, message: string) {
    super(`${code} at ${path}: ${message}`);
    this.name = "CutAudioSemanticPromptPolicyError";
  }
}

function fail(code: string, path: string, message: string): never {
  throw new CutAudioSemanticPromptPolicyError(code, path, message);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("CUT_AUDIO_PROMPT_POLICY_TYPE", path, "must be one plain object.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("CUT_AUDIO_PROMPT_POLICY_TYPE", path, "must be one plain object.");
  }
  return value as Record<string, unknown>;
}

function closed(value: unknown, path: string, required: readonly string[]) {
  const result = record(value, path), allowed = new Set(required);
  for (const key of Object.keys(result)) {
    if (!allowed.has(key)) fail("CUT_AUDIO_PROMPT_POLICY_UNKNOWN_FIELD", `${path}.${key}`, "is not part of the closed prompt-policy contract.");
  }
  for (const key of required) {
    if (!Object.hasOwn(result, key)) fail("CUT_AUDIO_PROMPT_POLICY_TYPE", `${path}.${key}`, "is required.");
  }
  return result;
}

function exact<T extends string | number>(value: unknown, expected: T, path: string): T {
  if (value !== expected) fail("CUT_AUDIO_PROMPT_POLICY_VALUE", path, `must be ${JSON.stringify(expected)}.`);
  return expected;
}

function digest(value: unknown, path: string) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    fail("CUT_AUDIO_PROMPT_POLICY_SHA256", path, "must be one lowercase SHA-256 digest.");
  }
  return value;
}

function parsePrompts(value: unknown, path: string, expected: readonly CutAudioSemanticPrompt[]) {
  if (!Array.isArray(value) || value.length !== expected.length) {
    fail("CUT_AUDIO_PROMPT_POLICY_COUNT", path, `must contain exactly ${expected.length} prompts.`);
  }
  const seen = new Set<string>();
  return Object.freeze(value.map((raw, index) => {
    const itemPath = `${path}[${index}]`, item = closed(raw, itemPath, ["label", "prompt"]);
    if (typeof item.label === "string" && seen.has(item.label)) {
      fail("CUT_AUDIO_PROMPT_POLICY_DUPLICATE", `${itemPath}.label`, "duplicates an earlier label in its group.");
    }
    if (typeof item.label === "string") seen.add(item.label);
    const expectedItem = expected[index]!;
    return Object.freeze({
      label: exact(item.label, expectedItem.label, `${itemPath}.label`),
      prompt: exact(item.prompt, expectedItem.prompt, `${itemPath}.prompt`),
    });
  }));
}

export function cutAudioSemanticPromptPolicySha256(body: CutAudioSemanticPromptPolicyBody) {
  return createHash("sha256").update(stableJsonStringify(body)).digest("hex");
}

function parsePromptPolicyBody(value: unknown): CutAudioSemanticPromptPolicyBody {
  const item = closed(value, "$", [
    "format", "version", "backendFamily", "groups", "normalization", "scoreToPpm", "window", "policySha256",
  ]);
  exact(item.format, cutAudioSemanticPromptPolicyFormat, "$.format");
  exact(item.version, cutAudioSemanticPromptPolicyVersion, "$.version");
  exact(item.backendFamily, cutAudioSemanticPromptPolicyIds.backendFamily, "$.backendFamily");
  if (!Array.isArray(item.groups) || item.groups.length !== 2) {
    fail("CUT_AUDIO_PROMPT_POLICY_COUNT", "$.groups", "must contain exactly the role group followed by the mood group.");
  }
  const role = closed(item.groups[0], "$.groups[0]", ["id", "prompts"]);
  const mood = closed(item.groups[1], "$.groups[1]", ["id", "prompts"]);
  exact(role.id, "role", "$.groups[0].id");
  exact(mood.id, "mood", "$.groups[1].id");
  const normalization = closed(item.normalization, "$.normalization", [
    "text", "audioEmbedding", "textEmbedding", "comparison", "groupScores",
  ]);
  const window = closed(item.window, "$.window", [
    "sampleRate", "channels", "windowSamples", "hopSamples", "channelMix", "terminalWindow",
  ]);
  return Object.freeze({
    format: cutAudioSemanticPromptPolicyFormat,
    version: cutAudioSemanticPromptPolicyVersion,
    backendFamily: cutAudioSemanticPromptPolicyIds.backendFamily,
    groups: Object.freeze([
      Object.freeze({ id: "role" as const, prompts: parsePrompts(role.prompts, "$.groups[0].prompts", cutAudioSemanticPromptRoles) }),
      Object.freeze({ id: "mood" as const, prompts: parsePrompts(mood.prompts, "$.groups[1].prompts", cutAudioSemanticPromptMoods) }),
    ]),
    normalization: Object.freeze({
      text: exact(normalization.text, cutAudioSemanticPromptPolicyIds.textNormalization, "$.normalization.text"),
      audioEmbedding: exact(normalization.audioEmbedding, cutAudioSemanticPromptPolicyIds.audioEmbeddingNormalization, "$.normalization.audioEmbedding"),
      textEmbedding: exact(normalization.textEmbedding, cutAudioSemanticPromptPolicyIds.textEmbeddingNormalization, "$.normalization.textEmbedding"),
      comparison: exact(normalization.comparison, cutAudioSemanticPromptPolicyIds.comparison, "$.normalization.comparison"),
      groupScores: exact(normalization.groupScores, cutAudioSemanticPromptPolicyIds.groupScores, "$.normalization.groupScores"),
    }),
    scoreToPpm: exact(item.scoreToPpm, cutAudioSemanticPromptPolicyIds.scoreToPpm, "$.scoreToPpm"),
    window: Object.freeze({
      sampleRate: exact(window.sampleRate, 48_000, "$.window.sampleRate"),
      channels: exact(window.channels, 1, "$.window.channels"),
      windowSamples: exact(window.windowSamples, 480_000, "$.window.windowSamples"),
      hopSamples: exact(window.hopSamples, 480_000, "$.window.hopSamples"),
      channelMix: exact(window.channelMix, cutAudioSemanticPromptPolicyIds.channelMix, "$.window.channelMix"),
      terminalWindow: exact(window.terminalWindow, cutAudioSemanticPromptPolicyIds.terminalWindow, "$.window.terminalWindow"),
    }),
  });
}

const canonicalBody: CutAudioSemanticPromptPolicyBody = Object.freeze({
  format: cutAudioSemanticPromptPolicyFormat,
  version: cutAudioSemanticPromptPolicyVersion,
  backendFamily: cutAudioSemanticPromptPolicyIds.backendFamily,
  groups: Object.freeze([
    Object.freeze({ id: "role", prompts: cutAudioSemanticPromptRoles }),
    Object.freeze({ id: "mood", prompts: cutAudioSemanticPromptMoods }),
  ]),
  normalization: Object.freeze({
    text: cutAudioSemanticPromptPolicyIds.textNormalization,
    audioEmbedding: cutAudioSemanticPromptPolicyIds.audioEmbeddingNormalization,
    textEmbedding: cutAudioSemanticPromptPolicyIds.textEmbeddingNormalization,
    comparison: cutAudioSemanticPromptPolicyIds.comparison,
    groupScores: cutAudioSemanticPromptPolicyIds.groupScores,
  }),
  scoreToPpm: cutAudioSemanticPromptPolicyIds.scoreToPpm,
  window: Object.freeze({
    sampleRate: 48_000,
    channels: 1,
    windowSamples: 480_000,
    hopSamples: 480_000,
    channelMix: cutAudioSemanticPromptPolicyIds.channelMix,
    terminalWindow: cutAudioSemanticPromptPolicyIds.terminalWindow,
  }),
});

export const cutAudioClapPromptPolicyV1: CutAudioSemanticPromptPolicy = Object.freeze({
  ...canonicalBody,
  policySha256: cutAudioSemanticPromptPolicySha256(canonicalBody),
});

export function parseCutAudioSemanticPromptPolicy(value: unknown): CutAudioSemanticPromptPolicy {
  const body = parsePromptPolicyBody(value);
  const observed = digest(record(value, "$").policySha256, "$.policySha256");
  const expected = cutAudioSemanticPromptPolicySha256(body);
  if (observed !== expected) {
    fail("CUT_AUDIO_PROMPT_POLICY_IDENTITY", "$.policySha256", "does not match the canonical prompt-policy body.");
  }
  return Object.freeze({ ...body, policySha256: expected });
}

/** Quantizes one independently normalized role or mood score under the bound v1 policy. */
export function cutAudioSemanticScoreToPpm(score: number) {
  if (!Number.isFinite(score) || score < 0 || score > 1) {
    fail("CUT_AUDIO_PROMPT_POLICY_SCORE", "$score", "must be one finite unit-interval semantic score.");
  }
  return Math.floor(score * 1_000_000 + 0.5);
}
