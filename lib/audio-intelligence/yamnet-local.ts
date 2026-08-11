import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { stableJsonStringify } from "../core/stable";

export const cutYamnetLocalPolicy = Object.freeze({
  format: "cut-yamnet-local-policy",
  version: 1,
  provider: "cut-yamnet-litert-local-v1",
  adapterResultFormat: "cut-yamnet-local-adapter-result",
  adapterProtocolVersion: 1,
  sampleFormat: "f32le",
  sampleRate: 16_000,
  channels: 1,
  maximumDurationSamples: 160_000,
  patchSamples: 15_600,
  patchHopSamples: 7_680,
  rightPadFinalPatch: true,
  classCount: 521,
  interpreterThreads: 1,
  maximumTopK: 20,
  maximumPythonBytes: 256 * 1024 * 1024,
  maximumAdapterBytes: 4 * 1024 * 1024,
  maximumEnvironmentFiles: 50_000,
  maximumEnvironmentBytes: 4 * 1024 * 1024 * 1024,
  maximumModelBytes: 64 * 1024 * 1024,
  maximumClassMapBytes: 2 * 1024 * 1024,
  maximumDoctorBytes: 64 * 1024,
  maximumStderrBytes: 128 * 1024,
  defaultTimeoutMs: 30_000,
  maximumTimeoutMs: 120_000,
  terminationGraceMs: 500,
  authorityScope:
    "CUT authenticates the caller-selected CPython, environment, LiteRT subset, adapter, model, and class-map bytes. It does not authenticate the operating system or every dynamically loaded system library.",
  licenseBoundary:
    "License and provenance strings are caller declarations recorded for traceability; CUT does not verify licensing rights or upstream provenance.",
  localityBoundary:
    "The adapter accepts PCM only through stdin and invokes the staged direct LiteRT interpreter with a local model. It has no setup, download, MediaPipe Tasks, or telemetry path. This is not an operating-system network sandbox.",
  inferenceBoundary:
    "Raw float32 score bytes and their SHA-256 are the deterministic result boundary; reproducible floating-point inference across different runtime or hardware identities is not claimed.",
} as const);

export const cutYamnetBundledAdapterRevision = "cut-yamnet-litert-adapter-v1" as const;
export const cutYamnetBundledClassMapRevision = "yamnet-audioset-class-map-521-v1" as const;

export type CutYamnetAuthenticatedFile = Readonly<{
  path: string;
  bytes: number;
  sha256: string;
}>;

export type CutYamnetAuthenticatedTreeFile = CutYamnetAuthenticatedFile & Readonly<{
  relativePath: string;
}>;

export type CutYamnetPythonAuthority = CutYamnetAuthenticatedFile & Readonly<{
  implementation: "CPython";
  pythonVersion: string;
  platform: "darwin" | "linux";
  machine: "arm64" | "x86_64";
}>;

export type CutYamnetLocalSetup = Readonly<{
  python: CutYamnetPythonAuthority;
  adapter: CutYamnetAuthenticatedFile & Readonly<{ revision: string }>;
  environment: Readonly<{
    revision: string;
    files: readonly CutYamnetAuthenticatedTreeFile[];
    treeSha256: string;
  }>;
  liteRt: Readonly<{
    packageVersion: string;
    declaredLicense: string;
    files: readonly CutYamnetAuthenticatedTreeFile[];
    treeSha256: string;
  }>;
  model: Readonly<{
    name: string;
    revision: string;
    declaredLicense: string;
    declaredProvenance: string;
    file: CutYamnetAuthenticatedFile;
  }>;
  classMap: Readonly<{
    name: string;
    revision: string;
    declaredLicense: string;
    declaredProvenance: string;
    file: CutYamnetAuthenticatedFile;
  }>;
}>;

export type CutYamnetLocalSetupPaths = Readonly<{
  python: Readonly<{
    path: string;
    pythonVersion: string;
    platform: "darwin" | "linux";
    machine: "arm64" | "x86_64";
  }>;
  adapter: Readonly<{ path: string; revision: string }>;
  environment: Readonly<{ sitePackagesRoot: string; roots: readonly string[]; revision: string }>;
  liteRt: Readonly<{ roots: readonly string[]; packageVersion: string; declaredLicense: string }>;
  model: Readonly<{
    path: string;
    name: string;
    revision: string;
    declaredLicense: string;
    declaredProvenance: string;
  }>;
  classMap: Readonly<{
    path: string;
    name: string;
    revision: string;
    declaredLicense: string;
    declaredProvenance: string;
  }>;
}>;

export type CutYamnetLocalSetupRecipe = Omit<CutYamnetLocalSetupPaths, "adapter" | "classMap">;

export type CutYamnetDoctorReceipt = Readonly<{
  format: "cut-yamnet-local-doctor";
  version: 1;
  status: "PASS";
  provider: typeof cutYamnetLocalPolicy.provider;
  runtime: Readonly<{
    implementation: "CPython";
    pythonVersion: string;
    platform: "darwin" | "linux";
    machine: "arm64" | "x86_64";
    liteRtVersion: string;
  }>;
  authorities: Readonly<{
    pythonSha256: string;
    adapterSha256: string;
    environmentTreeSha256: string;
    liteRtTreeSha256: string;
    modelSha256: string;
    classMapSha256: string;
  }>;
  declarations: Readonly<{
    callerDeclared: true;
    liteRtLicense: string;
    model: Readonly<{ name: string; revision: string; license: string; provenance: string }>;
    classMap: Readonly<{ name: string; revision: string; license: string; provenance: string }>;
  }>;
  policy: Readonly<{
    sampleRate: 16_000;
    patchSamples: 15_600;
    patchHopSamples: 7_680;
    rightPadFinalPatch: true;
    classCount: 521;
    interpreterThreads: 1;
  }>;
  stderr: Readonly<{ bytes: number; sha256: string }>;
  evidenceScope: Readonly<{
    authority: typeof cutYamnetLocalPolicy.authorityScope;
    licenses: typeof cutYamnetLocalPolicy.licenseBoundary;
    locality: typeof cutYamnetLocalPolicy.localityBoundary;
  }>;
  receiptSha256: string;
}>;

export type CutYamnetTopClass = Readonly<{
  classIndex: number;
  label: string;
  score: number;
}>;

export type CutYamnetLocalAnalysis = Readonly<{
  format: "cut-yamnet-local-analysis";
  version: 1;
  provider: typeof cutYamnetLocalPolicy.provider;
  input: Readonly<{
    sampleFormat: "f32le";
    sampleRate: 16_000;
    channels: 1;
    samples: number;
    bytes: number;
    sha256: string;
  }>;
  framing: Readonly<{
    patchSamples: 15_600;
    patchHopSamples: 7_680;
    rightPadFinalPatch: true;
    patchCount: number;
  }>;
  rawScores: Readonly<{
    classCount: 521;
    sampleFormat: "f32le";
    bytes: number;
    sha256: string;
  }>;
  stderr: Readonly<{ bytes: number; sha256: string }>;
  topK: number;
  aggregateTopClasses: readonly CutYamnetTopClass[];
  patches: readonly Readonly<{
    patchIndex: number;
    startSample: number;
    validSamples: number;
    topClasses: readonly CutYamnetTopClass[];
  }>[];
  authorities: Readonly<{
    pythonSha256: string;
    adapterSha256: string;
    environmentTreeSha256: string;
    liteRtTreeSha256: string;
    modelSha256: string;
    classMapSha256: string;
  }>;
  declarations: Readonly<{
    callerDeclared: true;
    liteRtLicense: string;
    model: Readonly<{ name: string; revision: string; license: string; provenance: string }>;
    classMap: Readonly<{ name: string; revision: string; license: string; provenance: string }>;
  }>;
  evidenceScope: Readonly<{
    authority: typeof cutYamnetLocalPolicy.authorityScope;
    licenses: typeof cutYamnetLocalPolicy.licenseBoundary;
    locality: typeof cutYamnetLocalPolicy.localityBoundary;
    inference: typeof cutYamnetLocalPolicy.inferenceBoundary;
  }>;
  analysisSha256: string;
}>;

export type CutYamnetLocalAnalysisResult = Readonly<{
  analysis: CutYamnetLocalAnalysis;
  analysisBytes: Buffer;
  rawScoreBytes: Buffer;
  classMapBytes: Buffer;
}>;

export type CutYamnetLocalErrorCode =
  | "CUT_YAMNET_CONTRACT"
  | "CUT_YAMNET_AUTHORITY"
  | "CUT_YAMNET_PLATFORM"
  | "CUT_YAMNET_PROCESS"
  | "CUT_YAMNET_TIMEOUT"
  | "CUT_YAMNET_CANCELLED"
  | "CUT_YAMNET_OUTPUT"
  | "CUT_YAMNET_CLEANUP";

export class CutYamnetLocalError extends Error {
  constructor(readonly code: CutYamnetLocalErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "CutYamnetLocalError";
  }
}

type StableSnapshot = Readonly<{
  path: string;
  bytes: number;
  sha256: string;
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;
type OwnedRoot = Readonly<{ path: string; dev: bigint; ino: bigint }>;
type ProcessOutput = Readonly<{ stdout: Buffer; stderr: Buffer }>;

const sha256Pattern = /^[a-f0-9]{64}$/u;
const safeTextPattern = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$/u;
const safeTokenPattern = /^[A-Za-z0-9][A-Za-z0-9._+@-]{0,255}$/u;

function fail(code: CutYamnetLocalErrorCode, message: string): never {
  throw new CutYamnetLocalError(code, message);
}

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalBytes(value: unknown) {
  return Buffer.from(`${stableJsonStringify(value)}\n`, "utf8");
}

function plainRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    fail("CUT_YAMNET_CONTRACT", `${path} must be one plain object.`);
  }
  return value as Record<string, unknown>;
}

function closedRecord(value: unknown, path: string, required: readonly string[], optional: readonly string[] = []) {
  const record = plainRecord(value, path);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) fail("CUT_YAMNET_CONTRACT", `${path}.${key} is not part of the closed contract.`);
  }
  for (const key of required) {
    if (!Object.hasOwn(record, key)) fail("CUT_YAMNET_CONTRACT", `${path}.${key} is required.`);
  }
  return record;
}

function integer(value: unknown, path: string, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    fail("CUT_YAMNET_CONTRACT", `${path} must be a safe integer from ${minimum} through ${maximum}.`);
  }
  return Number(value);
}

function digest(value: unknown, path: string) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    fail("CUT_YAMNET_CONTRACT", `${path} must be one lowercase SHA-256 digest.`);
  }
  return value;
}

function text(value: unknown, path: string, maximumBytes = 4_096) {
  if (typeof value !== "string" || !value || value !== value.trim() || value.normalize("NFC") !== value
    || !safeTextPattern.test(value) || Buffer.byteLength(value, "utf8") > maximumBytes) {
    fail("CUT_YAMNET_CONTRACT", `${path} must be bounded, trimmed, NFC, control-free text.`);
  }
  return value;
}

function token(value: unknown, path: string) {
  const result = text(value, path, 256);
  if (!safeTokenPattern.test(result)) fail("CUT_YAMNET_CONTRACT", `${path} must be one safe token.`);
  return result;
}

function absolutePath(value: unknown, path: string) {
  const result = text(value, path, 16_384);
  if (!isAbsolute(result) || resolve(result) !== result || result.includes("\\")
    || result.split("/").some((part, index) => index > 0 && (!part || part === "." || part === ".."))) {
    fail("CUT_YAMNET_CONTRACT", `${path} must be one canonical absolute POSIX path.`);
  }
  return result;
}

function relativePath(value: unknown, path: string) {
  const result = text(value, path, 4_096);
  if (result.startsWith("/") || result.includes("\\")
    || result.split("/").some((part) => !part || part === "." || part === "..")) {
    fail("CUT_YAMNET_CONTRACT", `${path} must be one canonical relative POSIX path.`);
  }
  return result;
}

function parseFile(value: unknown, path: string, maximumBytes: number, minimumBytes = 1) {
  const file = closedRecord(value, path, ["path", "bytes", "sha256"]);
  return Object.freeze({
    path: absolutePath(file.path, `${path}.path`),
    bytes: integer(file.bytes, `${path}.bytes`, minimumBytes, maximumBytes),
    sha256: digest(file.sha256, `${path}.sha256`),
  });
}

function treeDigest(files: readonly Readonly<{ relativePath: string; bytes: number; sha256: string }>[]) {
  const hash = createHash("sha256");
  for (const file of files) hash.update(`${file.relativePath}\0${file.bytes}\0${file.sha256}\n`, "utf8");
  return hash.digest("hex");
}

function parseTree(value: unknown, path: string) {
  if (!Array.isArray(value) || value.length < 1 || value.length > cutYamnetLocalPolicy.maximumEnvironmentFiles) {
    fail("CUT_YAMNET_CONTRACT", `${path} must contain 1 through ${cutYamnetLocalPolicy.maximumEnvironmentFiles} files.`);
  }
  let bytes = 0;
  const seen = new Set<string>();
  const files = value.map((entry, index) => {
    const item = closedRecord(entry, `${path}[${index}]`, ["path", "relativePath", "bytes", "sha256"]);
    const file = parseFile({ path: item.path, bytes: item.bytes, sha256: item.sha256 }, `${path}[${index}]`, cutYamnetLocalPolicy.maximumEnvironmentBytes, 0);
    const local = relativePath(item.relativePath, `${path}[${index}].relativePath`);
    if (seen.has(local)) fail("CUT_YAMNET_CONTRACT", `${path} repeats ${local}.`);
    seen.add(local);
    bytes += file.bytes;
    if (!Number.isSafeInteger(bytes) || bytes > cutYamnetLocalPolicy.maximumEnvironmentBytes) {
      fail("CUT_YAMNET_CONTRACT", `${path} exceeds its total-byte limit.`);
    }
    return Object.freeze({ ...file, relativePath: local });
  });
  const sorted = Object.freeze([...files].sort((left, right) => left.relativePath.localeCompare(right.relativePath)));
  if (files.some((file, index) => file !== sorted[index])) fail("CUT_YAMNET_CONTRACT", `${path} must be sorted by relativePath.`);
  return sorted;
}

function parseSetup(value: unknown) {
  const root = closedRecord(value, "$", ["python", "adapter", "environment", "liteRt", "model", "classMap"]);
  const python = closedRecord(root.python, "$.python", ["path", "bytes", "sha256", "implementation", "pythonVersion", "platform", "machine"]);
  const platform = python.platform === "darwin" || python.platform === "linux"
    ? python.platform
    : fail("CUT_YAMNET_CONTRACT", "$.python.platform must be darwin or linux.");
  const machine = python.machine === "arm64" || python.machine === "x86_64"
    ? python.machine
    : fail("CUT_YAMNET_CONTRACT", "$.python.machine must be arm64 or x86_64.");
  const parsedPython = Object.freeze({
    ...parseFile({ path: python.path, bytes: python.bytes, sha256: python.sha256 }, "$.python", cutYamnetLocalPolicy.maximumPythonBytes),
    implementation: python.implementation === "CPython" ? "CPython" as const : fail("CUT_YAMNET_CONTRACT", "$.python.implementation must be CPython."),
    pythonVersion: token(python.pythonVersion, "$.python.pythonVersion"),
    platform,
    machine,
  });
  const adapter = closedRecord(root.adapter, "$.adapter", ["path", "bytes", "sha256", "revision"]);
  const parsedAdapter = Object.freeze({
    ...parseFile({ path: adapter.path, bytes: adapter.bytes, sha256: adapter.sha256 }, "$.adapter", cutYamnetLocalPolicy.maximumAdapterBytes),
    revision: token(adapter.revision, "$.adapter.revision"),
  });
  const environment = closedRecord(root.environment, "$.environment", ["revision", "files", "treeSha256"]);
  const environmentFiles = parseTree(environment.files, "$.environment.files");
  const parsedEnvironment = Object.freeze({
    revision: token(environment.revision, "$.environment.revision"),
    files: environmentFiles,
    treeSha256: digest(environment.treeSha256, "$.environment.treeSha256"),
  });
  if (treeDigest(environmentFiles) !== parsedEnvironment.treeSha256) {
    fail("CUT_YAMNET_CONTRACT", "$.environment.treeSha256 does not bind the exact manifest.");
  }
  const liteRt = closedRecord(root.liteRt, "$.liteRt", ["packageVersion", "declaredLicense", "files", "treeSha256"]);
  const liteRtFiles = parseTree(liteRt.files, "$.liteRt.files");
  const parsedLiteRt = Object.freeze({
    packageVersion: token(liteRt.packageVersion, "$.liteRt.packageVersion"),
    declaredLicense: text(liteRt.declaredLicense, "$.liteRt.declaredLicense"),
    files: liteRtFiles,
    treeSha256: digest(liteRt.treeSha256, "$.liteRt.treeSha256"),
  });
  if (treeDigest(liteRtFiles) !== parsedLiteRt.treeSha256) {
    fail("CUT_YAMNET_CONTRACT", "$.liteRt.treeSha256 does not bind the exact manifest.");
  }
  const environmentByPath = new Map(environmentFiles.map((file) => [file.relativePath, file]));
  for (const file of liteRtFiles) {
    const outer = environmentByPath.get(file.relativePath);
    if (!outer || outer.path !== file.path || outer.bytes !== file.bytes || outer.sha256 !== file.sha256) {
      fail("CUT_YAMNET_CONTRACT", "$.liteRt.files must be an exact subset of $.environment.files.");
    }
  }
  const parseAsset = (entry: unknown, path: string, maximumBytes: number) => {
    const item = closedRecord(entry, path, ["name", "revision", "declaredLicense", "declaredProvenance", "file"]);
    return Object.freeze({
      name: text(item.name, `${path}.name`),
      revision: token(item.revision, `${path}.revision`),
      declaredLicense: text(item.declaredLicense, `${path}.declaredLicense`),
      declaredProvenance: text(item.declaredProvenance, `${path}.declaredProvenance`, 2_048),
      file: parseFile(item.file, `${path}.file`, maximumBytes),
    });
  };
  return Object.freeze({
    python: parsedPython,
    adapter: parsedAdapter,
    environment: parsedEnvironment,
    liteRt: parsedLiteRt,
    model: parseAsset(root.model, "$.model", cutYamnetLocalPolicy.maximumModelBytes),
    classMap: parseAsset(root.classMap, "$.classMap", cutYamnetLocalPolicy.maximumClassMapBytes),
  });
}

/** Parse one closed machine-local setup record without executing its authorities. */
export function parseCutYamnetLocalSetup(value: unknown): CutYamnetLocalSetup {
  return parseSetup(value);
}

/** Canonical newline-terminated setup bytes suitable for create-only publication. */
export function cutYamnetLocalSetupBytes(value: unknown) {
  return canonicalBytes(parseSetup(value));
}

/** Resolve the adapter shipped beside the installed CUT package; callers never guess this path. */
export function resolveCutYamnetBundledAdapterPath() {
  return resolve(__dirname, "../../../adapters/audio-yamnet-local/sidecar.py");
}

/** Resolve CUT's exact ordered AudioSet label map shipped beside the adapter. */
export function resolveCutYamnetBundledClassMapPath() {
  return resolve(__dirname, "../../../adapters/audio-yamnet-local/yamnet_label_list.txt");
}

export function isCutYamnetLocalPlatformSupported(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
) {
  return (platform === "darwin" && architecture === "arm64")
    || (platform === "linux" && architecture === "x64");
}

function assertRuntimePlatform(setup: ReturnType<typeof parseSetup>) {
  const expectedMachine = process.arch === "x64" ? "x86_64" : process.arch;
  if (!isCutYamnetLocalPlatformSupported() || setup.python.platform !== process.platform || setup.python.machine !== expectedMachine) {
    fail("CUT_YAMNET_PLATFORM", "YAMNet local execution requires a bound darwin-arm64 or linux-x86_64 CPython matching the current host.");
  }
}

async function hashHandle(handle: FileHandle, size: bigint) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0n;
  while (position < size) {
    const length = Number(size - position > BigInt(buffer.length) ? BigInt(buffer.length) : size - position);
    const read = await handle.read(buffer, 0, length, Number(position));
    if (read.bytesRead !== length) fail("CUT_YAMNET_AUTHORITY", "authenticated file changed during hashing.");
    hash.update(buffer.subarray(0, read.bytesRead));
    position += BigInt(read.bytesRead);
  }
  return hash.digest("hex");
}

async function snapshotFile(path: string, maximumBytes: number, label: string, minimumBytes = 1): Promise<StableSnapshot> {
  let handle: FileHandle | undefined;
  try {
    const physical = await realpath(path);
    if (physical !== path) fail("CUT_YAMNET_AUTHORITY", `${label} must use its canonical physical path.`);
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < BigInt(minimumBytes) || before.size > BigInt(maximumBytes)) {
      fail("CUT_YAMNET_AUTHORITY", `${label} must be one bounded regular file.`);
    }
    const observed = await hashHandle(handle, before.size);
    const after = await handle.stat({ bigint: true });
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      fail("CUT_YAMNET_AUTHORITY", `${label} changed during authentication.`);
    }
    return Object.freeze({
      path,
      bytes: Number(before.size),
      sha256: observed,
      dev: before.dev,
      ino: before.ino,
      size: before.size,
      mtimeNs: before.mtimeNs,
      ctimeNs: before.ctimeNs,
    });
  } catch (error) {
    if (error instanceof CutYamnetLocalError) throw error;
    return fail("CUT_YAMNET_AUTHORITY", `${label} could not be authenticated.`);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function assertExpected(snapshot: StableSnapshot, authority: CutYamnetAuthenticatedFile, label: string) {
  if (snapshot.bytes !== authority.bytes || snapshot.sha256 !== authority.sha256) {
    fail("CUT_YAMNET_AUTHORITY", `${label} differs from its caller-supplied authority.`);
  }
}

async function assertUnchanged(snapshot: StableSnapshot, maximumBytes: number, label: string, minimumBytes = 1) {
  const current = await snapshotFile(snapshot.path, maximumBytes, label, minimumBytes);
  if (current.dev !== snapshot.dev || current.ino !== snapshot.ino || current.size !== snapshot.size
    || current.mtimeNs !== snapshot.mtimeNs || current.ctimeNs !== snapshot.ctimeNs || current.sha256 !== snapshot.sha256) {
    fail("CUT_YAMNET_AUTHORITY", `${label} changed during local YAMNet execution.`);
  }
}

async function createOwnedRoot(): Promise<OwnedRoot> {
  const path = await realpath(await mkdtemp(join(tmpdir(), "cut-yamnet-local-")));
  await chmod(path, 0o700);
  const state = await lstat(path, { bigint: true });
  if (!state.isDirectory() || (state.mode & 0o077n) !== 0n) {
    fail("CUT_YAMNET_AUTHORITY", "private YAMNet root is not owner-private.");
  }
  return Object.freeze({ path, dev: state.dev, ino: state.ino });
}

async function removeOwnedRoot(root: OwnedRoot) {
  let state;
  try { state = await lstat(root.path, { bigint: true }); }
  catch { fail("CUT_YAMNET_CLEANUP", "private YAMNet root disappeared before cleanup."); }
  if (!state.isDirectory() || state.isSymbolicLink() || state.dev !== root.dev || state.ino !== root.ino) {
    fail("CUT_YAMNET_CLEANUP", "private YAMNet root identity changed before cleanup.");
  }
  await rm(root.path, { recursive: true, force: false });
}

async function makePrivateDirectory(path: string) {
  await mkdir(path, { mode: 0o700 });
  await chmod(path, 0o700);
}

async function copyAuthenticatedFile(
  authority: CutYamnetAuthenticatedFile,
  destination: string,
  maximumBytes: number,
  label: string,
  allowEmpty = false,
  signal?: AbortSignal,
) {
  assertNotAborted(signal, `YAMNet staging was cancelled before ${label} authentication.`);
  const minimumBytes = allowEmpty ? 0 : 1;
  const snapshot = await snapshotFile(authority.path, maximumBytes, label, minimumBytes);
  assertExpected(snapshot, authority, label);
  let source: FileHandle | undefined;
  let output: FileHandle | undefined;
  try {
    source = await open(snapshot.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    output = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < snapshot.bytes) {
      assertNotAborted(signal, `YAMNet staging was cancelled while copying ${label}.`);
      const length = Math.min(buffer.byteLength, snapshot.bytes - position);
      const read = await source.read(buffer, 0, length, position);
      if (read.bytesRead !== length) fail("CUT_YAMNET_AUTHORITY", `${label} changed during staging.`);
      let written = 0;
      while (written < read.bytesRead) {
        const result = await output.write(buffer, written, read.bytesRead - written, position + written);
        if (result.bytesWritten < 1) fail("CUT_YAMNET_AUTHORITY", `${label} could not be staged completely.`);
        written += result.bytesWritten;
      }
      position += read.bytesRead;
    }
    assertNotAborted(signal, `YAMNet staging was cancelled after copying ${label}.`);
    await output.sync();
  } catch (error) {
    if (error instanceof CutYamnetLocalError) throw error;
    fail("CUT_YAMNET_AUTHORITY", `${label} could not be staged.`);
  } finally {
    await Promise.all([source?.close().catch(() => undefined), output?.close().catch(() => undefined)]);
  }
  const staged = await snapshotFile(destination, maximumBytes, `private ${label}`, minimumBytes);
  assertExpected(staged, authority, `private ${label}`);
  return snapshot;
}

async function copyTree(files: readonly CutYamnetAuthenticatedTreeFile[], root: string, label: string, signal?: AbortSignal) {
  const snapshots: StableSnapshot[] = [];
  for (const file of files) {
    assertNotAborted(signal, `YAMNet staging was cancelled while copying ${label}.`);
    const destination = join(root, ...file.relativePath.split("/"));
    await mkdir(resolve(destination, ".."), { recursive: true, mode: 0o700 });
    snapshots.push(await copyAuthenticatedFile(file, destination, cutYamnetLocalPolicy.maximumEnvironmentBytes, label, true, signal));
  }
  return snapshots;
}

function assertNotAborted(signal: AbortSignal | undefined, message: string) {
  if (signal?.aborted) fail("CUT_YAMNET_CANCELLED", message);
}

async function processGroupExists(pid: number) {
  try { process.kill(-pid, 0); return true; }
  catch (error) {
    return !(error && typeof error === "object" && "code" in error && error.code === "ESRCH");
  }
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number) {
  const end = Date.now() + timeoutMs;
  while (Date.now() <= end) {
    if (!(await processGroupExists(pid))) return true;
    await new Promise((accept) => setTimeout(accept, 10));
  }
  return !(await processGroupExists(pid));
}

async function runProvider(
  executable: string,
  args: readonly string[],
  cwd: string,
  stdin: Buffer,
  maximumStdoutBytes: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ProcessOutput> {
  return new Promise((accept, reject) => {
    if (signal?.aborted) {
      reject(new CutYamnetLocalError("CUT_YAMNET_CANCELLED", "YAMNet execution was cancelled before provider launch."));
      return;
    }
    let child;
    let childError: unknown;
    let onChildError = (error: unknown) => { childError = error; };
    try {
      child = spawn(executable, [...args], {
        shell: false,
        detached: true,
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: Object.freeze({
          HOME: join(cwd, "home"),
          TMPDIR: join(cwd, "tmp"),
          LANG: "C",
          LC_ALL: "C",
          PYTHONHASHSEED: "0",
          PYTHONDONTWRITEBYTECODE: "1",
          PYTHONNOUSERSITE: "1",
        }),
      });
    } catch {
      reject(new CutYamnetLocalError("CUT_YAMNET_PROCESS", "CPython could not be launched."));
      return;
    }
    child.once("error", (error) => onChildError(error));
    const observedPid = child.pid;
    if (!Number.isSafeInteger(observedPid) || Number(observedPid) < 1) {
      reject(new CutYamnetLocalError("CUT_YAMNET_PROCESS", "CPython launch did not yield one process identity."));
      return;
    }
    const pid = Number(observedPid);
    let failure: CutYamnetLocalError | undefined;
    let closed = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let killTimer: NodeJS.Timeout | undefined;
    const signalTree = (value: NodeJS.Signals) => {
      try { process.kill(-pid, value); return; } catch { /* direct-child fallback */ }
      try { child.kill(value); } catch { /* already closed */ }
    };
    const drain = async () => {
      if (!(await processGroupExists(pid))) return true;
      signalTree("SIGTERM");
      if (await waitForProcessGroupExit(pid, cutYamnetLocalPolicy.terminationGraceMs)) return true;
      signalTree("SIGKILL");
      return waitForProcessGroupExit(pid, cutYamnetLocalPolicy.terminationGraceMs);
    };
    const terminate = (error: CutYamnetLocalError) => {
      if (failure || closed) return;
      failure = error;
      signalTree("SIGTERM");
      killTimer = setTimeout(() => signalTree("SIGKILL"), cutYamnetLocalPolicy.terminationGraceMs);
    };
    const abort = () => terminate(new CutYamnetLocalError("CUT_YAMNET_CANCELLED", "YAMNet execution was cancelled."));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => terminate(new CutYamnetLocalError("CUT_YAMNET_TIMEOUT", `YAMNet execution exceeded ${timeoutMs}ms.`)), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (failure) return;
      const copy = Buffer.from(chunk);
      stdoutBytes += copy.byteLength;
      if (stdoutBytes > maximumStdoutBytes) terminate(new CutYamnetLocalError("CUT_YAMNET_OUTPUT", "YAMNet stdout exceeded its exact bound."));
      else stdout.push(copy);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (failure) return;
      const copy = Buffer.from(chunk);
      stderrBytes += copy.byteLength;
      if (stderrBytes > cutYamnetLocalPolicy.maximumStderrBytes) terminate(new CutYamnetLocalError("CUT_YAMNET_OUTPUT", "YAMNet stderr exceeded its byte bound."));
      else stderr.push(copy);
    });
    child.stdin.on("error", () => terminate(new CutYamnetLocalError("CUT_YAMNET_PROCESS", "YAMNet stdin failed before complete delivery.")));
    child.stdin.end(stdin);
    onChildError = () => terminate(new CutYamnetLocalError("CUT_YAMNET_PROCESS", "CPython failed after launch."));
    if (childError) onChildError(childError);
    child.once("close", async (code, terminalSignal) => {
      closed = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      const leftDescendant = await processGroupExists(pid);
      if (failure) {
        if (!(await drain())) reject(new CutYamnetLocalError("CUT_YAMNET_CLEANUP", "YAMNet process group survived forced cleanup."));
        else reject(failure);
        return;
      }
      if (leftDescendant && !(await drain())) {
        reject(new CutYamnetLocalError("CUT_YAMNET_CLEANUP", "YAMNet descendant survived forced cleanup."));
        return;
      }
      if (code !== 0 || terminalSignal !== null) {
        reject(new CutYamnetLocalError("CUT_YAMNET_PROCESS", "YAMNet provider exited unsuccessfully."));
        return;
      }
      if (leftDescendant) {
        reject(new CutYamnetLocalError("CUT_YAMNET_CLEANUP", "YAMNet left a descendant; CUT terminated and drained it."));
        return;
      }
      accept(Object.freeze({ stdout: Buffer.concat(stdout, stdoutBytes), stderr: Buffer.concat(stderr, stderrBytes) }));
    });
  });
}

function patchCount(samples: number) {
  return samples <= cutYamnetLocalPolicy.patchSamples
    ? 1
    : 1 + Math.ceil((samples - cutYamnetLocalPolicy.patchSamples) / cutYamnetLocalPolicy.patchHopSamples);
}

function parseClassMap(bytes: Buffer) {
  let textValue: string;
  try { textValue = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return fail("CUT_YAMNET_AUTHORITY", "YAMNet class map must be fatal UTF-8."); }
  if (bytes.includes(0) || !textValue.endsWith("\n") || textValue.includes("\r")) {
    fail("CUT_YAMNET_AUTHORITY", "YAMNet class map must be fatal UTF-8 text ending in LF.");
  }
  const labels = textValue.slice(0, -1).split("\n");
  if (labels.length !== cutYamnetLocalPolicy.classCount) {
    fail("CUT_YAMNET_AUTHORITY", "YAMNet class map must contain exactly 521 ordered label rows.");
  }
  for (let index = 0; index < cutYamnetLocalPolicy.classCount; index += 1) {
    text(labels[index], `classMap[${index}]`, 512);
  }
  return Object.freeze(labels);
}

async function readClassMap(authority: CutYamnetAuthenticatedFile) {
  let handle: FileHandle | undefined;
  let snapshot: StableSnapshot | undefined;
  try {
    const physical = await realpath(authority.path);
    if (physical !== authority.path) fail("CUT_YAMNET_AUTHORITY", "YAMNet class map must use its canonical physical path.");
    handle = await open(authority.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(cutYamnetLocalPolicy.maximumClassMapBytes)) {
      fail("CUT_YAMNET_AUTHORITY", "YAMNet class map must be one bounded regular file.");
    }
    const bytes = Buffer.alloc(Number(before.size));
    const read = await handle.read(bytes, 0, bytes.byteLength, 0);
    if (read.bytesRead !== bytes.byteLength) fail("CUT_YAMNET_AUTHORITY", "YAMNet class map changed while reading.");
    const after = await handle.stat({ bigint: true });
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      fail("CUT_YAMNET_AUTHORITY", "YAMNet class map changed while reading.");
    }
    snapshot = Object.freeze({
      path: authority.path,
      bytes: Number(before.size),
      sha256: sha256(bytes),
      dev: before.dev,
      ino: before.ino,
      size: before.size,
      mtimeNs: before.mtimeNs,
      ctimeNs: before.ctimeNs,
    });
    assertExpected(snapshot, authority, "YAMNet class map");
    const labels = parseClassMap(bytes);
    await assertUnchanged(snapshot, cutYamnetLocalPolicy.maximumClassMapBytes, "YAMNet class map");
    return Object.freeze({ labels, bytes: Buffer.from(bytes) });
  } catch (error) {
    if (error instanceof CutYamnetLocalError) throw error;
    fail("CUT_YAMNET_AUTHORITY", "YAMNet class map could not be authenticated and read.");
  } finally { await handle?.close().catch(() => undefined); }
}

function parseDoctorOutput(bytes: Buffer, setup: ReturnType<typeof parseSetup>) {
  let value: unknown;
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!source.endsWith("\n")) fail("CUT_YAMNET_OUTPUT", "doctor output must end in one LF.");
    value = JSON.parse(source);
  } catch (error) {
    if (error instanceof CutYamnetLocalError) throw error;
    fail("CUT_YAMNET_OUTPUT", "doctor output is not fatal UTF-8 JSON.");
  }
  const root = closedRecord(value, "$doctor", ["format", "version", "runtime", "model", "classMap", "policy"]);
  if (root.format !== cutYamnetLocalPolicy.adapterResultFormat || root.version !== 1) fail("CUT_YAMNET_OUTPUT", "doctor output has the wrong protocol identity.");
  const runtime = closedRecord(root.runtime, "$doctor.runtime", ["implementation", "pythonVersion", "platform", "machine", "liteRtVersion"]);
  const model = closedRecord(root.model, "$doctor.model", ["bytes", "sha256"]);
  const classMap = closedRecord(root.classMap, "$doctor.classMap", ["bytes", "sha256", "classCount"]);
  const policy = closedRecord(root.policy, "$doctor.policy", ["sampleRate", "patchSamples", "patchHopSamples", "rightPadFinalPatch", "classCount", "interpreterThreads"]);
  if (runtime.implementation !== setup.python.implementation || runtime.pythonVersion !== setup.python.pythonVersion
    || runtime.platform !== setup.python.platform || runtime.machine !== setup.python.machine
    || runtime.liteRtVersion !== setup.liteRt.packageVersion
    || model.bytes !== setup.model.file.bytes || model.sha256 !== setup.model.file.sha256
    || classMap.bytes !== setup.classMap.file.bytes || classMap.sha256 !== setup.classMap.file.sha256
    || classMap.classCount !== cutYamnetLocalPolicy.classCount
    || policy.sampleRate !== cutYamnetLocalPolicy.sampleRate || policy.patchSamples !== cutYamnetLocalPolicy.patchSamples
    || policy.patchHopSamples !== cutYamnetLocalPolicy.patchHopSamples || policy.rightPadFinalPatch !== true
    || policy.classCount !== cutYamnetLocalPolicy.classCount || policy.interpreterThreads !== cutYamnetLocalPolicy.interpreterThreads) {
    fail("CUT_YAMNET_OUTPUT", "doctor output differs from the authenticated setup or framing law.");
  }
  return Object.freeze({
    implementation: "CPython" as const,
    pythonVersion: setup.python.pythonVersion,
    platform: setup.python.platform,
    machine: setup.python.machine,
    liteRtVersion: setup.liteRt.packageVersion,
  });
}

type StagedRun = Readonly<{
  root: OwnedRoot;
  setup: ReturnType<typeof parseSetup>;
  snapshots: readonly Readonly<{ value: StableSnapshot; maximum: number; minimum: number; label: string }>[];
  arguments: readonly string[];
}>;

async function stageSetup(setup: ReturnType<typeof parseSetup>, mode: "doctor" | "analyze", signal?: AbortSignal) {
  assertNotAborted(signal, "YAMNet staging was cancelled before its private root was created.");
  const root = await createOwnedRoot();
  const snapshots: Array<Readonly<{ value: StableSnapshot; maximum: number; minimum: number; label: string }>> = [];
  try {
    const environmentRoot = join(root.path, "environment");
    await Promise.all([
      makePrivateDirectory(environmentRoot),
      makePrivateDirectory(join(root.path, "home")),
      makePrivateDirectory(join(root.path, "tmp")),
    ]);
    assertNotAborted(signal, "YAMNet staging was cancelled before executable authentication.");
    const python = await snapshotFile(setup.python.path, cutYamnetLocalPolicy.maximumPythonBytes, "CPython executable");
    assertExpected(python, setup.python, "CPython executable");
    snapshots.push({ value: python, maximum: cutYamnetLocalPolicy.maximumPythonBytes, minimum: 1, label: "CPython executable" });
    const adapter = await copyAuthenticatedFile(setup.adapter, join(root.path, "adapter.py"), cutYamnetLocalPolicy.maximumAdapterBytes, "YAMNet adapter", false, signal);
    snapshots.push({ value: adapter, maximum: cutYamnetLocalPolicy.maximumAdapterBytes, minimum: 1, label: "YAMNet adapter" });
    for (const snapshot of await copyTree(setup.environment.files, environmentRoot, "YAMNet environment file", signal)) {
      snapshots.push({ value: snapshot, maximum: cutYamnetLocalPolicy.maximumEnvironmentBytes, minimum: 0, label: "YAMNet environment file" });
    }
    const model = await copyAuthenticatedFile(setup.model.file, join(root.path, "model.tflite"), cutYamnetLocalPolicy.maximumModelBytes, "YAMNet model", false, signal);
    const classMap = await copyAuthenticatedFile(setup.classMap.file, join(root.path, "labels.txt"), cutYamnetLocalPolicy.maximumClassMapBytes, "YAMNet class map", false, signal);
    snapshots.push(
      { value: model, maximum: cutYamnetLocalPolicy.maximumModelBytes, minimum: 1, label: "YAMNet model" },
      { value: classMap, maximum: cutYamnetLocalPolicy.maximumClassMapBytes, minimum: 1, label: "YAMNet class map" },
    );
    assertNotAborted(signal, "YAMNet staging was cancelled before provider arguments were sealed.");
    const args = Object.freeze([
      "-I", "-B", "-S", "-s", join(root.path, "adapter.py"),
      "--mode", mode,
      "--environment-root", environmentRoot,
      "--litert-version", setup.liteRt.packageVersion,
      "--interpreter-threads", String(cutYamnetLocalPolicy.interpreterThreads),
      "--model", join(root.path, "model.tflite"),
      "--model-bytes", String(setup.model.file.bytes),
      "--model-sha256", setup.model.file.sha256,
      "--class-map", join(root.path, "labels.txt"),
      "--class-map-bytes", String(setup.classMap.file.bytes),
      "--class-map-sha256", setup.classMap.file.sha256,
    ]);
    return Object.freeze({ root, setup, snapshots: Object.freeze(snapshots), arguments: args });
  } catch (error) {
    try { await removeOwnedRoot(root); }
    catch { fail("CUT_YAMNET_CLEANUP", "private YAMNet staging failed and its owned root could not be removed."); }
    throw error;
  }
}

async function assertStagedSourcesUnchanged(staged: StagedRun) {
  for (const item of staged.snapshots) await assertUnchanged(item.value, item.maximum, item.label, item.minimum);
}

function authorityReceipt(setup: ReturnType<typeof parseSetup>) {
  return Object.freeze({
    pythonSha256: setup.python.sha256,
    adapterSha256: setup.adapter.sha256,
    environmentTreeSha256: setup.environment.treeSha256,
    liteRtTreeSha256: setup.liteRt.treeSha256,
    modelSha256: setup.model.file.sha256,
    classMapSha256: setup.classMap.file.sha256,
  });
}

function declarationReceipt(setup: ReturnType<typeof parseSetup>) {
  return Object.freeze({
    callerDeclared: true as const,
    liteRtLicense: setup.liteRt.declaredLicense,
    model: Object.freeze({
      name: setup.model.name,
      revision: setup.model.revision,
      license: setup.model.declaredLicense,
      provenance: setup.model.declaredProvenance,
    }),
    classMap: Object.freeze({
      name: setup.classMap.name,
      revision: setup.classMap.revision,
      license: setup.classMap.declaredLicense,
      provenance: setup.classMap.declaredProvenance,
    }),
  });
}

export async function doctorYamnetLocal(
  setupValue: CutYamnetLocalSetup,
  options: Readonly<{ timeoutMs?: number; signal?: AbortSignal }> = {},
): Promise<CutYamnetDoctorReceipt> {
  const setup = parseSetup(setupValue);
  assertRuntimePlatform(setup);
  await readClassMap(setup.classMap.file);
  const optionsRecord = closedRecord(options, "$options", [], ["timeoutMs", "signal"]);
  const timeoutMs = optionsRecord.timeoutMs === undefined
    ? cutYamnetLocalPolicy.defaultTimeoutMs
    : integer(optionsRecord.timeoutMs, "$options.timeoutMs", 1, cutYamnetLocalPolicy.maximumTimeoutMs);
  if (optionsRecord.signal !== undefined && !(optionsRecord.signal instanceof AbortSignal)) fail("CUT_YAMNET_CONTRACT", "$options.signal must be one AbortSignal.");
  const signal = optionsRecord.signal as AbortSignal | undefined;
  if (signal?.aborted) fail("CUT_YAMNET_CANCELLED", "YAMNet doctor was cancelled before staging.");
  const staged = await stageSetup(setup, "doctor", signal);
  let result: CutYamnetDoctorReceipt | undefined;
  let primaryError: unknown;
  try {
    let output: ProcessOutput | undefined;
    try {
      assertNotAborted(signal, "YAMNet doctor was cancelled after staging.");
      output = await runProvider(setup.python.path, staged.arguments, staged.root.path, Buffer.alloc(0), cutYamnetLocalPolicy.maximumDoctorBytes, timeoutMs, signal);
    } catch (error) { primaryError = error; }
    await assertStagedSourcesUnchanged(staged);
    if (primaryError) throw primaryError;
    const runtime = parseDoctorOutput(output!.stdout, setup);
    const body = Object.freeze({
      format: "cut-yamnet-local-doctor" as const,
      version: 1 as const,
      status: "PASS" as const,
      provider: cutYamnetLocalPolicy.provider,
      runtime,
      authorities: authorityReceipt(setup),
      declarations: declarationReceipt(setup),
      policy: Object.freeze({
        sampleRate: 16_000 as const,
        patchSamples: 15_600 as const,
        patchHopSamples: 7_680 as const,
        rightPadFinalPatch: true as const,
        classCount: 521 as const,
        interpreterThreads: 1 as const,
      }),
      evidenceScope: Object.freeze({
        authority: cutYamnetLocalPolicy.authorityScope,
        licenses: cutYamnetLocalPolicy.licenseBoundary,
        locality: cutYamnetLocalPolicy.localityBoundary,
      }),
      stderr: Object.freeze({ bytes: output!.stderr.byteLength, sha256: sha256(output!.stderr) }),
    });
    result = Object.freeze({ ...body, receiptSha256: sha256(stableJsonStringify(body)) });
  } catch (error) { primaryError = error; }
  let cleanupError: unknown;
  try { await removeOwnedRoot(staged.root); } catch (error) { cleanupError = error; }
  if (cleanupError) throw cleanupError;
  if (primaryError) throw primaryError;
  return result!;
}

function validatePcm(value: Buffer) {
  if (!Buffer.isBuffer(value) || value.byteLength < 4 || value.byteLength % 4 !== 0
    || value.byteLength > cutYamnetLocalPolicy.maximumDurationSamples * 4) {
    fail("CUT_YAMNET_CONTRACT", "PCM must be 1 through 160000 mono f32le samples.");
  }
  for (let offset = 0; offset < value.byteLength; offset += 4) {
    const sample = value.readFloatLE(offset);
    if (!Number.isFinite(sample) || sample < -1 || sample > 1) {
      fail("CUT_YAMNET_CONTRACT", `PCM sample ${offset / 4} must be finite and normalized to [-1,1].`);
    }
  }
  return Buffer.from(value);
}

function stableTop(scores: readonly number[], labels: readonly string[], count: number) {
  return Object.freeze(scores.map((score, classIndex) => Object.freeze({ classIndex, label: labels[classIndex]!, score }))
    .sort((left, right) => right.score - left.score || left.classIndex - right.classIndex)
    .slice(0, count));
}

export async function analyzeWithYamnetLocal(inputValue: Readonly<{
  setup: CutYamnetLocalSetup;
  pcm: Buffer;
  topK: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}>): Promise<CutYamnetLocalAnalysisResult> {
  const input = closedRecord(inputValue, "$", ["setup", "pcm", "topK"], ["timeoutMs", "signal"]);
  const setup = parseSetup(input.setup as CutYamnetLocalSetup);
  assertRuntimePlatform(setup);
  const pcm = validatePcm(input.pcm as Buffer);
  const topK = integer(input.topK, "$.topK", 1, cutYamnetLocalPolicy.maximumTopK);
  const timeoutMs = input.timeoutMs === undefined
    ? cutYamnetLocalPolicy.defaultTimeoutMs
    : integer(input.timeoutMs, "$.timeoutMs", 1, cutYamnetLocalPolicy.maximumTimeoutMs);
  if (input.signal !== undefined && !(input.signal instanceof AbortSignal)) fail("CUT_YAMNET_CONTRACT", "$.signal must be one AbortSignal.");
  const signal = input.signal as AbortSignal | undefined;
  if (signal?.aborted) fail("CUT_YAMNET_CANCELLED", "YAMNet analysis was cancelled before staging.");
  const classMap = await readClassMap(setup.classMap.file);
  const labels = classMap.labels;
  const samples = pcm.byteLength / 4;
  const count = patchCount(samples);
  const scoreByteCount = count * cutYamnetLocalPolicy.classCount * 4;
  const staged = await stageSetup(setup, "analyze", signal);
  let result: CutYamnetLocalAnalysisResult | undefined;
  let primaryError: unknown;
  try {
    let output: ProcessOutput | undefined;
    try {
      assertNotAborted(signal, "YAMNet analysis was cancelled after staging.");
      output = await runProvider(setup.python.path, staged.arguments, staged.root.path, pcm, scoreByteCount, timeoutMs, signal);
    } catch (error) { primaryError = error; }
    await assertStagedSourcesUnchanged(staged);
    if (primaryError) throw primaryError;
    if (output!.stdout.byteLength !== scoreByteCount) {
      fail("CUT_YAMNET_OUTPUT", `YAMNet returned ${output!.stdout.byteLength} score bytes; exactly ${scoreByteCount} were required.`);
    }
    const sums = Array<number>(cutYamnetLocalPolicy.classCount).fill(0);
    const patches: Array<Readonly<{
      patchIndex: number;
      startSample: number;
      validSamples: number;
      topClasses: readonly CutYamnetTopClass[];
    }>> = [];
    for (let patchIndex = 0; patchIndex < count; patchIndex += 1) {
      const scores: number[] = [];
      for (let classIndex = 0; classIndex < cutYamnetLocalPolicy.classCount; classIndex += 1) {
        const score = output!.stdout.readFloatLE((patchIndex * cutYamnetLocalPolicy.classCount + classIndex) * 4);
        if (!Number.isFinite(score) || score < 0 || score > 1) {
          fail("CUT_YAMNET_OUTPUT", `YAMNet score [${patchIndex},${classIndex}] must be finite and within [0,1].`);
        }
        scores.push(score);
        sums[classIndex] += score;
      }
      const startSample = patchIndex * cutYamnetLocalPolicy.patchHopSamples;
      patches.push(Object.freeze({
        patchIndex,
        startSample,
        validSamples: Math.max(0, Math.min(cutYamnetLocalPolicy.patchSamples, samples - startSample)),
        topClasses: stableTop(scores, labels, topK),
      }));
    }
    const aggregate = sums.map((sum) => sum / count);
    const body = Object.freeze({
      format: "cut-yamnet-local-analysis" as const,
      version: 1 as const,
      provider: cutYamnetLocalPolicy.provider,
      input: Object.freeze({
        sampleFormat: "f32le" as const,
        sampleRate: 16_000 as const,
        channels: 1 as const,
        samples,
        bytes: pcm.byteLength,
        sha256: sha256(pcm),
      }),
      framing: Object.freeze({
        patchSamples: 15_600 as const,
        patchHopSamples: 7_680 as const,
        rightPadFinalPatch: true as const,
        patchCount: count,
      }),
      rawScores: Object.freeze({
        classCount: 521 as const,
        sampleFormat: "f32le" as const,
        bytes: scoreByteCount,
        sha256: sha256(output!.stdout),
      }),
      stderr: Object.freeze({ bytes: output!.stderr.byteLength, sha256: sha256(output!.stderr) }),
      topK,
      aggregateTopClasses: stableTop(aggregate, labels, topK),
      patches: Object.freeze(patches),
      authorities: authorityReceipt(setup),
      declarations: declarationReceipt(setup),
      evidenceScope: Object.freeze({
        authority: cutYamnetLocalPolicy.authorityScope,
        licenses: cutYamnetLocalPolicy.licenseBoundary,
        locality: cutYamnetLocalPolicy.localityBoundary,
        inference: cutYamnetLocalPolicy.inferenceBoundary,
      }),
    });
    const analysis: CutYamnetLocalAnalysis = Object.freeze({ ...body, analysisSha256: sha256(stableJsonStringify(body)) });
    result = Object.freeze({
      analysis,
      analysisBytes: canonicalBytes(analysis),
      rawScoreBytes: Buffer.from(output!.stdout),
      classMapBytes: Buffer.from(classMap.bytes),
    });
  } catch (error) { primaryError = error; }
  let cleanupError: unknown;
  try { await removeOwnedRoot(staged.root); } catch (error) { cleanupError = error; }
  if (cleanupError) throw cleanupError;
  if (primaryError) throw primaryError;
  return result!;
}

async function collectTree(rootValue: string, roots: readonly string[]) {
  const root = await realpath(absolutePath(rootValue, "$collector.sitePackagesRoot"));
  const state = await lstat(root, { bigint: true });
  if (!state.isDirectory() || state.isSymbolicLink() || (state.mode & 0o022n) !== 0n) {
    fail("CUT_YAMNET_AUTHORITY", "environment root must be one physical directory not writable by group or other.");
  }
  const paths = new Set<string>();
  const visit = async (path: string) => {
    const local = relative(root, path);
    if (!local || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) {
      fail("CUT_YAMNET_AUTHORITY", "environment collection escaped its root.");
    }
    const observed = await lstat(path, { bigint: true });
    if (observed.isSymbolicLink()) fail("CUT_YAMNET_AUTHORITY", "environment contains a symbolic link.");
    if (observed.isDirectory()) {
      if (path.endsWith(`${sep}__pycache__`)) return;
      for (const name of (await readdir(path)).sort()) await visit(join(path, name));
    } else if (observed.isFile()) {
      if (!path.endsWith(".pyc")) paths.add(path);
    } else fail("CUT_YAMNET_AUTHORITY", "environment contains an unsupported filesystem entry.");
  };
  const normalizedRoots = roots.map((entry, index) => relativePath(entry, `$collector.roots[${index}]`));
  if (new Set(normalizedRoots).size !== normalizedRoots.length) fail("CUT_YAMNET_CONTRACT", "$collector.roots repeats an entry.");
  for (const entry of normalizedRoots.sort()) await visit(resolve(root, entry));
  if (paths.size < 1 || paths.size > cutYamnetLocalPolicy.maximumEnvironmentFiles) {
    fail("CUT_YAMNET_AUTHORITY", "environment file count is outside the supported bound.");
  }
  const files = await Promise.all([...paths].map(async (path) => {
    const snapshot = await snapshotFile(path, cutYamnetLocalPolicy.maximumEnvironmentBytes, "environment file", 0);
    return Object.freeze({ path, relativePath: relative(root, path).split(sep).join("/"), bytes: snapshot.bytes, sha256: snapshot.sha256 });
  }));
  const sorted = Object.freeze(files.sort((left, right) => left.relativePath.localeCompare(right.relativePath)));
  let total = 0;
  for (const file of sorted) {
    total += file.bytes;
    if (!Number.isSafeInteger(total) || total > cutYamnetLocalPolicy.maximumEnvironmentBytes) fail("CUT_YAMNET_AUTHORITY", "environment exceeds the total-byte bound.");
  }
  return sorted;
}

/** Authenticate an already-installed, caller-selected local environment. No setup, download, or inference occurs. */
export async function collectYamnetLocalSetup(pathsValue: unknown): Promise<CutYamnetLocalSetup> {
  const paths = closedRecord(pathsValue, "$collector", ["python", "adapter", "environment", "liteRt", "model", "classMap"]);
  const python = closedRecord(paths.python, "$collector.python", ["path", "pythonVersion", "platform", "machine"]);
  const adapter = closedRecord(paths.adapter, "$collector.adapter", ["path", "revision"]);
  const environment = closedRecord(paths.environment, "$collector.environment", ["sitePackagesRoot", "roots", "revision"]);
  const liteRt = closedRecord(paths.liteRt, "$collector.liteRt", ["roots", "packageVersion", "declaredLicense"]);
  const parseCollectorAsset = (value: unknown, path: string) => closedRecord(value, path, ["path", "name", "revision", "declaredLicense", "declaredProvenance"]);
  const model = parseCollectorAsset(paths.model, "$collector.model");
  const classMap = parseCollectorAsset(paths.classMap, "$collector.classMap");
  if (!Array.isArray(environment.roots) || !Array.isArray(liteRt.roots)) fail("CUT_YAMNET_CONTRACT", "collector roots must be arrays.");
  const [pythonFile, adapterFile, environmentFiles, liteRtFiles, modelFile, classMapFile] = await Promise.all([
    snapshotFile(await realpath(absolutePath(python.path, "$collector.python.path")), cutYamnetLocalPolicy.maximumPythonBytes, "CPython executable"),
    snapshotFile(await realpath(absolutePath(adapter.path, "$collector.adapter.path")), cutYamnetLocalPolicy.maximumAdapterBytes, "YAMNet adapter"),
    collectTree(environment.sitePackagesRoot as string, environment.roots as readonly string[]),
    collectTree(environment.sitePackagesRoot as string, liteRt.roots as readonly string[]),
    snapshotFile(await realpath(absolutePath(model.path, "$collector.model.path")), cutYamnetLocalPolicy.maximumModelBytes, "YAMNet model"),
    snapshotFile(await realpath(absolutePath(classMap.path, "$collector.classMap.path")), cutYamnetLocalPolicy.maximumClassMapBytes, "YAMNet class map"),
  ]);
  const file = (value: StableSnapshot) => Object.freeze({ path: value.path, bytes: value.bytes, sha256: value.sha256 });
  const platform = python.platform === "darwin" || python.platform === "linux" ? python.platform : fail("CUT_YAMNET_CONTRACT", "$collector.python.platform must be darwin or linux.");
  const machine = python.machine === "arm64" || python.machine === "x86_64" ? python.machine : fail("CUT_YAMNET_CONTRACT", "$collector.python.machine must be arm64 or x86_64.");
  const setup = Object.freeze({
    python: Object.freeze({ ...file(pythonFile), implementation: "CPython" as const, pythonVersion: token(python.pythonVersion, "$collector.python.pythonVersion"), platform, machine }),
    adapter: Object.freeze({ ...file(adapterFile), revision: token(adapter.revision, "$collector.adapter.revision") }),
    environment: Object.freeze({ revision: token(environment.revision, "$collector.environment.revision"), files: environmentFiles, treeSha256: treeDigest(environmentFiles) }),
    liteRt: Object.freeze({
      packageVersion: token(liteRt.packageVersion, "$collector.liteRt.packageVersion"),
      declaredLicense: text(liteRt.declaredLicense, "$collector.liteRt.declaredLicense"),
      files: liteRtFiles,
      treeSha256: treeDigest(liteRtFiles),
    }),
    model: Object.freeze({
      name: text(model.name, "$collector.model.name"), revision: token(model.revision, "$collector.model.revision"),
      declaredLicense: text(model.declaredLicense, "$collector.model.declaredLicense"),
      declaredProvenance: text(model.declaredProvenance, "$collector.model.declaredProvenance", 2_048), file: file(modelFile),
    }),
    classMap: Object.freeze({
      name: text(classMap.name, "$collector.classMap.name"), revision: token(classMap.revision, "$collector.classMap.revision"),
      declaredLicense: text(classMap.declaredLicense, "$collector.classMap.declaredLicense"),
      declaredProvenance: text(classMap.declaredProvenance, "$collector.classMap.declaredProvenance", 2_048), file: file(classMapFile),
    }),
  });
  parseSetup(setup);
  await readClassMap(setup.classMap.file);
  return setup;
}

/** Authenticate a caller-installed environment while injecting CUT's exact bundled adapter. */
export async function collectBundledYamnetLocalSetup(recipeValue: unknown): Promise<CutYamnetLocalSetup> {
  const recipe = closedRecord(recipeValue, "$recipe", ["python", "environment", "liteRt", "model"]);
  return collectYamnetLocalSetup({
    python: recipe.python,
    adapter: Object.freeze({
      path: resolveCutYamnetBundledAdapterPath(),
      revision: cutYamnetBundledAdapterRevision,
    }),
    environment: recipe.environment,
    liteRt: recipe.liteRt,
    model: recipe.model,
    classMap: Object.freeze({
      path: resolveCutYamnetBundledClassMapPath(),
      name: "YAMNet AudioSet class map",
      revision: cutYamnetBundledClassMapRevision,
      declaredLicense: "CC-BY-4.0",
      declaredProvenance: "Google AudioSet ontology display labels bundled by CUT in exact YAMNet class-index order.",
    }),
  });
}
