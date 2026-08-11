import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  analyzeDialogueProsody,
  DialogueProsodyError,
  dialogueProsodyLimits,
  hashDialogueProsodyPcmF32,
  hashDialogueProsodyTranscript,
  type DialogueProsodyErrorCode,
  type DialogueProsodyInput,
} from "../lib/audio-intelligence/dialogue-prosody";
import { stableJsonStringify } from "../lib/core/stable";
import type { CutTranscript } from "../lib/interchange/transcript";
import { rational } from "../lib/language/rational";

const sampleRate = 8_000;
const durationSamples = sampleRate * 4;
const mediaSha256 = "a".repeat(64);

function transcriptFixture(): CutTranscript {
  return {
    format: "cut-transcript",
    version: 1,
    media: {
      sha256: mediaSha256,
      audioStreamIndex: 0,
      audioSampleRate: sampleRate,
      duration: rational(4),
    },
    words: [
      { id: "w1", start: rational(800, sampleRate), end: rational(2_800, sampleRate), text: "Calm", join: "none" },
      { id: "p1", start: rational(2_800, sampleRate), end: rational(2_880, sampleRate), text: ",", join: "none" },
      { id: "w2", start: rational(3_600, sampleRate), end: rational(5_200, sampleRate), text: "clear", join: "space" },
      { id: "w3", start: rational(8_400, sampleRate), end: rational(9_200, sampleRate), text: "then", join: "space" },
      { id: "w4", start: rational(9_600, sampleRate), end: rational(12_800, sampleRate), text: "listen", join: "space" },
      { id: "p2", start: rational(12_800, sampleRate), end: rational(12_880, sampleRate), text: "!", join: "none" },
      { id: "w5", start: rational(20_800, sampleRate), end: rational(24_000, sampleRate), text: "Now", join: "space" },
    ],
  };
}

function paint(pcm: Float32Array, channels: 1 | 2, start: number, end: number, amplitude: number) {
  for (let frame = start; frame < end; frame += 1) {
    pcm[frame * channels] = amplitude;
    if (channels === 2) pcm[frame * channels + 1] = amplitude / 2;
  }
}

function inputFixture(channels: 1 | 2 = 1): DialogueProsodyInput {
  const transcript = transcriptFixture();
  const pcm = new Float32Array(durationSamples * channels);
  paint(pcm, channels, 800, 2_800, 0.1);
  paint(pcm, channels, 3_600, 5_200, 0.1);
  paint(pcm, channels, 8_400, 9_200, 0.5);
  paint(pcm, channels, 9_600, 12_800, 0.1);
  paint(pcm, channels, 20_800, 24_000, 0.25);
  return {
    source: {
      mediaSha256,
      audioStreamIndex: 0,
      normalizedPcmSha256: hashDialogueProsodyPcmF32(pcm),
      transcriptSha256: hashDialogueProsodyTranscript(transcript),
      sampleRate,
      channels,
      durationSamples,
    },
    pcm,
    transcript,
  };
}

function expectError(action: () => unknown, code: DialogueProsodyErrorCode, path: string, message?: RegExp) {
  assert.throws(action, (error: unknown) => error instanceof DialogueProsodyError
    && error.code === code
    && error.path === path
    && error.message.startsWith(`${code} at ${path}:`)
    && (!message || message.test(error.message)));
}

function canonicalHash(value: unknown) {
  return createHash("sha256").update(stableJsonStringify(value), "utf8").digest("hex");
}

test("dialogue prosody measures exact rate, pauses, structure, contours, emphasis, and editorial space", () => {
  const input = inputFixture();
  const before = Buffer.from(input.pcm.buffer.slice(0));
  const first = analyzeDialogueProsody(input);
  const second = analyzeDialogueProsody(structuredClone(input));

  assert.deepEqual(first, second);
  assert.deepEqual(Buffer.from(input.pcm.buffer), before);
  assert.equal(first.format, "cut-dialogue-prosody-analysis");
  assert.equal(first.version, 1);
  assert.equal(first.interpretation, "measured-timing-plus-authored-policy-not-emotion-or-performance-approval");
  assert.equal(first.authority.mediaIdentitySemantics, "transcript-cross-binding-not-original-byte-authentication");
  assert.deepEqual(first.samplePolicy, {
    minimumPauseSamples: 960,
    mediumPauseSamples: 2_800,
    longPauseSamples: 5_600,
    sentencePauseSamples: 7_200,
    dialoguePreRollSamples: 640,
    dialoguePostRollSamples: 960,
    pauseMarginSamples: 320,
  });
  assert.deepEqual(first.speakingRate, {
    lexicalWordCount: 5,
    spanSamples: 23_200,
    activeWordSamples: 10_800,
    wordsPerMinuteMilli: 103_448,
    articulationWordsPerMinuteMilli: 222_222,
  });
  assert.deepEqual(first.pauses.map((pause) => ({
    pair: [pause.precedingWordId, pause.followingWordId],
    range: [pause.startSample, pause.endSample],
    class: pause.class,
    quiet: pause.quiet,
    activityPpm: pause.acoustics.activityPpm,
  })), [
    { pair: ["w2", "w3"], range: [5_200, 8_400], class: "medium", quiet: true, activityPpm: 0 },
    { pair: ["w4", "w5"], range: [12_800, 20_800], class: "long", quiet: true, activityPpm: 0 },
  ]);
  assert.deepEqual(first.phrases.map((phrase) => [phrase.firstWordId, phrase.lastWordId, phrase.sentenceId]), [
    ["w1", "w1", "sentence.000001"],
    ["w2", "w2", "sentence.000001"],
    ["w3", "w4", "sentence.000001"],
    ["w5", "w5", "sentence.000002"],
  ]);
  assert.deepEqual(first.sentences.map((sentence) => [sentence.firstWordId, sentence.lastWordId, sentence.phraseIds]), [
    ["w1", "w4", ["phrase.000001", "phrase.000002", "phrase.000003"]],
    ["w5", "w5", ["phrase.000004"]],
  ]);
  assert.ok(first.contours.some((contour) => contour.rateDirection !== "steady"));
  assert.ok(first.contours.some((contour) => contour.dynamicDirection !== "steady"));
  assert.deepEqual(first.emphasisCandidates.find((candidate) => candidate.wordId === "w3")?.reasons, [
    "isolated-after-pause",
    "level-rise",
  ]);
  assert.ok(first.emphasisCandidates.find((candidate) => candidate.wordId === "w4")?.reasons.includes("lengthened-delivery"));
  assert.ok(first.dialogueSpaceSuggestions.some((suggestion) => suggestion.kind === "protect-dialogue"));
  assert.deepEqual(
    first.dialogueSpaceSuggestions.find((suggestion) => suggestion.kind === "protect-dialogue"),
    {
      id: "space.000001",
      kind: "protect-dialogue",
      basisPhraseId: "phrase.000001",
      startSample: 160,
      endSample: 3_760,
      basis: "transcript-timing-plus-authored-protection-policy",
      policyBedGainDeltaDbMilli: -6_000,
      sfxGuidance: "avoid-sustained-dialogue-overlap-policy",
    },
  );
  assert.deepEqual(first.dialogueSpaceSuggestions.filter((suggestion) => suggestion.kind === "pause-accent-window").map((suggestion) => ({
    pause: suggestion.basisPauseId,
    class: suggestion.pauseClass,
    range: [suggestion.startSample, suggestion.endSample],
  })), [
    { pause: "pause.000001", class: "medium", range: [5_520, 8_080] },
    { pause: "pause.000002", class: "long", range: [13_120, 20_480] },
  ]);
  const { analysisSha256, ...body } = first;
  assert.equal(analysisSha256, canonicalHash(body));
  assert.match(analysisSha256, /^[0-9a-f]{64}$/u);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.pauses), true);
  assert.equal(Object.isFrozen(first.phrases[0]?.acoustics), true);
  assert.equal(Object.isFrozen(first.dialogueSpaceSuggestions[0]), true);
});

test("stereo analysis is channel-aware, integer-only, deterministic, and non-aliasing", () => {
  const input = inputFixture(2);
  const result = analyzeDialogueProsody(input);
  assert.equal(result.authority.channels, 2);
  assert.ok(result.phrases.every((phrase) => Number.isInteger(phrase.acoustics.rmsDbfsMilli)
    && Number.isInteger(phrase.acoustics.peakDbfsMilli)
    && Number.isInteger(phrase.acoustics.meanAbsolutePpm)
    && Number.isInteger(phrase.acoustics.activityPpm)));
  assert.equal(result.work.pcmFramesAuthenticated, durationSamples);
  assert.equal(result.work.scalarSamplesRead, result.work.metricFramesRead * 2);

  input.pcm.fill(0);
  assert.notEqual(hashDialogueProsodyPcmF32(input.pcm), result.authority.normalizedPcmSha256);
  assert.ok(result.phrases.some((phrase) => phrase.acoustics.peakDbfsMilli > -120_000));
});

test("exact millisecond boundaries classify pauses without floating-point clock drift", () => {
  const result = analyzeDialogueProsody({
    ...inputFixture(),
    policy: {
      mediumPauseMilliseconds: 400,
      longPauseMilliseconds: 1_000,
      sentencePauseMilliseconds: 1_000,
    },
  });
  assert.equal(result.samplePolicy.mediumPauseSamples, 3_200);
  assert.equal(result.samplePolicy.longPauseSamples, 8_000);
  assert.deepEqual(result.pauses.map((pause) => [pause.durationSamples, pause.class]), [
    [3_200, "medium"],
    [8_000, "long"],
  ]);
});

test("all source, PCM, transcript, policy, and range identities bind the canonical analysis", () => {
  const baseline = inputFixture();
  const first = analyzeDialogueProsody(baseline);

  const changedPcm = inputFixture();
  changedPcm.pcm[900] = 0.2;
  (changedPcm.source as { normalizedPcmSha256: string }).normalizedPcmSha256 = hashDialogueProsodyPcmF32(changedPcm.pcm);
  assert.notEqual(analyzeDialogueProsody(changedPcm).analysisSha256, first.analysisSha256);

  const changedTranscript = inputFixture();
  (changedTranscript.transcript.words[0] as { text: string }).text = "Quiet";
  (changedTranscript.source as { transcriptSha256: string }).transcriptSha256 = hashDialogueProsodyTranscript(changedTranscript.transcript);
  assert.notEqual(analyzeDialogueProsody(changedTranscript).analysisSha256, first.analysisSha256);

  const changedPolicy = { ...inputFixture(), policy: { dialogueProtectionGainDeltaDbMilli: -9_000 } };
  assert.notEqual(analyzeDialogueProsody(changedPolicy).analysisSha256, first.analysisSha256);

  const changedRange = { ...inputFixture(), range: { startSample: 3_600, endSample: 5_200 } };
  const ranged = analyzeDialogueProsody(changedRange);
  assert.notEqual(ranged.analysisSha256, first.analysisSha256);
  assert.equal(ranged.speakingRate.lexicalWordCount, 1);
  assert.deepEqual(ranged.range, changedRange.range);
});

test("authority mismatches fail before analysis", () => {
  const pcm = inputFixture();
  (pcm.source as { normalizedPcmSha256: string }).normalizedPcmSha256 = "f".repeat(64);
  expectError(() => analyzeDialogueProsody(pcm), "CUT_DIALOGUE_PROSODY_AUTHORITY", "$.source.normalizedPcmSha256");

  const transcript = inputFixture();
  (transcript.source as { transcriptSha256: string }).transcriptSha256 = "e".repeat(64);
  expectError(() => analyzeDialogueProsody(transcript), "CUT_DIALOGUE_PROSODY_AUTHORITY", "$.source.transcriptSha256");

  const media = inputFixture();
  (media.source as { mediaSha256: string }).mediaSha256 = "d".repeat(64);
  expectError(() => analyzeDialogueProsody(media), "CUT_DIALOGUE_PROSODY_AUTHORITY", "$.source.mediaSha256");

  const stream = inputFixture();
  (stream.source as { audioStreamIndex: number }).audioStreamIndex = 1;
  expectError(() => analyzeDialogueProsody(stream), "CUT_DIALOGUE_PROSODY_AUTHORITY", "$.source.audioStreamIndex");
});

test("every transcript time must land on the exact sample clock and range boundaries cannot split words", () => {
  const offGrid = inputFixture();
  (offGrid.transcript.words[0] as { start: ReturnType<typeof rational> }).start = rational(1, 3);
  expectError(
    () => analyzeDialogueProsody(offGrid),
    "CUT_DIALOGUE_PROSODY_TRANSCRIPT",
    "$.transcript",
    /CUT_TRANSCRIPT_GRID.*declared 8000 Hz audio-sample grid/u,
  );

  const duration = inputFixture();
  (duration.transcript.media as { duration: ReturnType<typeof rational> }).duration = rational(5);
  (duration.source as { transcriptSha256: string }).transcriptSha256 = hashDialogueProsodyTranscript(duration.transcript);
  expectError(() => analyzeDialogueProsody(duration), "CUT_DIALOGUE_PROSODY_CLOCK", "$.transcript.media.duration");

  const sampleClock = inputFixture();
  (sampleClock.source as { sampleRate: number }).sampleRate = 16_000;
  expectError(() => analyzeDialogueProsody(sampleClock), "CUT_DIALOGUE_PROSODY_CLOCK", "$.source.sampleRate");

  for (const range of [{ startSample: 1_000, endSample: 24_000 }, { startSample: 0, endSample: 23_000 }]) {
    expectError(
      () => analyzeDialogueProsody({ ...inputFixture(), range }),
      "CUT_DIALOGUE_PROSODY_RANGE",
      "$.range",
      /cuts through transcript word/u,
    );
  }
});

test("closed parsing rejects unknown fields, accessors, proxies, and sparse transcript arrays", () => {
  const unknown = { ...inputFixture(), extra: true };
  expectError(() => analyzeDialogueProsody(unknown), "CUT_DIALOGUE_PROSODY_FORMAT", "$.extra");

  const nested = inputFixture();
  (nested.source as unknown as Record<string, unknown>).extra = true;
  expectError(() => analyzeDialogueProsody(nested), "CUT_DIALOGUE_PROSODY_FORMAT", "$.source.extra");

  const accessor = inputFixture() as unknown as Record<string, unknown>;
  Object.defineProperty(accessor, "pcm", { enumerable: true, get: () => new Float32Array(1) });
  expectError(() => analyzeDialogueProsody(accessor as DialogueProsodyInput), "CUT_DIALOGUE_PROSODY_FORMAT", "$.pcm");

  const proxy = inputFixture();
  expectError(
    () => analyzeDialogueProsody(new Proxy(proxy, {})),
    "CUT_DIALOGUE_PROSODY_FORMAT",
    "$",
  );

  const sparse = inputFixture();
  const sparseWords = [...sparse.transcript.words];
  delete sparseWords[1];
  (sparse.transcript as unknown as { words: typeof sparseWords }).words = sparseWords;
  expectError(() => analyzeDialogueProsody(sparse), "CUT_DIALOGUE_PROSODY_FORMAT", "$.transcript.words[1]");
});

test("hostile PCM, shape, range, clock, and policy values fail closed", () => {
  expectError(
    () => hashDialogueProsodyPcmF32(new Float32Array()),
    "CUT_DIALOGUE_PROSODY_LIMIT",
    "$.pcm",
  );
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 1.01, -1.01]) {
    const input = inputFixture();
    input.pcm[0] = bad;
    expectError(() => analyzeDialogueProsody(input), "CUT_DIALOGUE_PROSODY_SAMPLE", "$.pcm[0]");
  }

  const wrongLength = inputFixture();
  (wrongLength as { pcm: Float32Array }).pcm = wrongLength.pcm.subarray(1) as Float32Array;
  expectError(() => analyzeDialogueProsody(wrongLength), "CUT_DIALOGUE_PROSODY_CLOCK", "$.pcm.length");

  const channels = inputFixture();
  (channels.source as { channels: number }).channels = 3;
  expectError(() => analyzeDialogueProsody(channels), "CUT_DIALOGUE_PROSODY_AUTHORITY", "$.source.channels");

  const overLimit = inputFixture();
  (overLimit.source as { durationSamples: number }).durationSamples = dialogueProsodyLimits.maximumInterleavedSamples + 1;
  expectError(() => analyzeDialogueProsody(overLimit), "CUT_DIALOGUE_PROSODY_LIMIT", "$.source.durationSamples");

  for (const range of [
    { startSample: -1, endSample: 100 },
    { startSample: 100, endSample: 100 },
    { startSample: 0, endSample: durationSamples + 1 },
  ]) {
    assert.throws(() => analyzeDialogueProsody({ ...inputFixture(), range }), DialogueProsodyError);
  }

  for (const policy of [
    { minimumPauseMilliseconds: 400, mediumPauseMilliseconds: 300 },
    { activityAmplitudePpm: 0 },
    { emphasisDurationRatioPpm: 999_999 },
    { dialogueProtectionGainDeltaDbMilli: 1 },
    { unexpected: 1 },
  ]) {
    assert.throws(() => analyzeDialogueProsody({ ...inputFixture(), policy }), DialogueProsodyError);
  }
});

test("an authenticated empty transcript yields an exact non-invented zero analysis", () => {
  const input = inputFixture();
  (input.transcript as unknown as { words: readonly [] }).words = [];
  (input.source as { transcriptSha256: string }).transcriptSha256 = hashDialogueProsodyTranscript(input.transcript);
  const result = analyzeDialogueProsody(input);
  assert.deepEqual(result.speakingRate, {
    lexicalWordCount: 0,
    spanSamples: 0,
    activeWordSamples: 0,
    wordsPerMinuteMilli: 0,
    articulationWordsPerMinuteMilli: 0,
  });
  assert.deepEqual(result.pauses, []);
  assert.deepEqual(result.phrases, []);
  assert.deepEqual(result.sentences, []);
  assert.deepEqual(result.contours, []);
  assert.deepEqual(result.emphasisCandidates, []);
  assert.deepEqual(result.dialogueSpaceSuggestions, []);
  assert.deepEqual(result.work, {
    pcmFramesAuthenticated: durationSamples,
    metricFramesRead: 0,
    scalarSamplesRead: 0,
    transcriptWordsVisited: 0,
    phraseSentenceAssignments: 0,
    contourPairsVisited: 0,
  });
});

test("speaker changes split phrases and sentences and never create cross-speaker contours", () => {
  const input = inputFixture();
  for (const word of input.transcript.words) {
    const speaker = word.id === "w1" || word.id === "w2" || word.id.startsWith("p1") ? "host" : "guest";
    (word as { speaker?: string }).speaker = speaker;
  }
  (input.source as { transcriptSha256: string }).transcriptSha256 = hashDialogueProsodyTranscript(input.transcript);

  const result = analyzeDialogueProsody(input);
  assert.deepEqual(result.phrases.map((phrase) => [phrase.firstWordId, phrase.lastWordId, phrase.speaker]), [
    ["w1", "w1", "host"],
    ["w2", "w2", "host"],
    ["w3", "w4", "guest"],
    ["w5", "w5", "guest"],
  ]);
  assert.deepEqual(result.sentences.map((sentence) => [sentence.firstWordId, sentence.lastWordId, sentence.speaker]), [
    ["w1", "w2", "host"],
    ["w3", "w4", "guest"],
    ["w5", "w5", "guest"],
  ]);
  const phraseById = new Map(result.phrases.map((phrase) => [phrase.id, phrase]));
  assert.ok(result.contours.every((contour) => phraseById.get(contour.fromPhraseId)?.speaker === phraseById.get(contour.toPhraseId)?.speaker));
  assert.equal(result.work.contourPairsVisited, result.phrases.length - 1);
  assert.equal(result.contours.length, 2);
});

test("a speaker change alone splits adjacent unpunctuated words below the pause threshold", () => {
  const transcript: CutTranscript = {
    format: "cut-transcript",
    version: 1,
    media: {
      sha256: mediaSha256,
      audioStreamIndex: 0,
      audioSampleRate: sampleRate,
      duration: rational(4),
    },
    words: [
      { id: "host.1", start: rational(800, sampleRate), end: rational(1_600, sampleRate), text: "Welcome", join: "none", speaker: "host" },
      { id: "guest.1", start: rational(1_601, sampleRate), end: rational(2_401, sampleRate), text: "Thanks", join: "space", speaker: "guest" },
    ],
  };
  const pcm = new Float32Array(durationSamples);
  paint(pcm, 1, 800, 1_600, 0.1);
  paint(pcm, 1, 1_601, 2_401, 0.1);
  const result = analyzeDialogueProsody({
    source: {
      mediaSha256,
      audioStreamIndex: 0,
      normalizedPcmSha256: hashDialogueProsodyPcmF32(pcm),
      transcriptSha256: hashDialogueProsodyTranscript(transcript),
      sampleRate,
      channels: 1,
      durationSamples,
    },
    pcm,
    transcript,
  });
  assert.equal(result.pauses.length, 0);
  assert.deepEqual(result.phrases.map((phrase) => [phrase.firstWordId, phrase.lastWordId, phrase.speaker]), [
    ["host.1", "host.1", "host"],
    ["guest.1", "guest.1", "guest"],
  ]);
  assert.deepEqual(result.sentences.map((sentence) => [sentence.firstWordId, sentence.lastWordId, sentence.speaker]), [
    ["host.1", "host.1", "host"],
    ["guest.1", "guest.1", "guest"],
  ]);
  assert.deepEqual(result.contours, []);
  assert.equal(result.work.contourPairsVisited, 1);
});

test("silent dialogue emits measured silence plus an explicitly authored protection policy, not a masking claim", () => {
  const input = inputFixture();
  input.pcm.fill(0);
  (input.source as { normalizedPcmSha256: string }).normalizedPcmSha256 = hashDialogueProsodyPcmF32(input.pcm);
  const result = analyzeDialogueProsody(input);
  assert.ok(result.phrases.every((phrase) => phrase.acoustics.rmsDbfsMilli === -120_000));
  for (const suggestion of result.dialogueSpaceSuggestions) {
    if (suggestion.kind !== "protect-dialogue") continue;
    assert.equal(suggestion.basis, "transcript-timing-plus-authored-protection-policy");
    assert.equal(suggestion.policyBedGainDeltaDbMilli, -6_000);
    assert.equal(suggestion.sfxGuidance, "avoid-sustained-dialogue-overlap-policy");
  }
});

test("phrase-to-sentence assignment stays one-pass for ten thousand single-word sentences", () => {
  const wordCount = 10_000;
  const largeDurationSamples = wordCount * 2;
  const transcript: CutTranscript = {
    format: "cut-transcript",
    version: 1,
    media: {
      sha256: mediaSha256,
      audioStreamIndex: 0,
      audioSampleRate: sampleRate,
      duration: rational(largeDurationSamples, sampleRate),
    },
    words: Array.from({ length: wordCount }, (_, index) => ({
      id: `large.${String(index + 1).padStart(6, "0")}`,
      start: rational(index * 2, sampleRate),
      end: rational(index * 2 + 1, sampleRate),
      text: `w${index}.`,
      join: index === 0 ? "none" as const : "space" as const,
    })),
  };
  const pcm = new Float32Array(largeDurationSamples);
  const result = analyzeDialogueProsody({
    source: {
      mediaSha256,
      audioStreamIndex: 0,
      normalizedPcmSha256: hashDialogueProsodyPcmF32(pcm),
      transcriptSha256: hashDialogueProsodyTranscript(transcript),
      sampleRate,
      channels: 1,
      durationSamples: largeDurationSamples,
    },
    pcm,
    transcript,
  });
  assert.equal(result.phrases.length, wordCount);
  assert.equal(result.sentences.length, wordCount);
  assert.equal(result.work.phraseSentenceAssignments, wordCount);
  assert.equal(result.work.contourPairsVisited, wordCount - 1);
});
