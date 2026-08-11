import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  arrangeCutAudio,
  CutAudioArrangementError,
  cutAudioArrangementInputFormat,
  cutAudioArrangementInputSha256,
  cutAudioArrangementInputVersion,
  cutAudioArrangementLimits,
  cutAudioArrangementProfile,
  parseCutAudioArrangementInput,
  type CutAudioArrangementInputBody,
  type CutAudioArrangementProsody,
} from "../lib/audio-intelligence/arrange";
import { cutAudioBriefSha256, parseCutAudioBrief } from "../lib/audio-intelligence/brief";
import {
  analyzeDialogueProsody,
  hashDialogueProsodyPcmF32,
  hashDialogueProsodyTranscript,
} from "../lib/audio-intelligence/dialogue-prosody";
import { stableJsonStringify } from "../lib/core/stable";
import type { CutTranscript } from "../lib/interchange/transcript";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import { parseCutLanguage } from "../lib/language/parser";
import { rational } from "../lib/language/rational";

const sampleRate = 8_000;
const durationSamples = sampleRate * 4;
const sha = (value: string) => value.repeat(64);
const canonicalHash = (value: unknown) => createHash("sha256").update(stableJsonStringify(value), "utf8").digest("hex");

function briefFixture() {
  const body = {
    format: "cut-audio-brief" as const,
    version: 1 as const,
    sampleRate,
    durationSamples,
    sourceScriptSha256: sha("1"),
    acts: [
      {
        id: "opening", range: { startSample: 0, endSample: 16_000 }, narrativeTurn: "hook" as const,
        desiredRoles: ["music", "sfx"] as const, moods: ["curious"],
        energyPpm: 750_000, densityPpm: 500_000, dialogueSpacePpm: 800_000,
        intent: "Establish the question beneath a protected opening line.",
      },
      {
        id: "resolution", range: { startSample: 16_000, endSample: 32_000 }, narrativeTurn: "resolution" as const,
        desiredRoles: ["ambience", "sfx", "silence"] as const, moods: ["reflective"],
        energyPpm: 250_000, densityPpm: 200_000, dialogueSpacePpm: 1_000_000,
        intent: "Clear the bed, then return restrained room perspective.",
      },
    ],
    events: [
      { sample: 6_000, kind: "hit" as const, purpose: "Accent a quiet pause after the opening phrase.", strengthPpm: 500_000 },
      { sample: 25_000, kind: "texture" as const, purpose: "This event remains intentionally unfilled.", strengthPpm: 200_000 },
    ],
    intentionalSilences: [
      { range: { startSample: 24_000, endSample: 26_000 }, purpose: "Protect the final spoken turn." },
    ],
  };
  return parseCutAudioBrief(JSON.stringify({ ...body, briefSha256: cutAudioBriefSha256(body) }));
}

function transcriptFixture(): CutTranscript {
  return {
    format: "cut-transcript",
    version: 1,
    media: {
      sha256: sha("a"),
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

function prosodyFixture(): CutAudioArrangementProsody {
  const transcript = transcriptFixture();
  const pcm = new Float32Array(durationSamples);
  for (const [start, end, amplitude] of [
    [800, 2_800, 0.1], [3_600, 5_200, 0.1], [8_400, 9_200, 0.5],
    [9_600, 12_800, 0.1], [20_800, 24_000, 0.25],
  ] as const) {
    for (let frame = start; frame < end; frame += 1) pcm[frame] = amplitude;
  }
  return analyzeDialogueProsody({
    source: {
      mediaSha256: sha("a"),
      audioStreamIndex: 0,
      normalizedPcmSha256: hashDialogueProsodyPcmF32(pcm),
      transcriptSha256: hashDialogueProsodyTranscript(transcript),
      sampleRate,
      channels: 1,
      durationSamples,
    },
    pcm,
    transcript,
  }) as unknown as CutAudioArrangementProsody;
}

const perspectives = {
  dialogue: { distance: "near", gainDbMilli: -1_000, panPpm: 0, eqFrequencyHz: 3_000, eqGainDbMilli: 1_000, eqQMilli: 900, reverbWetPpm: 40_000 },
  music: { distance: "mid", gainDbMilli: -2_000, panPpm: -100_000, eqFrequencyHz: 2_500, eqGainDbMilli: -1_500, eqQMilli: 1_200, reverbWetPpm: 0 },
  ambience: { distance: "far", gainDbMilli: -6_000, panPpm: 150_000, eqFrequencyHz: 1_800, eqGainDbMilli: -3_000, eqQMilli: 700, reverbWetPpm: 0 },
  sfx: { distance: "mid", gainDbMilli: -3_000, panPpm: 250_000, eqFrequencyHz: 3_500, eqGainDbMilli: 2_000, eqQMilli: 1_500, reverbWetPpm: 0 },
} as const;

function bodyFixture(): CutAudioArrangementInputBody {
  return {
    format: cutAudioArrangementInputFormat,
    version: cutAudioArrangementInputVersion,
    profile: cutAudioArrangementProfile,
    brief: briefFixture(),
    prosody: prosodyFixture(),
    assets: [
      {
        id: "host-dialogue", role: "dialogue", locator: "assets/host-dialogue.wav", lockedResourceSha256: sha("a"),
        sampleRate, sourceRange: { startSample: 0, endSample: 32_000 }, assignment: { kind: "program-dialogue" },
        perspective: perspectives.dialogue,
      },
      {
        id: "opening-score", role: "music", locator: "assets/opening-score.wav", lockedResourceSha256: sha("3"),
        sampleRate, sourceRange: { startSample: 32_000, endSample: 48_000 }, assignment: { kind: "act", actId: "opening" },
        perspective: perspectives.music,
      },
      {
        id: "resolution-room", role: "ambience", locator: "assets/resolution-room.wav", lockedResourceSha256: sha("4"),
        sampleRate, sourceRange: { startSample: 8_000, endSample: 24_000 }, assignment: { kind: "act", actId: "resolution" },
        perspective: perspectives.ambience,
      },
      {
        id: "opening-hit", role: "sfx", locator: "assets/opening-hit.wav", lockedResourceSha256: sha("5"),
        sampleRate, sourceRange: { startSample: 28_000, endSample: 32_000 }, assignment: { kind: "event", eventIndex: 0 },
        perspective: perspectives.sfx,
      },
    ],
  };
}

function signedFixture(body: CutAudioArrangementInputBody = bodyFixture()) {
  return { ...body, inputSha256: cutAudioArrangementInputSha256(body) };
}

type DeepMutable<Value> = Value extends readonly (infer Item)[]
  ? DeepMutable<Item>[]
  : Value extends object
    ? { -readonly [Key in keyof Value]: DeepMutable<Value[Key]> }
    : Value;
type MutableFixture = DeepMutable<ReturnType<typeof signedFixture>>;

function mutableFixture(): MutableFixture {
  return structuredClone(signedFixture()) as MutableFixture;
}

function jsonFixture(body: CutAudioArrangementInputBody = bodyFixture()) {
  return JSON.stringify(signedFixture(body));
}

function resign(value: MutableFixture) {
  const { inputSha256: _ignored, ...body } = value;
  value.inputSha256 = cutAudioArrangementInputSha256(body as CutAudioArrangementInputBody);
  return value;
}

function resignProsody(value: MutableFixture) {
  const prosody = value.prosody as unknown as Record<string, unknown>;
  const { analysisSha256: _ignored, ...body } = prosody;
  prosody.analysisSha256 = canonicalHash(body);
  return resign(value);
}

function expectCode(input: unknown, code: string, path?: string) {
  assert.throws(
    () => arrangeCutAudio(typeof input === "string" ? input : JSON.stringify(input)),
    (error: unknown) => error instanceof CutAudioArrangementError && error.code === code && (!path || error.path === path),
  );
}

test("arranger emits deterministic ordinary CUT with exact act, prosody, event, perspective, and silence semantics", () => {
  const first = arrangeCutAudio(jsonFixture());
  const second = arrangeCutAudio(jsonFixture());
  assert.deepEqual(first, second);
  assert.equal(first.format, "cut-audio-arrangement");
  assert.equal(first.manifest.profile, cutAudioArrangementProfile);
  assert.equal(first.manifest.authority.briefSha256, briefFixture().briefSha256);
  assert.equal(first.manifest.authority.prosodyAnalysisSha256, prosodyFixture().analysisSha256);
  assert.equal(first.manifest.authority.sourceSha256, first.sourceSha256);
  assert.equal(createHash("sha256").update(first.source).digest("hex"), first.sourceSha256);
  const { manifestSha256, ...manifestBody } = first.manifest;
  assert.equal(manifestSha256, canonicalHash(manifestBody));
  const { arrangementSha256, ...arrangementBody } = first;
  assert.equal(arrangementSha256, canonicalHash(arrangementBody));
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.manifest) && Object.isFrozen(first.manifest.placements));

  const dialogue = first.manifest.placements.filter((item) => item.role === "dialogue");
  assert.deepEqual(dialogue.map((item) => item.destinationRange), [{ startSample: 0, endSample: 32_000 }]);
  assert.deepEqual(dialogue.map((item) => item.sourceRange), [{ startSample: 0, endSample: 32_000 }]);
  const supporting = first.manifest.placements.filter((item) => item.role !== "dialogue");
  assert.ok(supporting.every((item) => item.destinationRange.endSample <= 24_000 || item.destinationRange.startSample >= 26_000));
  assert.deepEqual(first.manifest.intentionalSilences, [{
    range: { startSample: 24_000, endSample: 26_000 },
    purpose: "Protect the final spoken turn.",
    semantics: "exact-supporting-sound-gap-dialogue-preserved",
  }]);

  const music = first.manifest.placements.filter((item) => item.role === "music");
  assert.ok(music.length > 1);
  assert.ok(music.some((item) => item.dialogueProtectionSuggestionIds.length > 0));
  assert.ok(new Set(music.map((item) => item.gainDbMilli)).size > 1);
  assert.ok(music.some((item) => item.fadeInSamples > 0));
  assert.ok(music.some((item) => item.fadeOutSamples > 0));

  const sfx = first.manifest.placements.find((item) => item.role === "sfx")!;
  assert.equal(sfx.eventIndex, 0);
  assert.equal(sfx.eventSample, 6_000);
  assert.equal(sfx.destinationRange.startSample, 6_000);
  assert.equal(sfx.destinationRange.endSample, 7_280);
  assert.match(sfx.pauseAccentSuggestionId ?? "", /^space\./u);
  assert.ok(sfx.dialogueProtectionSuggestionIds.length > 0);

  assert.match(first.source, /asset arr_host_dialogue: AudioAsset = audio\("assets\/host-dialogue\.wav"\);/u);
  assert.match(first.source, /Bus\(name: "dialogue", role: "dialogue"\)/u);
  assert.match(first.source, /Reverb\(wet: \(40000% \/ 10000\)\)/u);
  assert.match(first.source, /Reverb\(wet: 0%\)/u);
  assert.match(first.source, /ParametricEQ\(frequency: 2500hz, gain: \(-1500db \/ 1000\), q: \(1200 \/ 1000\)\)/u);
  assert.match(first.source, /Pan\(position: \(-100000% \/ 10000\)\)/u);
  assert.match(first.source, /AudioGap\(destination: \(24000s \/ 8000\) \.\.< \(26000s \/ 8000\)\);/u);
  assert.doesNotMatch(first.source, /download|fetch|model|prompt|inference/iu);

  const parsed = parseCutLanguage(first.source);
  assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  assert.deepEqual(parsed.diagnostics, []);
  assert.deepEqual(checkCutModule(parsed.module!).diagnostics, []);
  const compiled = compileCutModule(parsed.module!);
  assert.equal(compiled.ir.compositions[0]?.sampleRate, sampleRate);
  assert.equal(compiled.ir.compositions[0]?.duration.numerator, "4");
  assert.equal(compiled.ir.compositions[0]?.duration.denominator, "1");
});

test("arranger is a pure proposal and never reorders or mutates the supplied JSON bytes", () => {
  const input = jsonFixture();
  const copy = `${input}`;
  const result = arrangeCutAudio(input);
  const parsed = parseCutAudioArrangementInput(input);
  assert.equal(input, copy);
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.prosody) && Object.isFrozen(parsed.prosody?.policy));
  assert.equal(result.manifest.authority.resourceIdentitySemantics, "caller-accepted-locked-resource-digests-not-reopened-by-pure-planner");
  assert.ok(result.manifest.limitations.some((item) => item.includes("normal-speed listening")));
  assert.ok(result.manifest.limitations.some((item) => item.includes("not reopened")));
});

test("perspective distance is retained metadata while only separately authored numeric controls affect CUT source", () => {
  const baseline = arrangeCutAudio(jsonFixture());
  const changed = mutableFixture();
  changed.assets[1]!.perspective.distance = "far";
  const relabeled = arrangeCutAudio(JSON.stringify(resign(changed)));
  assert.equal(relabeled.source, baseline.source);
  assert.equal(relabeled.sourceSha256, baseline.sourceSha256);
  assert.notEqual(relabeled.manifest.authority.inputSha256, baseline.manifest.authority.inputSha256);
  assert.equal(relabeled.manifest.assets.find((item) => item.id === "opening-score")?.perspective.distance, "far");
});

test("prosody is optional and its absence removes protection splits and pause-window truncation without inventing semantics", () => {
  const value = mutableFixture();
  value.prosody = null;
  const result = arrangeCutAudio(JSON.stringify(resign(value)));
  assert.equal(result.manifest.authority.prosodyAnalysisSha256, null);
  assert.equal(result.manifest.work.prosodySuggestionsVisited, 0);
  assert.equal(result.manifest.placements.filter((item) => item.role === "music").length, 1);
  const sfx = result.manifest.placements.find((item) => item.role === "sfx")!;
  assert.deepEqual(sfx.destinationRange, { startSample: 6_000, endSample: 10_000 });
  assert.equal(sfx.pauseAccentSuggestionId, null);
  assert.deepEqual(sfx.dialogueProtectionSuggestionIds, []);
});

test("input, brief, prosody, and policy identities fail closed", () => {
  const input = mutableFixture();
  input.assets[0]!.locator = "assets/forged.wav";
  expectCode(input, "CUT_AUDIO_ARRANGEMENT_IDENTITY", "$.inputSha256");

  const brief = mutableFixture();
  brief.brief.acts[0]!.energyPpm += 1;
  expectCode(resign(brief), "CUT_AUDIO_ARRANGEMENT_AUTHORITY", "$.brief");

  const prosody = mutableFixture();
  (prosody.prosody!.dialogueSpaceSuggestions[0] as { endSample: number }).endSample += 1;
  expectCode(resign(prosody), "CUT_AUDIO_ARRANGEMENT_IDENTITY", "$.prosody.analysisSha256");

  const policy = mutableFixture();
  (policy.prosody!.policy as { dialogueProtectionGainDeltaDbMilli: number }).dialogueProtectionGainDeltaDbMilli = -9_000;
  expectCode(resignProsody(policy), "CUT_AUDIO_ARRANGEMENT_AUTHORITY", "$.prosody.authority.policySha256");

  const foreignDialogue = mutableFixture();
  foreignDialogue.assets[0]!.lockedResourceSha256 = sha("2");
  expectCode(resign(foreignDialogue), "CUT_AUDIO_ARRANGEMENT_AUTHORITY", "$.prosody.authority.mediaSha256");
});

test("strict closed parsing rejects duplicates, unknowns, path traversal, malformed digests, and perspective injection", () => {
  const duplicateJson = jsonFixture().replace(
    '"format":"cut-audio-arrangement-input"',
    '"format":"cut-audio-arrangement-input","format":"forged"',
  );
  expectCode(duplicateJson, "CUT_AUDIO_ARRANGEMENT_FORMAT", "$");

  const unknown = { ...signedFixture(), automaticSelection: true };
  expectCode(unknown, "CUT_AUDIO_ARRANGEMENT_FORMAT", "$.automaticSelection");

  const traversal = mutableFixture();
  traversal.assets[0]!.locator = "../private/host.wav";
  expectCode(resign(traversal), "CUT_AUDIO_ARRANGEMENT_PATH", "$.assets[0].locator");

  const absolute = mutableFixture();
  absolute.assets[0]!.locator = "/tmp/host.wav";
  expectCode(resign(absolute), "CUT_AUDIO_ARRANGEMENT_PATH", "$.assets[0].locator");

  const digest = mutableFixture();
  digest.assets[0]!.lockedResourceSha256 = "not-a-digest";
  expectCode(resign(digest), "CUT_AUDIO_ARRANGEMENT_AUTHORITY", "$.assets[0].lockedResourceSha256");

  const perspective = mutableFixture();
  (perspective.assets[0]!.perspective as Record<string, unknown>).inferredEmotion = "sad";
  expectCode(resign(perspective), "CUT_AUDIO_ARRANGEMENT_FORMAT", "$.assets[0].perspective.inferredEmotion");
});

test("the documentary profile rejects missing, duplicate, off-clock, wrong-role, and mismatched-duration bindings", () => {
  const missing = mutableFixture();
  missing.assets.splice(1, 1);
  expectCode(resign(missing), "CUT_AUDIO_ARRANGEMENT_COVERAGE", "$.brief.acts.opening.desiredRoles");

  const duplicate = mutableFixture();
  duplicate.assets.push({ ...structuredClone(duplicate.assets[1]!), id: "second-score" });
  expectCode(resign(duplicate), "CUT_AUDIO_ARRANGEMENT_DUPLICATE", "$.assets.second-score");

  const offClock = mutableFixture();
  offClock.assets[1]!.sampleRate = 16_000;
  expectCode(resign(offClock), "CUT_AUDIO_ARRANGEMENT_CLOCK", "$.assets[1].sampleRate");

  const duration = mutableFixture();
  duration.assets[1]!.sourceRange.endSample = 47_999;
  expectCode(resign(duration), "CUT_AUDIO_ARRANGEMENT_COVERAGE", "$.assets.opening-score.sourceRange");

  const dialogueDuration = mutableFixture();
  dialogueDuration.assets[0]!.sourceRange = { startSample: 16_000, endSample: 48_000 };
  expectCode(resign(dialogueDuration), "CUT_AUDIO_ARRANGEMENT_COVERAGE", "$.assets.host-dialogue.sourceRange");

  const wrongRole = mutableFixture();
  wrongRole.assets[2]!.assignment = { kind: "act", actId: "opening" };
  expectCode(resign(wrongRole), "CUT_AUDIO_ARRANGEMENT_ROLE", "$.assets.resolution-room");

  const twoDialogue = mutableFixture();
  twoDialogue.assets.push({ ...structuredClone(twoDialogue.assets[0]!), id: "second-host", locator: "assets/second-host.wav" });
  expectCode(resign(twoDialogue), "CUT_AUDIO_ARRANGEMENT_COVERAGE", "$.assets");
});

test("intentional silence, event bounds, and prosody windows remain exact and fail closed", () => {
  const reverbTail = mutableFixture();
  reverbTail.assets[1]!.perspective.reverbWetPpm = 1;
  expectCode(resign(reverbTail), "CUT_AUDIO_ARRANGEMENT_SILENCE", "$.assets.opening-score.perspective.reverbWetPpm");

  const silence = mutableFixture();
  silence.assets[3]!.assignment = { kind: "event", eventIndex: 1 };
  expectCode(resign(silence), "CUT_AUDIO_ARRANGEMENT_SILENCE", "$.assets.opening-hit");

  const clock = mutableFixture();
  (clock.prosody!.authority as { sampleRate: number }).sampleRate = 16_000;
  (clock.prosody!.authority as unknown as { policySha256: string }).policySha256 = canonicalHash(clock.prosody!.policy);
  expectCode(resignProsody(clock), "CUT_AUDIO_ARRANGEMENT_CLOCK", "$.prosody.authority");

  const overlap = mutableFixture();
  const pauses = overlap.prosody!.dialogueSpaceSuggestions.filter((item) => item.kind === "pause-accent-window");
  assert.equal(pauses.length, 2);
  (pauses[1] as { startSample: number }).startSample = (pauses[0] as { endSample: number }).endSample - 1;
  overlap.prosody!.dialogueSpaceSuggestions.sort((left, right) => left.startSample - right.startSample || left.endSample - right.endSample || left.kind.localeCompare(right.kind));
  expectCode(resignProsody(overlap), "CUT_AUDIO_ARRANGEMENT_PROSODY");

  const unknown = mutableFixture();
  (unknown.prosody!.dialogueSpaceSuggestions[0] as Record<string, unknown>).emotion = "tense";
  expectCode(resignProsody(unknown), "CUT_AUDIO_ARRANGEMENT_FORMAT");
});

test("asset and expanded-placement work are explicitly bounded", () => {
  const value = mutableFixture();
  value.assets = Array.from({ length: cutAudioArrangementLimits.maximumAssets + 1 }, (_, index) => ({
    ...structuredClone(value.assets[0]!),
    id: `dialogue-${index}`,
    locator: `assets/dialogue-${index}.wav`,
  }));
  expectCode(resign(value), "CUT_AUDIO_ARRANGEMENT_LIMIT", "$.assets");
});
