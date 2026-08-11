import { createHash } from "node:crypto";
import { stableJsonStringify } from "../core/stable";
import { parseStrictPackageJson } from "../package/json";
import {
  cutAudioSemanticInferenceKind,
  parseCutAudioSemanticPromptPolicy,
  type CutAudioSemanticPromptPolicy,
} from "./prompt-policy";

export const cutAudioAnalysisFormat = "cut-audio-analysis" as const;
export const cutAudioAnalysisVersion = 1 as const;
export const cutAudioAnalysisTaxonomyId = "cut-audio-taxonomy-v1" as const;
export const cutAudioAnalysisSemanticStatus = "editorial-suggestions-not-ground-truth" as const;

export const cutAudioAnalysisRoles = Object.freeze([
  "speech", "music", "ambience", "sfx", "silence",
] as const);
export type CutAudioAnalysisRole = (typeof cutAudioAnalysisRoles)[number];

export const cutAudioAnalysisMoods = Object.freeze([
  "calm", "tense", "hopeful", "energetic", "reflective", "somber", "joyful", "ominous", "intimate", "triumphant",
] as const);
export type CutAudioAnalysisMood = (typeof cutAudioAnalysisMoods)[number];
export type CutAudioAnalysisLabel = CutAudioAnalysisRole | CutAudioAnalysisMood;

export const cutAudioAnalysisLimits = Object.freeze({
  maximumInputBytes: 1024 * 1024,
  maximumStringBytes: 4_096,
  maximumTotalStringBytes: 512 * 1024,
  maximumStreamIndex: 65_535,
  minimumSampleRate: 8_000,
  maximumSampleRate: 384_000,
  maximumChannels: 32,
  maximumDurationSamples: 384_000 * 60 * 60 * 24,
  maximumModelFiles: 128,
  maximumWindows: 4_096,
  maximumLabelsPerWindow: 16,
  maximumTempoCandidates: 32,
  maximumBeats: 16_384,
  maximumSections: 4_096,
  minimumDbfsMilli: -200_000,
  maximumDbfsMilli: 24_000,
  maximumPpm: 1_000_000,
  minimumTempoBpm: 20,
  maximumTempoBpm: 400,
});

export type CutAudioAnalysisSource = Readonly<{
  locator: string;
  bytes: number;
  sha256: string;
  streamIndex: number;
  sampleRate: number;
  channels: number;
  durationSamples: number;
  normalizedPcmSha256: string;
}>;

export type CutAudioAnalysisBackend = Readonly<{
  provider: string;
  model: string;
  revision: string;
  adapterSha256: string;
  modelFiles: readonly Readonly<{ locator: string; bytes: number; sha256: string; license: string }>[];
  semanticInference?: Readonly<{
    kind: typeof cutAudioSemanticInferenceKind;
    promptPolicy: CutAudioSemanticPromptPolicy;
  }>;
}>;

export type CutAudioAnalysisPolicy = Readonly<{
  windowSamples: number;
  hopSamples: number;
  taxonomyId: typeof cutAudioAnalysisTaxonomyId;
  tempoMinBpm: number;
  tempoMaxBpm: number;
}>;

export type CutAudioAnalysisWindow = Readonly<{
  range: Readonly<{ startSample: number; endSample: number }>;
  rmsDbfsMilli: number;
  peakDbfsMilli: number;
  onsetStrengthPpm: number;
  labels: readonly Readonly<{ label: CutAudioAnalysisLabel; scorePpm: number }>[];
}>;

export type CutAudioAnalysisGlobal = Readonly<{
  tempoCandidates: readonly Readonly<{ bpmMilli: number; scorePpm: number }>[];
  beats: readonly Readonly<{ sample: number; scorePpm: number }>[];
}>;

export type CutAudioAnalysisSection = Readonly<{
  range: Readonly<{ startSample: number; endSample: number }>;
  role: CutAudioAnalysisRole;
  mood?: CutAudioAnalysisMood;
  confidencePpm: number;
}>;

export type CutAudioAnalysisBody = Readonly<{
  format: typeof cutAudioAnalysisFormat;
  version: typeof cutAudioAnalysisVersion;
  semanticStatus: typeof cutAudioAnalysisSemanticStatus;
  source: CutAudioAnalysisSource;
  backend: CutAudioAnalysisBackend;
  policy: CutAudioAnalysisPolicy;
  windows: readonly CutAudioAnalysisWindow[];
  global: CutAudioAnalysisGlobal;
  sections: readonly CutAudioAnalysisSection[];
}>;

export type CutAudioAnalysis = CutAudioAnalysisBody & Readonly<{ analysisSha256: string }>;

export class CutAudioAnalysisError extends Error {
  constructor(readonly code: string, readonly path: string, message: string) {
    super(`${code} at ${path}: ${message}`);
    this.name = "CutAudioAnalysisError";
  }
}

function fail(code: string, path: string, message: string): never {
  throw new CutAudioAnalysisError(code, path, message);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("CUT_AUDIO_ANALYSIS_TYPE", path, "must be one plain object.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("CUT_AUDIO_ANALYSIS_TYPE", path, "must be one plain object.");
  }
  return value as Record<string, unknown>;
}

function closed(value: unknown, path: string, required: readonly string[], optional: readonly string[] = []) {
  const result = record(value, path), allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(result)) {
    if (!allowed.has(key)) fail("CUT_AUDIO_ANALYSIS_UNKNOWN_FIELD", `${path}.${key}`, "is not part of the closed audio-analysis contract.");
  }
  for (const key of required) {
    if (!Object.hasOwn(result, key)) fail("CUT_AUDIO_ANALYSIS_TYPE", `${path}.${key}`, "is required.");
  }
  return result;
}

function text(value: unknown, path: string, maximum: number = cutAudioAnalysisLimits.maximumStringBytes) {
  if (typeof value !== "string" || !value || value !== value.trim()
    || Buffer.byteLength(value, "utf8") > maximum
    || value.normalize("NFC") !== value
    || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)) {
    fail("CUT_AUDIO_ANALYSIS_TEXT", path, "must be non-empty, trimmed, NFC, bounded, and control-free text.");
  }
  return value;
}

function digest(value: unknown, path: string) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    fail("CUT_AUDIO_ANALYSIS_SHA256", path, "must be one lowercase SHA-256 digest.");
  }
  return value;
}

function integer(value: unknown, path: string, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    fail("CUT_AUDIO_ANALYSIS_NUMBER", path, `must be an integer from ${minimum} through ${maximum}.`);
  }
  return Number(value);
}

function positiveInteger(value: unknown, path: string, maximum = Number.MAX_SAFE_INTEGER) {
  return integer(value, path, 1, maximum);
}

/** One canonical project- or backend-root-relative POSIX locator; no filesystem access occurs here. */
function locator(value: unknown, path: string) {
  const result = text(value, path, 1_024);
  if (result.startsWith("/") || /^[A-Za-z]:/u.test(result) || /[\\%?#:]/u.test(result)) {
    fail("CUT_AUDIO_ANALYSIS_LOCATOR", path, "must be one canonical relative POSIX locator.");
  }
  const segments = result.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".."
    || segment === "__proto__" || segment === "prototype" || segment === "constructor")) {
    fail("CUT_AUDIO_ANALYSIS_LOCATOR", path, "contains an empty, dot, parent, or unsafe segment.");
  }
  return result;
}

function ppm(value: unknown, path: string) {
  return integer(value, path, 0, cutAudioAnalysisLimits.maximumPpm);
}

function positivePpm(value: unknown, path: string) {
  return integer(value, path, 1, cutAudioAnalysisLimits.maximumPpm);
}

function parseSource(value: unknown): CutAudioAnalysisSource {
  const path = "$.source", item = closed(value, path, [
    "locator", "bytes", "sha256", "streamIndex", "sampleRate", "channels", "durationSamples", "normalizedPcmSha256",
  ]);
  return Object.freeze({
    locator: locator(item.locator, `${path}.locator`),
    bytes: positiveInteger(item.bytes, `${path}.bytes`),
    sha256: digest(item.sha256, `${path}.sha256`),
    streamIndex: integer(item.streamIndex, `${path}.streamIndex`, 0, cutAudioAnalysisLimits.maximumStreamIndex),
    sampleRate: integer(item.sampleRate, `${path}.sampleRate`, cutAudioAnalysisLimits.minimumSampleRate, cutAudioAnalysisLimits.maximumSampleRate),
    channels: integer(item.channels, `${path}.channels`, 1, cutAudioAnalysisLimits.maximumChannels),
    durationSamples: positiveInteger(item.durationSamples, `${path}.durationSamples`, cutAudioAnalysisLimits.maximumDurationSamples),
    normalizedPcmSha256: digest(item.normalizedPcmSha256, `${path}.normalizedPcmSha256`),
  });
}

function parseBackend(value: unknown): CutAudioAnalysisBackend {
  const path = "$.backend", item = closed(
    value,
    path,
    ["provider", "model", "revision", "adapterSha256", "modelFiles"],
    ["semanticInference"],
  );
  if (!Array.isArray(item.modelFiles) || !item.modelFiles.length || item.modelFiles.length > cutAudioAnalysisLimits.maximumModelFiles) {
    fail("CUT_AUDIO_ANALYSIS_LIMIT", `${path}.modelFiles`, `must contain 1..${cutAudioAnalysisLimits.maximumModelFiles} files.`);
  }
  const seen = new Set<string>();
  let previous = "";
  const modelFiles = item.modelFiles.map((value, index) => {
    const filePath = `${path}.modelFiles[${index}]`, file = closed(value, filePath, ["locator", "bytes", "sha256", "license"]);
    const parsed = Object.freeze({
      locator: locator(file.locator, `${filePath}.locator`),
      bytes: positiveInteger(file.bytes, `${filePath}.bytes`),
      sha256: digest(file.sha256, `${filePath}.sha256`),
      license: text(file.license, `${filePath}.license`, 512),
    });
    if (seen.has(parsed.locator)) fail("CUT_AUDIO_ANALYSIS_DUPLICATE", `${filePath}.locator`, "duplicates an earlier model file.");
    if (previous && parsed.locator <= previous) fail("CUT_AUDIO_ANALYSIS_ORDER", `${filePath}.locator`, "must be strictly sorted by locator.");
    seen.add(parsed.locator); previous = parsed.locator;
    return parsed;
  });
  let semanticInference: CutAudioAnalysisBackend["semanticInference"];
  if (item.semanticInference !== undefined) {
    const semanticPath = `${path}.semanticInference`;
    const semantic = closed(item.semanticInference, semanticPath, ["kind", "promptPolicy"]);
    if (semantic.kind !== cutAudioSemanticInferenceKind) {
      fail("CUT_AUDIO_ANALYSIS_SEMANTIC_BACKEND", `${semanticPath}.kind`, `must be ${cutAudioSemanticInferenceKind}.`);
    }
    semanticInference = Object.freeze({
      kind: cutAudioSemanticInferenceKind,
      promptPolicy: parseCutAudioSemanticPromptPolicy(semantic.promptPolicy),
    });
  }
  return Object.freeze({
    provider: text(item.provider, `${path}.provider`, 256),
    model: text(item.model, `${path}.model`, 512),
    revision: text(item.revision, `${path}.revision`, 256),
    adapterSha256: digest(item.adapterSha256, `${path}.adapterSha256`),
    modelFiles: Object.freeze(modelFiles),
    ...(semanticInference === undefined ? {} : { semanticInference }),
  });
}

function parsePolicy(value: unknown, durationSamples: number): CutAudioAnalysisPolicy {
  const path = "$.policy", item = closed(value, path, ["windowSamples", "hopSamples", "taxonomyId", "tempoMinBpm", "tempoMaxBpm"]);
  const windowSamples = positiveInteger(item.windowSamples, `${path}.windowSamples`, durationSamples);
  const hopSamples = positiveInteger(item.hopSamples, `${path}.hopSamples`, durationSamples);
  const tempoMinBpm = integer(item.tempoMinBpm, `${path}.tempoMinBpm`, cutAudioAnalysisLimits.minimumTempoBpm, cutAudioAnalysisLimits.maximumTempoBpm);
  const tempoMaxBpm = integer(item.tempoMaxBpm, `${path}.tempoMaxBpm`, cutAudioAnalysisLimits.minimumTempoBpm, cutAudioAnalysisLimits.maximumTempoBpm);
  if (tempoMinBpm >= tempoMaxBpm) fail("CUT_AUDIO_ANALYSIS_RANGE", path, "tempoMinBpm must be strictly less than tempoMaxBpm.");
  if (item.taxonomyId !== cutAudioAnalysisTaxonomyId) fail("CUT_AUDIO_ANALYSIS_TAXONOMY", `${path}.taxonomyId`, `must be ${cutAudioAnalysisTaxonomyId}.`);
  return Object.freeze({ windowSamples, hopSamples, taxonomyId: cutAudioAnalysisTaxonomyId, tempoMinBpm, tempoMaxBpm });
}

function parseRange(value: unknown, path: string, durationSamples: number) {
  const item = closed(value, path, ["startSample", "endSample"]);
  const startSample = integer(item.startSample, `${path}.startSample`, 0, durationSamples - 1);
  const endSample = integer(item.endSample, `${path}.endSample`, 1, durationSamples);
  if (startSample >= endSample) fail("CUT_AUDIO_ANALYSIS_RANGE", path, "must be one non-empty half-open sample range.");
  return Object.freeze({ startSample, endSample });
}

function labelRank(left: Readonly<{ label: string; scorePpm: number }>, right: Readonly<{ label: string; scorePpm: number }>) {
  return right.scorePpm - left.scorePpm || (left.label < right.label ? -1 : left.label > right.label ? 1 : 0);
}

function parseWindows(value: unknown, source: CutAudioAnalysisSource, policy: CutAudioAnalysisPolicy) {
  if (!Array.isArray(value) || !value.length || value.length > cutAudioAnalysisLimits.maximumWindows) {
    fail("CUT_AUDIO_ANALYSIS_LIMIT", "$.windows", `must contain 1..${cutAudioAnalysisLimits.maximumWindows} windows.`);
  }
  let previousEnd = -1;
  return Object.freeze(value.map((value, index): CutAudioAnalysisWindow => {
    const path = `$.windows[${index}]`, item = closed(value, path, ["range", "rmsDbfsMilli", "peakDbfsMilli", "onsetStrengthPpm", "labels"]);
    const range = parseRange(item.range, `${path}.range`, source.durationSamples);
    const length = range.endSample - range.startSample;
    const completeWindow = length === policy.windowSamples;
    const terminalPartialWindow = range.endSample === source.durationSamples && length < policy.windowSamples;
    if (range.startSample % policy.hopSamples !== 0 || (!completeWindow && !terminalPartialWindow)) {
      fail("CUT_AUDIO_ANALYSIS_GRID", `${path}.range`, "must begin on the declared hop grid and contain windowSamples samples, except for one bounded terminal partial window.");
    }
    if (range.startSample < previousEnd) fail("CUT_AUDIO_ANALYSIS_ORDER", `${path}.range`, "overlaps or precedes an earlier analysis window.");
    previousEnd = range.endSample;
    const rmsDbfsMilli = integer(item.rmsDbfsMilli, `${path}.rmsDbfsMilli`, cutAudioAnalysisLimits.minimumDbfsMilli, cutAudioAnalysisLimits.maximumDbfsMilli);
    const peakDbfsMilli = integer(item.peakDbfsMilli, `${path}.peakDbfsMilli`, cutAudioAnalysisLimits.minimumDbfsMilli, cutAudioAnalysisLimits.maximumDbfsMilli);
    if (rmsDbfsMilli > peakDbfsMilli) fail("CUT_AUDIO_ANALYSIS_RANGE", path, "rmsDbfsMilli cannot exceed peakDbfsMilli.");
    if (!Array.isArray(item.labels) || !item.labels.length || item.labels.length > cutAudioAnalysisLimits.maximumLabelsPerWindow) {
      fail("CUT_AUDIO_ANALYSIS_LIMIT", `${path}.labels`, `must contain 1..${cutAudioAnalysisLimits.maximumLabelsPerWindow} labels.`);
    }
    const seen = new Set<string>();
    const labels = item.labels.map((value, labelIndex) => {
      const labelPath = `${path}.labels[${labelIndex}]`, label = closed(value, labelPath, ["label", "scorePpm"]);
      if (typeof label.label !== "string" || !([...cutAudioAnalysisRoles, ...cutAudioAnalysisMoods] as readonly string[]).includes(label.label)) {
        fail("CUT_AUDIO_ANALYSIS_TAXONOMY", `${labelPath}.label`, "is not a role or mood in the closed v1 taxonomy.");
      }
      if (seen.has(label.label)) fail("CUT_AUDIO_ANALYSIS_DUPLICATE", `${labelPath}.label`, "duplicates an earlier semantic label.");
      seen.add(label.label);
      return Object.freeze({ label: label.label as CutAudioAnalysisLabel, scorePpm: positivePpm(label.scorePpm, `${labelPath}.scorePpm`) });
    });
    if (!labels.some((label) => (cutAudioAnalysisRoles as readonly string[]).includes(label.label))) {
      fail("CUT_AUDIO_ANALYSIS_TAXONOMY", `${path}.labels`, "must include at least one role label; mood labels are optional suggestions.");
    }
    for (let position = 1; position < labels.length; position += 1) {
      if (labelRank(labels[position - 1]!, labels[position]!) > 0) fail("CUT_AUDIO_ANALYSIS_ORDER", `${path}.labels`, "must be sorted by descending score and then label.");
    }
    return Object.freeze({
      range,
      rmsDbfsMilli,
      peakDbfsMilli,
      onsetStrengthPpm: ppm(item.onsetStrengthPpm, `${path}.onsetStrengthPpm`),
      labels: Object.freeze(labels),
    });
  }));
}

function parseGlobal(value: unknown, source: CutAudioAnalysisSource, policy: CutAudioAnalysisPolicy): CutAudioAnalysisGlobal {
  const path = "$.global", item = closed(value, path, ["tempoCandidates", "beats"]);
  if (!Array.isArray(item.tempoCandidates) || item.tempoCandidates.length > cutAudioAnalysisLimits.maximumTempoCandidates) {
    fail("CUT_AUDIO_ANALYSIS_LIMIT", `${path}.tempoCandidates`, `must contain at most ${cutAudioAnalysisLimits.maximumTempoCandidates} candidates.`);
  }
  const seenTempo = new Set<number>();
  const tempoCandidates = item.tempoCandidates.map((value, index) => {
    const candidatePath = `${path}.tempoCandidates[${index}]`, candidate = closed(value, candidatePath, ["bpmMilli", "scorePpm"]);
    const bpmMilli = integer(candidate.bpmMilli, `${candidatePath}.bpmMilli`, policy.tempoMinBpm * 1_000, policy.tempoMaxBpm * 1_000);
    if (seenTempo.has(bpmMilli)) fail("CUT_AUDIO_ANALYSIS_DUPLICATE", `${candidatePath}.bpmMilli`, "duplicates an earlier tempo candidate.");
    seenTempo.add(bpmMilli);
    return Object.freeze({ bpmMilli, scorePpm: positivePpm(candidate.scorePpm, `${candidatePath}.scorePpm`) });
  });
  for (let index = 1; index < tempoCandidates.length; index += 1) {
    const left = tempoCandidates[index - 1]!, right = tempoCandidates[index]!;
    if (left.scorePpm < right.scorePpm || (left.scorePpm === right.scorePpm && left.bpmMilli >= right.bpmMilli)) {
      fail("CUT_AUDIO_ANALYSIS_ORDER", `${path}.tempoCandidates`, "must be sorted by descending score and then ascending unique bpmMilli.");
    }
  }
  if (!Array.isArray(item.beats) || item.beats.length > cutAudioAnalysisLimits.maximumBeats) {
    fail("CUT_AUDIO_ANALYSIS_LIMIT", `${path}.beats`, `must contain at most ${cutAudioAnalysisLimits.maximumBeats} beats.`);
  }
  let previousSample = -1;
  const beats = item.beats.map((value, index) => {
    const beatPath = `${path}.beats[${index}]`, beat = closed(value, beatPath, ["sample", "scorePpm"]);
    const sample = integer(beat.sample, `${beatPath}.sample`, 0, source.durationSamples - 1);
    if (sample <= previousSample) fail("CUT_AUDIO_ANALYSIS_ORDER", `${beatPath}.sample`, "must be strictly later than the previous beat.");
    previousSample = sample;
    return Object.freeze({ sample, scorePpm: positivePpm(beat.scorePpm, `${beatPath}.scorePpm`) });
  });
  return Object.freeze({ tempoCandidates: Object.freeze(tempoCandidates), beats: Object.freeze(beats) });
}

function parseSections(value: unknown, source: CutAudioAnalysisSource) {
  if (!Array.isArray(value) || value.length > cutAudioAnalysisLimits.maximumSections) {
    fail("CUT_AUDIO_ANALYSIS_LIMIT", "$.sections", `must contain at most ${cutAudioAnalysisLimits.maximumSections} sections.`);
  }
  let previousEnd = -1;
  return Object.freeze(value.map((value, index): CutAudioAnalysisSection => {
    const path = `$.sections[${index}]`, item = closed(value, path, ["range", "role", "confidencePpm"], ["mood"]);
    const range = parseRange(item.range, `${path}.range`, source.durationSamples);
    if (range.startSample < previousEnd) fail("CUT_AUDIO_ANALYSIS_ORDER", `${path}.range`, "overlaps or precedes an earlier section.");
    previousEnd = range.endSample;
    if (typeof item.role !== "string" || !(cutAudioAnalysisRoles as readonly string[]).includes(item.role)) {
      fail("CUT_AUDIO_ANALYSIS_TAXONOMY", `${path}.role`, "is not a role in the closed v1 taxonomy.");
    }
    if (item.mood !== undefined && (typeof item.mood !== "string" || !(cutAudioAnalysisMoods as readonly string[]).includes(item.mood))) {
      fail("CUT_AUDIO_ANALYSIS_TAXONOMY", `${path}.mood`, "is not a mood in the closed v1 taxonomy.");
    }
    return Object.freeze({
      range,
      role: item.role as CutAudioAnalysisRole,
      ...(item.mood === undefined ? {} : { mood: item.mood as CutAudioAnalysisMood }),
      confidencePpm: positivePpm(item.confidencePpm, `${path}.confidencePpm`),
    });
  }));
}

export function cutAudioAnalysisSha256(body: CutAudioAnalysisBody) {
  return createHash("sha256").update(stableJsonStringify(body)).digest("hex");
}

export function parseCutAudioAnalysis(input: string | Uint8Array): CutAudioAnalysis {
  let decoded: unknown;
  try {
    decoded = parseStrictPackageJson(input, {
      limits: {
        maxInputBytes: cutAudioAnalysisLimits.maximumInputBytes,
        maxDepth: 12,
        maxNodes: 100_000,
        maxStringBytes: cutAudioAnalysisLimits.maximumStringBytes,
        maxTotalStringBytes: cutAudioAnalysisLimits.maximumTotalStringBytes,
      },
    });
  } catch (error) {
    fail("CUT_AUDIO_ANALYSIS_JSON", "$", error instanceof Error ? error.message : "invalid strict JSON.");
  }
  const item = closed(decoded, "$", [
    "format", "version", "semanticStatus", "source", "backend", "policy", "windows", "global", "sections", "analysisSha256",
  ]);
  if (item.format !== cutAudioAnalysisFormat || item.version !== cutAudioAnalysisVersion) {
    fail("CUT_AUDIO_ANALYSIS_VERSION", "$", `must be ${cutAudioAnalysisFormat} v${cutAudioAnalysisVersion}.`);
  }
  if (item.semanticStatus !== cutAudioAnalysisSemanticStatus) {
    fail("CUT_AUDIO_ANALYSIS_SEMANTIC_STATUS", "$.semanticStatus", `must be ${cutAudioAnalysisSemanticStatus}.`);
  }
  const source = parseSource(item.source), backend = parseBackend(item.backend), policy = parsePolicy(item.policy, source.durationSamples);
  const body: CutAudioAnalysisBody = Object.freeze({
    format: cutAudioAnalysisFormat,
    version: cutAudioAnalysisVersion,
    semanticStatus: cutAudioAnalysisSemanticStatus,
    source,
    backend,
    policy,
    windows: parseWindows(item.windows, source, policy),
    global: parseGlobal(item.global, source, policy),
    sections: parseSections(item.sections, source),
  });
  const expected = cutAudioAnalysisSha256(body), observed = digest(item.analysisSha256, "$.analysisSha256");
  if (observed !== expected) fail("CUT_AUDIO_ANALYSIS_IDENTITY", "$.analysisSha256", "does not match the canonical analysis body.");
  return Object.freeze({ ...body, analysisSha256: expected });
}
