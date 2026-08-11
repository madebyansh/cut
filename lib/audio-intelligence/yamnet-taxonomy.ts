import { createHash } from "node:crypto";
import { stableJsonStringify } from "../core/stable";

export const cutYamnetAudioSetLabelMapSha256 = "8e1267a120c1932b7273c0d0e0c5529edbb9a35512b437b1c8982baa59047051" as const;

const roleMappings = Object.freeze([
  Object.freeze({ id: "speech", audioSetIndices: Object.freeze([0] as const), audioSetLabels: Object.freeze(["Speech"] as const) }),
  Object.freeze({ id: "music", audioSetIndices: Object.freeze([132] as const), audioSetLabels: Object.freeze(["Music"] as const) }),
  Object.freeze({ id: "silence", audioSetIndices: Object.freeze([494] as const), audioSetLabels: Object.freeze(["Silence"] as const) }),
  Object.freeze({ id: "sfx", audioSetIndices: Object.freeze([498] as const), audioSetLabels: Object.freeze(["Sound effect"] as const) }),
  Object.freeze({
    id: "ambience",
    audioSetIndices: Object.freeze([500, 501, 502, 503, 504, 508, 520] as const),
    audioSetLabels: Object.freeze([
      "Inside, small room",
      "Inside, large room or hall",
      "Inside, public space",
      "Outside, urban or manmade",
      "Outside, rural or natural",
      "Environmental noise",
      "Field recording",
    ] as const),
  }),
] as const);

const musicMoodMappings = Object.freeze([
  Object.freeze({ id: "joyful", audioSetIndices: Object.freeze([271] as const), audioSetLabels: Object.freeze(["Happy music"] as const) }),
  Object.freeze({ id: "somber", audioSetIndices: Object.freeze([272] as const), audioSetLabels: Object.freeze(["Sad music"] as const) }),
  Object.freeze({ id: "intimate", audioSetIndices: Object.freeze([273] as const), audioSetLabels: Object.freeze(["Tender music"] as const) }),
  Object.freeze({ id: "energetic", audioSetIndices: Object.freeze([274] as const), audioSetLabels: Object.freeze(["Exciting music"] as const) }),
  Object.freeze({
    id: "tense",
    audioSetIndices: Object.freeze([275, 276] as const),
    audioSetLabels: Object.freeze(["Angry music", "Scary music"] as const),
  }),
  Object.freeze({ id: "ominous", audioSetIndices: Object.freeze([276] as const), audioSetLabels: Object.freeze(["Scary music"] as const) }),
] as const);

export type CutYamnetAudioSetMapPolicyBody = Readonly<{
  format: "cut-yamnet-audioset-map-v1";
  version: 1;
  labelMap: Readonly<{ sha256: typeof cutYamnetAudioSetLabelMapSha256; classCount: 521 }>;
  scoreInput: Readonly<{
    sampleFormat: "f32le";
    ordering: "patch-major-class-index-ascending-v1";
    patchSamples: 15_600;
    patchHopSamples: 7_680;
    maximumPatchCount: 100_000;
  }>;
  scoreToPpm: "unit-interval-round-half-up-to-ppm-v1";
  aggregate: "overlapping-valid-patch-sample-weighted-mean-of-derived-patch-scores-v1";
  compositeClassScore: "maximum-listed-audioset-class-score-v1";
  interpretation: "editorial-suggestions-not-ground-truth-v1";
  musicMoodScope: "music-only-no-unmapped-mood-inference-v1";
  roles: typeof roleMappings;
  musicMoods: typeof musicMoodMappings;
}>;

export type CutYamnetAudioSetMapPolicy = CutYamnetAudioSetMapPolicyBody & Readonly<{ policySha256: string }>;

const policyBody: CutYamnetAudioSetMapPolicyBody = Object.freeze({
  format: "cut-yamnet-audioset-map-v1",
  version: 1,
  labelMap: Object.freeze({ sha256: cutYamnetAudioSetLabelMapSha256, classCount: 521 as const }),
  scoreInput: Object.freeze({
    sampleFormat: "f32le" as const,
    ordering: "patch-major-class-index-ascending-v1" as const,
    patchSamples: 15_600 as const,
    patchHopSamples: 7_680 as const,
    maximumPatchCount: 100_000 as const,
  }),
  scoreToPpm: "unit-interval-round-half-up-to-ppm-v1",
  aggregate: "overlapping-valid-patch-sample-weighted-mean-of-derived-patch-scores-v1",
  compositeClassScore: "maximum-listed-audioset-class-score-v1",
  interpretation: "editorial-suggestions-not-ground-truth-v1",
  musicMoodScope: "music-only-no-unmapped-mood-inference-v1",
  roles: roleMappings,
  musicMoods: musicMoodMappings,
});

export function cutYamnetAudioSetMapPolicySha256(body: CutYamnetAudioSetMapPolicyBody) {
  return createHash("sha256").update(stableJsonStringify(body), "utf8").digest("hex");
}

export const cutYamnetAudioSetMapV1: CutYamnetAudioSetMapPolicy = Object.freeze({
  ...policyBody,
  policySha256: cutYamnetAudioSetMapPolicySha256(policyBody),
});

export class CutYamnetAudioSetMapError extends Error {
  constructor(readonly code: string, readonly path: string, message: string) {
    super(`${code} at ${path}: ${message}`);
    this.name = "CutYamnetAudioSetMapError";
  }
}

function fail(code: string, path: string, message: string): never {
  throw new CutYamnetAudioSetMapError(code, path, message);
}

function plainRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("CUT_YAMNET_TAXONOMY_TYPE", path, "must be one plain object.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("CUT_YAMNET_TAXONOMY_TYPE", path, "must be one plain object.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!Object.hasOwn(descriptor, "value") || descriptor.get || descriptor.set) {
      fail("CUT_YAMNET_TAXONOMY_TYPE", `${path}.${key}`, "must be one ordinary data property.");
    }
  }
  return value as Record<string, unknown>;
}

function closedRecord(value: unknown, path: string, fields: readonly string[]) {
  const item = plainRecord(value, path);
  const allowed = new Set(fields);
  for (const key of Object.keys(item)) {
    if (!allowed.has(key)) fail("CUT_YAMNET_TAXONOMY_UNKNOWN_FIELD", `${path}.${key}`, "is outside the closed mapping input.");
  }
  for (const key of fields) {
    if (!Object.hasOwn(item, key)) fail("CUT_YAMNET_TAXONOMY_TYPE", `${path}.${key}`, "is required.");
  }
  return item;
}

function exact<T extends string | number>(value: unknown, expected: T, path: string): T {
  if (value !== expected) fail("CUT_YAMNET_TAXONOMY_IDENTITY", path, `must be ${JSON.stringify(expected)}.`);
  return expected;
}

function integer(value: unknown, path: string, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail("CUT_YAMNET_TAXONOMY_RANGE", path, `must be one safe integer within [${minimum},${maximum}].`);
  }
  return value as number;
}

export function cutYamnetAudioSetScoreToPpm(score: number) {
  if (!Number.isFinite(score) || score < 0 || score > 1) {
    fail("CUT_YAMNET_TAXONOMY_SCORE", "$score", "must be one finite unit-interval score.");
  }
  return Math.floor(score * 1_000_000 + 0.5);
}

export type CutYamnetAudioSetPatchInput = Readonly<{ startSample: number; validSamples: number }>;

export type CutYamnetAudioSetMapInput = Readonly<{
  labelMapSha256: string;
  sampleFormat: "f32le";
  classCount: 521;
  scoreOrdering: "patch-major-class-index-ascending-v1";
  scoreBytes: Uint8Array;
  patches: readonly CutYamnetAudioSetPatchInput[];
}>;

type RoleId = typeof roleMappings[number]["id"];
type MusicMoodId = typeof musicMoodMappings[number]["id"];
export type CutYamnetAudioSetSuggestion<Id extends string> = Readonly<{ id: Id; scorePpm: number }>;

export type CutYamnetAudioSetEditorialSuggestions = Readonly<{
  format: "cut-yamnet-audioset-editorial-suggestions";
  version: 1;
  policyId: "cut-yamnet-audioset-map-v1";
  policySha256: string;
  sourceScores: Readonly<{
    sampleFormat: "f32le";
    classCount: 521;
    ordering: "patch-major-class-index-ascending-v1";
    bytes: number;
    sha256: string;
    labelMapSha256: typeof cutYamnetAudioSetLabelMapSha256;
  }>;
  interpretation: "editorial-suggestions-not-ground-truth-v1";
  musicMoodScope: "music-only-no-unmapped-mood-inference-v1";
  aggregatePatchWeightSamples: number;
  aggregate: Readonly<{
    roleSuggestions: readonly CutYamnetAudioSetSuggestion<RoleId>[];
    musicMoodSuggestions: readonly CutYamnetAudioSetSuggestion<MusicMoodId>[];
  }>;
  patches: readonly Readonly<{
    patchIndex: number;
    startSample: number;
    validSamples: number;
    roleSuggestions: readonly CutYamnetAudioSetSuggestion<RoleId>[];
    musicMoodSuggestions: readonly CutYamnetAudioSetSuggestion<MusicMoodId>[];
  }>[];
  suggestionsSha256: string;
}>;

type MapEntry = Readonly<{ id: string; audioSetIndices: readonly number[] }>;

function derivedScore(scores: readonly number[], entry: MapEntry) {
  let maximum = 0;
  for (const index of entry.audioSetIndices) maximum = Math.max(maximum, scores[index]!);
  return maximum;
}

function suggestions<Id extends string>(
  mappings: readonly Readonly<{ id: Id; audioSetIndices: readonly number[] }>[],
  scores: readonly number[],
) {
  return Object.freeze(mappings.map((mapping) => Object.freeze({
    id: mapping.id,
    scorePpm: cutYamnetAudioSetScoreToPpm(derivedScore(scores, mapping)),
  })));
}

function weightedSuggestions<Id extends string>(
  mappings: readonly Readonly<{ id: Id; audioSetIndices: readonly number[] }>[],
  sums: readonly number[],
  totalWeight: number,
) {
  return Object.freeze(mappings.map((mapping, index) => Object.freeze({
    id: mapping.id,
    scorePpm: cutYamnetAudioSetScoreToPpm(sums[index]! / totalWeight),
  })));
}

/**
 * Maps caller-supplied YAMNet AudioSet score bytes into bounded editorial suggestions.
 * The function does not infer truth, emotion, licensing, authorship, or user intent.
 */
export function mapCutYamnetAudioSetScores(rawInput: CutYamnetAudioSetMapInput): CutYamnetAudioSetEditorialSuggestions {
  const input = closedRecord(rawInput, "$", [
    "labelMapSha256", "sampleFormat", "classCount", "scoreOrdering", "scoreBytes", "patches",
  ]);
  exact(input.labelMapSha256, cutYamnetAudioSetLabelMapSha256, "$.labelMapSha256");
  exact(input.sampleFormat, cutYamnetAudioSetMapV1.scoreInput.sampleFormat, "$.sampleFormat");
  exact(input.classCount, cutYamnetAudioSetMapV1.labelMap.classCount, "$.classCount");
  exact(input.scoreOrdering, cutYamnetAudioSetMapV1.scoreInput.ordering, "$.scoreOrdering");
  if (!(input.scoreBytes instanceof Uint8Array)) {
    fail("CUT_YAMNET_TAXONOMY_TYPE", "$.scoreBytes", "must be one Uint8Array containing exact little-endian float32 scores.");
  }
  if (typeof SharedArrayBuffer !== "undefined" && input.scoreBytes.buffer instanceof SharedArrayBuffer) {
    fail("CUT_YAMNET_TAXONOMY_TYPE", "$.scoreBytes", "must not use shared mutable backing storage.");
  }
  if (!Array.isArray(input.patches) || input.patches.length < 1
    || input.patches.length > cutYamnetAudioSetMapV1.scoreInput.maximumPatchCount) {
    fail("CUT_YAMNET_TAXONOMY_COUNT", "$.patches", `must contain 1..${cutYamnetAudioSetMapV1.scoreInput.maximumPatchCount} patches.`);
  }
  const rawPatches: unknown[] = input.patches;
  const parsedPatches: Array<Readonly<{ startSample: number; validSamples: number }>> = [];
  for (let patchIndex = 0; patchIndex < rawPatches.length; patchIndex += 1) {
    const path = `$.patches[${patchIndex}]`;
    const patch = closedRecord(rawPatches[patchIndex], path, ["startSample", "validSamples"]);
    const startSample = integer(patch.startSample, `${path}.startSample`, 0, Number.MAX_SAFE_INTEGER);
    const validSamples = integer(patch.validSamples, `${path}.validSamples`, 1, cutYamnetAudioSetMapV1.scoreInput.patchSamples);
    if (!Number.isSafeInteger(startSample + validSamples)) {
      fail("CUT_YAMNET_TAXONOMY_RANGE", path, "sample extent must remain within the safe integer range.");
    }
    if (patchIndex > 0) {
      const expected = parsedPatches[patchIndex - 1]!.startSample + cutYamnetAudioSetMapV1.scoreInput.patchHopSamples;
      if (!Number.isSafeInteger(expected) || startSample !== expected) {
        fail("CUT_YAMNET_TAXONOMY_ORDER", `${path}.startSample`, `must follow the prior patch by exactly ${cutYamnetAudioSetMapV1.scoreInput.patchHopSamples} samples.`);
      }
    }
    if (patchIndex < rawPatches.length - 1 && validSamples !== cutYamnetAudioSetMapV1.scoreInput.patchSamples) {
      fail("CUT_YAMNET_TAXONOMY_ORDER", `${path}.validSamples`, "only the terminal patch may be partially valid.");
    }
    if (rawPatches.length > 1 && patchIndex === rawPatches.length - 1
      && validSamples <= cutYamnetAudioSetMapV1.scoreInput.patchSamples - cutYamnetAudioSetMapV1.scoreInput.patchHopSamples) {
      fail("CUT_YAMNET_TAXONOMY_ORDER", `${path}.validSamples`, "terminal validity is too short for the minimal cover-the-tail framing law.");
    }
    parsedPatches.push(Object.freeze({ startSample, validSamples }));
  }

  const expectedBytes = parsedPatches.length * cutYamnetAudioSetMapV1.labelMap.classCount * 4;
  if (input.scoreBytes.byteLength !== expectedBytes) {
    fail("CUT_YAMNET_TAXONOMY_BYTES", "$.scoreBytes", `must contain exactly ${expectedBytes} bytes for ${parsedPatches.length} patches.`);
  }
  const scoreBytes = Buffer.from(input.scoreBytes);
  const scoreSha256 = createHash("sha256").update(scoreBytes).digest("hex");
  const roleSums = roleMappings.map(() => 0);
  const musicMoodSums = musicMoodMappings.map(() => 0);
  let aggregatePatchWeightSamples = 0;
  const patches = parsedPatches.map((patch, patchIndex) => {
    const scores = Array<number>(cutYamnetAudioSetMapV1.labelMap.classCount);
    const patchOffset = patchIndex * cutYamnetAudioSetMapV1.labelMap.classCount * 4;
    for (let classIndex = 0; classIndex < scores.length; classIndex += 1) {
      const score = scoreBytes.readFloatLE(patchOffset + classIndex * 4);
      if (!Number.isFinite(score) || score < 0 || score > 1) {
        fail("CUT_YAMNET_TAXONOMY_SCORE", `$.scoreBytes[patch=${patchIndex},class=${classIndex}]`, "must decode to one finite unit-interval float32 score.");
      }
      scores[classIndex] = score;
    }
    for (let index = 0; index < roleMappings.length; index += 1) {
      roleSums[index]! += derivedScore(scores, roleMappings[index]!) * patch.validSamples;
    }
    for (let index = 0; index < musicMoodMappings.length; index += 1) {
      musicMoodSums[index]! += derivedScore(scores, musicMoodMappings[index]!) * patch.validSamples;
    }
    aggregatePatchWeightSamples += patch.validSamples;
    return Object.freeze({
      patchIndex,
      startSample: patch.startSample,
      validSamples: patch.validSamples,
      roleSuggestions: suggestions(roleMappings, scores),
      musicMoodSuggestions: suggestions(musicMoodMappings, scores),
    });
  });

  const body = Object.freeze({
    format: "cut-yamnet-audioset-editorial-suggestions" as const,
    version: 1 as const,
    policyId: cutYamnetAudioSetMapV1.format,
    policySha256: cutYamnetAudioSetMapV1.policySha256,
    sourceScores: Object.freeze({
      sampleFormat: cutYamnetAudioSetMapV1.scoreInput.sampleFormat,
      classCount: cutYamnetAudioSetMapV1.labelMap.classCount,
      ordering: cutYamnetAudioSetMapV1.scoreInput.ordering,
      bytes: scoreBytes.byteLength,
      sha256: scoreSha256,
      labelMapSha256: cutYamnetAudioSetLabelMapSha256,
    }),
    interpretation: cutYamnetAudioSetMapV1.interpretation,
    musicMoodScope: cutYamnetAudioSetMapV1.musicMoodScope,
    aggregatePatchWeightSamples,
    aggregate: Object.freeze({
      roleSuggestions: weightedSuggestions(roleMappings, roleSums, aggregatePatchWeightSamples),
      musicMoodSuggestions: weightedSuggestions(musicMoodMappings, musicMoodSums, aggregatePatchWeightSamples),
    }),
    patches: Object.freeze(patches),
  });
  return Object.freeze({
    ...body,
    suggestionsSha256: createHash("sha256").update(stableJsonStringify(body), "utf8").digest("hex"),
  });
}
