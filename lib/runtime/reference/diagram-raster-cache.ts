import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdtemp,
  open,
  opendir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { stableJsonStringify } from "../../core/stable";
import { parseStrictPackageJson } from "../../package/json";
import { ensureProjectWriteDirectory, publishStagedFile } from "../../project/write-boundary";
import { cutReferenceRuntimeIdentity } from "../../version";

export const referenceDiagramRasterCacheFormat = "cut-reference-diagram-raster-cache" as const;
export const referenceDiagramRasterCacheVersion = 1 as const;
export const referenceDiagramRasterCacheNamespace = "diagram-raster-v1" as const;

const receiptFormat = "cut-reference-diagram-raster-cache-receipt" as const;
const identityFormat = "cut-reference-diagram-raster-cache-identity" as const;
const artifactSuffix = ".rgba";
const manifestSuffix = ".json";
const sha256Pattern = /^[a-f0-9]{64}$/u;
const finalEntryPattern = /^([a-f0-9]{64})\.(rgba|json)$/u;
const stagingEntryPattern = /^\.cut-diagram-raster-stage-([0-9]+)-[0-9A-Za-z-]+$/u;

export const referenceDiagramRasterCacheHardLimits = Object.freeze({
  maximumAxisPixels: 16_384,
  maximumArtifactRgbaBytes: 268_435_456,
  maximumTotalNamespaceBytes: 4_294_967_296,
  maximumEntries: 65_536,
  maximumDirectoryEntriesScanned: 131_072,
  maximumManifestBytes: 65_536,
  maximumIdentityStringBytes: 4_096,
});

export type ReferenceDiagramRasterCacheLimits = Readonly<{
  maximumAxisPixels: number;
  maximumArtifactRgbaBytes: number;
  maximumTotalNamespaceBytes: number;
  maximumEntries: number;
  maximumDirectoryEntriesScanned: number;
  maximumManifestBytes: number;
}>;

export const referenceDiagramRasterCacheDefaultLimits: ReferenceDiagramRasterCacheLimits = Object.freeze({
  maximumAxisPixels: 16_384,
  maximumArtifactRgbaBytes: 67_108_864,
  maximumTotalNamespaceBytes: 536_870_912,
  maximumEntries: 2_048,
  maximumDirectoryEntriesScanned: 8_192,
  maximumManifestBytes: 16_384,
});

export type ReferenceDiagramRasterKind = "node-tile" | "edge-raster";

/**
 * All four split identities are already SHA-256 digests at this boundary.
 * The cache never serializes authored text, source paths, node names, or raw
 * backend strings. Callers decide which exact topology/geometry/paint/time
 * semantics affect their raster and hash each split before lookup.
 */
export type ReferenceDiagramRasterCacheIdentityInput = Readonly<{
  kind: ReferenceDiagramRasterKind;
  width: number;
  height: number;
  splitIdentities: Readonly<{
    topology: string;
    geometry: string;
    paint: string;
    temporal: string;
  }>;
  backendIdentity: string;
  runtimeIdentity: typeof cutReferenceRuntimeIdentity;
}>;

export type ReferenceDiagramRasterCacheIdentity = Readonly<{
  format: typeof identityFormat;
  version: 1;
  kind: ReferenceDiagramRasterKind;
  width: number;
  height: number;
  channels: 4;
  pixelFormat: "rgba8-straight";
  splitIdentities: Readonly<{
    topology: string;
    geometry: string;
    paint: string;
    temporal: string;
  }>;
  backendIdentitySha256: string;
  runtimeIdentitySha256: string;
  key: string;
}>;

export type ReferenceDiagramRgbaSurface = Readonly<{
  data: Uint8Array;
  width: number;
  height: number;
}>;

export type ReferenceDiagramRasterCacheReason =
  | "CUT_DIAGRAM_RASTER_CACHE_HIT"
  | "CUT_DIAGRAM_RASTER_CACHE_HIT_AFTER_BUILD_RACE"
  | "CUT_DIAGRAM_RASTER_CACHE_COALESCED"
  | "CUT_DIAGRAM_RASTER_CACHE_COLD"
  | "CUT_DIAGRAM_RASTER_CACHE_MANIFEST_MISSING"
  | "CUT_DIAGRAM_RASTER_CACHE_MANIFEST_INVALID"
  | "CUT_DIAGRAM_RASTER_CACHE_ARTIFACT_MISSING"
  | "CUT_DIAGRAM_RASTER_CACHE_ARTIFACT_CORRUPT";

export type ReferenceDiagramRasterCacheReceipt = Readonly<{
  format: typeof receiptFormat;
  version: 1;
  /** This is a sub-scene RGBA cache, never evidence of scene-cache reuse. */
  cacheLayer: "diagram-subscene-rgba";
  scope: "persistent-cross-render";
  lookup: "persistent-hit" | "built-miss" | "same-process-coalesced";
  reason: ReferenceDiagramRasterCacheReason;
  key: string;
  identity: ReferenceDiagramRasterCacheIdentity;
  artifact: Readonly<{
    sha256: string;
    bytes: number;
    width: number;
    height: number;
    channels: 4;
    pixelFormat: "rgba8-straight";
    verification: "closed-manifest+exact-dimensions+exact-bytes+sha256";
  }>;
  counters: Readonly<{
    persistentLookups: number;
    persistentHits: number;
    persistentMisses: number;
    sameProcessCoalescedWaits: number;
    builderExecutions: number;
    bytesRead: number;
    bytesWritten: number;
    manifestsValidated: number;
    evictedEntries: number;
    evictedBytes: number;
  }>;
  executionIdentity: string;
}>;

export type ReferenceDiagramRasterCacheResult = Readonly<{
  surface: Readonly<{ data: Buffer; width: number; height: number }>;
  receipt: ReferenceDiagramRasterCacheReceipt;
}>;

export type ReferenceDiagramRasterCacheFaultPoint =
  | "before-artifact-publication"
  | "after-artifact-publication"
  | "before-manifest-publication"
  | "after-manifest-publication";

/** @internal Deterministic publication-fault injection for conformance tests. */
export type ReferenceDiagramRasterCacheTestHooks = Readonly<{
  fault?: (point: ReferenceDiagramRasterCacheFaultPoint) => void | Promise<void>;
}>;

export type ReferenceDiagramRasterCacheOptions = Readonly<{
  projectRoot: string;
  cacheRoot: string;
  limits?: Partial<ReferenceDiagramRasterCacheLimits>;
  /** @internal */
  __testHooks?: ReferenceDiagramRasterCacheTestHooks;
}>;

export type ReferenceDiagramRasterCacheErrorCode =
  | "CUT_DIAGRAM_RASTER_CACHE_INPUT"
  | "CUT_DIAGRAM_RASTER_CACHE_PATH"
  | "CUT_DIAGRAM_RASTER_CACHE_NAMESPACE"
  | "CUT_DIAGRAM_RASTER_CACHE_RESOURCE_LIMIT"
  | "CUT_DIAGRAM_RASTER_CACHE_ARTIFACT"
  | "CUT_DIAGRAM_RASTER_CACHE_BUILD"
  | "CUT_DIAGRAM_RASTER_CACHE_PUBLICATION";

export class ReferenceDiagramRasterCacheError extends Error {
  constructor(readonly code: ReferenceDiagramRasterCacheErrorCode, detail: string, options?: ErrorOptions) {
    super(`${code}: ${detail}`, options);
    this.name = "ReferenceDiagramRasterCacheError";
  }
}

type ReferenceDiagramRasterCacheManifest = Readonly<{
  format: typeof referenceDiagramRasterCacheFormat;
  version: 1;
  key: string;
  identity: Omit<ReferenceDiagramRasterCacheIdentity, "key">;
  artifact: Readonly<{
    sha256: string;
    bytes: number;
    width: number;
    height: number;
    channels: 4;
    pixelFormat: "rgba8-straight";
  }>;
}>;

type Inspection = Readonly<{
  status: "hit" | "miss";
  reason: ReferenceDiagramRasterCacheReason;
  data?: Buffer;
  sha256?: string;
  bytesRead: number;
  manifestsValidated: number;
}>;

type NamespaceEntry = {
  key: string;
  artifact: boolean;
  manifest: boolean;
  bytes: number;
};

type NamespaceScan = {
  entries: Map<string, NamespaceEntry>;
  totalBytes: number;
  recoveredStagingEntries: number;
};

type Eviction = Readonly<{ entries: number; bytes: number }>;

type Materialized = Readonly<{
  data: Buffer;
  identity: ReferenceDiagramRasterCacheIdentity;
  sha256: string;
  receipt: ReferenceDiagramRasterCacheReceipt;
}>;

type NamespaceSnapshot = Readonly<{
  path: string;
  physical: string;
  dev: number | bigint;
  ino: number | bigint;
}>;

const namespaceTails = new Map<string, Promise<void>>();
const inFlightArtifacts = new Map<string, Promise<Materialized>>();

function fail(code: ReferenceDiagramRasterCacheErrorCode, detail: string, cause?: unknown): never {
  throw new ReferenceDiagramRasterCacheError(code, detail, cause === undefined ? undefined : { cause });
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.keys(value).sort(), canonical = [...expected].sort();
  return actual.length === canonical.length && actual.every((key, index) => key === canonical[index]);
}

function inside(root: string, candidate: string) {
  const local = relative(root, candidate);
  return local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local);
}

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function frozen<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value) || ArrayBuffer.isView(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) frozen(child);
  return value;
}

function validateDigest(value: unknown, label: string) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    fail("CUT_DIAGRAM_RASTER_CACHE_INPUT", `${label} must be one lowercase SHA-256 digest.`);
  }
  return value;
}

function validateIdentityString(value: unknown, label: string) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > referenceDiagramRasterCacheHardLimits.maximumIdentityStringBytes) {
    fail("CUT_DIAGRAM_RASTER_CACHE_INPUT", `${label} must be one bounded non-empty identity string.`);
  }
  return value;
}

function validateAxis(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > referenceDiagramRasterCacheHardLimits.maximumAxisPixels) {
    fail("CUT_DIAGRAM_RASTER_CACHE_INPUT", `${label} must be a positive safe integer no greater than ${referenceDiagramRasterCacheHardLimits.maximumAxisPixels}.`);
  }
  return Number(value);
}

function exactRgbaBytes(width: number, height: number) {
  const bytes = width * height * 4;
  if (!Number.isSafeInteger(bytes) || bytes < 4 || bytes > referenceDiagramRasterCacheHardLimits.maximumArtifactRgbaBytes) {
    fail("CUT_DIAGRAM_RASTER_CACHE_RESOURCE_LIMIT", `RGBA surface requires ${String(bytes)} bytes; hard maximum is ${referenceDiagramRasterCacheHardLimits.maximumArtifactRgbaBytes}.`);
  }
  return bytes;
}

/** Validate and hash the complete path-free cache identity. */
export function referenceDiagramRasterCacheIdentity(input: ReferenceDiagramRasterCacheIdentityInput): ReferenceDiagramRasterCacheIdentity {
  if (!plainRecord(input) || !exactKeys(input, ["kind", "width", "height", "splitIdentities", "backendIdentity", "runtimeIdentity"])) {
    fail("CUT_DIAGRAM_RASTER_CACHE_INPUT", "cache identity must be one closed object.");
  }
  if (input.kind !== "node-tile" && input.kind !== "edge-raster") {
    fail("CUT_DIAGRAM_RASTER_CACHE_INPUT", "cache identity kind must be node-tile or edge-raster.");
  }
  const width = validateAxis(input.width, "width"), height = validateAxis(input.height, "height");
  exactRgbaBytes(width, height);
  if (!plainRecord(input.splitIdentities) || !exactKeys(input.splitIdentities, ["topology", "geometry", "paint", "temporal"])) {
    fail("CUT_DIAGRAM_RASTER_CACHE_INPUT", "splitIdentities must contain exactly topology, geometry, paint, and temporal.");
  }
  const splitIdentities = frozen({
    topology: validateDigest(input.splitIdentities.topology, "splitIdentities.topology"),
    geometry: validateDigest(input.splitIdentities.geometry, "splitIdentities.geometry"),
    paint: validateDigest(input.splitIdentities.paint, "splitIdentities.paint"),
    temporal: validateDigest(input.splitIdentities.temporal, "splitIdentities.temporal"),
  });
  const backendIdentity = validateIdentityString(input.backendIdentity, "backendIdentity");
  const runtimeIdentity = validateIdentityString(input.runtimeIdentity, "runtimeIdentity");
  if (runtimeIdentity !== cutReferenceRuntimeIdentity) {
    fail("CUT_DIAGRAM_RASTER_CACHE_INPUT", "runtimeIdentity must equal the executing CUT reference runtime identity.");
  }
  const content = frozen({
    format: identityFormat,
    version: 1 as const,
    kind: input.kind,
    width,
    height,
    channels: 4 as const,
    pixelFormat: "rgba8-straight" as const,
    splitIdentities,
    backendIdentitySha256: sha256(backendIdentity),
    runtimeIdentitySha256: sha256(runtimeIdentity),
  });
  return frozen({ ...content, key: sha256(stableJsonStringify(content)) });
}

function resolveLimits(overrides: Partial<ReferenceDiagramRasterCacheLimits> | undefined): ReferenceDiagramRasterCacheLimits {
  if (overrides === undefined) return referenceDiagramRasterCacheDefaultLimits;
  if (!plainRecord(overrides)) fail("CUT_DIAGRAM_RASTER_CACHE_INPUT", "cache limits must be one closed object.");
  const allowed = Object.keys(referenceDiagramRasterCacheDefaultLimits) as Array<keyof ReferenceDiagramRasterCacheLimits>;
  if (Object.keys(overrides).some((key) => !allowed.includes(key as keyof ReferenceDiagramRasterCacheLimits))) {
    fail("CUT_DIAGRAM_RASTER_CACHE_INPUT", "cache limits contain an unsupported property.");
  }
  const result: { -readonly [K in keyof ReferenceDiagramRasterCacheLimits]: number } = { ...referenceDiagramRasterCacheDefaultLimits };
  for (const name of allowed) {
    const value = overrides[name];
    if (value === undefined) continue;
    const ceiling = referenceDiagramRasterCacheHardLimits[name];
    if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) {
      fail("CUT_DIAGRAM_RASTER_CACHE_INPUT", `${name} must be a positive safe integer no greater than ${ceiling}.`);
    }
    result[name] = value;
  }
  return Object.freeze(result);
}

async function withNamespaceLock<T>(namespace: string, work: () => Promise<T>): Promise<T> {
  const previous = namespaceTails.get(namespace) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((accept) => { release = accept; });
  namespaceTails.set(namespace, current);
  await previous.catch(() => undefined);
  try { return await work(); }
  finally {
    release();
    if (namespaceTails.get(namespace) === current) namespaceTails.delete(namespace);
  }
}

async function optionalLstat(path: string) {
  try { return await lstat(path); }
  catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

async function openNamespace(options: ReferenceDiagramRasterCacheOptions): Promise<NamespaceSnapshot> {
  if (!plainRecord(options) || !exactKeys(options, ["projectRoot", "cacheRoot", ...(options.limits === undefined ? [] : ["limits"]), ...(options.__testHooks === undefined ? [] : ["__testHooks"])])) {
    fail("CUT_DIAGRAM_RASTER_CACHE_INPUT", "cache options must be one closed object.");
  }
  if (typeof options.projectRoot !== "string" || typeof options.cacheRoot !== "string" || !options.projectRoot || !options.cacheRoot) {
    fail("CUT_DIAGRAM_RASTER_CACHE_INPUT", "projectRoot and cacheRoot must be non-empty paths.");
  }
  if (options.__testHooks !== undefined
    && (!plainRecord(options.__testHooks)
      || !exactKeys(options.__testHooks, options.__testHooks.fault === undefined ? [] : ["fault"])
      || (options.__testHooks.fault !== undefined && typeof options.__testHooks.fault !== "function"))) {
    fail("CUT_DIAGRAM_RASTER_CACHE_INPUT", "test hooks must contain only an optional fault function.");
  }
  const lexicalProject = resolve(options.projectRoot), lexicalCache = resolve(options.cacheRoot);
  let projectMetadata, physicalProject: string;
  try {
    projectMetadata = await lstat(lexicalProject);
    if (projectMetadata.isSymbolicLink() || !projectMetadata.isDirectory()) {
      fail("CUT_DIAGRAM_RASTER_CACHE_PATH", "projectRoot must be a direct non-symlink directory.");
    }
    physicalProject = await realpath(lexicalProject);
  } catch (error) {
    if (error instanceof ReferenceDiagramRasterCacheError) throw error;
    fail("CUT_DIAGRAM_RASTER_CACHE_PATH", "projectRoot cannot be resolved as a direct directory.", error);
  }
  const candidateLocals = [relative(lexicalProject, lexicalCache), relative(physicalProject, lexicalCache)];
  const local = candidateLocals.find((candidate) => inside("/", resolve("/", candidate)) && candidate !== ".." && !candidate.startsWith(`..${sep}`) && !isAbsolute(candidate));
  if (local === undefined) fail("CUT_DIAGRAM_RASTER_CACHE_PATH", "cacheRoot must remain inside projectRoot.");
  const cacheLocator = local === "" ? "" : local.split(sep).join("/");
  let namespace: string;
  try {
    namespace = await ensureProjectWriteDirectory(
      physicalProject,
      cacheLocator ? `${cacheLocator}/${referenceDiagramRasterCacheNamespace}` : referenceDiagramRasterCacheNamespace,
    );
  } catch (error) {
    fail("CUT_DIAGRAM_RASTER_CACHE_PATH", "cacheRoot or its diagram namespace contains a symlink, non-directory, or escape.", error);
  }
  const metadata = await lstat(namespace);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) fail("CUT_DIAGRAM_RASTER_CACHE_PATH", "diagram cache namespace must be a direct directory.");
  const physical = await realpath(namespace);
  if (!inside(physicalProject, physical)) fail("CUT_DIAGRAM_RASTER_CACHE_PATH", "diagram cache namespace resolves outside projectRoot.");
  return Object.freeze({ path: namespace, physical, dev: metadata.dev, ino: metadata.ino });
}

async function assertNamespace(snapshot: NamespaceSnapshot) {
  let metadata, physical: string;
  try {
    metadata = await lstat(snapshot.path);
    physical = await realpath(snapshot.path);
  } catch (error) {
    fail("CUT_DIAGRAM_RASTER_CACHE_PATH", "diagram cache namespace disappeared or cannot be resolved.", error);
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || metadata.dev !== snapshot.dev || metadata.ino !== snapshot.ino || physical !== snapshot.physical) {
    fail("CUT_DIAGRAM_RASTER_CACHE_PATH", "diagram cache namespace changed after validation.");
  }
}

type BoundedRead =
  | Readonly<{ status: "missing"; bytesRead: 0 }>
  | Readonly<{ status: "invalid"; bytesRead: 0 }>
  | Readonly<{ status: "ok"; data: Buffer; bytesRead: number }>;

async function readBoundedRegularFile(path: string, maximumBytes: number, exactBytes?: number): Promise<BoundedRead> {
  const before = await optionalLstat(path).catch(() => undefined);
  if (!before) return { status: "missing", bytesRead: 0 };
  if (before.isSymbolicLink() || !before.isFile() || !Number.isSafeInteger(before.size)
    || before.size < 1 || before.size > maximumBytes || (exactBytes !== undefined && before.size !== exactBytes)) {
    return { status: "invalid", bytesRead: 0 };
  }
  let handle;
  try {
    const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    handle = await open(path, fsConstants.O_RDONLY | noFollow);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== before.size || opened.dev !== before.dev || opened.ino !== before.ino) return { status: "invalid", bytesRead: 0 };
    const data = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < data.byteLength) {
      const result = await handle.read(data, offset, data.byteLength - offset, offset);
      if (result.bytesRead === 0) return { status: "invalid", bytesRead: 0 };
      offset += result.bytesRead;
    }
    const extra = Buffer.alloc(1), trailing = await handle.read(extra, 0, 1, data.byteLength);
    const after = await handle.stat();
    if (trailing.bytesRead !== 0 || after.size !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino) {
      return { status: "invalid", bytesRead: 0 };
    }
    return { status: "ok", data, bytesRead: data.byteLength };
  } catch {
    return { status: "invalid", bytesRead: 0 };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function manifestIdentity(identity: ReferenceDiagramRasterCacheIdentity): Omit<ReferenceDiagramRasterCacheIdentity, "key"> {
  return {
    format: identity.format,
    version: identity.version,
    kind: identity.kind,
    width: identity.width,
    height: identity.height,
    channels: identity.channels,
    pixelFormat: identity.pixelFormat,
    splitIdentities: identity.splitIdentities,
    backendIdentitySha256: identity.backendIdentitySha256,
    runtimeIdentitySha256: identity.runtimeIdentitySha256,
  };
}

function validManifest(value: unknown, identity: ReferenceDiagramRasterCacheIdentity, expectedBytes: number): value is ReferenceDiagramRasterCacheManifest {
  if (!plainRecord(value) || !exactKeys(value, ["format", "version", "key", "identity", "artifact"])) return false;
  if (value.format !== referenceDiagramRasterCacheFormat || value.version !== referenceDiagramRasterCacheVersion || value.key !== identity.key) return false;
  if (!plainRecord(value.identity) || !exactKeys(value.identity, ["format", "version", "kind", "width", "height", "channels", "pixelFormat", "splitIdentities", "backendIdentitySha256", "runtimeIdentitySha256"])) return false;
  if (!plainRecord(value.identity.splitIdentities) || !exactKeys(value.identity.splitIdentities, ["topology", "geometry", "paint", "temporal"])) return false;
  if (stableJsonStringify(value.identity) !== stableJsonStringify(manifestIdentity(identity))) return false;
  if (!plainRecord(value.artifact) || !exactKeys(value.artifact, ["sha256", "bytes", "width", "height", "channels", "pixelFormat"])) return false;
  return sha256Pattern.test(String(value.artifact.sha256))
    && value.artifact.bytes === expectedBytes
    && value.artifact.width === identity.width
    && value.artifact.height === identity.height
    && value.artifact.channels === 4
    && value.artifact.pixelFormat === "rgba8-straight";
}

async function inspectArtifact(namespace: string, identity: ReferenceDiagramRasterCacheIdentity, limits: ReferenceDiagramRasterCacheLimits): Promise<Inspection> {
  const expectedBytes = exactRgbaBytes(identity.width, identity.height);
  const artifactPath = resolve(namespace, `${identity.key}${artifactSuffix}`), manifestPath = resolve(namespace, `${identity.key}${manifestSuffix}`);
  const manifestRead = await readBoundedRegularFile(manifestPath, limits.maximumManifestBytes);
  if (manifestRead.status === "missing") {
    const artifact = await optionalLstat(artifactPath).catch(() => undefined);
    return {
      status: "miss",
      reason: artifact ? "CUT_DIAGRAM_RASTER_CACHE_MANIFEST_MISSING" : "CUT_DIAGRAM_RASTER_CACHE_COLD",
      bytesRead: 0,
      manifestsValidated: 0,
    };
  }
  if (manifestRead.status === "invalid") return { status: "miss", reason: "CUT_DIAGRAM_RASTER_CACHE_MANIFEST_INVALID", bytesRead: 0, manifestsValidated: 0 };
  let parsed: unknown;
  try {
    parsed = parseStrictPackageJson(manifestRead.data, {
      limits: {
        maxInputBytes: limits.maximumManifestBytes,
        maxDepth: 8,
        maxNodes: 64,
        maxStringBytes: 4_096,
        maxTotalStringBytes: 16_384,
      },
    });
  } catch {
    return { status: "miss", reason: "CUT_DIAGRAM_RASTER_CACHE_MANIFEST_INVALID", bytesRead: manifestRead.bytesRead, manifestsValidated: 0 };
  }
  if (!validManifest(parsed, identity, expectedBytes)) {
    return { status: "miss", reason: "CUT_DIAGRAM_RASTER_CACHE_MANIFEST_INVALID", bytesRead: manifestRead.bytesRead, manifestsValidated: 0 };
  }
  const artifactRead = await readBoundedRegularFile(artifactPath, limits.maximumArtifactRgbaBytes, expectedBytes);
  if (artifactRead.status === "missing") {
    return { status: "miss", reason: "CUT_DIAGRAM_RASTER_CACHE_ARTIFACT_MISSING", bytesRead: manifestRead.bytesRead, manifestsValidated: 1 };
  }
  if (artifactRead.status === "invalid") {
    return { status: "miss", reason: "CUT_DIAGRAM_RASTER_CACHE_ARTIFACT_CORRUPT", bytesRead: manifestRead.bytesRead, manifestsValidated: 1 };
  }
  const digest = sha256(artifactRead.data);
  if (digest !== parsed.artifact.sha256) {
    return { status: "miss", reason: "CUT_DIAGRAM_RASTER_CACHE_ARTIFACT_CORRUPT", bytesRead: manifestRead.bytesRead + artifactRead.bytesRead, manifestsValidated: 1 };
  }
  return {
    status: "hit",
    reason: "CUT_DIAGRAM_RASTER_CACHE_HIT",
    data: artifactRead.data,
    sha256: digest,
    bytesRead: manifestRead.bytesRead + artifactRead.bytesRead,
    manifestsValidated: 1,
  };
}

async function removeCachePair(namespace: string, entry: NamespaceEntry) {
  for (const suffix of [artifactSuffix, manifestSuffix]) {
    const path = resolve(namespace, `${entry.key}${suffix}`), metadata = await optionalLstat(path);
    if (!metadata) continue;
    if (metadata.isDirectory() || (!metadata.isFile() && !metadata.isSymbolicLink())) {
      fail("CUT_DIAGRAM_RASTER_CACHE_NAMESPACE", "a cache-owned final entry is not a regular file or leaf symlink.");
    }
    await rm(path, { force: true });
  }
}

async function scanNamespace(snapshot: NamespaceSnapshot, limits: ReferenceDiagramRasterCacheLimits): Promise<NamespaceScan> {
  await assertNamespace(snapshot);
  const names: Array<{ name: string; kind: "final" | "staging" }> = [];
  const directory = await opendir(snapshot.path);
  let scanned = 0;
  try {
    for await (const entry of directory) {
      scanned += 1;
      if (scanned > limits.maximumDirectoryEntriesScanned) {
        fail("CUT_DIAGRAM_RASTER_CACHE_RESOURCE_LIMIT", `diagram cache namespace contains more than ${limits.maximumDirectoryEntriesScanned} directory entries.`);
      }
      if (finalEntryPattern.test(entry.name)) names.push({ name: entry.name, kind: "final" });
      else if (stagingEntryPattern.test(entry.name)) names.push({ name: entry.name, kind: "staging" });
      else fail("CUT_DIAGRAM_RASTER_CACHE_NAMESPACE", "diagram cache namespace contains an unmanaged entry.");
    }
  } catch (error) {
    if (error instanceof ReferenceDiagramRasterCacheError) throw error;
    fail("CUT_DIAGRAM_RASTER_CACHE_NAMESPACE", "diagram cache namespace cannot be enumerated safely.", error);
  }

  // Publication is serialized per namespace in-process, but not across
  // processes. A stage carrying this PID cannot be active while this process
  // holds the namespace FIFO and may be recovered. A different PID may still
  // be publishing, so it is validated as a direct directory and left alone.
  // Cross-process eviction coordination remains explicitly unclaimed; never
  // turn that limitation into deletion of another writer's live stage.
  let recoveredStagingEntries = 0;
  for (const entry of names.filter((candidate) => candidate.kind === "staging")) {
    const match = stagingEntryPattern.exec(entry.name), path = resolve(snapshot.path, entry.name), metadata = await optionalLstat(path);
    if (!metadata) continue;
    if (!match || metadata.isSymbolicLink() || !metadata.isDirectory()) {
      fail("CUT_DIAGRAM_RASTER_CACHE_NAMESPACE", "diagram cache staging entry must be one direct process-owned directory.");
    }
    if (match[1] === String(process.pid)) {
      await rm(path, { recursive: true, force: true });
      recoveredStagingEntries += 1;
    }
  }

  const entries = new Map<string, NamespaceEntry>();
  let totalBytes = 0;
  for (const entry of names.filter((candidate) => candidate.kind === "final")) {
    const match = finalEntryPattern.exec(entry.name)!;
    const key = match[1], role = match[2], path = resolve(snapshot.path, entry.name), metadata = await optionalLstat(path);
    if (!metadata) continue;
    if (metadata.isDirectory() || (!metadata.isFile() && !metadata.isSymbolicLink())) {
      fail("CUT_DIAGRAM_RASTER_CACHE_NAMESPACE", "a cache-owned final entry has an unsupported filesystem type.");
    }
    if (!Number.isSafeInteger(metadata.size) || metadata.size < 0) {
      fail("CUT_DIAGRAM_RASTER_CACHE_RESOURCE_LIMIT", "a cache-owned final entry has an unbounded byte count.");
    }
    const item = entries.get(key) ?? { key, artifact: false, manifest: false, bytes: 0 };
    if (role === "rgba") item.artifact = true;
    else item.manifest = true;
    item.bytes += metadata.size;
    totalBytes += metadata.size;
    if (!Number.isSafeInteger(item.bytes) || !Number.isSafeInteger(totalBytes)) {
      fail("CUT_DIAGRAM_RASTER_CACHE_RESOURCE_LIMIT", "diagram cache namespace byte accounting overflowed.");
    }
    entries.set(key, item);
  }
  return { entries, totalBytes, recoveredStagingEntries };
}

async function enforceBounds(
  snapshot: NamespaceSnapshot,
  scan: NamespaceScan,
  limits: ReferenceDiagramRasterCacheLimits,
  preserveKey?: string,
  replacementBytes = 0,
) {
  let entries = scan.entries.size - (preserveKey && scan.entries.has(preserveKey) ? 1 : 0) + (preserveKey ? 1 : 0);
  let bytes = scan.totalBytes - (preserveKey ? scan.entries.get(preserveKey)?.bytes ?? 0 : 0) + replacementBytes;
  const candidates = [...scan.entries.values()]
    .filter((entry) => entry.key !== preserveKey)
    .sort((left, right) => {
      const leftComplete = left.artifact && left.manifest ? 1 : 0, rightComplete = right.artifact && right.manifest ? 1 : 0;
      return leftComplete - rightComplete || right.key.localeCompare(left.key);
    });
  let evictedEntries = 0, evictedBytes = 0;
  while (entries > limits.maximumEntries || bytes > limits.maximumTotalNamespaceBytes) {
    const victim = candidates.shift();
    if (!victim) {
      fail(
        "CUT_DIAGRAM_RASTER_CACHE_RESOURCE_LIMIT",
        `one admitted diagram raster and manifest cannot fit the ${limits.maximumEntries}-entry / ${limits.maximumTotalNamespaceBytes}-byte namespace budget.`,
      );
    }
    await removeCachePair(snapshot.path, victim);
    entries -= 1;
    bytes -= victim.bytes;
    evictedEntries += 1;
    evictedBytes += victim.bytes;
  }
  return Object.freeze({ entries: evictedEntries, bytes: evictedBytes });
}

function cacheManifest(identity: ReferenceDiagramRasterCacheIdentity, digest: string, bytes: number): ReferenceDiagramRasterCacheManifest {
  return frozen({
    format: referenceDiagramRasterCacheFormat,
    version: referenceDiagramRasterCacheVersion,
    key: identity.key,
    identity: manifestIdentity(identity),
    artifact: {
      sha256: digest,
      bytes,
      width: identity.width,
      height: identity.height,
      channels: 4,
      pixelFormat: "rgba8-straight",
    },
  });
}

function receipt(
  identity: ReferenceDiagramRasterCacheIdentity,
  digest: string,
  lookup: ReferenceDiagramRasterCacheReceipt["lookup"],
  reason: ReferenceDiagramRasterCacheReason,
  counters: ReferenceDiagramRasterCacheReceipt["counters"],
) {
  const body = frozen({
    format: receiptFormat,
    version: 1 as const,
    cacheLayer: "diagram-subscene-rgba" as const,
    scope: "persistent-cross-render" as const,
    lookup,
    reason,
    key: identity.key,
    identity,
    artifact: {
      sha256: digest,
      bytes: exactRgbaBytes(identity.width, identity.height),
      width: identity.width,
      height: identity.height,
      channels: 4 as const,
      pixelFormat: "rgba8-straight" as const,
      verification: "closed-manifest+exact-dimensions+exact-bytes+sha256" as const,
    },
    counters: frozen(counters),
  });
  return frozen({ ...body, executionIdentity: sha256(stableJsonStringify(body)) });
}

function validateSurface(surface: unknown, identity: ReferenceDiagramRasterCacheIdentity, limits: ReferenceDiagramRasterCacheLimits) {
  if (!plainRecord(surface) || !exactKeys(surface, ["data", "width", "height"])) {
    fail("CUT_DIAGRAM_RASTER_CACHE_ARTIFACT", "raster builder must return exactly data, width, and height.");
  }
  if (surface.width !== identity.width || surface.height !== identity.height) {
    fail("CUT_DIAGRAM_RASTER_CACHE_ARTIFACT", "raster builder dimensions do not match the admitted cache identity.");
  }
  if (!(surface.data instanceof Uint8Array)) fail("CUT_DIAGRAM_RASTER_CACHE_ARTIFACT", "raster builder data must be one Uint8Array RGBA surface.");
  const bytes = exactRgbaBytes(identity.width, identity.height);
  if (bytes > limits.maximumArtifactRgbaBytes) {
    fail("CUT_DIAGRAM_RASTER_CACHE_RESOURCE_LIMIT", `RGBA surface requires ${bytes} bytes; configured artifact maximum is ${limits.maximumArtifactRgbaBytes}.`);
  }
  if (surface.data.byteLength !== bytes) {
    fail("CUT_DIAGRAM_RASTER_CACHE_ARTIFACT", `raster builder returned ${surface.data.byteLength} bytes; exact RGBA contract requires ${bytes}.`);
  }
  return Buffer.from(surface.data);
}

function publicResult(materialized: Materialized, coalesced: boolean): ReferenceDiagramRasterCacheResult {
  const renderedReceipt = coalesced
    ? receipt(materialized.identity, materialized.sha256, "same-process-coalesced", "CUT_DIAGRAM_RASTER_CACHE_COALESCED", {
      persistentLookups: 0,
      persistentHits: 0,
      persistentMisses: 0,
      sameProcessCoalescedWaits: 1,
      builderExecutions: 0,
      bytesRead: 0,
      bytesWritten: 0,
      manifestsValidated: 0,
      evictedEntries: 0,
      evictedBytes: 0,
    })
    : materialized.receipt;
  return Object.freeze({
    surface: Object.freeze({ data: Buffer.from(materialized.data), width: materialized.identity.width, height: materialized.identity.height }),
    receipt: renderedReceipt,
  });
}

export class ReferenceDiagramRasterCache {
  private constructor(
    private readonly namespace: NamespaceSnapshot,
    private readonly limits: ReferenceDiagramRasterCacheLimits,
    private readonly hooks: ReferenceDiagramRasterCacheTestHooks,
  ) {}

  static async open(options: ReferenceDiagramRasterCacheOptions) {
    if (!plainRecord(options)) fail("CUT_DIAGRAM_RASTER_CACHE_INPUT", "cache options must be one closed object.");
    const limits = resolveLimits(options.limits), namespace = await openNamespace(options);
    await withNamespaceLock(namespace.path, async () => {
      const scan = await scanNamespace(namespace, limits);
      await enforceBounds(namespace, scan, limits);
    });
    return new ReferenceDiagramRasterCache(namespace, limits, options.__testHooks ?? {});
  }

  identity(input: ReferenceDiagramRasterCacheIdentityInput) {
    return referenceDiagramRasterCacheIdentity(input);
  }

  async materialize(
    input: ReferenceDiagramRasterCacheIdentityInput,
    build: () => ReferenceDiagramRgbaSurface | Promise<ReferenceDiagramRgbaSurface>,
  ): Promise<ReferenceDiagramRasterCacheResult> {
    if (typeof build !== "function") fail("CUT_DIAGRAM_RASTER_CACHE_INPUT", "raster builder must be a function.");
    const identity = referenceDiagramRasterCacheIdentity(input), bytes = exactRgbaBytes(identity.width, identity.height);
    if (bytes > this.limits.maximumArtifactRgbaBytes) {
      fail("CUT_DIAGRAM_RASTER_CACHE_RESOURCE_LIMIT", `RGBA surface requires ${bytes} bytes; configured artifact maximum is ${this.limits.maximumArtifactRgbaBytes}.`);
    }
    const token = `${this.namespace.physical}\0${identity.key}`;
    const existing = inFlightArtifacts.get(token);
    if (existing) return publicResult(await existing, true);
    const pending = this.performMaterialize(identity, build);
    inFlightArtifacts.set(token, pending);
    try { return publicResult(await pending, false); }
    finally { if (inFlightArtifacts.get(token) === pending) inFlightArtifacts.delete(token); }
  }

  private async performMaterialize(
    identity: ReferenceDiagramRasterCacheIdentity,
    build: () => ReferenceDiagramRgbaSurface | Promise<ReferenceDiagramRgbaSurface>,
  ): Promise<Materialized> {
    await assertNamespace(this.namespace);
    const inspected = await inspectArtifact(this.namespace.path, identity, this.limits);
    if (inspected.status === "hit" && inspected.data && inspected.sha256) {
      return Object.freeze({
        data: inspected.data,
        identity,
        sha256: inspected.sha256,
        receipt: receipt(identity, inspected.sha256, "persistent-hit", "CUT_DIAGRAM_RASTER_CACHE_HIT", {
          persistentLookups: 1,
          persistentHits: 1,
          persistentMisses: 0,
          sameProcessCoalescedWaits: 0,
          builderExecutions: 0,
          bytesRead: inspected.bytesRead,
          bytesWritten: 0,
          manifestsValidated: inspected.manifestsValidated,
          evictedEntries: 0,
          evictedBytes: 0,
        }),
      });
    }

    let built: ReferenceDiagramRgbaSurface;
    try { built = await build(); }
    catch (error) {
      // Renderer callbacks own source-located syntax/runtime diagnostics. Do
      // not erase their stable code/provenance behind a generic cache wrapper.
      if (error instanceof Error) throw error;
      fail("CUT_DIAGRAM_RASTER_CACHE_BUILD", "diagram raster builder rejected with a non-Error value.", error);
    }
    const data = validateSurface(built, identity, this.limits), digest = sha256(data);
    const manifest = cacheManifest(identity, digest, data.byteLength), manifestBytes = Buffer.from(`${stableJsonStringify(manifest)}\n`, "utf8");
    if (manifestBytes.byteLength > this.limits.maximumManifestBytes) {
      fail("CUT_DIAGRAM_RASTER_CACHE_RESOURCE_LIMIT", `closed cache manifest requires ${manifestBytes.byteLength} bytes; configured maximum is ${this.limits.maximumManifestBytes}.`);
    }
    if (data.byteLength + manifestBytes.byteLength > this.limits.maximumTotalNamespaceBytes) {
      fail("CUT_DIAGRAM_RASTER_CACHE_RESOURCE_LIMIT", "one diagram raster and its manifest exceed the configured namespace byte budget.");
    }

    return withNamespaceLock(this.namespace.path, async () => {
      await assertNamespace(this.namespace);
      // Recheck after potentially expensive rasterization. A second process is
      // not promised coordination, but a complete exact artifact that arrived
      // meanwhile is safe to reuse; any partial or divergent pair is repaired.
      const raced = await inspectArtifact(this.namespace.path, identity, this.limits);
      if (raced.status === "hit" && raced.data && raced.sha256) {
        return Object.freeze({
          data: raced.data,
          identity,
          sha256: raced.sha256,
          receipt: receipt(identity, raced.sha256, "persistent-hit", "CUT_DIAGRAM_RASTER_CACHE_HIT_AFTER_BUILD_RACE", {
            persistentLookups: 2,
            persistentHits: 1,
            persistentMisses: 1,
            sameProcessCoalescedWaits: 0,
            builderExecutions: 1,
            bytesRead: inspected.bytesRead + raced.bytesRead,
            bytesWritten: 0,
            manifestsValidated: inspected.manifestsValidated + raced.manifestsValidated,
            evictedEntries: 0,
            evictedBytes: 0,
          }),
        });
      }
      const scan = await scanNamespace(this.namespace, this.limits);
      const eviction: Eviction = await enforceBounds(
        this.namespace,
        scan,
        this.limits,
        identity.key,
        data.byteLength + manifestBytes.byteLength,
      );
      // The inspected pair is already unusable. Remove it before staging the
      // replacement so even the transient on-disk namespace stays within the
      // configured byte budget; manifest-last publication then starts from a
      // clean, non-authorizing destination pair.
      const replaced = scan.entries.get(identity.key);
      if (replaced) await removeCachePair(this.namespace.path, replaced);
      const staging = await mkdtemp(resolve(this.namespace.path, `.cut-diagram-raster-stage-${process.pid}-${randomUUID()}-`));
      const stagedArtifact = resolve(staging, "surface.rgba"), stagedManifest = resolve(staging, "manifest.json");
      const artifactPath = resolve(this.namespace.path, `${identity.key}${artifactSuffix}`), manifestPath = resolve(this.namespace.path, `${identity.key}${manifestSuffix}`);
      try {
        await writeFile(stagedArtifact, data, { flag: "wx", mode: 0o600 });
        await writeFile(stagedManifest, manifestBytes, { flag: "wx", mode: 0o600 });
        // Recheck the manifest leaf in case an unsupported external writer
        // appeared after the replacement pair was removed. Manifest removal
        // always precedes artifact promotion, so old metadata can never
        // authorize newly replaced bytes during the commit.
        const oldManifest = await optionalLstat(manifestPath);
        if (oldManifest) {
          if (oldManifest.isDirectory() || (!oldManifest.isFile() && !oldManifest.isSymbolicLink())) {
            fail("CUT_DIAGRAM_RASTER_CACHE_NAMESPACE", "cache manifest destination has an unsupported filesystem type.");
          }
          await rm(manifestPath, { force: true });
        }
        await this.hooks.fault?.("before-artifact-publication");
        await publishStagedFile(stagedArtifact, artifactPath);
        await this.hooks.fault?.("after-artifact-publication");
        await this.hooks.fault?.("before-manifest-publication");
        await publishStagedFile(stagedManifest, manifestPath);
        await this.hooks.fault?.("after-manifest-publication");
      } catch (error) {
        if (error instanceof ReferenceDiagramRasterCacheError) throw error;
        fail("CUT_DIAGRAM_RASTER_CACHE_PUBLICATION", "manifest-last diagram raster publication failed; no partial pair can authorize a hit.", error);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
      return Object.freeze({
        data,
        identity,
        sha256: digest,
        receipt: receipt(identity, digest, "built-miss", inspected.reason, {
          persistentLookups: 2,
          persistentHits: 0,
          persistentMisses: 2,
          sameProcessCoalescedWaits: 0,
          builderExecutions: 1,
          bytesRead: inspected.bytesRead + raced.bytesRead,
          bytesWritten: data.byteLength + manifestBytes.byteLength,
          manifestsValidated: inspected.manifestsValidated + raced.manifestsValidated,
          evictedEntries: eviction.entries,
          evictedBytes: eviction.bytes,
        }),
      });
    });
  }
}

export function createReferenceDiagramRasterCache(options: ReferenceDiagramRasterCacheOptions) {
  return ReferenceDiagramRasterCache.open(options);
}
