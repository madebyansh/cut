import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  arrangeCutAudio,
  cutAudioArrangementInputSha256,
  prepareAuthenticatedProjectAudioArrangement,
  type CutAudioArrangementInputBody,
} from "../lib/audio-intelligence";
import { cutAudioBriefSha256, type CutAudioBriefBody } from "../lib/audio-intelligence/brief";
import { stableJsonStringify } from "../lib/core/stable";
import { checkCutModule } from "../lib/language/checker";
import { parseCutLanguage } from "../lib/language/parser";
import { writeProjectArtifacts } from "../lib/project/write-boundary";

const cli = resolve("dist-cli/cli/cut.js");
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

function wave(sampleRate: number, frames: number, channels = 1) {
  const dataBytes = frames * channels * 2, bytes = Buffer.alloc(44 + dataBytes);
  bytes.write("RIFF", 0, "ascii"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii"); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(channels, 22); bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * channels * 2, 28); bytes.writeUInt16LE(channels * 2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii"); bytes.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < frames * channels; index += 1) bytes.writeInt16LE((index % 17) - 8, 44 + index * 2);
  return bytes;
}

function arrangementInput(assetSha256: string, declaredSampleRate = 8_000, sourceEnd = 8_000) {
  const briefBody: CutAudioBriefBody = {
    format: "cut-audio-brief",
    version: 1,
    sampleRate: declaredSampleRate,
    durationSamples: 8_000,
    sourceScriptSha256: "1".repeat(64),
    acts: [{
      id: "opening",
      range: { startSample: 0, endSample: 8_000 },
      narrativeTurn: "hook",
      desiredRoles: ["silence"],
      moods: ["clear"],
      energyPpm: 300_000,
      densityPpm: 200_000,
      dialogueSpacePpm: 900_000,
      intent: "Keep the spoken line clear and leave one intentional breath.",
    }],
    events: [],
    intentionalSilences: [{
      range: { startSample: 4_000, endSample: 4_800 },
      purpose: "Hold one deliberate breath in supporting sound.",
    }],
  };
  const brief = { ...briefBody, briefSha256: cutAudioBriefSha256(briefBody) };
  const body: CutAudioArrangementInputBody = {
    format: "cut-audio-arrangement-input",
    version: 1,
    profile: "documentary-podcast-arrangement-v1",
    brief,
    prosody: null,
    assets: [{
      id: "host-dialogue",
      role: "dialogue",
      locator: "assets/host-dialogue.wav",
      lockedResourceSha256: assetSha256,
      sampleRate: declaredSampleRate,
      sourceRange: { startSample: 0, endSample: sourceEnd },
      assignment: { kind: "program-dialogue" },
      perspective: {
        distance: "near", gainDbMilli: 0, panPpm: 0, eqFrequencyHz: 3_000,
        eqGainDbMilli: 0, eqQMilli: 1_000, reverbWetPpm: 0,
      },
    }],
  };
  return { ...body, inputSha256: cutAudioArrangementInputSha256(body) };
}

async function fixture(options: Readonly<{
  waveSampleRate?: number;
  waveFrames?: number;
  declaredSampleRate?: number;
  sourceEnd?: number;
  lockedSha256?: string;
  invalidWave?: boolean;
}> = {}) {
  const root = await mkdtemp(join(tmpdir(), "cut-audio-arrange-cli-"));
  await mkdir(join(root, "assets"), { recursive: true });
  const wav = options.invalidWave
    ? Buffer.from("not-an-integer-pcm-wave", "utf8")
    : wave(options.waveSampleRate ?? 8_000, options.waveFrames ?? 8_000);
  const assetPath = join(root, "assets/host-dialogue.wav"), inputPath = join(root, "arrangement-input.json");
  await writeFile(assetPath, wav);
  const input = arrangementInput(
    options.lockedSha256 ?? hash(wav),
    options.declaredSampleRate ?? 8_000,
    options.sourceEnd ?? 8_000,
  );
  const inputBytes = Buffer.from(`${JSON.stringify(input)}\n`, "utf8");
  await writeFile(inputPath, inputBytes);
  return { root, assetPath, inputPath, inputBytes, input };
}

function run(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });
}

const command = [
  "audio", "arrange", "arrangement-input.json",
  "--out", "arrangement.cut",
  "--manifest", "review/arrangement.manifest.json",
  "--json",
] as const;

test("audio arrange deterministically publishes exact kernel source and manifest that parse and check", async () => {
  const firstFixture = await fixture(), secondFixture = await fixture();
  try {
    const first = run(firstFixture.root, ...command), second = run(secondFixture.root, ...command);
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
    assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
    const firstReport = JSON.parse(first.stdout), secondReport = JSON.parse(second.stdout);
    const firstSource = await readFile(join(firstFixture.root, "arrangement.cut"));
    const secondSource = await readFile(join(secondFixture.root, "arrangement.cut"));
    const firstManifest = await readFile(join(firstFixture.root, "review/arrangement.manifest.json"));
    const secondManifest = await readFile(join(secondFixture.root, "review/arrangement.manifest.json"));
    assert.deepEqual(firstSource, secondSource);
    assert.deepEqual(firstManifest, secondManifest);
    const kernel = arrangeCutAudio(firstFixture.inputBytes);
    assert.deepEqual(firstSource, Buffer.from(kernel.source, "utf8"));
    assert.deepEqual(firstManifest, Buffer.from(`${stableJsonStringify(kernel.manifest)}\n`, "utf8"));
    assert.equal(firstReport.output.sha256, hash(firstSource));
    assert.equal(firstReport.manifest.fileSha256, hash(firstManifest));
    assert.equal(firstReport.manifest.manifestSha256, kernel.manifest.manifestSha256);
    assert.equal(firstReport.arrangementSha256, kernel.arrangementSha256);
    assert.equal(firstReport.assets.count, 1);
    assert.equal(firstReport.assets.channelSampleReads, 8_000);
    assert.deepEqual(firstReport, secondReport);
    const parsed = parseCutLanguage(firstSource.toString("utf8"));
    assert.ok(parsed.module, JSON.stringify(parsed.diagnostics));
    assert.deepEqual(parsed.diagnostics, []);
    assert.deepEqual(checkCutModule(parsed.module!).diagnostics, []);
  } finally {
    await Promise.all([firstFixture, secondFixture].map((value) => rm(value.root, { recursive: true, force: true })));
  }
});

test("audio arrange rejects nested CUT output before filesystem work and refuses create-only collisions", async () => {
  const value = await fixture();
  try {
    const nested = run(value.root, "audio", "arrange", "missing.json", "--out", "nested/arrangement.cut", "--manifest", "manifest.json", "--json");
    assert.equal(nested.status, 1);
    assert.match(nested.stdout, /root-level portable \.cut/u);
    await assert.rejects(readFile(join(value.root, "nested/arrangement.cut")), { code: "ENOENT" });
    const first = run(value.root, ...command);
    assert.equal(first.status, 0, first.stdout);
    const sourceBefore = await readFile(join(value.root, "arrangement.cut"));
    const manifestBefore = await readFile(join(value.root, "review/arrangement.manifest.json"));
    const second = run(value.root, ...command);
    assert.equal(second.status, 1);
    assert.match(second.stdout, /CUT_AUDIO_ARRANGEMENT_OUTPUT_EXISTS/u);
    assert.deepEqual(await readFile(join(value.root, "arrangement.cut")), sourceBefore);
    assert.deepEqual(await readFile(join(value.root, "review/arrangement.manifest.json")), manifestBefore);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("audio arrange fails closed on asset hash, sample-rate, and source-range drift without path leaks or residue", async () => {
  const cases = [
    { options: { lockedSha256: "f".repeat(64) }, code: "CUT_AUDIO_ARRANGEMENT_ASSET_AUTHORITY" },
    { options: { waveSampleRate: 16_000 }, code: "CUT_AUDIO_ARRANGEMENT_ASSET_CLOCK" },
    { options: { waveFrames: 4_000 }, code: "CUT_AUDIO_ARRANGEMENT_ASSET_RANGE" },
    { options: { invalidWave: true }, code: "CUT_AUDIO_ARRANGEMENT_ASSET_WAVE" },
  ] as const;
  for (const item of cases) {
    const value = await fixture(item.options);
    try {
      const result = run(value.root, ...command);
      assert.equal(result.status, 1, `${item.code} unexpectedly passed`);
      assert.match(result.stdout, new RegExp(item.code, "u"));
      assert.equal(result.stdout.includes(value.root), false);
      assert.equal(result.stderr.includes(value.root), false);
      await assert.rejects(readFile(join(value.root, "arrangement.cut")), { code: "ENOENT" });
      await assert.rejects(readFile(join(value.root, "review/arrangement.manifest.json")), { code: "ENOENT" });
    } finally { await rm(value.root, { recursive: true, force: true }); }
  }
});

test("audio arrange rejects a leaf-symlink asset without outputs, residue, or path disclosure", async () => {
  const value = await fixture();
  try {
    const actualPath = join(value.root, "assets/actual.wav");
    await rename(value.assetPath, actualPath);
    await symlink("actual.wav", value.assetPath);
    const result = run(value.root, ...command);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stdout, /CUT_AUDIO_AUDITION_FILE/u);
    assert.equal(result.stdout.includes(value.root), false);
    assert.equal(result.stderr.includes(value.root), false);
    await assert.rejects(readFile(join(value.root, "arrangement.cut")), { code: "ENOENT" });
    await assert.rejects(readFile(join(value.root, "review/arrangement.manifest.json")), { code: "ENOENT" });
    assert.deepEqual((await readdir(value.root)).filter((entry) => entry.includes(".cut-") || entry.endsWith(".tmp")), []);
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("arrangement verifier rolls back staged publication after input or asset mutation", async () => {
  for (const mutate of ["input", "asset"] as const) {
    const value = await fixture();
    try {
      const authenticated = await prepareAuthenticatedProjectAudioArrangement({
        projectRoot: value.root,
        inputLocator: "arrangement-input.json",
        testHooks: {
          afterInitialAsset: async () => writeFile(
            mutate === "input" ? value.inputPath : value.assetPath,
            mutate === "input" ? Buffer.concat([value.inputBytes, Buffer.from(" ")]) : Buffer.from("mutated-wave"),
          ),
        },
      });
      const sourcePath = join(value.root, "arrangement.cut"), manifestPath = join(value.root, "manifest.json");
      await assert.rejects(
        writeProjectArtifacts([value.root], [
          { destination: sourcePath, contents: authenticated.arrangement.source, expectedDestinationSnapshot: { state: "absent" } },
          { destination: manifestPath, contents: `${stableJsonStringify(authenticated.arrangement.manifest)}\n`, expectedDestinationSnapshot: { state: "absent" } },
        ], authenticated.verifyInputsUnchanged),
        new RegExp(mutate === "input" ? "CUT_AUDIO_ARRANGEMENT_INPUT_CHANGED" : "CUT_AUDIO_ARRANGEMENT_ASSET_CHANGED", "u"),
      );
      await assert.rejects(readFile(sourcePath), { code: "ENOENT" });
      await assert.rejects(readFile(manifestPath), { code: "ENOENT" });
      const residue = (await import("node:fs/promises")).readdir(value.root).then((entries) => entries.filter((entry) => entry.includes(".cut-") || entry.endsWith(".tmp")));
      assert.deepEqual(await residue, []);
    } finally { await rm(value.root, { recursive: true, force: true }); }
  }
});

test("arrangement authentication cancellation is fail-closed and writes nothing", async () => {
  const value = await fixture(), controller = new AbortController();
  try {
    await assert.rejects(
      prepareAuthenticatedProjectAudioArrangement({
        projectRoot: value.root,
        inputLocator: "arrangement-input.json",
        signal: controller.signal,
        testHooks: { afterInitialAsset: () => controller.abort() },
      }),
      /CUT_AUDIO_ARRANGEMENT_CANCELLED/u,
    );
    await assert.rejects(readFile(join(value.root, "arrangement.cut")), { code: "ENOENT" });
    await assert.rejects(readFile(join(value.root, "manifest.json")), { code: "ENOENT" });
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("public arrangement closes the asset-count limit before asset traversal", async () => {
  const value = await fixture();
  try {
    const { inputSha256: _ignored, ...base } = value.input;
    const body: CutAudioArrangementInputBody = {
      ...base,
      assets: Array.from({ length: 65 }, (_, index) => ({
        ...base.assets[0]!,
        id: `dialogue-${String(index + 1).padStart(2, "0")}`,
      })),
    };
    await writeFile(value.inputPath, `${JSON.stringify({ ...body, inputSha256: cutAudioArrangementInputSha256(body) })}\n`);
    await assert.rejects(
      prepareAuthenticatedProjectAudioArrangement({ projectRoot: value.root, inputLocator: "arrangement-input.json" }),
      /public arrangement accepts at most 64 bound assets/u,
    );
  } finally { await rm(value.root, { recursive: true, force: true }); }
});
