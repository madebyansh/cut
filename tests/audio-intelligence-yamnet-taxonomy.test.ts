import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { stableJsonStringify } from "../lib/core/stable";
import {
  CutYamnetAudioSetMapError,
  cutYamnetAudioSetLabelMapSha256,
  cutYamnetAudioSetMapPolicySha256,
  cutYamnetAudioSetMapV1,
  cutYamnetAudioSetScoreToPpm,
  mapCutYamnetAudioSetScores,
  type CutYamnetAudioSetMapInput,
} from "../lib/audio-intelligence/yamnet-taxonomy";

const classCount = 521;

function scoreBytes(patches: readonly Readonly<Record<number, number>>[]) {
  const bytes = Buffer.alloc(patches.length * classCount * 4);
  patches.forEach((scores, patchIndex) => {
    for (const [rawIndex, score] of Object.entries(scores)) {
      const classIndex = Number(rawIndex);
      bytes.writeFloatLE(score, (patchIndex * classCount + classIndex) * 4);
    }
  });
  return bytes;
}

function input(
  scores: readonly Readonly<Record<number, number>>[] = [{}],
  patches: readonly Readonly<{ startSample: number; validSamples: number }>[] = [{ startSample: 0, validSamples: 15_600 }],
): CutYamnetAudioSetMapInput {
  return {
    labelMapSha256: cutYamnetAudioSetLabelMapSha256,
    sampleFormat: "f32le",
    classCount,
    scoreOrdering: "patch-major-class-index-ascending-v1",
    scoreBytes: scoreBytes(scores),
    patches,
  };
}

function suggestion(group: readonly Readonly<{ id: string; scorePpm: number }>[], id: string) {
  return group.find((item) => item.id === id)?.scorePpm;
}

function expectFailure(value: CutYamnetAudioSetMapInput, code: string) {
  assert.throws(
    () => mapCutYamnetAudioSetScores(value),
    (error: unknown) => error instanceof CutYamnetAudioSetMapError && error.code === code,
  );
}

test("YAMNet AudioSet policy binds the exact official map, indices, score law, and editorial scope", () => {
  assert.equal(cutYamnetAudioSetMapV1.format, "cut-yamnet-audioset-map-v1");
  assert.equal(cutYamnetAudioSetMapV1.labelMap.sha256, "8e1267a120c1932b7273c0d0e0c5529edbb9a35512b437b1c8982baa59047051");
  assert.equal(cutYamnetAudioSetMapV1.labelMap.classCount, 521);
  assert.deepEqual(cutYamnetAudioSetMapV1.roles.map(({ id, audioSetIndices }) => [id, audioSetIndices]), [
    ["speech", [0]], ["music", [132]], ["silence", [494]], ["sfx", [498]],
    ["ambience", [500, 501, 502, 503, 504, 508, 520]],
  ]);
  assert.deepEqual(cutYamnetAudioSetMapV1.musicMoods.map(({ id, audioSetIndices }) => [id, audioSetIndices]), [
    ["joyful", [271]], ["somber", [272]], ["intimate", [273]], ["energetic", [274]],
    ["tense", [275, 276]], ["ominous", [276]],
  ]);
  const { policySha256: _ignored, ...body } = cutYamnetAudioSetMapV1;
  assert.equal(cutYamnetAudioSetMapPolicySha256(body), cutYamnetAudioSetMapV1.policySha256);
  assert.equal(cutYamnetAudioSetMapV1.policySha256, "9c62b23d62a05871aa1b124afc509fc2edbdeddca5b7c43e5e4facfcf4508efc");
  assert.equal(cutYamnetAudioSetMapV1.interpretation, "editorial-suggestions-not-ground-truth-v1");
  assert.equal(cutYamnetAudioSetMapV1.musicMoodScope, "music-only-no-unmapped-mood-inference-v1");
  assert.ok(Object.isFrozen(cutYamnetAudioSetMapV1) && Object.isFrozen(cutYamnetAudioSetMapV1.roles[4]?.audioSetIndices));
});

test("one exact score patch maps roles, max-composites, and only defensible music moods", () => {
  const result = mapCutYamnetAudioSetScores(input([{
    0: 0.125,
    132: 0.25,
    494: 0.375,
    498: 0.5,
    500: 0.25,
    504: 0.75,
    271: 0.125,
    272: 0.25,
    273: 0.375,
    274: 0.5,
    275: 0.625,
    276: 0.75,
  }]));
  assert.deepEqual(result.patches[0]?.roleSuggestions, [
    { id: "speech", scorePpm: 125_000 },
    { id: "music", scorePpm: 250_000 },
    { id: "silence", scorePpm: 375_000 },
    { id: "sfx", scorePpm: 500_000 },
    { id: "ambience", scorePpm: 750_000 },
  ]);
  assert.deepEqual(result.patches[0]?.musicMoodSuggestions, [
    { id: "joyful", scorePpm: 125_000 },
    { id: "somber", scorePpm: 250_000 },
    { id: "intimate", scorePpm: 375_000 },
    { id: "energetic", scorePpm: 500_000 },
    { id: "tense", scorePpm: 750_000 },
    { id: "ominous", scorePpm: 750_000 },
  ]);
  assert.equal(result.interpretation, "editorial-suggestions-not-ground-truth-v1");
  assert.equal(result.musicMoodScope, "music-only-no-unmapped-mood-inference-v1");
  assert.doesNotMatch(JSON.stringify(result), /calm|hopeful|reflective|triumphant/u);
});

test("aggregate scores use exact valid-sample weights after each patch composite", () => {
  const result = mapCutYamnetAudioSetScores(input([
    { 0: 0.25, 500: 0.75, 501: 0.125, 275: 0.5, 276: 0.25 },
    { 0: 1, 500: 0.25, 501: 0.5, 275: 0.125, 276: 1 },
  ], [
    { startSample: 100, validSamples: 15_600 },
    { startSample: 7_780, validSamples: 7_921 },
  ]));
  assert.equal(result.aggregatePatchWeightSamples, 23_521);
  assert.equal(suggestion(result.aggregate.roleSuggestions, "speech"), 502_572);
  assert.equal(suggestion(result.aggregate.roleSuggestions, "ambience"), 665_809);
  assert.equal(suggestion(result.aggregate.musicMoodSuggestions, "tense"), 668_381);
  assert.equal(suggestion(result.aggregate.musicMoodSuggestions, "ominous"), 502_572);
  assert.deepEqual(result.patches.map(({ patchIndex, startSample, validSamples }) => [patchIndex, startSample, validSamples]), [
    [0, 100, 15_600], [1, 7_780, 7_921],
  ]);
});

test("score conversion uses finite unit interval round-half-up PPM", () => {
  assert.equal(cutYamnetAudioSetScoreToPpm(0), 0);
  assert.equal(cutYamnetAudioSetScoreToPpm(0.000_000_49), 0);
  assert.equal(cutYamnetAudioSetScoreToPpm(0.000_000_5), 1);
  assert.equal(cutYamnetAudioSetScoreToPpm(0.123_456_5), 123_457);
  assert.equal(cutYamnetAudioSetScoreToPpm(1), 1_000_000);
  for (const score of [-Number.EPSILON, 1 + Number.EPSILON, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => cutYamnetAudioSetScoreToPpm(score), /CUT_YAMNET_TAXONOMY_SCORE/u);
  }
});

test("mapper rejects label, encoding, ordering, byte-count, and patch-boundary drift", () => {
  expectFailure({ ...input(), labelMapSha256: "0".repeat(64) }, "CUT_YAMNET_TAXONOMY_IDENTITY");
  expectFailure({ ...input(), sampleFormat: "f32be" as "f32le" }, "CUT_YAMNET_TAXONOMY_IDENTITY");
  expectFailure({ ...input(), classCount: 520 as 521 }, "CUT_YAMNET_TAXONOMY_IDENTITY");
  expectFailure({ ...input(), scoreOrdering: "class-major" as CutYamnetAudioSetMapInput["scoreOrdering"] }, "CUT_YAMNET_TAXONOMY_IDENTITY");
  expectFailure({ ...input(), scoreBytes: Buffer.alloc(classCount * 4 - 1) }, "CUT_YAMNET_TAXONOMY_BYTES");
  expectFailure({ ...input(), scoreBytes: Buffer.alloc(classCount * 4 + 1) }, "CUT_YAMNET_TAXONOMY_BYTES");
  expectFailure(input([{}, {}], [{ startSample: 0, validSamples: 15_600 }, { startSample: 7_681, validSamples: 15_600 }]), "CUT_YAMNET_TAXONOMY_ORDER");
  expectFailure(input([{}, {}], [{ startSample: 0, validSamples: 1 }, { startSample: 7_680, validSamples: 1 }]), "CUT_YAMNET_TAXONOMY_ORDER");
  expectFailure(input([{}, {}], [{ startSample: 0, validSamples: 15_600 }, { startSample: 7_680, validSamples: 7_920 }]), "CUT_YAMNET_TAXONOMY_ORDER");
  expectFailure(input([{}], [{ startSample: 0, validSamples: 0 }]), "CUT_YAMNET_TAXONOMY_RANGE");
  expectFailure(input([{}], [{ startSample: 0, validSamples: 15_601 }]), "CUT_YAMNET_TAXONOMY_RANGE");
});

test("every float32 score is validated before mapped output is accepted", () => {
  for (const score of [Number.NaN, Number.POSITIVE_INFINITY, -0.125, 1.125]) {
    const value = input();
    const bytes = Buffer.from(value.scoreBytes);
    bytes.writeFloatLE(score, 400 * 4);
    expectFailure({ ...value, scoreBytes: bytes }, "CUT_YAMNET_TAXONOMY_SCORE");
  }
});

test("closed input rejects unknown/accessor metadata and shared mutable score storage", () => {
  expectFailure(Object.assign(input(), { calibration: "host" }) as CutYamnetAudioSetMapInput, "CUT_YAMNET_TAXONOMY_UNKNOWN_FIELD");
  const accessor = { ...input() } as Record<string, unknown>;
  Object.defineProperty(accessor, "classCount", { enumerable: true, get: () => 521 });
  expectFailure(accessor as CutYamnetAudioSetMapInput, "CUT_YAMNET_TAXONOMY_TYPE");
  const patch = { startSample: 0, validSamples: 15_600, hidden: true };
  expectFailure(input([{}], [patch]), "CUT_YAMNET_TAXONOMY_UNKNOWN_FIELD");
  if (typeof SharedArrayBuffer !== "undefined") {
    const shared = new Uint8Array(new SharedArrayBuffer(classCount * 4));
    expectFailure({ ...input(), scoreBytes: shared }, "CUT_YAMNET_TAXONOMY_TYPE");
  }
});

test("mapping is repeatable, hash-bound, deeply immutable, and does not mutate caller buffers", () => {
  const value = input([{ 0: 0.5, 132: 0.25, 271: 0.75 }]);
  const beforeBytes = Buffer.from(value.scoreBytes);
  const beforePatches = structuredClone(value.patches);
  const first = mapCutYamnetAudioSetScores(value);
  const second = mapCutYamnetAudioSetScores(value);
  assert.deepEqual(first, second);
  assert.deepEqual(value.scoreBytes, beforeBytes);
  assert.deepEqual(value.patches, beforePatches);
  const { suggestionsSha256: _ignored, ...body } = first;
  assert.equal(first.suggestionsSha256, createHash("sha256").update(stableJsonStringify(body), "utf8").digest("hex"));
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.aggregate)
    && Object.isFrozen(first.aggregate.roleSuggestions) && Object.isFrozen(first.patches[0]?.musicMoodSuggestions));
  assert.throws(() => {
    (first.patches[0]!.roleSuggestions[0] as { scorePpm: number }).scorePpm = 1;
  }, TypeError);

  const changed = Buffer.from(value.scoreBytes);
  changed.writeFloatLE(0.75, 0);
  const changedResult = mapCutYamnetAudioSetScores({ ...value, scoreBytes: changed });
  assert.notEqual(changedResult.sourceScores.sha256, first.sourceScores.sha256);
  assert.notEqual(changedResult.suggestionsSha256, first.suggestionsSha256);
});
