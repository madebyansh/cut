import { createHash, randomBytes } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import { link, lstat, open, readdir, readlink, realpath, rename, rmdir, symlink, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import Ajv, { type ValidateFunction } from "ajv";
import { stableJsonStringify } from "../core/stable";
import { parseStrictPackageJson } from "../package/json";
import type {
  CutAssetCatalog,
  CutAssetCatalogEntry,
  CutAudioCatalogEnergy,
  CutAudioCatalogRole,
} from "../project/asset-catalog";
import { doesCutAudioCatalogMetadataDeclareCommercialSyncUse } from "../project/asset-catalog";
import { validateProjectLocator } from "../project/manifest";
import { probeProjectMedia, type CutLockedFileIdentity } from "../project/probe";
import type { CutAudioBrief } from "./brief";
import { analyzeCutAudioPcm, type CutAudioDspAnalysis } from "./dsp";
import {
  cutYamnetSemanticAnalysisPolicy,
  materializeCutYamnetSemanticAnalysis,
  verifyCutYamnetSemanticAnalysisDerivation,
  type CutYamnetSemanticAnalysis,
} from "./yamnet-materialize";
import { cutYamnetLocalPolicy } from "./yamnet-local";
import { cutYamnetAudioSetMapV1 } from "./yamnet-taxonomy";
import { cutWaveNormalizePolicy, normalizeCutWaveForYamnet } from "./wave-normalize";

export const cutAudioAuditionBindingsFormat = "cut-audio-audition-bindings" as const;
export const cutAudioAuditionBindingsVersion = 2 as const;
export const cutAudioAuditionLegacyBindingsVersion = 1 as const;
export const cutAudioAuditionSelectionFormat = "cut-audio-audition-selection" as const;
export const cutAudioAuditionSelectionVersion = 1 as const;

export const cutAudioAuditionLimits = Object.freeze({
  maximumBindingsBytes: 256 * 1024,
  maximumBindings: 1_000,
  maximumEvidenceBytes: 32 * 1024 * 1024,
  maximumSemanticAnalysisBytes: 1024 * 1024,
  // 20 admitted YAMNet patches * 521 f32 scores, encoded as canonical base64.
  maximumSemanticAnalysisStringBytes: 4 * Math.ceil((20 * 521 * 4) / 3),
  maximumWaveBytes: 256 * 1024 * 1024,
  maximumAnalysisSeconds: 120,
  maximumAnalysisSampleOperations: 24_000_000,
  maximumWaveChunks: 128,
  maximumLoopPlacements: 256,
  maximumTop: 3,
});

export type CutAudioAuditionBinding = Readonly<{
  id: string;
  audioLocator: string;
  rightsEvidenceLocator: string;
  semanticAnalysis?: Readonly<{
    locator: string;
    bytes: number;
    fileSha256: string;
    analysisSha256: string;
  }>;
}>;

export type CutAudioAuditionBindings = Readonly<{
  format: typeof cutAudioAuditionBindingsFormat;
  version: typeof cutAudioAuditionLegacyBindingsVersion | typeof cutAudioAuditionBindingsVersion;
  entries: readonly CutAudioAuditionBinding[];
  bindingsSha256: string;
}>;

export type CutAudioAuditionSemanticEvidence = Readonly<{
  contract: "authenticated-source-and-embedded-semantic-derivation-recomputed-without-model-reexecution-v1";
  file: Readonly<{ locator: string; bytes: number; sha256: string }>;
  analysisSha256: string;
  source: Readonly<{ locator: string; bytes: number; sha256: string }>;
  normalization: Readonly<{
    evidenceSha256: string;
    policySha256: string;
    outputSha256: string;
    outputSamples: number;
  }>;
  provider: Readonly<{
    id: typeof cutYamnetLocalPolicy.provider;
    analysisSha256: string;
    rawScoreSha256: string;
    authorities: CutYamnetSemanticAnalysis["provider"]["authorities"];
    aggregateTopClasses: CutYamnetSemanticAnalysis["provider"]["aggregateTopClasses"];
  }>;
  taxonomy: Readonly<{
    policySha256: string;
    suggestionsSha256: string;
    interpretation: "editorial-suggestions-not-ground-truth-v1";
    musicMoodScope: "music-only-no-unmapped-mood-inference-v1";
    roleSuggestions: CutYamnetSemanticAnalysis["taxonomy"]["aggregate"]["roleSuggestions"];
    musicMoodSuggestions: CutYamnetSemanticAnalysis["taxonomy"]["aggregate"]["musicMoodSuggestions"];
  }>;
  limitations: typeof cutYamnetSemanticAnalysisPolicy.limitations;
}>;

export type CutAudioAuditionSignalEvidence = Readonly<{
  contract: "bounded-classic-pcm-wave-v1";
  renderedSourceIntervals: readonly Readonly<{ semantics: "half-open-samples"; startSample: number; endSample: number }>[];
  analyzedSamples: number;
  sourceSamples: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: 16 | 24 | 32;
  rmsDbfsMilli: number;
  peakDbfsMilli: number;
  activityPpm: number;
  meanOnsetPpm: number;
  tempoCandidates: CutAudioDspAnalysis["tempoCandidates"];
  sectionRmsDbfsMilli: readonly number[];
}>;

export type CutAudioAuditionVerifiedCandidate = Readonly<{
  entry: CutAssetCatalogEntry & Readonly<{
    kind: "audio";
    audio: NonNullable<CutAssetCatalogEntry["audio"]> & Readonly<{ role: Exclude<CutAudioCatalogRole, "dialogue"> }>;
    rights: NonNullable<CutAssetCatalogEntry["rights"]>;
  }>;
  binding: CutAudioAuditionBinding;
  file: CutLockedFileIdentity;
  rightsEvidence: Readonly<{ locator: string; bytes: number; sha256: string }>;
  signal: CutAudioAuditionSignalEvidence;
  semantic?: CutAudioAuditionSemanticEvidence;
}>;

export type CutAudioAuditionScore = Readonly<{
  totalPpm: number;
  catalogSemanticPpm: number;
  measuredSignalPpm: number;
  semanticAdvisory?: Readonly<{
    policy: "whole-source-music-only-centered-four-percent-capped-v1";
    applicability:
      | "applied-exact-whole-source-music"
      | "not-applied-non-music-role"
      | "not-applied-inexact-rendered-window";
    role: CutAudioCatalogRole;
    roleSuggestionPpm: number;
    deltaPpm: number;
  }>;
  factors: Readonly<{
    roleCoveragePpm: number;
    moodCoveragePpm: number;
    catalogEnergyFitPpm: number;
    durationCoveragePpm: number;
    measuredActivityFitPpm: number;
    measuredTempoAgreementPpm: number;
  }>;
}>;

export type CutAudioAuditionRankedCandidate = CutAudioAuditionVerifiedCandidate & Readonly<{
  rank: number;
  score: CutAudioAuditionScore;
  placement: Readonly<{
    auditionStartSample: number;
    auditionEndSample: number;
    loops: number;
    coverageSamples: number;
    coveragePpm: number;
    renderedSourceIntervals: readonly Readonly<{ semantics: "half-open-samples"; startSample: 0; endSample: number }>[];
  }>;
  leveling: CutAudioAuditionLevelingEvidence;
}>;

export type CutAudioAuditionLevelingEvidence = Readonly<{
  policy: "exact-window-rms-target-with-peak-ceiling-v1";
  sourceRmsDbfsMilli: number;
  sourcePeakDbfsMilli: number;
  targetRmsDbfsMilli: -24_000;
  peakCeilingDbfsMilli: -1_000;
  minimumGainDbMilli: -24_000;
  maximumGainDbMilli: 12_000;
  requestedGainDbMilli: number;
  peakLimitedMaximumGainDbMilli: number;
  appliedGainDbMilli: number;
  bounded: boolean;
}>;

/**
 * Private orchestration authority for one create-only audition artifact.
 * This is deliberately not serialized into public receipts: it exists only so
 * a failed multi-artifact command can prove that a path still names CUT's
 * exact inode and bytes before removing it.
 */
export type CutAudioAuditionOwnedArtifact = Readonly<{
  path: string;
  parentPath: string;
  parentDev: bigint;
  parentIno: bigint;
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  sha256: string;
  handle: FileHandle;
  parentHandle: FileHandle;
}>;

export type CutAudioAuditionOwnedDirectory = Readonly<{
  path: string;
  dev: bigint;
  ino: bigint;
  mode: bigint;
  parentPath: string;
  parentDev: bigint;
  parentIno: bigint;
  handle: FileHandle;
  parentHandle: FileHandle;
}>;

/** @internal Deterministic hostile cleanup race used only by focused tests. */
export type CutAudioAuditionCleanupTestHooks = Readonly<{
  beforeQuarantine?: (locatedPath: string) => void | Promise<void>;
  beforeStageQuarantine?: (locatedPath: string) => void | Promise<void>;
}>;

/** @internal Deterministic post-resolution failure used only by focused tests. */
export type CutAudioAuditionFileTestHooks = Readonly<{
  afterResolve?: () => void | Promise<void>;
}>;

export class CutAudioAuditionError extends Error {
  constructor(readonly code: string, readonly path: string, message: string) {
    super(`${code} at ${path}: ${message}`);
    this.name = "CutAudioAuditionError";
  }
}

function fail(code: string, path: string, message: string): never {
  throw new CutAudioAuditionError(code, path, message);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail("CUT_AUDIO_AUDITION_TYPE", path, "must be one plain object.");
  }
  return value as Record<string, unknown>;
}

function closed(value: unknown, path: string, required: readonly string[]) {
  const result = record(value, path), allowed = new Set(required);
  for (const key of Object.keys(result)) {
    if (!allowed.has(key)) fail("CUT_AUDIO_AUDITION_UNKNOWN_FIELD", `${path}.${key}`, "is not part of the closed audition contract.");
  }
  for (const key of required) {
    if (!Object.hasOwn(result, key)) fail("CUT_AUDIO_AUDITION_TYPE", `${path}.${key}`, "is required.");
  }
  return result;
}

function stableId(value: unknown, path: string) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value)) {
    fail("CUT_AUDIO_AUDITION_ID", path, "must be one canonical lowercase stable id.");
  }
  return value;
}

function digest(value: unknown, path: string) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    fail("CUT_AUDIO_AUDITION_SHA256", path, "must be one lowercase SHA-256 digest.");
  }
  return value;
}

function safeLocator(value: unknown, path: string) {
  try { return validateProjectLocator(value, path); }
  catch (error) { fail("CUT_AUDIO_AUDITION_LOCATOR", path, error instanceof Error ? error.message : "must be project-relative."); }
}

function safeInteger(value: unknown, path: string, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    fail("CUT_AUDIO_AUDITION_NUMBER", path, `must be one safe integer within [${minimum}, ${maximum}].`);
  }
  return Number(value);
}

export function cutAudioAuditionBindingsSha256(body: Omit<CutAudioAuditionBindings, "bindingsSha256">) {
  return createHash("sha256").update(stableJsonStringify(body)).digest("hex");
}

export function parseCutAudioAuditionBindings(input: string | Uint8Array): CutAudioAuditionBindings {
  let decoded: unknown;
  try {
    decoded = parseStrictPackageJson(input, {
      limits: {
        maxInputBytes: cutAudioAuditionLimits.maximumBindingsBytes,
        maxDepth: 4,
        maxNodes: 10_000,
        maxStringBytes: 4_096,
        maxTotalStringBytes: 128 * 1024,
      },
    });
  } catch (error) {
    fail("CUT_AUDIO_AUDITION_JSON", "$", error instanceof Error ? error.message : "invalid strict JSON.");
  }
  const item = closed(decoded, "$", ["format", "version", "entries", "bindingsSha256"]);
  if (item.format !== cutAudioAuditionBindingsFormat
    || (item.version !== cutAudioAuditionLegacyBindingsVersion && item.version !== cutAudioAuditionBindingsVersion)) {
    fail("CUT_AUDIO_AUDITION_VERSION", "$", `must be ${cutAudioAuditionBindingsFormat} v${cutAudioAuditionLegacyBindingsVersion} or v${cutAudioAuditionBindingsVersion}.`);
  }
  const version = item.version as CutAudioAuditionBindings["version"];
  if (!Array.isArray(item.entries) || item.entries.length < 1 || item.entries.length > cutAudioAuditionLimits.maximumBindings) {
    fail("CUT_AUDIO_AUDITION_LIMIT", "$.entries", `must contain 1..${cutAudioAuditionLimits.maximumBindings} bindings.`);
  }
  const ids = new Set<string>(), locators = new Set<string>(), semanticLocators = new Set<string>();
  const entries = Object.freeze(item.entries.map((value, index): CutAudioAuditionBinding => {
    const path = `$.entries[${index}]`;
    const fields = version === cutAudioAuditionLegacyBindingsVersion
      ? ["id", "audioLocator", "rightsEvidenceLocator"]
      : ["id", "audioLocator", "rightsEvidenceLocator", "semanticAnalysis"];
    const entry = closed(value, path, fields);
    const id = stableId(entry.id, `${path}.id`), audioLocator = safeLocator(entry.audioLocator, `${path}.audioLocator`), rightsEvidenceLocator = safeLocator(entry.rightsEvidenceLocator, `${path}.rightsEvidenceLocator`);
    if (ids.has(id)) fail("CUT_AUDIO_AUDITION_DUPLICATE", `${path}.id`, "duplicates an earlier binding id.");
    if (locators.has(audioLocator)) fail("CUT_AUDIO_AUDITION_DUPLICATE", `${path}.audioLocator`, "duplicates an earlier audio locator.");
    ids.add(id); locators.add(audioLocator);
    if (version === cutAudioAuditionLegacyBindingsVersion) return Object.freeze({ id, audioLocator, rightsEvidenceLocator });
    const semanticItem = closed(entry.semanticAnalysis, `${path}.semanticAnalysis`, ["locator", "bytes", "fileSha256", "analysisSha256"]);
    const semanticAnalysis = Object.freeze({
      locator: safeLocator(semanticItem.locator, `${path}.semanticAnalysis.locator`),
      bytes: safeInteger(semanticItem.bytes, `${path}.semanticAnalysis.bytes`, 1, cutAudioAuditionLimits.maximumSemanticAnalysisBytes),
      fileSha256: digest(semanticItem.fileSha256, `${path}.semanticAnalysis.fileSha256`),
      analysisSha256: digest(semanticItem.analysisSha256, `${path}.semanticAnalysis.analysisSha256`),
    });
    if (semanticAnalysis.locator === audioLocator || semanticAnalysis.locator === rightsEvidenceLocator) {
      fail("CUT_AUDIO_AUDITION_DUPLICATE", `${path}.semanticAnalysis.locator`, "must differ from the audio and rights-evidence locators.");
    }
    if (semanticLocators.has(semanticAnalysis.locator)) {
      fail("CUT_AUDIO_AUDITION_DUPLICATE", `${path}.semanticAnalysis.locator`, "duplicates an earlier semantic-analysis locator.");
    }
    semanticLocators.add(semanticAnalysis.locator);
    return Object.freeze({ id, audioLocator, rightsEvidenceLocator, semanticAnalysis });
  }));
  const body = Object.freeze({ format: cutAudioAuditionBindingsFormat, version, entries });
  const bindingsSha256 = digest(item.bindingsSha256, "$.bindingsSha256");
  if (bindingsSha256 !== cutAudioAuditionBindingsSha256(body)) fail("CUT_AUDIO_AUDITION_IDENTITY", "$.bindingsSha256", "does not match canonical binding content.");
  return Object.freeze({ ...body, bindingsSha256 });
}

let semanticAnalysisSchemaValidator: ValidateFunction | undefined;

function cutAudioSemanticAnalysisValidator() {
  if (semanticAnalysisSchemaValidator) return semanticAnalysisSchemaValidator;
  let schema: Record<string, unknown>;
  try {
    schema = JSON.parse(readFileSync(resolve(__dirname, "../../../schemas/cut-audio-semantic-analysis-v1.schema.json"), "utf8")) as Record<string, unknown>;
  } catch (error) {
    fail("CUT_AUDIO_AUDITION_SEMANTIC_SCHEMA", "$", error instanceof Error ? error.message : "could not load the shipped semantic-analysis schema.");
  }
  const ajv = new Ajv({ allErrors: true, jsonPointers: true, strictKeywords: true });
  ajv.addKeyword("x-cut-semanticConstraints", { validate: () => true });
  semanticAnalysisSchemaValidator = ajv.compile(schema);
  return semanticAnalysisSchemaValidator;
}

function canonicalSha256(value: unknown) {
  return createHash("sha256").update(stableJsonStringify(value), "utf8").digest("hex");
}

function deeplyFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deeplyFreeze(child);
  }
  return value;
}

/**
 * Parse one materialized semantic artifact for downstream authoring use.
 * This proves closed canonical artifact structure and independently replays
 * provider top-class and taxonomy derivation from the embedded exact score and
 * class-map bytes. It deliberately does not re-run LiteRT.
 */
export function parseCutAudioAuditionSemanticAnalysis(input: string | Uint8Array): CutYamnetSemanticAnalysis {
  let decoded: unknown;
  try {
    decoded = parseStrictPackageJson(input, {
      limits: {
        maxInputBytes: cutAudioAuditionLimits.maximumSemanticAnalysisBytes,
        maxDepth: 32,
        maxNodes: 100_000,
        maxStringBytes: cutAudioAuditionLimits.maximumSemanticAnalysisStringBytes,
        maxTotalStringBytes: 512 * 1024,
      },
    });
  } catch (error) {
    fail("CUT_AUDIO_AUDITION_SEMANTIC_JSON", "$", error instanceof Error ? error.message : "invalid strict JSON.");
  }
  const validate = cutAudioSemanticAnalysisValidator();
  if (!validate(decoded)) {
    const detail = (validate.errors ?? []).slice(0, 3)
      .map((error) => `${error.dataPath || "/"} ${error.message ?? "is invalid"}`)
      .join("; ");
    fail("CUT_AUDIO_AUDITION_SEMANTIC_SCHEMA", "$", detail || "does not match the shipped closed semantic-analysis schema.");
  }
  let analysis: CutYamnetSemanticAnalysis;
  try {
    analysis = verifyCutYamnetSemanticAnalysisDerivation(decoded);
  } catch (error) {
    fail("CUT_AUDIO_AUDITION_SEMANTIC_DERIVATION", "$", error instanceof Error ? error.message : "embedded semantic derivation could not be verified.");
  }
  const { analysisSha256, ...analysisBody } = analysis;
  if (canonicalSha256(analysisBody) !== analysisSha256) {
    fail("CUT_AUDIO_AUDITION_SEMANTIC_IDENTITY", "$.analysisSha256", "does not match the canonical semantic-analysis body.");
  }
  const { evidenceSha256, ...normalizationBody } = analysis.normalization;
  if (canonicalSha256(normalizationBody) !== evidenceSha256) {
    fail("CUT_AUDIO_AUDITION_SEMANTIC_IDENTITY", "$.normalization.evidenceSha256", "does not match the canonical normalization body.");
  }
  const { suggestionsSha256, ...suggestionsBody } = analysis.taxonomy;
  if (canonicalSha256(suggestionsBody) !== suggestionsSha256) {
    fail("CUT_AUDIO_AUDITION_SEMANTIC_IDENTITY", "$.taxonomy.suggestionsSha256", "does not match the canonical taxonomy body.");
  }
  if (analysis.normalization.policy.policySha256 !== cutWaveNormalizePolicy.policySha256
    || analysis.taxonomy.policySha256 !== cutYamnetAudioSetMapV1.policySha256
    || stableJsonStringify(analysis.limitations) !== stableJsonStringify(cutYamnetSemanticAnalysisPolicy.limitations)) {
    fail("CUT_AUDIO_AUDITION_SEMANTIC_POLICY", "$", "does not bind the current normalization, taxonomy, and limitation policies.");
  }
  if (analysis.normalization.source.bytes !== analysis.source.bytes
    || analysis.normalization.source.sha256 !== analysis.source.sha256) {
    fail("CUT_AUDIO_AUDITION_SEMANTIC_LINK", "$.normalization.source", "does not cross-bind the semantic source authority.");
  }
  const normalized = analysis.normalization.output, providerInput = analysis.provider.input;
  if (providerInput.sampleFormat !== normalized.sampleFormat
    || providerInput.sampleRate !== normalized.sampleRate
    || providerInput.channels !== normalized.channels
    || providerInput.samples !== normalized.samples
    || providerInput.bytes !== normalized.bytes
    || providerInput.sha256 !== normalized.sha256) {
    fail("CUT_AUDIO_AUDITION_SEMANTIC_LINK", "$.provider.input", "does not cross-bind the exact normalized output.");
  }
  const rawScores = analysis.provider.rawScores, sourceScores = analysis.taxonomy.sourceScores;
  if (sourceScores.sampleFormat !== rawScores.sampleFormat
    || sourceScores.classCount !== rawScores.classCount
    || sourceScores.bytes !== rawScores.bytes
    || sourceScores.sha256 !== rawScores.sha256
    || sourceScores.labelMapSha256 !== analysis.provider.authorities.classMapSha256) {
    fail("CUT_AUDIO_AUDITION_SEMANTIC_LINK", "$.taxonomy.sourceScores", "does not cross-bind provider score and class-map authority.");
  }
  return deeplyFreeze(JSON.parse(stableJsonStringify(analysis)) as CutYamnetSemanticAnalysis);
}

async function stableFileIdentity(projectRoot: string, locator: string, maximumBytes: number, testHooks: CutAudioAuditionFileTestHooks = {}) {
  let handle: FileHandle | undefined;
  try {
    const root = await realpath(resolve(projectRoot));
    const parent = await realpath(dirname(resolve(root, locator)));
    const fromRoot = relative(root, parent);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      fail("CUT_AUDIO_AUDITION_FILE", locator, "could not be opened safely.");
    }
    const path = resolve(parent, basename(locator));
    const entryBefore = await lstat(path, { bigint: true });
    if (!entryBefore.isFile() || entryBefore.isSymbolicLink()) {
      fail("CUT_AUDIO_AUDITION_FILE", locator, "must be one symlink-free regular file.");
    }
    await testHooks.afterResolve?.();
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    if (before.dev !== entryBefore.dev || before.ino !== entryBefore.ino) {
      fail("CUT_AUDIO_AUDITION_MUTATION", locator, "changed before its authenticated read.");
    }
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maximumBytes)) {
      fail("CUT_AUDIO_AUDITION_FILE", locator, `must be one 1..${maximumBytes}-byte regular file.`);
    }
    const bytes = await handle.readFile(), after = await handle.stat({ bigint: true }), entryAfter = await lstat(path, { bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      fail("CUT_AUDIO_AUDITION_MUTATION", locator, "changed during its authenticated read.");
    }
    if (!entryAfter.isFile() || entryAfter.isSymbolicLink()
      || entryAfter.dev !== after.dev || entryAfter.ino !== after.ino || entryAfter.size !== after.size
      || entryAfter.mtimeNs !== after.mtimeNs || entryAfter.ctimeNs !== after.ctimeNs) {
      fail("CUT_AUDIO_AUDITION_MUTATION", locator, "changed before its authenticated read closed.");
    }
    return Object.freeze({ locator, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"), contents: bytes });
  } catch (error) {
    if (error instanceof CutAudioAuditionError) throw error;
    // Native filesystem messages commonly include the resolved absolute path.
    // The project locator is sufficient public diagnostic authority; never
    // copy an OS message across the CLI privacy boundary.
    fail("CUT_AUDIO_AUDITION_FILE", locator, "could not be opened safely.");
  } finally { await handle?.close().catch(() => undefined); }
}

/** Read one bounded project JSON/evidence input without following a leaf symlink. */
export async function loadCutAudioAuditionProjectFile(projectRoot: string, locator: string, maximumBytes: number, testHooks: CutAudioAuditionFileTestHooks = {}) {
  const safeMaximum = Number(maximumBytes);
  if (!Number.isSafeInteger(safeMaximum) || safeMaximum < 1 || safeMaximum > cutAudioAuditionLimits.maximumWaveBytes) {
    fail("CUT_AUDIO_AUDITION_LIMIT", "$.maximumBytes", `must be 1..${cutAudioAuditionLimits.maximumWaveBytes}.`);
  }
  return stableFileIdentity(projectRoot, safeLocator(locator, "$.locator"), safeMaximum, testHooks);
}

type CutAudioAuditionLockResource = Readonly<{
  id: string;
  kind: string;
  locator: string;
  bytes: number;
  sha256: string;
}>;

type CutAudioAuditionAppliedResource = Readonly<{
  id: string;
  kind: string;
  locator: string;
  state: string;
  sha256?: string;
  metadata?: Readonly<Record<string, unknown>>;
}>;

/**
 * Reconcile the generated audition graph's two fixed resource slots with the
 * exact media authorities used for signal/semantic ranking. A lock created
 * after either locator changes must never authorize rendering or publication.
 */
export function assertCutAudioAuditionRenderAuthorities(options: Readonly<{
  lockResources: Readonly<Record<string, CutAudioAuditionLockResource>>;
  appliedResources: Readonly<Record<string, CutAudioAuditionAppliedResource>>;
  dialogue: CutLockedFileIdentity;
  candidate: CutAudioAuditionVerifiedCandidate;
}>) {
  const expectedIds = ["candidate", "dialogueAsset"];
  const lockIds = Object.keys(options.lockResources).sort(compareText);
  const appliedIds = Object.keys(options.appliedResources).sort(compareText);
  if (stableJsonStringify(lockIds) !== stableJsonStringify(expectedIds)
    || stableJsonStringify(appliedIds) !== stableJsonStringify(expectedIds)) {
    fail("CUT_AUDIO_AUDITION_LOCK_AUTHORITY", "$.resources", "generated audition lock and applied graph must contain exactly the dialogue and candidate resources.");
  }
  const expectations = Object.freeze({
    dialogueAsset: options.dialogue,
    candidate: options.candidate.file,
  });
  for (const id of expectedIds as Array<keyof typeof expectations>) {
    const expected = expectations[id], locked = options.lockResources[id], applied = options.appliedResources[id];
    if (!locked || locked.id !== id || locked.kind !== "audio"
      || locked.locator !== expected.locator || locked.bytes !== expected.bytes || locked.sha256 !== expected.sha256) {
      fail("CUT_AUDIO_AUDITION_LOCK_AUTHORITY", `$.resources.${id}`, "generated lock does not match the exact verified audition media authority.");
    }
    if (!applied || applied.id !== id || applied.kind !== "audio" || applied.state !== "locked"
      || applied.locator !== expected.locator || applied.sha256 !== expected.sha256
      || applied.metadata?.bytes !== expected.bytes) {
      fail("CUT_AUDIO_AUDITION_LOCK_AUTHORITY", `$.appliedResources.${id}`, "applied graph does not match the exact verified audition media authority.");
    }
  }
}

/** Retain the exact inode and byte authority for one just-created artifact. */
export async function retainCutAudioAuditionOwnedArtifact(path: string, expectedSha256: string, maximumBytes: number): Promise<CutAudioAuditionOwnedArtifact> {
  const safeMaximum = Number(maximumBytes);
  if (!Number.isSafeInteger(safeMaximum) || safeMaximum < 1 || safeMaximum > cutAudioAuditionLimits.maximumWaveBytes) {
    fail("CUT_AUDIO_AUDITION_LIMIT", "$.maximumBytes", `must be 1..${cutAudioAuditionLimits.maximumWaveBytes}.`);
  }
  const expected = digest(expectedSha256, "$.expectedSha256");
  const parentPath = dirname(path);
  let handle: FileHandle | undefined, parentHandle: FileHandle | undefined, retained = false;
  try {
    parentHandle = await open(parentPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const parentBefore = await parentHandle.stat({ bigint: true });
    if (!parentBefore.isDirectory()) fail("CUT_AUDIO_AUDITION_OWNERSHIP", parentPath, "published output parent is not one retained directory.");
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(safeMaximum)) {
      fail("CUT_AUDIO_AUDITION_OWNERSHIP", path, "published output is not one bounded regular file.");
    }
    const bytes = await handle.readFile(), after = await handle.stat({ bigint: true });
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || BigInt(bytes.byteLength) !== before.size) {
      fail("CUT_AUDIO_AUDITION_OWNERSHIP", path, "published output changed while CUT retained cleanup authority.");
    }
    if (sha256 !== expected) fail("CUT_AUDIO_AUDITION_OWNERSHIP", path, "published output bytes do not match CUT's expected digest.");
    const parentAfter = await parentHandle.stat({ bigint: true });
    if (parentAfter.dev !== parentBefore.dev || parentAfter.ino !== parentBefore.ino) fail("CUT_AUDIO_AUDITION_OWNERSHIP", parentPath, "published output parent changed while CUT retained cleanup authority.");
    retained = true;
    return Object.freeze({
      path, parentPath, parentDev: parentBefore.dev, parentIno: parentBefore.ino,
      dev: before.dev, ino: before.ino, size: before.size, mtimeNs: before.mtimeNs, ctimeNs: before.ctimeNs, sha256,
      handle, parentHandle,
    });
  } catch (error) {
    if (error instanceof CutAudioAuditionError) throw error;
    return fail("CUT_AUDIO_AUDITION_OWNERSHIP", path, error instanceof Error ? error.message : "could not retain cleanup authority.");
  } finally {
    if (!retained) await Promise.all([handle?.close().catch(() => undefined), parentHandle?.close().catch(() => undefined)]);
  }
}

async function readRetainedFile(handle: FileHandle, size: bigint) {
  if (size > BigInt(cutAudioAuditionLimits.maximumWaveBytes)) throw new Error("retained artifact exceeds its cleanup byte ceiling");
  const bytes = Buffer.alloc(Number(size));
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (result.bytesRead < 1) throw new Error("retained artifact ended before its cleanup byte authority");
    offset += result.bytesRead;
  }
  return bytes;
}

async function locateRetainedEntry(
  parentPath: string,
  parentHandle: FileHandle,
  parentDev: bigint,
  parentIno: bigint,
  dev: bigint,
  ino: bigint,
  kind: "file" | "directory",
) {
  const retainedParent = await parentHandle.stat({ bigint: true });
  const currentParent = await lstat(parentPath, { bigint: true });
  if (!retainedParent.isDirectory() || !currentParent.isDirectory() || currentParent.isSymbolicLink()
    || retainedParent.dev !== parentDev || retainedParent.ino !== parentIno || currentParent.dev !== parentDev || currentParent.ino !== parentIno) return undefined;
  const names = await readdir(parentPath);
  if (names.length > 4_096) return undefined;
  const matches: string[] = [];
  for (const name of names) {
    const candidate = resolve(parentPath, name), metadata = await lstat(candidate, { bigint: true }).catch(() => undefined);
    const matchesKind = kind === "file" ? metadata?.isFile() : metadata?.isDirectory() && !metadata.isSymbolicLink();
    if (matchesKind && metadata!.dev === dev && metadata!.ino === ino) matches.push(candidate);
  }
  return matches.length === 1 ? matches[0] : undefined;
}

async function locateRetainedDirectory(authority: CutAudioAuditionOwnedDirectory) {
  return locateRetainedEntry(authority.parentPath, authority.parentHandle, authority.parentDev, authority.parentIno, authority.dev, authority.ino, "directory");
}

async function restoreForeignQuarantine(quarantine: string, destination: string) {
  const metadata = await lstat(quarantine, { bigint: true });
  if (metadata.isFile()) {
    await link(quarantine, destination);
    await unlink(quarantine);
    return;
  }
  if (metadata.isSymbolicLink()) {
    await symlink(await readlink(quarantine), destination);
    await unlink(quarantine);
    return;
  }
  throw new Error("raced foreign cleanup entry cannot be restored without clobbering");
}

/** Release retained file and parent handles after a successful command. */
export async function releaseCutAudioAuditionOwnedArtifact(authority: CutAudioAuditionOwnedArtifact) {
  await Promise.all([authority.handle.close(), authority.parentHandle.close()]);
}

/**
 * Roll back through one retained private quarantine. The owned inode is found
 * under its retained parent, atomically moved, and rechecked before unlink. A
 * raced foreign file is restored without clobbering and reported as failure.
 */
export async function removeCutAudioAuditionOwnedArtifact(
  authority: CutAudioAuditionOwnedArtifact,
  stage: CutAudioAuditionOwnedDirectory,
  hooks: CutAudioAuditionCleanupTestHooks = {},
) {
  try {
    const retained = await authority.handle.stat({ bigint: true });
    if (!retained.isFile() || retained.dev !== authority.dev || retained.ino !== authority.ino || retained.size !== authority.size
      || retained.mtimeNs !== authority.mtimeNs || retained.ctimeNs !== authority.ctimeNs
      || createHash("sha256").update(await readRetainedFile(authority.handle, authority.size)).digest("hex") !== authority.sha256) return "foreign" as const;
    const located = await locateRetainedEntry(authority.parentPath, authority.parentHandle, authority.parentDev, authority.parentIno, authority.dev, authority.ino, "file");
    if (!located) return retained.nlink === 0n ? "absent" as const : "foreign" as const;
    const stagePath = await locateRetainedDirectory(stage);
    if (!stagePath) return "foreign" as const;
    const quarantine = resolve(stagePath, `.cleanup-${randomBytes(16).toString("hex")}-${basename(located)}`);
    await hooks.beforeQuarantine?.(located);
    await rename(located, quarantine);
    const moved = await lstat(quarantine, { bigint: true });
    if (moved.isFile() && moved.dev === authority.dev && moved.ino === authority.ino) {
      await unlink(quarantine);
      return "removed" as const;
    }
    await restoreForeignQuarantine(quarantine, located);
    return "foreign" as const;
  } catch {
    return "foreign" as const;
  } finally {
    await Promise.all([authority.handle.close().catch(() => undefined), authority.parentHandle.close().catch(() => undefined)]);
  }
}

/** Retain inode authority for one CUT-created private staging directory. */
export async function retainCutAudioAuditionOwnedDirectory(path: string): Promise<CutAudioAuditionOwnedDirectory> {
  const parentPath = dirname(path);
  let handle: FileHandle | undefined, parentHandle: FileHandle | undefined, retained = false;
  try {
    parentHandle = await open(parentPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const [metadata, parentMetadata] = await Promise.all([handle.stat({ bigint: true }), parentHandle.stat({ bigint: true })]);
    if (!metadata.isDirectory() || !parentMetadata.isDirectory() || (metadata.mode & 0o077n) !== 0n) {
      fail("CUT_AUDIO_AUDITION_OWNERSHIP", path, "staging output is not one real directory.");
    }
    retained = true;
    return Object.freeze({
      path, dev: metadata.dev, ino: metadata.ino, mode: metadata.mode,
      parentPath, parentDev: parentMetadata.dev, parentIno: parentMetadata.ino,
      handle, parentHandle,
    });
  } catch (error) {
    if (error instanceof CutAudioAuditionError) throw error;
    return fail("CUT_AUDIO_AUDITION_OWNERSHIP", path, error instanceof Error ? error.message : "could not retain staging-directory authority.");
  } finally {
    if (!retained) await Promise.all([handle?.close().catch(() => undefined), parentHandle?.close().catch(() => undefined)]);
  }
}

/** Release retained directory handles without removing an untrusted residue. */
export async function releaseCutAudioAuditionOwnedDirectory(authority: CutAudioAuditionOwnedDirectory) {
  await Promise.all([authority.handle.close(), authority.parentHandle.close()]);
}

/**
 * Remove a CUT-created private staging tree only while the leaf still names
 * the exact retained directory inode. A foreign replacement is preserved.
 */
export async function removeCutAudioAuditionOwnedDirectory(
  authority: CutAudioAuditionOwnedDirectory,
  hooks: CutAudioAuditionCleanupTestHooks = {},
) {
  try {
    const retained = await authority.handle.stat({ bigint: true }), located = await locateRetainedDirectory(authority);
    if (!retained.isDirectory() || retained.dev !== authority.dev || retained.ino !== authority.ino || retained.mode !== authority.mode) return "foreign" as const;
    if (!located) return retained.nlink === 0n ? "absent" as const : "foreign" as const;
    const quarantine = resolve(authority.parentPath, `.cleanup-stage-${randomBytes(16).toString("hex")}-${basename(located)}`);
    await hooks.beforeStageQuarantine?.(located);
    await rename(located, quarantine);
    const moved = await lstat(quarantine, { bigint: true });
    if (!moved.isDirectory() || moved.isSymbolicLink() || moved.dev !== authority.dev || moved.ino !== authority.ino) {
      // The raced foreign directory is deliberately preserved at the bounded
      // quarantine locator. The caller surfaces cleanup failure and never
      // reports the audition as successful.
      return "foreign" as const;
    }
    let entryCount = 0;
    const clean = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        entryCount += 1;
        if (entryCount > 512) throw new Error("staging cleanup entry ceiling exceeded");
        const candidate = resolve(directory, entry.name), metadata = await lstat(candidate, { bigint: true });
        if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
          if (metadata.dev !== authority.dev) throw new Error("foreign filesystem directory in private stage");
          await clean(candidate); await rmdir(candidate);
        } else await unlink(candidate);
      }
    };
    await clean(quarantine);
    await rmdir(quarantine);
    return "removed" as const;
  } catch {
    return "foreign" as const;
  } finally {
    await Promise.all([authority.handle.close().catch(() => undefined), authority.parentHandle.close().catch(() => undefined)]);
  }
}

type WaveFormat = Readonly<{ code: number; channels: number; sampleRate: number; blockAlign: number; bitsPerSample: 16 | 24 | 32 }>;

function pcmValue(bytes: Buffer, offset: number, bits: 16 | 24 | 32) {
  if (bits === 16) return bytes.readInt16LE(offset) / 32_768;
  if (bits === 24) {
    let value = bytes[offset]! | bytes[offset + 1]! << 8 | bytes[offset + 2]! << 16;
    if (value & 0x800000) value -= 0x1000000;
    return value / 8_388_608;
  }
  return bytes.readInt32LE(offset) / 2_147_483_648;
}

function dbfsMilli(amplitude: number) {
  return amplitude <= 0 ? -120_000 : Math.max(-120_000, Math.round(20_000 * Math.log10(amplitude)));
}

function sectionRms(samples: Float32Array, count = 8) {
  const result: number[] = [];
  for (let section = 0; section < count; section += 1) {
    const start = Math.floor(samples.length * section / count), end = Math.floor(samples.length * (section + 1) / count);
    let square = 0;
    for (let index = start; index < end; index += 1) square += samples[index]! * samples[index]!;
    result.push(dbfsMilli(end > start ? Math.sqrt(square / (end - start)) : 0));
  }
  return Object.freeze(result);
}

/** Decode and measure one exact bounded classic integer-PCM WAVE interval. */
export function analyzeCutAudioAuditionWave(bytes: Buffer, expected: Readonly<{
  sampleRate: number;
  channels: number;
  durationSamples: number;
  renderedSourceIntervals?: readonly Readonly<{ startSample: number; endSample: number }>[];
}>): CutAudioAuditionSignalEvidence {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength < 44 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE" || bytes.readUInt32LE(4) + 8 !== bytes.byteLength) {
    fail("CUT_AUDIO_AUDITION_WAVE", "$.candidate", "must be one complete classic RIFF/WAVE byte stream.");
  }
  let cursor = 12, chunks = 0, format: WaveFormat | undefined, data: Buffer | undefined;
  while (cursor + 8 <= bytes.length) {
    if (++chunks > cutAudioAuditionLimits.maximumWaveChunks) fail("CUT_AUDIO_AUDITION_WAVE", "$.candidate", "contains too many WAVE chunks.");
    const id = bytes.toString("ascii", cursor, cursor + 4), size = bytes.readUInt32LE(cursor + 4), body = cursor + 8, end = body + size;
    if (end > bytes.length) fail("CUT_AUDIO_AUDITION_WAVE", "$.candidate", `contains one truncated ${JSON.stringify(id)} chunk.`);
    if (id === "fmt ") {
      if (format || size < 16) fail("CUT_AUDIO_AUDITION_WAVE", "$.candidate", "must contain one complete format chunk.");
      const code = bytes.readUInt16LE(body), channels = bytes.readUInt16LE(body + 2), sampleRate = bytes.readUInt32LE(body + 4), blockAlign = bytes.readUInt16LE(body + 12), rawBits = bytes.readUInt16LE(body + 14);
      if (code !== 1 || ![16, 24, 32].includes(rawBits) || channels < 1 || channels > 8 || sampleRate < 8_000 || sampleRate > 96_000 || blockAlign !== channels * rawBits / 8) {
        fail("CUT_AUDIO_AUDITION_WAVE_SUBSET", "$.candidate", "tranche 1 accepts classic PCM integer WAVE at 8..96 kHz, 1..8 channels, and 16/24/32 bits only.");
      }
      format = Object.freeze({ code, channels, sampleRate, blockAlign, bitsPerSample: rawBits as 16 | 24 | 32 });
    }
    if (id === "data") {
      if (data) fail("CUT_AUDIO_AUDITION_WAVE", "$.candidate", "must contain one data chunk.");
      data = bytes.subarray(body, end);
    }
    cursor = end + (size & 1);
  }
  if (!format || !data || data.length % format.blockAlign !== 0) fail("CUT_AUDIO_AUDITION_WAVE", "$.candidate", "must contain aligned format and data chunks.");
  const sourceSamples = data.length / format.blockAlign;
  if (format.sampleRate !== expected.sampleRate || format.channels !== expected.channels || sourceSamples !== expected.durationSamples) {
    fail("CUT_AUDIO_AUDITION_CATALOG_MISMATCH", "$.candidate", "decoded WAVE sample rate, channels, or duration does not match the catalog metadata.");
  }
  const renderedSourceIntervals = expected.renderedSourceIntervals ?? [{ startSample: 0, endSample: sourceSamples }];
  if (!Array.isArray(renderedSourceIntervals) || renderedSourceIntervals.length < 1 || renderedSourceIntervals.length > cutAudioAuditionLimits.maximumLoopPlacements) {
    fail("CUT_AUDIO_AUDITION_RANGE", "$.candidate.renderedSourceIntervals", `must contain 1..${cutAudioAuditionLimits.maximumLoopPlacements} rendered source intervals.`);
  }
  let analysisSamples = 0;
  const exactIntervals = Object.freeze(renderedSourceIntervals.map((interval, index) => {
    if (!Number.isSafeInteger(interval.startSample) || !Number.isSafeInteger(interval.endSample)
      || interval.startSample < 0 || interval.startSample >= interval.endSample || interval.endSample > sourceSamples) {
      fail("CUT_AUDIO_AUDITION_RANGE", `$.candidate.renderedSourceIntervals[${index}]`, "must be one non-empty half-open source-sample interval inside the authenticated WAVE.");
    }
    analysisSamples += interval.endSample - interval.startSample;
    if (!Number.isSafeInteger(analysisSamples)) fail("CUT_AUDIO_AUDITION_ANALYSIS_LIMIT", "$.candidate.renderedSourceIntervals", "aggregate rendered source samples exceed safe integer arithmetic.");
    return Object.freeze({ semantics: "half-open-samples" as const, startSample: interval.startSample, endSample: interval.endSample });
  }));
  if (analysisSamples > format.sampleRate * cutAudioAuditionLimits.maximumAnalysisSeconds) {
    fail("CUT_AUDIO_AUDITION_ANALYSIS_LIMIT", "$.candidate.renderedSourceIntervals", `must not exceed ${cutAudioAuditionLimits.maximumAnalysisSeconds} seconds of rendered source work.`);
  }
  if (analysisSamples * format.channels > cutAudioAuditionLimits.maximumAnalysisSampleOperations) {
    fail("CUT_AUDIO_AUDITION_ANALYSIS_LIMIT", "$.candidate", "bounded mono downmix work exceeds the tranche-1 analysis ceiling.");
  }
  const mono = new Float32Array(analysisSamples), bytesPerSample = format.bitsPerSample / 8;
  let square = 0, peak = 0, renderedFrame = 0;
  for (const interval of exactIntervals) {
    for (let sourceFrame = interval.startSample; sourceFrame < interval.endSample; sourceFrame += 1) {
      let sum = 0;
      for (let channel = 0; channel < format.channels; channel += 1) {
        const channelValue = pcmValue(data, sourceFrame * format.blockAlign + channel * bytesPerSample, format.bitsPerSample);
        sum += channelValue;
        square += channelValue * channelValue;
        peak = Math.max(peak, Math.abs(channelValue));
      }
      mono[renderedFrame] = sum / format.channels;
      renderedFrame += 1;
    }
  }
  // Keep the shared autocorrelation kernel below its exact quadratic work
  // ceiling even when the full 120-second analysis window is admitted.
  const hopSamples = Math.max(1, Math.ceil(analysisSamples / 2_800)), windowSamples = Math.min(analysisSamples, hopSamples * 2);
  const dsp = analyzeCutAudioPcm(mono, { sampleRate: format.sampleRate, windowSamples, hopSamples, silenceThresholdDbfsMilli: -50_000, tempoMinBpm: 50, tempoMaxBpm: 200 });
  const activeWindows = dsp.windows.filter((window) => window.rmsDbfsMilli > -50_000).length;
  const meanOnset = dsp.windows.reduce((sum, window) => sum + window.onsetStrengthPpm, 0);
  return Object.freeze({
    contract: "bounded-classic-pcm-wave-v1",
    renderedSourceIntervals: exactIntervals,
    analyzedSamples: analysisSamples,
    sourceSamples,
    sampleRate: format.sampleRate,
    channels: format.channels,
    bitsPerSample: format.bitsPerSample,
    rmsDbfsMilli: dbfsMilli(Math.sqrt(square / (analysisSamples * format.channels))),
    peakDbfsMilli: dbfsMilli(peak),
    activityPpm: Math.round(activeWindows * 1_000_000 / dsp.windows.length),
    meanOnsetPpm: Math.round(meanOnset / dsp.windows.length),
    tempoCandidates: dsp.tempoCandidates,
    sectionRmsDbfsMilli: sectionRms(mono),
  });
}

function compareText(left: string, right: string) { return left < right ? -1 : left > right ? 1 : 0; }

function exactCandidateRenderedSourceIntervals(
  audio: Readonly<{ durationSamples: number; sampleRate: number; loopable: boolean }>,
  auditionSamples: number,
  auditionSampleRate: number,
) {
  const totalSourceSamples = BigInt(auditionSamples) * BigInt(audio.sampleRate) / BigInt(auditionSampleRate);
  if (totalSourceSamples < 1n) return Object.freeze([]);
  const loops = audio.loopable
    ? Number((totalSourceSamples + BigInt(audio.durationSamples) - 1n) / BigInt(audio.durationSamples))
    : 1;
  if (!Number.isSafeInteger(loops) || loops < 1 || loops > cutAudioAuditionLimits.maximumLoopPlacements) return Object.freeze([]);
  let remaining = totalSourceSamples;
  const intervals: Array<Readonly<{ semantics: "half-open-samples"; startSample: 0; endSample: number }>> = [];
  for (let loop = 0; loop < loops && remaining > 0n; loop += 1) {
    const endSample = Number(remaining < BigInt(audio.durationSamples) ? remaining : BigInt(audio.durationSamples));
    intervals.push(Object.freeze({ semantics: "half-open-samples", startSample: 0, endSample }));
    remaining -= BigInt(endSample);
  }
  return Object.freeze(intervals);
}

function bindCutAudioAuditionSemanticEvidence(
  binding: NonNullable<CutAudioAuditionBinding["semanticAnalysis"]>,
  file: Readonly<{ locator: string; bytes: number; sha256: string; contents: Buffer }>,
  source: CutLockedFileIdentity,
  sourceBytes: Buffer,
  audio: Readonly<{ durationSamples: number; sampleRate: number; channels: number }>,
) {
  if (file.bytes !== binding.bytes || file.sha256 !== binding.fileSha256) {
    fail("CUT_AUDIO_AUDITION_SEMANTIC_IDENTITY", binding.locator, "does not match the binding's exact file identity.");
  }
  const analysis = parseCutAudioAuditionSemanticAnalysis(file.contents);
  if (analysis.analysisSha256 !== binding.analysisSha256) {
    fail("CUT_AUDIO_AUDITION_SEMANTIC_IDENTITY", binding.locator, "does not match the binding's canonical analysis identity.");
  }
  if (analysis.source.locator !== source.locator
    || analysis.source.bytes !== source.bytes
    || analysis.source.sha256 !== source.sha256) {
    fail("CUT_AUDIO_AUDITION_SEMANTIC_SOURCE", binding.locator, "does not cross-bind the exact catalog candidate source.");
  }
  let recomputed: CutYamnetSemanticAnalysis;
  try {
    const normalized = normalizeCutWaveForYamnet(sourceBytes, { bytes: source.bytes, sha256: source.sha256 });
    recomputed = materializeCutYamnetSemanticAnalysis({
      source: analysis.source,
      sourceBytes,
      normalization: normalized.evidence,
      pcm: normalized.pcmBytes,
      providerAnalysis: analysis.provider,
      rawScoreBytes: Buffer.from(analysis.derivationInputs.rawScores.data, "base64"),
      classMapBytes: Buffer.from(analysis.derivationInputs.classMap.data, "base64"),
    });
  } catch (error) {
    fail("CUT_AUDIO_AUDITION_SEMANTIC_REPLAY", binding.locator, error instanceof Error ? error.message : "source-backed semantic replay failed.");
  }
  if (stableJsonStringify(recomputed) !== stableJsonStringify(analysis)) {
    fail("CUT_AUDIO_AUDITION_SEMANTIC_REPLAY", binding.locator, "does not equal semantic analysis independently replayed from the authenticated source and embedded derivation bytes.");
  }
  const wave = analysis.normalization.wave;
  if (wave.frames !== audio.durationSamples || wave.sampleRate !== audio.sampleRate || wave.channels !== audio.channels) {
    fail("CUT_AUDIO_AUDITION_SEMANTIC_SOURCE", binding.locator, "does not cross-bind the catalog candidate's exact sample extent, rate, and channels.");
  }
  return Object.freeze({
    contract: "authenticated-source-and-embedded-semantic-derivation-recomputed-without-model-reexecution-v1" as const,
    file: Object.freeze({ locator: file.locator, bytes: file.bytes, sha256: file.sha256 }),
    analysisSha256: analysis.analysisSha256,
    source: analysis.source,
    normalization: Object.freeze({
      evidenceSha256: analysis.normalization.evidenceSha256,
      policySha256: analysis.normalization.policy.policySha256,
      outputSha256: analysis.normalization.output.sha256,
      outputSamples: analysis.normalization.output.samples,
    }),
    provider: Object.freeze({
      id: analysis.provider.provider,
      analysisSha256: analysis.provider.analysisSha256,
      rawScoreSha256: analysis.provider.rawScores.sha256,
      authorities: analysis.provider.authorities,
      aggregateTopClasses: analysis.provider.aggregateTopClasses,
    }),
    taxonomy: Object.freeze({
      policySha256: analysis.taxonomy.policySha256,
      suggestionsSha256: analysis.taxonomy.suggestionsSha256,
      interpretation: analysis.taxonomy.interpretation,
      musicMoodScope: analysis.taxonomy.musicMoodScope,
      roleSuggestions: analysis.taxonomy.aggregate.roleSuggestions,
      musicMoodSuggestions: analysis.taxonomy.aggregate.musicMoodSuggestions,
    }),
    limitations: analysis.limitations,
  });
}

/** Authenticate dialogue and every explicitly bound catalog candidate before ranking. */
export async function verifyCutAudioAuditionInputs(options: Readonly<{
  projectRoot: string;
  dialogueLocator: string;
  brief: CutAudioBrief;
  catalog: CutAssetCatalog;
  bindings: CutAudioAuditionBindings;
  startSample: number;
  endSample: number;
  musicStartSample: number;
}>) {
  if (!Number.isSafeInteger(options.startSample) || !Number.isSafeInteger(options.endSample)
    || options.startSample < 0 || options.startSample >= options.endSample || options.endSample > options.brief.durationSamples) {
    fail("CUT_AUDIO_AUDITION_RANGE", "$.samples", "must be one non-empty half-open range inside the brief sample clock.");
  }
  const windowSamples = options.endSample - options.startSample;
  if (!Number.isSafeInteger(options.musicStartSample) || options.musicStartSample < 0 || options.musicStartSample >= windowSamples) {
    fail("CUT_AUDIO_AUDITION_RANGE", "$.musicStartSample", "must be an integer inside the audition window, relative to its start.");
  }
  const candidateWindowSamples = windowSamples - options.musicStartSample;
  const dialogueLocator = safeLocator(options.dialogueLocator, "$.dialogueLocator"), dialogueProbe = await probeProjectMedia(options.projectRoot, dialogueLocator);
  const dialogueStreams = dialogueProbe.streams.filter((stream) => stream.type === "audio");
  if (dialogueStreams.length !== 1 || dialogueProbe.streams.some((stream) => stream.type === "video")) {
    fail("CUT_AUDIO_AUDITION_DIALOGUE", dialogueLocator, "must expose exactly one audio stream and no video stream.");
  }
  const dialogueStream = dialogueStreams[0]!;
  if (dialogueStream.sampleRate !== options.brief.sampleRate || dialogueProbe.file.bytes > cutAudioAuditionLimits.maximumWaveBytes) {
    fail("CUT_AUDIO_AUDITION_DIALOGUE", dialogueLocator, "must be one bounded PCM WAVE on the exact brief sample clock.");
  }
  const dialogueWave = await stableFileIdentity(options.projectRoot, dialogueLocator, cutAudioAuditionLimits.maximumWaveBytes);
  if (dialogueWave.bytes !== dialogueProbe.file.bytes || dialogueWave.sha256 !== dialogueProbe.file.sha256) {
    fail("CUT_AUDIO_AUDITION_MEDIA_IDENTITY", dialogueLocator, "changed between native probe and bounded signal analysis.");
  }
  const dialogueSignal = analyzeCutAudioAuditionWave(dialogueWave.contents, {
    sampleRate: options.brief.sampleRate,
    channels: dialogueStream.channels ?? 0,
    durationSamples: options.brief.durationSamples,
    renderedSourceIntervals: [{ startSample: options.startSample, endSample: options.endSample }],
  });
  const catalogById = new Map(options.catalog.entries.map((entry) => [entry.id, entry])), seen = new Set<string>();
  const candidates: CutAudioAuditionVerifiedCandidate[] = [], exclusions: Array<Readonly<{ id: string; reason: string }>> = [];
  for (const binding of options.bindings.entries) {
    const entry = catalogById.get(binding.id);
    if (!entry) fail("CUT_AUDIO_AUDITION_BINDING", binding.id, "does not identify one catalog entry.");
    seen.add(binding.id);
    if (entry.kind !== "audio" || !entry.audio || !entry.rights || entry.audio.role === "dialogue") {
      exclusions.push(Object.freeze({ id: binding.id, reason: "not-one-complete-nondialogue-audio-candidate" })); continue;
    }
    if (!doesCutAudioCatalogMetadataDeclareCommercialSyncUse(entry)) {
      exclusions.push(Object.freeze({ id: binding.id, reason: "catalog-grants-do-not-pass-the-closed-candidate-policy" })); continue;
    }
    const rightsEvidence = await stableFileIdentity(options.projectRoot, binding.rightsEvidenceLocator, cutAudioAuditionLimits.maximumEvidenceBytes);
    if (rightsEvidence.sha256 !== entry.rights.evidenceSha256) fail("CUT_AUDIO_AUDITION_RIGHTS_IDENTITY", binding.rightsEvidenceLocator, "does not match the catalog rights evidence digest.");
    const probe = await probeProjectMedia(options.projectRoot, binding.audioLocator), streams = probe.streams.filter((stream) => stream.type === "audio");
    if (probe.file.bytes !== entry.bytes || probe.file.sha256 !== entry.sha256) fail("CUT_AUDIO_AUDITION_MEDIA_IDENTITY", binding.audioLocator, "does not match the catalog byte identity.");
    if (streams.length !== 1 || probe.streams.some((stream) => stream.type === "video") || streams[0]!.sampleRate !== entry.audio.sampleRate || streams[0]!.channels !== entry.audio.channels) {
      fail("CUT_AUDIO_AUDITION_MEDIA_STREAM", binding.audioLocator, "must expose exactly the catalog-declared audio stream and no video stream.");
    }
    if (entry.bytes > cutAudioAuditionLimits.maximumWaveBytes) {
      exclusions.push(Object.freeze({ id: binding.id, reason: "CUT_AUDIO_AUDITION_WAVE_SIZE_LIMIT" })); continue;
    }
    const wave = await stableFileIdentity(options.projectRoot, binding.audioLocator, cutAudioAuditionLimits.maximumWaveBytes);
    if (wave.bytes !== entry.bytes || wave.sha256 !== entry.sha256) fail("CUT_AUDIO_AUDITION_MEDIA_IDENTITY", binding.audioLocator, "changed between native probe and bounded signal analysis.");
    const renderedSourceIntervals = exactCandidateRenderedSourceIntervals(entry.audio, candidateWindowSamples, options.brief.sampleRate);
    if (!renderedSourceIntervals.length) {
      exclusions.push(Object.freeze({ id: binding.id, reason: "CUT_AUDIO_AUDITION_EMPTY_SOURCE_INTERVAL" })); continue;
    }
    let signal: CutAudioAuditionSignalEvidence;
    try { signal = analyzeCutAudioAuditionWave(wave.contents, { ...entry.audio, renderedSourceIntervals }); }
    catch (error) {
      if (error instanceof CutAudioAuditionError && ["CUT_AUDIO_AUDITION_WAVE_SUBSET", "CUT_AUDIO_AUDITION_ANALYSIS_LIMIT"].includes(error.code)) {
        exclusions.push(Object.freeze({ id: binding.id, reason: error.code })); continue;
      }
      throw error;
    }
    const semantic = binding.semanticAnalysis
      ? bindCutAudioAuditionSemanticEvidence(
        binding.semanticAnalysis,
        await stableFileIdentity(options.projectRoot, binding.semanticAnalysis.locator, cutAudioAuditionLimits.maximumSemanticAnalysisBytes),
        probe.file,
        wave.contents,
        entry.audio,
      )
      : undefined;
    candidates.push(Object.freeze({
      entry: entry as CutAudioAuditionVerifiedCandidate["entry"],
      binding,
      file: probe.file,
      rightsEvidence: Object.freeze({ locator: rightsEvidence.locator, bytes: rightsEvidence.bytes, sha256: rightsEvidence.sha256 }),
      signal,
      ...(semantic ? { semantic } : {}),
    }));
  }
  for (const entry of options.catalog.entries) {
    if (entry.kind === "audio" && !seen.has(entry.id)) exclusions.push(Object.freeze({ id: entry.id, reason: "no-local-authority-binding" }));
  }
  if (!candidates.length) fail("CUT_AUDIO_AUDITION_NO_CANDIDATE", "$.bindings", "contains no verified, rights-evidenced, signal-measured non-dialogue audio candidate.");
  const semanticCount = candidates.filter((candidate) => candidate.semantic).length;
  if (semanticCount !== 0 && semanticCount !== candidates.length) {
    fail("CUT_AUDIO_AUDITION_SEMANTIC_COHORT", "$.bindings", "must provide semantic authority for every eligible candidate or for none of them.");
  }
  return Object.freeze({ dialogue: dialogueProbe.file, dialogueSignal, candidates: Object.freeze(candidates), exclusions: Object.freeze(exclusions.sort((left, right) => compareText(left.id, right.id))) });
}

function weightedPpm(brief: CutAudioBrief, startSample: number, endSample: number, select: (act: CutAudioBrief["acts"][number]) => number) {
  let numerator = 0n;
  for (const act of brief.acts) {
    const overlap = Math.max(0, Math.min(endSample, act.range.endSample) - Math.max(startSample, act.range.startSample));
    numerator += BigInt(overlap) * BigInt(select(act));
  }
  const samples = endSample - startSample;
  return Number((numerator + BigInt(Math.floor(samples / 2))) / BigInt(samples));
}

function energyPpm(value: CutAudioCatalogEnergy | undefined) { return value === "low" ? 250_000 : value === "medium" ? 500_000 : value === "high" ? 750_000 : 500_000; }
function fitPpm(left: number, right: number) { return Math.max(0, 1_000_000 - Math.abs(left - right)); }

function durationCoverage(candidate: CutAudioAuditionVerifiedCandidate, windowSamples: number, sampleRate: number) {
  const numerator = BigInt(candidate.entry.audio.durationSamples) * BigInt(sampleRate), denominator = BigInt(candidate.entry.audio.sampleRate) * BigInt(windowSamples);
  if (candidate.entry.audio.loopable || numerator >= denominator) return 1_000_000;
  return Number(numerator * 1_000_000n / denominator);
}

function placementPlan(candidate: CutAudioAuditionVerifiedCandidate, windowSamples: number, sampleRate: number, musicStartSample: number) {
  const asset = candidate.entry.audio;
  const renderedSourceIntervals = exactCandidateRenderedSourceIntervals(asset, windowSamples, sampleRate);
  if (!renderedSourceIntervals.length) return undefined;
  const coveragePpm = durationCoverage(candidate, windowSamples, sampleRate);
  const coverageSamples = Math.round(windowSamples * coveragePpm / 1_000_000);
  return Object.freeze({
    auditionStartSample: musicStartSample,
    auditionEndSample: musicStartSample + coverageSamples,
    loops: renderedSourceIntervals.length,
    coverageSamples,
    coveragePpm,
    renderedSourceIntervals,
  });
}

function levelingEvidence(signal: CutAudioAuditionSignalEvidence): CutAudioAuditionLevelingEvidence {
  const targetRmsDbfsMilli = -24_000 as const, peakCeilingDbfsMilli = -1_000 as const;
  const minimumGainDbMilli = -24_000 as const, maximumGainDbMilli = 12_000 as const;
  const requestedGainDbMilli = targetRmsDbfsMilli - signal.rmsDbfsMilli;
  const peakLimitedMaximumGainDbMilli = peakCeilingDbfsMilli - signal.peakDbfsMilli;
  const appliedGainDbMilli = Math.max(minimumGainDbMilli, Math.min(maximumGainDbMilli, peakLimitedMaximumGainDbMilli, requestedGainDbMilli));
  return Object.freeze({
    policy: "exact-window-rms-target-with-peak-ceiling-v1",
    sourceRmsDbfsMilli: signal.rmsDbfsMilli,
    sourcePeakDbfsMilli: signal.peakDbfsMilli,
    targetRmsDbfsMilli,
    peakCeilingDbfsMilli,
    minimumGainDbMilli,
    maximumGainDbMilli,
    requestedGainDbMilli,
    peakLimitedMaximumGainDbMilli,
    appliedGainDbMilli,
    bounded: appliedGainDbMilli !== requestedGainDbMilli,
  });
}

function tempoAgreement(candidate: CutAudioAuditionVerifiedCandidate) {
  const declared = candidate.entry.audio.bpmMilli, measured = candidate.signal.tempoCandidates[0];
  if (declared === undefined) return measured?.confidencePpm ?? 0;
  if (!measured) return 0;
  const fit = Math.max(0, 1_000_000 - Math.round(Math.abs(declared - measured.bpmMilli) * 1_000_000 / Math.max(declared, measured.bpmMilli)));
  return Math.round(fit * measured.confidencePpm / 1_000_000);
}

function semanticAdvisory(
  candidate: CutAudioAuditionVerifiedCandidate,
  placement: NonNullable<ReturnType<typeof placementPlan>>,
) {
  if (!candidate.semantic) return undefined;
  const roleSuggestionPpm = candidate.semantic.taxonomy.roleSuggestions
    .find((suggestion) => suggestion.id === candidate.entry.audio.role)?.scorePpm ?? 0;
  const exactWholeSource = placement.renderedSourceIntervals.every((interval) => (
    interval.startSample === 0 && interval.endSample === candidate.entry.audio.durationSamples
  ));
  const policy = "whole-source-music-only-centered-four-percent-capped-v1" as const;
  if (candidate.entry.audio.role !== "music") {
    return Object.freeze({
      policy,
      applicability: "not-applied-non-music-role" as const,
      role: candidate.entry.audio.role,
      roleSuggestionPpm,
      deltaPpm: 0,
    });
  }
  if (!exactWholeSource) {
    return Object.freeze({
      policy,
      applicability: "not-applied-inexact-rendered-window" as const,
      role: candidate.entry.audio.role,
      roleSuggestionPpm,
      deltaPpm: 0,
    });
  }
  const deltaPpm = Math.max(-20_000, Math.min(20_000, Math.round((roleSuggestionPpm - 500_000) * 40_000 / 1_000_000)));
  return Object.freeze({
    policy,
    applicability: "applied-exact-whole-source-music" as const,
    role: candidate.entry.audio.role,
    roleSuggestionPpm,
    deltaPpm,
  });
}

export function rankCutAudioAuditionCandidates(options: Readonly<{
  brief: CutAudioBrief;
  candidates: readonly CutAudioAuditionVerifiedCandidate[];
  startSample: number;
  endSample: number;
  musicStartSample: number;
  top: number;
}>) {
  const { brief } = options;
  if (!Number.isSafeInteger(options.startSample) || !Number.isSafeInteger(options.endSample) || options.startSample < 0 || options.startSample >= options.endSample || options.endSample > brief.durationSamples) {
    fail("CUT_AUDIO_AUDITION_RANGE", "$.samples", "must be one non-empty half-open range inside the brief sample clock.");
  }
  if (!Number.isSafeInteger(options.top) || options.top < 1 || options.top > cutAudioAuditionLimits.maximumTop) fail("CUT_AUDIO_AUDITION_TOP", "$.top", `must be 1..${cutAudioAuditionLimits.maximumTop}.`);
  const windowSamples = options.endSample - options.startSample;
  if (windowSamples > brief.sampleRate * 120) fail("CUT_AUDIO_AUDITION_RANGE", "$.samples", "must not exceed the existing 120-second audition-render boundary.");
  if (!Number.isSafeInteger(options.musicStartSample) || options.musicStartSample < 0 || options.musicStartSample >= windowSamples) {
    fail("CUT_AUDIO_AUDITION_RANGE", "$.musicStartSample", "must be an integer inside the audition window, relative to its start.");
  }
  const candidateWindowSamples = windowSamples - options.musicStartSample;
  const candidateBriefStart = options.startSample + options.musicStartSample;
  const semanticCount = options.candidates.filter((candidate) => candidate.semantic).length;
  if (semanticCount !== 0 && semanticCount !== options.candidates.length) {
    fail("CUT_AUDIO_AUDITION_SEMANTIC_COHORT", "$.candidates", "must provide semantic authority for every rankable candidate or for none of them.");
  }
  const density = weightedPpm(brief, candidateBriefStart, options.endSample, (act) => act.densityPpm);
  const targetEnergy = weightedPpm(brief, candidateBriefStart, options.endSample, (act) => act.energyPpm);
  const ranked = options.candidates.flatMap((candidate) => {
    const placement = placementPlan(candidate, candidateWindowSamples, brief.sampleRate, options.musicStartSample);
    if (!placement) return [];
    const renderedSamples = placement.renderedSourceIntervals.reduce((sum, interval) => sum + interval.endSample - interval.startSample, 0);
    if (stableJsonStringify(candidate.signal.renderedSourceIntervals) !== stableJsonStringify(placement.renderedSourceIntervals)
      || candidate.signal.analyzedSamples !== renderedSamples) {
      fail("CUT_AUDIO_AUDITION_SIGNAL_INTERVAL", candidate.entry.id, "measured signal evidence does not cover the exact ordered source-interval multiplicity that will be rendered.");
    }
    const roleCoveragePpm = weightedPpm(brief, candidateBriefStart, options.endSample, (act) => act.desiredRoles.includes(candidate.entry.audio.role) ? 1_000_000 : 0);
    const moodSet = new Set(candidate.entry.audio.moods);
    const moodCoveragePpm = weightedPpm(brief, candidateBriefStart, options.endSample, (act) => act.moods.some((mood) => moodSet.has(mood)) ? 1_000_000 : 0);
    const catalogEnergyFitPpm = fitPpm(energyPpm(candidate.entry.audio.energy), targetEnergy), durationCoveragePpm = placement.coveragePpm;
    const measuredActivityFitPpm = fitPpm(candidate.signal.activityPpm, density), measuredTempoAgreementPpm = tempoAgreement(candidate);
    const catalogSemanticPpm = Math.round((roleCoveragePpm * 400_000 + moodCoveragePpm * 300_000 + catalogEnergyFitPpm * 200_000 + durationCoveragePpm * 100_000) / 1_000_000);
    const measuredSignalPpm = Math.round((measuredActivityFitPpm * 600_000 + measuredTempoAgreementPpm * 400_000) / 1_000_000);
    const baseTotalPpm = Math.round((catalogSemanticPpm * 800_000 + measuredSignalPpm * 200_000) / 1_000_000);
    const semantic = semanticAdvisory(candidate, placement);
    const totalPpm = Math.max(0, Math.min(1_000_000, baseTotalPpm + (semantic?.deltaPpm ?? 0)));
    return [{
      candidate,
      placement,
      leveling: levelingEvidence(candidate.signal),
      score: Object.freeze({
        totalPpm,
        catalogSemanticPpm,
        measuredSignalPpm,
        ...(semantic ? { semanticAdvisory: semantic } : {}),
        factors: Object.freeze({ roleCoveragePpm, moodCoveragePpm, catalogEnergyFitPpm, durationCoveragePpm, measuredActivityFitPpm, measuredTempoAgreementPpm }),
      }),
    }];
  }).sort((left, right) => right.score.totalPpm - left.score.totalPpm || compareText(left.candidate.entry.id, right.candidate.entry.id)).slice(0, options.top);
  if (!ranked.length) fail("CUT_AUDIO_AUDITION_NO_CANDIDATE", "$.candidates", "no verified candidate can be represented inside the bounded ordinary CUT audition program.");
  return Object.freeze(ranked.map((item, index) => Object.freeze({ ...item.candidate, rank: index + 1, score: item.score, placement: item.placement, leveling: item.leveling })));
}

function seconds(numerator: bigint | number, denominator: bigint | number) { return `seconds(${numerator.toString()} / ${denominator.toString()})`; }
function gainDbLiteral(milli: number) {
  const sign = milli < 0 ? "-" : "";
  const magnitude = Math.abs(milli), whole = Math.floor(magnitude / 1_000), fraction = String(magnitude % 1_000).padStart(3, "0");
  return `${sign}${whole}.${fraction}db`;
}

function candidateClips(candidate: CutAudioAuditionRankedCandidate, windowSamples: number, briefSampleRate: number) {
  const asset = candidate.entry.audio, lines: string[] = [];
  const expectedSamples = BigInt(windowSamples) * BigInt(asset.sampleRate) / BigInt(briefSampleRate);
  const plannedSamples = candidate.placement.renderedSourceIntervals.reduce((sum, interval) => sum + BigInt(interval.endSample - interval.startSample), 0n);
  if (plannedSamples !== expectedSamples) fail("CUT_AUDIO_AUDITION_SIGNAL_INTERVAL", candidate.entry.id, "generated source intervals do not match the exact audition time map.");
  let offsetSamples = 0n;
  for (const interval of candidate.placement.renderedSourceIntervals) {
    const clip = `AudioClip(source: candidate, range: ${seconds(interval.startSample, asset.sampleRate)} ..< ${seconds(interval.endSample, asset.sampleRate)});`;
    lines.push(offsetSamples === 0n ? `        ${clip}` : `        at ${seconds(offsetSamples, asset.sampleRate)} { ${clip} }`);
    offsetSamples += BigInt(interval.endSample - interval.startSample);
  }
  return lines.join("\n");
}

export function createCutAudioAuditionSource(options: Readonly<{
  candidate: CutAudioAuditionRankedCandidate;
  dialogueLocator: string;
  startSample: number;
  endSample: number;
  sampleRate: number;
}>) {
  const durationSamples = options.endSample - options.startSample, role = options.candidate.entry.audio.role;
  if (options.candidate.placement.auditionStartSample < 0 || options.candidate.placement.auditionStartSample >= durationSamples) {
    fail("CUT_AUDIO_AUDITION_RANGE", "$.candidate.placement.auditionStartSample", "must remain inside the generated audition timeline.");
  }
  const candidateWindowSamples = durationSamples - options.candidate.placement.auditionStartSample;
  const source = `cut 0.4;

// Non-authoritative listening candidate generated from exact local bytes.
// Rights evidence is bound in the sibling selection receipt; human clearance remains external.
project ${JSON.stringify(`Audio audition · ${options.candidate.entry.id}`)};

import { AudioClip, Bus, Gain, Sidechain } from "@cut/audio";

asset dialogueAsset: AudioAsset = audio(${JSON.stringify(options.dialogueLocator)});
asset candidate: AudioAsset = audio(${JSON.stringify(options.candidate.binding.audioLocator)});

timeline main(duration: ${seconds(durationSamples, options.sampleRate)}, fps: 24, width: 64px, height: 64px, sampleRate: ${options.sampleRate}hz) {
  Bus(name: "dialogue", role: "dialogue") as dialogue {
    AudioClip(source: dialogueAsset, range: ${seconds(options.startSample, options.sampleRate)} ..< ${seconds(options.endSample, options.sampleRate)});
  }
  Bus(name: "candidate", role: ${JSON.stringify(role)}) {
    at ${seconds(options.candidate.placement.auditionStartSample, options.sampleRate)} {
      Sidechain(source: dialogue, amount: -8db, threshold: -30db, attack: 20ms, release: 250ms) {
        Gain(amount: ${gainDbLiteral(options.candidate.leveling.appliedGainDbMilli)}) {
${candidateClips(options.candidate, candidateWindowSamples, options.sampleRate)}
        }
      }
    }
  }
}

export audition = render(main, width: 64px, height: 64px, codec: "h264");
`;
  return Object.freeze({ source, sourceSha256: createHash("sha256").update(source).digest("hex") });
}

export function cutAudioAuditionSelectionSha256(body: Readonly<Record<string, unknown>>) {
  return createHash("sha256").update(stableJsonStringify(body)).digest("hex");
}
