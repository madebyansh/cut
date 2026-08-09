import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, resolve } from "node:path";
import { stableJsonStringify } from "../core/stable";

export type ReferenceNativeMediaTool = "ffmpeg" | "ffprobe";

export type ReferenceNativeProcessAuthorityFailureReason =
  | "CONTRACT"
  | "EXECUTABLE_FILE"
  | "EXECUTABLE_CHANGED"
  | "EXECUTABLE_READ";

export class ReferenceNativeProcessAuthorityError extends Error {
  readonly code = "CUT_NATIVE_PROCESS_AUTHORITY" as const;

  constructor(
    readonly reason: ReferenceNativeProcessAuthorityFailureReason,
    readonly tool: ReferenceNativeMediaTool | undefined,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(`CUT_NATIVE_PROCESS_AUTHORITY: ${message}`, options);
    this.name = "ReferenceNativeProcessAuthorityError";
  }
}

export const referenceNativeProcessAuthorityPolicy = Object.freeze({
  format: "cut-reference-native-process-authority-policy",
  version: 1,
  maximumExecutableBytes: 256 * 1024 * 1024,
  maximumPathBytes: 16_384,
  maximumPathEnvironmentBytes: 128_000,
  maximumArguments: 4_096,
  maximumArgumentBytes: 16 * 1024 * 1024,
  maximumSingleArgumentBytes: 8 * 1024 * 1024,
  maximumProcessesPerInvocation: 20_000,
} as const);

type ExecutableSnapshot = Readonly<{
  path: string;
  bytes: number;
  sha256: string;
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;

class ReferenceNativeExecutableCandidateMissing extends Error {
  constructor(readonly systemCode: "ENOENT" | "ENOTDIR") {
    super("native executable PATH candidate is absent");
    this.name = "ReferenceNativeExecutableCandidateMissing";
  }
}

export type ReferenceNativeExecutableEvidence = Readonly<{
  tool: ReferenceNativeMediaTool;
  canonicalPathSha256: string;
  bytes: number;
  sha256: string;
  stat: Readonly<{
    dev: string;
    ino: string;
    size: string;
    mtimeNs: string;
    ctimeNs: string;
  }>;
}>;

export type ReferenceNativeProcessContext = Readonly<{
  ordinal: number;
  operation:
    | "media-metadata"
    | "decoded-video-cadence"
    | "decoded-audio-pcm"
    | "decoded-audio-samples"
    | "audio-proxy-alignment"
    | "video-proxy-alignment"
    | "toolchain-version"
    | "picture-encode"
    | "picture-artifact-probe"
    | "picture-rgba-decode"
    | "footage-frame-sample";
  resourceId: string;
  resourceSha256: string;
  resourceBytes: number;
  variant: "master" | "proxy";
  streamIndex?: number;
}>;

export type ReferenceNativeProcessLifecycleReceipt = Readonly<{
  receiptId: string;
  ordinal: number;
  context: ReferenceNativeProcessContext;
  executable: ReferenceNativeExecutableEvidence;
  argvCount: number;
  argvSha256: string;
  parentPid: number;
  expectedProcessGroupId: number | null;
  childPid: number;
  detached: false;
  spawned: true;
  exit: Readonly<{ code: number | null; signal: NodeJS.Signals | null }>;
  close: Readonly<{ code: number | null; signal: NodeJS.Signals | null }>;
  executableRevalidatedAfterClose: true;
}>;

export type ReferenceNativeProcessLifecycleEvent = Readonly<{
  format: "cut-reference-native-process-lifecycle-event";
  version: 1;
  phase:
    | "reserved"
    | "launched"
    | "spawn-confirmed"
    | "exit"
    | "close-verified"
    | "spawn-failed";
  receiptId: string;
  tool: ReferenceNativeMediaTool;
  context: ReferenceNativeProcessContext;
  executable: ReferenceNativeExecutableEvidence;
  argvCount: number;
  argvSha256: string;
  parentPid: number;
  expectedProcessGroupId: number | null;
  childPid: number | null;
  terminal?: Readonly<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>;
  failureCode?: string;
}>;

export type ReferenceNativeProcessLifecycleObserver =
  (event: ReferenceNativeProcessLifecycleEvent) => void;

export type ReferenceNativeProcessLifecycleEvidence = Readonly<{
  format: "cut-reference-native-process-lifecycle";
  version: 1;
  policy: typeof referenceNativeProcessAuthorityPolicy.format;
  invocationNonceSha256: string;
  parentPid: number;
  expectedProcessGroupId: number | null;
  executable: ReferenceNativeExecutableEvidence;
  receipts: readonly ReferenceNativeProcessLifecycleReceipt[];
  receiptCount: number;
  receiptsSha256: string;
}>;

export type BoundReferenceNativeMediaTool = Readonly<{
  tool: ReferenceNativeMediaTool;
  executablePath: string;
  evidence: ReferenceNativeExecutableEvidence;
  verify: () => Promise<void>;
}>;

type MutableReceipt = {
  receiptId: string;
  ordinal: number;
  context: ReferenceNativeProcessContext;
  argv: readonly string[];
  argvSha256: string;
  parentPid: number;
  expectedProcessGroupId: number | null;
  childPid?: number;
  spawned: boolean;
  spawnConfirmed: boolean;
  exit?: { code: number | null; signal: NodeJS.Signals | null };
  close?: { code: number | null; signal: NodeJS.Signals | null };
  spawnFailure?: string;
  closeVerification?: Promise<void>;
  closeVerificationFailure?: unknown;
  completion?: Promise<void>;
  finishCompletion?: () => void;
  executableRevalidatedAfterClose: boolean;
};

export type ReferenceNativeProcessCollector = Readonly<{
  authority: BoundReferenceNativeMediaTool;
  parentPid: number;
  expectedProcessGroupId: number | null;
  seal: () => Promise<ReferenceNativeProcessLifecycleEvidence>;
}>;

type CollectorPrivate = {
  nonce: string;
  receipts: Map<string, MutableReceipt>;
  pids: Set<number>;
  ordinals: Set<number>;
  sealed: boolean;
  lifecycleEvent?: ReferenceNativeProcessLifecycleObserver;
  lifecycleFailure?: unknown;
};

const issuedAuthorities = new WeakSet<object>();
const issuedCollectors = new WeakSet<object>();
const collectorPrivate = new WeakMap<object, CollectorPrivate>();

function sha256Bytes(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function systemCode(error: unknown) {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    && /^[A-Z0-9_]{1,32}$/u.test(error.code)
    ? error.code
    : "UNKNOWN";
}

function fail(
  message: string,
  cause?: unknown,
  detail: Readonly<{ reason?: ReferenceNativeProcessAuthorityFailureReason; tool?: ReferenceNativeMediaTool }> = {},
): never {
  throw new ReferenceNativeProcessAuthorityError(
    detail.reason ?? "CONTRACT",
    detail.tool,
    message,
    cause === undefined ? {} : { cause },
  );
}

function assertPid(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail(`${label} must be one positive safe integer.`);
  return value as number;
}

function boundedArgumentList(value: readonly string[]) {
  if (!Array.isArray(value) || value.length > referenceNativeProcessAuthorityPolicy.maximumArguments) {
    fail("native process argv exceeds its item bound.");
  }
  let bytes = 0;
  const result = value.map((argument) => {
    if (typeof argument !== "string" || argument.includes("\0")) fail("native process argv contains a non-string or NUL byte.");
    const argumentBytes = Buffer.byteLength(argument, "utf8");
    if (argumentBytes > referenceNativeProcessAuthorityPolicy.maximumSingleArgumentBytes) {
      fail("one native process argument exceeds its byte bound.");
    }
    bytes += argumentBytes;
    if (bytes > referenceNativeProcessAuthorityPolicy.maximumArgumentBytes) {
      fail("native process argv exceeds its aggregate byte bound.");
    }
    return argument;
  });
  return Object.freeze(result);
}

function evidence(snapshot: ExecutableSnapshot, tool: ReferenceNativeMediaTool): ReferenceNativeExecutableEvidence {
  return Object.freeze({
    tool,
    canonicalPathSha256: sha256Bytes(snapshot.path),
    bytes: snapshot.bytes,
    sha256: snapshot.sha256,
    stat: Object.freeze({
      dev: String(snapshot.dev),
      ino: String(snapshot.ino),
      size: String(snapshot.size),
      mtimeNs: String(snapshot.mtimeNs),
      ctimeNs: String(snapshot.ctimeNs),
    }),
  });
}

async function snapshotExecutable(
  path: string,
  tool: ReferenceNativeMediaTool,
  allowMissingPathCandidate = false,
): Promise<ExecutableSnapshot> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (typeof fsConstants.O_NOFOLLOW !== "number") fail(`platform cannot bind ${tool} through a no-follow executable handle.`);
    let physical: string;
    try {
      physical = await realpath(path);
    } catch (error) {
      const code = systemCode(error);
      if (allowMissingPathCandidate && (code === "ENOENT" || code === "ENOTDIR")) {
        throw new ReferenceNativeExecutableCandidateMissing(code);
      }
      return fail(`${tool} executable authority could not be collected (${code}).`, error, { reason: "EXECUTABLE_READ", tool });
    }
    if (!isAbsolute(physical) || physical.includes("\0")
      || Buffer.byteLength(physical, "utf8") > referenceNativeProcessAuthorityPolicy.maximumPathBytes) {
      fail(`${tool} did not resolve to one bounded absolute executable path.`);
    }
    const pathState = await lstat(physical, { bigint: true });
    if (pathState.isSymbolicLink() || !pathState.isFile() || pathState.size < 1n
      || pathState.size > BigInt(referenceNativeProcessAuthorityPolicy.maximumExecutableBytes)
      || (process.platform !== "win32" && (pathState.mode & 0o111n) === 0n)) {
      fail(`${tool} must resolve to one bounded executable regular file.`, undefined, { reason: "EXECUTABLE_FILE", tool });
    }
    handle = await open(physical, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.dev !== pathState.dev || before.ino !== pathState.ino
      || before.size !== pathState.size || before.mtimeNs !== pathState.mtimeNs
      || before.ctimeNs !== pathState.ctimeNs) {
      fail(`${tool} path and no-follow handle do not identify the same executable.`, undefined, { reason: "EXECUTABLE_CHANGED", tool });
    }
    const digest = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 1024 * 1024 })) digest.update(chunk);
    const after = await handle.stat({ bigint: true });
    const afterPath = await lstat(physical, { bigint: true });
    for (const candidate of [after, afterPath]) {
      if (!candidate.isFile() || candidate.dev !== before.dev || candidate.ino !== before.ino
        || candidate.size !== before.size || candidate.mtimeNs !== before.mtimeNs
        || candidate.ctimeNs !== before.ctimeNs) {
        fail(`${tool} changed while CUT snapshotted its executable identity.`, undefined, { reason: "EXECUTABLE_CHANGED", tool });
      }
    }
    return Object.freeze({
      path: physical,
      bytes: Number(before.size),
      sha256: digest.digest("hex"),
      dev: before.dev,
      ino: before.ino,
      size: before.size,
      mtimeNs: before.mtimeNs,
      ctimeNs: before.ctimeNs,
    });
  } catch (error) {
    if (error instanceof ReferenceNativeExecutableCandidateMissing) throw error;
    if (error instanceof ReferenceNativeProcessAuthorityError) throw error;
    return fail(`${tool} executable authority could not be collected (${systemCode(error)}).`, error, { reason: "EXECUTABLE_READ", tool });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function resolveExecutable(tool: ReferenceNativeMediaTool, authoredPath?: string) {
  if (authoredPath !== undefined) {
    if (typeof authoredPath !== "string" || !isAbsolute(authoredPath) || authoredPath.includes("\0")) {
      fail(`${tool} authored executable must be one absolute path.`);
    }
    return snapshotExecutable(authoredPath, tool);
  }
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const environmentPath = process.env[pathKey];
  if (typeof environmentPath !== "string" || !environmentPath || environmentPath.includes("\0")
    || Buffer.byteLength(environmentPath, "utf8") > referenceNativeProcessAuthorityPolicy.maximumPathEnvironmentBytes) {
    fail("PATH must be one bounded non-empty executable search path.");
  }
  const names = process.platform === "win32" ? [`${tool}.exe`, tool] : [tool];
  for (const directory of environmentPath.split(delimiter)) {
    if (!directory || !isAbsolute(directory)) continue;
    for (const name of names) {
      try { return await snapshotExecutable(resolve(directory, name), tool, true); }
      catch (error) {
        if (!(error instanceof ReferenceNativeExecutableCandidateMissing)) throw error;
      }
    }
  }
  fail(`PATH did not resolve one bounded ${tool} executable.`);
}

function sameSnapshot(left: ExecutableSnapshot, right: ExecutableSnapshot) {
  return left.path === right.path && left.bytes === right.bytes && left.sha256 === right.sha256
    && left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

export async function bindReferenceNativeMediaTool(
  tool: ReferenceNativeMediaTool,
  authoredPath?: string,
): Promise<BoundReferenceNativeMediaTool> {
  if (tool !== "ffmpeg" && tool !== "ffprobe") fail("native media tool is not supported.");
  const snapshot = await resolveExecutable(tool, authoredPath);
  const verify = async () => {
    const current = await snapshotExecutable(snapshot.path, tool);
    if (!sameSnapshot(snapshot, current)) fail(`${tool} executable authority changed during the invocation.`, undefined, { reason: "EXECUTABLE_CHANGED", tool });
  };
  const result = Object.freeze({ tool, executablePath: snapshot.path, evidence: evidence(snapshot, tool), verify });
  issuedAuthorities.add(result);
  await verify();
  return result;
}

function assertAuthority(value: BoundReferenceNativeMediaTool) {
  if (!value || typeof value !== "object" || !issuedAuthorities.has(value)) {
    fail("native executable authority was not issued by this module instance.");
  }
}

function normalizedContext(value: ReferenceNativeProcessContext) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !Number.isSafeInteger(value.ordinal) || value.ordinal < 0
    || ![
      "media-metadata",
      "decoded-video-cadence",
      "decoded-audio-pcm",
      "decoded-audio-samples",
      "audio-proxy-alignment",
      "video-proxy-alignment",
      "toolchain-version",
      "picture-encode",
      "picture-artifact-probe",
      "picture-rgba-decode",
      "footage-frame-sample",
    ].includes(value.operation)
    || typeof value.resourceId !== "string" || value.resourceId.length < 1 || value.resourceId.length > 1_024
    || typeof value.resourceSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(value.resourceSha256)
    || !Number.isSafeInteger(value.resourceBytes) || value.resourceBytes < 0
    || (value.variant !== "master" && value.variant !== "proxy")) {
    fail("native process context is malformed.");
  }
  if ([
    "media-metadata",
    "toolchain-version",
    "picture-encode",
    "picture-artifact-probe",
    "picture-rgba-decode",
  ].includes(value.operation)) {
    if (value.streamIndex !== undefined) fail("media-metadata native process context must omit streamIndex.");
  } else if (!Number.isSafeInteger(value.streamIndex) || (value.streamIndex as number) < 0) {
    fail(`${value.operation} native process context requires one non-negative streamIndex.`);
  }
  return Object.freeze({
    ordinal: value.ordinal,
    operation: value.operation,
    resourceId: value.resourceId,
    resourceSha256: value.resourceSha256,
    resourceBytes: value.resourceBytes,
    variant: value.variant,
    ...(value.streamIndex === undefined ? {} : { streamIndex: value.streamIndex }),
  }) as ReferenceNativeProcessContext;
}

const supportedSpawnOptionNames = new Set(["detached", "shell", "stdio", "windowsHide"]);

function normalizedSpawnOptions(value: SpawnOptions): SpawnOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("bound native process options must be one object.");
  }
  const symbols = Object.getOwnPropertySymbols(value);
  if (symbols.length > 0) fail("bound native process options cannot contain symbol keys.");
  const names = Object.getOwnPropertyNames(value);
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !("value" in descriptor)) fail(`bound native process option ${name} must be one data property.`);
    if (name === "argv0") fail("bound native process options cannot override argv0.");
    if (!supportedSpawnOptionNames.has(name)) fail(`bound native process option ${name} is unsupported.`);
  }
  if (value.shell !== false) fail("bound native processes require an explicit shell:false option.");
  if (!(value.detached === undefined || value.detached === false)) {
    fail("bound native processes require detached:false when detached is specified.");
  }
  if (!(value.windowsHide === undefined || typeof value.windowsHide === "boolean")) {
    fail("bound native process windowsHide must be boolean when specified.");
  }
  if (!Object.prototype.hasOwnProperty.call(value, "stdio") || value.stdio === undefined) {
    fail("bound native processes require one explicit stdio option.");
  }
  return {
    shell: false,
    detached: false,
    stdio: value.stdio,
    ...(value.windowsHide === undefined ? {} : { windowsHide: value.windowsHide }),
  };
}

export function createReferenceNativeProcessCollector(
  authority: BoundReferenceNativeMediaTool,
  options: Readonly<{
    parentPid?: number;
    expectedProcessGroupId?: number | null;
    lifecycleEvent?: ReferenceNativeProcessLifecycleObserver;
  }> = {},
): ReferenceNativeProcessCollector {
  assertAuthority(authority);
  if (!options || typeof options !== "object" || Array.isArray(options)
    || Object.getOwnPropertySymbols(options).length > 0
    || Object.keys(options).some((key) => !["parentPid", "expectedProcessGroupId", "lifecycleEvent"].includes(key))) {
    fail("native process collector options are malformed.");
  }
  if (options.lifecycleEvent !== undefined && typeof options.lifecycleEvent !== "function") {
    fail("native process lifecycle observer must be one function.");
  }
  const parentPid = assertPid(options.parentPid ?? process.pid, "native process parent pid");
  const expectedProcessGroupId = options.expectedProcessGroupId === undefined
    ? null
    : options.expectedProcessGroupId === null
      ? null
      : assertPid(options.expectedProcessGroupId, "native process expected process-group id");
  const state: CollectorPrivate = {
    nonce: randomBytes(32).toString("hex"),
    receipts: new Map(),
    pids: new Set(),
    ordinals: new Set(),
    sealed: false,
    ...(options.lifecycleEvent === undefined ? {} : { lifecycleEvent: options.lifecycleEvent }),
  };
  const seal = async () => {
    if (!issuedCollectors.has(collector)) fail("native process collector was not issued by this module instance.");
    if (state.sealed) fail("native process collector was already sealed.");
    state.sealed = true;
    const receipts = [...state.receipts.values()].sort((left, right) => left.ordinal - right.ordinal);
    if (receipts.length > referenceNativeProcessAuthorityPolicy.maximumProcessesPerInvocation) {
      fail("native process collector exceeded its receipt bound.");
    }
    await Promise.all(receipts.map(async (receipt) => receipt.completion));
    await Promise.all(receipts.map(async (receipt) => receipt.closeVerification));
    if (state.lifecycleFailure !== undefined) throw state.lifecycleFailure;
    const closeVerificationFailure = receipts.find((receipt) => receipt.closeVerificationFailure !== undefined)?.closeVerificationFailure;
    if (closeVerificationFailure !== undefined) throw closeVerificationFailure;
    await authority.verify();
    const closed = receipts.map((receipt) => {
      if (!receipt.spawned || !receipt.spawnConfirmed || receipt.childPid === undefined || !receipt.exit || !receipt.close
        || receipt.spawnFailure !== undefined || !receipt.executableRevalidatedAfterClose) {
        fail(`native process receipt ${receipt.receiptId} is incomplete.`);
      }
      if (receipt.exit.code !== receipt.close.code || receipt.exit.signal !== receipt.close.signal) {
        fail(`native process receipt ${receipt.receiptId} exit and close disagree.`);
      }
      if (receipt.exit.code !== 0 || receipt.exit.signal !== null) {
        fail(`native process receipt ${receipt.receiptId} did not close successfully.`);
      }
      return Object.freeze({
        receiptId: receipt.receiptId,
        ordinal: receipt.ordinal,
        context: receipt.context,
        executable: authority.evidence,
        argvCount: receipt.argv.length,
        argvSha256: receipt.argvSha256,
        parentPid: receipt.parentPid,
        expectedProcessGroupId: receipt.expectedProcessGroupId,
        childPid: receipt.childPid,
        detached: false as const,
        spawned: true as const,
        exit: Object.freeze({ ...receipt.exit }),
        close: Object.freeze({ ...receipt.close }),
        executableRevalidatedAfterClose: true as const,
      });
    });
    const frozen = Object.freeze(closed);
    return Object.freeze({
      format: "cut-reference-native-process-lifecycle" as const,
      version: 1 as const,
      policy: referenceNativeProcessAuthorityPolicy.format,
      invocationNonceSha256: sha256Bytes(state.nonce),
      parentPid,
      expectedProcessGroupId,
      executable: authority.evidence,
      receipts: frozen,
      receiptCount: frozen.length,
      receiptsSha256: sha256Bytes(stableJsonStringify(frozen)),
    });
  };
  const collector: ReferenceNativeProcessCollector = Object.freeze({
    authority,
    parentPid,
    expectedProcessGroupId,
    seal,
  });
  collectorPrivate.set(collector, state);
  issuedCollectors.add(collector);
  return collector;
}

function lifecycleEvent(
  collector: ReferenceNativeProcessCollector,
  state: CollectorPrivate,
  receipt: MutableReceipt,
  phase: ReferenceNativeProcessLifecycleEvent["phase"],
  detail: Readonly<{
    childPid?: number | null;
    terminal?: Readonly<{ code: number | null; signal: NodeJS.Signals | null }>;
    failureCode?: string;
  }> = {},
) {
  if (!state.lifecycleEvent) return;
  const event = Object.freeze({
    format: "cut-reference-native-process-lifecycle-event" as const,
    version: 1 as const,
    phase,
    receiptId: receipt.receiptId,
    tool: collector.authority.tool,
    context: receipt.context,
    executable: collector.authority.evidence,
    argvCount: receipt.argv.length,
    argvSha256: receipt.argvSha256,
    parentPid: receipt.parentPid,
    expectedProcessGroupId: receipt.expectedProcessGroupId,
    childPid: detail.childPid ?? receipt.childPid ?? null,
    ...(detail.terminal === undefined ? {} : { terminal: Object.freeze({ ...detail.terminal }) }),
    ...(detail.failureCode === undefined ? {} : { failureCode: detail.failureCode }),
  }) satisfies ReferenceNativeProcessLifecycleEvent;
  try {
    state.lifecycleEvent(event);
  } catch (error) {
    state.lifecycleFailure ??= error;
    throw error;
  }
}

function collectorState(collector: ReferenceNativeProcessCollector) {
  if (!collector || typeof collector !== "object" || !issuedCollectors.has(collector)) {
    fail("native process collector was not issued by this module instance.");
  }
  const state = collectorPrivate.get(collector);
  if (!state || state.sealed) fail("native process collector is unavailable or sealed.");
  return state;
}

export async function spawnBoundReferenceNativeProcess(
  collector: ReferenceNativeProcessCollector,
  contextValue: ReferenceNativeProcessContext,
  argumentValues: readonly string[],
  options: SpawnOptions,
): Promise<ChildProcess> {
  const state = collectorState(collector);
  const authority = collector.authority;
  assertAuthority(authority);
  const context = normalizedContext(contextValue);
  if (state.ordinals.has(context.ordinal)) fail("native process context ordinal was duplicated.");
  const safeOptions = normalizedSpawnOptions(options);
  const args = boundedArgumentList(argumentValues);
  const canonicalArgv = Object.freeze([authority.executablePath, ...args]);
  const argvSha256 = sha256Bytes(stableJsonStringify(canonicalArgv));
  const receiptId = sha256Bytes(stableJsonStringify({
    domain: "cut-reference-native-process-receipt-v1",
    invocationNonce: state.nonce,
    context,
    argvSha256,
    executable: authority.evidence,
  }));
  if (state.receipts.has(receiptId)) fail("native process receipt id was duplicated.");
  const receipt: MutableReceipt = {
    receiptId,
    ordinal: context.ordinal,
    context,
    argv: canonicalArgv,
    argvSha256,
    parentPid: collector.parentPid,
    expectedProcessGroupId: collector.expectedProcessGroupId,
    spawned: false,
    spawnConfirmed: false,
    executableRevalidatedAfterClose: false,
  };
  state.receipts.set(receiptId, receipt);
  state.ordinals.add(context.ordinal);
  await authority.verify();
  lifecycleEvent(collector, state, receipt, "reserved");
  let child: ChildProcess;
  try {
    child = spawn(authority.executablePath, args, safeOptions);
  } catch (error) {
    receipt.spawnFailure = systemCode(error);
    lifecycleEvent(collector, state, receipt, "spawn-failed", {
      failureCode: receipt.spawnFailure,
    });
    throw error;
  }
  if (!Number.isSafeInteger(child.pid) || (child.pid as number) < 1) {
    receipt.spawnFailure = "NO_PID";
    child.kill("SIGKILL");
    fail("bound native process returned no positive child pid.");
  }
  if (child.spawnfile !== authority.executablePath
    || stableJsonStringify(child.spawnargs) !== stableJsonStringify(canonicalArgv)) {
    receipt.spawnFailure = "SPAWN_AUTHORITY";
    child.kill("SIGKILL");
    fail("bound native process spawnfile or spawnargs differs from its authority.");
  }
  const childPid = child.pid as number;
  if (state.pids.has(childPid)) {
    receipt.spawnFailure = "PID_REUSE";
    child.kill("SIGKILL");
    fail("native process collector observed a reused child pid.");
  }
  state.pids.add(childPid);
  receipt.childPid = childPid;
  receipt.spawned = true;
  receipt.completion = new Promise((accept) => { receipt.finishCompletion = accept; });
  child.on("spawn", () => {
    if (receipt.spawnConfirmed) { receipt.spawnFailure ??= "DUPLICATE_SPAWN"; return; }
    receipt.spawnConfirmed = true;
    try { lifecycleEvent(collector, state, receipt, "spawn-confirmed", { childPid }); }
    catch { child.kill("SIGKILL"); }
  });
  child.once("error", (error) => {
    receipt.spawnFailure ??= systemCode(error);
  });
  child.once("exit", (code, signal) => {
    if (receipt.exit !== undefined) { receipt.spawnFailure ??= "DUPLICATE_EXIT"; return; }
    receipt.exit = { code, signal };
    try { lifecycleEvent(collector, state, receipt, "exit", { childPid, terminal: receipt.exit }); }
    catch { /* seal reports the observer failure after process cleanup */ }
  });
  child.once("close", (code, signal) => {
    if (receipt.close !== undefined) { receipt.spawnFailure ??= "DUPLICATE_CLOSE"; return; }
    receipt.close = { code, signal };
    receipt.closeVerification = authority.verify().then(
      () => {
        receipt.executableRevalidatedAfterClose = true;
        lifecycleEvent(collector, state, receipt, "close-verified", { childPid, terminal: receipt.close });
      },
      (error) => { receipt.closeVerificationFailure = error; },
    ).catch((error) => { receipt.closeVerificationFailure = error; });
    receipt.finishCompletion?.();
  });
  try {
    lifecycleEvent(collector, state, receipt, "launched", { childPid });
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
  return child;
}
