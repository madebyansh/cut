import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { CutAVIR, IRComposition, IRNode, IRSignal, IRValue } from "../lib/language/ir";
import { rational } from "../lib/language/rational";
import {
  ReferenceMapCameraCanonicalRasterCache,
  prepareReferenceMapCameraRenderInvocation,
  referenceMapCameraCanonicalRasterCacheIdentity,
  referenceMapCameraPreparedConfigurations,
  renderReferenceMapCameraFrame,
  validateReferenceMapCameraFrameEvidenceSemantics,
} from "../lib/runtime/reference/map-camera-render";
import { validateReferenceMapCameraGraph } from "../lib/runtime/reference/map-camera";

const span = {
  start: { offset: 0, line: 4, column: 3 },
  end: { offset: 1, line: 4, column: 4 },
};
const provenance = (symbol: string) => ({
  module: "map-camera-canonical-raster-cache.cut",
  span,
  symbol,
});
const referenceSha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function scalar(numerator: number, denominator = 1): IRValue {
  return {
    kind: "quantity",
    dimension: "scalar",
    unit: "scalar",
    magnitude: rational(numerator, denominator),
  };
}

function length(numerator: number): IRValue {
  return {
    kind: "quantity",
    dimension: "length",
    unit: "px",
    magnitude: rational(numerator),
  };
}

function point(latitude: number, longitude: number): IRValue {
  return {
    kind: "object",
    entries: {
      latitude: scalar(latitude),
      longitude: scalar(longitude),
    },
  };
}

function visualNode(
  id: string,
  op: string,
  inputs: Record<string, IRValue> = {},
  children: string[] = [],
  properties: IRNode["properties"] = {},
): IRNode {
  return {
    id,
    op,
    domain: "visual",
    ownership: id === "camera" ? "root" : "child",
    sceneId: "scene",
    interval: { start: rational(0), duration: rational(1) },
    inputs,
    children,
    properties,
    effects: ["pure"],
    contentHash: `${id}-content`,
    provenance: provenance(id),
  };
}

function fixture(options: {
  width?: number;
  height?: number;
  cameraProperties?: IRNode["properties"];
  signals?: Record<string, IRSignal>;
} = {}) {
  const marker = visualNode("marker", "cut.geo.marker", {
    point: point(0, 20),
    radius: length(8),
    color: { kind: "color", value: "#f97316" },
  });
  const camera = visualNode(
    "camera",
    "cut.geo.map_camera",
    {},
    [marker.id],
    options.cameraProperties,
  );
  const composition: IRComposition = {
    id: "composition",
    name: "canonical-raster cache proof",
    width: options.width ?? 160,
    height: options.height ?? 90,
    fps: rational(4),
    sampleRate: 48_000,
    duration: rational(1),
    sceneIds: ["scene"],
    rootVisualIds: [camera.id],
    rootAudioIds: [],
    rootAVIds: [],
    items: [{ kind: "scene", id: "scene" }],
    provenance: provenance("composition"),
  };
  const ir: CutAVIR = {
    format: "cut-av-ir",
    version: 3,
    language: "0.4",
    compiler: "cut-ts/test",
    project: "canonical-raster cache proof",
    sourceHash: "source",
    buildId: "build",
    determinism: {
      semantic: "locked",
      decodedMedia: "verified",
      bitstream: "unverified",
    },
    timebase: { defaultFps: composition.fps, audioSampleRate: 48_000 },
    modules: [{
      specifier: "@cut/geo",
      version: "0.4.0-alpha.2",
      integrity: "geo-integrity",
    }],
    resources: {},
    compositions: [composition],
    scenes: {
      scene: {
        id: "scene",
        name: "only",
        start: rational(0),
        duration: rational(1),
        rootVisualIds: [camera.id],
        rootAudioIds: [],
        rootAVIds: [],
        items: [{ id: camera.id, domain: "visual" }],
        provenance: provenance("scene"),
      },
    },
    nodes: { camera, marker },
    signals: options.signals ?? {},
    jobs: [],
    outputs: [],
    assertions: [],
    annotations: { markers: [], regions: [] },
    linkedEdits: [],
  };
  const config = validateReferenceMapCameraGraph(ir, composition).get(camera.id);
  assert.ok(config);
  const preparation = prepareReferenceMapCameraRenderInvocation(
    ir,
    composition,
    new Set([camera.id, marker.id]),
  );
  const preparedConfig = referenceMapCameraPreparedConfigurations(preparation).get(camera.id);
  assert.ok(preparedConfig);
  return { ir, composition, config: preparedConfig, preparation };
}

function context(
  cache: ReferenceMapCameraCanonicalRasterCache,
  preparation: ReturnType<typeof prepareReferenceMapCameraRenderInvocation>,
) {
  return {
    annotationMode: "defer-local-space" as const,
    evidenceKind: "completed-public-retained-geo-pass" as const,
    publicRuntimeStatus: "connected-reference-visual-renderer" as const,
    cacheStatus: "renderer-invocation-canonical-raster-cache-no-persistent-cache" as const,
    preparation,
    canonicalRasterCache: cache,
  };
}

test("static out-of-order MapCamera frames reuse private canonical bytes while publishing current-frame evidence", async () => {
  const value = fixture();
  const cache = new ReferenceMapCameraCanonicalRasterCache();
  const uncached = await renderReferenceMapCameraFrame(
    value.ir,
    value.composition,
    value.config,
    rational(0),
  );
  const first = await renderReferenceMapCameraFrame(
    value.ir,
    value.composition,
    value.config,
    rational(0),
    context(cache, value.preparation),
  );
  const later = await renderReferenceMapCameraFrame(
    value.ir,
    value.composition,
    value.config,
    rational(1, 2),
    context(cache, value.preparation),
  );
  const frozenBytes = Buffer.from(first.surface.data);
  first.surface.data.fill(0);
  const earlyReplay = await renderReferenceMapCameraFrame(
    value.ir,
    value.composition,
    value.config,
    rational(1, 4),
    context(cache, value.preparation),
  );

  assert.equal(first.canonicalRasterCache.outcome, "miss");
  assert.equal(first.counters.rasterizations, 1);
  assert.equal(first.counters.alphaCanonicalizationPasses, 1);
  assert.equal(later.canonicalRasterCache.outcome, "hit");
  assert.equal(later.counters.rasterizations, 0);
  assert.equal(later.counters.alphaCanonicalizationPasses, 0);
  assert.equal(later.execution.raster, "reused-canonical-renderer-invocation-raster");
  assert.equal(earlyReplay.canonicalRasterCache.outcome, "hit");
  assert.deepEqual(later.surface.data, frozenBytes);
  assert.deepEqual(earlyReplay.surface.data, frozenBytes);
  assert.deepEqual(uncached.surface.data, frozenBytes, "cache must preserve the frozen scalar raster bytes");
  assert.equal(uncached.surface.sha256, later.surface.sha256);
  assert.equal(first.canonicalRasterCache.key, later.canonicalRasterCache.key);
  assert.deepEqual(later.exactTime, rational(1, 2));
  assert.deepEqual(earlyReplay.exactTime, rational(1, 4));
  assert.notEqual(first.executionIdentity, later.executionIdentity);
  assert.notEqual(later.executionIdentity, earlyReplay.executionIdentity);
  assert.equal(cache.entryCount, 1);
  assert.equal(cache.residentBytes, 160 * 90 * 4);
  cache.clear();
  assert.equal(cache.entryCount, 0);
  assert.equal(cache.residentBytes, 0);
});

test("animated camera state misses, replays hit, and bounded admission evicts without stale pixels", async () => {
  const linear: IRValue = { kind: "symbol", name: "@cut/motion#linear" };
  const scale: IRSignal = {
    id: "scale",
    kind: "track",
    valueType: "Number",
    initial: scalar(1),
    events: [{
      kind: "animate",
      start: rational(0),
      end: rational(1),
      from: scalar(1),
      to: scalar(5),
      curve: linear,
    }],
    contentHash: "scale-content",
    provenance: provenance("scale"),
  };
  const value = fixture({
    cameraProperties: { scale: { signal: scale.id } },
    signals: { [scale.id]: scale },
  });
  const bytes = value.composition.width * value.composition.height * 4;
  const cache = new ReferenceMapCameraCanonicalRasterCache(bytes, 1);
  const first = await renderReferenceMapCameraFrame(
    value.ir, value.composition, value.config, rational(0), context(cache, value.preparation),
  );
  const changed = await renderReferenceMapCameraFrame(
    value.ir, value.composition, value.config, rational(1, 2), context(cache, value.preparation),
  );
  const replay = await renderReferenceMapCameraFrame(
    value.ir, value.composition, value.config, rational(1, 2), context(cache, value.preparation),
  );
  const firstAgain = await renderReferenceMapCameraFrame(
    value.ir, value.composition, value.config, rational(0), context(cache, value.preparation),
  );

  assert.equal(first.canonicalRasterCache.outcome, "miss");
  assert.equal(changed.canonicalRasterCache.outcome, "miss");
  assert.equal(changed.canonicalRasterCache.evictions, 1);
  assert.notEqual(first.canonicalRasterCache.key, changed.canonicalRasterCache.key);
  assert.notEqual(first.surface.sha256, changed.surface.sha256);
  assert.equal(replay.canonicalRasterCache.outcome, "hit");
  assert.equal(replay.surface.sha256, changed.surface.sha256);
  assert.equal(firstAgain.canonicalRasterCache.outcome, "miss");
  assert.equal(firstAgain.canonicalRasterCache.evictions, 1);
  assert.equal(firstAgain.surface.sha256, first.surface.sha256);
});

test("cache identity binds dimensions, backend, algorithms, and atlas closure; oversized entries bypass", async () => {
  const value = fixture();
  const frame = await renderReferenceMapCameraFrame(
    value.ir,
    value.composition,
    value.config,
    rational(0),
  );
  const input = {
    canonicalDrawingStreamSha256: frame.canonicalDrawingStream.sha256,
    canonicalDrawingStreamBytes: frame.canonicalDrawingStream.bytes,
    width: frame.surface.width,
    height: frame.surface.height,
    backend: frame.backend,
    atlas: frame.atlas,
  };
  const base = referenceMapCameraCanonicalRasterCacheIdentity(input);
  assert.notEqual(
    base,
    referenceMapCameraCanonicalRasterCacheIdentity({
      ...input,
      width: input.width + 1,
    }),
  );
  assert.notEqual(
    base,
    referenceMapCameraCanonicalRasterCacheIdentity({
      ...input,
      backend: {
        ...input.backend,
        sharpStackIdentity: "f".repeat(64),
      },
    }),
  );
  assert.notEqual(
    base,
    referenceMapCameraCanonicalRasterCacheIdentity({
      ...input,
      atlas: [{
        ...input.atlas[0]!,
        sha256: "e".repeat(64),
      }],
    }),
  );

  const cache = new ReferenceMapCameraCanonicalRasterCache(4, 1);
  const bypassed = await renderReferenceMapCameraFrame(
    value.ir,
    value.composition,
    value.config,
    rational(0),
    context(cache, value.preparation),
  );
  assert.equal(bypassed.canonicalRasterCache.outcome, "bypass");
  assert.equal(bypassed.counters.rasterizations, 1);
  assert.equal(cache.entryCount, 0);
  assert.equal(cache.residentBytes, 0);
});

test("malformed materialization is removed transactionally and a same-key retry is a fresh miss", async () => {
  const cache = new ReferenceMapCameraCanonicalRasterCache(64, 2);
  const key = "a".repeat(64);
  let malformedBuilds = 0;
  await assert.rejects(
    cache.request(key, 2, 2, async () => {
      malformedBuilds += 1;
      return {
        data: Buffer.alloc(12),
        width: 2,
        height: 2,
        sha256: "b".repeat(64),
        clearedTransparentRgbPixels: 0,
        visiblePixels: 1,
      };
    }),
    /CUT_MAP_CAMERA_RENDER_RASTER/u,
  );
  assert.equal(malformedBuilds, 1);
  assert.equal(cache.entryCount, 0);
  assert.equal(cache.residentBytes, 0);

  let validBuilds = 0;
  const data = Buffer.from([
    1, 2, 3, 255, 4, 5, 6, 255,
    7, 8, 9, 255, 10, 11, 12, 255,
  ]);
  const retried = await cache.request(key, 2, 2, async () => {
    validBuilds += 1;
    return {
      data,
      width: 2,
      height: 2,
      sha256: referenceSha256(data),
      clearedTransparentRgbPixels: 0,
      visiblePixels: 4,
    };
  });
  assert.equal(validBuilds, 1);
  assert.equal(retried.evidence.outcome, "miss");
  assert.equal(cache.entryCount, 1);
  assert.equal(cache.residentBytes, 16);
});

test("current semantic validation rejects forged canonical-raster cache outcomes and counters", async () => {
  const value = fixture();
  const cache = new ReferenceMapCameraCanonicalRasterCache();
  const first = await renderReferenceMapCameraFrame(
    value.ir, value.composition, value.config, rational(0), context(cache, value.preparation),
  );
  const hit = await renderReferenceMapCameraFrame(
    value.ir, value.composition, value.config, rational(1, 2), context(cache, value.preparation),
  );
  assert.equal(hit.canonicalRasterCache.outcome, "hit");

  const forgedRaster = structuredClone(hit) as typeof hit;
  Object.assign(forgedRaster.counters, { rasterizations: 1 });
  assert.throws(
    () => validateReferenceMapCameraFrameEvidenceSemantics(forgedRaster),
    /cache outcome does not correlate/u,
  );

  const forgedScope = structuredClone(first) as typeof first;
  Object.assign(forgedScope.canonicalRasterCache, { outcome: "disabled", byteLimit: 0, entryLimit: 0 });
  assert.throws(
    () => validateReferenceMapCameraFrameEvidenceSemantics(forgedScope),
    /cache identity, bounds, scope, and terminal outcome/u,
  );

  const forgedKey = structuredClone(first) as typeof first;
  Object.assign(forgedKey.canonicalRasterCache, { key: "9".repeat(64) });
  assert.throws(
    () => validateReferenceMapCameraFrameEvidenceSemantics(forgedKey),
    /cache identity, bounds, scope, and terminal outcome/u,
  );
});

test("one digest cannot alias conflicting dimensions and every bypass authenticates materialized bytes", async () => {
  const key = "c".repeat(64);
  const pixel = Buffer.from([10, 20, 30, 255]);
  const validPixel = {
    data: pixel,
    width: 1,
    height: 1,
    sha256: referenceSha256(pixel),
    clearedTransparentRgbPixels: 0,
    visiblePixels: 1,
  };
  const cache = new ReferenceMapCameraCanonicalRasterCache(4, 1);
  const first = await cache.request(key, 1, 1, async () => validPixel);
  assert.equal(first.evidence.outcome, "miss");
  let conflictingBuilderCalls = 0;
  await assert.rejects(
    cache.request(key, 2, 1, async () => {
      conflictingBuilderCalls += 1;
      const data = Buffer.alloc(8, 255);
      return {
        data,
        width: 2,
        height: 1,
        sha256: referenceSha256(data),
        clearedTransparentRgbPixels: 0,
        visiblePixels: 2,
      };
    }),
    /conflicting RGBA dimensions/u,
  );
  assert.equal(conflictingBuilderCalls, 0);

  await assert.rejects(
    cache.request("d".repeat(64), 2, 1, async () => ({
      data: Buffer.alloc(4),
      width: 2,
      height: 1,
      sha256: referenceSha256(Buffer.alloc(4)),
      clearedTransparentRgbPixels: 0,
      visiblePixels: 1,
    })),
    /malformed or unauthenticated/u,
    "oversized bypass must authenticate the returned raster",
  );

  let releasePending!: () => void;
  const pending = new Promise<void>((resolve) => { releasePending = resolve; });
  const constrained = new ReferenceMapCameraCanonicalRasterCache(4, 1);
  const admitted = constrained.request("e".repeat(64), 1, 1, async () => {
    await pending;
    return validPixel;
  });
  await assert.rejects(
    constrained.request("f".repeat(64), 1, 1, async () => ({
      ...validPixel,
      sha256: "0".repeat(64),
    })),
    /malformed or unauthenticated/u,
    "capacity bypass while another entry is pending must authenticate the returned raster",
  );
  releasePending();
  assert.equal((await admitted).evidence.outcome, "miss");
});

test("clear while one materialization is coalesced admits no impossible completed waiter receipt", async () => {
  const cache = new ReferenceMapCameraCanonicalRasterCache(4, 1);
  const key = "1".repeat(64);
  const data = Buffer.from([1, 2, 3, 255]);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let builds = 0;
  const materialize = async () => {
    builds += 1;
    await gate;
    return {
      data,
      width: 1,
      height: 1,
      sha256: referenceSha256(data),
      clearedTransparentRgbPixels: 0,
      visiblePixels: 1,
    };
  };
  const first = cache.request(key, 1, 1, materialize);
  const coalesced = cache.request(key, 1, 1, materialize);
  cache.clear();
  release();
  const [firstResult, coalescedResult] = await Promise.allSettled([first, coalesced]);
  assert.equal(builds, 1);
  assert.equal(firstResult.status, "fulfilled");
  if (firstResult.status === "fulfilled") assert.equal(firstResult.value.evidence.outcome, "bypass");
  assert.equal(coalescedResult.status, "rejected");
  if (coalescedResult.status === "rejected") {
    assert.match(String(coalescedResult.reason), /CUT_MAP_CAMERA_RENDER_RASTER: .*invalidated/u);
  }
  assert.equal(cache.entryCount, 0);
  assert.equal(cache.residentBytes, 0);
});

test("direct materializer rejection cleans the reservation and permits an unrelated request", async () => {
  const cache = new ReferenceMapCameraCanonicalRasterCache(4, 1);
  await assert.rejects(
    cache.request("2".repeat(64), 1, 1, async () => {
      throw new Error("injected raster failure");
    }),
    /injected raster failure/u,
  );
  assert.equal(cache.entryCount, 0);
  assert.equal(cache.residentBytes, 0);
  const data = Buffer.from([9, 8, 7, 255]);
  const next = await cache.request("3".repeat(64), 1, 1, async () => ({
    data,
    width: 1,
    height: 1,
    sha256: referenceSha256(data),
    clearedTransparentRgbPixels: 0,
    visiblePixels: 1,
  }));
  assert.equal(next.evidence.outcome, "miss");
});
