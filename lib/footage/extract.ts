import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, realpath, rmdir, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { stableJsonStringify } from "../core/stable";
import { decodedVideoCadenceDuration, maximumDecodedVideoCadenceFrames } from "../language/video-cadence";
import {
  compareRational,
  decimalRational,
  divideRational,
  rational,
  subtractRational,
  type Rational,
  zeroRational,
} from "../language/rational";
import { resolveProjectFile, validateProjectLocator } from "../project/manifest";
import { bindReferenceNativeMediaTool, createReferenceNativeProcessCollector, type ReferenceNativeProcessContext } from "../project/native-process-authority";
import { probeProjectBytes, probeProjectDecodedVideoCadence, probeProjectMedia, type CutByteProbe, type CutMediaProbe } from "../project/probe";
import {
  ensureProjectWriteDirectory,
  publishCreateOnlyStagedFileTransactionForTest,
  StagedFileTransactionError,
  type StagedFileTransactionTestHooks,
} from "../project/write-boundary";
import { runBoundReferenceFfmpeg, runBoundReferenceFfmpegCapture } from "../runtime/reference/ffmpeg";
import {
  cutFootageLimits,
  loadCutFootageIndexFile,
  loadCutFootageSearchFile,
  parseCutFootageExtract,
  validateCutFootageExtractAgainstSearch,
  validateCutFootageSearchAgainstIndex,
  type CutFootageExtract,
  type CutFootageIndex,
  type CutFootageSearch,
} from "./contracts";
import { CutFootageError, footageFail } from "./diagnostics";
import { normalizeFootageSourceProbe } from "./planner";
import { clampFootageHandles, type CutFootageHandles } from "./range";

const maximumHandle = rational(86_400);
const maximumIndexedSourceBytes = 100 * 1024 * 1024 * 1024;
const maximumExtractBytes = 8 * 1024 * 1024 * 1024;
const maximumNativeTimeoutMs = 5 * 60_000;
const heldHashBufferBytes = 1024 * 1024;

/** Parse one canonical, exact, non-negative footage handle in seconds or milliseconds. */
export function parseCutFootageHandle(value: unknown): Rational {
  if (typeof value !== "string" || value.length > 128 || /[\u0000-\u001f\u007f]/u.test(value)) {
    return footageFail("CUT_FOOTAGE_RANGE", "$.requestedHandles", "must be one bounded canonical exact time in s or ms.");
  }
  const match = /^(?:(0|[1-9]\d{0,23})(?:\/([1-9]\d{0,23}))?|((?:0|[1-9]\d{0,17})\.\d{0,17}[1-9]))(ms|s)$/u.exec(value);
  if (!match) return footageFail("CUT_FOOTAGE_RANGE", "$.requestedHandles", "must be one bounded canonical exact time in s or ms.");
  let magnitude: Rational;
  try { magnitude = match[3] === undefined ? rational(match[1]!, match[2] ?? "1") : decimalRational(match[3]); }
  catch { return footageFail("CUT_FOOTAGE_RANGE", "$.requestedHandles", "contains an invalid exact rational value."); }
  if (match[2] !== undefined && (magnitude.numerator !== match[1] || magnitude.denominator !== match[2])) {
    return footageFail("CUT_FOOTAGE_RANGE", "$.requestedHandles", "must use a reduced canonical rational value.");
  }
  const seconds = match[4] === "ms" ? divideRational(magnitude, rational(1_000)) : magnitude;
  if (compareRational(seconds, maximumHandle) > 0) {
    return footageFail("CUT_FOOTAGE_RANGE", "$.requestedHandles", "must not exceed 86400 seconds in footage v1.");
  }
  return seconds;
}

export type CutFootageMatchSelector =
  | Readonly<{ rank: number; id?: never }>
  | Readonly<{ id: string; rank?: never }>;

export type ExtractProjectFootageOptions = Readonly<{
  projectRoot: string;
  searchLocator: string;
  outputLocator: string;
  selector: CutFootageMatchSelector;
  requestedHandles?: CutFootageHandles;
  signal?: AbortSignal;
  /** @internal Deterministic filesystem transaction faults only. */
  publicationHooks?: StagedFileTransactionTestHooks;
  /** @internal Native executable and race seams; production callers omit this. */
  __testHooks?: Readonly<{
    ffmpegExecutable?: string;
    ffprobeExecutable?: string;
    beforeSourceProbe?: (detail: Readonly<{ maxFileBytes: number }>) => void | Promise<void>;
    beforeStage?: (detail: Readonly<{ parent: string }>) => void | Promise<void>;
    afterEncode?: (detail: Readonly<{ path: string; arguments: readonly string[] }>) => void | Promise<void>;
    afterVerification?: (detail: Readonly<{ path: string }>) => void | Promise<void>;
    afterPublication?: (detail: Readonly<{ outputPath: string; manifestPath: string }>) => void | Promise<void>;
    beforeStageCleanup?: (detail: Readonly<{ path: string }>) => void | Promise<void>;
  }>;
}>;

export type ExtractProjectFootageResult = Readonly<{
  manifest: CutFootageExtract;
  outputPath: string;
  manifestPath: string;
}>;

type HeldSnapshot = Readonly<{ dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }>;
type HeldFile = Readonly<{ path: string; handle: FileHandle; snapshot: HeldSnapshot }>;
type DirectorySnapshot = Readonly<{ dev: bigint; ino: bigint }>;
type HeldDirectory = Readonly<{ path: string; snapshot: DirectorySnapshot; leaves: readonly string[] }>;

function snapshot(metadata: Awaited<ReturnType<FileHandle["stat"]>>): HeldSnapshot {
  const value = metadata as unknown as HeldSnapshot;
  return Object.freeze({ dev: value.dev, ino: value.ino, size: value.size, mtimeNs: value.mtimeNs, ctimeNs: value.ctimeNs });
}

function sameSnapshot(metadata: Awaited<ReturnType<FileHandle["stat"]>>, expected: HeldSnapshot) {
  const value = metadata as unknown as HeldSnapshot;
  return value.dev === expected.dev && value.ino === expected.ino && value.size === expected.size
    && value.mtimeNs === expected.mtimeNs && value.ctimeNs === expected.ctimeNs;
}

function systemCode(error: unknown) {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "UNKNOWN";
}

function abortIfRequested(signal: AbortSignal | undefined) {
  if (signal?.aborted) footageFail("CUT_FOOTAGE_PUBLISH", "$signal", "the footage extraction was cancelled.");
}

async function runExtractionHook<T>(signal: AbortSignal | undefined, hook: ((detail: T) => void | Promise<void>) | undefined, detail: T) {
  abortIfRequested(signal);
  await hook?.(detail);
  abortIfRequested(signal);
}

function directorySnapshot(metadata: Awaited<ReturnType<typeof lstat>>): DirectorySnapshot {
  const value = metadata as typeof metadata & Readonly<{ dev: bigint; ino: bigint }>;
  return Object.freeze({ dev: value.dev, ino: value.ino });
}

function sameDirectory(metadata: Awaited<ReturnType<typeof lstat>>, expected: DirectorySnapshot) {
  return metadata.isDirectory() && !metadata.isSymbolicLink() && metadata.dev === expected.dev && metadata.ino === expected.ino;
}

async function cleanupStagingDirectory(
  stage: HeldDirectory | undefined,
  beforeCleanup?: (detail: Readonly<{ path: string }>) => void | Promise<void>,
) {
  if (!stage) return;
  try {
    const initial = await lstat(stage.path, { bigint: true });
    if (!sameDirectory(initial, stage.snapshot)) return;
    await beforeCleanup?.({ path: stage.path });
    const afterHook = await lstat(stage.path, { bigint: true });
    if (!sameDirectory(afterHook, stage.snapshot)) return;
    for (const leaf of stage.leaves) {
      const parent = await lstat(stage.path, { bigint: true });
      if (!sameDirectory(parent, stage.snapshot)) return;
      const metadata = await optionalLstat(leaf);
      if (!metadata) continue;
      if (!metadata.isFile() || metadata.isSymbolicLink()) return;
      await unlink(leaf);
    }
    const final = await lstat(stage.path, { bigint: true });
    if (!sameDirectory(final, stage.snapshot)) return;
    await rmdir(stage.path);
  } catch (error) {
    if (systemCode(error) !== "ENOENT") return;
  }
}

async function optionalLstat(path: string) {
  try { return await lstat(path, { bigint: true }); }
  catch (error) { if (systemCode(error) === "ENOENT") return undefined; throw error; }
}

async function openHeldSource(projectRoot: string, locator: string): Promise<HeldFile> {
  if (typeof constants.O_NOFOLLOW !== "number") footageFail("CUT_FOOTAGE_UNSUPPORTED_MEDIA", "$.sourceSelection.locator", "this platform has no no-follow source boundary.");
  let path = projectRoot;
  const parts = locator.split("/");
  try {
    for (const [index, part] of parts.entries()) {
      path = resolve(path, part);
      const metadata = await lstat(path, { bigint: true });
      if (metadata.isSymbolicLink() || (index === parts.length - 1 ? !metadata.isFile() : !metadata.isDirectory())) {
        footageFail("CUT_FOOTAGE_INDEX_STALE", "$.sourceSelection.locator", "the indexed source now crosses a symlink or non-regular entry.");
      }
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const [handleMetadata, pathMetadata] = await Promise.all([handle.stat({ bigint: true }), lstat(path, { bigint: true })]);
    if (!handleMetadata.isFile() || !pathMetadata.isFile()
      || handleMetadata.dev !== pathMetadata.dev || handleMetadata.ino !== pathMetadata.ino) {
      await handle.close();
      footageFail("CUT_FOOTAGE_INDEX_STALE", "$.sourceSelection.locator", "the indexed source changed while CUT acquired its no-follow handle.");
    }
    return Object.freeze({ path, handle, snapshot: snapshot(handleMetadata) });
  } catch (error) {
    if (error instanceof CutFootageError) throw error;
    return footageFail("CUT_FOOTAGE_INDEX_STALE", "$.sourceSelection.locator", `the indexed source cannot be held safely (${systemCode(error)}).`);
  }
}

async function assertHeldPath(held: HeldFile) {
  const [handleMetadata, pathMetadata] = await Promise.all([held.handle.stat({ bigint: true }), lstat(held.path, { bigint: true })]);
  if (!handleMetadata.isFile() || !pathMetadata.isFile() || !sameSnapshot(handleMetadata, held.snapshot)
    || pathMetadata.dev !== held.snapshot.dev || pathMetadata.ino !== held.snapshot.ino
    || pathMetadata.size !== held.snapshot.size || pathMetadata.mtimeNs !== held.snapshot.mtimeNs || pathMetadata.ctimeNs !== held.snapshot.ctimeNs) {
    footageFail("CUT_FOOTAGE_INDEX_STALE", "$.sourceSelection.locator", "the held indexed source changed during extraction.");
  }
}

async function digestHeldBytes(held: HeldFile) {
  const expectedBytes = Number(held.snapshot.size);
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) {
    footageFail("CUT_FOOTAGE_PUBLISH", "$.output.bytes", "one held extraction file exceeds the safe hashing bound.");
  }
  const digest = createHash("sha256"), buffer = Buffer.allocUnsafe(Math.min(heldHashBufferBytes, Math.max(1, expectedBytes)));
  let position = 0;
  while (position < expectedBytes) {
    const length = Math.min(buffer.byteLength, expectedBytes - position);
    const { bytesRead } = await held.handle.read(buffer, 0, length, position);
    if (bytesRead < 1) break;
    digest.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return digest.digest("hex");
}

async function hashHeldFile(held: HeldFile) {
  await assertHeldPath(held);
  const digest = await digestHeldBytes(held);
  await assertHeldPath(held);
  return digest;
}

async function assertLinkedHeldBytes(held: HeldFile, expectedSha256: string, linkedPath = held.path) {
  const assertLinkedIdentity = async () => {
    const [handleMetadata, pathMetadata] = await Promise.all([held.handle.stat({ bigint: true }), lstat(linkedPath, { bigint: true })]);
    if (!handleMetadata.isFile() || !pathMetadata.isFile()
      || handleMetadata.dev !== held.snapshot.dev || handleMetadata.ino !== held.snapshot.ino
      || pathMetadata.dev !== held.snapshot.dev || pathMetadata.ino !== held.snapshot.ino
      || handleMetadata.size !== held.snapshot.size || pathMetadata.size !== held.snapshot.size
      || handleMetadata.mtimeNs !== held.snapshot.mtimeNs || pathMetadata.mtimeNs !== held.snapshot.mtimeNs) {
      footageFail("CUT_FOOTAGE_PUBLISH", "$.output", "a staged extraction inode or its bytes changed during publication.");
    }
  };
  await assertLinkedIdentity();
  const digest = await digestHeldBytes(held);
  await assertLinkedIdentity();
  if (digest !== expectedSha256) {
    footageFail("CUT_FOOTAGE_PUBLISH", "$.output.sha256", "a staged extraction byte hash changed during publication.");
  }
}

async function assertHeldSourceIdentity(held: HeldFile, source: CutFootageIndex["sources"][number]) {
  if (held.snapshot.size !== BigInt(source.bytes) || await hashHeldFile(held) !== source.sha256) {
    footageFail("CUT_FOOTAGE_INDEX_STALE", "$.sourceSelection.sha256", "the held indexed source bytes no longer match the index.");
  }
}

async function openHeldRegular(path: string): Promise<HeldFile> {
  if (typeof constants.O_NOFOLLOW !== "number") footageFail("CUT_FOOTAGE_PUBLISH", "$.output", "this platform has no no-follow output boundary.");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const metadata = await handle.stat({ bigint: true });
  if (!metadata.isFile()) { await handle.close(); footageFail("CUT_FOOTAGE_PUBLISH", "$.output", "the staged output is not one regular file."); }
  return Object.freeze({ path, handle, snapshot: snapshot(metadata) });
}

function selectMatch(search: CutFootageSearch, value: unknown): CutFootageSearch["matches"][number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return footageFail("CUT_FOOTAGE_MATCH", "$.selector", "must contain exactly one rank or stable match ID.");
  }
  const selector = value as Record<string, unknown>, keys = Object.keys(selector);
  if (keys.length !== 1 || (keys[0] !== "rank" && keys[0] !== "id")) {
    return footageFail("CUT_FOOTAGE_MATCH", "$.selector", "must contain exactly one rank or stable match ID.");
  }
  if (keys[0] === "rank") {
    if (!Number.isSafeInteger(selector.rank) || Number(selector.rank) < 1 || Number(selector.rank) > cutFootageLimits.maximumMatches) {
      return footageFail("CUT_FOOTAGE_MATCH", "$.selector.rank", `must be one-based and no greater than ${cutFootageLimits.maximumMatches}.`);
    }
    if (search.matches.length === 0) return footageFail("CUT_FOOTAGE_NO_MATCH", "$.matches", "the footage search report contains no match to extract.");
    return search.matches[Number(selector.rank) - 1]
      ?? footageFail("CUT_FOOTAGE_MATCH", "$.selector.rank", "does not select one reported footage match.");
  }
  if (typeof selector.id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(selector.id)) {
    return footageFail("CUT_FOOTAGE_MATCH", "$.selector.id", "must be one canonical stable footage match ID.");
  }
  return search.matches.find((match) => match.id === selector.id)
    ?? footageFail("CUT_FOOTAGE_MATCH", "$.selector.id", "does not select one reported footage match.");
}

function admittedHandle(value: unknown, path: string): Rational {
  if (!value || typeof value !== "object" || Array.isArray(value)) return footageFail("CUT_FOOTAGE_RANGE", path, "must be one canonical non-negative rational.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "denominator,numerator" || typeof record.numerator !== "string" || typeof record.denominator !== "string") {
    return footageFail("CUT_FOOTAGE_RANGE", path, "must be one canonical non-negative rational.");
  }
  let result: Rational;
  try { result = rational(record.numerator, record.denominator); }
  catch { return footageFail("CUT_FOOTAGE_RANGE", path, "must be one canonical non-negative rational."); }
  if (result.numerator !== record.numerator || result.denominator !== record.denominator
    || compareRational(result, zeroRational) < 0 || compareRational(result, maximumHandle) > 0) {
    return footageFail("CUT_FOOTAGE_RANGE", path, "must be reduced, non-negative, and no greater than 86400 seconds.");
  }
  return result;
}

function requestedHandles(options: ExtractProjectFootageOptions, match: CutFootageSearch["matches"][number]): CutFootageHandles {
  const authored = options.requestedHandles ?? match.handles ?? Object.freeze({ head: zeroRational, tail: zeroRational });
  if (!authored || typeof authored !== "object" || Array.isArray(authored) || Object.keys(authored).sort().join(",") !== "head,tail") {
    return footageFail("CUT_FOOTAGE_RANGE", "$.requestedHandles", "must contain exact head and tail rationals.");
  }
  return Object.freeze({ head: admittedHandle(authored.head, "$.requestedHandles.head"), tail: admittedHandle(authored.tail, "$.requestedHandles.tail") });
}

async function recheckReports(projectRoot: string, searchLocator: string, search: CutFootageSearch, index: CutFootageIndex) {
  try {
    const currentSearch = await loadCutFootageSearchFile(await resolveProjectFile(projectRoot, searchLocator));
    const currentIndex = await loadCutFootageIndexFile(await resolveProjectFile(projectRoot, currentSearch.indexLocator));
    validateCutFootageSearchAgainstIndex(currentIndex, currentSearch);
    if (currentSearch.searchSha256 !== search.searchSha256 || currentSearch.indexLocator !== search.indexLocator
      || currentIndex.indexSha256 !== index.indexSha256) {
      footageFail("CUT_FOOTAGE_INDEX_STALE", "$.searchSha256", "the search report or its exact index changed during extraction.");
    }
  } catch (error) {
    if (error instanceof CutFootageError && error.code === "CUT_FOOTAGE_INDEX_STALE") throw error;
    footageFail("CUT_FOOTAGE_INDEX_STALE", "$.searchSha256", "the search report or its exact index cannot be revalidated.");
  }
}

function same(value: unknown, expected: unknown) {
  return stableJsonStringify(value) === stableJsonStringify(expected);
}

function mediaContext(
  ordinal: number,
  operation: ReferenceNativeProcessContext["operation"],
  identity: Readonly<{ locator: string; sha256: string; bytes: number }>,
  streamIndex?: number,
  variant: "master" | "proxy" = "master",
): ReferenceNativeProcessContext {
  return Object.freeze({
    ordinal, operation, resourceId: identity.locator, resourceSha256: identity.sha256,
    resourceBytes: identity.bytes, variant, ...(streamIndex === undefined ? {} : { streamIndex }),
  });
}

function normalizeSourceProbe(bytes: CutByteProbe, media: CutMediaProbe, indexed: CutFootageIndex["sources"][number]) {
  const normalized = normalizeFootageSourceProbe(bytes, media);
  if (!same(normalized.source, indexed)) footageFail("CUT_FOOTAGE_INDEX_STALE", "$.sourceSelection", "the selected source probe no longer matches its index record.");
  return normalized;
}

async function prepareDestination(projectRoot: string, outputLocator: string) {
  if (!/\.(?:mp4|mov)$/iu.test(outputLocator)) footageFail("CUT_FOOTAGE_PUBLISH", "$.outputLocator", "must end in .mp4 or .mov for footage v1.");
  const manifestLocator = validateProjectLocator(`${outputLocator}.cut-footage.json`, "footage extraction manifest locator");
  const parentLocator = dirname(outputLocator).split(sep).join("/");
  let parent: string;
  try { parent = parentLocator === "." ? projectRoot : await ensureProjectWriteDirectory(projectRoot, parentLocator); }
  catch { return footageFail("CUT_FOOTAGE_PUBLISH", "$.outputLocator", "the extraction destination parent cannot be prepared without following a symlink."); }
  const outputPath = resolve(parent, basename(outputLocator)), manifestPath = resolve(parent, basename(manifestLocator));
  let parentSnapshot: DirectorySnapshot;
  try {
    const initialParent = await lstat(parent, { bigint: true });
    if (!initialParent.isDirectory() || initialParent.isSymbolicLink()) {
      footageFail("CUT_FOOTAGE_PUBLISH", "$.outputLocator", "the extraction destination parent is not one direct regular directory.");
    }
    parentSnapshot = directorySnapshot(initialParent);
    if (await optionalLstat(outputPath) || await optionalLstat(manifestPath)) {
      footageFail("CUT_FOOTAGE_OUTPUT_EXISTS", "$.outputLocator", "the footage output or its manifest already exists.");
    }
    const finalParent = await lstat(parent, { bigint: true });
    if (!sameDirectory(finalParent, parentSnapshot)) {
      footageFail("CUT_FOOTAGE_PUBLISH", "$.outputLocator", "the extraction destination parent changed while it was prepared.");
    }
  } catch (error) {
    if (error instanceof CutFootageError) throw error;
    return footageFail("CUT_FOOTAGE_PUBLISH", "$.outputLocator", "the extraction destination leaves cannot be inspected safely.");
  }
  return Object.freeze({ outputLocator, manifestLocator, outputPath, manifestPath, parent, parentSnapshot });
}

async function assertDestinationParent(destination: Awaited<ReturnType<typeof prepareDestination>>) {
  try {
    const current = await lstat(destination.parent, { bigint: true });
    if (!sameDirectory(current, destination.parentSnapshot)) {
      footageFail("CUT_FOOTAGE_PUBLISH", "$.outputLocator", "the extraction destination parent changed during staging or publication.");
    }
  } catch (error) {
    if (error instanceof CutFootageError) throw error;
    footageFail("CUT_FOOTAGE_PUBLISH", "$.outputLocator", "the extraction destination parent cannot be revalidated safely.");
  }
}

function ffmpegVersion(stdout: string) {
  const line = stdout.split(/\r?\n/u)[0];
  if (!line || line.length > 128 || !/^ffmpeg version [^\u0000-\u001f\u007f]+$/u.test(line)) {
    return footageFail("CUT_FOOTAGE_UNSUPPORTED_MEDIA", "$.toolchain.ffmpeg.version", "the bound FFmpeg version line is malformed.");
  }
  return line;
}

async function rollbackOwnedPair(entries: readonly Readonly<{ path: string; held: HeldFile }>[]) {
  let uncertain = false;
  for (const entry of [...entries].reverse()) {
    try {
      const [destination, owned] = await Promise.all([optionalLstat(entry.path), entry.held.handle.stat({ bigint: true })]);
      if (!destination) continue;
      if (destination.dev !== owned.dev || destination.ino !== owned.ino) { uncertain = true; continue; }
      await unlink(entry.path);
    } catch { uncertain = true; }
  }
  if (uncertain) footageFail("CUT_FOOTAGE_PUBLISH", "$.outputLocator", "a stale extraction could not be rolled back without touching a foreign destination.");
}

async function loadExtractionReports(projectRoot: string, searchLocator: string) {
  try {
    const search = await loadCutFootageSearchFile(await resolveProjectFile(projectRoot, searchLocator));
    const index = await loadCutFootageIndexFile(await resolveProjectFile(projectRoot, search.indexLocator));
    validateCutFootageSearchAgainstIndex(index, search);
    return Object.freeze({ search, index });
  } catch (error) {
    if (error instanceof CutFootageError && /^\$(?:$|\.|\[)/u.test(error.path)) throw error;
    footageFail("CUT_FOOTAGE_INDEX_STALE", "$.searchSha256", "the search report or its exact index cannot be loaded from bounded project files.");
  }
}

/** Extract one exact search match into a verified create-only candidate pair. */
async function extractProjectFootageOperation(options: ExtractProjectFootageOptions): Promise<ExtractProjectFootageResult> {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    return footageFail("CUT_FOOTAGE_MATCH", "$", "must be one footage extraction request.");
  }
  abortIfRequested(options.signal);
  const projectRoot = await realpath(resolve(options.projectRoot));
  const searchLocator = validateProjectLocator(options.searchLocator, "footage search locator");
  const outputLocator = validateProjectLocator(options.outputLocator, "footage output locator");
  const { search, index } = await loadExtractionReports(projectRoot, searchLocator);
  abortIfRequested(options.signal);
  const match = selectMatch(search, options.selector);
  const indexedSource = index.sources.find((source) => source.locator === match.sourceSelection.locator);
  const indexedStream = indexedSource?.streams.find((stream) => stream.index === match.sourceSelection.streamIndex);
  if (!indexedSource || indexedSource.sha256 !== match.sourceSelection.sha256 || indexedStream?.type !== "video" || !indexedStream.frameRate) {
    return footageFail("CUT_FOOTAGE_MATCH", "$.sourceSelection", "must bind one indexed video stream with an exact frame rate.");
  }
  const destination = await prepareDestination(projectRoot, outputLocator);
  const source = await openHeldSource(projectRoot, match.sourceSelection.locator);
  let stageDirectory: HeldDirectory | undefined, heldOutput: HeldFile | undefined, heldManifest: HeldFile | undefined;
  try {
    await assertHeldSourceIdentity(source, indexedSource);
    await recheckReports(projectRoot, searchLocator, search, index);
    const grid = divideRational(rational(1), indexedStream.frameRate);
    const clamped = clampFootageHandles({
      range: match.sourceSelection.range,
      duration: indexedSource.duration,
      requested: requestedHandles(options, match),
      grid,
    });
    const exactStartFrame = divideRational(clamped.range.start, grid), exactEndFrame = divideRational(clamped.range.end, grid);
    if (exactStartFrame.denominator !== "1" || exactEndFrame.denominator !== "1") {
      footageFail("CUT_FOOTAGE_RANGE", "$.finalRange", "must align to exact selected-source frames.");
    }
    const startFrameIndex = BigInt(exactStartFrame.numerator), endFrameExclusive = BigInt(exactEndFrame.numerator);
    const expectedFrames = endFrameExclusive - startFrameIndex;
    if (expectedFrames < 1n || expectedFrames > maximumDecodedVideoCadenceFrames) {
      footageFail("CUT_FOOTAGE_RANGE", "$.finalRange", "exceeds the bounded decoded source frame extent.");
    }

    const ffmpeg = await bindReferenceNativeMediaTool("ffmpeg", options.__testHooks?.ffmpegExecutable);
    const ffprobe = await bindReferenceNativeMediaTool("ffprobe", options.__testHooks?.ffprobeExecutable);
    const ffmpegCollector = createReferenceNativeProcessCollector(ffmpeg);
    const ffprobeCollector = createReferenceNativeProcessCollector(ffprobe);
    let operationError: unknown;
    let initialBytes: CutByteProbe | undefined, initialMedia: CutMediaProbe | undefined;
    let outputBytes: CutByteProbe | undefined, outputMedia: CutMediaProbe | undefined, outputCadence: Awaited<ReturnType<typeof probeProjectDecodedVideoCadence>> | undefined;
    let version = "", ffmpegArguments: string[] = [], stageOutput = "", stageManifest = "";
    try {
      await runExtractionHook(options.signal, options.__testHooks?.beforeSourceProbe, { maxFileBytes: maximumIndexedSourceBytes });
      initialBytes = await probeProjectBytes(projectRoot, indexedSource.locator, { maxFileBytes: maximumIndexedSourceBytes, signal: options.signal });
      abortIfRequested(options.signal);
      initialMedia = await probeProjectMedia(projectRoot, indexedSource.locator, { maxFileBytes: maximumIndexedSourceBytes }, { ffprobe: ffprobe.executablePath }, {
        authority: ffprobe, collector: ffprobeCollector, signal: options.signal, terminateProcessTree: true,
        context: mediaContext(0, "media-metadata", indexedSource),
      });
      abortIfRequested(options.signal);
      normalizeSourceProbe(initialBytes, initialMedia, indexedSource);
      await assertHeldSourceIdentity(source, indexedSource);
      const currentStream = initialMedia.streams.find((stream) => stream.index === match.sourceSelection.streamIndex && stream.type === "video");
      if (!currentStream?.frameRate || !currentStream.duration || compareRational(currentStream.frameRate, indexedStream.frameRate) !== 0
        || compareRational(currentStream.duration, indexedSource.duration) !== 0) {
        footageFail("CUT_FOOTAGE_INDEX_STALE", "$.sourceSelection.streamIndex", "the selected video stream type, rate, or duration changed.");
      }
      let sourceCadence: Awaited<ReturnType<typeof probeProjectDecodedVideoCadence>>;
      try {
        sourceCadence = await probeProjectDecodedVideoCadence(
          projectRoot,
          indexedSource.locator,
          initialMedia,
          currentStream.index,
          { maxFileBytes: maximumIndexedSourceBytes },
          { ffprobe: ffprobe.executablePath },
          {
            authority: ffprobe, collector: ffprobeCollector, signal: options.signal, terminateProcessTree: true,
            context: mediaContext(1, "decoded-video-cadence", indexedSource, currentStream.index),
          },
        );
        const sourceCadenceDuration = decodedVideoCadenceDuration(sourceCadence, currentStream);
        if (compareRational(sourceCadenceDuration, indexedSource.duration) !== 0
          || endFrameExclusive > BigInt(sourceCadence.frameCount)) {
          footageFail("CUT_FOOTAGE_UNSUPPORTED_MEDIA", "$.sourceSelection.streamIndex", "the selected source decoded cadence does not bind its indexed frame extent.");
        }
      } catch (error) {
        if (error instanceof CutFootageError) throw error;
        footageFail("CUT_FOOTAGE_UNSUPPORTED_MEDIA", "$.sourceSelection.streamIndex", "the selected source has no exact constant decoded-video cadence for frame-index extraction.");
      }
      abortIfRequested(options.signal);
      const versionCapture = await runBoundReferenceFfmpegCapture(ffmpeg.executablePath, ["-version"], 30_000, { stdoutBytes: 16_000, stderrBytes: 16_000, totalBytes: 32_000 }, {
        authority: ffmpeg, collector: ffmpegCollector,
        context: mediaContext(0, "toolchain-version", indexedSource),
      }, { signal: options.signal, terminateProcessTree: true });
      version = ffmpegVersion(versionCapture.stdout);

      await assertDestinationParent(destination);
      await runExtractionHook(options.signal, options.__testHooks?.beforeStage, { parent: destination.parent });
      await assertDestinationParent(destination);
      const stagePath = await mkdtemp(resolve(destination.parent, `.${basename(outputLocator)}.cut-footage-staging-`));
      const stageMetadata = await lstat(stagePath, { bigint: true });
      if (!stageMetadata.isDirectory() || stageMetadata.isSymbolicLink()) {
        footageFail("CUT_FOOTAGE_PUBLISH", "$.output", "the private extraction staging root is not one direct directory.");
      }
      const extension = outputLocator.toLowerCase().endsWith(".mov") ? "mov" : "mp4";
      stageOutput = resolve(stagePath, `candidate.${extension}`);
      stageManifest = resolve(stagePath, "candidate.cut-footage.json");
      stageDirectory = Object.freeze({
        path: stagePath,
        snapshot: directorySnapshot(stageMetadata),
        leaves: Object.freeze([stageOutput, stageManifest]),
      });
      const stageLocator = relative(projectRoot, stageOutput).split(sep).join("/");
      const filter = `[0:${currentStream.index}]trim=start_frame=${startFrameIndex}:end_frame=${endFrameExclusive},setpts=PTS-STARTPTS[v]`;
      ffmpegArguments = [
        "-nostdin", "-v", "error", "-i", "/dev/fd/3", "-filter_complex", filter,
        "-map", "[v]", "-an", "-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1",
        "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p", "-preset", "medium", "-crf", "18",
        "-fps_mode", "passthrough", "-movflags", "+faststart", "-fs", String(maximumExtractBytes), "-f", extension, stageOutput,
      ];
      await runBoundReferenceFfmpeg(ffmpeg.executablePath, ffmpegArguments, maximumNativeTimeoutMs, { stderrBytes: 128_000, totalBytes: 128_000 }, {
        authority: ffmpeg, collector: ffmpegCollector,
        context: mediaContext(1, "footage-range-extract", indexedSource, currentStream.index),
      }, { signal: options.signal, inheritedFileDescriptors: [source.handle.fd], terminateProcessTree: true });
      await runExtractionHook(options.signal, options.__testHooks?.afterEncode, { path: stageOutput, arguments: Object.freeze([...ffmpegArguments]) });
      heldOutput = await openHeldRegular(stageOutput);
      const heldStageSha = await hashHeldFile(heldOutput);
      const heldStageBytes = Number(heldOutput.snapshot.size);
      if (!Number.isSafeInteger(heldStageBytes) || heldStageBytes < 1 || heldStageBytes > maximumExtractBytes) {
        footageFail("CUT_FOOTAGE_PUBLISH", "$.output.bytes", "the staged extraction is empty or exceeds its byte bound.");
      }
      outputBytes = await probeProjectBytes(projectRoot, stageLocator, { maxFileBytes: maximumExtractBytes, signal: options.signal });
      if (outputBytes.file.bytes !== heldStageBytes || outputBytes.file.sha256 !== heldStageSha) footageFail("CUT_FOOTAGE_PUBLISH", "$.output.sha256", "the staged output changed during byte verification.");
      abortIfRequested(options.signal);
      outputMedia = await probeProjectMedia(projectRoot, stageLocator, { maxFileBytes: maximumExtractBytes }, { ffprobe: ffprobe.executablePath }, {
        authority: ffprobe, collector: ffprobeCollector, signal: options.signal, terminateProcessTree: true,
        context: mediaContext(2, "media-metadata", outputBytes.file, undefined, "proxy"),
      });
      if (outputMedia.streams.length !== 1) footageFail("CUT_FOOTAGE_UNSUPPORTED_MEDIA", "$.output.streams", "the staged output must contain exactly one public video stream.");
      const outputStream = outputMedia.streams[0];
      if (!outputStream || outputStream.index !== 0 || outputStream.type !== "video" || outputStream.codec !== "h264" || outputStream.profile !== "High"
        || !outputStream.start || compareRational(outputStream.start, zeroRational) !== 0
        || !outputStream.frameRate || compareRational(outputStream.frameRate, indexedStream.frameRate) !== 0) {
        footageFail("CUT_FOOTAGE_UNSUPPORTED_MEDIA", "$.output.streams[0]", "must be one zero-start High-profile H.264 stream at the selected source frame rate.");
      }
      outputCadence = await probeProjectDecodedVideoCadence(projectRoot, stageLocator, outputMedia, 0, {}, { ffprobe: ffprobe.executablePath }, {
        authority: ffprobe, collector: ffprobeCollector, signal: options.signal, terminateProcessTree: true,
        context: mediaContext(3, "decoded-video-cadence", outputBytes.file, 0, "proxy"),
      });
      const outputDuration = decodedVideoCadenceDuration(outputCadence, outputStream);
      if (BigInt(outputCadence.frameCount) !== expectedFrames
        || compareRational(outputDuration, subtractRational(clamped.range.end, clamped.range.start)) !== 0) {
        footageFail("CUT_FOOTAGE_RANGE", "$.output", "the decoded output frame count or exact duration differs from the selected range.");
      }
      abortIfRequested(options.signal);
      const postBytes = await probeProjectBytes(projectRoot, indexedSource.locator, { maxFileBytes: maximumIndexedSourceBytes, signal: options.signal });
      const postMedia = await probeProjectMedia(projectRoot, indexedSource.locator, { maxFileBytes: maximumIndexedSourceBytes }, { ffprobe: ffprobe.executablePath }, {
        authority: ffprobe, collector: ffprobeCollector, signal: options.signal, terminateProcessTree: true,
        context: mediaContext(4, "media-metadata", indexedSource),
      });
      normalizeSourceProbe(postBytes, postMedia, indexedSource);
      if (!same(postBytes, initialBytes) || !same(postMedia, initialMedia)) footageFail("CUT_FOOTAGE_INDEX_STALE", "$.sourceSelection", "the source probe changed during extraction.");
      await assertHeldSourceIdentity(source, indexedSource);
      abortIfRequested(options.signal);
      await ffmpeg.verify(); abortIfRequested(options.signal);
      await ffprobe.verify(); abortIfRequested(options.signal);
      await ffmpegCollector.seal(); abortIfRequested(options.signal);
      await ffprobeCollector.seal(); abortIfRequested(options.signal);
    } catch (error) { operationError = error; }
    if (operationError !== undefined) {
      await Promise.allSettled([ffmpegCollector.seal(), ffprobeCollector.seal()]);
      abortIfRequested(options.signal);
      if (operationError instanceof CutFootageError) throw operationError;
      footageFail("CUT_FOOTAGE_UNSUPPORTED_MEDIA", "$.sourceSelection", "the bound extraction toolchain could not produce a verified exact clip.");
    }
    if (!initialMedia || !outputBytes || !outputMedia || !outputCadence || !heldOutput || !stageOutput || !stageManifest || !version) {
      footageFail("CUT_FOOTAGE_PUBLISH", "$.output", "the extraction did not produce complete verification evidence.");
    }
    await runExtractionHook(options.signal, options.__testHooks?.afterVerification, { path: stageOutput });
    await assertHeldSourceIdentity(source, indexedSource);
    abortIfRequested(options.signal);
    await assertHeldPath(heldOutput);
    if (await hashHeldFile(heldOutput) !== outputBytes.file.sha256) footageFail("CUT_FOOTAGE_PUBLISH", "$.output.sha256", "the staged output changed after verification.");
    await recheckReports(projectRoot, searchLocator, search, index);
    abortIfRequested(options.signal);

    const outputStreams = Object.freeze(outputMedia.streams.map((stream) => Object.freeze({
      index: stream.index, type: stream.type === "audio" ? "audio" as const : "video" as const, codec: stream.codec,
    })).sort((left, right) => left.index - right.index));
    const body = Object.freeze({
      format: "cut-footage-extract" as const, version: 1 as const,
      searchSha256: search.searchSha256, indexSha256: index.indexSha256, matchId: match.id,
      label: "candidate-only-not-cut-lock" as const, sourceSelection: match.sourceSelection,
      requestedHandles: clamped.requested, effectiveHandles: clamped.effective, finalRange: clamped.range,
      toolchain: Object.freeze({
        ffmpeg: Object.freeze({ name: "ffmpeg" as const, version }),
        ffprobe: Object.freeze({ name: "ffprobe" as const, version: initialMedia.implementation.version }),
      }),
      output: Object.freeze({ locator: outputLocator, bytes: outputBytes.file.bytes, sha256: outputBytes.file.sha256, streams: outputStreams }),
    });
    const extractSha256 = createHash("sha256").update(stableJsonStringify(body)).digest("hex");
    const manifestBytes = Buffer.from(`${stableJsonStringify({ ...body, extractSha256 })}\n`, "utf8");
    const manifest = validateCutFootageExtractAgainstSearch(search, parseCutFootageExtract(manifestBytes));
    abortIfRequested(options.signal);
    await writeFile(stageManifest, manifestBytes, { flag: "wx", mode: 0o600 });
    abortIfRequested(options.signal);
    heldManifest = await openHeldRegular(stageManifest);
    const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
    if (await hashHeldFile(heldManifest) !== manifestSha256) {
      footageFail("CUT_FOOTAGE_PUBLISH", "$.extractSha256", "the staged extraction manifest changed before publication.");
    }
    abortIfRequested(options.signal);
    const verifiedOutput = heldOutput, verifiedManifest = heldManifest;
    const assertPublicationInputs = async () => {
      abortIfRequested(options.signal);
      await Promise.all([
        assertHeldPath(source), assertLinkedHeldBytes(verifiedOutput, outputBytes.file.sha256),
        assertLinkedHeldBytes(verifiedManifest, manifestSha256),
        recheckReports(projectRoot, searchLocator, search, index), assertDestinationParent(destination),
      ]);
      abortIfRequested(options.signal);
    };
    const guardedHooks: StagedFileTransactionTestHooks = Object.freeze({
      ...(options.publicationHooks?.device === undefined ? {} : { device: options.publicationHooks.device }),
      async fault(point) {
        if (point.phase !== "promotion") {
          await options.publicationHooks?.fault?.(point);
          return;
        }
        await assertPublicationInputs();
        await options.publicationHooks?.fault?.(point);
        abortIfRequested(options.signal);
        await assertPublicationInputs();
      },
    });
    try {
      await publishCreateOnlyStagedFileTransactionForTest([
        { staged: stageOutput, destination: destination.outputPath, order: 100, role: "footage-output" },
        { staged: stageManifest, destination: destination.manifestPath, order: 200, role: "footage-manifest" },
      ], guardedHooks);
    } catch (error) {
      if (error instanceof StagedFileTransactionError && error.code === "CUT_PUBLISH_EXISTS") {
        footageFail("CUT_FOOTAGE_OUTPUT_EXISTS", "$.outputLocator", "the footage output or its manifest appeared during publication.");
      }
      if (error instanceof StagedFileTransactionError && error.cause instanceof CutFootageError
        && error.code === "CUT_PUBLISH_COMMIT") {
        throw error.cause;
      }
      if (error instanceof CutFootageError) throw error;
      footageFail("CUT_FOOTAGE_PUBLISH", "$.outputLocator", "the verified extraction pair could not be published safely.");
    }
    try {
      abortIfRequested(options.signal);
      await runExtractionHook(options.signal, options.__testHooks?.afterPublication, {
        outputPath: destination.outputPath, manifestPath: destination.manifestPath,
      });
      await assertDestinationParent(destination);
      await Promise.all([
        assertLinkedHeldBytes(heldOutput, outputBytes.file.sha256, destination.outputPath),
        assertLinkedHeldBytes(heldManifest, manifestSha256, destination.manifestPath),
      ]);
      await assertHeldSourceIdentity(source, indexedSource);
      await recheckReports(projectRoot, searchLocator, search, index);
      abortIfRequested(options.signal);
    } catch (error) {
      await rollbackOwnedPair([
        { path: destination.outputPath, held: heldOutput }, { path: destination.manifestPath, held: heldManifest },
      ]);
      throw error;
    }
    return Object.freeze({ manifest, outputPath: destination.outputPath, manifestPath: destination.manifestPath });
  } finally {
    await Promise.allSettled([heldOutput?.handle.close(), heldManifest?.handle.close(), source.handle.close()]);
    await cleanupStagingDirectory(stageDirectory, options.__testHooks?.beforeStageCleanup);
  }
}


/** Extract one exact search match while keeping every local failure inside stable footage diagnostics. */
export async function extractProjectFootage(options: ExtractProjectFootageOptions): Promise<ExtractProjectFootageResult> {
  try {
    return await extractProjectFootageOperation(options);
  } catch (error) {
    if (error instanceof CutFootageError) throw error;
    footageFail("CUT_FOOTAGE_PUBLISH", "$", "the footage extraction failed at a bounded local I/O boundary.");
  }
}
