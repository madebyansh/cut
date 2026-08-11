import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after, before } from "node:test";
import {
  analyzeWithYamnetLocal,
  collectBundledYamnetLocalSetup,
  collectYamnetLocalSetup,
  cutYamnetLocalSetupBytes,
  cutYamnetLocalPolicy,
  CutYamnetLocalError,
  doctorYamnetLocal,
  isCutYamnetLocalPlatformSupported,
  parseCutYamnetLocalSetup,
  resolveCutYamnetBundledAdapterPath,
  resolveCutYamnetBundledClassMapPath,
  type CutYamnetLocalErrorCode,
  type CutYamnetLocalSetup,
  type CutYamnetLocalSetupRecipe,
} from "../lib/audio-intelligence/yamnet-local";
import { stableJsonStringify } from "../lib/core/stable";

const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const originalTmpdir = process.env.TMPDIR;
let suiteTmpRoot = "";

before(async () => {
  suiteTmpRoot = await realpath(await mkdtemp(join(tmpdir(), "cut-yamnet-test-suite-")));
  process.env.TMPDIR = suiteTmpRoot;
});

after(async () => {
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;
  if (suiteTmpRoot) await rm(suiteTmpRoot, { recursive: true, force: true });
});

type Mode = "valid" | "short" | "nan" | "range" | "nonzero" | "timeout" | "descendant" | "mutate" | "mutate-class-map" | "launch-marker" | "bad-doctor";
type Fixture = Readonly<{
  root: string;
  modelPath: string;
  marker: string;
  recipe: CutYamnetLocalSetupRecipe;
  setup: CutYamnetLocalSetup;
}>;

function classMapBytes() {
  const lines: string[] = [];
  for (let index = 0; index < cutYamnetLocalPolicy.classCount; index += 1) {
    const label = index === 7 ? "Speech" : index === 3 ? "Music, general" : index === 4 ? 'Bell "tone"' : `Class ${index}`;
    lines.push(label);
  }
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

function pcm(samples: number, value = 0.125) {
  const bytes = Buffer.alloc(samples * 4);
  for (let index = 0; index < samples; index += 1) bytes.writeFloatLE(value, index * 4);
  return bytes;
}

function fakePython(mode: Mode, marker: string, originalModel: string, originalClassMap: string, platform: string, machine: string) {
  return `#!${process.execPath}
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2), get = flag => args[args.indexOf(flag) + 1];
const mode = ${JSON.stringify(mode)}, platform = ${JSON.stringify(platform)}, machine = ${JSON.stringify(machine)};
if (mode === "timeout") {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
  writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ root: process.pid, child: child.pid }) + "\\n", { flag: "wx" });
  process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);
} else {
  if (mode === "launch-marker") writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ root: process.pid }) + "\\n", { flag: "wx" });
  if (mode === "descendant") {
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
    child.unref(); writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ root: process.pid, child: child.pid }) + "\\n", { flag: "wx" });
  }
  if (mode === "nonzero") process.exit(19);
  if (mode === "mutate") appendFileSync(${JSON.stringify(originalModel)}, "mutation\\n");
  if (mode === "mutate-class-map") appendFileSync(${JSON.stringify(originalClassMap)}, "mutation\\n");
  if (get("--mode") === "doctor") {
    const result = {
      format: "cut-yamnet-local-adapter-result", version: 1,
      runtime: { implementation: "CPython", pythonVersion: "3.12.8", platform, machine, liteRtVersion: get("--litert-version") },
      model: { bytes: Number(get("--model-bytes")), sha256: get("--model-sha256") },
      classMap: { bytes: Number(get("--class-map-bytes")), sha256: get("--class-map-sha256"), classCount: 521 },
      policy: { sampleRate: 16000, patchSamples: 15600, patchHopSamples: 7680, rightPadFinalPatch: true, classCount: 521, interpreterThreads: 1 },
    };
    if (mode === "bad-doctor") result.policy.interpreterThreads = 4;
    process.stdout.write(JSON.stringify(result) + "\\n");
  } else {
    const chunks = []; process.stdin.on("data", chunk => chunks.push(chunk)); process.stdin.on("end", () => {
      const input = Buffer.concat(chunks), samples = input.length / 4;
      const patches = samples <= 15600 ? 1 : 1 + Math.ceil((samples - 15600) / 7680);
      let scores = Buffer.alloc(patches * 521 * 4);
      for (let patch = 0; patch < patches; patch += 1) for (let index = 0; index < 521; index += 1) {
        const score = index === 7 ? 0.9 - patch * 0.1 : index === 3 || index === 4 ? 0.5 : 0.001;
        scores.writeFloatLE(score, (patch * 521 + index) * 4);
      }
      if (mode === "short") scores = scores.subarray(0, scores.length - 4);
      if (mode === "nan") scores.writeFloatLE(Number.NaN, 0);
      if (mode === "range") scores.writeFloatLE(1.5, 0);
      process.stdout.write(scores);
    });
  }
}
`;
}

async function fixture(mode: Mode = "valid", environmentPaddingBytes = 0): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cut-yamnet-fixture-")));
  const pythonPath = resolve(root, "fake-python");
  const environmentRoot = resolve(root, "site-packages");
  const liteRtRoot = resolve(environmentRoot, "ai_edge_litert");
  const liteRtMetadata = resolve(environmentRoot, "ai_edge_litert-2.1.6.dist-info");
  const numpyRoot = resolve(environmentRoot, "numpy");
  const modelPath = resolve(root, "yamnet.tflite");
  const classMapPath = resolve(root, "yamnet_class_map.csv");
  const paddingPath = resolve(environmentRoot, "padding.bin");
  const marker = resolve(root, "pids.json");
  const adapterPath = await realpath(resolve("adapters/audio-yamnet-local/sidecar.py"));
  await Promise.all([
    mkdir(liteRtRoot, { recursive: true, mode: 0o700 }),
    mkdir(liteRtMetadata, { recursive: true, mode: 0o700 }),
    mkdir(numpyRoot, { recursive: true, mode: 0o700 }),
  ]);
  await Promise.all([
    writeFile(resolve(liteRtRoot, "__init__.py"), Buffer.from("# fixture LiteRT\n"), { flag: "wx" }),
    writeFile(resolve(liteRtMetadata, "METADATA"), Buffer.from("Name: ai-edge-litert\nVersion: 2.1.6\n"), { flag: "wx" }),
    writeFile(resolve(numpyRoot, "__init__.py"), Buffer.from("# fixture numpy\n"), { flag: "wx" }),
    writeFile(modelPath, Buffer.from("fixture YAMNet model bytes\n"), { flag: "wx" }),
    writeFile(classMapPath, classMapBytes(), { flag: "wx" }),
    ...(environmentPaddingBytes > 0
      ? [writeFile(paddingPath, Buffer.alloc(environmentPaddingBytes), { flag: "wx" })]
      : []),
  ]);
  const platform = process.platform === "linux" ? "linux" : "darwin";
  const machine = process.arch === "x64" ? "x86_64" : "arm64";
  await writeFile(pythonPath, Buffer.from(fakePython(mode, marker, modelPath, classMapPath, platform, machine)), { flag: "wx", mode: 0o700 });
  await chmod(pythonPath, 0o700);
  const recipe: CutYamnetLocalSetupRecipe = {
    python: { path: pythonPath, pythonVersion: "3.12.8", platform, machine },
    environment: {
      sitePackagesRoot: environmentRoot,
      roots: ["ai_edge_litert", "ai_edge_litert-2.1.6.dist-info", "numpy", ...(environmentPaddingBytes > 0 ? ["padding.bin"] : [])],
      revision: "fixture-environment-v1",
    },
    liteRt: { roots: ["ai_edge_litert", "ai_edge_litert-2.1.6.dist-info"], packageVersion: "2.1.6", declaredLicense: "Apache-2.0" },
    model: {
      path: modelPath,
      name: "YAMNet TFLite",
      revision: "fixture-model-v1",
      declaredLicense: "Apache-2.0",
      declaredProvenance: "caller-declared fixture provenance",
    },
  };
  const classMap = {
      path: classMapPath,
      name: "AudioSet YAMNet class map",
      revision: "fixture-class-map-v1",
      declaredLicense: "CC-BY-4.0",
      declaredProvenance: "caller-declared fixture provenance",
  };
  const setup = await collectYamnetLocalSetup({
    ...recipe,
    adapter: { path: adapterPath, revision: "cut-yamnet-litert-adapter-v1" },
    classMap,
  });
  return Object.freeze({ root, modelPath, marker, recipe: Object.freeze(recipe), setup });
}

async function privateRoots() {
  return (await readdir(await realpath(tmpdir()))).filter((name) => name.startsWith("cut-yamnet-local-")).sort();
}

async function cleanup(value: Fixture) {
  await rm(value.root, { recursive: true, force: true });
}

async function expectFailure(action: () => Promise<unknown>, code: CutYamnetLocalErrorCode, message?: RegExp) {
  await assert.rejects(action, (error: unknown) => error instanceof CutYamnetLocalError
    && error.code === code && (!message || message.test(error.message)));
}

async function processGone(pid: number) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { process.kill(pid, 0); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return true;
    }
    await new Promise((accept) => setTimeout(accept, 20));
  }
  return false;
}

test("admits only the direct-LiteRT host platforms", () => {
  assert.equal(isCutYamnetLocalPlatformSupported("darwin", "arm64"), true);
  assert.equal(isCutYamnetLocalPlatformSupported("linux", "x64"), true);
  assert.equal(isCutYamnetLocalPlatformSupported("darwin", "x64"), false);
  assert.equal(isCutYamnetLocalPlatformSupported("win32", "x64"), false);
});

test("collects a closed setup and doctor proves the staged direct-LiteRT boundary", async () => {
  const value = await fixture();
  const rootsBefore = await privateRoots();
  try {
    const receipt = await doctorYamnetLocal(value.setup);
    assert.equal(receipt.status, "PASS");
    assert.equal(receipt.runtime.liteRtVersion, "2.1.6");
    assert.equal(receipt.policy.interpreterThreads, 1);
    assert.equal(receipt.authorities.modelSha256, value.setup.model.file.sha256);
    assert.equal(receipt.authorities.liteRtTreeSha256, value.setup.liteRt.treeSha256);
    assert.equal(receipt.declarations.callerDeclared, true);
    assert.equal(receipt.declarations.model.provenance, value.setup.model.declaredProvenance);
    assert.match(receipt.evidenceScope.licenses, /caller declarations/u);
    assert.match(receipt.evidenceScope.locality, /not an operating-system network sandbox/u);
    const { receiptSha256, ...body } = receipt;
    assert.equal(receiptSha256, hash(stableJsonStringify(body)));
    assert.deepEqual(await privateRoots(), rootsBefore);
  } finally { await cleanup(value); }
});

test("bundled setup collection resolves the installed adapter and canonical setup parser", async () => {
  const value = await fixture();
  try {
    assert.equal(resolveCutYamnetBundledAdapterPath(), await realpath("adapters/audio-yamnet-local/sidecar.py"));
    const bundled = await collectBundledYamnetLocalSetup(value.recipe);
    assert.equal(bundled.adapter.path, resolveCutYamnetBundledAdapterPath());
    assert.equal(bundled.adapter.sha256, value.setup.adapter.sha256);
    assert.equal(bundled.classMap.file.path, resolveCutYamnetBundledClassMapPath());
    assert.equal(bundled.classMap.file.sha256, "8e1267a120c1932b7273c0d0e0c5529edbb9a35512b437b1c8982baa59047051");
    assert.deepEqual(parseCutYamnetLocalSetup(JSON.parse(cutYamnetLocalSetupBytes(bundled).toString("utf8"))), bundled);
    assert.throws(() => parseCutYamnetLocalSetup({ ...bundled, extra: true }), /CUT_YAMNET_CONTRACT/u);
    await assert.rejects(() => collectBundledYamnetLocalSetup({ ...value.recipe, adapter: {} }), /CUT_YAMNET_CONTRACT/u);
  } finally { await cleanup(value); }
});

test("applies the exact 15600/7680/right-pad law and stable score ordering", async () => {
  const value = await fixture();
  try {
    const input = pcm(15_601);
    const first = await analyzeWithYamnetLocal({ setup: value.setup, pcm: input, topK: 4 });
    const second = await analyzeWithYamnetLocal({ setup: value.setup, pcm: input, topK: 4 });
    assert.equal(first.analysis.framing.patchCount, 2);
    assert.deepEqual(first.analysis.patches.map((patch) => [patch.startSample, patch.validSamples]), [[0, 15_600], [7_680, 7_921]]);
    assert.deepEqual(first.analysis.aggregateTopClasses.map((item) => item.classIndex), [7, 3, 4, 0]);
    assert.equal(first.analysis.aggregateTopClasses[0]!.label, "Speech");
    assert.equal(first.analysis.aggregateTopClasses[1]!.label, "Music, general");
    assert.equal(first.analysis.rawScores.bytes, 2 * 521 * 4);
    assert.equal(first.analysis.rawScores.sha256, hash(first.rawScoreBytes));
    assert.equal(hash(first.classMapBytes), first.analysis.authorities.classMapSha256);
    assert.deepEqual(first.rawScoreBytes, second.rawScoreBytes);
    assert.deepEqual(first.classMapBytes, second.classMapBytes);
    assert.deepEqual(first.analysisBytes, second.analysisBytes);
    second.classMapBytes.fill(0);
    assert.equal(hash(first.classMapBytes), first.analysis.authorities.classMapSha256);
    const { analysisSha256, ...body } = first.analysis;
    assert.equal(analysisSha256, hash(stableJsonStringify(body)));
  } finally { await cleanup(value); }
});

test("rejects malformed PCM before provider launch", async () => {
  const value = await fixture();
  try {
    const nan = pcm(1); nan.writeFloatLE(Number.NaN, 0);
    const range = pcm(1); range.writeFloatLE(1.1, 0);
    await expectFailure(() => analyzeWithYamnetLocal({ setup: value.setup, pcm: Buffer.alloc(3), topK: 1 }), "CUT_YAMNET_CONTRACT");
    await expectFailure(() => analyzeWithYamnetLocal({ setup: value.setup, pcm: nan, topK: 1 }), "CUT_YAMNET_CONTRACT");
    await expectFailure(() => analyzeWithYamnetLocal({ setup: value.setup, pcm: range, topK: 1 }), "CUT_YAMNET_CONTRACT");
    await expectFailure(() => analyzeWithYamnetLocal({ setup: value.setup, pcm: pcm(160_001), topK: 1 }), "CUT_YAMNET_CONTRACT");
  } finally { await cleanup(value); }
});

test("rejects incomplete, non-finite, and out-of-range score output without residue", async () => {
  for (const mode of ["short", "nan", "range"] as const) {
    const value = await fixture(mode);
    const rootsBefore = await privateRoots();
    try {
      await expectFailure(() => analyzeWithYamnetLocal({ setup: value.setup, pcm: pcm(1), topK: 1 }), "CUT_YAMNET_OUTPUT");
      assert.deepEqual(await privateRoots(), rootsBefore);
    } finally { await cleanup(value); }
  }
});

test("rejects provider, doctor, and post-authentication mutation failures", async () => {
  for (const [mode, code] of [
    ["nonzero", "CUT_YAMNET_PROCESS"],
    ["bad-doctor", "CUT_YAMNET_OUTPUT"],
    ["mutate", "CUT_YAMNET_AUTHORITY"],
    ["mutate-class-map", "CUT_YAMNET_AUTHORITY"],
  ] as const) {
    const value = await fixture(mode);
    try {
      const action = mode === "bad-doctor"
        ? () => doctorYamnetLocal(value.setup)
        : () => analyzeWithYamnetLocal({ setup: value.setup, pcm: pcm(1), topK: 1 });
      await expectFailure(action, code);
    } finally { await cleanup(value); }
  }
});

test("cancellation during private staging fails before launch and removes the owned root", async () => {
  const value = await fixture("launch-marker", 32 * 1024 * 1024);
  const rootsBefore = await privateRoots();
  const controller = new AbortController();
  try {
    const running = analyzeWithYamnetLocal({
      setup: value.setup,
      pcm: pcm(15_600),
      topK: 1,
      signal: controller.signal,
    });
    let observedStage = false;
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const current = await privateRoots();
      if (current.some((name) => !rootsBefore.includes(name))) {
        observedStage = true;
        break;
      }
      await new Promise((accept) => setTimeout(accept, 1));
    }
    assert.equal(observedStage, true);
    controller.abort();
    await expectFailure(() => running, "CUT_YAMNET_CANCELLED");
    assert.equal(await readFile(value.marker).then(() => true, () => false), false);
    assert.deepEqual(await privateRoots(), rootsBefore);
  } finally { await cleanup(value); }
});

test("timeout and descendant leakage fail closed and drain the complete process group", async () => {
  for (const [mode, code] of [["timeout", "CUT_YAMNET_TIMEOUT"], ["descendant", "CUT_YAMNET_CLEANUP"]] as const) {
    const value = await fixture(mode);
    const rootsBefore = await privateRoots();
    try {
      await expectFailure(
        () => analyzeWithYamnetLocal({ setup: value.setup, pcm: pcm(1), topK: 1, timeoutMs: 2_000 }),
        code,
      );
      const pids = JSON.parse(await readFile(value.marker, "utf8")) as { root: number; child: number };
      assert.equal(await processGone(pids.root), true);
      assert.equal(await processGone(pids.child), true);
      assert.deepEqual(await privateRoots(), rootsBefore);
    } finally { await cleanup(value); }
  }
});

test("setup is closed and the LiteRT subset must exactly match the environment authority", async () => {
  const value = await fixture();
  try {
    await expectFailure(
      () => doctorYamnetLocal({ ...value.setup, extra: true } as never),
      "CUT_YAMNET_CONTRACT",
    );
    await expectFailure(
      () => doctorYamnetLocal(value.setup, { unexpected: true } as never),
      "CUT_YAMNET_CONTRACT",
    );
    await expectFailure(
      () => doctorYamnetLocal({
        ...value.setup,
        liteRt: { ...value.setup.liteRt, files: value.setup.liteRt.files.map((file, index) => index ? file : { ...file, sha256: "f".repeat(64) }) },
      }),
      "CUT_YAMNET_CONTRACT",
      /subset|treeSha256/u,
    );
  } finally { await cleanup(value); }
});

test("the real adapter is direct LiteRT, stdin-only, and contains no setup or MediaPipe Tasks path", async () => {
  const source = await readFile(resolve("adapters/audio-yamnet-local/sidecar.py"), "utf8");
  assert.match(source, /from ai_edge_litert\.interpreter import Interpreter/u);
  assert.match(source, /sys\.stdin\.buffer\.read/u);
  assert.match(source, /num_threads=threads/u);
  assert.doesNotMatch(source, /(?:import|from) mediapipe|AudioClassifier|pip install|snapshot_download|urllib|requests/u);
});
