import assert from "node:assert/strict";
import test from "node:test";
import {
  ReferenceRetainedVisualError,
  assertReferenceRetainedBoundsCovered,
  canonicalReferenceRect,
  combineReferenceRetainedWork,
  composeReferenceAffine2D,
  expandReferenceRect,
  intersectReferenceRects,
  referenceAffine2D,
  referenceAffineOperatorNorm,
  referenceConservativeStrokeBounds,
  referenceIdentityAffine2D,
  referenceIntegerRasterBounds,
  referencePositionedSurface,
  referencePositionedSurfaceBounds,
  referenceRect,
  referenceRetainedCacheIdentity,
  referenceRetainedRasterWork,
  referenceScaleAffine2D,
  referenceTranslationAffine2D,
  transformReferencePoint,
  transformReferenceRect,
  unionReferenceRects,
} from "../lib/runtime/reference/retained-visual";

function expectCode(work: () => unknown, code: ReferenceRetainedVisualError["code"], message?: RegExp) {
  assert.throws(work, (error: unknown) => {
    assert.ok(error instanceof ReferenceRetainedVisualError);
    assert.equal(error.code, code);
    if (message) assert.match(error.message, message);
    return true;
  });
}

test("retained rects are closed, frozen, composable records", () => {
  const first = referenceRect(-2.5, 3, 8.25, 10), second = referenceRect(0, -4, 12, 6);
  assert.ok(Object.isFrozen(first));
  assert.deepEqual(unionReferenceRects([first, second]), { minX: -2.5, minY: -4, maxX: 12, maxY: 10 });
  assert.deepEqual(expandReferenceRect(first, 1.5), { minX: -4, minY: 1.5, maxX: 9.75, maxY: 11.5 });
  assert.deepEqual(intersectReferenceRects(first, second), { minX: 0, minY: 3, maxX: 8.25, maxY: 6 });
  assert.equal(intersectReferenceRects(first, referenceRect(20, 20, 30, 30)), undefined);
  expectCode(
    () => canonicalReferenceRect({ minX: 0, minY: 0, maxX: 1, maxY: 1, titleSpecific: true }),
    "CUT_RETAINED_VISUAL_SHAPE",
    /does not accept property "titleSpecific"/,
  );
  const hostile = Object.create(null) as Record<string, unknown>;
  Object.defineProperties(hostile, {
    minX: { enumerable: true, value: 0 }, minY: { enumerable: true, value: 0 },
    maxX: { enumerable: true, get: () => 1 }, maxY: { enumerable: true, value: 1 },
  });
  expectCode(() => canonicalReferenceRect(hostile), "CUT_RETAINED_VISUAL_SHAPE", /enumerable data property/);
});

test("affine composition is inner-to-outer and canonicalizes neutral floating residue", () => {
  const scale = referenceScaleAffine2D(2), translate = referenceTranslationAffine2D(7, -3);
  const composed = composeReferenceAffine2D(translate, scale);
  assert.deepEqual(transformReferencePoint(composed, 4, 5), { x: 15, y: 7 });
  assert.deepEqual(composeReferenceAffine2D(referenceScaleAffine2D(0.5), scale), referenceIdentityAffine2D);
  const almostIdentity = referenceAffine2D({ a: 1 + 2 ** -50, b: -(2 ** -50), c: -0, d: 1, tx: -0, ty: 2 ** -50 });
  assert.deepEqual(almostIdentity, referenceIdentityAffine2D);
  assert.ok(Object.isFrozen(composed));
});

test("affine transform bounds use all four corners and expose a bounded operator norm", () => {
  const affine = referenceAffine2D({ a: 0, b: 2, c: -3, d: 0, tx: 10, ty: -5 });
  assert.equal(referenceAffineOperatorNorm(affine), 3);
  assert.deepEqual(transformReferenceRect(referenceRect(1, 2, 5, 7), affine), {
    minX: -11, minY: -3, maxX: 4, maxY: 5,
  });
  expectCode(
    () => referenceAffine2D({ a: Number.NaN, b: 0, c: 0, d: 1, tx: 0, ty: 0 }),
    "CUT_RETAINED_VISUAL_VALUE_RANGE",
    /retained affine\.a must be finite/,
  );
});

test("stroke bounds conservatively include transformed miter, square-cap, and AA support", () => {
  const centerline = referenceRect(0, 0, 10, 4), affine = referenceScaleAffine2D(2);
  const round = referenceConservativeStrokeBounds(centerline, affine, {
    width: 4, lineCap: "round", lineJoin: "round", miterLimit: 4, antialiasGuard: 1,
  });
  const miter = referenceConservativeStrokeBounds(centerline, affine, {
    width: 4, lineCap: "square", lineJoin: "miter", miterLimit: 4, antialiasGuard: 1,
  });
  assert.deepEqual(round, { minX: -5, minY: -5, maxX: 25, maxY: 13 });
  assert.deepEqual(miter, { minX: -17, minY: -17, maxX: 37, maxY: 25 });
  expectCode(
    () => referenceConservativeStrokeBounds(centerline, affine, {
      width: 4, lineCap: "round", lineJoin: "miter", miterLimit: 0.5, antialiasGuard: 1,
    }),
    "CUT_RETAINED_VISUAL_VALUE_RANGE",
    /miterLimit must be at least one/,
  );
});

test("integer raster bounds round outward and reject empty or hostile allocations", () => {
  const bounds = referenceIntegerRasterBounds(referenceRect(-0.25, 2.1, 10.01, 9));
  assert.deepEqual(bounds, { left: -1, top: 2, right: 11, bottom: 9, width: 12, height: 7, pixels: 84 });
  assert.ok(Object.isFrozen(bounds));
  expectCode(() => referenceIntegerRasterBounds(referenceRect(0, 0, 0, 1)), "CUT_RETAINED_VISUAL_VALUE_RANGE", /at least one pixel/);
  expectCode(() => referenceIntegerRasterBounds(referenceRect(0, 0, 16_385, 1)), "CUT_RETAINED_VISUAL_RESOURCE_LIMIT", /per-axis limit/);
  expectCode(() => referenceIntegerRasterBounds(referenceRect(-100_000, -100_000, 100_000, 100_000)), "CUT_RETAINED_VISUAL_RESOURCE_LIMIT");
});

test("positioned surfaces are closed/frozen and retain explicit origin bounds", () => {
  const surface = referencePositionedSurface({
    data: new Uint8Array(3 * 2 * 4), width: 3, height: 2, originX: -4.5, originY: 7.25, alphaMode: "straight",
  });
  assert.ok(Object.isFrozen(surface));
  assert.deepEqual(referencePositionedSurfaceBounds(surface), { minX: -4.5, minY: 7.25, maxX: -1.5, maxY: 9.25 });
  expectCode(
    () => referencePositionedSurface({ data: new Uint8Array(3), width: 1, height: 1, originX: 0, originY: 0, alphaMode: "straight" }),
    "CUT_RETAINED_VISUAL_SURFACE",
    /byte length/,
  );
  expectCode(
    () => referencePositionedSurface({ data: new Uint8Array(4), width: 1, height: 1, originX: 0, originY: 0, alphaMode: "premultiplied" }),
    "CUT_RETAINED_VISUAL_SURFACE",
    /alphaMode must be straight/,
  );
});

test("nonzero raster-edge alpha fails with a stable bounds-underrun diagnostic", () => {
  const data = new Uint8Array(5 * 5 * 4);
  data[(2 * 5 + 2) * 4 + 3] = 255;
  const interior = referencePositionedSurface({ data, width: 5, height: 5, originX: -10, originY: 20, alphaMode: "straight" });
  assert.doesNotThrow(() => assertReferenceRetainedBoundsCovered(interior));
  data[(4 * 5 + 1) * 4 + 3] = 1;
  expectCode(
    () => assertReferenceRetainedBoundsCovered(interior),
    "CUT_RETAINED_BOUNDS_UNDERRUN",
    /local \(1, 4\), retained \(-9, 24\)/,
  );
});

test("retained cache identity is fixed-order, dependency-order independent, and context-sensitive", () => {
  const affine = referenceAffine2D({ a: 1, b: -0, c: 0, d: 1, tx: 2, ty: -3 });
  const rasterBounds = referenceIntegerRasterBounds(referenceRect(-2, 4, 12, 15));
  const base = {
    algorithmVersion: "phase-a.1", backendIdentity: "cpu-test", semanticIdentity: "node:abc", timeIdentity: "1/24",
    affine, rasterBounds, dependencies: ["font:2", "asset:1"],
  };
  const first = referenceRetainedCacheIdentity(base);
  const reordered = referenceRetainedCacheIdentity({ ...base, dependencies: ["asset:1", "font:2"] });
  assert.deepEqual(first, reordered);
  assert.ok(Object.isFrozen(first));
  assert.match(first.sha256, /^[a-f0-9]{64}$/);
  assert.notEqual(referenceRetainedCacheIdentity({ ...base, backendIdentity: "cpu-other" }).sha256, first.sha256);
  assert.notEqual(referenceRetainedCacheIdentity({ ...base, timeIdentity: "2/24" }).sha256, first.sha256);
  assert.notEqual(referenceRetainedCacheIdentity({ ...base, affine: referenceTranslationAffine2D(3, -3) }).sha256, first.sha256);
  assert.notEqual(referenceRetainedCacheIdentity({ ...base, rasterBounds: referenceIntegerRasterBounds(referenceRect(-2, 4, 13, 15)) }).sha256, first.sha256);
});

test("cache identity rejects aliases, forged bounds, unknown fields, and dependency holes", () => {
  const rasterBounds = referenceIntegerRasterBounds(referenceRect(0, 0, 2, 2));
  const base = {
    algorithmVersion: "phase-a.1", backendIdentity: "cpu", semanticIdentity: "node", timeIdentity: "static",
    affine: referenceIdentityAffine2D, rasterBounds, dependencies: ["a"],
  };
  expectCode(() => referenceRetainedCacheIdentity({ ...base, dependencies: ["same", "same"] }), "CUT_RETAINED_VISUAL_CACHE_IDENTITY", /unique/);
  expectCode(
    () => referenceRetainedCacheIdentity({ ...base, rasterBounds: { ...rasterBounds, pixels: 3 } }),
    "CUT_RETAINED_VISUAL_SHAPE",
    /inconsistent/,
  );
  expectCode(() => referenceRetainedCacheIdentity({ ...base, projectTitle: "forbidden" }), "CUT_RETAINED_VISUAL_SHAPE", /projectTitle/);
  const sparse = new Array<string>(1);
  expectCode(() => referenceRetainedCacheIdentity({ ...base, dependencies: sparse }), "CUT_RETAINED_VISUAL_CACHE_IDENTITY", /holes/);
});

test("retained work accounting is exact, frozen, and fails aggregate overflow", () => {
  const bounds = referenceIntegerRasterBounds(referenceRect(0, 0, 100, 50));
  const one = referenceRetainedRasterWork(bounds, 3), two = referenceRetainedRasterWork(bounds, 2);
  assert.deepEqual(one, { rasterPixels: 5_000, rgbaBytes: 20_000, pixelWork: 15_000 });
  assert.ok(Object.isFrozen(one));
  assert.deepEqual(combineReferenceRetainedWork([one, two]), { rasterPixels: 10_000, rgbaBytes: 40_000, pixelWork: 25_000 });
  expectCode(
    () => combineReferenceRetainedWork([{ rasterPixels: 5_000, rgbaBytes: 1, pixelWork: 15_000 }]),
    "CUT_RETAINED_VISUAL_SHAPE",
    /inconsistent pixel, RGBA-byte, or pixel-pass accounting/,
  );
  expectCode(() => referenceRetainedRasterWork(bounds, 16_385), "CUT_RETAINED_VISUAL_RESOURCE_LIMIT", /passes exceed/);
  expectCode(
    () => combineReferenceRetainedWork(Array.from({ length: 14_000 }, () => one)),
    "CUT_RETAINED_VISUAL_RESOURCE_LIMIT",
    /aggregate retained raster work/,
  );
});
