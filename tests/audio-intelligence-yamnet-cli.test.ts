import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const cli = resolve("dist-cli/cli/cut.js");
const writeBoundaryModule = resolve("dist-cli/lib/project/write-boundary.js");
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

function run(root: string, args: readonly string[], environment: Readonly<Record<string, string>> = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...environment, NO_COLOR: "1", FORCE_COLOR: "0" },
    timeout: 60_000,
  });
}

function fakePython(platform: "darwin" | "linux", machine: "arm64" | "x86_64", mutateSourcePath?: string) {
  return `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2), get = flag => args[args.indexOf(flag) + 1];
if (get("--mode") === "doctor") {
  process.stdout.write(JSON.stringify({
    format: "cut-yamnet-local-adapter-result",
    version: 1,
    runtime: { implementation: "CPython", pythonVersion: "3.12.8", platform: ${JSON.stringify(platform)}, machine: ${JSON.stringify(machine)}, liteRtVersion: get("--litert-version") },
    model: { bytes: Number(get("--model-bytes")), sha256: get("--model-sha256") },
    classMap: { bytes: Number(get("--class-map-bytes")), sha256: get("--class-map-sha256"), classCount: 521 },
    policy: { sampleRate: 16000, patchSamples: 15600, patchHopSamples: 7680, rightPadFinalPatch: true, classCount: 521, interpreterThreads: 1 },
  }) + "\\n");
} else {
  const chunks = [];
  process.stdin.on("data", chunk => chunks.push(chunk));
  process.stdin.on("end", () => {
    const samples = Buffer.concat(chunks).length / 4;
    const patches = samples <= 15600 ? 1 : 1 + Math.ceil((samples - 15600) / 7680);
    const scores = Buffer.alloc(patches * 521 * 4);
    for (let patch = 0; patch < patches; patch += 1) {
      for (let index = 0; index < 521; index += 1) {
        const score = index === 0 ? 0.9 : index === 132 ? 0.35 : index === 271 ? 0.45 : 0.001;
        scores.writeFloatLE(score, (patch * 521 + index) * 4);
      }
    }
    ${mutateSourcePath ? `appendFileSync(${JSON.stringify(mutateSourcePath)}, "mutation");` : ""}
    process.stdout.write(scores);
  });
}
`;
}

function classicWave(sampleCount = 1_600) {
  const channels = 1, sampleRate = 16_000, bitsPerSample = 16;
  const data = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    data.writeInt16LE(index < 800 ? 0 : 8_192, index * 2);
  }
  const wave = Buffer.alloc(44 + data.byteLength);
  wave.write("RIFF", 0, "ascii");
  wave.writeUInt32LE(wave.byteLength - 8, 4);
  wave.write("WAVEfmt ", 8, "ascii");
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(channels, 22);
  wave.writeUInt32LE(sampleRate, 24);
  wave.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 28);
  wave.writeUInt16LE(channels * bitsPerSample / 8, 32);
  wave.writeUInt16LE(bitsPerSample, 34);
  wave.write("data", 36, "ascii");
  wave.writeUInt32LE(data.byteLength, 40);
  data.copy(wave, 44);
  return wave;
}

type Fixture = Readonly<{ root: string; recipe: Record<string, unknown> }>;

async function fixture(mutateSource = false): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "cut-yamnet-cli-"));
  const pythonPath = resolve(root, "fake-python");
  const environmentRoot = resolve(root, "site-packages");
  const liteRtRoot = resolve(environmentRoot, "ai_edge_litert");
  const liteRtMetadata = resolve(environmentRoot, "ai_edge_litert-2.1.6.dist-info");
  const numpyRoot = resolve(environmentRoot, "numpy");
  const modelPath = resolve(root, "yamnet.tflite");
  const sourcePath = resolve(root, "source.wav");
  await Promise.all([
    mkdir(liteRtRoot, { recursive: true, mode: 0o700 }),
    mkdir(liteRtMetadata, { recursive: true, mode: 0o700 }),
    mkdir(numpyRoot, { recursive: true, mode: 0o700 }),
  ]);
  await Promise.all([
    writeFile(resolve(liteRtRoot, "__init__.py"), "# fixture LiteRT\n", { flag: "wx" }),
    writeFile(resolve(liteRtMetadata, "METADATA"), "Name: ai-edge-litert\nVersion: 2.1.6\n", { flag: "wx" }),
    writeFile(resolve(numpyRoot, "__init__.py"), "# fixture NumPy\n", { flag: "wx" }),
    writeFile(modelPath, "fixture YAMNet model bytes\n", { flag: "wx" }),
  ]);
  const platform = process.platform === "linux" ? "linux" : "darwin";
  const machine = process.arch === "x64" ? "x86_64" : "arm64";
  await writeFile(pythonPath, fakePython(platform, machine, mutateSource ? sourcePath : undefined), { flag: "wx", mode: 0o700 });
  await chmod(pythonPath, 0o700);
  const recipe = {
    python: { path: pythonPath, pythonVersion: "3.12.8", platform, machine },
    environment: {
      sitePackagesRoot: environmentRoot,
      roots: ["ai_edge_litert", "ai_edge_litert-2.1.6.dist-info", "numpy"],
      revision: "fixture-environment-v1",
    },
    liteRt: {
      roots: ["ai_edge_litert", "ai_edge_litert-2.1.6.dist-info"],
      packageVersion: "2.1.6",
      declaredLicense: "Apache-2.0",
    },
    model: {
      path: modelPath,
      name: "YAMNet TFLite",
      revision: "fixture-model-v1",
      declaredLicense: "Apache-2.0",
      declaredProvenance: "caller-declared local fixture provenance",
    },
  };
  await Promise.all([
    writeFile(resolve(root, "yamnet.recipe.json"), `${JSON.stringify(recipe, null, 2)}\n`, { flag: "wx" }),
    writeFile(sourcePath, classicWave(), { flag: "wx" }),
  ]);
  return Object.freeze({ root, recipe: Object.freeze(recipe) });
}

async function publicationSignalPreload(root: string) {
  const preload = resolve(root, "signal-during-yamnet-publication.cjs");
  await writeFile(preload, `
const boundary = require(${JSON.stringify(writeBoundaryModule)});
const original = boundary.writeProjectArtifacts;
let injected = false;
boundary.writeProjectArtifacts = async (roots, artifacts, verifier) => original(roots, artifacts, async phase => {
  if (!injected && phase === process.env.CUT_TEST_YAMNET_SIGNAL_PHASE
      && artifacts.some(artifact => artifact.role === process.env.CUT_TEST_YAMNET_SIGNAL_ROLE)) {
    injected = true;
    process.emit("SIGTERM");
  }
  if (verifier) await verifier(phase);
});
`, { flag: "wx" });
  return preload;
}

test("repository-dist YAMNet setup, doctor, and semantic analysis are exact, repeatable, and create-only", async () => {
  const value = await fixture();
  try {
    const setup = run(value.root, ["audio", "analyze-setup", "yamnet.recipe.json", "--out", "yamnet.setup.json", "--json"]);
    assert.equal(setup.status, 0, setup.stderr || setup.stdout);
    const setupReport = JSON.parse(setup.stdout);
    assert.equal(setupReport.format, "cut-audio-analyze-setup-result");
    assert.equal(setupReport.doctor.status, "PASS");
    assert.equal(setupReport.limitations.rights, "caller-declared-not-verified");
    assert.equal(Object.hasOwn(setupReport, "path"), false);
    assert.equal(setup.stdout.includes(value.root), false);

    const doctor = run(value.root, ["audio", "analyze-doctor", "--setup", "yamnet.setup.json", "--json"]);
    assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
    const doctorReport = JSON.parse(doctor.stdout);
    assert.equal(doctorReport.format, "cut-yamnet-local-doctor");
    assert.equal(doctorReport.status, "PASS");
    assert.equal(doctorReport.policy.interpreterThreads, 1);
    assert.equal(doctor.stdout.includes(value.root), false);

    const first = run(value.root, ["audio", "analyze", "source.wav", "--setup", "yamnet.setup.json", "--out", "first.analysis.json", "--top", "3", "--json"]);
    const second = run(value.root, ["audio", "analyze", "source.wav", "--setup", "yamnet.setup.json", "--out", "second.analysis.json", "--top", "3", "--json"]);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const firstReport = JSON.parse(first.stdout), secondReport = JSON.parse(second.stdout);
    assert.equal(firstReport.format, "cut-audio-analyze-result");
    assert.equal(firstReport.provider.topK, 3);
    assert.equal(firstReport.setup.locator, "yamnet.setup.json");
    assert.equal(firstReport.limitations.emotion, "no-emotion-inference-claim");
    assert.equal(firstReport.limitations.legal, "no-license-provenance-or-rights-claim");
    assert.equal(firstReport.output.analysisSha256, secondReport.output.analysisSha256);
    assert.equal(firstReport.output.fileSha256, secondReport.output.fileSha256);
    assert.equal(first.stdout.includes(value.root), false);
    const [firstBytes, secondBytes] = await Promise.all([
      readFile(resolve(value.root, "first.analysis.json")),
      readFile(resolve(value.root, "second.analysis.json")),
    ]);
    assert.deepEqual(firstBytes, secondBytes);
    assert.equal(hash(firstBytes), firstReport.output.fileSha256);
    const analysis = JSON.parse(firstBytes.toString("utf8"));
    assert.equal(analysis.format, "cut-audio-semantic-analysis");
    assert.equal(analysis.normalization.output.samples, 1_600);
    assert.equal(analysis.provider.aggregateTopClasses[0].label, "Speech");
    assert.equal(analysis.taxonomy.aggregate.roleSuggestions.find((entry: { id: string }) => entry.id === "speech").scorePpm, 900_000);

    const before = Buffer.from(firstBytes);
    const noClobber = run(value.root, ["audio", "analyze", "source.wav", "--setup", "yamnet.setup.json", "--out", "first.analysis.json", "--json"]);
    assert.equal(noClobber.status, 1);
    assert.equal(JSON.parse(noClobber.stdout).diagnostics[0]?.code, "CUT_AUDIO_ANALYSIS_OUTPUT_EXISTS");
    assert.equal(JSON.parse(noClobber.stdout).diagnostics[0]?.message.includes("first.analysis.json"), true);
    assert.equal(noClobber.stdout.includes(value.root), false);
    assert.deepEqual(await readFile(resolve(value.root, "first.analysis.json")), before);

    const setupNoClobber = run(value.root, ["audio", "analyze-setup", "yamnet.recipe.json", "--out", "yamnet.setup.json", "--json"]);
    assert.equal(setupNoClobber.status, 1);
    assert.equal(JSON.parse(setupNoClobber.stdout).diagnostics[0]?.code, "CUT_AUDIO_ANALYSIS_OUTPUT_EXISTS");
    assert.equal(JSON.parse(setupNoClobber.stdout).diagnostics[0]?.message.includes("yamnet.setup.json"), true);
    assert.equal(setupNoClobber.stdout.includes(value.root), false);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("YAMNet setup and analysis cancellation inside publication rolls back output and temporary files", async () => {
  const value = await fixture();
  try {
    const preload = await publicationSignalPreload(value.root);
    const injectedEnvironment = (phase: "before-promotion" | "before-finalize", role: string) => ({
      NODE_OPTIONS: `--require=${preload}`,
      CUT_TEST_YAMNET_SIGNAL_PHASE: phase,
      CUT_TEST_YAMNET_SIGNAL_ROLE: role,
    });

    const cancelledSetup = run(value.root, ["audio", "analyze-setup", "yamnet.recipe.json", "--out", "cancelled.setup.json", "--json"],
      injectedEnvironment("before-promotion", "yamnet-local-setup"));
    assert.equal(cancelledSetup.status, 1, cancelledSetup.stderr || cancelledSetup.stdout);
    assert.equal(JSON.parse(cancelledSetup.stdout).diagnostics[0]?.code, "CUT_YAMNET_CANCELLED");
    await assert.rejects(() => readFile(resolve(value.root, "cancelled.setup.json")), { code: "ENOENT" });
    assert.equal((await readdir(value.root)).some((entry) => entry.includes(".cut-") && entry.endsWith(".tmp")), false);

    const setup = run(value.root, ["audio", "analyze-setup", "yamnet.recipe.json", "--out", "yamnet.setup.json", "--json"]);
    assert.equal(setup.status, 0, setup.stderr || setup.stdout);
    const cancelledAnalysis = run(value.root, ["audio", "analyze", "source.wav", "--setup", "yamnet.setup.json", "--out", "cancelled.analysis.json", "--json"],
      injectedEnvironment("before-finalize", "yamnet-semantic-analysis"));
    assert.equal(cancelledAnalysis.status, 1, cancelledAnalysis.stderr || cancelledAnalysis.stdout);
    assert.equal(JSON.parse(cancelledAnalysis.stdout).diagnostics[0]?.code, "CUT_YAMNET_CANCELLED");
    await assert.rejects(() => readFile(resolve(value.root, "cancelled.analysis.json")), { code: "ENOENT" });
    assert.equal((await readdir(value.root)).some((entry) => entry.includes(".cut-") && entry.endsWith(".tmp")), false);
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("YAMNet CLI rejects duplicate JSON, unknown options, and noncanonical top values before provider work", async () => {
  const value = await fixture();
  try {
    await writeFile(resolve(value.root, "duplicate.recipe.json"), '{"python":{},"python":{"path":"/forged"}}\n', { flag: "wx" });
    const duplicateRecipe = run(value.root, ["audio", "analyze-setup", "duplicate.recipe.json", "--out", "missing.setup.json", "--json"]);
    assert.equal(duplicateRecipe.status, 1);
    assert.ok(JSON.parse(duplicateRecipe.stdout).diagnostics.some((entry: { code: string }) => entry.code === "CUT_PACKAGE_JSON_DUPLICATE_KEY"));

    await writeFile(resolve(value.root, "duplicate.setup.json"), '{"python":{},"python":{}}\n', { flag: "wx" });
    const duplicateSetup = run(value.root, ["audio", "analyze-doctor", "--setup", "duplicate.setup.json", "--json"]);
    assert.equal(duplicateSetup.status, 1);
    assert.ok(JSON.parse(duplicateSetup.stdout).diagnostics.some((entry: { code: string }) => entry.code === "CUT_PACKAGE_JSON_DUPLICATE_KEY"));

    for (const args of [
      ["audio", "analyze-setup", "yamnet.recipe.json", "--out", "setup.json", "--download", "--json"],
      ["audio", "analyze-doctor", "--setup", "setup.json", "--remote", "--json"],
      ["audio", "analyze", "source.wav", "--setup", "setup.json", "--out", "analysis.json", "--remote", "--json"],
    ]) {
      const result = run(value.root, args);
      assert.equal(result.status, 1);
      assert.equal(JSON.parse(result.stdout).diagnostics[0]?.code, "CUTC1001");
    }

    for (const top of ["0", "01", "21", "1.5"]) {
      const result = run(value.root, ["audio", "analyze", "source.wav", "--setup", "missing.setup.json", "--out", "analysis.json", "--top", top, "--json"]);
      assert.equal(result.status, 1);
      assert.equal(JSON.parse(result.stdout).diagnostics[0]?.code, "CUTC1007");
    }
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});

test("YAMNet CLI refuses publication when the authenticated source changes during provider execution", async () => {
  const value = await fixture(true);
  try {
    const setup = run(value.root, ["audio", "analyze-setup", "yamnet.recipe.json", "--out", "yamnet.setup.json", "--json"]);
    assert.equal(setup.status, 0, setup.stderr || setup.stdout);
    const result = run(value.root, ["audio", "analyze", "source.wav", "--setup", "yamnet.setup.json", "--out", "analysis.json", "--json"]);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).diagnostics[0]?.code, "CUT_AUDIO_ANALYSIS_INPUT_CHANGED");
    await assert.rejects(() => readFile(resolve(value.root, "analysis.json")), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT"));
  } finally {
    await rm(value.root, { recursive: true, force: true });
  }
});
