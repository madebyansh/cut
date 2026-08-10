import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { CutFootageError, footageFail } from "./diagnostics";

export const cutFootageSidecarLimits = Object.freeze({
  maximumRequestBytes: 1024 * 1024,
  maximumResponseLineBytes: 16 * 1024 * 1024,
  maximumStdoutBytes: 32 * 1024 * 1024,
  maximumStderrBytes: 256 * 1024,
  maximumCandidates: 100_000,
  handshakeMs: 30_000,
  indexMs: 30 * 60_000,
  searchMs: 120_000,
  closeMs: 5_000,
  terminateGraceMs: 1_000,
  maximumEnvironmentValueBytes: 4_096,
  maximumArgumentBytes: 16_384,
  maximumArguments: 64,
});
const cutFootageSidecarLimitCeilings = Object.freeze({
  ...cutFootageSidecarLimits,
  handshakeMs: 30 * 60_000,
});

export type CutFootageSidecarHandshake = Readonly<{
  format: "cut-footage-sidecar-handshake"; version: 1; protocolVersion: 1;
  provider: string; model: string; revision: string; dimensions: number; normalization: "l2";
  modalities: readonly ["image", "text"]; hardware: "cpu";
  adapterSha256: string; selfTestSha256: string;
}>;
export type CutFootageSidecarPlan = Readonly<{ path: string; bytes: number; sha256: string }>;
export type CutFootageSidecarArtifact = Readonly<{ path: string; bytes: number; sha256: string }>;
export type CutFootageSidecarIndexResult = Readonly<{ bytes: number; sha256: string; recordCount: number; dimensions: number }>;
export type CutFootageSidecarCandidate = Readonly<{ chunkId: string; score: number }>;
export type CutFootageSidecarLimits = Readonly<{ [Key in keyof typeof cutFootageSidecarLimits]?: number }>;
type ResolvedCutFootageSidecarLimits = Readonly<{ [Key in keyof typeof cutFootageSidecarLimits]: number }>;
export type CutFootageSidecarStart = Readonly<{
  executable: string; arguments: readonly string[]; expectedHandshake: CutFootageSidecarHandshake;
  environment?: Readonly<Record<string, string>>; limits?: CutFootageSidecarLimits; signal?: AbortSignal;
}>;
export type CutFootageSidecarSession = Readonly<{
  readonly handshake: CutFootageSidecarHandshake;
  readonly pid: number | undefined;
  index(request: Readonly<{ plan: CutFootageSidecarPlan; artifactPath: string }>): Promise<CutFootageSidecarIndexResult>;
  searchText(request: Readonly<{ artifact: CutFootageSidecarArtifact; query: string }>): Promise<readonly CutFootageSidecarCandidate[]>;
  close(): Promise<void>;
}>;

const allowedEnvironment = new Set([
  "ALL_PROXY",
  "CUT_FOOTAGE_CACHE_DIR",
  "CUT_FOOTAGE_MODEL_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
]);
const shaPattern = /^[a-f0-9]{64}$/u;
const idPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const safeTextPattern = /^[^\u0000-\u001f\u007f]+$/u;

function protocol(reason: string): never { return footageFail("CUT_FOOTAGE_BACKEND_PROTOCOL", "$sidecar", reason); }
function object(value: unknown, reason: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) protocol(reason);
  return value as Record<string, unknown>;
}
function closed(value: unknown, required: readonly string[], reason: string): Record<string, unknown> {
  const result = object(value, reason), keys = Object.keys(result);
  if (keys.length !== required.length || required.some((key) => !Object.hasOwn(result, key))) protocol(reason);
  return result;
}
function boundedText(value: unknown, maximum: number, reason: string): string {
  if (typeof value !== "string" || !value.length || Buffer.byteLength(value, "utf8") > maximum || !safeTextPattern.test(value)) protocol(reason);
  return value;
}
function absolutePath(value: unknown, reason: string): string {
  const text = boundedText(value, 16_384, reason);
  if (!text.startsWith("/") || text.includes("\\") || text.split("/").some((part, index) => index > 0 && (!part || part === "." || part === ".."))) protocol(reason);
  return text;
}
function positive(value: unknown, maximum: number, reason: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) protocol(reason);
  return Number(value);
}
function sha(value: unknown, reason: string): string {
  if (typeof value !== "string" || !shaPattern.test(value)) protocol(reason);
  return value;
}
function freezeHandshake(value: Record<string, unknown>): CutFootageSidecarHandshake {
  const record = closed(value, ["format", "version", "protocolVersion", "provider", "model", "revision", "dimensions", "normalization", "modalities", "hardware", "adapterSha256", "selfTestSha256"], "handshake is malformed");
  if (record.format !== "cut-footage-sidecar-handshake" || record.version !== 1 || record.protocolVersion !== 1 || record.normalization !== "l2" || record.hardware !== "cpu"
    || !Array.isArray(record.modalities) || record.modalities.length !== 2 || record.modalities[0] !== "image" || record.modalities[1] !== "text") protocol("handshake is malformed");
  return Object.freeze({
    format: "cut-footage-sidecar-handshake", version: 1, protocolVersion: 1,
    provider: boundedText(record.provider, 256, "handshake is malformed"), model: boundedText(record.model, 256, "handshake is malformed"), revision: boundedText(record.revision, 256, "handshake is malformed"),
    dimensions: positive(record.dimensions, 65_536, "handshake is malformed"), normalization: "l2", modalities: Object.freeze(["image", "text"] as ["image", "text"]), hardware: "cpu",
    adapterSha256: sha(record.adapterSha256, "handshake is malformed"), selfTestSha256: sha(record.selfTestSha256, "handshake is malformed"),
  });
}
function sameHandshake(left: CutFootageSidecarHandshake, right: CutFootageSidecarHandshake) { return JSON.stringify(left) === JSON.stringify(right); }
function parseJson(line: Buffer): unknown { try { return JSON.parse(line.toString("utf8")); } catch { return protocol("received malformed JSON"); } }
function boundedLimits(overrides: CutFootageSidecarLimits | undefined) {
  if (overrides !== undefined && (!overrides || typeof overrides !== "object" || Array.isArray(overrides))) protocol("limits are malformed");
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (!Object.hasOwn(cutFootageSidecarLimits, key)) protocol("limits are not allowlisted");
    const maximum = cutFootageSidecarLimitCeilings[key as keyof typeof cutFootageSidecarLimits];
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) protocol(`invalid ${key} limit`);
  }
  const result = { ...cutFootageSidecarLimits, ...overrides };
  for (const [key, value] of Object.entries(result)) {
    const maximum = cutFootageSidecarLimitCeilings[key as keyof typeof cutFootageSidecarLimits];
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) protocol(`invalid ${key} limit`);
  }
  return Object.freeze(result);
}
function validateStart(start: CutFootageSidecarStart, limits: ResolvedCutFootageSidecarLimits) {
  boundedText(start.executable, limits.maximumArgumentBytes, "executable is malformed");
  if (!Array.isArray(start.arguments) || start.arguments.length > limits.maximumArguments) protocol("arguments are malformed");
  for (const argument of start.arguments) boundedText(argument, limits.maximumArgumentBytes, "arguments are malformed");
  freezeHandshake(start.expectedHandshake as unknown as Record<string, unknown>);
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(start.environment ?? {})) {
    if (!allowedEnvironment.has(key) || !/^[A-Z0-9_]{1,64}$/u.test(key)) protocol("environment is not allowlisted");
    environment[key] = boundedText(value, limits.maximumEnvironmentValueBytes, "environment is malformed");
  }
  return Object.freeze(environment);
}

type Pending = Readonly<{ id: string; operation: "index" | "searchText" | "close"; resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>;

/** Runs one closed v1 JSONL sidecar session. It deliberately has no model setup or indexing policy. */
export async function startCutFootageSidecar(start: CutFootageSidecarStart): Promise<CutFootageSidecarSession> {
  const limits = boundedLimits(start.limits), environment = validateStart(start, limits);
  const expected = freezeHandshake(start.expectedHandshake as unknown as Record<string, unknown>);
  let child: ChildProcessWithoutNullStreams;
  const terminateProcessGroup = process.platform !== "win32";
  try {
    child = spawn(start.executable, [...start.arguments], { shell: false, detached: terminateProcessGroup, stdio: ["pipe", "pipe", "pipe"], env: environment });
  } catch { protocol("sidecar could not start"); }
  let pid: number | undefined = child!.pid;
  let stdout = Buffer.alloc(0), stdoutBytes = 0, stderrBytes = 0, handshaken = false, closeRequested = false, closeSent = false, closeAcknowledged = false;
  let fatal: CutFootageError | undefined, pending: Pending | undefined, settled: Readonly<{ pending: Pending; result: unknown }> | undefined, closePromise: Promise<void> | undefined;
  let terminateTimer: NodeJS.Timeout | undefined, drainTimer: NodeJS.Timeout | undefined, closeTimer: NodeJS.Timeout | undefined;
  let resolveDead!: () => void;
  const dead = new Promise<void>((resolve) => { resolveDead = resolve; });
  let resolveHandshake!: (value: CutFootageSidecarSession) => void, rejectHandshake!: (error: Error) => void;
  const handshakeReady = new Promise<CutFootageSidecarSession>((resolve, reject) => { resolveHandshake = resolve; rejectHandshake = reject; });

  const error = (reason: string) => new CutFootageError("CUT_FOOTAGE_BACKEND_PROTOCOL", "$sidecar", reason);
  const signalTree = (signal: NodeJS.Signals) => {
    if (pid === undefined) return;
    if (terminateProcessGroup) {
      try { process.kill(-pid, signal); return; } catch { /* fall through to the direct child */ }
    }
    try { child!.kill(signal); } catch { /* the process already ended */ }
  };
  const finish = (reason: string) => {
    if (fatal) return;
    fatal = error(reason);
    clearTimeout(terminateTimer);
    clearTimeout(drainTimer);
    clearTimeout(closeTimer);
    if (pending) {
      clearTimeout(pending.timer);
      const current = pending; pending = undefined;
      void dead.then(() => current.reject(fatal!));
    }
    void dead.then(() => rejectHandshake(fatal!));
    child!.stdin.end();
    if (pid !== undefined) {
      signalTree("SIGTERM");
      terminateTimer = setTimeout(() => {
        signalTree("SIGKILL");
        drainTimer = setTimeout(() => {
          child!.stdin.destroy();
          child!.stdout.destroy();
          child!.stderr.destroy();
        }, 50);
      }, limits.terminateGraceMs);
    }
  };
  const finishSoon = (reason: string) => queueMicrotask(() => finish(reason));
  const rejectTimeout = (operation: string) => finish(`${operation} timed out`);
  const processLine = (line: Buffer) => {
    if (fatal) return;
    if (line.byteLength > limits.maximumResponseLineBytes) return finishSoon("response line exceeds its byte limit");
    let value: unknown;
    try { value = parseJson(line); } catch { return finishSoon("received malformed JSON"); }
    if (!handshaken) {
      let received: CutFootageSidecarHandshake;
      try { received = freezeHandshake(object(value, "handshake is malformed")); } catch { return finishSoon("handshake is malformed"); }
      if (!sameHandshake(received, expected)) return finishSoon("handshake does not match the expected identity");
      handshaken = true;
      setImmediate(() => { if (!fatal) resolveHandshake(session); });
      return;
    }
    let response: Record<string, unknown>;
    try { response = closed(value, ["format", "version", "id", "operation"], "response is malformed"); }
    catch {
      try { response = object(value, "response is malformed"); } catch { return finishSoon("response is malformed"); }
    }
    if (response.format !== "cut-footage-sidecar-response" || response.version !== 1 || typeof response.id !== "string" || (response.operation !== "index" && response.operation !== "searchText" && response.operation !== "close")) return finishSoon("response is malformed");
    if (!pending || settled || response.id !== pending.id || response.operation !== pending.operation) return finishSoon("response is unsolicited or out of order");
    const current = pending;
    let result: unknown;
    try {
      if (current.operation === "index") {
        const record = closed(value, ["format", "version", "id", "operation", "artifact"], "index response is malformed");
        const artifact = closed(record.artifact, ["bytes", "sha256", "recordCount", "dimensions"], "index response is malformed");
        const dimensions = positive(artifact.dimensions, 65_536, "index response is malformed");
        if (dimensions !== expected.dimensions) protocol("index response is malformed");
        result = Object.freeze({ bytes: positive(artifact.bytes, Number.MAX_SAFE_INTEGER, "index response is malformed"), sha256: sha(artifact.sha256, "index response is malformed"), recordCount: positive(artifact.recordCount, limits.maximumCandidates, "index response is malformed"), dimensions });
      } else if (current.operation === "searchText") {
        const record = closed(value, ["format", "version", "id", "operation", "candidates"], "search response is malformed");
        if (!Array.isArray(record.candidates) || record.candidates.length > limits.maximumCandidates) protocol("search response is malformed");
        const ids = new Set<string>();
        result = Object.freeze(record.candidates.map((candidate: unknown) => {
          const item = closed(candidate, ["chunkId", "score"], "search response is malformed");
          const chunkId = boundedText(item.chunkId, 128, "search response is malformed");
          if (!idPattern.test(chunkId) || ids.has(chunkId) || typeof item.score !== "number" || !Number.isFinite(item.score) || item.score < -1 || item.score > 1) protocol("search response is malformed");
          ids.add(chunkId);
          return Object.freeze({ chunkId, score: item.score });
        }));
      } else {
        closed(value, ["format", "version", "id", "operation"], "close response is malformed");
        closeAcknowledged = true;
        result = undefined;
      }
    } catch { return finishSoon("response violates the footage protocol"); }
    if (current.operation !== "close") clearTimeout(current.timer);
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
    if (stdout.byteLength > limits.maximumResponseLineBytes) finish("response line exceeds its byte limit");
    if (settled) {
      const response = settled;
      setImmediate(() => {
        if (fatal || settled !== response) return;
        settled = undefined;
        pending = undefined;
        response.pending.resolve(response.result);
      });
    }
  });
  child!.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.byteLength; if (stderrBytes > limits.maximumStderrBytes) finish("stderr exceeds its byte limit"); });
  child!.on("error", () => finish("sidecar could not start"));
  child!.on("close", (code) => {
    clearTimeout(terminateTimer); clearTimeout(drainTimer); clearTimeout(closeTimer); pid = undefined;
    start.signal?.removeEventListener("abort", abort);
    if (stdout.byteLength) finish("sidecar ended with a partial response line");
    else if (!fatal && (!closeRequested || !closeSent || !closeAcknowledged || code !== 0)) finish("sidecar exited before a valid close");
    resolveDead();
  });
  const handshakeTimer = setTimeout(() => finish("handshake timed out"), limits.handshakeMs);
  handshakeReady.finally(() => clearTimeout(handshakeTimer)).catch(() => undefined);
  const abort = () => finish("sidecar operation was cancelled");
  if (start.signal?.aborted) finish("sidecar operation was cancelled");
  else start.signal?.addEventListener("abort", abort, { once: true });

  let requestOrdinal = 0;
  let tail: Promise<unknown> = Promise.resolve();
  const request = <T>(operation: "index" | "searchText" | "close", body: Record<string, unknown>, timeout: number): Promise<T> => {
    const run = () => new Promise<unknown>((resolve, reject) => {
      if (fatal || pid === undefined) {
        if (fatal && pid !== undefined) void dead.then(() => reject(fatal!));
        else reject(fatal ?? error("sidecar is not running"));
        return;
      }
      const id = `footage-${++requestOrdinal}`;
      const message = JSON.stringify(Object.freeze({ format: "cut-footage-sidecar-request", version: 1, id, operation, ...body }));
      if (Buffer.byteLength(message, "utf8") > limits.maximumRequestBytes) {
        finish("request exceeds its byte limit");
        void dead.then(() => reject(fatal!));
        return;
      }
      const timer = setTimeout(() => rejectTimeout(operation), timeout);
      pending = Object.freeze({ id, operation, resolve, reject, timer });
      if (operation === "close") { closeSent = true; closeTimer = timer; }
      child!.stdin.write(`${message}\n`, (writeError) => { if (writeError) finish("sidecar request write failed"); });
    });
    const next = tail.then(run, run) as Promise<T>;
    tail = next.catch(() => undefined);
    return next;
  };
  const session: CutFootageSidecarSession = Object.freeze({
    handshake: expected,
    get pid() { return pid; },
    async index(requestValue) {
      if (closeRequested) throw error("sidecar is closing");
      const plan = requestValue?.plan;
      const planRecord = object(plan, "index request is malformed");
      const payload = Object.freeze({ plan: Object.freeze({ path: absolutePath(planRecord.path, "index request is malformed"), bytes: positive(planRecord.bytes, Number.MAX_SAFE_INTEGER, "index request is malformed"), sha256: sha(planRecord.sha256, "index request is malformed") }), artifactPath: absolutePath(requestValue.artifactPath, "index request is malformed") });
      return request<CutFootageSidecarIndexResult>("index", payload, limits.indexMs);
    },
    async searchText(requestValue) {
      if (closeRequested) throw error("sidecar is closing");
      const artifact = object(requestValue?.artifact, "search request is malformed");
      const payload = Object.freeze({ artifact: Object.freeze({ path: absolutePath(artifact.path, "search request is malformed"), bytes: positive(artifact.bytes, Number.MAX_SAFE_INTEGER, "search request is malformed"), sha256: sha(artifact.sha256, "search request is malformed") }), query: boundedText(requestValue.query, 4_096, "search request is malformed") });
      return request<readonly CutFootageSidecarCandidate[]>("searchText", payload, limits.searchMs);
    },
    close() {
      if (!closePromise) {
        closeRequested = true;
        closePromise = request<void>("close", {}, limits.closeMs).then(async () => {
          await dead;
          if (fatal) throw fatal;
        });
      }
      return closePromise;
    },
  });
  return handshakeReady;
}
