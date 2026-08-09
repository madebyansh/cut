import assert from "node:assert/strict";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createCutProject } from "../lib/project";
import { CutFootageError } from "../lib/footage/diagnostics";
import {
  encodeCutFootageVectorArtifact,
  indexProjectFootage,
  loadCutFootageVectorArtifact,
  parseCutFootageVectorArtifact,
  type CutFootageIndexBackend,
  type CutFootageVectorArtifact,
  type FootageFrameBatchRequest,
} from "../lib/footage/indexer";
import type { CutFootageSidecarHandshake } from "../lib/footage/sidecar";

const dimensions = 512;
const digest = (digit: string) => digit.repeat(64);

function unitVector(index: number) {
  const vector = new Float32Array(dimensions); vector[index] = 1; return vector;
}

function artifact(ids = ["chunk-a", "chunk-b"]): CutFootageVectorArtifact {
  return {
    dimensions, planSha256: digest("d"),
    records: ids.map((chunkId, index) => ({ chunkId, vector: unitVector(index) })),
  };
}

async function deterministicSidecar(root: string) {
  const path = join(root, "index-sidecar.mjs");
  await writeFile(path, `
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
const adapter = (process.argv[2] ?? "a").repeat(64);
const mode = process.argv[3] ?? "valid";
const dimensions = 512;
const sha = (value) => createHash("sha256").update(value).digest("hex");
const line = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
line({ format:"cut-footage-sidecar-handshake", version:1, protocolVersion:1, provider:"fixture", model:"deterministic-clip", revision:"r1", dimensions, normalization:"l2", modalities:["image","text"], hardware:"cpu", adapterSha256:adapter, selfTestSha256:"b".repeat(64) });
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  input += chunk;
  while (input.includes("\\n")) {
    const end = input.indexOf("\\n"), raw = input.slice(0, end); input = input.slice(end + 1);
    const request = JSON.parse(raw);
    const base = { format:"cut-footage-sidecar-response", version:1, id:request.id, operation:request.operation };
    if (request.operation === "index") {
      const plan = JSON.parse(await readFile(request.plan.path, "utf8"));
      const chunks = [...plan.chunks].sort((a,b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)));
      let size = 48;
      for (const item of chunks) size += 2 + Buffer.byteLength(item.id) + dimensions * 4;
      const output = Buffer.alloc(size); output.write("CUTFVEC1", 0, "ascii"); output.writeUInt32LE(dimensions, 8); output.writeUInt32LE(chunks.length, 12); Buffer.from(request.plan.sha256, "hex").copy(output, 16);
      let offset = 48;
      for (const item of chunks) {
        const id = Buffer.from(item.id); output.writeUInt16LE(id.length, offset); offset += 2; id.copy(output, offset); offset += id.length;
        const selected = createHash("sha256").update(item.id).digest().readUInt16LE(0) % dimensions;
        for (let index = 0; index < dimensions; index += 1) { output.writeFloatLE(index === selected ? 1 : 0, offset); offset += 4; }
      }
      await writeFile(request.artifactPath, output, { flag:"wx" });
      line({ ...base, artifact:{ bytes:output.length, sha256:sha(output), recordCount:chunks.length, dimensions } });
    } else if (request.operation === "close") {
      line(base); process.exit(mode === "close-fail" ? 17 : 0);
    }
  }
});
`);
  return path;
}

function handshake(adapterDigit = "a"): CutFootageSidecarHandshake {
  return Object.freeze({
    format: "cut-footage-sidecar-handshake", version: 1, protocolVersion: 1,
    provider: "fixture", model: "deterministic-clip", revision: "r1", dimensions,
    normalization: "l2", modalities: Object.freeze(["image", "text"] as const), hardware: "cpu",
    adapterSha256: digest(adapterDigit), selfTestSha256: digest("b"),
  });
}

function backend(script: string, adapterDigit = "a", mode = "valid"): CutFootageIndexBackend {
  const expected = handshake(adapterDigit);
  return Object.freeze({
    identity: Object.freeze({
      protocolVersion: 1, provider: expected.provider,
      model: `${expected.model}@${expected.revision}+adapter.${expected.adapterSha256}`,
      dimensions, normalization: "l2",
    }),
    sidecar: Object.freeze({
      executable: process.execPath, arguments: Object.freeze([script, adapterDigit, mode]), expectedHandshake: expected,
      limits: Object.freeze({ handshakeMs: 1_000, indexMs: 5_000, closeMs: 1_000, terminateGraceMs: 100 }),
    }),
  });
}

function frameHook(calls: FootageFrameBatchRequest[]) {
  return async (request: FootageFrameBatchRequest) => {
    calls.push(request);
    await Promise.all(request.outputPaths.map((path, index) => writeFile(
      path,
      `deterministic-frame:${request.sourceLocator}:${request.streamIndex}:${request.samplePoints[index]?.numerator}/${request.samplePoints[index]?.denominator}\n`,
      { flag: "wx" },
    )));
  };
}

async function fixtureProject(twoSources = true) {
  const root = join(await mkdtemp(join(tmpdir(), "cut-footage-indexer-")), "project");
  await createCutProject(root, "Footage indexer");
  await copyFile(resolve("examples/media/demo.mp4"), join(root, "media/a.mp4"));
  if (twoSources) await copyFile(resolve("examples/media/demo.mp4"), join(root, "media/b.mov"));
  const script = await deterministicSidecar(join(root, ".cut"));
  return { root, script, output: ".cut/footage/index.json" };
}

test("CUTFVEC1 codec accepts exact sorted unit 512-d records and rejects malformed artifacts", () => {
  const encoded = Buffer.from(encodeCutFootageVectorArtifact(artifact()));
  const parsed = parseCutFootageVectorArtifact(encoded, { dimensions, chunkIds: ["chunk-b", "chunk-a"] });
  assert.equal(parsed.dimensions, dimensions);
  assert.deepEqual(parsed.records.map((record) => record.chunkId), ["chunk-a", "chunk-b"]);
  assert.equal(parsed.records[0]?.vector[0], 1);

  const malformed = [
    encoded.subarray(0, encoded.length - 1),
    Buffer.concat([encoded, Buffer.from([0])]),
    Buffer.from(encoded),
    Buffer.from(encoded),
  ];
  const firstFloat = 48 + 2 + Buffer.byteLength("chunk-a");
  malformed[2]!.writeFloatLE(Number.NaN, firstFloat);
  malformed[3]!.writeFloatLE(0.5, firstFloat);
  for (const bytes of malformed) {
    assert.throws(() => parseCutFootageVectorArtifact(bytes, { dimensions, chunkIds: ["chunk-a", "chunk-b"] }), (error: unknown) => error instanceof CutFootageError && error.code === "CUT_FOOTAGE_BACKEND_PROTOCOL");
  }
  assert.throws(() => parseCutFootageVectorArtifact(encoded, { dimensions: 4, chunkIds: ["chunk-a", "chunk-b"] }), /dimensions/u);
  assert.throws(() => parseCutFootageVectorArtifact(encoded, { dimensions, chunkIds: ["wrong", "chunk-b"] }), /chunk ids/u);
});

test("index workflow publishes a strict pair, then reuses every chunk byte-identically without starting inference", { timeout: 30_000, skip: process.platform === "win32" }, async () => {
  const fixture = await fixtureProject();
  const calls: FootageFrameBatchRequest[] = [];
  const first = await indexProjectFootage({
    projectRoot: fixture.root, rootLocator: "media", outputLocator: fixture.output, backend: backend(fixture.script),
    ffmpegExecutable: process.execPath, __testHooks: { runFrameBatch: frameHook(calls) },
  });
  assert.equal(first.reusedChunkIds.length, 0);
  assert.equal(first.indexedChunkIds.length, first.index.chunks.length);
  assert.ok(calls.length > 0);
  const indexPath = join(fixture.root, fixture.output), vectorPath = join(fixture.root, ".cut/footage/index.vectors");
  const before = await Promise.all([readFile(indexPath), readFile(vectorPath)]);
  const loaded = await loadCutFootageVectorArtifact(fixture.root, first.index);
  assert.equal(loaded.records.length, first.index.chunks.length);

  let reinferred = false;
  const second = await indexProjectFootage({
    projectRoot: fixture.root, rootLocator: "media", outputLocator: fixture.output, backend: backend(fixture.script),
    ffmpegExecutable: process.execPath, __testHooks: { async runFrameBatch() { reinferred = true; } },
  });
  assert.equal(reinferred, false);
  assert.deepEqual(second.reusedChunkIds, second.index.chunks.map((chunk) => chunk.id));
  assert.deepEqual(second.indexedChunkIds, []);
  assert.deepEqual(await Promise.all([readFile(indexPath), readFile(vectorPath)]), before);
  assert.equal((await readdir(join(fixture.root, ".cut/footage"))).some((name) => name.includes("staging")), false);
});

test("index workflow extracts exact 224px PNG samples through the bound FFmpeg lifecycle", { timeout: 30_000, skip: process.platform === "win32" }, async () => {
  const fixture = await fixtureProject(false);
  const indexed = await indexProjectFootage({
    projectRoot: fixture.root, rootLocator: "media", outputLocator: fixture.output, backend: backend(fixture.script),
  });
  assert.ok(indexed.indexedChunkIds.length > 0);
  assert.equal((await loadCutFootageVectorArtifact(fixture.root, indexed.index)).records.length, indexed.index.chunks.length);
});

test("fresh equivalent projects produce identical persistent bytes despite private staging paths", { timeout: 30_000, skip: process.platform === "win32" }, async () => {
  const left = await fixtureProject(false), right = await fixtureProject(false);
  for (const fixture of [left, right]) {
    await indexProjectFootage({
      projectRoot: fixture.root, rootLocator: "media", outputLocator: fixture.output, backend: backend(fixture.script),
      ffmpegExecutable: process.execPath, __testHooks: { runFrameBatch: frameHook([]) },
    });
  }
  assert.deepEqual(
    await Promise.all([readFile(join(left.root, left.output)), readFile(join(left.root, ".cut/footage/index.vectors"))]),
    await Promise.all([readFile(join(right.root, right.output)), readFile(join(right.root, ".cut/footage/index.vectors"))]),
  );
});

test("one changed source reindexes only its delta while adapter drift forces a full rebuild", { timeout: 30_000, skip: process.platform === "win32" }, async () => {
  const fixture = await fixtureProject();
  const first = await indexProjectFootage({
    projectRoot: fixture.root, rootLocator: "media", outputLocator: fixture.output, backend: backend(fixture.script),
    ffmpegExecutable: process.execPath, __testHooks: { runFrameBatch: frameHook([]) },
  });
  await appendFile(join(fixture.root, "media/b.mov"), Buffer.from([0]));
  const partialCalls: FootageFrameBatchRequest[] = [];
  const partial = await indexProjectFootage({
    projectRoot: fixture.root, rootLocator: "media", outputLocator: fixture.output, backend: backend(fixture.script),
    ffmpegExecutable: process.execPath, __testHooks: { runFrameBatch: frameHook(partialCalls) },
  });
  const aChunks = first.index.chunks.filter((chunk) => chunk.sourceLocator === "media/a.mp4").map((chunk) => chunk.id);
  assert.deepEqual(partial.reusedChunkIds, aChunks);
  assert.ok(partial.indexedChunkIds.length > 0 && partialCalls.every((call) => call.sourceLocator === "media/b.mov"));

  const rebuilt = await indexProjectFootage({
    projectRoot: fixture.root, rootLocator: "media", outputLocator: fixture.output, backend: backend(fixture.script, "c"),
    ffmpegExecutable: process.execPath, __testHooks: { runFrameBatch: frameHook([]) },
  });
  assert.deepEqual(rebuilt.reusedChunkIds, []);
  assert.equal(rebuilt.indexedChunkIds.length, rebuilt.index.chunks.length);
});

test("source mutation and publication failure preserve the verified old pair and clean private staging", { timeout: 30_000, skip: process.platform === "win32" }, async () => {
  const fixture = await fixtureProject(false);
  await indexProjectFootage({
    projectRoot: fixture.root, rootLocator: "media", outputLocator: fixture.output, backend: backend(fixture.script),
    ffmpegExecutable: process.execPath, __testHooks: { runFrameBatch: frameHook([]) },
  });
  const indexPath = join(fixture.root, fixture.output), vectorPath = join(fixture.root, ".cut/footage/index.vectors");
  const original = await Promise.all([readFile(indexPath), readFile(vectorPath)]);

  await appendFile(join(fixture.root, "media/a.mp4"), Buffer.from([0]));
  let mutated = false;
  await assert.rejects(indexProjectFootage({
    projectRoot: fixture.root, rootLocator: "media", outputLocator: fixture.output, backend: backend(fixture.script),
    ffmpegExecutable: process.execPath,
    __testHooks: {
      runFrameBatch: frameHook([]),
      async afterFrames() { if (!mutated) { mutated = true; await appendFile(join(fixture.root, "media/a.mp4"), Buffer.from([1])); } },
    },
  }), (error: unknown) => error instanceof CutFootageError && error.code === "CUT_FOOTAGE_INDEX_STALE");
  assert.deepEqual(await Promise.all([readFile(indexPath), readFile(vectorPath)]), original);
  assert.equal((await readdir(join(fixture.root, ".cut/footage"))).some((name) => name.includes("staging")), false);
});

test("FFmpeg, sidecar close, and paired-publication failures leave no partial pair", { timeout: 30_000, skip: process.platform === "win32" }, async () => {
  const frameFailure = await fixtureProject(false);
  await assert.rejects(indexProjectFootage({
    projectRoot: frameFailure.root, rootLocator: "media", outputLocator: frameFailure.output, backend: backend(frameFailure.script),
    ffmpegExecutable: process.execPath, __testHooks: { async runFrameBatch() { throw new Error("private ffmpeg detail"); } },
  }), (error: unknown) => error instanceof CutFootageError && error.code === "CUT_FOOTAGE_UNSUPPORTED_MEDIA" && !error.message.includes("private ffmpeg detail"));
  assert.deepEqual(await readdir(join(frameFailure.root, ".cut/footage")), []);

  const closeFailure = await fixtureProject(false);
  await assert.rejects(indexProjectFootage({
    projectRoot: closeFailure.root, rootLocator: "media", outputLocator: closeFailure.output, backend: backend(closeFailure.script, "a", "close-fail"),
    ffmpegExecutable: process.execPath, __testHooks: { runFrameBatch: frameHook([]) },
  }), (error: unknown) => error instanceof CutFootageError && error.code === "CUT_FOOTAGE_BACKEND_PROTOCOL");
  assert.deepEqual(await readdir(join(closeFailure.root, ".cut/footage")), []);

  const publicationFailure = await fixtureProject(false);
  await indexProjectFootage({
    projectRoot: publicationFailure.root, rootLocator: "media", outputLocator: publicationFailure.output, backend: backend(publicationFailure.script),
    ffmpegExecutable: process.execPath, __testHooks: { runFrameBatch: frameHook([]) },
  });
  const indexPath = join(publicationFailure.root, publicationFailure.output), vectorPath = join(publicationFailure.root, ".cut/footage/index.vectors");
  const original = await Promise.all([readFile(indexPath), readFile(vectorPath)]);
  await appendFile(join(publicationFailure.root, "media/a.mp4"), Buffer.from([0]));
  await assert.rejects(indexProjectFootage({
    projectRoot: publicationFailure.root, rootLocator: "media", outputLocator: publicationFailure.output, backend: backend(publicationFailure.script),
    ffmpegExecutable: process.execPath,
    __testHooks: {
      runFrameBatch: frameHook([]),
      publication: { fault(point) { if (point.phase === "promotion" && point.timing === "before" && point.role === "footage-index") throw new Error("fault"); } },
    },
  }), (error: unknown) => error instanceof CutFootageError && error.code === "CUT_FOOTAGE_PUBLISH");
  assert.deepEqual(await Promise.all([readFile(indexPath), readFile(vectorPath)]), original);
  assert.equal((await readdir(join(publicationFailure.root, ".cut/footage"))).some((name) => name.includes("staging") || name.endsWith(".bak")), false);
});

test("orphan and symlink destinations fail closed without being overwritten", { timeout: 30_000, skip: process.platform === "win32" }, async () => {
  const fixture = await fixtureProject(false);
  const outputRoot = join(fixture.root, ".cut/footage"); await mkdir(outputRoot);
  const vectorPath = join(outputRoot, "index.vectors"); await writeFile(vectorPath, "preserve orphan\n");
  await assert.rejects(indexProjectFootage({
    projectRoot: fixture.root, rootLocator: "media", outputLocator: fixture.output, backend: backend(fixture.script),
    ffmpegExecutable: process.execPath, __testHooks: { runFrameBatch: frameHook([]) },
  }), (error: unknown) => error instanceof CutFootageError && error.code === "CUT_FOOTAGE_INDEX_STALE");
  assert.equal(await readFile(vectorPath, "utf8"), "preserve orphan\n");

  const target = join(outputRoot, "elsewhere"); await writeFile(target, "do not touch\n");
  await symlink(target, join(outputRoot, "index.json"));
  await assert.rejects(indexProjectFootage({
    projectRoot: fixture.root, rootLocator: "media", outputLocator: fixture.output, backend: backend(fixture.script),
    ffmpegExecutable: process.execPath, __testHooks: { runFrameBatch: frameHook([]) },
  }), /complete regular no-follow pair/u);
  assert.equal(await readFile(target, "utf8"), "do not touch\n");
});
