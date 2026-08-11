import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import Ajv from "ajv";
import {
  analyzeCutAudioAuditionWave,
  assertCutAudioAuditionRenderAuthorities,
  createCutAudioAuditionSource,
  cutAudioAuditionBindingsSha256,
  cutAudioAuditionLimits,
  CutAudioAuditionError,
  loadCutAudioAuditionProjectFile,
  parseCutAudioAuditionBindings,
  parseCutAudioAuditionSemanticAnalysis,
  rankCutAudioAuditionCandidates,
  removeCutAudioAuditionOwnedArtifact,
  removeCutAudioAuditionOwnedDirectory,
  retainCutAudioAuditionOwnedArtifact,
  retainCutAudioAuditionOwnedDirectory,
  verifyCutAudioAuditionInputs,
  type CutAudioAuditionVerifiedCandidate,
} from "../lib/audio-intelligence/audition";
import { cutAudioBriefSha256, parseCutAudioBrief } from "../lib/audio-intelligence/brief";
import { stableJsonStringify } from "../lib/core/stable";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule } from "../lib/language/compiler";
import { applyCutLockForVerifiedInputSession, createCutLock } from "../lib/language/lock";
import { parseCutLanguage } from "../lib/language/parser";
import { parseCutAssetCatalog } from "../lib/project/asset-catalog";
import { cutDiagnosticsFromError } from "../lib/runtime/diagnostics";
import { createYamnetSemanticTestArtifact } from "./yamnet-semantic-test-fixture";

const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

function pcm16Wave(sampleRate: number, seconds: number, channels: number, sample: (frame: number, channel: number) => number) {
  const frames = sampleRate * seconds, dataBytes = frames * channels * 2, bytes = Buffer.alloc(44 + dataBytes);
  bytes.write("RIFF", 0, "ascii"); bytes.writeUInt32LE(36 + dataBytes, 4); bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii"); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * channels * 2, 28); bytes.writeUInt16LE(channels * 2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii"); bytes.writeUInt32LE(dataBytes, 40);
  for (let frame = 0; frame < frames; frame += 1) for (let channel = 0; channel < channels; channel += 1) {
    bytes.writeInt16LE(Math.max(-32_768, Math.min(32_767, Math.round(sample(frame, channel) * 32_767))), 44 + (frame * channels + channel) * 2);
  }
  return bytes;
}

function clickWave(sampleRate = 8_000, seconds = 2) {
  return pcm16Wave(sampleRate, seconds, 2, (frame) => frame % (sampleRate / 2) < 80 ? (1 - frame % (sampleRate / 2) / 80) * 0.8 : 0);
}

function brief(sampleRate = 8_000, seconds = 2) {
  const body = {
    format: "cut-audio-brief" as const,
    version: 1 as const,
    sampleRate,
    durationSamples: sampleRate * seconds,
    sourceScriptSha256: "1".repeat(64),
    acts: [{
      id: "hook", range: { startSample: 0, endSample: sampleRate * seconds }, narrativeTurn: "hook" as const,
      desiredRoles: ["music"] as const, moods: ["curious"], energyPpm: 500_000, densityPpm: 750_000,
      dialogueSpacePpm: 900_000, intent: "Keep motion beneath dialogue.",
    }],
    events: [],
    intentionalSilences: [],
  };
  return parseCutAudioBrief(JSON.stringify({ ...body, briefSha256: cutAudioBriefSha256(body) }));
}

function grants() {
  return { commercialUse: true, modification: true, audiovisualSynchronization: true, standaloneRedistribution: false, attributionRequired: true, shareAlike: false };
}

function entry(id: string, wave: Buffer, evidence: Buffer, options: { moods?: string[]; energy?: string; loopable?: boolean } = {}) {
  return {
    id, label: id, kind: "audio", description: "Local audition candidate", tags: ["audition"],
    downloadUrl: `https://assets.example.test/${id}.wav`, sha256: sha(wave), bytes: wave.byteLength,
    provenance: { creator: "Fixture", license: "CC BY 4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0/", sourceUrl: `https://assets.example.test/source/${id}`, attribution: `${id} by Fixture` },
    audio: { role: "music", durationSamples: 16_000, sampleRate: 8_000, channels: 2, bpmMilli: 120_000, energy: options.energy ?? "medium", moods: options.moods ?? ["curious"], loopable: options.loopable ?? false },
    rights: { basis: "source-asserted", licenseId: "CC-BY-4.0", licenseVersion: "4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0/", evidenceSha256: sha(evidence), compositionGrant: grants(), masterGrant: grants(), reviewStatus: "approved" },
  };
}

function bindings(entries: Array<{ id: string; audioLocator: string; rightsEvidenceLocator: string }>) {
  const body = { format: "cut-audio-audition-bindings" as const, version: 1 as const, entries };
  return parseCutAudioAuditionBindings(JSON.stringify({ ...body, bindingsSha256: cutAudioAuditionBindingsSha256(body) }));
}

function semanticBindings(entries: Array<{
  id: string;
  audioLocator: string;
  rightsEvidenceLocator: string;
  semanticAnalysis: { locator: string; bytes: number; fileSha256: string; analysisSha256: string };
}>) {
  const body = { format: "cut-audio-audition-bindings" as const, version: 2 as const, entries };
  return parseCutAudioAuditionBindings(JSON.stringify({ ...body, bindingsSha256: cutAudioAuditionBindingsSha256(body) }));
}

test("audition bindings are closed, hash-bound, project-local, and duplicate-safe", () => {
  const parsed = bindings([{ id: "bed", audioLocator: "assets/bed.wav", rightsEvidenceLocator: "rights/bed.txt" }]);
  assert.equal(parsed.entries[0]!.id, "bed");
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.entries));
  const tampered = JSON.parse(JSON.stringify(parsed)); tampered.entries[0].audioLocator = "assets/other.wav";
  assert.throws(() => parseCutAudioAuditionBindings(JSON.stringify(tampered)), (error: unknown) => error instanceof CutAudioAuditionError && error.code === "CUT_AUDIO_AUDITION_IDENTITY");
  assert.throws(() => bindings([{ id: "bed", audioLocator: "../bed.wav", rightsEvidenceLocator: "rights/bed.txt" }]), (error: unknown) => error instanceof CutAudioAuditionError && error.code === "CUT_AUDIO_AUDITION_LOCATOR");
});

test("the shipped audition-bindings schema and example agree exactly with the runtime contract", async () => {
  const [schemaBytes, exampleBytes] = await Promise.all([
    readFile(resolve("schemas/cut-audio-audition-bindings-v1.schema.json"), "utf8"),
    readFile(resolve("docs/fixtures/audio-audition-bindings.example.json"), "utf8"),
  ]);
  const schema = JSON.parse(schemaBytes), example = JSON.parse(exampleBytes);
  const validate = new Ajv({ schemaId: "auto", meta: false, validateSchema: false, allErrors: true }).compile(schema);
  assert.equal(validate(example), true, JSON.stringify(validate.errors));
  const parsed = parseCutAudioAuditionBindings(exampleBytes);
  assert.equal(parsed.bindingsSha256, "d4608f944fab55cc5c67cde670a2a2c861f7a04f4f2172b7335806aaeb53d15d");
  assert.deepEqual(parsed.entries, [{
    id: "harbour-water-ambience",
    audioLocator: "assets/harbour-water-ambience.wav",
    rightsEvidenceLocator: "rights/harbour-water-ambience-license.txt",
  }]);
  const unknown = { ...example, conveniencePath: "outside-contract.wav" };
  assert.equal(validate(unknown), false);
  assert.throws(
    () => parseCutAudioAuditionBindings(JSON.stringify(unknown)),
    (error: unknown) => error instanceof CutAudioAuditionError && error.code === "CUT_AUDIO_AUDITION_UNKNOWN_FIELD",
  );
});

test("semantic audition bindings v2 are closed, hash-bound, and preserve the legacy v1 shape", async () => {
  const [schemaBytes, exampleBytes] = await Promise.all([
    readFile(resolve("schemas/cut-audio-audition-bindings-v2.schema.json"), "utf8"),
    readFile(resolve("docs/fixtures/audio-audition-bindings-v2.example.json"), "utf8"),
  ]);
  const schema = JSON.parse(schemaBytes), example = JSON.parse(exampleBytes);
  const ajv = new Ajv({ schemaId: "auto", meta: false, validateSchema: false, allErrors: true });
  ajv.addKeyword("x-cut-semanticConstraints", { validate: () => true });
  const validate = ajv.compile(schema);
  assert.equal(validate(example), true, JSON.stringify(validate.errors));
  const parsed = parseCutAudioAuditionBindings(exampleBytes);
  assert.equal(parsed.version, 2);
  assert.equal(parsed.bindingsSha256, "f63ed080905db73e9f9bc06db37057418dcb436a081df10d0aa8ac822f474e46");
  assert.equal(parsed.entries[0]?.semanticAnalysis?.locator, ".cut/audio/local-music-bed.analysis.json");
  assert.equal(bindings([{ id: "bed", audioLocator: "assets/bed.wav", rightsEvidenceLocator: "rights/bed.txt" }]).version, 1);
  const missingSemantic = structuredClone(example); delete missingSemantic.entries[0].semanticAnalysis;
  assert.equal(validate(missingSemantic), false);
  assert.throws(
    () => parseCutAudioAuditionBindings(JSON.stringify(missingSemantic)),
    (error: unknown) => error instanceof CutAudioAuditionError && error.code === "CUT_AUDIO_AUDITION_TYPE",
  );
});

test("materialized semantic artifacts revalidate schema, canonical hashes, and internal authority links", () => {
  const artifact = createYamnetSemanticTestArtifact(clickWave(), "assets/bed.wav", { 132: 0.9, 271: 0.4 });
  const parsed = parseCutAudioAuditionSemanticAnalysis(artifact.bytes);
  assert.equal(parsed.analysisSha256, artifact.analysis.analysisSha256);
  assert.equal(parsed.taxonomy.aggregate.roleSuggestions.find(({ id }) => id === "music")?.scorePpm, 900_000);
  assert.equal(parsed.taxonomy.aggregate.musicMoodSuggestions.find(({ id }) => id === "joyful")?.scorePpm, 400_000);

  const taxonomyMutation = JSON.parse(artifact.bytes.toString("utf8"));
  taxonomyMutation.taxonomy.aggregate.roleSuggestions[1].scorePpm = 100_000;
  const { analysisSha256: _taxonomyHash, ...taxonomyBody } = taxonomyMutation;
  taxonomyMutation.analysisSha256 = sha(stableJsonStringify(taxonomyBody));
  assert.throws(
    () => parseCutAudioAuditionSemanticAnalysis(JSON.stringify(taxonomyMutation)),
    (error: unknown) => error instanceof CutAudioAuditionError && error.code === "CUT_AUDIO_AUDITION_SEMANTIC_DERIVATION",
  );

  const normalizationMutation = JSON.parse(artifact.bytes.toString("utf8"));
  normalizationMutation.normalization.output.sha256 = "0".repeat(64);
  const { analysisSha256: _normalizationHash, ...normalizationBody } = normalizationMutation;
  normalizationMutation.analysisSha256 = sha(stableJsonStringify(normalizationBody));
  assert.throws(
    () => parseCutAudioAuditionSemanticAnalysis(JSON.stringify(normalizationMutation)),
    (error: unknown) => error instanceof CutAudioAuditionError && error.code === "CUT_AUDIO_AUDITION_SEMANTIC_DERIVATION",
  );

  const normalizationLawMutation = JSON.parse(artifact.bytes.toString("utf8"));
  normalizationLawMutation.normalization.wave.blockAlign = 2;
  const { evidenceSha256: _evidenceHash, ...evidenceBody } = normalizationLawMutation.normalization;
  normalizationLawMutation.normalization.evidenceSha256 = sha(stableJsonStringify(evidenceBody));
  const { analysisSha256: _analysisHash, ...analysisBody } = normalizationLawMutation;
  normalizationLawMutation.analysisSha256 = sha(stableJsonStringify(analysisBody));
  assert.throws(
    () => parseCutAudioAuditionSemanticAnalysis(JSON.stringify(normalizationLawMutation)),
    (error: unknown) => error instanceof CutAudioAuditionError && error.code === "CUT_AUDIO_AUDITION_SEMANTIC_DERIVATION",
    "a cascade-rehashed stereo PCM block-align forgery must not cross the public semantic parser",
  );

  const unknown = JSON.parse(artifact.bytes.toString("utf8")); unknown.convenience = true;
  assert.throws(
    () => parseCutAudioAuditionSemanticAnalysis(JSON.stringify(unknown)),
    (error: unknown) => error instanceof CutAudioAuditionError && error.code === "CUT_AUDIO_AUDITION_SEMANTIC_SCHEMA",
  );
  const duplicate = artifact.bytes.toString("utf8").replace('"version":1', '"version":1,"version":1');
  assert.throws(
    () => parseCutAudioAuditionSemanticAnalysis(duplicate),
    (error: unknown) => error instanceof CutAudioAuditionError && error.code === "CUT_AUDIO_AUDITION_SEMANTIC_JSON",
  );
});

test("maximum 10-second semantic artifact parses and replays against authenticated source bytes", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-audition-semantic-maximum-"));
  try {
    await mkdir(resolve(root, "assets"));
    await mkdir(resolve(root, "rights"));
    await mkdir(resolve(root, ".cut"));
    await mkdir(resolve(root, ".cut/audio"));
    const maximumWave = pcm16Wave(16_000, 10, 2, (frame) => (
      frame % 8_000 < 80 ? (1 - (frame % 8_000) / 80) * 0.8 : 0
    ));
    const evidence = Buffer.from("CC BY 4.0 receipt\n");
    const semantic = createYamnetSemanticTestArtifact(maximumWave, "assets/maximum.wav", { 132: 0.9 });
    assert.equal(semantic.analysis.provider.framing.patchCount, 20);
    assert.equal(semantic.analysis.derivationInputs.rawScores.data.length, 55_576);
    assert.equal(cutAudioAuditionLimits.maximumSemanticAnalysisStringBytes, 55_576);
    assert.equal(parseCutAudioAuditionSemanticAnalysis(semantic.bytes).analysisSha256, semantic.analysis.analysisSha256);

    await Promise.all([
      writeFile(resolve(root, "assets/dialogue.wav"), maximumWave),
      writeFile(resolve(root, "assets/maximum.wav"), maximumWave),
      writeFile(resolve(root, "rights/maximum.txt"), evidence),
      writeFile(resolve(root, ".cut/audio/maximum.analysis.json"), semantic.bytes),
    ]);
    const baseEntry = entry("maximum", maximumWave, evidence);
    const catalog = parseCutAssetCatalog(JSON.stringify({
      format: "cut-asset-catalog",
      version: 1,
      name: "maximum semantic fixture",
      entries: [{
        ...baseEntry,
        audio: {
          ...baseEntry.audio,
          durationSamples: 160_000,
          sampleRate: 16_000,
          channels: 2,
        },
      }],
    }));
    const authority = semanticBindings([{
      id: "maximum",
      audioLocator: "assets/maximum.wav",
      rightsEvidenceLocator: "rights/maximum.txt",
      semanticAnalysis: {
        locator: ".cut/audio/maximum.analysis.json",
        bytes: semantic.bytes.byteLength,
        fileSha256: semantic.fileSha256,
        analysisSha256: semantic.analysis.analysisSha256,
      },
    }]);
    const verified = await verifyCutAudioAuditionInputs({
      projectRoot: root,
      dialogueLocator: "assets/dialogue.wav",
      brief: brief(16_000, 10),
      catalog,
      bindings: authority,
      startSample: 0,
      endSample: 160_000,
      musicStartSample: 0,
    });
    assert.equal(verified.candidates.length, 1);
    assert.equal(verified.candidates[0]?.semantic?.analysisSha256, semantic.analysis.analysisSha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("classic PCM WAVE analysis reports exact signal, tempo, and bounded structure evidence", () => {
  const wave = clickWave(), result = analyzeCutAudioAuditionWave(wave, { sampleRate: 8_000, channels: 2, durationSamples: 16_000 });
  assert.equal(result.sourceSamples, 16_000);
  assert.deepEqual(result.renderedSourceIntervals, [{ semantics: "half-open-samples", startSample: 0, endSample: 16_000 }]);
  assert.equal(result.bitsPerSample, 16);
  assert.ok(result.rmsDbfsMilli < 0 && result.peakDbfsMilli < 0);
  assert.ok(result.activityPpm > 0 && result.tempoCandidates.length > 0);
  assert.equal(result.sectionRmsDbfsMilli.length, 8);
  const float = Buffer.from(wave); float.writeUInt16LE(3, 20);
  assert.throws(() => analyzeCutAudioAuditionWave(float, { sampleRate: 8_000, channels: 2, durationSamples: 16_000 }), (error: unknown) => error instanceof CutAudioAuditionError && error.code === "CUT_AUDIO_AUDITION_WAVE_SUBSET");

  const split = pcm16Wave(8_000, 2, 2, (frame) => frame < 8_000 ? 0.1 : 0.8);
  const first = analyzeCutAudioAuditionWave(split, { sampleRate: 8_000, channels: 2, durationSamples: 16_000, renderedSourceIntervals: [{ startSample: 0, endSample: 8_000 }] });
  const second = analyzeCutAudioAuditionWave(split, { sampleRate: 8_000, channels: 2, durationSamples: 16_000, renderedSourceIntervals: [{ startSample: 8_000, endSample: 16_000 }] });
  assert.deepEqual(first.renderedSourceIntervals, [{ semantics: "half-open-samples", startSample: 0, endSample: 8_000 }]);
  assert.ok(second.rmsDbfsMilli > first.rmsDbfsMilli + 17_000, "trailing samples outside the selected source interval must not influence evidence");

  const antiPhase = pcm16Wave(8_000, 2, 2, (_frame, channel) => channel === 0 ? 0.8 : -0.8);
  const antiPhaseResult = analyzeCutAudioAuditionWave(antiPhase, { sampleRate: 8_000, channels: 2, durationSamples: 16_000 });
  assert.ok(antiPhaseResult.rmsDbfsMilli > -2_000 && antiPhaseResult.peakDbfsMilli > -2_000, "level and peak evidence must remain channel-safe when a mono analysis downmix cancels");
});

test("verified candidate ranking separates catalog-semantic from actual measured-signal factors", () => {
  const activeWave = clickWave(), quietWave = pcm16Wave(8_000, 2, 2, () => 0), evidence = Buffer.from("exact rights evidence\n");
  const make = (id: string, wave: Buffer): CutAudioAuditionVerifiedCandidate => ({
    entry: parseCutAssetCatalog(JSON.stringify({ format: "cut-asset-catalog", version: 1, name: "fixture", entries: [entry(id, wave, evidence)] })).entries[0] as CutAudioAuditionVerifiedCandidate["entry"],
    binding: { id, audioLocator: `assets/${id}.wav`, rightsEvidenceLocator: `rights/${id}.txt` },
    file: { locator: `assets/${id}.wav`, basename: `${id}.wav`, bytes: wave.byteLength, sha256: sha(wave) },
    rightsEvidence: { locator: `rights/${id}.txt`, bytes: evidence.byteLength, sha256: sha(evidence) },
    signal: analyzeCutAudioAuditionWave(wave, { sampleRate: 8_000, channels: 2, durationSamples: 16_000 }),
  });
  const result = rankCutAudioAuditionCandidates({ brief: brief(), candidates: [make("quiet", quietWave), make("active", activeWave)], startSample: 0, endSample: 16_000, musicStartSample: 0, top: 2 });
  assert.equal(result[0]!.entry.id, "active");
  assert.equal(result[0]!.score.catalogSemanticPpm, result[1]!.score.catalogSemanticPpm);
  assert.ok(result[0]!.score.measuredSignalPpm > result[1]!.score.measuredSignalPpm);
  assert.equal(result[0]!.leveling.targetRmsDbfsMilli, -24_000);
  assert.equal(result[1]!.leveling.appliedGainDbMilli, 12_000, "silent candidates expose the bounded gain rather than a false normalized level");
});

test("candidate A/B leveling uses the exact measured interval, one transparent RMS target, and peak-safe bounds", () => {
  const evidence = Buffer.from("exact rights evidence\n");
  const make = (id: string, amplitude: number): CutAudioAuditionVerifiedCandidate => {
    const wave = pcm16Wave(8_000, 2, 2, (frame) => Math.sin(frame * 0.05) * amplitude);
    return {
      entry: parseCutAssetCatalog(JSON.stringify({ format: "cut-asset-catalog", version: 1, name: "fixture", entries: [entry(id, wave, evidence)] })).entries[0] as CutAudioAuditionVerifiedCandidate["entry"],
      binding: { id, audioLocator: `assets/${id}.wav`, rightsEvidenceLocator: `rights/${id}.txt` },
      file: { locator: `assets/${id}.wav`, basename: `${id}.wav`, bytes: wave.byteLength, sha256: sha(wave) },
      rightsEvidence: { locator: `rights/${id}.txt`, bytes: evidence.byteLength, sha256: sha(evidence) },
      signal: analyzeCutAudioAuditionWave(wave, { sampleRate: 8_000, channels: 2, durationSamples: 16_000 }),
    };
  };
  const ranked = rankCutAudioAuditionCandidates({ brief: brief(), candidates: [make("low", 0.1), make("high", 0.2)], startSample: 0, endSample: 16_000, musicStartSample: 0, top: 2 });
  const outputLevels = ranked.map((candidate) => candidate.signal.rmsDbfsMilli + candidate.leveling.appliedGainDbMilli);
  assert.deepEqual(outputLevels, [-24_000, -24_000]);
  assert.notEqual(ranked[0]!.leveling.appliedGainDbMilli, ranked[1]!.leveling.appliedGainDbMilli);
  assert.ok(ranked.every((candidate) => candidate.signal.peakDbfsMilli + candidate.leveling.appliedGainDbMilli <= -1_000));
  assert.ok(ranked.every((candidate) => candidate.leveling.policy === "exact-window-rms-target-with-peak-ceiling-v1"));
});

test("loopable nonstationary candidates measure and render exact full-loop plus partial multiplicity", () => {
  const evidence = Buffer.from("exact rights evidence\n");
  const wave = pcm16Wave(8_000, 2, 2, (frame) => frame < 8_000 ? 0.1 : 0.8);
  const catalogEntry = parseCutAssetCatalog(JSON.stringify({
    format: "cut-asset-catalog", version: 1, name: "fixture", entries: [entry("loop", wave, evidence, { loopable: true })],
  })).entries[0] as CutAudioAuditionVerifiedCandidate["entry"];
  const renderedSourceIntervals = [
    { startSample: 0, endSample: 16_000 },
    { startSample: 0, endSample: 16_000 },
    { startSample: 0, endSample: 8_000 },
  ];
  const signal = analyzeCutAudioAuditionWave(wave, { sampleRate: 8_000, channels: 2, durationSamples: 16_000, renderedSourceIntervals });
  const candidate: CutAudioAuditionVerifiedCandidate = {
    entry: catalogEntry,
    binding: { id: "loop", audioLocator: "assets/loop.wav", rightsEvidenceLocator: "rights/loop.txt" },
    file: { locator: "assets/loop.wav", basename: "loop.wav", bytes: wave.byteLength, sha256: sha(wave) },
    rightsEvidence: { locator: "rights/loop.txt", bytes: evidence.byteLength, sha256: sha(evidence) },
    signal,
  };
  const ranked = rankCutAudioAuditionCandidates({ brief: brief(8_000, 5), candidates: [candidate], startSample: 0, endSample: 40_000, musicStartSample: 0, top: 1 })[0]!;
  assert.equal(signal.analyzedSamples, 40_000);
  assert.deepEqual(signal.renderedSourceIntervals.map(({ startSample, endSample }) => ({ startSample, endSample })), renderedSourceIntervals);
  assert.deepEqual(ranked.placement.renderedSourceIntervals, signal.renderedSourceIntervals);
  const singlePass = analyzeCutAudioAuditionWave(wave, { sampleRate: 8_000, channels: 2, durationSamples: 16_000 });
  assert.ok(signal.rmsDbfsMilli < singlePass.rmsDbfsMilli - 500, "the quiet final partial must alter exact rendered-sequence level evidence");
  const generated = createCutAudioAuditionSource({ candidate: ranked, dialogueLocator: "assets/dialogue.wav", startSample: 0, endSample: 40_000, sampleRate: 8_000 });
  assert.equal((generated.source.match(/AudioClip\(source: candidate/gu) ?? []).length, 3);
  assert.match(generated.source, /range: seconds\(0 \/ 8000\) \.\.< seconds\(8000 \/ 8000\)/u);

  const falselySinglePass = { ...candidate, signal: singlePass };
  assert.throws(
    () => rankCutAudioAuditionCandidates({ brief: brief(8_000, 5), candidates: [falselySinglePass], startSample: 0, endSample: 40_000, musicStartSample: 0, top: 1 }),
    (error: unknown) => error instanceof CutAudioAuditionError && error.code === "CUT_AUDIO_AUDITION_SIGNAL_INTERVAL",
  );
});

test("generated audition source is ordinary public CUT with exact dialogue range and measured candidate bus", () => {
  const wave = clickWave(), evidence = Buffer.from("rights\n"), catalogEntry = parseCutAssetCatalog(JSON.stringify({ format: "cut-asset-catalog", version: 1, name: "fixture", entries: [entry("bed", wave, evidence)] })).entries[0] as CutAudioAuditionVerifiedCandidate["entry"];
  const candidate: CutAudioAuditionVerifiedCandidate = {
    entry: catalogEntry, binding: { id: "bed", audioLocator: "assets/bed.wav", rightsEvidenceLocator: "rights/bed.txt" },
    file: { locator: "assets/bed.wav", basename: "bed.wav", bytes: wave.byteLength, sha256: sha(wave) },
    rightsEvidence: { locator: "rights/bed.txt", bytes: evidence.byteLength, sha256: sha(evidence) },
    signal: analyzeCutAudioAuditionWave(wave, { sampleRate: 8_000, channels: 2, durationSamples: 16_000, renderedSourceIntervals: [{ startSample: 0, endSample: 6_000 }] }),
  };
  const ranked = rankCutAudioAuditionCandidates({ brief: brief(), candidates: [candidate], startSample: 4_000, endSample: 12_000, musicStartSample: 2_000, top: 1 })[0]!;
  const generated = createCutAudioAuditionSource({ candidate: ranked, dialogueLocator: "assets/dialogue.wav", startSample: 4_000, endSample: 12_000, sampleRate: 8_000 });
  assert.match(generated.source, /Bus\(name: "dialogue", role: "dialogue"\) as dialogue/u);
  assert.match(generated.source, /Sidechain\(source: dialogue/u);
  assert.match(generated.source, /seconds\(4000 \/ 8000\) \.\.< seconds\(12000 \/ 8000\)/u);
  assert.match(generated.source, /at seconds\(2000 \/ 8000\)/u);
  assert.ok(generated.source.includes(`Gain(amount: ${(ranked.leveling.appliedGainDbMilli / 1_000).toFixed(3)}db)`));
  assert.equal(generated.sourceSha256, sha(generated.source));
  const parsed = parseCutLanguage(generated.source); assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
  const diagnostics = [...parsed.diagnostics, ...checkCutModule(parsed.module).diagnostics].filter((item) => item.severity === "error");
  assert.deepEqual(diagnostics, []);
  assert.doesNotThrow(() => compileCutModule(parsed.module!));
});

test("input verification authenticates dialogue, candidate, and rights bytes and fails closed on evidence drift", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-audition-inputs-"));
  try {
    await mkdir(resolve(root, "assets")); await mkdir(resolve(root, "rights"));
    const dialogue = pcm16Wave(8_000, 2, 2, (frame) => Math.sin(frame * 0.05) * 0.2), candidate = clickWave(), evidence = Buffer.from("CC BY 4.0 receipt\n");
    await Promise.all([writeFile(resolve(root, "assets/dialogue.wav"), dialogue), writeFile(resolve(root, "assets/bed.wav"), candidate), writeFile(resolve(root, "rights/bed.txt"), evidence)]);
    const catalog = parseCutAssetCatalog(JSON.stringify({ format: "cut-asset-catalog", version: 1, name: "fixture", entries: [entry("bed", candidate, evidence)] }));
    const authority = bindings([{ id: "bed", audioLocator: "assets/bed.wav", rightsEvidenceLocator: "rights/bed.txt" }]);
    const verified = await verifyCutAudioAuditionInputs({ projectRoot: root, dialogueLocator: "assets/dialogue.wav", brief: brief(), catalog, bindings: authority, startSample: 4_000, endSample: 12_000, musicStartSample: 2_000 });
    assert.equal(verified.dialogue.sha256, sha(dialogue));
    assert.equal(verified.candidates[0]!.file.sha256, sha(candidate));
    assert.equal(verified.candidates[0]!.rightsEvidence.sha256, sha(evidence));
    assert.deepEqual(verified.dialogueSignal.renderedSourceIntervals, [{ semantics: "half-open-samples", startSample: 4_000, endSample: 12_000 }]);
    assert.deepEqual(verified.candidates[0]!.signal.renderedSourceIntervals, [{ semantics: "half-open-samples", startSample: 0, endSample: 6_000 }]);

    const ranked = rankCutAudioAuditionCandidates({ brief: brief(), candidates: verified.candidates, startSample: 4_000, endSample: 12_000, musicStartSample: 2_000, top: 1 })[0]!;
    const generated = createCutAudioAuditionSource({ candidate: ranked, dialogueLocator: "assets/dialogue.wav", startSample: 4_000, endSample: 12_000, sampleRate: 8_000 });
    const parsed = parseCutLanguage(generated.source); assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
    const replacement = pcm16Wave(8_000, 2, 2, (frame) => Math.sin(frame * 0.09) * 0.7);
    assert.equal(replacement.byteLength, candidate.byteLength);
    assert.notEqual(sha(replacement), sha(candidate));
    await writeFile(resolve(root, "assets/bed.wav"), replacement);
    const ir = compileCutModule(parsed.module!).ir, changedLock = await createCutLock(ir, root);
    const changedApplied = await applyCutLockForVerifiedInputSession(ir, changedLock, root);
    assert.throws(
      () => assertCutAudioAuditionRenderAuthorities({
        lockResources: changedLock.resources,
        appliedResources: changedApplied.ir.resources,
        dialogue: verified.dialogue,
        candidate: verified.candidates[0]!,
      }),
      (error: unknown) => error instanceof CutAudioAuditionError && error.code === "CUT_AUDIO_AUDITION_LOCK_AUTHORITY",
      "a candidate swapped after verification but before lock creation must not inherit the earlier ranking authority",
    );

    await writeFile(resolve(root, "rights/bed.txt"), "changed\n");
    await assert.rejects(verifyCutAudioAuditionInputs({ projectRoot: root, dialogueLocator: "assets/dialogue.wav", brief: brief(), catalog, bindings: authority, startSample: 4_000, endSample: 12_000, musicStartSample: 2_000 }), (error: unknown) => error instanceof CutAudioAuditionError && error.code === "CUT_AUDIO_AUDITION_RIGHTS_IDENTITY");
    assert.notEqual(sha(await readFile(resolve(root, "rights/bed.txt"))), sha(evidence));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("post-resolution filesystem failures remain locator-only in public diagnostics", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-audition-private-path-"));
  try {
    await mkdir(resolve(root, "inputs"));
    const locator = "inputs/raced.json", path = resolve(root, locator);
    await writeFile(path, "{}\n");
    let caught: unknown;
    await assert.rejects(
      loadCutAudioAuditionProjectFile(root, locator, 1024, { afterResolve: async () => unlink(path) }),
      (error: unknown) => {
        caught = error;
        return error instanceof CutAudioAuditionError && error.code === "CUT_AUDIO_AUDITION_FILE";
      },
    );
    const report = stableJsonStringify(cutDiagnosticsFromError(caught));
    assert.match(report, /inputs\/raced\.json/u);
    assert.equal(report.includes(root), false, "resolved project root must not cross the JSON diagnostic boundary");
    assert.equal(report.includes(tmpdir()), false, "OS temporary-directory paths must not cross the JSON diagnostic boundary");

    let missingCaught: unknown;
    await assert.rejects(
      loadCutAudioAuditionProjectFile(root, "inputs/missing.json", 1024),
      (error: unknown) => {
        missingCaught = error;
        return error instanceof CutAudioAuditionError && error.code === "CUT_AUDIO_AUDITION_FILE";
      },
    );
    const missingReport = stableJsonStringify(cutDiagnosticsFromError(missingCaught));
    assert.match(missingReport, /inputs\/missing\.json/u);
    assert.equal(missingReport.includes(root), false);
    assert.equal(missingReport.includes(tmpdir()), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("v2 semantic authority is source-bound, rights-gated, cohort-complete, and applies a bounded additive score adjustment only to exact whole-source music", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-audition-semantic-"));
  try {
    await mkdir(resolve(root, "assets")); await mkdir(resolve(root, "rights")); await mkdir(resolve(root, ".cut")); await mkdir(resolve(root, ".cut/audio"));
    const dialogue = pcm16Wave(8_000, 2, 2, (frame) => Math.sin(frame * 0.05) * 0.2);
    const candidate = clickWave(), evidence = Buffer.from("CC BY 4.0 receipt\n");
    const semantic = createYamnetSemanticTestArtifact(candidate, "assets/bed.wav", { 132: 0.9, 271: 0.4 });
    await Promise.all([
      writeFile(resolve(root, "assets/dialogue.wav"), dialogue),
      writeFile(resolve(root, "assets/bed.wav"), candidate),
      writeFile(resolve(root, "rights/bed.txt"), evidence),
      writeFile(resolve(root, ".cut/audio/bed.analysis.json"), semantic.bytes),
    ]);
    const catalogEntry = entry("bed", candidate, evidence);
    const catalog = parseCutAssetCatalog(JSON.stringify({ format: "cut-asset-catalog", version: 1, name: "fixture", entries: [catalogEntry] }));
    const authority = semanticBindings([{
      id: "bed",
      audioLocator: "assets/bed.wav",
      rightsEvidenceLocator: "rights/bed.txt",
      semanticAnalysis: {
        locator: ".cut/audio/bed.analysis.json",
        bytes: semantic.bytes.byteLength,
        fileSha256: semantic.fileSha256,
        analysisSha256: semantic.analysis.analysisSha256,
      },
    }]);
    const verified = await verifyCutAudioAuditionInputs({
      projectRoot: root,
      dialogueLocator: "assets/dialogue.wav",
      brief: brief(),
      catalog,
      bindings: authority,
      startSample: 0,
      endSample: 16_000,
      musicStartSample: 0,
    });
    assert.equal(verified.candidates[0]?.semantic?.contract, "authenticated-source-and-embedded-semantic-derivation-recomputed-without-model-reexecution-v1");
    assert.equal(verified.candidates[0]?.semantic?.file.sha256, semantic.fileSha256);
    const ranked = rankCutAudioAuditionCandidates({ brief: brief(), candidates: verified.candidates, startSample: 0, endSample: 16_000, musicStartSample: 0, top: 1 });
    assert.deepEqual(ranked[0]?.score.semanticAdvisory, {
      policy: "whole-source-music-only-centered-four-percent-capped-v1",
      applicability: "applied-exact-whole-source-music",
      role: "music",
      roleSuggestionPpm: 900_000,
      deltaPpm: 16_000,
    });

    const withMusicSuggestion = (id: string, scorePpm: number): CutAudioAuditionVerifiedCandidate => {
      const base = verified.candidates[0]!, semanticEvidence = base.semantic!;
      return {
        ...base,
        entry: { ...base.entry, id, label: id },
        binding: { ...base.binding, id },
        semantic: {
          ...semanticEvidence,
          taxonomy: {
            ...semanticEvidence.taxonomy,
            roleSuggestions: semanticEvidence.taxonomy.roleSuggestions.map((suggestion) => suggestion.id === "music" ? { ...suggestion, scorePpm } : suggestion),
          },
        },
      };
    };
    const capped = rankCutAudioAuditionCandidates({
      brief: brief(),
      candidates: [withMusicSuggestion("negative", 0), withMusicSuggestion("positive", 1_000_000)],
      startSample: 0,
      endSample: 16_000,
      musicStartSample: 0,
      top: 2,
    });
    assert.deepEqual(capped.map((candidate) => [candidate.entry.id, candidate.score.semanticAdvisory?.deltaPpm]), [["positive", 20_000], ["negative", -20_000]]);
    assert.equal(capped[0]!.score.totalPpm - capped[1]!.score.totalPpm, 40_000, "opposite exact caps may reverse an otherwise equal pair by exactly 40,000 ppm");
    const reversed = rankCutAudioAuditionCandidates({
      brief: brief(),
      candidates: [withMusicSuggestion("negative", 1_000_000), withMusicSuggestion("positive", 0)],
      startSample: 0,
      endSample: 16_000,
      musicStartSample: 0,
      top: 2,
    });
    assert.deepEqual(reversed.map((candidate) => candidate.entry.id), ["negative", "positive"]);
    const tied = rankCutAudioAuditionCandidates({
      brief: brief(),
      candidates: [withMusicSuggestion("positive", 500_000), withMusicSuggestion("negative", 500_000)],
      startSample: 0,
      endSample: 16_000,
      musicStartSample: 0,
      top: 2,
    });
    assert.deepEqual(tied.map((candidate) => candidate.entry.id), ["negative", "positive"], "exact score ties remain candidate-id ordered");

    const partialCandidate: CutAudioAuditionVerifiedCandidate = {
      ...verified.candidates[0]!,
      signal: analyzeCutAudioAuditionWave(candidate, {
        sampleRate: 8_000,
        channels: 2,
        durationSamples: 16_000,
        renderedSourceIntervals: [{ startSample: 0, endSample: 8_000 }],
      }),
    };
    const partial = rankCutAudioAuditionCandidates({ brief: brief(), candidates: [partialCandidate], startSample: 0, endSample: 8_000, musicStartSample: 0, top: 1 });
    assert.equal(partial[0]?.score.semanticAdvisory?.applicability, "not-applied-inexact-rendered-window");
    assert.equal(partial[0]?.score.semanticAdvisory?.deltaPpm, 0);

    const baseBrief = brief();
    const repeatedBrief = {
      ...baseBrief,
      durationSamples: 32_000,
      acts: baseBrief.acts.map((act) => ({ ...act, range: { startSample: 0, endSample: 32_000 } })),
    };
    const repeatedWholeCandidate: CutAudioAuditionVerifiedCandidate = {
      ...verified.candidates[0]!,
      entry: {
        ...verified.candidates[0]!.entry,
        audio: { ...verified.candidates[0]!.entry.audio, loopable: true },
      },
      signal: analyzeCutAudioAuditionWave(candidate, {
        sampleRate: 8_000,
        channels: 2,
        durationSamples: 16_000,
        renderedSourceIntervals: [{ startSample: 0, endSample: 16_000 }, { startSample: 0, endSample: 16_000 }],
      }),
    };
    const repeated = rankCutAudioAuditionCandidates({ brief: repeatedBrief, candidates: [repeatedWholeCandidate], startSample: 0, endSample: 32_000, musicStartSample: 0, top: 1 });
    assert.equal(repeated[0]?.placement.loops, 2);
    assert.equal(repeated[0]?.score.semanticAdvisory?.applicability, "applied-exact-whole-source-music");
    assert.equal(repeated[0]?.score.semanticAdvisory?.deltaPpm, 16_000);

    const signalForgery = JSON.parse(semantic.bytes.toString("utf8"));
    signalForgery.signal.activity[0].meanAbsolutePpm = signalForgery.signal.activity[0].meanAbsolutePpm === 0 ? 1 : 0;
    const { analysisSha256: _signalHash, ...signalBody } = signalForgery;
    signalForgery.analysisSha256 = sha(stableJsonStringify(signalBody));
    const signalForgeryBytes = Buffer.from(`${stableJsonStringify(signalForgery)}\n`);
    await writeFile(resolve(root, ".cut/audio/bed.analysis.json"), signalForgeryBytes);
    const forgedAuthority = semanticBindings([{
      id: "bed",
      audioLocator: "assets/bed.wav",
      rightsEvidenceLocator: "rights/bed.txt",
      semanticAnalysis: {
        locator: ".cut/audio/bed.analysis.json",
        bytes: signalForgeryBytes.byteLength,
        fileSha256: sha(signalForgeryBytes),
        analysisSha256: signalForgery.analysisSha256,
      },
    }]);
    await assert.rejects(
      verifyCutAudioAuditionInputs({ projectRoot: root, dialogueLocator: "assets/dialogue.wav", brief: brief(), catalog, bindings: forgedAuthority, startSample: 0, endSample: 16_000, musicStartSample: 0 }),
      (error: unknown) => error instanceof CutAudioAuditionError && error.code === "CUT_AUDIO_AUDITION_SEMANTIC_REPLAY",
      "a cascade-rehashed signal forgery must differ from source-backed semantic replay",
    );
    await writeFile(resolve(root, ".cut/audio/bed.analysis.json"), semantic.bytes);
    assert.throws(
      () => rankCutAudioAuditionCandidates({ brief: brief(), candidates: [verified.candidates[0]!, { ...verified.candidates[0]!, semantic: undefined }], startSample: 0, endSample: 16_000, musicStartSample: 0, top: 2 }),
      (error: unknown) => error instanceof CutAudioAuditionError && error.code === "CUT_AUDIO_AUDITION_SEMANTIC_COHORT",
    );

    await writeFile(resolve(root, ".cut/audio/bed.analysis.json"), `${semantic.bytes.toString("utf8").trim()} \n`);
    await assert.rejects(
      verifyCutAudioAuditionInputs({ projectRoot: root, dialogueLocator: "assets/dialogue.wav", brief: brief(), catalog, bindings: authority, startSample: 0, endSample: 16_000, musicStartSample: 0 }),
      (error: unknown) => error instanceof CutAudioAuditionError && error.code === "CUT_AUDIO_AUDITION_SEMANTIC_IDENTITY",
    );

    const deniedCatalog = parseCutAssetCatalog(JSON.stringify({
      format: "cut-asset-catalog",
      version: 1,
      name: "fixture",
      entries: [{ ...catalogEntry, rights: { ...catalogEntry.rights, reviewStatus: "rejected" } }],
    }));
    const missingSemanticBody = {
      format: "cut-audio-audition-bindings" as const,
      version: 2 as const,
      entries: [{
        id: "bed",
        audioLocator: "assets/bed.wav",
        rightsEvidenceLocator: "rights/bed.txt",
        semanticAnalysis: { locator: ".cut/audio/missing.json", bytes: 1, fileSha256: "a".repeat(64), analysisSha256: "b".repeat(64) },
      }],
    };
    const missingSemanticAuthority = parseCutAudioAuditionBindings(JSON.stringify({
      ...missingSemanticBody,
      bindingsSha256: cutAudioAuditionBindingsSha256(missingSemanticBody),
    }));
    await assert.rejects(
      verifyCutAudioAuditionInputs({ projectRoot: root, dialogueLocator: "assets/dialogue.wav", brief: brief(), catalog: deniedCatalog, bindings: missingSemanticAuthority, startSample: 0, endSample: 16_000, musicStartSample: 0 }),
      (error: unknown) => error instanceof CutAudioAuditionError && error.code === "CUT_AUDIO_AUDITION_NO_CANDIDATE",
      "a rights-denied candidate must be excluded without opening its semantic locator",
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("selection identities use canonical JSON rather than insertion order", () => {
  const left = stableJsonStringify({ b: 2, a: 1 }), right = stableJsonStringify({ a: 1, b: 2 });
  assert.equal(left, right);
});

test("failed audition rollback removes only the exact retained inode and bytes", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-audition-owned-"));
  try {
    const stagePath = resolve(root, "stage"); await mkdir(stagePath, { mode: 0o700 });
    const stage = await retainCutAudioAuditionOwnedDirectory(stagePath);
    const path = resolve(root, "audition.wav"), original = Buffer.from("CUT-owned audition\n"), foreign = Buffer.from("foreign replacement\n");
    await writeFile(path, original);
    const authority = await retainCutAudioAuditionOwnedArtifact(path, sha(original), 1024);
    const replacement = resolve(root, "foreign.tmp"); await writeFile(replacement, foreign); await rename(replacement, path);
    assert.equal(await removeCutAudioAuditionOwnedArtifact(authority, stage), "foreign");
    assert.deepEqual(await readFile(path), foreign, "rollback must preserve a foreign replacement");

    const ownedPath = resolve(root, "owned.lock"); await writeFile(ownedPath, original);
    const owned = await retainCutAudioAuditionOwnedArtifact(ownedPath, sha(original), 1024);
    assert.equal(await removeCutAudioAuditionOwnedArtifact(owned, stage), "removed");
    await assert.rejects(readFile(ownedPath), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT"));
    assert.equal(await removeCutAudioAuditionOwnedDirectory(stage), "removed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("inode-located cleanup quarantines then restores a foreign file raced after lookup", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-audition-race-"));
  try {
    const stagePath = resolve(root, "stage"); await mkdir(stagePath, { mode: 0o700 });
    const stage = await retainCutAudioAuditionOwnedDirectory(stagePath);
    const path = resolve(root, "partial.wav"), moved = resolve(root, "owned-moved.wav");
    const original = Buffer.from("owned partial\n"), foreign = Buffer.from("foreign raced bytes\n");
    await writeFile(path, original);
    const authority = await retainCutAudioAuditionOwnedArtifact(path, sha(original), 1024);
    const result = await removeCutAudioAuditionOwnedArtifact(authority, stage, {
      beforeQuarantine: async (located) => { await rename(located, moved); await writeFile(located, foreign); },
    });
    assert.equal(result, "foreign");
    assert.deepEqual(await readFile(path), foreign, "raced foreign bytes must be restored at their exact path");
    assert.deepEqual(await readFile(moved), original, "the moved owned inode must not authorize deleting the raced foreign path");
    assert.equal(await removeCutAudioAuditionOwnedDirectory(stage), "removed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("failed audition rollback removes only its exact private staging directory", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-audition-owned-dir-"));
  try {
    const stage = resolve(root, "stage"); await mkdir(stage, { mode: 0o700 }); await writeFile(resolve(stage, "owned.tmp"), "owned\n");
    const authority = await retainCutAudioAuditionOwnedDirectory(stage);
    const moved = resolve(root, "old-stage"); await rename(stage, moved); await mkdir(stage); await writeFile(resolve(stage, "foreign.txt"), "foreign\n");
    assert.equal(await removeCutAudioAuditionOwnedDirectory(authority), "removed");
    assert.equal(await readFile(resolve(stage, "foreign.txt"), "utf8"), "foreign\n");

    const exact = resolve(root, "exact"); await mkdir(exact, { mode: 0o700 }); await writeFile(resolve(exact, "partial.wav"), "partial\n");
    const exactAuthority = await retainCutAudioAuditionOwnedDirectory(exact);
    assert.equal(await removeCutAudioAuditionOwnedDirectory(exactAuthority), "removed");
    await assert.rejects(lstat(exact), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("staging cleanup quarantines and preserves a foreign directory raced after inode lookup", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-audition-stage-race-"));
  try {
    const stagePath = resolve(root, "stage"), movedOwned = resolve(root, "owned-stage-moved");
    await mkdir(stagePath, { mode: 0o700 }); await writeFile(resolve(stagePath, "owned.tmp"), "owned\n");
    const authority = await retainCutAudioAuditionOwnedDirectory(stagePath);
    const result = await removeCutAudioAuditionOwnedDirectory(authority, {
      beforeStageQuarantine: async (located) => {
        await rename(located, movedOwned); await mkdir(located, { mode: 0o700 }); await writeFile(resolve(located, "foreign.txt"), "foreign\n");
      },
    });
    assert.equal(result, "foreign");
    assert.equal(await readFile(resolve(movedOwned, "owned.tmp"), "utf8"), "owned\n");
    const quarantine = (await readdir(root)).find((name) => name.startsWith(".cleanup-stage-"));
    assert.ok(quarantine, "raced foreign directory must remain preserved in a bounded quarantine");
    assert.equal(await readFile(resolve(root, quarantine, "foreign.txt"), "utf8"), "foreign\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});
