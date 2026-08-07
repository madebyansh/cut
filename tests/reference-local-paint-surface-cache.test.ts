import assert from "node:assert/strict";
import test from "node:test";
import {
  ReferenceLocalPaintSurfaceCache,
  referenceLocalPaintSurfaceCacheIdentity,
  type RawSurface,
  type ReferenceLocalPaintSurfaceCacheEvent,
  type ReferenceLocalPaintSurfaceCacheIdentityInput,
} from "../lib/runtime/reference/visual";

function surface(width: number, height: number, bytes?: readonly number[]): RawSurface {
  const data = Buffer.alloc(width * height * 4);
  if (bytes) data.set(bytes);
  return { data, width, height };
}

test("local paint cache identity closes exact paint, context, raster, backend, and locked-resource inputs", () => {
  const base: ReferenceLocalPaintSurfaceCacheIdentityInput = {
    kind: "shape",
    svg: "<svg><rect fill=\"#123456\"/></svg>",
    width: 32,
    height: 24,
    rasterOriginQ16: { x: "65536", y: "131072" },
    localSpaceSemanticIdentity: "a".repeat(64),
    backendIdentity: "sharp@closed",
    rasterContract: "svg-density-144-resize-rgba8",
    lockedResources: [],
  };
  const identity = referenceLocalPaintSurfaceCacheIdentity(base);
  assert.match(identity, /^[a-f0-9]{64}$/u);
  const edits: ReferenceLocalPaintSurfaceCacheIdentityInput[] = [
    { ...base, kind: "static-vector-path" },
    { ...base, svg: "<svg><rect fill=\"#654321\"/></svg>" },
    { ...base, width: 31 },
    { ...base, height: 23 },
    { ...base, rasterOriginQ16: { ...base.rasterOriginQ16, x: "65537" } },
    { ...base, localSpaceSemanticIdentity: "b".repeat(64) },
    { ...base, backendIdentity: "sharp@changed" },
    { ...base, rasterContract: "svg-native-dimensions-rgba8" },
    { ...base, lockedResources: [{ id: "asset", sha256: "c".repeat(64) }] },
  ];
  for (const edited of edits) {
    assert.notEqual(referenceLocalPaintSurfaceCacheIdentity(edited), identity);
  }
  assert.equal(referenceLocalPaintSurfaceCacheIdentity({ ...base }), identity);
});

test("bounded local paint cache coalesces, preserves exact hidden RGB, and cleans failed work", async () => {
  const cache = new ReferenceLocalPaintSurfaceCache(8, 2);
  const events: ReferenceLocalPaintSurfaceCacheEvent[] = [];
  let resolveFirst!: (value: RawSurface) => void;
  let builds = 0;
  const first = cache.request("a", 4, () => {
    builds += 1;
    return new Promise<RawSurface>((resolve) => { resolveFirst = resolve; });
  }, (event) => events.push(event));
  const coalesced = cache.request("a", 4, async () => {
    builds += 1;
    return surface(1, 1, [1, 2, 3, 0]);
  }, (event) => events.push(event));
  assert.strictEqual(coalesced, first);
  assert.equal(builds, 0, "materialization begins on the deterministic promise turn");
  await Promise.resolve();
  assert.equal(builds, 1);
  resolveFirst(surface(1, 1, [91, 73, 55, 0]));
  const [left, right] = await Promise.all([first, coalesced]);
  assert.strictEqual(left, right);
  assert.deepEqual([...left.data], [91, 73, 55, 0], "noncanonical hidden RGB must remain byte exact");
  assert.equal(cache.entryCount, 1);
  assert.equal(cache.residentBytes, 4);
  assert.deepEqual(
    events.map((event) => event.kind),
    ["hit", "miss"],
    "a coalesced hit may be observed while the original request is still awaiting its terminal admission",
  );

  const replay = await cache.request("a", 4, async () => {
    builds += 1;
    return surface(1, 1);
  });
  assert.strictEqual(replay, left);
  assert.equal(builds, 1);

  await assert.rejects(cache.request("failure", 4, async () => {
    throw new Error("later raster failure");
  }), /later raster failure/u);
  assert.equal(cache.entryCount, 1, "a rejected builder must leave no cache entry");
  assert.equal(cache.residentBytes, 4);

  let releaseCleared!: (value: RawSurface) => void;
  const clearedEvents: string[] = [];
  const clearedPending = cache.request("clear-pending", 4, () => new Promise((resolve) => {
    releaseCleared = resolve;
  }), (event) => clearedEvents.push(event.kind));
  await Promise.resolve();
  cache.clear();
  assert.equal(cache.entryCount, 0);
  assert.equal(cache.residentBytes, 0);
  releaseCleared(surface(1, 1, [7, 8, 9, 255]));
  await clearedPending;
  assert.deepEqual(clearedEvents, ["bypass"], "cleared successful work must terminate as one uncached materialization");
  assert.equal(cache.entryCount, 0, "cleared in-flight work must never repopulate the cache");
  assert.equal(cache.residentBytes, 0);
});

test("constrained concurrent paint requests emit exactly one terminal miss or bypass per successful materialization", async () => {
  const cache = new ReferenceLocalPaintSurfaceCache(4, 1);
  const cachedEvents: string[] = [];
  const bypassedEvents: string[] = [];
  let releaseCached!: (value: RawSurface) => void;
  let releaseBypassed!: (value: RawSurface) => void;
  const cached = cache.request("cached", 4, () => new Promise((resolve) => {
    releaseCached = resolve;
  }), (event) => cachedEvents.push(event.kind));
  const bypassed = cache.request("bypassed", 4, () => new Promise((resolve) => {
    releaseBypassed = resolve;
  }), (event) => bypassedEvents.push(event.kind));
  await Promise.resolve();
  assert.deepEqual(cachedEvents, [], "an admitted pending request is not a miss until it becomes resident");
  assert.deepEqual(bypassedEvents, ["bypass"], "the pending entry bound forces one immediate uncached outcome");

  releaseBypassed(surface(1, 1, [9, 8, 7, 255]));
  releaseCached(surface(1, 1, [1, 2, 3, 255]));
  const [cachedSurface, bypassedSurface] = await Promise.all([cached, bypassed]);
  assert.deepEqual([...cachedSurface.data], [1, 2, 3, 255]);
  assert.deepEqual([...bypassedSurface.data], [9, 8, 7, 255]);
  assert.deepEqual(cachedEvents, ["miss"], "the retained request emits one terminal miss after admission");
  assert.deepEqual(bypassedEvents, ["bypass"], "the uncached request never emits a second terminal event");
  assert.equal(cache.entryCount, 1);
  assert.equal(cache.residentBytes, 4);
});

test("bounded local paint cache has deterministic LRU, byte, entry, and bypass behavior", async () => {
  const cache = new ReferenceLocalPaintSurfaceCache(8, 2);
  const kinds: string[] = [];
  const observe = (event: ReferenceLocalPaintSurfaceCacheEvent) => {
    kinds.push(event.kind);
    assert.ok(event.residentBytes <= 8);
    assert.ok(event.entries <= 2);
  };
  let builds = 0;
  const build = async (marker: number) => {
    builds += 1;
    return surface(1, 1, [marker, marker, marker, 255]);
  };
  await cache.request("a", 4, () => build(1), observe);
  await cache.request("b", 4, () => build(2), observe);
  await cache.request("a", 4, () => build(3), observe);
  await cache.request("c", 4, () => build(4), observe);
  await cache.request("b", 4, () => build(5), observe);
  assert.equal(builds, 4, "the A hit must make B the deterministic LRU eviction");
  assert.deepEqual(kinds, ["miss", "miss", "hit", "eviction", "miss", "eviction", "miss"]);
  assert.equal(cache.entryCount, 2);
  assert.equal(cache.residentBytes, 8);

  let oversizedBuilds = 0;
  const oversizedEvents: string[] = [];
  const oversized = new ReferenceLocalPaintSurfaceCache(4, 1);
  await oversized.request("large", 8, async () => {
    oversizedBuilds += 1;
    return surface(2, 1);
  }, (event) => oversizedEvents.push(event.kind));
  assert.equal(oversizedBuilds, 1);
  assert.deepEqual(oversizedEvents, ["bypass"]);
  assert.equal(oversized.entryCount, 0);
  assert.equal(oversized.residentBytes, 0);

  let release!: (value: RawSurface) => void;
  const pending = oversized.request("pending", 4, () => new Promise((resolve) => { release = resolve; }));
  const fullEvents: string[] = [];
  await oversized.request("uncached", 4, async () => surface(1, 1), (event) => fullEvents.push(event.kind));
  assert.deepEqual(fullEvents, ["bypass"], "a full pending set must not grow the cache");
  release(surface(1, 1));
  await pending;
  assert.equal(oversized.entryCount, 1);
  assert.equal(oversized.residentBytes, 4);
});

test("local paint cache refuses malformed expected and materialized surface bounds transactionally", async () => {
  const cache = new ReferenceLocalPaintSurfaceCache(16, 2);
  assert.throws(() => cache.request("bad-size", 3, async () => surface(1, 1)), /expected surface bytes/u);
  const events: string[] = [];
  await assert.rejects(cache.request("bad-surface", 4, async () => ({
    data: Buffer.alloc(3),
    width: 1,
    height: 1,
  }), (event) => events.push(event.kind)), /materialized surfaces/u);
  assert.equal(cache.entryCount, 0);
  assert.equal(cache.residentBytes, 0);
  const recovered = await cache.request("bad-surface", 4, async () => surface(1, 1, [1, 2, 3, 255]), (event) => events.push(event.kind));
  assert.deepEqual([...recovered.data], [1, 2, 3, 255]);
  assert.deepEqual(events, ["miss"], "only the valid same-key retry may become an admitted cache miss");
  assert.equal(cache.entryCount, 1);
  assert.equal(cache.residentBytes, 4);
});
