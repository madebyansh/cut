import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";
import { stableJsonStringify } from "../core/stable";
import { analyzeCutAudioPcm } from "./dsp";
import {
  cutWaveNormalizePolicy,
  normalizeCutWaveForYamnet,
  type CutWaveNormalizationEvidence,
} from "./wave-normalize";
import {
  cutYamnetLocalPolicy,
  type CutYamnetLocalAnalysis,
} from "./yamnet-local";
import {
  cutYamnetAudioSetLabelMapSha256,
  mapCutYamnetAudioSetScores,
  type CutYamnetAudioSetEditorialSuggestions,
} from "./yamnet-taxonomy";

const sha256Pattern = /^[a-f0-9]{64}$/u;
const controlPattern = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

export const cutYamnetSemanticAnalysisPolicy = Object.freeze({
  format: "cut-audio-semantic-analysis-policy" as const,
  version: 1 as const,
  signalWindowSamples: 1_600 as const,
  silenceThresholdDbfsMilli: -50_000 as const,
  tempoMinBpm: 50 as const,
  tempoMaxBpm: 200 as const,
  sectionLaw: "contiguous-dsp-window-activity-runs-v1" as const,
  limitations: Object.freeze({
    semantics: "editorial-suggestions-not-ground-truth" as const,
    emotion: "no-emotion-inference-claim" as const,
    legal: "no-license-provenance-or-rights-claim" as const,
    providerAuthority:
      "upstream-provider-evidence-not-reauthenticated-by-pure-materializer-public-cli-is-authenticated-composition-boundary" as const,
  }),
});

export type CutYamnetSemanticAnalysisInput = Readonly<{
  source: Readonly<{ locator: string; bytes: number; sha256: string }>;
  sourceBytes: Buffer;
  normalization: CutWaveNormalizationEvidence;
  pcm: Buffer;
  providerAnalysis: CutYamnetLocalAnalysis;
  rawScoreBytes: Buffer;
  classMapBytes: Buffer;
}>;

type ProviderEvidence = CutYamnetLocalAnalysis;

type EmbeddedByteAuthority = Readonly<{
  encoding: "base64";
  bytes: number;
  sha256: string;
  data: string;
}>;

type SignalActivityWindow = Readonly<{
  range: Readonly<{ startSample: number; endSample: number }>;
  state: "active" | "silence";
  rmsDbfsMilli: number;
  peakDbfsMilli: number;
  meanAbsolutePpm: number;
}>;

type SignalOnset = Readonly<{
  range: Readonly<{ startSample: number; endSample: number }>;
  strengthPpm: number;
}>;

type SignalSection = Readonly<{
  range: Readonly<{ startSample: number; endSample: number }>;
  state: "active" | "silence";
  windowCount: number;
  maximumOnsetStrengthPpm: number;
}>;

export type CutYamnetSemanticAnalysisBody = Readonly<{
  format: "cut-audio-semantic-analysis";
  version: 1;
  source: Readonly<{ locator: string; bytes: number; sha256: string }>;
  normalization: CutYamnetSemanticAnalysisInput["normalization"];
  provider: ProviderEvidence;
  derivationInputs: Readonly<{
    rawScores: EmbeddedByteAuthority;
    classMap: EmbeddedByteAuthority;
  }>;
  taxonomy: CutYamnetAudioSetEditorialSuggestions;
  signal: Readonly<{
    policy: Readonly<{
      sampleRate: 16_000;
      windowSamples: number;
      hopSamples: number;
      silenceThresholdDbfsMilli: -50_000;
      tempoMinBpm: 50;
      tempoMaxBpm: 200;
      sectionLaw: "contiguous-dsp-window-activity-runs-v1";
    }>;
    activity: readonly SignalActivityWindow[];
    onsets: readonly SignalOnset[];
    tempo: Readonly<{
      candidates: readonly Readonly<{ bpmMilli: number; confidencePpm: number; lagWindows: number }>[];
      beatSamples: readonly number[];
    }>;
    sections: readonly SignalSection[];
  }>;
  limitations: typeof cutYamnetSemanticAnalysisPolicy.limitations;
}>;

export type CutYamnetSemanticAnalysis = CutYamnetSemanticAnalysisBody & Readonly<{ analysisSha256: string }>;

export class CutYamnetSemanticMaterializeError extends Error {
  constructor(readonly code: string, readonly path: string, message: string) {
    super(`${code} at ${path}: ${message}`);
    this.name = "CutYamnetSemanticMaterializeError";
  }
}

function fail(code: string, path: string, message: string): never {
  throw new CutYamnetSemanticMaterializeError(code, path, message);
}

function hash(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function plainRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) {
    fail("CUT_YAMNET_MATERIALIZE_TYPE", path, "must be one plain object.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("CUT_YAMNET_MATERIALIZE_TYPE", path, "must be one plain object.");
  }
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (typeof key === "symbol") {
      fail("CUT_YAMNET_MATERIALIZE_FIELD", path, "must not contain symbol properties.");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.get || descriptor.set) {
      fail("CUT_YAMNET_MATERIALIZE_TYPE", `${path}.${key}`, "must be one ordinary data property.");
    }
    if (!descriptor.enumerable) {
      fail("CUT_YAMNET_MATERIALIZE_FIELD", `${path}.${key}`, "must not be one hidden non-enumerable field.");
    }
  }
  return value as Record<string, unknown>;
}

function closedRecord(value: unknown, path: string, required: readonly string[]) {
  const item = plainRecord(value, path), allowed = new Set(required);
  for (const key of Object.getOwnPropertyNames(item)) {
    if (!allowed.has(key)) fail("CUT_YAMNET_MATERIALIZE_FIELD", `${path}.${key}`, "is outside the closed contract.");
  }
  for (const key of required) {
    if (!Object.hasOwn(item, key)) fail("CUT_YAMNET_MATERIALIZE_TYPE", `${path}.${key}`, "is required.");
  }
  return item;
}

function exact<T extends string | number | boolean>(value: unknown, expected: T, path: string): T {
  if (value !== expected) fail("CUT_YAMNET_MATERIALIZE_IDENTITY", path, `must be ${JSON.stringify(expected)}.`);
  return expected;
}

function integer(value: unknown, path: string, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    fail("CUT_YAMNET_MATERIALIZE_RANGE", path, `must be one safe integer within [${minimum},${maximum}].`);
  }
  return Number(value);
}

function digest(value: unknown, path: string) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    fail("CUT_YAMNET_MATERIALIZE_SHA256", path, "must be one lowercase SHA-256 digest.");
  }
  return value;
}

function text(value: unknown, path: string, maximumBytes = 4_096) {
  if (typeof value !== "string" || !value || value !== value.trim() || value.normalize("NFC") !== value
    || Buffer.byteLength(value, "utf8") > maximumBytes || controlPattern.test(value)) {
    fail("CUT_YAMNET_MATERIALIZE_TEXT", path, "must be non-empty, trimmed, NFC, bounded, and control-free text.");
  }
  return value;
}

function locator(value: unknown, path: string) {
  const result = text(value, path, 1_024);
  if (result.startsWith("/") || /^[A-Za-z]:/u.test(result) || /[\\%?#:]/u.test(result)) {
    fail("CUT_YAMNET_MATERIALIZE_LOCATOR", path, "must be one canonical relative POSIX locator.");
  }
  const segments = result.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".."
    || segment === "__proto__" || segment === "prototype" || segment === "constructor")) {
    fail("CUT_YAMNET_MATERIALIZE_LOCATOR", path, "contains an empty, dot, parent, or unsafe segment.");
  }
  return result;
}

function unitScore(value: unknown, path: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    fail("CUT_YAMNET_MATERIALIZE_SCORE", path, "must be one finite unit-interval score.");
  }
  return value;
}

function denseArray(value: unknown, path: string, expectedLength?: number) {
  if (utilTypes.isProxy(value)) {
    fail("CUT_YAMNET_MATERIALIZE_TYPE", path, "must not be one Proxy-backed array.");
  }
  if (!Array.isArray(value) || (expectedLength !== undefined && value.length !== expectedLength)) {
    fail(
      "CUT_YAMNET_MATERIALIZE_COUNT",
      path,
      expectedLength === undefined ? "must be one dense array." : `must contain exactly ${expectedLength} entries.`,
    );
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.get || descriptor.set) {
      fail("CUT_YAMNET_MATERIALIZE_TYPE", `${path}[${index}]`, "must be one present ordinary data element.");
    }
  }
  for (const key of Object.keys(descriptors)) {
    if (key !== "length" && !/^(0|[1-9][0-9]*)$/u.test(key)) {
      fail("CUT_YAMNET_MATERIALIZE_FIELD", `${path}.${key}`, "is outside the closed array contract.");
    }
  }
  if (Object.getOwnPropertySymbols(value).length) {
    fail("CUT_YAMNET_MATERIALIZE_FIELD", path, "must not contain symbol properties.");
  }
  return value as unknown[];
}

/**
 * Buffer authority is only the copied byte view. All string-keyed Buffer
 * metadata, enumerable or not, is deliberately outside this pure
 * materializer's authority contract and is never read, spread, serialized, or
 * propagated. Enumerating arbitrary string properties would also enumerate
 * every integer index and make the admitted 61 MiB WAVE boundary impractical.
 * Symbol metadata remains cheaply detectable and is rejected; all string
 * metadata is safely discarded by the immediate byte copy.
 */
function snapshotBuffer(value: unknown, path: string) {
  if (!Buffer.isBuffer(value) || utilTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Buffer.prototype
    || (typeof SharedArrayBuffer !== "undefined" && value.buffer instanceof SharedArrayBuffer)) {
    fail("CUT_YAMNET_MATERIALIZE_TYPE", path, "must be one ordinary non-proxy, non-shared Buffer.");
  }
  if (Object.getOwnPropertySymbols(value).length) {
    fail("CUT_YAMNET_MATERIALIZE_FIELD", path, "must not contain symbol metadata.");
  }
  return Buffer.from(value);
}

const canonicalBase64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const officialClassMapBytes = 6_230;

function embeddedByteAuthority(bytes: Buffer): EmbeddedByteAuthority {
  return Object.freeze({
    encoding: "base64" as const,
    bytes: bytes.byteLength,
    sha256: hash(bytes),
    data: bytes.toString("base64"),
  });
}

function parseEmbeddedByteAuthority(
  value: unknown,
  path: string,
  minimumBytes: number,
  maximumBytes: number,
) {
  const item = closedRecord(value, path, ["encoding", "bytes", "sha256", "data"]);
  exact(item.encoding, "base64", `${path}.encoding`);
  const bytes = integer(item.bytes, `${path}.bytes`, minimumBytes, maximumBytes);
  const sha256 = digest(item.sha256, `${path}.sha256`);
  if (typeof item.data !== "string" || item.data.length !== Math.ceil(bytes / 3) * 4
    || !canonicalBase64Pattern.test(item.data)) {
    fail("CUT_YAMNET_MATERIALIZE_BASE64", `${path}.data`, "must be canonical padded base64 for the declared byte count.");
  }
  const decoded = Buffer.from(item.data, "base64");
  if (decoded.byteLength !== bytes || decoded.toString("base64") !== item.data) {
    fail("CUT_YAMNET_MATERIALIZE_BASE64", `${path}.data`, "must round-trip through canonical padded base64 exactly.");
  }
  if (hash(decoded) !== sha256) {
    fail("CUT_YAMNET_MATERIALIZE_IDENTITY", `${path}.sha256`, "does not bind the embedded bytes.");
  }
  return Object.freeze({ identity: Object.freeze({ encoding: "base64" as const, bytes, sha256, data: item.data }), bytes: decoded });
}

function ordinaryJsonClone(value: unknown, path: string): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("CUT_YAMNET_MATERIALIZE_TYPE", path, "must contain only finite JSON numbers.");
    return value;
  }
  if (Array.isArray(value)) return denseArray(value, path).map((item, index) => ordinaryJsonClone(item, `${path}[${index}]`));
  const item = plainRecord(value, path), result: Record<string, unknown> = {};
  for (const key of Object.keys(item)) result[key] = ordinaryJsonClone(item[key], `${path}.${key}`);
  return result;
}

function parseClassMapBytes(bytes: Buffer) {
  let value: string;
  try { value = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return fail("CUT_YAMNET_MATERIALIZE_CLASS_MAP", "$.classMapBytes", "must be fatal UTF-8."); }
  if (bytes.includes(0) || !value.endsWith("\n") || value.includes("\r")) {
    fail("CUT_YAMNET_MATERIALIZE_CLASS_MAP", "$.classMapBytes", "must be LF-terminated text without NUL or CR bytes.");
  }
  const labels = value.slice(0, -1).split("\n");
  if (labels.length !== cutYamnetLocalPolicy.classCount) {
    fail("CUT_YAMNET_MATERIALIZE_CLASS_MAP", "$.classMapBytes", "must contain exactly 521 ordered labels.");
  }
  return Object.freeze(labels.map((label, index) => text(label, `$.classMapBytes[${index}]`, 512)));
}

function stableTop(scores: readonly number[], labels: readonly string[], count: number) {
  return Object.freeze(scores.map((score, classIndex) => Object.freeze({ classIndex, label: labels[classIndex]!, score }))
    .sort((left, right) => right.score - left.score || left.classIndex - right.classIndex)
    .slice(0, count));
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

function parseStringReceipt(value: unknown, path: string, fields: readonly string[]) {
  const item = closedRecord(value, path, fields), result: Record<string, string> = {};
  for (const field of fields) result[field] = digest(item[field], `${path}.${field}`);
  return result;
}

function parseDeclarations(value: unknown): CutYamnetLocalAnalysis["declarations"] {
  const item = closedRecord(value, "$.providerAnalysis.declarations", ["callerDeclared", "liteRtLicense", "model", "classMap"]);
  exact(item.callerDeclared, true, "$.providerAnalysis.declarations.callerDeclared");
  const parseDeclaredAsset = (asset: unknown, path: string) => {
    const entry = closedRecord(asset, path, ["name", "revision", "license", "provenance"]);
    return Object.freeze({
      name: text(entry.name, `${path}.name`, 512),
      revision: text(entry.revision, `${path}.revision`, 512),
      license: text(entry.license, `${path}.license`, 1_024),
      provenance: text(entry.provenance, `${path}.provenance`, 4_096),
    });
  };
  return Object.freeze({
    callerDeclared: true as const,
    liteRtLicense: text(item.liteRtLicense, "$.providerAnalysis.declarations.liteRtLicense", 1_024),
    model: parseDeclaredAsset(item.model, "$.providerAnalysis.declarations.model"),
    classMap: parseDeclaredAsset(item.classMap, "$.providerAnalysis.declarations.classMap"),
  });
}

function parseAndMatchTopClasses(
  value: unknown,
  path: string,
  expected: readonly Readonly<{ classIndex: number; label: string; score: number }>[],
) {
  const entries = denseArray(value, path, expected.length);
  let priorScore = Number.POSITIVE_INFINITY, priorIndex = -1;
  const seen = new Set<number>();
  return Object.freeze(entries.map((entryValue, index) => {
    const entryPath = `${path}[${index}]`;
    const entry = closedRecord(entryValue, entryPath, ["classIndex", "label", "score"]);
    const classIndex = integer(entry.classIndex, `${entryPath}.classIndex`, 0, cutYamnetLocalPolicy.classCount - 1);
    const label = text(entry.label, `${entryPath}.label`, 512);
    const score = unitScore(entry.score, `${entryPath}.score`);
    if (seen.has(classIndex)) fail("CUT_YAMNET_MATERIALIZE_DUPLICATE", `${entryPath}.classIndex`, "duplicates an earlier class.");
    if (score > priorScore || (score === priorScore && classIndex <= priorIndex)) {
      fail("CUT_YAMNET_MATERIALIZE_ORDER", entryPath, "must use descending score then ascending class-index order.");
    }
    seen.add(classIndex); priorScore = score; priorIndex = classIndex;
    const expectedEntry = expected[index]!;
    if (classIndex !== expectedEntry.classIndex) {
      fail("CUT_YAMNET_MATERIALIZE_TOPK", `${entryPath}.classIndex`, `must be recomputed class ${expectedEntry.classIndex}.`);
    }
    if (label !== expectedEntry.label) {
      fail("CUT_YAMNET_MATERIALIZE_TOPK", `${entryPath}.label`, "must equal the authenticated class-map label.");
    }
    if (score !== expectedEntry.score) {
      fail("CUT_YAMNET_MATERIALIZE_TOPK", `${entryPath}.score`, "must equal the exact recomputed raw score.");
    }
    return Object.freeze({ classIndex, label, score });
  }));
}

function parseProviderAnalysis(
  value: unknown,
  expectedInput: Readonly<{ samples: number; bytes: number; sha256: string }>,
  rawScoreBytes: Buffer,
  classMapBytes: Buffer,
  path = "$.providerAnalysis",
): ProviderEvidence {
  const item = closedRecord(value, path, [
    "format", "version", "provider", "input", "framing", "rawScores", "stderr", "topK",
    "aggregateTopClasses", "patches", "authorities", "declarations", "evidenceScope", "analysisSha256",
  ]);
  exact(item.format, "cut-yamnet-local-analysis", `${path}.format`);
  exact(item.version, 1, `${path}.version`);
  exact(item.provider, cutYamnetLocalPolicy.provider, `${path}.provider`);
  const input = closedRecord(item.input, `${path}.input`, ["sampleFormat", "sampleRate", "channels", "samples", "bytes", "sha256"]);
  exact(input.sampleFormat, cutYamnetLocalPolicy.sampleFormat, `${path}.input.sampleFormat`);
  exact(input.sampleRate, cutYamnetLocalPolicy.sampleRate, `${path}.input.sampleRate`);
  exact(input.channels, cutYamnetLocalPolicy.channels, `${path}.input.channels`);
  const samples = integer(input.samples, `${path}.input.samples`, 1, cutYamnetLocalPolicy.maximumDurationSamples);
  exact(input.bytes, samples * 4, `${path}.input.bytes`);
  const pcmSha256 = digest(input.sha256, `${path}.input.sha256`);
  if (samples !== expectedInput.samples || samples * 4 !== expectedInput.bytes || pcmSha256 !== expectedInput.sha256) {
    fail("CUT_YAMNET_MATERIALIZE_IDENTITY", `${path}.input`, "does not bind the exact normalized PCM identity.");
  }

  const framing = closedRecord(item.framing, `${path}.framing`, ["patchSamples", "patchHopSamples", "rightPadFinalPatch", "patchCount"]);
  exact(framing.patchSamples, cutYamnetLocalPolicy.patchSamples, `${path}.framing.patchSamples`);
  exact(framing.patchHopSamples, cutYamnetLocalPolicy.patchHopSamples, `${path}.framing.patchHopSamples`);
  exact(framing.rightPadFinalPatch, true, `${path}.framing.rightPadFinalPatch`);
  const expectedPatchCount = samples <= cutYamnetLocalPolicy.patchSamples
    ? 1
    : 1 + Math.ceil((samples - cutYamnetLocalPolicy.patchSamples) / cutYamnetLocalPolicy.patchHopSamples);
  const patchCount = integer(framing.patchCount, `${path}.framing.patchCount`, 1, 20);
  if (patchCount !== expectedPatchCount) {
    fail("CUT_YAMNET_MATERIALIZE_GEOMETRY", `${path}.framing.patchCount`, `must be ${expectedPatchCount}.`);
  }

  const rawScores = closedRecord(item.rawScores, `${path}.rawScores`, ["classCount", "sampleFormat", "bytes", "sha256"]);
  exact(rawScores.classCount, cutYamnetLocalPolicy.classCount, `${path}.rawScores.classCount`);
  exact(rawScores.sampleFormat, cutYamnetLocalPolicy.sampleFormat, `${path}.rawScores.sampleFormat`);
  const expectedScoreBytes = patchCount * cutYamnetLocalPolicy.classCount * 4;
  exact(rawScores.bytes, expectedScoreBytes, `${path}.rawScores.bytes`);
  const scoreSha256 = digest(rawScores.sha256, `${path}.rawScores.sha256`);
  if (rawScoreBytes.byteLength !== expectedScoreBytes || hash(rawScoreBytes) !== scoreSha256) {
    fail("CUT_YAMNET_MATERIALIZE_IDENTITY", `${path}.rawScores`, "does not bind the supplied raw score bytes.");
  }
  const authorityFields = [
    "pythonSha256", "adapterSha256", "environmentTreeSha256", "liteRtTreeSha256", "modelSha256", "classMapSha256",
  ] as const;
  const authorities = parseStringReceipt(item.authorities, `${path}.authorities`, authorityFields);
  if (authorities.classMapSha256 !== cutYamnetAudioSetLabelMapSha256) {
    fail("CUT_YAMNET_MATERIALIZE_IDENTITY", `${path}.authorities.classMapSha256`, "must bind the mapped official YAMNet AudioSet label map.");
  }
  if (hash(classMapBytes) !== authorities.classMapSha256) {
    fail("CUT_YAMNET_MATERIALIZE_IDENTITY", "$.classMapBytes", "must equal the provider's authenticated class-map bytes.");
  }

  const stderr = closedRecord(item.stderr, `${path}.stderr`, ["bytes", "sha256"]);
  const stderrBytes = integer(stderr.bytes, `${path}.stderr.bytes`, 0, cutYamnetLocalPolicy.maximumStderrBytes);
  const stderrSha256 = digest(stderr.sha256, `${path}.stderr.sha256`);
  const topK = integer(item.topK, `${path}.topK`, 1, cutYamnetLocalPolicy.maximumTopK);
  const labels = parseClassMapBytes(classMapBytes);
  const sums = Array<number>(cutYamnetLocalPolicy.classCount).fill(0);
  const expectedPatchTop: Array<ReturnType<typeof stableTop>> = [];
  for (let patchIndex = 0; patchIndex < patchCount; patchIndex += 1) {
    const scores: number[] = [];
    for (let classIndex = 0; classIndex < cutYamnetLocalPolicy.classCount; classIndex += 1) {
      const score = rawScoreBytes.readFloatLE((patchIndex * cutYamnetLocalPolicy.classCount + classIndex) * 4);
      unitScore(score, `$.rawScoreBytes[patch=${patchIndex},class=${classIndex}]`);
      scores.push(score);
      sums[classIndex]! += score;
    }
    expectedPatchTop.push(stableTop(scores, labels, topK));
  }
  const expectedAggregateTop = stableTop(sums.map((sum) => sum / patchCount), labels, topK);
  const aggregateTopClasses = parseAndMatchTopClasses(
    item.aggregateTopClasses,
    `${path}.aggregateTopClasses`,
    expectedAggregateTop,
  );
  const patchEntries = denseArray(item.patches, `${path}.patches`, patchCount);
  const patches = patchEntries.map((patchValue, patchIndex) => {
    const patchPath = `${path}.patches[${patchIndex}]`;
    const patch = closedRecord(patchValue, patchPath, ["patchIndex", "startSample", "validSamples", "topClasses"]);
    exact(patch.patchIndex, patchIndex, `${patchPath}.patchIndex`);
    const startSample = patchIndex * cutYamnetLocalPolicy.patchHopSamples;
    exact(patch.startSample, startSample, `${patchPath}.startSample`);
    const validSamples = Math.max(0, Math.min(cutYamnetLocalPolicy.patchSamples, samples - startSample));
    exact(patch.validSamples, validSamples, `${patchPath}.validSamples`);
    const topClasses = parseAndMatchTopClasses(patch.topClasses, `${patchPath}.topClasses`, expectedPatchTop[patchIndex]!);
    return Object.freeze({ patchIndex, startSample, validSamples, topClasses });
  });

  const declarations = parseDeclarations(item.declarations);
  const evidenceScopeItem = closedRecord(item.evidenceScope, `${path}.evidenceScope`, ["authority", "licenses", "locality", "inference"]);
  const evidenceScope = Object.freeze({
    authority: exact(evidenceScopeItem.authority, cutYamnetLocalPolicy.authorityScope, `${path}.evidenceScope.authority`),
    licenses: exact(evidenceScopeItem.licenses, cutYamnetLocalPolicy.licenseBoundary, `${path}.evidenceScope.licenses`),
    locality: exact(evidenceScopeItem.locality, cutYamnetLocalPolicy.localityBoundary, `${path}.evidenceScope.locality`),
    inference: exact(evidenceScopeItem.inference, cutYamnetLocalPolicy.inferenceBoundary, `${path}.evidenceScope.inference`),
  });

  const analysisSha256 = digest(item.analysisSha256, `${path}.analysisSha256`);
  const { analysisSha256: _ignored, ...body } = item;
  if (hash(stableJsonStringify(body)) !== analysisSha256) {
    fail("CUT_YAMNET_MATERIALIZE_IDENTITY", `${path}.analysisSha256`, "does not match the canonical provider analysis body.");
  }
  return Object.freeze({
    format: "cut-yamnet-local-analysis" as const,
    version: 1 as const,
    provider: cutYamnetLocalPolicy.provider,
    input: Object.freeze({
      sampleFormat: cutYamnetLocalPolicy.sampleFormat,
      sampleRate: cutYamnetLocalPolicy.sampleRate,
      channels: cutYamnetLocalPolicy.channels,
      samples,
      bytes: samples * 4,
      sha256: pcmSha256,
    }),
    framing: Object.freeze({
      patchSamples: cutYamnetLocalPolicy.patchSamples,
      patchHopSamples: cutYamnetLocalPolicy.patchHopSamples,
      rightPadFinalPatch: true as const,
      patchCount,
    }),
    rawScores: Object.freeze({
      classCount: cutYamnetLocalPolicy.classCount,
      sampleFormat: cutYamnetLocalPolicy.sampleFormat,
      bytes: expectedScoreBytes,
      sha256: scoreSha256,
    }),
    stderr: Object.freeze({ bytes: stderrBytes, sha256: stderrSha256 }),
    topK,
    aggregateTopClasses,
    patches: Object.freeze(patches),
    authorities: Object.freeze(authorities) as CutYamnetLocalAnalysis["authorities"],
    declarations,
    evidenceScope,
    analysisSha256,
  });
}

function parseInput(value: CutYamnetSemanticAnalysisInput) {
  const input = closedRecord(value, "$", [
    "source", "sourceBytes", "normalization", "pcm", "providerAnalysis", "rawScoreBytes", "classMapBytes",
  ]);
  const sourceBytes = snapshotBuffer(input.sourceBytes, "$.sourceBytes");
  const suppliedPcm = snapshotBuffer(input.pcm, "$.pcm");
  const rawScoreBytes = snapshotBuffer(input.rawScoreBytes, "$.rawScoreBytes");
  const classMapBytes = snapshotBuffer(input.classMapBytes, "$.classMapBytes");
  const sourceItem = closedRecord(input.source, "$.source", ["locator", "bytes", "sha256"]);
  const source = Object.freeze({
    locator: locator(sourceItem.locator, "$.source.locator"),
    bytes: integer(sourceItem.bytes, "$.source.bytes", 1, Number.MAX_SAFE_INTEGER),
    sha256: digest(sourceItem.sha256, "$.source.sha256"),
  });
  let recomputed: ReturnType<typeof normalizeCutWaveForYamnet>;
  try {
    recomputed = normalizeCutWaveForYamnet(sourceBytes, { bytes: source.bytes, sha256: source.sha256 });
  } catch (error) {
    fail(
      "CUT_YAMNET_MATERIALIZE_NORMALIZATION",
      "$.sourceBytes",
      error instanceof Error ? error.message : "normalization failed without one Error.",
    );
  }
  const suppliedNormalization = ordinaryJsonClone(input.normalization, "$.normalization");
  if (stableJsonStringify(suppliedNormalization) !== stableJsonStringify(recomputed.evidence)) {
    fail("CUT_YAMNET_MATERIALIZE_NORMALIZATION", "$.normalization", "must equal the independently recomputed full evidence.");
  }
  const normalization = recomputed.evidence;
  if (!suppliedPcm.equals(recomputed.pcmBytes)) {
    fail("CUT_YAMNET_MATERIALIZE_NORMALIZATION", "$.pcm", "must equal the independently recomputed normalized PCM bytes.");
  }
  const pcm = Buffer.from(recomputed.pcmBytes);
  const provider = parseProviderAnalysis(input.providerAnalysis, normalization.output, rawScoreBytes, classMapBytes);
  if (provider.input.sha256 !== normalization.output.sha256 || provider.input.samples !== normalization.output.samples) {
    fail("CUT_YAMNET_MATERIALIZE_IDENTITY", "$.providerAnalysis.input", "must equal the normalization authority.");
  }
  return Object.freeze({ source, normalization, pcm, rawScoreBytes, classMapBytes, provider });
}

function decodePcm(bytes: Buffer) {
  const samples = new Float32Array(bytes.byteLength / 4);
  for (let index = 0; index < samples.length; index += 1) samples[index] = bytes.readFloatLE(index * 4);
  return samples;
}

function signalSections(
  windows: readonly Readonly<{ startSample: number; endSample: number; rmsDbfsMilli: number; onsetStrengthPpm: number }>[],
) {
  const result: Array<{
    range: { startSample: number; endSample: number };
    state: "active" | "silence";
    windowCount: number;
    maximumOnsetStrengthPpm: number;
  }> = [];
  for (const window of windows) {
    const state = window.rmsDbfsMilli > cutYamnetSemanticAnalysisPolicy.silenceThresholdDbfsMilli ? "active" : "silence";
    const previous = result.at(-1);
    if (previous && previous.state === state && previous.range.endSample === window.startSample) {
      previous.range.endSample = window.endSample;
      previous.windowCount += 1;
      previous.maximumOnsetStrengthPpm = Math.max(previous.maximumOnsetStrengthPpm, window.onsetStrengthPpm);
    } else {
      result.push({
        range: { startSample: window.startSample, endSample: window.endSample },
        state,
        windowCount: 1,
        maximumOnsetStrengthPpm: window.onsetStrengthPpm,
      });
    }
  }
  return result;
}

function normalizationBoundaryExtendedTaps(frames: number, sourceRate: number, outputSamples: number) {
  let count = 0;
  for (let outputIndex = 0; outputIndex < outputSamples; outputIndex += 1) {
    const base = Math.floor(outputIndex * sourceRate / cutWaveNormalizePolicy.output.sampleRate);
    for (let tap = 0; tap < cutWaveNormalizePolicy.resampler.taps; tap += 1) {
      const candidate = base + tap - 15;
      if (candidate < 0 || candidate >= frames) count += 1;
    }
  }
  return count;
}

function verifyMaterializedNormalizationEvidence(value: unknown, source: Readonly<{ bytes: number; sha256: string }>) {
  const path = "$artifact.normalization";
  const item = closedRecord(value, path, ["format", "version", "source", "wave", "policy", "output", "work", "evidenceSha256"]);
  exact(item.format, "cut-wave-normalization-evidence", `${path}.format`);
  exact(item.version, 1, `${path}.version`);
  const evidenceSha256 = digest(item.evidenceSha256, `${path}.evidenceSha256`);
  const { evidenceSha256: _ignoredEvidenceSha256, ...body } = item;
  if (hash(stableJsonStringify(body)) !== evidenceSha256) {
    fail("CUT_YAMNET_MATERIALIZE_IDENTITY", `${path}.evidenceSha256`, "does not match the canonical normalization body.");
  }
  const sourceItem = closedRecord(item.source, `${path}.source`, ["bytes", "sha256"]);
  if (integer(sourceItem.bytes, `${path}.source.bytes`, 1, Number.MAX_SAFE_INTEGER) !== source.bytes
    || digest(sourceItem.sha256, `${path}.source.sha256`) !== source.sha256) {
    fail("CUT_YAMNET_MATERIALIZE_IDENTITY", `${path}.source`, "does not bind the exact semantic source bytes.");
  }
  const wave = closedRecord(item.wave, `${path}.wave`, [
    "container", "audioFormat", "formatVariant", "sampleRate", "channels", "bitsPerSample", "validBitsPerSample",
    "channelMask", "blockAlign", "byteRate", "frames", "dataBytes", "dataPadBytes", "duration",
  ]);
  exact(wave.container, "RIFF/WAVE", `${path}.wave.container`);
  exact(wave.audioFormat, 1, `${path}.wave.audioFormat`);
  if (wave.formatVariant !== "classic-pcm" && wave.formatVariant !== "extensible-pcm") {
    fail("CUT_YAMNET_MATERIALIZE_NORMALIZATION", `${path}.wave.formatVariant`, "must be classic-pcm or extensible-pcm.");
  }
  const sampleRate = integer(wave.sampleRate, `${path}.wave.sampleRate`, 8_000, 192_000);
  const channels = integer(wave.channels, `${path}.wave.channels`, 1, 8);
  const bitsPerSample = integer(wave.bitsPerSample, `${path}.wave.bitsPerSample`, 16, 32);
  if (![16, 24, 32].includes(bitsPerSample)) fail("CUT_YAMNET_MATERIALIZE_NORMALIZATION", `${path}.wave.bitsPerSample`, "must be 16, 24, or 32.");
  exact(wave.validBitsPerSample, bitsPerSample, `${path}.wave.validBitsPerSample`);
  const channelMask = integer(wave.channelMask, `${path}.wave.channelMask`, 0, 0x3ffff);
  if (wave.formatVariant === "classic-pcm" && channelMask !== 0) {
    fail("CUT_YAMNET_MATERIALIZE_NORMALIZATION", `${path}.wave.channelMask`, "classic PCM must use channel mask zero.");
  }
  if (wave.formatVariant === "extensible-pcm" && channelMask !== 0) {
    let remaining = channelMask >>> 0, speakers = 0;
    while (remaining !== 0) { remaining = (remaining & (remaining - 1)) >>> 0; speakers += 1; }
    if (speakers !== channels) fail("CUT_YAMNET_MATERIALIZE_NORMALIZATION", `${path}.wave.channelMask`, "must contain exactly one standard speaker bit per channel.");
  }
  const blockAlign = integer(wave.blockAlign, `${path}.wave.blockAlign`, 2, 32);
  if (blockAlign !== channels * bitsPerSample / 8) fail("CUT_YAMNET_MATERIALIZE_NORMALIZATION", `${path}.wave.blockAlign`, "does not match channels times container bytes.");
  const byteRate = integer(wave.byteRate, `${path}.wave.byteRate`, 16_000, 6_144_000);
  if (byteRate !== sampleRate * blockAlign) fail("CUT_YAMNET_MATERIALIZE_NORMALIZATION", `${path}.wave.byteRate`, "does not match sampleRate times blockAlign.");
  const frames = integer(wave.frames, `${path}.wave.frames`, 1, sampleRate * cutWaveNormalizePolicy.input.maximumDurationSeconds);
  const dataBytes = integer(wave.dataBytes, `${path}.wave.dataBytes`, blockAlign, 64 * 1024 * 1024);
  if (dataBytes !== frames * blockAlign) fail("CUT_YAMNET_MATERIALIZE_NORMALIZATION", `${path}.wave.dataBytes`, "does not match frames times blockAlign.");
  const dataPadBytes = integer(wave.dataPadBytes, `${path}.wave.dataPadBytes`, 0, 1);
  if (dataPadBytes !== (dataBytes & 1)) fail("CUT_YAMNET_MATERIALIZE_NORMALIZATION", `${path}.wave.dataPadBytes`, "does not match RIFF odd-byte padding.");
  const expectedSourceBytes = (wave.formatVariant === "classic-pcm" ? 44 : 68) + dataBytes + dataPadBytes;
  if (source.bytes !== expectedSourceBytes) fail("CUT_YAMNET_MATERIALIZE_NORMALIZATION", `${path}.source.bytes`, "does not match the closed fmt+data WAVE byte extent.");
  const duration = closedRecord(wave.duration, `${path}.wave.duration`, ["numeratorSamples", "denominatorSampleRate"]);
  exact(duration.numeratorSamples, frames, `${path}.wave.duration.numeratorSamples`);
  exact(duration.denominatorSampleRate, sampleRate, `${path}.wave.duration.denominatorSampleRate`);

  const policy = closedRecord(item.policy, `${path}.policy`, ["policySha256", "downmix", "resampler"]);
  exact(policy.policySha256, cutWaveNormalizePolicy.policySha256, `${path}.policy.policySha256`);
  exact(policy.downmix, cutWaveNormalizePolicy.downmix, `${path}.policy.downmix`);
  const expectedResampler = sampleRate === cutWaveNormalizePolicy.output.sampleRate
    ? "target-rate-identity-v1"
    : cutWaveNormalizePolicy.resampler.kernel;
  exact(policy.resampler, expectedResampler, `${path}.policy.resampler`);

  const output = closedRecord(item.output, `${path}.output`, ["sampleFormat", "sampleRate", "channels", "samples", "bytes", "sha256"]);
  exact(output.sampleFormat, "f32le", `${path}.output.sampleFormat`);
  exact(output.sampleRate, cutWaveNormalizePolicy.output.sampleRate, `${path}.output.sampleRate`);
  exact(output.channels, 1, `${path}.output.channels`);
  const expectedOutputSamples = Math.floor((frames * cutWaveNormalizePolicy.output.sampleRate + sampleRate - 1) / sampleRate);
  const outputSamples = integer(output.samples, `${path}.output.samples`, 1, cutYamnetLocalPolicy.maximumDurationSamples);
  if (outputSamples !== expectedOutputSamples) fail("CUT_YAMNET_MATERIALIZE_NORMALIZATION", `${path}.output.samples`, "does not match rational ceil resampling length.");
  exact(output.bytes, outputSamples * 4, `${path}.output.bytes`);
  digest(output.sha256, `${path}.output.sha256`);

  const work = closedRecord(item.work, `${path}.work`, [
    "inputFrames", "channelSampleReads", "downmixAdditions", "outputSamples", "candidateTapEvaluations",
    "coefficientEvaluations", "contributingCoefficients", "boundaryExtendedTaps", "multiplyAccumulateOperations",
    "saturatedOutputSamples", "float32Writes",
  ]);
  exact(work.inputFrames, frames, `${path}.work.inputFrames`);
  exact(work.channelSampleReads, frames * channels, `${path}.work.channelSampleReads`);
  exact(work.downmixAdditions, frames * channels, `${path}.work.downmixAdditions`);
  exact(work.outputSamples, outputSamples, `${path}.work.outputSamples`);
  exact(work.float32Writes, outputSamples, `${path}.work.float32Writes`);
  const tapWork = sampleRate === cutWaveNormalizePolicy.output.sampleRate ? 0 : outputSamples * cutWaveNormalizePolicy.resampler.taps;
  for (const field of ["candidateTapEvaluations", "coefficientEvaluations", "contributingCoefficients", "multiplyAccumulateOperations"] as const) {
    exact(work[field], tapWork, `${path}.work.${field}`);
  }
  const expectedBoundaryTaps = tapWork === 0 ? 0 : normalizationBoundaryExtendedTaps(frames, sampleRate, outputSamples);
  exact(work.boundaryExtendedTaps, expectedBoundaryTaps, `${path}.work.boundaryExtendedTaps`);
  integer(work.saturatedOutputSamples, `${path}.work.saturatedOutputSamples`, 0, outputSamples);
  return item as unknown as CutWaveNormalizationEvidence;
}

/**
 * Revalidates the derivation chain of one schema-validated materialized
 * semantic artifact without provider execution or filesystem access. The
 * embedded bytes are the exact replay boundary: provider top classes and CUT
 * taxonomy must independently recompute from them, while the upstream
 * provider analysis hash remains bound to its complete materialized body.
 */
export function verifyCutYamnetSemanticAnalysisDerivation(value: unknown): CutYamnetSemanticAnalysis {
  const snapshot = ordinaryJsonClone(value, "$artifact");
  const root = closedRecord(snapshot, "$artifact", [
    "format", "version", "source", "normalization", "provider", "derivationInputs",
    "taxonomy", "signal", "limitations", "analysisSha256",
  ]);
  exact(root.format, "cut-audio-semantic-analysis", "$artifact.format");
  exact(root.version, 1, "$artifact.version");
  const analysisSha256 = digest(root.analysisSha256, "$artifact.analysisSha256");
  const { analysisSha256: _ignoredAnalysisSha256, ...body } = root;
  if (hash(stableJsonStringify(body)) !== analysisSha256) {
    fail("CUT_YAMNET_MATERIALIZE_IDENTITY", "$artifact.analysisSha256", "does not match the canonical semantic-analysis body.");
  }

  const sourceItem = closedRecord(root.source, "$artifact.source", ["locator", "bytes", "sha256"]);
  const source = Object.freeze({
    locator: locator(sourceItem.locator, "$artifact.source.locator"),
    bytes: integer(sourceItem.bytes, "$artifact.source.bytes", 1, Number.MAX_SAFE_INTEGER),
    sha256: digest(sourceItem.sha256, "$artifact.source.sha256"),
  });
  const normalization = verifyMaterializedNormalizationEvidence(root.normalization, source);
  const output = closedRecord(
    normalization.output,
    "$artifact.normalization.output",
    ["sampleFormat", "sampleRate", "channels", "samples", "bytes", "sha256"],
  );
  exact(output.sampleFormat, "f32le", "$artifact.normalization.output.sampleFormat");
  exact(output.sampleRate, cutYamnetLocalPolicy.sampleRate, "$artifact.normalization.output.sampleRate");
  exact(output.channels, cutYamnetLocalPolicy.channels, "$artifact.normalization.output.channels");
  const outputSamples = integer(
    output.samples,
    "$artifact.normalization.output.samples",
    1,
    cutYamnetLocalPolicy.maximumDurationSamples,
  );
  const outputBytes = integer(
    output.bytes,
    "$artifact.normalization.output.bytes",
    4,
    cutYamnetLocalPolicy.maximumDurationSamples * 4,
  );
  if (outputBytes !== outputSamples * 4) {
    fail("CUT_YAMNET_MATERIALIZE_IDENTITY", "$artifact.normalization.output.bytes", "must contain exactly four bytes per normalized sample.");
  }
  const normalizedInput = Object.freeze({
    samples: outputSamples,
    bytes: outputBytes,
    sha256: digest(output.sha256, "$artifact.normalization.output.sha256"),
  });

  const derivationInputs = closedRecord(
    root.derivationInputs,
    "$artifact.derivationInputs",
    ["rawScores", "classMap"],
  );
  const rawScores = parseEmbeddedByteAuthority(
    derivationInputs.rawScores,
    "$artifact.derivationInputs.rawScores",
    cutYamnetLocalPolicy.classCount * 4,
    20 * cutYamnetLocalPolicy.classCount * 4,
  );
  const classMap = parseEmbeddedByteAuthority(
    derivationInputs.classMap,
    "$artifact.derivationInputs.classMap",
    officialClassMapBytes,
    officialClassMapBytes,
  );
  const provider = parseProviderAnalysis(root.provider, normalizedInput, rawScores.bytes, classMap.bytes, "$artifact.provider");
  const recomputedTaxonomy = mapCutYamnetAudioSetScores({
    labelMapSha256: provider.authorities.classMapSha256,
    sampleFormat: "f32le",
    classCount: cutYamnetLocalPolicy.classCount,
    scoreOrdering: "patch-major-class-index-ascending-v1",
    scoreBytes: rawScores.bytes,
    patches: provider.patches.map(({ startSample, validSamples }) => ({ startSample, validSamples })),
  });
  const taxonomy = ordinaryJsonClone(root.taxonomy, "$artifact.taxonomy");
  if (stableJsonStringify(taxonomy) !== stableJsonStringify(recomputedTaxonomy)) {
    fail("CUT_YAMNET_MATERIALIZE_DERIVATION", "$artifact.taxonomy", "must exactly equal taxonomy recomputed from embedded score bytes.");
  }
  const limitations = ordinaryJsonClone(root.limitations, "$artifact.limitations");
  if (stableJsonStringify(limitations) !== stableJsonStringify(cutYamnetSemanticAnalysisPolicy.limitations)) {
    fail("CUT_YAMNET_MATERIALIZE_IDENTITY", "$artifact.limitations", "must preserve the closed semantic limitations.");
  }
  return deepFreeze(canonicalClone(root)) as CutYamnetSemanticAnalysis;
}

/**
 * Binds exact normalized PCM and provider score evidence into one immutable,
 * canonical semantic-analysis object. Semantic output remains editorial help;
 * it never asserts emotion, licensing, provenance, rights, or ground truth.
 */
export function materializeCutYamnetSemanticAnalysis(
  value: CutYamnetSemanticAnalysisInput,
): CutYamnetSemanticAnalysis {
  const input = parseInput(value);
  const taxonomy = mapCutYamnetAudioSetScores({
    labelMapSha256: input.provider.authorities.classMapSha256,
    sampleFormat: "f32le",
    classCount: 521,
    scoreOrdering: "patch-major-class-index-ascending-v1",
    scoreBytes: input.rawScoreBytes,
    patches: input.provider.patches.map(({ startSample, validSamples }) => ({ startSample, validSamples })),
  });
  const windowSamples = Math.min(cutYamnetSemanticAnalysisPolicy.signalWindowSamples, input.normalization.output.samples);
  const dsp = analyzeCutAudioPcm(decodePcm(input.pcm), {
    sampleRate: 16_000,
    windowSamples,
    hopSamples: windowSamples,
    silenceThresholdDbfsMilli: cutYamnetSemanticAnalysisPolicy.silenceThresholdDbfsMilli,
    tempoMinBpm: cutYamnetSemanticAnalysisPolicy.tempoMinBpm,
    tempoMaxBpm: cutYamnetSemanticAnalysisPolicy.tempoMaxBpm,
  });
  const body: CutYamnetSemanticAnalysisBody = {
    format: "cut-audio-semantic-analysis",
    version: 1,
    source: input.source,
    normalization: input.normalization,
    provider: input.provider,
    derivationInputs: {
      rawScores: embeddedByteAuthority(input.rawScoreBytes),
      classMap: embeddedByteAuthority(input.classMapBytes),
    },
    taxonomy,
    signal: {
      policy: {
        sampleRate: 16_000,
        windowSamples,
        hopSamples: windowSamples,
        silenceThresholdDbfsMilli: cutYamnetSemanticAnalysisPolicy.silenceThresholdDbfsMilli,
        tempoMinBpm: cutYamnetSemanticAnalysisPolicy.tempoMinBpm,
        tempoMaxBpm: cutYamnetSemanticAnalysisPolicy.tempoMaxBpm,
        sectionLaw: cutYamnetSemanticAnalysisPolicy.sectionLaw,
      },
      activity: dsp.windows.map((window) => ({
        range: { startSample: window.startSample, endSample: window.endSample },
        state: window.rmsDbfsMilli > cutYamnetSemanticAnalysisPolicy.silenceThresholdDbfsMilli ? "active" : "silence",
        rmsDbfsMilli: window.rmsDbfsMilli,
        peakDbfsMilli: window.peakDbfsMilli,
        meanAbsolutePpm: window.meanAbsolutePpm,
      })),
      onsets: dsp.windows.filter((window) => window.onsetStrengthPpm > 0).map((window) => ({
        range: { startSample: window.startSample, endSample: window.endSample },
        strengthPpm: window.onsetStrengthPpm,
      })),
      tempo: { candidates: dsp.tempoCandidates, beatSamples: dsp.beatSamples },
      sections: signalSections(dsp.windows),
    },
    limitations: cutYamnetSemanticAnalysisPolicy.limitations,
  };
  const canonicalBody = deepFreeze(canonicalClone(body));
  const artifact = deepFreeze({
    ...canonicalBody,
    analysisSha256: hash(stableJsonStringify(canonicalBody)),
  });
  return verifyCutYamnetSemanticAnalysisDerivation(artifact);
}
