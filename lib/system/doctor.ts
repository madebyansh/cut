import { spawn } from "node:child_process";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { cutCompilerIdentity, cutIrVersion, cutLanguageVersion, cutPackageAbi, cutProductVersion, cutReferenceRuntimeIdentity } from "../version";
import { processReferenceAudioLimiter, referenceAudioLimiterIdentity } from "../runtime/reference/audio-limiter";

export type CutDoctorCheck = {
  code: string;
  name: string;
  status: "pass" | "fail";
  detail: string;
  remedy?: string;
};

export type CutDoctorReport = {
  format: "cut-doctor-report";
  version: 1;
  status: "pass" | "fail";
  cut: {
    product: string;
    language: string;
    compiler: string;
    ir: number;
    packageAbi: number;
    runtime: string;
  };
  platform: { os: NodeJS.Platform; architecture: string; node: string };
  checks: CutDoctorCheck[];
};

export type CutDoctorToolResult = { status: "pass" | "fail"; stdout: string; detail: string };
type ToolRunner = (command: string, args: string[], timeoutMs?: number, maxOutputBytes?: number) => Promise<CutDoctorToolResult>;
type CutDoctorOptions = Readonly<{
  runTool?: ToolRunner;
  temporaryRoot?: string;
  /** @internal deterministic platform-capability test seam. */
  platform?: NodeJS.Platform;
}>;

const maximumCapabilityArtifactBytes = 1024 * 1024;
const writableProbeBytes = Buffer.from("cut-doctor-write-probe\n", "utf8");

/** @internal Exported so the bounded subprocess lifecycle can be tested without
 * substituting a fake runner. It is not a CUT language or package API. */
export async function runBoundedDoctorTool(command: string, args: string[], timeoutMs = 5_000, maxOutputBytes = 2 * 1024 * 1024): Promise<CutDoctorToolResult> {
  return new Promise((accept) => {
    const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const output: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const timing: { timer?: NodeJS.Timeout } = {};
    let terminationFailure: CutDoctorToolResult | undefined;
    const finish = (result: CutDoctorToolResult) => {
      if (settled) return;
      settled = true;
      if (timing.timer) clearTimeout(timing.timer);
      accept(result);
    };
    const terminate = (failure: CutDoctorToolResult) => {
      if (settled || terminationFailure) return;
      terminationFailure = failure;
      output.length = 0;
      // Never return while a timed-out or overproducing native process may
      // still own files in the private workspace. `exit` proves termination;
      // successful processes wait for `close` so bounded output is complete.
      if (child.exitCode !== null || child.signalCode !== null) {
        finish(failure);
        return;
      }
      child.kill("SIGKILL");
    };
    const collect = (chunk: Buffer) => {
      if (terminationFailure) return;
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        terminate({ status: "fail", stdout: "", detail: `native tool exceeded the ${maxOutputBytes}-byte diagnostic output budget` });
      } else output.push(Buffer.from(chunk));
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (error) => {
      if (terminationFailure) {
        finish(terminationFailure);
        return;
      }
      const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "START_FAILED";
      finish({ status: "fail", stdout: "", detail: `native tool could not be started (${code})` });
    });
    child.on("exit", () => {
      if (terminationFailure) finish(terminationFailure);
    });
    child.on("close", (code, signal) => {
      if (terminationFailure) {
        finish(terminationFailure);
        return;
      }
      const stdout = Buffer.concat(output).toString("utf8");
      if (code === 0) finish({ status: "pass", stdout, detail: stdout.split(/\r?\n/, 1)[0].trim() });
      else finish({ status: "fail", stdout, detail: `native tool exited with ${code ?? signal}` });
    });
    timing.timer = setTimeout(() => {
      terminate({ status: "fail", stdout: "", detail: `native tool exceeded the ${timeoutMs}ms diagnostic timeout` });
    }, timeoutMs);
  });
}

function availableVersion(tool: "FFmpeg" | "FFprobe", source: string) {
  const match = source.match(new RegExp(`^${tool.toLowerCase()} version ([^\\s]+)`, "im"));
  const token = match?.[1];
  return token && /^[A-Za-z0-9][A-Za-z0-9._+~-]{0,63}$/.test(token) ? `${tool} ${token}` : `${tool} is available`;
}

function failedCheck(code: string, name: string, detail: string, remedy: string): CutDoctorCheck {
  return { code, name, status: "fail", detail, remedy };
}

/** @internal Pure supported-Node contract used by doctor and tests. */
export function cutDoctorNodeVersionCheck(version: string): CutDoctorCheck {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?$/.exec(version);
  const major = match ? Number(match[1]) : Number.NaN;
  return major === 20
    ? { code: "CUTD1000", name: "Node.js", status: "pass", detail: `Node.js ${version}` }
    : failedCheck("CUTD1001", "Node.js", `Node.js ${version} is unsupported`, "Install a Node.js 20.x release. CUT's scoped release does not admit later Node majors without a new compatibility proof.");
}

/** @internal Pure platform-capability contract used by doctor and tests. */
export function cutDoctorMediaInputPlatformCheck(operatingSystem: NodeJS.Platform): CutDoctorCheck {
  return operatingSystem === "win32"
    ? failedCheck("CUTD1003", "Media input platform", "Windows media lock/probe/render is unsupported because this runtime cannot pass an already-open input descriptor to ffprobe safely.", "Use the current macOS or Linux runtime; Windows support remains a pre-1.0 release gate.")
    : { code: "CUTD1002", name: "Media input platform", status: "pass", detail: `${operatingSystem} supports descriptor-bound native media probing` };
}

function referenceLimiterCheck(): CutDoctorCheck {
  try {
    const input = new Float32Array([
      0, 0,
      0.9, -0.45,
      -0.9, 0.45,
      0, 0,
    ]);
    const ceilingDbtp = -1;
    const result = processReferenceAudioLimiter(input, {
      sampleRate: 48_000,
      lookaheadSamples: 2,
      ceilingDbtp: () => ceilingDbtp,
      releaseSeconds: () => 0.05,
      source: { module: "<cut-doctor-limiter>", line: 1, column: 1 },
    });
    const ceiling = 10 ** (ceilingDbtp / 20);
    if (result.algorithm !== referenceAudioLimiterIdentity
      || result.output.length !== input.length
      || result.outputTruePeakEnvelope.some((peak) => !Number.isFinite(peak) || peak > ceiling)) {
      throw new Error("limiter self-check mismatch");
    }
    return { code: "CUTD1140", name: "CUT-owned limiter", status: "pass", detail: `${referenceAudioLimiterIdentity} verified on an exact stereo f32 boundary` };
  } catch {
    return failedCheck("CUTD1141", "CUT-owned limiter", "The deterministic limiter self-check did not preserve its exact true-peak contract.", "Reinstall the exact cut-lang package and rerun cut doctor.");
  }
}

function mediaFailure(result: CutDoctorToolResult): CutDoctorCheck {
  const output = result.stdout;
  const missing = /(?:no such filter|filter not found|unknown filter|option not found)/i.test(output);
  if (missing && /loudnorm/i.test(output)) {
    return failedCheck("CUTD1131", "Reference media pipeline", "FFmpeg does not provide the loudnorm mastering filter.", "Install an FFmpeg build with the loudnorm audio filter enabled.");
  }
  if (missing && /(?:aformat|volume|aresample)/i.test(output)) {
    return failedCheck("CUTD1131", "Reference media pipeline", "FFmpeg does not provide CUT's required reference audio filter chain.", "Install a complete FFmpeg build with aformat, volume, aresample, and loudnorm filters.");
  }
  if (/libx264/i.test(output) && /(?:unknown encoder|encoder not found|not compiled|unavailable)/i.test(output)) {
    return failedCheck("CUTD1131", "Reference media pipeline", "FFmpeg cannot encode H.264 with libx264.", "Install an FFmpeg build with the libx264 encoder enabled.");
  }
  if (/\baac\b/i.test(output) && /(?:unknown encoder|encoder not found|not compiled|unavailable)/i.test(output)) {
    return failedCheck("CUTD1131", "Reference media pipeline", "FFmpeg cannot encode AAC audio.", "Install an FFmpeg build with the AAC encoder enabled.");
  }
  if (/timeout/i.test(result.detail)) {
    return failedCheck("CUTD1131", "Reference media pipeline", "The bounded FFmpeg capability probe timed out.", "Check the FFmpeg installation and available CPU/temp-space resources, then rerun cut doctor.");
  }
  if (/output budget/i.test(result.detail)) {
    return failedCheck("CUTD1131", "Reference media pipeline", "FFmpeg exceeded CUT's bounded diagnostic output limit.", "Repair the FFmpeg installation so the tiny reference probe completes without unbounded diagnostics.");
  }
  return failedCheck("CUTD1131", "Reference media pipeline", "FFmpeg could not encode CUT's bounded H.264/AAC mastering probe.", "Install a complete FFmpeg build with libx264, AAC, and CUT's required audio filters, then rerun cut doctor.");
}

async function probeReferenceMedia(directory: string, run: ToolRunner, ffmpegAvailable: boolean, ffprobeAvailable: boolean): Promise<CutDoctorCheck> {
  if (!ffmpegAvailable || !ffprobeAvailable) {
    return failedCheck("CUTD1131", "Reference media pipeline", "The reference-media probe requires both FFmpeg and ffprobe.", "Resolve the FFmpeg and ffprobe checks above, then rerun cut doctor.");
  }
  const picture = resolve(directory, "picture.rgba");
  const output = resolve(directory, "capability.mp4");
  try {
    // Two 16x16 RGBA frames exercise the same raw-picture input family as the
    // reference encoder without depending on an unrelated synthetic-video
    // filter or retaining a user/project asset.
    await writeFile(picture, Buffer.alloc(16 * 16 * 4 * 2, 0x10), { flag: "wx", mode: 0o600 });
    const encoded = await run("ffmpeg", [
      "-nostdin", "-y", "-hide_banner", "-loglevel", "error",
      "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", "16x16", "-framerate", "8", "-i", picture,
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=0.25",
      "-filter_complex", "[1:a]aformat=sample_fmts=fltp:channel_layouts=stereo,volume=0.5,aresample=96000,aresample=48000,loudnorm=I=-14:TP=-1:LRA=9[audio]",
      "-map", "0:v:0", "-map", "[audio]", "-t", "0.25",
      "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "256000", "-ar", "48000", "-ac", "2",
      "-movflags", "+faststart", output,
    ], 15_000, 256 * 1024);
    if (encoded.status === "fail") return mediaFailure(encoded);

    const metadata = await lstat(output).catch(() => undefined);
    if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > maximumCapabilityArtifactBytes) {
      return failedCheck("CUTD1131", "Reference media pipeline", "FFmpeg did not produce a bounded regular media artifact.", "Check temp-space availability and install a complete FFmpeg build, then rerun cut doctor.");
    }

    const probed = await run("ffprobe", [
      "-v", "error",
      "-count_frames",
      "-show_entries", "format=format_name,duration:stream=codec_name,codec_type,pix_fmt,sample_rate,channels,width,height,avg_frame_rate,nb_read_frames,duration",
      "-of", "json", output,
    ], 10_000, 256 * 1024);
    if (probed.status === "fail") {
      return failedCheck("CUTD1131", "Reference media pipeline", "FFprobe could not inspect CUT's bounded reference artifact.", "Install the ffprobe binary distributed with FFmpeg and ensure it can inspect MP4/H.264/AAC media.");
    }

    let report: unknown;
    try {
      report = JSON.parse(probed.stdout);
    } catch {
      return failedCheck("CUTD1131", "Reference media pipeline", "FFprobe returned invalid JSON for CUT's bounded reference artifact.", "Repair or reinstall ffprobe, then rerun cut doctor.");
    }
    const value = report && typeof report === "object" && !Array.isArray(report) ? report as Record<string, unknown> : {};
    const streams = Array.isArray(value.streams) ? value.streams.filter((stream): stream is Record<string, unknown> => Boolean(stream) && typeof stream === "object" && !Array.isArray(stream)) : [];
    const video = streams.find((stream) => stream.codec_type === "video");
    const audio = streams.find((stream) => stream.codec_type === "audio");
    const format = value.format && typeof value.format === "object" && !Array.isArray(value.format) ? value.format as Record<string, unknown> : {};
    const duration = Number(format.duration);
    const videoDuration = Number(video?.duration);
    const audioDuration = Number(audio?.duration);
    const frameRateParts = typeof video?.avg_frame_rate === "string" ? video.avg_frame_rate.split("/").map(Number) : [];
    const frameRate = frameRateParts.length === 2 && Number.isFinite(frameRateParts[0]) && Number.isFinite(frameRateParts[1]) && frameRateParts[1] !== 0
      ? frameRateParts[0] / frameRateParts[1]
      : Number.NaN;
    if (video?.codec_name !== "h264" || video.pix_fmt !== "yuv420p"
      || video.width !== 16 || video.height !== 16 || video.nb_read_frames !== "2" || frameRate !== 8
      || !Number.isFinite(videoDuration) || videoDuration < 0.24 || videoDuration > 0.26
      || audio?.codec_name !== "aac" || audio.sample_rate !== "48000" || audio.channels !== 2
      // AAC priming/padding representation varies slightly by FFmpeg build;
      // this bound still rejects a one-frame/truncated result.
      || !Number.isFinite(audioDuration) || audioDuration < 0.20 || audioDuration > 0.36
      || typeof format.format_name !== "string" || !format.format_name.split(",").includes("mp4")
      || !Number.isFinite(duration) || duration < 0.24 || duration > 0.36) {
      return failedCheck("CUTD1131", "Reference media pipeline", "FFmpeg/ffprobe did not preserve CUT's bounded H.264/AAC delivery contract.", "Install compatible FFmpeg and ffprobe binaries with libx264, AAC, MP4, yuv420p, and the required mastering filters.");
    }
    return { code: "CUTD1130", name: "Reference media pipeline", status: "pass", detail: "bounded H.264/yuv420p and AAC/48 kHz stereo MP4 encoded through CUT's required audio filters and verified by ffprobe" };
  } catch {
    return failedCheck("CUTD1131", "Reference media pipeline", "The bounded reference-media capability probe failed safely.", "Check the FFmpeg, ffprobe, and operating-system temp-space installation, then rerun cut doctor.");
  }
}

async function workspaceChecks(run: ToolRunner, temporaryRoot: string, ffmpegAvailable: boolean, ffprobeAvailable: boolean) {
  let directory: string | undefined;
  let writable = false;
  let cleanup = true;
  let media = failedCheck("CUTD1131", "Reference media pipeline", "The reference-media probe requires a writable temporary workspace.", "Make the operating-system temporary directory writable, then rerun cut doctor.");
  try {
    directory = await mkdtemp(resolve(temporaryRoot, "cut-doctor-"));
    const marker = resolve(directory, "write-probe.bin");
    await writeFile(marker, writableProbeBytes, { flag: "wx", mode: 0o600 });
    const [bytes, metadata] = await Promise.all([readFile(marker), lstat(marker)]);
    if (metadata.isSymbolicLink() || !metadata.isFile() || !bytes.equals(writableProbeBytes)) throw new Error("temporary workspace did not preserve the write probe");
    writable = true;
    media = await probeReferenceMedia(directory, run, ffmpegAvailable, ffprobeAvailable);
  } catch {
    // The report deliberately omits raw OS errors because they commonly embed
    // machine-local paths. Stable codes and remedies carry the diagnosis.
  } finally {
    if (directory) {
      try {
        await rm(directory, { recursive: true, force: true });
      } catch {
        cleanup = false;
      }
    }
  }
  const temporary = writable && cleanup
    ? { code: "CUTD1010", name: "Temporary workspace", status: "pass", detail: "private temporary bytes were created, verified, and removed" } satisfies CutDoctorCheck
    : failedCheck("CUTD1011", "Temporary workspace", cleanup ? "The operating-system temporary directory is not writable." : "CUT could not remove its private temporary probe bytes.", cleanup ? "Make the operating-system temporary directory writable with available free space." : "Check temporary-directory permissions, remove the failed cut-doctor workspace, and rerun cut doctor.");
  return { temporary, media };
}

export async function collectCutDoctorReport(options: CutDoctorOptions = {}): Promise<CutDoctorReport> {
  const checks: CutDoctorCheck[] = [];
  const run = options.runTool ?? runBoundedDoctorTool;
  const operatingSystem = options.platform ?? process.platform;
  checks.push(cutDoctorMediaInputPlatformCheck(operatingSystem));
  checks.push(cutDoctorNodeVersionCheck(process.versions.node));

  const [ffmpeg, ffprobe, encoders] = await Promise.all([
    run("ffmpeg", ["-version"]),
    run("ffprobe", ["-version"]),
    run("ffmpeg", ["-hide_banner", "-encoders"]),
  ]);
  checks.push(ffmpeg.status === "pass"
    ? { code: "CUTD1100", name: "FFmpeg", status: "pass", detail: availableVersion("FFmpeg", ffmpeg.stdout) }
    : failedCheck("CUTD1101", "FFmpeg", "FFmpeg could not complete its bounded version probe.", "Install FFmpeg and ensure ffmpeg is on PATH."));
  checks.push(ffprobe.status === "pass"
    ? { code: "CUTD1110", name: "FFprobe", status: "pass", detail: availableVersion("FFprobe", ffprobe.stdout) }
    : failedCheck("CUTD1111", "FFprobe", "FFprobe could not complete its bounded version probe.", "Install the ffprobe binary distributed with FFmpeg and ensure it is on PATH."));

  if (encoders.status === "pass") {
    const missing = ["libx264", "aac"].filter((encoder) => !new RegExp(`^\\s*[A-Z.]{6}\\s+${encoder}\\s`, "m").test(encoders.stdout));
    checks.push(missing.length
      ? { code: "CUTD1121", name: "Delivery codecs", status: "fail", detail: `FFmpeg is missing required encoder(s): ${missing.join(", ")}`, remedy: "Install an FFmpeg build with libx264 and AAC encoding." }
      : { code: "CUTD1120", name: "Delivery codecs", status: "pass", detail: "libx264 video and AAC audio encoders are available" });
  } else checks.push(failedCheck("CUTD1121", "Delivery codecs", "FFmpeg could not enumerate its available encoders.", "Install an FFmpeg build that can enumerate encoders."));

  const workspace = await workspaceChecks(run, options.temporaryRoot ?? tmpdir(), ffmpeg.status === "pass", ffprobe.status === "pass");
  checks.push(workspace.temporary, workspace.media);
  checks.push(referenceLimiterCheck());

  try {
    const sharpModule = await import("sharp");
    const versions = sharpModule.default?.versions ?? sharpModule.versions;
    if (!versions?.sharp || !versions.vips) throw new Error("sharp did not expose its native implementation versions");
    checks.push({ code: "CUTD1200", name: "Reference compositor", status: "pass", detail: `sharp ${versions.sharp} · libvips ${versions.vips}` });
  } catch {
    checks.push(failedCheck("CUTD1201", "Reference compositor", "Sharp/libvips could not load for this operating system and architecture.", "Reinstall cut-lang for this operating system and architecture."));
  }

  return {
    format: "cut-doctor-report",
    version: 1,
    status: checks.some((check) => check.status === "fail") ? "fail" : "pass",
    cut: {
      product: cutProductVersion,
      language: cutLanguageVersion,
      compiler: cutCompilerIdentity,
      ir: cutIrVersion,
      packageAbi: cutPackageAbi,
      runtime: cutReferenceRuntimeIdentity,
    },
    platform: { os: operatingSystem, architecture: process.arch, node: process.versions.node },
    checks,
  };
}
