import { createHash } from "node:crypto";
import { stableJsonStringify } from "../core/stable";
import { parseStrictPackageJson } from "../package/json";
import {
  parseCutAudioBrief,
  type CutAudioBrief,
  type CutAudioBriefAct,
} from "./brief";

export const cutAudioArrangementInputFormat = "cut-audio-arrangement-input" as const;
export const cutAudioArrangementInputVersion = 1 as const;
export const cutAudioArrangementProfile = "documentary-podcast-arrangement-v1" as const;

export const cutAudioArrangementLimits = Object.freeze({
  maximumInputBytes: 1024 * 1024,
  maximumStringBytes: 8 * 1024,
  maximumTotalStringBytes: 512 * 1024,
  maximumAssets: 512,
  maximumProsodySuggestions: 4_096,
  maximumPlacements: 32_768,
  maximumSourceBytes: 4 * 1024 * 1024,
  maximumLocatorBytes: 1_024,
  maximumAcceptedSourceDurationSeconds: 24 * 60 * 60,
});

export const cutAudioArrangementPolicy = Object.freeze({
  musicBaseGainDbMilli: -24_000,
  ambienceBaseGainDbMilli: -30_000,
  sfxBaseGainDbMilli: -18_000,
  actEnergyGainSpanDbMilli: 12_000,
  dialogueSpaceBedReductionSpanDbMilli: 6_000,
  sfxStrengthGainSpanDbMilli: 12_000,
  maximumActFadeMilliseconds: 250,
  maximumSfxFadeOutMilliseconds: 50,
  supportingSilenceRoles: Object.freeze(["music", "ambience", "sfx"] as const),
});

export type CutAudioArrangementRole = "dialogue" | "music" | "ambience" | "sfx";
export type CutAudioPerspectiveDistance = "near" | "mid" | "far";

export type CutAudioArrangementRange = Readonly<{ startSample: number; endSample: number }>;

export type CutAudioArrangementPerspective = Readonly<{
  distance: CutAudioPerspectiveDistance;
  gainDbMilli: number;
  panPpm: number;
  eqFrequencyHz: number;
  eqGainDbMilli: number;
  eqQMilli: number;
  reverbWetPpm: number;
}>;

export type CutAudioArrangementAssignment =
  | Readonly<{ kind: "program-dialogue" }>
  | Readonly<{ kind: "act"; actId: string }>
  | Readonly<{ kind: "event"; eventIndex: number }>;

export type CutAudioArrangementAsset = Readonly<{
  id: string;
  role: CutAudioArrangementRole;
  locator: string;
  lockedResourceSha256: string;
  sampleRate: number;
  sourceRange: CutAudioArrangementRange;
  assignment: CutAudioArrangementAssignment;
  perspective: CutAudioArrangementPerspective;
}>;

export type CutAudioArrangementProsody = Readonly<Record<string, unknown> & {
  format: "cut-dialogue-prosody-analysis";
  version: 1;
  analysisSha256: string;
  authority: Readonly<Record<string, unknown> & {
    mediaSha256: string;
    sampleRate: number;
    durationSamples: number;
  }>;
  range: CutAudioArrangementRange;
  dialogueSpaceSuggestions: readonly CutAudioArrangementProsodySuggestion[];
}>;

export type CutAudioArrangementProsodySuggestion = Readonly<{
  id: string;
  kind: "protect-dialogue";
  basisPhraseId: string;
  startSample: number;
  endSample: number;
  basis: "transcript-timing-plus-authored-protection-policy";
  policyBedGainDeltaDbMilli: number;
  sfxGuidance: "avoid-sustained-dialogue-overlap-policy";
}> | Readonly<{
  id: string;
  kind: "pause-accent-window";
  basisPauseId: string;
  pauseClass: "medium" | "long";
  startSample: number;
  endSample: number;
  maximumEventDurationSamples: number;
}>;

export type CutAudioArrangementInputBody = Readonly<{
  format: typeof cutAudioArrangementInputFormat;
  version: typeof cutAudioArrangementInputVersion;
  profile: typeof cutAudioArrangementProfile;
  brief: CutAudioBrief;
  prosody: CutAudioArrangementProsody | null;
  assets: readonly CutAudioArrangementAsset[];
}>;

export type CutAudioArrangementInput = CutAudioArrangementInputBody & Readonly<{ inputSha256: string }>;

export type CutAudioArrangementPlacement = Readonly<{
  id: string;
  assetId: string;
  role: CutAudioArrangementRole;
  destinationRange: CutAudioArrangementRange;
  sourceRange: CutAudioArrangementRange;
  gainDbMilli: number;
  fadeInSamples: number;
  fadeOutSamples: number;
  actId: string | null;
  eventIndex: number | null;
  eventSample: number | null;
  dialogueProtectionSuggestionIds: readonly string[];
  pauseAccentSuggestionId: string | null;
}>;

export type CutAudioArrangementManifestBody = Readonly<{
  format: "cut-audio-arrangement-manifest";
  version: 1;
  profile: typeof cutAudioArrangementProfile;
  authority: Readonly<{
    inputSha256: string;
    briefSha256: string;
    sourceScriptSha256: string;
    prosodyAnalysisSha256: string | null;
    sourceSha256: string;
    resourceIdentitySemantics: "caller-accepted-locked-resource-digests-not-reopened-by-pure-planner";
  }>;
  clock: Readonly<{ sampleRate: number; durationSamples: number }>;
  policy: typeof cutAudioArrangementPolicy;
  assets: readonly CutAudioArrangementAsset[];
  placements: readonly CutAudioArrangementPlacement[];
  intentionalSilences: readonly Readonly<{
    range: CutAudioArrangementRange;
    purpose: string;
    semantics: "exact-supporting-sound-gap-dialogue-preserved";
  }>[];
  work: Readonly<{
    assetsVisited: number;
    actsVisited: number;
    eventsVisited: number;
    prosodySuggestionsVisited: number;
    placementsEmitted: number;
  }>;
  limitations: readonly string[];
}>;

export type CutAudioArrangementManifest = CutAudioArrangementManifestBody & Readonly<{ manifestSha256: string }>;

export type CutAudioArrangement = Readonly<{
  format: "cut-audio-arrangement";
  version: 1;
  source: string;
  sourceSha256: string;
  manifest: CutAudioArrangementManifest;
  arrangementSha256: string;
}>;

export type CutAudioArrangementErrorCode =
  | "CUT_AUDIO_ARRANGEMENT_ASSIGNMENT"
  | "CUT_AUDIO_ARRANGEMENT_AUTHORITY"
  | "CUT_AUDIO_ARRANGEMENT_CLOCK"
  | "CUT_AUDIO_ARRANGEMENT_COVERAGE"
  | "CUT_AUDIO_ARRANGEMENT_DUPLICATE"
  | "CUT_AUDIO_ARRANGEMENT_FORMAT"
  | "CUT_AUDIO_ARRANGEMENT_IDENTITY"
  | "CUT_AUDIO_ARRANGEMENT_LIMIT"
  | "CUT_AUDIO_ARRANGEMENT_PATH"
  | "CUT_AUDIO_ARRANGEMENT_PERSPECTIVE"
  | "CUT_AUDIO_ARRANGEMENT_PROSODY"
  | "CUT_AUDIO_ARRANGEMENT_ROLE"
  | "CUT_AUDIO_ARRANGEMENT_SILENCE";

export class CutAudioArrangementError extends Error {
  constructor(readonly code: CutAudioArrangementErrorCode, readonly path: string, detail: string) {
    super(`${code} at ${path}: ${detail}`);
    this.name = "CutAudioArrangementError";
  }
}

type DataRecord = Record<string, unknown>;
type PlannedAsset = Readonly<{ asset: CutAudioArrangementAsset; symbol: string; placements: readonly CutAudioArrangementPlacement[] }>;

const digestPattern = /^[0-9a-f]{64}$/u;
const stableIdPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const portableLocatorPartPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function fail(code: CutAudioArrangementErrorCode, path: string, detail: string): never {
  throw new CutAudioArrangementError(code, path, detail);
}

function canonicalHash(value: unknown) {
  return createHash("sha256").update(stableJsonStringify(value), "utf8").digest("hex");
}

function record(value: unknown, path: string): DataRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("CUT_AUDIO_ARRANGEMENT_FORMAT", path, "must be one ordinary object.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("CUT_AUDIO_ARRANGEMENT_FORMAT", path, "must be one ordinary object.");
  }
  return value as DataRecord;
}

function closed(value: unknown, path: string, required: readonly string[], optional: readonly string[] = []) {
  const item = record(value, path);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(item)) {
    if (!allowed.has(key)) fail("CUT_AUDIO_ARRANGEMENT_FORMAT", `${path}.${key}`, "is not part of this closed contract.");
  }
  for (const key of required) {
    if (!Object.hasOwn(item, key)) fail("CUT_AUDIO_ARRANGEMENT_FORMAT", `${path}.${key}`, "is required.");
  }
  return item;
}

function integer(value: unknown, path: string, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    fail("CUT_AUDIO_ARRANGEMENT_FORMAT", path, `must be one safe integer from ${minimum} through ${maximum}.`);
  }
  return Number(value);
}

function text(value: unknown, path: string, maximumBytes = cutAudioArrangementLimits.maximumStringBytes) {
  if (typeof value !== "string" || !value || value !== value.trim() || value.normalize("NFC") !== value
    || Buffer.byteLength(value, "utf8") > maximumBytes || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) {
    fail("CUT_AUDIO_ARRANGEMENT_FORMAT", path, "must be non-empty, trimmed, NFC, bounded, and control-free text.");
  }
  return value;
}

function digest(value: unknown, path: string) {
  if (typeof value !== "string" || !digestPattern.test(value)) {
    fail("CUT_AUDIO_ARRANGEMENT_AUTHORITY", path, "must be one lowercase SHA-256 digest.");
  }
  return value;
}

function stableId(value: unknown, path: string) {
  const result = text(value, path, 128);
  if (!stableIdPattern.test(result)) {
    fail("CUT_AUDIO_ARRANGEMENT_FORMAT", path, "must match ^[a-z0-9][a-z0-9._-]{0,127}$.");
  }
  return result;
}

function oneOf<const Values extends readonly string[]>(value: unknown, path: string, values: Values): Values[number] {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    fail("CUT_AUDIO_ARRANGEMENT_FORMAT", path, `must be one of ${values.join(", ")}.`);
  }
  return value as Values[number];
}

function range(value: unknown, path: string, maximum: number): CutAudioArrangementRange {
  const item = closed(value, path, ["startSample", "endSample"]);
  const startSample = integer(item.startSample, `${path}.startSample`, 0, maximum - 1);
  const endSample = integer(item.endSample, `${path}.endSample`, 1, maximum);
  if (startSample >= endSample) fail("CUT_AUDIO_ARRANGEMENT_FORMAT", path, "must be one non-empty half-open sample range.");
  return Object.freeze({ startSample, endSample });
}

function locator(value: unknown, path: string) {
  const result = text(value, path, cutAudioArrangementLimits.maximumLocatorBytes);
  if (result.startsWith("/") || result.startsWith("\\") || /^[A-Za-z]:/u.test(result) || result.includes("\\")) {
    fail("CUT_AUDIO_ARRANGEMENT_PATH", path, "must be one project-relative POSIX locator.");
  }
  const parts = result.split("/");
  if (parts.some((part) => part === "." || part === ".." || !portableLocatorPartPattern.test(part))) {
    fail("CUT_AUDIO_ARRANGEMENT_PATH", path, "must contain only portable non-traversing path components.");
  }
  return result;
}

function parsePerspective(value: unknown, path: string, sampleRate: number): CutAudioArrangementPerspective {
  const item = closed(value, path, [
    "distance", "gainDbMilli", "panPpm", "eqFrequencyHz", "eqGainDbMilli", "eqQMilli", "reverbWetPpm",
  ]);
  const eqFrequencyHz = integer(item.eqFrequencyHz, `${path}.eqFrequencyHz`, 1, 192_000);
  if (eqFrequencyHz * 2 >= sampleRate) {
    fail("CUT_AUDIO_ARRANGEMENT_PERSPECTIVE", `${path}.eqFrequencyHz`, "must stay strictly below the arrangement Nyquist frequency.");
  }
  return Object.freeze({
    distance: oneOf(item.distance, `${path}.distance`, ["near", "mid", "far"] as const),
    gainDbMilli: integer(item.gainDbMilli, `${path}.gainDbMilli`, -60_000, 24_000),
    panPpm: integer(item.panPpm, `${path}.panPpm`, -1_000_000, 1_000_000),
    eqFrequencyHz,
    eqGainDbMilli: integer(item.eqGainDbMilli, `${path}.eqGainDbMilli`, -60_000, 24_000),
    eqQMilli: integer(item.eqQMilli, `${path}.eqQMilli`, 1, 1_000_000),
    reverbWetPpm: integer(item.reverbWetPpm, `${path}.reverbWetPpm`, 0, 1_000_000),
  });
}

function parseAssignment(value: unknown, path: string, role: CutAudioArrangementRole): CutAudioArrangementAssignment {
  const base = record(value, path);
  const kind = oneOf(base.kind, `${path}.kind`, ["program-dialogue", "act", "event"] as const);
  if (kind === "program-dialogue") {
    closed(value, path, ["kind"]);
    if (role !== "dialogue") fail("CUT_AUDIO_ARRANGEMENT_ASSIGNMENT", path, "program-dialogue belongs only to a dialogue asset.");
    return Object.freeze({ kind });
  }
  if (kind === "act") {
    const item = closed(value, path, ["kind", "actId"]);
    if (role !== "music" && role !== "ambience") {
      fail("CUT_AUDIO_ARRANGEMENT_ASSIGNMENT", path, "act assignment belongs only to music or ambience.");
    }
    return Object.freeze({ kind, actId: stableId(item.actId, `${path}.actId`) });
  }
  const item = closed(value, path, ["kind", "eventIndex"]);
  if (role !== "sfx") fail("CUT_AUDIO_ARRANGEMENT_ASSIGNMENT", path, "event assignment belongs only to SFX.");
  return Object.freeze({ kind, eventIndex: integer(item.eventIndex, `${path}.eventIndex`, 0, 8_191) });
}

function parseAssets(value: unknown, brief: CutAudioBrief) {
  if (!Array.isArray(value) || value.length < 1 || value.length > cutAudioArrangementLimits.maximumAssets) {
    fail("CUT_AUDIO_ARRANGEMENT_LIMIT", "$.assets", `must contain 1..${cutAudioArrangementLimits.maximumAssets} accepted assets.`);
  }
  const ids = new Set<string>();
  const symbols = new Set<string>();
  return Object.freeze(value.map((entry, index): CutAudioArrangementAsset => {
    const path = `$.assets[${index}]`;
    const item = closed(entry, path, [
      "id", "role", "locator", "lockedResourceSha256", "sampleRate", "sourceRange", "assignment", "perspective",
    ]);
    const id = stableId(item.id, `${path}.id`);
    if (ids.has(id)) fail("CUT_AUDIO_ARRANGEMENT_DUPLICATE", `${path}.id`, "duplicates an earlier asset id.");
    ids.add(id);
    const symbol = assetSymbol(id);
    if (symbols.has(symbol)) fail("CUT_AUDIO_ARRANGEMENT_DUPLICATE", `${path}.id`, "collides with another generated CUT asset symbol.");
    symbols.add(symbol);
    const role = oneOf(item.role, `${path}.role`, ["dialogue", "music", "ambience", "sfx"] as const);
    const sampleRate = integer(item.sampleRate, `${path}.sampleRate`, 8_000, 384_000);
    if (sampleRate !== brief.sampleRate) {
      fail("CUT_AUDIO_ARRANGEMENT_CLOCK", `${path}.sampleRate`, "must already be normalized to the exact brief sample rate.");
    }
    return Object.freeze({
      id,
      role,
      locator: locator(item.locator, `${path}.locator`),
      lockedResourceSha256: digest(item.lockedResourceSha256, `${path}.lockedResourceSha256`),
      sampleRate,
      sourceRange: range(
        item.sourceRange,
        `${path}.sourceRange`,
        sampleRate * cutAudioArrangementLimits.maximumAcceptedSourceDurationSeconds,
      ),
      assignment: parseAssignment(item.assignment, `${path}.assignment`, role),
      perspective: parsePerspective(item.perspective, `${path}.perspective`, sampleRate),
    });
  }));
}

function shallowBoundedObject(value: unknown, path: string) {
  const result = record(value, path);
  if (Object.keys(result).length > 64) fail("CUT_AUDIO_ARRANGEMENT_LIMIT", path, "contains too many fields.");
  return result;
}

function parseProsodySuggestion(value: unknown, path: string, durationSamples: number): CutAudioArrangementProsodySuggestion {
  const base = record(value, path);
  const kind = oneOf(base.kind, `${path}.kind`, ["protect-dialogue", "pause-accent-window"] as const);
  if (kind === "protect-dialogue") {
    const item = closed(value, path, [
      "id", "kind", "basisPhraseId", "startSample", "endSample", "basis",
      "policyBedGainDeltaDbMilli", "sfxGuidance",
    ]);
    const parsedRange = range({ startSample: item.startSample, endSample: item.endSample }, path, durationSamples);
    if (item.basis !== "transcript-timing-plus-authored-protection-policy"
      || item.sfxGuidance !== "avoid-sustained-dialogue-overlap-policy") {
      fail("CUT_AUDIO_ARRANGEMENT_PROSODY", path, "contains an unsupported dialogue-protection interpretation.");
    }
    return Object.freeze({
      id: stableId(item.id, `${path}.id`),
      kind,
      basisPhraseId: stableId(item.basisPhraseId, `${path}.basisPhraseId`),
      ...parsedRange,
      basis: item.basis,
      policyBedGainDeltaDbMilli: integer(item.policyBedGainDeltaDbMilli, `${path}.policyBedGainDeltaDbMilli`, -60_000, 0),
      sfxGuidance: item.sfxGuidance,
    });
  }
  const item = closed(value, path, [
    "id", "kind", "basisPauseId", "pauseClass", "startSample", "endSample", "maximumEventDurationSamples",
  ]);
  const parsedRange = range({ startSample: item.startSample, endSample: item.endSample }, path, durationSamples);
  const maximumEventDurationSamples = integer(
    item.maximumEventDurationSamples,
    `${path}.maximumEventDurationSamples`,
    1,
    parsedRange.endSample - parsedRange.startSample,
  );
  return Object.freeze({
    id: stableId(item.id, `${path}.id`),
    kind,
    basisPauseId: stableId(item.basisPauseId, `${path}.basisPauseId`),
    pauseClass: oneOf(item.pauseClass, `${path}.pauseClass`, ["medium", "long"] as const),
    ...parsedRange,
    maximumEventDurationSamples,
  });
}

function parseProsody(value: unknown, brief: CutAudioBrief): CutAudioArrangementProsody | null {
  if (value === null) return null;
  const item = closed(value, "$.prosody", [
    "format", "version", "interpretation", "authority", "range", "policy", "samplePolicy", "speakingRate",
    "pauses", "phrases", "sentences", "contours", "emphasisCandidates", "dialogueSpaceSuggestions", "work", "analysisSha256",
  ]);
  if (item.format !== "cut-dialogue-prosody-analysis" || item.version !== 1
    || item.interpretation !== "measured-timing-plus-authored-policy-not-emotion-or-performance-approval") {
    fail("CUT_AUDIO_ARRANGEMENT_PROSODY", "$.prosody", "must be the accepted dialogue-prosody analysis v1 contract.");
  }
  const authority = closed(item.authority, "$.prosody.authority", [
    "mediaSha256", "audioStreamIndex", "normalizedPcmSha256", "transcriptSha256", "sampleRate", "channels",
    "durationSamples", "pcmEncoding", "policySha256", "mediaIdentitySemantics",
  ]);
  digest(authority.mediaSha256, "$.prosody.authority.mediaSha256");
  integer(authority.audioStreamIndex, "$.prosody.authority.audioStreamIndex", 0, 1_000_000);
  digest(authority.normalizedPcmSha256, "$.prosody.authority.normalizedPcmSha256");
  digest(authority.transcriptSha256, "$.prosody.authority.transcriptSha256");
  const sampleRate = integer(authority.sampleRate, "$.prosody.authority.sampleRate", 8_000, 192_000);
  const durationSamples = integer(authority.durationSamples, "$.prosody.authority.durationSamples", 1, brief.durationSamples);
  integer(authority.channels, "$.prosody.authority.channels", 1, 2);
  digest(authority.policySha256, "$.prosody.authority.policySha256");
  if (authority.pcmEncoding !== "f32le-interleaved"
    || authority.mediaIdentitySemantics !== "transcript-cross-binding-not-original-byte-authentication") {
    fail("CUT_AUDIO_ARRANGEMENT_PROSODY", "$.prosody.authority", "contains unsupported authority semantics.");
  }
  if (sampleRate !== brief.sampleRate || durationSamples !== brief.durationSamples) {
    fail("CUT_AUDIO_ARRANGEMENT_CLOCK", "$.prosody.authority", "must match the complete brief sample clock.");
  }
  const analysisRange = range(item.range, "$.prosody.range", brief.durationSamples);
  if (analysisRange.startSample !== 0 || analysisRange.endSample !== brief.durationSamples) {
    fail("CUT_AUDIO_ARRANGEMENT_COVERAGE", "$.prosody.range", "must cover the complete arrangement program.");
  }
  const policy = closed(item.policy, "$.prosody.policy", [
    "minimumPauseMilliseconds", "mediumPauseMilliseconds", "longPauseMilliseconds", "sentencePauseMilliseconds",
    "activityAmplitudePpm", "maximumQuietPauseActivityPpm", "dynamicsDeltaDbfsMilli", "rateDeltaPpm",
    "emphasisRmsDeltaDbfsMilli", "emphasisDurationRatioPpm", "dialoguePreRollMilliseconds",
    "dialoguePostRollMilliseconds", "pauseMarginMilliseconds", "dialogueProtectionGainDeltaDbMilli",
  ]);
  for (const [key, raw] of Object.entries(policy)) integer(raw, `$.prosody.policy.${key}`, -1_000_000_000, 1_000_000_000);
  if (canonicalHash(policy) !== authority.policySha256) {
    fail("CUT_AUDIO_ARRANGEMENT_AUTHORITY", "$.prosody.authority.policySha256", "does not bind the canonical prosody policy.");
  }
  shallowBoundedObject(item.samplePolicy, "$.prosody.samplePolicy");
  shallowBoundedObject(item.speakingRate, "$.prosody.speakingRate");
  shallowBoundedObject(item.work, "$.prosody.work");
  for (const [key, raw] of [
    ["pauses", item.pauses], ["phrases", item.phrases], ["sentences", item.sentences], ["contours", item.contours],
    ["emphasisCandidates", item.emphasisCandidates],
  ] as const) {
    if (!Array.isArray(raw) || raw.length > 100_000) fail("CUT_AUDIO_ARRANGEMENT_LIMIT", `$.prosody.${key}`, "must be one bounded array.");
  }
  if (!Array.isArray(item.dialogueSpaceSuggestions)
    || item.dialogueSpaceSuggestions.length > cutAudioArrangementLimits.maximumProsodySuggestions) {
    fail("CUT_AUDIO_ARRANGEMENT_LIMIT", "$.prosody.dialogueSpaceSuggestions", `must contain at most ${cutAudioArrangementLimits.maximumProsodySuggestions} suggestions.`);
  }
  const ids = new Set<string>();
  let previousStart = -1;
  let previousEnd = -1;
  let previousKind = "";
  let previousPauseEnd = -1;
  const suggestions = Object.freeze(item.dialogueSpaceSuggestions.map((entry, index) => {
    const suggestion = parseProsodySuggestion(entry, `$.prosody.dialogueSpaceSuggestions[${index}]`, brief.durationSamples);
    if (ids.has(suggestion.id)) fail("CUT_AUDIO_ARRANGEMENT_DUPLICATE", `$.prosody.dialogueSpaceSuggestions[${index}].id`, "duplicates an earlier suggestion id.");
    ids.add(suggestion.id);
    const comparison = suggestion.startSample - previousStart || suggestion.endSample - previousEnd || suggestion.kind.localeCompare(previousKind);
    if (index > 0 && comparison < 0) {
      fail("CUT_AUDIO_ARRANGEMENT_PROSODY", `$.prosody.dialogueSpaceSuggestions[${index}]`, "must retain canonical sample/kind order.");
    }
    previousStart = suggestion.startSample;
    previousEnd = suggestion.endSample;
    previousKind = suggestion.kind;
    if (suggestion.kind === "protect-dialogue") {
      if (suggestion.policyBedGainDeltaDbMilli !== policy.dialogueProtectionGainDeltaDbMilli) {
        fail("CUT_AUDIO_ARRANGEMENT_PROSODY", `$.prosody.dialogueSpaceSuggestions[${index}].policyBedGainDeltaDbMilli`, "must match the bound prosody policy.");
      }
    } else {
      if (suggestion.startSample < previousPauseEnd) {
        fail("CUT_AUDIO_ARRANGEMENT_PROSODY", `$.prosody.dialogueSpaceSuggestions[${index}]`, "overlaps an earlier pause-accent window.");
      }
      previousPauseEnd = suggestion.endSample;
    }
    return suggestion;
  }));
  const observed = digest(item.analysisSha256, "$.prosody.analysisSha256");
  const { analysisSha256: _ignored, ...body } = item;
  const expected = canonicalHash(body);
  if (observed !== expected) {
    fail("CUT_AUDIO_ARRANGEMENT_IDENTITY", "$.prosody.analysisSha256", "does not bind the canonical prosody analysis body.");
  }
  return deepFreeze({
    ...item,
    authority: Object.freeze({ ...authority, sampleRate, durationSamples }),
    range: analysisRange,
    dialogueSpaceSuggestions: suggestions,
    analysisSha256: expected,
  }) as CutAudioArrangementProsody;
}

export function cutAudioArrangementInputSha256(body: CutAudioArrangementInputBody) {
  return canonicalHash(body);
}

export function parseCutAudioArrangementInput(input: string | Uint8Array): CutAudioArrangementInput {
  let decoded: unknown;
  try {
    decoded = parseStrictPackageJson(input, {
      limits: {
        maxInputBytes: cutAudioArrangementLimits.maximumInputBytes,
        maxDepth: 32,
        maxNodes: 100_000,
        maxStringBytes: cutAudioArrangementLimits.maximumStringBytes,
        maxTotalStringBytes: cutAudioArrangementLimits.maximumTotalStringBytes,
      },
    });
  } catch (error) {
    fail("CUT_AUDIO_ARRANGEMENT_FORMAT", "$", error instanceof Error ? error.message : "is not strict bounded JSON.");
  }
  const item = closed(decoded, "$", ["format", "version", "profile", "brief", "prosody", "assets", "inputSha256"]);
  if (item.format !== cutAudioArrangementInputFormat || item.version !== cutAudioArrangementInputVersion
    || item.profile !== cutAudioArrangementProfile) {
    fail("CUT_AUDIO_ARRANGEMENT_FORMAT", "$", `must be ${cutAudioArrangementInputFormat} v${cutAudioArrangementInputVersion} with ${cutAudioArrangementProfile}.`);
  }
  let brief: CutAudioBrief;
  try {
    brief = parseCutAudioBrief(stableJsonStringify(item.brief));
  } catch (error) {
    fail("CUT_AUDIO_ARRANGEMENT_AUTHORITY", "$.brief", error instanceof Error ? error.message : "is not one accepted audio brief.");
  }
  const body: CutAudioArrangementInputBody = Object.freeze({
    format: cutAudioArrangementInputFormat,
    version: cutAudioArrangementInputVersion,
    profile: cutAudioArrangementProfile,
    brief,
    prosody: parseProsody(item.prosody, brief),
    assets: parseAssets(item.assets, brief),
  });
  const observed = digest(item.inputSha256, "$.inputSha256");
  const expected = cutAudioArrangementInputSha256(body);
  if (observed !== expected) {
    fail("CUT_AUDIO_ARRANGEMENT_IDENTITY", "$.inputSha256", "does not bind the canonical arrangement input body.");
  }
  return Object.freeze({ ...body, inputSha256: expected });
}

function assetSymbol(id: string) {
  return `arr_${id.replace(/[.-]/gu, "_")}`;
}

function overlaps(left: CutAudioArrangementRange, right: CutAudioArrangementRange) {
  return left.startSample < right.endSample && right.startSample < left.endSample;
}

function actAtSample(brief: CutAudioBrief, sample: number) {
  return brief.acts.find((act) => act.range.startSample <= sample && sample < act.range.endSample);
}

function exactScaledPpm(value: number, span: number) {
  return Math.floor((value * span + 500_000) / 1_000_000);
}

function bedGain(act: CutAudioBriefAct, asset: CutAudioArrangementAsset) {
  const base = asset.role === "music"
    ? cutAudioArrangementPolicy.musicBaseGainDbMilli
    : cutAudioArrangementPolicy.ambienceBaseGainDbMilli;
  return base
    + exactScaledPpm(act.energyPpm, cutAudioArrangementPolicy.actEnergyGainSpanDbMilli)
    - exactScaledPpm(act.dialogueSpacePpm, cutAudioArrangementPolicy.dialogueSpaceBedReductionSpanDbMilli)
    + asset.perspective.gainDbMilli;
}

function audibleRuns(act: CutAudioBriefAct, brief: CutAudioBrief) {
  const runs: CutAudioArrangementRange[] = [];
  let cursor = act.range.startSample;
  for (const silence of brief.intentionalSilences) {
    if (!overlaps(act.range, silence.range)) continue;
    const silenceStart = Math.max(act.range.startSample, silence.range.startSample);
    const silenceEnd = Math.min(act.range.endSample, silence.range.endSample);
    if (cursor < silenceStart) runs.push(Object.freeze({ startSample: cursor, endSample: silenceStart }));
    cursor = Math.max(cursor, silenceEnd);
  }
  if (cursor < act.range.endSample) runs.push(Object.freeze({ startSample: cursor, endSample: act.range.endSample }));
  return runs;
}

function protectionSegments(
  run: CutAudioArrangementRange,
  protections: readonly Extract<CutAudioArrangementProsodySuggestion, { kind: "protect-dialogue" }>[],
) {
  const active = new Map<string, Extract<CutAudioArrangementProsodySuggestion, { kind: "protect-dialogue" }>>();
  const boundaries = new Map<number, { opens: typeof protections[number][]; closes: string[] }>();
  const boundary = (sample: number) => {
    let result = boundaries.get(sample);
    if (!result) {
      result = { opens: [], closes: [] };
      boundaries.set(sample, result);
    }
    return result;
  };
  for (const protection of protections) {
    if (!overlaps(run, protection)) continue;
    if (protection.startSample <= run.startSample) active.set(protection.id, protection);
    else boundary(protection.startSample).opens.push(protection);
    if (protection.endSample < run.endSample) boundary(protection.endSample).closes.push(protection.id);
  }
  const samples = [...boundaries.keys()].filter((sample) => sample > run.startSample && sample < run.endSample).sort((a, b) => a - b);
  const result: Array<Readonly<{
    range: CutAudioArrangementRange;
    suggestionIds: readonly string[];
    gainDeltaDbMilli: number;
  }>> = [];
  let cursor = run.startSample;
  for (const sample of [...samples, run.endSample]) {
    const values = [...active.values()].sort((left, right) => left.id.localeCompare(right.id));
    result.push(Object.freeze({
      range: Object.freeze({ startSample: cursor, endSample: sample }),
      suggestionIds: Object.freeze(values.map((item) => item.id)),
      gainDeltaDbMilli: values.reduce((minimum, item) => Math.min(minimum, item.policyBedGainDeltaDbMilli), 0),
    }));
    const transition = boundaries.get(sample);
    for (const id of transition?.closes ?? []) active.delete(id);
    for (const item of transition?.opens ?? []) active.set(item.id, item);
    cursor = sample;
  }
  return result;
}

function validateAssignments(input: CutAudioArrangementInput) {
  const { brief, assets } = input;
  const dialogue = assets.filter((asset) => asset.role === "dialogue");
  if (dialogue.length !== 1) {
    fail("CUT_AUDIO_ARRANGEMENT_COVERAGE", "$.assets", "documentary/podcast profile requires exactly one full-program dialogue asset.");
  }
  const dialogueAsset = dialogue[0]!;
  if (dialogueAsset.assignment.kind !== "program-dialogue"
    || dialogueAsset.sourceRange.endSample - dialogueAsset.sourceRange.startSample !== brief.durationSamples) {
    fail("CUT_AUDIO_ARRANGEMENT_COVERAGE", "$.assets", "dialogue must bind one exact full-program source range.");
  }
  if (input.prosody && input.prosody.authority.mediaSha256 !== dialogueAsset.lockedResourceSha256) {
    fail(
      "CUT_AUDIO_ARRANGEMENT_AUTHORITY",
      "$.prosody.authority.mediaSha256",
      "must match the selected program-dialogue locked resource authority.",
    );
  }
  if (input.prosody && dialogueAsset.sourceRange.endSample > input.prosody.authority.durationSamples) {
    fail(
      "CUT_AUDIO_ARRANGEMENT_COVERAGE",
      `$.assets.${dialogueAsset.id}.sourceRange`,
      "must stay within the bound prosody media duration.",
    );
  }
  const actById = new Map(brief.acts.map((act) => [act.id, act]));
  const actRoles = new Map<string, CutAudioArrangementAsset>();
  const eventBindings = new Map<number, CutAudioArrangementAsset>();
  for (const asset of assets) {
    if (asset.assignment.kind === "act") {
      const act = actById.get(asset.assignment.actId);
      if (!act) fail("CUT_AUDIO_ARRANGEMENT_ASSIGNMENT", `$.assets.${asset.id}.assignment.actId`, "does not name a brief act.");
      if (!act.desiredRoles.includes(asset.role as "music" | "ambience")) {
        fail("CUT_AUDIO_ARRANGEMENT_ROLE", `$.assets.${asset.id}`, "binds a role the assigned act did not request.");
      }
      if (asset.sourceRange.endSample - asset.sourceRange.startSample !== act.range.endSample - act.range.startSample) {
        fail("CUT_AUDIO_ARRANGEMENT_COVERAGE", `$.assets.${asset.id}.sourceRange`, "must exactly span its assigned act before supporting-sound silence gaps are cut.");
      }
      const key = `${act.id}\u0000${asset.role}`;
      if (actRoles.has(key)) fail("CUT_AUDIO_ARRANGEMENT_DUPLICATE", `$.assets.${asset.id}`, "duplicates an accepted act/role binding.");
      actRoles.set(key, asset);
    } else if (asset.assignment.kind === "event") {
      const event = brief.events[asset.assignment.eventIndex];
      if (!event) fail("CUT_AUDIO_ARRANGEMENT_ASSIGNMENT", `$.assets.${asset.id}.assignment.eventIndex`, "does not name a brief event.");
      const act = actAtSample(brief, event.sample);
      if (!act || !act.desiredRoles.includes("sfx")) {
        fail("CUT_AUDIO_ARRANGEMENT_ROLE", `$.assets.${asset.id}`, "binds SFX outside an act that explicitly requests SFX.");
      }
      if (eventBindings.has(asset.assignment.eventIndex)) {
        fail("CUT_AUDIO_ARRANGEMENT_DUPLICATE", `$.assets.${asset.id}`, "duplicates an accepted event SFX binding.");
      }
      eventBindings.set(asset.assignment.eventIndex, asset);
    }
  }
  for (const act of brief.acts) {
    for (const role of ["music", "ambience"] as const) {
      const bound = actRoles.has(`${act.id}\u0000${role}`);
      if (act.desiredRoles.includes(role) !== bound) {
        fail("CUT_AUDIO_ARRANGEMENT_COVERAGE", `$.brief.acts.${act.id}.desiredRoles`, `requires exactly one accepted ${role} binding for this act.`);
      }
    }
  }
}

function createPlacement(
  id: string,
  asset: CutAudioArrangementAsset,
  destinationRange: CutAudioArrangementRange,
  sourceRange: CutAudioArrangementRange,
  gainDbMilli: number,
  fadeInSamples: number,
  fadeOutSamples: number,
  options: Readonly<{
    actId?: string;
    eventIndex?: number;
    eventSample?: number;
    protections?: readonly string[];
    pauseAccentSuggestionId?: string;
  }> = {},
): CutAudioArrangementPlacement {
  return Object.freeze({
    id,
    assetId: asset.id,
    role: asset.role,
    destinationRange,
    sourceRange,
    gainDbMilli,
    fadeInSamples,
    fadeOutSamples,
    actId: options.actId ?? null,
    eventIndex: options.eventIndex ?? null,
    eventSample: options.eventSample ?? null,
    dialogueProtectionSuggestionIds: Object.freeze([...(options.protections ?? [])]),
    pauseAccentSuggestionId: options.pauseAccentSuggestionId ?? null,
  });
}

function planAssets(input: CutAudioArrangementInput) {
  validateAssignments(input);
  const protections = (input.prosody?.dialogueSpaceSuggestions ?? []).filter(
    (item): item is Extract<CutAudioArrangementProsodySuggestion, { kind: "protect-dialogue" }> => item.kind === "protect-dialogue",
  );
  const pauseAccents = (input.prosody?.dialogueSpaceSuggestions ?? []).filter(
    (item): item is Extract<CutAudioArrangementProsodySuggestion, { kind: "pause-accent-window" }> => item.kind === "pause-accent-window",
  );
  const planned: PlannedAsset[] = [];
  let placementNumber = 0;
  const nextId = () => `placement.${String(++placementNumber).padStart(6, "0")}`;
  for (const asset of input.assets) {
    const placements: CutAudioArrangementPlacement[] = [];
    if (asset.assignment.kind === "program-dialogue") {
      placements.push(createPlacement(
        nextId(),
        asset,
        Object.freeze({ startSample: 0, endSample: input.brief.durationSamples }),
        asset.sourceRange,
        asset.perspective.gainDbMilli,
        0,
        0,
      ));
    } else if (asset.assignment.kind === "act") {
      const { actId } = asset.assignment;
      const act = input.brief.acts.find((item) => item.id === actId)!;
      const baseGain = bedGain(act, asset);
      const runs = audibleRuns(act, input.brief);
      if (runs.length === 0) {
        fail("CUT_AUDIO_ARRANGEMENT_SILENCE", `$.assets.${asset.id}`, "cannot place a supporting asset in an act fully covered by intentional silence.");
      }
      for (const run of runs) {
        const fadeSamples = Math.min(
          Math.floor(input.brief.sampleRate * cutAudioArrangementPolicy.maximumActFadeMilliseconds / 1_000),
          Math.floor((run.endSample - run.startSample) / 8),
        );
        for (const segment of protectionSegments(run, protections)) {
          const sourceStart = asset.sourceRange.startSample + segment.range.startSample - act.range.startSample;
          const sourceEnd = asset.sourceRange.startSample + segment.range.endSample - act.range.startSample;
          const wantsFadeIn = segment.range.startSample === run.startSample;
          const wantsFadeOut = segment.range.endSample === run.endSample;
          const fadeDivisor = Number(wantsFadeIn) + Number(wantsFadeOut);
          const boundedFadeSamples = fadeDivisor === 0
            ? 0
            : Math.min(fadeSamples, Math.floor((segment.range.endSample - segment.range.startSample) / fadeDivisor));
          placements.push(createPlacement(
            nextId(),
            asset,
            segment.range,
            Object.freeze({ startSample: sourceStart, endSample: sourceEnd }),
            baseGain + segment.gainDeltaDbMilli,
            wantsFadeIn ? boundedFadeSamples : 0,
            wantsFadeOut ? boundedFadeSamples : 0,
            { actId: act.id, protections: segment.suggestionIds },
          ));
        }
      }
    } else {
      const event = input.brief.events[asset.assignment.eventIndex]!;
      const maximumSourceDuration = asset.sourceRange.endSample - asset.sourceRange.startSample;
      const accent = pauseAccents.find((item) => item.startSample <= event.sample && event.sample < item.endSample);
      const duration = accent
        ? Math.min(maximumSourceDuration, accent.maximumEventDurationSamples, accent.endSample - event.sample)
        : maximumSourceDuration;
      if (duration < 1 || event.sample + duration > input.brief.durationSamples) {
        fail("CUT_AUDIO_ARRANGEMENT_COVERAGE", `$.assets.${asset.id}`, "event-bound SFX does not fit the program or its containing pause-accent window.");
      }
      const destinationRange = Object.freeze({ startSample: event.sample, endSample: event.sample + duration });
      const silence = input.brief.intentionalSilences.find((item) => overlaps(item.range, destinationRange));
      if (silence) {
        fail("CUT_AUDIO_ARRANGEMENT_SILENCE", `$.assets.${asset.id}`, "event-bound SFX overlaps an exact supporting-sound intentional silence.");
      }
      const activeProtections = protections.filter((item) => overlaps(item, destinationRange)).sort((left, right) => left.id.localeCompare(right.id));
      const protectionGain = activeProtections.reduce((minimum, item) => Math.min(minimum, item.policyBedGainDeltaDbMilli), 0);
      const fadeOutSamples = Math.min(
        Math.floor(input.brief.sampleRate * cutAudioArrangementPolicy.maximumSfxFadeOutMilliseconds / 1_000),
        Math.floor(duration / 4),
      );
      placements.push(createPlacement(
        nextId(),
        asset,
        destinationRange,
        Object.freeze({ startSample: asset.sourceRange.startSample, endSample: asset.sourceRange.startSample + duration }),
        cutAudioArrangementPolicy.sfxBaseGainDbMilli
          + exactScaledPpm(event.strengthPpm, cutAudioArrangementPolicy.sfxStrengthGainSpanDbMilli)
          + asset.perspective.gainDbMilli
          + protectionGain,
        0,
        fadeOutSamples,
        {
          eventIndex: asset.assignment.eventIndex,
          eventSample: event.sample,
          protections: activeProtections.map((item) => item.id),
          ...(accent ? { pauseAccentSuggestionId: accent.id } : {}),
        },
      ));
    }
    if (asset.role !== "dialogue" && asset.perspective.reverbWetPpm > 0
      && input.brief.intentionalSilences.some((silence) => placements.some((placement) => placement.destinationRange.startSample < silence.range.endSample))) {
      fail(
        "CUT_AUDIO_ARRANGEMENT_SILENCE",
        `$.assets.${asset.id}.perspective.reverbWetPpm`,
        "must be zero when this supporting route precedes an intentional silence; the current public Reverb has no exact post-effect region gate.",
      );
    }
    planned.push(Object.freeze({ asset, symbol: assetSymbol(asset.id), placements: Object.freeze(placements) }));
  }
  if (placementNumber > cutAudioArrangementLimits.maximumPlacements) {
    fail("CUT_AUDIO_ARRANGEMENT_LIMIT", "$.assets", `expands to more than ${cutAudioArrangementLimits.maximumPlacements} placements.`);
  }
  return Object.freeze(planned);
}

function time(sample: number, sampleRate: number) {
  return sample === 0 ? "0s" : `(${sample}s / ${sampleRate})`;
}

function gain(value: number) {
  return value === 0 ? "0db" : `(${value}db / 1000)`;
}

function ratioPpm(value: number) {
  return value === 0 ? "0%" : `(${value}% / 10000)`;
}

function scalarMilli(value: number) {
  return value % 1_000 === 0 ? String(value / 1_000) : `(${value} / 1000)`;
}

function renderTrack(item: PlannedAsset, durationSamples: number, sampleRate: number) {
  const lines = ["AudioTrack() {"];
  let cursor = 0;
  for (const placement of item.placements) {
    if (cursor < placement.destinationRange.startSample) {
      lines.push(`  AudioGap(destination: ${time(cursor, sampleRate)} ..< ${time(placement.destinationRange.startSample, sampleRate)});`);
    }
    const fadeInputs = [
      placement.fadeInSamples > 0 ? `fadeIn: ${time(placement.fadeInSamples, sampleRate)}` : "",
      placement.fadeOutSamples > 0 ? `fadeOut: ${time(placement.fadeOutSamples, sampleRate)}` : "",
    ].filter(Boolean);
    lines.push(`  AudioRegion(destination: ${time(placement.destinationRange.startSample, sampleRate)} ..< ${time(placement.destinationRange.endSample, sampleRate)}) {`);
    lines.push(`    Gain(amount: ${gain(placement.gainDbMilli)}) {`);
    lines.push(`      Pan(position: ${ratioPpm(item.asset.perspective.panPpm)}) {`);
    lines.push(`        ParametricEQ(frequency: ${item.asset.perspective.eqFrequencyHz}hz, gain: ${gain(item.asset.perspective.eqGainDbMilli)}, q: ${scalarMilli(item.asset.perspective.eqQMilli)}) {`);
    lines.push(`          AudioClip(source: ${item.symbol}, range: ${time(placement.sourceRange.startSample, sampleRate)} ..< ${time(placement.sourceRange.endSample, sampleRate)}${fadeInputs.length ? `, ${fadeInputs.join(", ")}` : ""});`);
    lines.push("        }");
    lines.push("      }");
    lines.push("    }");
    lines.push("  }");
    cursor = placement.destinationRange.endSample;
  }
  if (cursor < durationSamples) lines.push(`  AudioGap(destination: ${time(cursor, sampleRate)} ..< ${time(durationSamples, sampleRate)});`);
  lines.push("}");
  return lines;
}

function indent(lines: readonly string[], spaces: number) {
  const prefix = " ".repeat(spaces);
  return lines.map((line) => `${prefix}${line}`);
}

function renderProcessedTrack(item: PlannedAsset, durationSamples: number, sampleRate: number) {
  const { perspective } = item.asset;
  return [
    `Reverb(wet: ${ratioPpm(perspective.reverbWetPpm)}) {`,
    ...indent(renderTrack(item, durationSamples, sampleRate), 2),
    "}",
  ];
}

function renderCutSource(input: CutAudioArrangementInput, planned: readonly PlannedAsset[]) {
  const order: Record<CutAudioArrangementRole, number> = { dialogue: 0, music: 1, ambience: 2, sfx: 3 };
  const sorted = [...planned].sort((left, right) => order[left.asset.role] - order[right.asset.role]
    || left.asset.assignment.kind.localeCompare(right.asset.assignment.kind)
    || (left.asset.assignment.kind === "act" && right.asset.assignment.kind === "act"
      ? left.asset.assignment.actId.localeCompare(right.asset.assignment.actId) : 0)
    || (left.asset.assignment.kind === "event" && right.asset.assignment.kind === "event"
      ? left.asset.assignment.eventIndex - right.asset.assignment.eventIndex : 0)
    || left.asset.id.localeCompare(right.asset.id));
  const lines = [
    "cut 0.4;",
    "",
    "project \"Documentary podcast audio arrangement\";",
    "",
    "import { AudioGap, AudioRegion, AudioTrack } from \"@cut/edit\";",
    "import { AudioClip, Bus, Gain, Pan, ParametricEQ, Reverb } from \"@cut/audio\";",
    "",
  ];
  for (const item of [...input.assets].sort((left, right) => left.id.localeCompare(right.id))) {
    lines.push(`asset ${assetSymbol(item.id)}: AudioAsset = audio(${JSON.stringify(item.locator)});`);
  }
  lines.push("", `timeline main(duration: ${time(input.brief.durationSamples, input.brief.sampleRate)}, fps: 30, sampleRate: ${input.brief.sampleRate / 1_000}khz) {`);
  for (const role of ["dialogue", "music", "ambience", "sfx"] as const) {
    const roleItems = sorted.filter((item) => item.asset.role === role);
    if (!roleItems.length) continue;
    lines.push(`  Bus(name: ${JSON.stringify(role)}, role: ${JSON.stringify(role)}) {`);
    for (const item of roleItems) lines.push(...indent(renderProcessedTrack(item, input.brief.durationSamples, input.brief.sampleRate), 4));
    lines.push("  }");
  }
  lines.push("}", "", "export arrangement = render(main);", "");
  const source = lines.join("\n");
  if (Buffer.byteLength(source, "utf8") > cutAudioArrangementLimits.maximumSourceBytes) {
    fail("CUT_AUDIO_ARRANGEMENT_LIMIT", "$.assets", `generated source exceeds ${cutAudioArrangementLimits.maximumSourceBytes} bytes.`);
  }
  return source;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/**
 * Purely turns already accepted, explicit semantic/audio authorities into ordinary CUT source.
 * It never opens assets, selects media, executes a model, writes source, or invokes a renderer.
 */
export function arrangeCutAudio(inputBytes: string | Uint8Array): CutAudioArrangement {
  const input = parseCutAudioArrangementInput(inputBytes);
  const planned = planAssets(input);
  const source = renderCutSource(input, planned);
  const sourceSha256 = createHash("sha256").update(source, "utf8").digest("hex");
  const assets = Object.freeze([...input.assets].sort((left, right) => left.id.localeCompare(right.id)));
  const placements = Object.freeze(planned.flatMap((item) => item.placements).sort((left, right) =>
    left.destinationRange.startSample - right.destinationRange.startSample
      || left.destinationRange.endSample - right.destinationRange.endSample
      || left.role.localeCompare(right.role)
      || left.assetId.localeCompare(right.assetId)
      || left.id.localeCompare(right.id)));
  const manifestBody: CutAudioArrangementManifestBody = deepFreeze({
    format: "cut-audio-arrangement-manifest",
    version: 1,
    profile: cutAudioArrangementProfile,
    authority: {
      inputSha256: input.inputSha256,
      briefSha256: input.brief.briefSha256,
      sourceScriptSha256: input.brief.sourceScriptSha256,
      prosodyAnalysisSha256: input.prosody?.analysisSha256 ?? null,
      sourceSha256,
      resourceIdentitySemantics: "caller-accepted-locked-resource-digests-not-reopened-by-pure-planner",
    },
    clock: { sampleRate: input.brief.sampleRate, durationSamples: input.brief.durationSamples },
    policy: cutAudioArrangementPolicy,
    assets,
    placements,
    intentionalSilences: input.brief.intentionalSilences.map((item) => ({
      range: item.range,
      purpose: item.purpose,
      semantics: "exact-supporting-sound-gap-dialogue-preserved",
    })),
    work: {
      assetsVisited: input.assets.length,
      actsVisited: input.brief.acts.length,
      eventsVisited: input.brief.events.length,
      prosodySuggestionsVisited: input.prosody?.dialogueSpaceSuggestions.length ?? 0,
      placementsEmitted: placements.length,
    },
    limitations: [
      "Accepted audio bytes are not reopened by this pure planner; lockedResourceSha256 remains caller-accepted authority.",
      "All accepted assets must already be normalized to the brief sample rate; this profile does not loop or retime media.",
      "The profile requires one continuous full-program dialogue asset and one music/ambience asset per requested act/role.",
      "Intentional silence suppresses supporting music, ambience, and SFX exactly while preserving the authored dialogue program.",
      "A supporting route that precedes intentional silence must author zero reverb wetness because CUT has no exact post-Reverb AudioRegion gate.",
      "Perspective labels and every gain, pan, equalizer, and reverb control are authored inputs, not inferred acoustic facts.",
      "The arrangement is an editable proposal; normal-speed listening, rights review, locking, rendering, and delivery remain separate gates.",
    ],
  });
  const manifest = deepFreeze({ ...manifestBody, manifestSha256: canonicalHash(manifestBody) });
  const body = { format: "cut-audio-arrangement" as const, version: 1 as const, source, sourceSha256, manifest };
  return deepFreeze({ ...body, arrangementSha256: canonicalHash(body) });
}
