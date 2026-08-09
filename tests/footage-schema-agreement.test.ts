import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import Ajv from "ajv";
import { stableJsonStringify } from "../lib/core/stable";
import { parseCutFootageExtract, parseCutFootageIndex, parseCutFootageSearch } from "../lib/footage/contracts";
import { compileCutFootageSchema } from "../lib/footage/schema";

const sha = (digit: string) => digit.repeat(64);
const time = (numerator: string, denominator = "1") => ({ numerator, denominator });
const range = (start: string, end: string) => ({ semantics: "half-open", start: time(start), end: time(end) });
const digest = (value: unknown) => createHash("sha256").update(stableJsonStringify(value)).digest("hex");

function signed<T extends Record<string, unknown>>(value: T, field: "indexSha256" | "searchSha256" | "extractSha256") {
  const { [field]: _identity, ...body } = value;
  return { ...body, [field]: digest(body) };
}

function indexFixture() {
  return signed({
    format: "cut-footage-index", version: 1, root: "media", indexSha256: "ignored",
    sources: [{ locator: "media/harbour.mov", bytes: 1234, sha256: sha("1"), duration: time("10"), probeSha256: sha("2"), streams: [{ index: 0, type: "video", timeBase: time("1", "24"), frameRate: time("24") }] }],
    chunkPolicy: { duration: time("3"), overlap: time("1") }, chunks: [{ id: "harbour-000", sourceLocator: "media/harbour.mov", sourceSha256: sha("1"), streamIndex: 0, range: range("0", "3") }],
    backend: { protocolVersion: 1, provider: "local", model: "clip", dimensions: 512, normalization: "l2" }, vectorArtifact: { locator: ".cut/footage/harbour.vectors", bytes: 8192, sha256: sha("3") }, creation: { cutVersion: "0.4.0", backendProtocolVersion: 1 },
  }, "indexSha256");
}

function searchFixture() {
  const index = indexFixture();
  return signed({
    format: "cut-footage-search", version: 1, indexSha256: index.indexSha256, searchSha256: "ignored", query: { text: "cargo vessel", thresholdPpm: 250000 },
    matches: [{ id: "match-cargo-000", scorePpm: 875000, chunkIds: ["harbour-000"], sourceSelection: { locator: "media/harbour.mov", sha256: sha("1"), streamIndex: 0, range: range("0", "3") }, handles: { head: time("1"), tail: time("1") } }],
  }, "searchSha256");
}

function extractFixture() {
  const search = searchFixture();
  return signed({
    format: "cut-footage-extract", version: 1, searchSha256: search.searchSha256, indexSha256: search.indexSha256, matchId: "match-cargo-000", label: "candidate-only-not-cut-lock", extractSha256: "ignored",
    sourceSelection: { locator: "media/harbour.mov", sha256: sha("1"), streamIndex: 0, range: range("0", "3") }, requestedHandles: { head: time("1"), tail: time("1") }, effectiveHandles: { head: time("0"), tail: time("1") }, finalRange: range("0", "4"), toolchain: { ffmpeg: { name: "ffmpeg", version: "7.1" }, ffprobe: { name: "ffprobe", version: "7.1" } }, output: { locator: "output/cargo.mp4", bytes: 4567, sha256: sha("4"), streams: [{ index: 0, type: "video", codec: "h264" }] },
  }, "extractSha256");
}

async function schema(kind: "index" | "search" | "extract") {
  return JSON.parse(await readFile(resolve("schemas", `cut-footage-${kind}-v1.schema.json`), "utf8")) as Record<string, unknown>;
}

test("footage schemas fail closed without the executable CUT semantic keyword", async () => {
  const [indexSchema, searchSchema, extractSchema] = await Promise.all([schema("index"), schema("search"), schema("extract")]);
  const unsupported = new Ajv({ schemaId: "auto", meta: false, validateSchema: false, allErrors: true, jsonPointers: true, strictKeywords: true });
  assert.throws(() => unsupported.compile(indexSchema), /unknown keyword: cutSemantic/u);
  for (const [schemaValue, fixture] of [[indexSchema, indexFixture()], [searchSchema, searchFixture()], [extractSchema, extractFixture()]] as const) {
    const validate = compileCutFootageSchema(schemaValue);
    assert.equal(validate(fixture), true, JSON.stringify(validate.errors));
  }
});

test("real JSON Schema and runtime reject the same signed rational, range, and handle defects", async () => {
  const [indexSchema, searchSchema, extractSchema] = await Promise.all([schema("index"), schema("search"), schema("extract")]);
  const unreducedIndex = signed({ ...indexFixture(), sources: [{ ...indexFixture().sources[0]!, duration: time("2", "2") }] }, "indexSha256");
  const negativeSearch = signed({ ...searchFixture(), matches: [{ ...searchFixture().matches[0]!, sourceSelection: { ...searchFixture().matches[0]!.sourceSelection, range: range("-1", "3") } }] }, "searchSha256");
  const reversedSearch = signed({ ...searchFixture(), matches: [{ ...searchFixture().matches[0]!, sourceSelection: { ...searchFixture().matches[0]!.sourceSelection, range: range("3", "2") } }] }, "searchSha256");
  const negativeExtract = signed({ ...extractFixture(), requestedHandles: { head: time("-1"), tail: time("1") } }, "extractSha256");
  const reversedExtract = signed({ ...extractFixture(), finalRange: range("4", "0") }, "extractSha256");
  const cases = [
    { schema: indexSchema, value: unreducedIndex, parse: parseCutFootageIndex, code: "CUT_FOOTAGE_RANGE", path: "$.sources[0].duration" },
    { schema: searchSchema, value: negativeSearch, parse: parseCutFootageSearch, code: "CUT_FOOTAGE_RANGE", path: "$.matches[0].sourceSelection.range.start" },
    { schema: searchSchema, value: reversedSearch, parse: parseCutFootageSearch, code: "CUT_FOOTAGE_RANGE", path: "$.matches[0].sourceSelection.range" },
    { schema: extractSchema, value: negativeExtract, parse: parseCutFootageExtract, code: "CUT_FOOTAGE_RANGE", path: "$.requestedHandles.head" },
    { schema: extractSchema, value: reversedExtract, parse: parseCutFootageExtract, code: "CUT_FOOTAGE_RANGE", path: "$.finalRange" },
  ];
  for (const item of cases) {
    const validate = compileCutFootageSchema(item.schema);
    assert.equal(validate(item.value), false, "schema must reject the semantic defect");
    assert.ok(validate.errors?.some((error) => error.keyword === "cutSemantic"), JSON.stringify(validate.errors));
    assert.throws(
      () => item.parse(JSON.stringify(item.value)),
      (error: unknown) => error instanceof Error && "code" in error && error.code === item.code && "path" in error && error.path === item.path,
    );
  }
});
