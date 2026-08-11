import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  AudioTranscriptionError,
  materializeAudioTranscription,
  type AudioTranscriptionErrorCode,
  type NormalizedAudioTranscription,
} from "../lib/audio-intelligence/transcription";
import { stableJsonStringify } from "../lib/core/stable";
import { validateCutTranscript } from "../lib/interchange/transcript";

function inputFixture() {
  return {
    source: {
      locator: "media/interview.wav",
      bytes: 2_304_044,
      sha256: "a".repeat(64),
      streamIndex: 1,
      sampleRate: 48_000,
      durationSamples: 144_000,
      normalizedPcmSha256: "b".repeat(64),
    },
    backend: {
      provider: "whisper.cpp",
      model: "ggml-base.en-q5_1",
      revision: "whisper.cpp@v1.8.2",
      adapterSha256: "c".repeat(64),
      // Deliberately reversed: the receipt owns canonical locator order.
      modelFiles: [
        {
          locator: "models/voice.bin",
          bytes: 8_192,
          sha256: "e".repeat(64),
          license: "CC0-1.0",
        },
        {
          locator: "models/model.bin",
          bytes: 151_000_000,
          sha256: "d".repeat(64),
          license: "MIT",
        },
      ],
    },
    settings: {
      language: "en-US",
      temperatureMilli: 0,
      noFallback: true,
    },
    words: [
      { startSample: 0, endSample: 12_000, text: "Hello", speaker: "Narrator" },
      { startSample: 12_000, endSample: 13_000, text: ",", speaker: "Narrator" },
      { startSample: 13_000, endSample: 14_000, text: "(" },
      { startSample: 14_000, endSample: 24_000, text: "world" },
      { startSample: 24_000, endSample: 25_000, text: ")" },
      { startSample: 30_000, endSample: 48_001, text: "again" },
    ],
  } satisfies NormalizedAudioTranscription;
}

function canonicalHash(value: unknown) {
  return createHash("sha256").update(stableJsonStringify(value), "utf8").digest("hex");
}

function expectAudioError(
  action: () => unknown,
  code: AudioTranscriptionErrorCode,
  path: string,
  message?: RegExp,
) {
  assert.throws(action, (error: unknown) => (
    error instanceof AudioTranscriptionError
      && error.code === code
      && error.path === path
      && error.message.startsWith(`${code} at ${path}:`)
      && (!message || message.test(error.message))
  ));
}

test("materializes exact reduced transcript time, stable IDs, conservative joins, and a canonical receipt", () => {
  const input = inputFixture();
  const first = materializeAudioTranscription(input);
  const second = materializeAudioTranscription(structuredClone(input));

  assert.deepEqual(first, second);
  assert.deepEqual(validateCutTranscript(first.transcript), first.transcript);
  assert.deepEqual(first.transcript.media, {
    sha256: "a".repeat(64),
    audioStreamIndex: 1,
    audioSampleRate: 48_000,
    duration: { numerator: "3", denominator: "1" },
  });
  assert.deepEqual(
    first.transcript.words.map(({ id, start, end, text, join }) => ({ id, start, end, text, join })),
    [
      {
        id: "asr.000001",
        start: { numerator: "0", denominator: "1" },
        end: { numerator: "1", denominator: "4" },
        text: "Hello",
        join: "none",
      },
      {
        id: "asr.000002",
        start: { numerator: "1", denominator: "4" },
        end: { numerator: "13", denominator: "48" },
        text: ",",
        join: "none",
      },
      {
        id: "asr.000003",
        start: { numerator: "13", denominator: "48" },
        end: { numerator: "7", denominator: "24" },
        text: "(",
        join: "space",
      },
      {
        id: "asr.000004",
        start: { numerator: "7", denominator: "24" },
        end: { numerator: "1", denominator: "2" },
        text: "world",
        join: "none",
      },
      {
        id: "asr.000005",
        start: { numerator: "1", denominator: "2" },
        end: { numerator: "25", denominator: "48" },
        text: ")",
        join: "none",
      },
      {
        id: "asr.000006",
        start: { numerator: "5", denominator: "8" },
        end: { numerator: "48001", denominator: "48000" },
        text: "again",
        join: "space",
      },
    ],
  );
  assert.equal(first.transcript.words[0]!.speaker, "Narrator");
  assert.equal(first.transcript.words[2]!.speaker, undefined);

  assert.equal(first.receipt.format, "cut-audio-transcription-receipt");
  assert.equal(first.receipt.version, 1);
  assert.equal(first.receipt.authority, "committed-transcript");
  assert.deepEqual(
    first.receipt.backend.modelFiles.map((file) => file.locator),
    ["models/model.bin", "models/voice.bin"],
  );
  assert.equal(first.receipt.transcriptSha256, canonicalHash(first.transcript));
  const { receiptSha256, ...receiptBody } = first.receipt;
  assert.equal(receiptSha256, canonicalHash(receiptBody));
  assert.match(receiptSha256, /^[0-9a-f]{64}$/u);

  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.receipt), true);
  assert.equal(Object.isFrozen(first.receipt.source), true);
  assert.equal(Object.isFrozen(first.receipt.backend), true);
  assert.equal(Object.isFrozen(first.receipt.backend.modelFiles), true);
  assert.equal(Object.isFrozen(first.receipt.backend.modelFiles[0]), true);
  assert.equal(Object.isFrozen(first.receipt.settings), true);

  input.source.sha256 = "f".repeat(64);
  input.backend.modelFiles[0]!.license = "changed-after-call";
  assert.equal(first.transcript.media.sha256, "a".repeat(64));
  assert.equal(first.receipt.source.sha256, "a".repeat(64));
  assert.equal(first.receipt.backend.modelFiles[1]!.license, "CC0-1.0");
});

test("canonical model-file ordering is input-order independent and all authority dimensions bind the receipt", () => {
  const baselineInput = inputFixture();
  const baseline = materializeAudioTranscription(baselineInput);
  const reordered = inputFixture();
  reordered.backend.modelFiles.reverse();
  assert.deepEqual(materializeAudioTranscription(reordered), baseline);

  const changedSettings = inputFixture();
  changedSettings.settings.temperatureMilli = 1;
  const settingsResult = materializeAudioTranscription(changedSettings);
  assert.equal(settingsResult.receipt.transcriptSha256, baseline.receipt.transcriptSha256);
  assert.notEqual(settingsResult.receipt.receiptSha256, baseline.receipt.receiptSha256);

  const changedBackend = inputFixture();
  changedBackend.backend.adapterSha256 = "9".repeat(64);
  const backendResult = materializeAudioTranscription(changedBackend);
  assert.equal(backendResult.receipt.transcriptSha256, baseline.receipt.transcriptSha256);
  assert.notEqual(backendResult.receipt.receiptSha256, baseline.receipt.receiptSha256);

  const changedPcm = inputFixture();
  changedPcm.source.normalizedPcmSha256 = "8".repeat(64);
  const pcmResult = materializeAudioTranscription(changedPcm);
  assert.equal(pcmResult.receipt.transcriptSha256, baseline.receipt.transcriptSha256);
  assert.notEqual(pcmResult.receipt.receiptSha256, baseline.receipt.receiptSha256);

  const changedTranscript = inputFixture();
  changedTranscript.words[0]!.text = "Hallo";
  const transcriptResult = materializeAudioTranscription(changedTranscript);
  assert.notEqual(transcriptResult.receipt.transcriptSha256, baseline.receipt.transcriptSha256);
  assert.notEqual(transcriptResult.receipt.receiptSha256, baseline.receipt.receiptSha256);
});

test("stable ASR IDs remain zero-padded across decimal boundaries and silence is valid", () => {
  const ten = inputFixture();
  ten.words = Array.from({ length: 10 }, (_, index) => ({
    startSample: index * 100,
    endSample: index * 100 + 50,
    text: `word${index}`,
  }));
  const materialized = materializeAudioTranscription(ten);
  assert.equal(materialized.transcript.words[9]!.id, "asr.000010");

  const silent = inputFixture();
  silent.words = [];
  const empty = materializeAudioTranscription(silent);
  assert.deepEqual(empty.transcript.words, []);
  assert.match(empty.receipt.transcriptSha256, /^[0-9a-f]{64}$/u);
});

test("closed input rejects unknown fields, sparse arrays, accessors, and proxies", () => {
  const root = { ...inputFixture(), unexpected: true };
  expectAudioError(
    () => materializeAudioTranscription(root),
    "CUT_AUDIO_TRANSCRIPTION_FORMAT",
    "$.unexpected",
    /closed transcription input/u,
  );

  const nestedCases: Array<[() => ReturnType<typeof inputFixture>, string]> = [
    [() => {
      const value = inputFixture();
      (value.source as unknown as Record<string, unknown>).unexpected = true;
      return value;
    }, "$.source.unexpected"],
    [() => {
      const value = inputFixture();
      (value.backend as unknown as Record<string, unknown>).unexpected = true;
      return value;
    }, "$.backend.unexpected"],
    [() => {
      const value = inputFixture();
      (value.backend.modelFiles[0] as unknown as Record<string, unknown>).unexpected = true;
      return value;
    }, "$.backend.modelFiles[0].unexpected"],
    [() => {
      const value = inputFixture();
      (value.settings as unknown as Record<string, unknown>).unexpected = true;
      return value;
    }, "$.settings.unexpected"],
    [() => {
      const value = inputFixture();
      (value.words[0] as unknown as Record<string, unknown>).confidence = 0.9;
      return value;
    }, "$.words[0].confidence"],
  ];
  for (const [make, path] of nestedCases) {
    expectAudioError(
      () => materializeAudioTranscription(make()),
      "CUT_AUDIO_TRANSCRIPTION_FORMAT",
      path,
    );
  }

  const sparse = inputFixture();
  delete sparse.words[1];
  expectAudioError(
    () => materializeAudioTranscription(sparse),
    "CUT_AUDIO_TRANSCRIPTION_FORMAT",
    "$.words[1]",
    /sparse arrays/u,
  );

  const extraArrayField = inputFixture();
  (extraArrayField.words as unknown as Record<string, unknown>).metadata = true;
  expectAudioError(
    () => materializeAudioTranscription(extraArrayField),
    "CUT_AUDIO_TRANSCRIPTION_FORMAT",
    "$.words.metadata",
    /closed array/u,
  );

  let getterCalls = 0;
  const accessor = inputFixture();
  Object.defineProperty(accessor.source, "sha256", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "a".repeat(64);
    },
  });
  expectAudioError(
    () => materializeAudioTranscription(accessor),
    "CUT_AUDIO_TRANSCRIPTION_FORMAT",
    "$.source.sha256",
    /data field/u,
  );
  assert.equal(getterCalls, 0);

  let proxyTraps = 0;
  const proxy = new Proxy(inputFixture(), {
    ownKeys(target) {
      proxyTraps += 1;
      return Reflect.ownKeys(target);
    },
  });
  expectAudioError(
    () => materializeAudioTranscription(proxy),
    "CUT_AUDIO_TRANSCRIPTION_FORMAT",
    "$",
    /ordinary object/u,
  );
  assert.equal(proxyTraps, 0);
});

test("sample spans reject unsafe numbers, zero length, overlap, and source-duration overflow", () => {
  const fractional = inputFixture();
  fractional.words[0]!.startSample = 0.5;
  expectAudioError(
    () => materializeAudioTranscription(fractional),
    "CUT_AUDIO_TRANSCRIPTION_WORD",
    "$.words[0].startSample",
    /integer/u,
  );

  const unsafe = inputFixture();
  unsafe.words[0]!.endSample = Number.MAX_SAFE_INTEGER + 1;
  expectAudioError(
    () => materializeAudioTranscription(unsafe),
    "CUT_AUDIO_TRANSCRIPTION_WORD",
    "$.words[0].endSample",
    /safe integer/u,
  );

  const zero = inputFixture();
  zero.words[1]!.endSample = zero.words[1]!.startSample;
  expectAudioError(
    () => materializeAudioTranscription(zero),
    "CUT_AUDIO_TRANSCRIPTION_WORD",
    "$.words[1].endSample",
    /zero and reversed spans/u,
  );

  const overlap = inputFixture();
  overlap.words[1]!.startSample = 11_999;
  expectAudioError(
    () => materializeAudioTranscription(overlap),
    "CUT_AUDIO_TRANSCRIPTION_WORD",
    "$.words[1].startSample",
    /overlaps/u,
  );

  const pastDuration = inputFixture();
  pastDuration.words[5]!.endSample = pastDuration.source.durationSamples + 1;
  expectAudioError(
    () => materializeAudioTranscription(pastDuration),
    "CUT_AUDIO_TRANSCRIPTION_WORD",
    "$.words[5].endSample",
    /durationSamples/u,
  );

  const zeroDuration = inputFixture();
  zeroDuration.source.durationSamples = 0;
  expectAudioError(
    () => materializeAudioTranscription(zeroDuration),
    "CUT_AUDIO_TRANSCRIPTION_SOURCE",
    "$.source.durationSamples",
    /positive safe integer/u,
  );
});

test("provider whitespace is never authority and control or bidi hazards fail in every human-readable domain", () => {
  const embeddedWhitespace = inputFixture();
  embeddedWhitespace.words[3]!.text = "two words";
  expectAudioError(
    () => materializeAudioTranscription(embeddedWhitespace),
    "CUT_AUDIO_TRANSCRIPTION_WORD",
    "$.words[3].text",
    /embedded whitespace/u,
  );

  const providerLeadingWhitespace = inputFixture();
  providerLeadingWhitespace.words[3]!.text = " world";
  expectAudioError(
    () => materializeAudioTranscription(providerLeadingWhitespace),
    "CUT_AUDIO_TRANSCRIPTION_WORD",
    "$.words[3].text",
    /surrounding whitespace/u,
  );

  const bidiWord = inputFixture();
  bidiWord.words[3]!.text = "world\u202e";
  expectAudioError(
    () => materializeAudioTranscription(bidiWord),
    "CUT_AUDIO_TRANSCRIPTION_WORD",
    "$.words[3].text",
    /safe Unicode/u,
  );

  const controlSpeaker = inputFixture();
  controlSpeaker.words[0]!.speaker = "Narrator\u0007";
  expectAudioError(
    () => materializeAudioTranscription(controlSpeaker),
    "CUT_AUDIO_TRANSCRIPTION_WORD",
    "$.words[0].speaker",
    /safe Unicode/u,
  );

  const bidiBackend = inputFixture();
  bidiBackend.backend.model = "model\u2066";
  expectAudioError(
    () => materializeAudioTranscription(bidiBackend),
    "CUT_AUDIO_TRANSCRIPTION_BACKEND",
    "$.backend.model",
    /safe Unicode/u,
  );

  const bidiLicense = inputFixture();
  bidiLicense.backend.modelFiles[0]!.license = "MIT\u061c";
  expectAudioError(
    () => materializeAudioTranscription(bidiLicense),
    "CUT_AUDIO_TRANSCRIPTION_BACKEND",
    "$.backend.modelFiles[0].license",
    /safe Unicode/u,
  );

  const badLocator = inputFixture();
  badLocator.source.locator = "../media/interview.wav";
  expectAudioError(
    () => materializeAudioTranscription(badLocator),
    "CUT_AUDIO_TRANSCRIPTION_SOURCE",
    "$.source.locator",
    /project-relative POSIX locator/u,
  );
});

test("source, backend, and deterministic settings have strict closed validation", () => {
  const uppercaseDigest = inputFixture();
  uppercaseDigest.source.sha256 = "A".repeat(64);
  expectAudioError(
    () => materializeAudioTranscription(uppercaseDigest),
    "CUT_AUDIO_TRANSCRIPTION_SOURCE",
    "$.source.sha256",
    /lowercase/u,
  );

  const excessiveSampleRate = inputFixture();
  excessiveSampleRate.source.sampleRate = 768_001;
  expectAudioError(
    () => materializeAudioTranscription(excessiveSampleRate),
    "CUT_AUDIO_TRANSCRIPTION_SOURCE",
    "$.source.sampleRate",
    /768000/u,
  );

  const duplicateModelLocator = inputFixture();
  duplicateModelLocator.backend.modelFiles[1]!.locator = duplicateModelLocator.backend.modelFiles[0]!.locator;
  expectAudioError(
    () => materializeAudioTranscription(duplicateModelLocator),
    "CUT_AUDIO_TRANSCRIPTION_BACKEND",
    "$.backend.modelFiles[1].locator",
    /duplicates/u,
  );

  const emptyModels = inputFixture();
  emptyModels.backend.modelFiles = [];
  expectAudioError(
    () => materializeAudioTranscription(emptyModels),
    "CUT_AUDIO_TRANSCRIPTION_FORMAT",
    "$.backend.modelFiles",
    /at least 1/u,
  );

  const badLanguage = inputFixture();
  badLanguage.settings.language = "en_US";
  expectAudioError(
    () => materializeAudioTranscription(badLanguage),
    "CUT_AUDIO_TRANSCRIPTION_SETTINGS",
    "$.settings.language",
    /language tag/u,
  );

  const excessiveTemperature = inputFixture();
  excessiveTemperature.settings.temperatureMilli = 1_001;
  expectAudioError(
    () => materializeAudioTranscription(excessiveTemperature),
    "CUT_AUDIO_TRANSCRIPTION_SETTINGS",
    "$.settings.temperatureMilli",
    /0 through 1000/u,
  );

  const badFallback = inputFixture();
  (badFallback.settings as unknown as Record<string, unknown>).noFallback = "true";
  expectAudioError(
    () => materializeAudioTranscription(badFallback),
    "CUT_AUDIO_TRANSCRIPTION_SETTINGS",
    "$.settings.noFallback",
    /boolean/u,
  );
});

test("caller limits can only tighten bounded work", () => {
  expectAudioError(
    () => materializeAudioTranscription(inputFixture(), { maxWords: 5 }),
    "CUT_AUDIO_TRANSCRIPTION_LIMIT",
    "$.words",
    /item limit/u,
  );
  expectAudioError(
    () => materializeAudioTranscription(inputFixture(), { maxWordTextBytes: 4 }),
    "CUT_AUDIO_TRANSCRIPTION_LIMIT",
    "$.words[0].text",
    /byte limit/u,
  );
  expectAudioError(
    () => materializeAudioTranscription(inputFixture(), { maxTextBytes: 5 }),
    "CUT_AUDIO_TRANSCRIPTION_LIMIT",
    "$.words[1].text",
    /cumulative word text/u,
  );
  expectAudioError(
    () => materializeAudioTranscription(inputFixture(), { maxModelFiles: 1 }),
    "CUT_AUDIO_TRANSCRIPTION_LIMIT",
    "$.backend.modelFiles",
    /item limit/u,
  );
  expectAudioError(
    () => materializeAudioTranscription(inputFixture(), { maxWords: 250_001 }),
    "CUT_AUDIO_TRANSCRIPTION_LIMIT",
    "$.limits.maxWords",
    /1 through 250000/u,
  );
  expectAudioError(
    () => materializeAudioTranscription(
      inputFixture(),
      { unexpected: 1 } as unknown as Partial<Parameters<typeof materializeAudioTranscription>[1]>,
    ),
    "CUT_AUDIO_TRANSCRIPTION_FORMAT",
    "$.limits.unexpected",
    /closed transcription input/u,
  );
});
