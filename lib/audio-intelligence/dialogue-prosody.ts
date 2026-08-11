import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";
import { stableJsonStringify } from "../core/stable";
import {
  defaultTranscriptLimits,
  validateCutTranscript,
  type CutTranscript,
  type TranscriptWord,
} from "../interchange/transcript";
import type { Rational } from "../language/rational";

export const dialogueProsodyLimits = Object.freeze({
  maximumInterleavedSamples: 100_000_000,
  maximumWords: 100_000,
  minimumSampleRate: 8_000,
  maximumSampleRate: 192_000,
  decibelFloorMilli: -120_000,
});

export type DialogueProsodySourceAuthority = Readonly<{
  /** Cross-bound to transcript.media.sha256; this pure kernel does not open the original media bytes. */
  mediaSha256: string;
  audioStreamIndex: number;
  normalizedPcmSha256: string;
  transcriptSha256: string;
  sampleRate: number;
  channels: 1 | 2;
  durationSamples: number;
}>;

export type DialogueProsodyPolicy = Readonly<{
  minimumPauseMilliseconds: number;
  mediumPauseMilliseconds: number;
  longPauseMilliseconds: number;
  sentencePauseMilliseconds: number;
  activityAmplitudePpm: number;
  maximumQuietPauseActivityPpm: number;
  dynamicsDeltaDbfsMilli: number;
  rateDeltaPpm: number;
  emphasisRmsDeltaDbfsMilli: number;
  emphasisDurationRatioPpm: number;
  dialoguePreRollMilliseconds: number;
  dialoguePostRollMilliseconds: number;
  pauseMarginMilliseconds: number;
  dialogueProtectionGainDeltaDbMilli: number;
}>;

export const defaultDialogueProsodyPolicy: DialogueProsodyPolicy = Object.freeze({
  minimumPauseMilliseconds: 120,
  mediumPauseMilliseconds: 350,
  longPauseMilliseconds: 700,
  sentencePauseMilliseconds: 900,
  activityAmplitudePpm: 10_000,
  maximumQuietPauseActivityPpm: 150_000,
  dynamicsDeltaDbfsMilli: 2_000,
  rateDeltaPpm: 100_000,
  emphasisRmsDeltaDbfsMilli: 2_500,
  emphasisDurationRatioPpm: 1_500_000,
  dialoguePreRollMilliseconds: 80,
  dialoguePostRollMilliseconds: 120,
  pauseMarginMilliseconds: 40,
  dialogueProtectionGainDeltaDbMilli: -6_000,
});

export type DialogueProsodyInput = Readonly<{
  source: DialogueProsodySourceAuthority;
  pcm: Float32Array;
  transcript: CutTranscript;
  range?: Readonly<{ startSample: number; endSample: number }>;
  policy?: Partial<DialogueProsodyPolicy>;
}>;

export type DialogueProsodyAcousticMetrics = Readonly<{
  rmsDbfsMilli: number;
  peakDbfsMilli: number;
  meanAbsolutePpm: number;
  activityPpm: number;
}>;

export type DialogueProsodyPause = Readonly<{
  id: string;
  precedingWordId: string;
  followingWordId: string;
  startSample: number;
  endSample: number;
  durationSamples: number;
  class: "short" | "medium" | "long";
  quiet: boolean;
  acoustics: DialogueProsodyAcousticMetrics;
}>;

export type DialogueProsodyPhrase = Readonly<{
  id: string;
  sentenceId: string;
  firstWordId: string;
  lastWordId: string;
  startSample: number;
  endSample: number;
  wordCount: number;
  speaker?: string;
  wordsPerMinuteMilli: number;
  medianWordDurationSamples: number;
  acoustics: DialogueProsodyAcousticMetrics;
}>;

export type DialogueProsodySentence = Readonly<{
  id: string;
  firstWordId: string;
  lastWordId: string;
  startSample: number;
  endSample: number;
  wordCount: number;
  speaker?: string;
  phraseIds: readonly string[];
}>;

export type DialogueProsodyContour = Readonly<{
  fromPhraseId: string;
  toPhraseId: string;
  rateDeltaPpm: number;
  rateDirection: "faster" | "steady" | "slower";
  rmsDeltaDbfsMilli: number;
  dynamicDirection: "louder" | "steady" | "quieter";
}>;

export type DialogueProsodyEmphasisCandidate = Readonly<{
  wordId: string;
  phraseId: string;
  startSample: number;
  endSample: number;
  reasons: readonly ("isolated-after-pause" | "lengthened-delivery" | "level-rise")[];
  wordRmsDbfsMilli: number;
  phraseRmsDbfsMilli: number;
  durationSamples: number;
  phraseMedianWordDurationSamples: number;
}>;

export type DialogueSpaceSuggestion = Readonly<{
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

export type DialogueProsodyAnalysisBody = Readonly<{
  format: "cut-dialogue-prosody-analysis";
  version: 1;
  interpretation: "measured-timing-plus-authored-policy-not-emotion-or-performance-approval";
  authority: DialogueProsodySourceAuthority & Readonly<{
    pcmEncoding: "f32le-interleaved";
    policySha256: string;
    mediaIdentitySemantics: "transcript-cross-binding-not-original-byte-authentication";
  }>;
  range: Readonly<{ startSample: number; endSample: number }>;
  policy: DialogueProsodyPolicy;
  samplePolicy: Readonly<{
    minimumPauseSamples: number;
    mediumPauseSamples: number;
    longPauseSamples: number;
    sentencePauseSamples: number;
    dialoguePreRollSamples: number;
    dialoguePostRollSamples: number;
    pauseMarginSamples: number;
  }>;
  speakingRate: Readonly<{
    lexicalWordCount: number;
    spanSamples: number;
    activeWordSamples: number;
    wordsPerMinuteMilli: number;
    articulationWordsPerMinuteMilli: number;
  }>;
  pauses: readonly DialogueProsodyPause[];
  phrases: readonly DialogueProsodyPhrase[];
  sentences: readonly DialogueProsodySentence[];
  contours: readonly DialogueProsodyContour[];
  emphasisCandidates: readonly DialogueProsodyEmphasisCandidate[];
  dialogueSpaceSuggestions: readonly DialogueSpaceSuggestion[];
  work: Readonly<{
    pcmFramesAuthenticated: number;
    metricFramesRead: number;
    scalarSamplesRead: number;
    transcriptWordsVisited: number;
    phraseSentenceAssignments: number;
    contourPairsVisited: number;
  }>;
}>;

export type DialogueProsodyAnalysis = DialogueProsodyAnalysisBody & Readonly<{
  analysisSha256: string;
}>;

export type DialogueProsodyErrorCode =
  | "CUT_DIALOGUE_PROSODY_AUTHORITY"
  | "CUT_DIALOGUE_PROSODY_CLOCK"
  | "CUT_DIALOGUE_PROSODY_FORMAT"
  | "CUT_DIALOGUE_PROSODY_LIMIT"
  | "CUT_DIALOGUE_PROSODY_POLICY"
  | "CUT_DIALOGUE_PROSODY_RANGE"
  | "CUT_DIALOGUE_PROSODY_SAMPLE"
  | "CUT_DIALOGUE_PROSODY_TRANSCRIPT";

export class DialogueProsodyError extends Error {
  constructor(
    readonly code: DialogueProsodyErrorCode,
    readonly path: string,
    detail: string,
  ) {
    super(`${code} at ${path}: ${detail}`);
    this.name = "DialogueProsodyError";
  }
}

type DataRecord = Record<string, unknown>;
type ClockWord = Readonly<{ word: TranscriptWord; transcriptIndex: number; startSample: number; endSample: number }>;
type LexicalWord = ClockWord & Readonly<{ acoustics: DialogueProsodyAcousticMetrics }>;
type MetricResult = Readonly<{ metrics: DialogueProsodyAcousticMetrics; framesRead: number; scalarSamplesRead: number }>;

const digestPattern = /^[0-9a-f]{64}$/u;
const lexicalPattern = /[\p{L}\p{N}]/u;
const phrasePunctuationPattern = /[,;:，；：—–]/u;
const sentencePunctuationPattern = /[.!?…。！？]/u;

function fail(code: DialogueProsodyErrorCode, path: string, detail: string): never {
  throw new DialogueProsodyError(code, path, detail);
}

function fieldPath(path: string, field: string) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(field) ? `${path}.${field}` : `${path}[${JSON.stringify(field)}]`;
}

function closedObject(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): DataRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isProxy(value)) {
    fail("CUT_DIALOGUE_PROSODY_FORMAT", path, "must be one ordinary object.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("CUT_DIALOGUE_PROSODY_FORMAT", path, "must be one ordinary object.");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === "symbol")) {
    fail("CUT_DIALOGUE_PROSODY_FORMAT", `${path}[symbol]`, "symbol fields are forbidden.");
  }
  const names = keys as string[];
  const allowed = new Set([...required, ...optional]);
  const unknown = names.filter((name) => !allowed.has(name)).sort()[0];
  if (unknown !== undefined) fail("CUT_DIALOGUE_PROSODY_FORMAT", fieldPath(path, unknown), "is not part of the closed input.");
  for (const name of required) {
    if (!names.includes(name)) fail("CUT_DIALOGUE_PROSODY_FORMAT", fieldPath(path, name), "is required.");
  }
  const result: DataRecord = Object.create(null) as DataRecord;
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      fail("CUT_DIALOGUE_PROSODY_FORMAT", fieldPath(path, name), "must be one enumerable data field.");
    }
    result[name] = descriptor.value;
  }
  return result;
}

function closedArray(value: unknown, path: string, maximumLength: number): readonly unknown[] {
  if (!Array.isArray(value) || isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    fail("CUT_DIALOGUE_PROSODY_FORMAT", path, "must be one ordinary dense array.");
  }
  if (value.length > maximumLength) fail("CUT_DIALOGUE_PROSODY_LIMIT", path, `exceeds ${maximumLength} items.`);
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length) {
      fail("CUT_DIALOGUE_PROSODY_FORMAT", typeof key === "string" ? fieldPath(path, key) : `${path}[symbol]`, "is not part of the closed array.");
    }
  }
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      fail("CUT_DIALOGUE_PROSODY_FORMAT", `${path}[${index}]`, "must be one enumerable data item; sparse arrays and accessors are forbidden.");
    }
    result.push(descriptor.value);
  }
  return result;
}

function snapshotRational(value: unknown, path: string): Rational {
  const record = closedObject(value, path, ["numerator", "denominator"]);
  return { numerator: record.numerator as string, denominator: record.denominator as string };
}

function snapshotTranscript(value: unknown): CutTranscript {
  const root = closedObject(value, "$.transcript", ["format", "version", "media", "words"]);
  const media = closedObject(
    root.media,
    "$.transcript.media",
    ["sha256", "audioStreamIndex", "audioSampleRate", "duration"],
    ["videoStreamIndex", "videoFrameRate", "videoDuration", "audioVideoPresentationDelta"],
  );
  const mediaSnapshot: Record<string, unknown> = {
    sha256: media.sha256,
    audioStreamIndex: media.audioStreamIndex,
    audioSampleRate: media.audioSampleRate,
    duration: snapshotRational(media.duration, "$.transcript.media.duration"),
  };
  if (Object.hasOwn(media, "videoStreamIndex")) mediaSnapshot.videoStreamIndex = media.videoStreamIndex;
  if (Object.hasOwn(media, "videoFrameRate")) mediaSnapshot.videoFrameRate = snapshotRational(media.videoFrameRate, "$.transcript.media.videoFrameRate");
  if (Object.hasOwn(media, "videoDuration")) mediaSnapshot.videoDuration = snapshotRational(media.videoDuration, "$.transcript.media.videoDuration");
  if (Object.hasOwn(media, "audioVideoPresentationDelta")) {
    mediaSnapshot.audioVideoPresentationDelta = snapshotRational(media.audioVideoPresentationDelta, "$.transcript.media.audioVideoPresentationDelta");
  }
  const words = closedArray(root.words, "$.transcript.words", dialogueProsodyLimits.maximumWords).map((value, index) => {
    const path = `$.transcript.words[${index}]`;
    const word = closedObject(value, path, ["id", "start", "end", "text", "join"], ["speaker"]);
    const snapshot: Record<string, unknown> = {
      id: word.id,
      start: snapshotRational(word.start, `${path}.start`),
      end: snapshotRational(word.end, `${path}.end`),
      text: word.text,
      join: word.join,
    };
    if (Object.hasOwn(word, "speaker")) snapshot.speaker = word.speaker;
    return snapshot;
  });
  try {
    return validateCutTranscript({ format: root.format, version: root.version, media: mediaSnapshot, words }, {
      maxWords: dialogueProsodyLimits.maximumWords,
      maxWordTextBytes: defaultTranscriptLimits.maxWordTextBytes,
      maxTextBytes: defaultTranscriptLimits.maxTextBytes,
      maxIdBytes: defaultTranscriptLimits.maxIdBytes,
      maxSpeakerBytes: defaultTranscriptLimits.maxSpeakerBytes,
      maxRationalDigits: defaultTranscriptLimits.maxRationalDigits,
    });
  } catch (error) {
    fail("CUT_DIALOGUE_PROSODY_TRANSCRIPT", "$.transcript", error instanceof Error ? error.message : "transcript validation failed.");
  }
}

function integer(value: unknown, path: string, minimum: number, maximum: number, code: DialogueProsodyErrorCode) {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail(code, path, `must be one safe integer from ${minimum} through ${maximum}.`);
  }
  return value as number;
}

function digest(value: unknown, path: string) {
  if (typeof value !== "string" || !digestPattern.test(value)) {
    fail("CUT_DIALOGUE_PROSODY_AUTHORITY", path, "must be one lowercase 64-digit SHA-256 digest.");
  }
  return value;
}

function snapshotSource(value: unknown): DialogueProsodySourceAuthority {
  const source = closedObject(value, "$.source", [
    "mediaSha256", "audioStreamIndex", "normalizedPcmSha256", "transcriptSha256",
    "sampleRate", "channels", "durationSamples",
  ]);
  const channels = integer(source.channels, "$.source.channels", 1, 2, "CUT_DIALOGUE_PROSODY_AUTHORITY");
  return Object.freeze({
    mediaSha256: digest(source.mediaSha256, "$.source.mediaSha256"),
    audioStreamIndex: integer(source.audioStreamIndex, "$.source.audioStreamIndex", 0, 65_535, "CUT_DIALOGUE_PROSODY_AUTHORITY"),
    normalizedPcmSha256: digest(source.normalizedPcmSha256, "$.source.normalizedPcmSha256"),
    transcriptSha256: digest(source.transcriptSha256, "$.source.transcriptSha256"),
    sampleRate: integer(
      source.sampleRate,
      "$.source.sampleRate",
      dialogueProsodyLimits.minimumSampleRate,
      dialogueProsodyLimits.maximumSampleRate,
      "CUT_DIALOGUE_PROSODY_AUTHORITY",
    ),
    channels: channels as 1 | 2,
    durationSamples: integer(
      source.durationSamples,
      "$.source.durationSamples",
      1,
      dialogueProsodyLimits.maximumInterleavedSamples,
      "CUT_DIALOGUE_PROSODY_LIMIT",
    ),
  });
}

function snapshotPcm(value: unknown, source: DialogueProsodySourceAuthority) {
  if (!(value instanceof Float32Array) || isProxy(value) || Object.getPrototypeOf(value) !== Float32Array.prototype) {
    fail("CUT_DIALOGUE_PROSODY_FORMAT", "$.pcm", "must be one ordinary Float32Array.");
  }
  if (typeof SharedArrayBuffer !== "undefined" && value.buffer instanceof SharedArrayBuffer) {
    fail("CUT_DIALOGUE_PROSODY_FORMAT", "$.pcm", "must not use shared mutable storage.");
  }
  const expectedLength = source.durationSamples * source.channels;
  if (!Number.isSafeInteger(expectedLength) || expectedLength > dialogueProsodyLimits.maximumInterleavedSamples) {
    fail("CUT_DIALOGUE_PROSODY_LIMIT", "$.pcm", `exceeds ${dialogueProsodyLimits.maximumInterleavedSamples} interleaved samples.`);
  }
  if (value.length !== expectedLength) {
    fail("CUT_DIALOGUE_PROSODY_CLOCK", "$.pcm.length", `must equal durationSamples * channels (${expectedLength}).`);
  }
  try {
    return new Float32Array(value);
  } catch {
    return fail("CUT_DIALOGUE_PROSODY_FORMAT", "$.pcm", "could not be snapshotted from stable storage.");
  }
}

function hashPcmSnapshot(samples: Float32Array) {
  const hash = createHash("sha256");
  hash.update("cut-f32le-interleaved-v1\0", "utf8");
  const bytes = Buffer.allocUnsafe(16_384);
  let used = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index]!;
    if (!Number.isFinite(value) || value < -1 || value > 1) {
      fail("CUT_DIALOGUE_PROSODY_SAMPLE", `$.pcm[${index}]`, "must be finite and between -1 and 1.");
    }
    bytes.writeFloatLE(value, used);
    used += 4;
    if (used === bytes.length) {
      hash.update(bytes);
      used = 0;
    }
  }
  if (used > 0) hash.update(bytes.subarray(0, used));
  return hash.digest("hex");
}

/** Domain-separated SHA-256 of canonical little-endian interleaved f32 values. */
export function hashDialogueProsodyPcmF32(samples: Float32Array) {
  if (!(samples instanceof Float32Array) || isProxy(samples) || Object.getPrototypeOf(samples) !== Float32Array.prototype) {
    fail("CUT_DIALOGUE_PROSODY_FORMAT", "$.pcm", "must be one ordinary Float32Array.");
  }
  if (typeof SharedArrayBuffer !== "undefined" && samples.buffer instanceof SharedArrayBuffer) {
    fail("CUT_DIALOGUE_PROSODY_FORMAT", "$.pcm", "must not use shared mutable storage.");
  }
  if (samples.length < 1 || samples.length > dialogueProsodyLimits.maximumInterleavedSamples) {
    fail("CUT_DIALOGUE_PROSODY_LIMIT", "$.pcm", `must contain 1..${dialogueProsodyLimits.maximumInterleavedSamples} interleaved samples.`);
  }
  return hashPcmSnapshot(new Float32Array(samples));
}

/** Canonical transcript identity used by the prosody authority. */
export function hashDialogueProsodyTranscript(transcript: CutTranscript) {
  return createHash("sha256").update(stableJsonStringify(snapshotTranscript(transcript)), "utf8").digest("hex");
}

function resolvePolicy(value: unknown): DialogueProsodyPolicy {
  const names = Object.keys(defaultDialogueProsodyPolicy) as Array<keyof DialogueProsodyPolicy>;
  const record = value === undefined ? Object.create(null) as DataRecord : closedObject(value, "$.policy", [], names);
  const result = { ...defaultDialogueProsodyPolicy };
  const bounds: Record<keyof DialogueProsodyPolicy, readonly [number, number]> = {
    minimumPauseMilliseconds: [1, 10_000],
    mediumPauseMilliseconds: [1, 10_000],
    longPauseMilliseconds: [1, 60_000],
    sentencePauseMilliseconds: [1, 60_000],
    activityAmplitudePpm: [1, 1_000_000],
    maximumQuietPauseActivityPpm: [0, 1_000_000],
    dynamicsDeltaDbfsMilli: [0, 120_000],
    rateDeltaPpm: [0, 10_000_000],
    emphasisRmsDeltaDbfsMilli: [0, 120_000],
    emphasisDurationRatioPpm: [1_000_000, 10_000_000],
    dialoguePreRollMilliseconds: [0, 10_000],
    dialoguePostRollMilliseconds: [0, 10_000],
    pauseMarginMilliseconds: [0, 10_000],
    dialogueProtectionGainDeltaDbMilli: [-24_000, 0],
  };
  for (const name of names) {
    if (Object.hasOwn(record, name)) {
      const [minimum, maximum] = bounds[name];
      result[name] = integer(record[name], `$.policy.${name}`, minimum, maximum, "CUT_DIALOGUE_PROSODY_POLICY");
    }
  }
  if (!(result.minimumPauseMilliseconds < result.mediumPauseMilliseconds
    && result.mediumPauseMilliseconds < result.longPauseMilliseconds
    && result.longPauseMilliseconds <= result.sentencePauseMilliseconds)) {
    fail(
      "CUT_DIALOGUE_PROSODY_POLICY",
      "$.policy",
      "pause thresholds must satisfy minimum < medium < long <= sentence.",
    );
  }
  return Object.freeze(result);
}

function snapshotRange(value: unknown, durationSamples: number) {
  if (value === undefined) return Object.freeze({ startSample: 0, endSample: durationSamples });
  const range = closedObject(value, "$.range", ["startSample", "endSample"]);
  const startSample = integer(range.startSample, "$.range.startSample", 0, durationSamples - 1, "CUT_DIALOGUE_PROSODY_RANGE");
  const endSample = integer(range.endSample, "$.range.endSample", 1, durationSamples, "CUT_DIALOGUE_PROSODY_RANGE");
  if (endSample <= startSample) fail("CUT_DIALOGUE_PROSODY_RANGE", "$.range", "endSample must be greater than startSample.");
  return Object.freeze({ startSample, endSample });
}

function exactSample(value: Rational, sampleRate: number, path: string) {
  const numerator = BigInt(value.numerator) * BigInt(sampleRate);
  const denominator = BigInt(value.denominator);
  if (numerator % denominator !== 0n) fail("CUT_DIALOGUE_PROSODY_CLOCK", path, "does not land on the declared integer audio-sample grid.");
  const result = numerator / denominator;
  if (result < 0n || result > BigInt(Number.MAX_SAFE_INTEGER)) fail("CUT_DIALOGUE_PROSODY_CLOCK", path, "is outside the safe sample clock.");
  return Number(result);
}

function clockWords(transcript: CutTranscript, source: DialogueProsodySourceAuthority, range: Readonly<{ startSample: number; endSample: number }>) {
  const durationNumerator = BigInt(transcript.media.duration.numerator) * BigInt(source.sampleRate);
  const durationDenominator = BigInt(transcript.media.duration.denominator);
  if (durationNumerator !== BigInt(source.durationSamples) * durationDenominator) {
    fail("CUT_DIALOGUE_PROSODY_CLOCK", "$.transcript.media.duration", "does not equal durationSamples on the declared sample clock.");
  }
  const words: ClockWord[] = [];
  for (let index = 0; index < transcript.words.length; index += 1) {
    const word = transcript.words[index]!;
    const startSample = exactSample(word.start, source.sampleRate, `$.transcript.words[${index}].start`);
    const endSample = exactSample(word.end, source.sampleRate, `$.transcript.words[${index}].end`);
    if (endSample > source.durationSamples) fail("CUT_DIALOGUE_PROSODY_CLOCK", `$.transcript.words[${index}].end`, "exceeds durationSamples.");
    if ((startSample < range.startSample && range.startSample < endSample)
      || (startSample < range.endSample && range.endSample < endSample)) {
      fail("CUT_DIALOGUE_PROSODY_RANGE", "$.range", `cuts through transcript word ${JSON.stringify(word.id)}.`);
    }
    if (startSample >= range.startSample && endSample <= range.endSample) {
      words.push(Object.freeze({ word, transcriptIndex: index, startSample, endSample }));
    }
  }
  return Object.freeze(words);
}

function millisecondsToSamples(milliseconds: number, sampleRate: number) {
  return Number((BigInt(milliseconds) * BigInt(sampleRate) + 999n) / 1_000n);
}

function roundedRatio(numerator: bigint, denominator: bigint, path: string) {
  if (denominator <= 0n) return 0;
  const negative = numerator < 0n;
  const magnitude = negative ? -numerator : numerator;
  const value = (magnitude + denominator / 2n) / denominator;
  const signed = negative ? -value : value;
  if (signed < BigInt(Number.MIN_SAFE_INTEGER) || signed > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail("CUT_DIALOGUE_PROSODY_LIMIT", path, "exceeds safe integer output accounting.");
  }
  return Number(signed);
}

function wordsPerMinuteMilli(wordCount: number, durationSamples: number, sampleRate: number) {
  return durationSamples > 0
    ? roundedRatio(BigInt(wordCount) * 60_000n * BigInt(sampleRate), BigInt(durationSamples), "$.speakingRate")
    : 0;
}

function dbfsMilli(amplitude: number) {
  return amplitude <= 0
    ? dialogueProsodyLimits.decibelFloorMilli
    : Math.max(dialogueProsodyLimits.decibelFloorMilli, Math.round(20_000 * Math.log10(amplitude)));
}

function metrics(
  pcm: Float32Array,
  channels: 1 | 2,
  startSample: number,
  endSample: number,
  activityAmplitudePpm: number,
): MetricResult {
  if (endSample <= startSample) {
    return Object.freeze({
      metrics: Object.freeze({ rmsDbfsMilli: -120_000, peakDbfsMilli: -120_000, meanAbsolutePpm: 0, activityPpm: 0 }),
      framesRead: 0,
      scalarSamplesRead: 0,
    });
  }
  let square = 0, peak = 0, absolute = 0, activeFrames = 0;
  const threshold = activityAmplitudePpm / 1_000_000;
  for (let frame = startSample; frame < endSample; frame += 1) {
    let active = false;
    const base = frame * channels;
    for (let channel = 0; channel < channels; channel += 1) {
      const value = pcm[base + channel]!;
      const magnitude = Math.abs(value);
      square += value * value;
      absolute += magnitude;
      peak = Math.max(peak, magnitude);
      if (magnitude >= threshold) active = true;
    }
    if (active) activeFrames += 1;
  }
  const framesRead = endSample - startSample;
  const scalarSamplesRead = framesRead * channels;
  return Object.freeze({
    metrics: Object.freeze({
      rmsDbfsMilli: dbfsMilli(Math.sqrt(square / scalarSamplesRead)),
      peakDbfsMilli: dbfsMilli(peak),
      meanAbsolutePpm: Math.round((absolute * 1_000_000) / scalarSamplesRead),
      activityPpm: Math.round((activeFrames * 1_000_000) / framesRead),
    }),
    framesRead,
    scalarSamplesRead,
  });
}

function pauseClass(durationSamples: number, mediumSamples: number, longSamples: number): "short" | "medium" | "long" {
  return durationSamples >= longSamples ? "long" : durationSamples >= mediumSamples ? "medium" : "short";
}

function median(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor((sorted.length - 1) / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : Math.round((sorted[middle]! + sorted[middle + 1]!) / 2);
}

function canonicalHash(value: unknown) {
  return createHash("sha256").update(stableJsonStringify(value), "utf8").digest("hex");
}

/**
 * Analyze transcript-timed dialogue without inferring emotion or approving a
 * performance. PCM and transcript identities are recomputed before analysis.
 */
export function analyzeDialogueProsody(value: DialogueProsodyInput): DialogueProsodyAnalysis {
  const input = closedObject(value, "$", ["source", "pcm", "transcript"], ["range", "policy"]);
  const source = snapshotSource(input.source);
  const pcm = snapshotPcm(input.pcm, source);
  const transcript = snapshotTranscript(input.transcript);
  const policy = resolvePolicy(input.policy);
  const range = snapshotRange(input.range, source.durationSamples);

  const pcmSha256 = hashPcmSnapshot(pcm);
  if (pcmSha256 !== source.normalizedPcmSha256) fail("CUT_DIALOGUE_PROSODY_AUTHORITY", "$.source.normalizedPcmSha256", "does not match the supplied PCM values.");
  const transcriptSha256 = canonicalHash(transcript);
  if (transcriptSha256 !== source.transcriptSha256) fail("CUT_DIALOGUE_PROSODY_AUTHORITY", "$.source.transcriptSha256", "does not match the validated transcript.");
  if (transcript.media.sha256 !== source.mediaSha256) fail("CUT_DIALOGUE_PROSODY_AUTHORITY", "$.source.mediaSha256", "does not match transcript media authority.");
  if (transcript.media.audioStreamIndex !== source.audioStreamIndex) fail("CUT_DIALOGUE_PROSODY_AUTHORITY", "$.source.audioStreamIndex", "does not match transcript media authority.");
  if (transcript.media.audioSampleRate !== source.sampleRate) fail("CUT_DIALOGUE_PROSODY_CLOCK", "$.source.sampleRate", "does not match transcript audioSampleRate.");

  const selected = clockWords(transcript, source, range);
  const clock = Object.freeze({
    minimumPauseSamples: millisecondsToSamples(policy.minimumPauseMilliseconds, source.sampleRate),
    mediumPauseSamples: millisecondsToSamples(policy.mediumPauseMilliseconds, source.sampleRate),
    longPauseSamples: millisecondsToSamples(policy.longPauseMilliseconds, source.sampleRate),
    sentencePauseSamples: millisecondsToSamples(policy.sentencePauseMilliseconds, source.sampleRate),
    dialoguePreRollSamples: millisecondsToSamples(policy.dialoguePreRollMilliseconds, source.sampleRate),
    dialoguePostRollSamples: millisecondsToSamples(policy.dialoguePostRollMilliseconds, source.sampleRate),
    pauseMarginSamples: millisecondsToSamples(policy.pauseMarginMilliseconds, source.sampleRate),
  });

  let metricFramesRead = 0, scalarSamplesRead = 0;
  const lexical: LexicalWord[] = selected.filter((item) => lexicalPattern.test(item.word.text)).map((item) => {
    const result = metrics(pcm, source.channels, item.startSample, item.endSample, policy.activityAmplitudePpm);
    metricFramesRead += result.framesRead;
    scalarSamplesRead += result.scalarSamplesRead;
    return Object.freeze({ ...item, acoustics: result.metrics });
  });

  const pauses: DialogueProsodyPause[] = [];
  const pauseAfterLexical = new Map<number, DialogueProsodyPause>();
  for (let index = 0; index + 1 < lexical.length; index += 1) {
    const preceding = lexical[index]!, following = lexical[index + 1]!;
    const durationSamples = following.startSample - preceding.endSample;
    if (durationSamples < clock.minimumPauseSamples) continue;
    const result = metrics(pcm, source.channels, preceding.endSample, following.startSample, policy.activityAmplitudePpm);
    metricFramesRead += result.framesRead;
    scalarSamplesRead += result.scalarSamplesRead;
    const pause = Object.freeze({
      id: `pause.${String(pauses.length + 1).padStart(6, "0")}`,
      precedingWordId: preceding.word.id,
      followingWordId: following.word.id,
      startSample: preceding.endSample,
      endSample: following.startSample,
      durationSamples,
      class: pauseClass(durationSamples, clock.mediumPauseSamples, clock.longPauseSamples),
      quiet: result.metrics.activityPpm <= policy.maximumQuietPauseActivityPpm,
      acoustics: result.metrics,
    });
    pauses.push(pause);
    pauseAfterLexical.set(index, pause);
  }

  const phraseBoundaryAfter: boolean[] = [];
  const sentenceBoundaryAfter: boolean[] = [];
  for (let index = 0; index < lexical.length; index += 1) {
    if (index === lexical.length - 1) {
      phraseBoundaryAfter[index] = true;
      sentenceBoundaryAfter[index] = true;
      continue;
    }
    const current = lexical[index]!, next = lexical[index + 1]!;
    if (current.word.speaker !== next.word.speaker) {
      phraseBoundaryAfter[index] = true;
      sentenceBoundaryAfter[index] = true;
      continue;
    }
    let hasPhrasePunctuation = phrasePunctuationPattern.test(current.word.text);
    let hasSentencePunctuation = sentencePunctuationPattern.test(current.word.text);
    // Adjacent lexical gaps are disjoint, so this traversal remains linear in
    // transcript words rather than rescanning the selection per lexical word.
    for (let cursor = current.transcriptIndex + 1; cursor < next.transcriptIndex; cursor += 1) {
      const text = transcript.words[cursor]!.text;
      if (phrasePunctuationPattern.test(text)) hasPhrasePunctuation = true;
      if (sentencePunctuationPattern.test(text)) hasSentencePunctuation = true;
    }
    const pause = pauseAfterLexical.get(index);
    const quietPause = pause?.quiet === true;
    sentenceBoundaryAfter[index] = hasSentencePunctuation
      || (quietPause && pause!.durationSamples >= clock.sentencePauseSamples);
    phraseBoundaryAfter[index] = sentenceBoundaryAfter[index]!
      || hasPhrasePunctuation
      || (quietPause && (pause!.class === "medium" || pause!.class === "long"));
  }

  const phraseDrafts: Array<Omit<DialogueProsodyPhrase, "sentenceId"> & { firstLexicalIndex: number; lastLexicalIndex: number }> = [];
  let phraseStart = 0;
  for (let index = 0; index < lexical.length; index += 1) {
    if (!phraseBoundaryAfter[index]) continue;
    const group = lexical.slice(phraseStart, index + 1);
    const first = group[0]!, last = group.at(-1)!;
    const result = metrics(pcm, source.channels, first.startSample, last.endSample, policy.activityAmplitudePpm);
    metricFramesRead += result.framesRead;
    scalarSamplesRead += result.scalarSamplesRead;
    phraseDrafts.push(Object.freeze({
      id: `phrase.${String(phraseDrafts.length + 1).padStart(6, "0")}`,
      firstWordId: first.word.id,
      lastWordId: last.word.id,
      startSample: first.startSample,
      endSample: last.endSample,
      wordCount: group.length,
      ...(first.word.speaker === undefined ? {} : { speaker: first.word.speaker }),
      wordsPerMinuteMilli: wordsPerMinuteMilli(group.length, last.endSample - first.startSample, source.sampleRate),
      medianWordDurationSamples: median(group.map((item) => item.endSample - item.startSample)),
      acoustics: result.metrics,
      firstLexicalIndex: phraseStart,
      lastLexicalIndex: index,
    }));
    phraseStart = index + 1;
  }

  const sentences: DialogueProsodySentence[] = [];
  const sentenceByLexical = new Map<number, string>();
  let phraseCursor = 0;
  let phraseSentenceAssignments = 0;
  let sentenceStart = 0;
  for (let index = 0; index < lexical.length; index += 1) {
    if (!sentenceBoundaryAfter[index]) continue;
    const group = lexical.slice(sentenceStart, index + 1);
    const first = group[0]!, last = group.at(-1)!;
    const id = `sentence.${String(sentences.length + 1).padStart(6, "0")}`;
    for (let cursor = sentenceStart; cursor <= index; cursor += 1) sentenceByLexical.set(cursor, id);
    const phraseIds: string[] = [];
    while (phraseCursor < phraseDrafts.length && phraseDrafts[phraseCursor]!.lastLexicalIndex <= index) {
      const phrase = phraseDrafts[phraseCursor]!;
      if (phrase.firstLexicalIndex < sentenceStart) {
        fail("CUT_DIALOGUE_PROSODY_FORMAT", "$.sentences", "internal phrase and sentence partitions disagree.");
      }
      phraseIds.push(phrase.id);
      phraseCursor += 1;
      phraseSentenceAssignments += 1;
    }
    sentences.push(Object.freeze({
      id,
      firstWordId: first.word.id,
      lastWordId: last.word.id,
      startSample: first.startSample,
      endSample: last.endSample,
      wordCount: group.length,
      ...(first.word.speaker === undefined ? {} : { speaker: first.word.speaker }),
      phraseIds: Object.freeze(phraseIds),
    }));
    sentenceStart = index + 1;
  }

  const phrases: DialogueProsodyPhrase[] = phraseDrafts.map((phrase) => Object.freeze({
    id: phrase.id,
    sentenceId: sentenceByLexical.get(phrase.firstLexicalIndex)!,
    firstWordId: phrase.firstWordId,
    lastWordId: phrase.lastWordId,
    startSample: phrase.startSample,
    endSample: phrase.endSample,
    wordCount: phrase.wordCount,
    ...(phrase.speaker === undefined ? {} : { speaker: phrase.speaker }),
    wordsPerMinuteMilli: phrase.wordsPerMinuteMilli,
    medianWordDurationSamples: phrase.medianWordDurationSamples,
    acoustics: phrase.acoustics,
  }));

  const contours: DialogueProsodyContour[] = [];
  let contourPairsVisited = 0;
  for (let index = 1; index < phrases.length; index += 1) {
    const previous = phrases[index - 1]!, current = phrases[index]!;
    contourPairsVisited += 1;
    if (previous.speaker !== current.speaker) continue;
    const rateDeltaPpm = previous.wordsPerMinuteMilli === 0 ? 0 : roundedRatio(
      BigInt(current.wordsPerMinuteMilli - previous.wordsPerMinuteMilli) * 1_000_000n,
      BigInt(previous.wordsPerMinuteMilli),
      "$.contours.rateDeltaPpm",
    );
    const rmsDeltaDbfsMilli = current.acoustics.rmsDbfsMilli - previous.acoustics.rmsDbfsMilli;
    contours.push(Object.freeze({
      fromPhraseId: previous.id,
      toPhraseId: current.id,
      rateDeltaPpm,
      rateDirection: rateDeltaPpm >= policy.rateDeltaPpm ? "faster" : rateDeltaPpm <= -policy.rateDeltaPpm ? "slower" : "steady",
      rmsDeltaDbfsMilli,
      dynamicDirection: rmsDeltaDbfsMilli >= policy.dynamicsDeltaDbfsMilli
        ? "louder" : rmsDeltaDbfsMilli <= -policy.dynamicsDeltaDbfsMilli ? "quieter" : "steady",
    }));
  }

  const emphasisCandidates: DialogueProsodyEmphasisCandidate[] = [];
  for (const phrase of phraseDrafts) {
    for (let index = phrase.firstLexicalIndex; index <= phrase.lastLexicalIndex; index += 1) {
      const word = lexical[index]!;
      const durationSamples = word.endSample - word.startSample;
      const reasons: Array<"isolated-after-pause" | "lengthened-delivery" | "level-rise"> = [];
      const precedingPause = pauseAfterLexical.get(index - 1);
      if (precedingPause?.quiet && (precedingPause.class === "medium" || precedingPause.class === "long")) reasons.push("isolated-after-pause");
      if (BigInt(durationSamples) * 1_000_000n >= BigInt(phrase.medianWordDurationSamples) * BigInt(policy.emphasisDurationRatioPpm)) {
        reasons.push("lengthened-delivery");
      }
      if (word.acoustics.rmsDbfsMilli - phrase.acoustics.rmsDbfsMilli >= policy.emphasisRmsDeltaDbfsMilli) reasons.push("level-rise");
      if (reasons.length === 0) continue;
      emphasisCandidates.push(Object.freeze({
        wordId: word.word.id,
        phraseId: phrase.id,
        startSample: word.startSample,
        endSample: word.endSample,
        reasons: Object.freeze(reasons),
        wordRmsDbfsMilli: word.acoustics.rmsDbfsMilli,
        phraseRmsDbfsMilli: phrase.acoustics.rmsDbfsMilli,
        durationSamples,
        phraseMedianWordDurationSamples: phrase.medianWordDurationSamples,
      }));
    }
  }

  const suggestions: Array<Omit<DialogueSpaceSuggestion, "id">> = [];
  for (const phrase of phrases) {
    suggestions.push(Object.freeze({
      kind: "protect-dialogue",
      basisPhraseId: phrase.id,
      startSample: Math.max(range.startSample, phrase.startSample - clock.dialoguePreRollSamples),
      endSample: Math.min(range.endSample, phrase.endSample + clock.dialoguePostRollSamples),
      basis: "transcript-timing-plus-authored-protection-policy",
      policyBedGainDeltaDbMilli: policy.dialogueProtectionGainDeltaDbMilli,
      sfxGuidance: "avoid-sustained-dialogue-overlap-policy",
    }));
  }
  for (const pause of pauses) {
    if (!pause.quiet || pause.class === "short") continue;
    const startSample = pause.startSample + clock.pauseMarginSamples;
    const endSample = pause.endSample - clock.pauseMarginSamples;
    if (endSample <= startSample) continue;
    suggestions.push(Object.freeze({
      kind: "pause-accent-window",
      basisPauseId: pause.id,
      pauseClass: pause.class,
      startSample,
      endSample,
      maximumEventDurationSamples: Math.max(1, Math.floor((endSample - startSample) / 2)),
    }));
  }
  suggestions.sort((left, right) => left.startSample - right.startSample || left.endSample - right.endSample || left.kind.localeCompare(right.kind));
  const dialogueSpaceSuggestions = suggestions.map((suggestion, index) => Object.freeze({
    id: `space.${String(index + 1).padStart(6, "0")}`,
    ...suggestion,
  })) as DialogueSpaceSuggestion[];

  const firstLexical = lexical[0], lastLexical = lexical.at(-1);
  const activeWordSamples = lexical.reduce((total, word) => total + word.endSample - word.startSample, 0);
  const spanSamples = firstLexical && lastLexical ? lastLexical.endSample - firstLexical.startSample : 0;
  const policySha256 = canonicalHash(policy);
  const body: DialogueProsodyAnalysisBody = Object.freeze({
    format: "cut-dialogue-prosody-analysis",
    version: 1,
    interpretation: "measured-timing-plus-authored-policy-not-emotion-or-performance-approval",
    authority: Object.freeze({
      ...source,
      pcmEncoding: "f32le-interleaved",
      policySha256,
      mediaIdentitySemantics: "transcript-cross-binding-not-original-byte-authentication",
    }),
    range,
    policy,
    samplePolicy: clock,
    speakingRate: Object.freeze({
      lexicalWordCount: lexical.length,
      spanSamples,
      activeWordSamples,
      wordsPerMinuteMilli: wordsPerMinuteMilli(lexical.length, spanSamples, source.sampleRate),
      articulationWordsPerMinuteMilli: wordsPerMinuteMilli(lexical.length, activeWordSamples, source.sampleRate),
    }),
    pauses: Object.freeze(pauses),
    phrases: Object.freeze(phrases),
    sentences: Object.freeze(sentences),
    contours: Object.freeze(contours),
    emphasisCandidates: Object.freeze(emphasisCandidates),
    dialogueSpaceSuggestions: Object.freeze(dialogueSpaceSuggestions),
    work: Object.freeze({
      pcmFramesAuthenticated: source.durationSamples,
      metricFramesRead,
      scalarSamplesRead,
      transcriptWordsVisited: transcript.words.length,
      phraseSentenceAssignments,
      contourPairsVisited,
    }),
  });
  return Object.freeze({ ...body, analysisSha256: canonicalHash(body) });
}
