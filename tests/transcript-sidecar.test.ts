import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv from "ajv";
import {
  parseCutTranscript,
  selectTranscriptRange,
  TranscriptInterchangeError,
  validateCutTranscript,
  type TranscriptErrorCode,
} from "../lib/interchange/transcript";
import { rational } from "../lib/language/rational";

const q = (numerator: bigint | number | string, denominator: bigint | number | string = 1) => (
  rational(numerator, denominator)
);

function fixture() {
  return {
    format: "cut-transcript",
    version: 1,
    media: {
      sha256: "a".repeat(64),
      audioStreamIndex: 1,
      audioSampleRate: 48_000,
      duration: q(1),
      videoStreamIndex: 0,
      videoFrameRate: q(30_000, 1_001),
    },
    words: [
      { id: "w1", start: q(0), end: q(1, 48_000), text: "Hello", join: "none" },
      { id: "w2", start: q(1, 48_000), end: q(2, 48_000), text: ",", join: "none" },
      { id: "w3", start: q(2, 48_000), end: q(3, 48_000), text: "world", join: "space", speaker: "Narrator" },
      { id: "w4", start: q(3, 48_000), end: q(4, 48_000), text: "!", join: "none", speaker: "Narrator" },
    ],
  };
}

function expectTranscriptError(
  action: () => unknown,
  code: TranscriptErrorCode,
  path: string,
  message?: RegExp,
) {
  assert.throws(action, (error: unknown) => (
    error instanceof TranscriptInterchangeError
    && error.code === code
    && error.path === path
    && error.message.startsWith(`${code} at ${path}:`)
    && (!message || message.test(error.message))
  ));
}

test("closed schema accepts audio-first media and requires complete optional video provenance", async () => {
  const schema = JSON.parse(await readFile("schemas/cut-transcript-v1.schema.json", "utf8")) as object;
  const validate = new Ajv({
    schemaId: "auto",
    meta: false,
    validateSchema: false,
    allErrors: true,
    jsonPointers: true,
  }).compile(schema);
  assert.equal(validate(fixture()), true, JSON.stringify(validate.errors));
  const audioOnly = structuredClone(fixture());
  delete (audioOnly.media as Partial<typeof audioOnly.media>).videoStreamIndex;
  delete (audioOnly.media as Partial<typeof audioOnly.media>).videoFrameRate;
  assert.equal(validate(audioOnly), true, JSON.stringify(validate.errors));
  assert.equal(validateCutTranscript(audioOnly).media.videoFrameRate, undefined);
  assert.equal(validate({ ...fixture(), privateGraph: true }), false);
  assert.equal(validate({
    ...fixture(),
    media: { ...fixture().media, privateAssetLocator: "/private/source.mov" },
  }), false);
  assert.equal(validate({
    ...fixture(),
    words: fixture().words.map((word, index) => index === 0 ? { ...word, confidence: 1 } : word),
  }), false);
  const missingVideoRate = structuredClone(fixture());
  delete (missingVideoRate.media as Partial<typeof missingVideoRate.media>).videoFrameRate;
  assert.equal(validate(missingVideoRate), false);
  const negativeZero = structuredClone(fixture());
  negativeZero.words[0]!.start.numerator = "-0";
  assert.equal(validate(negativeZero), false);

  const withDelta = structuredClone(fixture());
  const deltaMedia = withDelta.media as unknown as Record<string, unknown>;
  deltaMedia.videoDuration = q(1);
  deltaMedia.audioVideoPresentationDelta = q(1, 4);
  assert.equal(validate(withDelta), true, JSON.stringify(validate.errors));
  assert.deepEqual(
    validateCutTranscript(withDelta).media.audioVideoPresentationDelta,
    q(1, 4),
  );

  const negativeDelta = structuredClone(withDelta);
  (negativeDelta.media as unknown as Record<string, unknown>)
    .audioVideoPresentationDelta = q(-1, 4);
  assert.equal(validate(negativeDelta), true, JSON.stringify(validate.errors));
  assert.deepEqual(
    validateCutTranscript(negativeDelta).media.audioVideoPresentationDelta,
    q(-1, 4),
  );

  const zeroDelta = structuredClone(withDelta);
  (zeroDelta.media as unknown as Record<string, unknown>)
    .audioVideoPresentationDelta = q(0);
  assert.equal(validate(zeroDelta), false);
  expectTranscriptError(
    () => validateCutTranscript(zeroDelta),
    "CUT_TRANSCRIPT_TIME",
    "$.media.audioVideoPresentationDelta",
    /must be omitted/,
  );

  const deltaWithoutVideoDuration = structuredClone(withDelta);
  delete (deltaWithoutVideoDuration.media as unknown as Record<string, unknown>)
    .videoDuration;
  assert.equal(validate(deltaWithoutVideoDuration), false);
  expectTranscriptError(
    () => validateCutTranscript(deltaWithoutVideoDuration),
    "CUT_TRANSCRIPT_MEDIA",
    "$.media.videoDuration",
    /required when audioVideoPresentationDelta is present/,
  );
});

test("an empty word list is a valid silent transcript but cannot satisfy an ID selection", () => {
  const silent = fixture();
  silent.words = [];
  const parsed = parseCutTranscript(JSON.stringify(silent));
  assert.deepEqual(parsed.words, []);
  expectTranscriptError(
    () => selectTranscriptRange(parsed, { from: "w1", through: "w1" }),
    "CUT_TRANSCRIPT_ID",
    "$.selection.from",
    /does not identify/,
  );
});

test("parse and inclusive from/through selection are deterministic, exact, and audio-first", () => {
  const source = JSON.stringify(fixture());
  const first = parseCutTranscript(source);
  const second = parseCutTranscript(new TextEncoder().encode(source));
  assert.deepEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.media), true);
  assert.equal(Object.isFrozen(first.words), true);
  assert.equal(Object.isFrozen(first.words[0]), true);

  const selection = selectTranscriptRange(first, { from: "w2", through: "w4" });
  assert.equal(selection.text, ", world!");
  assert.equal(selection.selectedWordCount, 3);
  assert.equal(
    selection.selectedIdsSha256,
    createHash("sha256").update(JSON.stringify(["w2", "w3", "w4"])).digest("hex"),
  );
  assert.deepEqual(selection.sourceRange, {
    start: q(1, 48_000),
    end: q(4, 48_000),
    duration: q(3, 48_000),
  });
  assert.deepEqual(selection.media, first.media);
  assert.equal(selection.media.videoFrameRate?.numerator, "30000");

  // These word bounds are not on a 30000/1001 video-frame grid. Video
  // provenance is deliberately not a speech-edit quantization grid.
  assert.equal(
    BigInt(first.words[1]!.start.numerator) * 30_000n
      % (BigInt(first.words[1]!.start.denominator) * 1_001n),
    30_000n,
  );

  const oneWord = selectTranscriptRange(first, { from: "w3", through: "w3" });
  assert.equal(oneWord.text, "world");
  assert.deepEqual(oneWord.sourceRange.duration, q(1, 48_000));
});

test("preparse bytes, word counts, text totals, and rational digits fail before unbounded work", () => {
  expectTranscriptError(
    () => parseCutTranscript(Uint8Array.from([0x7b, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0xff]), {
      maxBytes: 8,
    }),
    "CUT_TRANSCRIPT_LIMIT",
    "$",
    /maxBytes/,
  );
  expectTranscriptError(
    () => parseCutTranscript(JSON.stringify(fixture()), { maxJsonDepth: 1 }),
    "CUT_TRANSCRIPT_LIMIT",
    "$.format",
    /maxJsonDepth/,
  );

  const tooMany = structuredClone(fixture());
  tooMany.words[0]!.start = { numerator: "9".repeat(128), denominator: "1" };
  expectTranscriptError(
    () => validateCutTranscript(tooMany, { maxWords: 3 }),
    "CUT_TRANSCRIPT_LIMIT",
    "$.words",
    /maxWords/,
  );

  expectTranscriptError(
    () => validateCutTranscript(fixture(), { maxTextBytes: 5 }),
    "CUT_TRANSCRIPT_LIMIT",
    "$.words[1].text",
    /maxTextBytes/,
  );

  const longRational = structuredClone(fixture());
  longRational.media.duration = { numerator: "123", denominator: "1" };
  expectTranscriptError(
    () => validateCutTranscript(longRational, { maxRationalDigits: 2 }),
    "CUT_TRANSCRIPT_LIMIT",
    "$.media.duration.numerator",
    /maxRationalDigits/,
  );
});

test("UTF-8, JSON shape, unknown fields, word text, and join semantics fail with FORMAT paths", () => {
  expectTranscriptError(
    () => parseCutTranscript(Uint8Array.from([0xc3, 0x28])),
    "CUT_TRANSCRIPT_FORMAT",
    "$",
    /valid UTF-8/,
  );
  expectTranscriptError(
    () => parseCutTranscript("\ufeff{}"),
    "CUT_TRANSCRIPT_FORMAT",
    "$",
    /BOM/,
  );
  expectTranscriptError(
    () => parseCutTranscript(Uint8Array.from([
      0xef, 0xbb, 0xbf,
      ...new TextEncoder().encode(JSON.stringify(fixture())),
    ])),
    "CUT_TRANSCRIPT_FORMAT",
    "$",
    /BOM/,
  );
  expectTranscriptError(
    () => parseCutTranscript("{"),
    "CUT_TRANSCRIPT_FORMAT",
    "$",
    /valid JSON/,
  );
  expectTranscriptError(
    () => parseCutTranscript('{"format":"cut-transcript","\\u0066ormat":"cut-transcript","version":1,"media":{},"words":[]}'),
    "CUT_TRANSCRIPT_FORMAT",
    "$.format",
    /duplicates JSON object key/,
  );
  expectTranscriptError(
    () => parseCutTranscript('{"format":"cut-transcript","version":1,"media":{},"words":[{"id":"first","id":"second"}]}'),
    "CUT_TRANSCRIPT_FORMAT",
    "$.words[0].id",
    /duplicates JSON object key/,
  );
  expectTranscriptError(
    () => validateCutTranscript({ ...fixture(), unexpected: true }),
    "CUT_TRANSCRIPT_FORMAT",
    '$["unexpected"]',
    /not part/,
  );
  const spacedWord = structuredClone(fixture());
  spacedWord.words[1]!.text = "two words";
  expectTranscriptError(
    () => validateCutTranscript(spacedWord),
    "CUT_TRANSCRIPT_FORMAT",
    "$.words[1].text",
    /without whitespace/,
  );
  const bidiWord = structuredClone(fixture());
  bidiWord.words[1]!.text = "word\u202e";
  expectTranscriptError(
    () => validateCutTranscript(bidiWord),
    "CUT_TRANSCRIPT_FORMAT",
    "$.words[1].text",
    /safe Unicode/,
  );
  const noncharacterWord = structuredClone(fixture());
  noncharacterWord.words[1]!.text = "word\ufdd0";
  expectTranscriptError(
    () => validateCutTranscript(noncharacterWord),
    "CUT_TRANSCRIPT_FORMAT",
    "$.words[1].text",
    /safe Unicode/,
  );
  const arabicLetterMarkWord = structuredClone(fixture());
  arabicLetterMarkWord.words[1]!.text = "word\u061c";
  expectTranscriptError(
    () => validateCutTranscript(arabicLetterMarkWord),
    "CUT_TRANSCRIPT_FORMAT",
    "$.words[1].text",
    /safe Unicode/,
  );
  const bidiSpeaker = structuredClone(fixture());
  bidiSpeaker.words[2]!.speaker = "Narrator\u2066";
  expectTranscriptError(
    () => validateCutTranscript(bidiSpeaker),
    "CUT_TRANSCRIPT_FORMAT",
    "$.words[2].speaker",
    /safe Unicode/,
  );
  const unpairedSpeaker = structuredClone(fixture());
  unpairedSpeaker.words[2]!.speaker = "\ud800";
  expectTranscriptError(
    () => validateCutTranscript(unpairedSpeaker),
    "CUT_TRANSCRIPT_FORMAT",
    "$.words[2].speaker",
    /safe Unicode/,
  );
  expectTranscriptError(
    () => parseCutTranscript(JSON.stringify(unpairedSpeaker)),
    "CUT_TRANSCRIPT_FORMAT",
    "$.words[2].speaker",
    /safe Unicode/,
  );
  const leadingJoin = structuredClone(fixture());
  leadingJoin.words[0]!.join = "space";
  expectTranscriptError(
    () => validateCutTranscript(leadingJoin),
    "CUT_TRANSCRIPT_FORMAT",
    "$.words[0].join",
    /no word precedes/,
  );
});

test("stable IDs are bounded and unique; missing or reversed selections fail with ID paths", () => {
  const duplicate = structuredClone(fixture());
  duplicate.words[2]!.id = "w2";
  expectTranscriptError(
    () => validateCutTranscript(duplicate),
    "CUT_TRANSCRIPT_ID",
    "$.words[2].id",
    /duplicates/,
  );
  const invalid = structuredClone(fixture());
  invalid.words[1]!.id = "word with spaces";
  expectTranscriptError(
    () => validateCutTranscript(invalid),
    "CUT_TRANSCRIPT_ID",
    "$.words[1].id",
    /stable ASCII/,
  );

  const parsed = validateCutTranscript(fixture());
  expectTranscriptError(
    () => selectTranscriptRange(parsed, { from: "absent", through: "w2" }),
    "CUT_TRANSCRIPT_ID",
    "$.selection.from",
    /does not identify/,
  );
  expectTranscriptError(
    () => selectTranscriptRange(parsed, { from: "w2", through: "absent" }),
    "CUT_TRANSCRIPT_ID",
    "$.selection.through",
    /does not identify/,
  );
  expectTranscriptError(
    () => selectTranscriptRange(parsed, { from: "w4", through: "w1" }),
    "CUT_TRANSCRIPT_ID",
    "$.selection.through",
    /precedes/,
  );
});

test("canonical exact time rejects -0, unreduced values, nonpositive spans, order, overlap, and media overflow", () => {
  const negativeZero = structuredClone(fixture());
  negativeZero.words[0]!.start = { numerator: "-0", denominator: "1" };
  expectTranscriptError(
    () => validateCutTranscript(negativeZero),
    "CUT_TRANSCRIPT_TIME",
    "$.words[0].start.numerator",
    /-0/,
  );

  const unreduced = structuredClone(fixture());
  unreduced.words[1]!.start = { numerator: "2", denominator: "96000" };
  expectTranscriptError(
    () => validateCutTranscript(unreduced),
    "CUT_TRANSCRIPT_TIME",
    "$.words[1].start",
    /reduced canonical/,
  );

  const zeroSpan = structuredClone(fixture());
  zeroSpan.words[1]!.end = zeroSpan.words[1]!.start;
  expectTranscriptError(
    () => validateCutTranscript(zeroSpan),
    "CUT_TRANSCRIPT_TIME",
    "$.words[1].end",
    /strictly later/,
  );

  const overlap = structuredClone(fixture());
  overlap.words[2]!.start = q(1, 48_000);
  expectTranscriptError(
    () => validateCutTranscript(overlap),
    "CUT_TRANSCRIPT_TIME",
    "$.words[2].start",
    /overlaps/,
  );

  const outOfOrder = structuredClone(fixture());
  outOfOrder.words[2]!.start = q(0);
  outOfOrder.words[2]!.end = q(1, 48_000);
  expectTranscriptError(
    () => validateCutTranscript(outOfOrder),
    "CUT_TRANSCRIPT_TIME",
    "$.words[2].start",
    /out of chronological order/,
  );

  const pastDuration = structuredClone(fixture());
  pastDuration.words[3]!.end = q(2);
  expectTranscriptError(
    () => validateCutTranscript(pastDuration),
    "CUT_TRANSCRIPT_TIME",
    "$.words[3].end",
    /media duration/,
  );
});

test("audio-sample grid arithmetic remains exact beyond Number precision", () => {
  const startSample = 9_007_199_254_740_997n;
  const endSample = startSample + 1n;
  const huge = {
    format: "cut-transcript",
    version: 1,
    media: {
      sha256: "b".repeat(64),
      audioStreamIndex: 0,
      audioSampleRate: 48_000,
      duration: q(endSample + 1n, 48_000),
    },
    words: [{
      id: "exact",
      start: q(startSample, 48_000),
      end: q(endSample, 48_000),
      text: "exact",
      join: "none",
    }],
  };
  const parsed = validateCutTranscript(huge);
  assert.equal(
    BigInt(parsed.words[0]!.start.numerator) * 48_000n % BigInt(parsed.words[0]!.start.denominator),
    0n,
  );
  assert.equal(selectTranscriptRange(parsed, { from: "exact", through: "exact" }).text, "exact");

  const offGrid = structuredClone(fixture());
  offGrid.words[1]!.end = q(1, 47_999);
  expectTranscriptError(
    () => validateCutTranscript(offGrid),
    "CUT_TRANSCRIPT_GRID",
    "$.words[1].end",
    /audio-sample grid/,
  );
});

test("media binding validates hashes, stream provenance, sample rates, and optional video pairing", () => {
  const badHash = structuredClone(fixture());
  badHash.media.sha256 = "A".repeat(64);
  expectTranscriptError(
    () => validateCutTranscript(badHash),
    "CUT_TRANSCRIPT_MEDIA",
    "$.media.sha256",
    /lowercase/,
  );

  const incompleteVideo = structuredClone(fixture());
  delete (incompleteVideo.media as Partial<typeof incompleteVideo.media>).videoFrameRate;
  expectTranscriptError(
    () => validateCutTranscript(incompleteVideo),
    "CUT_TRANSCRIPT_MEDIA",
    "$.media.videoFrameRate",
    /required/,
  );

  const streamCollision = structuredClone(fixture());
  streamCollision.media.videoStreamIndex = 1;
  expectTranscriptError(
    () => validateCutTranscript(streamCollision),
    "CUT_TRANSCRIPT_MEDIA",
    "$.media.videoStreamIndex",
    /audio stream/,
  );

  const badSampleRate = structuredClone(fixture());
  badSampleRate.media.audioSampleRate = 0;
  expectTranscriptError(
    () => validateCutTranscript(badSampleRate),
    "CUT_TRANSCRIPT_MEDIA",
    "$.media.audioSampleRate",
    /1 through/,
  );
});
