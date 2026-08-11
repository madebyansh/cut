import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";
import {
  boundedDiagnosticString,
  stableJsonStringify,
} from "../core/stable";
import {
  defaultTranscriptLimits,
  validateCutTranscript,
  type CutTranscript,
} from "../interchange/transcript";
import { rational } from "../language/rational";
import { cutTranscriptHasUnsafeUnicodeScalar } from "../language/transcript-contract";

export type AudioTranscriptionSource = Readonly<{
  locator: string;
  bytes: number;
  sha256: string;
  streamIndex: number;
  sampleRate: number;
  durationSamples: number;
  normalizedPcmSha256: string;
}>;

export type AudioTranscriptionModelFile = Readonly<{
  locator: string;
  bytes: number;
  sha256: string;
  license: string;
}>;

export type AudioTranscriptionBackend = Readonly<{
  provider: string;
  model: string;
  revision: string;
  adapterSha256: string;
  modelFiles: readonly AudioTranscriptionModelFile[];
}>;

export type AudioTranscriptionSettings = Readonly<{
  language: string;
  temperatureMilli: number;
  noFallback: boolean;
}>;

export type NormalizedAudioTranscriptionWord = Readonly<{
  startSample: number;
  endSample: number;
  text: string;
  speaker?: string;
}>;

/**
 * Closed, provider-independent ASR result. All sample positions address the
 * selected source stream directly; floating-point seconds are never admitted.
 */
export type NormalizedAudioTranscription = Readonly<{
  source: AudioTranscriptionSource;
  backend: AudioTranscriptionBackend;
  settings: AudioTranscriptionSettings;
  words: readonly NormalizedAudioTranscriptionWord[];
}>;

export type CutAudioTranscriptionReceiptBody = Readonly<{
  format: "cut-audio-transcription-receipt";
  version: 1;
  /** Provider output is provenance only; the committed cut-transcript is authoritative. */
  authority: "committed-transcript";
  source: AudioTranscriptionSource;
  backend: AudioTranscriptionBackend;
  settings: AudioTranscriptionSettings;
  transcriptSha256: string;
}>;

export type CutAudioTranscriptionReceipt = CutAudioTranscriptionReceiptBody & Readonly<{
  /** SHA-256 of canonical receipt body JSON, excluding this field. */
  receiptSha256: string;
}>;

export type AudioTranscriptionMaterialization = Readonly<{
  transcript: CutTranscript;
  receipt: CutAudioTranscriptionReceipt;
}>;

export type AudioTranscriptionLimits = Readonly<{
  maxWords: number;
  maxWordTextBytes: number;
  maxTextBytes: number;
  maxSpeakerBytes: number;
  maxIdentityBytes: number;
  maxLicenseBytes: number;
  maxLocatorBytes: number;
  maxModelFiles: number;
}>;

export const defaultAudioTranscriptionLimits: AudioTranscriptionLimits = Object.freeze({
  maxWords: defaultTranscriptLimits.maxWords,
  maxWordTextBytes: defaultTranscriptLimits.maxWordTextBytes,
  maxTextBytes: defaultTranscriptLimits.maxTextBytes,
  maxSpeakerBytes: defaultTranscriptLimits.maxSpeakerBytes,
  maxIdentityBytes: 512,
  maxLicenseBytes: 1_024,
  maxLocatorBytes: 4_096,
  maxModelFiles: 64,
});

export type AudioTranscriptionErrorCode =
  | "CUT_AUDIO_TRANSCRIPTION_FORMAT"
  | "CUT_AUDIO_TRANSCRIPTION_LIMIT"
  | "CUT_AUDIO_TRANSCRIPTION_SOURCE"
  | "CUT_AUDIO_TRANSCRIPTION_BACKEND"
  | "CUT_AUDIO_TRANSCRIPTION_SETTINGS"
  | "CUT_AUDIO_TRANSCRIPTION_WORD";

export class AudioTranscriptionError extends Error {
  constructor(
    readonly code: AudioTranscriptionErrorCode,
    readonly path: string,
    detail: string,
  ) {
    super(`${code} at ${path}: ${detail}`);
    this.name = "AudioTranscriptionError";
  }
}

type DataRecord = Record<string, unknown>;

const digestPattern = /^[0-9a-f]{64}$/u;
const languagePattern = /^[a-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u;
const maximumStreamIndex = 65_535;
const maximumSampleRate = 768_000;
const maximumTemperatureMilli = 1_000;
const openingPunctuation = new Set(["(", "[", "{", "“", "‘", "«", "‹", "¿", "¡"]);
const closingPunctuation = new Set([".", ",", "!", "?", ";", ":", "%", ")", "]", "}", "”", "’", "»", "›"]);

function fail(
  code: AudioTranscriptionErrorCode,
  path: string,
  detail: string,
): never {
  throw new AudioTranscriptionError(code, path, detail);
}

function utf8Bytes(value: string) {
  return Buffer.byteLength(value, "utf8");
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fieldPath(path: string, field: string) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(field)
    ? `${path}.${field}`
    : `${path}[${boundedDiagnosticString(field)}]`;
}

/** Snapshot one ordinary JSON-like object without invoking accessors. */
function closedObject(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): DataRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)) {
    fail("CUT_AUDIO_TRANSCRIPTION_FORMAT", path, "must be one ordinary object.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("CUT_AUDIO_TRANSCRIPTION_FORMAT", path, "must be one ordinary object.");
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key === "symbol")) {
    fail("CUT_AUDIO_TRANSCRIPTION_FORMAT", `${path}[symbol]`, "symbol fields are not permitted.");
  }
  const names = ownKeys as string[];
  const allowed = new Set([...required, ...optional]);
  const unknown = names.filter((name) => !allowed.has(name)).sort(compareText)[0];
  if (unknown !== undefined) {
    fail("CUT_AUDIO_TRANSCRIPTION_FORMAT", fieldPath(path, unknown), "is not part of the closed transcription input.");
  }
  for (const name of required) {
    if (!names.includes(name)) {
      fail("CUT_AUDIO_TRANSCRIPTION_FORMAT", fieldPath(path, name), "is required.");
    }
  }
  const snapshot: DataRecord = Object.create(null) as DataRecord;
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      fail("CUT_AUDIO_TRANSCRIPTION_FORMAT", fieldPath(path, name), "must be an enumerable data field.");
    }
    snapshot[name] = descriptor.value;
  }
  return snapshot;
}

/** Snapshot one bounded dense ordinary array without invoking accessors. */
function closedArray(
  value: unknown,
  path: string,
  minimumLength: number,
  maximumLength: number,
): readonly unknown[] {
  if (value === null || typeof value !== "object" || isProxy(value) || !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype) {
    fail("CUT_AUDIO_TRANSCRIPTION_FORMAT", path, "must be one ordinary dense array.");
  }
  if (value.length < minimumLength) {
    fail("CUT_AUDIO_TRANSCRIPTION_FORMAT", path, `must contain at least ${minimumLength} item${minimumLength === 1 ? "" : "s"}.`);
  }
  if (value.length > maximumLength) {
    fail("CUT_AUDIO_TRANSCRIPTION_LIMIT", path, `exceeds its item limit (${maximumLength}).`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key)
      || Number(key) >= value.length) {
      fail(
        "CUT_AUDIO_TRANSCRIPTION_FORMAT",
        typeof key === "string" ? fieldPath(path, key) : `${path}[symbol]`,
        "is not part of the closed array.",
      );
    }
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      fail("CUT_AUDIO_TRANSCRIPTION_FORMAT", `${path}[${index}]`, "must be an enumerable data item; sparse arrays and accessors are forbidden.");
    }
    snapshot.push(descriptor.value);
  }
  return snapshot;
}

function resolveLimits(overrides: Partial<AudioTranscriptionLimits>): AudioTranscriptionLimits {
  const names = Object.keys(defaultAudioTranscriptionLimits) as Array<keyof AudioTranscriptionLimits>;
  const record = closedObject(overrides, "$.limits", [], names);
  const resolved = { ...defaultAudioTranscriptionLimits } as Record<keyof AudioTranscriptionLimits, number>;
  for (const name of names) {
    if (!Object.hasOwn(record, name)) continue;
    const value = record[name];
    const maximum = defaultAudioTranscriptionLimits[name];
    if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
      fail(
        "CUT_AUDIO_TRANSCRIPTION_LIMIT",
        `$.limits.${name}`,
        `must be an integer from 1 through ${maximum}.`,
      );
    }
    resolved[name] = value as number;
  }
  return Object.freeze(resolved);
}

function safeTrimmedText(
  value: unknown,
  path: string,
  maximumBytes: number,
  code: AudioTranscriptionErrorCode,
) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumBytes) {
    if (typeof value === "string" && value.length > maximumBytes) {
      fail("CUT_AUDIO_TRANSCRIPTION_LIMIT", path, `exceeds its UTF-8 byte limit (${maximumBytes}).`);
    }
    fail(code, path, "must be one non-empty safe Unicode string without surrounding whitespace.");
  }
  if (value !== value.trim() || cutTranscriptHasUnsafeUnicodeScalar(value)) {
    fail(code, path, "must be one non-empty safe Unicode string without surrounding whitespace.");
  }
  if (utf8Bytes(value) > maximumBytes) {
    fail("CUT_AUDIO_TRANSCRIPTION_LIMIT", path, `exceeds its UTF-8 byte limit (${maximumBytes}).`);
  }
  return value;
}

function digest(value: unknown, path: string, code: AudioTranscriptionErrorCode) {
  if (typeof value !== "string" || !digestPattern.test(value)) {
    fail(code, path, "must be one lowercase 64-digit SHA-256 digest.");
  }
  return value;
}

function positiveSafeInteger(value: unknown, path: string, code: AudioTranscriptionErrorCode) {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    fail(code, path, "must be one positive safe integer.");
  }
  return value as number;
}

function nonnegativeSafeInteger(
  value: unknown,
  path: string,
  maximum: number,
  code: AudioTranscriptionErrorCode,
) {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    fail(code, path, `must be an integer from 0 through ${maximum}.`);
  }
  return value as number;
}

function canonicalLocator(value: unknown, path: string, limits: AudioTranscriptionLimits) {
  const locator = safeTrimmedText(
    value,
    path,
    limits.maxLocatorBytes,
    "CUT_AUDIO_TRANSCRIPTION_SOURCE",
  );
  if (locator.startsWith("/") || locator.includes("\\")
    || locator.split("/").some((part) => part === "" || part === "." || part === "..")) {
    fail(
      "CUT_AUDIO_TRANSCRIPTION_SOURCE",
      path,
      "must be one canonical project-relative POSIX locator.",
    );
  }
  return locator;
}

function validateSource(value: unknown, limits: AudioTranscriptionLimits): AudioTranscriptionSource {
  const source = closedObject(value, "$.source", [
    "locator",
    "bytes",
    "sha256",
    "streamIndex",
    "sampleRate",
    "durationSamples",
    "normalizedPcmSha256",
  ]);
  const sampleRate = positiveSafeInteger(
    source.sampleRate,
    "$.source.sampleRate",
    "CUT_AUDIO_TRANSCRIPTION_SOURCE",
  );
  if (sampleRate > maximumSampleRate) {
    fail(
      "CUT_AUDIO_TRANSCRIPTION_SOURCE",
      "$.source.sampleRate",
      `must not exceed ${maximumSampleRate} Hz.`,
    );
  }
  return Object.freeze({
    locator: canonicalLocator(source.locator, "$.source.locator", limits),
    bytes: positiveSafeInteger(source.bytes, "$.source.bytes", "CUT_AUDIO_TRANSCRIPTION_SOURCE"),
    sha256: digest(source.sha256, "$.source.sha256", "CUT_AUDIO_TRANSCRIPTION_SOURCE"),
    streamIndex: nonnegativeSafeInteger(
      source.streamIndex,
      "$.source.streamIndex",
      maximumStreamIndex,
      "CUT_AUDIO_TRANSCRIPTION_SOURCE",
    ),
    sampleRate,
    durationSamples: positiveSafeInteger(
      source.durationSamples,
      "$.source.durationSamples",
      "CUT_AUDIO_TRANSCRIPTION_SOURCE",
    ),
    normalizedPcmSha256: digest(
      source.normalizedPcmSha256,
      "$.source.normalizedPcmSha256",
      "CUT_AUDIO_TRANSCRIPTION_SOURCE",
    ),
  });
}

function validateModelFile(
  value: unknown,
  index: number,
  limits: AudioTranscriptionLimits,
): AudioTranscriptionModelFile {
  const path = `$.backend.modelFiles[${index}]`;
  const file = closedObject(value, path, ["locator", "bytes", "sha256", "license"]);
  return Object.freeze({
    locator: canonicalLocator(file.locator, `${path}.locator`, limits),
    bytes: positiveSafeInteger(file.bytes, `${path}.bytes`, "CUT_AUDIO_TRANSCRIPTION_BACKEND"),
    sha256: digest(file.sha256, `${path}.sha256`, "CUT_AUDIO_TRANSCRIPTION_BACKEND"),
    license: safeTrimmedText(
      file.license,
      `${path}.license`,
      limits.maxLicenseBytes,
      "CUT_AUDIO_TRANSCRIPTION_BACKEND",
    ),
  });
}

function validateBackend(value: unknown, limits: AudioTranscriptionLimits): AudioTranscriptionBackend {
  const backend = closedObject(value, "$.backend", [
    "provider",
    "model",
    "revision",
    "adapterSha256",
    "modelFiles",
  ]);
  const modelFileValues = closedArray(
    backend.modelFiles,
    "$.backend.modelFiles",
    1,
    limits.maxModelFiles,
  );
  const modelFiles = modelFileValues
    .map((file, index) => validateModelFile(file, index, limits))
    .sort((left, right) => compareText(left.locator, right.locator));
  for (let index = 1; index < modelFiles.length; index += 1) {
    if (modelFiles[index - 1]!.locator === modelFiles[index]!.locator) {
      fail(
        "CUT_AUDIO_TRANSCRIPTION_BACKEND",
        `$.backend.modelFiles[${index}].locator`,
        "duplicates another model-file locator.",
      );
    }
  }
  return Object.freeze({
    provider: safeTrimmedText(
      backend.provider,
      "$.backend.provider",
      limits.maxIdentityBytes,
      "CUT_AUDIO_TRANSCRIPTION_BACKEND",
    ),
    model: safeTrimmedText(
      backend.model,
      "$.backend.model",
      limits.maxIdentityBytes,
      "CUT_AUDIO_TRANSCRIPTION_BACKEND",
    ),
    revision: safeTrimmedText(
      backend.revision,
      "$.backend.revision",
      limits.maxIdentityBytes,
      "CUT_AUDIO_TRANSCRIPTION_BACKEND",
    ),
    adapterSha256: digest(
      backend.adapterSha256,
      "$.backend.adapterSha256",
      "CUT_AUDIO_TRANSCRIPTION_BACKEND",
    ),
    modelFiles: Object.freeze(modelFiles),
  });
}

function validateSettings(value: unknown, limits: AudioTranscriptionLimits): AudioTranscriptionSettings {
  const settings = closedObject(value, "$.settings", [
    "language",
    "temperatureMilli",
    "noFallback",
  ]);
  const language = safeTrimmedText(
    settings.language,
    "$.settings.language",
    limits.maxIdentityBytes,
    "CUT_AUDIO_TRANSCRIPTION_SETTINGS",
  );
  if (!languagePattern.test(language)) {
    fail(
      "CUT_AUDIO_TRANSCRIPTION_SETTINGS",
      "$.settings.language",
      "must be one normalized BCP-47-like language tag with a lowercase primary subtag.",
    );
  }
  const temperatureMilli = nonnegativeSafeInteger(
    settings.temperatureMilli,
    "$.settings.temperatureMilli",
    maximumTemperatureMilli,
    "CUT_AUDIO_TRANSCRIPTION_SETTINGS",
  );
  if (typeof settings.noFallback !== "boolean") {
    fail(
      "CUT_AUDIO_TRANSCRIPTION_SETTINGS",
      "$.settings.noFallback",
      "must be a boolean.",
    );
  }
  return Object.freeze({ language, temperatureMilli, noFallback: settings.noFallback });
}

type ValidatedWord = Readonly<{
  startSample: number;
  endSample: number;
  text: string;
  speaker?: string;
}>;

function validateWordText(value: unknown, path: string, limits: AudioTranscriptionLimits) {
  const text = safeTrimmedText(
    value,
    path,
    limits.maxWordTextBytes,
    "CUT_AUDIO_TRANSCRIPTION_WORD",
  );
  if (/\s/u.test(text)) {
    fail(
      "CUT_AUDIO_TRANSCRIPTION_WORD",
      path,
      "must be one safe Unicode word without embedded whitespace.",
    );
  }
  return text;
}

function validateWords(
  value: unknown,
  source: AudioTranscriptionSource,
  limits: AudioTranscriptionLimits,
): readonly ValidatedWord[] {
  const values = closedArray(value, "$.words", 0, limits.maxWords);
  const words: ValidatedWord[] = [];
  let previousEnd = 0;
  let totalTextBytes = 0;
  for (let index = 0; index < values.length; index += 1) {
    const path = `$.words[${index}]`;
    const word = closedObject(values[index], path, ["startSample", "endSample", "text"], ["speaker"]);
    const startSample = nonnegativeSafeInteger(
      word.startSample,
      `${path}.startSample`,
      Number.MAX_SAFE_INTEGER,
      "CUT_AUDIO_TRANSCRIPTION_WORD",
    );
    const endSample = positiveSafeInteger(
      word.endSample,
      `${path}.endSample`,
      "CUT_AUDIO_TRANSCRIPTION_WORD",
    );
    if (endSample <= startSample) {
      fail(
        "CUT_AUDIO_TRANSCRIPTION_WORD",
        `${path}.endSample`,
        "must be strictly greater than startSample; zero and reversed spans are forbidden.",
      );
    }
    if (startSample < previousEnd) {
      fail(
        "CUT_AUDIO_TRANSCRIPTION_WORD",
        `${path}.startSample`,
        `overlaps $.words[${index - 1}].endSample.`,
      );
    }
    if (endSample > source.durationSamples) {
      fail(
        "CUT_AUDIO_TRANSCRIPTION_WORD",
        `${path}.endSample`,
        "exceeds $.source.durationSamples.",
      );
    }
    const text = validateWordText(word.text, `${path}.text`, limits);
    totalTextBytes += utf8Bytes(text);
    if (totalTextBytes > limits.maxTextBytes) {
      fail(
        "CUT_AUDIO_TRANSCRIPTION_LIMIT",
        `${path}.text`,
        `cumulative word text exceeds maxTextBytes (${limits.maxTextBytes}).`,
      );
    }
    const speaker = Object.hasOwn(word, "speaker")
      ? safeTrimmedText(
        word.speaker,
        `${path}.speaker`,
        limits.maxSpeakerBytes,
        "CUT_AUDIO_TRANSCRIPTION_WORD",
      )
      : undefined;
    words.push(Object.freeze({
      startSample,
      endSample,
      text,
      ...(speaker === undefined ? {} : { speaker }),
    }));
    previousEnd = endSample;
  }
  return Object.freeze(words);
}

function consistsOnlyOf(value: string, members: ReadonlySet<string>) {
  const characters = [...value];
  return characters.length > 0 && characters.every((character) => members.has(character));
}

/**
 * Whitespace is never trusted from a provider. Attach only an unambiguous
 * closed punctuation token, or a token following an unambiguous opener;
 * defaulting to a space avoids silently merging lexical words.
 */
function derivedJoin(
  index: number,
  current: ValidatedWord,
  previous: ValidatedWord | undefined,
): "none" | "space" {
  if (index === 0) return "none";
  if (consistsOnlyOf(current.text, closingPunctuation)) return "none";
  if (previous && consistsOnlyOf(previous.text, openingPunctuation)) return "none";
  return "space";
}

function canonicalSha256(value: unknown) {
  return createHash("sha256").update(stableJsonStringify(value), "utf8").digest("hex");
}

/**
 * Materialize a bounded normalized ASR observation into current cut-transcript
 * v1 and a byte-/settings-bound provenance receipt. This boundary never runs a
 * provider. Once the returned transcript is committed, that transcript—not a
 * later provider rerun, receipt, or reconstructed provider response—is the
 * sole authority for downstream editorial operations.
 */
export function materializeAudioTranscription(
  input: unknown,
  overrides: Partial<AudioTranscriptionLimits> = {},
): AudioTranscriptionMaterialization {
  const limits = resolveLimits(overrides);
  const value = closedObject(input, "$", ["source", "backend", "settings", "words"]);
  const source = validateSource(value.source, limits);
  const backend = validateBackend(value.backend, limits);
  const settings = validateSettings(value.settings, limits);
  const normalizedWords = validateWords(value.words, source, limits);
  const transcript = validateCutTranscript({
    format: "cut-transcript",
    version: 1,
    media: {
      sha256: source.sha256,
      audioStreamIndex: source.streamIndex,
      audioSampleRate: source.sampleRate,
      duration: rational(source.durationSamples, source.sampleRate),
    },
    words: normalizedWords.map((word, index) => ({
      id: `asr.${String(index + 1).padStart(6, "0")}`,
      start: rational(word.startSample, source.sampleRate),
      end: rational(word.endSample, source.sampleRate),
      text: word.text,
      join: derivedJoin(index, word, normalizedWords[index - 1]),
      ...(word.speaker === undefined ? {} : { speaker: word.speaker }),
    })),
  }, {
    maxWords: limits.maxWords,
    maxWordTextBytes: limits.maxWordTextBytes,
    maxTextBytes: limits.maxTextBytes,
    maxSpeakerBytes: limits.maxSpeakerBytes,
  });
  const body: CutAudioTranscriptionReceiptBody = Object.freeze({
    format: "cut-audio-transcription-receipt",
    version: 1,
    authority: "committed-transcript",
    source,
    backend,
    settings,
    transcriptSha256: canonicalSha256(transcript),
  });
  const receipt: CutAudioTranscriptionReceipt = Object.freeze({
    ...body,
    receiptSha256: canonicalSha256(body),
  });
  return Object.freeze({ transcript, receipt });
}
