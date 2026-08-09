import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { compareRational, rational, type Rational, zeroRational } from "../lib/language/rational";
import { parseCutFootageExtract, parseCutFootageIndex, parseCutFootageSearch } from "../lib/footage/contracts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Schema = { [key: string]: Json };

const sha = (digit: string) => digit.repeat(64);
const time = (numerator: string, denominator = "1") => ({ numerator, denominator });
const range = (start: string, end: string) => ({ semantics: "half-open", start: time(start), end: time(end) });
const selection = { locator: "media/harbour.mov", sha256: sha("1"), streamIndex: 0, range: range("0", "3") };

function fixture(format: "index" | "search" | "extract") {
  if (format === "index") return {
    format: "cut-footage-index", version: 1, root: "media", indexSha256: sha("a"),
    sources: [{ locator: "media/harbour.mov", bytes: 1234, sha256: sha("1"), duration: time("10"), probeSha256: sha("2"), streams: [{ index: 0, type: "video", timeBase: time("1", "24"), frameRate: time("24") }] }],
    chunkPolicy: { duration: time("3"), overlap: time("1") }, chunks: [{ id: "harbour-000", sourceLocator: "media/harbour.mov", sourceSha256: sha("1"), streamIndex: 0, range: range("0", "3") }],
    backend: { protocolVersion: 1, provider: "local", model: "clip", dimensions: 512, normalization: "l2" }, vectorArtifact: { locator: ".cut/footage/harbour.vectors", bytes: 8192, sha256: sha("3") }, creation: { cutVersion: "0.4.0", backendProtocolVersion: 1 },
  };
  if (format === "search") return { format: "cut-footage-search", version: 1, indexSha256: sha("a"), query: { text: "cargo vessel", thresholdPpm: 250000 }, matches: [{ id: "match-cargo-000", scorePpm: 875000, chunkIds: ["harbour-000"], sourceSelection: selection, handles: { head: time("1"), tail: time("1") } }], searchSha256: sha("b") };
  return { format: "cut-footage-extract", version: 1, searchSha256: sha("b"), indexSha256: sha("a"), matchId: "match-cargo-000", label: "candidate-only-not-cut-lock", sourceSelection: selection, requestedHandles: { head: time("1"), tail: time("1") }, effectiveHandles: { head: time("0"), tail: time("1") }, finalRange: range("0", "4"), toolchain: { ffmpeg: { name: "ffmpeg", version: "7.1" }, ffprobe: { name: "ffprobe", version: "7.1" } }, output: { locator: "output/cargo.mp4", bytes: 4567, sha256: sha("4"), streams: [{ index: 0, type: "video", codec: "h264" }] }, extractSha256: sha("c") };
}

function resolveSchema(schema: Schema, root: Schema): Schema {
  if (typeof schema.$ref !== "string") return schema;
  const name = schema.$ref.match(/^#\/\$defs\/([^/]+)$/u)?.[1];
  assert.ok(name, `unsupported schema reference ${schema.$ref}`);
  const target = root.$defs;
  assert.ok(target && typeof target === "object" && !Array.isArray(target));
  const resolved = target[name];
  assert.ok(resolved && typeof resolved === "object" && !Array.isArray(resolved));
  return resolved as Schema;
}

function structuralValid(schema: Schema, value: unknown, root: Schema): boolean {
  const node = resolveSchema(schema, root);
  if (Array.isArray(node.allOf) && !node.allOf.every((part) => structuralValid(part as Schema, value, root))) return false;
  if (node.const !== undefined && value !== node.const) return false;
  if (Array.isArray(node.enum) && !node.enum.includes(value as Json)) return false;
  if (node.type === "string" && typeof value !== "string") return false;
  if (node.type === "integer" && (!Number.isSafeInteger(value) || typeof value !== "number")) return false;
  if (node.type === "array" && !Array.isArray(value)) return false;
  if (node.type === "object" && (!value || typeof value !== "object" || Array.isArray(value))) return false;
  if (typeof value === "string") {
    if (typeof node.minLength === "number" && value.length < node.minLength) return false;
    if (typeof node.maxLength === "number" && value.length > node.maxLength) return false;
    if (typeof node.pattern === "string" && !(new RegExp(node.pattern, "u")).test(value)) return false;
  }
  if (typeof value === "number" && ((typeof node.minimum === "number" && value < node.minimum) || (typeof node.maximum === "number" && value > node.maximum))) return false;
  if (Array.isArray(value)) {
    if ((typeof node.minItems === "number" && value.length < node.minItems) || (typeof node.maxItems === "number" && value.length > node.maxItems)) return false;
    return !node.items || value.every((item) => structuralValid(node.items as Schema, item, root));
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>, properties = (node.properties ?? {}) as Record<string, Schema>;
    if (Array.isArray(node.required) && node.required.some((key) => typeof key !== "string" || !Object.hasOwn(object, key))) return false;
    if (node.additionalProperties === false && Object.keys(object).some((key) => !Object.hasOwn(properties, key))) return false;
    return Object.entries(properties).every(([key, child]) => !Object.hasOwn(object, key) || structuralValid(child, object[key], root));
  }
  return true;
}

function semanticValid(schema: Schema, value: unknown, root: Schema): boolean {
  const node = resolveSchema(schema, root);
  if (Array.isArray(node.allOf) && !node.allOf.every((part) => semanticValid(part as Schema, value, root))) return false;
  const rules = Array.isArray(node["x-cut-semantic"]) ? node["x-cut-semantic"] : [];
  for (const rule of rules) {
    const object = value as Record<string, unknown>;
    if (rule === "cut-rational-reduced-v1") {
      if (typeof object?.numerator !== "string" || typeof object.denominator !== "string") return false;
      const reduced = rational(object.numerator, object.denominator);
      if (reduced.numerator !== object.numerator || reduced.denominator !== object.denominator) return false;
    }
    if (rule === "cut-rational-non-negative-v1" && compareRational(value as Rational, zeroRational) < 0) return false;
    if (rule === "cut-rational-positive-v1" && compareRational(value as Rational, zeroRational) <= 0) return false;
    if (rule === "cut-half-open-range-v1") {
      const rangeValue = value as { start: Rational; end: Rational };
      if (compareRational(rangeValue.start, zeroRational) < 0 || compareRational(rangeValue.end, rangeValue.start) <= 0) return false;
    }
    if (rule === "cut-handles-non-negative-v1") {
      const handles = value as { head: Rational; tail: Rational };
      if (compareRational(handles.head, zeroRational) < 0 || compareRational(handles.tail, zeroRational) < 0) return false;
    }
  }
  if (Array.isArray(value) && node.items) return value.every((item) => semanticValid(node.items as Schema, item, root));
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const properties = (node.properties ?? {}) as Record<string, Schema>, object = value as Record<string, unknown>;
    return Object.entries(properties).every(([key, child]) => !Object.hasOwn(object, key) || semanticValid(child, object[key], root));
  }
  return true;
}

test("shipped footage schemas enforce their declared CUT rational, range, and handle semantics", async () => {
  const schemas = await Promise.all(["index", "search", "extract"].map(async (kind) => JSON.parse(await readFile(resolve("schemas", `cut-footage-${kind}-v1.schema.json`), "utf8")) as Schema));
  const fixtures = [fixture("index"), fixture("search"), fixture("extract")];
  for (const [index, schema] of schemas.entries()) {
    assert.ok(structuralValid(schema, fixtures[index], schema));
    assert.ok(semanticValid(schema, fixtures[index], schema));
  }

  const unreducedIndex = fixture("index") as ReturnType<typeof fixture> & { sources: Array<{ duration: unknown }> };
  unreducedIndex.sources[0]!.duration = time("2", "2");
  const negativeSearch = fixture("search") as ReturnType<typeof fixture> & { matches: Array<{ sourceSelection: { range: { start: unknown } } }> };
  negativeSearch.matches[0]!.sourceSelection.range.start = time("-1");
  const negativeExtract = fixture("extract") as ReturnType<typeof fixture> & { requestedHandles: { head: unknown } };
  negativeExtract.requestedHandles.head = time("-1");
  const invalid = [[schemas[0]!, unreducedIndex, parseCutFootageIndex], [schemas[1]!, negativeSearch, parseCutFootageSearch], [schemas[2]!, negativeExtract, parseCutFootageExtract]] as const;
  for (const [schema, value, parse] of invalid) {
    assert.ok(structuralValid(schema, value, schema), "JSON Schema structural constraints admit arithmetic cases intentionally delegated to CUT semantics");
    assert.equal(semanticValid(schema, value, schema), false);
    assert.throws(() => parse(JSON.stringify(value)));
  }
});
