import { createHash } from "node:crypto";
import { stableJsonStringify } from "../core/stable";
import { compareRational, divideRational, subtractRational, addRational, rational, type Rational, zeroRational } from "../language/rational";
import type { CutFootageIndex } from "./contracts";
import { cutFootageLimits } from "./contracts";
import { footageFail } from "./diagnostics";
import { floorFootageTimeToGrid, planFootageChunkRanges, type CutFootageRange } from "./range";
import { resolveProjectFile, validateProjectLocator } from "../project/manifest";
import { probeProjectBytes, probeProjectMedia, type CutByteProbe, type CutMediaProbe } from "../project/probe";
import {
  bindReferenceNativeMediaTool,
  createReferenceNativeProcessCollector,
  type BoundReferenceNativeMediaTool,
  type ReferenceNativeProcessCollector,
  type ReferenceNativeProcessLifecycleObserver,
} from "../project/native-process-authority";

export type FootageBackendIdentity = CutFootageIndex["backend"];
export type FootageChunkPolicy = CutFootageIndex["chunkPolicy"];
export type FootagePublicSource = CutFootageIndex["sources"][number];
export type FootageNormalizedSource = Readonly<{
  source: FootagePublicSource;
  selectedStreamIndex: number;
  grid: Rational;
  searchableDuration: Rational;
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

export type FootagePlannerProbeEvent = Readonly<{
  phase: "start" | "settled";
  ordinal: number;
  locator: string;
  status?: "fulfilled" | "rejected";
}>;

/** @internal Deterministic scheduling and native-lifecycle observation for focused tests. */
export type FootagePlannerTestHooks = Readonly<{
  probeConcurrency?: number;
  probeEvent?: (event: FootagePlannerProbeEvent) => void | Promise<void>;
  ffprobeExecutable?: string;
  lifecycleEvent?: ReferenceNativeProcessLifecycleObserver;
}>;

export const defaultFootageChunkPolicy: FootageChunkPolicy = Object.freeze({ duration: rational(8), overlap: rational(2) });
const footagePlannerProbeConcurrency = 4;
const maximumFootageSamplePoints = cutFootageLimits.maximumChunks * 8;

function abortIfRequested(signal: AbortSignal | undefined) {
  if (signal?.aborted) footageFail("CUT_FOOTAGE_BACKEND_PROTOCOL", "$signal", "the footage source-planning operation was cancelled.");
}

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
  const streams = probe.streams
    .filter((stream): stream is CutMediaProbe["streams"][number] & { type: "video" | "audio"; timeBase: Rational } => (stream.type === "video" || stream.type === "audio") && stream.timeBase !== undefined)
    .map((stream) => Object.freeze({ index: stream.index, type: stream.type, timeBase: stream.timeBase, ...(stream.frameRate === undefined ? {} : { frameRate: stream.frameRate }) }))
    .sort((left, right) => left.index - right.index);
  const videos = probe.streams.filter((stream) => stream.type === "video").sort((left, right) => Number(right.disposition.includes("default")) - Number(left.disposition.includes("default")) || left.index - right.index);
  const selected = videos[0];
  if (!selected) footageFail("CUT_FOOTAGE_UNSUPPORTED_MEDIA", byteFile.locator, "one video stream is required.");
  if (!selected.timeBase) footageFail("CUT_FOOTAGE_UNSUPPORTED_MEDIA", byteFile.locator, "selected video timeBase is required.");
  if (!selected.frameRate || compareRational(selected.frameRate, zeroRational) <= 0) footageFail("CUT_FOOTAGE_UNSUPPORTED_MEDIA", byteFile.locator, "selected video frameRate is required and must be positive.");
  if (!selected.duration || compareRational(selected.duration, zeroRational) <= 0) footageFail("CUT_FOOTAGE_UNSUPPORTED_MEDIA", byteFile.locator, "selected video duration is required and must be positive.");
  positive(selected.timeBase, `${byteFile.locator}.timeBase`);
  const publicStreams = streams.filter((stream) => stream.type === "video" || stream.type === "audio");
  const grid = divideRational(rational(1), selected.frameRate);
  const searchableDuration = floorFootageTimeToGrid(selected.duration, grid);
  if (compareRational(searchableDuration, zeroRational) <= 0) footageFail("CUT_FOOTAGE_UNSUPPORTED_MEDIA", byteFile.locator, "selected video duration contains no positive frame-grid boundary.");
  const probeSha256 = digest(probe);
  return Object.freeze({
    source: Object.freeze({ locator: byteFile.locator, bytes: byteFile.bytes, sha256: byteFile.sha256, duration: selected.duration, probeSha256, streams: Object.freeze(publicStreams) }),
    selectedStreamIndex: selected.index,
    grid,
    searchableDuration,
  });
}

function chunkId(source: FootageNormalizedSource, range: CutFootageRange) {
  return `chunk-${digest({ sourceLocator: source.source.locator, sourceSha256: source.source.sha256, streamIndex: source.selectedStreamIndex, range })}`;
}

function boundedSamplePointCount(range: CutFootageRange, maximumPoints: number) {
  if (!Number.isSafeInteger(maximumPoints) || maximumPoints < 0 || maximumPoints > maximumFootageSamplePoints) {
    footageFail("CUT_FOOTAGE_RANGE", "$samplePoints", "has one invalid remaining sample-point budget.");
  }
  const extent = subtractRational(range.end, range.start);
  const numerator = BigInt(extent.numerator), denominator = BigInt(extent.denominator);
  const count = (numerator + denominator - 1n) / denominator;
  if (count > BigInt(maximumPoints)) footageFail("CUT_FOOTAGE_RANGE", "$samplePoints", "exceeds the bounded footage sample-point count.");
  return Number(count);
}

function samplePoints(range: CutFootageRange, grid: Rational, maximumPoints: number): readonly Rational[] {
  const count = boundedSamplePointCount(range, maximumPoints);
  const result: Rational[] = [];
  let slotStart = range.start;
  for (let ordinal = 0; ordinal < count; ordinal += 1) {
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

function planFootageChunksWithin(
  source: FootageNormalizedSource,
  policy: FootageChunkPolicy,
  maximumChunks: number,
  maximumSamplePoints: number,
) {
  const ranges = planFootageChunkRanges(
    { duration: source.searchableDuration, chunkDuration: policy.duration, overlap: policy.overlap, grid: source.grid },
    maximumChunks,
  );
  const chunks: FootagePlannedChunk[] = [];
  let remainingSamplePoints = maximumSamplePoints;
  for (const range of ranges) {
    const points = samplePoints(range, source.grid, remainingSamplePoints);
    remainingSamplePoints -= points.length;
    chunks.push(Object.freeze({
      id: chunkId(source, range), sourceLocator: source.source.locator, sourceSha256: source.source.sha256,
      streamIndex: source.selectedStreamIndex, range, samplePoints: points,
    }));
  }
  return Object.freeze(chunks);
}

/** Plans v1's fixed 8s/2s chunk law and one grid-aligned frame point per second slot. */
export function planFootageChunks(source: FootageNormalizedSource, policy: FootageChunkPolicy = defaultFootageChunkPolicy): readonly FootagePlannedChunk[] {
  return planFootageChunksWithin(source, policy, cutFootageLimits.maximumChunks, maximumFootageSamplePoints);
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
  const priorChunksById = new Map(priorChunks.map((chunk) => [chunk.id, chunk]));
  if (priorChunks.length !== chunks.length || !chunks.every((chunk) => {
    const previous = priorChunksById.get(chunk.id);
    return previous !== undefined && sameChunk(chunk, previous);
  })) return Object.freeze([]);
  return Object.freeze(chunks.map((chunk) => chunk.id));
}

async function probeFootageSource(
  projectRoot: string,
  locator: string,
  ordinal: number,
  authority: BoundReferenceNativeMediaTool,
  collector: ReferenceNativeProcessCollector,
  signal?: AbortSignal,
): Promise<FootageNormalizedSource> {
  abortIfRequested(signal);
  const safeLocator = validateProjectLocator(locator, "footage source locator");
  await resolveProjectFile(projectRoot, safeLocator);
  abortIfRequested(signal);
  const byteProbe = await probeProjectBytes(projectRoot, safeLocator, signal === undefined ? {} : { signal });
  abortIfRequested(signal);
  const context = Object.freeze({
    ordinal, operation: "media-metadata" as const, resourceId: safeLocator, resourceSha256: byteProbe.file.sha256,
    resourceBytes: byteProbe.file.bytes, variant: "master" as const,
  });
  const mediaProbe = await probeProjectMedia(
    projectRoot,
    safeLocator,
    {},
    { ffprobe: authority.executablePath },
    { authority, collector, context, terminateProcessTree: true, ...(signal === undefined ? {} : { signal }) },
  );
  abortIfRequested(signal);
  return normalizeFootageSourceProbe(byteProbe, mediaProbe);
}

async function probeFootageSourceWithEvent(
  projectRoot: string,
  locator: string,
  ordinal: number,
  authority: BoundReferenceNativeMediaTool,
  collector: ReferenceNativeProcessCollector,
  hooks: FootagePlannerTestHooks | undefined,
  signal?: AbortSignal,
) {
  let source: FootageNormalizedSource | undefined, primaryError: unknown;
  try {
    await hooks?.probeEvent?.(Object.freeze({ phase: "start", ordinal, locator }));
    source = await probeFootageSource(projectRoot, locator, ordinal, authority, collector, signal);
  } catch (error) { primaryError = error; }
  try {
    await hooks?.probeEvent?.(Object.freeze({
      phase: "settled", ordinal, locator,
      status: primaryError === undefined ? "fulfilled" : "rejected",
    }));
  } catch (error) {
    if (primaryError === undefined) primaryError = error;
  }
  if (primaryError !== undefined) {
    abortIfRequested(signal);
    throw primaryError;
  }
  return source!;
}

export async function planFootageSources(options: Readonly<{
  projectRoot: string;
  locators: readonly string[];
  backend: FootageBackendIdentity;
  priorIndex?: CutFootageIndex;
  chunkPolicy?: FootageChunkPolicy;
  signal?: AbortSignal;
  __testHooks?: FootagePlannerTestHooks;
}>): Promise<FootagePlan> {
  if (!options || typeof options !== "object" || Array.isArray(options)) footageFail("CUT_FOOTAGE_BACKEND_PROTOCOL", "$", "must be one source planning request.");
  abortIfRequested(options.signal);
  const locators = options.locators.map((locator) => validateProjectLocator(locator, "footage source locator")).sort(bytewise);
  if (!locators.length || new Set(locators).size !== locators.length) footageFail("CUT_FOOTAGE_BACKEND_PROTOCOL", "$.locators", "must be one non-empty duplicate-free locator list.");
  if (locators.length > cutFootageLimits.maximumSources) footageFail("CUT_FOOTAGE_BACKEND_PROTOCOL", "$.locators", "exceeds the bounded source count.");
  if (locators.some((locator) => !mediaLocator(locator))) footageFail("CUT_FOOTAGE_UNSUPPORTED_MEDIA", "$.locators", "must contain MP4 or MOV source locators only.");
  const policy = options.chunkPolicy ?? defaultFootageChunkPolicy;
  const width = options.__testHooks?.probeConcurrency ?? footagePlannerProbeConcurrency;
  if (!Number.isSafeInteger(width) || width < 1 || width > footagePlannerProbeConcurrency) {
    footageFail("CUT_FOOTAGE_BACKEND_PROTOCOL", "$.__testHooks.probeConcurrency", "must be one bounded planner probe width.");
  }
  const authority = await bindReferenceNativeMediaTool("ffprobe", options.__testHooks?.ffprobeExecutable);
  abortIfRequested(options.signal);
  const collector = createReferenceNativeProcessCollector(authority, options.__testHooks?.lifecycleEvent === undefined
    ? {}
    : { lifecycleEvent: options.__testHooks.lifecycleEvent });
  const sources: FootageNormalizedSource[] = [];
  let primaryError: unknown;
  try {
    for (let waveStart = 0; waveStart < locators.length; waveStart += width) {
      abortIfRequested(options.signal);
      const wave = locators.slice(waveStart, waveStart + width);
      const outcomes = await Promise.allSettled(wave.map((locator, localIndex) => probeFootageSourceWithEvent(
        options.projectRoot,
        locator,
        waveStart + localIndex,
        authority,
        collector,
        options.__testHooks,
        options.signal,
      )));
      abortIfRequested(options.signal);
      const rejected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
      if (rejected) throw rejected.reason;
      sources.push(...(outcomes as PromiseFulfilledResult<FootageNormalizedSource>[]).map((outcome) => outcome.value));
    }
  } catch (error) { primaryError = error; }
  let sealError: unknown, verifyError: unknown;
  try { await collector.seal(); }
  catch (error) { sealError = error; }
  try { await authority.verify(); }
  catch (error) { verifyError = error; }
  if (primaryError !== undefined) {
    abortIfRequested(options.signal);
    throw primaryError;
  }
  abortIfRequested(options.signal);
  if (sealError !== undefined || verifyError !== undefined) {
    footageFail("CUT_FOOTAGE_UNSUPPORTED_MEDIA", "$.locators", "the bound FFprobe source-planning lifecycle could not be verified.");
  }
  const chunks: FootagePlannedChunk[] = [], reusableChunkIds: string[] = [];
  let remainingChunks = cutFootageLimits.maximumChunks, remainingSamplePoints = maximumFootageSamplePoints;
  for (const source of sources) {
    const sourceChunks = planFootageChunksWithin(source, policy, remainingChunks, remainingSamplePoints);
    chunks.push(...sourceChunks);
    remainingChunks -= sourceChunks.length;
    remainingSamplePoints -= sourceChunks.reduce((total, chunk) => total + chunk.samplePoints.length, 0);
    reusableChunkIds.push(...reusableFootageChunkIds(source, sourceChunks, options.priorIndex, options.backend, policy));
  }
  const samplePointList: Array<Readonly<{ chunkId: string; time: Rational }>> = [];
  for (const chunk of chunks) {
    for (const time of chunk.samplePoints) samplePointList.push(Object.freeze({ chunkId: chunk.id, time }));
  }
  return Object.freeze({ sources: Object.freeze(sources), chunks: Object.freeze(chunks), samplePoints: Object.freeze(samplePointList), reusableChunkIds: Object.freeze(reusableChunkIds) });
}
