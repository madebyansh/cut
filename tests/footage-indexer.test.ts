import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFile, chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createCutProject } from "../lib/project";
import { runFfmpeg } from "../lib/runtime/reference/ffmpeg";
import { CutFootageError } from "../lib/footage/diagnostics";
import {
  encodeCutFootageVectorArtifact,
  indexProjectFootage,
  loadCutFootageVectorArtifact,
  parseCutFootageVectorArtifact,
  type CutFootageIndexBackend,
  type CutFootageVectorArtifact,
  type FootageFrameBatchRequest,
  type FootageIndexerTestHooks,
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

test("CUTFVEC1 rejects signed negative zero and empty record sets", () => {
  const negativeZero = Buffer.from(encodeCutFootageVectorArtifact(artifact(["chunk-a"])));
  const firstFloat = 48 + 2 + Buffer.byteLength("chunk-a");
  negativeZero.writeUInt32LE(0x8000_0000, firstFloat + 4);
  assert.throws(
    () => parseCutFootageVectorArtifact(negativeZero, { dimensions, chunkIds: ["chunk-a"] }),
    (error: unknown) => error instanceof CutFootageError && error.code === "CUT_FOOTAGE_BACKEND_PROTOCOL",
  );

  const empty = Buffer.alloc(48);
  empty.write("CUTFVEC1", 0, "ascii");
  empty.writeUInt32LE(dimensions, 8);
  Buffer.from(digest("e"), "hex").copy(empty, 16);
  assert.throws(
    () => parseCutFootageVectorArtifact(empty, { dimensions, chunkIds: [] }),
    (error: unknown) => error instanceof CutFootageError && error.code === "CUT_FOOTAGE_BACKEND_PROTOCOL",
  );
  assert.throws(
    () => encodeCutFootageVectorArtifact({ dimensions, planSha256: digest("e"), records: [] }),
    (error: unknown) => error instanceof CutFootageError && error.code === "CUT_FOOTAGE_BACKEND_PROTOCOL",
  );
});

test("FFmpeg frame batches isolate one first frame per planned window before numbering", { timeout: 30_000, skip: process.platform === "win32" }, async () => {
  const fixture = await fixtureProject(false);
  const calls: FootageFrameBatchRequest[] = [];
  await indexProjectFootage({
    projectRoot: fixture.root, rootLocator: "media", outputLocator: fixture.output, backend: backend(fixture.script),
    ffmpegExecutable: process.execPath, __testHooks: { runFrameBatch: frameHook(calls) },
  });
  assert.ok(calls.length > 0);
  for (const call of calls) {
    const filterIndex = call.arguments.indexOf("-vf");
    assert.notEqual(filterIndex, -1);
    const filter = call.arguments[filterIndex + 1]!;
    assert.equal(filter.match(/trim=end_frame=1/gu)?.length, call.samplePoints.length);
    assert.match(filter, new RegExp(`split=${call.samplePoints.length}(?:\\[|;)`, "u"));
    assert.match(filter, new RegExp(`concat=n=${call.samplePoints.length}:v=1:a=0`, "u"));
  }
});

test("VFR duplicate frames cannot hide a later missing planned window", { timeout: 30_000, skip: process.platform === "win32" }, async () => {
  const fixture = await fixtureProject(false), sourcePath = join(fixture.root, "media/a.mp4");
  await runFfmpeg([
    "-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=64x64:rate=30:duration=0.2",
    "-vf", "settb=1/1000,setpts=if(eq(N\\,0)\\,0\\,if(eq(N\\,1)\\,500\\,if(eq(N\\,2)\\,510\\,if(eq(N\\,3)\\,1000\\,if(eq(N\\,4)\\,2000\\,3000)))))",
    "-fps_mode", "vfr", "-c:v", "libx264", "-x264-params", "force-cfr=0", "-pix_fmt", "yuv420p", "-y", sourcePath,
  ]);
  await assert.rejects(indexProjectFootage({
    projectRoot: fixture.root, rootLocator: "media", outputLocator: fixture.output, backend: backend(fixture.script),
  }), (error: unknown) => error instanceof CutFootageError && error.code === "CUT_FOOTAGE_UNSUPPORTED_MEDIA");
  assert.deepEqual((await readdir(join(fixture.root, ".cut/footage"))).filter((name) => name.endsWith(".json") || name.endsWith(".vectors")), []);
});

test("abort kills the complete FFmpeg process group and returns one private stable error", { timeout: 10_000, skip: process.platform === "win32" }, async () => {
  const fixture = await fixtureProject(false);
  const pidPath = join(fixture.root, ".cut/ffmpeg-grandchild.pid"), executable = join(fixture.root, ".cut/hanging-ffmpeg.mjs");
  await writeFile(executable, `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => {});
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setTimeout(()=>process.exit(0),2000)"], { stdio:["ignore","ignore","inherit"] });
writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
setTimeout(() => process.exit(0), 2000);
`, { flag: "wx", mode: 0o700 });
  await chmod(executable, 0o700);
  const controller = new AbortController();
  const operation = indexProjectFootage({
    projectRoot: fixture.root, rootLocator: "media", outputLocator: fixture.output, backend: backend(fixture.script),
    ffmpegExecutable: executable, signal: controller.signal,
  });
  void operation.catch(() => undefined);
  const deadline = Date.now() + 3_000;
  let grandchildPid: number | undefined;
  while (Date.now() < deadline && grandchildPid === undefined) {
    try { grandchildPid = Number(await readFile(pidPath, "utf8")); }
    catch { await new Promise((resolveWait) => setTimeout(resolveWait, 20)); }
  }
  assert.ok(Number.isSafeInteger(grandchildPid) && grandchildPid! > 0);
  const abortStarted = Date.now(); controller.abort();
  await assert.rejects(operation, (error: unknown) => error instanceof CutFootageError
    && error.code === "CUT_FOOTAGE_BACKEND_PROTOCOL"
    && error.path === "$signal"
    && !error.message.includes(fixture.root));
  assert.ok(Date.now() - abortStarted < 2_000);
  await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  assert.throws(() => process.kill(grandchildPid!, 0), (error: unknown) => error !== null && typeof error === "object" && "code" in error && error.code === "ESRCH");
  assert.deepEqual((await readdir(join(fixture.root, ".cut/footage"))).filter((name) => name.endsWith(".json") || name.endsWith(".vectors") || name.includes("staging")), []);
});

test("abort at the final publication boundary leaves no footage pair", { timeout: 30_000, skip: process.platform === "win32" }, async () => {
  const fixture = await fixtureProject(false), controller = new AbortController();
  await assert.rejects(indexProjectFootage({
    projectRoot: fixture.root, rootLocator: "media", outputLocator: fixture.output, backend: backend(fixture.script),
    ffmpegExecutable: process.execPath, signal: controller.signal,
    __testHooks: {
      runFrameBatch: frameHook([]),
      async beforePublication() { controller.abort(); },
    },
  }), (error: unknown) => error instanceof CutFootageError
    && error.code === "CUT_FOOTAGE_BACKEND_PROTOCOL"
    && error.path === "$signal"
    && !error.message.includes(fixture.root));
  assert.deepEqual((await readdir(join(fixture.root, ".cut/footage"))).filter((name) => name.endsWith(".json") || name.endsWith(".vectors") || name.includes("staging")), []);
});

test("abort during a large footage discovery walk leaves no index, vector, or staging output", { timeout: 30_000, skip: process.platform === "win32" }, async () => {
  const root = join(await mkdtemp(join(tmpdir(), "cut-footage-indexer-discovery-abort-")), "project");
  await createCutProject(root, "Footage discovery abort");
  await Promise.all(Array.from({ length: 512 }, (_unused, index) => writeFile(
    join(root, "media", `${String(index).padStart(4, "0")}.mp4`),
    "x",
  )));
  const script = await deterministicSidecar(join(root, ".cut")), controller = new AbortController();
  try {
    const operation = indexProjectFootage({
      projectRoot: root, rootLocator: "media", outputLocator: ".cut/footage/index.json", backend: backend(script),
      ffmpegExecutable: process.execPath, signal: controller.signal, __testHooks: { runFrameBatch: frameHook([]) },
    });
    setTimeout(() => controller.abort(), 1);
    await assert.rejects(operation, (error: unknown) => error instanceof CutFootageError
      && error.code === "CUT_FOOTAGE_BACKEND_PROTOCOL"
      && error.path === "$signal");
    assert.deepEqual((await readdir(join(root, ".cut/footage"))).filter((name) => name.endsWith(".json") || name.endsWith(".vectors") || name.includes("staging")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("indexing maps local I/O failures to stable footage errors without absolute paths", { skip: process.platform === "win32" }, async () => {
  const fixture = await fixtureProject(false);
  const missingRoot = join(fixture.root, "private-missing-project");
  await assert.rejects(indexProjectFootage({
    projectRoot: missingRoot, rootLocator: "media", outputLocator: fixture.output, backend: backend(fixture.script),
    ffmpegExecutable: process.execPath, __testHooks: { runFrameBatch: frameHook([]) },
  }), (error: unknown) => error instanceof CutFootageError
    && error.code === "CUT_FOOTAGE_PUBLISH"
    && !error.message.includes(missingRoot)
    && !error.message.includes(fixture.root));
});

test("staging cleanup preserves a replacement directory and keeps the error path private", { timeout: 30_000, skip: process.platform === "win32" }, async () => {
  const fixture = await fixtureProject(false);
  const outputRoot = join(fixture.root, ".cut/footage");
  let replacementLeaf = "";
  await assert.rejects(indexProjectFootage({
    projectRoot: fixture.root, rootLocator: "media", outputLocator: fixture.output, backend: backend(fixture.script),
    ffmpegExecutable: process.execPath,
    __testHooks: {
      runFrameBatch: frameHook([]),
      async beforeSourceRecheck() {
        const stagingName = (await readdir(outputRoot)).find((name) => name.includes("cut-footage-staging"));
        assert.ok(stagingName);
        const stagingPath = join(outputRoot, stagingName);
        await rename(stagingPath, `${stagingPath}.owned`);
        await mkdir(stagingPath, { mode: 0o700 });
        replacementLeaf = join(stagingPath, "foreign-data");
        await writeFile(replacementLeaf, "preserve replacement\n", { flag: "wx" });
        throw new Error("private cleanup trigger");
      },
    },
  }), (error: unknown) => error instanceof CutFootageError
    && error.code === "CUT_FOOTAGE_PUBLISH"
    && !error.message.includes(fixture.root)
    && !error.message.includes("private cleanup trigger"));
  assert.equal(await readFile(replacementLeaf, "utf8"), "preserve replacement\n");
});

test("publication compare-and-swap preserves a concurrent valid footage pair", { timeout: 30_000, skip: process.platform === "win32" }, async () => {
  const fixture = await fixtureProject(false);
  await indexProjectFootage({
    projectRoot: fixture.root, rootLocator: "media", outputLocator: fixture.output, backend: backend(fixture.script),
    ffmpegExecutable: process.execPath, __testHooks: { runFrameBatch: frameHook([]) },
  });
  await appendFile(join(fixture.root, "media/a.mp4"), Buffer.from([0]));
  const indexPath = join(fixture.root, fixture.output), vectorPath = join(fixture.root, ".cut/footage/index.vectors");
  let concurrentPair: readonly Buffer[] | undefined;
  let raced = false;
  const hooks = {
    runFrameBatch: frameHook([]),
    publication: {
      async fault(point) {
        if (raced || point.phase !== "backup" || point.timing !== "before" || point.index !== 0) return;
        raced = true;
        await indexProjectFootage({
          projectRoot: fixture.root, rootLocator: "media", outputLocator: fixture.output, backend: backend(fixture.script, "c"),
          ffmpegExecutable: process.execPath, __testHooks: { runFrameBatch: frameHook([]) },
        });
        concurrentPair = await Promise.all([readFile(indexPath), readFile(vectorPath)]);
      },
    },
  } as FootageIndexerTestHooks;
  await assert.rejects(indexProjectFootage({
    projectRoot: fixture.root, rootLocator: "media", outputLocator: fixture.output, backend: backend(fixture.script),
    ffmpegExecutable: process.execPath, __testHooks: hooks,
  }), (error: unknown) => error instanceof CutFootageError && error.code === "CUT_FOOTAGE_PUBLISH" && !error.message.includes(fixture.root));
  assert.ok(concurrentPair);
  assert.deepEqual(await Promise.all([readFile(indexPath), readFile(vectorPath)]), concurrentPair);
});

test("publication admission preserves concurrent same-inode index and vector writes", { timeout: 60_000, skip: process.platform === "win32" }, async () => {
  for (const targetRole of ["index", "vector"] as const) {
    const fixture = await fixtureProject(false);
    await indexProjectFootage({
      projectRoot: fixture.root, rootLocator: "media", outputLocator: fixture.output, backend: backend(fixture.script),
      ffmpegExecutable: process.execPath, __testHooks: { runFrameBatch: frameHook([]) },
    });
    await appendFile(join(fixture.root, "media/a.mp4"), Buffer.from([0]));
    const indexPath = join(fixture.root, fixture.output), vectorPath = join(fixture.root, ".cut/footage/index.vectors");
    const target = targetRole === "index" ? indexPath : vectorPath;
    const concurrentBytes = Buffer.from(`concurrent same-inode ${targetRole}\n`);
    const before = await lstat(target, { bigint: true });
    await assert.rejects(indexProjectFootage({
      projectRoot: fixture.root, rootLocator: "media", outputLocator: fixture.output, backend: backend(fixture.script),
      ffmpegExecutable: process.execPath,
      __testHooks: {
        runFrameBatch: frameHook([]),
        async beforePublication() { await writeFile(target, concurrentBytes); },
      },
    }), (error: unknown) => error instanceof CutFootageError && error.code === "CUT_FOOTAGE_INDEX_STALE");
    const after = await lstat(target, { bigint: true });
    assert.equal(after.dev, before.dev);
    assert.equal(after.ino, before.ino, "the test must mutate the admitted destination inode in place");
    assert.deepEqual(await readFile(target), concurrentBytes, "CUT must preserve the concurrent writer's exact bytes");
  }
});

test("source authority changes inside either publication verifier phase restore the prior pair", { timeout: 60_000, skip: process.platform === "win32" }, async () => {
  const injections = [
    { phase: "backup", timing: "after" },
    { phase: "promotion", timing: "after" },
  ] as const;
  for (const injection of injections) {
    const fixture = await fixtureProject(false);
    await indexProjectFootage({
      projectRoot: fixture.root, rootLocator: "media", outputLocator: fixture.output, backend: backend(fixture.script),
      ffmpegExecutable: process.execPath, __testHooks: { runFrameBatch: frameHook([]) },
    });
    const indexPath = join(fixture.root, fixture.output), vectorPath = join(fixture.root, ".cut/footage/index.vectors");
    const priorPair = await Promise.all([readFile(indexPath), readFile(vectorPath)]);
    const sourcePath = join(fixture.root, "media/a.mp4");
    await appendFile(sourcePath, Buffer.from([0]));
    let injected = false;
    await assert.rejects(indexProjectFootage({
      projectRoot: fixture.root, rootLocator: "media", outputLocator: fixture.output, backend: backend(fixture.script),
      ffmpegExecutable: process.execPath,
      __testHooks: {
        runFrameBatch: frameHook([]),
        publication: {
          async fault(point) {
            if (injected || point.phase !== injection.phase || point.timing !== injection.timing || point.role !== "footage-index") return;
            injected = true;
            await appendFile(sourcePath, Buffer.from([1]));
          },
        },
      },
    }), (error: unknown) => error instanceof CutFootageError && error.code === "CUT_FOOTAGE_INDEX_STALE");
    assert.equal(injected, true);
    assert.deepEqual(await Promise.all([readFile(indexPath), readFile(vectorPath)]), priorPair);
  }
});

test("abort inside the final publication verifier restores the prior pair", { timeout: 30_000, skip: process.platform === "win32" }, async () => {
  const fixture = await fixtureProject(false);
  await indexProjectFootage({
    projectRoot: fixture.root, rootLocator: "media", outputLocator: fixture.output, backend: backend(fixture.script),
    ffmpegExecutable: process.execPath, __testHooks: { runFrameBatch: frameHook([]) },
  });
  const indexPath = join(fixture.root, fixture.output), vectorPath = join(fixture.root, ".cut/footage/index.vectors");
  const priorPair = await Promise.all([readFile(indexPath), readFile(vectorPath)]);
  await appendFile(join(fixture.root, "media/a.mp4"), Buffer.from([0]));
  const controller = new AbortController();
  await assert.rejects(indexProjectFootage({
    projectRoot: fixture.root, rootLocator: "media", outputLocator: fixture.output, backend: backend(fixture.script),
    ffmpegExecutable: process.execPath, signal: controller.signal,
    __testHooks: {
      runFrameBatch: frameHook([]),
      publication: {
        fault(point) {
          if (point.phase === "promotion" && point.timing === "after" && point.role === "footage-index") controller.abort();
        },
      },
    },
  }), (error: unknown) => error instanceof CutFootageError
    && error.code === "CUT_FOOTAGE_BACKEND_PROTOCOL"
    && error.path === "$signal");
  assert.deepEqual(await Promise.all([readFile(indexPath), readFile(vectorPath)]), priorPair);
});

test("a source changed and byte-restored during inference is still rejected as stale", { timeout: 30_000, skip: process.platform === "win32" }, async () => {
  const fixture = await fixtureProject(false);
  const sourcePath = join(fixture.root, "media/a.mp4"), original = await readFile(sourcePath);
  await assert.rejects(indexProjectFootage({
    projectRoot: fixture.root, rootLocator: "media", outputLocator: fixture.output, backend: backend(fixture.script),
    ffmpegExecutable: process.execPath,
    __testHooks: {
      runFrameBatch: frameHook([]),
      async afterFrames() { await appendFile(sourcePath, Buffer.from([0])); },
      async beforeSourceRecheck() { await writeFile(sourcePath, original); },
    },
  }), (error: unknown) => error instanceof CutFootageError && error.code === "CUT_FOOTAGE_INDEX_STALE");
  assert.deepEqual((await readdir(join(fixture.root, ".cut/footage"))).filter((name) => name.endsWith(".json") || name.endsWith(".vectors")), []);
});

test("a source changed after the multi-source hash pass cannot enter the published index", { timeout: 30_000, skip: process.platform === "win32" }, async () => {
  const fixture = await fixtureProject(true);
  const sourcePath = join(fixture.root, "media/a.mp4");
  const hooks = {
    runFrameBatch: frameHook([]),
    async beforePublication() { await appendFile(sourcePath, Buffer.from([0])); },
  } as FootageIndexerTestHooks;
  await assert.rejects(indexProjectFootage({
    projectRoot: fixture.root, rootLocator: "media", outputLocator: fixture.output, backend: backend(fixture.script),
    ffmpegExecutable: process.execPath, __testHooks: hooks,
  }), (error: unknown) => error instanceof CutFootageError && error.code === "CUT_FOOTAGE_INDEX_STALE");
  assert.deepEqual((await readdir(join(fixture.root, ".cut/footage"))).filter((name) => name.endsWith(".json") || name.endsWith(".vectors")), []);
});

test("full reuse rejects a source changed after the multi-source hash pass", { timeout: 30_000, skip: process.platform === "win32" }, async () => {
  const fixture = await fixtureProject(true);
  await indexProjectFootage({
    projectRoot: fixture.root, rootLocator: "media", outputLocator: fixture.output, backend: backend(fixture.script),
    ffmpegExecutable: process.execPath, __testHooks: { runFrameBatch: frameHook([]) },
  });
  const indexPath = join(fixture.root, fixture.output), vectorPath = join(fixture.root, ".cut/footage/index.vectors");
  const before = await Promise.all([readFile(indexPath), readFile(vectorPath)]);
  const sourcePath = join(fixture.root, "media/a.mp4");
  await assert.rejects(indexProjectFootage({
    projectRoot: fixture.root, rootLocator: "media", outputLocator: fixture.output, backend: backend(fixture.script),
    ffmpegExecutable: process.execPath,
    __testHooks: {
      async afterSourceRecheck() { await appendFile(sourcePath, Buffer.from([0])); },
    },
  }), (error: unknown) => error instanceof CutFootageError && error.code === "CUT_FOOTAGE_INDEX_STALE");
  assert.deepEqual(await Promise.all([readFile(indexPath), readFile(vectorPath)]), before);
});

test("full reuse seals all 301 sources after a timer mutation during the final awaited boundary", { timeout: 120_000, skip: process.platform === "win32" }, async () => {
  const root = join(await mkdtemp(join(tmpdir(), "cut-footage-indexer-reuse-seal-")), "project");
  await createCutProject(root, "Footage full reuse seal");
  const locators = Array.from({ length: 301 }, (_unused, index) => `media/${String(index).padStart(3, "0")}.mp4`);
  await Promise.all(locators.map((locator) => copyFile(resolve("examples/media/demo.mp4"), join(root, locator))));
  const script = await deterministicSidecar(join(root, ".cut")), output = ".cut/footage/index.json";
  try {
    await indexProjectFootage({
      projectRoot: root, rootLocator: "media", outputLocator: output, backend: backend(script),
      ffmpegExecutable: process.execPath, __testHooks: { runFrameBatch: frameHook([]) },
    });
    const indexPath = join(root, output), vectorPath = join(root, ".cut/footage/index.vectors");
    const priorPair = await Promise.all([readFile(indexPath), readFile(vectorPath)]);
    const sourcePath = join(root, locators[0]!);
    let mutationResolve!: () => void, mutationReject!: (error: unknown) => void;
    const mutation = new Promise<void>((resolveMutation, rejectMutation) => {
      mutationResolve = resolveMutation;
      mutationReject = rejectMutation;
    });
    try {
      await assert.rejects(indexProjectFootage({
        projectRoot: root, rootLocator: "media", outputLocator: output, backend: backend(script),
        ffmpegExecutable: process.execPath,
        __testHooks: {
          async afterSourceRecheck() {
            const mutator = spawn("/bin/sh", ["-c", "sleep 0.005; printf x >> \"$1\"", "cut-source-mutator", sourcePath], {
              stdio: "ignore",
            });
            mutator.once("error", mutationReject);
            mutator.once("close", (code, signal) => {
              if (code === 0 && signal === null) mutationResolve();
              else mutationReject(new Error(`source mutator failed with ${code ?? signal ?? "unknown status"}`));
            });
          },
        },
      }), (error: unknown) => error instanceof CutFootageError && error.code === "CUT_FOOTAGE_INDEX_STALE");
    } finally { await mutation; }
    assert.deepEqual(await Promise.all([readFile(indexPath), readFile(vectorPath)]), priorPair);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
