import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { stableJsonStringify } from "../lib/core/stable";
import {
  CutFootageError,
  parseCutFootageExtract,
  parseCutFootageIndex,
  parseCutFootageSearch,
} from "../lib/footage/contracts";

const digest = (value: unknown) => createHash("sha256").update(stableJsonStringify(value)).digest("hex");
const sha = (digit: string) => digit.repeat(64);
const time = (numerator: string, denominator = "1") => ({ numerator, denominator });
const range = (start: string, end: string) => ({ semantics: "half-open", start: time(start), end: time(end) });

function signed<T extends Record<string, unknown>>(value: T, field: "indexSha256" | "searchSha256" | "extractSha256") {
  const { [field]: _ignored, ...body } = value;
  return { ...body, [field]: digest(body) };
}

function indexFixture() {
  return signed({
    format: "cut-footage-index",
    version: 1,
    root: "media",
    sources: [{
      locator: "media/harbour.mov", bytes: 1234, sha256: sha("1"), duration: time("10"), probeSha256: sha("2"),
      streams: [{ index: 0, type: "video", timeBase: time("1", "24"), frameRate: time("24") }],
    }],
    chunkPolicy: { duration: time("3"), overlap: time("1") },
    chunks: [
      { id: "harbour-000", sourceLocator: "media/harbour.mov", sourceSha256: sha("1"), streamIndex: 0, range: range("0", "3") },
      { id: "harbour-001", sourceLocator: "media/harbour.mov", sourceSha256: sha("1"), streamIndex: 0, range: range("2", "5") },
    ],
    backend: { protocolVersion: 1, provider: "local", model: "Xenova/clip-vit-base-patch32", dimensions: 512, normalization: "l2" },
    vectorArtifact: { locator: ".cut/footage/harbour.vectors", bytes: 8192, sha256: sha("3") },
    creation: { cutVersion: "0.4.0-alpha.3", backendProtocolVersion: 1 },
    indexSha256: "ignored",
  }, "indexSha256");
}

function searchFixture() {
  const index = indexFixture();
  return signed({
    format: "cut-footage-search",
    version: 1,
    indexSha256: index.indexSha256,
    query: { text: "cargo vessel", thresholdPpm: 250000 },
    matches: [{
      id: "match-cargo-000", scorePpm: 875000, chunkIds: ["harbour-000"],
      sourceSelection: { locator: "media/harbour.mov", sha256: sha("1"), streamIndex: 0, range: range("0", "3") },
      handles: { head: time("1"), tail: time("1") },
    }],
    searchSha256: "ignored",
  }, "searchSha256");
}

function extractFixture() {
  const search = searchFixture();
  return signed({
    format: "cut-footage-extract",
    version: 1,
    searchSha256: search.searchSha256,
    indexSha256: search.indexSha256,
    matchId: "match-cargo-000",
    label: "candidate-only-not-cut-lock",
    sourceSelection: { locator: "media/harbour.mov", sha256: sha("1"), streamIndex: 0, range: range("0", "3") },
    requestedHandles: { head: time("1"), tail: time("1") },
    effectiveHandles: { head: time("0"), tail: time("1") },
    finalRange: range("0", "4"),
    toolchain: { ffmpeg: { name: "ffmpeg", version: "7.1" }, ffprobe: { name: "ffprobe", version: "7.1" } },
    output: { locator: "output/cargo.mp4", bytes: 4567, sha256: sha("4"), streams: [{ index: 0, type: "video", codec: "h264" }] },
    extractSha256: "ignored",
  }, "extractSha256");
}

test("footage v1 decoders preserve canonical identities and exact rational wire values", () => {
  const index = parseCutFootageIndex(JSON.stringify(indexFixture()));
  const search = parseCutFootageSearch(JSON.stringify(searchFixture()));
  const extract = parseCutFootageExtract(JSON.stringify(extractFixture()));

  assert.equal(index.indexSha256, indexFixture().indexSha256);
  assert.equal(search.matches[0]!.scorePpm, 875000);
  assert.deepEqual(search.matches[0]!.sourceSelection.range, range("0", "3"));
  assert.equal(extract.label, "candidate-only-not-cut-lock");
  assert.equal(extract.extractSha256, extractFixture().extractSha256);
});

test("footage v1 decoders fail closed on hostile shapes, stale identities, and invalid collections", () => {
  const index = indexFixture(), search = searchFixture();
  const duplicateChunks = signed({ ...index, chunks: [...index.chunks, index.chunks[0]!] }, "indexSha256");
  const unsafeRoot = signed({ ...index, root: "../media" }, "indexSha256");
  const offGridChunk = signed({ ...index, chunks: [{ ...index.chunks[0]!, range: { semantics: "half-open", start: time("1", "48"), end: time("3") } }] }, "indexSha256");
  const excessiveMatches = signed({ ...search, matches: Array.from({ length: 101 }, () => search.matches[0]!) }, "searchSha256");
  const invalid: Array<{ value: unknown; parse: (value: string) => unknown; code: string }> = [
    { value: { ...index, surprise: true }, parse: parseCutFootageIndex, code: "CUT_FOOTAGE_BACKEND_PROTOCOL" },
    { value: { ...index, indexSha256: sha("f") }, parse: parseCutFootageIndex, code: "CUT_FOOTAGE_INDEX_STALE" },
    { value: unsafeRoot, parse: parseCutFootageIndex, code: "CUT_FOOTAGE_INDEX_STALE" },
    { value: duplicateChunks, parse: parseCutFootageIndex, code: "CUT_FOOTAGE_INDEX_STALE" },
    { value: offGridChunk, parse: parseCutFootageIndex, code: "CUT_FOOTAGE_RANGE" },
    { value: excessiveMatches, parse: parseCutFootageSearch, code: "CUT_FOOTAGE_BACKEND_PROTOCOL" },
    { value: { ...search, matches: [{ ...search.matches[0], scorePpm: Number.POSITIVE_INFINITY }] }, parse: parseCutFootageSearch, code: "CUT_FOOTAGE_BACKEND_PROTOCOL" },
    { value: { ...search, matches: [{ ...search.matches[0], sourceSelection: { ...search.matches[0].sourceSelection, range: range("1", "1") } }] }, parse: parseCutFootageSearch, code: "CUT_FOOTAGE_RANGE" },
  ];
  for (const { value, parse, code } of invalid) {
    assert.throws(() => parse(JSON.stringify(value)), (error: unknown) => error instanceof CutFootageError && error.code === code);
  }
  const noncanonical = structuredClone(index);
  noncanonical.sources[0]!.duration = time("2", "2");
  noncanonical.indexSha256 = signed(noncanonical, "indexSha256").indexSha256;
  assert.throws(() => parseCutFootageIndex(JSON.stringify(noncanonical)), (error: unknown) => error instanceof CutFootageError && error.code === "CUT_FOOTAGE_RANGE");
});
