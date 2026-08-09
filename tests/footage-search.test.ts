import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { stableJsonStringify } from "../lib/core/stable";
import { createCutProject } from "../lib/project";
import { parseCutFootageIndex, type CutFootageIndex } from "../lib/footage/contracts";
import { CutFootageError } from "../lib/footage/diagnostics";
import { encodeCutFootageVectorArtifact } from "../lib/footage/indexer";
import { defaultFootageChunkPolicy, planFootageSources } from "../lib/footage/planner";
import {
  buildCutFootageSearchReport,
  normalizeCutFootageQuery,
  quantizeCutFootageScorePpm,
  rankCutFootageCandidates,
  searchProjectFootage,
  type SearchProjectFootageOptions,
} from "../lib/footage/search";
import type { CutFootageLocalInstall } from "../lib/footage/setup";
import type { CutFootageSidecarHandshake, CutFootageSidecarSession } from "../lib/footage/sidecar";
import { rational } from "../lib/language/rational";

const digest = (digit: string) => digit.repeat(64);
const range = (start: number, end: number) => Object.freeze({ semantics: "half-open" as const, start: rational(start), end: rational(end) });

function fixtureIndex(): CutFootageIndex {
  const streams = Object.freeze([{ index: 0, type: "video" as const, timeBase: rational(1, 30), frameRate: rational(30) }]);
  const sources = Object.freeze([
    Object.freeze({ locator: "media/a.mp4", bytes: 10, sha256: digest("a"), duration: rational(20), probeSha256: digest("b"), streams }),
    Object.freeze({ locator: "media/b.mp4", bytes: 11, sha256: digest("c"), duration: rational(20), probeSha256: digest("d"), streams }),
  ]);
  const chunks = Object.freeze([
    Object.freeze({ id: "chunk-a0", sourceLocator: "media/a.mp4", sourceSha256: digest("a"), streamIndex: 0, range: range(0, 8) }),
    Object.freeze({ id: "chunk-a1", sourceLocator: "media/a.mp4", sourceSha256: digest("a"), streamIndex: 0, range: range(6, 14) }),
    Object.freeze({ id: "chunk-a2", sourceLocator: "media/a.mp4", sourceSha256: digest("a"), streamIndex: 0, range: range(14, 20) }),
    Object.freeze({ id: "chunk-b0", sourceLocator: "media/b.mp4", sourceSha256: digest("c"), streamIndex: 0, range: range(0, 8) }),
  ]);
  return Object.freeze({
    format: "cut-footage-index", version: 1, root: "media", sources,
    chunkPolicy: Object.freeze({ duration: rational(8), overlap: rational(2) }), chunks,
    backend: Object.freeze({ protocolVersion: 1, provider: "fixture", model: "clip@r1+adapter.abc", dimensions: 4, normalization: "l2" }),
    vectorArtifact: Object.freeze({ locator: ".cut/footage.vectors", bytes: 100, sha256: digest("e") }),
    creation: Object.freeze({ cutVersion: "0.4.0-test", backendProtocolVersion: 1 }), indexSha256: digest("f"),
  });
}

function protocol(action: () => unknown) {
  assert.throws(action, (error: unknown) => error instanceof CutFootageError && error.code === "CUT_FOOTAGE_BACKEND_PROTOCOL");
}

test("footage query normalization is exact NFKC plus trim and bounded UTF-8", () => {
  assert.equal(normalizeCutFootageQuery("  Ｄｏｇ   outdoors  "), "Dog   outdoors");
  for (const value of [undefined, "", "   ", "dog\npark", "x".repeat(16_385)]) protocol(() => normalizeCutFootageQuery(value));
  protocol(() => normalizeCutFootageQuery("ﬃ".repeat(1_500)));
});

test("footage score quantization clamps, rounds once, and never returns negative zero", () => {
  assert.equal(quantizeCutFootageScorePpm(2), 1_000_000);
  assert.equal(quantizeCutFootageScorePpm(-2), -1_000_000);
  assert.equal(quantizeCutFootageScorePpm(0.0000005), 1);
  assert.equal(quantizeCutFootageScorePpm(-0.0000005), 0);
  assert.equal(Object.is(quantizeCutFootageScorePpm(-0), -0), false);
  for (const value of [NaN, Infinity, -Infinity, "0.5"]) protocol(() => quantizeCutFootageScorePpm(value));
});

test("ranking is enumeration-independent, inclusive, and suppresses only positive same-source overlap", () => {
  const index = fixtureIndex();
  const candidates = [
    { chunkId: "chunk-a1", score: 0.9 },
    { chunkId: "chunk-a2", score: 0.8 },
    { chunkId: "chunk-b0", score: 0.9 },
    { chunkId: "chunk-a0", score: 0.9 },
  ];
  const expected = rankCutFootageCandidates(index, candidates, { thresholdPpm: 800_000, limit: 10 });
  const shuffled = rankCutFootageCandidates(index, [...candidates].reverse(), { thresholdPpm: 800_000, limit: 10 });
  assert.deepEqual(shuffled, expected);
  assert.deepEqual(expected.map((match) => [match.sourceSelection.locator, match.chunkIds[0], match.scorePpm]), [
    ["media/a.mp4", "chunk-a0", 900_000],
    ["media/b.mp4", "chunk-b0", 900_000],
    ["media/a.mp4", "chunk-a2", 800_000],
  ]);
  assert.equal(expected.every((match) => /^match-[a-f0-9]{64}$/u.test(match.id)), true);
});

test("ranking fails closed for candidate-set drift and invalid limits", () => {
  const index = fixtureIndex(), candidates = index.chunks.map((chunk) => ({ chunkId: chunk.id, score: 0.5 }));
  protocol(() => rankCutFootageCandidates(index, candidates.slice(1), { thresholdPpm: 0, limit: 10 }));
  protocol(() => rankCutFootageCandidates(index, [...candidates, candidates[0]!], { thresholdPpm: 0, limit: 10 }));
  protocol(() => rankCutFootageCandidates(index, [{ ...candidates[0]!, chunkId: "unknown" }, ...candidates.slice(1)], { thresholdPpm: 0, limit: 10 }));
  protocol(() => rankCutFootageCandidates(index, candidates, { thresholdPpm: 1_000_001, limit: 10 }));
  protocol(() => rankCutFootageCandidates(index, candidates, { thresholdPpm: 0, limit: 0 }));
});

test("ranking permits an honest deterministic empty match list", () => {
  const index = fixtureIndex(), candidates = index.chunks.map((chunk) => ({ chunkId: chunk.id, score: -0.5 }));
  assert.deepEqual(rankCutFootageCandidates(index, candidates, { thresholdPpm: 0, limit: 10 }), []);
});

test("search report bytes and identity do not depend on candidate enumeration", () => {
  const index = fixtureIndex(), candidates = index.chunks.map((chunk, ordinal) => ({ chunkId: chunk.id, score: 0.9 - ordinal / 10 }));
  const left = buildCutFootageSearchReport(index, ".cut/footage/index.json", "  Ｄｏｇ outdoors  ", candidates, { thresholdPpm: 0, limit: 10 });
  const right = buildCutFootageSearchReport(index, ".cut/footage/index.json", "Dog outdoors", [...candidates].reverse(), { thresholdPpm: 0, limit: 10 });
  assert.deepEqual(left, right);
  assert.equal(left.report.query.text, "Dog outdoors");
  assert.equal(left.report.indexLocator, ".cut/footage/index.json");
  assert.equal(left.bytes.at(-1), 10);
  assert.match(left.report.searchSha256, /^[a-f0-9]{64}$/u);
});

test("footage index and search canonical ordering is UTF-8 bytewise under Swedish and German locales", () => {
  const contractsUrl = pathToFileURL(resolve("dist-cli/lib/footage/contracts.js")).href;
  const searchUrl = pathToFileURL(resolve("dist-cli/lib/footage/search.js")).href;
  const stableUrl = pathToFileURL(resolve("dist-cli/lib/core/stable.js")).href;
  const script = `
    import { createHash } from "node:crypto";
    import { parseCutFootageIndex } from ${JSON.stringify(contractsUrl)};
    import { rankCutFootageCandidates } from ${JSON.stringify(searchUrl)};
    import { stableJsonStringify } from ${JSON.stringify(stableUrl)};
    const sha = (digit) => digit.repeat(64);
    const time = (numerator, denominator = "1") => ({ numerator, denominator });
    const range = { semantics: "half-open", start: time("0"), end: time("1") };
    const stream = [{ index: 0, type: "video", timeBase: time("1", "24"), frameRate: time("24") }];
    const body = {
      format: "cut-footage-index", version: 1, root: "media",
      sources: [
        { locator: "media/z.mp4", bytes: 1, sha256: sha("a"), duration: time("1"), probeSha256: sha("b"), streams: stream },
        { locator: "media/ä.mp4", bytes: 1, sha256: sha("c"), duration: time("1"), probeSha256: sha("d"), streams: stream },
      ],
      chunkPolicy: { duration: time("1"), overlap: time("0") },
      chunks: [
        { id: "chunk-z", sourceLocator: "media/z.mp4", sourceSha256: sha("a"), streamIndex: 0, range },
        { id: "chunk-umlaut", sourceLocator: "media/ä.mp4", sourceSha256: sha("c"), streamIndex: 0, range },
      ],
      backend: { protocolVersion: 1, provider: "fixture", model: "clip", dimensions: 2, normalization: "l2" },
      vectorArtifact: { locator: ".cut/footage/index.vectors", bytes: 1, sha256: sha("e") },
      creation: { cutVersion: "test", backendProtocolVersion: 1 },
    };
    const indexSha256 = createHash("sha256").update(stableJsonStringify(body)).digest("hex");
    const index = parseCutFootageIndex(stableJsonStringify({ ...body, indexSha256 }));
    const matches = rankCutFootageCandidates(index, [
      { chunkId: "chunk-umlaut", score: 0.5 },
      { chunkId: "chunk-z", score: 0.5 },
    ], { thresholdPpm: 0, limit: 2 });
    process.stdout.write(JSON.stringify(matches.map((match) => match.sourceSelection.locator)));
  `;
  for (const locale of ["sv_SE.UTF-8", "de_DE.UTF-8"]) {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, LANG: locale, LC_ALL: locale },
    });
    assert.equal(child.status, 0, `${locale}: ${child.stderr}`);
    assert.equal(child.stdout, '["media/z.mp4","media/ä.mp4"]', locale);
  }
});

async function workflowFixture() {
  const root = join(await mkdtemp(join(tmpdir(), "cut-footage-search-workflow-")), "project");
  await createCutProject(root, "Footage search");
  await copyFile(resolve("examples/media/demo.mp4"), join(root, "media/a.mp4"));
  const handshake: CutFootageSidecarHandshake = Object.freeze({
    format: "cut-footage-sidecar-handshake", version: 1, protocolVersion: 1,
    provider: "fixture", model: "deterministic-clip", revision: "r1", dimensions: 512,
    normalization: "l2", modalities: Object.freeze(["image", "text"] as const), hardware: "cpu",
    adapterSha256: digest("a"), selfTestSha256: digest("b"),
  });
  const backend = Object.freeze({
    protocolVersion: 1 as const, provider: handshake.provider,
    model: `${handshake.model}@${handshake.revision}+adapter.${handshake.adapterSha256}`,
    dimensions: 512, normalization: "l2" as const,
  });
  const plan = await planFootageSources({ projectRoot: root, locators: ["media/a.mp4"], backend });
  const vectorBytes = Buffer.from(encodeCutFootageVectorArtifact({
    dimensions: 512,
    planSha256: digest("c"),
    records: plan.chunks.map((chunk, ordinal) => {
      const vector = new Float32Array(512); vector[ordinal % 512] = 1;
      return Object.freeze({ chunkId: chunk.id, vector });
    }),
  }));
  const vectorLocator = ".cut/footage/index.vectors", indexLocator = ".cut/footage/index.json";
  const body = Object.freeze({
    format: "cut-footage-index" as const, version: 1 as const, root: "media",
    sources: Object.freeze(plan.sources.map((source) => source.source)), chunkPolicy: defaultFootageChunkPolicy,
    chunks: Object.freeze(plan.chunks.map((chunk) => Object.freeze({
      id: chunk.id, sourceLocator: chunk.sourceLocator, sourceSha256: chunk.sourceSha256, streamIndex: chunk.streamIndex, range: chunk.range,
    }))),
    backend,
    vectorArtifact: Object.freeze({ locator: vectorLocator, bytes: vectorBytes.byteLength, sha256: createHash("sha256").update(vectorBytes).digest("hex") }),
    creation: Object.freeze({ cutVersion: "0.4.0-test", backendProtocolVersion: 1 as const }),
  });
  const index = parseCutFootageIndex(`${stableJsonStringify({ ...body, indexSha256: createHash("sha256").update(stableJsonStringify(body)).digest("hex") })}\n`);
  await mkdir(join(root, ".cut/footage"), { recursive: true });
  await Promise.all([
    writeFile(join(root, indexLocator), `${stableJsonStringify(index)}\n`),
    writeFile(join(root, vectorLocator), vectorBytes),
  ]);
  const install = { root: join(root, ".fake-footage-home/.payload"), manifest: { handshake } } as unknown as CutFootageLocalInstall;
  return { root, index, indexLocator, vectorLocator, handshake, install };
}

function changedIndexBytes(index: CutFootageIndex) {
  const { indexSha256: _oldIdentity, ...body } = index;
  const changed = { ...body, creation: { ...body.creation, cutVersion: "0.4.0-valid-replacement" } };
  const indexSha256 = createHash("sha256").update(stableJsonStringify(changed)).digest("hex");
  return Buffer.from(`${stableJsonStringify({ ...changed, indexSha256 })}\n`, "utf8");
}

function searchSession(handshake: CutFootageSidecarHandshake, candidates: readonly Readonly<{ chunkId: string; score: number }>[], onClose?: () => void): CutFootageSidecarSession {
  return Object.freeze({
    handshake, pid: undefined,
    async index() { throw new Error("not used by search"); },
    async searchText() { return candidates; },
    async close() { onClose?.(); },
  });
}

test("search workflow revalidates, closes inference, and publishes canonical bytes", { timeout: 30_000 }, async () => {
  const fixture = await workflowFixture();
  const candidates = fixture.index.chunks.map((chunk, ordinal) => ({ chunkId: chunk.id, score: 0.9 - ordinal / 10 }));
  let closed = 0;
  const result = await searchProjectFootage({
    projectRoot: fixture.root, indexLocator: fixture.indexLocator, outputLocator: ".cut/footage/search.json",
    query: "  Ｄｏｇ outdoors ", backendInstall: fixture.install,
    __testHooks: { async startSidecar() { return searchSession(fixture.handshake, [...candidates].reverse(), () => { closed += 1; }); } },
  });
  assert.equal(closed, 1);
  assert.equal(result.report.query.text, "Dog outdoors");
  assert.deepEqual(await readFile(result.outputPath), result.bytes);
  assert.equal(result.bytes.at(-1), 10);
});

test("search workflow rejects backend and post-inference source drift before publication", { timeout: 30_000 }, async () => {
  const fixture = await workflowFixture();
  const outputLocator = ".cut/footage/search.json", candidates = fixture.index.chunks.map((chunk) => ({ chunkId: chunk.id, score: 0.5 }));
  const wrong = { ...fixture.install, manifest: { ...fixture.install.manifest, handshake: { ...fixture.handshake, revision: "wrong" } } } as CutFootageLocalInstall;
  let started = false;
  await assert.rejects(searchProjectFootage({
    projectRoot: fixture.root, indexLocator: fixture.indexLocator, outputLocator, query: "dog", backendInstall: wrong,
    __testHooks: { async startSidecar() { started = true; return searchSession(fixture.handshake, candidates); } },
  }), (error: unknown) => error instanceof CutFootageError && error.code === "CUT_FOOTAGE_MODEL_MISMATCH");
  assert.equal(started, false);

  await assert.rejects(searchProjectFootage({
    projectRoot: fixture.root, indexLocator: fixture.indexLocator, outputLocator, query: "dog", limit: 0, backendInstall: fixture.install,
    __testHooks: { async startSidecar() { started = true; return searchSession(fixture.handshake, candidates); } },
  }), (error: unknown) => error instanceof CutFootageError && error.code === "CUT_FOOTAGE_BACKEND_PROTOCOL");
  assert.equal(started, false);

  await assert.rejects(searchProjectFootage({
    projectRoot: fixture.root, indexLocator: fixture.indexLocator, outputLocator, query: "dog", backendInstall: fixture.install,
    __testHooks: {
      async startSidecar() { return searchSession(fixture.handshake, candidates); },
      async afterInference() { await appendFile(join(fixture.root, "media/a.mp4"), Buffer.from([0])); },
    },
  }), (error: unknown) => error instanceof CutFootageError && error.code === "CUT_FOOTAGE_INDEX_STALE");
  await assert.rejects(readFile(join(fixture.root, outputLocator)), { code: "ENOENT" });
});

test("search workflow reloads its index locator and rejects a changed valid index after inference", { timeout: 30_000 }, async () => {
  const fixture = await workflowFixture();
  const outputLocator = ".cut/footage/search.json";
  const candidates = fixture.index.chunks.map((chunk) => ({ chunkId: chunk.id, score: 0.5 }));
  await assert.rejects(searchProjectFootage({
    projectRoot: fixture.root, indexLocator: fixture.indexLocator, outputLocator, query: "dog", backendInstall: fixture.install,
    __testHooks: {
      async startSidecar() { return searchSession(fixture.handshake, candidates); },
      async afterInference() { await writeFile(join(fixture.root, fixture.indexLocator), changedIndexBytes(fixture.index)); },
    },
  }), (error: unknown) => error instanceof CutFootageError && error.code === "CUT_FOOTAGE_INDEX_STALE");
  await assert.rejects(readFile(join(fixture.root, outputLocator)), { code: "ENOENT" });
});

test("search workflow preserves a foreign output that appears after admission", { timeout: 30_000 }, async () => {
  const fixture = await workflowFixture();
  const outputLocator = ".cut/footage/search.json", outputPath = join(fixture.root, outputLocator);
  const foreign = Buffer.from("foreign concurrent report\n", "utf8");
  const candidates = fixture.index.chunks.map((chunk) => ({ chunkId: chunk.id, score: 0.5 }));
  await assert.rejects(searchProjectFootage({
    projectRoot: fixture.root, indexLocator: fixture.indexLocator, outputLocator, query: "dog", backendInstall: fixture.install,
    __testHooks: {
      async startSidecar() { return searchSession(fixture.handshake, candidates); },
      async afterInference() { await writeFile(outputPath, foreign, { flag: "wx" }); },
    },
  }), (error: unknown) => error instanceof CutFootageError && error.code === "CUT_FOOTAGE_PUBLISH");
  assert.deepEqual(await readFile(outputPath), foreign);
});

test("search workflow replaces only the output inode admitted before inference", { timeout: 30_000 }, async () => {
  const fixture = await workflowFixture();
  const outputLocator = ".cut/footage/search.json", outputPath = join(fixture.root, outputLocator);
  const candidates = fixture.index.chunks.map((chunk) => ({ chunkId: chunk.id, score: 0.5 }));
  await writeFile(outputPath, "previous CUT report\n");
  const replaced = await searchProjectFootage({
    projectRoot: fixture.root, indexLocator: fixture.indexLocator, outputLocator, query: "dog", backendInstall: fixture.install,
    __testHooks: { async startSidecar() { return searchSession(fixture.handshake, candidates); } },
  });
  assert.deepEqual(await readFile(outputPath), replaced.bytes);

  const sameInodeForeign = Buffer.from("foreign same-inode edit\n", "utf8"), admittedInode = (await lstat(outputPath)).ino;
  await assert.rejects(searchProjectFootage({
    projectRoot: fixture.root, indexLocator: fixture.indexLocator, outputLocator, query: "dog", backendInstall: fixture.install,
    __testHooks: {
      async startSidecar() { return searchSession(fixture.handshake, candidates); },
      async afterInference() { await writeFile(outputPath, sameInodeForeign); },
    },
  }), (error: unknown) => error instanceof CutFootageError && error.code === "CUT_FOOTAGE_PUBLISH");
  assert.equal((await lstat(outputPath)).ino, admittedInode);
  assert.deepEqual(await readFile(outputPath), sameInodeForeign);

  const foreign = Buffer.from("foreign replacement\n", "utf8"), stagedForeign = `${outputPath}.foreign`;
  await assert.rejects(searchProjectFootage({
    projectRoot: fixture.root, indexLocator: fixture.indexLocator, outputLocator, query: "dog", backendInstall: fixture.install,
    __testHooks: {
      async startSidecar() { return searchSession(fixture.handshake, candidates); },
      async afterInference() {
        await writeFile(stagedForeign, foreign, { flag: "wx" });
        await rename(stagedForeign, outputPath);
      },
    },
  }), (error: unknown) => error instanceof CutFootageError && error.code === "CUT_FOOTAGE_PUBLISH");
  assert.deepEqual(await readFile(outputPath), foreign);
});

test("search workflow honors cancellation after final index revalidation and before commit", { timeout: 30_000 }, async () => {
  const fixture = await workflowFixture();
  const controller = new AbortController();
  const candidates = fixture.index.chunks.map((chunk) => ({ chunkId: chunk.id, score: 0.5 }));
  const hooks = {
    async startSidecar() { return searchSession(fixture.handshake, candidates); },
    async afterFinalRevalidation() { controller.abort(); },
  } as unknown as NonNullable<SearchProjectFootageOptions["__testHooks"]>;
  await assert.rejects(searchProjectFootage({
    projectRoot: fixture.root, indexLocator: fixture.indexLocator, outputLocator: ".cut/footage/search.json",
    query: "dog", backendInstall: fixture.install, signal: controller.signal, __testHooks: hooks,
  }), (error: unknown) => error instanceof CutFootageError && error.code === "CUT_FOOTAGE_BACKEND_PROTOCOL" && error.path === "$signal");
  await assert.rejects(readFile(join(fixture.root, ".cut/footage/search.json")), { code: "ENOENT" });
});

test("search workflow maps missing and empty index files to one stable path-free boundary", { timeout: 30_000 }, async () => {
  const fixture = await workflowFixture();
  const indexPath = join(fixture.root, fixture.indexLocator), errors: CutFootageError[] = [];
  for (const state of ["missing", "empty"] as const) {
    if (state === "missing") await rm(indexPath);
    else await writeFile(indexPath, "", { flag: "wx" });
    try {
      await searchProjectFootage({
        projectRoot: fixture.root, indexLocator: fixture.indexLocator, outputLocator: ".cut/footage/search.json",
        query: "dog", backendInstall: fixture.install,
      });
      assert.fail(`${state} index unexpectedly searched`);
    } catch (error) {
      assert.ok(error instanceof CutFootageError);
      errors.push(error);
    }
    if (state === "missing") continue;
    await rm(indexPath);
  }
  assert.equal(errors.length, 2);
  for (const error of errors) {
    assert.equal(error.code, "CUT_FOOTAGE_INDEX_STALE");
    assert.equal(error.path, "$.indexLocator");
    assert.equal(error.message, "CUT_FOOTAGE_INDEX_STALE at $.indexLocator: the footage index could not be loaded as one current bounded report.");
    assert.equal(error.message.includes(fixture.root), false);
  }
});

test("search publication authority rejects index and source drift after final revalidation", { timeout: 30_000 }, async () => {
  for (const mutation of ["index", "source"] as const) {
    const fixture = await workflowFixture();
    const outputLocator = ".cut/footage/search.json";
    const candidates = fixture.index.chunks.map((chunk) => ({ chunkId: chunk.id, score: 0.5 }));
    await assert.rejects(searchProjectFootage({
      projectRoot: fixture.root, indexLocator: fixture.indexLocator, outputLocator, query: "dog", backendInstall: fixture.install,
      __testHooks: {
        async startSidecar() { return searchSession(fixture.handshake, candidates); },
        async afterFinalRevalidation() {
          if (mutation === "index") await writeFile(join(fixture.root, fixture.indexLocator), changedIndexBytes(fixture.index));
          else await appendFile(join(fixture.root, "media/a.mp4"), Buffer.from([0]));
        },
      },
    }), (error: unknown) => error instanceof CutFootageError && error.code === "CUT_FOOTAGE_INDEX_STALE" && error.path === "$.indexLocator", mutation);
    await assert.rejects(readFile(join(fixture.root, outputLocator)), { code: "ENOENT" });
  }
});

test("search authority failure after promotion restores an admitted report or absent output", { timeout: 30_000 }, async () => {
  for (const prior of ["absent", "admitted"] as const) {
    const fixture = await workflowFixture();
    const outputLocator = ".cut/footage/search.json", outputPath = join(fixture.root, outputLocator);
    const candidates = fixture.index.chunks.map((chunk) => ({ chunkId: chunk.id, score: 0.5 }));
    let admittedBytes: Buffer | undefined, admittedInode: number | undefined;
    if (prior === "admitted") {
      const first = await searchProjectFootage({
        projectRoot: fixture.root, indexLocator: fixture.indexLocator, outputLocator, query: "first dog", backendInstall: fixture.install,
        __testHooks: { async startSidecar() { return searchSession(fixture.handshake, candidates); } },
      });
      admittedBytes = Buffer.from(first.bytes); admittedInode = (await lstat(outputPath)).ino;
    }
    const hooks = {
      async startSidecar() { return searchSession(fixture.handshake, candidates); },
      async beforePublicationFinalize() { await appendFile(join(fixture.root, "media/a.mp4"), Buffer.from([0])); },
    } as unknown as NonNullable<SearchProjectFootageOptions["__testHooks"]>;
    await assert.rejects(searchProjectFootage({
      projectRoot: fixture.root, indexLocator: fixture.indexLocator, outputLocator, query: "second dog", backendInstall: fixture.install,
      __testHooks: hooks,
    }), (error: unknown) => error instanceof CutFootageError && error.code === "CUT_FOOTAGE_INDEX_STALE" && error.path === "$.indexLocator", prior);
    if (admittedBytes) {
      assert.deepEqual(await readFile(outputPath), admittedBytes);
      assert.equal((await lstat(outputPath)).ino, admittedInode);
    } else {
      await assert.rejects(lstat(outputPath), { code: "ENOENT" });
    }
  }
});

test("search cancellation scheduled during artifact staging rolls back before commit", { timeout: 30_000 }, async () => {
  const fixture = await workflowFixture(), controller = new AbortController();
  const outputPath = join(fixture.root, ".cut/footage/search.json");
  const candidates = fixture.index.chunks.map((chunk) => ({ chunkId: chunk.id, score: 0.5 }));
  await assert.rejects(searchProjectFootage({
    projectRoot: fixture.root, indexLocator: fixture.indexLocator, outputLocator: ".cut/footage/search.json",
    query: "dog", backendInstall: fixture.install, signal: controller.signal,
    __testHooks: {
      async startSidecar() { return searchSession(fixture.handshake, candidates); },
      afterFinalRevalidation() { setTimeout(() => controller.abort(), 0); },
    },
  }), (error: unknown) => error instanceof CutFootageError && error.code === "CUT_FOOTAGE_BACKEND_PROTOCOL" && error.path === "$signal");
  await assert.rejects(lstat(outputPath), { code: "ENOENT" });
});

test("vector and source revalidation failures stay in one stable path-free search boundary", { timeout: 30_000 }, async () => {
  for (const missing of ["vector", "source"] as const) {
    const fixture = await workflowFixture();
    await rm(join(fixture.root, missing === "vector" ? fixture.vectorLocator : "media/a.mp4"));
    let caught: unknown;
    try {
      await searchProjectFootage({
        projectRoot: fixture.root, indexLocator: fixture.indexLocator, outputLocator: ".cut/footage/search.json",
        query: "dog", backendInstall: fixture.install,
      });
    } catch (error) { caught = error; }
    assert.ok(caught instanceof CutFootageError, missing);
    assert.equal(caught.code, "CUT_FOOTAGE_INDEX_STALE", missing);
    assert.equal(caught.path, "$.indexLocator", missing);
    assert.equal(caught.message, "CUT_FOOTAGE_INDEX_STALE at $.indexLocator: the footage index vector and source authority could not be revalidated safely.", missing);
    assert.equal(caught.message.includes(fixture.root), false, missing);
  }
});
