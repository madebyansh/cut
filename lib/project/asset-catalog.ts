import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { stableJsonStringify } from "../core/stable";
import { parseStrictPackageJson } from "../package/json";

export const cutAssetCatalogFormat = "cut-asset-catalog" as const;
export const cutAssetCatalogVersion = 1 as const;
export const cutAssetCatalogKinds = Object.freeze([
  "video", "audio", "image", "font", "data", "caption", "transcript", "lut", "sequence",
] as const);
export type CutAssetCatalogKind = (typeof cutAssetCatalogKinds)[number];

export const cutAudioCatalogRoles = Object.freeze(["music", "sfx", "ambience", "dialogue"] as const);
export type CutAudioCatalogRole = (typeof cutAudioCatalogRoles)[number];

export const cutAudioCatalogEnergyLevels = Object.freeze(["low", "medium", "high"] as const);
export type CutAudioCatalogEnergy = (typeof cutAudioCatalogEnergyLevels)[number];

export const cutAudioCatalogRightsBases = Object.freeze([
  "source-asserted", "user-attested", "contract-receipt",
] as const);
export type CutAudioCatalogRightsBasis = (typeof cutAudioCatalogRightsBases)[number];

export const cutAudioCatalogReviewStatuses = Object.freeze(["pending", "approved", "rejected"] as const);
export type CutAudioCatalogReviewStatus = (typeof cutAudioCatalogReviewStatuses)[number];

export const cutAssetCatalogLimits = Object.freeze({
  maximumBytes: 1024 * 1024,
  maximumEntries: 1_000,
  maximumTagsPerEntry: 32,
  maximumQueryBytes: 256,
  maximumQueryTokens: 8,
  maximumResults: 100,
  maximumTextBytes: 4_096,
  maximumTotalStringBytes: 512 * 1024,
  maximumAudioDurationSamples: 2_147_483_647,
  maximumAudioSampleRate: 768_000,
  maximumAudioChannels: 64,
  maximumAudioBpmMilli: 1_000_000,
  maximumAudioKeyBytes: 32,
  maximumAudioMoods: 16,
  maximumAudioMoodBytes: 32,
});

export type CutAudioCatalogMetadata = Readonly<{
  role: CutAudioCatalogRole;
  durationSamples: number;
  sampleRate: number;
  channels: number;
  bpmMilli?: number;
  key?: string;
  energy?: CutAudioCatalogEnergy;
  moods: readonly string[];
  loopable: boolean;
}>;

export type CutAudioCatalogRightsGrant = Readonly<{
  commercialUse: boolean;
  modification: boolean;
  audiovisualSynchronization: boolean;
  standaloneRedistribution: boolean;
  attributionRequired: boolean;
  shareAlike: boolean;
}>;

export type CutAudioCatalogRights = Readonly<{
  basis: CutAudioCatalogRightsBasis;
  licenseId: string;
  licenseVersion: string;
  licenseUrl: string;
  evidenceSha256: string;
  compositionGrant: CutAudioCatalogRightsGrant;
  masterGrant: CutAudioCatalogRightsGrant;
  reviewStatus: CutAudioCatalogReviewStatus;
}>;

export type CutAssetCatalogEntry = Readonly<{
  id: string;
  label: string;
  kind: CutAssetCatalogKind;
  description: string;
  tags: readonly string[];
  downloadUrl: string;
  sha256: string;
  bytes: number;
  provenance: Readonly<{
    creator: string;
    license: string;
    licenseUrl: string;
    sourceUrl: string;
    attribution: string;
  }>;
  audio?: CutAudioCatalogMetadata;
  rights?: CutAudioCatalogRights;
}>;

export type CutAssetCatalog = Readonly<{
  format: typeof cutAssetCatalogFormat;
  version: typeof cutAssetCatalogVersion;
  name: string;
  description?: string;
  entries: readonly CutAssetCatalogEntry[];
  catalogSha256: string;
}>;

export type CutAssetCatalogSearchReport = Readonly<{
  format: "cut-asset-catalog-search";
  version: 1;
  status: "pass";
  catalog: Readonly<{ name: string; sha256: string; entries: number }>;
  query: Readonly<{ text: string; tokens: readonly string[]; kind?: CutAssetCatalogKind; limit: number }>;
  results: readonly CutAssetCatalogEntry[];
  selection: Readonly<{
    trust: "candidate-only-not-runtime-authority";
    requiredSteps: readonly [
      "download-or-copy-selected-bytes-into-project",
      "verify-declared-bytes-and-sha256",
      "run-cut-probe-for-media",
      "declare-explicit-project-local-asset",
      "run-cut-lock",
    ];
  }>;
}>;

export class CutAssetCatalogError extends Error {
  constructor(
    readonly code: string,
    readonly path: string,
    message: string,
  ) {
    super(`${code} at ${path}: ${message}`);
    this.name = "CutAssetCatalogError";
  }
}

function fail(code: string, path: string, message: string): never {
  throw new CutAssetCatalogError(code, path, message);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("CUT_ASSET_CATALOG_TYPE", path, "must be one plain object.");
  }
  return value as Record<string, unknown>;
}

function closed(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
) {
  const result = record(value, path), allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(result)) {
    if (!allowed.has(key)) fail("CUT_ASSET_CATALOG_UNKNOWN_FIELD", `${path}.${key}`, "is not part of the closed catalog contract.");
  }
  for (const key of required) {
    if (!Object.hasOwn(result, key)) fail("CUT_ASSET_CATALOG_TYPE", `${path}.${key}`, "is required.");
  }
  return result;
}

function text(value: unknown, path: string, allowEmpty = false) {
  if (typeof value !== "string"
    || (!allowEmpty && value.trim().length === 0)
    || Buffer.byteLength(value, "utf8") > cutAssetCatalogLimits.maximumTextBytes
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("CUT_ASSET_CATALOG_TEXT", path, `must be one${allowEmpty ? "" : " non-empty"} bounded control-free string.`);
  }
  return value;
}

function httpsUrl(value: unknown, path: string) {
  const raw = text(value, path);
  let parsed: URL;
  try { parsed = new URL(raw); }
  catch { fail("CUT_ASSET_CATALOG_URL", path, "must be one absolute HTTPS URL."); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    fail("CUT_ASSET_CATALOG_URL", path, "must be one credential-free fragment-free HTTPS URL.");
  }
  return parsed.toString();
}

function sha256(value: unknown, path: string) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    fail("CUT_ASSET_CATALOG_SHA256", path, "must be one lowercase SHA-256 digest.");
  }
  return value;
}

function positiveSafeInteger(value: unknown, path: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    fail("CUT_ASSET_CATALOG_NUMBER", path, "must be one positive safe integer.");
  }
  return Number(value);
}

function boundedPositiveSafeInteger(value: unknown, path: string, maximum: number) {
  const result = positiveSafeInteger(value, path);
  if (result > maximum) fail("CUT_ASSET_CATALOG_LIMIT", path, `must be at most ${maximum}.`);
  return result;
}

function booleanValue(value: unknown, path: string) {
  if (typeof value !== "boolean") fail("CUT_ASSET_CATALOG_TYPE", path, "must be one boolean.");
  return value;
}

function oneOf<const Values extends readonly string[]>(value: unknown, path: string, values: Values): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    fail("CUT_ASSET_CATALOG_TYPE", path, `must be one of ${values.join(", ")}.`);
  }
  return value as Values[number];
}

function boundedNormalizedText(value: unknown, path: string, maximumBytes: number) {
  const result = text(value, path).normalize("NFKC").trim();
  if (Buffer.byteLength(result, "utf8") > maximumBytes) {
    fail("CUT_ASSET_CATALOG_LIMIT", path, `must be at most ${maximumBytes} UTF-8 bytes after normalization.`);
  }
  return result;
}

function audioMood(value: unknown, path: string) {
  const result = boundedNormalizedText(value, path, cutAssetCatalogLimits.maximumAudioMoodBytes).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(result)) {
    fail("CUT_ASSET_CATALOG_TEXT", path, "must normalize to one lowercase ASCII token containing only letters, digits, or hyphens.");
  }
  return result;
}

function licenseIdentifier(value: unknown, path: string) {
  const result = boundedNormalizedText(value, path, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9.+-]*$/u.test(result)) {
    fail("CUT_ASSET_CATALOG_TEXT", path, "must be one bounded SPDX-style or LicenseRef identifier token.");
  }
  return result;
}

function stableId(value: unknown, path: string) {
  const result = text(value, path);
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(result)) {
    fail("CUT_ASSET_CATALOG_ID", path, "must match ^[a-z0-9][a-z0-9._-]{0,127}$.");
  }
  return result;
}

function parseAudioMetadata(value: unknown, path: string): CutAudioCatalogMetadata {
  const object = closed(value, path, [
    "role", "durationSamples", "sampleRate", "channels", "moods", "loopable",
  ], ["bpmMilli", "key", "energy"]);
  if (!Array.isArray(object.moods) || object.moods.length > cutAssetCatalogLimits.maximumAudioMoods) {
    fail("CUT_ASSET_CATALOG_LIMIT", `${path}.moods`, `must contain at most ${cutAssetCatalogLimits.maximumAudioMoods} moods.`);
  }
  const moods = object.moods.map((mood, index) => audioMood(mood, `${path}.moods[${index}]`));
  if (new Set(moods).size !== moods.length) {
    fail("CUT_ASSET_CATALOG_DUPLICATE", `${path}.moods`, "must not contain duplicate normalized moods.");
  }
  return Object.freeze({
    role: oneOf(object.role, `${path}.role`, cutAudioCatalogRoles),
    durationSamples: boundedPositiveSafeInteger(
      object.durationSamples,
      `${path}.durationSamples`,
      cutAssetCatalogLimits.maximumAudioDurationSamples,
    ),
    sampleRate: boundedPositiveSafeInteger(
      object.sampleRate,
      `${path}.sampleRate`,
      cutAssetCatalogLimits.maximumAudioSampleRate,
    ),
    channels: boundedPositiveSafeInteger(
      object.channels,
      `${path}.channels`,
      cutAssetCatalogLimits.maximumAudioChannels,
    ),
    ...(object.bpmMilli === undefined ? {} : {
      bpmMilli: boundedPositiveSafeInteger(
        object.bpmMilli,
        `${path}.bpmMilli`,
        cutAssetCatalogLimits.maximumAudioBpmMilli,
      ),
    }),
    ...(object.key === undefined ? {} : {
      key: boundedNormalizedText(object.key, `${path}.key`, cutAssetCatalogLimits.maximumAudioKeyBytes),
    }),
    ...(object.energy === undefined ? {} : {
      energy: oneOf(object.energy, `${path}.energy`, cutAudioCatalogEnergyLevels),
    }),
    moods: Object.freeze(moods),
    loopable: booleanValue(object.loopable, `${path}.loopable`),
  });
}

function parseRightsGrant(value: unknown, path: string): CutAudioCatalogRightsGrant {
  const object = closed(value, path, [
    "commercialUse", "modification", "audiovisualSynchronization", "standaloneRedistribution",
    "attributionRequired", "shareAlike",
  ]);
  return Object.freeze({
    commercialUse: booleanValue(object.commercialUse, `${path}.commercialUse`),
    modification: booleanValue(object.modification, `${path}.modification`),
    audiovisualSynchronization: booleanValue(
      object.audiovisualSynchronization,
      `${path}.audiovisualSynchronization`,
    ),
    standaloneRedistribution: booleanValue(object.standaloneRedistribution, `${path}.standaloneRedistribution`),
    attributionRequired: booleanValue(object.attributionRequired, `${path}.attributionRequired`),
    shareAlike: booleanValue(object.shareAlike, `${path}.shareAlike`),
  });
}

function parseAudioRights(value: unknown, path: string): CutAudioCatalogRights {
  const object = closed(value, path, [
    "basis", "licenseId", "licenseVersion", "licenseUrl", "evidenceSha256",
    "compositionGrant", "masterGrant", "reviewStatus",
  ]);
  return Object.freeze({
    basis: oneOf(object.basis, `${path}.basis`, cutAudioCatalogRightsBases),
    licenseId: licenseIdentifier(object.licenseId, `${path}.licenseId`),
    licenseVersion: boundedNormalizedText(object.licenseVersion, `${path}.licenseVersion`, 64),
    licenseUrl: httpsUrl(object.licenseUrl, `${path}.licenseUrl`),
    evidenceSha256: sha256(object.evidenceSha256, `${path}.evidenceSha256`),
    compositionGrant: parseRightsGrant(object.compositionGrant, `${path}.compositionGrant`),
    masterGrant: parseRightsGrant(object.masterGrant, `${path}.masterGrant`),
    reviewStatus: oneOf(object.reviewStatus, `${path}.reviewStatus`, cutAudioCatalogReviewStatuses),
  });
}

function parseEntry(value: unknown, index: number): CutAssetCatalogEntry {
  const path = `$.entries[${index}]`;
  const object = closed(value, path, [
    "id", "label", "kind", "description", "tags", "downloadUrl", "sha256", "bytes", "provenance",
  ], ["audio", "rights"]);
  if (typeof object.kind !== "string" || !cutAssetCatalogKinds.includes(object.kind as CutAssetCatalogKind)) {
    fail("CUT_ASSET_CATALOG_KIND", `${path}.kind`, `must be one of ${cutAssetCatalogKinds.join(", ")}.`);
  }
  if (object.kind !== "audio" && (object.audio !== undefined || object.rights !== undefined)) {
    fail("CUT_ASSET_CATALOG_KIND", path, "audio and rights metadata are only valid for kind=audio entries.");
  }
  if (!Array.isArray(object.tags) || object.tags.length > cutAssetCatalogLimits.maximumTagsPerEntry) {
    fail("CUT_ASSET_CATALOG_LIMIT", `${path}.tags`, `must contain at most ${cutAssetCatalogLimits.maximumTagsPerEntry} tags.`);
  }
  const tags = object.tags.map((tag, tagIndex) => text(tag, `${path}.tags[${tagIndex}]`).normalize("NFKC"));
  if (new Set(tags).size !== tags.length) fail("CUT_ASSET_CATALOG_DUPLICATE", `${path}.tags`, "must not contain duplicate tags.");
  const provenance = closed(object.provenance, `${path}.provenance`, [
    "creator", "license", "licenseUrl", "sourceUrl", "attribution",
  ]);
  return Object.freeze({
    id: stableId(object.id, `${path}.id`),
    label: text(object.label, `${path}.label`),
    kind: object.kind as CutAssetCatalogKind,
    description: text(object.description, `${path}.description`, true),
    tags: Object.freeze(tags),
    downloadUrl: httpsUrl(object.downloadUrl, `${path}.downloadUrl`),
    sha256: sha256(object.sha256, `${path}.sha256`),
    bytes: positiveSafeInteger(object.bytes, `${path}.bytes`),
    provenance: Object.freeze({
      creator: text(provenance.creator, `${path}.provenance.creator`),
      license: text(provenance.license, `${path}.provenance.license`),
      licenseUrl: httpsUrl(provenance.licenseUrl, `${path}.provenance.licenseUrl`),
      sourceUrl: httpsUrl(provenance.sourceUrl, `${path}.provenance.sourceUrl`),
      attribution: text(provenance.attribution, `${path}.provenance.attribution`),
    }),
    ...(object.audio === undefined ? {} : { audio: parseAudioMetadata(object.audio, `${path}.audio`) }),
    ...(object.rights === undefined ? {} : { rights: parseAudioRights(object.rights, `${path}.rights`) }),
  });
}

function grantsCommercialAudiovisualUse(grant: CutAudioCatalogRightsGrant) {
  return grant.commercialUse
    && grant.modification
    && grant.audiovisualSynchronization
    && !grant.shareAlike;
}

/**
 * Matches catalog metadata against CUT's narrow commercial-sync policy. This
 * does not authenticate the referenced evidence bytes and is never legal
 * clearance; callers must verify those bytes and retain human rights review.
 */
export function doesCutAudioCatalogMetadataDeclareCommercialSyncUse(entry: CutAssetCatalogEntry) {
  if (entry.kind !== "audio" || !entry.rights || entry.rights.reviewStatus !== "approved") return false;
  const rights = entry.rights;
  const cc0 = rights.licenseId === "CC0-1.0" && rights.licenseVersion === "1.0";
  const ccBy = rights.licenseId === "CC-BY-4.0" && rights.licenseVersion === "4.0";
  const forbiddenPublicLicense = /^CC-(?:[A-Z0-9.]+-)*(?:NC|ND|SA)(?:-|$)/iu.test(rights.licenseId);
  const unknownLicense = /(?:^|[-.])(?:unknown|noassertion|none)(?:[-.]|$)/iu.test(rights.licenseId);
  if (forbiddenPublicLicense || unknownLicense) return false;
  if (!cc0 && !ccBy && rights.basis !== "contract-receipt") return false;
  return grantsCommercialAudiovisualUse(rights.compositionGrant)
    && grantsCommercialAudiovisualUse(rights.masterGrant);
}

export function parseCutAssetCatalog(input: string | Uint8Array): CutAssetCatalog {
  let decoded: unknown;
  try {
    decoded = parseStrictPackageJson(input, {
      limits: {
        maxInputBytes: cutAssetCatalogLimits.maximumBytes,
        maxDepth: 8,
        maxNodes: 100_000,
        maxStringBytes: cutAssetCatalogLimits.maximumTextBytes,
        maxTotalStringBytes: cutAssetCatalogLimits.maximumTotalStringBytes,
      },
    });
  } catch (error) {
    fail("CUT_ASSET_CATALOG_JSON", "$", error instanceof Error ? error.message : "invalid strict JSON.");
  }
  const object = closed(decoded, "$", ["format", "version", "name", "entries"], ["description"]);
  if (object.format !== cutAssetCatalogFormat || object.version !== cutAssetCatalogVersion) {
    fail("CUT_ASSET_CATALOG_VERSION", "$", `must be ${cutAssetCatalogFormat} v${cutAssetCatalogVersion}.`);
  }
  if (!Array.isArray(object.entries) || object.entries.length > cutAssetCatalogLimits.maximumEntries) {
    fail("CUT_ASSET_CATALOG_LIMIT", "$.entries", `must contain at most ${cutAssetCatalogLimits.maximumEntries} entries.`);
  }
  const entries = object.entries.map(parseEntry), ids = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    if (ids.has(entry.id)) fail("CUT_ASSET_CATALOG_DUPLICATE", `$.entries[${index}].id`, `duplicates ${JSON.stringify(entry.id)}.`);
    ids.add(entry.id);
  }
  const body = {
    format: cutAssetCatalogFormat,
    version: cutAssetCatalogVersion,
    name: text(object.name, "$.name"),
    ...(object.description === undefined ? {} : { description: text(object.description, "$.description", true) }),
    entries: Object.freeze(entries),
  };
  return Object.freeze({
    ...body,
    catalogSha256: createHash("sha256").update(stableJsonStringify(body)).digest("hex"),
  });
}

export async function loadCutAssetCatalogFile(path: string) {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > cutAssetCatalogLimits.maximumBytes) {
      fail("CUT_ASSET_CATALOG_FILE", path, `must be one 1..${cutAssetCatalogLimits.maximumBytes}-byte regular file.`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      fail("CUT_ASSET_CATALOG_FILE", path, "changed during its bounded read.");
    }
    return parseCutAssetCatalog(bytes);
  } catch (error) {
    if (error instanceof CutAssetCatalogError) throw error;
    fail("CUT_ASSET_CATALOG_FILE", path, error instanceof Error ? error.message : "could not be opened safely.");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function normalizedSearchText(value: string) {
  return value.normalize("NFKC").toLowerCase();
}

function compareStableIds(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function searchCutAssetCatalog(
  catalog: CutAssetCatalog,
  options: Readonly<{ query: string; kind?: CutAssetCatalogKind; limit?: number }>,
): CutAssetCatalogSearchReport {
  if (!options || typeof options !== "object" || Array.isArray(options)) fail("CUT_ASSET_CATALOG_QUERY", "$.query", "must be one query object.");
  const query = text(options.query, "$.query.text").trim();
  if (Buffer.byteLength(query, "utf8") > cutAssetCatalogLimits.maximumQueryBytes) {
    fail("CUT_ASSET_CATALOG_LIMIT", "$.query.text", `exceeds ${cutAssetCatalogLimits.maximumQueryBytes} UTF-8 bytes.`);
  }
  const tokens = normalizedSearchText(query).split(/\s+/u).filter(Boolean);
  if (tokens.length > cutAssetCatalogLimits.maximumQueryTokens) {
    fail("CUT_ASSET_CATALOG_LIMIT", "$.query.text", `must contain at most ${cutAssetCatalogLimits.maximumQueryTokens} tokens.`);
  }
  if (options.kind !== undefined && !cutAssetCatalogKinds.includes(options.kind)) {
    fail("CUT_ASSET_CATALOG_KIND", "$.query.kind", `must be one of ${cutAssetCatalogKinds.join(", ")}.`);
  }
  const limit = options.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > cutAssetCatalogLimits.maximumResults) {
    fail("CUT_ASSET_CATALOG_LIMIT", "$.query.limit", `must be 1..${cutAssetCatalogLimits.maximumResults}.`);
  }
  const results = catalog.entries
    .filter((entry) => options.kind === undefined || entry.kind === options.kind)
    .map((entry) => {
      const haystack = normalizedSearchText([
        entry.id, entry.label, entry.kind, entry.description, ...entry.tags,
        entry.provenance.creator, entry.provenance.license,
        ...(entry.audio ? [
          entry.audio.role,
          String(entry.audio.durationSamples),
          String(entry.audio.sampleRate),
          String(entry.audio.channels),
          ...(entry.audio.bpmMilli === undefined ? [] : [String(entry.audio.bpmMilli)]),
          ...(entry.audio.key === undefined ? [] : [entry.audio.key]),
          ...(entry.audio.energy === undefined ? [] : [entry.audio.energy]),
          ...entry.audio.moods,
          entry.audio.loopable ? "loopable" : "nonlooping",
        ] : []),
        ...(entry.rights ? [
          entry.rights.basis,
          entry.rights.licenseId,
          entry.rights.licenseVersion,
          entry.rights.reviewStatus,
        ] : []),
      ].join(" "));
      return { entry, haystack };
    })
    .filter(({ haystack }) => tokens.every((token) => haystack.includes(token)))
    .sort((left, right) => {
      const leftId = normalizedSearchText(left.entry.id), rightId = normalizedSearchText(right.entry.id);
      const leftLabel = normalizedSearchText(left.entry.label), rightLabel = normalizedSearchText(right.entry.label);
      const leftRank = leftId === normalizedSearchText(query) ? 0 : leftLabel.startsWith(normalizedSearchText(query)) ? 1 : 2;
      const rightRank = rightId === normalizedSearchText(query) ? 0 : rightLabel.startsWith(normalizedSearchText(query)) ? 1 : 2;
      return leftRank - rightRank || compareStableIds(left.entry.id, right.entry.id);
    })
    .slice(0, limit)
    .map(({ entry }) => entry);
  return Object.freeze({
    format: "cut-asset-catalog-search",
    version: 1,
    status: "pass",
    catalog: Object.freeze({ name: catalog.name, sha256: catalog.catalogSha256, entries: catalog.entries.length }),
    query: Object.freeze({ text: query, tokens: Object.freeze(tokens), ...(options.kind ? { kind: options.kind } : {}), limit }),
    results: Object.freeze(results),
    selection: Object.freeze({
      trust: "candidate-only-not-runtime-authority",
      requiredSteps: Object.freeze([
        "download-or-copy-selected-bytes-into-project",
        "verify-declared-bytes-and-sha256",
        "run-cut-probe-for-media",
        "declare-explicit-project-local-asset",
        "run-cut-lock",
      ] as const),
    }),
  });
}
