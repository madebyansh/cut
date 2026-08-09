import { spawn, type ChildProcessByStdio } from "node:child_process";
import { once } from "node:events";
import { isAbsolute } from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  spawnBoundReferenceNativeProcess,
  type BoundReferenceNativeMediaTool,
  type ReferenceNativeProcessCollector,
  type ReferenceNativeProcessContext,
} from "../../project/native-process-authority";
import type { ReferenceColorProfile } from "./color-management";
import { referenceSceneEncodingContract } from "./scene-encoding";

type EncoderChild = ChildProcessByStdio<Writable, null, Readable>;

export type ReferenceMediaProcessErrorCode =
  | "CUT_MEDIA_PROCESS_CONTRACT"
  | "CUT_MEDIA_PROCESS_START"
  | "CUT_MEDIA_PROCESS_ABORTED"
  | "CUT_MEDIA_PROCESS_TIMEOUT"
  | "CUT_MEDIA_PROCESS_OUTPUT_LIMIT"
  | "CUT_MEDIA_PROCESS_STREAM"
  | "CUT_MEDIA_PROCESS_EXIT";

export type ReferenceMediaProcessErrorDetail = Readonly<{
  kind: "contract" | "start" | "abort" | "timeout" | "output" | "stream" | "exit";
  reason: string;
  timeoutMs?: number;
  stream?: "stdout" | "stderr" | "combined";
  observedBytes?: number;
  limitBytes?: number;
  stdoutBytes?: number;
  stderrBytes?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  systemCode?: string;
}>;

export class ReferenceMediaProcessError extends Error {
  constructor(
    readonly code: ReferenceMediaProcessErrorCode,
    readonly tool: "ffmpeg" | "ffprobe",
    message: string,
    readonly detail: ReferenceMediaProcessErrorDetail,
  ) {
    super(`${code}: ${message}`);
    this.name = "ReferenceMediaProcessError";
    this.detail = Object.freeze({ ...detail });
  }
}

export type ReferenceMediaProcessCaptureLimits = Readonly<{
  stdoutBytes?: number;
  stderrBytes?: number;
  totalBytes?: number;
}>;

export type ReferenceMediaProcessStderrLimits = Readonly<{
  stderrBytes?: number;
  totalBytes?: number;
}>;

export type ReferenceMediaProcessControl = Readonly<{
  signal?: AbortSignal;
  /** Read-only descriptors inherited at child descriptors 3..N in the authored order. */
  inheritedFileDescriptors?: readonly number[];
  /** Launch a private POSIX process group and terminate the complete group on failure. */
  terminateProcessTree?: boolean;
  terminationGraceMs?: number;
}>;

type ProcessTool = "ffmpeg" | "ffprobe";
export type ReferenceMediaNativeProcessExecution = Readonly<{
  authority: BoundReferenceNativeMediaTool;
  collector: ReferenceNativeProcessCollector;
  context: ReferenceNativeProcessContext;
}>;
type NormalizedOutputLimits = Readonly<{
  stdoutBytes: number;
  stderrBytes: number;
  totalBytes: number;
}>;

const maximumTimeoutMs = 24 * 60 * 60 * 1_000;
const maximumStreamOutputBytes = 16 * 1_024 * 1_024;
const maximumCombinedOutputBytes = 2 * maximumStreamOutputBytes;
const maximumArguments = 4_096;
const maximumSingleArgumentBytes = 8 * 1_024 * 1_024;
const maximumArgumentBytes = 16 * 1_024 * 1_024;
const defaultRunLimits = Object.freeze({ stdoutBytes: 0, stderrBytes: 32_000, totalBytes: 32_000 });
const defaultCaptureLimits = Object.freeze({ stdoutBytes: 128_000, stderrBytes: 128_000, totalBytes: 256_000 });
const defaultTerminationGraceMs = 250;
const maximumInheritedFileDescriptors = 16;

function normalizeProcessControl(tool: ProcessTool, authored: unknown) {
  let control: Record<string, unknown>;
  try {
    control = authored === undefined ? {} : authored as Record<string, unknown>;
    if (!control || typeof control !== "object" || Array.isArray(control)
      || Reflect.ownKeys(control).some((key) => typeof key !== "string" || !["signal", "inheritedFileDescriptors", "terminateProcessTree", "terminationGraceMs"].includes(key))) {
      throw new Error("invalid process control");
    }
    for (const key of Object.keys(control)) {
      const descriptor = Object.getOwnPropertyDescriptor(control, key);
      if (!descriptor || !("value" in descriptor)) throw new Error("non-inert process control");
    }
  } catch {
    throw processFailure("CUT_MEDIA_PROCESS_CONTRACT", tool, "process control is malformed.", { kind: "contract", reason: "invalid-process-control" });
  }
  const signal = control.signal;
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw processFailure("CUT_MEDIA_PROCESS_CONTRACT", tool, "process signal must be one AbortSignal.", { kind: "contract", reason: "invalid-signal" });
  }
  let descriptors: readonly number[] = Object.freeze([]);
  if (control.inheritedFileDescriptors !== undefined) {
    if (!Array.isArray(control.inheritedFileDescriptors) || control.inheritedFileDescriptors.length > maximumInheritedFileDescriptors
      || control.inheritedFileDescriptors.some((fd) => !Number.isSafeInteger(fd) || fd < 0)
      || new Set(control.inheritedFileDescriptors).size !== control.inheritedFileDescriptors.length) {
      throw processFailure("CUT_MEDIA_PROCESS_CONTRACT", tool, "inherited file descriptors must be one bounded unique integer array.", { kind: "contract", reason: "invalid-inherited-file-descriptors" });
    }
    descriptors = Object.freeze([...control.inheritedFileDescriptors]);
  }
  if (control.terminateProcessTree !== undefined && typeof control.terminateProcessTree !== "boolean") {
    throw processFailure("CUT_MEDIA_PROCESS_CONTRACT", tool, "terminateProcessTree must be boolean.", { kind: "contract", reason: "invalid-process-tree-control" });
  }
  const terminateProcessTree = control.terminateProcessTree === true;
  if (terminateProcessTree && process.platform === "win32") {
    throw processFailure("CUT_MEDIA_PROCESS_CONTRACT", tool, "private process-tree termination is unavailable on Windows.", { kind: "contract", reason: "unsupported-process-tree-control" });
  }
  const terminationGraceMs = control.terminationGraceMs ?? defaultTerminationGraceMs;
  if (!Number.isSafeInteger(terminationGraceMs) || Number(terminationGraceMs) < 10 || Number(terminationGraceMs) > 5_000) {
    throw processFailure("CUT_MEDIA_PROCESS_CONTRACT", tool, "terminationGraceMs must be an integer from 10 to 5000.", { kind: "contract", reason: "invalid-termination-grace" });
  }
  return Object.freeze({ signal: signal as AbortSignal | undefined, inheritedFileDescriptors: descriptors, terminateProcessTree, terminationGraceMs: Number(terminationGraceMs) });
}

function processFailure(
  code: ReferenceMediaProcessErrorCode,
  tool: ProcessTool,
  message: string,
  detail: ReferenceMediaProcessErrorDetail,
) {
  return new ReferenceMediaProcessError(code, tool, message, detail);
}

function systemErrorCode(error: unknown) {
  try {
    const value = error && typeof error === "object" && "code" in error ? error.code : undefined;
    return typeof value === "string" && /^[A-Z0-9_]{1,32}$/u.test(value) ? value : "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}

function normalizeTimeout(tool: ProcessTool, value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximumTimeoutMs) {
    throw processFailure(
      "CUT_MEDIA_PROCESS_CONTRACT",
      tool,
      `process timeout must be a positive safe integer no greater than ${maximumTimeoutMs}ms.`,
      { kind: "contract", reason: "invalid-timeout" },
    );
  }
  return value as number;
}

function normalizeArguments(tool: ProcessTool, value: unknown) {
  let authored: unknown[];
  try {
    if (!Array.isArray(value) || value.length > maximumArguments) throw new Error("invalid arguments");
    authored = Array.from(value);
  } catch {
    throw processFailure(
      "CUT_MEDIA_PROCESS_CONTRACT",
      tool,
      `process arguments must be an array with at most ${maximumArguments} entries.`,
      { kind: "contract", reason: "invalid-arguments" },
    );
  }
  let argumentBytes = 0;
  const args = authored.map((argument) => {
    if (typeof argument !== "string" || argument.includes("\0")) {
      throw processFailure(
        "CUT_MEDIA_PROCESS_CONTRACT",
        tool,
        "every process argument must be a string without NUL bytes.",
        { kind: "contract", reason: "invalid-argument" },
      );
    }
    const bytes = Buffer.byteLength(argument, "utf8") + 1;
    if (bytes > maximumSingleArgumentBytes) {
      throw processFailure(
        "CUT_MEDIA_PROCESS_CONTRACT",
        tool,
        `one process argument exceeds the ${maximumSingleArgumentBytes}-byte boundary.`,
        { kind: "contract", reason: "single-argument-budget" },
      );
    }
    argumentBytes += bytes;
    return argument;
  });
  if (argumentBytes > maximumArgumentBytes) {
    throw processFailure(
      "CUT_MEDIA_PROCESS_CONTRACT",
      tool,
      `process arguments exceed the ${maximumArgumentBytes}-byte aggregate boundary.`,
      { kind: "contract", reason: "argument-budget" },
    );
  }
  return args;
}

function normalizeOutputLimits(
  tool: ProcessTool,
  authored: unknown,
  captureStdout: boolean,
  defaults: NormalizedOutputLimits,
): NormalizedOutputLimits {
  let options: Record<string, unknown>;
  try {
    if (authored === undefined) options = {};
    else if (typeof authored === "object" && authored !== null && !Array.isArray(authored)) options = authored as Record<string, unknown>;
    else throw new Error("invalid options");
    const allowed = new Set(captureStdout ? ["stdoutBytes", "stderrBytes", "totalBytes"] : ["stderrBytes", "totalBytes"]);
    if (Reflect.ownKeys(options).some((key) => typeof key !== "string" || !allowed.has(key))) throw new Error("unknown option");
  } catch {
    throw processFailure(
      "CUT_MEDIA_PROCESS_CONTRACT",
      tool,
      "process output limits must contain only supported byte-budget properties.",
      { kind: "contract", reason: "invalid-output-limits" },
    );
  }
  const validate = (name: keyof NormalizedOutputLimits, maximum: number) => {
    let value: unknown;
    try { value = options[name] ?? defaults[name]; }
    catch {
      throw processFailure(
        "CUT_MEDIA_PROCESS_CONTRACT",
        tool,
        "process output byte budgets must be inert numeric values.",
        { kind: "contract", reason: "invalid-output-limit" },
      );
    }
    if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
      throw processFailure(
        "CUT_MEDIA_PROCESS_CONTRACT",
        tool,
        `process ${name} must be a non-negative safe integer no greater than ${maximum}.`,
        { kind: "contract", reason: "invalid-output-limit" },
      );
    }
    return value as number;
  };
  return Object.freeze({
    stdoutBytes: captureStdout ? validate("stdoutBytes", maximumStreamOutputBytes) : 0,
    stderrBytes: validate("stderrBytes", maximumStreamOutputBytes),
    totalBytes: validate("totalBytes", maximumCombinedOutputBytes),
  });
}

async function runReferenceMediaProcess(
  tool: ProcessTool,
  authoredArgs: unknown,
  authoredTimeout: unknown,
  authoredLimits: unknown,
  captureStdout: boolean,
  executable: string = tool,
  execution?: ReferenceMediaNativeProcessExecution,
  authoredControl?: ReferenceMediaProcessControl,
) {
  const args = normalizeArguments(tool, authoredArgs);
  const timeoutMs = normalizeTimeout(tool, authoredTimeout);
  const limits = normalizeOutputLimits(tool, authoredLimits, captureStdout, captureStdout ? defaultCaptureLimits : defaultRunLimits);
  const control = normalizeProcessControl(tool, authoredControl);
  if (execution !== undefined && (execution.authority.tool !== tool
    || execution.collector.authority !== execution.authority
    || execution.authority.executablePath !== executable)) {
    throw processFailure(
      "CUT_MEDIA_PROCESS_CONTRACT",
      tool,
      `${tool} native process execution authority differs from its requested executable.`,
      { kind: "contract", reason: "native-process-authority" },
    );
  }
  const abortedFailure = () => processFailure(
    "CUT_MEDIA_PROCESS_ABORTED",
    tool,
    `${tool} was cancelled through its bounded process control.`,
    { kind: "abort", reason: "abort-signal" },
  );
  if (control.signal?.aborted) throw abortedFailure();
  return new Promise<{ stdout: string; stderr: string }>(async (accept, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      const stdio: Array<"ignore" | "pipe" | number> = ["ignore", captureStdout ? "pipe" : "ignore", "pipe", ...control.inheritedFileDescriptors];
      child = execution === undefined
        ? spawn(executable, args, { shell: false, detached: control.terminateProcessTree, stdio })
        : await spawnBoundReferenceNativeProcess(execution.collector, execution.context, args, {
          shell: false,
          detached: control.terminateProcessTree,
          stdio,
        });
    } catch (error) {
      reject(processFailure(
        "CUT_MEDIA_PROCESS_START",
        tool,
        `could not start ${tool} (${systemErrorCode(error)}).`,
        { kind: "start", reason: "spawn-failure", systemCode: systemErrorCode(error) },
      ));
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let terminationFailure: ReferenceMediaProcessError | undefined;
    const timing: { timer?: NodeJS.Timeout; terminate?: NodeJS.Timeout; drain?: NodeJS.Timeout } = {};
    const finish = (error?: ReferenceMediaProcessError, result?: { stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      if (timing.timer) clearTimeout(timing.timer);
      if (timing.terminate) clearTimeout(timing.terminate);
      if (timing.drain) clearTimeout(timing.drain);
      control.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else accept(result!);
    };
    const signalProcess = (signal: NodeJS.Signals) => {
      if (control.terminateProcessTree && child.pid !== undefined) {
        try { process.kill(-child.pid, signal); return; }
        catch { /* The direct child fallback still closes CUT's bound process. */ }
      }
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    };
    const terminate = (error: ReferenceMediaProcessError) => {
      if (settled || terminationFailure) return;
      terminationFailure = error;
      stdout.length = 0;
      stderr.length = 0;
      signalProcess("SIGTERM");
      timing.terminate = setTimeout(() => {
        signalProcess("SIGKILL");
        timing.drain = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish(terminationFailure);
        }, control.terminationGraceMs);
      }, control.terminationGraceMs);
    };
    const abort = () => terminate(abortedFailure());
    const outputFailure = (stream: "stdout" | "stderr" | "combined", observedBytes: number, limitBytes: number) => processFailure(
      "CUT_MEDIA_PROCESS_OUTPUT_LIMIT",
      tool,
      `${tool} exceeded CUT's bounded ${stream} output budget.`,
      { kind: "output", reason: "output-budget", stream, observedBytes, limitBytes, stdoutBytes, stderrBytes },
    );
    const collect = (stream: "stdout" | "stderr", chunk: Buffer) => {
      if (terminationFailure) return;
      const bytes = Buffer.from(chunk);
      if (stream === "stdout") stdoutBytes += bytes.byteLength;
      else stderrBytes += bytes.byteLength;
      const streamBytes = stream === "stdout" ? stdoutBytes : stderrBytes;
      const streamLimit = stream === "stdout" ? limits.stdoutBytes : limits.stderrBytes;
      if (streamBytes > streamLimit) {
        terminate(outputFailure(stream, streamBytes, streamLimit));
        return;
      }
      const combined = stdoutBytes + stderrBytes;
      if (combined > limits.totalBytes) {
        terminate(outputFailure("combined", combined, limits.totalBytes));
        return;
      }
      (stream === "stdout" ? stdout : stderr).push(bytes);
    };
    const streamFailure = (stream: "stdout" | "stderr", error: unknown) => terminate(processFailure(
      "CUT_MEDIA_PROCESS_STREAM",
      tool,
      `${tool} ${stream} failed while collecting bounded output (${systemErrorCode(error)}).`,
      { kind: "stream", reason: "pipe-failure", stream, stdoutBytes, stderrBytes, systemCode: systemErrorCode(error) },
    ));

    child.stdout?.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stdout?.on("error", (error) => streamFailure("stdout", error));
    child.stderr?.on("data", (chunk: Buffer) => collect("stderr", chunk));
    child.stderr?.on("error", (error) => streamFailure("stderr", error));
    child.on("error", (error) => {
      if (terminationFailure) return;
      terminate(processFailure(
        "CUT_MEDIA_PROCESS_START",
        tool,
        `${tool} process failed (${systemErrorCode(error)}).`,
        { kind: "start", reason: "process-error", systemCode: systemErrorCode(error) },
      ));
    });
    // `close`, unlike `exit`, proves that both bounded pipes have drained. CUT
    // never resumes caller cleanup while a timed-out/overproducing tool may
    // still own its private output artifacts.
    child.on("close", (code, signal) => {
      if (terminationFailure) {
        finish(terminationFailure);
        return;
      }
      if (code !== 0) {
        finish(processFailure(
          "CUT_MEDIA_PROCESS_EXIT",
          tool,
          `${tool} exited without completing successfully.`,
          { kind: "exit", reason: "nonzero-exit", exitCode: code, signal, stdoutBytes, stderrBytes },
        ));
        return;
      }
      finish(undefined, {
        stdout: Buffer.concat(stdout, stdoutBytes).toString("utf8"),
        stderr: Buffer.concat(stderr, stderrBytes).toString("utf8"),
      });
    });
    timing.timer = setTimeout(() => terminate(processFailure(
      "CUT_MEDIA_PROCESS_TIMEOUT",
      tool,
      `${tool} exceeded CUT's bounded execution timeout.`,
      { kind: "timeout", reason: "timeout", timeoutMs, stdoutBytes, stderrBytes },
    )), timeoutMs);
    control.signal?.addEventListener("abort", abort, { once: true });
    if (control.signal?.aborted) abort();
  });
}

export async function runFfmpeg(
  args: string[],
  timeout = 600_000,
  limits: ReferenceMediaProcessStderrLimits = {},
) {
  await runReferenceMediaProcess("ffmpeg", args, timeout, limits, false);
}

/**
 * Run the exact absolute FFmpeg executable already bound by CUT's toolchain
 * identity layer. This is intentionally narrower than a generic process API:
 * callers still receive the same bounded stderr/timeout contract as
 * `runFfmpeg`, and no shell or PATH lookup is involved.
 */
export async function runBoundReferenceFfmpeg(
  executable: string,
  args: string[],
  timeout = 600_000,
  limits: ReferenceMediaProcessStderrLimits = {},
  execution?: ReferenceMediaNativeProcessExecution,
  control?: ReferenceMediaProcessControl,
) {
  if (typeof executable !== "string" || !isAbsolute(executable) || executable.includes("\0") || Buffer.byteLength(executable, "utf8") > 32_768) {
    throw processFailure(
      "CUT_MEDIA_PROCESS_CONTRACT",
      "ffmpeg",
      "bound FFmpeg executable must be one bounded absolute path without NUL bytes.",
      { kind: "contract", reason: "invalid-bound-executable" },
    );
  }
  await runReferenceMediaProcess("ffmpeg", args, timeout, limits, false, executable, execution, control);
}

/** Run one already-bound absolute FFmpeg executable and capture bounded output. */
export async function runBoundReferenceFfmpegCapture(
  executable: string,
  args: string[],
  timeout = 60_000,
  limits: ReferenceMediaProcessCaptureLimits = {},
  execution?: ReferenceMediaNativeProcessExecution,
  control?: ReferenceMediaProcessControl,
) {
  if (typeof executable !== "string" || !isAbsolute(executable) || executable.includes("\0") || Buffer.byteLength(executable, "utf8") > 32_768) {
    throw processFailure(
      "CUT_MEDIA_PROCESS_CONTRACT",
      "ffmpeg",
      "bound FFmpeg executable must be one bounded absolute path without NUL bytes.",
      { kind: "contract", reason: "invalid-bound-executable" },
    );
  }
  return runReferenceMediaProcess("ffmpeg", args, timeout, limits, true, executable, execution, control);
}

export async function runFfmpegCapture(
  args: string[],
  timeout = 600_000,
  limits: ReferenceMediaProcessCaptureLimits = {},
) {
  return runReferenceMediaProcess("ffmpeg", args, timeout, limits, true);
}

export async function runFfprobeCapture(
  args: string[],
  timeout = 60_000,
  limits: ReferenceMediaProcessCaptureLimits = {},
  execution?: ReferenceMediaNativeProcessExecution,
) {
  return runReferenceMediaProcess(
    "ffprobe",
    args,
    timeout,
    limits,
    true,
    execution?.authority.executablePath ?? "ffprobe",
    execution,
  );
}

/** Run one already-bound absolute FFprobe executable without PATH lookup. */
export async function runBoundReferenceFfprobeCapture(
  executable: string,
  args: string[],
  timeout = 60_000,
  limits: ReferenceMediaProcessCaptureLimits = {},
  execution?: ReferenceMediaNativeProcessExecution,
  control?: ReferenceMediaProcessControl,
) {
  if (typeof executable !== "string" || !isAbsolute(executable) || executable.includes("\0") || Buffer.byteLength(executable, "utf8") > 32_768) {
    throw processFailure(
      "CUT_MEDIA_PROCESS_CONTRACT",
      "ffprobe",
      "bound FFprobe executable must be one bounded absolute path without NUL bytes.",
      { kind: "contract", reason: "invalid-bound-executable" },
    );
  }
  return runReferenceMediaProcess("ffprobe", args, timeout, limits, true, executable, execution, control);
}

export async function writeFrame(child: EncoderChild, frame: Buffer) {
  if (!child.stdin.write(frame)) await once(child.stdin, "drain");
}

export async function finishEncoder(child: EncoderChild) {
  child.stdin.end(); const [code] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
  if (code !== 0) throw new Error(`CUT frame encoder exited with ${code}.`);
}

export async function abortEncoderAndWait(child: EncoderChild) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((accept) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      child.off("exit", finish);
      child.off("error", finish);
      accept();
    };
    child.once("exit", finish);
    child.once("error", finish);
    child.stdin.destroy();
    child.stderr.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    else finish();
  });
}

export class RawVideoReader {
  private readonly child: ChildProcessByStdio<null, Readable, Readable>;
  private readonly iterator: AsyncIterator<Buffer>;
  private buffered = Buffer.alloc(0);
  private stderr = "";
  private shutdown?: Promise<void>;
  constructor(args: string[], readonly frameBytes: number) {
    this.child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    this.iterator = this.child.stdout[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
    this.child.stderr.on("data", (chunk) => { this.stderr = `${this.stderr}${String(chunk)}`.slice(-16_000); });
  }
  async nextFrame() {
    while (this.buffered.length < this.frameBytes) {
      const next = await this.iterator.next();
      if (next.done) {
        // stdout can reach EOF one event-loop turn before Node publishes the
        // child exit status. Await the status instead of treating that normal
        // race as a decoder failure (and leaving the renderer mid-cleanup).
        const [code, signal] = this.child.exitCode === null && this.child.signalCode === null
          ? await once(this.child, "exit") as [number | null, NodeJS.Signals | null]
          : [this.child.exitCode, this.child.signalCode];
        if (code !== 0) throw new Error(`CUT video decoder stopped with ${code ?? signal}: ${this.stderr.trim()}`);
        return undefined;
      }
      this.buffered = this.buffered.length ? Buffer.concat([this.buffered, next.value]) : Buffer.from(next.value);
    }
    const frame = this.buffered.subarray(0, this.frameBytes); this.buffered = this.buffered.subarray(this.frameBytes); return frame;
  }
  closeAndWait() {
    if (this.shutdown) return this.shutdown;
    // A partially consumed rawvideo pipe can leave FFmpeg blocked in a write.
    // Destroy both read handles and use an unconditional, idempotent SIGKILL:
    // the decoder owns no output artifact and must not keep CUT alive after
    // its renderer is closed. Await exit so a verified-input snapshot remains
    // alive until no decoder can retain an open handle (especially on Windows).
    this.shutdown = new Promise<void>((accept) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) { accept(); return; }
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.child.off("exit", finish);
        this.child.off("error", finish);
        accept();
      };
      this.child.once("exit", finish);
      this.child.once("error", finish);
      this.child.stdout.destroy();
      this.child.stderr.destroy();
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
      else finish();
    });
    return this.shutdown;
  }

  close() { void this.closeAndWait(); }
}

export function referenceH264ColorEncoderArgs(profile: ReferenceColorProfile | "legacy") {
  if (profile === "legacy") return ["-pix_fmt", referenceSceneEncodingContract.outputPixelFormat];
  const transfer = profile === "srgb" ? "iec61966-2-1" : profile === "linear-srgb" ? "linear" : "bt709";
  const full = profile !== "rec709-limited", range = full ? "pc" : "tv";
  return [
    "-vf", `scale=out_color_matrix=bt709:out_range=${range},format=${referenceSceneEncodingContract.outputPixelFormat}`,
    "-x264-params", `colorprim=bt709:transfer=${transfer}:colormatrix=bt709:fullrange=${full ? "on" : "off"}`,
  ];
}

export function spawnRawEncoder(width: number, height: number, fps: string, output: string, color: ReferenceColorProfile | "legacy" = "legacy", executable = "ffmpeg") {
  const child = spawn(executable, ["-y", "-v", "error", "-f", referenceSceneEncodingContract.inputFormat, "-pixel_format", referenceSceneEncodingContract.inputPixelFormat, "-video_size", `${width}x${height}`, "-framerate", fps, "-i", "pipe:0", "-an", "-c:v", referenceSceneEncodingContract.encoder, "-bf", String(referenceSceneEncodingContract.bFrames), "-preset", referenceSceneEncodingContract.preset, "-crf", String(referenceSceneEncodingContract.crf), ...referenceH264ColorEncoderArgs(color), "-movflags", referenceSceneEncodingContract.movFlags, output], { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = ""; child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-16_000); });
  child.on("error", () => undefined); child.on("exit", (code) => { if (code && stderr) process.stderr.write(stderr); });
  return child;
}

export async function spawnBoundRawEncoder(
  width: number,
  height: number,
  fps: string,
  output: string,
  color: ReferenceColorProfile | "legacy",
  execution: ReferenceMediaNativeProcessExecution,
) {
  if (execution.authority.tool !== "ffmpeg" || execution.collector.authority !== execution.authority) {
    throw processFailure(
      "CUT_MEDIA_PROCESS_CONTRACT",
      "ffmpeg",
      "picture encoder native process execution authority is inconsistent.",
      { kind: "contract", reason: "native-process-authority" },
    );
  }
  const args = ["-y", "-v", "error", "-f", referenceSceneEncodingContract.inputFormat, "-pixel_format", referenceSceneEncodingContract.inputPixelFormat, "-video_size", `${width}x${height}`, "-framerate", fps, "-i", "pipe:0", "-an", "-c:v", referenceSceneEncodingContract.encoder, "-bf", String(referenceSceneEncodingContract.bFrames), "-preset", referenceSceneEncodingContract.preset, "-crf", String(referenceSceneEncodingContract.crf), ...referenceH264ColorEncoderArgs(color), "-movflags", referenceSceneEncodingContract.movFlags, output];
  const child = await spawnBoundReferenceNativeProcess(execution.collector, execution.context, args, {
    shell: false,
    detached: false,
    stdio: ["pipe", "ignore", "pipe"],
  }) as EncoderChild;
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-16_000); });
  child.on("error", () => undefined);
  child.on("exit", (code) => { if (code && stderr) process.stderr.write(stderr); });
  return child;
}
