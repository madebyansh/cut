import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  cutKokoroMlxLocalRecipePolicy,
  isCutKokoroMlxLocalPlatformSupported,
  parseCutKokoroMlxLocalRecipe,
} from "../lib/audio-intelligence";

const cli = resolve("dist-cli/cli/cut.js");
const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

type FixtureMode = "valid" | "nonzero" | "mutate-script";

function fakePython(mode: FixtureMode, marker: string, script: string) {
  return `#!${process.execPath}
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const args = process.argv.slice(2), get = flag => args[args.indexOf(flag) + 1];
appendFileSync(${JSON.stringify(marker)}, "invoked\\n");
if (${JSON.stringify(mode)} === "nonzero") process.exit(19);
const request = JSON.parse(readFileSync(get("--request"), "utf8"));
const output = get("--output"), result = get("--result");
const samples = [100, -200, 300, -400], wav = Buffer.alloc(52);
wav.write("RIFF", 0, "ascii"); wav.writeUInt32LE(44, 4); wav.write("WAVE", 8, "ascii");
wav.write("fmt ", 12, "ascii"); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(request.synthesis.sampleRate, 24); wav.writeUInt32LE(request.synthesis.sampleRate * 2, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36, "ascii"); wav.writeUInt32LE(8, 40);
samples.forEach((sample, index) => wav.writeInt16LE(sample, 44 + index * 2));
writeFileSync(output, wav, { flag: "wx" });
const digest = value => createHash("sha256").update(value).digest("hex");
writeFileSync(result, JSON.stringify({
  format: "cut-kokoro-mlx-local-adapter-result", version: 2,
  runtime: { implementation: "CPython", pythonVersion: "3.12.8", platform: "darwin", machine: "arm64", componentSetSha256: request.runtime.componentSetSha256 },
  model: { configSha256: request.model.config.sha256, weightsSha256: request.model.weights.sha256 },
  voice: { name: request.voice.name, weightsSha256: request.voice.weights.sha256 },
  phonemizer: { librarySha256: request.phonemizer.library.sha256, dataTreeSha256: request.phonemizer.dataTreeSha256 },
  synthesis: { textSha256: digest(request.synthesis.text), language: request.synthesis.language, speedMicros: request.synthesis.speedMicros, seed: request.synthesis.seed, sampleRate: request.synthesis.sampleRate },
  output: { bytes: wav.length, sha256: digest(wav), durationSamples: 4 }
}) + "\\n", { flag: "wx" });
if (${JSON.stringify(mode)} === "mutate-script") appendFileSync(${JSON.stringify(script)}, " changed");
`;
}

async function fixture(mode: FixtureMode = "valid") {
  const root = await mkdtemp(join(tmpdir(), "cut-kokoro-cli-"));
  const script = join(root, "script.txt"), recipePath = join(root, "recipe.json");
  const python = join(root, "fake-python"), marker = join(root, "invocations.txt");
  const sitePackages = join(root, "site-packages"), model = join(root, "model"), voices = join(model, "voices");
  const espeakData = join(root, "espeak-data"), espeakLibrary = join(root, "libespeak-ng.dylib");
  const packageDefinitions = [
    ["kokoro-mlx", "0.1.2", "kokoro_mlx", "kokoro_mlx-0.1.2.dist-info", "MIT"],
    ["misaki", "0.9.4", "misaki", "misaki-0.9.4.dist-info", "Apache-2.0"],
    ["mlx", "0.32.0", "mlx", "mlx-0.32.0.dist-info", "MIT"],
    ["mlx-metal", "0.32.0", "mlx_metal", "mlx_metal-0.32.0.dist-info", "MIT"],
    ["numpy", "2.5.1", "numpy", "numpy-2.5.1.dist-info", "BSD-3-Clause"],
    ["safetensors", "0.8.0", "safetensors", "safetensors-0.8.0.dist-info", "Apache-2.0"],
  ] as const;
  await Promise.all([
    mkdir(voices, { recursive: true }), mkdir(espeakData, { recursive: true }),
    ...packageDefinitions.flatMap(([, , module, metadata]) => [
      mkdir(join(sitePackages, module), { recursive: true }),
      mkdir(join(sitePackages, metadata), { recursive: true }),
    ]),
  ]);
  await Promise.all([
    writeFile(script, "CUT listens before it edits."),
    writeFile(python, fakePython(mode, marker, script), { mode: 0o700 }),
    writeFile(join(model, "config.json"), "{}\n"),
    writeFile(join(model, "kokoro-v1_0.safetensors"), "model\n"),
    writeFile(join(voices, "af_heart.safetensors"), "voice\n"),
    writeFile(espeakLibrary, "espeak\n"), writeFile(join(espeakData, "phontab"), "data\n"),
    ...packageDefinitions.flatMap(([name, version, module, metadata]) => [
      writeFile(join(sitePackages, module, "__init__.py"), `__version__ = ${JSON.stringify(version)}\n`),
      writeFile(join(sitePackages, metadata, "METADATA"), `Name: ${name}\nVersion: ${version}\n`),
    ]),
  ]);
  await chmod(python, 0o700);
  const components = [
    {
      id: "kokoro-python-runtime",
      roots: packageDefinitions.filter(([name]) => !name.startsWith("mlx"))
        .flatMap(([, , module, metadata]) => [module, metadata]),
      packages: packageDefinitions.filter(([name]) => !name.startsWith("mlx"))
        .map(([name, packageVersion, , , license]) => ({ name, packageVersion, license })),
    },
    {
      id: "mlx-native-runtime",
      roots: packageDefinitions.filter(([name]) => name.startsWith("mlx"))
        .flatMap(([, , module, metadata]) => [module, metadata]),
      packages: packageDefinitions.filter(([name]) => name.startsWith("mlx"))
        .map(([name, packageVersion, , , license]) => ({ name, packageVersion, license })),
    },
  ];
  const recipe = {
    format: cutKokoroMlxLocalRecipePolicy.format,
    version: cutKokoroMlxLocalRecipePolicy.version,
    python: { path: python, pythonVersion: "3.12.8" },
    runtime: { sitePackagesRoot: sitePackages, components },
    model: {
      name: "Kokoro-82M-bf16", revision: "fixture-only", license: "Apache-2.0",
      configPath: join(model, "config.json"), weightsPath: join(model, "kokoro-v1_0.safetensors"),
    },
    voice: { name: "af_heart", license: "Apache-2.0", weightsPath: join(voices, "af_heart.safetensors") },
    phonemizer: { version: "1.52.0", libraryPath: espeakLibrary, dataRoot: espeakData },
  };
  await writeFile(recipePath, `${JSON.stringify(recipe)}\n`);
  return { root, script, recipePath, marker, recipe };
}

function run(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });
}

test("public Kokoro recipe is closed and excludes caller-selected adapter authority", () => {
  const value = {
    format: cutKokoroMlxLocalRecipePolicy.format, version: 1,
    python: { path: "/absolute/python", pythonVersion: "3.12.8" },
    runtime: { sitePackagesRoot: "/absolute/site-packages", components: [{ id: "runtime", roots: ["package"], packages: [{ name: "package", packageVersion: "1.0.0", license: "MIT" }] }] },
    model: { name: "model", revision: "revision", license: "Apache-2.0", configPath: "/absolute/config", weightsPath: "/absolute/weights" },
    voice: { name: "af_heart", license: "Apache-2.0", weightsPath: "/absolute/voice" },
    phonemizer: { version: "1.52.0", libraryPath: "/absolute/espeak", dataRoot: "/absolute/data" },
  };
  assert.deepEqual(parseCutKokoroMlxLocalRecipe(value), value);
  assert.throws(() => parseCutKokoroMlxLocalRecipe({ ...value, adapter: { path: "/tmp/foreign.py" } }), /must contain exactly/u);
  assert.throws(() => parseCutKokoroMlxLocalRecipe({ ...value, model: { ...value.model, configPath: "relative" } }), /canonical absolute/u);
});

test("public Kokoro recipe admits the bounded real-world root fanout and rejects one root beyond it", () => {
  const roots = Array.from(
    { length: cutKokoroMlxLocalRecipePolicy.maximumRuntimeRootsPerComponent },
    (_, index) => `package-${String(index + 1).padStart(3, "0")}`,
  );
  const value = {
    format: cutKokoroMlxLocalRecipePolicy.format, version: 1,
    python: { path: "/absolute/python", pythonVersion: "3.12.8" },
    runtime: {
      sitePackagesRoot: "/absolute/site-packages",
      components: [{ id: "runtime", roots, packages: [{ name: "package", packageVersion: "1.0.0", license: "MIT" }] }],
    },
    model: { name: "model", revision: "revision", license: "Apache-2.0", configPath: "/absolute/config", weightsPath: "/absolute/weights" },
    voice: { name: "af_heart", license: "Apache-2.0", weightsPath: "/absolute/voice" },
    phonemizer: { version: "1.52.0", libraryPath: "/absolute/espeak", dataRoot: "/absolute/data" },
  };
  assert.equal(parseCutKokoroMlxLocalRecipe(value).runtime.components[0]!.roots.length, roots.length);
  assert.throws(
    () => parseCutKokoroMlxLocalRecipe({
      ...value,
      runtime: {
        ...value.runtime,
        components: [{ ...value.runtime.components[0]!, roots: [...roots, "package-over-limit"] }],
      },
    }),
    new RegExp(`1 through ${cutKokoroMlxLocalRecipePolicy.maximumRuntimeRootsPerComponent} entries`, "u"),
  );
});

test("audio narrate option contract fails before filesystem or inference work", () => {
  const result = run(process.cwd(), "audio", "narrate", "missing.txt", "--recipe", "missing.json", "--out", "voice.wav", "--receipt", "receipt.json", "--speed", "1.250001", "--json");
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.command, "audio narrate");
  assert.equal(report.diagnostics[0].code, "CUTC1007");
});

test("audio narrate accepts one conventional file terminator but no paragraph whitespace or controls", async () => {
  const value = await fixture();
  try {
    for (const [index, ending] of ["\n", "\r\n"].entries()) {
      const rawScript = Buffer.from(`CUT listens before it edits.${ending}`, "utf8");
      await writeFile(value.script, rawScript);
      const result = run(
        value.root,
        "audio", "narrate", "script.txt", "--recipe", "recipe.json",
        "--out", `voice-${index}.wav`, "--receipt", `receipt-${index}.json`, "--json",
      );
      if (!isCutKokoroMlxLocalPlatformSupported()) {
        assert.equal(result.status, 1);
        assert.match(result.stdout, /CUT_KOKORO_MLX_PLATFORM/u);
        continue;
      }
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const report = JSON.parse(result.stdout);
      const receipt = JSON.parse(await readFile(join(value.root, `receipt-${index}.json`), "utf8"));
      assert.deepEqual(report.script, { locator: "script.txt", bytes: rawScript.byteLength, sha256: hash(rawScript) });
      assert.equal(receipt.synthesis.text, "CUT listens before it edits.");
      assert.equal(receipt.synthesis.textSha256, hash("CUT listens before it edits."));
    }
    for (const invalid of [" leading whitespace", "extra blank line\n\n", "internal\nline", "control\u0007character"]) {
      await writeFile(value.script, invalid);
      const result = run(
        value.root,
        "audio", "narrate", "script.txt", "--recipe", "recipe.json",
        "--out", "invalid.wav", "--receipt", "invalid.json", "--json",
      );
      assert.equal(result.status, 1);
      assert.match(result.stdout, /CUT_KOKORO_MLX_SCRIPT_TEXT/u);
    }
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("audio narrate publishes one authenticated WAV/receipt transaction; fake provider proves wiring, not inference", {
  skip: !isCutKokoroMlxLocalPlatformSupported() && "Kokoro MLX public execution is macOS arm64 only",
}, async () => {
  const value = await fixture();
  try {
    const args = ["audio", "narrate", "script.txt", "--recipe", "recipe.json", "--out", "voice.wav", "--receipt", "receipt.json", "--speed", "0.96", "--seed", "17", "--sample-rate", "48000", "--json"];
    const first = run(value.root, ...args);
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
    const report = JSON.parse(first.stdout), wav = await readFile(join(value.root, "voice.wav"));
    const receiptBytes = await readFile(join(value.root, "receipt.json")), receipt = JSON.parse(receiptBytes.toString("utf8"));
    assert.equal(report.format, "cut-audio-narrate-result");
    assert.equal(report.status, "pass");
    assert.equal(report.syntheticSpeech, true);
    assert.equal(report.output.sha256, hash(wav));
    assert.equal(report.receipt.sha256, hash(receiptBytes));
    assert.equal(receipt.output.sha256, hash(wav));
    assert.equal(receipt.synthesis.speedMicros, 960_000);
    assert.equal(receipt.synthesis.seed, 17);
    assert.equal(receipt.synthesis.sampleRate, 48_000);
    assert.equal(first.stdout.includes(value.root), false, "machine path leaked in public report");
    assert.equal(receiptBytes.includes(Buffer.from(value.root, "utf8")), false, "machine path leaked in execution receipt");
    const second = run(value.root, ...args);
    assert.equal(second.status, 1);
    assert.match(second.stdout, /CUT_KOKORO_MLX_OUTPUT_EXISTS/u);
    assert.equal((await readFile(value.marker, "utf8")).trim().split("\n").length, 1, "no-clobber must reject before second execution");
  } finally { await rm(value.root, { recursive: true, force: true }); }
});

test("audio narrate publishes neither artifact on provider failure or input mutation", {
  skip: !isCutKokoroMlxLocalPlatformSupported() && "Kokoro MLX public execution is macOS arm64 only",
}, async () => {
  for (const mode of ["nonzero", "mutate-script"] as const) {
    const value = await fixture(mode);
    try {
      const result = run(value.root, "audio", "narrate", "script.txt", "--recipe", "recipe.json", "--out", "voice.wav", "--receipt", "receipt.json", "--json");
      assert.equal(result.status, 1, `${mode} unexpectedly passed`);
      assert.equal(result.stdout.includes(value.root), false, `${mode} leaked a machine path`);
      assert.equal(result.stderr.includes(value.root), false, `${mode} leaked a machine path on stderr`);
      await assert.rejects(readFile(join(value.root, "voice.wav")), { code: "ENOENT" });
      await assert.rejects(readFile(join(value.root, "receipt.json")), { code: "ENOENT" });
      if (mode === "mutate-script") assert.match(result.stdout, /CUT_KOKORO_MLX_INPUT_CHANGED/u);
    } finally { await rm(value.root, { recursive: true, force: true }); }
  }
});
