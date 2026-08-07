import { createHash } from "node:crypto";
import {
  compareRational,
  rational,
  subtractRational,
  type Rational,
  zeroRational,
} from "../language/rational";
import {
  cutTranscriptHasUnpairedUnicodeSurrogate,
  cutTranscriptHasUnsafeUnicodeScalar,
} from "../language/transcript-contract";

export type TranscriptMediaBinding = Readonly<{
  sha256: string;
  audioStreamIndex: number;
  audioSampleRate: number;
  duration: Rational;
  videoStreamIndex?: number;
  videoFrameRate?: Rational;
  /** Independently probed selected-video duration; required by TranscriptPicture. */
  videoDuration?: Rational;
  /**
   * Exact audio presentation anchor minus video presentation anchor, in
   * seconds. Absence canonically means zero; a present value must be nonzero.
   */
  audioVideoPresentationDelta?: Rational;
}>;

/**
 * `join` is the separator before this word in its authored transcript. The
 * first word must use `none`; a range selection deliberately omits the join
 * that preceded its first selected word.
 */
export type TranscriptWord = Readonly<{
  id: string;
  start: Rational;
  end: Rational;
  text: string;
  join: "none" | "space";
  speaker?: string;
}>;

export type CutTranscript = Readonly<{
  format: "cut-transcript";
  version: 1;
  media: TranscriptMediaBinding;
  words: readonly TranscriptWord[];
}>;

export type TranscriptSelectionRequest = Readonly<{
  from: string;
  through: string;
}>;

export type TranscriptSelection = Readonly<{
  from: string;
  through: string;
  selectedWordCount: number;
  selectedIdsSha256: string;
  text: string;
  sourceRange: Readonly<{
    start: Rational;
    end: Rational;
    duration: Rational;
  }>;
  media: TranscriptMediaBinding;
}>;

export type TranscriptLimits = Readonly<{
  maxBytes: number;
  maxWords: number;
  maxWordTextBytes: number;
  maxTextBytes: number;
  maxIdBytes: number;
  maxSpeakerBytes: number;
  maxRationalDigits: number;
  maxJsonDepth: number;
}>;

export type TranscriptDecodedLimits = Omit<TranscriptLimits, "maxBytes" | "maxJsonDepth">;

export const defaultTranscriptLimits: TranscriptLimits = Object.freeze({
  maxBytes: 16 * 1024 * 1024,
  maxWords: 250_000,
  maxWordTextBytes: 4_096,
  maxTextBytes: 8 * 1024 * 1024,
  maxIdBytes: 128,
  maxSpeakerBytes: 256,
  maxRationalDigits: 128,
  maxJsonDepth: 64,
});

export type TranscriptErrorCode =
  | "CUT_TRANSCRIPT_FORMAT"
  | "CUT_TRANSCRIPT_LIMIT"
  | "CUT_TRANSCRIPT_ID"
  | "CUT_TRANSCRIPT_TIME"
  | "CUT_TRANSCRIPT_GRID"
  | "CUT_TRANSCRIPT_MEDIA";

export class TranscriptInterchangeError extends Error {
  constructor(
    readonly code: TranscriptErrorCode,
    readonly path: string,
    detail: string,
  ) {
    super(`${code} at ${path}: ${detail}`);
    this.name = "TranscriptInterchangeError";
  }
}

type JsonObject = Record<string, unknown>;

const maximumStreamIndex = 65_535;
const maximumAudioSampleRate = 768_000;
const stableId = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const canonicalInteger = /^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/;
const canonicalPositiveInteger = /^[1-9][0-9]*$/;

function fail(code: TranscriptErrorCode, path: string, detail: string): never {
  throw new TranscriptInterchangeError(code, path, detail);
}

function utf8Bytes(value: string) {
  return Buffer.byteLength(value, "utf8");
}

function isObject(value: unknown): value is JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedKey(value: string) {
  if (value.length <= 80 && utf8Bytes(value) <= 480) return JSON.stringify(value);
  let prefix = "", count = 0;
  for (const character of value) {
    if (count === 80) break;
    prefix += character;
    count += 1;
  }
  return `${JSON.stringify(prefix)}…<${value.length} UTF-16 code units>`;
}

function objectValue(value: unknown, path: string) {
  if (!isObject(value)) fail("CUT_TRANSCRIPT_FORMAT", path, "must be an object.");
  return value;
}

function closedObject(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
) {
  const result = objectValue(value, path);
  for (const field of required) {
    if (!Object.hasOwn(result, field)) fail("CUT_TRANSCRIPT_FORMAT", `${path}.${field}`, "is required.");
  }
  const allowed = new Set([...required, ...optional]);
  let unknown: string | undefined;
  for (const field of Object.keys(result)) {
    if (!allowed.has(field) && (unknown === undefined || field < unknown)) unknown = field;
  }
  if (unknown !== undefined) {
    fail("CUT_TRANSCRIPT_FORMAT", `${path}[${boundedKey(unknown)}]`, "is not part of cut-transcript v1.");
  }
  return result;
}

/**
 * A bounded lexical JSON pass preserves the native parser's semantics while
 * rejecting duplicate object keys before JSON.parse can collapse them. It
 * deliberately captures object keys only; ordinary string payloads are
 * skipped without allocating a second copy.
 */
function scanJsonDocument(source: string, maximumDepth: number) {
  let cursor = 0;
  const whitespace = new Set([" ", "\t", "\n", "\r"]);
  const escapedCharacters: Record<string, string> = {
    '"': '"',
    "\\": "\\",
    "/": "/",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
  };

  const syntax = (): never => fail("CUT_TRANSCRIPT_FORMAT", "$", "input must be valid JSON.");
  const skipWhitespace = () => {
    while (cursor < source.length && whitespace.has(source[cursor]!)) cursor += 1;
  };
  const pathForKey = (path: string, key: string) => (
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `${path}.${key}` : `${path}[${boundedKey(key)}]`
  );
  const scanString = (capture: boolean) => {
    if (source[cursor] !== '"') syntax();
    cursor += 1;
    let result = "";
    while (cursor < source.length) {
      const character = source[cursor++]!;
      if (character === '"') return result;
      if (character.charCodeAt(0) <= 0x1f) syntax();
      if (character !== "\\") {
        if (capture) result += character;
        continue;
      }
      if (cursor >= source.length) syntax();
      const escaped = source[cursor++]!;
      if (Object.hasOwn(escapedCharacters, escaped)) {
        if (capture) result += escapedCharacters[escaped]!;
        continue;
      }
      if (escaped !== "u") syntax();
      const digits = source.slice(cursor, cursor + 4);
      if (!/^[0-9a-fA-F]{4}$/.test(digits)) syntax();
      cursor += 4;
      if (capture) result += String.fromCharCode(Number.parseInt(digits, 16));
    }
    return syntax();
  };
  const scanNumber = () => {
    if (source[cursor] === "-") cursor += 1;
    if (source[cursor] === "0") {
      cursor += 1;
    } else {
      if (!/[1-9]/.test(source[cursor] ?? "")) syntax();
      while (/[0-9]/.test(source[cursor] ?? "")) cursor += 1;
    }
    if (source[cursor] === ".") {
      cursor += 1;
      if (!/[0-9]/.test(source[cursor] ?? "")) syntax();
      while (/[0-9]/.test(source[cursor] ?? "")) cursor += 1;
    }
    if (source[cursor] === "e" || source[cursor] === "E") {
      cursor += 1;
      if (source[cursor] === "+" || source[cursor] === "-") cursor += 1;
      if (!/[0-9]/.test(source[cursor] ?? "")) syntax();
      while (/[0-9]/.test(source[cursor] ?? "")) cursor += 1;
    }
  };
  const scanValue = (path: string, depth: number): void => {
    if (depth > maximumDepth) {
      fail("CUT_TRANSCRIPT_LIMIT", path, `JSON nesting exceeds maxJsonDepth (${maximumDepth}).`);
    }
    skipWhitespace();
    const initial = source[cursor];
    if (initial === '"') {
      scanString(false);
      return;
    }
    if (initial === "{") {
      cursor += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (source[cursor] === "}") {
        cursor += 1;
        return;
      }
      while (cursor < source.length) {
        const key = scanString(true);
        const childPath = pathForKey(path, key);
        if (keys.has(key)) {
          fail("CUT_TRANSCRIPT_FORMAT", childPath, `duplicates JSON object key ${boundedKey(key)}.`);
        }
        keys.add(key);
        skipWhitespace();
        if (source[cursor] !== ":") syntax();
        cursor += 1;
        scanValue(childPath, depth + 1);
        skipWhitespace();
        if (source[cursor] === "}") {
          cursor += 1;
          return;
        }
        if (source[cursor] !== ",") syntax();
        cursor += 1;
        skipWhitespace();
      }
      syntax();
    }
    if (initial === "[") {
      cursor += 1;
      skipWhitespace();
      if (source[cursor] === "]") {
        cursor += 1;
        return;
      }
      let index = 0;
      while (cursor < source.length) {
        scanValue(`${path}[${index}]`, depth + 1);
        index += 1;
        skipWhitespace();
        if (source[cursor] === "]") {
          cursor += 1;
          return;
        }
        if (source[cursor] !== ",") syntax();
        cursor += 1;
        skipWhitespace();
      }
      syntax();
    }
    if (source.startsWith("true", cursor)) {
      cursor += 4;
      return;
    }
    if (source.startsWith("false", cursor)) {
      cursor += 5;
      return;
    }
    if (source.startsWith("null", cursor)) {
      cursor += 4;
      return;
    }
    if (initial === "-" || /[0-9]/.test(initial ?? "")) {
      scanNumber();
      return;
    }
    syntax();
  };

  scanValue("$", 1);
  skipWhitespace();
  if (cursor !== source.length) syntax();
}

function resolveLimits(
  overrides: Partial<TranscriptLimits> | Partial<TranscriptDecodedLimits>,
  includeParseLimits: boolean,
): TranscriptLimits {
  if (!isObject(overrides)) fail("CUT_TRANSCRIPT_LIMIT", "$.limits", "must be an object.");
  const known = Object.keys(defaultTranscriptLimits)
    .filter((name) => includeParseLimits || (name !== "maxBytes" && name !== "maxJsonDepth"));
  let unknown: string | undefined;
  for (const field of Object.keys(overrides)) {
    if (!known.includes(field) && (unknown === undefined || field < unknown)) unknown = field;
  }
  if (unknown !== undefined) fail("CUT_TRANSCRIPT_LIMIT", `$.limits[${boundedKey(unknown)}]`, "is not a supported limit.");
  const resolved = { ...defaultTranscriptLimits, ...overrides };
  for (const name of known as Array<keyof TranscriptLimits>) {
    const value = resolved[name];
    const maximum = defaultTranscriptLimits[name];
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      fail("CUT_TRANSCRIPT_LIMIT", `$.limits.${name}`, `must be an integer from 1 through ${maximum}.`);
    }
  }
  return Object.freeze(resolved);
}

function decodeJsonInput(input: string | Uint8Array, limits: TranscriptLimits) {
  if (typeof input !== "string" && !(input instanceof Uint8Array)) {
    fail("CUT_TRANSCRIPT_FORMAT", "$", "input must be a UTF-8 string or Uint8Array.");
  }
  const byteLength = typeof input === "string" ? utf8Bytes(input) : input.byteLength;
  if (byteLength > limits.maxBytes) {
    fail("CUT_TRANSCRIPT_LIMIT", "$", `input exceeds maxBytes (${limits.maxBytes}).`);
  }
  let decoded: string;
  if (typeof input === "string") {
    decoded = input;
  } else {
    try {
      decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input);
    } catch {
      fail("CUT_TRANSCRIPT_FORMAT", "$", "input is not valid UTF-8.");
    }
  }
  if (cutTranscriptHasUnpairedUnicodeSurrogate(decoded)) fail("CUT_TRANSCRIPT_FORMAT", "$", "input contains an unpaired Unicode surrogate.");
  if (decoded.startsWith("\ufeff")) fail("CUT_TRANSCRIPT_FORMAT", "$", "a UTF-8 BOM is not permitted.");
  scanJsonDocument(decoded, limits.maxJsonDepth);
  try {
    return JSON.parse(decoded) as unknown;
  } catch {
    fail("CUT_TRANSCRIPT_FORMAT", "$", "input must be valid JSON.");
  }
}

function canonicalRational(value: unknown, path: string, limits: TranscriptLimits): Rational {
  const record = closedObject(value, path, ["numerator", "denominator"]);
  if (typeof record.numerator !== "string") {
    fail("CUT_TRANSCRIPT_TIME", `${path}.numerator`, "must be a canonical integer string; -0 and leading zeros are forbidden.");
  }
  const numeratorDigits = record.numerator.startsWith("-") ? record.numerator.length - 1 : record.numerator.length;
  if (numeratorDigits > limits.maxRationalDigits) {
    fail("CUT_TRANSCRIPT_LIMIT", `${path}.numerator`, `exceeds maxRationalDigits (${limits.maxRationalDigits}).`);
  }
  if (!canonicalInteger.test(record.numerator)) {
    fail("CUT_TRANSCRIPT_TIME", `${path}.numerator`, "must be a canonical integer string; -0 and leading zeros are forbidden.");
  }
  if (typeof record.denominator !== "string") {
    fail("CUT_TRANSCRIPT_TIME", `${path}.denominator`, "must be a canonical positive integer string.");
  }
  if (record.denominator.length > limits.maxRationalDigits) {
    fail("CUT_TRANSCRIPT_LIMIT", `${path}.denominator`, `exceeds maxRationalDigits (${limits.maxRationalDigits}).`);
  }
  if (!canonicalPositiveInteger.test(record.denominator)) {
    fail("CUT_TRANSCRIPT_TIME", `${path}.denominator`, "must be a canonical positive integer string.");
  }
  const normalized = rational(record.numerator, record.denominator);
  if (normalized.numerator !== record.numerator || normalized.denominator !== record.denominator) {
    fail("CUT_TRANSCRIPT_TIME", path, "must be a reduced canonical rational.");
  }
  return Object.freeze(normalized);
}

function preflightId(value: unknown, path: string, limits: TranscriptLimits) {
  if (typeof value !== "string") {
    fail("CUT_TRANSCRIPT_ID", path, "must be a stable ASCII identifier using letters, digits, dot, underscore, colon, or hyphen.");
  }
  if (value.length > limits.maxIdBytes) {
    fail("CUT_TRANSCRIPT_LIMIT", path, `exceeds maxIdBytes (${limits.maxIdBytes}).`);
  }
  if (!stableId.test(value)) {
    fail("CUT_TRANSCRIPT_ID", path, "must be a stable ASCII identifier using letters, digits, dot, underscore, colon, or hyphen.");
  }
  if (utf8Bytes(value) > limits.maxIdBytes) {
    fail("CUT_TRANSCRIPT_LIMIT", path, `exceeds maxIdBytes (${limits.maxIdBytes}).`);
  }
  return value;
}

function preflightText(value: unknown, path: string, limits: TranscriptLimits) {
  if (typeof value !== "string" || value.length === 0) {
    fail("CUT_TRANSCRIPT_FORMAT", path, "must be one non-empty safe Unicode word without whitespace.");
  }
  if (value.length > limits.maxWordTextBytes) {
    fail("CUT_TRANSCRIPT_LIMIT", path, `exceeds maxWordTextBytes (${limits.maxWordTextBytes}).`);
  }
  if (
    cutTranscriptHasUnsafeUnicodeScalar(value)
    || /\s/u.test(value)
  ) {
    fail("CUT_TRANSCRIPT_FORMAT", path, "must be one non-empty safe Unicode word without whitespace.");
  }
  const byteLength = utf8Bytes(value);
  if (byteLength > limits.maxWordTextBytes) {
    fail("CUT_TRANSCRIPT_LIMIT", path, `exceeds maxWordTextBytes (${limits.maxWordTextBytes}).`);
  }
  return { value, byteLength };
}

function preflightSpeaker(value: unknown, path: string, limits: TranscriptLimits) {
  if (typeof value !== "string" || value.length === 0) {
    fail("CUT_TRANSCRIPT_FORMAT", path, "must be a non-empty safe Unicode label without surrounding whitespace.");
  }
  if (value.length > limits.maxSpeakerBytes) {
    fail("CUT_TRANSCRIPT_LIMIT", path, `exceeds maxSpeakerBytes (${limits.maxSpeakerBytes}).`);
  }
  if (
    value !== value.trim()
    || cutTranscriptHasUnsafeUnicodeScalar(value)
  ) {
    fail("CUT_TRANSCRIPT_FORMAT", path, "must be a non-empty safe Unicode label without surrounding whitespace.");
  }
  if (utf8Bytes(value) > limits.maxSpeakerBytes) {
    fail("CUT_TRANSCRIPT_LIMIT", path, `exceeds maxSpeakerBytes (${limits.maxSpeakerBytes}).`);
  }
  return value;
}

type PreflightWord = Readonly<{
  record: JsonObject;
  id: string;
  text: string;
  join: "none" | "space";
  speaker?: string;
}>;

function preflightWords(value: unknown, limits: TranscriptLimits) {
  if (!Array.isArray(value)) fail("CUT_TRANSCRIPT_FORMAT", "$.words", "must be an array.");
  if (value.length > limits.maxWords) {
    fail("CUT_TRANSCRIPT_LIMIT", "$.words", `exceeds maxWords (${limits.maxWords}).`);
  }
  const result: PreflightWord[] = [];
  const seen = new Set<string>();
  let totalTextBytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const path = `$.words[${index}]`;
    const record = closedObject(value[index], path, ["id", "start", "end", "text", "join"], ["speaker"]);
    const id = preflightId(record.id, `${path}.id`, limits);
    if (seen.has(id)) fail("CUT_TRANSCRIPT_ID", `${path}.id`, `duplicates transcript word ID ${JSON.stringify(id)}.`);
    seen.add(id);
    const text = preflightText(record.text, `${path}.text`, limits);
    totalTextBytes += text.byteLength;
    if (totalTextBytes > limits.maxTextBytes) {
      fail("CUT_TRANSCRIPT_LIMIT", `${path}.text`, `cumulative word text exceeds maxTextBytes (${limits.maxTextBytes}).`);
    }
    if (record.join !== "none" && record.join !== "space") {
      fail("CUT_TRANSCRIPT_FORMAT", `${path}.join`, "must be “none” or “space”.");
    }
    const speaker = Object.hasOwn(record, "speaker")
      ? preflightSpeaker(record.speaker, `${path}.speaker`, limits)
      : undefined;
    result.push(Object.freeze({
      record,
      id,
      text: text.value,
      join: record.join,
      ...(speaker === undefined ? {} : { speaker }),
    }));
  }
  if (result[0]?.join === "space") {
    fail("CUT_TRANSCRIPT_FORMAT", "$.words[0].join", "must be “none” because no word precedes the first word.");
  }
  return result;
}

function nonnegativeSafeInteger(value: unknown, path: string, maximum: number) {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    fail("CUT_TRANSCRIPT_MEDIA", path, `must be an integer from 0 through ${maximum}.`);
  }
  return value as number;
}

function validateMedia(value: unknown, limits: TranscriptLimits): TranscriptMediaBinding {
  const record = closedObject(
    value,
    "$.media",
    ["sha256", "audioStreamIndex", "audioSampleRate", "duration"],
    [
      "videoStreamIndex",
      "videoFrameRate",
      "videoDuration",
      "audioVideoPresentationDelta",
    ],
  );
  if (typeof record.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(record.sha256)) {
    fail("CUT_TRANSCRIPT_MEDIA", "$.media.sha256", "must be a lowercase 64-digit SHA-256.");
  }
  const audioStreamIndex = nonnegativeSafeInteger(
    record.audioStreamIndex,
    "$.media.audioStreamIndex",
    maximumStreamIndex,
  );
  if (
    !Number.isSafeInteger(record.audioSampleRate)
    || (record.audioSampleRate as number) < 1
    || (record.audioSampleRate as number) > maximumAudioSampleRate
  ) {
    fail(
      "CUT_TRANSCRIPT_MEDIA",
      "$.media.audioSampleRate",
      `must be an integer from 1 through ${maximumAudioSampleRate}.`,
    );
  }
  const duration = canonicalRational(record.duration, "$.media.duration", limits);
  if (compareRational(duration, zeroRational) <= 0) {
    fail("CUT_TRANSCRIPT_TIME", "$.media.duration", "must be positive.");
  }
  const hasVideoStream = Object.hasOwn(record, "videoStreamIndex");
  const hasVideoRate = Object.hasOwn(record, "videoFrameRate");
  const hasVideoDuration = Object.hasOwn(record, "videoDuration");
  const hasPresentationDelta = Object.hasOwn(
    record,
    "audioVideoPresentationDelta",
  );
  if (hasVideoStream !== hasVideoRate) {
    const missing = hasVideoStream ? "videoFrameRate" : "videoStreamIndex";
    fail("CUT_TRANSCRIPT_MEDIA", `$.media.${missing}`, "is required when the other video provenance field is present.");
  }
  if (hasVideoDuration && !hasVideoStream) {
    fail("CUT_TRANSCRIPT_MEDIA", "$.media.videoStreamIndex", "is required when videoDuration is present.");
  }
  if (hasPresentationDelta && !hasVideoStream) {
    fail(
      "CUT_TRANSCRIPT_MEDIA",
      "$.media.videoStreamIndex",
      "is required when audioVideoPresentationDelta is present.",
    );
  }
  if (hasPresentationDelta && !hasVideoDuration) {
    fail(
      "CUT_TRANSCRIPT_MEDIA",
      "$.media.videoDuration",
      "is required when audioVideoPresentationDelta is present.",
    );
  }
  if (!hasVideoStream) {
    return Object.freeze({
      sha256: record.sha256,
      audioStreamIndex,
      audioSampleRate: record.audioSampleRate as number,
      duration,
    });
  }
  const videoStreamIndex = nonnegativeSafeInteger(
    record.videoStreamIndex,
    "$.media.videoStreamIndex",
    maximumStreamIndex,
  );
  if (videoStreamIndex === audioStreamIndex) {
    fail("CUT_TRANSCRIPT_MEDIA", "$.media.videoStreamIndex", "cannot identify the declared audio stream.");
  }
  const videoFrameRate = canonicalRational(record.videoFrameRate, "$.media.videoFrameRate", limits);
  if (compareRational(videoFrameRate, zeroRational) <= 0) {
    fail("CUT_TRANSCRIPT_MEDIA", "$.media.videoFrameRate", "must be positive.");
  }
  const videoDuration = hasVideoDuration
    ? canonicalRational(record.videoDuration, "$.media.videoDuration", limits)
    : undefined;
  if (videoDuration !== undefined
    && compareRational(videoDuration, zeroRational) <= 0) {
    fail("CUT_TRANSCRIPT_TIME", "$.media.videoDuration", "must be positive.");
  }
  const audioVideoPresentationDelta = hasPresentationDelta
    ? canonicalRational(
      record.audioVideoPresentationDelta,
      "$.media.audioVideoPresentationDelta",
      limits,
    )
    : undefined;
  if (audioVideoPresentationDelta !== undefined
    && compareRational(audioVideoPresentationDelta, zeroRational) === 0) {
    fail(
      "CUT_TRANSCRIPT_TIME",
      "$.media.audioVideoPresentationDelta",
      "must be omitted when the selected audio and video presentation anchors are equal.",
    );
  }
  return Object.freeze({
    sha256: record.sha256,
    audioStreamIndex,
    audioSampleRate: record.audioSampleRate as number,
    duration,
    videoStreamIndex,
    videoFrameRate,
    ...(videoDuration === undefined ? {} : { videoDuration }),
    ...(audioVideoPresentationDelta === undefined
      ? {}
      : { audioVideoPresentationDelta }),
  });
}

function isOnAudioSampleGrid(value: Rational, sampleRate: number) {
  const scaledNumerator = BigInt(value.numerator) * BigInt(sampleRate);
  return scaledNumerator % BigInt(value.denominator) === 0n;
}

function validateWords(
  preflight: readonly PreflightWord[],
  media: TranscriptMediaBinding,
  limits: TranscriptLimits,
) {
  const words: TranscriptWord[] = [];
  let previous: TranscriptWord | undefined;
  for (let index = 0; index < preflight.length; index += 1) {
    const candidate = preflight[index]!;
    const path = `$.words[${index}]`;
    const start = canonicalRational(candidate.record.start, `${path}.start`, limits);
    const end = canonicalRational(candidate.record.end, `${path}.end`, limits);
    if (compareRational(start, zeroRational) < 0) {
      fail("CUT_TRANSCRIPT_TIME", `${path}.start`, "cannot be negative.");
    }
    if (compareRational(end, start) <= 0) {
      fail("CUT_TRANSCRIPT_TIME", `${path}.end`, "must be strictly later than start.");
    }
    if (compareRational(end, media.duration) > 0) {
      fail("CUT_TRANSCRIPT_TIME", `${path}.end`, "exceeds the bound media duration.");
    }
    if (previous && compareRational(start, previous.start) < 0) {
      fail("CUT_TRANSCRIPT_TIME", `${path}.start`, "is out of chronological order.");
    }
    if (previous && compareRational(start, previous.end) < 0) {
      fail("CUT_TRANSCRIPT_TIME", `${path}.start`, `overlaps $.words[${index - 1}].end.`);
    }
    if (!isOnAudioSampleGrid(start, media.audioSampleRate)) {
      fail(
        "CUT_TRANSCRIPT_GRID",
        `${path}.start`,
        `must land exactly on the declared ${media.audioSampleRate} Hz audio-sample grid.`,
      );
    }
    if (!isOnAudioSampleGrid(end, media.audioSampleRate)) {
      fail(
        "CUT_TRANSCRIPT_GRID",
        `${path}.end`,
        `must land exactly on the declared ${media.audioSampleRate} Hz audio-sample grid.`,
      );
    }
    const word = Object.freeze({
      id: candidate.id,
      start,
      end,
      text: candidate.text,
      join: candidate.join,
      ...(candidate.speaker === undefined ? {} : { speaker: candidate.speaker }),
    });
    words.push(word);
    previous = word;
  }
  return Object.freeze(words);
}

function validateTranscriptValue(value: unknown, limits: TranscriptLimits): CutTranscript {
  const record = closedObject(value, "$", ["format", "version", "media", "words"]);
  if (record.format !== "cut-transcript") {
    fail("CUT_TRANSCRIPT_FORMAT", "$.format", "must equal “cut-transcript”.");
  }
  if (record.version !== 1) fail("CUT_TRANSCRIPT_FORMAT", "$.version", "must equal 1.");
  const preflight = preflightWords(record.words, limits);
  const media = validateMedia(record.media, limits);
  const words = validateWords(preflight, media, limits);
  return Object.freeze({ format: "cut-transcript", version: 1, media, words });
}

/** Parse and validate a bounded UTF-8 JSON transcript sidecar without I/O. */
export function parseCutTranscript(
  input: string | Uint8Array,
  overrides: Partial<TranscriptLimits> = {},
): CutTranscript {
  const limits = resolveLimits(overrides, true);
  return validateTranscriptValue(decodeJsonInput(input, limits), limits);
}

/** Validate an already-decoded value under all applicable structural limits. */
export function validateCutTranscript(
  value: unknown,
  overrides: Partial<TranscriptDecodedLimits> = {},
): CutTranscript {
  return validateTranscriptValue(value, resolveLimits(overrides, false));
}

function selectionRequest(value: unknown, limits: TranscriptLimits): TranscriptSelectionRequest {
  const record = closedObject(value, "$.selection", ["from", "through"]);
  return Object.freeze({
    from: preflightId(record.from, "$.selection.from", limits),
    through: preflightId(record.through, "$.selection.through", limits),
  });
}

function selectedIdsHash(words: readonly TranscriptWord[], fromIndex: number, throughIndex: number) {
  const digest = createHash("sha256");
  digest.update("[");
  for (let index = fromIndex; index <= throughIndex; index += 1) {
    if (index > fromIndex) digest.update(",");
    digest.update(JSON.stringify(words[index]!.id));
  }
  digest.update("]");
  return digest.digest("hex");
}

/**
 * Select a closed, inclusive word interval by stable IDs. The output source
 * range includes any intentional silence between selected words.
 */
export function selectTranscriptRange(
  transcriptValue: CutTranscript,
  requestValue: TranscriptSelectionRequest,
  overrides: Partial<TranscriptDecodedLimits> = {},
): TranscriptSelection {
  const limits = resolveLimits(overrides, false);
  const transcript = validateTranscriptValue(transcriptValue, limits);
  const request = selectionRequest(requestValue, limits);
  const indexes = new Map(transcript.words.map((word, index) => [word.id, index]));
  const fromIndex = indexes.get(request.from);
  if (fromIndex === undefined) {
    fail("CUT_TRANSCRIPT_ID", "$.selection.from", `does not identify a transcript word: ${JSON.stringify(request.from)}.`);
  }
  const throughIndex = indexes.get(request.through);
  if (throughIndex === undefined) {
    fail(
      "CUT_TRANSCRIPT_ID",
      "$.selection.through",
      `does not identify a transcript word: ${JSON.stringify(request.through)}.`,
    );
  }
  if (throughIndex < fromIndex) {
    fail("CUT_TRANSCRIPT_ID", "$.selection.through", "precedes $.selection.from in transcript order.");
  }
  const first = transcript.words[fromIndex]!;
  const last = transcript.words[throughIndex]!;
  const textParts = [first.text];
  for (let index = fromIndex + 1; index <= throughIndex; index += 1) {
    const word = transcript.words[index]!;
    if (word.join === "space") textParts.push(" ");
    textParts.push(word.text);
  }
  const sourceRange = Object.freeze({
    start: first.start,
    end: last.end,
    duration: Object.freeze(subtractRational(last.end, first.start)),
  });
  return Object.freeze({
    from: request.from,
    through: request.through,
    selectedWordCount: throughIndex - fromIndex + 1,
    selectedIdsSha256: selectedIdsHash(transcript.words, fromIndex, throughIndex),
    text: textParts.join(""),
    sourceRange,
    media: transcript.media,
  });
}
