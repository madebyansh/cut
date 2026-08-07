import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { hash } from "../../core/stable";
import {
  measureReferenceAudioAuthoredBoundary,
  ReferenceAudioLoudnessBoundaryError,
  type ReferenceLoudnessMeasurement,
} from "./audio";
import type { ReferenceAudioPeakSource } from "./audio-peak";
import {
  inspectReferenceDecodedTruePeak,
  ReferenceAudioDeliveryError,
  type ReferenceDecodedAudioFraming,
  type ReferenceDecodedTruePeakEvidence,
} from "./audio-delivery-inspection";
import { assertReferenceAudioTruePeakScanContract, type ReferenceAudioTruePeakScan } from "./audio-true-peak";
import { runFfmpeg } from "./ffmpeg";
import { publishStagedFile } from "../../project/write-boundary";
import {
  collectReferenceAudioToolchainIdentity,
  type ReferenceAudioToolchainIdentity,
} from "./audio-cache";

export type ReferenceAacDeliveryTarget = {
  integratedLufs: number;
  truePeakDbtp: number;
  loudnessRangeLu: number;
};

export type ReferenceAacDeliveryPass = {
  /** One-indexed AAC encoding attempt, always sourced from the same PCM master. */
  pass: number;
  source: "normalized-pcm";
  appliedGainDb: number;
  /** CUT-owned decode/framing evidence for the exact authored boundary. */
  decoded: ReferenceDecodedAudioFraming;
  /** CUT-owned BS.1770-5 estimate over decoded authored samples only. */
  cutTruePeak: ReferenceAudioTruePeakScan;
  /** Exact encoded candidate bytes for replay/audit identity. */
  encodedSha256: string;
  /** Exact decoded authored stereo-f32 boundary consumed by both authorities. */
  authoredPcmSha256: string;
  /** FFmpeg loudnorm is retained as an independently named cross-check. */
  measurement: ReferenceLoudnessMeasurement;
  cutTruePeakResidualDb: number | null;
  ffmpegTruePeakResidualDb: number | null;
  cutTruePeakCompliant: boolean;
  ffmpegTruePeakCompliant: boolean | null;
  /** Most conservative available dBTP residual; positive values violate. */
  truePeakResidualDb: number | null;
  /** Authored LUFS target minus measured LUFS; positive values are quieter. */
  loudnessResidualLu: number | null;
  truePeakCompliant: boolean;
};

export type ReferenceAacDeliveryReport = {
  format: "cut-reference-aac-delivery";
  version: 2;
  codec: {
    name: "aac";
    implementation: "ffmpeg-native-aac";
    bitrate: number;
    container: "mp4";
    movieTimescale: number;
    primingFrames: 1_024;
  };
  source: "normalized-pcm";
  truePeakAuthority: "cut-bs1770-5-with-conservative-ffmpeg-cross-check";
  /** One executable identity applies to the normalized master and every pass. */
  toolchain: ReferenceAudioToolchainIdentity;
  target: ReferenceAacDeliveryTarget;
  normalizedPcm: ReferenceDecodedTruePeakEvidence;
  maxPasses: number;
  maxGainReductionDb: number;
  safetyMarginDb: number;
  passCount: number;
  passes: ReferenceAacDeliveryPass[];
  appliedGainDb: number;
  status: "not-needed" | "reconciled" | "peak-limited" | "loudness-unmeasurable";
  truePeakCompliant: boolean;
  residuals: { truePeakDb: number | null; loudnessLu: number | null };
  finalFfmpegMeasurement: ReferenceLoudnessMeasurement;
};

export type ReferenceAacDeliveryOptions = {
  silentVideo: string;
  normalizedPcm: string;
  output: string;
  target: ReferenceAacDeliveryTarget;
  sampleRate: number;
  expectedFrames: number;
  source: ReferenceAudioPeakSource;
};

export type ReferenceAacPreparationOptions = Omit<ReferenceAacDeliveryOptions, "output"> & {
  /** Existing direct directory on the destination filesystem; CUT creates a mode-0700 child. */
  stagingRoot: string;
  toolchain: ReferenceAudioToolchainIdentity;
};

export type PreparedReferenceAacDelivery = Readonly<{
  artifact: string;
  report: ReferenceAacDeliveryReport;
  /** Revalidate the exact accepted bytes after any caller-owned probe. */
  verify: () => Promise<void>;
  cleanup: () => Promise<void>;
}>;

// AAC is lossy: a PCM true-peak ceiling can be crossed after encoding. The
// delivery stage therefore owns a small, deterministic, downward-only retry
// budget. It never decodes and re-encodes a prior AAC generation.
const aacBitrate = 256_000;
const maximumDeliveryPasses = 3;
const maximumDeliveryGainReductionDb = 6;
const deliverySafetyMarginDb = 0.05;
const deliveryGainPrecision = 1_000_000;
const loudnessToleranceLu = 0.2;
const maximumPathBytes = 16_384;
const maximumInputBytes = 64 * 1_024 * 1_024 * 1_024;
const candidateContainerOverheadBytes = 2 * 1_024 * 1_024;

const fallbackSource: ReferenceAudioPeakSource = Object.freeze({
  module: "<aac-delivery-runtime>",
  line: 1,
  column: 1,
});

type CommonDeliveryOptions = Omit<ReferenceAacDeliveryOptions, "output">;

type LocalInput = Readonly<{
  path: string;
  bytes: number;
  dev: number | bigint;
  ino: number | bigint;
}>;

function dataRecord(value: unknown, allowed: readonly string[]) {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    if (Object.getOwnPropertySymbols(value).length) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors);
    if (keys.some((key) => !allowed.includes(key))) return undefined;
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!("value" in descriptor) || !descriptor.enumerable) return undefined;
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return undefined;
  }
}

function normalizedSource(value: unknown) {
  const source = dataRecord(value, ["module", "line", "column", "nodeId"]);
  if (!source
    || typeof source.module !== "string"
    || source.module.length === 0
    || source.module.length > 4_096
    || /[\0\r\n]/u.test(source.module)
    || !Number.isSafeInteger(source.line)
    || (source.line as number) < 1
    || !Number.isSafeInteger(source.column)
    || (source.column as number) < 1
    || (source.nodeId !== undefined && (typeof source.nodeId !== "string" || source.nodeId.length === 0 || source.nodeId.length > 4_096 || /[\0\r\n]/u.test(source.nodeId)))) {
    return undefined;
  }
  return Object.freeze({
    module: source.module,
    line: source.line as number,
    column: source.column as number,
    ...(typeof source.nodeId === "string" ? { nodeId: source.nodeId } : {}),
  });
}

function deliveryError(
  code: ConstructorParameters<typeof ReferenceAudioDeliveryError>[0],
  source: ReferenceAudioPeakSource,
  message: string,
  detail: ConstructorParameters<typeof ReferenceAudioDeliveryError>[3],
  cause?: unknown,
): ReferenceAudioDeliveryError {
  return new ReferenceAudioDeliveryError(code, source, message, detail, cause === undefined ? undefined : { cause });
}

function structureFailure(source: ReferenceAudioPeakSource, reason: string, message: string): never {
  throw deliveryError("CUT_AUDIO_DELIVERY_STRUCTURE", source, message, { kind: "structure", reason });
}

function boundedPath(value: unknown, name: string, source: ReferenceAudioPeakSource) {
  if (typeof value !== "string"
    || value.length === 0
    || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > maximumPathBytes) {
    structureFailure(source, `invalid-${name}`, `${name} must be one bounded non-empty local path.`);
  }
  // Passing an absolute path makes strings such as https://... ordinary local
  // filenames rather than FFmpeg protocol selectors.
  return resolve(value);
}

function finiteRange(value: unknown, name: string, minimum: number, maximum: number, source: ReferenceAudioPeakSource) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    structureFailure(source, `invalid-${name}`, `${name} must be finite and between ${minimum} and ${maximum}.`);
  }
  return value;
}

function normalizedToolchain(value: unknown, source: ReferenceAudioPeakSource): ReferenceAudioToolchainIdentity | undefined {
  if (value === undefined) return undefined;
  const toolchain = dataRecord(value, ["format", "version", "runtime", "platform", "architecture", "node", "ffmpeg", "integrity"]);
  const ffmpeg = dataRecord(toolchain?.ffmpeg, ["version", "identitySha256"]);
  const bounded = (item: unknown, maximum = 256) => typeof item === "string" && item.length > 0 && item.length <= maximum && !/[\0\r\n]/u.test(item);
  if (!toolchain
    || Object.keys(toolchain).length !== 8
    || toolchain.format !== "cut-reference-audio-toolchain"
    || toolchain.version !== 1
    || !bounded(toolchain.runtime)
    || !bounded(toolchain.platform)
    || !bounded(toolchain.architecture)
    || !bounded(toolchain.node)
    || !ffmpeg
    || Object.keys(ffmpeg).length !== 2
    || !bounded(ffmpeg.version, 4_096)
    || typeof ffmpeg.identitySha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(ffmpeg.identitySha256)
    || typeof toolchain.integrity !== "string"
    || !/^[a-f0-9]{64}$/u.test(toolchain.integrity)) {
    structureFailure(source, "invalid-toolchain", "AAC delivery toolchain identity must be one closed bounded CUT audio identity.");
  }
  const content = {
    format: toolchain.format,
    version: toolchain.version,
    runtime: toolchain.runtime,
    platform: toolchain.platform,
    architecture: toolchain.architecture,
    node: toolchain.node,
    ffmpeg: { version: ffmpeg.version, identitySha256: ffmpeg.identitySha256 },
  };
  if (hash(content) !== toolchain.integrity) {
    structureFailure(source, "invalid-toolchain-integrity", "AAC delivery toolchain integrity does not match its canonical content.");
  }
  return Object.freeze({ ...content, integrity: toolchain.integrity }) as ReferenceAudioToolchainIdentity;
}

function normalizeCommonOptions(authored: unknown, allowed: readonly string[]): CommonDeliveryOptions & { stagingRoot?: string; toolchain?: ReferenceAudioToolchainIdentity } {
  const initial = dataRecord(authored, allowed);
  const source = normalizedSource(initial?.source) ?? fallbackSource;
  if (!initial) structureFailure(source, "invalid-options", "AAC delivery options must be a closed plain data object with no accessors or unknown fields.");
  if (!normalizedSource(initial.source)) structureFailure(source, "invalid-source", "AAC delivery source must contain a bounded module and positive integer line/column.");
  const target = dataRecord(initial.target, ["integratedLufs", "truePeakDbtp", "loudnessRangeLu"]);
  if (!target || Object.keys(target).length !== 3) structureFailure(source, "invalid-target", "AAC delivery target must contain exactly integratedLufs, truePeakDbtp, and loudnessRangeLu.");
  const expectedFrames = initial.expectedFrames;
  const sampleRate = initial.sampleRate;
  // The CUT scanner owns the exact rate/frame/work contract and produces the
  // normative source-located diagnostic before filesystem or backend work.
  assertReferenceAudioTruePeakScanContract({ expectedFrames: expectedFrames as number, sampleRate: sampleRate as number, source });
  const common = {
    silentVideo: boundedPath(initial.silentVideo, "silentVideo", source),
    normalizedPcm: boundedPath(initial.normalizedPcm, "normalizedPcm", source),
    target: Object.freeze({
      integratedLufs: finiteRange(target.integratedLufs, "target.integratedLufs", -70, -5, source),
      truePeakDbtp: finiteRange(target.truePeakDbtp, "target.truePeakDbtp", -9, 0, source),
      loudnessRangeLu: finiteRange(target.loudnessRangeLu, "target.loudnessRangeLu", 1, 50, source),
    }),
    sampleRate: sampleRate as number,
    expectedFrames: expectedFrames as number,
    source,
  };
  return {
    ...common,
    ...(initial.stagingRoot === undefined ? {} : { stagingRoot: boundedPath(initial.stagingRoot, "stagingRoot", source) }),
    ...(initial.toolchain === undefined ? {} : { toolchain: normalizedToolchain(initial.toolchain, source)! }),
  };
}

async function localInput(path: string, label: string, source: ReferenceAudioPeakSource): Promise<LocalInput> {
  try {
    const requested = await lstat(path);
    if (requested.isSymbolicLink() || !requested.isFile()) {
      structureFailure(source, `${label}-not-regular`, `${label} must be a direct regular local file.`);
    }
    if (!Number.isSafeInteger(requested.size) || requested.size < 1 || requested.size > maximumInputBytes) {
      throw deliveryError(
        "CUT_AUDIO_DELIVERY_RESOURCE_LIMIT",
        source,
        `${label} exceeds CUT's bounded local input size.`,
        { kind: "resource", reason: `${label}-byte-budget` },
      );
    }
    const physical = await realpath(path);
    const metadata = await lstat(physical);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.dev !== requested.dev || metadata.ino !== requested.ino) {
      structureFailure(source, `${label}-changed`, `${label} changed while CUT established its local-file boundary.`);
    }
    return Object.freeze({ path: physical, bytes: metadata.size, dev: metadata.dev, ino: metadata.ino });
  } catch (error) {
    if (error instanceof ReferenceAudioDeliveryError) throw error;
    throw deliveryError(
      "CUT_AUDIO_DELIVERY_STRUCTURE",
      source,
      `${label} is unavailable as one direct regular local file.`,
      { kind: "structure", reason: `${label}-unavailable` },
      error,
    );
  }
}

async function snapshotLocalInput(
  input: LocalInput,
  name: "silent-video" | "normalized-pcm" | "accepted-delivery",
  directory: string,
  source: ReferenceAudioPeakSource,
): Promise<LocalInput> {
  const destination = resolve(directory, `input-${name}.bin`);
  let sourceHandle: Awaited<ReturnType<typeof open>> | undefined;
  let destinationHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (typeof fsConstants.O_NOFOLLOW !== "number") {
      structureFailure(source, "no-follow-unavailable", "This platform cannot bind AAC inputs to private no-follow snapshots.");
    }
    sourceHandle = await open(input.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = await sourceHandle.stat();
    if (!before.isFile() || before.dev !== input.dev || before.ino !== input.ino || before.size !== input.bytes) {
      structureFailure(source, `${name}-changed`, `${name} changed before CUT could bind a private delivery snapshot.`);
    }
    destinationHandle = await open(
      destination,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    const chunk = Buffer.allocUnsafe(Math.min(1_048_576, input.bytes));
    let position = 0;
    while (position < input.bytes) {
      const requested = Math.min(chunk.byteLength, input.bytes - position);
      const { bytesRead } = await sourceHandle.read(chunk, 0, requested, position);
      if (bytesRead !== requested) {
        structureFailure(source, `${name}-changed`, `${name} changed while CUT bound its private delivery snapshot.`);
      }
      let written = 0;
      while (written < bytesRead) {
        const result = await destinationHandle.write(chunk, written, bytesRead - written, position + written);
        if (result.bytesWritten < 1) {
          structureFailure(source, `${name}-snapshot-write`, `CUT could not complete the private ${name} snapshot.`);
        }
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    const after = await sourceHandle.stat();
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) {
      structureFailure(source, `${name}-changed`, `${name} changed while CUT bound its private delivery snapshot.`);
    }
    const snapshot = await destinationHandle.stat();
    if (!snapshot.isFile() || snapshot.size !== input.bytes) {
      structureFailure(source, `${name}-snapshot-structure`, `CUT's private ${name} snapshot is incomplete.`);
    }
    return Object.freeze({ path: destination, bytes: snapshot.size, dev: snapshot.dev, ino: snapshot.ino });
  } catch (error) {
    if (error instanceof ReferenceAudioDeliveryError) throw error;
    throw deliveryError(
      "CUT_AUDIO_DELIVERY_STRUCTURE",
      source,
      `CUT could not bind ${name} to one private immutable delivery snapshot.`,
      { kind: "structure", reason: `${name}-snapshot` },
      error,
    );
  } finally {
    if (destinationHandle) await destinationHandle.close().catch(() => undefined);
    if (sourceHandle) await sourceHandle.close().catch(() => undefined);
  }
}

async function assertCandidateHash(path: string, expected: string, source: ReferenceAudioPeakSource) {
  const observed = await sha256RegularFile(path, source);
  if (observed.sha256 !== expected) {
    structureFailure(source, "candidate-changed", "Private AAC candidate bytes changed between delivery authorities.");
  }
  return observed;
}

type CanonicalPublicationDestination = Readonly<{
  requestedParent: string;
  physicalParent: string;
  destination: string;
  dev: number | bigint;
  ino: number | bigint;
}>;

async function canonicalPublicationDestination(output: string, source: ReferenceAudioPeakSource): Promise<CanonicalPublicationDestination> {
  const requestedParent = dirname(output);
  try {
    const requested = await lstat(requestedParent);
    if (requested.isSymbolicLink() || !requested.isDirectory()) {
      structureFailure(source, "publication-parent-structure", "AAC output parent must be a direct directory.");
    }
    const physicalParent = await realpath(requestedParent);
    const physical = await lstat(physicalParent);
    if (!physical.isDirectory() || physical.isSymbolicLink() || physical.dev !== requested.dev || physical.ino !== requested.ino) {
      structureFailure(source, "publication-parent-changed", "AAC output parent changed during publication preflight.");
    }
    return Object.freeze({
      requestedParent,
      physicalParent,
      destination: resolve(physicalParent, basename(output)),
      dev: physical.dev,
      ino: physical.ino,
    });
  } catch (error) {
    if (error instanceof ReferenceAudioDeliveryError) throw error;
    throw deliveryError("CUT_AUDIO_DELIVERY_PUBLICATION", source, "CUT could not establish a stable local AAC output parent.", { kind: "publication", reason: "publication-parent" }, error);
  }
}

async function assertPublicationDestination(destination: CanonicalPublicationDestination, source: ReferenceAudioPeakSource) {
  try {
    const [requested, physicalPath, physical] = await Promise.all([
      lstat(destination.requestedParent),
      realpath(destination.requestedParent),
      lstat(destination.physicalParent),
    ]);
    if (requested.isSymbolicLink()
      || !requested.isDirectory()
      || physicalPath !== destination.physicalParent
      || !physical.isDirectory()
      || physical.isSymbolicLink()
      || physical.dev !== destination.dev
      || physical.ino !== destination.ino
      || requested.dev !== destination.dev
      || requested.ino !== destination.ino) {
      structureFailure(source, "publication-parent-changed", "AAC output parent changed before verified publication.");
    }
  } catch (error) {
    if (error instanceof ReferenceAudioDeliveryError) throw error;
    throw deliveryError("CUT_AUDIO_DELIVERY_PUBLICATION", source, "AAC output parent became unavailable before publication.", { kind: "publication", reason: "publication-parent-changed" }, error);
  }
}

async function assertInputSnapshot(input: LocalInput, label: string, source: ReferenceAudioPeakSource) {
  try {
    const metadata = await lstat(input.path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.dev !== input.dev || metadata.ino !== input.ino || metadata.size !== input.bytes) {
      structureFailure(source, `${label}-changed`, `${label} changed before AAC encoding.`);
    }
  } catch (error) {
    if (error instanceof ReferenceAudioDeliveryError) throw error;
    throw deliveryError("CUT_AUDIO_DELIVERY_STRUCTURE", source, `${label} changed before AAC encoding.`, { kind: "structure", reason: `${label}-changed` }, error);
  }
}

async function privateStagingDirectory(root: string, source: ReferenceAudioPeakSource) {
  try {
    const requested = await lstat(root);
    if (requested.isSymbolicLink() || !requested.isDirectory()) structureFailure(source, "staging-root-structure", "AAC stagingRoot must be a direct directory.");
    const physical = await realpath(root);
    const metadata = await lstat(physical);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.dev !== requested.dev || metadata.ino !== requested.ino) {
      structureFailure(source, "staging-root-changed", "AAC stagingRoot changed during preflight.");
    }
    const directory = await mkdtemp(resolve(physical, ".cut-aac-delivery-"));
    await chmod(directory, 0o700);
    return directory;
  } catch (error) {
    if (error instanceof ReferenceAudioDeliveryError) throw error;
    throw deliveryError("CUT_AUDIO_DELIVERY_PUBLICATION", source, "CUT could not create private same-filesystem AAC staging.", { kind: "publication", reason: "staging-create" }, error);
  }
}

async function sha256RegularFile(path: string, source: ReferenceAudioPeakSource) {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let stream: ReturnType<Awaited<ReturnType<typeof open>>["createReadStream"]> | undefined;
  try {
    if (typeof fsConstants.O_NOFOLLOW !== "number") structureFailure(source, "no-follow-unavailable", "This platform cannot hash AAC evidence with no-follow semantics.");
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (!metadata.isFile()) structureFailure(source, "candidate-not-regular", "AAC candidate must be a regular file.");
    const digest = createHash("sha256");
    stream = handle.createReadStream({ autoClose: false });
    for await (const chunk of stream) digest.update(chunk);
    return { sha256: digest.digest("hex"), bytes: metadata.size };
  } catch (error) {
    if (error instanceof ReferenceAudioDeliveryError) throw error;
    throw deliveryError("CUT_AUDIO_DELIVERY_STRUCTURE", source, "CUT could not verify private AAC candidate bytes.", { kind: "structure", reason: "candidate-read" }, error);
  } finally {
    stream?.destroy();
    if (handle) await handle.close().catch(() => undefined);
  }
}

function roundedGain(value: number) { return Math.round(value * deliveryGainPrecision) / deliveryGainPrecision; }
function linearGain(db: number) { return Number((10 ** (db / 20)).toFixed(12)); }

function passEvidence(
  pass: number,
  appliedGainDb: number,
  encodedSha256: string,
  decoded: ReferenceDecodedTruePeakEvidence,
  measurement: ReferenceLoudnessMeasurement,
  target: ReferenceAacDeliveryTarget,
): ReferenceAacDeliveryPass {
  const cutTruePeakResidualDb = decoded.truePeak.truePeakDbtp === null ? null : decoded.truePeak.truePeakDbtp - target.truePeakDbtp;
  const ffmpegTruePeakResidualDb = measurement.truePeakDbtp === null ? null : measurement.truePeakDbtp - target.truePeakDbtp;
  const residuals = [cutTruePeakResidualDb, ffmpegTruePeakResidualDb].filter((value): value is number => value !== null);
  const truePeakResidualDb = residuals.length ? Math.max(...residuals) : null;
  const loudnessResidualLu = measurement.integratedLufs === null ? null : target.integratedLufs - measurement.integratedLufs;
  const cutTruePeakCompliant = cutTruePeakResidualDb === null || cutTruePeakResidualDb <= 0;
  const ffmpegTruePeakCompliant = ffmpegTruePeakResidualDb === null ? null : ffmpegTruePeakResidualDb <= 0;
  return {
    pass,
    source: "normalized-pcm",
    appliedGainDb,
    decoded: decoded.framing,
    cutTruePeak: decoded.truePeak,
    encodedSha256,
    authoredPcmSha256: decoded.authoredPcmSha256,
    measurement,
    cutTruePeakResidualDb,
    ffmpegTruePeakResidualDb,
    cutTruePeakCompliant,
    ffmpegTruePeakCompliant,
    truePeakResidualDb,
    loudnessResidualLu,
    truePeakCompliant: cutTruePeakCompliant && ffmpegTruePeakCompliant !== false,
  };
}

async function encodeAacPass(
  silentVideo: LocalInput,
  normalizedPcm: LocalInput,
  output: string,
  appliedGainDb: number,
  sampleRate: number,
  expectedFrames: number,
  source: ReferenceAudioPeakSource,
) {
  const audioFilter = appliedGainDb === 0 ? "anull" : `volume=${linearGain(appliedGainDb)}`;
  await assertInputSnapshot(silentVideo, "silentVideo", source);
  await assertInputSnapshot(normalizedPcm, "normalizedPcm", source);
  const audioBytes = Math.ceil((expectedFrames / sampleRate) * (aacBitrate / 8) * 2);
  const maximumCandidateBytes = silentVideo.bytes + audioBytes + candidateContainerOverheadBytes;
  if (!Number.isSafeInteger(maximumCandidateBytes)) {
    throw deliveryError("CUT_AUDIO_DELIVERY_RESOURCE_LIMIT", source, "AAC candidate byte budget exceeds a safe integer.", { kind: "resource", reason: "candidate-byte-budget", expectedFrames });
  }
  try {
    await runFfmpeg([
      "-y", "-v", "error",
      "-protocol_whitelist", "file,pipe",
      "-i", silentVideo.path,
      "-protocol_whitelist", "file,pipe",
      "-i", normalizedPcm.path,
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-c:v", "copy",
      "-af", audioFilter,
      "-c:a", "aac",
      "-b:a", String(aacBitrate),
      "-movie_timescale", String(sampleRate),
      "-movflags", "+faststart",
      "-shortest",
      "-fs", String(maximumCandidateBytes),
      output,
    ]);
  } catch (error) {
    throw deliveryError(
      "CUT_AUDIO_DELIVERY_ENCODE",
      source,
      "CUT could not encode a bounded PCM-sourced AAC candidate.",
      { kind: "encode", reason: "ffmpeg-encode", expectedFrames },
      error,
    );
  }
  const candidate = await sha256RegularFile(output, source);
  if (candidate.bytes < 1 || candidate.bytes > maximumCandidateBytes) {
    throw deliveryError(
      "CUT_AUDIO_DELIVERY_RESOURCE_LIMIT",
      source,
      "AAC candidate exceeded its duration-derived output-byte budget.",
      { kind: "resource", reason: "candidate-byte-budget", expectedFrames },
    );
  }
  return candidate;
}

function completedReport(
  target: ReferenceAacDeliveryTarget,
  normalizedPcm: ReferenceDecodedTruePeakEvidence,
  passes: ReferenceAacDeliveryPass[],
  appliedGainDb: number,
  toolchain: ReferenceAudioToolchainIdentity,
): ReferenceAacDeliveryReport {
  const final = passes.at(-1)!;
  const status = final.measurement.integratedLufs === null
    ? "loudness-unmeasurable"
    : appliedGainDb === 0
      ? "not-needed"
      : final.loudnessResidualLu !== null && Math.abs(final.loudnessResidualLu) > loudnessToleranceLu
        ? "peak-limited"
        : "reconciled";
  return {
    format: "cut-reference-aac-delivery",
    version: 2,
    codec: {
      name: "aac",
      implementation: "ffmpeg-native-aac",
      bitrate: aacBitrate,
      container: "mp4",
      movieTimescale: normalizedPcm.framing.sampleRate,
      primingFrames: 1_024,
    },
    source: "normalized-pcm",
    truePeakAuthority: "cut-bs1770-5-with-conservative-ffmpeg-cross-check",
    toolchain,
    target: { ...target },
    normalizedPcm,
    maxPasses: maximumDeliveryPasses,
    maxGainReductionDb: maximumDeliveryGainReductionDb,
    safetyMarginDb: deliverySafetyMarginDb,
    passCount: passes.length,
    passes,
    appliedGainDb,
    status,
    truePeakCompliant: final.truePeakCompliant,
    residuals: { truePeakDb: final.truePeakResidualDb, loudnessLu: final.loudnessResidualLu },
    finalFfmpegMeasurement: final.measurement,
  };
}

async function prepareNormalizedReferenceAac(
  options: CommonDeliveryOptions & { stagingRoot: string; toolchain: ReferenceAudioToolchainIdentity },
): Promise<PreparedReferenceAacDelivery> {
  const temporaryDirectory = await privateStagingDirectory(options.stagingRoot, options.source);
  const passes: ReferenceAacDeliveryPass[] = [];
  let appliedGainDb = 0;
  let retainedArtifact: string | undefined;
  try {
    const [authoredSilentVideo, authoredNormalizedInput] = await Promise.all([
      localInput(options.silentVideo, "silentVideo", options.source),
      localInput(options.normalizedPcm, "normalizedPcm", options.source),
    ]);
    // Every probe, measurement and encoder pass consumes these same private
    // bytes. A caller replacing or editing an authored path after preflight
    // cannot make normalized evidence describe a different master from the
    // one delivered.
    const [silentVideo, normalizedInput] = await Promise.all([
      snapshotLocalInput(authoredSilentVideo, "silent-video", temporaryDirectory, options.source),
      snapshotLocalInput(authoredNormalizedInput, "normalized-pcm", temporaryDirectory, options.source),
    ]);
    const maximumNormalizedBytes = options.expectedFrames * 8 + 1_048_576;
    if (normalizedInput.bytes > maximumNormalizedBytes) {
      throw deliveryError(
        "CUT_AUDIO_DELIVERY_RESOURCE_LIMIT",
        options.source,
        "normalizedPcm exceeds CUT's authored-boundary byte budget.",
        { kind: "resource", reason: "normalized-pcm-byte-budget", expectedFrames: options.expectedFrames },
      );
    }
    const normalizedPcm = await inspectReferenceDecodedTruePeak({
      input: normalizedInput.path,
      workDirectory: temporaryDirectory,
      kind: "normalized-pcm",
      expectedFrames: options.expectedFrames,
      sampleRate: options.sampleRate,
      source: options.source,
    });
    for (let pass = 1; pass <= maximumDeliveryPasses; pass += 1) {
      const candidate = resolve(temporaryDirectory, `delivery-pass-${pass}.mp4`);
      const encoded = await encodeAacPass(
        silentVideo,
        normalizedInput,
        candidate,
        appliedGainDb,
        options.sampleRate,
        options.expectedFrames,
        options.source,
      );
      // Framing validation owns the sample-domain boundary. Only after that
      // succeeds may the secondary FFmpeg authority measure the same exact
      // authored frames; codec padding is not programme audio.
      const decoded = await inspectReferenceDecodedTruePeak({
        input: candidate,
        workDirectory: temporaryDirectory,
        kind: "aac-candidate",
        expectedFrames: options.expectedFrames,
        sampleRate: options.sampleRate,
        source: options.source,
      });
      await assertCandidateHash(candidate, encoded.sha256, options.source);
      let measurement: ReferenceLoudnessMeasurement;
      try {
        measurement = await measureReferenceAudioAuthoredBoundary(candidate, {
          expectedFrames: options.expectedFrames,
          sampleRate: options.sampleRate,
          targetLufs: options.target.integratedLufs,
          truePeakDbtp: options.target.truePeakDbtp,
          loudnessRangeLu: options.target.loudnessRangeLu,
        });
      } catch (error) {
        throw deliveryError(
          error instanceof ReferenceAudioLoudnessBoundaryError && error.code === "CUT_AUDIO_LOUDNESS_BOUNDARY_RESOURCE_LIMIT"
            ? "CUT_AUDIO_DELIVERY_RESOURCE_LIMIT"
            : "CUT_AUDIO_DELIVERY_MEASUREMENT",
          options.source,
          "FFmpeg could not measure the exact authored AAC sample boundary.",
          {
            kind: error instanceof ReferenceAudioLoudnessBoundaryError && error.code === "CUT_AUDIO_LOUDNESS_BOUNDARY_RESOURCE_LIMIT" ? "resource" : "measurement",
            reason: error instanceof ReferenceAudioLoudnessBoundaryError ? error.detail.reason : "ffmpeg-authored-boundary",
            expectedFrames: options.expectedFrames,
          },
          error,
        );
      }
      await assertCandidateHash(candidate, encoded.sha256, options.source);
      const evidence = passEvidence(pass, appliedGainDb, encoded.sha256, decoded, measurement, options.target);
      passes.push(evidence);

      if (evidence.truePeakCompliant) {
        // No backend process is given the final publication inode. Copy the
        // fully measured candidate into a new private file and require exact
        // byte identity before handing it to the caller's transaction.
        const candidateInput = await localInput(candidate, "acceptedCandidate", options.source);
        const accepted = await snapshotLocalInput(candidateInput, "accepted-delivery", temporaryDirectory, options.source);
        await assertCandidateHash(accepted.path, encoded.sha256, options.source);
        retainedArtifact = accepted.path;
        let cleaned = false;
        return Object.freeze({
          artifact: accepted.path,
          report: completedReport(options.target, normalizedPcm, passes, appliedGainDb, options.toolchain),
          verify: () => assertCandidateHash(accepted.path, encoded.sha256, options.source).then(() => undefined),
          cleanup: async () => {
            if (cleaned) return;
            cleaned = true;
            await rm(temporaryDirectory, { recursive: true, force: true });
          },
        });
      }
      if (pass === maximumDeliveryPasses) {
        throw new ReferenceAudioDeliveryError(
          "CUT_AUDIO_DELIVERY_TRUE_PEAK",
          options.source,
          `AAC delivery remained ${evidence.truePeakResidualDb!.toFixed(3)} dB above the authored ${options.target.truePeakDbtp} dBTP ceiling after ${maximumDeliveryPasses} bounded PCM-sourced passes.`,
          { kind: "true-peak", reason: "pass-budget", expectedFrames: options.expectedFrames, peakDbtp: Math.max(decoded.truePeak.truePeakDbtp ?? -Infinity, measurement.truePeakDbtp ?? -Infinity), thresholdDbtp: options.target.truePeakDbtp },
        );
      }

      const requiredGainDb = roundedGain(appliedGainDb - evidence.truePeakResidualDb! - deliverySafetyMarginDb);
      if (requiredGainDb < -maximumDeliveryGainReductionDb) {
        throw new ReferenceAudioDeliveryError(
          "CUT_AUDIO_DELIVERY_RESOURCE_LIMIT",
          options.source,
          `AAC delivery needs ${requiredGainDb.toFixed(3)} dB of PCM gain reduction to meet the authored ${options.target.truePeakDbtp} dBTP ceiling, beyond the bounded ${maximumDeliveryGainReductionDb} dB delivery stage.`,
          { kind: "resource", reason: "gain-reduction-budget", expectedFrames: options.expectedFrames, peakDbtp: Math.max(decoded.truePeak.truePeakDbtp ?? -Infinity, measurement.truePeakDbtp ?? -Infinity), thresholdDbtp: options.target.truePeakDbtp },
        );
      }
      if (requiredGainDb >= appliedGainDb) {
        throw new ReferenceAudioDeliveryError(
          "CUT_AUDIO_DELIVERY_TRUE_PEAK",
          options.source,
          "AAC delivery could not derive a strictly downward correction from its measured output.",
          { kind: "true-peak", reason: "non-downward-correction", expectedFrames: options.expectedFrames, thresholdDbtp: options.target.truePeakDbtp },
        );
      }
      appliedGainDb = requiredGainDb;
    }
    throw new ReferenceAudioDeliveryError(
      "CUT_AUDIO_DELIVERY_TRUE_PEAK",
      options.source,
      "AAC delivery exhausted its bounded reconciliation loop.",
      { kind: "true-peak", reason: "pass-budget", expectedFrames: options.expectedFrames, thresholdDbtp: options.target.truePeakDbtp },
    );
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    // Successful preparation deliberately retains the private stage for the
    // caller's transaction. Every failing path cleans it without masking the
    // source-owned primary error.
    if (!retainedArtifact) await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Prepare an AAC artifact inside a mode-0700 same-filesystem directory. The
 * caller owns the only publication step and must call cleanup after commit or
 * rollback. This is the canonical render path.
 */
export async function prepareReferenceAacDelivery(authored: ReferenceAacPreparationOptions): Promise<PreparedReferenceAacDelivery> {
  const options = normalizeCommonOptions(authored, ["silentVideo", "normalizedPcm", "stagingRoot", "target", "sampleRate", "expectedFrames", "source", "toolchain"]);
  if (!options.stagingRoot) structureFailure(options.source, "missing-staging-root", "AAC preparation requires stagingRoot.");
  if (!options.toolchain) structureFailure(options.source, "missing-toolchain", "AAC preparation requires one verified audio toolchain identity.");
  return prepareNormalizedReferenceAac({ ...options, stagingRoot: options.stagingRoot, toolchain: options.toolchain });
}

/**
 * Standalone safe leaf publication. Canonical multi-artifact rendering uses
 * prepareReferenceAacDelivery and the rollback-safe transaction instead.
 */
export async function deliverReferenceAac(authored: ReferenceAacDeliveryOptions): Promise<ReferenceAacDeliveryReport> {
  const options = normalizeCommonOptions(authored, ["silentVideo", "normalizedPcm", "output", "target", "sampleRate", "expectedFrames", "source"]);
  const record = dataRecord(authored, ["silentVideo", "normalizedPcm", "output", "target", "sampleRate", "expectedFrames", "source"]);
  const output = boundedPath(record?.output, "output", options.source);
  const publication = await canonicalPublicationDestination(output, options.source);
  const toolchain = await collectReferenceAudioToolchainIdentity();
  const prepared = await prepareNormalizedReferenceAac({ ...options, stagingRoot: publication.physicalParent, toolchain });
  try {
    try {
      await prepared.verify();
      await assertPublicationDestination(publication, options.source);
      // Rename replaces a leaf symlink itself and never opens its target.
      await publishStagedFile(prepared.artifact, publication.destination);
    } catch (error) {
      if (error instanceof ReferenceAudioDeliveryError) throw error;
      throw deliveryError("CUT_AUDIO_DELIVERY_PUBLICATION", options.source, "CUT could not publish the verified AAC leaf.", { kind: "publication", reason: "leaf-rename", expectedFrames: options.expectedFrames }, error);
    }
    return prepared.report;
  } finally {
    // Once rename commits, private cleanup cannot turn a successful delivery
    // into a reported rollback. Failure paths likewise preserve their primary.
    await prepared.cleanup().catch(() => undefined);
  }
}
