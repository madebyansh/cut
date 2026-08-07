import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { CutAVIR } from "../../language/ir";
import { multiplyRational, rationalToNumber } from "../../language/rational";
import { createIncrementalRenderPlan, type RenderCacheManifest } from "../graph";
import { cutReferenceRuntimeIdentity } from "../../version";
import {
  abortEncoderAndWait,
  finishEncoder,
  runFfmpeg,
  runFfprobeCapture,
  spawnRawEncoder,
  writeFrame,
  type ReferenceMediaNativeProcessExecution,
} from "./ffmpeg";
import { ReferenceVisualRenderer } from "./visual";
import { normalizeReferenceAudio, type ReferenceLoudnessReport } from "./audio";
import { renderReferenceAudioArtifact, type ReferenceAudioCacheEvidence } from "./audio-cache";
import { bindReferenceFfmpegExecutableToolchain } from "./audio-limiter-compatibility";
import {
  prepareReferenceAacDelivery,
  type PreparedReferenceAacDelivery,
  type ReferenceAacDeliveryReport,
} from "./delivery";
import { deriveReferenceMasteringTarget, referenceMasteringPeakSource } from "./mastering";
import { assertReferenceAudioTruePeakScanContract } from "./audio-true-peak";
import { planReferenceAudioStems, prepareReferenceAudioStems, type PreparedReferenceAudioStems } from "./stems";
import { validateReferenceSession } from "./validate";
import {
  atomicWriteFile,
  ensureProjectWriteDirectory,
  publishStagedFile,
  publishStagedFileTransaction,
  publishStagedFileTransactionForTest,
  StagedFileTransactionError,
  type StagedFilePublication,
  type StagedFileTransactionTestHooks,
} from "../../project/write-boundary";
import { collectReferenceBackendIdentity, type CutReferenceBackendIdentity } from "./runtime-identity";
import { assertCutLockReferenceBackendIdentity } from "../../language/lock";
import {
  convertReferenceColorSurface,
  referenceColorProfileMetadata,
  ReferenceColorManagementError,
  type ReferenceColorProfile,
} from "./color-management";
import type { ReferenceMediaProfile, ReferenceMediaProfileEvidence } from "./media-profile";
import { referenceSceneEncodingContract } from "./scene-encoding";
import { prepareReferenceVerifiedInputSession, type ReferenceVerifiedInputSession } from "./verified-input-session";

const runtime = cutReferenceRuntimeIdentity;

async function sha256(path: string) {
  return new Promise<string>((accept, reject) => { const digest = createHash("sha256"); createReadStream(path).on("data", (chunk) => digest.update(chunk)).on("error", reject).on("end", () => accept(digest.digest("hex"))); });
}

export type ReferenceSceneArtifactExpectation = Readonly<{
  key: string;
  frames: number;
  width: number;
  height: number;
  fps: { numerator: string; denominator: string };
  runtime: string;
  backendIntegrity: string;
  toolchainIntegrity: string;
  color: ReferenceColorProfile | "legacy";
}>;

class ReferenceSceneArtifactContractError extends Error {
  readonly code = "CUT_SCENE_CACHE_ARTIFACT_CONTRACT" as const;
  constructor() {
    super("CUT_SCENE_CACHE_ARTIFACT_CONTRACT: H.264 scene does not match CUT's decoded frame/timing/format contract.");
    this.name = "ReferenceSceneArtifactContractError";
  }
}

function plainRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
    ? value as Record<string, unknown>
    : undefined;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function integerText(value: unknown) {
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return typeof value === "string" && /^-?\d{1,32}$/u.test(value) ? value : undefined;
}

function rationalText(value: unknown) {
  if (typeof value !== "string") return undefined;
  const match = /^(\d{1,32})\/(\d{1,32})$/u.exec(value);
  if (!match || BigInt(match[2]) === 0n) return undefined;
  return { numerator: BigInt(match[1]), denominator: BigInt(match[2]) };
}

function sameRational(left: { numerator: bigint; denominator: bigint }, right: { numerator: string; denominator: string }) {
  return left.numerator * BigInt(right.denominator) === BigInt(right.numerator) * left.denominator;
}

export async function assertReferenceSceneArtifactContract(
  path: string,
  expected: ReferenceSceneArtifactExpectation,
  nativeProcessExecution?: ReferenceMediaNativeProcessExecution,
) {
  const result = await runFfprobeCapture([
    "-v", "error", "-count_frames",
    "-show_entries", "stream=codec_type,codec_name,pix_fmt,width,height,has_b_frames,avg_frame_rate,time_base,start_pts,duration_ts,nb_read_frames,color_range,color_space,color_transfer,color_primaries",
    "-of", "json", path,
  ], 60_000, { stdoutBytes: 32_000, stderrBytes: 32_000, totalBytes: 64_000 }, nativeProcessExecution);
  let stream: Record<string, unknown> | undefined, streamCount = 0;
  try {
    const parsed = plainRecord(JSON.parse(result.stdout)), streams = parsed && Array.isArray(parsed.streams) ? parsed.streams : [];
    streamCount = streams.length;
    stream = streamCount === 1 ? plainRecord(streams[0]) : undefined;
  } catch { /* handled by the closed contract failure below */ }
  const rate = rationalText(stream?.avg_frame_rate), timeBase = rationalText(stream?.time_base);
  const start = integerText(stream?.start_pts), duration = integerText(stream?.duration_ts), frames = integerText(stream?.nb_read_frames);
  const durationMatches = duration !== undefined && timeBase !== undefined
    && BigInt(duration) * timeBase.numerator * BigInt(expected.fps.numerator)
      === BigInt(expected.frames) * BigInt(expected.fps.denominator) * timeBase.denominator;
  const expectedColor = expected.color === "legacy" ? undefined : {
    color_range: expected.color === "rec709-limited" ? "tv" : "pc",
    color_space: "bt709",
    color_transfer: expected.color === "srgb" ? "iec61966-2-1" : expected.color === "linear-srgb" ? "linear" : "bt709",
    color_primaries: "bt709",
  };
  const colorMatches = expectedColor === undefined
    || Object.entries(expectedColor).every(([name, value]) => stream?.[name] === value);
  // FFprobe names full-range planar 4:2:0 as yuvj420p even though the encoder
  // filter is format=yuv420p plus fullrange=on. Treat that observed semantic
  // pixel format as distinct from the limited/legacy yuv420p contract.
  const expectedPixelFormat = expected.color !== "legacy" && expected.color !== "rec709-limited"
    ? "yuvj420p"
    : "yuv420p";
  if (!stream
    || streamCount !== 1
    || stream.codec_type !== "video"
    || stream.codec_name !== "h264"
    || stream.pix_fmt !== expectedPixelFormat
    || stream.width !== expected.width
    || stream.height !== expected.height
    || stream.has_b_frames !== referenceSceneEncodingContract.bFrames
    || !rate
    || !sameRational(rate, expected.fps)
    || start !== "0"
    || frames !== String(expected.frames)
    || !durationMatches
    || !colorMatches) {
    throw new ReferenceSceneArtifactContractError();
  }
}

async function cacheArtifact(directory: string, expected: ReferenceSceneArtifactExpectation) {
  const manifestPath = resolve(directory, "manifest.json"), artifact = resolve(directory, "video.mp4");
  try {
    const [manifestMetadata, artifactMetadata] = await Promise.all([lstat(manifestPath), lstat(artifact)]);
    if (!manifestMetadata.isFile() || !artifactMetadata.isFile()) return undefined;
    const manifest = plainRecord(JSON.parse(await readFile(manifestPath, "utf8")));
    if (!manifest
      || !exactKeys(manifest, ["format", "version", "key", "sha256", "frames", "runtime", "backendIntegrity", "toolchainIntegrity"])
      || manifest.format !== "cut-scene-cache"
      || manifest.version !== 3
      || manifest.key !== expected.key
      || typeof manifest.sha256 !== "string"
      || !/^[a-f0-9]{64}$/u.test(manifest.sha256)
      || manifest.frames !== expected.frames
      || manifest.runtime !== expected.runtime
      || manifest.backendIntegrity !== expected.backendIntegrity
      || manifest.toolchainIntegrity !== expected.toolchainIntegrity
      || await sha256(artifact) !== manifest.sha256) return undefined;
    await assertReferenceSceneArtifactContract(artifact, expected);
    return artifact;
  }
  catch { return undefined; }
}

async function renderScene(ir: CutAVIR, compositionId: string, sceneId: string, projectRoot: string, cacheRoot: string, key: string, backend: CutReferenceBackendIdentity, toolchain: Awaited<ReturnType<typeof bindReferenceFfmpegExecutableToolchain>>, color: ReferenceColorProfile | "legacy", verifiedResourcePath: ReferenceVerifiedInputSession["pathFor"]) {
  const composition = ir.compositions.find((item) => item.id === compositionId)!; const scene = ir.scenes[sceneId]; const frameRate = `${composition.fps.numerator}/${composition.fps.denominator}`; const framesExact = multiplyRational(scene.duration, composition.fps);
  if (framesExact.denominator !== "1") throw new Error(`Scene “${scene.name}” duration does not land on a frame boundary.`);
  const frameCount = Number(framesExact.numerator);
  const expected = { key, frames: frameCount, width: composition.width, height: composition.height, fps: composition.fps, runtime, backendIntegrity: backend.integrity, toolchainIntegrity: toolchain.toolchain.integrity, color } as const;
  const target = await ensureProjectWriteDirectory(projectRoot, `.cut/cache/reference/scene/${key}`), hit = await cacheArtifact(target, expected); if (hit) return { path: hit, hit: true };
  const visual = new ReferenceVisualRenderer(ir, composition, projectRoot, cacheRoot, verifiedResourcePath);
  let staging: string | undefined, temp: string | undefined;
  let encoder: ReturnType<typeof spawnRawEncoder> | undefined, encoderFinished = false;
  try {
    await visual.prepare();
    staging = await mkdtemp(resolve(target, ".cut-render-")); temp = resolve(staging, "video.mp4");
    encoder = spawnRawEncoder(composition.width, composition.height, frameRate, temp, color, toolchain.executablePath);
    for (let frame = 0; frame < frameCount; frame += 1) {
      const surface = await visual.sceneFrame(scene, frame);
      // The encoder performs RGB -> YUV legal-range mapping. CPU conversion
      // therefore targets full-range Rec.709 code values even for tv delivery.
      const surfaceProfile = color === "rec709-limited" ? "rec709-full" : color;
      const encoded = surfaceProfile === "legacy" || surfaceProfile === "srgb"
        ? surface
        : convertReferenceColorSurface(surface, "srgb", surfaceProfile);
      await writeFrame(encoder, Buffer.from(encoded.data));
    }
    await finishEncoder(encoder);
    encoderFinished = true;
    await toolchain.verify();
    await assertReferenceSceneArtifactContract(temp, expected);
    const artifact = resolve(target, "video.mp4"); await publishStagedFile(temp, artifact); const digest = await sha256(artifact); await atomicWriteFile(resolve(target, "manifest.json"), JSON.stringify({ format: "cut-scene-cache", version: 3, key, sha256: digest, frames: frameCount, runtime, backendIntegrity: backend.integrity, toolchainIntegrity: toolchain.toolchain.integrity }, null, 2)); return { path: artifact, hit: false };
  } finally {
    if (encoder && !encoderFinished) await abortEncoderAndWait(encoder);
    await visual.closeAndWait();
    if (staging) await rm(staging, { recursive: true, force: true });
  }
}

async function prepareSafeConcatList(work: string, renderedScenes: readonly string[]) {
  const aliases: string[] = [];
  for (const [index, scene] of renderedScenes.entries()) {
    // The concat demuxer parses a directive language, so authored/project
    // paths must never enter its input. Hard links keep every list entry a
    // generated portable filename while preserving the cached scene bytes.
    const name = `scene-${String(index).padStart(6, "0")}.mp4`;
    await link(scene, resolve(work, name));
    aliases.push(name);
  }
  const list = resolve(work, "scenes.txt");
  await writeFile(list, `${aliases.map((name) => `file '${name}'`).join("\n")}\n`, { flag: "wx", mode: 0o600 });
  return list;
}

function portableRenderLocator(parent: string, destination: string) {
  const locator = relative(parent, destination);
  if (isAbsolute(locator) || locator.includes("\0")) {
    throw new StagedFileTransactionError("CUT_PUBLISH_PREFLIGHT", "render-manifest destinations must share one portable filesystem root.");
  }
  return locator === "" ? "." : locator.split(sep).join("/");
}

export type ReferenceRenderManifest = {
  format: "cut-reference-render";
  version: 10;
  runtime: string;
  backend: CutReferenceBackendIdentity;
  /** Present only when the rendered graph executes shaped FlowText. */
  features?: NonNullable<CutAVIR["features"]>;
  /** SHA-256 of the exact verified cut.lock bytes applied by the caller. */
  lock: { sha256: string };
  /** Canonical locked edit identity containing the master+proxy contract. */
  buildId: string;
  /** Profile-specific execution/cache identity containing only selected media. */
  executionBuildId: string;
  output: string;
  sha256: string;
  duration: number;
  canvas: { width: number; height: number; fps: string };
  color: {
    working: "srgb-straight";
    delivery: ReferenceColorProfile | "legacy-untagged";
    ffprobe: { colorRange?: string; colorSpace?: string; colorTransfer?: string; colorPrimaries?: string };
  };
  audio: { roots: number; filters: number; sampleRate: number; channels: 2; limiter: ReferenceAudioCacheEvidence["limiter"]; samplePeak: ReferenceAudioCacheEvidence["peak"]; loudness: ReferenceLoudnessReport; delivery: ReferenceAacDeliveryReport };
  stems?: { directory: string; manifest: string; manifestSha256: string; count: number };
  media: ReferenceMediaProfileEvidence;
  cache: { hits: number; misses: number; scenes: Array<{ id: string; status: "hit" | "miss" }>; audio: ReferenceAudioCacheEvidence };
};

export type ReferenceRenderOptions = {
  /** SHA-256 of the exact verified cut.lock bytes applied to this render. */
  lockSha256: string;
  stemsDirectory?: string;
  mediaProfile?: ReferenceMediaProfile;
  /** @internal Deterministic publication fault injection for integration tests. */
  __testPublicationHooks?: StagedFileTransactionTestHooks;
  /** @internal Deterministic pre-publication failure injection for integration tests. */
  __testPreparationFault?: (stage: "after-aac" | "after-stems") => void | Promise<void>;
  /** @internal Mutate caller-owned originals after verified input binding. */
  __testAfterInputSnapshot?: () => void | Promise<void>;
  /** @internal Force a verified-input cleanup boundary condition. */
  __testBeforeInputCleanup?: () => void | Promise<void>;
  /** @internal Backend identity from the already validated cut.lock. */
  __lockedReferenceBackend?: CutReferenceBackendIdentity;
};

export class ReferenceRenderContractError extends Error {
  constructor(readonly code: "CUT_RENDER_OPTION_CONTRACT" | "CUT_RENDER_LOCK_SHA256", message: string) {
    super(`${code}: ${message}`);
    this.name = "ReferenceRenderContractError";
  }
}

function validateReferenceRenderOptions(value: unknown): ReferenceRenderOptions {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ReferenceRenderContractError("CUT_RENDER_OPTION_CONTRACT", "render options must be a plain object containing lockSha256.");
  }
  const options = value as Record<string, unknown>;
  const allowed = new Set([
    "lockSha256",
    "stemsDirectory",
    "mediaProfile",
    "__testPublicationHooks",
    "__testPreparationFault",
    "__testAfterInputSnapshot",
    "__testBeforeInputCleanup",
    "__lockedReferenceBackend",
  ]);
  const unknown = Object.keys(options).filter((key) => !allowed.has(key)).sort();
  if (unknown.length) {
    throw new ReferenceRenderContractError("CUT_RENDER_OPTION_CONTRACT", `unknown render option ${JSON.stringify(unknown[0])}.`);
  }
  if (typeof options.lockSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(options.lockSha256)) {
    throw new ReferenceRenderContractError("CUT_RENDER_LOCK_SHA256", "lockSha256 must be one lowercase SHA-256 digest of the verified cut.lock bytes.");
  }
  if (options.stemsDirectory !== undefined && (typeof options.stemsDirectory !== "string" || !options.stemsDirectory || options.stemsDirectory.includes("\0"))) {
    throw new ReferenceRenderContractError("CUT_RENDER_OPTION_CONTRACT", "stemsDirectory must be non-empty path text without NUL.");
  }
  if (options.mediaProfile !== undefined && options.mediaProfile !== "master" && options.mediaProfile !== "proxy") {
    throw new ReferenceRenderContractError("CUT_RENDER_OPTION_CONTRACT", "mediaProfile must be master or proxy.");
  }
  for (const key of ["__testPreparationFault", "__testAfterInputSnapshot", "__testBeforeInputCleanup"] as const) {
    if (options[key] !== undefined && typeof options[key] !== "function") {
      throw new ReferenceRenderContractError("CUT_RENDER_OPTION_CONTRACT", `${key} must be a function when supplied.`);
    }
  }
  return options as ReferenceRenderOptions;
}

async function deliveredColorTags(path: string, color: ReferenceColorProfile | "legacy") {
  const result = await runFfprobeCapture(["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=color_range,color_space,color_transfer,color_primaries", "-of", "json", path]);
  let stream: Record<string, unknown>;
  try {
    const parsed = JSON.parse(result.stdout) as { streams?: unknown[] };
    stream = parsed.streams?.[0] && typeof parsed.streams[0] === "object" ? parsed.streams[0] as Record<string, unknown> : {};
  } catch {
    throw new ReferenceColorManagementError("CUT_COLOR_METADATA", "ffprobe returned invalid JSON while verifying delivered color tags.");
  }
  const tags = {
    colorRange: typeof stream.color_range === "string" ? stream.color_range : undefined,
    colorSpace: typeof stream.color_space === "string" ? stream.color_space : undefined,
    colorTransfer: typeof stream.color_transfer === "string" ? stream.color_transfer : undefined,
    colorPrimaries: typeof stream.color_primaries === "string" ? stream.color_primaries : undefined,
  };
  if (color !== "legacy") {
    const expected = {
      colorRange: color === "rec709-limited" ? "tv" : "pc",
      colorSpace: "bt709",
      colorTransfer: color === "srgb" ? "iec61966-2-1" : color === "linear-srgb" ? "linear" : "bt709",
      colorPrimaries: "bt709",
    };
    const mismatches = Object.entries(expected).filter(([name, value]) => tags[name as keyof typeof tags] !== value);
    if (mismatches.length) throw new ReferenceColorManagementError("CUT_COLOR_METADATA", `delivered H.264 color tags do not match ${color}: ${mismatches.map(([name, value]) => `${name}=${tags[name as keyof typeof tags] ?? "missing"} (expected ${value})`).join("; ")}.`);
  }
  return tags;
}

export async function renderReferenceIr(ir: CutAVIR, projectRoot: string, outputPath: string, outputName?: string, authoredOptions?: ReferenceRenderOptions) {
  // A full render without a verified-lock digest is not a reproducible public
  // artifact. Validate the closed option surface before probing resources,
  // touching caches, or starting any media process.
  const options = validateReferenceRenderOptions(authoredOptions);
  // Reject unsupported true-peak rate/work contracts before probing resources,
  // collecting backend identity, rendering frames or creating output staging.
  const preflightSession = validateReferenceSession(ir, outputName);
  const preflightPeakSource = referenceMasteringPeakSource(ir, preflightSession.composition);
  const preflightFrames = multiplyRational(preflightSession.composition.duration, {
    numerator: String(preflightSession.composition.sampleRate),
    denominator: "1",
  });
  if (preflightFrames.denominator !== "1" || !Number.isSafeInteger(Number(preflightFrames.numerator))) {
    throw new Error(`Timeline “${preflightSession.composition.name}” does not have an exact safe-integer audio boundary.`);
  }
  assertReferenceAudioTruePeakScanContract({
    expectedFrames: Number(preflightFrames.numerator),
    sampleRate: preflightSession.composition.sampleRate,
    source: preflightPeakSource,
  });
  const canonicalBuildId = ir.buildId;
  const verifiedInputs = await prepareReferenceVerifiedInputSession(ir, projectRoot, options.mediaProfile ?? "master");
  let verifiedInputsCleanupStarted = false;
  const cleanupVerifiedInputs = async () => {
    if (verifiedInputsCleanupStarted) return;
    verifiedInputsCleanupStarted = true;
    await verifiedInputs.cleanup();
  };
  try {
  await options.__testAfterInputSnapshot?.();
  // Reuse CUT's strongest existing path-free FFmpeg identity: bounded banner
  // plus stable no-follow SHA-256 of the resolved executable. The identity is
  // intentionally collected fresh so an executable replacement cannot reuse
  // picture segments within a long-lived process. Dynamically loaded codec
  // libraries remain outside this boundary and are not claimed here.
  const backend = await collectReferenceBackendIdentity();
  if (options.__lockedReferenceBackend) assertCutLockReferenceBackendIdentity(options.__lockedReferenceBackend, backend);
  const sceneToolchain = await bindReferenceFfmpegExecutableToolchain();
  ir = verifiedInputs.ir;
  const session = validateReferenceSession(ir, outputName); const { composition, outputContract } = session;
  if (options.stemsDirectory && resolve(options.stemsDirectory) === resolve(outputPath)) throw new Error("Stem directory and rendered video path must be different.");
  // This pure plan validates every stem name and routing edge before the first
  // encoder/decoder process is started by the reference renderer.
  const stemPlan = options.stemsDirectory ? planReferenceAudioStems(ir, composition) : undefined;
  const target = deriveReferenceMasteringTarget(ir, composition); const peakSource = referenceMasteringPeakSource(ir, composition); const cacheRoot = await ensureProjectWriteDirectory(projectRoot, ".cut/cache/reference");
  const previousPath = resolve(cacheRoot, `composition-${composition.id}.json`); const previous = await readFile(previousPath, "utf8").then((value) => JSON.parse(value) as RenderCacheManifest).catch(() => undefined); const plan = createIncrementalRenderPlan(ir, composition.id, previous, runtime, backend.integrity, outputContract.color, sceneToolchain.toolchain.integrity); const scenePlan = new Map(plan.scenes.map((item) => [item.id, item])); const renderedScenes: string[] = []; const sceneStatuses: Array<{ id: string; status: "hit" | "miss" }> = [];
  for (const id of composition.sceneIds) { const planned = scenePlan.get(id)!; const result = await renderScene(ir, composition.id, id, projectRoot, cacheRoot, planned.key, backend, sceneToolchain, outputContract.color, verifiedInputs.pathFor); renderedScenes.push(result.path); sceneStatuses.push({ id, status: result.hit ? "hit" : "miss" }); }
  // Keep the concat work next to its cache sources so hard-link aliases are
  // same-filesystem and never require copying or exposing authored paths.
  const work = await mkdtemp(resolve(cacheRoot, ".cut-reference-work-")); const silentVideo = resolve(work, "picture.mp4"), normalizedAudio = resolve(work, "master.wav");
  const outputStages: string[] = [];
  let cacheStaging: string | undefined, stemBuild: PreparedReferenceAudioStems | undefined, preparedDelivery: PreparedReferenceAacDelivery | undefined;
  try {
    await chmod(work, 0o700);
    const list = await prepareSafeConcatList(work, renderedScenes);
    await runFfmpeg(["-y", "-v", "error", "-protocol_whitelist", "file", "-f", "concat", "-safe", "1", "-i", list, "-c", "copy", silentVideo]);
    const audioArtifact = await renderReferenceAudioArtifact(ir, composition, projectRoot, { samplePeakDbfs: target.samplePeakDbfs, source: peakSource, __verifiedResourcePath: verifiedInputs.pathFor }); const audioBuild = audioArtifact.build; const normalized = await normalizeReferenceAudio(audioArtifact.path, normalizedAudio, target.integratedLufs, target.truePeakDbtp, target.loudnessRangeLu, composition.sampleRate, { inputFormat: "raw-stereo-f32le", inputPeak: audioArtifact.cache.peak }); const output = resolve(outputPath), outputParent = dirname(output); await mkdir(outputParent, { recursive: true });
    const outputParentMetadata = await lstat(outputParent);
    if (outputParentMetadata.isSymbolicLink() || !outputParentMetadata.isDirectory()) throw new StagedFileTransactionError("CUT_PUBLISH_PREFLIGHT", `destination parent must be a direct, non-symlink directory.`, outputParent);
    const publicationId = `${process.pid}-${randomUUID()}`;
    preparedDelivery = await prepareReferenceAacDelivery({
      silentVideo,
      normalizedPcm: normalizedAudio,
      stagingRoot: outputParent,
      target: normalized.target,
      sampleRate: composition.sampleRate,
      expectedFrames: audioArtifact.cache.artifact.samples,
      source: peakSource,
      toolchain: audioArtifact.cache.identity.toolchain,
    });
    const stagedOutput = preparedDelivery.artifact, delivery = preparedDelivery.report;
    const loudness: ReferenceLoudnessReport = { ...normalized, output: delivery.finalFfmpegMeasurement }; const colorTags = await deliveredColorTags(stagedOutput, outputContract.color);
    // Color probing is the final backend consumer of the accepted candidate.
    // Revalidate afterwards, then bind the manifest to the delivery hash; no
    // media subprocess receives the final publication inode again.
    await preparedDelivery.verify();
    const stagedOutputSha256 = delivery.passes.at(-1)!.encodedSha256;
    await options.__testPreparationFault?.("after-aac");
    // Meter.samplePeak is a final-master constraint. Stems are serialized from
    // their authored pre-master Bus roots, before any shared mastering chain,
    // so applying the final Meter ceiling to each isolated route would reject
    // valid mixes. The stem boundary independently enforces its lossless PCM24
    // serialization ceiling (0 dBFS by default).
    stemBuild = stemPlan && options.stemsDirectory ? await prepareReferenceAudioStems(ir, composition, projectRoot, options.stemsDirectory, { lockSha256: options.lockSha256, __verifiedResourcePath: verifiedInputs.pathFor }) : undefined;
    await options.__testPreparationFault?.("after-stems");
    const manifest: ReferenceRenderManifest = { format: "cut-reference-render", version: 10, runtime, backend, ...(ir.features ? { features: ir.features } : {}), lock: { sha256: options.lockSha256 }, buildId: canonicalBuildId, executionBuildId: ir.buildId, output: basename(output), sha256: stagedOutputSha256, duration: rationalToNumber(composition.duration), canvas: { width: composition.width, height: composition.height, fps: `${composition.fps.numerator}/${composition.fps.denominator}` }, color: { working: "srgb-straight", delivery: outputContract.color === "legacy" ? "legacy-untagged" : referenceColorProfileMetadata(outputContract.color).profile, ffprobe: colorTags }, audio: { ...audioBuild, sampleRate: composition.sampleRate, channels: 2, limiter: audioArtifact.cache.limiter, samplePeak: audioArtifact.cache.peak, loudness, delivery }, ...(stemBuild ? { stems: { directory: portableRenderLocator(outputParent, stemBuild.directory), manifest: portableRenderLocator(outputParent, stemBuild.manifestPath), manifestSha256: stemBuild.manifestSha256, count: stemBuild.manifest.stems.length } } : {}), media: verifiedInputs.media, cache: { hits: sceneStatuses.filter((item) => item.status === "hit").length, misses: sceneStatuses.filter((item) => item.status === "miss").length, scenes: sceneStatuses, audio: audioArtifact.cache } };
    const stagedRenderManifest = resolve(outputParent, `.cut-render-publication-${publicationId}-manifest.json`);
    await writeFile(stagedRenderManifest, JSON.stringify(manifest, null, 2), { flag: "wx", mode: 0o600 }); outputStages.push(stagedRenderManifest);
    cacheStaging = await mkdtemp(resolve(cacheRoot, ".cut-composition-publication-"));
    const stagedCompositionManifest = resolve(cacheStaging, "composition.json");
    await writeFile(stagedCompositionManifest, JSON.stringify(plan.manifest, null, 2));
    const renderManifestOrder = 1_000;
    const publications: StagedFilePublication[] = [
      ...(stemBuild?.publications ?? []),
      { staged: stagedOutput, destination: output, order: 500, role: "render-output" },
      { staged: stagedCompositionManifest, destination: previousPath, order: 900, role: "composition-manifest" },
      { staged: stagedRenderManifest, destination: `${output}.manifest.json`, order: renderManifestOrder, role: "render-manifest" },
    ];
    if (publications.some((publication) => publication.role !== "render-manifest" && (publication.order ?? 0) >= renderManifestOrder)) {
      throw new Error("CUT reference publication invariant failed: the render manifest must be the final commit-marker promotion.");
    }
    // All project-resource consumers are closed by this point. Delete the
    // invocation snapshots before the first public artifact promotion so a
    // cleanup failure cannot leave a newly published render or manifest.
    await options.__testBeforeInputCleanup?.();
    await cleanupVerifiedInputs();
    if (options.__testPublicationHooks) await publishStagedFileTransactionForTest(publications, options.__testPublicationHooks);
    else await publishStagedFileTransaction(publications);
    return manifest;
  } finally {
    if (stemBuild) await stemBuild.cleanup().catch(() => undefined);
    // These locations are private preparation state. Once the final manifest
    // promotion succeeds, cleanup errors cannot be reported as a failed render
    // or rollback; best effort may leave only hidden/temp staging residue.
    if (cacheStaging) await rm(cacheStaging, { recursive: true, force: true }).catch(() => undefined);
    if (preparedDelivery) await preparedDelivery.cleanup().catch(() => undefined);
    for (const staged of outputStages) await rm(staged, { force: true }).catch(() => undefined);
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
  } finally {
    await cleanupVerifiedInputs();
  }
}
