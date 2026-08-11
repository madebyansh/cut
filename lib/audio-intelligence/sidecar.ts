import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { stableJsonStringify } from "../core/stable";

export const cutAudioIntelligenceCapabilities = Object.freeze(["analyze", "transcribe", "narrate"] as const);
export type CutAudioIntelligenceCapability = (typeof cutAudioIntelligenceCapabilities)[number];
export const cutAudioIntelligenceModelRoles = Object.freeze(["analysis", "asr", "tts"] as const);
export type CutAudioIntelligenceModelRole = (typeof cutAudioIntelligenceModelRoles)[number];

export const cutAudioIntelligenceSidecarLimits = Object.freeze({
  maximumRequestBytes: 64 * 1024,
  maximumResponseLineBytes: 64 * 1024,
  maximumStdoutBytes: 256 * 1024,
  maximumStderrBytes: 64 * 1024,
  maximumArgumentBytes: 4_096,
  maximumTotalArgumentBytes: 32 * 1024,
  maximumArguments: 32,
  maximumEnvironmentValueBytes: 4_096,
  maximumInputArtifactBytes: 64 * 1024 * 1024 * 1024,
  maximumRequestArtifactBytes: 16 * 1024 * 1024,
  maximumOutputArtifactBytes: 64 * 1024 * 1024 * 1024,
  handshakeMs: 30_000,
  operationMs: 10 * 60_000,
  closeMs: 5_000,
  terminateGraceMs: 1_000,
});

const sidecarLimitCeilings = Object.freeze({
  ...cutAudioIntelligenceSidecarLimits,
  handshakeMs: 30 * 60_000,
  operationMs: 60 * 60_000,
});

export type CutAudioIntelligenceModelAuthority = Readonly<{
  role: CutAudioIntelligenceModelRole;
  model: string;
  revision: string;
  authoritySha256: string;
}>;

export type CutAudioIntelligenceSidecarHandshake = Readonly<{
  format: "cut-audio-intelligence-sidecar-handshake";
  version: 1;
  protocolVersion: 1;
  provider: string;
  revision: string;
  capabilities: readonly CutAudioIntelligenceCapability[];
  adapterSha256: string;
  selfTestSha256: string;
  models: readonly CutAudioIntelligenceModelAuthority[];
  modelsSha256: string;
}>;

export type CutAudioIntelligenceArtifact = Readonly<{ path: string; bytes: number; sha256: string }>;
export type CutAudioIntelligenceSidecarLimitOverrides = Readonly<{
  [Key in keyof typeof cutAudioIntelligenceSidecarLimits]?: number;
}>;

export type CutAudioIntelligenceSidecarStart = Readonly<{
  executable: string;
  arguments: readonly string[];
  outputRoot: string;
  expectedHandshake: CutAudioIntelligenceSidecarHandshake;
  environment?: Readonly<Record<string, string>>;
  limits?: CutAudioIntelligenceSidecarLimitOverrides;
  signal?: AbortSignal;
}>;

export type CutAudioIntelligenceSidecarSession = Readonly<{
  readonly handshake: CutAudioIntelligenceSidecarHandshake;
  readonly pid: number | undefined;
  analyze(request: Readonly<{ inputPath: string; requestPath: string; outputPath: string }>): Promise<CutAudioIntelligenceArtifact>;
  transcribe(request: Readonly<{ inputPath: string; requestPath: string; outputPath: string }>): Promise<CutAudioIntelligenceArtifact>;
  narrate(request: Readonly<{ requestPath: string; outputWavPath: string; outputMetadataPath: string }>): Promise<Readonly<{ wav: CutAudioIntelligenceArtifact; metadata: CutAudioIntelligenceArtifact }>>;
  close(): Promise<void>;
}>;

export class CutAudioIntelligenceSidecarError extends Error {
  readonly code = "CUT_AUDIO_INTELLIGENCE_SIDECAR" as const;
  constructor(message: string) {
    super(`CUT_AUDIO_INTELLIGENCE_SIDECAR: ${message}`);
    this.name = "CutAudioIntelligenceSidecarError";
  }
}

type ResolvedLimits = Readonly<{
  [Key in keyof typeof cutAudioIntelligenceSidecarLimits]: number;
}>;
type Operation = CutAudioIntelligenceCapability | "close";
type Pending = Readonly<{
  id: string;
  operation: Operation;
  timer: NodeJS.Timeout;
  parse: (value: unknown) => unknown;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}>;

const shaPattern = /^[a-f0-9]{64}$/u;
const safeTextPattern = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$/u;
const allowedEnvironment = new Set([
  "CUT_AUDIO_INTELLIGENCE_CACHE_ROOT",
  "CUT_AUDIO_INTELLIGENCE_MODEL_ROOT",
  "TMPDIR",
]);
const roleForCapability = Object.freeze({ analyze: "analysis", transcribe: "asr", narrate: "tts" } as const);

function failure(reason: string): CutAudioIntelligenceSidecarError {
  return new CutAudioIntelligenceSidecarError(reason);
}
function protocol(reason: string): never { throw failure(reason); }
function object(value: unknown, reason: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) protocol(reason);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) protocol(reason);
  return value as Record<string, unknown>;
}
function closed(value: unknown, required: readonly string[], reason: string) {
  const result = object(value, reason), keys = Object.keys(result);
  if (keys.length !== required.length || required.some((key) => !Object.hasOwn(result, key))) protocol(reason);
  return result;
}
function text(value: unknown, maximum: number, reason: string) {
  if (typeof value !== "string" || !value || value !== value.trim() || value.normalize("NFC") !== value
    || Buffer.byteLength(value, "utf8") > maximum || !safeTextPattern.test(value)) protocol(reason);
  return value;
}
function digest(value: unknown, reason: string) {
  if (typeof value !== "string" || !shaPattern.test(value)) protocol(reason);
  return value;
}
function positive(value: unknown, maximum: number, reason: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) protocol(reason);
  return Number(value);
}
function absolutePath(value: unknown, reason: string) {
  const result = text(value, 16_384, reason);
  if (!result.startsWith("/") || result.includes("\\") || /[\u0000-\u001f\u007f]/u.test(result)
    || result.split("/").some((segment, index) => index > 0 && (!segment || segment === "." || segment === ".."))) protocol(reason);
  return result;
}
function executablePath(value: unknown) {
  return absolutePath(value, "executable is malformed");
}

type FileSnapshot = Readonly<{
  path: string;
  bytes: number;
  sha256: string;
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;
type OutputRootIdentity = Readonly<{ path: string; dev: bigint; ino: bigint }>;
type PreparedFinalOutput = Readonly<{
  path: string;
  parentPath: string;
  parentHandle: Awaited<ReturnType<typeof open>>;
  parentDev: bigint;
  parentIno: bigint;
}>;
type OutputStage = Readonly<{
  root: string;
  paths: readonly string[];
  handle: Awaited<ReturnType<typeof open>>;
  dev: bigint;
  ino: bigint;
}>;

function fsCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "";
}

async function snapshotRegularFile(path: string, maximumBytes: number, reason: string): Promise<FileSnapshot> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maximumBytes)) protocol(reason);
    const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0n;
    while (position < before.size) {
      const length = Number(before.size - position > BigInt(buffer.length) ? BigInt(buffer.length) : before.size - position);
      const { bytesRead } = await handle.read(buffer, 0, length, Number(position));
      if (bytesRead !== length) protocol(reason);
      hash.update(buffer.subarray(0, bytesRead));
      position += BigInt(bytesRead);
    }
    const after = await handle.stat({ bigint: true });
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) protocol(reason);
    return Object.freeze({
      path,
      bytes: Number(before.size),
      sha256: hash.digest("hex"),
      dev: before.dev,
      ino: before.ino,
      size: before.size,
      mtimeNs: before.mtimeNs,
      ctimeNs: before.ctimeNs,
    });
  } catch (error) {
    if (error instanceof CutAudioIntelligenceSidecarError) throw error;
    return protocol(reason);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function outputRootIdentity(value: unknown): Promise<OutputRootIdentity> {
  const requestedPath = absolutePath(value, "output root is malformed");
  if (!isAbsolute(requestedPath) || resolve(requestedPath) !== requestedPath) protocol("output root is malformed");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const path = await realpath(requestedPath);
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const state = await handle.stat({ bigint: true });
    if (!state.isDirectory() || (state.mode & 0o022n) !== 0n) protocol("output root is not one private parent-owned directory");
    return Object.freeze({ path, dev: state.dev, ino: state.ino });
  } catch (error) {
    if (error instanceof CutAudioIntelligenceSidecarError) throw error;
    return protocol("output root could not be authenticated");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function assertOutputRoot(root: OutputRootIdentity) {
  const current = await outputRootIdentity(root.path);
  if (current.dev !== root.dev || current.ino !== root.ino) protocol("output root identity changed during the session");
}

async function prepareFinalOutputPath(root: OutputRootIdentity, value: unknown, reason: string): Promise<PreparedFinalOutput> {
  const requestedPath = absolutePath(value, reason);
  await assertOutputRoot(root);
  const requestedParent = dirname(requestedPath);
  let parentHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const parent = await realpath(requestedParent), parentLocal = relative(root.path, parent);
    if (parentLocal && (parentLocal === ".." || parentLocal.startsWith(`..${sep}`) || isAbsolute(parentLocal))) protocol(reason);
    const path = resolve(parent, basename(requestedPath)), local = relative(root.path, path);
    if (!local || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local)) protocol(reason);
    parentHandle = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const state = await parentHandle.stat({ bigint: true });
    if (!state.isDirectory() || (state.mode & 0o022n) !== 0n) protocol(reason);
    try {
      await lstat(path);
      protocol("output path already exists before sidecar execution");
    } catch (error) {
      if (error instanceof CutAudioIntelligenceSidecarError) throw error;
      if (fsCode(error) !== "ENOENT") protocol(reason);
    }
    return Object.freeze({ path, parentPath: parent, parentHandle, parentDev: state.dev, parentIno: state.ino });
  } catch (error) {
    await parentHandle?.close().catch(() => undefined);
    if (error instanceof CutAudioIntelligenceSidecarError) throw error;
    return protocol(reason);
  }
}

async function assertPreparedFinalParent(root: OutputRootIdentity, output: PreparedFinalOutput) {
  await assertOutputRoot(root);
  const [retained, current, physical] = await Promise.all([
    output.parentHandle.stat({ bigint: true }),
    lstat(output.parentPath, { bigint: true }),
    realpath(output.parentPath),
  ]).catch(() => protocol("sidecar final output parent changed during execution"));
  if (!retained.isDirectory() || !current.isDirectory() || current.isSymbolicLink()
    || retained.dev !== output.parentDev || retained.ino !== output.parentIno
    || current.dev !== output.parentDev || current.ino !== output.parentIno || physical !== output.parentPath) {
    protocol("sidecar final output parent changed during execution");
  }
}

async function closePreparedFinals(outputs: readonly PreparedFinalOutput[]) {
  await Promise.all(outputs.map((output) => output.parentHandle.close().catch(() => undefined)));
}

async function createOutputStage(root: OutputRootIdentity, outputCount: number): Promise<OutputStage> {
  await assertOutputRoot(root);
  const stageRoot = resolve(root.path, `.cut-audio-sidecar-stage-${randomBytes(16).toString("hex")}`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await mkdir(stageRoot, { mode: 0o700 });
    handle = await open(stageRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const state = await handle.stat({ bigint: true });
    if (!state.isDirectory() || (state.mode & 0o077n) !== 0n) protocol("sidecar output stage could not be authenticated");
    await assertOutputRoot(root);
    return Object.freeze({
      root: stageRoot,
      paths: Object.freeze(Array.from({ length: outputCount }, (_, index) => resolve(stageRoot, `artifact-${index}`))),
      handle,
      dev: state.dev,
      ino: state.ino,
    });
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rmdir(stageRoot).catch(() => undefined);
    if (error instanceof CutAudioIntelligenceSidecarError) throw error;
    return protocol("sidecar output stage could not be created");
  }
}

async function assertOutputStage(root: OutputRootIdentity, stage: OutputStage) {
  await assertOutputRoot(root);
  const [retained, current] = await Promise.all([
    stage.handle.stat({ bigint: true }),
    lstat(stage.root, { bigint: true }),
  ]).catch(() => protocol("sidecar output stage identity changed during execution"));
  if (!retained.isDirectory() || !current.isDirectory() || current.isSymbolicLink()
    || retained.dev !== stage.dev || retained.ino !== stage.ino || current.dev !== stage.dev || current.ino !== stage.ino) {
    protocol("sidecar output stage identity changed during execution");
  }
}

async function locateOwnedStage(root: OutputRootIdentity, stage: OutputStage) {
  await assertOutputRoot(root);
  const matches: string[] = [];
  for (const entry of await readdir(root.path)) {
    const candidate = resolve(root.path, entry);
    const state = await lstat(candidate, { bigint: true }).catch(() => undefined);
    if (state?.isDirectory() && !state.isSymbolicLink() && state.dev === stage.dev && state.ino === stage.ino) matches.push(candidate);
  }
  if (matches.length !== 1) protocol("owned sidecar output stage could not be uniquely located for cleanup");
  return matches[0]!;
}

async function assertExpectedStageEntries(stage: OutputStage) {
  const expected = [...stage.paths].map((path) => basename(path)).sort();
  const actual = (await readdir(stage.root)).sort();
  if (actual.length !== expected.length || actual.some((entry, index) => entry !== expected[index])) {
    protocol("sidecar output stage contains unexpected entries");
  }
}

async function cleanupOwnedStage(root: OutputRootIdentity, stage: OutputStage) {
  try {
    const located = await locateOwnedStage(root, stage);
    let entryCount = 0;
    const cleanDirectory = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        entryCount += 1;
        if (entryCount > 64) protocol("owned sidecar output stage exceeds its cleanup entry ceiling");
        const candidate = resolve(directory, entry.name), state = await lstat(candidate, { bigint: true });
        if (state.isDirectory() && !state.isSymbolicLink()) {
          if (state.dev !== stage.dev) protocol("owned sidecar output stage contains a foreign filesystem directory");
          await cleanDirectory(candidate);
          await rmdir(candidate);
        } else {
          // unlink removes the directory entry itself and never follows a symlink.
          await unlink(candidate);
        }
      }
    };
    await cleanDirectory(located);
    await rmdir(located);
  } finally {
    await stage.handle.close().catch(() => undefined);
  }
}

async function publishOutputNoClobber(root: OutputRootIdentity, staged: FileSnapshot, output: PreparedFinalOutput, maximumBytes: number) {
  let linked = false;
  try {
    await assertPreparedFinalParent(root, output);
    await link(staged.path, output.path);
    linked = true;
    await assertPreparedFinalParent(root, output);
    const published = await snapshotRegularFile(output.path, maximumBytes, "published sidecar output artifact is invalid");
    // Creating and then retiring the staging hard link legitimately changes ctime.
    // Content authority is the same inode, size, mtime, and independently hashed bytes.
    if (published.dev !== staged.dev || published.ino !== staged.ino || published.size !== staged.size
      || published.mtimeNs !== staged.mtimeNs || published.sha256 !== staged.sha256) {
      protocol("published sidecar output identity does not match its verified stage");
    }
    return published;
  } catch (error) {
    if (linked) await removeOwnedPublishedOutput(output.path, staged);
    if (error instanceof CutAudioIntelligenceSidecarError) throw error;
    return protocol("sidecar output could not be published without clobbering an existing path");
  }
}

async function removeOwnedPublishedOutput(path: string, authority: FileSnapshot) {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const state = await handle.stat({ bigint: true });
    if (state.isFile() && state.dev === authority.dev && state.ino === authority.ino) await unlink(path);
  } catch {
    // Cleanup is best-effort and never removes a path that no longer has the owned inode.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function assertInputUnchanged(before: FileSnapshot, maximumBytes: number, reason: string) {
  const after = await snapshotRegularFile(before.path, maximumBytes, reason);
  if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
    || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || after.sha256 !== before.sha256) protocol(reason);
}

export function cutAudioIntelligenceModelsSha256(models: readonly CutAudioIntelligenceModelAuthority[]) {
  return createHash("sha256").update(stableJsonStringify(models)).digest("hex");
}

function freezeHandshake(value: unknown): CutAudioIntelligenceSidecarHandshake {
  const record = closed(value, [
    "format", "version", "protocolVersion", "provider", "revision", "capabilities", "adapterSha256", "selfTestSha256", "models", "modelsSha256",
  ], "handshake is malformed");
  if (record.format !== "cut-audio-intelligence-sidecar-handshake" || record.version !== 1 || record.protocolVersion !== 1) protocol("handshake is malformed");
  if (!Array.isArray(record.capabilities) || !record.capabilities.length || record.capabilities.length > cutAudioIntelligenceCapabilities.length) protocol("handshake is malformed");
  let previousCapability = -1;
  const capabilities = record.capabilities.map((value) => {
    const order = typeof value === "string" ? (cutAudioIntelligenceCapabilities as readonly string[]).indexOf(value) : -1;
    if (order < 0 || order <= previousCapability) protocol("handshake is malformed");
    previousCapability = order;
    return value as CutAudioIntelligenceCapability;
  });
  if (!Array.isArray(record.models) || record.models.length !== capabilities.length) protocol("handshake is malformed");
  const models = record.models.map((value, index): CutAudioIntelligenceModelAuthority => {
    const item = closed(value, ["role", "model", "revision", "authoritySha256"], "handshake is malformed");
    const expectedRole = roleForCapability[capabilities[index]!];
    if (item.role !== expectedRole) protocol("handshake is malformed");
    return Object.freeze({
      role: item.role as CutAudioIntelligenceModelRole,
      model: text(item.model, 512, "handshake is malformed"),
      revision: text(item.revision, 256, "handshake is malformed"),
      authoritySha256: digest(item.authoritySha256, "handshake is malformed"),
    });
  });
  const modelsSha256 = digest(record.modelsSha256, "handshake is malformed");
  if (modelsSha256 !== cutAudioIntelligenceModelsSha256(models)) protocol("handshake model authority digest is invalid");
  return Object.freeze({
    format: "cut-audio-intelligence-sidecar-handshake",
    version: 1,
    protocolVersion: 1,
    provider: text(record.provider, 256, "handshake is malformed"),
    revision: text(record.revision, 256, "handshake is malformed"),
    capabilities: Object.freeze(capabilities),
    adapterSha256: digest(record.adapterSha256, "handshake is malformed"),
    selfTestSha256: digest(record.selfTestSha256, "handshake is malformed"),
    models: Object.freeze(models),
    modelsSha256,
  });
}

function sameHandshake(left: CutAudioIntelligenceSidecarHandshake, right: CutAudioIntelligenceSidecarHandshake) {
  return stableJsonStringify(left) === stableJsonStringify(right);
}

function resolveLimits(overrides: CutAudioIntelligenceSidecarLimitOverrides | undefined): ResolvedLimits {
  if (overrides !== undefined && (!overrides || typeof overrides !== "object" || Array.isArray(overrides))) protocol("limits are malformed");
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (!Object.hasOwn(cutAudioIntelligenceSidecarLimits, key)) protocol("limits are not allowlisted");
    const ceiling = sidecarLimitCeilings[key as keyof typeof sidecarLimitCeilings];
    if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > ceiling) protocol(`invalid ${key} limit`);
  }
  return Object.freeze({ ...cutAudioIntelligenceSidecarLimits, ...overrides });
}

function validateStart(start: CutAudioIntelligenceSidecarStart, limits: ResolvedLimits) {
  const executable = executablePath(start.executable);
  if (!Array.isArray(start.arguments) || start.arguments.length > limits.maximumArguments) protocol("arguments are malformed");
  let totalArgumentBytes = 0;
  const argumentsList = start.arguments.map((argument) => {
    const result = text(argument, limits.maximumArgumentBytes, "arguments are malformed");
    totalArgumentBytes += Buffer.byteLength(result, "utf8");
    if (totalArgumentBytes > limits.maximumTotalArgumentBytes) protocol("arguments exceed their aggregate byte limit");
    return result;
  });
  const environment: Record<string, string> = { CUT_AUDIO_INTELLIGENCE_OFFLINE: "1" };
  for (const [key, value] of Object.entries(start.environment ?? {})) {
    if (!allowedEnvironment.has(key)) protocol("environment is not allowlisted");
    environment[key] = absolutePath(value, "environment is malformed");
    if (Buffer.byteLength(environment[key]!, "utf8") > limits.maximumEnvironmentValueBytes) protocol("environment is malformed");
  }
  return Object.freeze({ executable, arguments: Object.freeze(argumentsList), environment: Object.freeze(environment), handshake: freezeHandshake(start.expectedHandshake) });
}

function parseJson(line: Buffer) {
  try { return JSON.parse(line.toString("utf8")); }
  catch { return protocol("received malformed JSON"); }
}

function artifact(value: unknown, expectedPath: string, reason: string): CutAudioIntelligenceArtifact {
  const item = closed(value, ["path", "bytes", "sha256"], reason);
  const path = absolutePath(item.path, reason);
  if (path !== expectedPath) protocol(reason);
  return Object.freeze({ path, bytes: positive(item.bytes, Number.MAX_SAFE_INTEGER, reason), sha256: digest(item.sha256, reason) });
}

/**
 * Start one offline, path-only audio-intelligence sidecar session. The caller
 * authenticates and prevalidates every path and expected backend identity;
 * this protocol never transmits prompts, transcript text, PCM, or model output.
 */
export async function startCutAudioIntelligenceSidecar(start: CutAudioIntelligenceSidecarStart): Promise<CutAudioIntelligenceSidecarSession> {
  const limits = resolveLimits(start.limits), validated = validateStart(start, limits), expected = validated.handshake;
  const outputRoot = await outputRootIdentity(start.outputRoot);
  const useProcessGroup = process.platform !== "win32";
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(validated.executable, [...validated.arguments], {
      shell: false,
      detached: useProcessGroup,
      stdio: ["pipe", "pipe", "pipe"],
      env: validated.environment,
    });
  } catch { protocol("sidecar could not start"); }

  let pid: number | undefined = child!.pid;
  let stdout = Buffer.alloc(0), stdoutBytes = 0, stderrBytes = 0;
  let handshaken = false, closeRequested = false, closeSent = false, closeAcknowledged = false;
  let fatal: CutAudioIntelligenceSidecarError | undefined, pending: Pending | undefined;
  let settled: Readonly<{ pending: Pending; result: unknown }> | undefined, closePromise: Promise<void> | undefined;
  let terminateTimer: NodeJS.Timeout | undefined, drainTimer: NodeJS.Timeout | undefined, closeTimer: NodeJS.Timeout | undefined;
  let resolveDead!: () => void;
  const dead = new Promise<void>((resolve) => { resolveDead = resolve; });
  let resolveHandshake!: (session: CutAudioIntelligenceSidecarSession) => void;
  let rejectHandshake!: (error: Error) => void;
  const ready = new Promise<CutAudioIntelligenceSidecarSession>((resolve, reject) => { resolveHandshake = resolve; rejectHandshake = reject; });

  const signalTree = (signal: NodeJS.Signals) => {
    if (pid === undefined) return;
    if (useProcessGroup) {
      try { process.kill(-pid, signal); return; } catch { /* fall through */ }
    }
    try { child!.kill(signal); } catch { /* already dead */ }
  };
  const finish = (reason: string) => {
    if (fatal) return;
    fatal = failure(reason);
    clearTimeout(closeTimer);
    if (pending) {
      clearTimeout(pending.timer);
      const current = pending; pending = undefined; settled = undefined;
      void dead.then(() => current.reject(fatal!));
    }
    void dead.then(() => rejectHandshake(fatal!));
    child!.stdin.end();
    if (pid !== undefined) {
      signalTree("SIGTERM");
      terminateTimer = setTimeout(() => {
        signalTree("SIGKILL");
        drainTimer = setTimeout(() => {
          child!.stdin.destroy(); child!.stdout.destroy(); child!.stderr.destroy();
        }, 50);
      }, limits.terminateGraceMs);
    }
  };
  const finishSoon = (reason: string) => queueMicrotask(() => finish(reason));

  const processLine = (line: Buffer) => {
    if (fatal) return;
    if (!line.byteLength || line.byteLength > limits.maximumResponseLineBytes) return finishSoon("response line violates its byte limit");
    let value: unknown;
    try { value = parseJson(line); } catch { return finishSoon("received malformed JSON"); }
    if (!handshaken) {
      let received: CutAudioIntelligenceSidecarHandshake;
      try { received = freezeHandshake(value); } catch { return finishSoon("handshake is malformed"); }
      if (!sameHandshake(received, expected)) return finishSoon("handshake does not match the expected identity");
      handshaken = true;
      setImmediate(() => { if (!fatal) resolveHandshake(session); });
      return;
    }
    let response: Record<string, unknown>;
    try { response = object(value, "response is malformed"); } catch { return finishSoon("response is malformed"); }
    if (response.format !== "cut-audio-intelligence-sidecar-response" || response.version !== 1
      || typeof response.id !== "string" || ![...cutAudioIntelligenceCapabilities, "close"].includes(response.operation as Operation)) {
      return finishSoon("response is malformed");
    }
    if (!pending || settled || response.id !== pending.id || response.operation !== pending.operation) {
      return finishSoon("response is unsolicited, duplicate, or out of order");
    }
    const current = pending;
    let result: unknown;
    try { result = current.parse(value); } catch { return finishSoon("response violates the audio-intelligence protocol"); }
    if (current.operation === "close") closeAcknowledged = true;
    else clearTimeout(current.timer);
    settled = Object.freeze({ pending: current, result });
  };

  child!.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.byteLength;
    if (stdoutBytes > limits.maximumStdoutBytes) return finish("stdout exceeds its byte limit");
    stdout = Buffer.concat([stdout, chunk]);
    while (true) {
      const newline = stdout.indexOf(10);
      if (newline < 0) break;
      const line = stdout.subarray(0, newline); stdout = stdout.subarray(newline + 1);
      processLine(line);
    }
    if (stdout.byteLength > limits.maximumResponseLineBytes) finish("response line violates its byte limit");
    if (settled) {
      const response = settled;
      setImmediate(() => {
        if (fatal || settled !== response) return;
        settled = undefined; pending = undefined;
        response.pending.resolve(response.result);
      });
    }
  });
  child!.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.byteLength;
    if (stderrBytes > limits.maximumStderrBytes) finish("stderr exceeds its byte limit");
  });
  child!.on("error", () => finish("sidecar could not start"));
  child!.on("close", (code) => {
    clearTimeout(terminateTimer); clearTimeout(drainTimer); clearTimeout(closeTimer);
    pid = undefined;
    start.signal?.removeEventListener("abort", abort);
    if (!fatal && stdout.byteLength) finish("sidecar ended with a partial response line");
    else if (!fatal && (!closeRequested || !closeSent || !closeAcknowledged || code !== 0)) finish("sidecar exited before an acknowledged clean close");
    resolveDead();
  });
  const handshakeTimer = setTimeout(() => finish("handshake timed out"), limits.handshakeMs);
  ready.finally(() => clearTimeout(handshakeTimer)).catch(() => undefined);
  const abort = () => finish("sidecar operation was cancelled");
  if (start.signal?.aborted) finish("sidecar operation was cancelled");
  else start.signal?.addEventListener("abort", abort, { once: true });

  let ordinal = 0;
  const request = <T>(operation: Operation, body: Record<string, unknown>, parse: (value: unknown) => T, timeout: number): Promise<T> => new Promise<T>((resolve, reject) => {
    if (fatal || pid === undefined) {
      if (fatal && pid !== undefined) void dead.then(() => reject(fatal!));
      else reject(fatal ?? failure("sidecar is not running"));
      return;
    }
    if (pending || settled) { reject(failure("only one sidecar operation may be in flight")); return; }
    const id = `audio-${++ordinal}`;
    const message = JSON.stringify(Object.freeze({ format: "cut-audio-intelligence-sidecar-request", version: 1, id, operation, ...body }));
    if (Buffer.byteLength(message, "utf8") > limits.maximumRequestBytes) {
      finish("request exceeds its byte limit"); void dead.then(() => reject(fatal!)); return;
    }
    const timer = setTimeout(() => finish(`${operation} timed out`), timeout);
    pending = Object.freeze({ id, operation, timer, parse, resolve, reject });
    if (operation === "close") { closeSent = true; closeTimer = timer; }
    child!.stdin.write(`${message}\n`, (writeError) => { if (writeError) finish("sidecar request write failed"); });
  });

  let fileOperationInFlight = false;
  const assertOperationLive = () => {
    if (fatal) throw fatal;
    if (start.signal?.aborted) {
      finish("sidecar operation was cancelled");
      throw fatal!;
    }
  };
  const performVerifiedFileOperation = async <T>(options: Readonly<{
    inputs: readonly Readonly<{ path: string; maximumBytes: number }>[];
    outputValues: readonly unknown[];
    execute: (outputPaths: readonly string[]) => Promise<T>;
    accept: (claimed: T, outputs: readonly FileSnapshot[]) => unknown;
  }>) => {
    const inputs = await Promise.all(options.inputs.map((input) => snapshotRegularFile(input.path, input.maximumBytes, "sidecar input authority is invalid")));
    const finalOutputs: PreparedFinalOutput[] = [];
    let stage: Awaited<ReturnType<typeof createOutputStage>> | undefined;
    try {
      for (const value of options.outputValues) finalOutputs.push(await prepareFinalOutputPath(outputRoot, value, "sidecar final output path is invalid"));
      if (new Set(finalOutputs.map((output) => output.path)).size !== finalOutputs.length) {
        protocol("sidecar input and output paths must be distinct");
      }
      stage = await createOutputStage(outputRoot, finalOutputs.length);
    } catch (error) {
      if (stage) await cleanupOwnedStage(outputRoot, stage).catch(() => undefined);
      await closePreparedFinals(finalOutputs);
      throw error;
    }
    let sent = false;
    const published: FileSnapshot[] = [];
    try {
      sent = true;
      const claimed = await options.execute(stage.paths);
      assertOperationLive();
      for (const [index, input] of inputs.entries()) {
        await assertInputUnchanged(input, options.inputs[index]!.maximumBytes, "sidecar input changed during execution");
        assertOperationLive();
      }
      await assertOutputStage(outputRoot, stage);
      assertOperationLive();
      await Promise.all(finalOutputs.map((output) => assertPreparedFinalParent(outputRoot, output)));
      assertOperationLive();
      const staged = await Promise.all(stage.paths.map((path) => snapshotRegularFile(path, limits.maximumOutputArtifactBytes, "sidecar output artifact is invalid")));
      await assertExpectedStageEntries(stage);
      assertOperationLive();
      const accepted = options.accept(claimed, staged);
      await assertOutputRoot(outputRoot);
      for (const [index, artifact] of staged.entries()) {
        assertOperationLive();
        published.push(await publishOutputNoClobber(outputRoot, artifact, finalOutputs[index]!, limits.maximumOutputArtifactBytes));
        assertOperationLive();
      }
      await assertOutputStage(outputRoot, stage);
      assertOperationLive();
      await cleanupOwnedStage(outputRoot, stage);
      await assertOutputRoot(outputRoot);
      assertOperationLive();
      for (const [index, input] of inputs.entries()) {
        await assertInputUnchanged(input, options.inputs[index]!.maximumBytes, "sidecar input changed during publication");
        assertOperationLive();
      }
      const sealed = await Promise.all(published.map((artifact) => snapshotRegularFile(
        artifact.path, limits.maximumOutputArtifactBytes, "published sidecar output artifact is invalid",
      )));
      for (const [index, artifact] of sealed.entries()) {
        assertOperationLive();
        const expectedArtifact = published[index]!;
        if (artifact.dev !== expectedArtifact.dev || artifact.ino !== expectedArtifact.ino || artifact.size !== expectedArtifact.size
          || artifact.mtimeNs !== expectedArtifact.mtimeNs || artifact.sha256 !== expectedArtifact.sha256) {
          protocol("published sidecar output changed before operation completion");
        }
      }
      assertOperationLive();
      await closePreparedFinals(finalOutputs);
      assertOperationLive();
      if (sealed.length === 1 && accepted && typeof accepted === "object" && "path" in accepted) {
        return Object.freeze({ ...(accepted as object), path: sealed[0]!.path }) as T;
      }
      if (sealed.length === 2 && accepted && typeof accepted === "object" && "wav" in accepted && "metadata" in accepted) {
        const result = accepted as Readonly<{ wav: object; metadata: object }>;
        return Object.freeze({
          wav: Object.freeze({ ...result.wav, path: sealed[0]!.path }),
          metadata: Object.freeze({ ...result.metadata, path: sealed[1]!.path }),
        }) as T;
      }
      return accepted as T;
    } catch (error) {
      if (sent) {
        if (!fatal) finish("sidecar file authority verification failed");
        await dead;
      }
      await Promise.all(published.map((artifact) => removeOwnedPublishedOutput(artifact.path, artifact)));
      await cleanupOwnedStage(outputRoot, stage).catch(() => undefined);
      await closePreparedFinals(finalOutputs);
      if (fatal) throw fatal;
      throw error;
    }
  };
  const verifiedFileOperation = async <T>(options: Parameters<typeof performVerifiedFileOperation<T>>[0]) => {
    if (fileOperationInFlight) throw failure("only one sidecar operation may be in flight");
    fileOperationInFlight = true;
    try {
      return await performVerifiedFileOperation(options);
    } finally {
      fileOperationInFlight = false;
    }
  };

  const requireCapability = (capability: CutAudioIntelligenceCapability) => {
    if (!expected.capabilities.includes(capability)) throw failure(`sidecar does not declare ${capability}`);
    if (closeRequested) throw failure("sidecar is closing");
  };
  const session: CutAudioIntelligenceSidecarSession = Object.freeze({
    handshake: expected,
    get pid() { return pid; },
    async analyze(requestValue) {
      requireCapability("analyze");
      const value = closed(requestValue, ["inputPath", "requestPath", "outputPath"], "analyze request is malformed");
      const inputPath = absolutePath(value.inputPath, "analyze request is malformed");
      const requestPath = absolutePath(value.requestPath, "analyze request is malformed");
      return verifiedFileOperation({
        inputs: [
          { path: inputPath, maximumBytes: limits.maximumInputArtifactBytes },
          { path: requestPath, maximumBytes: limits.maximumRequestArtifactBytes },
        ],
        outputValues: [value.outputPath],
        execute: ([outputPath]) => request("analyze", { inputPath, requestPath, outputPath }, (response) => {
          const item = closed(response, ["format", "version", "id", "operation", "artifact"], "analyze response is malformed");
          return artifact(item.artifact, outputPath!, "analyze response is malformed");
        }, limits.operationMs),
        accept: (claimed, outputs) => {
          const observed = outputs[0]!;
          if (claimed.bytes !== observed.bytes || claimed.sha256 !== observed.sha256) protocol("analyze output identity does not match parent-observed bytes");
          return Object.freeze({ path: observed.path, bytes: observed.bytes, sha256: observed.sha256 });
        },
      }) as Promise<CutAudioIntelligenceArtifact>;
    },
    async transcribe(requestValue) {
      requireCapability("transcribe");
      const value = closed(requestValue, ["inputPath", "requestPath", "outputPath"], "transcribe request is malformed");
      const inputPath = absolutePath(value.inputPath, "transcribe request is malformed");
      const requestPath = absolutePath(value.requestPath, "transcribe request is malformed");
      return verifiedFileOperation({
        inputs: [
          { path: inputPath, maximumBytes: limits.maximumInputArtifactBytes },
          { path: requestPath, maximumBytes: limits.maximumRequestArtifactBytes },
        ],
        outputValues: [value.outputPath],
        execute: ([outputPath]) => request("transcribe", { inputPath, requestPath, outputPath }, (response) => {
          const item = closed(response, ["format", "version", "id", "operation", "artifact"], "transcribe response is malformed");
          return artifact(item.artifact, outputPath!, "transcribe response is malformed");
        }, limits.operationMs),
        accept: (claimed, outputs) => {
          const observed = outputs[0]!;
          if (claimed.bytes !== observed.bytes || claimed.sha256 !== observed.sha256) protocol("transcribe output identity does not match parent-observed bytes");
          return Object.freeze({ path: observed.path, bytes: observed.bytes, sha256: observed.sha256 });
        },
      }) as Promise<CutAudioIntelligenceArtifact>;
    },
    async narrate(requestValue) {
      requireCapability("narrate");
      const value = closed(requestValue, ["requestPath", "outputWavPath", "outputMetadataPath"], "narrate request is malformed");
      const requestPath = absolutePath(value.requestPath, "narrate request is malformed");
      return verifiedFileOperation({
        inputs: [{ path: requestPath, maximumBytes: limits.maximumRequestArtifactBytes }],
        outputValues: [value.outputWavPath, value.outputMetadataPath],
        execute: ([outputWavPath, outputMetadataPath]) => request("narrate", { requestPath, outputWavPath, outputMetadataPath }, (response) => {
          const item = closed(response, ["format", "version", "id", "operation", "artifacts"], "narrate response is malformed");
          const artifacts = closed(item.artifacts, ["wav", "metadata"], "narrate response is malformed");
          return Object.freeze({
            wav: artifact(artifacts.wav, outputWavPath!, "narrate response is malformed"),
            metadata: artifact(artifacts.metadata, outputMetadataPath!, "narrate response is malformed"),
          });
        }, limits.operationMs),
        accept: (claimed, outputs) => {
          const wav = outputs[0]!, metadata = outputs[1]!;
          if (claimed.wav.bytes !== wav.bytes || claimed.wav.sha256 !== wav.sha256
            || claimed.metadata.bytes !== metadata.bytes || claimed.metadata.sha256 !== metadata.sha256) {
            protocol("narrate output identities do not match parent-observed bytes");
          }
          return Object.freeze({
            wav: Object.freeze({ path: wav.path, bytes: wav.bytes, sha256: wav.sha256 }),
            metadata: Object.freeze({ path: metadata.path, bytes: metadata.bytes, sha256: metadata.sha256 }),
          });
        },
      }) as Promise<Readonly<{ wav: CutAudioIntelligenceArtifact; metadata: CutAudioIntelligenceArtifact }>>;
    },
    close() {
      if (!closePromise) {
        if (pending || settled || fileOperationInFlight) return Promise.reject(failure("cannot close while an operation is in flight"));
        closeRequested = true;
        closePromise = request("close", {}, (response) => {
          closed(response, ["format", "version", "id", "operation"], "close response is malformed");
          return undefined;
        }, limits.closeMs).then(async () => {
          await dead;
          if (fatal) throw fatal;
        });
      }
      return closePromise;
    },
  });
  return ready;
}
