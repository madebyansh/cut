import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import Ajv from "ajv";
import { stableJsonStringify } from "../lib/core/stable";
import {
  CutAudioBriefError,
  cutAudioBriefLimits,
  cutAudioBriefSha256,
  parseCutAudioBrief,
} from "../lib/audio-intelligence/brief";

const sha = (digit: string) => digit.repeat(64);
const digest = (value: unknown) => createHash("sha256").update(stableJsonStringify(value)).digest("hex");

function sign<T extends Record<string, unknown>>(value: T) {
  const { briefSha256: _ignored, ...body } = value;
  return { ...body, briefSha256: digest(body) };
}

function fixture() {
  return sign({
    format: "cut-audio-brief",
    version: 1,
    sampleRate: 48_000,
    durationSamples: 96_000,
    sourceScriptSha256: sha("1"),
    acts: [
      {
        id: "opening-hook", range: { startSample: 0, endSample: 24_000 }, narrativeTurn: "hook",
        desiredRoles: ["music", "sfx"], moods: ["curious", "restrained"],
        energyPpm: 350_000, densityPpm: 250_000, dialogueSpacePpm: 900_000,
        intent: "Open a question without competing with the first line.",
      },
      {
        id: "evidence-build", range: { startSample: 24_000, endSample: 72_000 }, narrativeTurn: "accumulation",
        desiredRoles: ["music", "ambience"], moods: ["tense", "propulsive"],
        energyPpm: 700_000, densityPpm: 600_000, dialogueSpacePpm: 800_000,
        intent: "Accumulate pressure while leaving a stable centre for dialogue.",
      },
      {
        id: "quiet-resolution", range: { startSample: 72_000, endSample: 96_000 }, narrativeTurn: "resolution",
        desiredRoles: ["silence", "ambience"], moods: ["reflective"],
        energyPpm: 150_000, densityPpm: 100_000, dialogueSpacePpm: 1_000_000,
        intent: "Let the conclusion land before a minimal room-tone return.",
      },
    ],
    events: [
      { sample: 0, kind: "hit", purpose: "Mark the opening image without masking speech.", strengthPpm: 250_000 },
      { sample: 24_000, kind: "transition", purpose: "Begin the evidence build.", strengthPpm: 500_000 },
      { sample: 72_000, kind: "transition", purpose: "Clear space for the conclusion.", strengthPpm: 1_000_000 },
      { sample: 76_000, kind: "texture", purpose: "Return only restrained room tone.", strengthPpm: 200_000 },
      { sample: 96_000, kind: "hit", purpose: "Permit an optional terminal punctuation point.", strengthPpm: 100_000 },
    ],
    intentionalSilences: [
      { range: { startSample: 72_000, endSample: 76_000 }, purpose: "Protect the final spoken turn." },
    ],
  });
}

function expectCode(value: unknown, code: string) {
  assert.throws(
    () => parseCutAudioBrief(JSON.stringify(value)),
    (error: unknown) => error instanceof CutAudioBriefError && error.code === code,
  );
}

test("audio-brief v1 parses one canonical full-program direction artifact", async () => {
  const first = parseCutAudioBrief(JSON.stringify(fixture()));
  const second = parseCutAudioBrief(JSON.stringify(fixture()));
  assert.equal(first.briefSha256, second.briefSha256);
  assert.equal(first.acts[0]!.range.startSample, 0);
  assert.equal(first.acts.at(-1)!.range.endSample, first.durationSamples);
  assert.equal(first.events.at(-1)!.sample, first.durationSamples);
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.acts) && Object.isFrozen(first.acts[0]!.range));
  const { briefSha256: _ignored, ...body } = first;
  assert.equal(cutAudioBriefSha256(body), first.briefSha256);

  const schema = JSON.parse(await readFile(resolve("schemas/cut-audio-brief-v1.schema.json"), "utf8"));
  const ajv = new Ajv({ schemaId: "auto", meta: false, validateSchema: false, allErrors: true });
  const validate = ajv.compile(schema);
  assert.equal(validate(fixture()), true, JSON.stringify(validate.errors));
});

test("audio-brief rejects hash tampering, unknown fields, and non-strict JSON", () => {
  const tampered = structuredClone(fixture());
  tampered.acts[0]!.energyPpm += 1;
  expectCode(tampered, "CUT_AUDIO_BRIEF_IDENTITY");
  expectCode({ ...fixture(), automaticEdit: true }, "CUT_AUDIO_BRIEF_UNKNOWN_FIELD");

  const nested = structuredClone(fixture());
  (nested.acts[0] as typeof nested.acts[0] & { hiddenPrompt?: string }).hiddenPrompt = "trust me";
  expectCode(sign(nested), "CUT_AUDIO_BRIEF_UNKNOWN_FIELD");

  const duplicate = JSON.stringify(fixture()).replace('"format":"cut-audio-brief"', '"format":"cut-audio-brief","format":"forged"');
  assert.throws(
    () => parseCutAudioBrief(duplicate),
    (error: unknown) => error instanceof CutAudioBriefError && error.code === "CUT_AUDIO_BRIEF_JSON",
  );
});

test("acts must be ordered, unique, contiguous, and cover the complete program", () => {
  const gap = structuredClone(fixture());
  gap.acts[1]!.range.startSample = 25_000;
  expectCode(sign(gap), "CUT_AUDIO_BRIEF_COVERAGE");

  const overlap = structuredClone(fixture());
  overlap.acts[1]!.range.startSample = 23_000;
  expectCode(sign(overlap), "CUT_AUDIO_BRIEF_ORDER");

  const short = structuredClone(fixture());
  short.acts.at(-1)!.range.endSample = 95_999;
  expectCode(sign(short), "CUT_AUDIO_BRIEF_COVERAGE");

  const duplicateId = structuredClone(fixture());
  duplicateId.acts[1]!.id = duplicateId.acts[0]!.id;
  expectCode(sign(duplicateId), "CUT_AUDIO_BRIEF_DUPLICATE");
});

test("event samples are bounded, strictly ordered, and unique", () => {
  const duplicate = structuredClone(fixture());
  duplicate.events[1]!.sample = duplicate.events[0]!.sample;
  expectCode(sign(duplicate), "CUT_AUDIO_BRIEF_DUPLICATE");

  const reversed = structuredClone(fixture());
  [reversed.events[0], reversed.events[1]] = [reversed.events[1]!, reversed.events[0]!];
  expectCode(sign(reversed), "CUT_AUDIO_BRIEF_ORDER");

  const outside = structuredClone(fixture());
  outside.events.at(-1)!.sample = outside.durationSamples + 1;
  expectCode(sign(outside), "CUT_AUDIO_BRIEF_NUMBER");
});

test("intentional silences are exact bounded nonoverlapping half-open ranges", () => {
  const overlap = structuredClone(fixture());
  overlap.intentionalSilences.push({
    range: { startSample: 75_000, endSample: 80_000 },
    purpose: "This overlap is ambiguous.",
  });
  expectCode(sign(overlap), "CUT_AUDIO_BRIEF_OVERLAP");

  const reversed = structuredClone(fixture());
  reversed.intentionalSilences[0]!.range = { startSample: 76_000, endSample: 72_000 };
  expectCode(sign(reversed), "CUT_AUDIO_BRIEF_RANGE");

  const outside = structuredClone(fixture());
  outside.intentionalSilences[0]!.range.endSample = outside.durationSamples + 1;
  expectCode(sign(outside), "CUT_AUDIO_BRIEF_NUMBER");
});

test("audio-brief taxonomies, normalized tokens, PPM values, and collection limits fail closed", () => {
  const turn = structuredClone(fixture());
  turn.acts[0]!.narrativeTurn = "montage" as typeof turn.acts[0]["narrativeTurn"];
  expectCode(sign(turn), "CUT_AUDIO_BRIEF_ENUM");

  const duplicateMood = structuredClone(fixture());
  duplicateMood.acts[0]!.moods = ["curious", "curious"];
  expectCode(sign(duplicateMood), "CUT_AUDIO_BRIEF_DUPLICATE");

  const unnormalizedMood = structuredClone(fixture());
  unnormalizedMood.acts[0]!.moods = ["Slow Burn"];
  expectCode(sign(unnormalizedMood), "CUT_AUDIO_BRIEF_TOKEN");

  const ppm = structuredClone(fixture());
  ppm.acts[0]!.dialogueSpacePpm = cutAudioBriefLimits.maximumPpm + 1;
  expectCode(sign(ppm), "CUT_AUDIO_BRIEF_NUMBER");

  const tooManyActs = structuredClone(fixture());
  tooManyActs.acts = Array.from({ length: cutAudioBriefLimits.maximumActs + 1 }, () => structuredClone(tooManyActs.acts[0]!));
  expectCode(sign(tooManyActs), "CUT_AUDIO_BRIEF_LIMIT");
});
