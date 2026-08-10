import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, open as fsOpen, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import test from "node:test";

const adapterRoot = resolve("adapters/footage-local");
const adapterPath = resolve(adapterRoot, "local-clip-sidecar.mjs");
const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const loadAdapter = () => import(pathToFileURL(adapterPath).href);

function rawVector(first: number, second = 0) {
  const row = new Float32Array(512);
  row[0] = first;
  row[1] = second;
  return row;
}

function validPng(marker = 0) {
  const bytes = Buffer.alloc(33);
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(224, 16);
  bytes.writeUInt32BE(224, 20);
  bytes[24] = 8;
  bytes[25] = 2;
  bytes[26] = 0;
  bytes[27] = 0;
  bytes[28] = 0;
  bytes[32] = marker;
  return bytes;
}

function canonicalPlan(chunks: unknown[]) {
  return Buffer.from(`${JSON.stringify({
    chunks,
    dimensions: 512,
    format: "cut-footage-sidecar-index-plan",
    version: 1,
  })}\n`);
}

function jsonLineReader(stream: PassThrough) {
  let buffered = "";
  const values: unknown[] = [];
  const waiters: ((value: unknown) => void)[] = [];
  stream.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    while (buffered.includes("\n")) {
      const newline = buffered.indexOf("\n");
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      const value = JSON.parse(line);
      const waiter = waiters.shift();
      if (waiter) waiter(value); else values.push(value);
    }
  });
  return {
    next() {
      const value = values.shift();
      if (value !== undefined) return Promise.resolve(value);
      return new Promise<unknown>((resolveValue) => waiters.push(resolveValue));
    },
  };
}

async function protocolInstallation() {
  const root = await mkdtemp(join(tmpdir(), "cut-footage-protocol-install-"));
  await Promise.all([
    copyFile(adapterPath, join(root, "local-clip-sidecar.mjs")),
    copyFile(join(adapterRoot, "model.json"), join(root, "model.json")),
  ]);
  const cacheRoot = join(root, "models");
  const modelRevisionRoot = join(cacheRoot, "Xenova", "clip-vit-base-patch32", expectedModel.revision);
  await mkdir(modelRevisionRoot, { recursive: true });
  return { root, cacheRoot, modelRevisionRoot, adapterPath: join(root, "local-clip-sidecar.mjs") };
}

function protocolRuntime(disposals: number[]) {
  return {
    createSelfTestImage() { return { width: 2, height: 2, channels: 3 }; },
    async decodeImage(bytes: Uint8Array) { return { width: 224, height: 224, channels: 3, marker: bytes[32] }; },
    async embedImages(images: { marker?: number }[]) {
      return images.map((image) => image.marker === 2 ? rawVector(4, 3) : rawVector(3, 4));
    },
    async embedTexts() { return [rawVector(1, 1)]; },
    async dispose() { disposals.push(1); },
  };
}

function fakeTransformersModule(log: unknown[], options: { failTextDispose?: boolean } = {}) {
  const env: Record<string, unknown> = {};
  const rawRow = (first: number, second: number) => {
    const row = new Float32Array(512);
    row[0] = first;
    row[1] = second;
    return row;
  };
  const tokenizer = Object.assign((texts: string[], options: unknown) => {
    log.push(["tokenize", texts, options]);
    return { input_ids: texts };
  }, { fixture: true });
  const processor = Object.assign(async (images: unknown[]) => {
    log.push(["process", images.length]);
    return { pixel_values: images };
  }, { fixture: true });
  const textModel = Object.assign(async () => ({ text_embeds: { dims: [1, 512], data: rawRow(3, 4) } }), {
    async dispose() {
      log.push(["dispose", "text"]);
      if (options.failTextDispose) throw new Error("injected text disposal failure");
    },
  });
  const visionModel = Object.assign(async (inputs: { pixel_values: unknown[] }) => {
    const rows = inputs.pixel_values.length;
    const data = new Float32Array(rows * 512);
    for (let row = 0; row < rows; row += 1) data.set(rawRow(4, 3), row * 512);
    return { image_embeds: { dims: [rows, 512], data } };
  }, {
    async dispose() { log.push(["dispose", "vision"]); },
  });
  const loader = (name: string, result: unknown) => ({
    async from_pretrained(path: string, options: unknown) {
      log.push([name, path, options, { ...env }]);
      return result;
    },
  });
  class RawImage {
    data: Uint8Array;
    width: number;
    height: number;
    channels: number;
    constructor(data: Uint8Array, width: number, height: number, channels: number) {
      this.data = data; this.width = width; this.height = height; this.channels = channels;
    }
    static async read(blob: Blob) {
      log.push(["decode", blob.size]);
      return new RawImage(new Uint8Array(await blob.arrayBuffer()), 224, 224, 3);
    }
  }
  return {
    env,
    RawImage,
    AutoTokenizer: loader("tokenizer", tokenizer),
    AutoProcessor: loader("processor", processor),
    CLIPTextModelWithProjection: loader("text-model", textModel),
    CLIPVisionModelWithProjection: loader("vision-model", visionModel),
  };
}
const expectedPackage = {
  name: "@cut-lang/footage-local",
  version: "1.0.0",
  private: true,
  type: "module",
  engines: { node: ">=20.19.0 <21 || >=24.0.0 <25" },
  dependencies: { "@huggingface/transformers": "4.2.0" },
  overrides: { "adm-zip": "0.6.0", sharp: "0.35.3" },
};

const expectedModel = {
  format: "cut-footage-local-model",
  version: 1,
  provider: "huggingface-transformers-js",
  model: "Xenova/clip-vit-base-patch32",
  revision: "d15189d7028b43f1d3e65039190477f6af591c2a",
  dtype: "q8",
  device: "cpu",
  dimensions: 512,
  selfTestSha256: "ba7503358ab88be43b6e50d5d8a0f5367e22241208d832248ccb32209372aae7",
  files: [
    { locator: "config.json", role: "config", bytes: 4_524, sha256: "493ef57ff783e42d1530c91b53469b7fdf8db8a9c1408e86998fcb7899a4f495" },
    { locator: "onnx/text_model_quantized.onnx", role: "text-model", bytes: 64_504_507, sha256: "73baab855d406190da9faa498cfedf65f15cf309f4cc7385b7b032e6d08e5c3a" },
    { locator: "onnx/vision_model_quantized.onnx", role: "vision-model", bytes: 89_117_001, sha256: "583fd1110a514667812fee7d684952aaf82a99b959760c8d7dca7e0ab9839299" },
    { locator: "preprocessor_config.json", role: "preprocessor", bytes: 520, sha256: "6f638fb9401a6d6296feff533ee7efe657b787c49f954f82f5906b36ef2a1b1f" },
    { locator: "tokenizer.json", role: "tokenizer", bytes: 2_224_119, sha256: "f7f3b7af117d467b58374797691a6438d3e6b9e9cef800dfd5dced7f697a90cd" },
    { locator: "tokenizer_config.json", role: "tokenizer-config", bytes: 775, sha256: "60ba2912bc6344c94bc16bbdec27fa1209409167b6f2fdf3cfe9e65462ea3967" },
  ],
};

const expectedNotice = `# CUT local footage backend notices

The CUT local footage adapter (\`local-clip-sidecar.mjs\`) is part of CUT and is distributed under CUT's MIT License.

The optional \`cut footage setup --backend local\` command installs third-party software and model files into the user's CUT footage home. Those files are not dependencies of the main CUT package and are not bundled in the CUT package tarball.

- \`@huggingface/transformers\` 4.2.0 is distributed under the Apache License 2.0. Its installed package retains its license and notices.
- \`Xenova/clip-vit-base-patch32\` revision \`d15189d7028b43f1d3e65039190477f6af591c2a\` is a Transformers.js conversion of OpenAI CLIP ViT-B/32.
- OpenAI CLIP is distributed under the MIT License.

The installed dependency tree contains additional third-party packages. Their license files and notices remain in the immutable local backend installation. This notice is informational and does not replace those license terms.
`;

test("bundled local adapter is the exact standalone five-file recipe", async () => {
  assert.deepEqual((await readdir(adapterRoot)).sort(), [
    "NOTICE.md",
    "local-clip-sidecar.mjs",
    "model.json",
    "package-lock.json",
    "package.json",
  ]);

  const packageBytes = await readFile(resolve(adapterRoot, "package.json"), "utf8");
  const modelBytes = await readFile(resolve(adapterRoot, "model.json"), "utf8");
  assert.equal(packageBytes, `${JSON.stringify(expectedPackage, null, 2)}\n`);
  assert.equal(modelBytes, `${JSON.stringify(expectedModel, null, 2)}\n`);
  assert.equal(await readFile(resolve(adapterRoot, "NOTICE.md"), "utf8"), expectedNotice);

  const lock = JSON.parse(await readFile(resolve(adapterRoot, "package-lock.json"), "utf8"));
  assert.equal(lock.lockfileVersion, 3);
  assert.deepEqual(lock.packages[""], {
    name: "@cut-lang/footage-local",
    version: "1.0.0",
    engines: { node: ">=20.19.0 <21 || >=24.0.0 <25" },
    dependencies: { "@huggingface/transformers": "4.2.0" },
  });
  assert.equal(lock.packages["node_modules/adm-zip"].version, "0.6.0");
  assert.equal(lock.packages["node_modules/@huggingface/transformers"].version, "4.2.0");
  assert.equal(lock.packages["node_modules/onnxruntime-node"].version, "1.24.3");
  assert.equal(lock.packages["node_modules/sharp"].version, "0.35.3");
  for (const [locator, entry] of Object.entries(lock.packages) as [string, Record<string, unknown>][]) {
    if (!locator) continue;
    assert.match(String(entry.resolved), /^https:\/\/registry\.npmjs\.org\//u);
    assert.match(String(entry.integrity), /^sha512-[A-Za-z0-9+/]+={0,2}$/u);
  }
  const rootPackage = JSON.parse(await readFile(resolve("package.json"), "utf8"));
  assert.equal(rootPackage.files.includes("adapters/footage-local"), true);
});

test("adapter imports model-free with exact constants and canonical self-test identity", async () => {
  const adapter = await loadAdapter();
  assert.deepEqual(adapter.localClipAdapterContract, {
    protocolVersion: 1,
    provider: "huggingface-transformers-js",
    model: "Xenova/clip-vit-base-patch32",
    revision: "d15189d7028b43f1d3e65039190477f6af591c2a",
    dtype: "q8",
    device: "cpu",
    dimensions: 512,
    normalization: "l2",
    maximumRequestLineBytes: 1_048_576,
    maximumPlanBytes: 67_108_864,
    maximumArtifactBytes: 536_870_912,
    maximumRecords: 100_000,
    maximumFramesPerChunk: 8,
    maximumFrameReferences: 800_000,
    maximumFrameBytes: 4_194_304,
    maximumReferencedFrameBytes: 8_589_934_592,
    imageBatchSize: 8,
  });
  assert.equal(Object.isFrozen(adapter.localClipAdapterContract), true);

  const canonicalSelfTest = "{\"checks\":[\"text-embedding-finite-nonzero-512\",\"image-embedding-finite-nonzero-512\",\"l2-normalization-finite-unit\"],\"device\":\"cpu\",\"dimensions\":512,\"dtype\":\"q8\",\"format\":\"cut-footage-local-self-test\",\"image\":{\"channels\":3,\"format\":\"rgb8\",\"height\":2,\"pixelsBase64\":\"/wAAAP8AAAD/////\",\"width\":2},\"model\":\"Xenova/clip-vit-base-patch32\",\"normalization\":\"l2\",\"provider\":\"huggingface-transformers-js\",\"revision\":\"d15189d7028b43f1d3e65039190477f6af591c2a\",\"text\":\"cut semantic footage self test\",\"version\":1}";
  assert.equal(adapter.canonicalJson(adapter.localClipSelfTestDescriptor), canonicalSelfTest);
  assert.equal(sha256(canonicalSelfTest), "ba7503358ab88be43b6e50d5d8a0f5367e22241208d832248ccb32209372aae7");
  assert.equal(adapter.localClipSelfTestSha256, "ba7503358ab88be43b6e50d5d8a0f5367e22241208d832248ccb32209372aae7");
  assert.equal(adapter.canonicalJson({ z: 1, a: { y: 2, x: 3 } }), '{"a":{"x":3,"y":2},"z":1}');
});

test("normalizer rejects unsafe rows and emits finite canonical float32 unit vectors", async () => {
  const { normalizeEmbedding } = await loadAdapter();
  const normalized = normalizeEmbedding([3, -0, 4, 0], 4);
  assert.ok(normalized instanceof Float32Array);
  assert.deepEqual([...normalized], [0.6000000238418579, 0, 0.800000011920929, 0]);
  assert.equal(Object.is(normalized[1], -0), false);
  for (const row of [[0, 0, 0, 0], [1, 2, 3], [1, Number.NaN, 0, 0], [1, Number.POSITIVE_INFINITY, 0, 0]]) {
    assert.throws(() => normalizeEmbedding(row, 4), /embedding/u);
  }
});

test("CUTFVEC1 encoder matches the hand-checked golden and round-trips", async () => {
  const { encodeCutFvec1, parseCutFvec1 } = await loadAdapter();
  const encoded = encodeCutFvec1("11".repeat(32), [
    { id: "chunk-a", vector: new Float32Array([1, -0, 0, 0]) },
    { id: "chunk-b", vector: new Float32Array([0, 0.6, 0.8, 0]) },
  ], 4);
  assert.equal(encoded.byteLength, 98);
  assert.equal(encoded.toString("hex"), "43555446564543310400000002000000111111111111111111111111111111111111111111111111111111111111111107006368756e6b2d610000803f00000000000000000000000007006368756e6b2d62000000009a99193fcdcc4c3f00000000");
  assert.equal(sha256(encoded), "9f266b6a5ba5b97479c47d14265ce06ea7904f0131c64d7a01b20dcf8d785429");
  const parsed = parseCutFvec1(encoded, 4);
  assert.equal(parsed.planSha256, "11".repeat(32));
  assert.equal(parsed.dimensions, 4);
  assert.deepEqual(parsed.records.map((record: { id: string }) => record.id), ["chunk-a", "chunk-b"]);
  assert.deepEqual([...parsed.records[1].vector], [0, 0.6000000238418579, 0.800000011920929, 0]);
});

test("strict index plan accepts only canonical bounded closed evidence", async () => {
  const { parseIndexPlan } = await loadAdapter();
  const digestA = "a".repeat(64);
  const canonical = Buffer.from(`{"chunks":[{"frames":[{"bytes":33,"path":"/tmp/a.png","sha256":"${digestA}"}],"id":"chunk-a"}],"dimensions":512,"format":"cut-footage-sidecar-index-plan","version":1}\n`);
  assert.deepEqual(parseIndexPlan(canonical, 512), {
    format: "cut-footage-sidecar-index-plan",
    version: 1,
    dimensions: 512,
    chunks: [{ id: "chunk-a", frames: [{ path: "/tmp/a.png", bytes: 33, sha256: digestA }] }],
  });

  const malformed = [
    Buffer.from("{\n"),
    Buffer.from([0xff, 0x0a]),
    Buffer.from(` {"chunks":[],"dimensions":512,"format":"cut-footage-sidecar-index-plan","version":1}\n`),
    Buffer.from(`{"chunks":[{"frames":[{"bytes":33,"path":"../a.png","sha256":"${digestA}"}],"id":"chunk-a"}],"dimensions":512,"format":"cut-footage-sidecar-index-plan","version":1}\n`),
    Buffer.from(`{"chunks":[{"frames":[{"bytes":33,"path":"/tmp/a.png","sha256":"${digestA}"},{"bytes":33,"path":"/tmp/a.png","sha256":"${digestA}"}],"id":"chunk-a"}],"dimensions":512,"format":"cut-footage-sidecar-index-plan","version":1}\n`),
    Buffer.from(`{"chunks":[{"frames":[{"bytes":33,"path":"/tmp/z.png","sha256":"${digestA}"},{"bytes":33,"path":"/tmp/a.png","sha256":"${digestA}"}],"id":"chunk-a"}],"dimensions":512,"format":"cut-footage-sidecar-index-plan","version":1}\n`),
    Buffer.from(`{"chunks":[{"frames":[{"bytes":33,"path":"/tmp/a.png","sha256":"${digestA}"}],"id":"chunk-b"},{"frames":[{"bytes":33,"path":"/tmp/b.png","sha256":"${digestA}"}],"id":"chunk-a"}],"dimensions":512,"format":"cut-footage-sidecar-index-plan","version":1}\n`),
    Buffer.from(`{"chunks":[{"frames":[{"bytes":33,"path":"/tmp/a.png","sha256":"${digestA}"}],"id":"chunk-a","unexpected":true}],"dimensions":512,"format":"cut-footage-sidecar-index-plan","version":1}\n`),
    Buffer.from(`{"chunks":[{"frames":[{"bytes":33,"path":"/tmp/a.png","sha256":"${digestA}"}],"id":"chunk-a"}],"dimensions":512,"format":"cut-footage-sidecar-index-plan","unexpected":true,"version":1}\n`),
  ];
  for (const bytes of malformed) assert.throws(() => parseIndexPlan(bytes, 512), /plan/u);

  const tooManyFrames = Array.from({ length: 9 }, (_, index) => `{"bytes":33,"path":"/tmp/${index}.png","sha256":"${digestA}"}`).join(",");
  assert.throws(() => parseIndexPlan(Buffer.from(`{"chunks":[{"frames":[${tooManyFrames}],"id":"chunk-a"}],"dimensions":512,"format":"cut-footage-sidecar-index-plan","version":1}\n`), 512), /plan/u);

  const mismatchedReuse = Buffer.from(`{"chunks":[{"frames":[{"bytes":33,"path":"/tmp/a.png","sha256":"${digestA}"}],"id":"chunk-a"},{"frames":[{"bytes":34,"path":"/tmp/a.png","sha256":"${digestA}"}],"id":"chunk-b"}],"dimensions":512,"format":"cut-footage-sidecar-index-plan","version":1}\n`);
  assert.throws(() => parseIndexPlan(mismatchedReuse, 512), /plan/u);
});

test("CUTFVEC1 decoder rejects malformed and noncanonical artifacts", async () => {
  const { encodeCutFvec1, parseCutFvec1 } = await loadAdapter();
  const golden = encodeCutFvec1("11".repeat(32), [
    { id: "chunk-a", vector: new Float32Array([1, 0, 0, 0]) },
    { id: "chunk-b", vector: new Float32Array([0, 0.6, 0.8, 0]) },
  ], 4);
  const variants: Buffer[] = [];
  const badMagic = Buffer.from(golden); badMagic[0] = 0; variants.push(badMagic);
  const badDimensions = Buffer.from(golden); badDimensions.writeUInt32LE(5, 8); variants.push(badDimensions);
  const zeroRecords = Buffer.from(golden); zeroRecords.writeUInt32LE(0, 12); variants.push(zeroRecords);
  const tooManyRecords = Buffer.from(golden); tooManyRecords.writeUInt32LE(3, 12); variants.push(tooManyRecords);
  variants.push(golden.subarray(0, golden.byteLength - 1));
  variants.push(Buffer.concat([golden, Buffer.from([0])]));
  const badUtf8 = Buffer.from(golden); badUtf8[50] = 0xff; variants.push(badUtf8);
  const negativeZero = Buffer.from(golden); negativeZero.writeUInt32LE(0x80000000, 57); variants.push(negativeZero);
  const nonFinite = Buffer.from(golden); nonFinite.writeFloatLE(Number.NaN, 57); variants.push(nonFinite);
  const nonUnit = Buffer.from(golden); nonUnit.writeFloatLE(0.5, 57); variants.push(nonUnit);
  const duplicateId = Buffer.from(golden); duplicateId[81] = "a".charCodeAt(0); variants.push(duplicateId);
  for (const bytes of variants) assert.throws(() => parseCutFvec1(bytes, 4), /artifact/u);
});

test("runtime loader pins setup downloads and absolute offline model loading", async () => {
  const { createTransformersRuntime } = await loadAdapter();
  const installationRoot = "/tmp/cut-adapter-install";
  const cacheRoot = join(installationRoot, "models");
  const modelRevisionRoot = join(cacheRoot, "Xenova/clip-vit-base-patch32", expectedModel.revision);

  const setupLog: unknown[] = [];
  const setupRuntime = await createTransformersRuntime({
    mode: "setup", installationRoot, cacheRoot, modelRevisionRoot,
    transformersModule: fakeTransformersModule(setupLog),
  });
  assert.deepEqual(setupLog.slice(0, 4), [
    ["tokenizer", expectedModel.model, { revision: expectedModel.revision, cache_dir: cacheRoot }, { logLevel: 50, allowRemoteModels: true, allowLocalModels: true, useFSCache: true, cacheDir: cacheRoot }],
    ["processor", expectedModel.model, { revision: expectedModel.revision, cache_dir: cacheRoot }, { logLevel: 50, allowRemoteModels: true, allowLocalModels: true, useFSCache: true, cacheDir: cacheRoot }],
    ["text-model", expectedModel.model, { revision: expectedModel.revision, cache_dir: cacheRoot, device: "cpu", dtype: "q8" }, { logLevel: 50, allowRemoteModels: true, allowLocalModels: true, useFSCache: true, cacheDir: cacheRoot }],
    ["vision-model", expectedModel.model, { revision: expectedModel.revision, cache_dir: cacheRoot, device: "cpu", dtype: "q8" }, { logLevel: 50, allowRemoteModels: true, allowLocalModels: true, useFSCache: true, cacheDir: cacheRoot }],
  ]);
  await setupRuntime.dispose();

  const offlineLog: unknown[] = [];
  const offlineRuntime = await createTransformersRuntime({
    mode: "offline", installationRoot, modelRevisionRoot,
    transformersModule: fakeTransformersModule(offlineLog),
  });
  assert.deepEqual(offlineLog.slice(0, 4), [
    ["tokenizer", modelRevisionRoot, { local_files_only: true }, { logLevel: 50, allowRemoteModels: false, allowLocalModels: true, useFSCache: true }],
    ["processor", modelRevisionRoot, { local_files_only: true }, { logLevel: 50, allowRemoteModels: false, allowLocalModels: true, useFSCache: true }],
    ["text-model", modelRevisionRoot, { local_files_only: true, device: "cpu", dtype: "q8" }, { logLevel: 50, allowRemoteModels: false, allowLocalModels: true, useFSCache: true }],
    ["vision-model", modelRevisionRoot, { local_files_only: true, device: "cpu", dtype: "q8" }, { logLevel: 50, allowRemoteModels: false, allowLocalModels: true, useFSCache: true }],
  ]);
  await offlineRuntime.dispose();
  assert.deepEqual(offlineLog.slice(-2), [["dispose", "text"], ["dispose", "vision"]]);

  const disposalLog: unknown[] = [];
  const disposalRuntime = await createTransformersRuntime({
    mode: "offline", installationRoot, modelRevisionRoot,
    transformersModule: fakeTransformersModule(disposalLog, { failTextDispose: true }),
  });
  await disposalRuntime.dispose();
  assert.deepEqual(disposalLog.slice(-2), [["dispose", "text"], ["dispose", "vision"]]);
  await assert.rejects(createTransformersRuntime({
    mode: "offline", installationRoot, modelRevisionRoot: "relative/model",
    transformersModule: fakeTransformersModule([]),
  }), /model directory/u);
});

test("self-test runs both projection paths and rejects unsafe tensor rows", async () => {
  const { createTransformersRuntime, runLocalClipSelfTest } = await loadAdapter();
  const log: unknown[] = [];
  const runtime = await createTransformersRuntime({
    mode: "offline",
    installationRoot: "/tmp/cut-adapter-install",
    modelRevisionRoot: "/tmp/cut-adapter-model",
    transformersModule: fakeTransformersModule(log),
  });
  const result = await runLocalClipSelfTest(runtime);
  assert.ok(Math.abs(result.text[0] - 0.6) < 1e-6);
  assert.ok(Math.abs(result.image[0] - 0.8) < 1e-6);
  assert.ok(Number.isFinite(result.dot) && result.dot >= -1.0001 && result.dot <= 1.0001);
  assert.deepEqual(log.slice(4, 7).map((entry) => (entry as unknown[])[0]), ["tokenize", "process"]);
  await runtime.dispose();

  const unsafe = {
    createSelfTestImage() { return {}; },
    async embedTexts() { return [new Float32Array(511)]; },
    async embedImages() { return [new Float32Array(512)]; },
  };
  await assert.rejects(runLocalClipSelfTest(unsafe), /self-test/u);
});

test("index verifies PNG bytes, averages normalized frames, and searches in ID order", async (context) => {
  const { indexFootageArtifact, parseCutFvec1, searchFootageArtifact } = await loadAdapter();
  const root = await mkdtemp(join(tmpdir(), "cut-footage-adapter-index-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const frameA = join(root, "a.png");
  const frameB = join(root, "b.png");
  const planPath = join(root, "plan.json");
  const artifactPath = join(root, "vectors.bin");
  const aBytes = validPng(1);
  const bBytes = validPng(2);
  await writeFile(frameA, aBytes);
  await writeFile(frameB, bBytes);
  const planBytes = canonicalPlan([
    { frames: [{ bytes: aBytes.byteLength, path: frameA, sha256: sha256(aBytes) }], id: "chunk-a" },
    { frames: [
      { bytes: aBytes.byteLength, path: frameA, sha256: sha256(aBytes) },
      { bytes: bBytes.byteLength, path: frameB, sha256: sha256(bBytes) },
    ], id: "chunk-b" },
  ]);
  await writeFile(planPath, planBytes);
  const decoded: Buffer[] = [];
  const runtime = {
    async decodeImage(bytes: Uint8Array) {
      decoded.push(Buffer.from(bytes));
      return { width: 224, height: 224, channels: 3, marker: bytes[32] };
    },
    async embedImages(images: { marker: number }[]) {
      return images.map((image) => image.marker === 1 ? rawVector(3, 4) : rawVector(4, 3));
    },
    async embedTexts() { return [rawVector(1, 1)]; },
  };
  const indexed = await indexFootageArtifact({
    plan: { path: planPath, bytes: planBytes.byteLength, sha256: sha256(planBytes) },
    artifactPath,
    runtime,
  });
  assert.equal(indexed.recordCount, 2);
  assert.equal(indexed.dimensions, 512);
  assert.equal(indexed.sha256, sha256(await readFile(artifactPath)));
  const parsed = parseCutFvec1(await readFile(artifactPath), 512);
  assert.deepEqual(parsed.records.map((record: { id: string }) => record.id), ["chunk-a", "chunk-b"]);
  assert.ok(Math.abs(parsed.records[0].vector[0] - 0.6) < 1e-6);
  assert.ok(Math.abs(parsed.records[1].vector[0] - Math.SQRT1_2) < 1e-6);
  assert.deepEqual(decoded, [aBytes, aBytes, bBytes]);

  const candidates = await searchFootageArtifact({
    artifact: { path: artifactPath, bytes: indexed.bytes, sha256: indexed.sha256 },
    query: "a dashboard on a laptop",
    runtime,
  });
  assert.deepEqual(candidates.map((candidate: { chunkId: string }) => candidate.chunkId), ["chunk-a", "chunk-b"]);
  assert.ok(candidates.every((candidate: { score: number }) => Number.isFinite(candidate.score) && candidate.score >= -1 && candidate.score <= 1));
});

test("index rejects hostile PNG evidence and never clobbers an existing output", async (context) => {
  const { indexFootageArtifact, validatePng224Rgb } = await loadAdapter();
  const valid = validPng();
  const hostile = [
    Buffer.from(valid.subarray(0, 20)),
    (() => { const value = Buffer.from(valid); value[0] = 0; return value; })(),
    (() => { const value = Buffer.from(valid); value.writeUInt32BE(4096, 16); return value; })(),
    (() => { const value = Buffer.from(valid); value[24] = 16; return value; })(),
    (() => { const value = Buffer.from(valid); value[25] = 6; return value; })(),
    (() => { const value = Buffer.from(valid); value[28] = 1; return value; })(),
  ];
  for (const bytes of hostile) assert.throws(() => validatePng224Rgb(bytes), /PNG/u);

  const root = await mkdtemp(join(tmpdir(), "cut-footage-adapter-collision-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const framePath = join(root, "frame.png");
  const linkedFramePath = join(root, "linked.png");
  const planPath = join(root, "plan.json");
  const artifactPath = join(root, "vectors.bin");
  await writeFile(framePath, valid);
  await symlink(framePath, linkedFramePath);
  const makePlan = (path: string, bytes: number, digest: string) => canonicalPlan([
    { frames: [{ bytes, path, sha256: digest }], id: "chunk-a" },
  ]);
  const runtime = {
    async decodeImage() { return { width: 224, height: 224, channels: 3 }; },
    async embedImages() { return [rawVector(1)]; },
  };

  for (const [path, bytes, digest] of [
    [framePath, valid.byteLength + 1, sha256(valid)],
    [framePath, valid.byteLength, "f".repeat(64)],
    [linkedFramePath, valid.byteLength, sha256(valid)],
  ] as const) {
    const plan = makePlan(path, bytes, digest);
    await writeFile(planPath, plan);
    await assert.rejects(indexFootageArtifact({
      plan: { path: planPath, bytes: plan.byteLength, sha256: sha256(plan) }, artifactPath, runtime,
    }), /footage index/u);
  }

  const plan = makePlan(framePath, valid.byteLength, sha256(valid));
  await writeFile(planPath, plan);
  await writeFile(artifactPath, "preserve-existing-output\n");
  await assert.rejects(indexFootageArtifact({
    plan: { path: planPath, bytes: plan.byteLength, sha256: sha256(plan) }, artifactPath, runtime,
  }), /footage index/u);
  assert.equal(await readFile(artifactPath, "utf8"), "preserve-existing-output\n");

  await rm(artifactPath);
  for (const failure of ["write", "sync"] as const) {
    await assert.rejects(indexFootageArtifact({
      plan: { path: planPath, bytes: plan.byteLength, sha256: sha256(plan) }, artifactPath, runtime,
      filesystem: {
        async open(path: string, flags: number, mode?: number) {
          const handle = await fsOpen(path, flags, mode);
          if (path === planPath || path === framePath) return handle;
          return {
            stat: () => handle.stat(),
            write: failure === "write"
              ? async () => { throw new Error("injected write failure"); }
              : (bytes: Uint8Array, offset: number, length: number, position: number | null) => handle.write(bytes, offset, length, position),
            sync: failure === "sync"
              ? async () => { throw new Error("injected fsync failure"); }
              : () => handle.sync(),
            close: () => handle.close(),
          };
        },
      },
    }), /footage index/u);
    await assert.rejects(lstat(artifactPath), (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "ENOENT");
  }
});

test("abort during hung inference leaves the public artifact absent", async (context) => {
  const { indexFootageArtifact } = await loadAdapter();
  const root = await mkdtemp(join(tmpdir(), "cut-footage-adapter-abort-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const framePath = join(root, "frame.png");
  const planPath = join(root, "plan.json");
  const artifactPath = join(root, "vectors.bin");
  const frame = validPng();
  await writeFile(framePath, frame);
  const plan = canonicalPlan([{ frames: [{ bytes: frame.byteLength, path: framePath, sha256: sha256(frame) }], id: "chunk-a" }]);
  await writeFile(planPath, plan);
  const controller = new AbortController();
  let signalStarted!: () => void;
  const started = new Promise<void>((resolveStarted) => { signalStarted = resolveStarted; });
  const indexing = indexFootageArtifact({
    plan: { path: planPath, bytes: plan.byteLength, sha256: sha256(plan) }, artifactPath,
    signal: controller.signal,
    runtime: {
      async decodeImage() { return { width: 224, height: 224, channels: 3 }; },
      async embedImages() {
        signalStarted();
        return new Promise<never>(() => undefined);
      },
    },
  });
  await started;
  controller.abort();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      assert.rejects(indexing, /footage index/u),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("abort did not settle hung inference")), 250); }),
    ]);
  } finally { clearTimeout(timer); }
  await assert.rejects(lstat(artifactPath), (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "ENOENT");
});

test("a replaced private temp is preserved and never published as valid output", async (context) => {
  const { indexFootageArtifact } = await loadAdapter();
  const root = await mkdtemp(join(tmpdir(), "cut-footage-adapter-temp-race-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const framePath = join(root, "frame.png");
  const planPath = join(root, "plan.json");
  const artifactPath = join(root, "vectors.bin");
  const frame = validPng();
  await writeFile(framePath, frame);
  const plan = canonicalPlan([{ frames: [{ bytes: frame.byteLength, path: framePath, sha256: sha256(frame) }], id: "chunk-a" }]);
  await writeFile(planPath, plan);
  let privateTemp = "";
  await assert.rejects(indexFootageArtifact({
    plan: { path: planPath, bytes: plan.byteLength, sha256: sha256(plan) }, artifactPath,
    runtime: {
      async decodeImage() { return { width: 224, height: 224, channels: 3 }; },
      async embedImages() { return [rawVector(1)]; },
    },
    filesystem: {
      async link(source: string) {
        privateTemp = source;
        await rename(source, `${source}.owned`);
        await writeFile(source, "attacker replacement\n");
        throw new Error("injected link race");
      },
    },
  }), /footage index/u);
  assert.ok(privateTemp);
  assert.equal(await readFile(privateTemp, "utf8"), "attacker replacement\n");
  await assert.rejects(lstat(artifactPath), (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "ENOENT");
});

test("offline JSONL protocol serializes index, search, and graceful close", async (context) => {
  const { runLocalClipSidecar } = await loadAdapter();
  const installation = await protocolInstallation();
  context.after(() => rm(installation.root, { recursive: true, force: true }));
  const framePath = join(installation.root, "frame.png");
  const planPath = join(installation.root, "plan.json");
  const artifactPath = join(installation.root, "vectors.bin");
  const frame = validPng(2);
  await writeFile(framePath, frame);
  const plan = canonicalPlan([{ frames: [{ bytes: frame.byteLength, path: framePath, sha256: sha256(frame) }], id: "chunk-a" }]);
  await writeFile(planPath, plan);

  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const lines = jsonLineReader(stdout);
  const disposals: number[] = [];
  const running = runLocalClipSidecar({
    argv: ["offline"],
    environment: { CUT_FOOTAGE_MODEL_DIR: installation.modelRevisionRoot },
    stdin, stdout, stderr,
    installationRoot: installation.root,
    adapterPath: installation.adapterPath,
    runtimeFactory: async () => protocolRuntime(disposals),
  });
  const handshake = await lines.next() as Record<string, unknown>;
  assert.deepEqual(handshake, {
    format: "cut-footage-sidecar-handshake", version: 1, protocolVersion: 1,
    provider: expectedModel.provider, model: expectedModel.model, revision: expectedModel.revision,
    dimensions: 512, normalization: "l2", modalities: ["image", "text"], hardware: "cpu",
    adapterSha256: sha256(await readFile(installation.adapterPath)), selfTestSha256: expectedModel.selfTestSha256,
  });

  stdin.write(`${JSON.stringify({
    format: "cut-footage-sidecar-request", version: 1, id: "footage-1", operation: "index",
    plan: { path: planPath, bytes: plan.byteLength, sha256: sha256(plan) }, artifactPath,
  })}\n`);
  const indexResponse = await lines.next() as Record<string, any>;
  assert.equal(indexResponse.operation, "index");
  assert.equal(indexResponse.artifact.recordCount, 1);

  stdin.write(`${JSON.stringify({
    format: "cut-footage-sidecar-request", version: 1, id: "footage-2", operation: "searchText",
    artifact: { path: artifactPath, bytes: indexResponse.artifact.bytes, sha256: indexResponse.artifact.sha256 },
    query: "the exact private query",
  })}\n`);
  const searchResponse = await lines.next() as Record<string, any>;
  assert.equal(searchResponse.operation, "searchText");
  assert.deepEqual(searchResponse.candidates.map((candidate: { chunkId: string }) => candidate.chunkId), ["chunk-a"]);

  stdin.end(`${JSON.stringify({ format: "cut-footage-sidecar-request", version: 1, id: "footage-3", operation: "close" })}\n`);
  assert.deepEqual(await lines.next(), { format: "cut-footage-sidecar-response", version: 1, id: "footage-3", operation: "close" });
  await running;
  assert.equal(disposals.length, 1);
  assert.equal(stderr.read()?.toString("utf8") ?? "", "");
});

test("setup protocol permits only close and protocol failures leak no request data", async (context) => {
  const { runLocalClipSidecar } = await loadAdapter();
  const installation = await protocolInstallation();
  context.after(() => rm(installation.root, { recursive: true, force: true }));
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const lines = jsonLineReader(stdout);
  const disposals: number[] = [];
  const running = runLocalClipSidecar({
    argv: ["setup"],
    environment: {
      CUT_FOOTAGE_CACHE_DIR: installation.cacheRoot,
      CUT_FOOTAGE_MODEL_DIR: installation.modelRevisionRoot,
      HTTPS_PROXY: "https://secret-proxy.example",
    },
    stdin, stdout, stderr,
    installationRoot: installation.root,
    adapterPath: installation.adapterPath,
    runtimeFactory: async () => protocolRuntime(disposals),
  });
  await lines.next();
  stdin.end(`${JSON.stringify({
    format: "cut-footage-sidecar-request", version: 1, id: "footage-1", operation: "searchText",
    artifact: { path: "/tmp/private-artifact", bytes: 1, sha256: "a".repeat(64) },
    query: "private customer wording",
  })}\n`);
  await assert.rejects(running, /sidecar failed/u);
  const diagnostic = stderr.read()?.toString("utf8") ?? "";
  assert.equal(diagnostic, "cut footage sidecar failed\n");
  assert.equal(diagnostic.includes("private"), false);
  assert.equal(diagnostic.includes("secret-proxy"), false);
  assert.equal(disposals.length, 1);
});

test("JSONL protocol terminates on oversized, partial, and out-of-order requests", async (context) => {
  const { runLocalClipSidecar } = await loadAdapter();
  const installation = await protocolInstallation();
  context.after(() => rm(installation.root, { recursive: true, force: true }));
  for (const request of [
    `${"x".repeat(1024 * 1024 + 1)}\n`,
    "{\"partial\":true",
    `${JSON.stringify({ format: "cut-footage-sidecar-request", version: 1, id: "footage-2", operation: "close" })}\n`,
  ]) {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const lines = jsonLineReader(stdout);
    const running = runLocalClipSidecar({
      argv: ["offline"], environment: { CUT_FOOTAGE_MODEL_DIR: installation.modelRevisionRoot },
      stdin, stdout, stderr, installationRoot: installation.root, adapterPath: installation.adapterPath,
      runtimeFactory: async () => protocolRuntime([]),
    });
    await lines.next();
    stdin.end(request);
    await assert.rejects(running, /sidecar failed/u);
    assert.equal(stderr.read()?.toString("utf8"), "cut footage sidecar failed\n");
  }
});
