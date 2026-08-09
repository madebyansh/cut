import assert from "node:assert/strict";
import test from "node:test";
import type { CutFootageIndex } from "../lib/footage/contracts";
import { CutFootageError } from "../lib/footage/diagnostics";
import {
  buildCutFootageSearchReport,
  normalizeCutFootageQuery,
  quantizeCutFootageScorePpm,
  rankCutFootageCandidates,
} from "../lib/footage/search";
import { rational } from "../lib/language/rational";

const digest = (digit: string) => digit.repeat(64);
const range = (start: number, end: number) => Object.freeze({ semantics: "half-open" as const, start: rational(start), end: rational(end) });

function fixtureIndex(): CutFootageIndex {
  const streams = Object.freeze([{ index: 0, type: "video" as const, timeBase: rational(1, 30), frameRate: rational(30) }]);
  const sources = Object.freeze([
    Object.freeze({ locator: "media/a.mp4", bytes: 10, sha256: digest("a"), duration: rational(20), probeSha256: digest("b"), streams }),
    Object.freeze({ locator: "media/b.mp4", bytes: 11, sha256: digest("c"), duration: rational(20), probeSha256: digest("d"), streams }),
  ]);
  const chunks = Object.freeze([
    Object.freeze({ id: "chunk-a0", sourceLocator: "media/a.mp4", sourceSha256: digest("a"), streamIndex: 0, range: range(0, 8) }),
    Object.freeze({ id: "chunk-a1", sourceLocator: "media/a.mp4", sourceSha256: digest("a"), streamIndex: 0, range: range(6, 14) }),
    Object.freeze({ id: "chunk-a2", sourceLocator: "media/a.mp4", sourceSha256: digest("a"), streamIndex: 0, range: range(14, 20) }),
    Object.freeze({ id: "chunk-b0", sourceLocator: "media/b.mp4", sourceSha256: digest("c"), streamIndex: 0, range: range(0, 8) }),
  ]);
  return Object.freeze({
    format: "cut-footage-index", version: 1, root: "media", sources,
    chunkPolicy: Object.freeze({ duration: rational(8), overlap: rational(2) }), chunks,
    backend: Object.freeze({ protocolVersion: 1, provider: "fixture", model: "clip@r1+adapter.abc", dimensions: 4, normalization: "l2" }),
    vectorArtifact: Object.freeze({ locator: ".cut/footage.vectors", bytes: 100, sha256: digest("e") }),
    creation: Object.freeze({ cutVersion: "0.4.0-test", backendProtocolVersion: 1 }), indexSha256: digest("f"),
  });
}

function protocol(action: () => unknown) {
  assert.throws(action, (error: unknown) => error instanceof CutFootageError && error.code === "CUT_FOOTAGE_BACKEND_PROTOCOL");
}

test("footage query normalization is exact NFKC plus trim and bounded UTF-8", () => {
  assert.equal(normalizeCutFootageQuery("  Ｄｏｇ   outdoors  "), "Dog   outdoors");
  for (const value of [undefined, "", "   ", "dog\npark", "x".repeat(16_385)]) protocol(() => normalizeCutFootageQuery(value));
  protocol(() => normalizeCutFootageQuery("ﬃ".repeat(1_500)));
});

test("footage score quantization clamps, rounds once, and never returns negative zero", () => {
  assert.equal(quantizeCutFootageScorePpm(2), 1_000_000);
  assert.equal(quantizeCutFootageScorePpm(-2), -1_000_000);
  assert.equal(quantizeCutFootageScorePpm(0.0000005), 1);
  assert.equal(quantizeCutFootageScorePpm(-0.0000005), 0);
  assert.equal(Object.is(quantizeCutFootageScorePpm(-0), -0), false);
  for (const value of [NaN, Infinity, -Infinity, "0.5"]) protocol(() => quantizeCutFootageScorePpm(value));
});

test("ranking is enumeration-independent, inclusive, and suppresses only positive same-source overlap", () => {
  const index = fixtureIndex();
  const candidates = [
    { chunkId: "chunk-a1", score: 0.9 },
    { chunkId: "chunk-a2", score: 0.8 },
    { chunkId: "chunk-b0", score: 0.9 },
    { chunkId: "chunk-a0", score: 0.9 },
  ];
  const expected = rankCutFootageCandidates(index, candidates, { thresholdPpm: 800_000, limit: 10 });
  const shuffled = rankCutFootageCandidates(index, [...candidates].reverse(), { thresholdPpm: 800_000, limit: 10 });
  assert.deepEqual(shuffled, expected);
  assert.deepEqual(expected.map((match) => [match.sourceSelection.locator, match.chunkIds[0], match.scorePpm]), [
    ["media/a.mp4", "chunk-a0", 900_000],
    ["media/b.mp4", "chunk-b0", 900_000],
    ["media/a.mp4", "chunk-a2", 800_000],
  ]);
  assert.equal(expected.every((match) => /^match-[a-f0-9]{64}$/u.test(match.id)), true);
});

test("ranking fails closed for candidate-set drift and invalid limits", () => {
  const index = fixtureIndex(), candidates = index.chunks.map((chunk) => ({ chunkId: chunk.id, score: 0.5 }));
  protocol(() => rankCutFootageCandidates(index, candidates.slice(1), { thresholdPpm: 0, limit: 10 }));
  protocol(() => rankCutFootageCandidates(index, [...candidates, candidates[0]!], { thresholdPpm: 0, limit: 10 }));
  protocol(() => rankCutFootageCandidates(index, [{ ...candidates[0]!, chunkId: "unknown" }, ...candidates.slice(1)], { thresholdPpm: 0, limit: 10 }));
  protocol(() => rankCutFootageCandidates(index, candidates, { thresholdPpm: 1_000_001, limit: 10 }));
  protocol(() => rankCutFootageCandidates(index, candidates, { thresholdPpm: 0, limit: 0 }));
});

test("ranking permits an honest deterministic empty match list", () => {
  const index = fixtureIndex(), candidates = index.chunks.map((chunk) => ({ chunkId: chunk.id, score: -0.5 }));
  assert.deepEqual(rankCutFootageCandidates(index, candidates, { thresholdPpm: 0, limit: 10 }), []);
});

test("search report bytes and identity do not depend on candidate enumeration", () => {
  const index = fixtureIndex(), candidates = index.chunks.map((chunk, ordinal) => ({ chunkId: chunk.id, score: 0.9 - ordinal / 10 }));
  const left = buildCutFootageSearchReport(index, "  Ｄｏｇ outdoors  ", candidates, { thresholdPpm: 0, limit: 10 });
  const right = buildCutFootageSearchReport(index, "Dog outdoors", [...candidates].reverse(), { thresholdPpm: 0, limit: 10 });
  assert.deepEqual(left, right);
  assert.equal(left.report.query.text, "Dog outdoors");
  assert.equal(left.bytes.at(-1), 10);
  assert.match(left.report.searchSha256, /^[a-f0-9]{64}$/u);
});
