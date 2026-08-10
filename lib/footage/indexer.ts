import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, lstatSync, realpathSync, type BigIntStats } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import { stableJsonStringify } from "../core/stable";
import { addRational, compareRational, type Rational } from "../language/rational";
import {
  bindReferenceNativeMediaTool,
  createReferenceNativeProcessCollector,
} from "../project/native-process-authority";
import { resolveProjectFile, validateProjectLocator } from "../project/manifest";
import {
  ensureProjectWriteDirectory,
  publishStagedFileTransaction,
  publishStagedFileTransactionForTest,
  snapshotStagedFileDestination,
  type StagedFileDestinationSnapshot,
  type StagedFilePublication,
  type StagedFileTransactionTestHooks,
} from "../project/write-boundary";
import { runBoundReferenceFfmpeg, type ReferenceMediaNativeProcessExecution } from "../runtime/reference/ffmpeg";
import { cutProductVersion } from "../version";
import {
  cutFootageLimits,
  parseCutFootageIndex,
  type CutFootageIndex,
} from "./contracts";
import { discoverProjectFootage, type FootageDiscoveryLimits } from "./discovery";
import { CutFootageError, footageFail } from "./diagnostics";
import {
  defaultFootageChunkPolicy,
  planFootageSources,
  type FootageBackendIdentity,
  type FootagePlan,
  type FootagePlannedChunk,
} from "./planner";
import {
  startCutFootageSidecar,
  type CutFootageSidecarIndexResult,
  type CutFootageSidecarSession,
  type CutFootageSidecarStart,
} from "./sidecar";

const vectorMagic = Buffer.from("CUTFVEC1", "ascii");
const vectorHeaderBytes = 8 + 4 + 4 + 32;
const maximumVectorBytes = 512 * 1024 * 1024;
const maximumFrameBytes = 4 * 1024 * 1024;
const maximumStagedFrameBytes = 512 * 1024 * 1024;
const maximumSamplesPerFfmpegBatch = 128;
const sourceHashBufferBytes = 1024 * 1024;
const unitVectorTolerance = 1e-4;
const identifierPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const shaPattern = /^[a-f0-9]{64}$/u;

export type CutFootageIndexBackend = Readonly<{
  identity: FootageBackendIdentity;
  sidecar: Omit<CutFootageSidecarStart, "signal">;
}>;

export type CutFootageIndexResult = Readonly<{
  index: CutFootageIndex;
  indexLocator: string;
  vectorLocator: string;
  reusedChunkIds: readonly string[];
  indexedChunkIds: readonly string[];
}>;

export type CutFootageVectorRecord = Readonly<{ chunkId: string; vector: Float32Array }>;
export type CutFootageVectorArtifact = Readonly<{
  dimensions: number;
  planSha256: string;
  records: readonly CutFootageVectorRecord[];
}>;

export type FootageFrameBatchRequest = Readonly<{
  executable: string;
  arguments: readonly string[];
  sourceLocator: string;
  streamIndex: number;
  samplePoints: readonly Rational[];
  outputPaths: readonly string[];
  execution: ReferenceMediaNativeProcessExecution;
}>;

export type FootageIndexerTestHooks = Readonly<{
  runFrameBatch?: (request: FootageFrameBatchRequest) => Promise<void>;
  afterFrames?: (plan: FootagePlan) => void | Promise<void>;
  beforeSourceRecheck?: (plan: FootagePlan) => void | Promise<void>;
  afterSourceRecheck?: (plan: FootagePlan) => void | Promise<void>;
  beforePublication?: (plan: FootagePlan) => void | Promise<void>;
  afterFirstFullReuseSourceMetadataRecheck?: () => void | Promise<void>;
  afterFirstFullReuseOutputSeal?: () => void;
  publication?: StagedFileTransactionTestHooks;
}>;

type FileEvidence = Readonly<{
  bytes: number;
  sha256: string;
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;

type DirectoryEvidence = Readonly<{ dev: bigint; ino: bigint }>;

type PlannedSourceSnapshot = Readonly<{
  projectRoot: string;
  locator: string;
  path: string;
  evidence: FileEvidence;
}>;

type PriorPair = Readonly<{
  index: CutFootageIndex;
  vector: CutFootageVectorArtifact;
  indexBytes: Buffer;
  vectorBytes: Buffer;
  indexEvidence: FileEvidence;
  vectorEvidence: FileEvidence;
}>;

type SampleFrame = Readonly<{
  path: string;
  bytes: number;
  sha256: string;
}>;

type MergeRecord = Readonly<{
  chunkId: string;
  vector: Float32Array;
  canonicalizeZero: boolean;
}>;

function bytewise(left: string, right: string) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function abortIfRequested(signal: AbortSignal | undefined) {
  if (signal?.aborted) footageFail("CUT_FOOTAGE_BACKEND_PROTOCOL", "$signal", "the footage index operation was cancelled.");
}

function systemErrorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function sameSourceMetadata(metadata: BigIntStats, expected: FileEvidence) {
  return metadata.isFile() && !metadata.isSymbolicLink()
    && metadata.dev === expected.dev && metadata.ino === expected.ino && metadata.size === expected.size
    && metadata.mtimeNs === expected.mtimeNs && metadata.ctimeNs === expected.ctimeNs;
}

async function hashSourceHandle(handle: Awaited<ReturnType<typeof open>>, expectedBytes: number, locator: string, signal?: AbortSignal) {
  const digest = createHash("sha256"), buffer = Buffer.allocUnsafe(sourceHashBufferBytes);
  let position = 0;
  while (position < expectedBytes) {
    abortIfRequested(signal);
    const length = Math.min(buffer.byteLength, expectedBytes - position);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead < 1) footageFail("CUT_FOOTAGE_INDEX_STALE", locator, "was truncated while its pinned bytes were being verified.");
    digest.update(buffer.subarray(0, bytesRead)); position += bytesRead;
  }
  if ((await handle.read(buffer, 0, 1, expectedBytes)).bytesRead !== 0) {
    footageFail("CUT_FOOTAGE_INDEX_STALE", locator, "grew while its pinned bytes were being verified.");
  }
  abortIfRequested(signal);
  return digest.digest("hex");
}

async function verifySourcePath(snapshot: PlannedSourceSnapshot) {
  try {
    const [path, metadata] = await Promise.all([
      resolveProjectFile(snapshot.projectRoot, snapshot.locator),
      lstat(snapshot.path, { bigint: true }),
    ]);
    if (path !== snapshot.path || !sameSourceMetadata(metadata, snapshot.evidence)) {
      footageFail("CUT_FOOTAGE_INDEX_STALE", snapshot.locator, "changed while the footage index was being built.");
    }
  } catch (error) {
    if (error instanceof CutFootageError) throw error;
    footageFail("CUT_FOOTAGE_INDEX_STALE", snapshot.locator, "could not be revalidated through its pinned project locator.");
  }
}

async function capturePlannedSourceSnapshots(projectRoot: string, plan: FootagePlan) {
  const snapshots = new Map<string, PlannedSourceSnapshot>();
  for (const source of plan.sources) {
    const locator = source.source.locator;
    try {
      const path = await resolveProjectFile(projectRoot, locator);
      const metadata = await lstat(path, { bigint: true });
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== BigInt(source.source.bytes)) {
        footageFail("CUT_FOOTAGE_INDEX_STALE", locator, "changed before its pinned source snapshot could be captured.");
      }
      snapshots.set(locator, Object.freeze({
        projectRoot, locator, path,
        evidence: Object.freeze({
          bytes: source.source.bytes, sha256: source.source.sha256,
          dev: metadata.dev, ino: metadata.ino, size: metadata.size, mtimeNs: metadata.mtimeNs, ctimeNs: metadata.ctimeNs,
        }),
      }));
    } catch (error) {
      if (error instanceof CutFootageError) throw error;
      footageFail("CUT_FOOTAGE_INDEX_STALE", locator, "could not be captured as one stable regular no-follow source.");
    }
  }
  return snapshots as ReadonlyMap<string, PlannedSourceSnapshot>;
}

async function openVerifiedSource(snapshot: PlannedSourceSnapshot, signal?: AbortSignal) {
  if (typeof fsConstants.O_NOFOLLOW !== "number") {
    footageFail("CUT_FOOTAGE_INDEX_STALE", snapshot.locator, "the host cannot pin a no-follow source handle.");
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(snapshot.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    if (!sameSourceMetadata(before, snapshot.evidence)) {
      footageFail("CUT_FOOTAGE_INDEX_STALE", snapshot.locator, "changed before its pinned source handle was opened.");
    }
    const digest = await hashSourceHandle(handle, snapshot.evidence.bytes, snapshot.locator, signal);
    const after = await handle.stat({ bigint: true });
    if (digest !== snapshot.evidence.sha256 || !sameSourceMetadata(after, snapshot.evidence)) {
      footageFail("CUT_FOOTAGE_INDEX_STALE", snapshot.locator, "changed while its pinned source bytes were being verified.");
    }
    await verifySourcePath(snapshot);
    return handle;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof CutFootageError) throw error;
    footageFail("CUT_FOOTAGE_INDEX_STALE", snapshot.locator, "could not be opened as one stable regular no-follow source.");
  }
}

async function verifyOpenSource(snapshot: PlannedSourceSnapshot, handle: Awaited<ReturnType<typeof open>>, signal?: AbortSignal) {
  try {
    abortIfRequested(signal);
    const metadata = await handle.stat({ bigint: true });
    if (!sameSourceMetadata(metadata, snapshot.evidence)) {
      footageFail("CUT_FOOTAGE_INDEX_STALE", snapshot.locator, "changed while its pinned source handle was in use.");
    }
    await verifySourcePath(snapshot);
  } catch (error) {
    if (error instanceof CutFootageError) throw error;
    footageFail("CUT_FOOTAGE_INDEX_STALE", snapshot.locator, "could not be revalidated after pinned source use.");
  }
}

async function verifyPlannedSourceHashes(snapshots: ReadonlyMap<string, PlannedSourceSnapshot>, signal?: AbortSignal) {
  for (const snapshot of snapshots.values()) {
    const handle = await openVerifiedSource(snapshot, signal);
    await handle.close().catch(() => undefined);
  }
}

async function verifyPlannedSourceMetadata(
  snapshots: ReadonlyMap<string, PlannedSourceSnapshot>,
  afterFirst?: () => void | Promise<void>,
) {
  let index = 0;
  for (const snapshot of snapshots.values()) {
    await verifySourcePath(snapshot);
    if (index === 0) await afterFirst?.();
    index += 1;
  }
}

function sealPlannedSourceAuthority(
  snapshots: ReadonlyMap<string, PlannedSourceSnapshot>,
  signal?: AbortSignal,
) {
  try {
    abortIfRequested(signal);
    for (const snapshot of snapshots.values()) {
      abortIfRequested(signal);
      const requested = resolve(snapshot.projectRoot, snapshot.locator);
      const metadata = lstatSync(requested, { bigint: true });
      if (realpathSync(requested) !== snapshot.path || !sameSourceMetadata(metadata, snapshot.evidence)) {
        footageFail("CUT_FOOTAGE_INDEX_STALE", snapshot.locator, "changed at the final reuse source seal.");
      }
    }
    abortIfRequested(signal);
  } catch (error) {
    if (error instanceof CutFootageError) throw error;
    footageFail("CUT_FOOTAGE_INDEX_STALE", "$sources", "the final planned-source authority seal could not be verified.");
  }
}

function sealPairAuthority(
  expected: Readonly<{ index: FileEvidence; vector: FileEvidence }>,
  indexPath: string,
  vectorPath: string,
  signal?: AbortSignal,
) {
  try {
    abortIfRequested(signal);
    const indexMetadata = lstatSync(indexPath, { bigint: true }), vectorMetadata = lstatSync(vectorPath, { bigint: true });
    if (!sameSourceMetadata(indexMetadata, expected.index) || !sameSourceMetadata(vectorMetadata, expected.vector)
      || realpathSync(indexPath) !== indexPath || realpathSync(vectorPath) !== vectorPath) {
      footageFail("CUT_FOOTAGE_INDEX_STALE", "$output", "the verified footage index/vector pair changed at its final authority seal.");
    }
    abortIfRequested(signal);
  } catch (error) {
    if (error instanceof CutFootageError) throw error;
    footageFail("CUT_FOOTAGE_INDEX_STALE", "$output", "the final footage index/vector authority seal could not be verified.");
  }
}

function sealFullReuseAuthority(
  prior: PriorPair,
  indexPath: string,
  vectorPath: string,
  snapshots: ReadonlyMap<string, PlannedSourceSnapshot>,
  signal?: AbortSignal,
  hooks?: FootageIndexerTestHooks,
) {
  const expected = Object.freeze({ index: prior.indexEvidence, vector: prior.vectorEvidence });
  sealPairAuthority(expected, indexPath, vectorPath, signal);
  hooks?.afterFirstFullReuseOutputSeal?.();
  sealPlannedSourceAuthority(snapshots, signal);
  sealPairAuthority(expected, indexPath, vectorPath, signal);
}

async function verifyFullReuseAuthority(
  prior: PriorPair,
  indexPath: string,
  vectorPath: string,
  snapshots: ReadonlyMap<string, PlannedSourceSnapshot>,
  signal?: AbortSignal,
  hooks?: FootageIndexerTestHooks,
) {
  abortIfRequested(signal);
  await recheckPriorPair(prior, indexPath, vectorPath, signal);
  abortIfRequested(signal);
  await verifyPlannedSourceMetadata(snapshots, hooks?.afterFirstFullReuseSourceMetadataRecheck);
  abortIfRequested(signal);
  sealFullReuseAuthority(prior, indexPath, vectorPath, snapshots, signal, hooks);
}

function modelIdentity(handshake: CutFootageSidecarStart["expectedHandshake"]): FootageBackendIdentity {
  const required = ["format", "version", "protocolVersion", "provider", "model", "revision", "dimensions", "normalization", "modalities", "hardware", "adapterSha256", "selfTestSha256"];
  if (!handshake || typeof handshake !== "object" || Array.isArray(handshake)
    || Object.keys(handshake).length !== required.length || required.some((key) => !Object.hasOwn(handshake, key))
    || handshake.format !== "cut-footage-sidecar-handshake" || handshake.version !== 1 || handshake.protocolVersion !== 1
    || handshake.normalization !== "l2" || handshake.hardware !== "cpu"
    || !Array.isArray(handshake.modalities) || handshake.modalities.length !== 2 || handshake.modalities[0] !== "image" || handshake.modalities[1] !== "text"
    || ![handshake.provider, handshake.model, handshake.revision].every((value) => typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= 256 && !/[\u0000-\u001f\u007f]/u.test(value))
    || !Number.isSafeInteger(handshake.dimensions) || handshake.dimensions < 1 || handshake.dimensions > 65_536
    || !shaPattern.test(handshake.adapterSha256) || !shaPattern.test(handshake.selfTestSha256)) {
    footageFail("CUT_FOOTAGE_MODEL_MISMATCH", "$backend", "the verified sidecar handshake is malformed.");
  }
  return Object.freeze({
    protocolVersion: 1,
    provider: handshake.provider,
    model: `${handshake.model}@${handshake.revision}+adapter.${handshake.adapterSha256}`,
    dimensions: handshake.dimensions,
    normalization: "l2",
  });
}

function sameBackend(left: FootageBackendIdentity, right: FootageBackendIdentity) {
  return stableJsonStringify(left) === stableJsonStringify(right);
}

function checkedDimensions(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 65_536) {
    footageFail("CUT_FOOTAGE_BACKEND_PROTOCOL", "$vector.dimensions", "must be one bounded positive embedding dimension.");
  }
  return Number(value);
}

function checkedChunkIds(values: readonly string[]) {
  if (!Array.isArray(values) || values.length < 1 || values.length > cutFootageLimits.maximumChunks) {
    footageFail("CUT_FOOTAGE_BACKEND_PROTOCOL", "$vector.chunkIds", "must be one non-empty bounded chunk-id array.");
  }
  const result = values.map((value) => {
    if (typeof value !== "string" || !identifierPattern.test(value)) {
      footageFail("CUT_FOOTAGE_BACKEND_PROTOCOL", "$vector.chunkIds", "contains one malformed chunk id.");
    }
    return value;
  });
  if (new Set(result).size !== result.length) footageFail("CUT_FOOTAGE_BACKEND_PROTOCOL", "$vector.chunkIds", "must not contain duplicate chunk ids.");
  return Object.freeze([...result].sort(bytewise));
}

function decodeChunkId(bytes: Buffer) {
  let value: string;
  try { value = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return footageFail("CUT_FOOTAGE_BACKEND_PROTOCOL", "$vector.records", "contains invalid UTF-8 in one chunk id."); }
  if (!identifierPattern.test(value) || !Buffer.from(value, "utf8").equals(bytes)) {
    footageFail("CUT_FOOTAGE_BACKEND_PROTOCOL", "$vector.records", "contains one malformed chunk id.");
  }
  return value;
}

/** Strictly decodes the bounded sidecar-owned CUTFVEC1 binary format. */
export function parseCutFootageVectorArtifact(
  input: Uint8Array,
  expected: Readonly<{ dimensions: number; chunkIds: readonly string[] }>,
): CutFootageVectorArtifact {
  if (!(input instanceof Uint8Array) || input.byteLength < vectorHeaderBytes || input.byteLength > maximumVectorBytes) {
    footageFail("CUT_FOOTAGE_BACKEND_PROTOCOL", "$vector", "must be one bounded CUTFVEC1 artifact.");
  }
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (!bytes.subarray(0, 8).equals(vectorMagic)) footageFail("CUT_FOOTAGE_BACKEND_PROTOCOL", "$vector.magic", "must be CUTFVEC1.");
  const dimensions = bytes.readUInt32LE(8), count = bytes.readUInt32LE(12);
  const expectedDimensions = checkedDimensions(expected.dimensions), expectedIds = checkedChunkIds(expected.chunkIds);
  if (dimensions !== expectedDimensions || count !== expectedIds.length || count > cutFootageLimits.maximumChunks) {
    footageFail("CUT_FOOTAGE_BACKEND_PROTOCOL", "$vector.header", "does not match the expected dimensions and chunk count.");
  }
  const planSha256 = bytes.subarray(16, 48).toString("hex");
  if (!shaPattern.test(planSha256)) footageFail("CUT_FOOTAGE_BACKEND_PROTOCOL", "$vector.planSha256", "must bind one SHA-256 digest.");
  const records: CutFootageVectorRecord[] = [];
  let offset = vectorHeaderBytes, previous = "";
  for (let index = 0; index < count; index += 1) {
    if (offset + 2 > bytes.byteLength) footageFail("CUT_FOOTAGE_BACKEND_PROTOCOL", "$vector.records", "is truncated before a chunk id.");
    const idBytes = bytes.readUInt16LE(offset); offset += 2;
    const vectorBytes = dimensions * 4;
    if (idBytes < 1 || offset + idBytes + vectorBytes > bytes.byteLength) {
      footageFail("CUT_FOOTAGE_BACKEND_PROTOCOL", "$vector.records", "contains one truncated record.");
    }
    const chunkId = decodeChunkId(bytes.subarray(offset, offset + idBytes)); offset += idBytes;
    if ((index > 0 && bytewise(previous, chunkId) >= 0) || chunkId !== expectedIds[index]) {
      footageFail("CUT_FOOTAGE_BACKEND_PROTOCOL", "$vector.records", "must be byte-sorted, unique, and exactly match the expected chunk ids.");
    }
    previous = chunkId;
    const vector = new Float32Array(dimensions);
    let squaredNorm = 0;
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
      const value = bytes.readFloatLE(offset); offset += 4;
      if (!Number.isFinite(value) || Object.is(value, -0)) footageFail("CUT_FOOTAGE_BACKEND_PROTOCOL", "$vector.records", "contains one non-canonical float32 value.");
      vector[dimension] = value;
      squaredNorm += value * value;
    }
    if (!Number.isFinite(squaredNorm) || Math.abs(Math.sqrt(squaredNorm) - 1) > unitVectorTolerance) {
      footageFail("CUT_FOOTAGE_BACKEND_PROTOCOL", "$vector.records", `contains one vector outside the ${unitVectorTolerance} unit-norm tolerance.`);
    }
    records.push(Object.freeze({ chunkId, vector }));
  }
  if (offset !== bytes.byteLength) footageFail("CUT_FOOTAGE_BACKEND_PROTOCOL", "$vector", "contains trailing bytes.");
  return Object.freeze({ dimensions, planSha256, records: Object.freeze(records) });
}

function encodeRecords(dimensions: number, planSha256: string, records: readonly MergeRecord[]) {
  const safeDimensions = checkedDimensions(dimensions), sorted = [...records].sort((left, right) => bytewise(left.chunkId, right.chunkId));
  if (!shaPattern.test(planSha256) || sorted.length < 1 || sorted.length > cutFootageLimits.maximumChunks || new Set(sorted.map((record) => record.chunkId)).size !== sorted.length) {
    footageFail("CUT_FOOTAGE_BACKEND_PROTOCOL", "$vector", "cannot encode malformed vector evidence.");
  }
  let bytes = vectorHeaderBytes;
  for (const record of sorted) {
    const idBytes = Buffer.byteLength(record.chunkId, "utf8");
    if (!identifierPattern.test(record.chunkId) || idBytes > 0xffff || !(record.vector instanceof Float32Array) || record.vector.length !== safeDimensions) {
      footageFail("CUT_FOOTAGE_BACKEND_PROTOCOL", "$vector.records", "cannot encode one malformed vector record.");
    }
    bytes += 2 + idBytes + safeDimensions * 4;
    if (bytes > maximumVectorBytes) footageFail("CUT_FOOTAGE_BACKEND_PROTOCOL", "$vector", "would exceed the vector artifact byte bound.");
  }
  const output = Buffer.allocUnsafe(bytes);
  vectorMagic.copy(output, 0); output.writeUInt32LE(safeDimensions, 8); output.writeUInt32LE(sorted.length, 12);
  Buffer.from(planSha256, "hex").copy(output, 16);
  let offset = vectorHeaderBytes;
  for (const record of sorted) {
    const id = Buffer.from(record.chunkId, "utf8"); output.writeUInt16LE(id.byteLength, offset); offset += 2; id.copy(output, offset); offset += id.byteLength;
    let squaredNorm = 0;
    for (let dimension = 0; dimension < safeDimensions; dimension += 1) {
      const original = record.vector[dimension]!;
      if (!Number.isFinite(original)) footageFail("CUT_FOOTAGE_BACKEND_PROTOCOL", "$vector.records", "cannot encode one non-finite vector value.");
      const value = record.canonicalizeZero && original === 0 ? 0 : original;
      output.writeFloatLE(value, offset); offset += 4; squaredNorm += value * value;
    }
    if (!Number.isFinite(squaredNorm) || Math.abs(Math.sqrt(squaredNorm) - 1) > unitVectorTolerance) {
      footageFail("CUT_FOOTAGE_BACKEND_PROTOCOL", "$vector.records", "cannot encode one non-unit vector.");
    }
  }
  return output;
}

/** Canonically encodes sorted records and rewrites every signed zero to positive zero. */
export function encodeCutFootageVectorArtifact(artifact: CutFootageVectorArtifact): Uint8Array {
  return encodeRecords(artifact.dimensions, artifact.planSha256, artifact.records.map((record) => ({ ...record, canonicalizeZero: true })));
}

async function readRegularFile(path: string, maximumBytes: number, signal?: AbortSignal): Promise<Readonly<{ bytes: Buffer; evidence: FileEvidence }>> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    abortIfRequested(signal);
    if (typeof fsConstants.O_NOFOLLOW !== "number") footageFail("CUT_FOOTAGE_INDEX_STALE", "$artifact", "the host cannot perform a no-follow artifact read.");
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    abortIfRequested(signal);
    const before = await handle.stat({ bigint: true });
    abortIfRequested(signal);
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maximumBytes) || before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      footageFail("CUT_FOOTAGE_INDEX_STALE", "$artifact", "must be one bounded regular no-follow file.");
    }
    const byteLength = Number(before.size), bytes = Buffer.allocUnsafe(byteLength), digest = createHash("sha256");
    let position = 0;
    while (position < byteLength) {
      abortIfRequested(signal);
      const length = Math.min(sourceHashBufferBytes, byteLength - position);
      const { bytesRead } = await handle.read(bytes, position, length, position);
      abortIfRequested(signal);
      if (bytesRead < 1) footageFail("CUT_FOOTAGE_INDEX_STALE", "$artifact", "changed during its bounded read.");
      digest.update(bytes.subarray(position, position + bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    abortIfRequested(signal);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || bytes.byteLength !== Number(before.size)) {
      footageFail("CUT_FOOTAGE_INDEX_STALE", "$artifact", "changed during its bounded read.");
    }
    return Object.freeze({
      bytes,
      evidence: Object.freeze({ bytes: bytes.byteLength, sha256: digest.digest("hex"), dev: before.dev, ino: before.ino, size: before.size, mtimeNs: before.mtimeNs, ctimeNs: before.ctimeNs }),
    });
  } catch (error) {
    if (error instanceof CutFootageError) throw error;
    return footageFail("CUT_FOOTAGE_INDEX_STALE", "$artifact", "could not be read as a bounded regular no-follow file.");
  } finally { await handle?.close().catch(() => undefined); }
}

async function verifyExactPairBytes(
  expected: Readonly<{ indexBytes: Buffer; vectorBytes: Buffer }>,
  indexPath: string,
  vectorPath: string,
  signal?: AbortSignal,
): Promise<Readonly<{ index: FileEvidence; vector: FileEvidence }>> {
  abortIfRequested(signal);
  const [index, vector] = await Promise.all([
    readRegularFile(indexPath, cutFootageLimits.maximumBytes, signal),
    readRegularFile(vectorPath, maximumVectorBytes, signal),
  ]);
  abortIfRequested(signal);
  if (!index.bytes.equals(expected.indexBytes) || !vector.bytes.equals(expected.vectorBytes)) {
    footageFail("CUT_FOOTAGE_INDEX_STALE", "$output", "the footage index/vector pair does not retain its exact expected bytes and file authority.");
  }
  return Object.freeze({ index: index.evidence, vector: vector.evidence });
}

/** Loads, hashes, and independently parses the vector artifact bound by an index. */
export async function loadCutFootageVectorArtifact(
  projectRoot: string,
  index: CutFootageIndex,
  control: Readonly<{ signal?: AbortSignal }> = {},
): Promise<CutFootageVectorArtifact> {
  abortIfRequested(control.signal);
  const path = await resolveProjectFile(projectRoot, index.vectorArtifact.locator);
  abortIfRequested(control.signal);
  const loaded = await readRegularFile(path, maximumVectorBytes, control.signal);
  if (loaded.evidence.bytes !== index.vectorArtifact.bytes || loaded.evidence.sha256 !== index.vectorArtifact.sha256) {
    footageFail("CUT_FOOTAGE_INDEX_STALE", "$.vectorArtifact", "does not match the index byte length and SHA-256.");
  }
  abortIfRequested(control.signal);
  const artifact = parseCutFootageVectorArtifact(loaded.bytes, { dimensions: index.backend.dimensions, chunkIds: index.chunks.map((chunk) => chunk.id) });
  abortIfRequested(control.signal);
  return artifact;
}

function vectorLocatorFor(indexLocator: string) {
  const safe = validateProjectLocator(indexLocator, "footage index output locator");
  if (!safe.endsWith(".json") || basename(safe) === ".json") {
    footageFail("CUT_FOOTAGE_BACKEND_PROTOCOL", "$outputLocator", "must name one project-relative .json file.");
  }
  return `${safe.slice(0, -5)}.vectors`;
}

async function optionalMetadata(path: string) {
  try { return await lstat(path); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function cleanupStagingDirectory(path: string, expected: DirectoryEvidence) {
  let current: Awaited<ReturnType<typeof lstat>>;
  try { current = await lstat(path, { bigint: true }); }
  catch (error) {
    if (systemErrorCode(error) === "ENOENT") return;
    return;
  }
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== expected.dev || current.ino !== expected.ino) return;
  await rm(path, { recursive: true, force: true }).catch(() => undefined);
}

async function loadPriorPair(
  rootLocator: string,
  vectorLocator: string,
  indexPath: string,
  vectorPath: string,
  signal?: AbortSignal,
): Promise<PriorPair | undefined> {
  abortIfRequested(signal);
  const [indexMetadata, vectorMetadata] = await Promise.all([optionalMetadata(indexPath), optionalMetadata(vectorPath)]);
  abortIfRequested(signal);
  if (!indexMetadata && !vectorMetadata) return undefined;
  if (!indexMetadata || !vectorMetadata || indexMetadata.isSymbolicLink() || vectorMetadata.isSymbolicLink()
    || !indexMetadata.isFile() || !vectorMetadata.isFile()) {
    footageFail("CUT_FOOTAGE_INDEX_STALE", "$output", "the existing footage index/vector destination is not one complete regular no-follow pair.");
  }
  const [indexLoaded, vectorLoaded] = await Promise.all([
    readRegularFile(indexPath, cutFootageLimits.maximumBytes, signal),
    readRegularFile(vectorPath, maximumVectorBytes, signal),
  ]);
  let index: CutFootageIndex;
  try { index = parseCutFootageIndex(indexLoaded.bytes); }
  catch (error) {
    if (error instanceof CutFootageError) throw error;
    return footageFail("CUT_FOOTAGE_INDEX_STALE", "$output", "the existing footage index is invalid.");
  }
  if (index.root !== rootLocator || index.vectorArtifact.locator !== vectorLocator || index.vectorArtifact.bytes !== vectorLoaded.evidence.bytes
    || index.vectorArtifact.sha256 !== vectorLoaded.evidence.sha256) {
    footageFail("CUT_FOOTAGE_INDEX_STALE", "$output", "the existing footage pair does not bind this root and canonical vector destination.");
  }
  const vector = parseCutFootageVectorArtifact(vectorLoaded.bytes, { dimensions: index.backend.dimensions, chunkIds: index.chunks.map((chunk) => chunk.id) });
  return Object.freeze({
    index, vector, indexBytes: indexLoaded.bytes, vectorBytes: vectorLoaded.bytes,
    indexEvidence: indexLoaded.evidence, vectorEvidence: vectorLoaded.evidence,
  });
}

function sameFileEvidence(left: FileEvidence, right: FileEvidence) {
  return left.bytes === right.bytes && left.sha256 === right.sha256 && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function samePromotedFileOrigin(left: FileEvidence, right: FileEvidence) {
  return left.bytes === right.bytes && left.sha256 === right.sha256 && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeNs === right.mtimeNs;
}

async function recheckPriorPair(prior: PriorPair | undefined, indexPath: string, vectorPath: string, signal?: AbortSignal) {
  abortIfRequested(signal);
  if (!prior) {
    const [indexMetadata, vectorMetadata] = await Promise.all([optionalMetadata(indexPath), optionalMetadata(vectorPath)]);
    abortIfRequested(signal);
    if (indexMetadata || vectorMetadata) footageFail("CUT_FOOTAGE_INDEX_STALE", "$output", "a footage destination appeared during indexing.");
    return;
  }
  const [index, vector] = await Promise.all([
    readRegularFile(indexPath, cutFootageLimits.maximumBytes, signal),
    readRegularFile(vectorPath, maximumVectorBytes, signal),
  ]);
  if (!sameFileEvidence(index.evidence, prior.indexEvidence) || !sameFileEvidence(vector.evidence, prior.vectorEvidence)) {
    footageFail("CUT_FOOTAGE_INDEX_STALE", "$output", "the verified prior footage pair changed during indexing.");
  }
}

function matchesPriorDestination(snapshot: StagedFileDestinationSnapshot, evidence: FileEvidence) {
  return snapshot.state === "present" && snapshot.kind === "file"
    && snapshot.dev === evidence.dev && snapshot.ino === evidence.ino
    && snapshot.size === evidence.size && snapshot.mtimeNs === evidence.mtimeNs && snapshot.ctimeNs === evidence.ctimeNs;
}

async function publicationDestinationSnapshots(prior: PriorPair | undefined, indexPath: string, vectorPath: string) {
  const [index, vector] = await Promise.all([
    snapshotStagedFileDestination(indexPath),
    snapshotStagedFileDestination(vectorPath),
  ]);
  if (prior
    ? !matchesPriorDestination(index, prior.indexEvidence) || !matchesPriorDestination(vector, prior.vectorEvidence)
    : index.state !== "absent" || vector.state !== "absent") {
    footageFail("CUT_FOOTAGE_INDEX_STALE", "$output", "the verified footage destinations changed before publication admission.");
  }
  return Object.freeze({ index, vector });
}

function rationalExpression(value: Rational) {
  return `${value.numerator}/${value.denominator}`;
}

function sampleKey(locator: string, streamIndex: number, time: Rational) {
  return `${locator}\u0000${streamIndex}\u0000${time.numerator}/${time.denominator}`;
}

function compareTime(left: Rational, right: Rational) {
  return compareRational(left, right);
}

async function inspectFrame(path: string, signal?: AbortSignal) {
  const loaded = await readRegularFile(path, maximumFrameBytes, signal);
  return Object.freeze({ path, bytes: loaded.evidence.bytes, sha256: loaded.evidence.sha256 });
}

function ffmpegFrameArguments(
  sourcePath: string,
  streamIndex: number,
  points: readonly Rational[],
  grid: Rational,
  outputPattern: string,
) {
  const selections = points.map((point) => {
    const end = addRational(point, grid);
    return `gte(t\\,${rationalExpression(point)})*lt(t\\,${rationalExpression(end)})`;
  });
  const inputs = selections.map((_selection, index) => `[window-${String(index).padStart(3, "0")}]`).join("");
  const outputs = selections.map((_selection, index) => `[sample-${String(index).padStart(3, "0")}]`).join("");
  const branches = selections.map((selection, index) => {
    const suffix = String(index).padStart(3, "0");
    return `[window-${suffix}]select=${selection},trim=end_frame=1,setpts=PTS-STARTPTS[sample-${suffix}]`;
  }).join(";");
  const filter = `setpts=PTS-STARTPTS,split=${points.length}${inputs};${branches};${outputs}concat=n=${points.length}:v=1:a=0,setpts=N*(${rationalExpression(grid)})/TB,scale=224:224:force_original_aspect_ratio=decrease:flags=lanczos,pad=224:224:(ow-iw)/2:(oh-ih)/2:black,format=rgb24`;
  return Object.freeze([
    "-nostdin", "-v", "error", "-i", sourcePath,
    "-map", `0:${streamIndex}`, "-an", "-sn", "-dn",
    "-vf", filter, "-frames:v", String(points.length), "-fps_mode", "vfr",
    "-c:v", "png", "-pix_fmt", "rgb24", "-start_number", "0", "-n", outputPattern,
  ]);
}

async function extractChangedFrames(options: Readonly<{
  projectRoot: string;
  plan: FootagePlan;
  changedChunkIds: readonly string[];
  stagingRoot: string;
  sources: ReadonlyMap<string, PlannedSourceSnapshot>;
  ffmpegExecutable?: string;
  signal?: AbortSignal;
  hooks?: FootageIndexerTestHooks;
}>): Promise<ReadonlyMap<string, readonly SampleFrame[]>> {
  const changed = new Set(options.changedChunkIds), changedChunks = options.plan.chunks.filter((chunk) => changed.has(chunk.id));
  if (!changedChunks.length) return new Map();
  const framesRoot = resolve(options.stagingRoot, "frames"); await mkdir(framesRoot, { mode: 0o700 });
  const authority = await bindReferenceNativeMediaTool("ffmpeg", options.ffmpegExecutable);
  const collector = createReferenceNativeProcessCollector(authority);
  const groups = new Map<string, { source: FootagePlan["sources"][number]; points: Rational[] }>();
  for (const chunk of changedChunks) {
    const source = options.plan.sources.find((candidate) => candidate.source.locator === chunk.sourceLocator && candidate.selectedStreamIndex === chunk.streamIndex);
    if (!source) footageFail("CUT_FOOTAGE_INDEX_STALE", "$chunks", "one planned chunk lost its normalized source authority.");
    const key = `${chunk.sourceLocator}\u0000${chunk.streamIndex}`, group = groups.get(key) ?? { source, points: [] };
    group.points.push(...chunk.samplePoints); groups.set(key, group);
  }
  const frames = new Map<string, SampleFrame>();
  let totalFrameBytes = 0, ordinal = 0;
  let primaryError: unknown;
  try {
    for (const group of [...groups.values()].sort((left, right) => bytewise(left.source.source.locator, right.source.source.locator) || left.source.selectedStreamIndex - right.source.selectedStreamIndex)) {
      abortIfRequested(options.signal);
      const unique = [...new Map(group.points.map((point) => [`${point.numerator}/${point.denominator}`, point])).values()].sort(compareTime);
      const source = options.sources.get(group.source.source.locator);
      if (!source) footageFail("CUT_FOOTAGE_INDEX_STALE", group.source.source.locator, "lost its pinned source snapshot before frame extraction.");
      const sourceHandle = await openVerifiedSource(source, options.signal);
      try {
        const sourcePath = "/dev/fd/3";
        for (let start = 0; start < unique.length; start += maximumSamplesPerFfmpegBatch) {
          abortIfRequested(options.signal);
          const batch = unique.slice(start, start + maximumSamplesPerFfmpegBatch);
          const batchRoot = resolve(framesRoot, `batch-${String(ordinal).padStart(6, "0")}`);
          await mkdir(batchRoot, { mode: 0o700 });
          const outputPattern = resolve(batchRoot, "%06d.png");
          const outputPaths = batch.map((_point, index) => resolve(batchRoot, `${String(index).padStart(6, "0")}.png`));
          const args = ffmpegFrameArguments(sourcePath, group.source.selectedStreamIndex, batch, group.source.grid, outputPattern);
          const execution: ReferenceMediaNativeProcessExecution = Object.freeze({
            authority, collector,
            context: Object.freeze({
              ordinal, operation: "footage-frame-sample", resourceId: group.source.source.locator,
              resourceSha256: group.source.source.sha256, resourceBytes: group.source.source.bytes,
              variant: "master", streamIndex: group.source.selectedStreamIndex,
            }),
          });
          const request = Object.freeze({
            executable: authority.executablePath, arguments: args, sourceLocator: group.source.source.locator,
            streamIndex: group.source.selectedStreamIndex, samplePoints: Object.freeze(batch), outputPaths: Object.freeze(outputPaths), execution,
          });
          try {
            if (options.hooks?.runFrameBatch) await options.hooks.runFrameBatch(request);
            else await runBoundReferenceFfmpeg(
              authority.executablePath,
              [...args],
              10 * 60_000,
              { stderrBytes: 256 * 1024, totalBytes: 256 * 1024 },
              execution,
              { ...(options.signal === undefined ? {} : { signal: options.signal }), inheritedFileDescriptors: [sourceHandle.fd], terminateProcessTree: true, terminationGraceMs: 250 },
            );
          } catch {
            abortIfRequested(options.signal);
            footageFail("CUT_FOOTAGE_UNSUPPORTED_MEDIA", group.source.source.locator, "could not produce the exact deterministic frame sample batch.");
          }
          await verifyOpenSource(source, sourceHandle, options.signal);
          const names = (await readdir(batchRoot)).sort(bytewise), expectedNames = outputPaths.map((path) => basename(path));
          if (names.length !== expectedNames.length || names.some((name, index) => name !== expectedNames[index])) {
            footageFail("CUT_FOOTAGE_UNSUPPORTED_MEDIA", group.source.source.locator, "did not produce exactly one numbered PNG for every requested frame window.");
          }
          for (const [index, point] of batch.entries()) {
            const evidence = await inspectFrame(outputPaths[index]!, options.signal);
            totalFrameBytes += evidence.bytes;
            if (totalFrameBytes > maximumStagedFrameBytes) footageFail("CUT_FOOTAGE_UNSUPPORTED_MEDIA", "$frames", "exceeded the staged frame byte budget.");
            frames.set(sampleKey(group.source.source.locator, group.source.selectedStreamIndex, point), evidence);
          }
          ordinal += 1;
        }
      } finally { await sourceHandle.close().catch(() => undefined); }
    }
  } catch (error) { primaryError = error; }
  const lifecycleChecks = await Promise.allSettled([collector.seal(), authority.verify()]);
  if (primaryError !== undefined) throw primaryError;
  if (lifecycleChecks.some((check) => check.status === "rejected")) {
    footageFail("CUT_FOOTAGE_UNSUPPORTED_MEDIA", "$frames", "the bound FFmpeg frame-sampling lifecycle could not be verified.");
  }
  const chunkFrames = new Map<string, readonly SampleFrame[]>();
  for (const chunk of changedChunks) {
    const records = chunk.samplePoints.map((point) => frames.get(sampleKey(chunk.sourceLocator, chunk.streamIndex, point)));
    if (records.some((record) => !record)) footageFail("CUT_FOOTAGE_UNSUPPORTED_MEDIA", chunk.sourceLocator, "one planned frame sample is missing.");
    const sorted = records as SampleFrame[]; sorted.sort((left, right) => bytewise(left.path, right.path));
    if (!sorted.length || new Set(sorted.map((record) => record.path)).size !== sorted.length) {
      footageFail("CUT_FOOTAGE_BACKEND_PROTOCOL", "$plan.frames", "must contain non-empty duplicate-free frame records.");
    }
    chunkFrames.set(chunk.id, Object.freeze(sorted));
  }
  return chunkFrames;
}

function publicChunk(chunk: FootagePlannedChunk): CutFootageIndex["chunks"][number] {
  return Object.freeze({
    id: chunk.id, sourceLocator: chunk.sourceLocator, sourceSha256: chunk.sourceSha256,
    streamIndex: chunk.streamIndex, range: chunk.range,
  });
}

function signedIndex(options: Readonly<{
  rootLocator: string;
  plan: FootagePlan;
  backend: FootageBackendIdentity;
  vectorLocator: string;
  vectorBytes: Buffer;
}>): CutFootageIndex {
  const body = Object.freeze({
    format: "cut-footage-index" as const, version: 1 as const, root: options.rootLocator,
    sources: Object.freeze(options.plan.sources.map((source) => source.source)),
    chunkPolicy: defaultFootageChunkPolicy,
    chunks: Object.freeze(options.plan.chunks.map(publicChunk)),
    backend: options.backend,
    vectorArtifact: Object.freeze({ locator: options.vectorLocator, bytes: options.vectorBytes.byteLength, sha256: sha256(options.vectorBytes) }),
    creation: Object.freeze({ cutVersion: cutProductVersion, backendProtocolVersion: 1 as const }),
  });
  return parseCutFootageIndex(`${stableJsonStringify({ ...body, indexSha256: sha256(stableJsonStringify(body)) })}\n`);
}

function deterministicMergePlanSha(options: Readonly<{
  backend: FootageBackendIdentity;
  plan: FootagePlan;
  priorSha256?: string;
  reusedChunkIds: readonly string[];
  deltaSha256?: string;
  indexedChunkIds: readonly string[];
}>) {
  return sha256(stableJsonStringify(Object.freeze({
    format: "cut-footage-vector-merge-plan", version: 1,
    backend: options.backend,
    sources: options.plan.sources.map((source) => source.source),
    chunks: options.plan.chunks.map(publicChunk),
    prior: options.priorSha256 === undefined ? null : { sha256: options.priorSha256, chunkIds: options.reusedChunkIds },
    delta: options.deltaSha256 === undefined ? null : { sha256: options.deltaSha256, chunkIds: options.indexedChunkIds },
  })));
}

function semanticDeltaSha(artifact: CutFootageVectorArtifact) {
  // The sidecar header binds an ephemeral plan containing absolute staging
  // paths. Re-encode only admitted vector semantics under a fixed domain hash
  // before those bytes enter the persistent merge-plan identity.
  return sha256(encodeRecords(
    artifact.dimensions,
    sha256("cut-footage-semantic-delta-v1"),
    artifact.records.map((record) => Object.freeze({ ...record, canonicalizeZero: true })),
  ));
}

async function indexDelta(options: Readonly<{
  backend: CutFootageIndexBackend;
  plan: FootagePlan;
  changedChunkIds: readonly string[];
  frames: ReadonlyMap<string, readonly SampleFrame[]>;
  stagingRoot: string;
  signal?: AbortSignal;
}>): Promise<Readonly<{ response: CutFootageSidecarIndexResult; artifact: CutFootageVectorArtifact; bytes: Buffer }>> {
  const chunks = [...options.changedChunkIds].sort(bytewise).map((id) => {
    const frames = options.frames.get(id);
    if (!frames?.length) footageFail("CUT_FOOTAGE_BACKEND_PROTOCOL", "$plan.frames", "one changed chunk has no staged frames.");
    return Object.freeze({ id, frames: Object.freeze(frames.map((frame) => Object.freeze({ path: frame.path, bytes: frame.bytes, sha256: frame.sha256 }))) });
  });
  const plan = Object.freeze({
    format: "cut-footage-sidecar-index-plan" as const, version: 1 as const,
    dimensions: options.backend.sidecar.expectedHandshake.dimensions, chunks: Object.freeze(chunks),
  });
  const planBytes = Buffer.from(`${stableJsonStringify(plan)}\n`, "utf8"), planPath = resolve(options.stagingRoot, "sidecar-plan.json");
  const artifactPath = resolve(options.stagingRoot, "sidecar-delta.vectors");
  await writeFile(planPath, planBytes, { flag: "wx", mode: 0o600 });
  const planSha256 = sha256(planBytes);
  let session: CutFootageSidecarSession | undefined, response: CutFootageSidecarIndexResult | undefined, operationError: unknown, closeError: unknown;
  try {
    session = await startCutFootageSidecar({ ...options.backend.sidecar, ...(options.signal === undefined ? {} : { signal: options.signal }) });
    response = await session.index({ plan: { path: planPath, bytes: planBytes.byteLength, sha256: planSha256 }, artifactPath });
  } catch (error) { operationError = error; }
  finally {
    if (session) {
      try { await session.close(); }
      catch (error) { closeError = error; }
    }
  }
  if (operationError !== undefined) throw operationError;
  if (closeError !== undefined) throw closeError;
  if (!response) footageFail("CUT_FOOTAGE_BACKEND_PROTOCOL", "$sidecar", "did not return vector artifact evidence.");
  const loaded = await readRegularFile(artifactPath, maximumVectorBytes, options.signal);
  if (loaded.evidence.bytes !== response.bytes || loaded.evidence.sha256 !== response.sha256
    || response.recordCount !== options.changedChunkIds.length || response.dimensions !== options.backend.sidecar.expectedHandshake.dimensions) {
    footageFail("CUT_FOOTAGE_BACKEND_PROTOCOL", "$sidecar.artifact", "does not match the sidecar response evidence.");
  }
  const artifact = parseCutFootageVectorArtifact(loaded.bytes, { dimensions: response.dimensions, chunkIds: options.changedChunkIds });
  if (artifact.planSha256 !== planSha256) footageFail("CUT_FOOTAGE_BACKEND_PROTOCOL", "$sidecar.artifact", "does not bind the exact staged indexing plan.");
  return Object.freeze({ response, artifact, bytes: loaded.bytes });
}

function recordsById(artifact: CutFootageVectorArtifact) {
  return new Map(artifact.records.map((record) => [record.chunkId, record]));
}

function result(index: CutFootageIndex, indexLocator: string, vectorLocator: string, reusedChunkIds: readonly string[], indexedChunkIds: readonly string[]): CutFootageIndexResult {
  return Object.freeze({ index, indexLocator, vectorLocator, reusedChunkIds: Object.freeze([...reusedChunkIds]), indexedChunkIds: Object.freeze([...indexedChunkIds]) });
}

type IndexProjectFootageOptions = Readonly<{
  projectRoot: string;
  rootLocator: string;
  outputLocator: string;
  backend: CutFootageIndexBackend;
  discoveryLimits?: Partial<FootageDiscoveryLimits>;
  ffmpegExecutable?: string;
  signal?: AbortSignal;
  __testHooks?: FootageIndexerTestHooks;
}>;

async function indexProjectFootageOperation(options: IndexProjectFootageOptions): Promise<CutFootageIndexResult> {
  if (!options || typeof options !== "object" || Array.isArray(options)) footageFail("CUT_FOOTAGE_BACKEND_PROTOCOL", "$", "must be one footage indexing request.");
  abortIfRequested(options.signal);
  const rootLocator = validateProjectLocator(options.rootLocator, "footage root locator");
  const indexLocator = validateProjectLocator(options.outputLocator, "footage index output locator");
  const vectorLocator = vectorLocatorFor(indexLocator);
  const handshake = options.backend?.sidecar?.expectedHandshake;
  if (!handshake) footageFail("CUT_FOOTAGE_BACKEND_MISSING", "$backend", "one verified local footage backend is required.");
  const backend = modelIdentity(handshake);
  if (!options.backend.identity || !sameBackend(options.backend.identity, backend)) {
    footageFail("CUT_FOOTAGE_MODEL_MISMATCH", "$backend", "the verified backend identity does not match its sidecar handshake.");
  }
  const canonicalProjectRoot = await realpath(resolve(options.projectRoot));
  const parentLocator = dirname(indexLocator).split(sep).join("/");
  const outputParent = parentLocator === "." ? canonicalProjectRoot : await ensureProjectWriteDirectory(canonicalProjectRoot, parentLocator);
  const indexPath = resolve(outputParent, basename(indexLocator)), vectorPath = resolve(outputParent, basename(vectorLocator));
  const prior = await loadPriorPair(rootLocator, vectorLocator, indexPath, vectorPath, options.signal);
  const locators = await discoverProjectFootage(
    canonicalProjectRoot,
    rootLocator,
    options.discoveryLimits ?? {},
    options.signal === undefined ? {} : { signal: options.signal },
  );
  if (!locators.length) footageFail("CUT_FOOTAGE_UNSUPPORTED_MEDIA", rootLocator, "contains no MP4 or MOV footage.");
  const plan = await planFootageSources({
    projectRoot: canonicalProjectRoot,
    locators,
    backend,
    priorIndex: prior?.index,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const sourceSnapshots = await capturePlannedSourceSnapshots(canonicalProjectRoot, plan);
  const reusable = new Set(plan.reusableChunkIds);
  const reusedChunkIds = plan.chunks.map((chunk) => chunk.id).filter((id) => reusable.has(id)).sort(bytewise);
  const indexedChunkIds = plan.chunks.map((chunk) => chunk.id).filter((id) => !reusable.has(id)).sort(bytewise);
  if (reusedChunkIds.length && !prior) footageFail("CUT_FOOTAGE_INDEX_STALE", "$reuse", "planned reuse without one verified prior vector artifact.");
  const stagingRoot = await mkdtemp(resolve(outputParent, `.${basename(indexPath)}.cut-footage-staging-${process.pid}-${randomUUID()}-`));
  const stagingMetadata = await lstat(stagingRoot, { bigint: true });
  if (!stagingMetadata.isDirectory() || stagingMetadata.isSymbolicLink()) {
    footageFail("CUT_FOOTAGE_PUBLISH", "$output", "the private footage staging directory could not be verified.");
  }
  const stagingEvidence = Object.freeze({ dev: stagingMetadata.dev, ino: stagingMetadata.ino });
  try {
    const frames = await extractChangedFrames({
      projectRoot: canonicalProjectRoot, plan, changedChunkIds: indexedChunkIds, stagingRoot, sources: sourceSnapshots,
      ...(options.ffmpegExecutable === undefined ? {} : { ffmpegExecutable: options.ffmpegExecutable }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.__testHooks === undefined ? {} : { hooks: options.__testHooks }),
    });
    await options.__testHooks?.afterFrames?.(plan);
    abortIfRequested(options.signal);
    const delta = indexedChunkIds.length ? await indexDelta({ backend: options.backend, plan, changedChunkIds: indexedChunkIds, frames, stagingRoot, signal: options.signal }) : undefined;
    let vectorBytes: Buffer;
    if (!indexedChunkIds.length) {
      if (!prior || reusedChunkIds.length !== plan.chunks.length) footageFail("CUT_FOOTAGE_INDEX_STALE", "$reuse", "a complete reuse plan has no exact prior vector artifact.");
      vectorBytes = Buffer.from(prior.vectorBytes);
    } else {
      const priorRecords = prior ? recordsById(prior.vector) : new Map<string, CutFootageVectorRecord>();
      const deltaRecords = recordsById(delta!.artifact);
      const records: MergeRecord[] = plan.chunks.map((chunk) => {
        const reused = reusable.has(chunk.id), record = reused ? priorRecords.get(chunk.id) : deltaRecords.get(chunk.id);
        if (!record) footageFail("CUT_FOOTAGE_BACKEND_PROTOCOL", "$vector.records", "does not contain exactly one vector for every planned chunk.");
        return Object.freeze({ chunkId: chunk.id, vector: record.vector, canonicalizeZero: !reused });
      });
      const mergePlanSha = deterministicMergePlanSha({
        backend, plan, reusedChunkIds, indexedChunkIds,
        ...(prior === undefined ? {} : { priorSha256: prior.index.vectorArtifact.sha256 }),
        deltaSha256: semanticDeltaSha(delta!.artifact),
      });
      vectorBytes = encodeRecords(backend.dimensions, mergePlanSha, records);
      parseCutFootageVectorArtifact(vectorBytes, { dimensions: backend.dimensions, chunkIds: plan.chunks.map((chunk) => chunk.id) });
    }
    const index = signedIndex({ rootLocator, plan, backend, vectorLocator, vectorBytes });
    const indexBytes = Buffer.from(`${stableJsonStringify(index)}\n`, "utf8");
    const stagedVector = resolve(stagingRoot, "final.vectors"), stagedIndex = resolve(stagingRoot, "final.json");
    await Promise.all([
      writeFile(stagedVector, vectorBytes, { flag: "wx", mode: 0o600 }),
      writeFile(stagedIndex, indexBytes, { flag: "wx", mode: 0o600 }),
    ]);
    await options.__testHooks?.beforeSourceRecheck?.(plan);
    abortIfRequested(options.signal);
    await verifyPlannedSourceHashes(sourceSnapshots, options.signal);
    await options.__testHooks?.afterSourceRecheck?.(plan);
    if (prior && prior.indexBytes.equals(indexBytes) && prior.vectorBytes.equals(vectorBytes)) {
      await verifyFullReuseAuthority(prior, indexPath, vectorPath, sourceSnapshots, options.signal, options.__testHooks);
      return result(index, indexLocator, vectorLocator, reusedChunkIds, indexedChunkIds);
    }
    abortIfRequested(options.signal);
    await recheckPriorPair(prior, indexPath, vectorPath, options.signal);
    abortIfRequested(options.signal);
    await verifyPlannedSourceMetadata(sourceSnapshots);
    abortIfRequested(options.signal);
    await options.__testHooks?.beforePublication?.(plan);
    abortIfRequested(options.signal);
    await verifyPlannedSourceMetadata(sourceSnapshots);
    const expectedDestinations = await publicationDestinationSnapshots(prior, indexPath, vectorPath);
    abortIfRequested(options.signal);
    const stagedPairEvidence = await verifyExactPairBytes(
      Object.freeze({ indexBytes, vectorBytes }),
      stagedIndex,
      stagedVector,
      options.signal,
    );
    abortIfRequested(options.signal);
    const publications: readonly StagedFilePublication[] = Object.freeze([
      Object.freeze({ staged: stagedVector, destination: vectorPath, order: 100, role: "footage-vector", expectedDestinationSnapshot: expectedDestinations.vector }),
      Object.freeze({ staged: stagedIndex, destination: indexPath, order: 200, role: "footage-index", expectedDestinationSnapshot: expectedDestinations.index }),
    ]);
    const verifyPublicationAuthority = async (phase: "before-promotion" | "before-finalize") => {
      abortIfRequested(options.signal);
      if (phase === "before-promotion") {
        const currentStageEvidence = await verifyExactPairBytes(
          Object.freeze({ indexBytes, vectorBytes }),
          stagedIndex,
          stagedVector,
          options.signal,
        );
        if (!sameFileEvidence(currentStageEvidence.index, stagedPairEvidence.index)
          || !sameFileEvidence(currentStageEvidence.vector, stagedPairEvidence.vector)) {
          footageFail("CUT_FOOTAGE_INDEX_STALE", "$output", "the exact staged footage pair changed before promotion.");
        }
        await verifyPlannedSourceMetadata(sourceSnapshots);
        abortIfRequested(options.signal);
        sealPairAuthority(currentStageEvidence, stagedIndex, stagedVector, options.signal);
        sealPlannedSourceAuthority(sourceSnapshots, options.signal);
        sealPairAuthority(currentStageEvidence, stagedIndex, stagedVector, options.signal);
        return;
      }
      const promotedPairEvidence = await verifyExactPairBytes(
        Object.freeze({ indexBytes, vectorBytes }),
        indexPath,
        vectorPath,
        options.signal,
      );
      if (!samePromotedFileOrigin(promotedPairEvidence.index, stagedPairEvidence.index)
        || !samePromotedFileOrigin(promotedPairEvidence.vector, stagedPairEvidence.vector)) {
        footageFail("CUT_FOOTAGE_INDEX_STALE", "$output", "the promoted footage pair does not retain its staged inode and exact bytes.");
      }
      await verifyPlannedSourceMetadata(sourceSnapshots);
      abortIfRequested(options.signal);
      sealPairAuthority(promotedPairEvidence, indexPath, vectorPath, options.signal);
      sealPlannedSourceAuthority(sourceSnapshots, options.signal);
      sealPairAuthority(promotedPairEvidence, indexPath, vectorPath, options.signal);
    };
    try {
      if (options.__testHooks?.publication) {
        await publishStagedFileTransactionForTest(publications, options.__testHooks.publication, verifyPublicationAuthority);
      } else await publishStagedFileTransaction(publications, verifyPublicationAuthority);
    } catch (error) {
      if (error instanceof CutFootageError) throw error;
      footageFail("CUT_FOOTAGE_PUBLISH", "$output", "could not publish the staged footage index/vector rollback group.");
    }
    return result(index, indexLocator, vectorLocator, reusedChunkIds, indexedChunkIds);
  } finally {
    await cleanupStagingDirectory(stagingRoot, stagingEvidence);
  }
}

/** Builds or incrementally replaces one canonical project footage index/vector pair. */
export async function indexProjectFootage(options: IndexProjectFootageOptions): Promise<CutFootageIndexResult> {
  try {
    return await indexProjectFootageOperation(options);
  } catch (error) {
    if (error instanceof CutFootageError) throw error;
    abortIfRequested(options.signal);
    footageFail("CUT_FOOTAGE_PUBLISH", "$", "the footage index operation failed at a bounded local I/O boundary.");
  }
}
