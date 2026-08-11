import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync } from "node:fs";
import { chmod, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";
import {
  collectKokoroMlxLocalAuthorities,
  CutKokoroMlxLocalError,
  cutKokoroMlxLocalPolicy,
  isCutKokoroMlxLocalPlatformSupported,
  narrateWithKokoroMlxLocal,
  type CutKokoroMlxLocalErrorCode,
  type CutKokoroMlxLocalAuthorityPaths,
  type CutKokoroMlxLocalInput,
} from "../lib/audio-intelligence/kokoro-mlx-local";
import { stableJsonStringify } from "../lib/core/stable";

const inheritedTmpdir = process.env.TMPDIR;
const ownedTmpdir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "cut-kokoro-mlx-tests-")));
process.env.TMPDIR = ownedTmpdir;

after(async () => {
  try {
    assert.deepEqual(await readdir(ownedTmpdir), [], "Kokoro provider tests left residue in their owned TMPDIR");
  } finally {
    if (inheritedTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = inheritedTmpdir;
    await rm(ownedTmpdir, { recursive: true, force: true });
  }
});

const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

function runtimeTreeHash(files: readonly Readonly<{ relativePath: string; bytes: number; sha256: string }>[]) {
  const digest = createHash("sha256");
  for (const file of files) digest.update(`${file.relativePath}\0${file.bytes}\0${file.sha256}\n`, "utf8");
  return digest.digest("hex");
}

function runtimeSetHash(components: readonly Readonly<{
  id: string;
  treeSha256: string;
  packages: readonly Readonly<{ name: string; packageVersion: string; license: string }>[];
}>[]) {
  const digest = createHash("sha256");
  for (const component of components) {
    digest.update(`${component.id}\0${component.treeSha256}\n`, "utf8");
    for (const value of component.packages) {
      digest.update(`${value.name}\0${value.packageVersion}\0${value.license}\n`, "utf8");
    }
    digest.update("\n", "utf8");
  }
  return digest.digest("hex");
}

type Mode =
  | "valid"
  | "bad-wav"
  | "bad-result"
  | "stdout"
  | "nonzero"
  | "timeout"
  | "mutate-original"
  | "mutate-runtime"
  | "success-descendant"
  | "nonzero-descendant";
type Fixture = Readonly<{
  root: string;
  marker: string;
  modelWeights: string;
  runtimeFile: string;
  authorityPaths: CutKokoroMlxLocalAuthorityPaths;
  input: CutKokoroMlxLocalInput;
}>;

function wavBytes(sampleRate: number, silent = false) {
  const samples = silent ? [0, 0, 0, 0] : [100, -200, 300, -400];
  const dataBytes = samples.length * 2;
  const bytes = Buffer.alloc(44 + dataBytes);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(bytes.byteLength - 8, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(dataBytes, 40);
  samples.forEach((sample, index) => bytes.writeInt16LE(sample, 44 + index * 2));
  return bytes;
}

function fakePythonSource(mode: Mode, marker: string, originalModelWeights: string, originalRuntimeFile: string) {
  return `#!${process.execPath}
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
const get = flag => args[args.indexOf(flag) + 1];
const mode = ${JSON.stringify(mode)};
const request = JSON.parse(readFileSync(get("--request"), "utf8"));
const outputPath = get("--output"), resultPath = get("--result");
const digest = value => createHash("sha256").update(value).digest("hex");
function makeWav(sampleRate) {
  const samples = [100, -200, 300, -400], bytes = Buffer.alloc(52);
  bytes.write("RIFF", 0, "ascii"); bytes.writeUInt32LE(44, 4); bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii"); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(8, 40); samples.forEach((sample, index) => bytes.writeInt16LE(sample, 44 + index * 2));
  return bytes;
}
if (mode === "timeout") {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
  writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ root: process.pid, child: child.pid }) + "\\n", { flag: "wx" });
  process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);
} else {
  if (mode === "success-descendant" || mode === "nonzero-descendant") {
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
    child.unref();
    writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ root: process.pid, child: child.pid }) + "\\n", { flag: "wx" });
  }
  if (mode === "nonzero" || mode === "nonzero-descendant") {
    process.stderr.write("provider exact failure at " + get("--request") + "\\n");
    process.exit(19);
  }
  if (mode === "mutate-original") appendFileSync(${JSON.stringify(originalModelWeights)}, "mutation\\n");
  if (mode === "mutate-runtime") appendFileSync(${JSON.stringify(originalRuntimeFile)}, "mutation\\n");
  if (mode === "stdout") process.stdout.write("unexpected");
  const wav = mode === "bad-wav" ? Buffer.from("not-wave") : makeWav(request.synthesis.sampleRate);
  writeFileSync(outputPath, wav, { flag: "wx" });
  const result = {
    format: "cut-kokoro-mlx-local-adapter-result", version: 2,
    runtime: { implementation: "CPython", pythonVersion: "3.12.8", platform: "darwin", machine: "arm64", componentSetSha256: request.runtime.componentSetSha256 },
    model: { configSha256: request.model.config.sha256, weightsSha256: request.model.weights.sha256 },
    voice: { name: request.voice.name, weightsSha256: request.voice.weights.sha256 },
    phonemizer: { librarySha256: request.phonemizer.library.sha256, dataTreeSha256: request.phonemizer.dataTreeSha256 },
    synthesis: { textSha256: digest(request.synthesis.text), language: request.synthesis.language, speedMicros: request.synthesis.speedMicros, seed: request.synthesis.seed, sampleRate: request.synthesis.sampleRate },
    output: { bytes: wav.length, sha256: digest(wav), durationSamples: 4 },
  };
  if (mode === "bad-result") result.voice.name = "unbound_voice";
  writeFileSync(resultPath, JSON.stringify(result) + "\\n", { flag: "wx" });
}
`;
}

async function fixture(mode: Mode = "valid"): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cut-kokoro-fixture-")));
  const python = resolve(root, "fake-python");
  const sitePackages = resolve(root, "site-packages");
  const kokoroPackageRoot = resolve(sitePackages, "kokoro_mlx");
  const mlxPackageRoot = resolve(sitePackages, "mlx");
  const packageFixtures = [
    ["kokoro-mlx", "0.1.2", "kokoro_mlx-0.1.2.dist-info"],
    ["misaki", "0.9.4", "misaki-0.9.4.dist-info"],
    ["mlx", "0.32.0", "mlx-0.32.0.dist-info"],
    ["mlx-metal", "0.32.0", "mlx_metal-0.32.0.dist-info"],
    ["numpy", "2.5.1", "numpy-2.5.1.dist-info"],
    ["safetensors", "0.8.0", "safetensors-0.8.0.dist-info"],
  ] as const;
  const modelRoot = resolve(root, "model");
  const voiceRoot = resolve(modelRoot, "voices");
  const espeakData = resolve(root, "espeak-data");
  const marker = resolve(root, "pids.json");
  const modelWeights = resolve(modelRoot, "kokoro-v1_0.safetensors");
  const runtimeFile = resolve(kokoroPackageRoot, "__init__.py");
  const adapter = await realpath(resolve("adapters/audio-kokoro-mlx-local/sidecar.py"));
  await Promise.all([
    import("node:fs/promises").then(({ mkdir }) => mkdir(kokoroPackageRoot, { recursive: true, mode: 0o700 })),
    import("node:fs/promises").then(({ mkdir }) => mkdir(mlxPackageRoot, { recursive: true, mode: 0o700 })),
    ...packageFixtures.map(([, , directory]) => import("node:fs/promises")
      .then(({ mkdir }) => mkdir(resolve(sitePackages, directory), { recursive: true, mode: 0o700 }))),
    import("node:fs/promises").then(({ mkdir }) => mkdir(voiceRoot, { recursive: true, mode: 0o700 })),
    import("node:fs/promises").then(({ mkdir }) => mkdir(espeakData, { recursive: true, mode: 0o700 })),
  ]);
  const files = new Map<string, Buffer>([
    [runtimeFile, Buffer.from('__version__ = "0.1.2"\n', "utf8")],
    [resolve(mlxPackageRoot, "__init__.py"), Buffer.from("# fixture native package\n", "utf8")],
    ...packageFixtures.map(([name, version, directory]) => [
      resolve(sitePackages, directory, "METADATA"),
      Buffer.from(`Name: ${name}\nVersion: ${version}\n`, "utf8"),
    ] as const),
    [resolve(modelRoot, "config.json"), Buffer.from("{}\n", "utf8")],
    [modelWeights, Buffer.from("fixture model weights\n", "utf8")],
    [resolve(voiceRoot, "af_heart.safetensors"), Buffer.from("fixture voice weights\n", "utf8")],
    [resolve(root, "libespeak-ng.dylib"), Buffer.from("fixture espeak library\n", "utf8")],
    [resolve(espeakData, "phontab"), Buffer.from("fixture espeak data\n", "utf8")],
  ]);
  for (const [path, bytes] of files) await writeFile(path, bytes, { flag: "wx" });
  const pythonBytes = Buffer.from(fakePythonSource(mode, marker, modelWeights, runtimeFile), "utf8");
  await writeFile(python, pythonBytes, { flag: "wx", mode: 0o700 });
  await chmod(python, 0o700);
  const authorityPaths: CutKokoroMlxLocalAuthorityPaths = {
    python: { path: python, pythonVersion: "3.12.8" },
    adapter: { path: adapter, revision: "cut-kokoro-mlx-adapter-v2" },
    runtime: {
      sitePackagesRoot: sitePackages,
      components: [
        {
          id: "kokoro-python-runtime",
          roots: [
            "kokoro_mlx", "kokoro_mlx-0.1.2.dist-info", "misaki-0.9.4.dist-info",
            "numpy-2.5.1.dist-info", "safetensors-0.8.0.dist-info",
          ],
          packages: [
            { name: "kokoro-mlx", packageVersion: "0.1.2", license: "MIT" },
            { name: "misaki", packageVersion: "0.9.4", license: "Apache-2.0" },
            { name: "numpy", packageVersion: "2.5.1", license: "BSD-3-Clause" },
            { name: "safetensors", packageVersion: "0.8.0", license: "Apache-2.0" },
          ],
        },
        {
          id: "mlx-native-runtime",
          roots: ["mlx", "mlx-0.32.0.dist-info", "mlx_metal-0.32.0.dist-info"],
          packages: [
            { name: "mlx", packageVersion: "0.32.0", license: "MIT" },
            { name: "mlx-metal", packageVersion: "0.32.0", license: "MIT" },
          ],
        },
      ],
    },
    model: {
      name: "Kokoro-82M-bf16",
      revision: "a71e4d38b236d968966a2002c4c895dbd12b1c3c",
      license: "Apache-2.0",
      configPath: resolve(modelRoot, "config.json"),
      weightsPath: modelWeights,
    },
    voice: { name: "af_heart", license: "Apache-2.0", weightsPath: resolve(voiceRoot, "af_heart.safetensors") },
    phonemizer: { version: "1.52.0", libraryPath: resolve(root, "libespeak-ng.dylib"), dataRoot: espeakData },
  };
  const authorities = await collectKokoroMlxLocalAuthorities(authorityPaths);
  return Object.freeze({
    root,
    marker,
    modelWeights,
    runtimeFile,
    authorityPaths,
    input: Object.freeze({
      ...authorities,
      synthesis: Object.freeze({
        text: "A real local narration boundary.",
        language: "en-us",
        speedMicros: 960_000,
        seed: 17_072_026,
        sampleRate: 24_000,
      }),
    }),
  });
}

async function privateRoots() {
  return (await readdir(await realpath(tmpdir()))).filter((name) => name.startsWith("cut-kokoro-mlx-")).sort();
}

async function cleanup(value: Fixture) {
  await rm(value.root, { recursive: true, force: true });
}

async function expectFailure(action: () => Promise<unknown>, code: CutKokoroMlxLocalErrorCode, message?: RegExp) {
  await assert.rejects(action, (error: unknown) => error instanceof CutKokoroMlxLocalError
    && error.code === code && (!message || message.test(error.message)));
}

async function processGone(pid: number) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { process.kill(pid, 0); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return true;
    }
    await new Promise((accept) => setTimeout(accept, 25));
  }
  return false;
}

test("admits only the real Kokoro MLX platform boundary", () => {
  assert.equal(isCutKokoroMlxLocalPlatformSupported("darwin", "arm64"), true);
  assert.equal(isCutKokoroMlxLocalPlatformSupported("darwin", "x64"), false);
  assert.equal(isCutKokoroMlxLocalPlatformSupported("linux", "arm64"), false);
});

test("collector fails closed on unbounded or overlapping component-root declarations", async () => {
  const value = await fixture();
  try {
    const first = value.authorityPaths.runtime.components[0]!;
    const second = value.authorityPaths.runtime.components[1]!;
    await expectFailure(
      () => collectKokoroMlxLocalAuthorities({
        ...value.authorityPaths,
        runtime: {
          ...value.authorityPaths.runtime,
          components: [first, { ...second, roots: [...second.roots, first.roots[0]!] }],
        },
      }),
      "CUT_KOKORO_MLX_AUTHORITY",
      /overlap/u,
    );
    await expectFailure(
      () => collectKokoroMlxLocalAuthorities({
        ...value.authorityPaths,
        runtime: {
          ...value.authorityPaths.runtime,
          components: Array.from(
            { length: cutKokoroMlxLocalPolicy.maximumRuntimeComponents + 1 },
            (_, index) => ({ ...first, id: `component-${String(index + 1).padStart(3, "0")}` }),
          ),
        },
      }),
      "CUT_KOKORO_MLX_AUTHORITY",
      /component-count/u,
    );
    const maximumRoots = Array.from(
      { length: cutKokoroMlxLocalPolicy.maximumRuntimeRootsPerComponent },
      (_, index) => `root-${String(index + 1).padStart(3, "0")}.py`,
    );
    await Promise.all(maximumRoots.map((root) => writeFile(
      resolve(value.authorityPaths.runtime.sitePackagesRoot, root),
      `# ${root}\n`,
      { flag: "wx" },
    )));
    const atLimit = await collectKokoroMlxLocalAuthorities({
      ...value.authorityPaths,
      runtime: {
        ...value.authorityPaths.runtime,
        components: [{ ...first, roots: maximumRoots }, second],
      },
    });
    assert.equal(
      atLimit.runtime.components.find((component) => component.id === first.id)?.files.length,
      cutKokoroMlxLocalPolicy.maximumRuntimeRootsPerComponent,
    );
    await expectFailure(
      () => collectKokoroMlxLocalAuthorities({
        ...value.authorityPaths,
        runtime: {
          ...value.authorityPaths.runtime,
          components: [{
            ...first,
            roots: [...maximumRoots, "root-over-limit.py"],
          }, second],
        },
      }),
      "CUT_KOKORO_MLX_AUTHORITY",
      /root-count/u,
    );
  } finally { await cleanup(value); }
});

test("collector maps missing file and tree paths to typed locator-only authority errors", async () => {
  const value = await fixture();
  const sentinel = "CUT-PERSONAL-PATH-SENTINEL";
  const missingFile = resolve(value.root, sentinel, "missing-python");
  const first = value.authorityPaths.runtime.components[0]!;
  try {
    for (const [action, expectedMessage] of [
      [
        () => collectKokoroMlxLocalAuthorities({
          ...value.authorityPaths,
          python: { ...value.authorityPaths.python, path: missingFile },
        }),
        "CUT_KOKORO_MLX_AUTHORITY: Python executable could not be authenticated.",
      ],
      [
        () => collectKokoroMlxLocalAuthorities({
          ...value.authorityPaths,
          runtime: {
            ...value.authorityPaths.runtime,
            components: [{ ...first, roots: [`${sentinel}/missing-runtime.py`] }, ...value.authorityPaths.runtime.components.slice(1)],
          },
        }),
        "CUT_KOKORO_MLX_AUTHORITY: runtime component kokoro-python-runtime could not be authenticated.",
      ],
    ] as const) {
      await assert.rejects(action, (error: unknown) => {
        assert.equal(error instanceof CutKokoroMlxLocalError, true);
        assert.equal((error as CutKokoroMlxLocalError).code, "CUT_KOKORO_MLX_AUTHORITY");
        assert.equal((error as Error).message, expectedMessage);
        assert.equal((error as Error).message.includes(value.root), false);
        assert.equal((error as Error).message.includes(sentinel), false);
        return true;
      });
    }
  } finally { await cleanup(value); }
});

test("executes authenticated staged authorities and returns a validated WAV receipt", async () => {
  const value = await fixture();
  const rootsBefore = await privateRoots();
  try {
    const result = await narrateWithKokoroMlxLocal(value.input);
    assert.deepEqual(await privateRoots(), rootsBefore);
    assert.deepEqual(result.wavBytes, wavBytes(24_000));
    assert.equal(result.receipt.output.sha256, hash(result.wavBytes));
    assert.equal(result.receipt.synthesis.text, value.input.synthesis.text);
    assert.equal(result.receipt.runtime.python.sha256, value.input.python.sha256);
    assert.equal(result.receipt.runtime.adapter.sha256, value.input.adapter.sha256);
    assert.equal(result.receipt.runtime.componentSetSha256, value.input.runtime.componentSetSha256);
    assert.deepEqual(
      result.receipt.runtime.components.map((component) => component.id),
      value.input.runtime.components.map((component) => component.id),
    );
    assert.equal(result.receipt.model.weights.sha256, value.input.model.weights.sha256);
    assert.equal(result.receipt.voice.sha256, value.input.voice.weights.sha256);
    assert.equal(result.receipt.phonemizer.dataTreeSha256, value.input.phonemizer.dataTreeSha256);
    assert.equal(result.receipt.phonemizer.notice, cutKokoroMlxLocalPolicy.gplPhonemizerNotice);
    assert.equal(result.receipt.runtime.components[0]?.packages[0]?.declaredLicense, "MIT");
    assert.equal(result.receipt.model.declaredLicense, value.input.model.license);
    assert.equal(result.receipt.voice.declaredLicense, value.input.voice.license);
    assert.equal(result.receipt.phonemizer.declaredLicense, "GPL-3.0-or-later");
    assert.match(result.receipt.evidenceScope.authority, /separately declared Python\/native runtime components/u);
    assert.match(result.receipt.evidenceScope.authority, /standard-library and operating-system framework bytes remain outside/u);
    assert.match(result.receipt.evidenceScope.licenses, /caller declarations/u);
    assert.match(result.receipt.evidenceScope.networkIsolation, /not an operating-system network sandbox/u);
    assert.equal(result.receipt.determinism.reproducibleInferenceClaim, false);
    assert.match(result.receipt.determinism.boundary, /WAV bytes/u);
    const { executionSha256, ...body } = result.receipt;
    assert.equal(executionSha256, hash(stableJsonStringify(body)));
    assert.equal(result.receiptBytes.toString("utf8"), `${stableJsonStringify(result.receipt)}\n`);
    const receiptText = result.receiptBytes.toString("utf8");
    assert.equal(receiptText.includes(value.root), false);
    assert.equal(receiptText.includes(value.input.python.path), false);
  } finally { await cleanup(value); }
});

test("rejects malformed authorities and binds semantic synthesis settings", async () => {
  const value = await fixture();
  try {
    await expectFailure(
      () => narrateWithKokoroMlxLocal({ ...value.input, python: { ...value.input.python, sha256: "f".repeat(64) } }),
      "CUT_KOKORO_MLX_AUTHORITY",
    );
    await expectFailure(
      () => narrateWithKokoroMlxLocal({ ...value.input, phonemizer: { ...value.input.phonemizer, notice: "GPL" as never } }),
      "CUT_KOKORO_MLX_CONTRACT",
    );
    await expectFailure(
      () => narrateWithKokoroMlxLocal({ ...value.input, synthesis: { ...value.input.synthesis, speedMicros: 2_000_000 } }),
      "CUT_KOKORO_MLX_CONTRACT",
    );
    const alteredPackages = value.input.runtime.components[0]!.packages.map((entry, index) => (
      index === 0 ? { ...entry, license: "caller-altered" } : entry
    ));
    const alteredComponents = value.input.runtime.components.map((entry, index) => (
      index === 0 ? { ...entry, packages: alteredPackages } : entry
    ));
    await expectFailure(
      () => narrateWithKokoroMlxLocal({
        ...value.input,
        runtime: { ...value.input.runtime, components: alteredComponents },
      }),
      "CUT_KOKORO_MLX_CONTRACT",
      /component contract/u,
    );

    const duplicate = value.input.runtime.components[0]!.files[0]!;
    const overlapFiles = [...value.input.runtime.components[1]!.files, duplicate]
      .sort((left, right) => Buffer.compare(Buffer.from(left.relativePath), Buffer.from(right.relativePath)));
    const overlapComponents = value.input.runtime.components.map((entry, index) => (
      index === 1 ? { ...entry, files: overlapFiles, treeSha256: runtimeTreeHash(overlapFiles) } : entry
    ));
    await expectFailure(
      () => narrateWithKokoroMlxLocal({
        ...value.input,
        runtime: { components: overlapComponents, componentSetSha256: runtimeSetHash(overlapComponents) },
      }),
      "CUT_KOKORO_MLX_CONTRACT",
      /overlap/u,
    );
  } finally { await cleanup(value); }
});

test("rejects unbound result fields, malformed WAV, unexpected stdout, and nonzero exits without residue", async () => {
  for (const [mode, code] of [
    ["bad-result", "CUT_KOKORO_MLX_OUTPUT"],
    ["bad-wav", "CUT_KOKORO_MLX_OUTPUT"],
    ["stdout", "CUT_KOKORO_MLX_OUTPUT"],
    ["nonzero", "CUT_KOKORO_MLX_PROCESS"],
  ] as const) {
    const value = await fixture(mode);
    const rootsBefore = await privateRoots();
    try {
      await expectFailure(
        () => narrateWithKokoroMlxLocal(value.input),
        code,
        mode === "nonzero" ? /provider exact failure at <private-root>\/request\.json/u : undefined,
      );
      assert.deepEqual(await privateRoots(), rootsBefore);
    } finally { await cleanup(value); }
  }
});

test("handles an asynchronous failed spawn without an uncaught error or private residue", async () => {
  const value = await fixture();
  const rootsBefore = await privateRoots();
  try {
    await chmod(value.input.python.path, 0o600);
    await expectFailure(
      () => narrateWithKokoroMlxLocal(value.input),
      "CUT_KOKORO_MLX_PROCESS",
      /launch did not yield|failed after launch/u,
    );
    assert.deepEqual(await privateRoots(), rootsBefore);
  } finally { await cleanup(value); }
});

test("drains descendants left by successful and nonzero provider parents before stage cleanup", async () => {
  for (const [mode, code] of [
    ["success-descendant", "CUT_KOKORO_MLX_CLEANUP"],
    ["nonzero-descendant", "CUT_KOKORO_MLX_PROCESS"],
  ] as const) {
    const value = await fixture(mode);
    const rootsBefore = await privateRoots();
    try {
      await expectFailure(() => narrateWithKokoroMlxLocal(value.input), code);
      const pids = JSON.parse(await readFile(value.marker, "utf8")) as { root: number; child: number };
      assert.equal(await processGone(pids.root), true, `${mode} parent survived`);
      assert.equal(await processGone(pids.child), true, `${mode} descendant survived`);
      assert.deepEqual(await privateRoots(), rootsBefore);
    } finally { await cleanup(value); }
  }
});

test("detects post-staging source mutation even though inference consumed the owned copy", async () => {
  const value = await fixture("mutate-original");
  try {
    await expectFailure(
      () => narrateWithKokoroMlxLocal(value.input),
      "CUT_KOKORO_MLX_AUTHORITY",
      /changed during local Kokoro execution/u,
    );
    assert.match((await readFile(value.modelWeights, "utf8")), /mutation/u);
  } finally { await cleanup(value); }
});

test("detects post-staging runtime-component source mutation independently of the private copy", async () => {
  const value = await fixture("mutate-runtime");
  try {
    await expectFailure(
      () => narrateWithKokoroMlxLocal(value.input),
      "CUT_KOKORO_MLX_AUTHORITY",
      /changed during local Kokoro execution/u,
    );
    assert.match((await readFile(value.runtimeFile, "utf8")), /mutation/u);
  } finally { await cleanup(value); }
});

test("timeout kills the complete provider process group and removes its private stage", async () => {
  const value = await fixture("timeout");
  const rootsBefore = await privateRoots();
  try {
    await expectFailure(
      () => narrateWithKokoroMlxLocal({ ...value.input, timeoutMs: 1_000 }),
      "CUT_KOKORO_MLX_TIMEOUT",
    );
    const pids = JSON.parse(await readFile(value.marker, "utf8")) as { root: number; child: number };
    assert.equal(await processGone(pids.root), true);
    assert.equal(await processGone(pids.child), true);
    assert.deepEqual(await privateRoots(), rootsBefore);
  } finally { await cleanup(value); }
});

test("the packaged Python adapter remains syntax-valid and has no setup/download path", async () => {
  const source = await readFile(resolve("adapters/audio-kokoro-mlx-local/sidecar.py"), "utf8");
  assert.match(source, /KokoroTTS\.from_pretrained\(args\.model_root\)/u);
  assert.match(source, /generated = tts\.generate\(/u);
  assert.doesNotMatch(source, /tts\.save\(/u);
  assert.match(source, /path\.open\("xb"\)/u);
  assert.match(source, /args\.result\.open\("x"/u);
  assert.match(source, /require_import_origins/u);
  assert.match(source, /socket\.socket = OfflineSocket/u);
  assert.doesNotMatch(source, /snapshot_download|pip install|uv sync/u);
});
