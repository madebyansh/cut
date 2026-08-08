import { hash } from "../../core/stable";
import {
  bindReferenceNativeMediaTool,
  type BoundReferenceNativeMediaTool,
} from "../../project/native-process-authority";
import { bindReferenceFfmpegExecutableToolchain } from "./audio-limiter-compatibility";
import {
  runBoundReferenceFfprobeCapture,
  type ReferenceMediaNativeProcessExecution,
  type ReferenceMediaProcessCaptureLimits,
} from "./ffmpeg";

export const referencePictureMediaToolchainPolicy =
  "cut.reference-picture-media-toolchain/exact-ffmpeg-ffprobe-v1" as const;

type ExactMediaExecutableIdentity = Readonly<{
  version: string;
  bannerSha256: string;
  executableSha256: string;
  executableBytes: number;
}>;

export type ReferencePictureMediaToolchainIdentity = Readonly<{
  format: "cut-reference-picture-media-toolchain";
  version: 1;
  policy: typeof referencePictureMediaToolchainPolicy;
  ffmpeg: ExactMediaExecutableIdentity;
  ffprobe: ExactMediaExecutableIdentity;
  integrity: string;
}>;

export type ReferencePictureArtifactProbe = Readonly<{
  executablePath: string;
  verify: () => Promise<void>;
  execution?: ReferenceMediaNativeProcessExecution;
}>;

export type BoundReferencePictureMediaToolchain = Readonly<{
  ffmpegExecutablePath: string;
  ffprobeExecutablePath: string;
  toolchain: ReferencePictureMediaToolchainIdentity;
  ffprobe: ReferencePictureArtifactProbe;
  verify: () => Promise<void>;
}>;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function exactExecutableIdentity(value: unknown): value is ExactMediaExecutableIdentity {
  return record(value)
    && exactKeys(value, ["version", "bannerSha256", "executableSha256", "executableBytes"])
    && typeof value.version === "string"
    && value.version.length > 0
    && value.version.length <= 4_096
    && !/[\0\r\n]/u.test(value.version)
    && typeof value.bannerSha256 === "string"
    && /^[a-f0-9]{64}$/u.test(value.bannerSha256)
    && typeof value.executableSha256 === "string"
    && /^[a-f0-9]{64}$/u.test(value.executableSha256)
    && Number.isSafeInteger(value.executableBytes)
    && Number(value.executableBytes) > 0;
}

export function isReferencePictureMediaToolchainIdentity(value: unknown): value is ReferencePictureMediaToolchainIdentity {
  if (!record(value)
    || !exactKeys(value, ["format", "version", "policy", "ffmpeg", "ffprobe", "integrity"])
    || value.format !== "cut-reference-picture-media-toolchain"
    || value.version !== 1
    || value.policy !== referencePictureMediaToolchainPolicy
    || !exactExecutableIdentity(value.ffmpeg)
    || !exactExecutableIdentity(value.ffprobe)
    || typeof value.integrity !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.integrity)) return false;
  const content = {
    format: value.format,
    version: value.version,
    policy: value.policy,
    ffmpeg: value.ffmpeg,
    ffprobe: value.ffprobe,
  };
  return hash(content) === value.integrity;
}

function ffprobeIdentity(stdout: string, authority: BoundReferenceNativeMediaTool): ExactMediaExecutableIdentity {
  const normalized = stdout.replaceAll("\r\n", "\n").trim();
  const version = normalized.split("\n", 1)[0] ?? "";
  if (!version.startsWith("ffprobe version ")
    || version.length > 4_096
    || /[\0\r\n]/u.test(version)
    || normalized.length > 128_000) {
    throw new Error("CUT_PICTURE_MEDIA_TOOLCHAIN: FFprobe did not provide one bounded implementation banner.");
  }
  return Object.freeze({
    version,
    bannerSha256: hash(normalized),
    executableSha256: authority.evidence.sha256,
    executableBytes: authority.evidence.bytes,
  });
}

export async function bindReferencePictureMediaToolchain(): Promise<BoundReferencePictureMediaToolchain> {
  const [ffmpeg, ffprobe] = await Promise.all([
    bindReferenceFfmpegExecutableToolchain(),
    bindReferenceNativeMediaTool("ffprobe"),
  ]);
  const ffprobeVersion = await runBoundReferenceFfprobeCapture(
    ffprobe.executablePath,
    ["-version"],
    30_000,
    { stdoutBytes: 128_000, stderrBytes: 16_000, totalBytes: 144_000 },
  );
  await Promise.all([ffmpeg.verify(), ffprobe.verify()]);
  const content = Object.freeze({
    format: "cut-reference-picture-media-toolchain" as const,
    version: 1 as const,
    policy: referencePictureMediaToolchainPolicy,
    ffmpeg: Object.freeze({ ...ffmpeg.toolchain.ffmpeg }),
    ffprobe: ffprobeIdentity(ffprobeVersion.stdout, ffprobe),
  });
  const toolchain = Object.freeze({ ...content, integrity: hash(content) });
  const verify = async () => { await Promise.all([ffmpeg.verify(), ffprobe.verify()]); };
  return Object.freeze({
    ffmpegExecutablePath: ffmpeg.executablePath,
    ffprobeExecutablePath: ffprobe.executablePath,
    toolchain,
    ffprobe: Object.freeze({ executablePath: ffprobe.executablePath, verify: ffprobe.verify }),
    verify,
  });
}

export function referencePictureArtifactProbe(
  toolchain: BoundReferencePictureMediaToolchain,
  execution?: ReferenceMediaNativeProcessExecution,
): ReferencePictureArtifactProbe {
  if (execution === undefined) return toolchain.ffprobe;
  return Object.freeze({
    executablePath: execution.authority.executablePath,
    verify: execution.authority.verify,
    execution,
  });
}

export async function runReferencePictureFfprobeCapture(
  probe: ReferencePictureArtifactProbe,
  args: string[],
  timeout = 60_000,
  limits: ReferenceMediaProcessCaptureLimits = {},
) {
  await probe.verify();
  try {
    return await runBoundReferenceFfprobeCapture(probe.executablePath, args, timeout, limits, probe.execution);
  } finally {
    await probe.verify();
  }
}
