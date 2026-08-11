import { createHash } from "node:crypto";
import { stableJsonStringify } from "../core/stable";
import { parseStrictPackageJson } from "../package/json";

export const cutAudioBriefFormat = "cut-audio-brief" as const;
export const cutAudioBriefVersion = 1 as const;

export const cutAudioBriefNarrativeTurns = Object.freeze([
  "hook", "setup", "accumulation", "rupture", "counterfactual", "propagation", "resolution",
] as const);
export type CutAudioBriefNarrativeTurn = (typeof cutAudioBriefNarrativeTurns)[number];

export const cutAudioBriefRoles = Object.freeze(["music", "ambience", "sfx", "silence"] as const);
export type CutAudioBriefRole = (typeof cutAudioBriefRoles)[number];

export const cutAudioBriefEventKinds = Object.freeze([
  "hit", "transition", "riser", "texture",
] as const);
export type CutAudioBriefEventKind = (typeof cutAudioBriefEventKinds)[number];

export const cutAudioBriefLimits = Object.freeze({
  maximumInputBytes: 1024 * 1024,
  maximumStringBytes: 4_096,
  maximumTotalStringBytes: 512 * 1024,
  minimumSampleRate: 8_000,
  maximumSampleRate: 384_000,
  maximumDurationSamples: 384_000 * 60 * 60 * 24,
  maximumActs: 1_024,
  maximumEvents: 8_192,
  maximumIntentionalSilences: 1_024,
  maximumMoodsPerAct: 16,
  maximumMoodBytes: 32,
  maximumIntentBytes: 512,
  maximumPurposeBytes: 512,
  maximumPpm: 1_000_000,
});

export type CutAudioBriefRange = Readonly<{ startSample: number; endSample: number }>;

export type CutAudioBriefAct = Readonly<{
  id: string;
  range: CutAudioBriefRange;
  narrativeTurn: CutAudioBriefNarrativeTurn;
  desiredRoles: readonly CutAudioBriefRole[];
  moods: readonly string[];
  energyPpm: number;
  densityPpm: number;
  dialogueSpacePpm: number;
  intent: string;
}>;

export type CutAudioBriefEvent = Readonly<{
  sample: number;
  kind: CutAudioBriefEventKind;
  purpose: string;
  strengthPpm: number;
}>;

export type CutAudioBriefIntentionalSilence = Readonly<{
  range: CutAudioBriefRange;
  purpose: string;
}>;

export type CutAudioBriefBody = Readonly<{
  format: typeof cutAudioBriefFormat;
  version: typeof cutAudioBriefVersion;
  sampleRate: number;
  durationSamples: number;
  sourceScriptSha256: string;
  acts: readonly CutAudioBriefAct[];
  events: readonly CutAudioBriefEvent[];
  intentionalSilences: readonly CutAudioBriefIntentionalSilence[];
}>;

export type CutAudioBrief = CutAudioBriefBody & Readonly<{ briefSha256: string }>;

export class CutAudioBriefError extends Error {
  constructor(readonly code: string, readonly path: string, message: string) {
    super(`${code} at ${path}: ${message}`);
    this.name = "CutAudioBriefError";
  }
}

function fail(code: string, path: string, message: string): never {
  throw new CutAudioBriefError(code, path, message);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("CUT_AUDIO_BRIEF_TYPE", path, "must be one plain object.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("CUT_AUDIO_BRIEF_TYPE", path, "must be one plain object.");
  }
  return value as Record<string, unknown>;
}

function closed(value: unknown, path: string, required: readonly string[]) {
  const result = record(value, path), allowed = new Set(required);
  for (const key of Object.keys(result)) {
    if (!allowed.has(key)) fail("CUT_AUDIO_BRIEF_UNKNOWN_FIELD", `${path}.${key}`, "is not part of the closed audio-brief contract.");
  }
  for (const key of required) {
    if (!Object.hasOwn(result, key)) fail("CUT_AUDIO_BRIEF_TYPE", `${path}.${key}`, "is required.");
  }
  return result;
}

function text(value: unknown, path: string, maximumBytes: number) {
  if (typeof value !== "string" || !value || value !== value.trim()
    || Buffer.byteLength(value, "utf8") > maximumBytes
    || value.normalize("NFC") !== value
    || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) {
    fail("CUT_AUDIO_BRIEF_TEXT", path, "must be non-empty, trimmed, NFC, bounded, and control-free text.");
  }
  return value;
}

function digest(value: unknown, path: string) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    fail("CUT_AUDIO_BRIEF_SHA256", path, "must be one lowercase SHA-256 digest.");
  }
  return value;
}

function integer(value: unknown, path: string, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    fail("CUT_AUDIO_BRIEF_NUMBER", path, `must be an integer from ${minimum} through ${maximum}.`);
  }
  return Number(value);
}

function oneOf<const Values extends readonly string[]>(value: unknown, path: string, values: Values): Values[number] {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    fail("CUT_AUDIO_BRIEF_ENUM", path, `must be one of ${values.join(", ")}.`);
  }
  return value as Values[number];
}

function stableId(value: unknown, path: string) {
  const result = text(value, path, 128);
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(result)) {
    fail("CUT_AUDIO_BRIEF_ID", path, "must match ^[a-z0-9][a-z0-9._-]{0,127}$.");
  }
  return result;
}

function mood(value: unknown, path: string) {
  const result = text(value, path, cutAudioBriefLimits.maximumMoodBytes);
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(result)) {
    fail("CUT_AUDIO_BRIEF_TOKEN", path, "must be one normalized lowercase ASCII token containing only letters, digits, or hyphens.");
  }
  return result;
}

function parseRange(value: unknown, path: string, durationSamples: number): CutAudioBriefRange {
  const item = closed(value, path, ["startSample", "endSample"]);
  const startSample = integer(item.startSample, `${path}.startSample`, 0, durationSamples - 1);
  const endSample = integer(item.endSample, `${path}.endSample`, 1, durationSamples);
  if (startSample >= endSample) fail("CUT_AUDIO_BRIEF_RANGE", path, "must be one non-empty half-open sample range.");
  return Object.freeze({ startSample, endSample });
}

function parseDesiredRoles(value: unknown, path: string) {
  if (!Array.isArray(value) || !value.length || value.length > cutAudioBriefRoles.length) {
    fail("CUT_AUDIO_BRIEF_LIMIT", path, `must contain 1..${cutAudioBriefRoles.length} desired roles.`);
  }
  const seen = new Set<string>();
  return Object.freeze(value.map((role, index) => {
    const parsed = oneOf(role, `${path}[${index}]`, cutAudioBriefRoles);
    if (seen.has(parsed)) fail("CUT_AUDIO_BRIEF_DUPLICATE", `${path}[${index}]`, "duplicates an earlier desired role.");
    seen.add(parsed);
    return parsed;
  }));
}

function parseMoods(value: unknown, path: string) {
  if (!Array.isArray(value) || !value.length || value.length > cutAudioBriefLimits.maximumMoodsPerAct) {
    fail("CUT_AUDIO_BRIEF_LIMIT", path, `must contain 1..${cutAudioBriefLimits.maximumMoodsPerAct} mood tokens.`);
  }
  const seen = new Set<string>();
  return Object.freeze(value.map((value, index) => {
    const parsed = mood(value, `${path}[${index}]`);
    if (seen.has(parsed)) fail("CUT_AUDIO_BRIEF_DUPLICATE", `${path}[${index}]`, "duplicates an earlier mood token.");
    seen.add(parsed);
    return parsed;
  }));
}

function parseActs(value: unknown, durationSamples: number) {
  if (!Array.isArray(value) || !value.length || value.length > cutAudioBriefLimits.maximumActs) {
    fail("CUT_AUDIO_BRIEF_LIMIT", "$.acts", `must contain 1..${cutAudioBriefLimits.maximumActs} acts.`);
  }
  const ids = new Set<string>();
  let previousEnd = 0;
  const acts = value.map((value, index): CutAudioBriefAct => {
    const path = `$.acts[${index}]`, item = closed(value, path, [
      "id", "range", "narrativeTurn", "desiredRoles", "moods",
      "energyPpm", "densityPpm", "dialogueSpacePpm", "intent",
    ]);
    const id = stableId(item.id, `${path}.id`), range = parseRange(item.range, `${path}.range`, durationSamples);
    if (ids.has(id)) fail("CUT_AUDIO_BRIEF_DUPLICATE", `${path}.id`, "duplicates an earlier act id.");
    ids.add(id);
    if (range.startSample < previousEnd) fail("CUT_AUDIO_BRIEF_ORDER", `${path}.range`, "overlaps or precedes the previous act.");
    if (range.startSample > previousEnd) fail("CUT_AUDIO_BRIEF_COVERAGE", `${path}.range`, "leaves a gap after the previous act.");
    previousEnd = range.endSample;
    return Object.freeze({
      id,
      range,
      narrativeTurn: oneOf(item.narrativeTurn, `${path}.narrativeTurn`, cutAudioBriefNarrativeTurns),
      desiredRoles: parseDesiredRoles(item.desiredRoles, `${path}.desiredRoles`),
      moods: parseMoods(item.moods, `${path}.moods`),
      energyPpm: integer(item.energyPpm, `${path}.energyPpm`, 0, cutAudioBriefLimits.maximumPpm),
      densityPpm: integer(item.densityPpm, `${path}.densityPpm`, 0, cutAudioBriefLimits.maximumPpm),
      dialogueSpacePpm: integer(item.dialogueSpacePpm, `${path}.dialogueSpacePpm`, 0, cutAudioBriefLimits.maximumPpm),
      intent: text(item.intent, `${path}.intent`, cutAudioBriefLimits.maximumIntentBytes),
    });
  });
  if (previousEnd !== durationSamples) {
    fail("CUT_AUDIO_BRIEF_COVERAGE", "$.acts", "must cover the complete program through durationSamples.");
  }
  return Object.freeze(acts);
}

function parseEvents(value: unknown, durationSamples: number) {
  if (!Array.isArray(value) || value.length > cutAudioBriefLimits.maximumEvents) {
    fail("CUT_AUDIO_BRIEF_LIMIT", "$.events", `must contain at most ${cutAudioBriefLimits.maximumEvents} events.`);
  }
  let previousSample = -1;
  return Object.freeze(value.map((value, index): CutAudioBriefEvent => {
    const path = `$.events[${index}]`, item = closed(value, path, ["sample", "kind", "purpose", "strengthPpm"]);
    const sample = integer(item.sample, `${path}.sample`, 0, durationSamples);
    if (sample === previousSample) fail("CUT_AUDIO_BRIEF_DUPLICATE", `${path}.sample`, "duplicates the previous event sample.");
    if (sample < previousSample) fail("CUT_AUDIO_BRIEF_ORDER", `${path}.sample`, "must be later than the previous event sample.");
    previousSample = sample;
    return Object.freeze({
      sample,
      kind: oneOf(item.kind, `${path}.kind`, cutAudioBriefEventKinds),
      purpose: text(item.purpose, `${path}.purpose`, cutAudioBriefLimits.maximumPurposeBytes),
      strengthPpm: integer(item.strengthPpm, `${path}.strengthPpm`, 0, cutAudioBriefLimits.maximumPpm),
    });
  }));
}

function parseIntentionalSilences(value: unknown, durationSamples: number) {
  if (!Array.isArray(value) || value.length > cutAudioBriefLimits.maximumIntentionalSilences) {
    fail("CUT_AUDIO_BRIEF_LIMIT", "$.intentionalSilences", `must contain at most ${cutAudioBriefLimits.maximumIntentionalSilences} ranges.`);
  }
  let previousEnd = -1;
  return Object.freeze(value.map((value, index): CutAudioBriefIntentionalSilence => {
    const path = `$.intentionalSilences[${index}]`, item = closed(value, path, ["range", "purpose"]);
    const range = parseRange(item.range, `${path}.range`, durationSamples);
    if (range.startSample < previousEnd) {
      fail("CUT_AUDIO_BRIEF_OVERLAP", `${path}.range`, "overlaps or precedes an earlier intentional silence.");
    }
    previousEnd = range.endSample;
    return Object.freeze({
      range,
      purpose: text(item.purpose, `${path}.purpose`, cutAudioBriefLimits.maximumPurposeBytes),
    });
  }));
}

export function cutAudioBriefSha256(body: CutAudioBriefBody) {
  return createHash("sha256").update(stableJsonStringify(body)).digest("hex");
}

/** Parses creative direction only; this contract never selects media or applies edits. */
export function parseCutAudioBrief(input: string | Uint8Array): CutAudioBrief {
  let decoded: unknown;
  try {
    decoded = parseStrictPackageJson(input, {
      limits: {
        maxInputBytes: cutAudioBriefLimits.maximumInputBytes,
        maxDepth: 8,
        maxNodes: 100_000,
        maxStringBytes: cutAudioBriefLimits.maximumStringBytes,
        maxTotalStringBytes: cutAudioBriefLimits.maximumTotalStringBytes,
      },
    });
  } catch (error) {
    fail("CUT_AUDIO_BRIEF_JSON", "$", error instanceof Error ? error.message : "invalid strict JSON.");
  }
  const item = closed(decoded, "$", [
    "format", "version", "sampleRate", "durationSamples", "sourceScriptSha256",
    "acts", "events", "intentionalSilences", "briefSha256",
  ]);
  if (item.format !== cutAudioBriefFormat || item.version !== cutAudioBriefVersion) {
    fail("CUT_AUDIO_BRIEF_VERSION", "$", `must be ${cutAudioBriefFormat} v${cutAudioBriefVersion}.`);
  }
  const sampleRate = integer(
    item.sampleRate,
    "$.sampleRate",
    cutAudioBriefLimits.minimumSampleRate,
    cutAudioBriefLimits.maximumSampleRate,
  );
  const durationSamples = integer(
    item.durationSamples,
    "$.durationSamples",
    1,
    cutAudioBriefLimits.maximumDurationSamples,
  );
  const body: CutAudioBriefBody = Object.freeze({
    format: cutAudioBriefFormat,
    version: cutAudioBriefVersion,
    sampleRate,
    durationSamples,
    sourceScriptSha256: digest(item.sourceScriptSha256, "$.sourceScriptSha256"),
    acts: parseActs(item.acts, durationSamples),
    events: parseEvents(item.events, durationSamples),
    intentionalSilences: parseIntentionalSilences(item.intentionalSilences, durationSamples),
  });
  const expected = cutAudioBriefSha256(body), observed = digest(item.briefSha256, "$.briefSha256");
  if (expected !== observed) fail("CUT_AUDIO_BRIEF_IDENTITY", "$.briefSha256", "does not match the canonical brief body.");
  return Object.freeze({ ...body, briefSha256: expected });
}
