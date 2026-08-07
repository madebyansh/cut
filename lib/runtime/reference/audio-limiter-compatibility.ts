import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, resolve } from "node:path";
import { types as utilTypes } from "node:util";
import { hash } from "../../core/stable";
import {
  spawnBoundReferenceNativeProcess,
  type BoundReferenceNativeMediaTool,
  type ReferenceNativeProcessCollector,
  type ReferenceNativeProcessContext,
} from "../../project/native-process-authority";
import {
  deriveReferenceAudioLimiterTruePeakEnvelope,
  referenceAudioLimiterResultProducerAuthority,
  referenceAudioLimiterIdentity,
  referenceAudioLimiterLimits,
  type ReferenceAudioLimiterResult,
  type ReferenceAudioLimiterSummary,
} from "./audio-limiter";
import {
  measureReferenceAudioLimiterSnapshotTruePeak,
  referenceAudioLimiterFileSummaryProducerAuthority,
  referenceAudioLimiterFileLimits,
  referenceAudioLimiterUniformFileCorrectionProducerAuthority,
  type ReferenceAudioLimiterUniformFileCorrectionResult,
} from "./audio-limiter-file";
import type { ReferenceAudioPeakSource } from "./audio-peak";

export const referenceAudioLimiterCompatibilityIdentity =
  "cut.reference-limiter-static-compatibility/ffmpeg-loudnorm-input-tp-exact-f32-v1" as const;
export const referenceAudioLimiterCompatibilitySafetyDb = 0.01 as const;
export const referenceAudioLimiterCutPeakWitnessIdentity =
  "cut.reference-limiter-private-cut-peak-witness/exact-full-boundary-v1" as const;

export const referenceAudioLimiterCompatibilityLimits = Object.freeze({
  sampleRate: referenceAudioLimiterLimits.supportedSampleRate,
  channels: 2 as const,
  maximumFrames: referenceAudioLimiterFileLimits.maximumFrames,
  maximumPathBytes: 16_384,
  maximumFfmpegOutputBytes: 256_000,
  maximumExecutableBytes: 256 * 1_024 * 1_024,
  maximumPathEnvironmentBytes: 128_000,
  timeoutMs: 300_000,
});

export type ReferenceAudioLimiterCompatibilityErrorCode =
  | "CUT_AUDIO_LIMITER_COMPATIBILITY_STRUCTURE"
  | "CUT_AUDIO_LIMITER_COMPATIBILITY_SOURCE"
  | "CUT_AUDIO_LIMITER_COMPATIBILITY_WORK_LIMIT"
  | "CUT_AUDIO_LIMITER_COMPATIBILITY_TOOLCHAIN"
  | "CUT_AUDIO_LIMITER_COMPATIBILITY_MEASUREMENT"
  | "CUT_AUDIO_LIMITER_COMPATIBILITY_CORRECTION";

export class ReferenceAudioLimiterCompatibilityError extends Error {
  readonly source: ReferenceAudioPeakSource;

  constructor(
    readonly code: ReferenceAudioLimiterCompatibilityErrorCode,
    source: ReferenceAudioPeakSource,
    message: string,
    readonly reason: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "ReferenceAudioLimiterCompatibilityError";
    this.source = Object.freeze({ ...source });
  }
}

export type ReferenceAudioLimiterCompatibilityToolchain = Readonly<{
  format: "cut-reference-audio-limiter-compatibility-toolchain";
  version: 1;
  policy: typeof referenceAudioLimiterCompatibilityIdentity;
  ffmpeg: {
    version: string;
    bannerSha256: string;
    executableSha256: string;
    executableBytes: number;
  };
  integrity: string;
}>;

export type ReferenceAudioLimiterStaticCompatibilityReport = Readonly<{
  format: "cut-reference-audio-limiter-static-compatibility";
  version: 1;
  policy: typeof referenceAudioLimiterCompatibilityIdentity;
  boundary: {
    sampleRate: typeof referenceAudioLimiterCompatibilityLimits.sampleRate;
    channels: 2;
    sampleFormat: "f32le";
    expectedFrames: number;
    expectedBytes: number;
    suffixBytesExcluded: number;
    sha256: string;
  };
  targetCeilingDbtp: number;
  safetyDb: typeof referenceAudioLimiterCompatibilitySafetyDb;
  cut: {
    method: typeof referenceAudioLimiterIdentity;
    truePeakLinear: number;
    truePeakDbtp: number | null;
  };
  ffmpeg: {
    method: "loudnorm-input_tp";
    truePeakDbtp: number | null;
  };
  correctionFactor: number;
  toolchain: ReferenceAudioLimiterCompatibilityToolchain;
  integrity: string;
}>;

export type ReferenceAudioLimiterStaticCorrectionOptions = Readonly<{
  cutTruePeakDbtp: number | null;
  ffmpegTruePeakDbtp: number | null;
  targetCeilingDbtp: number;
  source: ReferenceAudioPeakSource;
}>;

export type ReferenceAudioLimiterStaticCompatibilityOptions = Readonly<{
  expectedFrames: number;
  sampleRate: number;
  targetCeilingDbtp: number;
  source: ReferenceAudioPeakSource;
}>;

/**
 * An in-process capability issued only after a limiter producer has published
 * and rebound one exact output boundary. It is deliberately absent from every
 * public report and persisted receipt: structured cloning or reconstructing
 * these fields does not preserve the private capability.
 */
export type ReferenceAudioLimiterCutPeakWitness = Readonly<{
  format: "cut-reference-audio-limiter-private-cut-peak-witness";
  version: 1;
  policy: typeof referenceAudioLimiterCutPeakWitnessIdentity;
  algorithm: typeof referenceAudioLimiterIdentity;
  producerStage: "core-final" | "compatibility-corrected";
  sampleRate: typeof referenceAudioLimiterCompatibilityLimits.sampleRate;
  channels: 2;
  sampleFormat: "f32le";
  expectedFrames: number;
  expectedBytes: number;
  sha256: string;
  coreEvidenceIntegrity: string;
  compatibilityCorrectionFactor: number;
  truePeakLinear: number;
  truePeakDbtp: number | null;
  truePeakFrame: number | null;
}>;

export type ReferenceAudioLimiterCoreCutPeakWitnessIssueOptions = Readonly<{
  producer: ReferenceAudioLimiterResult | ReferenceAudioLimiterSummary;
  coreEvidenceIntegrity: string;
  source: ReferenceAudioPeakSource;
}>;

export type ReferenceAudioLimiterCorrectedCutPeakWitnessIssueOptions = Readonly<{
  coreWitness: ReferenceAudioLimiterCutPeakWitness;
  correction: ReferenceAudioLimiterUniformFileCorrectionResult;
  source: ReferenceAudioPeakSource;
}>;

const issuedCutPeakWitnesses = new WeakSet<object>();

const fallbackSource: ReferenceAudioPeakSource = Object.freeze({
  module: "<limiter-compatibility>",
  line: 1,
  column: 1,
});

function closedRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    if (Object.getOwnPropertySymbols(value).length !== 0) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Object.keys(descriptors);
    return ownKeys.length === keys.length
      && ownKeys.every((key) => keys.includes(key) && "value" in descriptors[key]);
  } catch {
    return false;
  }
}

function normalizedSource(value: unknown) {
  if (!closedRecord(value, ["module", "line", "column"])
    && !closedRecord(value, ["module", "line", "column", "nodeId"])) return undefined;
  if (typeof value.module !== "string"
    || value.module.length === 0
    || value.module.length > 4_096
    || /[\0\r\n]/u.test(value.module)
    || !Number.isSafeInteger(value.line)
    || (value.line as number) < 1
    || !Number.isSafeInteger(value.column)
    || (value.column as number) < 1
    || (value.nodeId !== undefined
      && (typeof value.nodeId !== "string" || value.nodeId.length > 4_096 || /[\0\r\n]/u.test(value.nodeId)))) return undefined;
  return Object.freeze({
    module: value.module,
    line: value.line as number,
    column: value.column as number,
    ...(typeof value.nodeId === "string" ? { nodeId: value.nodeId } : {}),
  });
}

function fail(
  code: ReferenceAudioLimiterCompatibilityErrorCode,
  source: ReferenceAudioPeakSource,
  reason: string,
  message: string,
  cause?: unknown,
): never {
  throw compatibilityError(code, source, reason, message, cause);
}

function compatibilityError(
  code: ReferenceAudioLimiterCompatibilityErrorCode,
  source: ReferenceAudioPeakSource,
  reason: string,
  message: string,
  cause?: unknown,
) {
  return new ReferenceAudioLimiterCompatibilityError(
    code,
    source,
    message,
    reason,
    cause === undefined ? undefined : { cause },
  );
}

function systemCode(error: unknown) {
  try {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    return typeof code === "string" && /^[A-Z0-9_]{1,32}$/u.test(code) ? code : "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}

function normalizedPeak(value: unknown, name: string, source: ReferenceAudioPeakSource) {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < -1_000 || value > 1_000) {
    fail("CUT_AUDIO_LIMITER_COMPATIBILITY_STRUCTURE", source, `invalid-${name}`, `${name} must be null or one bounded finite dBTP value.`);
  }
  return value;
}

function normalizedTarget(value: unknown, source: ReferenceAudioPeakSource) {
  if (typeof value !== "number"
    || !Number.isFinite(value)
    || value < referenceAudioLimiterLimits.minimumCeilingDbtp
    || value > referenceAudioLimiterLimits.maximumCeilingDbtp) {
    fail(
      "CUT_AUDIO_LIMITER_COMPATIBILITY_STRUCTURE",
      source,
      "invalid-target-ceiling",
      `targetCeilingDbtp must be between ${referenceAudioLimiterLimits.minimumCeilingDbtp} and ${referenceAudioLimiterLimits.maximumCeilingDbtp}.`,
    );
  }
  return value;
}

export function assertReferenceAudioLimiterStaticCorrectionFactor(
  value: unknown,
  source: ReferenceAudioPeakSource = fallbackSource,
) {
  const normalized = normalizedSource(source);
  if (!normalized) {
    fail(
      "CUT_AUDIO_LIMITER_COMPATIBILITY_STRUCTURE",
      fallbackSource,
      "invalid-correction-source",
      "static compatibility correction source must be one closed source location.",
    );
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
    fail(
      "CUT_AUDIO_LIMITER_COMPATIBILITY_CORRECTION",
      normalized,
      "invalid-correction-factor",
      "static compatibility correction factor must be finite, greater than zero, and no greater than one.",
    );
  }
  return value;
}

/** Pure CUT-owned policy. FFmpeg supplies only its independently named reading. */
export function deriveReferenceAudioLimiterStaticCorrection(
  authored: ReferenceAudioLimiterStaticCorrectionOptions,
) {
  const initial = closedRecord(authored, ["cutTruePeakDbtp", "ffmpegTruePeakDbtp", "targetCeilingDbtp", "source"])
    ? authored
    : undefined;
  const source = normalizedSource(initial?.source) ?? fallbackSource;
  if (!initial || !normalizedSource(initial.source)) {
    fail("CUT_AUDIO_LIMITER_COMPATIBILITY_STRUCTURE", source, "invalid-correction-options", "static correction options and source must be closed plain data objects.");
  }
  const cut = normalizedPeak(initial.cutTruePeakDbtp, "cut-true-peak", source);
  const ffmpeg = normalizedPeak(initial.ffmpegTruePeakDbtp, "ffmpeg-true-peak", source);
  const target = normalizedTarget(initial.targetCeilingDbtp, source);
  const worst = Math.max(cut ?? -Infinity, ffmpeg ?? -Infinity);
  const guardedTarget = target - referenceAudioLimiterCompatibilitySafetyDb;
  const factor = worst > guardedTarget
    ? 10 ** ((guardedTarget - worst) / 20)
    : 1;
  return assertReferenceAudioLimiterStaticCorrectionFactor(factor, source);
}

function normalizedMeasureOptions(authored: unknown) {
  const initial = closedRecord(authored, ["expectedFrames", "sampleRate", "targetCeilingDbtp", "source"])
    ? authored
    : undefined;
  const source = normalizedSource(initial?.source) ?? fallbackSource;
  if (!initial || !normalizedSource(initial.source)) {
    fail("CUT_AUDIO_LIMITER_COMPATIBILITY_STRUCTURE", source, "invalid-measure-options", "static compatibility options and source must be closed plain data objects.");
  }
  if (!Number.isSafeInteger(initial.expectedFrames) || (initial.expectedFrames as number) < 1) {
    fail("CUT_AUDIO_LIMITER_COMPATIBILITY_STRUCTURE", source, "invalid-frame-count", "expectedFrames must be one positive safe integer.");
  }
  if ((initial.expectedFrames as number) > referenceAudioLimiterCompatibilityLimits.maximumFrames) {
    fail("CUT_AUDIO_LIMITER_COMPATIBILITY_WORK_LIMIT", source, "frame-budget", `expectedFrames exceeds the bounded ${referenceAudioLimiterCompatibilityLimits.maximumFrames}-frame compatibility domain.`);
  }
  if (initial.sampleRate !== referenceAudioLimiterCompatibilityLimits.sampleRate) {
    fail("CUT_AUDIO_LIMITER_COMPATIBILITY_STRUCTURE", source, "unsupported-sample-rate", `static compatibility measurement supports exactly ${referenceAudioLimiterCompatibilityLimits.sampleRate} Hz.`);
  }
  return Object.freeze({
    expectedFrames: initial.expectedFrames as number,
    sampleRate: referenceAudioLimiterCompatibilityLimits.sampleRate,
    targetCeilingDbtp: normalizedTarget(initial.targetCeilingDbtp, source),
    source,
  });
}

function normalizedPath(value: unknown, source: ReferenceAudioPeakSource) {
  if (typeof value !== "string"
    || value.length === 0
    || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > referenceAudioLimiterCompatibilityLimits.maximumPathBytes) {
    fail("CUT_AUDIO_LIMITER_COMPATIBILITY_STRUCTURE", source, "invalid-input-path", "compatibility input must be one bounded non-empty local path.");
  }
  return value;
}

async function snapshotExactPrefix(path: string, expectedFrames: number, source: ReferenceAudioPeakSource) {
  const expectedBytes = expectedFrames * 8;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (typeof fsConstants.O_NOFOLLOW !== "number") {
      fail("CUT_AUDIO_LIMITER_COMPATIBILITY_SOURCE", source, "no-follow-unavailable", "platform cannot bind compatibility input to a no-follow handle.");
    }
    const pathMetadata = await lstat(path, { bigint: true });
    if (pathMetadata.isSymbolicLink()
      || !pathMetadata.isFile()
      || pathMetadata.size < BigInt(expectedBytes)
      || pathMetadata.size > BigInt(referenceAudioLimiterCompatibilityLimits.maximumFrames * 8)
      || pathMetadata.size % 8n !== 0n) {
      fail("CUT_AUDIO_LIMITER_COMPATIBILITY_SOURCE", source, "invalid-direct-f32", "compatibility input must be one bounded direct stereo f32le file containing the complete exact boundary.");
    }
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()
      || before.dev !== pathMetadata.dev
      || before.ino !== pathMetadata.ino
      || before.size !== pathMetadata.size) {
      fail("CUT_AUDIO_LIMITER_COMPATIBILITY_SOURCE", source, "path-handle-mismatch", "compatibility input path and no-follow handle do not identify the same direct file.");
    }
    const bytes = Buffer.allocUnsafe(expectedBytes);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const afterPath = await lstat(path, { bigint: true });
    if (offset !== expectedBytes
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs
      || after.dev !== afterPath.dev
      || after.ino !== afterPath.ino
      || after.size !== afterPath.size
      || after.mtimeNs !== afterPath.mtimeNs
      || after.ctimeNs !== afterPath.ctimeNs) {
      fail("CUT_AUDIO_LIMITER_COMPATIBILITY_SOURCE", source, "changed-read", "compatibility input changed while CUT snapshotted its exact f32 boundary.");
    }
    return Object.freeze({
      bytes,
      expectedBytes,
      suffixBytesExcluded: Number(before.size - BigInt(expectedBytes)),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  } catch (error) {
    if (error instanceof ReferenceAudioLimiterCompatibilityError) throw error;
    fail("CUT_AUDIO_LIMITER_COMPATIBILITY_SOURCE", source, "read-failed", `compatibility input could not be snapshotted (${systemCode(error)}).`, error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function expectedCoreEvidenceIntegrity(
  producer: ReferenceAudioLimiterResult | ReferenceAudioLimiterSummary,
) {
  return hash(Object.freeze({
    format: "cut-reference-audio-limiter-core-evidence" as const,
    version: 2 as const,
    algorithm: producer.algorithm,
    sampleRate: producer.sampleRate,
    frames: producer.frames,
    lookaheadSamples: producer.lookaheadSamples,
    guardDb: producer.guardDb,
    execution: Object.freeze(producer.frames > referenceAudioLimiterLimits.maximumFrames
      ? {
        mode: "chunked-file" as const,
        chunkFrames: referenceAudioLimiterFileLimits.chunkFrames,
      }
      : {
        mode: "in-memory" as const,
        chunkFrames: null,
      }),
    ceiling: Object.freeze({
      mode: producer.ceilingMode,
      minimumDbtp: producer.minimumCeilingDbtp,
      maximumDbtp: producer.maximumCeilingDbtp,
    }),
    gain: Object.freeze({
      minimumApplied: producer.minimumAppliedGain,
      reconciliationFactor: producer.reconciliationFactor,
      minimumFinal: producer.minimumFinalGain,
    }),
    outputTruePeak: Object.freeze({
      linear: producer.maximumOutputTruePeakLinear,
      dbtp: producer.maximumOutputTruePeakDbtp,
      frame: producer.maximumOutputTruePeakFrame,
    }),
  }));
}

function issuedWitness(
  producerStage: ReferenceAudioLimiterCutPeakWitness["producerStage"],
  snapshot: Awaited<ReturnType<typeof snapshotExactPrefix>>,
  coreEvidenceIntegrity: string,
  compatibilityCorrectionFactor: number,
  peak: Readonly<{ linear: number; dbtp: number | null; frame: number | null }>,
) {
  const witness = Object.freeze({
    format: "cut-reference-audio-limiter-private-cut-peak-witness" as const,
    version: 1 as const,
    policy: referenceAudioLimiterCutPeakWitnessIdentity,
    algorithm: referenceAudioLimiterIdentity,
    producerStage,
    sampleRate: referenceAudioLimiterCompatibilityLimits.sampleRate,
    channels: 2 as const,
    sampleFormat: "f32le" as const,
    expectedFrames: snapshot.expectedBytes / 8,
    expectedBytes: snapshot.expectedBytes,
    sha256: snapshot.sha256,
    coreEvidenceIntegrity,
    compatibilityCorrectionFactor,
    truePeakLinear: peak.linear,
    truePeakDbtp: peak.dbtp,
    truePeakFrame: peak.frame,
  });
  issuedCutPeakWitnesses.add(witness);
  return witness;
}

/**
 * Issue a witness only for the exact result object authenticated by one actual
 * limiter producer. Caller-authored result lookalikes and mutated output bytes
 * cannot acquire this process-local authority.
 */
export async function issueReferenceAudioLimiterCoreCutPeakWitness(
  authoredPath: string,
  authoredOptions: ReferenceAudioLimiterCoreCutPeakWitnessIssueOptions,
): Promise<ReferenceAudioLimiterCutPeakWitness> {
  const initial = closedRecord(authoredOptions, ["producer", "coreEvidenceIntegrity", "source"])
    ? authoredOptions
    : undefined;
  const source = normalizedSource(initial?.source) ?? fallbackSource;
  if (!initial || !normalizedSource(initial.source)
    || typeof initial.coreEvidenceIntegrity !== "string"
    || !/^[a-f0-9]{64}$/u.test(initial.coreEvidenceIntegrity)) {
    fail(
      "CUT_AUDIO_LIMITER_COMPATIBILITY_STRUCTURE",
      source,
      "invalid-core-cut-peak-witness-options",
      "core CUT peak witness options and source must be one closed producer-bound record.",
    );
  }
  const producer = initial.producer as ReferenceAudioLimiterResult | ReferenceAudioLimiterSummary;
  const authority = referenceAudioLimiterResultProducerAuthority(producer)
    ?? referenceAudioLimiterFileSummaryProducerAuthority(producer);
  if (!authority) {
    fail(
      "CUT_AUDIO_LIMITER_COMPATIBILITY_STRUCTURE",
      source,
      "untrusted-limiter-producer",
      "core CUT peak witness requires the exact object emitted by an actual limiter producer.",
    );
  }
  if (producer.ceilingMode !== "static"
    || initial.coreEvidenceIntegrity !== expectedCoreEvidenceIntegrity(producer)) {
    fail(
      "CUT_AUDIO_LIMITER_COMPATIBILITY_STRUCTURE",
      source,
      "core-evidence-producer-mismatch",
      "core evidence does not bind the exact authenticated static limiter producer.",
    );
  }
  const path = normalizedPath(authoredPath, source);
  const snapshot = await snapshotExactPrefix(path, authority.frames, source);
  if (snapshot.suffixBytesExcluded !== 0
    || snapshot.expectedBytes !== authority.bytes
    || snapshot.sha256 !== authority.sha256
    || authority.algorithm !== referenceAudioLimiterIdentity
    || authority.sampleRate !== referenceAudioLimiterCompatibilityLimits.sampleRate) {
    fail(
      "CUT_AUDIO_LIMITER_COMPATIBILITY_SOURCE",
      source,
      "limiter-producer-boundary-mismatch",
      "core CUT peak witness boundary differs from the authenticated limiter producer output.",
    );
  }
  return issuedWitness(
    "core-final",
    snapshot,
    initial.coreEvidenceIntegrity,
    1,
    {
      linear: authority.truePeakLinear,
      dbtp: authority.truePeakDbtp,
      frame: authority.truePeakFrame,
    },
  );
}

/**
 * Issue a corrected-stage witness only when the authenticated correction
 * consumed the exact core witness bytes and produced the independently
 * snapshotted output. The pre-correction witness is never relabelled.
 */
export async function issueReferenceAudioLimiterCorrectedCutPeakWitness(
  authoredPath: string,
  authoredOptions: ReferenceAudioLimiterCorrectedCutPeakWitnessIssueOptions,
): Promise<ReferenceAudioLimiterCutPeakWitness> {
  const initial = closedRecord(authoredOptions, ["coreWitness", "correction", "source"])
    ? authoredOptions
    : undefined;
  const source = normalizedSource(initial?.source) ?? fallbackSource;
  if (!initial || !normalizedSource(initial.source)
    || typeof initial.coreWitness !== "object"
    || initial.coreWitness === null
    || !issuedCutPeakWitnesses.has(initial.coreWitness)
    || (initial.coreWitness as ReferenceAudioLimiterCutPeakWitness).producerStage !== "core-final") {
    fail(
      "CUT_AUDIO_LIMITER_COMPATIBILITY_STRUCTURE",
      source,
      "invalid-corrected-cut-peak-witness-options",
      "corrected CUT peak witness requires one exact core witness and correction producer.",
    );
  }
  const coreWitness = initial.coreWitness as ReferenceAudioLimiterCutPeakWitness;
  const authority = referenceAudioLimiterUniformFileCorrectionProducerAuthority(initial.correction);
  if (!authority) {
    fail(
      "CUT_AUDIO_LIMITER_COMPATIBILITY_STRUCTURE",
      source,
      "untrusted-correction-producer",
      "corrected CUT peak witness requires the exact result emitted by the uniform correction writer.",
    );
  }
  if (authority.algorithm !== referenceAudioLimiterIdentity
    || authority.sampleRate !== coreWitness.sampleRate
    || authority.frames !== coreWitness.expectedFrames
    || authority.bytes !== coreWitness.expectedBytes
    || authority.inputSha256 !== coreWitness.sha256
    || authority.factor <= 0
    || authority.factor >= 1) {
    fail(
      "CUT_AUDIO_LIMITER_COMPATIBILITY_STRUCTURE",
      source,
      "correction-core-relation-mismatch",
      "uniform correction did not consume the exact authenticated core boundary.",
    );
  }
  const path = normalizedPath(authoredPath, source);
  const snapshot = await snapshotExactPrefix(path, authority.frames, source);
  if (snapshot.suffixBytesExcluded !== 0
    || snapshot.expectedBytes !== authority.bytes
    || snapshot.sha256 !== authority.outputSha256) {
    fail(
      "CUT_AUDIO_LIMITER_COMPATIBILITY_SOURCE",
      source,
      "correction-output-boundary-mismatch",
      "corrected CUT peak witness boundary differs from the authenticated correction output.",
    );
  }
  return issuedWitness(
    "compatibility-corrected",
    snapshot,
    coreWitness.coreEvidenceIntegrity,
    authority.factor,
    {
      linear: authority.truePeakLinear,
      dbtp: authority.truePeakDbtp,
      frame: authority.truePeakFrame,
    },
  );
}

function cutPeakFromWitness(
  authored: unknown,
  snapshot: Awaited<ReturnType<typeof snapshotExactPrefix>>,
  options: ReturnType<typeof normalizedMeasureOptions>,
) {
  if (typeof authored !== "object" || authored === null || !issuedCutPeakWitnesses.has(authored)) {
    fail(
      "CUT_AUDIO_LIMITER_COMPATIBILITY_STRUCTURE",
      options.source,
      "untrusted-cut-peak-witness",
      "CUT peak reuse requires the exact private in-process witness issued for this limiter output.",
    );
  }
  const witness = authored as ReferenceAudioLimiterCutPeakWitness;
  if (witness.format !== "cut-reference-audio-limiter-private-cut-peak-witness"
    || witness.version !== 1
    || witness.policy !== referenceAudioLimiterCutPeakWitnessIdentity
    || witness.algorithm !== referenceAudioLimiterIdentity
    || witness.sampleRate !== options.sampleRate
    || witness.channels !== 2
    || witness.sampleFormat !== "f32le"
    || witness.expectedFrames !== options.expectedFrames
    || witness.expectedBytes !== snapshot.expectedBytes
    || witness.sha256 !== snapshot.sha256
    || snapshot.suffixBytesExcluded !== 0) {
    fail(
      "CUT_AUDIO_LIMITER_COMPATIBILITY_SOURCE",
      options.source,
      "cut-peak-witness-boundary-mismatch",
      "private CUT peak witness does not bind the independently snapshotted compatibility boundary.",
    );
  }
  return Object.freeze({
    truePeakLinear: witness.truePeakLinear,
    truePeakDbtp: witness.truePeakDbtp,
  });
}

function decodeExactF32(bytes: Buffer, source: ReferenceAudioPeakSource) {
  const result = new Float32Array(bytes.byteLength / 4);
  for (let index = 0; index < result.length; index += 1) result[index] = bytes.readFloatLE(index * 4);
  try {
    return result;
  } catch (error) {
    fail("CUT_AUDIO_LIMITER_COMPATIBILITY_MEASUREMENT", source, "decode-failed", "compatibility f32 boundary could not be decoded.", error);
  }
}

function maximum(values: Float64Array) {
  let value = 0;
  for (const item of values) if (item > value) value = item;
  return value;
}

const finitePattern = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu;

function parseLoudnormTruePeak(stderr: string, source: ReferenceAudioPeakSource) {
  const candidates = [...stderr.matchAll(/\{[\s\S]*?"input_i"[\s\S]*?\}/gu)];
  if (candidates.length !== 1) {
    fail(
      "CUT_AUDIO_LIMITER_COMPATIBILITY_MEASUREMENT",
      source,
      candidates.length === 0 ? "missing-loudnorm-json" : "ambiguous-loudnorm-json",
      "FFmpeg loudnorm must return exactly one bounded measurement object.",
    );
  }
  let parsed: unknown;
  try { parsed = JSON.parse(candidates.at(-1)![0]); }
  catch (error) {
    fail("CUT_AUDIO_LIMITER_COMPATIBILITY_MEASUREMENT", source, "invalid-loudnorm-json", "FFmpeg loudnorm returned invalid JSON.", error);
  }
  if (!closedRecord(parsed, [
    "input_i",
    "input_tp",
    "input_lra",
    "input_thresh",
    "output_i",
    "output_tp",
    "output_lra",
    "output_thresh",
    "normalization_type",
    "target_offset",
  ])) {
    fail("CUT_AUDIO_LIMITER_COMPATIBILITY_MEASUREMENT", source, "invalid-loudnorm-object", "FFmpeg loudnorm returned an invalid measurement object.");
  }
  const numericFields = [
    "input_i",
    "input_tp",
    "input_lra",
    "input_thresh",
    "output_i",
    "output_tp",
    "output_lra",
    "output_thresh",
    "target_offset",
  ] as const;
  if (numericFields.some((field) => (
    typeof parsed[field] !== "string"
    || parsed[field].length > 64
    || (parsed[field] !== "-inf" && parsed[field] !== "inf" && !finitePattern.test(parsed[field]))
  ))
    || (parsed.normalization_type !== "linear" && parsed.normalization_type !== "dynamic")) {
    fail("CUT_AUDIO_LIMITER_COMPATIBILITY_MEASUREMENT", source, "invalid-loudnorm-fields", "FFmpeg loudnorm returned invalid bounded measurement fields.");
  }
  const inputTp = parsed.input_tp;
  if (inputTp === "-inf") return null;
  if (typeof inputTp !== "string" || inputTp.length > 64 || !finitePattern.test(inputTp)) {
    fail("CUT_AUDIO_LIMITER_COMPATIBILITY_MEASUREMENT", source, "invalid-input-tp", "FFmpeg loudnorm returned an invalid input_tp field.");
  }
  const value = Number(inputTp);
  if (!Number.isFinite(value) || value < -1_000 || value > 1_000) {
    fail("CUT_AUDIO_LIMITER_COMPATIBILITY_MEASUREMENT", source, "nonfinite-input-tp", "FFmpeg loudnorm input_tp is outside the bounded finite domain.");
  }
  return value;
}

type FfmpegExecutableContract = Readonly<{
  path: string;
  sha256: string;
  bytes: number;
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}>;

async function snapshotExecutable(authoredPath: string, source: ReferenceAudioPeakSource) {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (typeof fsConstants.O_NOFOLLOW !== "number") {
      fail("CUT_AUDIO_LIMITER_COMPATIBILITY_TOOLCHAIN", source, "no-follow-unavailable", "platform cannot bind FFmpeg to a no-follow executable handle.");
    }
    const path = await realpath(authoredPath);
    if (!isAbsolute(path) || path.includes("\0") || Buffer.byteLength(path, "utf8") > referenceAudioLimiterCompatibilityLimits.maximumPathBytes) {
      fail("CUT_AUDIO_LIMITER_COMPATIBILITY_TOOLCHAIN", source, "invalid-executable-path", "FFmpeg did not resolve to one bounded absolute executable path.");
    }
    const pathMetadata = await lstat(path, { bigint: true });
    if (pathMetadata.isSymbolicLink()
      || !pathMetadata.isFile()
      || pathMetadata.size < 1n
      || pathMetadata.size > BigInt(referenceAudioLimiterCompatibilityLimits.maximumExecutableBytes)
      || (process.platform !== "win32" && (pathMetadata.mode & 0o111n) === 0n)) {
      fail("CUT_AUDIO_LIMITER_COMPATIBILITY_TOOLCHAIN", source, "invalid-executable", "FFmpeg must resolve to one bounded executable regular file.");
    }
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()
      || before.dev !== pathMetadata.dev
      || before.ino !== pathMetadata.ino
      || before.size !== pathMetadata.size
      || before.mtimeNs !== pathMetadata.mtimeNs
      || before.ctimeNs !== pathMetadata.ctimeNs) {
      fail("CUT_AUDIO_LIMITER_COMPATIBILITY_TOOLCHAIN", source, "executable-path-handle-mismatch", "FFmpeg path and no-follow handle do not identify the same executable.");
    }
    const digest = createHash("sha256");
    const stream = handle.createReadStream({ autoClose: false, highWaterMark: 1_024 * 1_024 });
    for await (const chunk of stream) digest.update(chunk);
    const after = await handle.stat({ bigint: true });
    const afterPath = await lstat(path, { bigint: true });
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
      fail("CUT_AUDIO_LIMITER_COMPATIBILITY_TOOLCHAIN", source, "changed-executable-read", "FFmpeg changed while CUT snapshotted its executable identity.");
    }
    return Object.freeze({
      path,
      sha256: digest.digest("hex"),
      bytes: Number(before.size),
      dev: before.dev,
      ino: before.ino,
      size: before.size,
      mtimeNs: before.mtimeNs,
      ctimeNs: before.ctimeNs,
    });
  } catch (error) {
    if (error instanceof ReferenceAudioLimiterCompatibilityError) throw error;
    fail("CUT_AUDIO_LIMITER_COMPATIBILITY_TOOLCHAIN", source, "executable-read-failed", `FFmpeg executable identity could not be collected (${systemCode(error)}).`, error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function resolveFfmpegExecutable(source: ReferenceAudioPeakSource): Promise<FfmpegExecutableContract> {
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const environmentPath = process.env[pathKey];
  if (typeof environmentPath !== "string"
    || environmentPath.length === 0
    || environmentPath.includes("\0")
    || Buffer.byteLength(environmentPath, "utf8") > referenceAudioLimiterCompatibilityLimits.maximumPathEnvironmentBytes) {
    fail("CUT_AUDIO_LIMITER_COMPATIBILITY_TOOLCHAIN", source, "invalid-path-environment", "PATH must be one bounded non-empty executable search path.");
  }
  const names = process.platform === "win32" ? ["ffmpeg.exe", "ffmpeg"] : ["ffmpeg"];
  for (const directory of environmentPath.split(delimiter)) {
    if (!directory || !isAbsolute(directory)) continue;
    for (const name of names) {
      try {
        return await snapshotExecutable(resolve(directory, name), source);
      } catch (error) {
        if (!(error instanceof ReferenceAudioLimiterCompatibilityError)
          || !["executable-read-failed", "invalid-executable"].includes(error.reason)) throw error;
      }
    }
  }
  fail("CUT_AUDIO_LIMITER_COMPATIBILITY_TOOLCHAIN", source, "ffmpeg-not-found", "PATH did not resolve one bounded FFmpeg executable.");
}

async function verifyExecutableUnchanged(contract: FfmpegExecutableContract, source: ReferenceAudioPeakSource) {
  const current = await snapshotExecutable(contract.path, source);
  if (current.path !== contract.path
    || current.sha256 !== contract.sha256
    || current.bytes !== contract.bytes
    || current.dev !== contract.dev
    || current.ino !== contract.ino
    || current.size !== contract.size
    || current.mtimeNs !== contract.mtimeNs
    || current.ctimeNs !== contract.ctimeNs) {
    fail("CUT_AUDIO_LIMITER_COMPATIBILITY_TOOLCHAIN", source, "executable-changed", "FFmpeg changed across compatibility measurement.");
  }
}

type ExactProcessLimits = Readonly<{ stdoutBytes: number; stderrBytes: number; totalBytes: number; timeoutMs: number }>;
export type ReferenceFfmpegNativeProcessExecution = Readonly<{
  authority: BoundReferenceNativeMediaTool;
  collector: ReferenceNativeProcessCollector;
  context: ReferenceNativeProcessContext;
}>;

async function runExactFfmpegCapture(
  executable: FfmpegExecutableContract,
  args: readonly string[],
  input: Buffer | undefined,
  limits: ExactProcessLimits,
  source: ReferenceAudioPeakSource,
  execution?: ReferenceFfmpegNativeProcessExecution,
) {
  if (execution !== undefined && (execution.authority.tool !== "ffmpeg"
    || execution.collector.authority !== execution.authority
    || execution.authority.executablePath !== executable.path
    || execution.authority.evidence.sha256 !== executable.sha256
    || execution.authority.evidence.bytes !== executable.bytes)) {
    fail("CUT_AUDIO_LIMITER_COMPATIBILITY_TOOLCHAIN", source, "native-process-authority", "FFmpeg execution authority differs from the compatibility executable snapshot.");
  }
  return new Promise<{ stdout: string; stderr: string }>(async (accept, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = execution === undefined
        ? spawn(executable.path, [...args], {
          shell: false,
          detached: process.platform !== "win32",
          stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
        })
        : await spawnBoundReferenceNativeProcess(execution.collector, execution.context, args, {
          shell: false,
          detached: false,
          stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
        });
    } catch (error) {
      reject(compatibilityError("CUT_AUDIO_LIMITER_COMPATIBILITY_MEASUREMENT", source, "process-start-failed", `FFmpeg could not start (${systemCode(error)}).`, error));
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: ReferenceAudioLimiterCompatibilityError | undefined;
    let settled = false;
    const terminate = (error: ReferenceAudioLimiterCompatibilityError) => {
      if (failure || settled) return;
      failure = error;
      stdout.length = 0;
      stderr.length = 0;
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const collect = (stream: "stdout" | "stderr", chunk: Buffer) => {
      if (failure) return;
      const bytes = Buffer.from(chunk);
      if (stream === "stdout") stdoutBytes += bytes.byteLength;
      else stderrBytes += bytes.byteLength;
      const streamBytes = stream === "stdout" ? stdoutBytes : stderrBytes;
      const streamLimit = stream === "stdout" ? limits.stdoutBytes : limits.stderrBytes;
      if (streamBytes > streamLimit || stdoutBytes + stderrBytes > limits.totalBytes) {
        terminate(compatibilityError("CUT_AUDIO_LIMITER_COMPATIBILITY_MEASUREMENT", source, "process-output-limit", "FFmpeg exceeded CUT's bounded compatibility output budget."));
        return;
      }
      (stream === "stdout" ? stdout : stderr).push(bytes);
    };
    child.stdout?.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => collect("stderr", chunk));
    child.stdout?.on("error", (error) => terminate(compatibilityError("CUT_AUDIO_LIMITER_COMPATIBILITY_MEASUREMENT", source, "process-stream-failed", `FFmpeg stdout failed (${systemCode(error)}).`, error)));
    child.stderr?.on("error", (error) => terminate(compatibilityError("CUT_AUDIO_LIMITER_COMPATIBILITY_MEASUREMENT", source, "process-stream-failed", `FFmpeg stderr failed (${systemCode(error)}).`, error)));
    child.stdin?.on("error", (error) => terminate(compatibilityError("CUT_AUDIO_LIMITER_COMPATIBILITY_MEASUREMENT", source, "process-input-failed", `FFmpeg input failed (${systemCode(error)}).`, error)));
    child.on("error", (error) => terminate(compatibilityError("CUT_AUDIO_LIMITER_COMPATIBILITY_MEASUREMENT", source, "process-start-failed", `FFmpeg process failed (${systemCode(error)}).`, error)));
    const timer = setTimeout(() => terminate(compatibilityError("CUT_AUDIO_LIMITER_COMPATIBILITY_MEASUREMENT", source, "process-timeout", "FFmpeg exceeded CUT's bounded compatibility timeout.")), limits.timeoutMs);
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(compatibilityError("CUT_AUDIO_LIMITER_COMPATIBILITY_MEASUREMENT", source, "process-exit", "FFmpeg exited without completing compatibility measurement."));
      else accept({
        stdout: Buffer.concat(stdout, stdoutBytes).toString("utf8"),
        stderr: Buffer.concat(stderr, stderrBytes).toString("utf8"),
      });
    });
    if (input) child.stdin?.end(input);
  });
}

function toolchainFromVersionOutput(
  stdout: string,
  executable: FfmpegExecutableContract,
  source: ReferenceAudioPeakSource,
): ReferenceAudioLimiterCompatibilityToolchain {
  const normalized = stdout.replaceAll("\r\n", "\n").trim();
  const version = normalized.split("\n", 1)[0] ?? "";
  if (!version.startsWith("ffmpeg version ")
    || version.length > 4_096
    || /[\0\r\n]/u.test(version)
    || normalized.length > 128_000) {
    fail("CUT_AUDIO_LIMITER_COMPATIBILITY_TOOLCHAIN", source, "invalid-ffmpeg-version", "FFmpeg did not provide one bounded implementation banner.");
  }
  const content = Object.freeze({
    format: "cut-reference-audio-limiter-compatibility-toolchain" as const,
    version: 1 as const,
    policy: referenceAudioLimiterCompatibilityIdentity,
    ffmpeg: Object.freeze({
      version,
      bannerSha256: hash(normalized),
      executableSha256: executable.sha256,
      executableBytes: executable.bytes,
    }),
  });
  return Object.freeze({ ...content, integrity: hash(content) });
}

async function collectToolchainContract(
  source: ReferenceAudioPeakSource,
  execution?: ReferenceFfmpegNativeProcessExecution,
) {
  const executable = await resolveFfmpegExecutable(source);
  let output: { stdout: string; stderr: string };
  try {
    output = await runExactFfmpegCapture(executable, ["-version"], undefined, {
      stdoutBytes: 128_000,
      stderrBytes: 16_000,
      totalBytes: 144_000,
      timeoutMs: 30_000,
    }, source, execution);
  } catch (error) {
    fail("CUT_AUDIO_LIMITER_COMPATIBILITY_TOOLCHAIN", source, "ffmpeg-version-failed", `FFmpeg identity process failed (${systemCode(error)}).`, error);
  }
  await verifyExecutableUnchanged(executable, source);
  return Object.freeze({ executable, toolchain: toolchainFromVersionOutput(output.stdout, executable, source) });
}

/** Fresh path-free identity suitable for binding every audio-cache invocation. */
export async function collectReferenceAudioLimiterCompatibilityToolchain() {
  return (await collectToolchainContract(fallbackSource)).toolchain;
}

/**
 * Bind execution to the exact no-follow executable snapshot behind the public
 * path-free identity. Reference picture encoding reuses this internal boundary
 * so the binary placed in its cache key is also the binary Node actually
 * spawns; `verify` detects replacement before encoded bytes are published.
 */
export async function bindReferenceFfmpegExecutableToolchain(execution?: ReferenceFfmpegNativeProcessExecution) {
  const contract = await collectToolchainContract(fallbackSource, execution);
  return Object.freeze({
    executablePath: contract.executable.path,
    toolchain: contract.toolchain,
    verify: () => verifyExecutableUnchanged(contract.executable, fallbackSource),
  });
}

export function isReferenceAudioLimiterCompatibilityToolchain(value: unknown): value is ReferenceAudioLimiterCompatibilityToolchain {
  if (!closedRecord(value, ["format", "version", "policy", "ffmpeg", "integrity"])
    || value.format !== "cut-reference-audio-limiter-compatibility-toolchain"
    || value.version !== 1
    || value.policy !== referenceAudioLimiterCompatibilityIdentity
    || typeof value.integrity !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.integrity)
    || !closedRecord(value.ffmpeg, ["version", "bannerSha256", "executableSha256", "executableBytes"])
    || typeof value.ffmpeg.version !== "string"
    || !value.ffmpeg.version.startsWith("ffmpeg version ")
    || value.ffmpeg.version.length > 4_096
    || /[\0\r\n]/u.test(value.ffmpeg.version)
    || typeof value.ffmpeg.bannerSha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.ffmpeg.bannerSha256)
    || typeof value.ffmpeg.executableSha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.ffmpeg.executableSha256)
    || !Number.isSafeInteger(value.ffmpeg.executableBytes)
    || (value.ffmpeg.executableBytes as number) < 1
    || (value.ffmpeg.executableBytes as number) > referenceAudioLimiterCompatibilityLimits.maximumExecutableBytes) return false;
  const content = { ...value } as Record<string, unknown>;
  delete content.integrity;
  return value.integrity === hash(content);
}

export function assertReferenceAudioLimiterCompatibilityToolchain(
  value: unknown,
  source: ReferenceAudioPeakSource = fallbackSource,
) {
  const location = normalizedSource(source);
  if (!location) {
    fail("CUT_AUDIO_LIMITER_COMPATIBILITY_STRUCTURE", fallbackSource, "invalid-toolchain-source", "compatibility toolchain source must be one closed source location.");
  }
  if (!isReferenceAudioLimiterCompatibilityToolchain(value)) {
    fail("CUT_AUDIO_LIMITER_COMPATIBILITY_TOOLCHAIN", location, "invalid-toolchain", "compatibility toolchain must be one closed integrity-valid v1 identity.");
  }
  return Object.freeze({
    format: value.format,
    version: value.version,
    policy: value.policy,
    ffmpeg: Object.freeze({ ...value.ffmpeg }),
    integrity: value.integrity,
  });
}

function reportContent(value: Omit<ReferenceAudioLimiterStaticCompatibilityReport, "integrity">) {
  return value;
}

export function isReferenceAudioLimiterStaticCompatibilityReport(value: unknown): value is ReferenceAudioLimiterStaticCompatibilityReport {
  if (!closedRecord(value, ["format", "version", "policy", "boundary", "targetCeilingDbtp", "safetyDb", "cut", "ffmpeg", "correctionFactor", "toolchain", "integrity"])
    || value.format !== "cut-reference-audio-limiter-static-compatibility"
    || value.version !== 1
    || value.policy !== referenceAudioLimiterCompatibilityIdentity
    || value.safetyDb !== referenceAudioLimiterCompatibilitySafetyDb
    || typeof value.integrity !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.integrity)
    || !closedRecord(value.boundary, ["sampleRate", "channels", "sampleFormat", "expectedFrames", "expectedBytes", "suffixBytesExcluded", "sha256"])
    || value.boundary.sampleRate !== referenceAudioLimiterCompatibilityLimits.sampleRate
    || value.boundary.channels !== 2
    || value.boundary.sampleFormat !== "f32le"
    || !Number.isSafeInteger(value.boundary.expectedFrames)
    || (value.boundary.expectedFrames as number) < 1
    || (value.boundary.expectedFrames as number) > referenceAudioLimiterCompatibilityLimits.maximumFrames
    || value.boundary.expectedBytes !== (value.boundary.expectedFrames as number) * 8
    || !Number.isSafeInteger(value.boundary.suffixBytesExcluded)
    || (value.boundary.suffixBytesExcluded as number) < 0
    || (value.boundary.suffixBytesExcluded as number) % 8 !== 0
    || (value.boundary.expectedBytes as number) + (value.boundary.suffixBytesExcluded as number) > referenceAudioLimiterCompatibilityLimits.maximumFrames * 8
    || typeof value.boundary.sha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.boundary.sha256)
    || typeof value.targetCeilingDbtp !== "number"
    || !Number.isFinite(value.targetCeilingDbtp)
    || value.targetCeilingDbtp < referenceAudioLimiterLimits.minimumCeilingDbtp
    || value.targetCeilingDbtp > referenceAudioLimiterLimits.maximumCeilingDbtp
    || !closedRecord(value.cut, ["method", "truePeakLinear", "truePeakDbtp"])
    || value.cut.method !== referenceAudioLimiterIdentity
    || typeof value.cut.truePeakLinear !== "number"
    || !Number.isFinite(value.cut.truePeakLinear)
    || value.cut.truePeakLinear < 0
    || value.cut.truePeakLinear > referenceAudioLimiterLimits.maximumEnvelopeLinear
    || (value.cut.truePeakLinear === 0
      ? value.cut.truePeakDbtp !== null
      : typeof value.cut.truePeakDbtp !== "number"
        || !Number.isFinite(value.cut.truePeakDbtp)
        || value.cut.truePeakDbtp !== 20 * Math.log10(value.cut.truePeakLinear))
    || !closedRecord(value.ffmpeg, ["method", "truePeakDbtp"])
    || value.ffmpeg.method !== "loudnorm-input_tp"
    || !(value.ffmpeg.truePeakDbtp === null
      || typeof value.ffmpeg.truePeakDbtp === "number"
        && Number.isFinite(value.ffmpeg.truePeakDbtp)
        && value.ffmpeg.truePeakDbtp >= -1_000
        && value.ffmpeg.truePeakDbtp <= 1_000)
    || !isReferenceAudioLimiterCompatibilityToolchain(value.toolchain)
    || typeof value.correctionFactor !== "number"
    || !Number.isFinite(value.correctionFactor)
    || value.correctionFactor <= 0
    || value.correctionFactor > 1) return false;
  let expectedFactor: number;
  try {
    expectedFactor = deriveReferenceAudioLimiterStaticCorrection({
      cutTruePeakDbtp: value.cut.truePeakDbtp as number | null,
      ffmpegTruePeakDbtp: value.ffmpeg.truePeakDbtp as number | null,
      targetCeilingDbtp: value.targetCeilingDbtp as number,
      source: fallbackSource,
    });
  } catch {
    return false;
  }
  if (value.correctionFactor !== expectedFactor) return false;
  const content = { ...value } as Record<string, unknown>;
  delete content.integrity;
  return value.integrity === hash(content);
}

export function assertReferenceAudioLimiterStaticCompatibilityReport(
  value: unknown,
  source: ReferenceAudioPeakSource = fallbackSource,
) {
  const location = normalizedSource(source);
  if (!location) {
    fail("CUT_AUDIO_LIMITER_COMPATIBILITY_STRUCTURE", fallbackSource, "invalid-report-source", "compatibility report source must be one closed source location.");
  }
  if (!isReferenceAudioLimiterStaticCompatibilityReport(value)) {
    fail("CUT_AUDIO_LIMITER_COMPATIBILITY_STRUCTURE", location, "invalid-report", "static compatibility report must be one closed integrity-valid v1 report.");
  }
  return Object.freeze({
    format: value.format,
    version: value.version,
    policy: value.policy,
    boundary: Object.freeze({ ...value.boundary }),
    targetCeilingDbtp: value.targetCeilingDbtp,
    safetyDb: value.safetyDb,
    cut: Object.freeze({ ...value.cut }),
    ffmpeg: Object.freeze({ ...value.ffmpeg }),
    correctionFactor: value.correctionFactor,
    toolchain: assertReferenceAudioLimiterCompatibilityToolchain(value.toolchain, location),
    integrity: value.integrity,
  });
}

/**
 * Measure one exact authored float boundary with CUT Annex 2 and FFmpeg's
 * independently named loudnorm `input_tp` estimator. The source path and
 * provenance never enter the returned cache-safe report.
 */
export async function measureReferenceAudioLimiterStaticCompatibility(
  authoredPath: string,
  authoredOptions: ReferenceAudioLimiterStaticCompatibilityOptions,
  cutPeakWitness?: ReferenceAudioLimiterCutPeakWitness,
): Promise<ReferenceAudioLimiterStaticCompatibilityReport> {
  const options = normalizedMeasureOptions(authoredOptions);
  const path = normalizedPath(authoredPath, options.source);
  const snapshot = await snapshotExactPrefix(path, options.expectedFrames, options.source);
  let cutTruePeakLinear: number;
  let cutTruePeakDbtp: number | null;
  if (cutPeakWitness !== undefined) {
    const witnessed = cutPeakFromWitness(cutPeakWitness, snapshot, options);
    cutTruePeakLinear = witnessed.truePeakLinear;
    cutTruePeakDbtp = witnessed.truePeakDbtp;
  } else {
    try {
      if (options.expectedFrames <= referenceAudioLimiterLimits.maximumFrames) {
        const samples = decodeExactF32(snapshot.bytes, options.source);
        const envelope = deriveReferenceAudioLimiterTruePeakEnvelope(samples, {
          sampleRate: options.sampleRate,
          source: options.source,
        });
        cutTruePeakLinear = maximum(envelope);
        cutTruePeakDbtp = cutTruePeakLinear === 0 ? null : 20 * Math.log10(cutTruePeakLinear);
      } else {
        const measurement = measureReferenceAudioLimiterSnapshotTruePeak(snapshot.bytes, {
          expectedFrames: options.expectedFrames,
          sampleRate: options.sampleRate,
          source: options.source,
        });
        cutTruePeakLinear = measurement.maximumLinear;
        cutTruePeakDbtp = measurement.maximumDbtp;
      }
    } catch (error) {
      fail("CUT_AUDIO_LIMITER_COMPATIBILITY_MEASUREMENT", options.source, "cut-meter-failed", "CUT could not measure the exact compatibility boundary.", error);
    }
  }
  const tool = await collectToolchainContract(options.source);
  const filter = `atrim=start_sample=0:end_sample=${options.expectedFrames},asetpts=N/SR/TB,loudnorm=I=-24:TP=-1:LRA=7:print_format=json`;
  let measurement: { stdout: string; stderr: string };
  try {
    measurement = await runExactFfmpegCapture(tool.executable, [
      "-hide_banner", "-nostdin", "-v", "info",
      "-f", "f32le", "-ar", String(options.sampleRate), "-ac", "2", "-i", "pipe:0",
      "-map", "0:a:0", "-af", filter, "-f", "null", "-",
    ], snapshot.bytes, {
      stdoutBytes: 0,
      stderrBytes: referenceAudioLimiterCompatibilityLimits.maximumFfmpegOutputBytes,
      totalBytes: referenceAudioLimiterCompatibilityLimits.maximumFfmpegOutputBytes,
      timeoutMs: referenceAudioLimiterCompatibilityLimits.timeoutMs,
    }, options.source);
    await verifyExecutableUnchanged(tool.executable, options.source);
  } catch (error) {
    if (error instanceof ReferenceAudioLimiterCompatibilityError
      && error.code === "CUT_AUDIO_LIMITER_COMPATIBILITY_TOOLCHAIN") throw error;
    fail("CUT_AUDIO_LIMITER_COMPATIBILITY_MEASUREMENT", options.source, "ffmpeg-measurement-failed", `FFmpeg compatibility measurement failed (${systemCode(error)}).`, error);
  }
  const ffmpegTruePeakDbtp = parseLoudnormTruePeak(measurement.stderr, options.source);
  const correctionFactor = deriveReferenceAudioLimiterStaticCorrection({
    cutTruePeakDbtp,
    ffmpegTruePeakDbtp,
    targetCeilingDbtp: options.targetCeilingDbtp,
    source: options.source,
  });
  const content = reportContent(Object.freeze({
    format: "cut-reference-audio-limiter-static-compatibility" as const,
    version: 1 as const,
    policy: referenceAudioLimiterCompatibilityIdentity,
    boundary: Object.freeze({
      sampleRate: options.sampleRate,
      channels: 2 as const,
      sampleFormat: "f32le" as const,
      expectedFrames: options.expectedFrames,
      expectedBytes: snapshot.expectedBytes,
      suffixBytesExcluded: snapshot.suffixBytesExcluded,
      sha256: snapshot.sha256,
    }),
    targetCeilingDbtp: options.targetCeilingDbtp,
    safetyDb: referenceAudioLimiterCompatibilitySafetyDb,
    cut: Object.freeze({
      method: referenceAudioLimiterIdentity,
      truePeakLinear: cutTruePeakLinear,
      truePeakDbtp: cutTruePeakDbtp,
    }),
    ffmpeg: Object.freeze({
      method: "loudnorm-input_tp" as const,
      truePeakDbtp: ffmpegTruePeakDbtp,
    }),
    correctionFactor,
    toolchain: tool.toolchain,
  }));
  const report = Object.freeze({ ...content, integrity: hash(content) });
  if (!isReferenceAudioLimiterStaticCompatibilityReport(report)) {
    fail("CUT_AUDIO_LIMITER_COMPATIBILITY_MEASUREMENT", options.source, "invalid-report", "CUT produced an invalid static compatibility report.");
  }
  return report;
}
