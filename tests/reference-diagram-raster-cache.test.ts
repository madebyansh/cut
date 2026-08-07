import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  createReferenceDiagramRasterCache,
  referenceDiagramRasterCacheIdentity,
  referenceDiagramRasterCacheNamespace,
  ReferenceDiagramRasterCacheError,
  type ReferenceDiagramRasterCacheIdentityInput,
} from "../lib/runtime/reference/diagram-raster-cache";
import { cutReferenceRuntimeIdentity } from "../lib/version";

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function identity(
  name: string,
  options: Partial<Pick<ReferenceDiagramRasterCacheIdentityInput, "kind" | "width" | "height">> & {
    topology?: string;
    geometry?: string;
    paint?: string;
    temporal?: string;
  } = {},
): ReferenceDiagramRasterCacheIdentityInput {
  return {
    kind: options.kind ?? "node-tile",
    width: options.width ?? 2,
    height: options.height ?? 2,
    splitIdentities: {
      topology: digest(options.topology ?? `${name}:topology`),
      geometry: digest(options.geometry ?? `${name}:geometry`),
      paint: digest(options.paint ?? `${name}:paint`),
      temporal: digest(options.temporal ?? `${name}:temporal`),
    },
    backendIdentity: "local-space@1;sharp@test;libvips@test;rgba@straight",
    runtimeIdentity: cutReferenceRuntimeIdentity,
  };
}

function surface(fill: number, width = 2, height = 2) {
  return { data: Buffer.alloc(width * height * 4, fill), width, height };
}

async function fixture(label: string) {
  const root = await mkdtemp(resolve(tmpdir(), `cut-diagram-raster-${label}-`));
  return { root, cacheRoot: resolve(root, ".cut/cache/reference") };
}

test("persistent diagram RGBA cache has an exact cold/hit contract and path-free receipts", async (context) => {
  const { root, cacheRoot } = await fixture("cold-hit");
  context.after(() => rm(root, { recursive: true, force: true }));
  const input = identity("cold-hit");
  let builds = 0;
  const firstCache = await createReferenceDiagramRasterCache({ projectRoot: root, cacheRoot });
  const cold = await firstCache.materialize(input, () => { builds += 1; return surface(0x31); });
  assert.equal(cold.receipt.lookup, "built-miss");
  assert.equal(cold.receipt.reason, "CUT_DIAGRAM_RASTER_CACHE_COLD");
  assert.equal(cold.receipt.cacheLayer, "diagram-subscene-rgba");
  assert.equal(cold.receipt.scope, "persistent-cross-render");
  assert.equal(cold.receipt.counters.builderExecutions, 1);
  assert.equal(cold.receipt.counters.persistentHits, 0);
  assert.deepEqual(cold.surface.data, Buffer.alloc(16, 0x31));

  const secondCache = await createReferenceDiagramRasterCache({ projectRoot: root, cacheRoot });
  const warm = await secondCache.materialize(input, () => { builds += 1; throw new Error("warm hit invoked builder"); });
  assert.equal(builds, 1);
  assert.equal(warm.receipt.lookup, "persistent-hit");
  assert.equal(warm.receipt.reason, "CUT_DIAGRAM_RASTER_CACHE_HIT");
  assert.equal(warm.receipt.counters.builderExecutions, 0);
  assert.equal(warm.receipt.counters.manifestsValidated, 1);
  assert.deepEqual(warm.surface.data, cold.surface.data);
  assert.notEqual(warm.surface.data, cold.surface.data, "callers receive independent buffers");

  const encodedReceipt = JSON.stringify(warm.receipt);
  assert.doesNotMatch(encodedReceipt, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.doesNotMatch(encodedReceipt, /(?:\/Users\/|\/private\/|\/tmp\/|[A-Za-z]:\\)/u);
  const plan = referenceDiagramRasterCacheIdentity(input);
  const manifest = JSON.parse(await readFile(resolve(cacheRoot, referenceDiagramRasterCacheNamespace, `${plan.key}.json`), "utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(manifest).sort(), ["artifact", "format", "identity", "key", "version"]);
  assert.equal(JSON.stringify(manifest).includes(root), false);
});

test("paint and temporal mutations produce distinct persistent keys while unchanged inputs reuse pixels", async (context) => {
  const { root, cacheRoot } = await fixture("mutation");
  context.after(() => rm(root, { recursive: true, force: true }));
  const cache = await createReferenceDiagramRasterCache({ projectRoot: root, cacheRoot });
  const firstInput = identity("mutation", { geometry: "shared-geometry", paint: "paint-a", temporal: "frame-7" });
  const paintInput = identity("mutation", { geometry: "shared-geometry", paint: "paint-b", temporal: "frame-7" });
  const timeInput = identity("mutation", { geometry: "shared-geometry", paint: "paint-b", temporal: "frame-8" });
  const backendInput = { ...firstInput, backendIdentity: `${firstInput.backendIdentity};implementation@changed` };
  const first = await cache.materialize(firstInput, () => surface(0x11));
  const paint = await cache.materialize(paintInput, () => surface(0x22));
  const time = await cache.materialize(timeInput, () => surface(0x33));
  const backend = await cache.materialize(backendInput, () => surface(0x44));
  assert.equal(new Set([first.receipt.key, paint.receipt.key, time.receipt.key, backend.receipt.key]).size, 4);
  assert.equal(paint.receipt.lookup, "built-miss");
  assert.equal(time.receipt.lookup, "built-miss");
  const replay = await cache.materialize(firstInput, () => { throw new Error("unchanged raster rebuilt"); });
  assert.equal(replay.receipt.lookup, "persistent-hit");
  assert.deepEqual(replay.surface.data, first.surface.data);
});

test("cache input diagnostics stay stable and renderer builder errors retain their original source metadata", async (context) => {
  const { root, cacheRoot } = await fixture("diagnostics");
  context.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    () => createReferenceDiagramRasterCache(null as unknown as Parameters<typeof createReferenceDiagramRasterCache>[0]),
    (error: unknown) => error instanceof ReferenceDiagramRasterCacheError && error.code === "CUT_DIAGRAM_RASTER_CACHE_INPUT",
  );
  const cache = await createReferenceDiagramRasterCache({ projectRoot: root, cacheRoot });
  const sourceError = Object.assign(new Error("CUT_DIAGRAM_TYPE: authored Text failed"), {
    code: "CUT_DIAGRAM_TYPE",
    source: { module: "main.cut", line: 9, column: 5, nodeId: "text" },
  });
  await assert.rejects(
    () => cache.materialize(identity("builder-source"), () => { throw sourceError; }),
    (error: unknown) => error === sourceError
      && (error as typeof sourceError).code === "CUT_DIAGRAM_TYPE"
      && (error as typeof sourceError).source.module === "main.cut",
  );
});

test("tampered bytes and hostile closed-manifest fields are misses and are repaired without trusting paths", async (context) => {
  const { root, cacheRoot } = await fixture("tamper");
  context.after(() => rm(root, { recursive: true, force: true }));
  const cache = await createReferenceDiagramRasterCache({ projectRoot: root, cacheRoot }), input = identity("tamper");
  const plan = referenceDiagramRasterCacheIdentity(input), namespace = resolve(cacheRoot, referenceDiagramRasterCacheNamespace);
  const artifactPath = resolve(namespace, `${plan.key}.rgba`), manifestPath = resolve(namespace, `${plan.key}.json`);
  let builds = 0;
  await cache.materialize(input, () => { builds += 1; return surface(0x41); });
  await writeFile(artifactPath, Buffer.alloc(16, 0x99));
  const byteRepair = await cache.materialize(input, () => { builds += 1; return surface(0x41); });
  assert.equal(byteRepair.receipt.reason, "CUT_DIAGRAM_RASTER_CACHE_ARTIFACT_CORRUPT");
  assert.deepEqual(await readFile(artifactPath), Buffer.alloc(16, 0x41));

  const outside = resolve(root, "outside-sentinel.txt");
  await writeFile(outside, "do not touch\n");
  const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  await writeFile(manifestPath, `${JSON.stringify({ ...parsed, locator: outside })}\n`);
  const manifestRepair = await cache.materialize(input, () => { builds += 1; return surface(0x41); });
  assert.equal(manifestRepair.receipt.reason, "CUT_DIAGRAM_RASTER_CACHE_MANIFEST_INVALID");
  assert.equal(await readFile(outside, "utf8"), "do not touch\n");
  const validText = await readFile(manifestPath, "utf8");
  await writeFile(manifestPath, validText.replace("{", `{"format":"duplicate-poison",`));
  const duplicateRepair = await cache.materialize(input, () => { builds += 1; return surface(0x41); });
  assert.equal(duplicateRepair.receipt.reason, "CUT_DIAGRAM_RASTER_CACHE_MANIFEST_INVALID");
  assert.equal(builds, 4);
  const finalHit = await cache.materialize(input, () => { throw new Error("repaired pair rebuilt"); });
  assert.equal(finalHit.receipt.lookup, "persistent-hit");
});

test("artifact leaf symlinks are never followed and are safely replaced on repair", { skip: process.platform === "win32" }, async (context) => {
  const { root, cacheRoot } = await fixture("leaf-symlink");
  context.after(() => rm(root, { recursive: true, force: true }));
  const cache = await createReferenceDiagramRasterCache({ projectRoot: root, cacheRoot }), input = identity("leaf-symlink");
  const plan = referenceDiagramRasterCacheIdentity(input), artifactPath = resolve(cacheRoot, referenceDiagramRasterCacheNamespace, `${plan.key}.rgba`);
  await cache.materialize(input, () => surface(0x51));
  const outside = resolve(root, "outside.rgba");
  await writeFile(outside, Buffer.alloc(16, 0x77));
  await rm(artifactPath);
  await symlink(outside, artifactPath);
  const repaired = await cache.materialize(input, () => surface(0x51));
  assert.equal(repaired.receipt.reason, "CUT_DIAGRAM_RASTER_CACHE_ARTIFACT_CORRUPT");
  assert.deepEqual(await readFile(artifactPath), Buffer.alloc(16, 0x51));
  assert.deepEqual(await readFile(outside), Buffer.alloc(16, 0x77));
});

test("project-owned cache directory creation refuses a cache-root symlink", { skip: process.platform === "win32" }, async (context) => {
  const { root } = await fixture("root-symlink"), outside = await mkdtemp(resolve(tmpdir(), "cut-diagram-raster-outside-"));
  context.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  const cacheRoot = resolve(root, "cache-link");
  await symlink(outside, cacheRoot);
  await assert.rejects(
    () => createReferenceDiagramRasterCache({ projectRoot: root, cacheRoot }),
    (error: unknown) => error instanceof ReferenceDiagramRasterCacheError && error.code === "CUT_DIAGRAM_RASTER_CACHE_PATH",
  );
  assert.deepEqual(await readdir(outside), []);
});

test("bounded namespace deterministically evicts and per-artifact admission fails before building", async (context) => {
  const { root, cacheRoot } = await fixture("eviction");
  context.after(() => rm(root, { recursive: true, force: true }));
  const limits = {
    maximumAxisPixels: 16,
    maximumArtifactRgbaBytes: 64,
    maximumTotalNamespaceBytes: 8_192,
    maximumEntries: 2,
    maximumDirectoryEntriesScanned: 128,
    maximumManifestBytes: 4_096,
  };
  const cache = await createReferenceDiagramRasterCache({ projectRoot: root, cacheRoot, limits });
  const inputs = [identity("evict-a"), identity("evict-b"), identity("evict-c")];
  const results = [];
  for (const [index, input] of inputs.entries()) results.push(await cache.materialize(input, () => surface(0x61 + index)));
  assert.equal(results[2].receipt.counters.evictedEntries, 1);
  assert.ok(results[2].receipt.counters.evictedBytes > 16);
  const plans = inputs.map(referenceDiagramRasterCacheIdentity);
  const manifests = (await readdir(resolve(cacheRoot, referenceDiagramRasterCacheNamespace)))
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort();
  const expectedVictim = [plans[0].key, plans[1].key].sort().at(-1)!;
  assert.deepEqual(manifests, plans.map((plan) => plan.key).filter((key) => key !== expectedVictim).sort());
  assert.ok(manifests.includes(plans[2].key), "newly requested entry is preserved during admission");

  let oversizedBuilds = 0;
  await assert.rejects(
    () => cache.materialize(identity("oversized", { width: 5, height: 5 }), () => { oversizedBuilds += 1; return surface(0x70, 5, 5); }),
    (error: unknown) => error instanceof ReferenceDiagramRasterCacheError && error.code === "CUT_DIAGRAM_RASTER_CACHE_RESOURCE_LIMIT",
  );
  assert.equal(oversizedBuilds, 0, "known dimensions are rejected before invoking a raster builder");
});

test("manifest-last publication fault cannot create a poisoned hit", async (context) => {
  const { root, cacheRoot } = await fixture("atomic");
  context.after(() => rm(root, { recursive: true, force: true }));
  const input = identity("atomic"), plan = referenceDiagramRasterCacheIdentity(input);
  const failing = await createReferenceDiagramRasterCache({
    projectRoot: root,
    cacheRoot,
    __testHooks: { fault: (point) => { if (point === "after-artifact-publication") throw new Error("injected crash window"); } },
  });
  await assert.rejects(
    () => failing.materialize(input, () => surface(0x71)),
    (error: unknown) => error instanceof ReferenceDiagramRasterCacheError && error.code === "CUT_DIAGRAM_RASTER_CACHE_PUBLICATION",
  );
  const namespace = resolve(cacheRoot, referenceDiagramRasterCacheNamespace);
  assert.deepEqual(await readFile(resolve(namespace, `${plan.key}.rgba`)), Buffer.alloc(16, 0x71));
  await assert.rejects(() => readFile(resolve(namespace, `${plan.key}.json`)), (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT"));

  let repairs = 0;
  const repairedCache = await createReferenceDiagramRasterCache({ projectRoot: root, cacheRoot });
  const repaired = await repairedCache.materialize(input, () => { repairs += 1; return surface(0x72); });
  assert.equal(repaired.receipt.lookup, "built-miss");
  assert.equal(repaired.receipt.reason, "CUT_DIAGRAM_RASTER_CACHE_MANIFEST_MISSING");
  assert.equal(repairs, 1);
  const hit = await repairedCache.materialize(input, () => { throw new Error("partial publication was trusted"); });
  assert.equal(hit.receipt.lookup, "persistent-hit");
  assert.deepEqual(hit.surface.data, Buffer.alloc(16, 0x72));
});

test("namespace scans never delete a different process staging directory", async (context) => {
  const { root, cacheRoot } = await fixture("foreign-stage");
  context.after(() => rm(root, { recursive: true, force: true }));
  const cache = await createReferenceDiagramRasterCache({ projectRoot: root, cacheRoot });
  const foreignPid = process.pid === 1 ? 2 : 1;
  const stage = resolve(cacheRoot, referenceDiagramRasterCacheNamespace, `.cut-diagram-raster-stage-${foreignPid}-still-active-`);
  await mkdir(stage);
  const marker = resolve(stage, "writer-owned.tmp");
  await writeFile(marker, "active\n");
  const result = await cache.materialize(identity("foreign-stage"), () => surface(0x79));
  assert.equal(result.receipt.lookup, "built-miss");
  assert.equal(await readFile(marker, "utf8"), "active\n");
});

test("same-process concurrent requests share one promise and return independent buffers", async (context) => {
  const { root, cacheRoot } = await fixture("concurrent");
  context.after(() => rm(root, { recursive: true, force: true }));
  const cache = await createReferenceDiagramRasterCache({ projectRoot: root, cacheRoot }), input = identity("concurrent");
  let release!: () => void, builds = 0;
  const gate = new Promise<void>((accept) => { release = accept; });
  const builder = async () => { builds += 1; await gate; return surface(0x81); };
  const pending = Array.from({ length: 8 }, () => cache.materialize(input, builder));
  await new Promise<void>((accept) => setImmediate(accept));
  release();
  const results = await Promise.all(pending);
  assert.equal(builds, 1);
  assert.equal(results.filter((result) => result.receipt.lookup === "built-miss").length, 1);
  assert.equal(results.filter((result) => result.receipt.lookup === "same-process-coalesced").length, 7);
  results[0].surface.data[0] = 0;
  assert.equal(results[1].surface.data[0], 0x81);
});
