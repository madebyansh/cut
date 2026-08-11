import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdtemp, open, realpath, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { stableJsonStringify } from "../core/stable";
import {
  materializeAudioTranscription,
  type AudioTranscriptionMaterialization,
  type AudioTranscriptionSettings,
  type AudioTranscriptionSource,
} from "./transcription";

export const cutWhisperCppLocalPolicy = Object.freeze({
  format: "cut-whisper-cpp-local-policy",
  version: 1,
  provider: "cut-whisper-cpp-adapter-sample-json-v1",
  normalizedSampleRate: 16_000,
  normalizedChannels: 1,
  normalizedSampleFormat: "f32le",
  outputFormat: "cut-whisper-cpp-sample-transcription",
  outputVersion: 1,
  maximumExecutableBytes: 256 * 1024 * 1024,
  maximumModelBytes: 16 * 1024 * 1024 * 1024,
  maximumPcmBytes: 16 * 1024 * 1024 * 1024,
  maximumWords: 250_000,
  maximumStdoutBytes: 16 * 1024 * 1024,
  maximumStderrBytes: 64 * 1024,
  defaultTimeoutMs: 10 * 60_000,
  maximumTimeoutMs: 30 * 60_000,
  terminationGraceMs: 250,
} as const);

export function isCutWhisperCppLocalPlatformSupported(platform: NodeJS.Platform = process.platform) {
  return platform === "darwin" || platform === "linux";
}

export type CutWhisperCppAuthenticatedFile = Readonly<{
  path: string;
  bytes: number;
  sha256: string;
}>;

export type CutWhisperCppExecutableAuthority = CutWhisperCppAuthenticatedFile & Readonly<{
  revision: string;
}>;

export type CutWhisperCppModelAuthority = CutWhisperCppAuthenticatedFile & Readonly<{
  locator: string;
  name: string;
  revision: string;
  license: string;
}>;

export type CutWhisperCppNormalizedPcmAuthority = CutWhisperCppAuthenticatedFile & Readonly<{
  sampleFormat: "f32le";
  sampleRate: 16_000;
  channels: 1;
  durationSamples: number;
}>;

export type CutWhisperCppLocalInput = Readonly<{
  executable: CutWhisperCppExecutableAuthority;
  model: CutWhisperCppModelAuthority;
  normalizedPcm: CutWhisperCppNormalizedPcmAuthority;
  source: AudioTranscriptionSource;
  settings: AudioTranscriptionSettings;
  timeoutMs?: number;
  signal?: AbortSignal;
}>;

export type CutWhisperCppExecutionReceiptBody = Readonly<{
  format: "cut-whisper-cpp-local-execution";
  version: 1;
  policy: typeof cutWhisperCppLocalPolicy.format;
  provider: typeof cutWhisperCppLocalPolicy.provider;
  executable: Readonly<{
    bytes: number;
    sha256: string;
    revision: string;
  }>;
  model: Readonly<{
    locator: string;
    bytes: number;
    sha256: string;
    name: string;
    revision: string;
    license: string;
  }>;
  normalizedPcm: Readonly<{
    bytes: number;
    sha256: string;
    sampleFormat: "f32le";
    sampleRate: 16_000;
    channels: 1;
    durationSamples: number;
  }>;
  settings: AudioTranscriptionSettings;
  invocation: readonly string[];
  invocationSha256: string;
  stdoutBytes: number;
  stdoutSha256: string;
  stderrBytes: number;
  stderrSha256: string;
  providerWordCount: number;
  transcriptSha256: string;
  transcriptionReceiptSha256: string;
}>;

export type CutWhisperCppExecutionReceipt = CutWhisperCppExecutionReceiptBody & Readonly<{
  executionSha256: string;
}>;

/**
 * The caller owns publication. These are canonical UTF-8 JSON bytes with one
 * trailing LF, ready for a higher-level no-clobber transaction.
 */
export type CutWhisperCppLocalResult = Readonly<{
  materialization: AudioTranscriptionMaterialization;
  transcriptBytes: Buffer;
  transcriptionReceiptBytes: Buffer;
  executionReceipt: CutWhisperCppExecutionReceipt;
  executionReceiptBytes: Buffer;
}>;

export type CutWhisperCppLocalErrorCode =
  | "CUT_WHISPER_LOCAL_CONTRACT"
  | "CUT_WHISPER_LOCAL_AUTHORITY"
  | "CUT_WHISPER_LOCAL_PROCESS"
  | "CUT_WHISPER_LOCAL_TIMEOUT"
  | "CUT_WHISPER_LOCAL_OUTPUT"
  | "CUT_WHISPER_LOCAL_CANCELLED";

export class CutWhisperCppLocalError extends Error {
  constructor(readonly code: CutWhisperCppLocalErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "CutWhisperCppLocalError";
  }
}

type StableFileSnapshot = Readonly<{
  path: string;
  bytes: number;
  sha256: string;
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;

type RetainedFileAuthority = Readonly<{
  handle: FileHandle;
  snapshot: StableFileSnapshot;
}>;

type ProviderWord = Readonly<{ startSample: number; endSample: number; text: string }>;

const sha256Pattern = /^[a-f0-9]{64}$/u;
const safeTextPattern = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$/u;

function fail(code: CutWhisperCppLocalErrorCode, message: string): never {
  throw new CutWhisperCppLocalError(code, message);
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
    fail("CUT_WHISPER_LOCAL_CONTRACT", `${path} must be one plain object.`);
  }
  return value as Record<string, unknown>;
}

function closedRecord(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
) {
  const result = plainRecord(value, path);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(result)) {
    if (!allowed.has(key)) fail("CUT_WHISPER_LOCAL_CONTRACT", `${path}.${key} is not part of the closed contract.`);
  }
  for (const key of required) {
    if (!Object.hasOwn(result, key)) fail("CUT_WHISPER_LOCAL_CONTRACT", `${path}.${key} is required.`);
  }
  return result;
}

function positiveInteger(value: unknown, path: string, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    fail("CUT_WHISPER_LOCAL_CONTRACT", `${path} must be a positive safe integer no greater than ${maximum}.`);
  }
  return Number(value);
}

function nonnegativeInteger(value: unknown, path: string, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) {
    fail("CUT_WHISPER_LOCAL_OUTPUT", `${path} must be a nonnegative safe integer no greater than ${maximum}.`);
  }
  return Number(value);
}

function digest(value: unknown, path: string) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    fail("CUT_WHISPER_LOCAL_CONTRACT", `${path} must be one lowercase SHA-256 digest.`);
  }
  return value;
}

function text(value: unknown, path: string, maximumBytes = 4_096) {
  if (typeof value !== "string" || !value || value !== value.trim()
    || value.normalize("NFC") !== value || !safeTextPattern.test(value)
    || Buffer.byteLength(value, "utf8") > maximumBytes) {
    fail("CUT_WHISPER_LOCAL_CONTRACT", `${path} must be bounded, trimmed, NFC, control-free text.`);
  }
  return value;
}

function absolutePath(value: unknown, path: string) {
  const result = text(value, path, 16_384);
  if (!isAbsolute(result) || resolve(result) !== result || result.includes("\\")
    || result.split("/").some((part, index) => index > 0 && (!part || part === "." || part === ".."))) {
    fail("CUT_WHISPER_LOCAL_CONTRACT", `${path} must be one canonical absolute POSIX path.`);
  }
  return result;
}

function relativeLocator(value: unknown, path: string) {
  const result = text(value, path, 4_096);
  if (result.startsWith("/") || result.includes("\\")
    || result.split("/").some((part) => !part || part === "." || part === "..")) {
    fail("CUT_WHISPER_LOCAL_CONTRACT", `${path} must be one canonical relative POSIX locator.`);
  }
  return result;
}

function parseAuthenticatedFile(
  value: unknown,
  path: string,
  maximumBytes: number,
) {
  const item = closedRecord(value, path, ["path", "bytes", "sha256"]);
  return Object.freeze({
    path: absolutePath(item.path, `${path}.path`),
    bytes: positiveInteger(item.bytes, `${path}.bytes`, maximumBytes),
    sha256: digest(item.sha256, `${path}.sha256`),
  });
}

function parseInput(input: unknown) {
  const item = closedRecord(input, "$", [
    "executable", "model", "normalizedPcm", "source", "settings",
  ], ["timeoutMs", "signal"]);
  const executableItem = closedRecord(item.executable, "$.executable", [
    "path", "bytes", "sha256", "revision",
  ]);
  const executableFile = parseAuthenticatedFile({
    path: executableItem.path,
    bytes: executableItem.bytes,
    sha256: executableItem.sha256,
  }, "$.executable", cutWhisperCppLocalPolicy.maximumExecutableBytes);
  const executable = Object.freeze({
    ...executableFile,
    revision: text(executableItem.revision, "$.executable.revision"),
  });
  const modelItem = closedRecord(item.model, "$.model", [
    "path", "locator", "bytes", "sha256", "name", "revision", "license",
  ]);
  const modelFile = parseAuthenticatedFile({
    path: modelItem.path,
    bytes: modelItem.bytes,
    sha256: modelItem.sha256,
  }, "$.model", cutWhisperCppLocalPolicy.maximumModelBytes);
  const model = Object.freeze({
    ...modelFile,
    locator: relativeLocator(modelItem.locator, "$.model.locator"),
    name: text(modelItem.name, "$.model.name"),
    revision: text(modelItem.revision, "$.model.revision"),
    license: text(modelItem.license, "$.model.license", 1_024),
  });
  const pcmItem = closedRecord(item.normalizedPcm, "$.normalizedPcm", [
    "path", "bytes", "sha256", "sampleFormat", "sampleRate", "channels", "durationSamples",
  ]);
  const pcmFile = parseAuthenticatedFile({
    path: pcmItem.path,
    bytes: pcmItem.bytes,
    sha256: pcmItem.sha256,
  }, "$.normalizedPcm", cutWhisperCppLocalPolicy.maximumPcmBytes);
  const durationSamples = positiveInteger(pcmItem.durationSamples, "$.normalizedPcm.durationSamples");
  if (pcmItem.sampleFormat !== cutWhisperCppLocalPolicy.normalizedSampleFormat
    || pcmItem.sampleRate !== cutWhisperCppLocalPolicy.normalizedSampleRate
    || pcmItem.channels !== cutWhisperCppLocalPolicy.normalizedChannels) {
    fail("CUT_WHISPER_LOCAL_CONTRACT", "$.normalizedPcm must be exact mono 16 kHz f32le PCM.");
  }
  if (pcmFile.bytes !== durationSamples * 4) {
    fail("CUT_WHISPER_LOCAL_CONTRACT", "$.normalizedPcm bytes must equal durationSamples times four f32le bytes.");
  }
  const normalizedPcm = Object.freeze({
    ...pcmFile,
    sampleFormat: "f32le" as const,
    sampleRate: 16_000 as const,
    channels: 1 as const,
    durationSamples,
  });
  const adapterSha256 = executable.sha256;
  let source: AudioTranscriptionSource;
  let settings: AudioTranscriptionSettings;
  try {
    const preflight = materializeAudioTranscription({
      source: item.source,
      backend: {
        provider: cutWhisperCppLocalPolicy.provider,
        model: model.name,
        revision: model.revision,
        adapterSha256,
        modelFiles: [{
          locator: model.locator,
          bytes: model.bytes,
          sha256: model.sha256,
          license: model.license,
        }],
      },
      settings: item.settings,
      words: [],
    });
    source = preflight.receipt.source;
    settings = preflight.receipt.settings;
  } catch {
    fail("CUT_WHISPER_LOCAL_CONTRACT", "source, settings, or backend identity violates the closed transcription contract.");
  }
  const timeoutMs = item.timeoutMs === undefined
    ? cutWhisperCppLocalPolicy.defaultTimeoutMs
    : positiveInteger(item.timeoutMs, "$.timeoutMs", cutWhisperCppLocalPolicy.maximumTimeoutMs);
  if (item.signal !== undefined && !(item.signal instanceof AbortSignal)) {
    fail("CUT_WHISPER_LOCAL_CONTRACT", "$.signal must be one AbortSignal.");
  }
  if (new Set([executable.path, model.path, normalizedPcm.path]).size !== 3) {
    fail("CUT_WHISPER_LOCAL_CONTRACT", "executable, model, and normalized PCM paths must be distinct.");
  }
  if (source.normalizedPcmSha256 !== normalizedPcm.sha256) {
    fail("CUT_WHISPER_LOCAL_CONTRACT", "$.source.normalizedPcmSha256 must bind $.normalizedPcm.sha256.");
  }
  if (!Number.isSafeInteger(source.sampleRate) || source.sampleRate < 1
    || !Number.isSafeInteger(source.durationSamples) || source.durationSamples < 1
    || BigInt(source.durationSamples) * 16_000n !== BigInt(normalizedPcm.durationSamples) * BigInt(source.sampleRate)) {
    fail("CUT_WHISPER_LOCAL_CONTRACT", "source and normalized PCM durations must be exactly rationally equal.");
  }
  return Object.freeze({
    executable,
    model,
    normalizedPcm,
    source,
    settings,
    timeoutMs,
    ...(item.signal === undefined ? {} : { signal: item.signal as AbortSignal }),
  });
}

async function openRetainedFileAuthority(
  path: string,
  maximumBytes: number,
  label: string,
): Promise<RetainedFileAuthority> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (await realpath(path) !== path) fail("CUT_WHISPER_LOCAL_AUTHORITY", `${label} path must be canonical and symlink-free at its final component.`);
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maximumBytes)) {
      fail("CUT_WHISPER_LOCAL_AUTHORITY", `${label} is not one bounded regular file.`);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0n;
    while (position < before.size) {
      const length = Number(before.size - position > BigInt(buffer.length) ? BigInt(buffer.length) : before.size - position);
      const { bytesRead } = await handle.read(buffer, 0, length, Number(position));
      if (bytesRead !== length) fail("CUT_WHISPER_LOCAL_AUTHORITY", `${label} changed while it was authenticated.`);
      hash.update(buffer.subarray(0, bytesRead));
      position += BigInt(bytesRead);
    }
    const after = await handle.stat({ bigint: true });
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      fail("CUT_WHISPER_LOCAL_AUTHORITY", `${label} changed while it was authenticated.`);
    }
    const snapshot = Object.freeze({
      path,
      bytes: Number(before.size),
      sha256: hash.digest("hex"),
      dev: before.dev,
      ino: before.ino,
      size: before.size,
      mtimeNs: before.mtimeNs,
      ctimeNs: before.ctimeNs,
    });
    const authority = Object.freeze({ handle, snapshot });
    handle = undefined;
    return authority;
  } catch (error) {
    if (error instanceof CutWhisperCppLocalError) throw error;
    return fail("CUT_WHISPER_LOCAL_AUTHORITY", `${label} could not be authenticated.`);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function snapshotRegularFile(path: string, maximumBytes: number, label: string): Promise<StableFileSnapshot> {
  const authority = await openRetainedFileAuthority(path, maximumBytes, label);
  try { return authority.snapshot; }
  finally { await authority.handle.close().catch(() => undefined); }
}

async function openInputFileAuthorities(input: ReturnType<typeof parseInput>) {
  const opened: RetainedFileAuthority[] = [];
  try {
    opened.push(await openRetainedFileAuthority(
      input.executable.path,
      cutWhisperCppLocalPolicy.maximumExecutableBytes,
      "whisper.cpp executable",
    ));
    opened.push(await openRetainedFileAuthority(
      input.model.path,
      cutWhisperCppLocalPolicy.maximumModelBytes,
      "whisper.cpp model",
    ));
    opened.push(await openRetainedFileAuthority(
      input.normalizedPcm.path,
      cutWhisperCppLocalPolicy.maximumPcmBytes,
      "normalized PCM",
    ));
    return opened as [RetainedFileAuthority, RetainedFileAuthority, RetainedFileAuthority];
  } catch (error) {
    await Promise.all(opened.map(({ handle }) => handle.close().catch(() => undefined)));
    throw error;
  }
}

function assertExpectedSnapshot(
  observed: StableFileSnapshot,
  expected: CutWhisperCppAuthenticatedFile,
  label: string,
) {
  if (observed.bytes !== expected.bytes || observed.sha256 !== expected.sha256) {
    fail("CUT_WHISPER_LOCAL_AUTHORITY", `${label} bytes differ from the caller-supplied authority.`);
  }
}

async function assertSnapshotUnchanged(
  snapshot: StableFileSnapshot,
  maximumBytes: number,
  label: string,
) {
  const current = await snapshotRegularFile(snapshot.path, maximumBytes, label);
  if (current.dev !== snapshot.dev || current.ino !== snapshot.ino || current.size !== snapshot.size
    || current.mtimeNs !== snapshot.mtimeNs || current.ctimeNs !== snapshot.ctimeNs
    || current.sha256 !== snapshot.sha256) {
    fail("CUT_WHISPER_LOCAL_AUTHORITY", `${label} changed during whisper.cpp execution.`);
  }
}

async function assertRetainedFileAuthorityUnchanged(
  authority: RetainedFileAuthority,
  maximumBytes: number,
  label: string,
) {
  const { snapshot, handle } = authority;
  let current;
  try { current = await handle.stat({ bigint: true }); }
  catch { fail("CUT_WHISPER_LOCAL_AUTHORITY", `${label} retained file authority could not be revalidated.`); }
  if (!current.isFile() || current.dev !== snapshot.dev || current.ino !== snapshot.ino
    || current.size !== snapshot.size || current.mtimeNs !== snapshot.mtimeNs
    || current.ctimeNs !== snapshot.ctimeNs) {
    fail("CUT_WHISPER_LOCAL_AUTHORITY", `${label} retained bytes changed during whisper.cpp execution.`);
  }
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0n;
  while (position < current.size) {
    const length = Number(current.size - position > BigInt(buffer.length)
      ? BigInt(buffer.length)
      : current.size - position);
    const { bytesRead } = await handle.read(buffer, 0, length, Number(position));
    if (bytesRead !== length) {
      fail("CUT_WHISPER_LOCAL_AUTHORITY", `${label} retained bytes changed during whisper.cpp execution.`);
    }
    hash.update(buffer.subarray(0, bytesRead));
    position += BigInt(bytesRead);
  }
  if (hash.digest("hex") !== snapshot.sha256) {
    fail("CUT_WHISPER_LOCAL_AUTHORITY", `${label} retained bytes changed during whisper.cpp execution.`);
  }
  await assertSnapshotUnchanged(snapshot, maximumBytes, label);
}

type PrivateExecutable = Readonly<{
  root: string;
  rootDev: bigint;
  rootIno: bigint;
  path: string;
  snapshot: StableFileSnapshot;
}>;

async function preparePrivateExecutable(sourceAuthority: RetainedFileAuthority): Promise<PrivateExecutable> {
  const { snapshot: source, handle: sourceHandle } = sourceAuthority;
  const root = await realpath(await mkdtemp(join(tmpdir(), "cut-whisper-adapter-")));
  const path = join(root, "adapter");
  let targetHandle: Awaited<ReturnType<typeof open>> | undefined;
  let rootDev = 0n;
  let rootIno = 0n;
  try {
    await chmod(root, 0o700);
    const rootStat = await lstat(root, { bigint: true });
    if (!rootStat.isDirectory()) fail("CUT_WHISPER_LOCAL_AUTHORITY", "private whisper.cpp adapter root is not a directory.");
    rootDev = rootStat.dev;
    rootIno = rootStat.ino;
    const before = await sourceHandle.stat({ bigint: true });
    if (!before.isFile() || before.dev !== source.dev || before.ino !== source.ino || before.size !== source.size
      || before.mtimeNs !== source.mtimeNs || before.ctimeNs !== source.ctimeNs) {
      fail("CUT_WHISPER_LOCAL_AUTHORITY", "whisper.cpp adapter changed before private executable preparation.");
    }
    targetHandle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o700,
    );
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0n;
    while (position < source.size) {
      const length = Number(source.size - position > BigInt(buffer.length) ? BigInt(buffer.length) : source.size - position);
      const read = await sourceHandle.read(buffer, 0, length, Number(position));
      if (read.bytesRead !== length) fail("CUT_WHISPER_LOCAL_AUTHORITY", "whisper.cpp adapter changed during private executable preparation.");
      const written = await targetHandle.write(buffer, 0, length, Number(position));
      if (written.bytesWritten !== length) fail("CUT_WHISPER_LOCAL_AUTHORITY", "private whisper.cpp adapter copy could not be completed.");
      position += BigInt(length);
    }
    await targetHandle.sync();
    await targetHandle.chmod(0o700);
    const after = await sourceHandle.stat({ bigint: true });
    if (after.dev !== source.dev || after.ino !== source.ino || after.size !== source.size
      || after.mtimeNs !== source.mtimeNs || after.ctimeNs !== source.ctimeNs) {
      fail("CUT_WHISPER_LOCAL_AUTHORITY", "whisper.cpp adapter changed during private executable preparation.");
    }
  } catch (error) {
    await removeOwnedPrivateRoot(root, rootDev, rootIno).catch(() => undefined);
    if (error instanceof CutWhisperCppLocalError) throw error;
    fail("CUT_WHISPER_LOCAL_AUTHORITY", "private whisper.cpp adapter copy could not be prepared.");
  } finally {
    await targetHandle?.close().catch(() => undefined);
  }
  let snapshot: StableFileSnapshot;
  try {
    snapshot = await snapshotRegularFile(
      path,
      cutWhisperCppLocalPolicy.maximumExecutableBytes,
      "private whisper.cpp adapter",
    );
  } catch (error) {
    await removeOwnedPrivateRoot(root, rootDev, rootIno).catch(() => undefined);
    throw error;
  }
  if (snapshot.bytes !== source.bytes || snapshot.sha256 !== source.sha256) {
    await removeOwnedPrivateRoot(root, rootDev, rootIno).catch(() => undefined);
    fail("CUT_WHISPER_LOCAL_AUTHORITY", "private whisper.cpp adapter bytes differ from authenticated source bytes.");
  }
  return Object.freeze({ root, rootDev, rootIno, path, snapshot });
}

async function removeOwnedPrivateRoot(root: string, expectedDev: bigint, expectedIno: bigint) {
  const observed = await lstat(root, { bigint: true });
  if (!observed.isDirectory() || expectedDev === 0n || expectedIno === 0n
    || observed.dev !== expectedDev || observed.ino !== expectedIno) {
    fail("CUT_WHISPER_LOCAL_AUTHORITY", "private whisper.cpp adapter root identity changed before cleanup.");
  }
  await rm(root, { recursive: true, force: false });
}

async function cleanupPrivateExecutable(value: PrivateExecutable) {
  let changed = false;
  try {
    await assertSnapshotUnchanged(
      value.snapshot,
      cutWhisperCppLocalPolicy.maximumExecutableBytes,
      "private whisper.cpp adapter",
    );
  } catch { changed = true; }
  await removeOwnedPrivateRoot(value.root, value.rootDev, value.rootIno);
  if (changed) fail("CUT_WHISPER_LOCAL_AUTHORITY", "private whisper.cpp adapter changed during execution.");
}

function providerArguments(input: ReturnType<typeof parseInput>) {
  return Object.freeze([
    "--cut-sample-json-v1",
    "--model-fd", "3",
    "--pcm-fd", "4",
    "--sample-rate", "16000",
    "--language", input.settings.language,
    "--temperature-milli", String(input.settings.temperatureMilli),
    "--no-fallback", input.settings.noFallback ? "true" : "false",
  ]);
}

type ProviderProcessResult = Readonly<{
  stdout: Buffer;
  stderr: Buffer;
}>;

async function processGroupExists(pid: number) {
  if (process.platform === "win32") return false;
  try { process.kill(-pid, 0); return true; }
  catch (error) {
    return !(error && typeof error === "object" && "code" in error && error.code === "ESRCH");
  }
}

async function runProvider(
  executable: string,
  args: readonly string[],
  modelFd: number,
  pcmFd: number,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<ProviderProcessResult> {
  if (signal?.aborted) fail("CUT_WHISPER_LOCAL_CANCELLED", "whisper.cpp execution was cancelled before launch.");
  if (!isCutWhisperCppLocalPlatformSupported()) {
    fail("CUT_WHISPER_LOCAL_PROCESS", "whisper.cpp local execution is unsupported on this platform until complete process-tree cleanup is implemented.");
  }
  const useProcessGroup = true;
  return new Promise<ProviderProcessResult>((accept, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, [...args], {
        shell: false,
        detached: useProcessGroup,
        stdio: ["ignore", "pipe", "pipe", modelFd, pcmFd],
        windowsHide: true,
        env: Object.freeze({ LANG: "C", LC_ALL: "C" }),
      });
    } catch {
      reject(new CutWhisperCppLocalError("CUT_WHISPER_LOCAL_PROCESS", "whisper.cpp could not start."));
      return;
    }
    let launchSettled = false;
    const rejectLaunch = () => {
      if (launchSettled) return;
      launchSettled = true;
      reject(new CutWhisperCppLocalError("CUT_WHISPER_LOCAL_PROCESS", "whisper.cpp failed during launch."));
    };
    child.once("error", rejectLaunch);
    const pid = child.pid;
    if (!Number.isSafeInteger(pid) || Number(pid) < 1) {
      try { child.kill("SIGKILL"); } catch { /* launch never completed */ }
      rejectLaunch();
      return;
    }
    child.removeListener("error", rejectLaunch);
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let failure: CutWhisperCppLocalError | undefined;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const signalTree = (value: NodeJS.Signals) => {
      if (useProcessGroup) {
        try { process.kill(-pid!, value); return; } catch { /* direct-child fallback */ }
      }
      try { child.kill(value); } catch { /* already closed */ }
    };
    const terminate = (error: CutWhisperCppLocalError) => {
      if (failure) return;
      failure = error;
      signalTree("SIGTERM");
      killTimer = setTimeout(() => signalTree("SIGKILL"), cutWhisperCppLocalPolicy.terminationGraceMs);
    };
    const abort = () => terminate(new CutWhisperCppLocalError(
      "CUT_WHISPER_LOCAL_CANCELLED",
      "whisper.cpp execution was cancelled.",
    ));
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => terminate(new CutWhisperCppLocalError(
      "CUT_WHISPER_LOCAL_TIMEOUT",
      `whisper.cpp exceeded ${timeoutMs}ms.`,
    )), timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (failure) return;
      const copy = Buffer.from(chunk);
      stdoutBytes += copy.byteLength;
      if (stdoutBytes > cutWhisperCppLocalPolicy.maximumStdoutBytes) {
        terminate(new CutWhisperCppLocalError("CUT_WHISPER_LOCAL_OUTPUT", "whisper.cpp stdout exceeded its byte limit."));
      } else stdout.push(copy);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (failure) return;
      const copy = Buffer.from(chunk);
      stderrBytes += copy.byteLength;
      if (stderrBytes > cutWhisperCppLocalPolicy.maximumStderrBytes) {
        terminate(new CutWhisperCppLocalError("CUT_WHISPER_LOCAL_OUTPUT", "whisper.cpp stderr exceeded its byte limit."));
      } else stderr.push(copy);
    });
    child.once("error", () => terminate(new CutWhisperCppLocalError(
      "CUT_WHISPER_LOCAL_PROCESS",
      "whisper.cpp failed after launch.",
    )));
    child.once("close", async (code, terminalSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      if (failure) {
        signalTree("SIGKILL");
        await new Promise((resolveWait) => setTimeout(resolveWait, cutWhisperCppLocalPolicy.terminationGraceMs));
        if (await processGroupExists(pid!)) {
          reject(new CutWhisperCppLocalError("CUT_WHISPER_LOCAL_PROCESS", "whisper.cpp process group survived forced cleanup."));
        } else reject(failure);
        return;
      }
      if (await processGroupExists(pid!)) {
        signalTree("SIGKILL");
        reject(new CutWhisperCppLocalError("CUT_WHISPER_LOCAL_PROCESS", "whisper.cpp left a descendant process alive."));
        return;
      }
      if (code !== 0 || terminalSignal !== null) {
        reject(new CutWhisperCppLocalError("CUT_WHISPER_LOCAL_PROCESS", "whisper.cpp exited unsuccessfully."));
        return;
      }
      accept(Object.freeze({
        stdout: Buffer.concat(stdout, stdoutBytes),
        stderr: Buffer.concat(stderr, stderrBytes),
      }));
    });
  });
}

function parseProviderOutput(bytes: Buffer, durationSamples: number): readonly ProviderWord[] {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { fail("CUT_WHISPER_LOCAL_OUTPUT", "whisper.cpp returned malformed JSON."); }
  const output = closedRecord(value, "$provider", ["format", "version", "sampleRate", "words"]);
  if (output.format !== cutWhisperCppLocalPolicy.outputFormat
    || output.version !== cutWhisperCppLocalPolicy.outputVersion
    || output.sampleRate !== cutWhisperCppLocalPolicy.normalizedSampleRate
    || !Array.isArray(output.words) || output.words.length > cutWhisperCppLocalPolicy.maximumWords) {
    fail("CUT_WHISPER_LOCAL_OUTPUT", "whisper.cpp returned an unsupported sample-timestamp result.");
  }
  const words: ProviderWord[] = [];
  let previousEnd = 0;
  for (let index = 0; index < output.words.length; index += 1) {
    const path = `$provider.words[${index}]`;
    const item = closedRecord(output.words[index], path, ["startSample", "endSample", "text"]);
    const startSample = nonnegativeInteger(item.startSample, `${path}.startSample`, durationSamples);
    const endSample = nonnegativeInteger(item.endSample, `${path}.endSample`, durationSamples);
    if (endSample <= startSample || startSample < previousEnd) {
      fail("CUT_WHISPER_LOCAL_OUTPUT", `${path} must be positive, ordered, and nonoverlapping.`);
    }
    const wordText = text(item.text, `${path}.text`, 4_096);
    if (/\s/u.test(wordText)) fail("CUT_WHISPER_LOCAL_OUTPUT", `${path}.text must contain one word without whitespace.`);
    words.push(Object.freeze({ startSample, endSample, text: wordText }));
    previousEnd = endSample;
  }
  return Object.freeze(words);
}

/** Round one exact rational boundary to the nearest source sample, ties upward. */
function mapSampleBoundary(sample: number, sourceSampleRate: number) {
  const numerator = BigInt(sample) * BigInt(sourceSampleRate);
  const denominator = BigInt(cutWhisperCppLocalPolicy.normalizedSampleRate);
  const mapped = (numerator * 2n + denominator) / (denominator * 2n);
  if (mapped < 0n || mapped > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail("CUT_WHISPER_LOCAL_OUTPUT", "whisper.cpp sample timestamp exceeds CUT's source-sample grid.");
  }
  return Number(mapped);
}

function mappedWords(
  words: readonly ProviderWord[],
  sourceSampleRate: number,
  sourceDurationSamples: number,
) {
  let previousEnd = 0;
  return Object.freeze(words.map((word, index) => {
    const startSample = mapSampleBoundary(word.startSample, sourceSampleRate);
    const endSample = mapSampleBoundary(word.endSample, sourceSampleRate);
    if (endSample <= startSample || startSample < previousEnd || endSample > sourceDurationSamples) {
      fail("CUT_WHISPER_LOCAL_OUTPUT", `mapped word ${index} is collapsed, overlapping, or outside the source sample grid.`);
    }
    previousEnd = endSample;
    return Object.freeze({ startSample, endSample, text: word.text });
  }));
}

/**
 * Execute one caller-authenticated CUT adapter around whisper.cpp. Stock
 * whisper-cli does not expose this sample-JSON protocol directly. This is a
 * provider contract, not bundled ASR: CUT neither downloads nor selects the
 * adapter/model bytes here. The normalized mono 16 kHz f32le artifact must
 * already exist and be authenticated by the caller.
 */
export async function transcribeWithWhisperCppLocal(inputValue: CutWhisperCppLocalInput): Promise<CutWhisperCppLocalResult> {
  const input = parseInput(inputValue);
  const [executableAuthority, modelAuthority, pcmAuthority] = await openInputFileAuthorities(input);
  try {
    assertExpectedSnapshot(executableAuthority.snapshot, input.executable, "whisper.cpp executable");
    assertExpectedSnapshot(modelAuthority.snapshot, input.model, "whisper.cpp model");
    assertExpectedSnapshot(pcmAuthority.snapshot, input.normalizedPcm, "normalized PCM");
  } catch (error) {
    await Promise.all([
      executableAuthority.handle.close().catch(() => undefined),
      modelAuthority.handle.close().catch(() => undefined),
      pcmAuthority.handle.close().catch(() => undefined),
    ]);
    throw error;
  }
  const args = providerArguments(input);
  let privateExecutable: PrivateExecutable | undefined;
  let processResult: ProviderProcessResult | undefined;
  let processError: unknown;
  let authorityError: unknown;
  try {
    privateExecutable = await preparePrivateExecutable(executableAuthority);
    try {
      processResult = await runProvider(
        privateExecutable.path,
        args,
        modelAuthority.handle.fd,
        pcmAuthority.handle.fd,
        input.timeoutMs,
        input.signal,
      );
    } catch (error) { processError = error; }
    try {
      await Promise.all([
        assertRetainedFileAuthorityUnchanged(
          executableAuthority,
          cutWhisperCppLocalPolicy.maximumExecutableBytes,
          "whisper.cpp executable",
        ),
        assertRetainedFileAuthorityUnchanged(
          modelAuthority,
          cutWhisperCppLocalPolicy.maximumModelBytes,
          "whisper.cpp model",
        ),
        assertRetainedFileAuthorityUnchanged(
          pcmAuthority,
          cutWhisperCppLocalPolicy.maximumPcmBytes,
          "normalized PCM",
        ),
      ]);
      await cleanupPrivateExecutable(privateExecutable);
      privateExecutable = undefined;
    } catch (error) {
      authorityError = error;
      if (privateExecutable) {
        await removeOwnedPrivateRoot(
          privateExecutable.root,
          privateExecutable.rootDev,
          privateExecutable.rootIno,
        ).catch(() => undefined);
        privateExecutable = undefined;
      }
    }
  } finally {
    await Promise.all([
      executableAuthority.handle.close().catch(() => undefined),
      modelAuthority.handle.close().catch(() => undefined),
      pcmAuthority.handle.close().catch(() => undefined),
    ]);
  }
  if (authorityError) throw authorityError;
  if (processError) throw processError;
  const observed = processResult!;
  const providerWords = parseProviderOutput(observed.stdout, input.normalizedPcm.durationSamples);
  const words = mappedWords(providerWords, input.source.sampleRate, input.source.durationSamples);
  const materialization = materializeAudioTranscription({
    source: input.source,
    backend: {
      provider: cutWhisperCppLocalPolicy.provider,
      model: input.model.name,
      revision: input.model.revision,
      adapterSha256: input.executable.sha256,
      modelFiles: [{
        locator: input.model.locator,
        bytes: input.model.bytes,
        sha256: input.model.sha256,
        license: input.model.license,
      }],
    },
    settings: input.settings,
    words,
  });
  const transcriptBytes = canonicalBytes(materialization.transcript);
  const transcriptionReceiptBytes = canonicalBytes(materialization.receipt);
  const invocation = Object.freeze([
    `cut-whisper-cpp-adapter-sha256:${input.executable.sha256}`,
    ...args,
  ]);
  const body: CutWhisperCppExecutionReceiptBody = Object.freeze({
    format: "cut-whisper-cpp-local-execution",
    version: 1,
    policy: cutWhisperCppLocalPolicy.format,
    provider: cutWhisperCppLocalPolicy.provider,
    executable: Object.freeze({
      bytes: input.executable.bytes,
      sha256: input.executable.sha256,
      revision: input.executable.revision,
    }),
    model: Object.freeze({
      locator: input.model.locator,
      bytes: input.model.bytes,
      sha256: input.model.sha256,
      name: input.model.name,
      revision: input.model.revision,
      license: input.model.license,
    }),
    normalizedPcm: Object.freeze({
      bytes: input.normalizedPcm.bytes,
      sha256: input.normalizedPcm.sha256,
      sampleFormat: input.normalizedPcm.sampleFormat,
      sampleRate: input.normalizedPcm.sampleRate,
      channels: input.normalizedPcm.channels,
      durationSamples: input.normalizedPcm.durationSamples,
    }),
    settings: Object.freeze({ ...input.settings }),
    invocation,
    invocationSha256: sha256(stableJsonStringify(invocation)),
    stdoutBytes: observed.stdout.byteLength,
    stdoutSha256: sha256(observed.stdout),
    stderrBytes: observed.stderr.byteLength,
    stderrSha256: sha256(observed.stderr),
    providerWordCount: providerWords.length,
    transcriptSha256: materialization.receipt.transcriptSha256,
    transcriptionReceiptSha256: materialization.receipt.receiptSha256,
  });
  const executionReceipt: CutWhisperCppExecutionReceipt = Object.freeze({
    ...body,
    executionSha256: sha256(stableJsonStringify(body)),
  });
  return Object.freeze({
    materialization,
    transcriptBytes,
    transcriptionReceiptBytes,
    executionReceipt,
    executionReceiptBytes: canonicalBytes(executionReceipt),
  });
}
