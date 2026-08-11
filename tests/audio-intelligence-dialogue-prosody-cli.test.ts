import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

const cli = resolve("dist-cli/cli/cut.js");
const writeBoundaryModule = resolve("dist-cli/lib/project/write-boundary.js");
const auditionModule = resolve("dist-cli/lib/audio-intelligence/audition.js");
const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const pcmGuid = Buffer.from("0100000000001000800000aa00389b71", "hex");

function run(root: string, args: readonly string[], environment: Readonly<Record<string, string>> = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...environment, NO_COLOR: "1", FORCE_COLOR: "0" },
    timeout: 60_000,
  });
}

function wave(extensible: boolean) {
  const sampleRate = 48_000, channels = 2, bits = 24, frames = 48_000;
  const bytesPerSample = bits / 8, blockAlign = channels * bytesPerSample, dataBytes = frames * blockAlign;
  const formatBytes = extensible ? 40 : 16, dataOffset = 12 + 8 + formatBytes + 8;
  const result = Buffer.alloc(dataOffset + dataBytes);
  result.write("RIFF", 0, "ascii"); result.writeUInt32LE(result.length - 8, 4); result.write("WAVEfmt ", 8, "ascii");
  result.writeUInt32LE(formatBytes, 16); result.writeUInt16LE(extensible ? 0xfffe : 1, 20);
  result.writeUInt16LE(channels, 22); result.writeUInt32LE(sampleRate, 24); result.writeUInt32LE(sampleRate * blockAlign, 28);
  result.writeUInt16LE(blockAlign, 32); result.writeUInt16LE(bits, 34);
  if (extensible) {
    result.writeUInt16LE(22, 36); result.writeUInt16LE(bits, 38); result.writeUInt32LE(3, 40); pcmGuid.copy(result, 44);
  }
  const chunkOffset = 12 + 8 + formatBytes;
  result.write("data", chunkOffset, "ascii"); result.writeUInt32LE(dataBytes, chunkOffset + 4);
  for (let frame = 0; frame < frames; frame += 1) {
    const active = (frame < 9_600 || (frame >= 19_200 && frame < 28_800));
    const left = active ? Math.round(Math.sin(frame / 17) * 3_000_000) : 0;
    const right = active ? Math.round(Math.cos(frame / 23) * 1_000_000) : 0;
    result.writeIntLE(left, dataOffset + frame * blockAlign, 3);
    result.writeIntLE(right, dataOffset + frame * blockAlign + bytesPerSample, 3);
  }
  return result;
}

function transcript(source: Buffer, overrides: Record<string, unknown> = {}) {
  const base = {
    format: "cut-transcript",
    version: 1,
    media: {
      sha256: sha256(source),
      audioStreamIndex: 0,
      audioSampleRate: 48_000,
      duration: { numerator: "1", denominator: "1" },
    },
    words: [
      { id: "w1", start: { numerator: "0", denominator: "1" }, end: { numerator: "1", denominator: "5" }, text: "Hello,", join: "none", speaker: "narrator" },
      { id: "w2", start: { numerator: "2", denominator: "5" }, end: { numerator: "3", denominator: "5" }, text: "world.", join: "space", speaker: "narrator" },
    ],
  };
  return { ...base, ...overrides };
}

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "cut-dialogue-prosody-cli-"));
  const classic = wave(false), extensible = wave(true);
  await Promise.all([
    writeFile(resolve(root, "voice.wav"), classic, { flag: "wx" }),
    writeFile(resolve(root, "voice-extensible.wav"), extensible, { flag: "wx" }),
    writeFile(resolve(root, "voice.transcript.json"), `${JSON.stringify(transcript(classic))}\n`, { flag: "wx" }),
    writeFile(resolve(root, "voice-extensible.transcript.json"), `${JSON.stringify(transcript(extensible))}\n`, { flag: "wx" }),
  ]);
  return { root, classic, extensible };
}

test("installed-form audio prosody authenticates WAVE and transcript, preserves native time, and publishes canonical create-only analysis", async () => {
  const value = await fixture();
  try {
    const first = run(value.root, ["audio", "prosody", "voice.wav", "--transcript", "voice.transcript.json", "--out", "first.prosody.json", "--json"]);
    const second = run(value.root, ["audio", "prosody", "voice.wav", "--transcript", "voice.transcript.json", "--out", "second.prosody.json", "--json"]);
    assert.equal(first.status, 0, first.stdout + first.stderr); assert.equal(second.status, 0, second.stdout + second.stderr);
    const firstReport = JSON.parse(first.stdout), secondReport = JSON.parse(second.stdout);
    assert.equal(firstReport.format, "cut-audio-prosody-result"); assert.equal(firstReport.status, "pass");
    assert.equal(firstReport.source.sha256, sha256(value.classic));
    assert.equal(firstReport.normalization.contract, "authenticated-native-rate-equal-weight-mono-f32-v1");
    assert.equal(firstReport.normalization.sampleRate, 48_000); assert.equal(firstReport.normalization.sourceChannels, 2);
    assert.equal(firstReport.normalization.durationSamples, 48_000); assert.equal(firstReport.measured.words, 2);
    assert.equal(firstReport.output.analysisSha256, secondReport.output.analysisSha256);
    assert.equal(firstReport.output.fileSha256, secondReport.output.fileSha256);
    assert.equal(first.stdout.includes(value.root), false); assert.equal(first.stdout.includes(tmpdir()), false);
    const firstBytes = await readFile(resolve(value.root, "first.prosody.json"));
    const secondBytes = await readFile(resolve(value.root, "second.prosody.json"));
    assert.deepEqual(firstBytes, secondBytes); assert.equal(sha256(firstBytes), firstReport.output.fileSha256);
    const analysis = JSON.parse(firstBytes.toString("utf8"));
    assert.equal(analysis.format, "cut-dialogue-prosody-analysis"); assert.equal(analysis.version, 1);
    assert.equal(analysis.authority.mediaSha256, sha256(value.classic));
    assert.equal(analysis.authority.sampleRate, 48_000); assert.equal(analysis.authority.channels, 1);
    assert.equal(analysis.authority.normalizedPcmSha256, firstReport.normalization.normalizedPcmSha256);
    assert.equal(analysis.pauses.length, 1); assert.equal(analysis.phrases.length, 2);
    assert.equal(analysis.interpretation, "measured-timing-plus-authored-policy-not-emotion-or-performance-approval");

    const occupied = run(value.root, ["audio", "prosody", "voice.wav", "--transcript", "voice.transcript.json", "--out", "first.prosody.json", "--json"]);
    assert.equal(occupied.status, 1); assert.equal(JSON.parse(occupied.stdout).diagnostics[0]?.code, "CUT_DIALOGUE_PROSODY_OUTPUT_EXISTS");
    assert.deepEqual(await readFile(resolve(value.root, "first.prosody.json")), firstBytes);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("classic and extensible inputs produce the same normalized PCM and measured prosody", async () => {
  const value = await fixture();
  try {
    const classic = run(value.root, ["audio", "prosody", "voice.wav", "--transcript", "voice.transcript.json", "--out", "classic.json", "--json"]);
    const extensible = run(value.root, ["audio", "prosody", "voice-extensible.wav", "--transcript", "voice-extensible.transcript.json", "--out", "extensible.json", "--json"]);
    assert.equal(classic.status, 0, classic.stdout + classic.stderr); assert.equal(extensible.status, 0, extensible.stdout + extensible.stderr);
    const classicReport = JSON.parse(classic.stdout), extensibleReport = JSON.parse(extensible.stdout);
    assert.equal(classicReport.normalization.normalizedPcmSha256, extensibleReport.normalization.normalizedPcmSha256);
    assert.equal(classicReport.normalization.formatVariant, "classic-pcm"); assert.equal(extensibleReport.normalization.formatVariant, "extensible-pcm");
    const classicAnalysis = JSON.parse(await readFile(resolve(value.root, "classic.json"), "utf8"));
    const extensibleAnalysis = JSON.parse(await readFile(resolve(value.root, "extensible.json"), "utf8"));
    assert.deepEqual(classicAnalysis.speakingRate, extensibleAnalysis.speakingRate);
    assert.deepEqual(classicAnalysis.pauses, extensibleAnalysis.pauses);
    assert.deepEqual(classicAnalysis.phrases, extensibleAnalysis.phrases);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("audio prosody rejects media, stream, clock, WAVE, and option drift before publication", async () => {
  const value = await fixture();
  try {
    const mutations = [
      { name: "media", value: transcript(value.classic, { media: { ...transcript(value.classic).media, sha256: "0".repeat(64) } }), code: "CUT_DIALOGUE_PROSODY_MEDIA_AUTHORITY" },
      { name: "stream", value: transcript(value.classic, { media: { ...transcript(value.classic).media, audioStreamIndex: 1 } }), code: "CUT_DIALOGUE_PROSODY_MEDIA_AUTHORITY" },
      { name: "rate", value: transcript(value.classic, { media: { ...transcript(value.classic).media, audioSampleRate: 44_100 } }), code: "CUT_DIALOGUE_PROSODY_CLOCK" },
      { name: "duration", value: transcript(value.classic, { media: { ...transcript(value.classic).media, duration: { numerator: "2", denominator: "1" } } }), code: "CUT_DIALOGUE_PROSODY_CLOCK" },
    ];
    for (const mutation of mutations) {
      const locator = `${mutation.name}.transcript.json`, output = `${mutation.name}.json`;
      await writeFile(resolve(value.root, locator), `${JSON.stringify(mutation.value)}\n`, { flag: "wx" });
      const result = run(value.root, ["audio", "prosody", "voice.wav", "--transcript", locator, "--out", output, "--json"]);
      assert.equal(result.status, 1, `${mutation.name}: ${result.stdout}${result.stderr}`);
      assert.equal(JSON.parse(result.stdout).diagnostics[0]?.code, mutation.code, mutation.name);
      assert.equal(result.stdout.includes(value.root), false, mutation.name);
      await assert.rejects(readFile(resolve(value.root, output)), { code: "ENOENT" });
    }
    const malformed = Buffer.from(value.classic); malformed.writeUInt16LE(3, 20);
    await writeFile(resolve(value.root, "float.wav"), malformed, { flag: "wx" });
    await writeFile(resolve(value.root, "float.transcript.json"), `${JSON.stringify(transcript(malformed))}\n`, { flag: "wx" });
    const invalidWave = run(value.root, ["audio", "prosody", "float.wav", "--transcript", "float.transcript.json", "--out", "float.json", "--json"]);
    assert.equal(invalidWave.status, 1); assert.equal(JSON.parse(invalidWave.stdout).diagnostics[0]?.code, "CUT_WAVE_NORMALIZE_FORMAT");

    const unknown = run(value.root, ["audio", "prosody", "voice.wav", "--transcript", "voice.transcript.json", "--out", "unknown.json", "--remote", "--json"]);
    assert.equal(unknown.status, 1); assert.equal(JSON.parse(unknown.stdout).diagnostics[0]?.code, "CUTC1001");
    assert.equal(unknown.stdout.includes("voice.wav"), false, "closed grammar must reject before input I/O");
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("audio prosody rechecks both inputs and cancellation rolls back publication without residue", async () => {
  const value = await fixture();
  try {
    const mutatePreload = resolve(value.root, "mutate-prosody-input.cjs");
    await writeFile(mutatePreload, `
const { appendFileSync } = require("node:fs");
const audio = require(${JSON.stringify(auditionModule)});
const original = audio.loadCutAudioAuditionProjectFile;
let targetReads = 0;
audio.loadCutAudioAuditionProjectFile = async (...args) => {
  const retained = await original(...args);
  if (args[1] === process.env.CUT_TEST_MUTATE_LOCATOR && ++targetReads === 1) appendFileSync(process.env.CUT_TEST_MUTATE_PATH, "mutation");
  return retained;
};
`, { flag: "wx" });
    const changed = run(value.root, ["audio", "prosody", "voice.wav", "--transcript", "voice.transcript.json", "--out", "changed.json", "--json"], {
      NODE_OPTIONS: `--require=${mutatePreload}`,
      CUT_TEST_MUTATE_LOCATOR: "voice.wav",
      CUT_TEST_MUTATE_PATH: resolve(value.root, "voice.wav"),
    });
    assert.equal(changed.status, 1, changed.stdout + changed.stderr);
    assert.equal(JSON.parse(changed.stdout).diagnostics[0]?.code, "CUT_DIALOGUE_PROSODY_INPUT_CHANGED");
    await assert.rejects(readFile(resolve(value.root, "changed.json")), { code: "ENOENT" });

    await writeFile(resolve(value.root, "voice.wav"), value.classic);
    const changedTranscript = run(value.root, ["audio", "prosody", "voice.wav", "--transcript", "voice.transcript.json", "--out", "changed-transcript.json", "--json"], {
      NODE_OPTIONS: `--require=${mutatePreload}`,
      CUT_TEST_MUTATE_LOCATOR: "voice.transcript.json",
      CUT_TEST_MUTATE_PATH: resolve(value.root, "voice.transcript.json"),
    });
    assert.equal(changedTranscript.status, 1, changedTranscript.stdout + changedTranscript.stderr);
    assert.equal(JSON.parse(changedTranscript.stdout).diagnostics[0]?.code, "CUT_DIALOGUE_PROSODY_INPUT_CHANGED");
    await assert.rejects(readFile(resolve(value.root, "changed-transcript.json")), { code: "ENOENT" });
    await writeFile(resolve(value.root, "voice.transcript.json"), `${JSON.stringify(transcript(value.classic))}\n`);

    const cancelPreload = resolve(value.root, "cancel-prosody.cjs");
    await writeFile(cancelPreload, `
const boundary = require(${JSON.stringify(writeBoundaryModule)});
const original = boundary.writeProjectArtifacts;
let injected = false;
boundary.writeProjectArtifacts = async (roots, artifacts, verifier) => original(roots, artifacts, async phase => {
  if (!injected && phase === "before-finalize" && artifacts.some(artifact => artifact.role === "dialogue-prosody-analysis")) {
    injected = true;
    process.emit("SIGTERM");
  }
  if (verifier) await verifier(phase);
});
`, { flag: "wx" });
    const cancelled = run(value.root, ["audio", "prosody", "voice.wav", "--transcript", "voice.transcript.json", "--out", "cancelled.json", "--json"], {
      NODE_OPTIONS: `--require=${cancelPreload}`,
    });
    assert.equal(cancelled.status, 1, cancelled.stdout + cancelled.stderr);
    assert.equal(JSON.parse(cancelled.stdout).diagnostics[0]?.code, "CUT_DIALOGUE_PROSODY_CANCELLED");
    await assert.rejects(readFile(resolve(value.root, "cancelled.json")), { code: "ENOENT" });
    assert.equal((await readdir(value.root)).some((entry) => entry.includes(".cut-") && entry.endsWith(".tmp")), false);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("audio prosody rejects a symlinked output parent without leaking physical project paths", async () => {
  const value = await fixture();
  try {
    await mkdir(resolve(value.root, "real-output"));
    await symlink("real-output", resolve(value.root, "linked-output"), "dir");
    const result = run(value.root, [
      "audio", "prosody", "voice.wav",
      "--transcript", "voice.transcript.json",
      "--out", "linked-output/prosody.json",
      "--json",
    ]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.diagnostics[0]?.code, "CUT_DIALOGUE_PROSODY_PUBLICATION_PREFLIGHT");
    assert.equal(
      report.diagnostics[0]?.message,
      "Dialogue prosody could not safely prepare create-only output \"linked-output/prosody.json\"; no output was published.",
    );
    assert.equal(Object.hasOwn(report.diagnostics[0], "source"), false);
    assert.equal(result.stdout.includes(value.root), false);
    assert.equal(result.stderr.includes(value.root), false);
    await assert.rejects(readFile(resolve(value.root, "real-output", "prosody.json")), { code: "ENOENT" });
    assert.equal((await readdir(resolve(value.root, "real-output"))).some((entry) => entry.includes(".cut-") && entry.endsWith(".tmp")), false);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});
