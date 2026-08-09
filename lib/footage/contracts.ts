import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { stableJsonStringify } from "../core/stable";
import { maximumRationalDigits, rational, compareRational, divideRational, type Rational, zeroRational } from "../language/rational";
import { parseStrictPackageJson } from "../package/json";
import { CutFootageError, footageFail } from "./diagnostics";
import type { CutFootageHandles, CutFootageRange } from "./range";

export { CutFootageError } from "./diagnostics";
export type { CutFootageHandles, CutFootageRange } from "./range";

export const cutFootageLimits = Object.freeze({
  maximumBytes: 1024 * 1024,
  maximumSources: 10_000,
  maximumStreamsPerSource: 64,
  maximumChunks: 100_000,
  maximumMatches: 100,
  maximumChunkIdsPerMatch: 256,
  maximumTextBytes: 4_096,
  maximumLocatorBytes: 1_024,
  maximumOutputStreams: 64,
});

export type CutFootageSourceSelection = Readonly<{ locator: string; sha256: string; streamIndex: number; range: CutFootageRange }>;
export type CutFootageIndex = Readonly<{
  format: "cut-footage-index"; version: 1; root: string;
  sources: readonly Readonly<{ locator: string; bytes: number; sha256: string; duration: Rational; probeSha256: string; streams: readonly Readonly<{ index: number; type: "video" | "audio"; timeBase: Rational; frameRate?: Rational }>[] }> [];
  chunkPolicy: Readonly<{ duration: Rational; overlap: Rational }>;
  chunks: readonly Readonly<{ id: string; sourceLocator: string; sourceSha256: string; streamIndex: number; range: CutFootageRange }>[];
  backend: Readonly<{ protocolVersion: 1; provider: string; model: string; dimensions: number; normalization: "l2" }>;
  vectorArtifact: Readonly<{ locator: string; bytes: number; sha256: string }>;
  creation: Readonly<{ cutVersion: string; backendProtocolVersion: 1 }>;
  indexSha256: string;
}>;
export type CutFootageSearch = Readonly<{
  format: "cut-footage-search"; version: 1; indexSha256: string;
  query: Readonly<{ text: string; thresholdPpm: number }>;
  matches: readonly Readonly<{ id: string; scorePpm: number; chunkIds: readonly string[]; sourceSelection: CutFootageSourceSelection; handles?: CutFootageHandles }>[];
  searchSha256: string;
}>;
export type CutFootageExtract = Readonly<{
  format: "cut-footage-extract"; version: 1; searchSha256: string; indexSha256: string; matchId: string; label: "candidate-only-not-cut-lock";
  sourceSelection: CutFootageSourceSelection; requestedHandles: CutFootageHandles; effectiveHandles: CutFootageHandles; finalRange: CutFootageRange;
  toolchain: Readonly<{ ffmpeg: Readonly<{ name: "ffmpeg"; version: string }>; ffprobe: Readonly<{ name: "ffprobe"; version: string }> }>;
  output: Readonly<{ locator: string; bytes: number; sha256: string; streams: readonly Readonly<{ index: number; type: "video" | "audio"; codec: string }>[] }>;
  extractSha256: string;
}>;

function protocol(path: string, message: string): never { return footageFail("CUT_FOOTAGE_BACKEND_PROTOCOL", path, message); }
function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) protocol(path, "must be one plain object.");
  return value as Record<string, unknown>;
}
function closed(value: unknown, path: string, required: readonly string[], optional: readonly string[] = []) {
  const result = object(value, path), allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(result)) if (!allowed.has(key)) protocol(`${path}.${key}`, "is not part of the closed footage v1 contract.");
  for (const key of required) if (!Object.hasOwn(result, key)) protocol(`${path}.${key}`, "is required.");
  return result;
}
function text(value: unknown, path: string, maximum: number = cutFootageLimits.maximumTextBytes) {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > maximum || /[\u0000-\u001f\u007f]/u.test(value)) protocol(path, "must be one bounded non-empty control-free string.");
  return value;
}
function locator(value: unknown, path: string) {
  const result = text(value, path, cutFootageLimits.maximumLocatorBytes);
  if (result.includes("\\") || result.startsWith("/") || result.split("/").some((part) => !part || part === "." || part === "..")) footageFail("CUT_FOOTAGE_INDEX_STALE", path, "must be one canonical project-relative POSIX locator.");
  return result;
}
function sha256(value: unknown, path: string) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) protocol(path, "must be one lowercase SHA-256 digest.");
  return value;
}
function positiveInteger(value: unknown, path: string, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) protocol(path, `must be one positive safe integer no greater than ${maximum}.`);
  return Number(value);
}
function nonNegativeInteger(value: unknown, path: string, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) protocol(path, `must be one non-negative safe integer no greater than ${maximum}.`);
  return Number(value);
}
function identifier(value: unknown, path: string) {
  const result = text(value, path, 128);
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(result)) protocol(path, "must be one stable lowercase identifier.");
  return result;
}
function rationalWire(value: unknown, path: string): Rational {
  const record = closed(value, path, ["numerator", "denominator"]);
  if (typeof record.numerator !== "string" || typeof record.denominator !== "string"
    || !/^(?:0|-?[1-9][0-9]*)$/u.test(record.numerator) || !/^[1-9][0-9]*$/u.test(record.denominator)
    || record.numerator.length > maximumRationalDigits || record.denominator.length > maximumRationalDigits) {
    footageFail("CUT_FOOTAGE_RANGE", path, "must be one bounded canonical rational { numerator, denominator }.");
  }
  const canonical = rational(record.numerator, record.denominator);
  if (canonical.numerator !== record.numerator || canonical.denominator !== record.denominator) footageFail("CUT_FOOTAGE_RANGE", path, "must be reduced with a positive denominator.");
  return Object.freeze(canonical);
}
function nonNegative(value: Rational, path: string) { if (compareRational(value, zeroRational) < 0) footageFail("CUT_FOOTAGE_RANGE", path, "must be non-negative."); return value; }
function rangeWire(value: unknown, path: string): CutFootageRange {
  const record = closed(value, path, ["semantics", "start", "end"]);
  if (record.semantics !== "half-open") footageFail("CUT_FOOTAGE_RANGE", `${path}.semantics`, "must be half-open.");
  const start = nonNegative(rationalWire(record.start, `${path}.start`), `${path}.start`), end = rationalWire(record.end, `${path}.end`);
  if (compareRational(end, start) <= 0) footageFail("CUT_FOOTAGE_RANGE", path, "must end strictly after it starts.");
  return Object.freeze({ semantics: "half-open", start, end });
}
function handles(value: unknown, path: string): CutFootageHandles {
  const record = closed(value, path, ["head", "tail"]);
  return Object.freeze({ head: nonNegative(rationalWire(record.head, `${path}.head`), `${path}.head`), tail: nonNegative(rationalWire(record.tail, `${path}.tail`), `${path}.tail`) });
}
function sourceSelection(value: unknown, path: string): CutFootageSourceSelection {
  const record = closed(value, path, ["locator", "sha256", "streamIndex", "range"]);
  return Object.freeze({ locator: locator(record.locator, `${path}.locator`), sha256: sha256(record.sha256, `${path}.sha256`), streamIndex: nonNegativeInteger(record.streamIndex, `${path}.streamIndex`, 1024), range: rangeWire(record.range, `${path}.range`) });
}
function isSorted<T>(values: readonly T[], compare: (left: T, right: T) => number) { return values.every((value, index) => index === 0 || compare(values[index - 1]!, value) <= 0); }
function digestWithout(value: Record<string, unknown>, identityField: string) {
  const { [identityField]: _identity, ...body } = value;
  return createHash("sha256").update(stableJsonStringify(body)).digest("hex");
}
function verifiedIdentity(value: Record<string, unknown>, field: "indexSha256" | "searchSha256" | "extractSha256", path: string) {
  const declared = sha256(value[field], `${path}.${field}`), calculated = digestWithout(value, field);
  if (declared !== calculated) footageFail("CUT_FOOTAGE_INDEX_STALE", `${path}.${field}`, "does not match canonical stable JSON with its own identity field omitted.");
  return declared;
}
function decode(input: string | Uint8Array): unknown {
  try {
    return parseStrictPackageJson(input, { limits: { maxInputBytes: cutFootageLimits.maximumBytes, maxDepth: 16, maxNodes: 100_000, maxStringBytes: cutFootageLimits.maximumTextBytes, maxTotalStringBytes: 512 * 1024 } });
  } catch (error) { protocol("$", error instanceof Error ? error.message : "must be valid bounded strict JSON."); }
}

export function parseCutFootageIndex(input: string | Uint8Array): CutFootageIndex {
  const root = closed(decode(input), "$", ["format", "version", "root", "sources", "chunkPolicy", "chunks", "backend", "vectorArtifact", "creation", "indexSha256"]);
  if (root.format !== "cut-footage-index" || root.version !== 1) protocol("$", "must be cut-footage-index v1.");
  if (!Array.isArray(root.sources) || root.sources.length > cutFootageLimits.maximumSources) protocol("$.sources", "must be one bounded source array.");
  const sources = root.sources.map((value, index) => {
    const path = `$.sources[${index}]`, source = closed(value, path, ["locator", "bytes", "sha256", "duration", "probeSha256", "streams"]);
    if (!Array.isArray(source.streams) || !source.streams.length || source.streams.length > cutFootageLimits.maximumStreamsPerSource) protocol(`${path}.streams`, "must contain 1..64 selected-source streams.");
    const streams = source.streams.map((stream, streamIndex) => {
      const streamPath = `${path}.streams[${streamIndex}]`, item = closed(stream, streamPath, ["index", "type", "timeBase"], ["frameRate"]);
      if (item.type !== "video" && item.type !== "audio") protocol(`${streamPath}.type`, "must be video or audio.");
      const timeBase = rationalWire(item.timeBase, `${streamPath}.timeBase`);
      if (compareRational(timeBase, zeroRational) <= 0) footageFail("CUT_FOOTAGE_RANGE", `${streamPath}.timeBase`, "must be positive.");
      const frameRate = item.frameRate === undefined ? undefined : rationalWire(item.frameRate, `${streamPath}.frameRate`);
      if (frameRate && compareRational(frameRate, zeroRational) <= 0) footageFail("CUT_FOOTAGE_RANGE", `${streamPath}.frameRate`, "must be positive.");
      return Object.freeze({ index: nonNegativeInteger(item.index, `${streamPath}.index`, 1024), type: item.type, timeBase, ...(frameRate === undefined ? {} : { frameRate }) });
    });
    if (new Set(streams.map((stream) => stream.index)).size !== streams.length) protocol(`${path}.streams`, "must not contain duplicate stream indices.");
    return Object.freeze({ locator: locator(source.locator, `${path}.locator`), bytes: positiveInteger(source.bytes, `${path}.bytes`), sha256: sha256(source.sha256, `${path}.sha256`), duration: nonNegative(rationalWire(source.duration, `${path}.duration`), `${path}.duration`), probeSha256: sha256(source.probeSha256, `${path}.probeSha256`), streams: Object.freeze(streams) });
  });
  if (!isSorted(sources, (left, right) => left.locator.localeCompare(right.locator)) || new Set(sources.map((source) => source.locator)).size !== sources.length) footageFail("CUT_FOOTAGE_INDEX_STALE", "$.sources", "must be canonical-locator sorted without duplicates.");
  const policy = closed(root.chunkPolicy, "$.chunkPolicy", ["duration", "overlap"]), duration = rationalWire(policy.duration, "$.chunkPolicy.duration"), overlap = nonNegative(rationalWire(policy.overlap, "$.chunkPolicy.overlap"), "$.chunkPolicy.overlap");
  if (compareRational(duration, zeroRational) <= 0 || compareRational(overlap, duration) >= 0) footageFail("CUT_FOOTAGE_RANGE", "$.chunkPolicy", "must have positive duration and shorter non-negative overlap.");
  if (!Array.isArray(root.chunks) || root.chunks.length > cutFootageLimits.maximumChunks) protocol("$.chunks", "must be one bounded chunk array.");
  const sourceByLocator = new Map(sources.map((source) => [source.locator, source]));
  const chunks = root.chunks.map((value, index) => {
    const path = `$.chunks[${index}]`, chunk = closed(value, path, ["id", "sourceLocator", "sourceSha256", "streamIndex", "range"]), sourceLocator = locator(chunk.sourceLocator, `${path}.sourceLocator`), source = sourceByLocator.get(sourceLocator), sourceSha256 = sha256(chunk.sourceSha256, `${path}.sourceSha256`), streamIndex = nonNegativeInteger(chunk.streamIndex, `${path}.streamIndex`, 1024), sourceRange = rangeWire(chunk.range, `${path}.range`);
    const stream = source?.streams.find((candidate) => candidate.index === streamIndex);
    if (!source || source.sha256 !== sourceSha256 || !stream || compareRational(sourceRange.end, source.duration) > 0) footageFail("CUT_FOOTAGE_INDEX_STALE", path, "does not bind one current source, stream, and in-bounds range.");
    const grid = stream.type === "video" ? (stream.frameRate ? divideRational(rational(1), stream.frameRate) : undefined) : stream.timeBase;
    if (!grid || divideRational(sourceRange.start, grid).denominator !== "1" || divideRational(sourceRange.end, grid).denominator !== "1") footageFail("CUT_FOOTAGE_RANGE", `${path}.range`, "must align to the selected source stream frame or sample grid.");
    return Object.freeze({ id: identifier(chunk.id, `${path}.id`), sourceLocator, sourceSha256, streamIndex, range: sourceRange });
  });
  if (new Set(chunks.map((chunk) => chunk.id)).size !== chunks.length || !isSorted(chunks, (left, right) => left.sourceLocator.localeCompare(right.sourceLocator) || compareRational(left.range.start, right.range.start) || compareRational(left.range.end, right.range.end) || left.id.localeCompare(right.id))) footageFail("CUT_FOOTAGE_INDEX_STALE", "$.chunks", "must be stable sorted without duplicate IDs.");
  const backend = closed(root.backend, "$.backend", ["protocolVersion", "provider", "model", "dimensions", "normalization"]);
  if (backend.protocolVersion !== 1 || backend.normalization !== "l2") protocol("$.backend", "must declare local protocol version 1 and l2 normalization.");
  const artifact = closed(root.vectorArtifact, "$.vectorArtifact", ["locator", "bytes", "sha256"]), creation = closed(root.creation, "$.creation", ["cutVersion", "backendProtocolVersion"]);
  if (creation.backendProtocolVersion !== 1) protocol("$.creation.backendProtocolVersion", "must be 1.");
  const indexSha256 = verifiedIdentity(root, "indexSha256", "$");
  return Object.freeze({ format: "cut-footage-index", version: 1, root: locator(root.root, "$.root"), sources: Object.freeze(sources), chunkPolicy: Object.freeze({ duration, overlap }), chunks: Object.freeze(chunks), backend: Object.freeze({ protocolVersion: 1, provider: text(backend.provider, "$.backend.provider"), model: text(backend.model, "$.backend.model"), dimensions: positiveInteger(backend.dimensions, "$.backend.dimensions", 65_536), normalization: "l2" }), vectorArtifact: Object.freeze({ locator: locator(artifact.locator, "$.vectorArtifact.locator"), bytes: positiveInteger(artifact.bytes, "$.vectorArtifact.bytes"), sha256: sha256(artifact.sha256, "$.vectorArtifact.sha256") }), creation: Object.freeze({ cutVersion: text(creation.cutVersion, "$.creation.cutVersion", 128), backendProtocolVersion: 1 }), indexSha256 });
}

export function parseCutFootageSearch(input: string | Uint8Array): CutFootageSearch {
  const root = closed(decode(input), "$", ["format", "version", "indexSha256", "query", "matches", "searchSha256"]);
  if (root.format !== "cut-footage-search" || root.version !== 1) protocol("$", "must be cut-footage-search v1.");
  const query = closed(root.query, "$.query", ["text", "thresholdPpm"]), queryText = text(query.text, "$.query.text");
  if (queryText !== queryText.normalize("NFKC").trim() || !Number.isSafeInteger(query.thresholdPpm) || Number(query.thresholdPpm) < -1_000_000 || Number(query.thresholdPpm) > 1_000_000) protocol("$.query", "must contain normalized text and an integer thresholdPpm in -1000000..1000000.");
  if (!Array.isArray(root.matches) || root.matches.length > cutFootageLimits.maximumMatches) protocol("$.matches", "must be one bounded match array.");
  const matches = root.matches.map((value, index) => {
    const path = `$.matches[${index}]`, match = closed(value, path, ["id", "scorePpm", "chunkIds", "sourceSelection"], ["handles"]);
    if (!Number.isSafeInteger(match.scorePpm) || Number(match.scorePpm) < -1_000_000 || Number(match.scorePpm) > 1_000_000) protocol(`${path}.scorePpm`, "must be one finite integer score in parts per million.");
    if (!Array.isArray(match.chunkIds) || !match.chunkIds.length || match.chunkIds.length > cutFootageLimits.maximumChunkIdsPerMatch) protocol(`${path}.chunkIds`, "must contain bounded matched chunk IDs.");
    const chunkIds = match.chunkIds.map((id, chunkIndex) => identifier(id, `${path}.chunkIds[${chunkIndex}]`));
    if (new Set(chunkIds).size !== chunkIds.length) protocol(`${path}.chunkIds`, "must not contain duplicate chunk IDs.");
    return Object.freeze({ id: identifier(match.id, `${path}.id`), scorePpm: Number(match.scorePpm), chunkIds: Object.freeze(chunkIds), sourceSelection: sourceSelection(match.sourceSelection, `${path}.sourceSelection`), ...(match.handles === undefined ? {} : { handles: handles(match.handles, `${path}.handles`) }) });
  });
  if (new Set(matches.map((match) => match.id)).size !== matches.length || !isSorted(matches, (left, right) => right.scorePpm - left.scorePpm || left.sourceSelection.locator.localeCompare(right.sourceSelection.locator) || compareRational(left.sourceSelection.range.start, right.sourceSelection.range.start) || compareRational(left.sourceSelection.range.end, right.sourceSelection.range.end) || left.id.localeCompare(right.id))) footageFail("CUT_FOOTAGE_MATCH", "$.matches", "must be deterministically ranked without duplicate IDs.");
  const searchSha256 = verifiedIdentity(root, "searchSha256", "$");
  return Object.freeze({ format: "cut-footage-search", version: 1, indexSha256: sha256(root.indexSha256, "$.indexSha256"), query: Object.freeze({ text: queryText, thresholdPpm: Number(query.thresholdPpm) }), matches: Object.freeze(matches), searchSha256 });
}

export function parseCutFootageExtract(input: string | Uint8Array): CutFootageExtract {
  const root = closed(decode(input), "$", ["format", "version", "searchSha256", "indexSha256", "matchId", "label", "sourceSelection", "requestedHandles", "effectiveHandles", "finalRange", "toolchain", "output", "extractSha256"]);
  if (root.format !== "cut-footage-extract" || root.version !== 1 || root.label !== "candidate-only-not-cut-lock") protocol("$", "must be cut-footage-extract v1 labelled candidate-only-not-cut-lock.");
  const selection = sourceSelection(root.sourceSelection, "$.sourceSelection"), requestedHandles = handles(root.requestedHandles, "$.requestedHandles"), effectiveHandles = handles(root.effectiveHandles, "$.effectiveHandles"), finalRange = rangeWire(root.finalRange, "$.finalRange");
  if (compareRational(effectiveHandles.head, requestedHandles.head) > 0 || compareRational(effectiveHandles.tail, requestedHandles.tail) > 0 || compareRational(finalRange.start, selection.range.start) > 0 || compareRational(finalRange.end, selection.range.end) < 0) footageFail("CUT_FOOTAGE_RANGE", "$.finalRange", "must contain the chosen source range with no more than requested handles.");
  const toolchain = closed(root.toolchain, "$.toolchain", ["ffmpeg", "ffprobe"]), ffmpeg = closed(toolchain.ffmpeg, "$.toolchain.ffmpeg", ["name", "version"]), ffprobe = closed(toolchain.ffprobe, "$.toolchain.ffprobe", ["name", "version"]);
  if (ffmpeg.name !== "ffmpeg" || ffprobe.name !== "ffprobe") protocol("$.toolchain", "must identify ffmpeg and ffprobe exactly.");
  const output = closed(root.output, "$.output", ["locator", "bytes", "sha256", "streams"]);
  if (!Array.isArray(output.streams) || !output.streams.length || output.streams.length > cutFootageLimits.maximumOutputStreams) protocol("$.output.streams", "must contain bounded output stream facts.");
  const streams = output.streams.map((value, index) => { const path = `$.output.streams[${index}]`, stream = closed(value, path, ["index", "type", "codec"]); if (stream.type !== "video" && stream.type !== "audio") protocol(`${path}.type`, "must be video or audio."); return Object.freeze({ index: nonNegativeInteger(stream.index, `${path}.index`, 1024), type: stream.type, codec: text(stream.codec, `${path}.codec`, 128) }); });
  if (new Set(streams.map((stream) => stream.index)).size !== streams.length) protocol("$.output.streams", "must not contain duplicate stream indices.");
  const extractSha256 = verifiedIdentity(root, "extractSha256", "$");
  return Object.freeze({ format: "cut-footage-extract", version: 1, searchSha256: sha256(root.searchSha256, "$.searchSha256"), indexSha256: sha256(root.indexSha256, "$.indexSha256"), matchId: identifier(root.matchId, "$.matchId"), label: "candidate-only-not-cut-lock", sourceSelection: selection, requestedHandles, effectiveHandles, finalRange, toolchain: Object.freeze({ ffmpeg: Object.freeze({ name: "ffmpeg", version: text(ffmpeg.version, "$.toolchain.ffmpeg.version", 128) }), ffprobe: Object.freeze({ name: "ffprobe", version: text(ffprobe.version, "$.toolchain.ffprobe.version", 128) }) }), output: Object.freeze({ locator: locator(output.locator, "$.output.locator"), bytes: positiveInteger(output.bytes, "$.output.bytes"), sha256: sha256(output.sha256, "$.output.sha256"), streams: Object.freeze(streams) }), extractSha256 });
}

async function loadFile<T>(path: string, parse: (input: Uint8Array) => T): Promise<T> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > cutFootageLimits.maximumBytes) footageFail("CUT_FOOTAGE_BACKEND_PROTOCOL", path, "must be one bounded regular no-follow manifest file.");
    const bytes = await handle.readFile(), after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) footageFail("CUT_FOOTAGE_INDEX_STALE", path, "changed during its bounded read.");
    return parse(bytes);
  } catch (error) {
    if (error instanceof CutFootageError) throw error;
    return footageFail("CUT_FOOTAGE_BACKEND_PROTOCOL", path, error instanceof Error ? error.message : "could not be read safely.");
  } finally { await handle?.close().catch(() => undefined); }
}
export const loadCutFootageIndexFile = (path: string) => loadFile(path, parseCutFootageIndex);
export const loadCutFootageSearchFile = (path: string) => loadFile(path, parseCutFootageSearch);
export const loadCutFootageExtractFile = (path: string) => loadFile(path, parseCutFootageExtract);
