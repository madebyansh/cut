import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  readdir,
  realpath,
  rmdir,
  type FileHandle,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { types as utilTypes } from "node:util";
import { stableJsonStringify } from "../core/stable";
import { validateProjectLocator } from "../project/manifest";
import { ensureProjectWriteDirectory, writeProjectArtifacts } from "../project/write-boundary";
import {
  materializeAudioTranscription,
  type AudioTranscriptionSettings,
  type CutAudioTranscriptionReceipt,
} from "./transcription";

export const cutWhisperLocalWorkflowContract = Object.freeze({
  format: "cut-whisper-local-setup",
  version: 1,
  acquisition: "explicit-user-supplied-network-bearing-setup",
  runtime: "offline-local-files-only",
  osNetworkSandbox: "not-provided",
  provider: "caller-authenticated-compatible-whisper-cli-json-v1",
  authorityScope: "caller-declared-provenance-authenticated-bytes-compatible-behavior-v1",
  normalization: "ffmpeg-mono-16000hz-pcm-s16le-wave-v1",
  timestampPolicy: "millisecond-start-floor-end-ceil-shared-boundary-snap-v2",
  tiedBoundaryPolicy: "zero-duration-word-one-sample-next-tied-start-push-v1",
  devicePolicy: "cpu-only-no-gpu-v1",
  whisperVersion: "1.9.2",
  whisperSourceRevision: "whisper.cpp-v1.9.2",
  whisperSourceArchiveSha256: "a6abd064fcca8b85e794d205abf328c522e9451db43a3eadc178b883b7d0e9cd",
  whisperBuildPolicy: "darwin-arm64-static-cpu-accelerate-v1",
  whisperLinkagePolicy: "darwin-system-libraries-only-v1",
  allowedWhisperDylibs: Object.freeze([
    "/usr/lib/libSystem.B.dylib",
    "/usr/lib/libc++.1.dylib",
    "/System/Library/Frameworks/Accelerate.framework/Versions/A/Accelerate",
  ]),
  maximumSourceBytes: 64 * 1024 * 1024 * 1024,
  maximumExecutableBytes: 512 * 1024 * 1024,
  maximumModelBytes: 16 * 1024 * 1024 * 1024,
  maximumWaveBytes: 8 * 1024 * 1024 * 1024,
  maximumJsonBytes: 64 * 1024 * 1024,
  maximumStdoutBytes: 64 * 1024,
  maximumStderrBytes: 256 * 1024,
  maximumWords: 250_000,
  defaultTimeoutMs: 10 * 60_000,
  maximumTimeoutMs: 30 * 60_000,
  terminationGraceMs: 250,
} as const);

type AuthenticatedFile = Readonly<{ path: string; bytes: number; sha256: string }>;

export type CutWhisperLocalExecutableAuthority = AuthenticatedFile & Readonly<{
  version: string;
  revision: string;
}>;

export type CutWhisperLocalCliAuthority = CutWhisperLocalExecutableAuthority & Readonly<{
  sourceArchiveSha256: string;
  buildPolicy: string;
  linkagePolicy: typeof cutWhisperLocalWorkflowContract.whisperLinkagePolicy;
}>;

export type CutWhisperLocalModelAuthority = AuthenticatedFile & Readonly<{
  locator: string;
  name: string;
  revision: string;
  license: string;
}>;

export type CutWhisperLocalSetup = Readonly<{
  format: typeof cutWhisperLocalWorkflowContract.format;
  version: typeof cutWhisperLocalWorkflowContract.version;
  acquisition: typeof cutWhisperLocalWorkflowContract.acquisition;
  runtime: typeof cutWhisperLocalWorkflowContract.runtime;
  ffmpeg: CutWhisperLocalExecutableAuthority;
  whisperCli: CutWhisperLocalCliAuthority;
  model: CutWhisperLocalModelAuthority;
}>;

export type CutWhisperLocalSourceAuthority = Readonly<{
  locator: string;
  bytes: number;
  sha256: string;
  streamIndex: number;
  sampleRate: number;
  durationSamples: number;
}>;

export type CutWhisperLocalTranscriptionInput = Readonly<{
  projectRoot: string;
  setup: CutWhisperLocalSetup;
  source: CutWhisperLocalSourceAuthority;
  settings: AudioTranscriptionSettings;
  threads: number;
  transcriptLocator: string;
  receiptLocator: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}>;

export type CutWhisperLocalDoctorReport = Readonly<{
  format: "cut-whisper-local-doctor";
  version: 1;
  status: "caller-authority-ready";
  authorityScope: typeof cutWhisperLocalWorkflowContract.authorityScope;
  platform: NodeJS.Platform;
  runtime: typeof cutWhisperLocalWorkflowContract.runtime;
  osNetworkSandbox: typeof cutWhisperLocalWorkflowContract.osNetworkSandbox;
  ffmpeg: Readonly<{ bytes: number; sha256: string; version: string; declaredRevision: string }>;
  whisperCli: Readonly<{
    bytes: number;
    sha256: string;
    version: string;
    declaredRevision: string;
    declaredSourceArchiveSha256: string;
    declaredBuildPolicy: string;
    verifiedLinkagePolicy: string;
    loadedDylibs: readonly string[];
  }>;
  model: Readonly<{ locator: string; bytes: number; sha256: string; declaredName: string; declaredRevision: string; declaredLicense: string }>;
  modelInferenceSmoke: "unperformed-until-transcription";
}>;

export type CutWhisperLocalWorkflowReceiptBody = Readonly<{
  format: "cut-whisper-local-workflow-receipt";
  version: 1;
  status: "executed-caller-authenticated-compatible-whisper-cli";
  authorityScope: typeof cutWhisperLocalWorkflowContract.authorityScope;
  runtime: typeof cutWhisperLocalWorkflowContract.runtime;
  osNetworkSandbox: typeof cutWhisperLocalWorkflowContract.osNetworkSandbox;
  source: CutWhisperLocalSourceAuthority;
  ffmpeg: Readonly<{ bytes: number; sha256: string; version: string; declaredRevision: string }>;
  whisperCli: Readonly<{
    bytes: number;
    sha256: string;
    version: string;
    declaredRevision: string;
    declaredSourceArchiveSha256: string;
    declaredBuildPolicy: string;
    verifiedLinkagePolicy: string;
    loadedDylibs: readonly string[];
  }>;
  model: Readonly<{ locator: string; bytes: number; sha256: string; declaredName: string; declaredRevision: string; declaredLicense: string }>;
  policy: Readonly<{
    provider: typeof cutWhisperLocalWorkflowContract.provider;
    normalization: typeof cutWhisperLocalWorkflowContract.normalization;
    timestamps: typeof cutWhisperLocalWorkflowContract.timestampPolicy;
    adjacentBoundarySnapCount: number;
    tiedBoundaries: typeof cutWhisperLocalWorkflowContract.tiedBoundaryPolicy;
    tiedBoundaryRepairCount: number;
    device: typeof cutWhisperLocalWorkflowContract.devicePolicy;
    threads: number;
    invocation: readonly string[];
    invocationSha256: string;
  }>;
  normalizedPcm: Readonly<{
    waveBytes: number;
    waveSha256: string;
    pcmBytes: number;
    pcmSha256: string;
    sampleFormat: "s16le";
    sampleRate: 16_000;
    channels: 1;
    durationSamples: number;
  }>;
  providerJson: Readonly<{ semanticBytes: number; semanticSha256: string; wordCount: number }>;
  transcriptionReceipt: CutAudioTranscriptionReceipt;
  transcriptSha256: string;
}>;

export type CutWhisperLocalWorkflowReceipt = CutWhisperLocalWorkflowReceiptBody & Readonly<{
  receiptSha256: string;
}>;

export type CutWhisperLocalWorkflowResult = Readonly<{
  transcriptPath: string;
  receiptPath: string;
  transcriptSha256: string;
  receipt: CutWhisperLocalWorkflowReceipt;
}>;

export type CutWhisperLocalWorkflowErrorCode =
  | "CUT_WHISPER_WORKFLOW_CONTRACT"
  | "CUT_WHISPER_WORKFLOW_AUTHORITY"
  | "CUT_WHISPER_WORKFLOW_PROCESS"
  | "CUT_WHISPER_WORKFLOW_OUTPUT"
  | "CUT_WHISPER_WORKFLOW_CANCELLED"
  | "CUT_WHISPER_WORKFLOW_PUBLISH";

export class CutWhisperLocalWorkflowError extends Error {
  constructor(readonly code: CutWhisperLocalWorkflowErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "CutWhisperLocalWorkflowError";
  }
}

type Snapshot = Readonly<{
  path: string;
  bytes: number;
  sha256: string;
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;
type Retained = Readonly<{ handle: FileHandle; snapshot: Snapshot }>;
type Stage = Readonly<{
  root: string;
  parent: string;
  parentHandle: FileHandle;
  parentDev: bigint;
  parentIno: bigint;
  handle: FileHandle;
  dev: bigint;
  ino: bigint;
}>;

type WhisperExecutableClosure = Readonly<{
  format: "mach-o-64-little-endian";
  architecture: "arm64";
  loadedDylibs: readonly string[];
}>;

const shaPattern = /^[a-f0-9]{64}$/u;
const safeTextPattern = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$/u;

function fail(code: CutWhisperLocalWorkflowErrorCode, detail: string): never {
  throw new CutWhisperLocalWorkflowError(code, detail);
}
function sha256(value: Uint8Array | string) { return createHash("sha256").update(value).digest("hex"); }
function canonicalBytes(value: unknown) { return Buffer.from(`${stableJsonStringify(value)}\n`, "utf8"); }

function closed(value: unknown, path: string, required: readonly string[], optional: readonly string[] = []) {
  if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) {
    fail("CUT_WHISPER_WORKFLOW_CONTRACT", `${path} must be one non-proxy plain data object.`);
  }
  let prototype: object | null, keys: readonly PropertyKey[], descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return fail("CUT_WHISPER_WORKFLOW_CONTRACT", `${path} must be one inspectable plain data object.`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    fail("CUT_WHISPER_WORKFLOW_CONTRACT", `${path} must be one plain data object.`);
  }
  const allowed = new Set([...required, ...optional]);
  const item: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== "string") fail("CUT_WHISPER_WORKFLOW_CONTRACT", `${path} must not contain symbol fields.`);
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      fail("CUT_WHISPER_WORKFLOW_CONTRACT", `${path}.${key} must be one enumerable data field.`);
    }
    if (!allowed.has(key)) fail("CUT_WHISPER_WORKFLOW_CONTRACT", `${path}.${key} is not part of the closed contract.`);
    item[key] = descriptor.value;
  }
  for (const key of required) if (!Object.hasOwn(item, key)) fail("CUT_WHISPER_WORKFLOW_CONTRACT", `${path}.${key} is required.`);
  return Object.freeze(item);
}
function text(value: unknown, path: string, maximumBytes = 4_096) {
  if (typeof value !== "string" || !value || value !== value.trim() || value.normalize("NFC") !== value
    || !safeTextPattern.test(value) || Buffer.byteLength(value, "utf8") > maximumBytes) {
    fail("CUT_WHISPER_WORKFLOW_CONTRACT", `${path} must be bounded, trimmed, NFC, control-free text.`);
  }
  return value;
}
function integer(value: unknown, path: string, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    fail("CUT_WHISPER_WORKFLOW_CONTRACT", `${path} must be an integer from ${minimum} through ${maximum}.`);
  }
  return Number(value);
}
function digest(value: unknown, path: string) {
  if (typeof value !== "string" || !shaPattern.test(value)) fail("CUT_WHISPER_WORKFLOW_CONTRACT", `${path} must be one lowercase SHA-256 digest.`);
  return value;
}
function absolutePath(value: unknown, path: string) {
  const candidate = text(value, path, 16_384);
  if (!isAbsolute(candidate) || resolve(candidate) !== candidate || candidate.includes("\\")
    || candidate.split("/").some((part, index) => index > 0 && (!part || part === "." || part === ".."))) {
    fail("CUT_WHISPER_WORKFLOW_CONTRACT", `${path} must be one canonical absolute POSIX path.`);
  }
  return candidate;
}
function projectLocator(value: unknown, path: string) {
  try { return validateProjectLocator(value, path); }
  catch { return fail("CUT_WHISPER_WORKFLOW_CONTRACT", `${path} must be one canonical project locator.`); }
}
function parseFile(value: unknown, path: string, maximumBytes: number) {
  const item = closed(value, path, ["path", "bytes", "sha256"]);
  return Object.freeze({
    path: absolutePath(item.path, `${path}.path`),
    bytes: integer(item.bytes, `${path}.bytes`, 1, maximumBytes),
    sha256: digest(item.sha256, `${path}.sha256`),
  });
}

export function parseCutWhisperLocalSetup(value: unknown): CutWhisperLocalSetup {
  const item = closed(value, "$setup", ["format", "version", "acquisition", "runtime", "ffmpeg", "whisperCli", "model"]);
  if (item.format !== cutWhisperLocalWorkflowContract.format || item.version !== cutWhisperLocalWorkflowContract.version
    || item.acquisition !== cutWhisperLocalWorkflowContract.acquisition || item.runtime !== cutWhisperLocalWorkflowContract.runtime) {
    fail("CUT_WHISPER_WORKFLOW_CONTRACT", "$setup has an unsupported setup/runtime contract.");
  }
  const executable = (value: unknown, path: string) => {
    const entry = closed(value, path, ["path", "bytes", "sha256", "version", "revision"]);
    return Object.freeze({
      ...parseFile({ path: entry.path, bytes: entry.bytes, sha256: entry.sha256 }, path, cutWhisperLocalWorkflowContract.maximumExecutableBytes),
      version: text(entry.version, `${path}.version`),
      revision: text(entry.revision, `${path}.revision`),
    });
  };
  const whisperItem = closed(item.whisperCli, "$setup.whisperCli", [
    "path", "bytes", "sha256", "version", "revision", "sourceArchiveSha256", "buildPolicy", "linkagePolicy",
  ]);
  if (whisperItem.version !== cutWhisperLocalWorkflowContract.whisperVersion
    || whisperItem.linkagePolicy !== cutWhisperLocalWorkflowContract.whisperLinkagePolicy) {
    fail("CUT_WHISPER_WORKFLOW_CONTRACT", "$setup.whisperCli does not match the compatible version and verified linkage policy.");
  }
  const modelItem = closed(item.model, "$setup.model", ["path", "locator", "bytes", "sha256", "name", "revision", "license"]);
  return Object.freeze({
    format: cutWhisperLocalWorkflowContract.format,
    version: cutWhisperLocalWorkflowContract.version,
    acquisition: cutWhisperLocalWorkflowContract.acquisition,
    runtime: cutWhisperLocalWorkflowContract.runtime,
    ffmpeg: executable(item.ffmpeg, "$setup.ffmpeg"),
    whisperCli: Object.freeze({
      ...parseFile({ path: whisperItem.path, bytes: whisperItem.bytes, sha256: whisperItem.sha256 }, "$setup.whisperCli", cutWhisperLocalWorkflowContract.maximumExecutableBytes),
      version: cutWhisperLocalWorkflowContract.whisperVersion,
      revision: text(whisperItem.revision, "$setup.whisperCli.revision"),
      sourceArchiveSha256: digest(whisperItem.sourceArchiveSha256, "$setup.whisperCli.sourceArchiveSha256"),
      buildPolicy: text(whisperItem.buildPolicy, "$setup.whisperCli.buildPolicy"),
      linkagePolicy: cutWhisperLocalWorkflowContract.whisperLinkagePolicy,
    }),
    model: Object.freeze({
      ...parseFile({ path: modelItem.path, bytes: modelItem.bytes, sha256: modelItem.sha256 }, "$setup.model", cutWhisperLocalWorkflowContract.maximumModelBytes),
      locator: projectLocator(modelItem.locator, "$setup.model.locator"),
      name: text(modelItem.name, "$setup.model.name"),
      revision: text(modelItem.revision, "$setup.model.revision"),
      license: text(modelItem.license, "$setup.model.license", 1_024),
    }),
  });
}

function parseSource(value: unknown): CutWhisperLocalSourceAuthority {
  const item = closed(value, "$source", ["locator", "bytes", "sha256", "streamIndex", "sampleRate", "durationSamples"]);
  return Object.freeze({
    locator: projectLocator(item.locator, "$source.locator"),
    bytes: integer(item.bytes, "$source.bytes", 1, cutWhisperLocalWorkflowContract.maximumSourceBytes),
    sha256: digest(item.sha256, "$source.sha256"),
    streamIndex: integer(item.streamIndex, "$source.streamIndex", 0, 65_535),
    sampleRate: integer(item.sampleRate, "$source.sampleRate", 1, 768_000),
    durationSamples: integer(item.durationSamples, "$source.durationSamples", 1, Number.MAX_SAFE_INTEGER),
  });
}

async function openAuthority(path: string, maximumBytes: number, label: string): Promise<Retained> {
  let handle: FileHandle | undefined;
  try {
    if (await realpath(path) !== path) fail("CUT_WHISPER_WORKFLOW_AUTHORITY", `${label} path is not canonical and symlink-free.`);
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maximumBytes)) fail("CUT_WHISPER_WORKFLOW_AUTHORITY", `${label} is not one bounded regular file.`);
    const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0n;
    while (position < before.size) {
      const length = Number(before.size - position > BigInt(buffer.length) ? BigInt(buffer.length) : before.size - position);
      const { bytesRead } = await handle.read(buffer, 0, length, Number(position));
      if (bytesRead !== length) fail("CUT_WHISPER_WORKFLOW_AUTHORITY", `${label} changed while hashing.`);
      hash.update(buffer.subarray(0, bytesRead)); position += BigInt(bytesRead);
    }
    const after = await handle.stat({ bigint: true });
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) fail("CUT_WHISPER_WORKFLOW_AUTHORITY", `${label} changed while hashing.`);
    const snapshot = Object.freeze({ path, bytes: Number(before.size), sha256: hash.digest("hex"), dev: before.dev, ino: before.ino, size: before.size, mtimeNs: before.mtimeNs, ctimeNs: before.ctimeNs });
    const result = Object.freeze({ handle, snapshot }); handle = undefined; return result;
  } catch (error) {
    if (error instanceof CutWhisperLocalWorkflowError) throw error;
    return fail("CUT_WHISPER_WORKFLOW_AUTHORITY", `${label} could not be authenticated.`);
  } finally { await handle?.close().catch(() => undefined); }
}

async function settleRetainedAuthorities(promises: readonly Promise<Retained>[]) {
  const settled = await Promise.allSettled(promises);
  const retained = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  const failure = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure) {
    await Promise.all(retained.map(({ handle }) => handle.close().catch(() => undefined)));
    throw failure.reason;
  }
  return retained;
}
function assertExpected(observed: Snapshot, expected: { bytes: number; sha256: string }, label: string) {
  if (observed.bytes !== expected.bytes || observed.sha256 !== expected.sha256) fail("CUT_WHISPER_WORKFLOW_AUTHORITY", `${label} differs from declared authority.`);
}

async function readRetainedExact(retained: Retained, offset: number, length: number, label: string) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0
    || BigInt(offset) + BigInt(length) > retained.snapshot.size) {
    fail("CUT_WHISPER_WORKFLOW_AUTHORITY", `${label} is outside authenticated executable bytes.`);
  }
  const value = Buffer.allocUnsafe(length);
  const read = await retained.handle.read(value, 0, length, offset);
  if (read.bytesRead !== length) fail("CUT_WHISPER_WORKFLOW_AUTHORITY", `${label} is truncated.`);
  return value;
}

function parseWhisperExecutableClosureBytes(bytes: Uint8Array, fileBytes: bigint): WhisperExecutableClosure {
  const image = Buffer.from(bytes);
  if (image.length < 32) fail("CUT_WHISPER_WORKFLOW_AUTHORITY", "whisper.cpp Mach-O header is truncated.");
  const header = image.subarray(0, 32);
  if (header.readUInt32LE(0) !== 0xfeedfacf || header.readUInt32LE(4) !== 0x0100000c
    || header.readUInt32LE(12) !== 2) {
    fail("CUT_WHISPER_WORKFLOW_AUTHORITY", "whisper.cpp CLI is not one thin arm64 Mach-O executable.");
  }
  const commandCount = header.readUInt32LE(16), commandBytes = header.readUInt32LE(20);
  if (commandCount < 1 || commandCount > 4_096 || commandBytes < 8 || commandBytes > 16 * 1024 * 1024
    || 32n + BigInt(commandBytes) > fileBytes || image.length !== 32 + commandBytes) {
    fail("CUT_WHISPER_WORKFLOW_AUTHORITY", "whisper.cpp Mach-O load-command bounds are invalid.");
  }
  const commands = image.subarray(32);
  const dylibCommands = new Set([0x0c, 0x80000018, 0x8000001f, 0x20, 0x80000023]);
  const loaded: string[] = [];
  let dynamicLinkerCount = 0;
  let offset = 0;
  for (let index = 0; index < commandCount; index += 1) {
    if (offset + 8 > commands.length) fail("CUT_WHISPER_WORKFLOW_AUTHORITY", "whisper.cpp Mach-O load commands are truncated.");
    const command = commands.readUInt32LE(offset), size = commands.readUInt32LE(offset + 4);
    if (size < 8 || size % 8 !== 0 || offset + size > commands.length) {
      fail("CUT_WHISPER_WORKFLOW_AUTHORITY", "whisper.cpp Mach-O contains an invalid load command.");
    }
    if (command === 0x8000001c || command === 0x27) {
      fail("CUT_WHISPER_WORKFLOW_AUTHORITY", "whisper.cpp CLI must not use rpath or dynamic-loader environment search.");
    }
    if (command === 0x0e) {
      if (size < 16) fail("CUT_WHISPER_WORKFLOW_AUTHORITY", "whisper.cpp dynamic-linker command is invalid.");
      const nameOffset = commands.readUInt32LE(offset + 8);
      if (nameOffset < 12 || nameOffset >= size) fail("CUT_WHISPER_WORKFLOW_AUTHORITY", "whisper.cpp dynamic-linker command is invalid.");
      const value = commands.subarray(offset + nameOffset, offset + size), nul = value.indexOf(0);
      if (nul < 1 || value.subarray(nul).some((byte) => byte !== 0)
        || value.subarray(0, nul).toString("ascii") !== "/usr/lib/dyld") {
        fail("CUT_WHISPER_WORKFLOW_AUTHORITY", "whisper.cpp CLI uses an unsupported dynamic linker.");
      }
      dynamicLinkerCount += 1;
    }
    if (dylibCommands.has(command)) {
      if (size < 24) fail("CUT_WHISPER_WORKFLOW_AUTHORITY", "whisper.cpp dylib command is truncated.");
      const nameOffset = commands.readUInt32LE(offset + 8);
      if (nameOffset < 24 || nameOffset >= size) fail("CUT_WHISPER_WORKFLOW_AUTHORITY", "whisper.cpp dylib path offset is invalid.");
      const value = commands.subarray(offset + nameOffset, offset + size), nul = value.indexOf(0);
      if (nul < 1 || value.subarray(nul).some((byte) => byte !== 0)
        || value.subarray(0, nul).some((byte) => byte < 0x20 || byte > 0x7e)) {
        fail("CUT_WHISPER_WORKFLOW_AUTHORITY", "whisper.cpp dylib path is not one closed printable path.");
      }
      loaded.push(value.subarray(0, nul).toString("ascii"));
    }
    offset += size;
  }
  if (offset !== commands.length) fail("CUT_WHISPER_WORKFLOW_AUTHORITY", "whisper.cpp Mach-O load-command size is inconsistent.");
  if (dynamicLinkerCount !== 1) fail("CUT_WHISPER_WORKFLOW_AUTHORITY", "whisper.cpp CLI must bind exactly one /usr/lib/dyld load command.");
  const observed = [...loaded].sort(), expected = [...cutWhisperLocalWorkflowContract.allowedWhisperDylibs].sort();
  if (new Set(observed).size !== observed.length || stableJsonStringify(observed) !== stableJsonStringify(expected)) {
    fail("CUT_WHISPER_WORKFLOW_AUTHORITY", "whisper.cpp CLI has an unbound dynamic dependency closure.");
  }
  return Object.freeze({
    format: "mach-o-64-little-endian",
    architecture: "arm64",
    loadedDylibs: Object.freeze([...loaded]),
  });
}

/**
 * Verifies the executable's load-command closure from authenticated bytes.
 * This proves compatible executable bytes and system-only linkage; it does not
 * claim that those bytes were built from caller-declared source provenance.
 */
async function verifyWhisperExecutableClosure(retained: Retained): Promise<WhisperExecutableClosure> {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    fail("CUT_WHISPER_WORKFLOW_AUTHORITY", "the compatible static whisper.cpp execution policy currently supports Darwin arm64 only.");
  }
  const header = await readRetainedExact(retained, 0, 32, "whisper.cpp Mach-O header");
  const commandBytes = header.readUInt32LE(20);
  if (commandBytes < 8 || commandBytes > 16 * 1024 * 1024
    || 32n + BigInt(commandBytes) > retained.snapshot.size) {
    fail("CUT_WHISPER_WORKFLOW_AUTHORITY", "whisper.cpp Mach-O load-command bounds are invalid.");
  }
  const commands = await readRetainedExact(retained, 32, commandBytes, "whisper.cpp Mach-O load commands");
  return parseWhisperExecutableClosureBytes(Buffer.concat([header, commands]), retained.snapshot.size);
}

async function assertUnchanged(retained: Retained, maximumBytes: number, label: string) {
  const held = await retained.handle.stat({ bigint: true }).catch(() => undefined);
  if (!held?.isFile() || held.dev !== retained.snapshot.dev || held.ino !== retained.snapshot.ino
    || held.size !== retained.snapshot.size || held.mtimeNs !== retained.snapshot.mtimeNs || held.ctimeNs !== retained.snapshot.ctimeNs) {
    fail("CUT_WHISPER_WORKFLOW_AUTHORITY", `${label} changed during execution.`);
  }
  const current = await openAuthority(retained.snapshot.path, maximumBytes, label);
  try {
    if (current.snapshot.dev !== retained.snapshot.dev || current.snapshot.ino !== retained.snapshot.ino
      || current.snapshot.sha256 !== retained.snapshot.sha256) fail("CUT_WHISPER_WORKFLOW_AUTHORITY", `${label} changed during execution.`);
  } finally { await current.handle.close().catch(() => undefined); }
}
async function copyRetained(retained: Retained, destination: string, mode: number) {
  let output: FileHandle | undefined;
  try {
    output = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    const buffer = Buffer.allocUnsafe(1024 * 1024); let position = 0n;
    while (position < retained.snapshot.size) {
      const length = Number(retained.snapshot.size - position > BigInt(buffer.length) ? BigInt(buffer.length) : retained.snapshot.size - position);
      const read = await retained.handle.read(buffer, 0, length, Number(position));
      if (read.bytesRead !== length) fail("CUT_WHISPER_WORKFLOW_AUTHORITY", "authority changed during private copy.");
      const written = await output.write(buffer, 0, length, Number(position));
      if (written.bytesWritten !== length) fail("CUT_WHISPER_WORKFLOW_AUTHORITY", "private copy is incomplete.");
      position += BigInt(length);
    }
    await output.chmod(mode); await output.sync();
  } finally { await output?.close().catch(() => undefined); }
}

async function createStage(parent: string, prefix: string): Promise<Stage> {
  let parentHandle: FileHandle | undefined, handle: FileHandle | undefined, root: string | undefined;
  try {
    const physicalParent = await realpath(parent);
    parentHandle = await open(physicalParent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const parentState = await parentHandle.stat({ bigint: true });
    if (!parentState.isDirectory() || (parentState.mode & 0o022n) !== 0n) {
      fail("CUT_WHISPER_WORKFLOW_AUTHORITY", "private stage parent is not one retained non-writable directory authority.");
    }
    root = await realpath(await mkdtemp(join(physicalParent, prefix)));
    await chmod(root, 0o700);
    handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const state = await handle.stat({ bigint: true });
    if (!state.isDirectory() || (state.mode & 0o077n) !== 0n) fail("CUT_WHISPER_WORKFLOW_AUTHORITY", "private stage is not one owned directory.");
    const result = Object.freeze({
      root,
      parent: physicalParent,
      parentHandle,
      parentDev: parentState.dev,
      parentIno: parentState.ino,
      handle,
      dev: state.dev,
      ino: state.ino,
    });
    parentHandle = undefined;
    handle = undefined;
    return result;
  } catch (error) {
    if (root) await rmdir(root).catch(() => undefined);
    if (error instanceof CutWhisperLocalWorkflowError) throw error;
    return fail("CUT_WHISPER_WORKFLOW_AUTHORITY", "private stage could not be created.");
  } finally {
    await handle?.close().catch(() => undefined);
    await parentHandle?.close().catch(() => undefined);
  }
}
async function cleanupStage(stage: Stage) {
  try {
    const [retainedParent, currentParent, retainedStage, physicalParent] = await Promise.all([
      stage.parentHandle.stat({ bigint: true }),
      lstat(stage.parent, { bigint: true }),
      stage.handle.stat({ bigint: true }),
      realpath(stage.parent),
    ]).catch(() => fail("CUT_WHISPER_WORKFLOW_AUTHORITY", "private stage authority changed before cleanup."));
    if (!retainedParent.isDirectory() || !currentParent.isDirectory() || currentParent.isSymbolicLink()
      || retainedParent.dev !== stage.parentDev || retainedParent.ino !== stage.parentIno
      || currentParent.dev !== stage.parentDev || currentParent.ino !== stage.parentIno
      || physicalParent !== stage.parent || !retainedStage.isDirectory()
      || retainedStage.dev !== stage.dev || retainedStage.ino !== stage.ino) {
      fail("CUT_WHISPER_WORKFLOW_AUTHORITY", "private stage authority changed before cleanup.");
    }
    const matches: string[] = [];
    for (const entry of await readdir(stage.parent)) {
      const candidate = resolve(stage.parent, entry), state = await lstat(candidate, { bigint: true }).catch(() => undefined);
      if (state?.isDirectory() && !state.isSymbolicLink() && state.dev === stage.dev && state.ino === stage.ino) matches.push(candidate);
    }
    if (matches.length !== 1) fail("CUT_WHISPER_WORKFLOW_AUTHORITY", "owned private stage could not be uniquely located for cleanup.");
    // The child can legitimately create many temporary files. Cleanup is tied
    // to the retained stage inode, never follows symlinks, and therefore must
    // not abandon owned files merely because their count crossed a small cap.
    const pending: Array<Readonly<{ path: string; removeDirectory: boolean }>> = [];
    for (const entry of await readdir(matches[0]!)) {
      pending.push(Object.freeze({ path: resolve(matches[0]!, entry), removeDirectory: false }));
    }
    while (pending.length > 0) {
      const entry = pending.pop()!;
      if (entry.removeDirectory) {
        await rmdir(entry.path);
        continue;
      }
      const state = await lstat(entry.path, { bigint: true });
      if (!state.isDirectory() || state.isSymbolicLink()) {
        await unlink(entry.path);
        continue;
      }
      if (state.dev !== stage.dev) {
        fail("CUT_WHISPER_WORKFLOW_AUTHORITY", "owned private stage contains a foreign filesystem directory.");
      }
      pending.push(Object.freeze({ path: entry.path, removeDirectory: true }));
      for (const child of await readdir(entry.path)) {
        pending.push(Object.freeze({ path: resolve(entry.path, child), removeDirectory: false }));
      }
    }
    await rmdir(matches[0]!);
  } finally {
    await stage.handle.close().catch(() => undefined);
    await stage.parentHandle.close().catch(() => undefined);
  }
}

type ProcessResult = Readonly<{ stdout: Buffer; stderr: Buffer }>;
async function processGroupExists(pid: number) {
  try { process.kill(-pid, 0); return true; }
  catch (error) { return !(error && typeof error === "object" && "code" in error && error.code === "ESRCH"); }
}
async function waitForProcessGroupExit(pid: number, milliseconds: number) {
  const deadline = Date.now() + milliseconds;
  do {
    if (!(await processGroupExists(pid))) return true;
    await new Promise((done) => setTimeout(done, 10));
  } while (Date.now() <= deadline);
  return !(await processGroupExists(pid));
}
async function runBounded(
  executable: string,
  args: readonly string[],
  timeoutMs: number,
  signal?: AbortSignal,
  stdin?: Retained,
): Promise<ProcessResult> {
  if (signal?.aborted) fail("CUT_WHISPER_WORKFLOW_CANCELLED", "transcription was cancelled before process launch.");
  if (process.platform !== "darwin" && process.platform !== "linux") fail("CUT_WHISPER_WORKFLOW_PROCESS", "local transcription is supported only on Darwin and Linux.");
  return new Promise((accept, reject) => {
    let child: ReturnType<typeof spawn>;
    try { child = spawn(executable, [...args], { shell: false, detached: true, stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"], env: Object.freeze({ LANG: "C", LC_ALL: "C" }) }); }
    catch { reject(new CutWhisperLocalWorkflowError("CUT_WHISPER_WORKFLOW_PROCESS", "local process could not start.")); return; }
    const stdout: Buffer[] = [], stderr: Buffer[] = []; let stdoutBytes = 0, stderrBytes = 0;
    let failure: CutWhisperLocalWorkflowError | undefined, killTimer: NodeJS.Timeout | undefined, pid: number | undefined;
    const signalTree = (value: NodeJS.Signals) => {
      if (!Number.isSafeInteger(pid) || Number(pid) < 1) return;
      try { process.kill(-pid!, value); return; } catch { /* fall through to the retained positive-PID child */ }
      try { child.kill(value); } catch { /* closed */ }
    };
    const terminate = (error: CutWhisperLocalWorkflowError) => { if (failure) return; failure = error; signalTree("SIGTERM"); killTimer = setTimeout(() => signalTree("SIGKILL"), cutWhisperLocalWorkflowContract.terminationGraceMs); };
    // Node emits spawn failures asynchronously. This listener must exist before
    // examining child.pid so an ENOENT/EACCES cannot escape as an unhandled event.
    child.once("error", () => terminate(new CutWhisperLocalWorkflowError("CUT_WHISPER_WORKFLOW_PROCESS", "local process failed after launch.")));
    pid = child.pid;
    const abort = () => terminate(new CutWhisperLocalWorkflowError("CUT_WHISPER_WORKFLOW_CANCELLED", "transcription was cancelled."));
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => terminate(new CutWhisperLocalWorkflowError("CUT_WHISPER_WORKFLOW_PROCESS", `local process exceeded ${timeoutMs}ms.`)), timeoutMs);
    child.stdout!.on("data", (chunk: Buffer) => { const copy = Buffer.from(chunk); stdoutBytes += copy.length; if (stdoutBytes > cutWhisperLocalWorkflowContract.maximumStdoutBytes) terminate(new CutWhisperLocalWorkflowError("CUT_WHISPER_WORKFLOW_OUTPUT", "stdout exceeded its limit.")); else stdout.push(copy); });
    child.stderr!.on("data", (chunk: Buffer) => { const copy = Buffer.from(chunk); stderrBytes += copy.length; if (stderrBytes > cutWhisperLocalWorkflowContract.maximumStderrBytes) terminate(new CutWhisperLocalWorkflowError("CUT_WHISPER_WORKFLOW_OUTPUT", "stderr exceeded its limit.")); else stderr.push(copy); });
    let inputTask: Promise<void> = Promise.resolve();
    if (!Number.isSafeInteger(pid) || Number(pid) < 1) {
      terminate(new CutWhisperLocalWorkflowError("CUT_WHISPER_WORKFLOW_PROCESS", "local process did not expose one identity."));
    } else if (stdin) {
      const source = stdin.handle.createReadStream({
        autoClose: false,
        start: 0,
        end: Number(stdin.snapshot.size - 1n),
      });
      inputTask = pipeline(source, child.stdin!).catch(() => {
        terminate(new CutWhisperLocalWorkflowError("CUT_WHISPER_WORKFLOW_PROCESS", "authenticated stdin transfer failed."));
      });
    }
    child.once("close", async (code, terminalSignal) => {
      await inputTask;
      clearTimeout(timer); if (killTimer) clearTimeout(killTimer); signal?.removeEventListener("abort", abort);
      if (!Number.isSafeInteger(pid) || Number(pid) < 1) { reject(failure ?? new CutWhisperLocalWorkflowError("CUT_WHISPER_WORKFLOW_PROCESS", "local process did not expose one identity.")); return; }
      if (failure) {
        signalTree("SIGKILL");
        if (!(await waitForProcessGroupExit(pid!, cutWhisperLocalWorkflowContract.terminationGraceMs))) {
          reject(new CutWhisperLocalWorkflowError("CUT_WHISPER_WORKFLOW_PROCESS", "process group survived cleanup."));
        } else reject(failure);
        return;
      }
      if (code !== 0 || terminalSignal !== null) {
        signalTree("SIGKILL");
        if (!(await waitForProcessGroupExit(pid!, cutWhisperLocalWorkflowContract.terminationGraceMs))) {
          reject(new CutWhisperLocalWorkflowError("CUT_WHISPER_WORKFLOW_PROCESS", "failed process left a descendant alive."));
        } else reject(new CutWhisperLocalWorkflowError("CUT_WHISPER_WORKFLOW_PROCESS", "local process exited unsuccessfully."));
        return;
      }
      if (!(await waitForProcessGroupExit(pid!, cutWhisperLocalWorkflowContract.terminationGraceMs))) {
        signalTree("SIGTERM");
        if (!(await waitForProcessGroupExit(pid!, cutWhisperLocalWorkflowContract.terminationGraceMs))) signalTree("SIGKILL");
        if (!(await waitForProcessGroupExit(pid!, cutWhisperLocalWorkflowContract.terminationGraceMs))) {
          reject(new CutWhisperLocalWorkflowError("CUT_WHISPER_WORKFLOW_PROCESS", "process left a descendant alive after drain."));
          return;
        }
        reject(new CutWhisperLocalWorkflowError("CUT_WHISPER_WORKFLOW_PROCESS", "process left a descendant alive."));
        return;
      }
      accept(Object.freeze({ stdout: Buffer.concat(stdout, stdoutBytes), stderr: Buffer.concat(stderr, stderrBytes) }));
    });
  });
}

async function stagedAuthority(stage: Stage, retained: Retained, name: string, mode: number, maximumBytes: number) {
  const path = join(stage.root, name); await copyRetained(retained, path, 0o700);
  if (mode !== 0o700) await chmod(path, mode);
  const observed = await openAuthority(path, maximumBytes, `private ${name}`);
  try {
    assertExpected(observed.snapshot, retained.snapshot, `private ${name}`);
    return observed;
  } catch (error) {
    await observed.handle.close().catch(() => undefined);
    throw error;
  }
}
async function exactVersion(
  executable: string,
  args: readonly string[],
  expected: string,
  comparison: "exact" | "first-line-prefix",
  signal?: AbortSignal,
) {
  const result = await runBounded(executable, args, 30_000, signal);
  const stdout = result.stdout.toString("utf8");
  const firstLine = stdout.split("\n", 1)[0] ?? "";
  const valid = comparison === "exact" ? stdout.trim() === expected : firstLine === expected || firstLine.startsWith(`${expected} `);
  if (result.stderr.length !== 0 || stdout.includes("\ufffd") || !valid) {
    fail("CUT_WHISPER_WORKFLOW_AUTHORITY", "executable version output differs from setup authority.");
  }
  return result;
}

type WorkflowHooks = Readonly<{
  verifyWhisperClosure: (retained: Retained) => Promise<WhisperExecutableClosure>;
}>;
const productionHooks: WorkflowHooks = Object.freeze({ verifyWhisperClosure: verifyWhisperExecutableClosure });
const fixtureClosure: WhisperExecutableClosure = Object.freeze({
  format: "mach-o-64-little-endian",
  architecture: "arm64",
  loadedDylibs: cutWhisperLocalWorkflowContract.allowedWhisperDylibs,
});

/** Authenticates local bytes; it never downloads a binary or model. */
async function doctorCutWhisperLocalSetupWithHooks(value: unknown, hooks: WorkflowHooks): Promise<CutWhisperLocalDoctorReport> {
  const setup = parseCutWhisperLocalSetup(value);
  const authorities = await settleRetainedAuthorities([
    openAuthority(setup.ffmpeg.path, cutWhisperLocalWorkflowContract.maximumExecutableBytes, "FFmpeg"),
    openAuthority(setup.whisperCli.path, cutWhisperLocalWorkflowContract.maximumExecutableBytes, "whisper.cpp CLI"),
    openAuthority(setup.model.path, cutWhisperLocalWorkflowContract.maximumModelBytes, "whisper model"),
  ]);
  const stagedAuthorities: Retained[] = [];
  let stage: Stage | undefined;
  try {
    assertExpected(authorities[0].snapshot, setup.ffmpeg, "FFmpeg"); assertExpected(authorities[1].snapshot, setup.whisperCli, "whisper.cpp CLI"); assertExpected(authorities[2].snapshot, setup.model, "whisper model");
    const closure = await hooks.verifyWhisperClosure(authorities[1]);
    stage = await createStage(resolve(process.env.TMPDIR ?? "/tmp"), "cut-whisper-doctor-");
    const ffmpeg = await stagedAuthority(stage, authorities[0], "ffmpeg", 0o700, cutWhisperLocalWorkflowContract.maximumExecutableBytes); stagedAuthorities.push(ffmpeg);
    const whisper = await stagedAuthority(stage, authorities[1], "whisper-cli", 0o700, cutWhisperLocalWorkflowContract.maximumExecutableBytes); stagedAuthorities.push(whisper);
    await exactVersion(ffmpeg.snapshot.path, ["-version"], `ffmpeg version ${setup.ffmpeg.version}`, "first-line-prefix");
    await exactVersion(whisper.snapshot.path, ["--version"], `whisper.cpp version: ${setup.whisperCli.version}`, "exact");
    await Promise.all([
      assertUnchanged(ffmpeg, cutWhisperLocalWorkflowContract.maximumExecutableBytes, "private FFmpeg"),
      assertUnchanged(whisper, cutWhisperLocalWorkflowContract.maximumExecutableBytes, "private whisper.cpp CLI"),
      assertUnchanged(authorities[0], cutWhisperLocalWorkflowContract.maximumExecutableBytes, "FFmpeg"),
      assertUnchanged(authorities[1], cutWhisperLocalWorkflowContract.maximumExecutableBytes, "whisper.cpp CLI"),
      assertUnchanged(authorities[2], cutWhisperLocalWorkflowContract.maximumModelBytes, "whisper model"),
    ]);
    return Object.freeze({
      format: "cut-whisper-local-doctor", version: 1, status: "caller-authority-ready",
      authorityScope: cutWhisperLocalWorkflowContract.authorityScope,
      platform: process.platform,
      runtime: cutWhisperLocalWorkflowContract.runtime, osNetworkSandbox: cutWhisperLocalWorkflowContract.osNetworkSandbox,
      ffmpeg: Object.freeze({ bytes: setup.ffmpeg.bytes, sha256: setup.ffmpeg.sha256, version: setup.ffmpeg.version, declaredRevision: setup.ffmpeg.revision }),
      whisperCli: Object.freeze({
        bytes: setup.whisperCli.bytes,
        sha256: setup.whisperCli.sha256,
        version: setup.whisperCli.version,
        declaredRevision: setup.whisperCli.revision,
        declaredSourceArchiveSha256: setup.whisperCli.sourceArchiveSha256,
        declaredBuildPolicy: setup.whisperCli.buildPolicy,
        verifiedLinkagePolicy: setup.whisperCli.linkagePolicy,
        loadedDylibs: closure.loadedDylibs,
      }),
      model: Object.freeze({ locator: setup.model.locator, bytes: setup.model.bytes, sha256: setup.model.sha256, declaredName: setup.model.name, declaredRevision: setup.model.revision, declaredLicense: setup.model.license }),
      modelInferenceSmoke: "unperformed-until-transcription",
    });
  } finally {
    try {
      await Promise.all(stagedAuthorities.splice(0).map(({ handle }) => handle.close().catch(() => undefined)));
      if (stage) await cleanupStage(stage);
    }
    finally { await Promise.all(authorities.map(({ handle }) => handle.close().catch(() => undefined))); }
  }
}

export async function doctorCutWhisperLocalSetup(value: unknown): Promise<CutWhisperLocalDoctorReport> {
  return doctorCutWhisperLocalSetupWithHooks(value, productionHooks);
}

function ffmpegArgs(streamIndex: number, outputPath: string) {
  return Object.freeze([
    "-nostdin", "-v", "error", "-xerror",
    "-protocol_whitelist", "pipe",
    "-protocol_blacklist", "file,http,https,tcp,tls,udp,rtmp,rtsp,srt,ftp,concat,subfile,crypto,data",
    "-i", "pipe:0",
    "-map", `0:${streamIndex}`,
    "-vn", "-sn", "-dn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
    "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact", "-f", "wav", outputPath,
  ]);
}
function whisperArgs(modelPath: string, wavePath: string, outputPrefix: string, settings: AudioTranscriptionSettings, threads: number) {
  return Object.freeze(["--model", modelPath, "--file", wavePath, "--language", settings.language, "--threads", String(threads), "--temperature", (settings.temperatureMilli / 1_000).toFixed(3), ...(settings.noFallback ? ["--no-fallback"] : []), "--split-on-word", "--max-len", "1", "--output-json-full", "--output-file", outputPrefix, "--no-prints", "--no-gpu"]);
}
function receiptInvocation(streamIndex: number, settings: AudioTranscriptionSettings, threads: number) {
  return Object.freeze(["ffmpeg", "-protocol_whitelist", "pipe", "-protocol_blacklist", "external-protocols", "-i", "pipe:0<authenticated-source>", "-map", `0:${streamIndex}`, "mono-16000hz-pcm-s16le-wave", "then", "whisper-cli", "--model", "<authenticated-model>", "--file", "<authenticated-normalized-wave>", "--language", settings.language, "--threads", String(threads), "--temperature", (settings.temperatureMilli / 1_000).toFixed(3), ...(settings.noFallback ? ["--no-fallback"] : []), "--split-on-word", "--max-len", "1", "--output-json-full", "--no-prints", "--no-gpu"]);
}

async function parseNormalizedWave(path: string) {
  const retained = await openAuthority(path, cutWhisperLocalWorkflowContract.maximumWaveBytes, "normalized WAVE")
    .catch(() => fail("CUT_WHISPER_WORKFLOW_OUTPUT", "normalized WAVE is missing, aliased, or not one bounded regular file."));
  try {
    if (retained.snapshot.size < 44n) fail("CUT_WHISPER_WORKFLOW_OUTPUT", "FFmpeg did not produce one bounded RIFF/WAVE artifact.");
    const riff = await readRetainedExact(retained, 0, 12, "normalized WAVE RIFF header");
    if (riff.toString("ascii", 0, 4) !== "RIFF" || riff.toString("ascii", 8, 12) !== "WAVE"
      || BigInt(riff.readUInt32LE(4)) + 8n !== retained.snapshot.size) {
      fail("CUT_WHISPER_WORKFLOW_OUTPUT", "FFmpeg did not produce one bounded RIFF/WAVE artifact.");
    }
    let offset = 12n, formatSeen = false;
    let pcm: Readonly<{ offset: bigint; bytes: number }> | undefined;
    while (offset + 8n <= retained.snapshot.size) {
      const header = await readRetainedExact(retained, Number(offset), 8, "normalized WAVE chunk header");
      const id = header.toString("ascii", 0, 4), size = header.readUInt32LE(4);
      const start = offset + 8n, end = start + BigInt(size), paddedEnd = end + BigInt(size % 2);
      if (end > retained.snapshot.size || paddedEnd > retained.snapshot.size) fail("CUT_WHISPER_WORKFLOW_OUTPUT", "normalized WAVE has a truncated chunk.");
      if (id === "fmt ") {
        const format = size === 16 ? await readRetainedExact(retained, Number(start), size, "normalized WAVE format") : Buffer.alloc(0);
        if (formatSeen || size !== 16 || format.readUInt16LE(0) !== 1 || format.readUInt16LE(2) !== 1
          || format.readUInt32LE(4) !== 16_000 || format.readUInt32LE(8) !== 32_000
          || format.readUInt16LE(12) !== 2 || format.readUInt16LE(14) !== 16) {
          fail("CUT_WHISPER_WORKFLOW_OUTPUT", "normalized WAVE format is not exact mono 16 kHz s16le PCM.");
        }
        formatSeen = true;
      } else if (id === "data") {
        if (pcm || size < 2 || size % 2 !== 0) fail("CUT_WHISPER_WORKFLOW_OUTPUT", "normalized WAVE has an invalid PCM payload.");
        pcm = Object.freeze({ offset: start, bytes: size });
      } else fail("CUT_WHISPER_WORKFLOW_OUTPUT", `normalized WAVE contains unsupported ${JSON.stringify(id)} metadata.`);
      offset = paddedEnd;
    }
    if (!formatSeen || !pcm || offset !== retained.snapshot.size) fail("CUT_WHISPER_WORKFLOW_OUTPUT", "normalized WAVE is incomplete.");
    const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = pcm.offset, remaining = BigInt(pcm.bytes);
    while (remaining > 0n) {
      const length = Number(remaining > BigInt(buffer.length) ? BigInt(buffer.length) : remaining);
      const read = await retained.handle.read(buffer, 0, length, Number(position));
      if (read.bytesRead !== length) fail("CUT_WHISPER_WORKFLOW_OUTPUT", "normalized WAVE PCM changed while reading.");
      hash.update(buffer.subarray(0, length));
      position += BigInt(length);
      remaining -= BigInt(length);
    }
    await assertUnchanged(retained, cutWhisperLocalWorkflowContract.maximumWaveBytes, "normalized WAVE");
    return Object.freeze({
      waveBytes: retained.snapshot.bytes,
      waveSha256: retained.snapshot.sha256,
      pcmBytes: pcm.bytes,
      pcmSha256: hash.digest("hex"),
      durationSamples: pcm.bytes / 2,
    });
  } finally {
    await retained.handle.close().catch(() => undefined);
  }
}

async function readRetainedOutput(path: string, maximumBytes: number, label: string) {
  const retained = await openAuthority(path, maximumBytes, label).catch(() => fail("CUT_WHISPER_WORKFLOW_OUTPUT", `${label} is missing, aliased, or not one bounded regular file.`));
  try {
    const bytes = await readRetainedExact(retained, 0, retained.snapshot.bytes, label);
    await assertUnchanged(retained, maximumBytes, label);
    return bytes;
  } finally {
    await retained.handle.close().catch(() => undefined);
  }
}

function strictJsonString(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) fail("CUT_WHISPER_WORKFLOW_OUTPUT", "whisper.cpp JSON contains an unpaired Unicode surrogate.");
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) fail("CUT_WHISPER_WORKFLOW_OUTPUT", "whisper.cpp JSON contains an unpaired Unicode surrogate.");
  }
}

class StrictProviderJsonScanner {
  private offset = 0;
  private nodes = 0;

  constructor(private readonly source: string) {}

  scan() {
    this.space();
    this.value(0);
    this.space();
    if (this.offset !== this.source.length) this.syntax();
  }

  private syntax(): never {
    return fail("CUT_WHISPER_WORKFLOW_OUTPUT", `whisper.cpp returned malformed JSON at byte-independent text offset ${this.offset}.`);
  }

  private space() {
    while (this.offset < this.source.length && /[\u0020\u0009\u000a\u000d]/u.test(this.source[this.offset]!)) this.offset += 1;
  }

  private value(depth: number) {
    this.nodes += 1;
    if (depth > 64 || this.nodes > 8_000_000) fail("CUT_WHISPER_WORKFLOW_OUTPUT", "whisper.cpp JSON exceeds structural bounds.");
    this.space();
    const character = this.source[this.offset];
    if (character === "{") return this.object(depth);
    if (character === "[") return this.array(depth);
    if (character === "\"") { this.string(); return; }
    if (this.source.startsWith("true", this.offset)) { this.offset += 4; return; }
    if (this.source.startsWith("false", this.offset)) { this.offset += 5; return; }
    if (this.source.startsWith("null", this.offset)) { this.offset += 4; return; }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(this.source.slice(this.offset));
    if (!number) this.syntax();
    this.offset += number[0].length;
  }

  private string() {
    const start = this.offset;
    this.offset += 1;
    while (this.offset < this.source.length) {
      const character = this.source[this.offset]!;
      if (character === "\"") {
        this.offset += 1;
        let decoded: unknown;
        try { decoded = JSON.parse(this.source.slice(start, this.offset)); } catch { this.syntax(); }
        if (typeof decoded !== "string") this.syntax();
        strictJsonString(decoded);
        return decoded;
      }
      if (character === "\\") {
        this.offset += 1;
        if (this.offset >= this.source.length) this.syntax();
        if (this.source[this.offset] === "u") {
          if (!/^[0-9a-fA-F]{4}$/u.test(this.source.slice(this.offset + 1, this.offset + 5))) this.syntax();
          this.offset += 5;
        } else {
          if (!/["\\/bfnrt]/u.test(this.source[this.offset]!)) this.syntax();
          this.offset += 1;
        }
        continue;
      }
      if (character.charCodeAt(0) < 0x20) this.syntax();
      this.offset += 1;
    }
    this.syntax();
  }

  private object(depth: number) {
    this.offset += 1;
    this.space();
    const keys = new Set<string>();
    if (this.source[this.offset] === "}") { this.offset += 1; return; }
    while (true) {
      if (this.source[this.offset] !== "\"") this.syntax();
      const key = this.string();
      if (keys.has(key)) fail("CUT_WHISPER_WORKFLOW_OUTPUT", `whisper.cpp JSON contains duplicate decoded key ${JSON.stringify(key)}.`);
      keys.add(key);
      this.space();
      if (this.source[this.offset] !== ":") this.syntax();
      this.offset += 1;
      this.value(depth + 1);
      this.space();
      if (this.source[this.offset] === "}") { this.offset += 1; return; }
      if (this.source[this.offset] !== ",") this.syntax();
      this.offset += 1;
      this.space();
    }
  }

  private array(depth: number) {
    this.offset += 1;
    this.space();
    if (this.source[this.offset] === "]") { this.offset += 1; return; }
    while (true) {
      this.value(depth + 1);
      this.space();
      if (this.source[this.offset] === "]") { this.offset += 1; return; }
      if (this.source[this.offset] !== ",") this.syntax();
      this.offset += 1;
      this.space();
    }
  }
}

function parseStrictProviderJson(bytes: Buffer) {
  let source: string;
  try { source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return fail("CUT_WHISPER_WORKFLOW_OUTPUT", "whisper.cpp JSON is not valid UTF-8."); }
  if (source.charCodeAt(0) === 0xfeff) fail("CUT_WHISPER_WORKFLOW_OUTPUT", "whisper.cpp JSON must not contain a byte-order mark.");
  new StrictProviderJsonScanner(source).scan();
  try { return JSON.parse(source) as unknown; }
  catch { return fail("CUT_WHISPER_WORKFLOW_OUTPUT", "whisper.cpp returned malformed JSON."); }
}

function plainProviderRecord(value: unknown, path: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) fail("CUT_WHISPER_WORKFLOW_OUTPUT", `${path} must be one plain object.`);
  return value as Record<string, unknown>;
}
function providerClosed(value: unknown, path: string, keys: readonly string[]) {
  const item = plainProviderRecord(value, path), observed = Object.keys(item).sort(), expected = [...keys].sort();
  if (stableJsonStringify(observed) !== stableJsonStringify(expected)) fail("CUT_WHISPER_WORKFLOW_OUTPUT", `${path} does not match the pinned whisper.cpp JSON shape.`);
  return item;
}
function formatTimestamp(milliseconds: number) {
  const hours = Math.floor(milliseconds / 3_600_000), minutes = Math.floor(milliseconds / 60_000) % 60;
  const seconds = Math.floor(milliseconds / 1_000) % 60, remainder = milliseconds % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(remainder).padStart(3, "0")}`;
}
function boundarySample(milliseconds: number, sampleRate: number, boundary: "start" | "end") {
  const numerator = BigInt(milliseconds) * BigInt(sampleRate), denominator = 1_000n;
  const sample = boundary === "start" ? numerator / denominator : (numerator + denominator - 1n) / denominator;
  if (sample > BigInt(Number.MAX_SAFE_INTEGER)) fail("CUT_WHISPER_WORKFLOW_OUTPUT", "provider timestamp exceeds CUT's source-sample grid.");
  return Number(sample);
}
function providerNumber(value: unknown, path: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) fail("CUT_WHISPER_WORKFLOW_OUTPUT", `${path} must be one finite number.`);
  return value;
}
function providerToken(value: unknown, path: string) {
  const token = providerClosed(value, path, ["text", "timestamps", "offsets", "id", "p", "t_dtw"]);
  const timestamps = providerClosed(token.timestamps, `${path}.timestamps`, ["from", "to"]);
  const offsets = providerClosed(token.offsets, `${path}.offsets`, ["from", "to"]);
  const from = integer(offsets.from, `${path}.offsets.from`, 0, Number.MAX_SAFE_INTEGER);
  const to = integer(offsets.to, `${path}.offsets.to`, 0, Number.MAX_SAFE_INTEGER);
  if (timestamps.from !== formatTimestamp(from) || timestamps.to !== formatTimestamp(to)
    || typeof token.text !== "string" || token.text.normalize("NFC") !== token.text
    || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(token.text)) {
    fail("CUT_WHISPER_WORKFLOW_OUTPUT", `${path} contains inconsistent or unsafe token data.`);
  }
  return Object.freeze({
    text: token.text,
    from,
    to,
    id: integer(token.id, `${path}.id`, 0, 1_000_000),
    p: providerNumber(token.p, `${path}.p`),
    tDtw: providerNumber(token.t_dtw, `${path}.t_dtw`),
  });
}
function parseWhisperJson(
  bytes: Buffer,
  source: CutWhisperLocalSourceAuthority,
  settings: AudioTranscriptionSettings,
  expectedModelPath: string,
) {
  if (bytes.length < 2 || bytes.length > cutWhisperLocalWorkflowContract.maximumJsonBytes) fail("CUT_WHISPER_WORKFLOW_OUTPUT", "whisper.cpp JSON exceeds its byte bounds.");
  const parsed = parseStrictProviderJson(bytes);
  const root = providerClosed(parsed, "$provider", ["systeminfo", "model", "params", "result", "transcription"]);
  if (typeof root.systeminfo !== "string") fail("CUT_WHISPER_WORKFLOW_OUTPUT", "$provider.systeminfo must be text.");
  plainProviderRecord(root.model, "$provider.model");
  const params = providerClosed(root.params, "$provider.params", ["model", "language", "translate"]);
  if (params.model !== expectedModelPath || params.language !== settings.language
    || params.translate !== false) fail("CUT_WHISPER_WORKFLOW_OUTPUT", "whisper.cpp params differ from the requested operation.");
  const result = providerClosed(root.result, "$provider.result", ["language"]);
  if (result.language !== settings.language) fail("CUT_WHISPER_WORKFLOW_OUTPUT", "whisper.cpp result language differs from the requested operation.");
  if (!Array.isArray(root.transcription) || root.transcription.length > cutWhisperLocalWorkflowContract.maximumWords + 1) fail("CUT_WHISPER_WORKFLOW_OUTPUT", "whisper.cpp transcription exceeds its limit.");
  const rawWords: Array<{ from: number; to: number; text: string }> = [];
  for (let index = 0; index < root.transcription.length; index += 1) {
    const path = `$provider.transcription[${index}]`;
    const segment = providerClosed(root.transcription[index], path, ["timestamps", "offsets", "text", "tokens"]);
    const timestamps = providerClosed(segment.timestamps, `$provider.transcription[${index}].timestamps`, ["from", "to"]);
    const offsets = providerClosed(segment.offsets, `$provider.transcription[${index}].offsets`, ["from", "to"]);
    const from = integer(offsets.from, `$provider.transcription[${index}].offsets.from`, 0, Number.MAX_SAFE_INTEGER);
    const to = integer(offsets.to, `$provider.transcription[${index}].offsets.to`, 0, Number.MAX_SAFE_INTEGER);
    if (timestamps.from !== formatTimestamp(from) || timestamps.to !== formatTimestamp(to)) fail("CUT_WHISPER_WORKFLOW_OUTPUT", "whisper.cpp text timestamps disagree with integer offsets.");
    if (typeof segment.text !== "string" || segment.text.normalize("NFC") !== segment.text
      || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(segment.text)) fail("CUT_WHISPER_WORKFLOW_OUTPUT", "whisper.cpp segment text is unsafe.");
    if (!Array.isArray(segment.tokens) || segment.tokens.length < 1 || segment.tokens.length > 128) fail("CUT_WHISPER_WORKFLOW_OUTPUT", `${path}.tokens is not one bounded array.`);
    const tokens = segment.tokens.map((token, tokenIndex) => providerToken(token, `${path}.tokens[${tokenIndex}]`));
    const word = segment.text.trim();
    if (!word) {
      const sentinel = tokens.length === 1 ? tokens[0] : undefined;
      if (!sentinel || sentinel.text !== "[_BEG_]" || sentinel.id !== 50_363 || sentinel.tDtw !== -1
        || sentinel.from !== from || sentinel.to !== from) {
        fail("CUT_WHISPER_WORKFLOW_OUTPUT", "whisper.cpp emitted an unsupported empty segment.");
      }
      continue;
    }
    if (/\s/u.test(word) || to < from) fail("CUT_WHISPER_WORKFLOW_OUTPUT", "word-split whisper.cpp output contains a multiword or reversed interval.");
    rawWords.push(Object.freeze({ from, to, text: word }));
  }
  const words: Array<{ startSample: number; endSample: number; text: string }> = [];
  let previousEnd = 0, previousRawEnd: number | undefined, previousWasTiedRepair = false;
  let tiedBoundaryRepairCount = 0, adjacentBoundarySnapCount = 0;
  for (let index = 0; index < rawWords.length; index += 1) {
    const raw = rawWords[index]!, next = rawWords[index + 1];
    let startSample = boundarySample(raw.from, source.sampleRate, "start");
    let endSample = boundarySample(raw.to, source.sampleRate, "end");
    if (startSample < previousEnd) {
      if (previousWasTiedRepair && startSample + 1 === previousEnd && endSample > previousEnd) {
        startSample = previousEnd;
      } else if (previousRawEnd === raw.from && startSample + 1 === previousEnd && endSample > previousEnd) {
        startSample = previousEnd;
        adjacentBoundarySnapCount += 1;
      } else {
        fail("CUT_WHISPER_WORKFLOW_OUTPUT", "mapped whisper.cpp word overlaps outside the tied-boundary repair law.");
      }
    }
    let repairedTie = false;
    if (endSample === startSample) {
      if (!next || raw.from !== raw.to || next.from !== raw.to || next.to <= next.from
        || startSample >= source.durationSamples) {
        fail("CUT_WHISPER_WORKFLOW_OUTPUT", "zero-duration whisper.cpp word is outside the tied-boundary repair law.");
      }
      endSample = startSample + 1;
      repairedTie = true;
      tiedBoundaryRepairCount += 1;
    }
    if (endSample <= startSample || endSample > source.durationSamples) fail("CUT_WHISPER_WORKFLOW_OUTPUT", "mapped whisper.cpp word is outside source duration.");
    words.push(Object.freeze({ startSample, endSample, text: raw.text }));
    previousEnd = endSample;
    previousRawEnd = raw.to;
    previousWasTiedRepair = repairedTie;
  }
  const semanticProjection = Object.freeze({
    language: settings.language,
    words: Object.freeze(words.map((word) => Object.freeze({ ...word }))),
    tiedBoundaryRepairCount,
    adjacentBoundarySnapCount,
  });
  return Object.freeze({
    words: Object.freeze(words),
    tiedBoundaryRepairCount,
    adjacentBoundarySnapCount,
    providerJsonSemanticBytes: Buffer.byteLength(stableJsonStringify(semanticProjection), "utf8"),
    providerJsonSemanticSha256: sha256(stableJsonStringify(semanticProjection)),
  });
}

async function transcribeProjectAudioWithWhisperLocalWithHooks(
  inputValue: CutWhisperLocalTranscriptionInput,
  hooks: WorkflowHooks,
): Promise<CutWhisperLocalWorkflowResult> {
  const item = closed(inputValue, "$", ["projectRoot", "setup", "source", "settings", "threads", "transcriptLocator", "receiptLocator"], ["timeoutMs", "signal"]);
  const projectRoot = await realpath(absolutePath(item.projectRoot, "$.projectRoot")).catch(() => fail("CUT_WHISPER_WORKFLOW_CONTRACT", "$.projectRoot could not be resolved."));
  const setup = parseCutWhisperLocalSetup(item.setup), source = parseSource(item.source);
  const settingsItem = closed(item.settings, "$.settings", ["language", "temperatureMilli", "noFallback"]);
  const language = text(settingsItem.language, "$.settings.language", 32);
  if (!/^[a-z]{2,3}$/u.test(language)) fail("CUT_WHISPER_WORKFLOW_CONTRACT", "stock whisper.cpp v1 requires one explicit lowercase ISO language code.");
  if (typeof settingsItem.noFallback !== "boolean") fail("CUT_WHISPER_WORKFLOW_CONTRACT", "$.settings.noFallback must be a boolean.");
  const settings: AudioTranscriptionSettings = Object.freeze({ language, temperatureMilli: integer(settingsItem.temperatureMilli, "$.settings.temperatureMilli", 0, 1_000), noFallback: settingsItem.noFallback });
  const threads = integer(item.threads, "$.threads", 1, 64), transcriptLocator = projectLocator(item.transcriptLocator, "$.transcriptLocator"), receiptLocator = projectLocator(item.receiptLocator, "$.receiptLocator");
  if (transcriptLocator === receiptLocator) fail("CUT_WHISPER_WORKFLOW_CONTRACT", "transcript and receipt locators must be distinct.");
  const timeoutMs = item.timeoutMs === undefined ? cutWhisperLocalWorkflowContract.defaultTimeoutMs : integer(item.timeoutMs, "$.timeoutMs", 1, cutWhisperLocalWorkflowContract.maximumTimeoutMs);
  if (item.signal !== undefined && (utilTypes.isProxy(item.signal) || !(item.signal instanceof AbortSignal))) fail("CUT_WHISPER_WORKFLOW_CONTRACT", "$.signal must be one non-proxy AbortSignal.");
  const signal = item.signal as AbortSignal | undefined; if (signal?.aborted) fail("CUT_WHISPER_WORKFLOW_CANCELLED", "transcription was cancelled before authentication.");
  const sourcePath = resolve(projectRoot, source.locator), local = relative(projectRoot, sourcePath);
  if (!local || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) fail("CUT_WHISPER_WORKFLOW_CONTRACT", "source locator escapes project root.");
  const authorities = await settleRetainedAuthorities([
    openAuthority(sourcePath, cutWhisperLocalWorkflowContract.maximumSourceBytes, "source media"),
    openAuthority(setup.ffmpeg.path, cutWhisperLocalWorkflowContract.maximumExecutableBytes, "FFmpeg"),
    openAuthority(setup.whisperCli.path, cutWhisperLocalWorkflowContract.maximumExecutableBytes, "whisper.cpp CLI"),
    openAuthority(setup.model.path, cutWhisperLocalWorkflowContract.maximumModelBytes, "whisper model"),
  ]);
  const stagedAuthorities: Retained[] = [];
  let stage: Stage | undefined;
  try {
    assertExpected(authorities[0].snapshot, source, "source media"); assertExpected(authorities[1].snapshot, setup.ffmpeg, "FFmpeg"); assertExpected(authorities[2].snapshot, setup.whisperCli, "whisper.cpp CLI"); assertExpected(authorities[3].snapshot, setup.model, "whisper model");
    const closure = await hooks.verifyWhisperClosure(authorities[2]);
    const stageParent = await ensureProjectWriteDirectory(projectRoot, ".cut/audio-transcription-staging"); stage = await createStage(stageParent, "run-");
    const ffmpeg = await stagedAuthority(stage, authorities[1], "ffmpeg", 0o700, cutWhisperLocalWorkflowContract.maximumExecutableBytes); stagedAuthorities.push(ffmpeg);
    const whisper = await stagedAuthority(stage, authorities[2], "whisper-cli", 0o700, cutWhisperLocalWorkflowContract.maximumExecutableBytes); stagedAuthorities.push(whisper);
    const model = await stagedAuthority(stage, authorities[3], "model.bin", 0o400, cutWhisperLocalWorkflowContract.maximumModelBytes); stagedAuthorities.push(model);
    const modelPath = model.snapshot.path;
    await exactVersion(ffmpeg.snapshot.path, ["-version"], `ffmpeg version ${setup.ffmpeg.version}`, "first-line-prefix", signal);
    await exactVersion(whisper.snapshot.path, ["--version"], `whisper.cpp version: ${setup.whisperCli.version}`, "exact", signal);
    await Promise.all([
      assertUnchanged(ffmpeg, cutWhisperLocalWorkflowContract.maximumExecutableBytes, "private FFmpeg"),
      assertUnchanged(whisper, cutWhisperLocalWorkflowContract.maximumExecutableBytes, "private whisper.cpp CLI"),
      assertUnchanged(model, cutWhisperLocalWorkflowContract.maximumModelBytes, "private whisper model"),
    ]);
    const wavePath = join(stage.root, "normalized.wav");
    await runBounded(ffmpeg.snapshot.path, ffmpegArgs(source.streamIndex, wavePath), timeoutMs, signal, authorities[0]);
    await assertUnchanged(ffmpeg, cutWhisperLocalWorkflowContract.maximumExecutableBytes, "private FFmpeg");
    const normalized = await parseNormalizedWave(wavePath);
    if (BigInt(normalized.durationSamples) * BigInt(source.sampleRate) !== BigInt(source.durationSamples) * 16_000n) fail("CUT_WHISPER_WORKFLOW_OUTPUT", "normalized PCM duration differs from locked source duration.");
    const outputPrefix = join(stage.root, "provider"), invocation = receiptInvocation(source.streamIndex, settings, threads);
    await Promise.all([
      assertUnchanged(whisper, cutWhisperLocalWorkflowContract.maximumExecutableBytes, "private whisper.cpp CLI"),
      assertUnchanged(model, cutWhisperLocalWorkflowContract.maximumModelBytes, "private whisper model"),
    ]);
    await runBounded(whisper.snapshot.path, whisperArgs(modelPath, wavePath, outputPrefix, settings, threads), timeoutMs, signal);
    await Promise.all([
      assertUnchanged(whisper, cutWhisperLocalWorkflowContract.maximumExecutableBytes, "private whisper.cpp CLI"),
      assertUnchanged(model, cutWhisperLocalWorkflowContract.maximumModelBytes, "private whisper model"),
    ]);
    const providerBytes = await readRetainedOutput(`${outputPrefix}.json`, cutWhisperLocalWorkflowContract.maximumJsonBytes, "whisper.cpp JSON artifact");
    const provider = parseWhisperJson(providerBytes, source, settings, modelPath);
    await Promise.all([
      assertUnchanged(authorities[0], cutWhisperLocalWorkflowContract.maximumSourceBytes, "source media"),
      assertUnchanged(authorities[1], cutWhisperLocalWorkflowContract.maximumExecutableBytes, "FFmpeg"),
      assertUnchanged(authorities[2], cutWhisperLocalWorkflowContract.maximumExecutableBytes, "whisper.cpp CLI"),
      assertUnchanged(authorities[3], cutWhisperLocalWorkflowContract.maximumModelBytes, "whisper model"),
    ]);
    const materialization = materializeAudioTranscription({
      source: { locator: source.locator, bytes: source.bytes, sha256: source.sha256, streamIndex: source.streamIndex, sampleRate: source.sampleRate, durationSamples: source.durationSamples, normalizedPcmSha256: normalized.pcmSha256 },
      backend: { provider: cutWhisperLocalWorkflowContract.provider, model: `caller-declared:${setup.model.name}`, revision: `caller-declared-cli:${setup.whisperCli.revision}+model:${setup.model.revision}`, adapterSha256: setup.whisperCli.sha256, modelFiles: [{ locator: setup.model.locator, bytes: setup.model.bytes, sha256: setup.model.sha256, license: `caller-declared:${setup.model.license}` }] },
      settings,
      words: provider.words,
    });
    const body: CutWhisperLocalWorkflowReceiptBody = Object.freeze({
      format: "cut-whisper-local-workflow-receipt", version: 1, status: "executed-caller-authenticated-compatible-whisper-cli",
      authorityScope: cutWhisperLocalWorkflowContract.authorityScope,
      runtime: cutWhisperLocalWorkflowContract.runtime, osNetworkSandbox: cutWhisperLocalWorkflowContract.osNetworkSandbox, source,
      ffmpeg: Object.freeze({ bytes: setup.ffmpeg.bytes, sha256: setup.ffmpeg.sha256, version: setup.ffmpeg.version, declaredRevision: setup.ffmpeg.revision }),
      whisperCli: Object.freeze({
        bytes: setup.whisperCli.bytes,
        sha256: setup.whisperCli.sha256,
        version: setup.whisperCli.version,
        declaredRevision: setup.whisperCli.revision,
        declaredSourceArchiveSha256: setup.whisperCli.sourceArchiveSha256,
        declaredBuildPolicy: setup.whisperCli.buildPolicy,
        verifiedLinkagePolicy: setup.whisperCli.linkagePolicy,
        loadedDylibs: closure.loadedDylibs,
      }),
      model: Object.freeze({ locator: setup.model.locator, bytes: setup.model.bytes, sha256: setup.model.sha256, declaredName: setup.model.name, declaredRevision: setup.model.revision, declaredLicense: setup.model.license }),
      policy: Object.freeze({
        provider: cutWhisperLocalWorkflowContract.provider,
        normalization: cutWhisperLocalWorkflowContract.normalization,
        timestamps: cutWhisperLocalWorkflowContract.timestampPolicy,
        adjacentBoundarySnapCount: provider.adjacentBoundarySnapCount,
        tiedBoundaries: cutWhisperLocalWorkflowContract.tiedBoundaryPolicy,
        tiedBoundaryRepairCount: provider.tiedBoundaryRepairCount,
        device: cutWhisperLocalWorkflowContract.devicePolicy,
        threads,
        invocation,
        invocationSha256: sha256(stableJsonStringify(invocation)),
      }),
      normalizedPcm: Object.freeze({ waveBytes: normalized.waveBytes, waveSha256: normalized.waveSha256, pcmBytes: normalized.pcmBytes, pcmSha256: normalized.pcmSha256, sampleFormat: "s16le", sampleRate: 16_000, channels: 1, durationSamples: normalized.durationSamples }),
      providerJson: Object.freeze({ semanticBytes: provider.providerJsonSemanticBytes, semanticSha256: provider.providerJsonSemanticSha256, wordCount: provider.words.length }),
      transcriptionReceipt: materialization.receipt, transcriptSha256: materialization.receipt.transcriptSha256,
    });
    const receipt: CutWhisperLocalWorkflowReceipt = Object.freeze({ ...body, receiptSha256: sha256(stableJsonStringify(body)) });
    const transcriptPath = resolve(projectRoot, transcriptLocator), receiptPath = resolve(projectRoot, receiptLocator);
    if (signal?.aborted) fail("CUT_WHISPER_WORKFLOW_CANCELLED", "transcription was cancelled before publication.");
    await Promise.all(stagedAuthorities.splice(0).map(({ handle }) => handle.close().catch(() => undefined)));
    const completedStage = stage;
    stage = undefined;
    await cleanupStage(completedStage);
    try {
      await writeProjectArtifacts([projectRoot], [
        { destination: transcriptPath, contents: canonicalBytes(materialization.transcript), order: 100, role: "whisper-transcript", expectedDestinationSnapshot: { state: "absent" } },
        { destination: receiptPath, contents: canonicalBytes(receipt), order: 200, role: "whisper-receipt", expectedDestinationSnapshot: { state: "absent" } },
      ], () => { if (signal?.aborted) fail("CUT_WHISPER_WORKFLOW_CANCELLED", "transcription was cancelled during publication."); });
    } catch (error) { if (error instanceof CutWhisperLocalWorkflowError) throw error; fail("CUT_WHISPER_WORKFLOW_PUBLISH", "transcript publication failed and rolled back."); }
    return Object.freeze({ transcriptPath, receiptPath, transcriptSha256: materialization.receipt.transcriptSha256, receipt });
  } finally {
    try {
      await Promise.all(stagedAuthorities.splice(0).map(({ handle }) => handle.close().catch(() => undefined)));
      if (stage) await cleanupStage(stage);
    }
    finally { await Promise.all(authorities.map(({ handle }) => handle.close().catch(() => undefined))); }
  }
}

export async function transcribeProjectAudioWithWhisperLocal(
  inputValue: CutWhisperLocalTranscriptionInput,
): Promise<CutWhisperLocalWorkflowResult> {
  return transcribeProjectAudioWithWhisperLocalWithHooks(inputValue, productionHooks);
}

/** @internal Focused tests only. Not re-exported by the audio-intelligence package. */
export const cutWhisperLocalWorkflowTestOnly = Object.freeze({
  doctorWithFixtureClosure: (value: unknown) => doctorCutWhisperLocalSetupWithHooks(value, Object.freeze({
    verifyWhisperClosure: async () => fixtureClosure,
  })),
  transcribeWithFixtureClosure: (value: CutWhisperLocalTranscriptionInput) => transcribeProjectAudioWithWhisperLocalWithHooks(value, Object.freeze({
    verifyWhisperClosure: async () => fixtureClosure,
  })),
  parseMachOFixture: (value: Uint8Array, fileBytes = value.byteLength) => parseWhisperExecutableClosureBytes(value, BigInt(fileBytes)),
  parseProviderJsonFixture: (value: Uint8Array) => parseStrictProviderJson(Buffer.from(value)),
  parseWhisperJsonFixture: (
    value: Uint8Array,
    source: CutWhisperLocalSourceAuthority,
    settings: AudioTranscriptionSettings,
    modelPath: string,
  ) => parseWhisperJson(Buffer.from(value), source, settings, modelPath),
  ffmpegArgsFixture: (streamIndex: number, outputPath: string) => ffmpegArgs(streamIndex, outputPath),
  settleRetainedAuthoritiesFixture: (promises: readonly Promise<Retained>[]) => settleRetainedAuthorities(promises),
});
