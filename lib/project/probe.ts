import { createHash } from "node:crypto";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { open, stat } from "node:fs/promises";
import { posix, relative } from "node:path";
import { platform } from "node:os";
import sharp from "sharp";
import {
  decodedAudioSamplesDuration,
  maximumDecodedAudioFrameRecords,
  maximumDecodedAudioSamples,
  type CutDecodedAudioSamples,
} from "../language/audio-sample-witness";
import {
  cutAudioProxyAlignmentContract,
  cutAudioProxyAlignmentIntegrity,
  type CutAudioProxyAlignment,
} from "../language/audio-proxy-alignment";
import {
  cutVideoProxyAlignmentContract,
  cutVideoProxyAlignmentIntegrity,
  type CutVideoProxyAlignment,
} from "../language/video-proxy-alignment";
import { compareRational, decimalRational, divideRational, multiplyRational, rational, subtractRational, type Rational } from "../language/rational";
import { decodedVideoCadenceDuration, maximumDecodedVideoCadenceFrames, valuePhaseQuantizedVideoCadenceOffset, type CutDecodedVideoCadence } from "../language/video-cadence";
import { CutProjectError, resolveProjectFile, validateProjectLocator } from "./manifest";
import {
  spawnBoundReferenceNativeProcess,
  type BoundReferenceNativeMediaTool,
  type ReferenceNativeProcessCollector,
  type ReferenceNativeProcessContext,
} from "./native-process-authority";

export type CutLockedFileIdentity = {
  locator: string;
  basename: string;
  bytes: number;
  sha256: string;
};

export type CutMediaProbe = {
  format: "cut-media-probe";
  version: 1;
  implementation: {
    name: "ffprobe";
    version: string;
    compiler?: string;
    configurationSha256?: string;
  };
  file: CutLockedFileIdentity;
  container: { names: string[]; duration?: Rational; start?: Rational; bitRate?: number };
  streams: Array<{
    index: number;
    type: "video" | "audio" | "subtitle" | "data" | "attachment" | "unknown";
    codec: string;
    profile?: string;
    timeBase?: Rational;
    start?: Rational;
    duration?: Rational;
    frameRate?: Rational;
    /** ffprobe avg_frame_rate retained separately from nominal r_frame_rate. */
    averageFrameRate?: Rational;
    width?: number;
    height?: number;
    pixelFormat?: string;
    /** Raw bounded ffprobe scan-order token (for example progressive). */
    fieldOrder?: string;
    /** Raw bounded ffprobe stream tags; interpretation is a separate strict CUT contract. */
    colorRange?: string;
    colorSpace?: string;
    colorTransfer?: string;
    colorPrimaries?: string;
    sampleRate?: number;
    channels?: number;
    channelLayout?: string;
    language?: string;
    disposition: string[];
  }>;
  chapters: Array<{ id: number; start: Rational; end: Rational; title?: string }>;
};

export type CutByteProbe = {
  format: "cut-byte-probe";
  version: 1;
  file: CutLockedFileIdentity;
};

export type CutImageProbe = {
  format: "cut-image-probe";
  version: 1;
  implementation: {
    name: "sharp";
    version: string;
    libvips: string;
  };
  file: CutLockedFileIdentity;
  image: {
    width: number;
    height: number;
    format: string;
    space: string;
    channels: number;
    hasAlpha: boolean;
    depth?: string;
    density?: number;
    orientation?: number;
  };
};

export type ProbeBudget = { maxFileBytes?: number; maxOutputBytes?: number; timeoutMs?: number };
export type ProbeNativeExecutables = Readonly<{
  ffmpeg?: string;
  ffprobe?: string;
}>;
export type ProbeNativeProcessExecution = Readonly<{
  authority: BoundReferenceNativeMediaTool;
  collector: ReferenceNativeProcessCollector;
  context: ReferenceNativeProcessContext;
  signal?: AbortSignal;
  terminateProcessTree?: boolean;
}>;
export type ProbeDecodedAudioNativeProcessExecutions = Readonly<{
  pcm: ProbeNativeProcessExecution;
  frames: ProbeNativeProcessExecution;
}>;
export type ProbeProxyAlignmentNativeProcessExecutions = Readonly<{
  master: ProbeNativeProcessExecution;
  proxy: ProbeNativeProcessExecution;
}>;
export type ImageProbeBudget = ProbeBudget & { maxPixels?: number; maxDimension?: number };

type StableStat = {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  isFile(): boolean;
};

type SourceSnapshot = Pick<StableStat, "dev" | "ino" | "size" | "mtimeNs" | "ctimeNs">;

const DEFAULT_BUDGET = {
  maxFileBytes: 100 * 1024 * 1024 * 1024,
  maxOutputBytes: 2 * 1024 * 1024,
  timeoutMs: 30_000,
};

const HARD_BUDGET = {
  maxFileBytes: DEFAULT_BUDGET.maxFileBytes,
  maxOutputBytes: 16 * 1024 * 1024,
  timeoutMs: 5 * 60_000,
};

const probeTerminationGraceMs = 250;

type ProbeNativeProcessControl = Readonly<{
  child: ChildProcess;
  terminate: () => void;
}>;

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

async function spawnProbeNativeProcess(
  tool: "ffmpeg" | "ffprobe",
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
  execution?: ProbeNativeProcessExecution,
): Promise<ProbeNativeProcessControl> {
  if (execution?.signal?.aborted) throw new CutProjectError("CUTP2008", `${tool} native process launch was cancelled.`);
  const detached = execution?.terminateProcessTree === true && platform() !== "win32";
  const controlledOptions = detached ? { ...options, detached: true } : options;
  let child: ChildProcess;
  if (execution === undefined) child = spawn(executable, args, controlledOptions);
  else {
    if (execution.authority.tool !== tool || execution.collector.authority !== execution.authority) {
      throw new CutProjectError("CUTP2008", `${tool} native process authority is inconsistent.`);
    }
    child = await spawnBoundReferenceNativeProcess(execution.collector, execution.context, args, controlledOptions);
  }
  let terminating = false;
  const signalTree = (value: NodeJS.Signals) => {
    if (detached && child.pid !== undefined) {
      try { process.kill(-child.pid, value); return; }
      catch { /* direct-child fallback still closes the bound process */ }
    }
    if (child.exitCode === null && child.signalCode === null) child.kill(value);
  };
  const terminate = () => {
    if (terminating) return;
    terminating = true;
    signalTree("SIGTERM");
    setTimeout(() => {
      signalTree("SIGKILL");
      setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.stdin?.destroy();
      }, probeTerminationGraceMs);
    }, probeTerminationGraceMs);
  };
  const signal = execution?.signal;
  if (signal) {
    child.once("close", () => signal.removeEventListener("abort", terminate));
    signal.addEventListener("abort", terminate, { once: true });
    if (signal.aborted) terminate();
  }
  return Object.freeze({ child, terminate });
}

function probeBudget(options: ProbeBudget): Required<ProbeBudget> {
  const result = { ...DEFAULT_BUDGET, ...options };
  for (const key of Object.keys(result) as Array<keyof Required<ProbeBudget>>) {
    const value = result[key];
    if (!Number.isSafeInteger(value) || value <= 0 || value > HARD_BUDGET[key]) {
      throw new CutProjectError(
        "CUTP2007",
        `${key} must be a positive safe integer no greater than ${HARD_BUDGET[key]}.`,
      );
    }
  }
  return result;
}

function exact(value: unknown): Rational | undefined {
  if (typeof value !== "string" || !value || value === "N/A" || value.length > 512) return undefined;
  if (/^[+-]?\d+\/[+-]?\d+$/.test(value)) {
    const [top, bottom] = value.split("/");
    if (top.replace(/^[+-]/, "").length > 256 || bottom.replace(/^[+-]/, "").length > 256) return undefined;
    if (BigInt(bottom) === 0n) return undefined;
    return rational(top, bottom);
  }
  if (/^[+-]?\d+(?:\.\d+)?$/.test(value) && value.replace(/^[+-]/, "").replace(".", "").length <= 256) return decimalRational(value);
  return undefined;
}

function integer(value: unknown, minimum = 0) {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.length <= 16 && /^\d+$/.test(value) ? Number(value) : undefined;
  return Number.isSafeInteger(parsed) && Number(parsed) >= minimum ? Number(parsed) : undefined;
}

function exactIntegerText(value: unknown) {
  if (typeof value === "number") return Number.isSafeInteger(value) ? String(value) : undefined;
  return typeof value === "string" && /^-?(?:0|[1-9]\d*)$/u.test(value) && value.length <= 256 ? value : undefined;
}

function startFromTicks(value: Record<string, unknown>) {
  const timeBase = exact(value.time_base), ticks = exactIntegerText(value.start_pts);
  if (timeBase && ticks) return multiplyRational(rational(ticks), timeBase);
  const fallback = exact(value.start_time);
  // Decimal ffprobe timestamps are acceptable only when they map back to one
  // exact codec tick. Otherwise CUT must not round a semantic PTS boundary.
  return fallback && timeBase && multiplyRational(fallback, rational(timeBase.denominator, timeBase.numerator)).denominator === "1"
    ? fallback
    : undefined;
}

function durationFromTicks(value: Record<string, unknown>) {
  const ticks = exactIntegerText(value.duration_ts);
  const timeBase = exact(value.time_base);
  if (ticks && timeBase) return multiplyRational(rational(ticks), timeBase);
  const reported = exact(value.duration);
  // ffprobe formats a stream duration as decimal text when duration_ts is
  // unavailable. Treat that text as exact only when it round-trips to one
  // integer codec tick; accepting an off-grid rounded decimal would let probe
  // presentation precision invent an executable source boundary.
  if (reported && timeBase && divideRational(reported, timeBase).denominator === "1") return reported;
  // Container/stream tags named DURATION are deliberately non-authoritative.
  // Depending on muxer and packet-duration availability, Matroska has emitted
  // either an end timestamp or the final frame PTS under that name. Neither
  // can safely define a selected stream's executable duration.
  return undefined;
}

function sortedStrings(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).filter(([, enabled]) => enabled === 1 || enabled === true).map(([name]) => name).sort();
}

function tag(value: unknown, key: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entry = Object.entries(value as Record<string, unknown>).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
  return typeof entry === "string" && entry ? entry : undefined;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function boundedString(value: unknown, maximum: number) {
  return typeof value === "string" && value.length > 0 && value.length <= maximum ? value : undefined;
}

function boundedProbeString(value: unknown, maximum: number, label: string, path: string) {
  if (value === undefined || value === null || value === "") return undefined;
  const result = boundedString(value, maximum);
  if (!result) throw new CutProjectError("CUTP2012", `${label} exceeds its ${maximum}-character probe bound or is not a string.`, path);
  return result;
}

function sourceSnapshot(value: StableStat): SourceSnapshot {
  return {
    dev: value.dev,
    ino: value.ino,
    size: value.size,
    mtimeNs: value.mtimeNs,
    ctimeNs: value.ctimeNs,
  };
}

function sameSnapshot(left: SourceSnapshot, right: SourceSnapshot) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function assertStableSource(expected: SourceSnapshot, observations: SourceSnapshot[], path: string) {
  if (observations.some((value) => !sameSnapshot(expected, value))) {
    throw new CutProjectError(
      "CUTP2009",
      "Media changed or was replaced while it was being probed; no probe was produced.",
      path,
    );
  }
}

async function assertStableLocator(projectRoot: string, locator: string, expectedPath: string) {
  let current: string;
  try {
    current = await resolveProjectFile(projectRoot, locator);
  } catch {
    throw new CutProjectError(
      "CUTP2009",
      "Media changed, disappeared, or was replaced while it was being probed; no probe was produced.",
      expectedPath,
    );
  }
  if (current !== expectedPath) {
    throw new CutProjectError(
      "CUTP2009",
      "Media locator resolved to a different file while it was being probed; no probe was produced.",
      expectedPath,
    );
  }
}

async function sha256(handle: Awaited<ReturnType<typeof open>>, expectedBytes: number, signal?: AbortSignal) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (position < expectedBytes) {
    if (signal?.aborted) throw new CutProjectError("CUTP2009", "Media hashing was cancelled.");
    const length = Math.min(buffer.length, expectedBytes - position);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (bytesRead === 0) {
      throw new CutProjectError("CUTP2009", "Media was truncated while it was being hashed.");
    }
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  if (signal?.aborted) throw new CutProjectError("CUTP2009", "Media hashing was cancelled.");
  const trailing = Buffer.allocUnsafe(1);
  if ((await handle.read(trailing, 0, 1, expectedBytes)).bytesRead !== 0) {
    throw new CutProjectError("CUTP2009", "Media grew while it was being hashed.");
  }
  return hash.digest("hex");
}

async function ffprobe(
  path: string,
  sourceFd: number,
  budget: Required<ProbeBudget>,
  executable = "ffprobe",
  execution?: ProbeNativeProcessExecution,
) {
  const inheritedDescriptor = platform() !== "win32";
  const input = inheritedDescriptor ? "/dev/fd/3" : path;
  const args = ["-v", "error", "-print_format", "json", "-show_program_version", "-show_format", "-show_streams", "-show_chapters", input];
  let child: ChildProcess, terminate: () => void;
  try {
    ({ child, terminate } = await spawnProbeNativeProcess(
      "ffprobe",
      executable,
      args,
      {
        shell: false,
        windowsHide: true,
        stdio: inheritedDescriptor ? ["ignore", "pipe", "pipe", sourceFd] : ["ignore", "pipe", "pipe"],
      },
      execution,
    ));
  } catch (error) {
    throw errorCode(error) === "ENOENT"
      ? new CutProjectError("CUTP2008", "ffprobe executable was not found on PATH.")
      : new CutProjectError("CUTP2008", `Cannot start ffprobe: ${error instanceof Error ? error.message : String(error)}`);
  }
  return new Promise<Record<string, unknown>>((accept, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let terminalError: Error | undefined;

    const finish = (error?: Error, value?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else accept(value!);
    };
    const abort = (error: Error) => {
      if (!terminalError) terminalError = error;
      terminate();
    };
    const timer = setTimeout(
      () => abort(new CutProjectError("CUTP2001", `ffprobe timed out after ${budget.timeoutMs}ms.`)),
      budget.timeoutMs,
    );

    if (!child.stdout || !child.stderr) {
      abort(new CutProjectError("CUTP2008", "ffprobe did not expose bounded output pipes."));
    } else {
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > budget.maxOutputBytes) {
          abort(new CutProjectError("CUTP2002", `ffprobe output exceeded ${budget.maxOutputBytes} bytes.`));
        } else {
          stdout.push(Buffer.from(chunk));
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const remaining = 32_000 - stderrBytes;
        if (remaining > 0) stderr.push(Buffer.from(chunk.subarray(0, remaining)));
        stderrBytes += chunk.length;
      });
    }

    child.on("error", (error) => {
      const wrapped = errorCode(error) === "ENOENT"
        ? new CutProjectError("CUTP2008", "ffprobe executable was not found on PATH.")
        : new CutProjectError("CUTP2008", `Cannot start ffprobe: ${error.message}`);
      finish(wrapped);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      if (terminalError) return finish(terminalError);
      if (code !== 0) {
        return finish(new CutProjectError(
          "CUTP2003",
          `ffprobe exited with ${code ?? signal ?? "unknown status"}: ${Buffer.concat(stderr).toString("utf8").trim()}`,
        ));
      }
      try {
        const parsed = JSON.parse(Buffer.concat(stdout).toString("utf8"));
        finish(undefined, parsed);
      } catch (error) {
        finish(new CutProjectError("CUTP2004", `ffprobe returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  });
}

const maximumDecodedCadenceLineBytes = 4_096;

async function ffmpegDecodedAudioPcmIdentity(
  path: string,
  sourceFd: number,
  stream: { index: number; channels: number },
  budget: Required<ProbeBudget>,
  executable = "ffmpeg",
  execution?: ProbeNativeProcessExecution,
) {
  const inheritedDescriptor = platform() !== "win32";
  const input = inheritedDescriptor ? "/dev/fd/3" : path;
  const args = [
    "-nostdin", "-v", "error", "-i", input,
    "-map", `0:${stream.index}`, "-vn", "-sn", "-dn",
    "-f", "s16le", "-acodec", "pcm_s16le", "pipe:1",
  ];
  let child: ChildProcess, terminate: () => void;
  try {
    ({ child, terminate } = await spawnProbeNativeProcess(
      "ffmpeg",
      executable,
      args,
      {
        shell: false,
        windowsHide: true,
        stdio: inheritedDescriptor ? ["ignore", "pipe", "pipe", sourceFd] : ["ignore", "pipe", "pipe"],
      },
      execution,
    ));
  } catch (error) {
    throw errorCode(error) === "ENOENT"
      ? new CutProjectError("CUTP2008", "ffmpeg executable was not found on PATH.", path)
      : new CutProjectError("CUTP2008", `Cannot start ffmpeg decoded-audio PCM scan: ${error instanceof Error ? error.message : String(error)}`, path);
  }
  return new Promise<{ sampleCount: string; sha256: string }>((accept, reject) => {
    const digest = createHash("sha256"), bytesPerSampleFrame = BigInt(stream.channels * 2);
    const maximumBytes = maximumDecodedAudioSamples * bytesPerSampleFrame;
    let outputBytes = 0n, stderrBytes = 0, settled = false;
    const stderr: Buffer[] = [];
    let terminalError: Error | undefined;
    const finish = (error?: Error, value?: { sampleCount: string; sha256: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else accept(value!);
    };
    const abort = (error: Error) => {
      if (!terminalError) terminalError = error;
      terminate();
    };
    const timer = setTimeout(() => abort(new CutProjectError("CUTP2001", `ffmpeg decoded-audio PCM scan timed out after ${budget.timeoutMs}ms.`, path)), budget.timeoutMs);
    if (!child.stdout || !child.stderr) abort(new CutProjectError("CUTP2008", "ffmpeg decoded-audio PCM scan did not expose bounded output pipes.", path));
    else {
      child.stdout.on("data", (chunk: Buffer) => {
        outputBytes += BigInt(chunk.byteLength);
        if (outputBytes > maximumBytes) return abort(new CutProjectError("CUTP2017", `Decoded audio exceeds the ${maximumDecodedAudioSamples}-sample PCM verification bound.`, path));
        digest.update(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const remaining = 32_000 - stderrBytes;
        if (remaining > 0) stderr.push(Buffer.from(chunk.subarray(0, remaining)));
        stderrBytes += chunk.length;
      });
    }
    child.on("error", (error) => finish(errorCode(error) === "ENOENT"
      ? new CutProjectError("CUTP2008", "ffmpeg executable was not found on PATH.", path)
      : new CutProjectError("CUTP2008", `Cannot start ffmpeg decoded-audio PCM scan: ${error.message}`, path)));
    child.on("close", (code, signal) => {
      if (settled) return;
      if (terminalError) return finish(terminalError);
      if (code !== 0) return finish(new CutProjectError("CUTP2003", `ffmpeg decoded-audio PCM scan exited with ${code ?? signal ?? "unknown status"}: ${Buffer.concat(stderr).toString("utf8").trim()}`, path));
      if (outputBytes < 1n || outputBytes % bytesPerSampleFrame !== 0n) {
        return finish(new CutProjectError("CUTP2017", `Audio stream ${stream.index} produced no whole interleaved s16le sample frames.`, path));
      }
      finish(undefined, { sampleCount: String(outputBytes / bytesPerSampleFrame), sha256: digest.digest("hex") });
    });
  });
}

type AudioProxyAlignmentBudget = Readonly<{ maxOutputBytes: number; timeoutMs: number }>;

function audioProxyAlignmentBudget(options: ProbeBudget): AudioProxyAlignmentBudget {
  const maxOutputBytes = options.maxOutputBytes ?? cutAudioProxyAlignmentContract.maximumAnalysisBytesPerVariant;
  const timeoutMs = options.timeoutMs ?? HARD_BUDGET.timeoutMs;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1
    || maxOutputBytes > cutAudioProxyAlignmentContract.maximumAnalysisBytesPerVariant) {
    throw new CutProjectError(
      "CUTP2007",
      `maxOutputBytes must be a positive safe integer no greater than ${cutAudioProxyAlignmentContract.maximumAnalysisBytesPerVariant} for audio-proxy alignment.`,
    );
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > HARD_BUDGET.timeoutMs) {
    throw new CutProjectError("CUTP2007", `timeoutMs must be a positive safe integer no greater than ${HARD_BUDGET.timeoutMs}.`);
  }
  return Object.freeze({ maxOutputBytes, timeoutMs });
}

async function ffmpegAudioProxyAnalysisPcm(
  path: string,
  sourceFd: number,
  stream: { index: number; channels: number },
  decodedSampleCount: string,
  budget: AudioProxyAlignmentBudget,
  executable = "ffmpeg",
  execution?: ProbeNativeProcessExecution,
) {
  const inheritedDescriptor = platform() !== "win32";
  const input = inheritedDescriptor ? "/dev/fd/3" : path;
  const analysis = cutAudioProxyAlignmentContract;
  const filter = `[0:${stream.index}]atrim=start_sample=0:end_sample=${decodedSampleCount},asetpts=N/SR/TB,aresample=${analysis.analysisSampleRate}:resampler=swr:filter_size=32:phase_shift=10:linear_interp=0:exact_rational=1,aformat=sample_fmts=s16[cut_audio_proxy_alignment]`;
  const args = [
    "-nostdin", "-v", "error", "-i", input,
    "-filter_complex", filter,
    "-map", "[cut_audio_proxy_alignment]", "-map_metadata", "-1",
    "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1",
  ];
  let child: ChildProcess, terminate: () => void;
  try {
    ({ child, terminate } = await spawnProbeNativeProcess(
      "ffmpeg",
      executable,
      args,
      {
        shell: false,
        windowsHide: true,
        stdio: inheritedDescriptor ? ["ignore", "pipe", "pipe", sourceFd] : ["ignore", "pipe", "pipe"],
      },
      execution,
    ));
  } catch (error) {
    throw errorCode(error) === "ENOENT"
      ? new CutProjectError("CUTP2008", "ffmpeg executable was not found on PATH.", path)
      : new CutProjectError("CUTP2008", `Cannot start ffmpeg audio-proxy alignment scan: ${error instanceof Error ? error.message : String(error)}`, path);
  }
  return new Promise<{ bytes: Buffer; sha256: string; frameCount: number }>((accept, reject) => {
    const digest = createHash("sha256"), chunks: Buffer[] = [], stderr: Buffer[] = [];
    let outputBytes = 0, stderrBytes = 0, settled = false;
    let terminalError: Error | undefined;
    const finish = (error?: Error, value?: { bytes: Buffer; sha256: string; frameCount: number }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else accept(value!);
    };
    const abort = (error: Error) => {
      if (!terminalError) terminalError = error;
      terminate();
    };
    const timer = setTimeout(
      () => abort(new CutProjectError("CUTP2001", `ffmpeg audio-proxy alignment scan timed out after ${budget.timeoutMs}ms.`, path)),
      budget.timeoutMs,
    );
    if (!child.stdout || !child.stderr) abort(new CutProjectError("CUTP2008", "ffmpeg audio-proxy alignment scan did not expose bounded output pipes.", path));
    else {
      child.stdout.on("data", (chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > budget.maxOutputBytes) {
          return abort(new CutProjectError("CUTP2018", `Audio-proxy alignment PCM exceeded the ${budget.maxOutputBytes}-byte analysis bound.`, path));
        }
        digest.update(chunk);
        chunks.push(Buffer.from(chunk));
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const remaining = 32_000 - stderrBytes;
        if (remaining > 0) stderr.push(Buffer.from(chunk.subarray(0, remaining)));
        stderrBytes += chunk.length;
      });
    }
    child.on("error", (error) => finish(errorCode(error) === "ENOENT"
      ? new CutProjectError("CUTP2008", "ffmpeg executable was not found on PATH.", path)
      : new CutProjectError("CUTP2008", `Cannot start ffmpeg audio-proxy alignment scan: ${error.message}`, path)));
    child.on("close", (code, signal) => {
      if (settled) return;
      if (terminalError) return finish(terminalError);
      if (code !== 0) return finish(new CutProjectError("CUTP2003", `ffmpeg audio-proxy alignment scan exited with ${code ?? signal ?? "unknown status"}: ${Buffer.concat(stderr).toString("utf8").trim()}`, path));
      const bytesPerFrame = stream.channels * 2;
      if (outputBytes < bytesPerFrame || outputBytes % bytesPerFrame !== 0) {
        return finish(new CutProjectError("CUTP2018", `Audio stream ${stream.index} produced no whole interleaved analysis sample frames.`, path));
      }
      finish(undefined, { bytes: Buffer.concat(chunks, outputBytes), sha256: digest.digest("hex"), frameCount: outputBytes / bytesPerFrame });
    });
  });
}

function correlationPpm(dot: bigint, leftEnergy: bigint, rightEnergy: bigint) {
  if (dot <= 0n || leftEnergy <= 0n || rightEnergy <= 0n) return 0;
  const numerator = dot * dot * 1_000_000_000_000n, denominator = leftEnergy * rightEnergy;
  let low = 0n, high = 1_000_000n;
  while (low < high) {
    const middle = (low + high + 1n) >> 1n;
    if (middle * middle * denominator <= numerator) low = middle;
    else high = middle - 1n;
  }
  return Number(low);
}

const oneMillion = 1_000_000n;

function ceilingRatioPpm(numerator: bigint, denominator: bigint) {
  if (numerator <= 0n) return 0;
  if (denominator <= 0n) return 1_000_000;
  return Number((numerator * oneMillion + denominator - 1n) / denominator);
}

function nearestRatioPpm(numerator: bigint, denominator: bigint) {
  if (numerator <= 0n) return 0;
  if (denominator <= 0n) return 0;
  return Number((numerator * oneMillion + denominator / 2n) / denominator);
}

/** Minimum least-squares residual after one positive gain fit, as power ppm. */
function gainNormalizedResidualPowerPpm(dot: bigint, masterEnergy: bigint, proxyEnergy: bigint) {
  if (dot <= 0n || masterEnergy <= 0n || proxyEnergy <= 0n) return 1_000_000;
  const total = masterEnergy * proxyEnergy;
  const explained = dot * dot;
  return ceilingRatioPpm(explained >= total ? 0n : total - explained, total);
}

function completeOverlappingWindowStarts(frameCount: number, windowFrames: number, hopFrames: number) {
  if (frameCount <= windowFrames) return [0];
  const starts: number[] = [];
  for (let start = 0; start + windowFrames <= frameCount; start += hopFrames) starts.push(start);
  const tail = frameCount - windowFrames;
  if (starts.at(-1) !== tail) starts.push(tail);
  return starts;
}

function audioProxyAlignmentMetrics(master: Buffer, proxy: Buffer, channels: number) {
  const contract = cutAudioProxyAlignmentContract, bytesPerFrame = channels * 2;
  if (master.byteLength !== proxy.byteLength || master.byteLength % bytesPerFrame !== 0) {
    throw new CutProjectError("CUTP2018", "Master and proxy audio alignment decodes produced different sample geometry.");
  }
  const frameCount = master.byteLength / bytesPerFrame;
  const globalDots = Array.from({ length: channels }, () => 0n);
  const globalMasterEnergy = Array.from({ length: channels }, () => 0n);
  const globalProxyEnergy = Array.from({ length: channels }, () => 0n);
  const channelMaximumGainNormalizedResidualPowerPpm = Array.from({ length: channels }, () => 0);
  let total = 0n, silent = 0n, evaluated = 0n, passed = 0n, failed = 0n, silenceMismatch = 0n, energyMismatch = 0n;
  let minimumWindowCorrelationPpm = 1_000_000;
  for (let start = 0; start < frameCount; start += contract.analysisWindowFrames) {
    const end = Math.min(frameCount, start + contract.analysisWindowFrames), frames = end - start;
    const silentEnergy = frames * contract.silenceRmsS16 ** 2, activeEnergy = frames * contract.activeRmsS16 ** 2;
    for (let channel = 0; channel < channels; channel += 1) {
      let dot = 0, masterEnergy = 0, proxyEnergy = 0;
      for (let frame = start; frame < end; frame += 1) {
        const offset = (frame * channels + channel) * 2;
        const left = master.readInt16LE(offset), right = proxy.readInt16LE(offset);
        dot += left * right; masterEnergy += left * left; proxyEnergy += right * right;
      }
      const exactDot = BigInt(dot), exactMasterEnergy = BigInt(masterEnergy), exactProxyEnergy = BigInt(proxyEnergy);
      globalDots[channel] += exactDot; globalMasterEnergy[channel] += exactMasterEnergy; globalProxyEnergy[channel] += exactProxyEnergy;
      total += 1n;
      if (masterEnergy <= silentEnergy && proxyEnergy <= silentEnergy) { silent += 1n; continue; }
      evaluated += 1n;
      const mismatchedSilence = masterEnergy <= silentEnergy && proxyEnergy >= activeEnergy
        || proxyEnergy <= silentEnergy && masterEnergy >= activeEnergy;
      const smallerEnergy = Math.min(masterEnergy, proxyEnergy), largerEnergy = Math.max(masterEnergy, proxyEnergy);
      const mismatchedEnergy = smallerEnergy === 0 || largerEnergy > smallerEnergy * contract.maximumEnergyPowerRatio;
      const correlation = correlationPpm(exactDot, exactMasterEnergy, exactProxyEnergy);
      const residualPowerPpm = gainNormalizedResidualPowerPpm(exactDot, exactMasterEnergy, exactProxyEnergy);
      minimumWindowCorrelationPpm = Math.min(minimumWindowCorrelationPpm, correlation);
      channelMaximumGainNormalizedResidualPowerPpm[channel] = Math.max(channelMaximumGainNormalizedResidualPowerPpm[channel], residualPowerPpm);
      if (mismatchedSilence) silenceMismatch += 1n;
      if (mismatchedEnergy) energyMismatch += 1n;
      if (!mismatchedSilence && !mismatchedEnergy
        && correlation >= contract.minimumWindowCorrelationPpm
        && residualPowerPpm <= contract.maximumGainNormalizedResidualPowerPpm) passed += 1n;
      else failed += 1n;
    }
  }
  const channelGlobalCorrelationPpm = globalDots.map((dot, channel) => {
    const silentLimit = BigInt(frameCount) * BigInt(contract.silenceRmsS16 ** 2);
    if (globalMasterEnergy[channel] <= silentLimit && globalProxyEnergy[channel] <= silentLimit) return 1_000_000;
    return correlationPpm(dot, globalMasterEnergy[channel], globalProxyEnergy[channel]);
  });
  const envelopeStarts = completeOverlappingWindowStarts(frameCount, contract.envelopeWindowFrames, contract.envelopeHopFrames);
  const channelMinimumEnvelopeEnergyRatioPpm = Array.from({ length: channels }, () => Number.MAX_SAFE_INTEGER);
  const channelMaximumEnvelopeEnergyRatioPpm = Array.from({ length: channels }, () => 0);
  const channelEvaluatedEnvelopeWindows = Array.from({ length: channels }, () => 0);
  let totalEnvelope = 0n, silentEnvelope = 0n, evaluatedEnvelope = 0n, passedEnvelope = 0n, failedEnvelope = 0n;
  for (const start of envelopeStarts) {
    const end = Math.min(frameCount, start + contract.envelopeWindowFrames), frames = end - start;
    const silentEnergy = BigInt(frames * contract.silenceRmsS16 ** 2);
    for (let channel = 0; channel < channels; channel += 1) {
      let masterEnergy = 0, proxyEnergy = 0;
      for (let frame = start; frame < end; frame += 1) {
        const offset = (frame * channels + channel) * 2;
        const left = master.readInt16LE(offset), right = proxy.readInt16LE(offset);
        masterEnergy += left * left; proxyEnergy += right * right;
      }
      const exactMasterEnergy = BigInt(masterEnergy), exactProxyEnergy = BigInt(proxyEnergy);
      totalEnvelope += 1n;
      if (exactMasterEnergy <= silentEnergy && exactProxyEnergy <= silentEnergy) { silentEnvelope += 1n; continue; }
      evaluatedEnvelope += 1n;
      channelEvaluatedEnvelopeWindows[channel] += 1;
      const dot = globalDots[channel], fittedProxyDenominator = globalProxyEnergy[channel] * globalProxyEnergy[channel] * exactMasterEnergy;
      const fittedProxyNumerator = dot > 0n ? dot * dot * exactProxyEnergy : 0n;
      const ratioPpm = nearestRatioPpm(fittedProxyNumerator, fittedProxyDenominator);
      channelMinimumEnvelopeEnergyRatioPpm[channel] = Math.min(channelMinimumEnvelopeEnergyRatioPpm[channel], ratioPpm);
      channelMaximumEnvelopeEnergyRatioPpm[channel] = Math.max(channelMaximumEnvelopeEnergyRatioPpm[channel], ratioPpm);
      if (ratioPpm >= contract.minimumEnvelopeEnergyRatioPpm && ratioPpm <= contract.maximumEnvelopeEnergyRatioPpm) passedEnvelope += 1n;
      else failedEnvelope += 1n;
    }
  }
  for (let channel = 0; channel < channels; channel += 1) {
    if (channelEvaluatedEnvelopeWindows[channel] === 0) {
      channelMinimumEnvelopeEnergyRatioPpm[channel] = 1_000_000;
      channelMaximumEnvelopeEnergyRatioPpm[channel] = 1_000_000;
    }
  }
  return Object.freeze({
    frameCount,
    channelGlobalCorrelationPpm: Object.freeze(channelGlobalCorrelationPpm),
    minimumGlobalCorrelationPpm: Math.min(...channelGlobalCorrelationPpm),
    minimumWindowCorrelationPpm,
    channelMaximumGainNormalizedResidualPowerPpm: Object.freeze(channelMaximumGainNormalizedResidualPowerPpm),
    maximumGainNormalizedResidualPowerPpm: Math.max(...channelMaximumGainNormalizedResidualPowerPpm),
    totalChannelWindows: String(total),
    silentChannelWindows: String(silent),
    evaluatedChannelWindows: String(evaluated),
    passedChannelWindows: String(passed),
    failedChannelWindows: String(failed),
    silenceMismatchChannelWindows: String(silenceMismatch),
    energyMismatchChannelWindows: String(energyMismatch),
    channelMinimumEnvelopeEnergyRatioPpm: Object.freeze(channelMinimumEnvelopeEnergyRatioPpm),
    channelMaximumEnvelopeEnergyRatioPpm: Object.freeze(channelMaximumEnvelopeEnergyRatioPpm),
    minimumEnvelopeEnergyRatioPpm: Math.min(...channelMinimumEnvelopeEnergyRatioPpm),
    maximumEnvelopeEnergyRatioPpm: Math.max(...channelMaximumEnvelopeEnergyRatioPpm),
    totalEnvelopeChannelWindows: String(totalEnvelope),
    silentEnvelopeChannelWindows: String(silentEnvelope),
    evaluatedEnvelopeChannelWindows: String(evaluatedEnvelope),
    passedEnvelopeChannelWindows: String(passedEnvelope),
    failedEnvelopeChannelWindows: String(failedEnvelope),
  });
}

async function scanAudioProxyAlignmentVariant(
  projectRoot: string,
  locator: string,
  identity: CutMediaProbe,
  witness: CutDecodedAudioSamples,
  budget: AudioProxyAlignmentBudget,
  ffmpegExecutable?: string,
  execution?: ProbeNativeProcessExecution,
) {
  const safeLocator = validateProjectLocator(locator, "media locator"), path = await resolveProjectFile(projectRoot, safeLocator);
  if (identity.file.locator !== safeLocator || identity.file.bytes < 0 || !/^[a-f0-9]{64}$/u.test(identity.file.sha256)) {
    throw new CutProjectError("CUTP2018", "Audio-proxy alignment requires the exact canonical raw media probe for each locator.", path);
  }
  const stream = identity.streams.find((candidate) => candidate.index === witness.streamIndex && candidate.type === "audio");
  if (!stream?.timeBase || !stream.sampleRate || !stream.channels) throw new CutProjectError("CUTP2018", "Audio-proxy alignment requires one exact selected audio stream.", path);
  decodedAudioSamplesDuration(witness, stream);
  const selectedStream = {
    index: stream.index,
    timeBase: stream.timeBase,
    sampleRate: stream.sampleRate,
    channels: stream.channels,
    ...(stream.channelLayout ? { channelLayout: stream.channelLayout } : {}),
  };
  let hashHandle: Awaited<ReturnType<typeof open>> | undefined, scanHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    hashHandle = await open(path, "r"); scanHandle = await open(path, "r");
    const [hashInitial, scanInitial, pathInitial] = await Promise.all([hashHandle.stat({ bigint: true }), scanHandle.stat({ bigint: true }), stat(path, { bigint: true })]);
    if (!hashInitial.isFile() || !scanInitial.isFile() || !pathInitial.isFile()) throw new CutProjectError("CUTP2005", "Media locator must resolve to a regular file.", path);
    const initial = sourceSnapshot(hashInitial);
    assertStableSource(initial, [sourceSnapshot(scanInitial), sourceSnapshot(pathInitial)], path);
    if (initial.size !== BigInt(identity.file.bytes)) throw new CutProjectError("CUTP2009", "Media byte count changed before audio-proxy alignment scanning.", path);
    const results = await Promise.allSettled([
      ffmpegAudioProxyAnalysisPcm(
        path,
        scanHandle.fd,
        { index: selectedStream.index, channels: selectedStream.channels },
        witness.decodedSampleCount,
        budget,
        ffmpegExecutable,
        execution,
      ),
      sha256(hashHandle, identity.file.bytes, execution?.signal),
    ]);
    const [hashFinal, scanFinal, pathFinal] = await Promise.all([hashHandle.stat({ bigint: true }), scanHandle.stat({ bigint: true }), stat(path, { bigint: true })]);
    assertStableSource(initial, [sourceSnapshot(hashFinal), sourceSnapshot(scanFinal), sourceSnapshot(pathFinal)], path);
    await assertStableLocator(projectRoot, safeLocator, path);
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason;
    const digest = (results[1] as PromiseFulfilledResult<string>).value;
    if (digest !== identity.file.sha256) throw new CutProjectError("CUTP2009", "Media bytes changed during audio-proxy alignment scanning.", path);
    return { stream: selectedStream, pcm: (results[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof ffmpegAudioProxyAnalysisPcm>>>).value };
  } finally {
    await Promise.allSettled([hashHandle?.close(), scanHandle?.close()].filter(Boolean) as Promise<void>[]);
  }
}

/**
 * Prove that two independently locked audio variants preserve the same
 * channel/sample timeline without requiring lossy PCM bytes to be identical.
 */
export async function probeProjectAudioProxyAlignment(
  projectRoot: string,
  masterLocator: string,
  masterIdentity: CutMediaProbe,
  masterWitness: CutDecodedAudioSamples,
  proxyLocator: string,
  proxyIdentity: CutMediaProbe,
  proxyWitness: CutDecodedAudioSamples,
  options: ProbeBudget = {},
  nativeExecutables: ProbeNativeExecutables = {},
  executions?: ProbeProxyAlignmentNativeProcessExecutions,
): Promise<CutAudioProxyAlignment> {
  if (platform() === "win32") {
    throw new CutProjectError("CUTP2015", "Audio-proxy alignment witnesses are not supported on Windows because this runtime cannot pass already-open media descriptors to ffmpeg safely.");
  }
  const budget = audioProxyAlignmentBudget(options);
  const [master, proxy] = await Promise.all([
    scanAudioProxyAlignmentVariant(projectRoot, masterLocator, masterIdentity, masterWitness, budget, nativeExecutables.ffmpeg, executions?.master),
    scanAudioProxyAlignmentVariant(projectRoot, proxyLocator, proxyIdentity, proxyWitness, budget, nativeExecutables.ffmpeg, executions?.proxy),
  ]);
  if (master.stream.sampleRate !== proxy.stream.sampleRate || master.stream.channels !== proxy.stream.channels
    || (master.stream.channelLayout ?? "") !== (proxy.stream.channelLayout ?? "")
    || masterWitness.decodedSampleCount !== proxyWitness.decodedSampleCount) {
    throw new CutProjectError("CUTP2018", "Audio-proxy alignment requires equal decoded sample rate, channel mapping, and retained sample count.");
  }
  const metrics = audioProxyAlignmentMetrics(master.pcm.bytes, proxy.pcm.bytes, master.stream.channels);
  const contract = cutAudioProxyAlignmentContract;
  if (master.pcm.frameCount !== proxy.pcm.frameCount || metrics.minimumGlobalCorrelationPpm < contract.minimumGlobalCorrelationPpm
    || BigInt(metrics.failedChannelWindows) > BigInt(contract.maximumFailedChannelWindows)
    || metrics.maximumGainNormalizedResidualPowerPpm > contract.maximumGainNormalizedResidualPowerPpm
    || BigInt(metrics.failedEnvelopeChannelWindows) > BigInt(contract.maximumFailedEnvelopeChannelWindows)
    || metrics.silenceMismatchChannelWindows !== "0" || metrics.energyMismatchChannelWindows !== "0") {
    throw new CutProjectError(
      "CUTP2018",
      `Audio proxy is not timeline-equivalent to its master (global=${metrics.minimumGlobalCorrelationPpm}ppm, window=${metrics.minimumWindowCorrelationPpm}ppm, residual=${metrics.maximumGainNormalizedResidualPowerPpm}ppm, envelope=${metrics.minimumEnvelopeEnergyRatioPpm}..${metrics.maximumEnvelopeEnergyRatioPpm}ppm, failed=${metrics.failedChannelWindows}, envelopeFailed=${metrics.failedEnvelopeChannelWindows}, silenceMismatch=${metrics.silenceMismatchChannelWindows}, energyMismatch=${metrics.energyMismatchChannelWindows}).`,
    );
  }
  const base = Object.freeze({
    format: contract.format,
    version: contract.version,
    method: contract.method,
    analysis: Object.freeze({
      sampleRate: contract.analysisSampleRate,
      sampleFormat: "s16le-interleaved" as const,
      windowFrames: contract.analysisWindowFrames,
      envelopeWindowFrames: contract.envelopeWindowFrames,
      envelopeHopFrames: contract.envelopeHopFrames,
      channels: master.stream.channels,
      frameCount: String(metrics.frameCount),
      bytesPerVariant: String(master.pcm.bytes.byteLength),
      frequencyCoverage: "dc-through-8khz" as const,
    }),
    master: Object.freeze({ fileSha256: masterIdentity.file.sha256, streamIndex: master.stream.index, sourceSampleRate: master.stream.sampleRate, decodedSampleCount: masterWitness.decodedSampleCount, analysisPcmSha256: master.pcm.sha256 }),
    proxy: Object.freeze({ fileSha256: proxyIdentity.file.sha256, streamIndex: proxy.stream.index, sourceSampleRate: proxy.stream.sampleRate, decodedSampleCount: proxyWitness.decodedSampleCount, analysisPcmSha256: proxy.pcm.sha256 }),
    policy: Object.freeze({
      silenceRmsS16: contract.silenceRmsS16,
      activeRmsS16: contract.activeRmsS16,
      maximumEnergyPowerRatio: contract.maximumEnergyPowerRatio,
      minimumGlobalCorrelationPpm: contract.minimumGlobalCorrelationPpm,
      minimumWindowCorrelationPpm: contract.minimumWindowCorrelationPpm,
      maximumFailedChannelWindows: contract.maximumFailedChannelWindows,
      maximumGainNormalizedResidualPowerPpm: contract.maximumGainNormalizedResidualPowerPpm,
      minimumEnvelopeEnergyRatioPpm: contract.minimumEnvelopeEnergyRatioPpm,
      maximumEnvelopeEnergyRatioPpm: contract.maximumEnvelopeEnergyRatioPpm,
      maximumFailedEnvelopeChannelWindows: contract.maximumFailedEnvelopeChannelWindows,
    }),
    metrics: Object.freeze({
      channelGlobalCorrelationPpm: metrics.channelGlobalCorrelationPpm,
      minimumGlobalCorrelationPpm: metrics.minimumGlobalCorrelationPpm,
      minimumWindowCorrelationPpm: metrics.minimumWindowCorrelationPpm,
      channelMaximumGainNormalizedResidualPowerPpm: metrics.channelMaximumGainNormalizedResidualPowerPpm,
      maximumGainNormalizedResidualPowerPpm: metrics.maximumGainNormalizedResidualPowerPpm,
      totalChannelWindows: metrics.totalChannelWindows,
      silentChannelWindows: metrics.silentChannelWindows,
      evaluatedChannelWindows: metrics.evaluatedChannelWindows,
      passedChannelWindows: metrics.passedChannelWindows,
      failedChannelWindows: metrics.failedChannelWindows,
      silenceMismatchChannelWindows: metrics.silenceMismatchChannelWindows,
      energyMismatchChannelWindows: metrics.energyMismatchChannelWindows,
      channelMinimumEnvelopeEnergyRatioPpm: metrics.channelMinimumEnvelopeEnergyRatioPpm,
      channelMaximumEnvelopeEnergyRatioPpm: metrics.channelMaximumEnvelopeEnergyRatioPpm,
      minimumEnvelopeEnergyRatioPpm: metrics.minimumEnvelopeEnergyRatioPpm,
      maximumEnvelopeEnergyRatioPpm: metrics.maximumEnvelopeEnergyRatioPpm,
      totalEnvelopeChannelWindows: metrics.totalEnvelopeChannelWindows,
      silentEnvelopeChannelWindows: metrics.silentEnvelopeChannelWindows,
      evaluatedEnvelopeChannelWindows: metrics.evaluatedEnvelopeChannelWindows,
      passedEnvelopeChannelWindows: metrics.passedEnvelopeChannelWindows,
      failedEnvelopeChannelWindows: metrics.failedEnvelopeChannelWindows,
    }),
    decision: "equivalent" as const,
  });
  return Object.freeze({ ...base, integrity: cutAudioProxyAlignmentIntegrity(base) });
}

type VideoProxyAlignmentBudget = Readonly<{ maxOutputBytes: number; timeoutMs: number }>;

function videoProxyAlignmentBudget(options: ProbeBudget): VideoProxyAlignmentBudget {
  const maxOutputBytes = options.maxOutputBytes ?? cutVideoProxyAlignmentContract.maximumAnalysisBytesPerVariant;
  const timeoutMs = options.timeoutMs ?? HARD_BUDGET.timeoutMs;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1
    || maxOutputBytes > cutVideoProxyAlignmentContract.maximumAnalysisBytesPerVariant) {
    throw new CutProjectError(
      "CUTP2007",
      `maxOutputBytes must be a positive safe integer no greater than ${cutVideoProxyAlignmentContract.maximumAnalysisBytesPerVariant} for video-proxy alignment.`,
    );
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > HARD_BUDGET.timeoutMs) {
    throw new CutProjectError("CUTP2007", `timeoutMs must be a positive safe integer no greater than ${HARD_BUDGET.timeoutMs}.`);
  }
  return Object.freeze({ maxOutputBytes, timeoutMs });
}

async function ffmpegVideoProxyAnalysisRgb(
  path: string,
  sourceFd: number,
  streamIndex: number,
  decodedFrameCount: string,
  budget: VideoProxyAlignmentBudget,
  executable = "ffmpeg",
  execution?: ProbeNativeProcessExecution,
) {
  const inheritedDescriptor = platform() !== "win32";
  const input = inheritedDescriptor ? "/dev/fd/3" : path;
  const contract = cutVideoProxyAlignmentContract;
  const filter = `[0:${streamIndex}]trim=start_frame=0:end_frame=${decodedFrameCount},scale=${contract.analysisWidth}:${contract.analysisHeight}:force_original_aspect_ratio=decrease:flags=area,pad=${contract.analysisWidth}:${contract.analysisHeight}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=rgb24[cut_video_proxy_alignment]`;
  const args = [
    "-nostdin", "-v", "error", "-threads", "1", "-filter_threads", "1", "-i", input,
    "-filter_complex", filter,
    "-map", "[cut_video_proxy_alignment]", "-map_metadata", "-1",
    "-fps_mode", "passthrough", "-c:v", "rawvideo", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1",
  ];
  let child: ChildProcess, terminate: () => void;
  try {
    ({ child, terminate } = await spawnProbeNativeProcess(
      "ffmpeg",
      executable,
      args,
      {
        shell: false,
        windowsHide: true,
        stdio: inheritedDescriptor ? ["ignore", "pipe", "pipe", sourceFd] : ["ignore", "pipe", "pipe"],
      },
      execution,
    ));
  } catch (error) {
    throw errorCode(error) === "ENOENT"
      ? new CutProjectError("CUTP2008", "ffmpeg executable was not found on PATH.", path)
      : new CutProjectError("CUTP2008", `Cannot start ffmpeg video-proxy alignment scan: ${error instanceof Error ? error.message : String(error)}`, path);
  }
  return new Promise<{ bytes: Buffer; sha256: string; frameCount: number }>((accept, reject) => {
    const digest = createHash("sha256"), chunks: Buffer[] = [], stderr: Buffer[] = [];
    let outputBytes = 0, stderrBytes = 0, settled = false;
    let terminalError: Error | undefined;
    const finish = (error?: Error, value?: { bytes: Buffer; sha256: string; frameCount: number }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else accept(value!);
    };
    const abort = (error: Error) => {
      if (!terminalError) terminalError = error;
      terminate();
    };
    const timer = setTimeout(
      () => abort(new CutProjectError("CUTP2001", `ffmpeg video-proxy alignment scan timed out after ${budget.timeoutMs}ms.`, path)),
      budget.timeoutMs,
    );
    if (!child.stdout || !child.stderr) abort(new CutProjectError("CUTP2008", "ffmpeg video-proxy alignment scan did not expose bounded output pipes.", path));
    else {
      child.stdout.on("data", (chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > budget.maxOutputBytes) {
          return abort(new CutProjectError("CUTP2018", `Video-proxy alignment RGB exceeded the ${budget.maxOutputBytes}-byte analysis bound.`, path));
        }
        digest.update(chunk);
        chunks.push(Buffer.from(chunk));
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const remaining = 32_000 - stderrBytes;
        if (remaining > 0) stderr.push(Buffer.from(chunk.subarray(0, remaining)));
        stderrBytes += chunk.length;
      });
    }
    child.on("error", (error) => finish(errorCode(error) === "ENOENT"
      ? new CutProjectError("CUTP2008", "ffmpeg executable was not found on PATH.", path)
      : new CutProjectError("CUTP2008", `Cannot start ffmpeg video-proxy alignment scan: ${error.message}`, path)));
    child.on("close", (code, signal) => {
      if (settled) return;
      if (terminalError) return finish(terminalError);
      if (code !== 0) return finish(new CutProjectError("CUTP2003", `ffmpeg video-proxy alignment scan exited with ${code ?? signal ?? "unknown status"}: ${Buffer.concat(stderr).toString("utf8").trim()}`, path));
      if (outputBytes < contract.bytesPerFrame || outputBytes % contract.bytesPerFrame !== 0) {
        return finish(new CutProjectError("CUTP2018", `Video stream ${streamIndex} produced no whole rgb24 analysis frames.`, path));
      }
      finish(undefined, {
        bytes: Buffer.concat(chunks, outputBytes),
        sha256: digest.digest("hex"),
        frameCount: outputBytes / contract.bytesPerFrame,
      });
    });
  });
}

function errorRatioPpm(error: number, samples: number) {
  if (!Number.isSafeInteger(error) || error < 0 || !Number.isSafeInteger(samples) || samples < 1) {
    throw new CutProjectError("CUTP2018", "Video-proxy alignment produced invalid integer error geometry.");
  }
  const denominator = BigInt(samples) * 255n;
  return Number((BigInt(error) * 1_000_000n + denominator / 2n) / denominator);
}

function videoProxyAlignmentMetrics(master: Buffer, proxy: Buffer) {
  const contract = cutVideoProxyAlignmentContract;
  if (master.byteLength !== proxy.byteLength || master.byteLength % contract.bytesPerFrame !== 0) {
    throw new CutProjectError("CUTP2018", "Master and proxy video alignment decodes produced different frame geometry.");
  }
  const frameCount = master.byteLength / contract.bytesPerFrame;
  let totalError = 0, maximumFrameMeanAbsoluteErrorPpm = 0, failedFrames = 0;
  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = frame * contract.bytesPerFrame, end = start + contract.bytesPerFrame;
    let frameError = 0;
    for (let offset = start; offset < end; offset += 1) frameError += Math.abs(master[offset] - proxy[offset]);
    totalError += frameError;
    const framePpm = errorRatioPpm(frameError, contract.bytesPerFrame);
    maximumFrameMeanAbsoluteErrorPpm = Math.max(maximumFrameMeanAbsoluteErrorPpm, framePpm);
    if (framePpm > contract.maximumFrameMeanAbsoluteErrorPpm) failedFrames += 1;
  }
  const meanAbsoluteErrorPpm = errorRatioPpm(totalError, master.byteLength);
  return Object.freeze({
    frameCount,
    meanAbsoluteErrorPpm,
    maximumFrameMeanAbsoluteErrorPpm,
    evaluatedFrames: String(frameCount),
    passedFrames: String(frameCount - failedFrames),
    failedFrames: String(failedFrames),
  });
}

async function scanVideoProxyAlignmentVariant(
  projectRoot: string,
  locator: string,
  identity: CutMediaProbe,
  witness: CutDecodedVideoCadence,
  budget: VideoProxyAlignmentBudget,
  ffmpegExecutable?: string,
  execution?: ProbeNativeProcessExecution,
) {
  const safeLocator = validateProjectLocator(locator, "media locator"), path = await resolveProjectFile(projectRoot, safeLocator);
  if (identity.file.locator !== safeLocator || identity.file.bytes < 0 || !/^[a-f0-9]{64}$/u.test(identity.file.sha256)) {
    throw new CutProjectError("CUTP2018", "Video-proxy alignment requires the exact canonical raw media probe for each locator.", path);
  }
  const stream = identity.streams.find((candidate) => candidate.index === witness.streamIndex && candidate.type === "video");
  if (!stream?.timeBase || !stream.width || !stream.height) throw new CutProjectError("CUTP2018", "Video-proxy alignment requires one exact selected video stream.", path);
  decodedVideoCadenceDuration(witness, stream);
  let hashHandle: Awaited<ReturnType<typeof open>> | undefined, scanHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    hashHandle = await open(path, "r"); scanHandle = await open(path, "r");
    const [hashInitial, scanInitial, pathInitial] = await Promise.all([hashHandle.stat({ bigint: true }), scanHandle.stat({ bigint: true }), stat(path, { bigint: true })]);
    if (!hashInitial.isFile() || !scanInitial.isFile() || !pathInitial.isFile()) throw new CutProjectError("CUTP2005", "Media locator must resolve to a regular file.", path);
    const initial = sourceSnapshot(hashInitial);
    assertStableSource(initial, [sourceSnapshot(scanInitial), sourceSnapshot(pathInitial)], path);
    if (initial.size !== BigInt(identity.file.bytes)) throw new CutProjectError("CUTP2009", "Media byte count changed before video-proxy alignment scanning.", path);
    const results = await Promise.allSettled([
      ffmpegVideoProxyAnalysisRgb(path, scanHandle.fd, stream.index, witness.frameCount, budget, ffmpegExecutable, execution),
      sha256(hashHandle, identity.file.bytes, execution?.signal),
    ]);
    const [hashFinal, scanFinal, pathFinal] = await Promise.all([hashHandle.stat({ bigint: true }), scanHandle.stat({ bigint: true }), stat(path, { bigint: true })]);
    assertStableSource(initial, [sourceSnapshot(hashFinal), sourceSnapshot(scanFinal), sourceSnapshot(pathFinal)], path);
    await assertStableLocator(projectRoot, safeLocator, path);
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason;
    const digest = (results[1] as PromiseFulfilledResult<string>).value;
    if (digest !== identity.file.sha256) throw new CutProjectError("CUTP2009", "Media bytes changed during video-proxy alignment scanning.", path);
    return {
      stream: { index: stream.index, width: stream.width, height: stream.height },
      rgb: (results[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof ffmpegVideoProxyAnalysisRgb>>>).value,
    };
  } finally {
    await Promise.allSettled([hashHandle?.close(), scanHandle?.close()].filter(Boolean) as Promise<void>[]);
  }
}

/**
 * Prove bounded frame-by-frame decoded-picture correspondence. Cadence alone
 * proves timing, not that the proxy contains the same imagery.
 */
export async function probeProjectVideoProxyAlignment(
  projectRoot: string,
  masterLocator: string,
  masterIdentity: CutMediaProbe,
  masterWitness: CutDecodedVideoCadence,
  proxyLocator: string,
  proxyIdentity: CutMediaProbe,
  proxyWitness: CutDecodedVideoCadence,
  options: ProbeBudget = {},
  nativeExecutables: ProbeNativeExecutables = {},
  executions?: ProbeProxyAlignmentNativeProcessExecutions,
): Promise<CutVideoProxyAlignment> {
  if (platform() === "win32") {
    throw new CutProjectError("CUTP2015", "Video-proxy alignment witnesses are not supported on Windows because this runtime cannot pass already-open media descriptors to ffmpeg safely.");
  }
  const budget = videoProxyAlignmentBudget(options);
  const [master, proxy] = await Promise.all([
    scanVideoProxyAlignmentVariant(projectRoot, masterLocator, masterIdentity, masterWitness, budget, nativeExecutables.ffmpeg, executions?.master),
    scanVideoProxyAlignmentVariant(projectRoot, proxyLocator, proxyIdentity, proxyWitness, budget, nativeExecutables.ffmpeg, executions?.proxy),
  ]);
  if (masterWitness.frameCount !== proxyWitness.frameCount
    || BigInt(master.stream.width) * BigInt(proxy.stream.height) !== BigInt(proxy.stream.width) * BigInt(master.stream.height)) {
    throw new CutProjectError("CUTP2018", "Video-proxy alignment requires equal decoded frame counts and exact coded-frame aspect ratios.");
  }
  const metrics = videoProxyAlignmentMetrics(master.rgb.bytes, proxy.rgb.bytes), contract = cutVideoProxyAlignmentContract;
  if (master.rgb.frameCount !== proxy.rgb.frameCount
    || String(master.rgb.frameCount) !== masterWitness.frameCount
    || metrics.meanAbsoluteErrorPpm > contract.maximumMeanAbsoluteErrorPpm
    || metrics.maximumFrameMeanAbsoluteErrorPpm > contract.maximumFrameMeanAbsoluteErrorPpm
    || BigInt(metrics.failedFrames) > BigInt(contract.maximumFailedFrames)) {
    throw new CutProjectError(
      "CUTP2018",
      `Video proxy is not frame-correspondent to its master (mean=${metrics.meanAbsoluteErrorPpm}ppm, worstFrame=${metrics.maximumFrameMeanAbsoluteErrorPpm}ppm, failedFrames=${metrics.failedFrames}).`,
    );
  }
  const base = Object.freeze({
    format: contract.format,
    version: contract.version,
    method: contract.method,
    analysis: Object.freeze({
      width: contract.analysisWidth,
      height: contract.analysisHeight,
      pixelFormat: "rgb24" as const,
      scaling: "fit-pad-black-area" as const,
      frameCount: String(metrics.frameCount),
      bytesPerFrame: contract.bytesPerFrame,
      bytesPerVariant: String(master.rgb.bytes.byteLength),
    }),
    master: Object.freeze({
      fileSha256: masterIdentity.file.sha256,
      streamIndex: master.stream.index,
      sourceWidth: master.stream.width,
      sourceHeight: master.stream.height,
      decodedFrameCount: masterWitness.frameCount,
      cadenceRecordsSha256: masterWitness.recordsSha256,
      analysisRgbSha256: master.rgb.sha256,
    }),
    proxy: Object.freeze({
      fileSha256: proxyIdentity.file.sha256,
      streamIndex: proxy.stream.index,
      sourceWidth: proxy.stream.width,
      sourceHeight: proxy.stream.height,
      decodedFrameCount: proxyWitness.frameCount,
      cadenceRecordsSha256: proxyWitness.recordsSha256,
      analysisRgbSha256: proxy.rgb.sha256,
    }),
    policy: Object.freeze({
      maximumMeanAbsoluteErrorPpm: contract.maximumMeanAbsoluteErrorPpm,
      maximumFrameMeanAbsoluteErrorPpm: contract.maximumFrameMeanAbsoluteErrorPpm,
      maximumFailedFrames: contract.maximumFailedFrames,
    }),
    metrics: Object.freeze({
      meanAbsoluteErrorPpm: metrics.meanAbsoluteErrorPpm,
      maximumFrameMeanAbsoluteErrorPpm: metrics.maximumFrameMeanAbsoluteErrorPpm,
      evaluatedFrames: metrics.evaluatedFrames,
      passedFrames: metrics.passedFrames,
      failedFrames: metrics.failedFrames,
    }),
    decision: "equivalent" as const,
  });
  return Object.freeze({ ...base, integrity: cutVideoProxyAlignmentIntegrity(base) });
}

async function ffprobeDecodedAudioSamples(
  path: string,
  sourceFd: number,
  stream: { index: number; timeBase: Rational; sampleRate: number; channels: number; duration?: Rational },
  budget: Required<ProbeBudget>,
  pcm: { sampleCount: string; sha256: string },
  executable = "ffprobe",
  execution?: ProbeNativeProcessExecution,
): Promise<CutDecodedAudioSamples> {
  const inheritedDescriptor = platform() !== "win32";
  const input = inheritedDescriptor ? "/dev/fd/3" : path;
  const args = [
    "-v", "error",
    "-select_streams", String(stream.index),
    "-show_frames",
    "-show_entries", "frame=stream_index,pts,duration,nb_samples:frame_side_data=",
    "-of", "compact=p=1:nk=0",
    input,
  ];
  let child: ChildProcess, terminate: () => void;
  try {
    ({ child, terminate } = await spawnProbeNativeProcess(
      "ffprobe",
      executable,
      args,
      {
        shell: false,
        windowsHide: true,
        stdio: inheritedDescriptor ? ["ignore", "pipe", "pipe", sourceFd] : ["ignore", "pipe", "pipe"],
      },
      execution,
    ));
  } catch (error) {
    throw errorCode(error) === "ENOENT"
      ? new CutProjectError("CUTP2008", "ffprobe executable was not found on PATH.", path)
      : new CutProjectError("CUTP2008", `Cannot start ffprobe decoded-audio scan: ${error instanceof Error ? error.message : String(error)}`, path);
  }
  return new Promise<CutDecodedAudioSamples>((accept, reject) => {
    const records = createHash("sha256").update(
      `cut-decoded-audio-samples-v2\nstream=${stream.index}\ntime_base=${stream.timeBase.numerator}/${stream.timeBase.denominator}\nsample_rate=${stream.sampleRate}\n`,
    );
    const phaseDenominator = BigInt(stream.sampleRate) * BigInt(stream.timeBase.numerator);
    const sampleTickNumerator = BigInt(stream.timeBase.denominator);
    let phaseLow = 0n, phaseHigh = phaseDenominator - 1n;
    let stdoutBytes = 0, stderrBytes = 0, lineBuffer = "", settled = false;
    const stderr: Buffer[] = [];
    let firstPts: bigint | undefined, lastPts: bigint | undefined;
    let frameCount = 0n, decodedFrameSamples = 0n, durationPresentCount = 0n;
    let leadingDiscontinuityFrameCount = 0n, leadingDiscontinuitySampleCount = 0n;
    let lastDuration: bigint | undefined, lastFrameSamples: bigint | undefined;
    let lastFrameUsedEndClock = false;
    let terminalError: Error | undefined;
    const finish = (error?: Error, value?: CutDecodedAudioSamples) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else accept(value!);
    };
    const abort = (error: Error) => {
      if (!terminalError) terminalError = error;
      terminate();
    };
    const invalid = (message: string) => abort(new CutProjectError("CUTP2016", `Audio stream ${stream.index} has no safe decoded sample witness: ${message}`, path));
    const parseLine = (line: string) => {
      if (!line) return;
      if (Buffer.byteLength(line, "utf8") > maximumDecodedCadenceLineBytes) return invalid(`one frame record exceeds ${maximumDecodedCadenceLineBytes} bytes.`);
      const entries = line.split("|");
      if (entries.shift() !== "frame") return invalid("ffprobe emitted an unexpected decoded-frame record.");
      if (entries.at(-1) === "") entries.pop();
      const fields = new Map<string, string>();
      for (const entry of entries) {
        const separator = entry.indexOf("=");
        if (separator <= 0) return invalid("ffprobe emitted a malformed decoded-frame field.");
        const key = entry.slice(0, separator), value = entry.slice(separator + 1);
        if (fields.has(key)) return invalid(`ffprobe repeated decoded-frame field ${key}.`);
        fields.set(key, value);
      }
      if ((fields.size !== 3 && fields.size !== 4)
        || fields.get("stream_index") !== String(stream.index)
        || [...fields.keys()].some((key) => !["stream_index", "pts", "duration", "nb_samples"].includes(key))) {
        return invalid("ffprobe decoded-frame fields do not match the selected stream.");
      }
      const ptsText = fields.get("pts"), samplesText = fields.get("nb_samples"), rawDuration = fields.get("duration");
      const durationText = rawDuration === undefined || rawDuration === "N/A" ? "-" : rawDuration;
      if (!ptsText || !/^-?(?:0|[1-9]\d*)$/u.test(ptsText) || ptsText.length > 256) return invalid("one decoded frame has no canonical exact PTS.");
      if (!samplesText || !/^[1-9]\d*$/u.test(samplesText) || samplesText.length > 256) return invalid("one decoded frame has no canonical positive sample count.");
      if (durationText !== "-" && (!/^[1-9]\d*$/u.test(durationText) || durationText.length > 256)) return invalid("one decoded frame duration must be N/A or one canonical positive tick integer.");
      const pts = BigInt(ptsText), samples = BigInt(samplesText);
      if (lastPts !== undefined && pts <= lastPts) return invalid("decoded frame PTS values must be strictly increasing.");
      firstPts ??= pts;
      const offset = pts - firstPts;
      const intersectClock = (observedOffset: bigint, sampleOffset: bigint) => {
        const lower = observedOffset * phaseDenominator - sampleOffset * sampleTickNumerator;
        const upper = (observedOffset + 1n) * phaseDenominator - sampleOffset * sampleTickNumerator - 1n;
        const nextLow = lower > phaseLow ? lower : phaseLow;
        const nextHigh = upper < phaseHigh ? upper : phaseHigh;
        return nextLow >= 0n && nextLow < phaseDenominator && nextLow <= nextHigh
          ? { low: nextLow, high: nextHigh }
          : undefined;
      };
      const startClock = intersectClock(offset, decodedFrameSamples);
      let selectedClock = startClock, usedEndClock = false, discontinuityFill = 0n;
      if (!selectedClock && durationText !== "-") {
        const durationTicks = BigInt(durationText);
        const durationSampleNumerator = durationTicks * BigInt(stream.timeBase.numerator) * BigInt(stream.sampleRate);
        const durationSampleDenominator = BigInt(stream.timeBase.denominator);
        if (durationSampleNumerator % durationSampleDenominator === 0n) {
          const presentationSamples = durationSampleNumerator / durationSampleDenominator;
          if (presentationSamples > 0n && presentationSamples < samples) {
            selectedClock = intersectClock(offset + durationTicks, decodedFrameSamples + samples);
            if (selectedClock) {
              usedEndClock = true;
              discontinuityFill = samples - presentationSamples;
            }
          }
        }
      }
      if (!selectedClock) return invalid("decoded frame PTS values follow neither the cumulative sample start clock nor an exact short-duration end clock.");
      phaseLow = selectedClock.low;
      phaseHigh = selectedClock.high;
      if (usedEndClock) {
        leadingDiscontinuityFrameCount += 1n;
        leadingDiscontinuitySampleCount += discontinuityFill;
      }
      records.update(`${frameCount}\t${ptsText}\t${durationText}\t${samplesText}\n`);
      lastDuration = durationText === "-" ? undefined : BigInt(durationText);
      if (lastDuration !== undefined) durationPresentCount += 1n;
      lastFrameSamples = samples;
      lastFrameUsedEndClock = usedEndClock;
      lastPts = pts;
      decodedFrameSamples += samples;
      frameCount += 1n;
      if (frameCount > maximumDecodedAudioFrameRecords) invalid(`decoded audio exceeds ${maximumDecodedAudioFrameRecords} frame records.`);
      if (decodedFrameSamples > maximumDecodedAudioSamples) invalid(`decoded audio exceeds ${maximumDecodedAudioSamples} samples.`);
    };
    const timer = setTimeout(() => abort(new CutProjectError("CUTP2001", `ffprobe decoded-audio scan timed out after ${budget.timeoutMs}ms.`, path)), budget.timeoutMs);
    if (!child.stdout || !child.stderr) abort(new CutProjectError("CUTP2008", "ffprobe decoded-audio scan did not expose bounded output pipes.", path));
    else {
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > budget.maxOutputBytes) return abort(new CutProjectError("CUTP2002", `ffprobe decoded-audio output exceeded ${budget.maxOutputBytes} bytes.`, path));
        lineBuffer += chunk.toString("utf8");
        let newline = lineBuffer.indexOf("\n");
        while (newline >= 0) {
          const line = lineBuffer.slice(0, newline).replace(/\r$/u, "");
          lineBuffer = lineBuffer.slice(newline + 1);
          parseLine(line);
          if (terminalError) break;
          newline = lineBuffer.indexOf("\n");
        }
        if (Buffer.byteLength(lineBuffer, "utf8") > maximumDecodedCadenceLineBytes) invalid(`one frame record exceeds ${maximumDecodedCadenceLineBytes} bytes.`);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const remaining = 32_000 - stderrBytes;
        if (remaining > 0) stderr.push(Buffer.from(chunk.subarray(0, remaining)));
        stderrBytes += chunk.length;
      });
    }
    child.on("error", (error) => finish(errorCode(error) === "ENOENT"
      ? new CutProjectError("CUTP2008", "ffprobe executable was not found on PATH.", path)
      : new CutProjectError("CUTP2008", `Cannot start ffprobe decoded-audio scan: ${error.message}`, path)));
    child.on("close", (code, signal) => {
      if (settled) return;
      if (terminalError) return finish(terminalError);
      if (code !== 0) return finish(new CutProjectError("CUTP2003", `ffprobe decoded-audio scan exited with ${code ?? signal ?? "unknown status"}: ${Buffer.concat(stderr).toString("utf8").trim()}`, path));
      if (lineBuffer) parseLine(lineBuffer.replace(/\r$/u, ""));
      if (terminalError) return finish(terminalError);
      if (firstPts === undefined || lastPts === undefined || frameCount < 1n || lastFrameSamples === undefined) {
        return finish(new CutProjectError("CUTP2016", `Audio stream ${stream.index} decoded no frames for a sample witness.`, path));
      }
      if (decodedFrameSamples !== BigInt(pcm.sampleCount)) {
        return finish(new CutProjectError("CUTP2017", `Audio stream ${stream.index} ffprobe frame samples do not equal the independent ffmpeg s16le decoder output.`, path));
      }
      let terminalTrimSamples = 0n;
      // A short terminal duration is padding authority only when one codec
      // tick is no coarser than one decoded sample. Matroska commonly uses a
      // 1 ms audio clock; its rounded final duration can be smaller than a
      // truthful PCM/FLAC frame by tens of samples and must not trim it.
      if (!lastFrameUsedEndClock && lastDuration !== undefined && compareRational(stream.timeBase, rational(1, stream.sampleRate)) <= 0) {
        const durationSamples = multiplyRational(
          multiplyRational(rational(lastDuration), stream.timeBase),
          rational(stream.sampleRate),
        );
        if (durationSamples.denominator === "1") {
          const effective = BigInt(durationSamples.numerator);
          if (effective > 0n && effective < lastFrameSamples) terminalTrimSamples = lastFrameSamples - effective;
        }
      }
      const decodedSampleCount = decodedFrameSamples - terminalTrimSamples;
      if (decodedSampleCount < 1n) return finish(new CutProjectError("CUTP2016", `Audio stream ${stream.index} decoded no retained samples after terminal padding.`, path));
      const witness: CutDecodedAudioSamples = {
        format: "cut-decoded-audio-samples",
        version: 2,
        method: "ffprobe-show-frames-audio-v2",
        quantization: "phase-floor-start-or-exact-end",
        trimSemantics: "decoder-output-sequence-plus-terminal-duration",
        phaseNumerator: String(phaseLow),
        streamIndex: stream.index,
        firstPts: String(firstPts),
        lastPts: String(lastPts),
        frameCount: String(frameCount),
        decoderOutputSampleCount: pcm.sampleCount,
        decoderPcmSha256: pcm.sha256,
        decodedSampleCount: String(decodedSampleCount),
        terminalTrimSamples: String(terminalTrimSamples),
        leadingDiscontinuityFrameCount: String(leadingDiscontinuityFrameCount),
        leadingDiscontinuitySampleCount: String(leadingDiscontinuitySampleCount),
        durationPresentCount: String(durationPresentCount),
        durationCoverage: durationPresentCount === 0n ? "none" : durationPresentCount === frameCount ? "complete" : "partial",
        recordsSha256: records.digest("hex"),
        timeBase: stream.timeBase,
        sampleRate: stream.sampleRate,
      };
      try { decodedAudioSamplesDuration(witness, stream); }
      catch (error) { return finish(new CutProjectError("CUTP2016", `Audio stream ${stream.index} decoded sample witness is invalid: ${error instanceof Error ? error.message : String(error)}`, path)); }
      finish(undefined, witness);
    });
  });
}

/**
 * Scan decoded presentation frames without retaining per-frame output. A
 * witness exists only when every frame has one exact PTS and duration and its
 * PTS follows nearest-tick quantization of the selected ideal CFR clock. This
 * admits professional fractional rates on coarse codec time bases without
 * relabeling arbitrary VFR material as CFR.
 */
async function ffprobeDecodedVideoCadence(
  path: string,
  sourceFd: number,
  stream: { index: number; timeBase: Rational; start: Rational; frameRates: Rational[] },
  budget: Required<ProbeBudget>,
  executable = "ffprobe",
  execution?: ProbeNativeProcessExecution,
): Promise<CutDecodedVideoCadence> {
  const inheritedDescriptor = platform() !== "win32";
  const input = inheritedDescriptor ? "/dev/fd/3" : path;
  const candidates = stream.frameRates.map((frameRate) => {
    const frameTicks = multiplyRational(rational(frameRate.denominator, frameRate.numerator), rational(stream.timeBase.denominator, stream.timeBase.numerator));
    const periodNumerator = BigInt(frameTicks.numerator), periodDenominator = BigInt(frameTicks.denominator);
    return {
      frameRate,
      periodNumerator,
      periodDenominator,
      phaseLow: 0n,
      phaseHigh: periodDenominator - 1n,
      valid: periodNumerator > 0n && periodNumerator / periodDenominator >= 1n,
      records: createHash("sha256").update(`cut-decoded-cfr-grid-v2\nstream=${stream.index}\ntime_base=${stream.timeBase.numerator}/${stream.timeBase.denominator}\nframe_rate=${frameRate.numerator}/${frameRate.denominator}\n`),
    };
  });
  if (!candidates.some((candidate) => candidate.valid)) throw new CutProjectError("CUTP2014", `Video stream ${stream.index} frame-rate candidates are smaller than one codec time-base tick.`, path);
  const args = [
    "-v", "error",
    "-select_streams", String(stream.index),
    "-show_frames",
    "-show_entries", "frame=stream_index,pts,duration:frame_side_data=",
    "-of", "compact=p=1:nk=0",
    input,
  ];
  let child: ChildProcess, terminate: () => void;
  try {
    ({ child, terminate } = await spawnProbeNativeProcess(
      "ffprobe",
      executable,
      args,
      {
        shell: false,
        windowsHide: true,
        stdio: inheritedDescriptor ? ["ignore", "pipe", "pipe", sourceFd] : ["ignore", "pipe", "pipe"],
      },
      execution,
    ));
  } catch (error) {
    throw errorCode(error) === "ENOENT"
      ? new CutProjectError("CUTP2008", "ffprobe executable was not found on PATH.", path)
      : new CutProjectError("CUTP2008", `Cannot start ffprobe decoded-cadence scan: ${error instanceof Error ? error.message : String(error)}`, path);
  }
  return new Promise<CutDecodedVideoCadence>((accept, reject) => {
    let stdoutBytes = 0, stderrBytes = 0, lineBuffer = "", settled = false;
    const stderr: Buffer[] = [];
    let firstPts: bigint | undefined, lastPts: bigint | undefined, frameCount = 0n, durationPresentCount = 0n;
    // A muxer quantizes the absolute source clock, so a nonzero stream start
    // can shift the floor/ceil pattern. Retain the exact bounded intersection
    // of all phases capable of producing every decoded PTS; VFR has no global
    // phase and is refused.
    let terminalError: Error | undefined;
    const finish = (error?: Error, value?: CutDecodedVideoCadence) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else accept(value!);
    };
    const abort = (error: Error) => {
      if (!terminalError) terminalError = error;
      terminate();
    };
    const invalid = (message: string) => abort(new CutProjectError("CUTP2014", `Video stream ${stream.index} has no safe decoded cadence witness: ${message}`, path));
    const parseLine = (line: string) => {
      if (!line) return;
      if (Buffer.byteLength(line, "utf8") > maximumDecodedCadenceLineBytes) return invalid(`one frame record exceeds ${maximumDecodedCadenceLineBytes} bytes.`);
      const entries = line.split("|");
      if (entries.shift() !== "frame") return invalid("ffprobe emitted an unexpected decoded-frame record.");
      if (entries.at(-1) === "") entries.pop();
      const fields = new Map<string, string>();
      for (const entry of entries) {
        const separator = entry.indexOf("=");
        if (separator <= 0) return invalid("ffprobe emitted a malformed decoded-frame field.");
        const key = entry.slice(0, separator), value = entry.slice(separator + 1);
        if (fields.has(key)) return invalid(`ffprobe repeated decoded-frame field ${key}.`);
        fields.set(key, value);
      }
      if ((fields.size !== 2 && fields.size !== 3) || fields.get("stream_index") !== String(stream.index) || [...fields.keys()].some((key) => !["stream_index", "pts", "duration"].includes(key))) return invalid("ffprobe decoded-frame fields do not match the selected stream.");
      const ptsText = fields.get("pts"), rawDuration = fields.get("duration"), durationText = rawDuration === undefined || rawDuration === "N/A" ? "-" : rawDuration;
      if (!ptsText || !/^-?(?:0|[1-9]\d*)$/u.test(ptsText) || ptsText.length > 256) return invalid("one decoded frame has no canonical exact PTS.");
      if (durationText !== "-" && (!/^[1-9]\d*$/u.test(durationText) || durationText.length > 256)) return invalid("one decoded frame duration must be N/A or one canonical positive tick integer.");
      const pts = BigInt(ptsText);
      if (lastPts !== undefined && pts <= lastPts) return invalid("decoded frame PTS values must be strictly increasing.");
      let duration: bigint | undefined;
      if (durationText !== "-") {
        duration = BigInt(durationText);
        durationPresentCount += 1n;
      }
      firstPts ??= pts;
      const offset = pts - firstPts;
      for (const candidate of candidates) {
        candidate.records.update(`${frameCount}\t${ptsText}\t${durationText}\n`);
        if (!candidate.valid) continue;
        const { periodNumerator, periodDenominator } = candidate;
        if (duration !== undefined) {
          const floor = periodNumerator / periodDenominator, ceil = (periodNumerator + periodDenominator - 1n) / periodDenominator;
          if (duration !== floor && duration !== ceil) { candidate.valid = false; continue; }
        }
        const lower = offset * periodDenominator - frameCount * periodNumerator;
        const upper = (offset + 1n) * periodDenominator - frameCount * periodNumerator - 1n;
        if (lower > candidate.phaseLow) candidate.phaseLow = lower;
        if (upper < candidate.phaseHigh) candidate.phaseHigh = upper;
        if (candidate.phaseLow > candidate.phaseHigh) candidate.valid = false;
      }
      if (!candidates.some((candidate) => candidate.valid)) return invalid("decoded frame PTS/durations match no exact phase-quantized nominal/average CFR candidate.");
      lastPts = pts;
      frameCount += 1n;
      if (frameCount > maximumDecodedVideoCadenceFrames) invalid(`decoded cadence exceeds ${maximumDecodedVideoCadenceFrames} frames.`);
    };
    const timer = setTimeout(() => abort(new CutProjectError("CUTP2001", `ffprobe decoded-cadence scan timed out after ${budget.timeoutMs}ms.`, path)), budget.timeoutMs);
    if (!child.stdout || !child.stderr) abort(new CutProjectError("CUTP2008", "ffprobe decoded-cadence scan did not expose bounded output pipes.", path));
    else {
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > budget.maxOutputBytes) return abort(new CutProjectError("CUTP2002", `ffprobe decoded-cadence output exceeded ${budget.maxOutputBytes} bytes.`, path));
        lineBuffer += chunk.toString("utf8");
        while (true) {
          const newline = lineBuffer.indexOf("\n");
          if (newline < 0) break;
          const line = lineBuffer.slice(0, newline).replace(/\r$/u, "");
          lineBuffer = lineBuffer.slice(newline + 1);
          parseLine(line);
          if (terminalError) break;
        }
        if (Buffer.byteLength(lineBuffer, "utf8") > maximumDecodedCadenceLineBytes) invalid(`one frame record exceeds ${maximumDecodedCadenceLineBytes} bytes.`);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const remaining = 32_000 - stderrBytes;
        if (remaining > 0) stderr.push(Buffer.from(chunk.subarray(0, remaining)));
        stderrBytes += chunk.length;
      });
    }
    child.on("error", (error) => finish(errorCode(error) === "ENOENT"
      ? new CutProjectError("CUTP2008", "ffprobe executable was not found on PATH.", path)
      : new CutProjectError("CUTP2008", `Cannot start ffprobe decoded-cadence scan: ${error.message}`, path)));
    child.on("close", (code, signal) => {
      if (settled) return;
      if (terminalError) return finish(terminalError);
      if (code !== 0) return finish(new CutProjectError("CUTP2003", `ffprobe decoded-cadence scan exited with ${code ?? signal ?? "unknown status"}: ${Buffer.concat(stderr).toString("utf8").trim()}`, path));
      if (lineBuffer) parseLine(lineBuffer.replace(/\r$/u, ""));
      if (terminalError) return finish(terminalError);
      if (firstPts === undefined || lastPts === undefined || frameCount < 1n) return finish(new CutProjectError("CUTP2014", `Video stream ${stream.index} decoded no frames for a cadence witness.`, path));
      const surviving = candidates.filter((candidate) => candidate.valid
        && candidate.phaseLow >= 0n
        && candidate.phaseLow < candidate.periodDenominator
        && candidate.phaseLow <= candidate.phaseHigh);
      if (!surviving.length) return finish(new CutProjectError("CUTP2014", `Video stream ${stream.index} decoded cadence proved no nominal/average frame-rate candidate.`, path));
      // Some muxers derive avg_frame_rate from the same coarse terminal PTS,
      // yielding a second near-identical rational. Prefer the nominal first
      // candidate only when every survivor's full N/rate duration is within
      // one codec tick; otherwise the stream's semantic rate is ambiguous.
      const chosen = surviving[0], chosenDuration = divideRational(rational(frameCount), chosen.frameRate);
      const equivalent = surviving.slice(1).every((candidate) => {
        const duration = divideRational(rational(frameCount), candidate.frameRate);
        const delta = compareRational(duration, chosenDuration) >= 0 ? subtractRational(duration, chosenDuration) : subtractRational(chosenDuration, duration);
        return compareRational(delta, stream.timeBase) <= 0;
      });
      if (!equivalent) return finish(new CutProjectError("CUTP2014", `Video stream ${stream.index} decoded cadence has non-equivalent nominal/average frame-rate candidates.`, path));
      const { frameRate, periodNumerator, periodDenominator, phaseLow } = chosen;
      const first = multiplyRational(rational(firstPts), stream.timeBase);
      if (first.numerator !== stream.start.numerator || first.denominator !== stream.start.denominator) {
        return finish(new CutProjectError("CUTP2014", `Video stream ${stream.index} first decoded PTS does not equal its exact stream start.`, path));
      }
      finish(undefined, {
        format: "cut-decoded-video-cadence",
        version: 2,
        method: "ffprobe-show-frames-cfr-v2",
        quantization: "phase-floor",
        phaseNumerator: String(phaseLow),
        streamIndex: stream.index,
        firstPts: String(firstPts),
        lastPts: String(lastPts),
        quantizedEndPts: String(firstPts + valuePhaseQuantizedVideoCadenceOffset(frameCount, periodNumerator, periodDenominator, phaseLow)),
        frameCount: String(frameCount),
        durationPresentCount: String(durationPresentCount),
        durationCoverage: durationPresentCount === 0n ? "none" : durationPresentCount === frameCount ? "complete" : "partial",
        recordsSha256: chosen.records.digest("hex"),
        timeBase: stream.timeBase,
        frameRate,
      });
    });
  });
}

function implementationIdentity(raw: Record<string, unknown>): CutMediaProbe["implementation"] {
  const program = object(raw.program_version);
  const version = boundedString(program.version, 128);
  if (!version) {
    throw new CutProjectError("CUTP2010", "ffprobe did not return a bounded implementation version.");
  }
  const compiler = boundedProbeString(program.compiler_ident, 256, "ffprobe compiler identity", "ffprobe:program_version");
  const configuration = typeof program.configuration === "string" ? program.configuration : undefined;
  return {
    name: "ffprobe",
    version,
    compiler,
    configurationSha256: configuration ? createHash("sha256").update(configuration).digest("hex") : undefined,
  };
}

export async function probeProjectMedia(
  projectRoot: string,
  locator: string,
  options: ProbeBudget = {},
  nativeExecutables: ProbeNativeExecutables = {},
  execution?: ProbeNativeProcessExecution,
): Promise<CutMediaProbe> {
  const safeLocator = validateProjectLocator(locator, "media locator");
  const path = await resolveProjectFile(projectRoot, safeLocator);
  if (platform() === "win32") {
    throw new CutProjectError("CUTP2015", "Safe native media probing is not supported on Windows because this runtime cannot pass an already-open media descriptor to ffprobe.", path);
  }
  const budget = probeBudget(options);

  let hashHandle: Awaited<ReturnType<typeof open>> | undefined;
  let probeHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    try {
      // Open independently so a successful first handle is retained and closed
      // by the outer finally even if opening the second handle fails.
      hashHandle = await open(path, "r");
      probeHandle = await open(path, "r");
    } catch (error) {
      if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") {
        throw new CutProjectError("CUTP1015", `Project resource does not exist: ${safeLocator}`, path);
      }
      throw new CutProjectError(
        "CUTP2011",
        `Cannot open media for probing: ${error instanceof Error ? error.message : String(error)}`,
        path,
      );
    }

    const [hashInitial, probeInitial, pathInitial] = await Promise.all([
      hashHandle.stat({ bigint: true }),
      probeHandle.stat({ bigint: true }),
      stat(path, { bigint: true }),
    ]);
    if (!hashInitial.isFile() || !probeInitial.isFile() || !pathInitial.isFile()) {
      throw new CutProjectError("CUTP2005", "Media locator must resolve to a regular file.", path);
    }
    const initial = sourceSnapshot(hashInitial);
    assertStableSource(initial, [sourceSnapshot(probeInitial), sourceSnapshot(pathInitial)], path);
    if (initial.size > BigInt(budget.maxFileBytes)) {
      throw new CutProjectError("CUTP2006", `Media exceeds the ${budget.maxFileBytes}-byte probe budget.`, path);
    }
    if (initial.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new CutProjectError("CUTP2006", "Media size cannot be represented safely by this runtime.", path);
    }
    const bytes = Number(initial.size);

    const results = await Promise.allSettled([
      ffprobe(path, probeHandle.fd, budget, nativeExecutables.ffprobe, execution),
      sha256(hashHandle, bytes, execution?.signal),
    ]);
    let after: SourceSnapshot[];
    try {
      const [hashFinal, probeFinal, pathFinal] = await Promise.all([
        hashHandle.stat({ bigint: true }),
        probeHandle.stat({ bigint: true }),
        stat(path, { bigint: true }),
      ]);
      after = [sourceSnapshot(hashFinal), sourceSnapshot(probeFinal), sourceSnapshot(pathFinal)];
    } catch {
      throw new CutProjectError(
        "CUTP2009",
        "Media changed, disappeared, or was replaced while it was being probed; no probe was produced.",
        path,
      );
    }
    assertStableSource(initial, after, path);
    await assertStableLocator(projectRoot, safeLocator, path);

    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason;
    const raw = (results[0] as PromiseFulfilledResult<Record<string, unknown>>).value;
    const digest = (results[1] as PromiseFulfilledResult<string>).value;
    const rawFormat = object(raw.format);
    const rawStreams = Array.isArray(raw.streams) ? raw.streams.map(object).filter((value) => Object.keys(value).length > 0) : [];
    const rawChapters = Array.isArray(raw.chapters) ? raw.chapters.map(object).filter((value) => Object.keys(value).length > 0) : [];
    if (rawStreams.length > 1_024) throw new CutProjectError("CUTP2012", "Media contains more than 1024 streams.", path);
    if (rawChapters.length > 10_000) throw new CutProjectError("CUTP2012", "Media contains more than 10000 chapters.", path);
    const allowedTypes = new Set(["video", "audio", "subtitle", "data", "attachment"]);
    const names = typeof rawFormat.format_name === "string" ? rawFormat.format_name.split(",").filter(Boolean).sort() : [];
    if (!names.length || names.length > 64 || names.some((name) => name.length > 128)) throw new CutProjectError("CUTP2012", "Media container must expose 1 to 64 format names of at most 128 characters.", path);
    const streamIndexes = new Set<number>();
    const streams = rawStreams.map((stream) => {
      const index = integer(stream.index);
      if (index === undefined || streamIndexes.has(index)) throw new CutProjectError("CUTP2013", "ffprobe returned an invalid or duplicate stream index.", path);
      streamIndexes.add(index);
      const rawType = typeof stream.codec_type === "string" ? stream.codec_type : "unknown";
      const timeBase = exact(stream.time_base), disposition = sortedStrings(stream.disposition);
      if ((rawType === "video" || rawType === "audio") && !timeBase) throw new CutProjectError("CUTP2013", `ffprobe returned no bounded exact time base for ${rawType} stream ${index}.`, path);
      if (disposition.length > 64 || disposition.some((item) => item.length > 128)) throw new CutProjectError("CUTP2012", `Stream ${index} disposition metadata exceeds its bound.`, path);
      return {
        index,
        type: (allowedTypes.has(rawType) ? rawType : "unknown") as CutMediaProbe["streams"][number]["type"],
        codec: boundedProbeString(stream.codec_name, 128, `stream ${index} codec`, path) ?? "unknown",
        profile: boundedProbeString(stream.profile, 128, `stream ${index} profile`, path),
        timeBase,
        start: startFromTicks(stream),
        duration: durationFromTicks(stream),
        // r_frame_rate is the selected stream's nominal picture clock. On a
        // coarse codec time base, ffprobe's avg_frame_rate is derived from
        // rounded first/last timestamps and can become 8000/233 for a genuine
        // 30000/1001 CFR stream. The decoded cadence witness independently
        // proves (or refuses) every actual PTS against this nominal clock.
        frameRate: exact(stream.r_frame_rate) ?? exact(stream.avg_frame_rate),
        averageFrameRate: exact(stream.avg_frame_rate),
        width: integer(stream.width, 1),
        height: integer(stream.height, 1),
        pixelFormat: boundedProbeString(stream.pix_fmt, 128, `stream ${index} pixel format`, path),
        fieldOrder: boundedProbeString(stream.field_order, 128, `stream ${index} field order`, path),
        colorRange: boundedProbeString(stream.color_range, 128, `stream ${index} color range`, path),
        colorSpace: boundedProbeString(stream.color_space, 128, `stream ${index} color space`, path),
        colorTransfer: boundedProbeString(stream.color_transfer, 128, `stream ${index} color transfer`, path),
        colorPrimaries: boundedProbeString(stream.color_primaries, 128, `stream ${index} color primaries`, path),
        sampleRate: integer(stream.sample_rate, 1),
        channels: integer(stream.channels, 1),
        channelLayout: boundedProbeString(stream.channel_layout, 128, `stream ${index} channel layout`, path),
        language: boundedProbeString(tag(stream.tags, "language"), 64, `stream ${index} language`, path),
        disposition,
      };
    }).sort((left, right) => left.index - right.index);
    return {
      format: "cut-media-probe",
      version: 1,
      implementation: implementationIdentity(raw),
      file: {
        locator: safeLocator,
        basename: posix.basename(safeLocator),
        bytes,
        sha256: digest,
      },
      container: {
        names,
        duration: exact(rawFormat.duration),
        start: exact(rawFormat.start_time),
        bitRate: integer(rawFormat.bit_rate),
      },
      streams,
      chapters: rawChapters.map((chapter) => ({
        id: integer(chapter.id) ?? 0,
        start: exact(chapter.start_time) ?? rational(0),
        end: exact(chapter.end_time) ?? rational(0),
        title: boundedProbeString(tag(chapter.tags, "title"), 512, "chapter title", path),
      })).sort((left, right) => left.id - right.id),
    };
  } finally {
    await Promise.allSettled([hashHandle?.close(), probeHandle?.close()].filter(Boolean) as Promise<void>[]);
  }
}

/**
 * Produce a full decoded-frame cadence witness for one already-probed video
 * stream. The raw media probe deliberately remains unchanged: this derived
 * evidence belongs to a concrete lock selection, not to stream metadata.
 */
export async function probeProjectDecodedVideoCadence(
  projectRoot: string,
  locator: string,
  identity: CutMediaProbe,
  streamIndex: number,
  options: ProbeBudget = {},
  nativeExecutables: ProbeNativeExecutables = {},
  execution?: ProbeNativeProcessExecution,
): Promise<CutDecodedVideoCadence> {
  const safeLocator = validateProjectLocator(locator, "media locator"), path = await resolveProjectFile(projectRoot, safeLocator);
  if (platform() === "win32") {
    throw new CutProjectError("CUTP2015", "Decoded-video-cadence witnesses are not supported on Windows because this runtime cannot pass an already-open media descriptor to ffprobe safely.", path);
  }
  // Cadence output is consumed line-by-line. Give an ordinary scan the full
  // existing bounded process envelope rather than the small metadata-probe
  // default; explicit caller limits remain authoritative.
  const cadenceBudget = probeBudget({
    ...options,
    maxOutputBytes: options.maxOutputBytes ?? HARD_BUDGET.maxOutputBytes,
    timeoutMs: options.timeoutMs ?? HARD_BUDGET.timeoutMs,
  });
  if (identity.file.locator !== safeLocator || identity.file.bytes < 0 || !/^[a-f0-9]{64}$/u.test(identity.file.sha256)) {
    throw new CutProjectError("CUTP2014", "Decoded-cadence scan requires the exact canonical raw media probe for this locator.", path);
  }
  const stream = identity.streams.find((candidate) => candidate.index === streamIndex && candidate.type === "video");
  if (!stream) throw new CutProjectError("CUTP2014", "Decoded-cadence scan requires one selected video stream.", path);
  const frameRates = [stream.frameRate, stream.averageFrameRate]
    .filter((candidate): candidate is Rational => Boolean(candidate) && compareRational(candidate!, rational(0)) > 0)
    .filter((candidate, index, all) => all.findIndex((other) => compareRational(candidate, other) === 0) === index);
  if (!stream.timeBase || !stream.start || !frameRates.length || compareRational(stream.start, rational(0)) < 0) {
    throw new CutProjectError("CUTP2014", `Video stream ${streamIndex} must expose exact non-negative start, positive time base, and positive frame rate metadata.`, path);
  }
  let hashHandle: Awaited<ReturnType<typeof open>> | undefined, scanHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    hashHandle = await open(path, "r"); scanHandle = await open(path, "r");
    const [hashInitial, scanInitial, pathInitial] = await Promise.all([hashHandle.stat({ bigint: true }), scanHandle.stat({ bigint: true }), stat(path, { bigint: true })]);
    if (!hashInitial.isFile() || !scanInitial.isFile() || !pathInitial.isFile()) throw new CutProjectError("CUTP2005", "Media locator must resolve to a regular file.", path);
    const initial = sourceSnapshot(hashInitial);
    assertStableSource(initial, [sourceSnapshot(scanInitial), sourceSnapshot(pathInitial)], path);
    if (initial.size !== BigInt(identity.file.bytes)) throw new CutProjectError("CUTP2009", "Media byte count changed before decoded-cadence scanning.", path);
    const results = await Promise.allSettled([
      ffprobeDecodedVideoCadence(path, scanHandle.fd, { index: stream.index, timeBase: stream.timeBase, start: stream.start, frameRates }, cadenceBudget, nativeExecutables.ffprobe, execution),
      sha256(hashHandle, identity.file.bytes, execution?.signal),
    ]);
    const [hashFinal, scanFinal, pathFinal] = await Promise.all([hashHandle.stat({ bigint: true }), scanHandle.stat({ bigint: true }), stat(path, { bigint: true })]);
    assertStableSource(initial, [sourceSnapshot(hashFinal), sourceSnapshot(scanFinal), sourceSnapshot(pathFinal)], path);
    await assertStableLocator(projectRoot, safeLocator, path);
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason;
    const digest = (results[1] as PromiseFulfilledResult<string>).value;
    if (digest !== identity.file.sha256) throw new CutProjectError("CUTP2009", "Media bytes changed between raw probing and decoded-cadence scanning.", path);
    return (results[0] as PromiseFulfilledResult<CutDecodedVideoCadence>).value;
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") throw new CutProjectError("CUTP1015", `Project resource does not exist: ${safeLocator}`, path);
    throw error;
  } finally {
    await Promise.allSettled([hashHandle?.close(), scanHandle?.close()].filter(Boolean) as Promise<void>[]);
  }
}

/**
 * Produce a full decoded-sample extent witness for one already-probed absolute
 * audio stream. The witness is selection-specific derived evidence: raw
 * stream/container duration metadata never substitutes for this scan.
 */
export async function probeProjectDecodedAudioSamples(
  projectRoot: string,
  locator: string,
  identity: CutMediaProbe,
  streamIndex: number,
  options: ProbeBudget = {},
  nativeExecutables: ProbeNativeExecutables = {},
  executions?: ProbeDecodedAudioNativeProcessExecutions,
): Promise<CutDecodedAudioSamples> {
  const safeLocator = validateProjectLocator(locator, "media locator"), path = await resolveProjectFile(projectRoot, safeLocator);
  if (platform() === "win32") {
    throw new CutProjectError("CUTP2015", "Decoded-audio-sample witnesses are not supported on Windows because this runtime cannot pass an already-open media descriptor to ffprobe safely.", path);
  }
  const scanBudget = probeBudget({
    ...options,
    maxOutputBytes: options.maxOutputBytes ?? HARD_BUDGET.maxOutputBytes,
    timeoutMs: options.timeoutMs ?? HARD_BUDGET.timeoutMs,
  });
  if (identity.file.locator !== safeLocator || identity.file.bytes < 0 || !/^[a-f0-9]{64}$/u.test(identity.file.sha256)) {
    throw new CutProjectError("CUTP2016", "Decoded-audio scan requires the exact canonical raw media probe for this locator.", path);
  }
  const stream = identity.streams.find((candidate) => candidate.index === streamIndex && candidate.type === "audio");
  if (!stream) throw new CutProjectError("CUTP2016", "Decoded-audio scan requires one selected audio stream.", path);
  if (!stream.timeBase || compareRational(stream.timeBase, rational(0)) <= 0 || !stream.sampleRate || !Number.isSafeInteger(stream.sampleRate)
    || !stream.channels || !Number.isSafeInteger(stream.channels) || stream.channels > 64) {
    throw new CutProjectError("CUTP2016", `Audio stream ${streamIndex} must expose a positive exact time base, sample rate, and at most 64 channels.`, path);
  }
  let hashHandle: Awaited<ReturnType<typeof open>> | undefined, scanHandle: Awaited<ReturnType<typeof open>> | undefined, pcmHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    hashHandle = await open(path, "r"); scanHandle = await open(path, "r"); pcmHandle = await open(path, "r");
    const [hashInitial, scanInitial, pcmInitial, pathInitial] = await Promise.all([hashHandle.stat({ bigint: true }), scanHandle.stat({ bigint: true }), pcmHandle.stat({ bigint: true }), stat(path, { bigint: true })]);
    if (!hashInitial.isFile() || !scanInitial.isFile() || !pcmInitial.isFile() || !pathInitial.isFile()) throw new CutProjectError("CUTP2005", "Media locator must resolve to a regular file.", path);
    const initial = sourceSnapshot(hashInitial);
    assertStableSource(initial, [sourceSnapshot(scanInitial), sourceSnapshot(pcmInitial), sourceSnapshot(pathInitial)], path);
    if (initial.size !== BigInt(identity.file.bytes)) throw new CutProjectError("CUTP2009", "Media byte count changed before decoded-audio scanning.", path);
    const pcm = await ffmpegDecodedAudioPcmIdentity(
      path,
      pcmHandle.fd,
      { index: stream.index, channels: stream.channels },
      scanBudget,
      nativeExecutables.ffmpeg,
      executions?.pcm,
    );
    const results = await Promise.allSettled([
      ffprobeDecodedAudioSamples(
        path,
        scanHandle.fd,
        { index: stream.index, timeBase: stream.timeBase, sampleRate: stream.sampleRate, channels: stream.channels, duration: stream.duration },
        scanBudget,
        pcm,
        nativeExecutables.ffprobe,
        executions?.frames,
      ),
      sha256(hashHandle, identity.file.bytes, executions?.frames.signal ?? executions?.pcm.signal),
    ]);
    const [hashFinal, scanFinal, pcmFinal, pathFinal] = await Promise.all([hashHandle.stat({ bigint: true }), scanHandle.stat({ bigint: true }), pcmHandle.stat({ bigint: true }), stat(path, { bigint: true })]);
    assertStableSource(initial, [sourceSnapshot(hashFinal), sourceSnapshot(scanFinal), sourceSnapshot(pcmFinal), sourceSnapshot(pathFinal)], path);
    await assertStableLocator(projectRoot, safeLocator, path);
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason;
    const digest = (results[1] as PromiseFulfilledResult<string>).value;
    if (digest !== identity.file.sha256) throw new CutProjectError("CUTP2009", "Media bytes changed between raw probing and decoded-audio scanning.", path);
    return (results[0] as PromiseFulfilledResult<CutDecodedAudioSamples>).value;
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") throw new CutProjectError("CUTP1015", `Project resource does not exist: ${safeLocator}`, path);
    throw error;
  } finally {
    await Promise.allSettled([hashHandle?.close(), scanHandle?.close(), pcmHandle?.close()].filter(Boolean) as Promise<void>[]);
  }
}

async function probeFileIdentity(projectRoot: string, locator: string, options: ProbeBudget = {}): Promise<CutByteProbe> {
  const safeLocator = validateProjectLocator(locator, "resource locator");
  const path = await resolveProjectFile(projectRoot, safeLocator);
  const budget = probeBudget(options);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    try {
      handle = await open(path, "r");
    } catch (error) {
      if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") {
        throw new CutProjectError("CUTP1015", `Project resource does not exist: ${safeLocator}`, path);
      }
      throw new CutProjectError("CUTP2011", `Cannot open resource for locking: ${error instanceof Error ? error.message : String(error)}`, path);
    }
    const [handleInitial, pathInitial] = await Promise.all([handle.stat({ bigint: true }), stat(path, { bigint: true })]);
    if (!handleInitial.isFile() || !pathInitial.isFile()) throw new CutProjectError("CUTP2005", "Resource locator must resolve to a regular file.", path);
    const initial = sourceSnapshot(handleInitial);
    assertStableSource(initial, [sourceSnapshot(pathInitial)], path);
    if (initial.size > BigInt(budget.maxFileBytes) || initial.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new CutProjectError("CUTP2006", `Resource exceeds the ${budget.maxFileBytes}-byte lock budget.`, path);
    }
    const bytes = Number(initial.size), digest = await sha256(handle, bytes);
    const [handleFinal, pathFinal] = await Promise.all([handle.stat({ bigint: true }), stat(path, { bigint: true })]);
    assertStableSource(initial, [sourceSnapshot(handleFinal), sourceSnapshot(pathFinal)], path);
    await assertStableLocator(projectRoot, safeLocator, path);
    return {
      format: "cut-byte-probe",
      version: 1,
      file: { locator: safeLocator, basename: posix.basename(safeLocator), bytes, sha256: digest },
    };
  } finally {
    await handle?.close();
  }
}

export async function probeProjectBytes(projectRoot: string, locator: string, options: ProbeBudget = {}) {
  return probeFileIdentity(projectRoot, locator, options);
}

const DEFAULT_IMAGE_BUDGET = {
  maxFileBytes: 512 * 1024 * 1024,
  maxPixels: 100_000_000,
  maxDimension: 32_768,
};

const HARD_IMAGE_BUDGET = {
  maxFileBytes: 1024 * 1024 * 1024,
  maxPixels: 268_435_456,
  maxDimension: 65_535,
};

function imageBudget(options: ImageProbeBudget) {
  const maxPixels = options.maxPixels ?? DEFAULT_IMAGE_BUDGET.maxPixels;
  const maxDimension = options.maxDimension ?? DEFAULT_IMAGE_BUDGET.maxDimension;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_IMAGE_BUDGET.maxFileBytes;
  for (const [name, value, maximum] of [
    ["maxFileBytes", maxFileBytes, HARD_IMAGE_BUDGET.maxFileBytes],
    ["maxPixels", maxPixels, HARD_IMAGE_BUDGET.maxPixels],
    ["maxDimension", maxDimension, HARD_IMAGE_BUDGET.maxDimension],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
      throw new CutProjectError("CUTP2007", `${name} must be a positive safe integer no greater than ${maximum}.`);
    }
  }
  const { maxPixels: _maxPixels, maxDimension: _maxDimension, ...fileOptions } = options;
  void _maxPixels; void _maxDimension;
  return { file: probeBudget({ ...fileOptions, maxFileBytes }), maxPixels, maxDimension };
}

export async function probeProjectImage(projectRoot: string, locator: string, options: ImageProbeBudget = {}): Promise<CutImageProbe> {
  const safeLocator = validateProjectLocator(locator, "image locator");
  const path = await resolveProjectFile(projectRoot, safeLocator);
  const budget = imageBudget(options);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    try {
      handle = await open(path, "r");
    } catch (error) {
      if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") {
        throw new CutProjectError("CUTP1015", `Project resource does not exist: ${safeLocator}`, path);
      }
      throw new CutProjectError("CUTP2011", `Cannot open image for probing: ${error instanceof Error ? error.message : String(error)}`, path);
    }
    const [handleInitial, pathInitial] = await Promise.all([handle.stat({ bigint: true }), stat(path, { bigint: true })]);
    if (!handleInitial.isFile() || !pathInitial.isFile()) throw new CutProjectError("CUTP2005", "Image locator must resolve to a regular file.", path);
    const initial = sourceSnapshot(handleInitial);
    assertStableSource(initial, [sourceSnapshot(pathInitial)], path);
    if (initial.size > BigInt(budget.file.maxFileBytes) || initial.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new CutProjectError("CUTP2006", `Image exceeds the ${budget.file.maxFileBytes}-byte probe budget.`, path);
    }
    const bytes = Number(initial.size);
    const buffer = await handle.readFile();
    if (buffer.byteLength !== bytes) throw new CutProjectError("CUTP2009", "Image changed while it was being read; no probe was produced.", path);
    const seconds = Math.max(1, Math.ceil(budget.file.timeoutMs / 1000));
    let metadata: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
    try {
      const pipeline = () => sharp(buffer, { limitInputPixels: budget.maxPixels, sequentialRead: true }).timeout({ seconds });
      const results = await Promise.all([
        pipeline().metadata(),
        pipeline().resize(1, 1, { fit: "fill" }).ensureAlpha().raw().toBuffer(),
      ]);
      metadata = results[0];
      if (results[1].byteLength !== 4) throw new Error("decoded image did not produce one RGBA pixel");
    } catch (error) {
      throw new CutProjectError("CUTP2101", `Image cannot be decoded within CUT's safety limits: ${error instanceof Error ? error.message : String(error)}`, path);
    }
    const [handleFinal, pathFinal] = await Promise.all([handle.stat({ bigint: true }), stat(path, { bigint: true })]);
    assertStableSource(initial, [sourceSnapshot(handleFinal), sourceSnapshot(pathFinal)], path);
    await assertStableLocator(projectRoot, safeLocator, path);

    const width = integer(metadata.width, 1), height = integer(metadata.height, 1), channels = integer(metadata.channels, 1);
    const format = boundedString(metadata.format, 64), space = boundedString(metadata.space, 64);
    if (!width || !height || !channels || !format || !space) throw new CutProjectError("CUTP2102", "Decoded image metadata is incomplete.", path);
    if (width > budget.maxDimension || height > budget.maxDimension || width * height > budget.maxPixels) {
      throw new CutProjectError("CUTP2103", `Decoded image exceeds ${budget.maxDimension}px per dimension or ${budget.maxPixels} pixels.`, path);
    }
    if ((metadata.pages ?? 1) !== 1 || (metadata.pageHeight !== undefined && metadata.pageHeight !== height)) {
      throw new CutProjectError("CUTP2104", "Animated and multi-page images require a future explicit sequence asset; ImageAsset accepts one image only.", path);
    }
    const versions = sharp.versions;
    const sharpVersion = boundedString(versions.sharp, 64), libvips = boundedString(versions.vips, 64);
    if (!sharpVersion || !libvips) throw new CutProjectError("CUTP2105", "Sharp did not expose bounded native implementation identities.", path);
    return {
      format: "cut-image-probe",
      version: 1,
      implementation: { name: "sharp", version: sharpVersion, libvips },
      file: {
        locator: safeLocator,
        basename: posix.basename(safeLocator),
        bytes,
        sha256: createHash("sha256").update(buffer).digest("hex"),
      },
      image: {
        width,
        height,
        format,
        space,
        channels,
        hasAlpha: metadata.hasAlpha === true,
        depth: boundedString(metadata.depth, 64),
        density: integer(metadata.density, 1),
        orientation: integer(metadata.orientation, 1),
      },
    };
  } finally {
    await handle?.close();
  }
}

export function mediaProbeLocator(projectRoot: string, absolutePath: string) {
  const locator = relative(projectRoot, absolutePath).replaceAll("\\", "/");
  return validateProjectLocator(locator, "media locator");
}
