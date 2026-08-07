import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { hash } from "../core/stable";
import { compareRational, zeroRational } from "../language/rational";
import { decodedVideoCadenceDuration } from "../language/video-cadence";
import { resolveProjectFile, validateProjectLocator } from "./manifest";
import {
  probeProjectDecodedVideoCadence,
  probeProjectMedia,
  probeProjectVideoProxyAlignment,
  type CutMediaProbe,
} from "./probe";
import { ensureProjectWriteDirectory } from "./write-boundary";

export const cutVideoProxyGenerationPolicy = Object.freeze({
  format: "cut-video-proxy-generation-policy",
  version: 1,
  container: "mp4",
  codec: "h264-libx264",
  preset: "veryfast",
  crf: 28,
  pixelFormat: "yuv420p",
  bFrames: 0,
  scaling: "exact-aspect-lanczos",
  audio: "excluded",
  metadata: "stripped",
  movFlags: "+frag_keyframe+empty_moov+default_base_moof",
  maximumWidth: 3_840,
  maximumDurationSeconds: 300,
  maximumOutputBytes: 2 * 1024 * 1024 * 1024,
} as const);

export type GenerateCutVideoProxyOptions = Readonly<{
  projectRoot: string;
  input: string;
  output: string;
  width: number;
  streamIndex?: number;
  /** Internal/focused-test lowering of the fixed ceiling; it can never raise it. */
  maximumOutputBytes?: number;
}>;

type CutProxyNativeToolIdentity = Readonly<{
  name: "ffmpeg" | "ffprobe";
  version: string;
  bannerSha256: string;
  executableSha256: string;
  executableBytes: number;
}>;

export type CutVideoProxyGenerationReport = Readonly<{
  format: "cut-video-proxy-generation-report";
  version: 1;
  status: "pass";
  policy: typeof cutVideoProxyGenerationPolicy;
  source: Readonly<{
    locator: string;
    sha256: string;
    bytes: number;
    streamIndex: number;
    width: number;
    height: number;
    decodedFrames: string;
  }>;
  proxy: Readonly<{
    locator: string;
    sha256: string;
    bytes: number;
    streamIndex: number;
    width: number;
    height: number;
    decodedFrames: string;
  }>;
  correspondence: Readonly<{
    format: "cut-video-proxy-alignment";
    version: 1;
    decision: "equivalent";
    meanAbsoluteErrorPpm: number;
    maximumFrameMeanAbsoluteErrorPpm: number;
    failedFrames: string;
    integrity: string;
  }>;
  toolchain: Readonly<{
    format: "cut-video-proxy-native-toolchain";
    version: 1;
    ffmpeg: CutProxyNativeToolIdentity;
    ffprobe: CutProxyNativeToolIdentity;
    integrity: string;
  }>;
  authoring: Readonly<{
    proxyArgument: string;
    next: readonly ["cut check", "cut lock", "cut preview"];
    note: string;
  }>;
}>;

export class CutVideoProxyGenerationError extends Error {
  constructor(readonly code: string, message: string, readonly path?: string) {
    super(`${code}: ${message}`);
    this.name = "CutVideoProxyGenerationError";
  }
}

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

type NativeExecutableSnapshot = Readonly<{
  path: string;
  sha256: string;
  bytes: number;
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;

const maximumNativeExecutableBytes = 256 * 1024 * 1024;
const maximumNativePathBytes = 16_384;
const maximumNativePathEnvironmentBytes = 128_000;

function toolchainFailure(message: string): never {
  throw new CutVideoProxyGenerationError("CUT_PROXY_GENERATE_TOOLCHAIN", message);
}

async function snapshotNativeExecutable(path: string, tool: "ffmpeg" | "ffprobe"): Promise<NativeExecutableSnapshot> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (typeof fsConstants.O_NOFOLLOW !== "number") toolchainFailure(`platform cannot bind ${tool} to a no-follow executable handle.`);
    const physical = await realpath(path);
    if (!isAbsolute(physical) || physical.includes("\0") || Buffer.byteLength(physical, "utf8") > maximumNativePathBytes) {
      toolchainFailure(`${tool} did not resolve to one bounded absolute executable path.`);
    }
    const pathMetadata = await lstat(physical, { bigint: true });
    if (pathMetadata.isSymbolicLink()
      || !pathMetadata.isFile()
      || pathMetadata.size < 1n
      || pathMetadata.size > BigInt(maximumNativeExecutableBytes)
      || (process.platform !== "win32" && (pathMetadata.mode & 0o111n) === 0n)) {
      toolchainFailure(`${tool} must resolve to one bounded executable regular file.`);
    }
    handle = await open(physical, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()
      || before.dev !== pathMetadata.dev
      || before.ino !== pathMetadata.ino
      || before.size !== pathMetadata.size
      || before.mtimeNs !== pathMetadata.mtimeNs
      || before.ctimeNs !== pathMetadata.ctimeNs) {
      toolchainFailure(`${tool} path and no-follow handle do not identify the same executable.`);
    }
    const digest = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 1024 * 1024 })) digest.update(chunk);
    const after = await handle.stat({ bigint: true }), afterPath = await lstat(physical, { bigint: true });
    if (before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
      || after.dev !== afterPath.dev
      || after.ino !== afterPath.ino
      || after.size !== afterPath.size
      || after.mtimeNs !== afterPath.mtimeNs
      || after.ctimeNs !== afterPath.ctimeNs) {
      toolchainFailure(`${tool} changed while CUT snapshotted its executable identity.`);
    }
    return Object.freeze({
      path: physical,
      sha256: digest.digest("hex"),
      bytes: Number(before.size),
      dev: before.dev,
      ino: before.ino,
      size: before.size,
      mtimeNs: before.mtimeNs,
      ctimeNs: before.ctimeNs,
    });
  } catch (error) {
    if (error instanceof CutVideoProxyGenerationError) throw error;
    throw new CutVideoProxyGenerationError(
      "CUT_PROXY_GENERATE_TOOLCHAIN",
      `${tool} executable identity could not be collected (${errorCode(error) ?? "UNKNOWN"}).`,
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function resolveNativeExecutable(tool: "ffmpeg" | "ffprobe") {
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const environmentPath = process.env[pathKey];
  if (typeof environmentPath !== "string"
    || !environmentPath
    || environmentPath.includes("\0")
    || Buffer.byteLength(environmentPath, "utf8") > maximumNativePathEnvironmentBytes) {
    toolchainFailure("PATH must be one bounded non-empty executable search path.");
  }
  const names = process.platform === "win32" ? [`${tool}.exe`, tool] : [tool];
  for (const directory of environmentPath.split(delimiter)) {
    if (!directory || !isAbsolute(directory)) continue;
    for (const name of names) {
      try {
        return await snapshotNativeExecutable(resolve(directory, name), tool);
      } catch (error) {
        if (errorCode(error) !== "CUT_PROXY_GENERATE_TOOLCHAIN") throw error;
      }
    }
  }
  toolchainFailure(`PATH did not resolve one bounded ${tool} executable.`);
}

function collectNativeVersion(executable: NativeExecutableSnapshot, tool: "ffmpeg" | "ffprobe") {
  return new Promise<string>((accept, reject) => {
    const child = spawn(executable.path, ["-version"], { shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let stdoutBytes = 0, stderrBytes = 0, settled = false;
    const finish = (error?: Error, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else accept(value!);
    };
    const abort = (message: string) => {
      child.kill("SIGKILL");
      finish(new CutVideoProxyGenerationError("CUT_PROXY_GENERATE_TOOLCHAIN", message));
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > 128_000 || stdoutBytes + stderrBytes > 144_000) abort(`${tool} version output exceeded CUT's bound.`);
      else stdout.push(Buffer.from(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > 16_000 || stdoutBytes + stderrBytes > 144_000) abort(`${tool} version output exceeded CUT's bound.`);
      else stderr.push(Buffer.from(chunk));
    });
    child.on("error", (error) => finish(new CutVideoProxyGenerationError("CUT_PROXY_GENERATE_TOOLCHAIN", `${tool} identity process failed (${errorCode(error) ?? "UNKNOWN"}).`)));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) return finish(new CutVideoProxyGenerationError("CUT_PROXY_GENERATE_TOOLCHAIN", `${tool} identity process exited ${code ?? "UNKNOWN"}.`));
      finish(undefined, Buffer.concat(stdout, stdoutBytes).toString("utf8"));
    });
    const timer = setTimeout(() => abort(`${tool} identity process exceeded 30000ms.`), 30_000);
  });
}

async function bindNativeTool(tool: "ffmpeg" | "ffprobe") {
  const executable = await resolveNativeExecutable(tool);
  const rawBanner = (await collectNativeVersion(executable, tool)).replaceAll("\r\n", "\n").trim();
  const version = rawBanner.split("\n", 1)[0] ?? "";
  if (!version.startsWith(`${tool} version `) || version.length > 4_096 || /[\0\r\n]/u.test(version)) {
    toolchainFailure(`${tool} did not provide one bounded implementation banner.`);
  }
  const identity = Object.freeze({
    name: tool,
    version,
    bannerSha256: hash(rawBanner),
    executableSha256: executable.sha256,
    executableBytes: executable.bytes,
  });
  const verify = async () => {
    const current = await snapshotNativeExecutable(executable.path, tool);
    if (current.path !== executable.path
      || current.sha256 !== executable.sha256
      || current.bytes !== executable.bytes
      || current.dev !== executable.dev
      || current.ino !== executable.ino
      || current.size !== executable.size
      || current.mtimeNs !== executable.mtimeNs
      || current.ctimeNs !== executable.ctimeNs) {
      toolchainFailure(`${tool} changed during proxy generation.`);
    }
  };
  await verify();
  return Object.freeze({ executablePath: executable.path, identity, verify });
}

async function optionalEntry(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

async function encodeBoundedProxy(
  executable: string,
  args: readonly string[],
  staged: string,
  outputLocator: string,
  maximumOutputBytes: number,
) {
  if (typeof fsConstants.O_NOFOLLOW !== "number") {
    throw new CutVideoProxyGenerationError("CUT_PROXY_GENERATE_ENCODE", "platform cannot create a no-follow proxy staging file.");
  }
  const output = await open(
    staged,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600,
  );
  let child: ReturnType<typeof spawn> | undefined;
  try {
    child = spawn(executable, [...args, "-f", "mp4", "pipe:1"], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let terminalError: CutVideoProxyGenerationError | undefined;
    let outputBytes = 0;
    let stderrBytes = 0;
    const stderr: Buffer[] = [];
    const abort = (error: CutVideoProxyGenerationError) => {
      if (!terminalError) terminalError = error;
      child?.kill("SIGKILL");
    };
    const timer = setTimeout(
      () => abort(new CutVideoProxyGenerationError("CUT_PROXY_GENERATE_ENCODE", "proxy encode exceeded 1800000ms.", outputLocator)),
      30 * 60 * 1_000,
    );
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((accept) => {
      child!.on("error", (error) => {
        abort(new CutVideoProxyGenerationError(
          "CUT_PROXY_GENERATE_ENCODE",
          `cannot start bound FFmpeg proxy encode (${errorCode(error) ?? "UNKNOWN"}).`,
          outputLocator,
        ));
      });
      child!.on("close", (code, signal) => accept({ code, signal }));
    });
    const picture = (async () => {
      if (!child?.stdout) {
        abort(new CutVideoProxyGenerationError("CUT_PROXY_GENERATE_ENCODE", "FFmpeg proxy encode exposed no picture-output pipe.", outputLocator));
        return;
      }
      try {
        for await (const value of child.stdout) {
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
          if (outputBytes + chunk.byteLength >= maximumOutputBytes) {
            abort(new CutVideoProxyGenerationError(
              "CUT_PROXY_GENERATE_OUTPUT_LIMIT",
              `encoded proxy reached CUT's ${maximumOutputBytes}-byte staging ceiling; no output was published.`,
              outputLocator,
            ));
            return;
          }
          let offset = 0;
          while (offset < chunk.byteLength) {
            const written = await output.write(chunk, offset, chunk.byteLength - offset, outputBytes + offset);
            if (written.bytesWritten < 1) throw new Error("staging write made no progress");
            offset += written.bytesWritten;
          }
          outputBytes += chunk.byteLength;
        }
      } catch (error) {
        abort(new CutVideoProxyGenerationError(
          "CUT_PROXY_GENERATE_ENCODE",
          `cannot write bounded proxy staging bytes (${errorCode(error) ?? "UNKNOWN"}).`,
          outputLocator,
        ));
      }
    })();
    const diagnostics = (async () => {
      if (!child?.stderr) {
        abort(new CutVideoProxyGenerationError("CUT_PROXY_GENERATE_ENCODE", "FFmpeg proxy encode exposed no diagnostic pipe.", outputLocator));
        return;
      }
      try {
        for await (const value of child.stderr) {
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
          const remaining = 128_000 - stderrBytes;
          if (remaining > 0) stderr.push(Buffer.from(chunk.subarray(0, remaining)));
          stderrBytes += chunk.byteLength;
          if (stderrBytes > 128_000) {
            abort(new CutVideoProxyGenerationError("CUT_PROXY_GENERATE_ENCODE", "FFmpeg proxy diagnostics exceeded CUT's 128000-byte bound.", outputLocator));
            return;
          }
        }
      } catch (error) {
        abort(new CutVideoProxyGenerationError(
          "CUT_PROXY_GENERATE_ENCODE",
          `cannot read bounded FFmpeg proxy diagnostics (${errorCode(error) ?? "UNKNOWN"}).`,
          outputLocator,
        ));
      }
    })();
    let status: { code: number | null; signal: NodeJS.Signals | null };
    try {
      [status] = await Promise.all([exit, picture, diagnostics]);
    } finally {
      clearTimeout(timer);
    }
    if (terminalError) throw terminalError;
    if (status.code !== 0) {
      throw new CutVideoProxyGenerationError(
        "CUT_PROXY_GENERATE_ENCODE",
        `FFmpeg proxy encode exited ${status.code ?? status.signal ?? "UNKNOWN"}: ${Buffer.concat(stderr, Math.min(stderrBytes, 128_000)).toString("utf8").trim()}`,
        outputLocator,
      );
    }
    if (outputBytes < 1) {
      throw new CutVideoProxyGenerationError("CUT_PROXY_GENERATE_ENCODE", "FFmpeg proxy encode emitted no bytes.", outputLocator);
    }
    await output.sync();
    return outputBytes;
  } finally {
    child?.kill("SIGKILL");
    await output.close().catch(() => undefined);
  }
}

function selectedVideoStream(identity: CutMediaProbe, authored: number | undefined) {
  if (authored !== undefined && (!Number.isSafeInteger(authored) || authored < 0)) {
    throw new CutVideoProxyGenerationError("CUT_PROXY_GENERATE_STREAM", "--stream must be one non-negative safe integer.");
  }
  const videos = identity.streams.filter((stream) => stream.type === "video");
  if (authored === undefined) {
    if (videos.length !== 1) {
      throw new CutVideoProxyGenerationError(
        "CUT_PROXY_GENERATE_STREAM",
        `source exposes ${videos.length} video streams; select exactly one with --stream.`,
        identity.file.locator,
      );
    }
    return videos[0];
  }
  const selected = identity.streams.find((stream) => stream.index === authored);
  if (!selected || selected.type !== "video") {
    throw new CutVideoProxyGenerationError(
      "CUT_PROXY_GENERATE_STREAM",
      `source stream ${authored} is not a video stream.`,
      identity.file.locator,
    );
  }
  return selected;
}

function exactProxyGeometry(width: number, sourceWidth: number | undefined, sourceHeight: number | undefined) {
  if (!Number.isSafeInteger(width) || width < 64 || width > cutVideoProxyGenerationPolicy.maximumWidth || width % 2 !== 0) {
    throw new CutVideoProxyGenerationError(
      "CUT_PROXY_GENERATE_GEOMETRY",
      `--width must be one even integer from 64 through ${cutVideoProxyGenerationPolicy.maximumWidth}.`,
    );
  }
  if (!sourceWidth || !sourceHeight) {
    throw new CutVideoProxyGenerationError("CUT_PROXY_GENERATE_GEOMETRY", "selected source video has no exact positive coded dimensions.");
  }
  if (width > sourceWidth) {
    throw new CutVideoProxyGenerationError("CUT_PROXY_GENERATE_GEOMETRY", `proxy width ${width} would upscale the ${sourceWidth}px source.`);
  }
  const heightNumerator = sourceHeight * width;
  if (!Number.isSafeInteger(heightNumerator) || heightNumerator % sourceWidth !== 0) {
    throw new CutVideoProxyGenerationError(
      "CUT_PROXY_GENERATE_GEOMETRY",
      `proxy width ${width} cannot preserve the exact ${sourceWidth}:${sourceHeight} coded aspect ratio at an integer height.`,
    );
  }
  const height = heightNumerator / sourceWidth;
  if (height < 2 || height % 2 !== 0) {
    throw new CutVideoProxyGenerationError(
      "CUT_PROXY_GENERATE_GEOMETRY",
      `proxy width ${width} produces ${height}px height, which is not a positive even H.264 4:2:0 dimension.`,
    );
  }
  return { width, height };
}

function assertZeroStart(identity: CutMediaProbe, stream: CutMediaProbe["streams"][number]) {
  if (!stream.start || compareRational(stream.start, zeroRational) !== 0) {
    throw new CutVideoProxyGenerationError(
      "CUT_PROXY_GENERATE_START",
      "the alpha proxy generator currently requires a selected picture stream starting at exact 0s; nonzero-origin preservation remains unsupported.",
      identity.file.locator,
    );
  }
}

function assertBoundedDuration(
  identity: CutMediaProbe,
  stream: CutMediaProbe["streams"][number],
  cadence: Awaited<ReturnType<typeof probeProjectDecodedVideoCadence>>,
) {
  const duration = decodedVideoCadenceDuration(cadence, stream);
  if (compareRational(duration, { numerator: String(cutVideoProxyGenerationPolicy.maximumDurationSeconds), denominator: "1" }) > 0) {
    throw new CutVideoProxyGenerationError(
      "CUT_PROXY_GENERATE_DURATION",
      `selected picture exceeds the ${cutVideoProxyGenerationPolicy.maximumDurationSeconds}s alpha proxy-generation bound.`,
      identity.file.locator,
    );
  }
  return duration;
}

function safeLocator(value: string, label: string) {
  try {
    return validateProjectLocator(value, label);
  } catch (error) {
    throw new CutVideoProxyGenerationError(
      "CUT_PROXY_GENERATE_LOCATOR",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Generate one bounded picture-only preview proxy.
 *
 * This deliberately does not mutate CUT source. The returned `proxyArgument`
 * is authored into `video(..., proxy: ...)`, after which `cut lock` performs
 * the authoritative temporal/content equivalence check again.
 */
export async function generateCutVideoProxy(options: GenerateCutVideoProxyOptions): Promise<CutVideoProxyGenerationReport> {
  const root = await realpath(resolve(options.projectRoot));
  const input = safeLocator(options.input, "proxy source locator");
  const output = safeLocator(options.output, "proxy output locator");
  const maximumOutputBytes = options.maximumOutputBytes ?? cutVideoProxyGenerationPolicy.maximumOutputBytes;
  if (!Number.isSafeInteger(maximumOutputBytes)
    || maximumOutputBytes < 4_096
    || maximumOutputBytes > cutVideoProxyGenerationPolicy.maximumOutputBytes) {
    throw new CutVideoProxyGenerationError(
      "CUT_PROXY_GENERATE_OUTPUT_LIMIT",
      `maximumOutputBytes must be one safe integer from 4096 through ${cutVideoProxyGenerationPolicy.maximumOutputBytes}.`,
    );
  }
  if (!output.toLowerCase().endsWith(".mp4")) {
    throw new CutVideoProxyGenerationError("CUT_PROXY_GENERATE_CONTAINER", "proxy output must end in .mp4.");
  }
  if (input === output) {
    throw new CutVideoProxyGenerationError("CUT_PROXY_GENERATE_COLLISION", "proxy output must differ from its source.", output);
  }
  const [ffmpeg, ffprobe] = await Promise.all([bindNativeTool("ffmpeg"), bindNativeTool("ffprobe")]);
  const nativeExecutables = Object.freeze({ ffmpeg: ffmpeg.executablePath, ffprobe: ffprobe.executablePath });
  await resolveProjectFile(root, input);
  const sourceIdentity = await probeProjectMedia(root, input, {}, nativeExecutables);
  const sourceStream = selectedVideoStream(sourceIdentity, options.streamIndex);
  assertZeroStart(sourceIdentity, sourceStream);
  const geometry = exactProxyGeometry(options.width, sourceStream.width, sourceStream.height);
  const sourceCadence = await probeProjectDecodedVideoCadence(root, input, sourceIdentity, sourceStream.index, {}, nativeExecutables);
  const sourceDuration = assertBoundedDuration(sourceIdentity, sourceStream, sourceCadence);

  const outputParentLocator = dirname(output).split(sep).join("/");
  const outputParent = outputParentLocator === "."
    ? root
    : await ensureProjectWriteDirectory(root, outputParentLocator);
  const destination = resolve(outputParent, basename(output));
  if (await optionalEntry(destination)) {
    throw new CutVideoProxyGenerationError("CUT_PROXY_GENERATE_COLLISION", "proxy generation refuses to overwrite an existing output.", output);
  }

  const staging = await mkdtemp(resolve(outputParent, `.cut-proxy-${randomUUID()}-`));
  const staged = resolve(staging, "proxy.mp4");
  const stagedLocator = relative(root, staged).split(sep).join("/");
  let published = false;
  try {
    const timescale = sourceStream.timeBase?.denominator;
    if (!timescale || !/^[1-9][0-9]*$/u.test(timescale)) {
      throw new CutVideoProxyGenerationError("CUT_PROXY_GENERATE_TIMEBASE", "selected source video has no bounded exact codec time-base denominator.", input);
    }
    await encodeBoundedProxy(ffmpeg.executablePath, [
      "-nostdin",
      "-hide_banner",
      "-loglevel", "error",
      "-i", await resolveProjectFile(root, input),
      "-map", `0:${sourceStream.index}`,
      "-an",
      "-sn",
      "-dn",
      "-map_metadata", "-1",
      "-map_chapters", "-1",
      "-vf", `scale=${geometry.width}:${geometry.height}:flags=lanczos,setsar=1`,
      "-fps_mode", "passthrough",
      "-c:v", "libx264",
      "-preset", cutVideoProxyGenerationPolicy.preset,
      "-crf", String(cutVideoProxyGenerationPolicy.crf),
      "-pix_fmt", cutVideoProxyGenerationPolicy.pixelFormat,
      "-bf", String(cutVideoProxyGenerationPolicy.bFrames),
      "-video_track_timescale", timescale,
      "-movflags", cutVideoProxyGenerationPolicy.movFlags,
    ], staged, output, maximumOutputBytes);
    await ffmpeg.verify();
    const stagedMetadata = await lstat(staged, { bigint: true });
    if (!stagedMetadata.isFile() || stagedMetadata.size >= BigInt(maximumOutputBytes)) {
      throw new CutVideoProxyGenerationError(
        "CUT_PROXY_GENERATE_OUTPUT_LIMIT",
        `encoded proxy reached CUT's ${maximumOutputBytes}-byte staging ceiling; no output was published.`,
        output,
      );
    }

    const proxyIdentity = await probeProjectMedia(root, stagedLocator, {}, nativeExecutables);
    const proxyStream = selectedVideoStream(proxyIdentity, undefined);
    assertZeroStart(proxyIdentity, proxyStream);
    if (proxyStream.width !== geometry.width || proxyStream.height !== geometry.height) {
      throw new CutVideoProxyGenerationError(
        "CUT_PROXY_GENERATE_GEOMETRY",
        `encoded proxy dimensions ${proxyStream.width ?? "?"}x${proxyStream.height ?? "?"} do not match ${geometry.width}x${geometry.height}.`,
        output,
      );
    }
    const proxyCadence = await probeProjectDecodedVideoCadence(root, stagedLocator, proxyIdentity, proxyStream.index, {}, nativeExecutables);
    const proxyDuration = decodedVideoCadenceDuration(proxyCadence, proxyStream);
    if (proxyCadence.frameCount !== sourceCadence.frameCount
      || compareRational(proxyCadence.frameRate, sourceCadence.frameRate) !== 0
      || compareRational(proxyDuration, sourceDuration) !== 0) {
      throw new CutVideoProxyGenerationError(
        "CUT_PROXY_GENERATE_TIMING",
        "encoded proxy does not preserve the selected source frame count, frame rate, and exact semantic duration.",
        output,
      );
    }
    const alignment = await probeProjectVideoProxyAlignment(
      root,
      input,
      sourceIdentity,
      sourceCadence,
      stagedLocator,
      proxyIdentity,
      proxyCadence,
      {},
      nativeExecutables,
    );
    await Promise.all([ffmpeg.verify(), ffprobe.verify()]);
    try {
      // A same-filesystem hard link is the no-clobber publication primitive:
      // unlike rename(), it atomically refuses a destination that appeared
      // while encoding or correspondence verification was in flight.
      await link(staged, destination);
    } catch (error) {
      if (errorCode(error) === "EEXIST") {
        throw new CutVideoProxyGenerationError("CUT_PROXY_GENERATE_COLLISION", "proxy generation refuses to overwrite an existing output.", output);
      }
      throw new CutVideoProxyGenerationError(
        "CUT_PROXY_GENERATE_PUBLICATION",
        `cannot publish the verified proxy (${errorCode(error) ?? "UNKNOWN"}).`,
        output,
      );
    }
    published = true;
    return Object.freeze({
      format: "cut-video-proxy-generation-report",
      version: 1,
      status: "pass",
      policy: cutVideoProxyGenerationPolicy,
      source: Object.freeze({
        locator: input,
        sha256: sourceIdentity.file.sha256,
        bytes: sourceIdentity.file.bytes,
        streamIndex: sourceStream.index,
        width: sourceStream.width!,
        height: sourceStream.height!,
        decodedFrames: sourceCadence.frameCount,
      }),
      proxy: Object.freeze({
        locator: output,
        sha256: proxyIdentity.file.sha256,
        bytes: proxyIdentity.file.bytes,
        streamIndex: proxyStream.index,
        width: proxyStream.width!,
        height: proxyStream.height!,
        decodedFrames: proxyCadence.frameCount,
      }),
      correspondence: Object.freeze({
        format: alignment.format,
        version: alignment.version,
        decision: alignment.decision,
        meanAbsoluteErrorPpm: alignment.metrics.meanAbsoluteErrorPpm,
        maximumFrameMeanAbsoluteErrorPpm: alignment.metrics.maximumFrameMeanAbsoluteErrorPpm,
        failedFrames: alignment.metrics.failedFrames,
        integrity: alignment.integrity,
      }),
      toolchain: (() => {
        const content = Object.freeze({
          format: "cut-video-proxy-native-toolchain" as const,
          version: 1 as const,
          ffmpeg: ffmpeg.identity,
          ffprobe: ffprobe.identity,
        });
        return Object.freeze({ ...content, integrity: hash(content) });
      })(),
      authoring: Object.freeze({
        proxyArgument: `proxy: ${JSON.stringify(output)}`,
        next: ["cut check", "cut lock", "cut preview"] as const,
        note: "Generated bytes are inert until this proxy locator is authored on the VideoAsset and a fresh cut.lock accepts equivalence.",
      }),
    });
  } finally {
    if (!published) await rm(staged, { force: true }).catch(() => undefined);
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}
