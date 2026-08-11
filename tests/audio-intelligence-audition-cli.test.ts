import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { cutAudioAuditionBindingsSha256, cutAudioAuditionSelectionSha256 } from "../lib/audio-intelligence/audition";
import { cutAudioBriefSha256 } from "../lib/audio-intelligence/brief";
import { createYamnetSemanticTestArtifact } from "./yamnet-semantic-test-fixture";

const cli = resolve("dist-cli/cli/cut.js"), sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

type V1AuditionReceipt = Readonly<{
  selectionSha256: string;
  ranking: Readonly<{
    candidates: readonly Readonly<{
      lock: Readonly<{ bytes: number; sha256: string; [key: string]: unknown }>;
      audition: Readonly<{
        manifest: Readonly<{ bytes: number; sha256: string; [key: string]: unknown }>;
        [key: string]: unknown;
      }>;
      [key: string]: unknown;
    }>[];
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}>;

function portableV1ReceiptSha256(receipt: V1AuditionReceipt) {
  const { selectionSha256: receiptSelfHash, ...body } = receipt;
  assert.equal(cutAudioAuditionSelectionSha256(body), receiptSelfHash, "the selection receipt must authenticate its exact environment-bound body");
  const candidates = receipt.ranking.candidates.map((candidate) => ({
    ...candidate,
    // Locks deliberately bind ffprobe identity, while exact WAVE bytes and
    // manifests bind the selected FFmpeg/reference backend. Their native-authority
    // bytes/hashes can vary across valid toolchain versions even when the stable
    // v1 plan, source, sample contract, and receipt structure remain unchanged.
    lock: { ...candidate.lock, bytes: "environment-bound-native-authority", sha256: "environment-bound-native-authority" },
    audition: {
      ...candidate.audition,
      sha256: "environment-bound-native-authority",
      manifest: { ...candidate.audition.manifest, bytes: "environment-bound-native-authority", sha256: "environment-bound-native-authority" },
    },
  }));
  return cutAudioAuditionSelectionSha256({ ...body, ranking: { ...receipt.ranking, candidates } });
}

function wave(kind: "voice" | "click", seconds = 1) {
  const sampleRate = 8_000, frames = sampleRate * seconds, channels = 2, dataBytes = frames * channels * 2, bytes = Buffer.alloc(44 + dataBytes);
  bytes.write("RIFF", 0, "ascii"); bytes.writeUInt32LE(36 + dataBytes, 4); bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii"); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * channels * 2, 28); bytes.writeUInt16LE(channels * 2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii"); bytes.writeUInt32LE(dataBytes, 40);
  for (let frame = 0; frame < frames; frame += 1) {
    const value = kind === "voice" ? Math.sin(frame * 0.05) * 0.2 : frame % 4_000 < 80 ? (1 - frame % 4_000 / 80) * 0.8 : 0;
    for (let channel = 0; channel < channels; channel += 1) bytes.writeInt16LE(Math.round(value * 32_767), 44 + (frame * channels + channel) * 2);
  }
  return bytes;
}

function grant() { return { commercialUse: true, modification: true, audiovisualSynchronization: true, standaloneRedistribution: false, attributionRequired: true, shareAlike: false }; }

async function project(changeEvidence = false, seconds = 1, semanticMode = false) {
  const root = await mkdtemp(resolve(tmpdir(), "cut-audio-audition-cli-")); await mkdir(resolve(root, "assets")); await mkdir(resolve(root, "rights"));
  const dialogue = wave("voice", seconds), bed = wave("click", seconds), evidence = Buffer.from("CC BY 4.0 local evidence\n");
  await Promise.all([
    writeFile(resolve(root, "assets/dialogue.wav"), dialogue), writeFile(resolve(root, "assets/bed.wav"), bed),
    writeFile(resolve(root, "rights/bed.txt"), changeEvidence ? "changed evidence\n" : evidence),
  ]);
  const briefBody = {
    format: "cut-audio-brief" as const, version: 1 as const, sampleRate: 8_000, durationSamples: 8_000 * seconds, sourceScriptSha256: "1".repeat(64),
    acts: [{ id: "hook", range: { startSample: 0, endSample: 8_000 * seconds }, narrativeTurn: "hook" as const, desiredRoles: ["music"] as const, moods: ["curious"], energyPpm: 500_000, densityPpm: 500_000, dialogueSpacePpm: 900_000, intent: "Protect the spoken hook." }],
    events: [], intentionalSilences: [],
  };
  const brief = { ...briefBody, briefSha256: cutAudioBriefSha256(briefBody) };
  const catalog = {
    format: "cut-asset-catalog", version: 1, name: "Local review candidates", entries: [{
      id: "bed", label: "Measured bed", kind: "audio", description: "One exact local PCM candidate.", tags: ["curious"],
      downloadUrl: "https://assets.example.test/bed.wav", sha256: sha(bed), bytes: bed.byteLength,
      provenance: { creator: "Fixture", license: "CC BY 4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0/", sourceUrl: "https://assets.example.test/source/bed", attribution: "Measured bed by Fixture" },
      audio: { role: "music", durationSamples: 8_000 * seconds, sampleRate: 8_000, channels: 2, bpmMilli: 120_000, energy: "medium", moods: ["curious"], loopable: false },
      rights: { basis: "source-asserted", licenseId: "CC-BY-4.0", licenseVersion: "4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0/", evidenceSha256: sha(evidence), compositionGrant: grant(), masterGrant: grant(), reviewStatus: "approved" },
    }],
  };
  const semantic = semanticMode ? createYamnetSemanticTestArtifact(bed, "assets/bed.wav", { 132: 0.9 }) : undefined;
  if (semantic) { await mkdir(resolve(root, ".cut")); await mkdir(resolve(root, ".cut/audio")); await writeFile(resolve(root, ".cut/audio/bed.analysis.json"), semantic.bytes); }
  const bindingsBody = semantic ? {
    format: "cut-audio-audition-bindings" as const,
    version: 2 as const,
    entries: [{
      id: "bed",
      audioLocator: "assets/bed.wav",
      rightsEvidenceLocator: "rights/bed.txt",
      semanticAnalysis: {
        locator: ".cut/audio/bed.analysis.json",
        bytes: semantic.bytes.byteLength,
        fileSha256: semantic.fileSha256,
        analysisSha256: semantic.analysis.analysisSha256,
      },
    }],
  } : {
    format: "cut-audio-audition-bindings" as const,
    version: 1 as const,
    entries: [{ id: "bed", audioLocator: "assets/bed.wav", rightsEvidenceLocator: "rights/bed.txt" }],
  };
  await Promise.all([
    writeFile(resolve(root, "brief.json"), `${JSON.stringify(brief)}\n`), writeFile(resolve(root, "catalog.json"), `${JSON.stringify(catalog)}\n`),
    writeFile(resolve(root, "bindings.json"), `${JSON.stringify({ ...bindingsBody, bindingsSha256: cutAudioAuditionBindingsSha256(bindingsBody) })}\n`),
  ]);
  return root;
}

function run(root: string, args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8", env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" }, timeout: 60_000 });
}

test("audio audition CLI authenticates, ranks, emits public source+lock, and renders exact WAV evidence", { timeout: 90_000 }, async () => {
  const roots = [await project(), await project()];
  try {
    const receipts = [];
    for (const root of roots) {
      const result = run(root, ["audio", "audition", "brief.json", "--dialogue", "assets/dialogue.wav", "--catalog", "catalog.json", "--bindings", "bindings.json", "--samples", "0:8000", "--music-start-sample", "1000", "--out", "review/audio", "--top", "1", "--json"]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const receipt = JSON.parse(result.stdout); receipts.push(receipt);
      assert.equal(receipt.status, "non-authoritative-candidate-review");
      assert.equal(receipt.ranking.candidates.length, 1);
      assert.equal(receipt.ranking.candidates[0].measuredSignal.contract, "bounded-classic-pcm-wave-v1");
      assert.deepEqual(receipt.ranking.candidates[0].measuredSignal.renderedSourceIntervals, [{ semantics: "half-open-samples", startSample: 0, endSample: 7_000 }]);
      assert.equal(receipt.window.musicStartSample, 1_000);
      assert.equal(receipt.ranking.candidates[0].placement.auditionStartSample, 1_000);
      assert.equal(receipt.ranking.candidates[0].leveling.targetRmsDbfsMilli, -24_000);
      assert.equal(receipt.ranking.candidates[0].leveling.peakCeilingDbfsMilli, -1_000);
      assert.equal(receipt.review.humanListening, "unperformed"); assert.equal(receipt.review.humanRightsApproval, "unperformed");
      const candidate = receipt.ranking.candidates[0], source = await readFile(resolve(root, candidate.source.locator), "utf8");
      assert.match(source, /Sidechain\(source: dialogue/u); assert.match(source, /at seconds\(1000 \/ 8000\)/u); assert.equal(sha(source), candidate.source.sha256);
      const checked = run(root, ["check", candidate.source.locator, "--json"]); assert.equal(checked.status, 0, checked.stdout + checked.stderr);
      const inspected = run(root, ["inspect", candidate.source.locator, "--lock", candidate.lock.locator, "--json"]); assert.equal(inspected.status, 0, inspected.stdout + inspected.stderr);
      const wav = await readFile(resolve(root, candidate.audition.locator)); assert.equal(wav.toString("ascii", 0, 4), "RIFF"); assert.equal(sha(wav), candidate.audition.sha256);
      assert.deepEqual(JSON.parse(await readFile(resolve(root, "review/audio/selection.json"), "utf8")), receipt);
      assert.deepEqual(await readdir(resolve(root, ".cut/audio-audition-staging")), [], "owned renderer staging must be empty after publication");
    }
    assert.deepEqual(receipts[0], receipts[1], "same-environment independent roots must emit the exact same complete receipt");
    assert.equal(
      portableV1ReceiptSha256(receipts[0]),
      "782a739e10264c95543574ef4d1d62130c1fe0761eb92e5f70b6bcd9616e1e64",
      "the frozen portable v1 omission receipt must remain byte-semantic compatible while v2 is additive",
    );
    assert.equal(receipts[0].ranking.candidates[0].source.sha256, receipts[1].ranking.candidates[0].source.sha256);
    assert.equal(receipts[0].ranking.candidates[0].audition.sha256, receipts[1].ranking.candidates[0].audition.sha256);
  } finally { await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))); }
});

test("audio audition CLI v2 binds semantic authority into plan and receipt with a bounded music-only delta", { timeout: 90_000 }, async () => {
  const root = await project(false, 1, true);
  try {
    const result = run(root, ["audio", "audition", "brief.json", "--dialogue", "assets/dialogue.wav", "--catalog", "catalog.json", "--bindings", "bindings.json", "--samples", "0:8000", "--out", "review/semantic", "--top", "1", "--json"]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const receipt = JSON.parse(result.stdout), candidate = receipt.ranking.candidates[0];
    assert.equal(receipt.ranking.policy, "brief-catalog-exact-window-signal-and-bounded-semantic-advisory-v3");
    assert.equal(receipt.ranking.semanticAdvisory.maximumAbsoluteDeltaPpm, 20_000);
    assert.equal(candidate.score.semanticAdvisory.applicability, "applied-exact-whole-source-music");
    assert.equal(candidate.score.semanticAdvisory.roleSuggestionPpm, 900_000);
    assert.equal(candidate.score.semanticAdvisory.deltaPpm, 16_000);
    assert.equal(candidate.localAuthority.semanticAnalysis.contract, "authenticated-source-and-embedded-semantic-derivation-recomputed-without-model-reexecution-v1");
    assert.equal(candidate.localAuthority.semanticAnalysis.source.sha256, candidate.localAuthority.audio.sha256);
    assert.equal(candidate.localAuthority.semanticAnalysis.limitations.emotion, "no-emotion-inference-claim");
    assert.deepEqual(JSON.parse(await readFile(resolve(root, "review/semantic/selection.json"), "utf8")), receipt);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("audio audition CLI refuses changed rights evidence before publishing source, lock, WAV, or receipt", { timeout: 30_000 }, async () => {
  const root = await project(true);
  try {
    const result = run(root, ["audio", "audition", "brief.json", "--dialogue", "assets/dialogue.wav", "--catalog", "catalog.json", "--bindings", "bindings.json", "--samples", "0:8000", "--out", "review/audio", "--json"]);
    assert.equal(result.status, 1); const report = JSON.parse(result.stdout);
    assert.ok(report.diagnostics.some((item: { code: string }) => item.code === "CUT_AUDIO_AUDITION_RIGHTS_IDENTITY"), result.stdout);
    assert.deepEqual((await readdir(root)).filter((name) => name.startsWith("audio-audition-")), []);
    await assert.rejects(readFile(resolve(root, "review/audio/selection.json")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("audio audition no-clobber JSON reports only the project locator, never the absolute project root", async () => {
  const root = await project();
  try {
    await mkdir(resolve(root, "review")); await mkdir(resolve(root, "review/audio"));
    await writeFile(resolve(root, "review/audio/selection.json"), "foreign\n");
    const result = run(root, ["audio", "audition", "brief.json", "--dialogue", "assets/dialogue.wav", "--catalog", "catalog.json", "--bindings", "bindings.json", "--samples", "0:8000", "--out", "review/audio", "--top", "1", "--json"]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout);
    assert.ok(report.diagnostics.some((item: { code: string }) => item.code === "CUT_AUDIO_AUDITION_OUTPUT_EXISTS"));
    assert.match(result.stdout, /review\/audio\/selection\.json/u);
    assert.equal(result.stdout.includes(root), false, "JSON diagnostics must not expose the absolute project root");
    assert.equal(result.stdout.includes("/private/tmp"), false);
    assert.equal(await readFile(resolve(root, "review/audio/selection.json"), "utf8"), "foreign\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("audio audition missing-input JSON reports only the project locator, never the resolved path", async () => {
  const root = await project();
  try {
    await rm(resolve(root, "brief.json"));
    const result = run(root, ["audio", "audition", "brief.json", "--dialogue", "assets/dialogue.wav", "--catalog", "catalog.json", "--bindings", "bindings.json", "--samples", "0:8000", "--out", "review/audio", "--json"]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout);
    assert.ok(report.diagnostics.some((item: { code: string }) => item.code === "CUT_AUDIO_AUDITION_FILE"), result.stdout);
    assert.match(result.stdout, /brief\.json/u);
    assert.equal(result.stdout.includes(root), false);
    assert.equal(result.stdout.includes("/private/tmp"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("audio audition closed CLI rejects an over-top request before input I/O", () => {
  const result = run(process.cwd(), ["audio", "audition", "missing.json", "--dialogue", "missing.wav", "--catalog", "missing-catalog.json", "--bindings", "missing-bindings.json", "--samples", "0:1", "--out", "review/audio", "--top", "4", "--json"]);
  assert.equal(result.status, 1); const report = JSON.parse(result.stdout);
  assert.ok(report.diagnostics.some((item: { code: string }) => item.code === "CUTC1007"));
});

test("cancelled audio audition rolls back exact partial outputs and its private staging directory", { timeout: 90_000 }, async () => {
  const root = await project(false, 120);
  try {
    const child = spawn(process.execPath, [cli, "audio", "audition", "brief.json", "--dialogue", "assets/dialogue.wav", "--catalog", "catalog.json", "--bindings", "bindings.json", "--samples", "0:960000", "--music-start-sample", "8000", "--out", "review/cancel", "--top", "1", "--json"], {
      cwd: root,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout!.setEncoding("utf8"); child.stdout!.on("data", (chunk) => { stdout += chunk; });
    child.stderr!.setEncoding("utf8"); child.stderr!.on("data", (chunk) => { stderr += chunk; });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => child.once("close", (code, signal) => done({ code, signal })));
    let sourcePath: string | undefined;
    for (let attempt = 0; attempt < 2_000 && !sourcePath; attempt += 1) {
      const names = await readdir(root);
      const source = names.find((name) => /^audio-audition-.*\.cut$/u.test(name));
      if (source) sourcePath = resolve(root, source);
      else await new Promise((done) => setTimeout(done, 2));
    }
    assert.ok(sourcePath, "the bounded cancellation fixture must observe partial source publication");
    child.kill("SIGTERM");
    const outcome = await closed;
    assert.equal(outcome.signal, null, `cancellation handler must drain and exit through CUT diagnostics: ${stderr}`);
    assert.equal(outcome.code, 1, stdout + stderr);
    await assert.rejects(readFile(sourcePath), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT"));
    const reviewNames = await readdir(resolve(root, "review/cancel")).catch(() => []);
    assert.deepEqual(reviewNames, [], "all still-owned partial lock/WAVE/manifest/receipt outputs must be rolled back");
    const stagingNames = await readdir(resolve(root, ".cut/audio-audition-staging")).catch(() => []);
    assert.deepEqual(stagingNames, [], "the exact owned staging directory must be cleaned after cancellation");
  } finally { await rm(root, { recursive: true, force: true }); }
});
