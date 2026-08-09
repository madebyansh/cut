import { createHash } from "node:crypto";
import { stableJsonStringify } from "../core/stable";
import { compareRational, divideRational, subtractRational, addRational, rational, type Rational, zeroRational } from "../language/rational";
import type { CutFootageIndex } from "./contracts";
import { cutFootageLimits } from "./contracts";
import { footageFail } from "./diagnostics";
import { floorFootageTimeToGrid, planFootageChunkRanges, type CutFootageRange } from "./range";
import { resolveProjectFile, validateProjectLocator } from "../project/manifest";
import { probeProjectBytes, probeProjectMedia, type CutByteProbe, type CutMediaProbe } from "../project/probe";
import { bindReferenceNativeMediaTool, createReferenceNativeProcessCollector } from "../project/native-process-authority";

export type FootageBackendIdentity = CutFootageIndex["backend"];
export type FootageChunkPolicy = CutFootageIndex["chunkPolicy"];
export type FootagePublicSource = CutFootageIndex["sources"][number];
export type FootageNormalizedSource = Readonly<{
  source: FootagePublicSource;
  selectedStreamIndex: number;
  grid: Rational;
}>;
export type FootagePlannedChunk = Readonly<{
  id: string;
  sourceLocator: string;
  sourceSha256: string;
  streamIndex: number;
  range: CutFootageRange;
  samplePoints: readonly Rational[];
}>;
export type FootagePlan = Readonly<{
  sources: readonly FootageNormalizedSource[];
  chunks: readonly FootagePlannedChunk[];
  samplePoints: readonly Readonly<{ chunkId: string; time: Rational }>[];
  reusableChunkIds: readonly string[];
}>;

export const defaultFootageChunkPolicy: FootageChunkPolicy = Object.freeze({ duration: rational(8), overlap: rational(2) });

function digest(value: unknown) { return createHash("sha256").update(stableJsonStringify(value)).digest("hex"); }
function same(left: unknown, right: unknown) { return stableJsonStringify(left) === stableJsonStringify(right); }
function positive(value: Rational, path: string) {
  if (compareRational(value, zeroRational) <= 0) footageFail("CUT_FOOTAGE_UNSUPPORTED_MEDIA", path, "must be positive.");
  return value;
}
function bytewise(left: string, right: string) { return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")); }
function sameRange(left: CutFootageRange, right: CutFootageRange) {
  return left.semantics === right.semantics && compareRational(left.start, right.start) === 0 && compareRational(left.end, right.end) === 0;
}
function sameChunk(left: FootagePlannedChunk, right: CutFootageIndex["chunks"][number]) {
  return left.id === right.id && left.sourceLocator === right.sourceLocator && left.sourceSha256 === right.sourceSha256
    && left.streamIndex === right.streamIndex && sameRange(left.range, right.range);
}
function mediaLocator(locator: string) { return /\.(?:mp4|mov)$/iu.test(locator); }

/** Reduces a probe to the public, host-path-free source identity used by v1 indexes. */
export function normalizeFootageSourceProbe(bytes: CutByteProbe, probe: CutMediaProbe): FootageNormalizedSource {
  const byteFile = bytes.file, mediaFile = probe.file;
  if (byteFile.locator !== mediaFile.locator || byteFile.bytes !== mediaFile.bytes || byteFile.sha256 !== mediaFile.sha256) {
    footageFail("CUT_FOOTAGE_INDEX_STALE", byteFile.locator, "byte probe and media probe do not identify the same immutable source.");
  }
  const duration = probe.container.duration;
  if (!duration || compareRational(duration, zeroRational) <= 0) footageFail("CUT_FOOTAGE_UNSUPPORTED_MEDIA", byteFile.locator, "duration is required and must be positive.");
  const streams = probe.streams
    .filter((stream): stream is CutMediaProbe["streams"][number] & { type: "video" | "audio"; timeBase: Rational } => (stream.type === "video" || stream.type === "audio") && stream.timeBase !== undefined)
    .map((stream) => Object.freeze({ index: stream.index, type: stream.type, timeBase: stream.timeBase, ...(stream.frameRate === undefined ? {} : { frameRate: stream.frameRate }) }))
    .sort((left, right) => left.index - right.index);
  const videos = probe.streams.filter((stream) => stream.type === "video").sort((left, right) => Number(right.disposition.includes("default")) - Number(left.disposition.includes("default")) || left.index - right.index);
  const selected = videos[0];
  if (!selected) footageFail("CUT_FOOTAGE_UNSUPPORTED_MEDIA", byteFile.locator, "one video stream is required.");
  if (!selected.timeBase) footageFail("CUT_FOOTAGE_UNSUPPORTED_MEDIA", byteFile.locator, "selected video timeBase is required.");
  if (!selected.frameRate || compareRational(selected.frameRate, zeroRational) <= 0) footageFail("CUT_FOOTAGE_UNSUPPORTED_MEDIA", byteFile.locator, "selected video frameRate is required and must be positive.");
  positive(selected.timeBase, `${byteFile.locator}.timeBase`);
  const publicStreams = streams.filter((stream) => stream.type === "video" || stream.type === "audio");
  const probeSha256 = digest({
    format: probe.format, version: probe.version, implementation: probe.implementation,
    container: { names: probe.container.names, duration, ...(probe.container.start === undefined ? {} : { start: probe.container.start }), ...(probe.container.bitRate === undefined ? {} : { bitRate: probe.container.bitRate }) },
    streams: publicStreams,
  });
  return Object.freeze({
    source: Object.freeze({ locator: byteFile.locator, bytes: byteFile.bytes, sha256: byteFile.sha256, duration, probeSha256, streams: Object.freeze(publicStreams) }),
    selectedStreamIndex: selected.index,
    grid: divideRational(rational(1), selected.frameRate),
  });
}

function chunkId(source: FootageNormalizedSource, range: CutFootageRange) {
  return `chunk-${digest({ sourceLocator: source.source.locator, sourceSha256: source.source.sha256, streamIndex: source.selectedStreamIndex, range })}`;
}

function samplePoints(range: CutFootageRange, grid: Rational): readonly Rational[] {
  const result: Rational[] = [];
  let slotStart = range.start;
  while (compareRational(slotStart, range.end) < 0) {
    const slotEnd = compareRational(addRational(slotStart, rational(1)), range.end) < 0 ? addRational(slotStart, rational(1)) : range.end;
    const middle = addRational(slotStart, divideRational(subtractRational(slotEnd, slotStart), rational(2)));
    let point = floorFootageTimeToGrid(middle, grid);
    if (compareRational(point, slotStart) < 0) point = slotStart;
    if (compareRational(point, slotEnd) >= 0) point = floorFootageTimeToGrid(subtractRational(slotEnd, grid), grid);
    if (compareRational(point, slotStart) < 0 || compareRational(point, slotEnd) >= 0) {
      footageFail("CUT_FOOTAGE_RANGE", "$samplePoints", "cannot place a deterministic sample inside the selected stream grid.");
    }
    result.push(Object.freeze(point));
    slotStart = slotEnd;
  }
  return Object.freeze(result);
}

/** Plans v1's fixed 8s/2s chunk law and one grid-aligned frame point per second slot. */
export function planFootageChunks(source: FootageNormalizedSource, policy: FootageChunkPolicy = defaultFootageChunkPolicy): readonly FootagePlannedChunk[] {
  const ranges = planFootageChunkRanges({ duration: source.source.duration, chunkDuration: policy.duration, overlap: policy.overlap, grid: source.grid });
  if (ranges.length > cutFootageLimits.maximumChunks) footageFail("CUT_FOOTAGE_RANGE", "$chunks", "exceeds the bounded footage chunk count.");
  return Object.freeze(ranges.map((range) => Object.freeze({
    id: chunkId(source, range), sourceLocator: source.source.locator, sourceSha256: source.source.sha256,
    streamIndex: source.selectedStreamIndex, range, samplePoints: samplePoints(range, source.grid),
  })));
}

/** Returns reuse only when an entire source's public probe, backend, policy, and chunk set are unchanged. */
export function reusableFootageChunkIds(
  source: FootageNormalizedSource,
  chunks: readonly FootagePlannedChunk[],
  prior: CutFootageIndex | undefined,
  backend: FootageBackendIdentity,
  policy: FootageChunkPolicy,
): readonly string[] {
  if (!prior || !same(prior.backend, backend) || !same(prior.chunkPolicy, policy)) return Object.freeze([]);
  const priorSource = prior.sources.find((candidate) => candidate.locator === source.source.locator);
  if (!priorSource || !same(priorSource, source.source)) return Object.freeze([]);
  const priorChunks = prior.chunks.filter((chunk) => chunk.sourceLocator === source.source.locator);
  if (priorChunks.length !== chunks.length || !chunks.every((chunk) => priorChunks.some((previous) => sameChunk(chunk, previous)))) return Object.freeze([]);
  return Object.freeze(chunks.map((chunk) => chunk.id));
}

async function probeFootageSource(projectRoot: string, locator: string, ordinal: number): Promise<FootageNormalizedSource> {
  const safeLocator = validateProjectLocator(locator, "footage source locator");
  await resolveProjectFile(projectRoot, safeLocator);
  const byteProbe = await probeProjectBytes(projectRoot, safeLocator);
  const authority = await bindReferenceNativeMediaTool("ffprobe");
  const collector = createReferenceNativeProcessCollector(authority);
  const context = Object.freeze({
    ordinal, operation: "media-metadata" as const, resourceId: safeLocator, resourceSha256: byteProbe.file.sha256,
    resourceBytes: byteProbe.file.bytes, variant: "master" as const,
  });
  const mediaProbe = await probeProjectMedia(projectRoot, safeLocator, {}, { ffprobe: authority.executablePath }, { authority, collector, context });
  await collector.seal();
  await authority.verify();
  return normalizeFootageSourceProbe(byteProbe, mediaProbe);
}

export async function planFootageSources(options: Readonly<{
  projectRoot: string;
  locators: readonly string[];
  backend: FootageBackendIdentity;
  priorIndex?: CutFootageIndex;
  chunkPolicy?: FootageChunkPolicy;
}>): Promise<FootagePlan> {
  if (!options || typeof options !== "object" || Array.isArray(options)) footageFail("CUT_FOOTAGE_BACKEND_PROTOCOL", "$", "must be one source planning request.");
  const locators = options.locators.map((locator) => validateProjectLocator(locator, "footage source locator")).sort(bytewise);
  if (!locators.length || new Set(locators).size !== locators.length) footageFail("CUT_FOOTAGE_BACKEND_PROTOCOL", "$.locators", "must be one non-empty duplicate-free locator list.");
  if (locators.some((locator) => !mediaLocator(locator))) footageFail("CUT_FOOTAGE_UNSUPPORTED_MEDIA", "$.locators", "must contain MP4 or MOV source locators only.");
  const policy = options.chunkPolicy ?? defaultFootageChunkPolicy;
  const sources = await Promise.all(locators.map((locator, ordinal) => probeFootageSource(options.projectRoot, locator, ordinal)));
  const chunks = sources.flatMap((source) => planFootageChunks(source, policy));
  if (chunks.length > cutFootageLimits.maximumChunks) footageFail("CUT_FOOTAGE_RANGE", "$chunks", "exceeds the bounded footage chunk count.");
  const reusableChunkIds = sources.flatMap((source) => reusableFootageChunkIds(source, chunks.filter((chunk) => chunk.sourceLocator === source.source.locator), options.priorIndex, options.backend, policy));
  const samplePointList = chunks.flatMap((chunk) => chunk.samplePoints.map((time) => Object.freeze({ chunkId: chunk.id, time })));
  return Object.freeze({ sources: Object.freeze(sources), chunks: Object.freeze(chunks), samplePoints: Object.freeze(samplePointList), reusableChunkIds: Object.freeze(reusableChunkIds) });
}
