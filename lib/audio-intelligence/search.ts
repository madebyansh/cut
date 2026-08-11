import { createHash } from "node:crypto";
import { stableJsonStringify } from "../core/stable";
import {
  cutAssetCatalogFormat,
  cutAssetCatalogVersion,
  doesCutAudioCatalogMetadataDeclareCommercialSyncUse,
  type CutAssetCatalog,
  type CutAssetCatalogEntry,
  type CutAudioCatalogRole,
} from "../project/asset-catalog";
import type { CutAudioAuditionSemanticEvidence } from "./audition";

const sha256Pattern = /^[a-f0-9]{64}$/u;
const identifierPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const controlPattern = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

export const cutAudioSearchLimits = Object.freeze({
  maximumCatalogBytes: 1024 * 1024,
  maximumBindingsBytes: 256 * 1024,
  maximumSemanticAnalysisBytes: 1024 * 1024,
  maximumRightsEvidenceBytes: 32 * 1024 * 1024,
  maximumSourceBytes: 64 * 1024 * 1024,
  maximumEntries: 1_000,
  maximumAggregateClasses: 20,
  maximumDeclaredTokensPerEntry: 512,
  maximumQueryBytes: 256,
  maximumQueryTokens: 8,
  maximumResults: 100,
  maximumLocatorBytes: 4_096,
  maximumClassLabelBytes: 512,
});

const policyBody = Object.freeze({
  format: "cut-audio-semantic-search-policy" as const,
  version: 1 as const,
  tokenization: "nfkc-lowercase-unicode-letter-or-number-exact-token-v1" as const,
  duplicateQueryTokens: "first-occurrence-only-v1" as const,
  declaredMetadata: Object.freeze({
    fields: Object.freeze([
      "id", "label", "kind", "description", "tags", "provenance.creator", "provenance.license",
      "audio.role", "audio.durationSamples", "audio.sampleRate", "audio.channels", "audio.bpmMilli",
      "audio.key", "audio.energy", "audio.moods", "audio.loopable",
      "rights.basis", "rights.licenseId", "rights.licenseVersion", "rights.reviewStatus",
    ] as const),
    matchedTokenScorePpm: 1_000_000 as const,
  }),
  observedSemantics: Object.freeze({
    source: "authenticated-provider-aggregate-top-classes-only-v1" as const,
    score: "unit-interval-round-half-up-to-ppm-v1" as const,
    providerExecution: "not-reexecuted-v1" as const,
    taxonomyRoles: "not-used-for-role-filter-or-rank-v1" as const,
    taxonomyMoods: "not-used-for-rank-v1" as const,
  }),
  matching: "every-query-token-needs-declared-or-positive-observed-evidence-v1" as const,
  ranking: "mean-best-per-token-ppm-then-declared-count-then-bytewise-id-v1" as const,
  roleFilter: "catalog-declared-audio-role-only-v1" as const,
  rightsFilter: "declared-commercial-sync-metadata-predicate-not-clearance-v1" as const,
});

function hash(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

export const cutAudioSearchPolicy = Object.freeze({
  ...policyBody,
  policySha256: hash(stableJsonStringify(policyBody)),
});

export const cutAudioSearchLimitations = Object.freeze({
  semantics: "editorial-retrieval-evidence-not-ground-truth" as const,
  emotion: "no-emotion-inference-claim" as const,
  provider: "authenticated-materialized-evidence-not-provider-reexecution" as const,
  rights: "declared-metadata-filter-not-rights-clearance" as const,
  selection: "candidate-only-index-snapshot-not-cut-lock" as const,
});

export type CutAudioSearchFileIdentity = Readonly<{
  locator: string;
  bytes: number;
  sha256: string;
}>;

export type CutAudioSearchBindings = Readonly<{
  format: "cut-audio-audition-bindings";
  version: 2;
  entries: readonly Readonly<{
    id: string;
    audioLocator: string;
    rightsEvidenceLocator: string;
    semanticAnalysis: Readonly<{
      locator: string;
      bytes: number;
      fileSha256: string;
      analysisSha256: string;
    }>;
  }>[];
  bindingsSha256: string;
}>;

/**
 * A deliberately narrow input boundary produced by an upstream semantic
 * artifact authenticator. This module cross-binds and projects that evidence;
 * it neither parses raw artifacts nor invokes the provider.
 */
export type CutAudioSearchAuthenticatedSemanticEvidence = CutAudioAuditionSemanticEvidence;

export type CutAudioSearchAuthenticatedCandidate = Readonly<{
  id: string;
  rightsEvidence: CutAudioSearchFileIdentity;
  semantic: CutAudioSearchAuthenticatedSemanticEvidence;
}>;

export type BuildCutAudioSemanticIndexInput = Readonly<{
  catalog: CutAudioSearchFileIdentity & Readonly<{ value: CutAssetCatalog }>;
  bindings: CutAudioSearchFileIdentity & Readonly<{ value: CutAudioSearchBindings }>;
  candidates: readonly CutAudioSearchAuthenticatedCandidate[];
}>;

export type CutAudioSemanticIndexClass = Readonly<{
  classIndex: number;
  label: string;
  scorePpm: number;
}>;

export type CutAudioSemanticIndexEntry = Readonly<{
  id: string;
  catalogEntry: CutAssetCatalogEntry & Readonly<{ kind: "audio"; audio: NonNullable<CutAssetCatalogEntry["audio"]> }>;
  source: CutAudioSearchFileIdentity;
  rightsEvidence: CutAudioSearchFileIdentity;
  semanticAnalysis: Readonly<{
    contract: "authenticated-source-and-embedded-semantic-derivation-recomputed-without-model-reexecution-v1";
    file: CutAudioSearchFileIdentity;
    analysisSha256: string;
    provider: Readonly<{
      id: "cut-yamnet-litert-local-v1";
      analysisSha256: string;
      rawScoreSha256: string;
      authoritiesSha256: string;
    }>;
    taxonomy: Readonly<{
      policySha256: string;
      suggestionsSha256: string;
      interpretation: "editorial-suggestions-not-ground-truth-v1";
      musicMoodScope: "music-only-no-unmapped-mood-inference-v1";
    }>;
  }>;
  declaredTokens: readonly string[];
  aggregateTopClasses: readonly CutAudioSemanticIndexClass[];
  declaredCommercialSync: boolean;
}>;

export type CutAudioSemanticIndex = Readonly<{
  format: "cut-audio-semantic-index";
  version: 1;
  status: "pass";
  catalog: Readonly<{ locator: string; bytes: number; fileSha256: string; catalogSha256: string }>;
  bindings: Readonly<{ locator: string; bytes: number; fileSha256: string; bindingsSha256: string }>;
  entries: readonly CutAudioSemanticIndexEntry[];
  coverage: Readonly<{
    catalogEntries: number;
    catalogAudioEntries: number;
    indexedEntries: number;
    omittedAudioEntryIds: readonly string[];
  }>;
  policy: typeof cutAudioSearchPolicy;
  limitations: typeof cutAudioSearchLimitations;
  indexSha256: string;
}>;

export type CutAudioSearchRightsFilter = "any" | "declared-commercial-sync";

export type CutAudioSemanticSearchResult = Readonly<{
  rank: number;
  id: string;
  label: string;
  role: CutAudioCatalogRole;
  source: CutAudioSearchFileIdentity;
  semanticAnalysis: CutAudioSemanticIndexEntry["semanticAnalysis"];
  rights: Readonly<{
    reviewStatus: "missing" | "pending" | "approved" | "rejected";
    declaredCommercialSync: boolean;
    evidence: CutAudioSearchFileIdentity;
  }>;
  score: Readonly<{
    policy: typeof cutAudioSearchPolicy.ranking;
    totalPpm: number;
    declaredMatchedTokenCount: number;
    evidence: readonly Readonly<{
      token: string;
      source: "declared-catalog-metadata" | "authenticated-audioset-aggregate-class";
      scorePpm: number;
      classIndex?: number;
      label?: string;
    }>[];
  }>;
}>;

export type CutAudioSemanticSearchReport = Readonly<{
  format: "cut-audio-semantic-search";
  version: 1;
  status: "pass";
  index: Readonly<{ locator: string; sha256: string }>;
  query: Readonly<{
    text: string;
    normalized: string;
    tokens: readonly string[];
    role?: CutAudioCatalogRole;
    rights: CutAudioSearchRightsFilter;
    limit: number;
  }>;
  results: readonly CutAudioSemanticSearchResult[];
  selection: Readonly<{
    trust: "candidate-only-authenticated-index-snapshot-not-cut-lock-or-rights-clearance";
    requiredSteps: readonly [
      "listen-to-selected-source-in-context",
      "retain-human-rights-review",
      "run-cut-audio-audition-when-applicable",
      "declare-explicit-project-local-asset",
      "run-cut-lock",
    ];
  }>;
  limitations: typeof cutAudioSearchLimitations;
  searchSha256: string;
}>;

export class CutAudioSearchError extends Error {
  constructor(readonly code: string, readonly path: string, message: string) {
    super(`${code} at ${path}: ${message}`);
    this.name = "CutAudioSearchError";
  }
}

function fail(code: string, path: string, message: string): never {
  throw new CutAudioSearchError(code, path, message);
}

function bytewise(left: string, right: string) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function digest(value: unknown, path: string) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    fail("CUT_AUDIO_SEARCH_SHA256", path, "must be one lowercase SHA-256 digest.");
  }
  return value;
}

function identifier(value: unknown, path: string) {
  if (typeof value !== "string" || !identifierPattern.test(value)) {
    fail("CUT_AUDIO_SEARCH_ID", path, "must be one canonical lowercase stable id.");
  }
  return value;
}

function integer(value: unknown, path: string, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    fail("CUT_AUDIO_SEARCH_LIMIT", path, `must be one safe integer within [${minimum},${maximum}].`);
  }
  return Number(value);
}

function locator(value: unknown, path: string) {
  if (typeof value !== "string" || !value || value !== value.trim()
    || Buffer.byteLength(value, "utf8") > cutAudioSearchLimits.maximumLocatorBytes
    || controlPattern.test(value) || value.startsWith("/") || /^[A-Za-z]:/u.test(value)
    || value.includes("\\") || value.includes("//")
    || value.split("/").some((part) => !part || part === "." || part === "..")) {
    fail("CUT_AUDIO_SEARCH_LOCATOR", path, "must be one bounded canonical project-relative POSIX locator.");
  }
  return value;
}

function fileIdentity(value: CutAudioSearchFileIdentity, path: string, maximumBytes: number) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("CUT_AUDIO_SEARCH_TYPE", path, "must be one authenticated file identity.");
  }
  return Object.freeze({
    locator: locator(value.locator, `${path}.locator`),
    bytes: integer(value.bytes, `${path}.bytes`, 1, maximumBytes),
    sha256: digest(value.sha256, `${path}.sha256`),
  });
}

function canonicalClone<T>(value: T): T {
  return JSON.parse(stableJsonStringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function normalizedTokens(value: string) {
  const normalized = value.normalize("NFKC").toLowerCase();
  const matches = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  const seen = new Set<string>();
  return matches.filter((token) => {
    if (seen.has(token)) return false;
    seen.add(token);
    return true;
  });
}

function declaredEntryTokens(entry: CutAssetCatalogEntry) {
  const audio = entry.audio;
  const values: Array<string | number> = [
    entry.id, entry.label, entry.kind, entry.description, ...entry.tags,
    entry.provenance.creator, entry.provenance.license,
  ];
  if (audio) values.push(
    audio.role,
    audio.durationSamples,
    audio.sampleRate,
    audio.channels,
    ...(audio.bpmMilli === undefined ? [] : [audio.bpmMilli]),
    ...(audio.key === undefined ? [] : [audio.key]),
    ...(audio.energy === undefined ? [] : [audio.energy]),
    ...audio.moods,
    audio.loopable ? "loopable" : "nonlooping",
  );
  if (entry.rights) values.push(
    entry.rights.basis,
    entry.rights.licenseId,
    entry.rights.licenseVersion,
    entry.rights.reviewStatus,
  );
  const tokens = [...new Set(values.flatMap((value) => normalizedTokens(String(value))))].sort(bytewise);
  if (tokens.length > cutAudioSearchLimits.maximumDeclaredTokensPerEntry) {
    fail("CUT_AUDIO_SEARCH_LIMIT", `$.entries[${entry.id}].declaredTokens`, `must contain at most ${cutAudioSearchLimits.maximumDeclaredTokensPerEntry} tokens.`);
  }
  return Object.freeze(tokens);
}

function verifyCatalogHash(catalog: CutAssetCatalog) {
  if (catalog.format !== cutAssetCatalogFormat || catalog.version !== cutAssetCatalogVersion) {
    fail("CUT_AUDIO_SEARCH_CATALOG", "$.catalog.value", "must be one authenticated CUT asset catalog v1.");
  }
  const body = {
    format: cutAssetCatalogFormat,
    version: cutAssetCatalogVersion,
    name: catalog.name,
    ...(catalog.description === undefined ? {} : { description: catalog.description }),
    entries: catalog.entries,
  };
  const expected = hash(stableJsonStringify(body));
  if (digest(catalog.catalogSha256, "$.catalog.value.catalogSha256") !== expected) {
    fail("CUT_AUDIO_SEARCH_CATALOG", "$.catalog.value.catalogSha256", "does not match canonical catalog content.");
  }
}

function verifyBindingsHash(bindings: CutAudioSearchBindings) {
  if (bindings.format !== "cut-audio-audition-bindings" || bindings.version !== 2) {
    fail("CUT_AUDIO_SEARCH_BINDINGS", "$.bindings.value", "must be authenticated audio audition bindings v2.");
  }
  const expected = hash(stableJsonStringify({ format: bindings.format, version: bindings.version, entries: bindings.entries }));
  if (digest(bindings.bindingsSha256, "$.bindings.value.bindingsSha256") !== expected) {
    fail("CUT_AUDIO_SEARCH_BINDINGS", "$.bindings.value.bindingsSha256", "does not match canonical binding content.");
  }
}

function semanticClasses(value: CutAudioSearchAuthenticatedSemanticEvidence, path: string) {
  const entries = value.provider.aggregateTopClasses;
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > cutAudioSearchLimits.maximumAggregateClasses) {
    fail("CUT_AUDIO_SEARCH_SEMANTIC", `${path}.provider.aggregateTopClasses`, `must contain 1..${cutAudioSearchLimits.maximumAggregateClasses} authenticated classes.`);
  }
  const seen = new Set<number>();
  let priorScore = Number.POSITIVE_INFINITY, priorIndex = -1;
  return Object.freeze(entries.map((entry, index) => {
    const itemPath = `${path}.provider.aggregateTopClasses[${index}]`;
    const classIndex = integer(entry.classIndex, `${itemPath}.classIndex`, 0, 520);
    if (seen.has(classIndex)) fail("CUT_AUDIO_SEARCH_DUPLICATE", `${itemPath}.classIndex`, "duplicates an earlier class index.");
    if (typeof entry.label !== "string" || !entry.label || entry.label !== entry.label.trim()
      || entry.label.normalize("NFC") !== entry.label || controlPattern.test(entry.label)
      || Buffer.byteLength(entry.label, "utf8") > cutAudioSearchLimits.maximumClassLabelBytes) {
      fail("CUT_AUDIO_SEARCH_SEMANTIC", `${itemPath}.label`, "must be one bounded normalized control-free label.");
    }
    if (typeof entry.score !== "number" || !Number.isFinite(entry.score) || entry.score < 0 || entry.score > 1) {
      fail("CUT_AUDIO_SEARCH_SEMANTIC", `${itemPath}.score`, "must be one finite unit-interval score.");
    }
    if (entry.score > priorScore || (entry.score === priorScore && classIndex <= priorIndex)) {
      fail("CUT_AUDIO_SEARCH_ORDER", itemPath, "must use descending score then ascending class-index order.");
    }
    seen.add(classIndex); priorScore = entry.score; priorIndex = classIndex;
    return Object.freeze({ classIndex, label: entry.label, scorePpm: Math.floor(entry.score * 1_000_000 + 0.5) });
  }));
}

function authenticatedSemantic(
  value: CutAudioSearchAuthenticatedSemanticEvidence,
  binding: CutAudioSearchBindings["entries"][number],
  entry: CutAssetCatalogEntry,
  path: string,
) {
  if (value.contract !== "authenticated-source-and-embedded-semantic-derivation-recomputed-without-model-reexecution-v1") {
    fail("CUT_AUDIO_SEARCH_SEMANTIC", `${path}.contract`, "must be authenticated without a provider-reexecution claim.");
  }
  const file = fileIdentity(value.file, `${path}.file`, cutAudioSearchLimits.maximumSemanticAnalysisBytes);
  const source = fileIdentity(value.source, `${path}.source`, cutAudioSearchLimits.maximumSourceBytes);
  const declared = binding.semanticAnalysis;
  if (file.locator !== declared.locator || file.bytes !== declared.bytes || file.sha256 !== declared.fileSha256
    || digest(value.analysisSha256, `${path}.analysisSha256`) !== digest(declared.analysisSha256, `${path}.binding.analysisSha256`)) {
    fail("CUT_AUDIO_SEARCH_SEMANTIC", path, "does not match the exact semantic binding identity.");
  }
  if (source.locator !== binding.audioLocator || source.bytes !== entry.bytes || source.sha256 !== entry.sha256) {
    fail("CUT_AUDIO_SEARCH_SOURCE", `${path}.source`, "does not cross-bind the exact catalog audio source.");
  }
  if (value.provider.id !== "cut-yamnet-litert-local-v1") {
    fail("CUT_AUDIO_SEARCH_SEMANTIC", `${path}.provider.id`, "must use the authenticated local YAMNet provider.");
  }
  const authorities = value.provider.authorities;
  for (const key of ["pythonSha256", "adapterSha256", "environmentTreeSha256", "liteRtTreeSha256", "modelSha256", "classMapSha256"] as const) {
    digest(authorities[key], `${path}.provider.authorities.${key}`);
  }
  if (value.taxonomy.interpretation !== "editorial-suggestions-not-ground-truth-v1"
    || value.taxonomy.musicMoodScope !== "music-only-no-unmapped-mood-inference-v1") {
    fail("CUT_AUDIO_SEARCH_SEMANTIC", `${path}.taxonomy`, "must preserve the bounded editorial interpretation.");
  }
  const classes = semanticClasses(value, path);
  return Object.freeze({
    source,
    file,
    analysisSha256: digest(value.analysisSha256, `${path}.analysisSha256`),
    provider: Object.freeze({
      id: "cut-yamnet-litert-local-v1" as const,
      analysisSha256: digest(value.provider.analysisSha256, `${path}.provider.analysisSha256`),
      rawScoreSha256: digest(value.provider.rawScoreSha256, `${path}.provider.rawScoreSha256`),
      authoritiesSha256: hash(stableJsonStringify(authorities)),
    }),
    taxonomy: Object.freeze({
      policySha256: digest(value.taxonomy.policySha256, `${path}.taxonomy.policySha256`),
      suggestionsSha256: digest(value.taxonomy.suggestionsSha256, `${path}.taxonomy.suggestionsSha256`),
      interpretation: "editorial-suggestions-not-ground-truth-v1" as const,
      musicMoodScope: "music-only-no-unmapped-mood-inference-v1" as const,
    }),
    classes,
  });
}

/** Build one canonical snapshot from inputs authenticated by upstream catalog, binding, and semantic parsers. */
export function buildCutAudioSemanticIndex(input: BuildCutAudioSemanticIndexInput): CutAudioSemanticIndex {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("CUT_AUDIO_SEARCH_TYPE", "$", "must be one index request.");
  const catalogFile = fileIdentity(input.catalog, "$.catalog", cutAudioSearchLimits.maximumCatalogBytes);
  const bindingsFile = fileIdentity(input.bindings, "$.bindings", cutAudioSearchLimits.maximumBindingsBytes);
  verifyCatalogHash(input.catalog.value);
  verifyBindingsHash(input.bindings.value);
  const catalog = input.catalog.value, bindings = input.bindings.value;
  if (catalog.entries.length > cutAudioSearchLimits.maximumEntries || bindings.entries.length < 1
    || bindings.entries.length > cutAudioSearchLimits.maximumEntries || input.candidates.length !== bindings.entries.length) {
    fail("CUT_AUDIO_SEARCH_LIMIT", "$.entries", `must contain 1..${cutAudioSearchLimits.maximumEntries} exact indexed bindings and candidates.`);
  }
  const catalogById = new Map<string, CutAssetCatalogEntry>();
  for (const [index, entry] of catalog.entries.entries()) {
    identifier(entry.id, `$.catalog.value.entries[${index}].id`);
    if (catalogById.has(entry.id)) fail("CUT_AUDIO_SEARCH_DUPLICATE", `$.catalog.value.entries[${index}].id`, "duplicates an earlier catalog id.");
    catalogById.set(entry.id, entry);
  }
  const candidatesById = new Map<string, CutAudioSearchAuthenticatedCandidate>();
  for (const [index, candidate] of input.candidates.entries()) {
    const id = identifier(candidate.id, `$.candidates[${index}].id`);
    if (candidatesById.has(id)) fail("CUT_AUDIO_SEARCH_DUPLICATE", `$.candidates[${index}].id`, "duplicates an earlier authenticated candidate.");
    candidatesById.set(id, candidate);
  }
  const seenBindingIds = new Set<string>();
  const entries = bindings.entries.map((binding, index): CutAudioSemanticIndexEntry => {
    const path = `$.bindings.value.entries[${index}]`, id = identifier(binding.id, `${path}.id`);
    if (seenBindingIds.has(id)) fail("CUT_AUDIO_SEARCH_DUPLICATE", `${path}.id`, "duplicates an earlier binding id.");
    seenBindingIds.add(id);
    locator(binding.audioLocator, `${path}.audioLocator`);
    locator(binding.rightsEvidenceLocator, `${path}.rightsEvidenceLocator`);
    const semanticBinding = binding.semanticAnalysis;
    fileIdentity({ locator: semanticBinding.locator, bytes: semanticBinding.bytes, sha256: semanticBinding.fileSha256 }, `${path}.semanticAnalysis`, cutAudioSearchLimits.maximumSemanticAnalysisBytes);
    digest(semanticBinding.analysisSha256, `${path}.semanticAnalysis.analysisSha256`);
    const rawEntry = catalogById.get(id);
    if (!rawEntry || rawEntry.kind !== "audio" || !rawEntry.audio) {
      fail("CUT_AUDIO_SEARCH_CATALOG", path, "must identify one catalog audio entry with declared audio metadata.");
    }
    const candidate = candidatesById.get(id);
    if (!candidate) fail("CUT_AUDIO_SEARCH_BINDINGS", path, "has no authenticated candidate evidence.");
    const rightsEvidence = fileIdentity(candidate.rightsEvidence, `$.candidates[${id}].rightsEvidence`, cutAudioSearchLimits.maximumRightsEvidenceBytes);
    if (rightsEvidence.locator !== binding.rightsEvidenceLocator) {
      fail("CUT_AUDIO_SEARCH_RIGHTS", `$.candidates[${id}].rightsEvidence.locator`, "does not match the binding's rights-evidence locator.");
    }
    if (rawEntry.rights && rightsEvidence.sha256 !== rawEntry.rights.evidenceSha256) {
      fail("CUT_AUDIO_SEARCH_RIGHTS", `$.candidates[${id}].rightsEvidence.sha256`, "does not match the catalog rights-evidence digest.");
    }
    const semantic = authenticatedSemantic(candidate.semantic, binding, rawEntry, `$.candidates[${id}].semantic`);
    const catalogEntry = deepFreeze(canonicalClone(rawEntry)) as CutAudioSemanticIndexEntry["catalogEntry"];
    return deepFreeze({
      id,
      catalogEntry,
      source: semantic.source,
      rightsEvidence,
      semanticAnalysis: {
        contract: "authenticated-source-and-embedded-semantic-derivation-recomputed-without-model-reexecution-v1" as const,
        file: semantic.file,
        analysisSha256: semantic.analysisSha256,
        provider: semantic.provider,
        taxonomy: semantic.taxonomy,
      },
      declaredTokens: declaredEntryTokens(catalogEntry),
      aggregateTopClasses: semantic.classes,
      declaredCommercialSync: doesCutAudioCatalogMetadataDeclareCommercialSyncUse(catalogEntry),
    });
  }).sort((left, right) => bytewise(left.id, right.id));
  if (candidatesById.size !== entries.length) fail("CUT_AUDIO_SEARCH_BINDINGS", "$.candidates", "contains an id not present in the binding set.");
  const audioIds = catalog.entries.filter((entry) => entry.kind === "audio").map((entry) => entry.id).sort(bytewise);
  const omittedAudioEntryIds = audioIds.filter((id) => !seenBindingIds.has(id));
  const body = deepFreeze({
    format: "cut-audio-semantic-index" as const,
    version: 1 as const,
    status: "pass" as const,
    catalog: Object.freeze({ locator: catalogFile.locator, bytes: catalogFile.bytes, fileSha256: catalogFile.sha256, catalogSha256: catalog.catalogSha256 }),
    bindings: Object.freeze({ locator: bindingsFile.locator, bytes: bindingsFile.bytes, fileSha256: bindingsFile.sha256, bindingsSha256: bindings.bindingsSha256 }),
    entries: Object.freeze(entries),
    coverage: Object.freeze({
      catalogEntries: catalog.entries.length,
      catalogAudioEntries: audioIds.length,
      indexedEntries: entries.length,
      omittedAudioEntryIds: Object.freeze(omittedAudioEntryIds),
    }),
    policy: cutAudioSearchPolicy,
    limitations: cutAudioSearchLimitations,
  });
  return deepFreeze({ ...body, indexSha256: hash(stableJsonStringify(body)) });
}

function assertIndex(index: CutAudioSemanticIndex) {
  if (!index || typeof index !== "object" || index.format !== "cut-audio-semantic-index" || index.version !== 1 || index.status !== "pass") {
    fail("CUT_AUDIO_SEARCH_INDEX", "$.index", "must be one canonical semantic audio index v1.");
  }
  const { indexSha256, ...body } = index;
  if (digest(indexSha256, "$.index.indexSha256") !== hash(stableJsonStringify(body))) {
    fail("CUT_AUDIO_SEARCH_INDEX", "$.index.indexSha256", "does not match canonical index content.");
  }
  if (stableJsonStringify(index.policy) !== stableJsonStringify(cutAudioSearchPolicy)
    || stableJsonStringify(index.limitations) !== stableJsonStringify(cutAudioSearchLimitations)) {
    fail("CUT_AUDIO_SEARCH_INDEX", "$.index.policy", "does not bind the current search policy and limitations.");
  }
  if (!Array.isArray(index.entries) || index.entries.length < 1 || index.entries.length > cutAudioSearchLimits.maximumEntries) {
    fail("CUT_AUDIO_SEARCH_LIMIT", "$.index.entries", `must contain 1..${cutAudioSearchLimits.maximumEntries} entries.`);
  }
  let prior = "";
  for (const [entryIndex, entry] of index.entries.entries()) {
    const path = `$.index.entries[${entryIndex}]`, id = identifier(entry.id, `${path}.id`);
    if (entryIndex > 0 && bytewise(prior, id) >= 0) fail("CUT_AUDIO_SEARCH_ORDER", path, "must be strictly bytewise id-sorted.");
    prior = id;
    if (entry.catalogEntry.id !== id || entry.catalogEntry.kind !== "audio" || !entry.catalogEntry.audio) {
      fail("CUT_AUDIO_SEARCH_INDEX", `${path}.catalogEntry`, "must cross-bind one declared audio entry.");
    }
    if (entry.source.bytes !== entry.catalogEntry.bytes || entry.source.sha256 !== entry.catalogEntry.sha256) {
      fail("CUT_AUDIO_SEARCH_SOURCE", `${path}.source`, "must match the catalog byte identity.");
    }
    if (stableJsonStringify(entry.declaredTokens) !== stableJsonStringify(declaredEntryTokens(entry.catalogEntry))) {
      fail("CUT_AUDIO_SEARCH_INDEX", `${path}.declaredTokens`, "does not match the deterministic catalog projection.");
    }
    if (entry.declaredCommercialSync !== doesCutAudioCatalogMetadataDeclareCommercialSyncUse(entry.catalogEntry)) {
      fail("CUT_AUDIO_SEARCH_RIGHTS", `${path}.declaredCommercialSync`, "does not match the declared metadata predicate.");
    }
    if (entry.catalogEntry.rights && entry.rightsEvidence.sha256 !== entry.catalogEntry.rights.evidenceSha256) {
      fail("CUT_AUDIO_SEARCH_RIGHTS", `${path}.rightsEvidence`, "does not match the catalog rights evidence.");
    }
    fileIdentity(entry.source, `${path}.source`, cutAudioSearchLimits.maximumSourceBytes);
    fileIdentity(entry.rightsEvidence, `${path}.rightsEvidence`, cutAudioSearchLimits.maximumRightsEvidenceBytes);
    fileIdentity(entry.semanticAnalysis.file, `${path}.semanticAnalysis.file`, cutAudioSearchLimits.maximumSemanticAnalysisBytes);
    digest(entry.semanticAnalysis.analysisSha256, `${path}.semanticAnalysis.analysisSha256`);
    const classes = entry.aggregateTopClasses;
    if (!Array.isArray(classes) || classes.length < 1 || classes.length > cutAudioSearchLimits.maximumAggregateClasses) {
      fail("CUT_AUDIO_SEARCH_SEMANTIC", `${path}.aggregateTopClasses`, "must contain bounded classes.");
    }
    let priorScore = Number.POSITIVE_INFINITY, priorClass = -1;
    const seen = new Set<number>();
    for (const [classOffset, item] of classes.entries()) {
      const classPath = `${path}.aggregateTopClasses[${classOffset}]`, classIndex = integer(item.classIndex, `${classPath}.classIndex`, 0, 520);
      const scorePpm = integer(item.scorePpm, `${classPath}.scorePpm`, 0, 1_000_000);
      if (seen.has(classIndex) || scorePpm > priorScore || (scorePpm === priorScore && classIndex <= priorClass)) {
        fail("CUT_AUDIO_SEARCH_ORDER", classPath, "must be unique and ordered by descending score then class index.");
      }
      if (typeof item.label !== "string" || !item.label || item.label !== item.label.trim()
        || Buffer.byteLength(item.label, "utf8") > cutAudioSearchLimits.maximumClassLabelBytes || controlPattern.test(item.label)) {
        fail("CUT_AUDIO_SEARCH_SEMANTIC", `${classPath}.label`, "must be one bounded label.");
      }
      seen.add(classIndex); priorScore = scorePpm; priorClass = classIndex;
    }
  }
  return index;
}

function queryTokens(query: unknown) {
  if (typeof query !== "string" || !query.trim() || controlPattern.test(query)
    || Buffer.byteLength(query, "utf8") > cutAudioSearchLimits.maximumQueryBytes) {
    fail("CUT_AUDIO_SEARCH_QUERY", "$.query.text", "must be one bounded non-empty control-free query.");
  }
  const normalized = query.normalize("NFKC").toLowerCase().trim().replace(/\s+/gu, " ");
  const tokens = normalizedTokens(normalized);
  if (!tokens.length || tokens.length > cutAudioSearchLimits.maximumQueryTokens) {
    fail("CUT_AUDIO_SEARCH_QUERY", "$.query.tokens", `must contain 1..${cutAudioSearchLimits.maximumQueryTokens} unique letter-or-number tokens.`);
  }
  return Object.freeze({ text: query.trim(), normalized, tokens: Object.freeze(tokens) });
}

function role(value: unknown) {
  if (value !== undefined && value !== "music" && value !== "sfx" && value !== "ambience" && value !== "dialogue") {
    fail("CUT_AUDIO_SEARCH_QUERY", "$.query.role", "must be music, sfx, ambience, or dialogue.");
  }
  return value as CutAudioCatalogRole | undefined;
}

function rightsFilter(value: unknown): CutAudioSearchRightsFilter {
  const result = value ?? "any";
  if (result !== "any" && result !== "declared-commercial-sync") {
    fail("CUT_AUDIO_SEARCH_QUERY", "$.query.rights", "must be any or declared-commercial-sync.");
  }
  return result;
}

function bestClass(entry: CutAudioSemanticIndexEntry, token: string) {
  return entry.aggregateTopClasses
    .filter((item) => item.scorePpm > 0 && normalizedTokens(item.label).includes(token))
    .sort((left, right) => right.scorePpm - left.scorePpm || left.classIndex - right.classIndex)[0];
}

/** Search one authenticated index without model execution or hidden rights inference. */
export function searchCutAudioSemanticIndex(
  rawIndex: CutAudioSemanticIndex,
  options: Readonly<{
    indexLocator: string;
    query: string;
    role?: CutAudioCatalogRole;
    rights?: CutAudioSearchRightsFilter;
    limit?: number;
  }>,
): CutAudioSemanticSearchReport {
  const index = assertIndex(rawIndex);
  if (!options || typeof options !== "object" || Array.isArray(options)) fail("CUT_AUDIO_SEARCH_TYPE", "$.query", "must be one search request.");
  const indexLocator = locator(options.indexLocator, "$.indexLocator"), query = queryTokens(options.query);
  const selectedRole = role(options.role), selectedRights = rightsFilter(options.rights);
  const limit = integer(options.limit ?? 20, "$.query.limit", 1, cutAudioSearchLimits.maximumResults);
  const candidates = index.entries.flatMap((entry) => {
    if (selectedRole !== undefined && entry.catalogEntry.audio!.role !== selectedRole) return [];
    if (selectedRights === "declared-commercial-sync" && !entry.declaredCommercialSync) return [];
    let declaredMatchedTokenCount = 0;
    const evidence: CutAudioSemanticSearchResult["score"]["evidence"][number][] = [];
    for (const token of query.tokens) {
      if (entry.declaredTokens.includes(token)) {
        declaredMatchedTokenCount += 1;
        evidence.push(Object.freeze({ token, source: "declared-catalog-metadata" as const, scorePpm: 1_000_000 }));
        continue;
      }
      const observed = bestClass(entry, token);
      if (!observed) return [];
      evidence.push(Object.freeze({
        token,
        source: "authenticated-audioset-aggregate-class" as const,
        scorePpm: observed.scorePpm,
        classIndex: observed.classIndex,
        label: observed.label,
      }));
    }
    const totalPpm = Math.round(evidence.reduce((sum, item) => sum + item.scorePpm, 0) / evidence.length);
    return [{ entry, totalPpm, declaredMatchedTokenCount, evidence: Object.freeze(evidence) }];
  }).sort((left, right) => right.totalPpm - left.totalPpm
    || right.declaredMatchedTokenCount - left.declaredMatchedTokenCount
    || bytewise(left.entry.id, right.entry.id))
    .slice(0, limit);
  const results = candidates.map(({ entry, totalPpm, declaredMatchedTokenCount, evidence }, indexOffset): CutAudioSemanticSearchResult => deepFreeze({
    rank: indexOffset + 1,
    id: entry.id,
    label: entry.catalogEntry.label,
    role: entry.catalogEntry.audio!.role,
    source: entry.source,
    semanticAnalysis: entry.semanticAnalysis,
    rights: {
      reviewStatus: entry.catalogEntry.rights?.reviewStatus ?? "missing",
      declaredCommercialSync: entry.declaredCommercialSync,
      evidence: entry.rightsEvidence,
    },
    score: {
      policy: cutAudioSearchPolicy.ranking,
      totalPpm,
      declaredMatchedTokenCount,
      evidence,
    },
  }));
  const body = deepFreeze({
    format: "cut-audio-semantic-search" as const,
    version: 1 as const,
    status: "pass" as const,
    index: Object.freeze({ locator: indexLocator, sha256: index.indexSha256 }),
    query: Object.freeze({
      text: query.text,
      normalized: query.normalized,
      tokens: query.tokens,
      ...(selectedRole === undefined ? {} : { role: selectedRole }),
      rights: selectedRights,
      limit,
    }),
    results: Object.freeze(results),
    selection: Object.freeze({
      trust: "candidate-only-authenticated-index-snapshot-not-cut-lock-or-rights-clearance" as const,
      requiredSteps: Object.freeze([
        "listen-to-selected-source-in-context",
        "retain-human-rights-review",
        "run-cut-audio-audition-when-applicable",
        "declare-explicit-project-local-asset",
        "run-cut-lock",
      ] as const),
    }),
    limitations: cutAudioSearchLimitations,
  });
  return deepFreeze({ ...body, searchSha256: hash(stableJsonStringify(body)) });
}
