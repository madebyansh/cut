import test from "node:test";
import assert from "node:assert/strict";
import { hash } from "../lib/core/stable";
import {
  ReferenceProjectiveWarpError,
  planReferenceProjectiveWarp,
  rasterReferenceProjectiveWarp,
  referenceProjectiveWarpLimits,
  referenceProjectiveWarpPhaseUnits,
  type ReferenceProjectiveQuad,
  type ReferenceProjectiveRasterBounds,
  type ReferenceProjectiveWarpDiagnosticCode,
  type ReferenceProjectiveWarpPlan,
} from "../lib/runtime/reference/projective-warp-kernel";

const bounds = (left: number, top: number, right: number, bottom: number): ReferenceProjectiveRasterBounds => ({ left, top, right, bottom });

function rectangle(width: number, height: number, left = 0, top = 0): ReferenceProjectiveQuad {
  return [
    { x: left, y: top },
    { x: left + width, y: top },
    { x: left + width, y: top + height },
    { x: left, y: top + height },
  ];
}

function plan(sourceWidth: number, sourceHeight: number, destinationQuad: ReferenceProjectiveQuad, destinationBounds: ReferenceProjectiveRasterBounds) {
  return planReferenceProjectiveWarp({ sourceWidth, sourceHeight, destinationQuad, destinationBounds });
}

function code(expected: ReferenceProjectiveWarpDiagnosticCode) {
  return (error: unknown) => error instanceof ReferenceProjectiveWarpError && error.code === expected && error.message.startsWith(`${expected}:`);
}

function pixel(data: Uint8Array, width: number, x: number, y: number) {
  const offset = (y * width + x) * 4;
  return [...data.subarray(offset, offset + 4)];
}

function recomputePlanIdentity(planValue: Record<string, unknown>) {
  const identityValue = { ...planValue };
  delete identityValue.planIdentity;
  planValue.planIdentity = hash(identityValue);
}

test("identity outer-edge quad is byte-exact, deterministic, and preserves independent straight hidden RGB", () => {
  const input = Uint8Array.from([
    255, 0, 0, 255, 19, 201, 77, 0, 0, 0, 255, 128,
    1, 2, 3, 4, 80, 90, 100, 255, 230, 220, 210, 64,
  ]);
  const admitted = plan(3, 2, rectangle(3, 2), bounds(0, 0, 3, 2));
  assert.equal(admitted.identityTransform, true);
  assert.equal(admitted.phaseUnits, referenceProjectiveWarpPhaseUnits);
  assert.equal(Object.isFrozen(admitted), true);
  const first = rasterReferenceProjectiveWarp({ data: input, width: 3, height: 2, alphaMode: "straight" }, admitted);
  const second = rasterReferenceProjectiveWarp({ data: input, width: 3, height: 2 }, admitted);
  assert.deepEqual(first.surface.data, input);
  assert.deepEqual(second, first);
  assert.deepEqual({ ...first.surface, data: undefined }, {
    data: undefined,
    width: 3,
    height: 2,
    originX: 0,
    originY: 0,
    alphaMode: "straight",
  });
  assert.deepEqual(first.observedWork, {
    destinationPixelsTested: 6,
    insideQuadPixels: 6,
    integerSamplesCopied: 6,
    bilinearSamplesEvaluated: 0,
    sourceTapsRead: 6,
  });
  assert.deepEqual(pixel(first.surface.data, 3, 1, 0), [19, 201, 77, 0], "integer identity keeps a hidden-RGB straight-alpha byte exactly");
});

test("Q16 fractional translation filters in associated alpha and clears transparent hidden RGB", () => {
  const shifted = plan(2, 1, rectangle(2, 1, 0.5, 0), bounds(0, 0, 3, 1));
  const hiddenRedBesideBlue = rasterReferenceProjectiveWarp({
    data: Uint8Array.of(255, 0, 0, 0, 0, 0, 255, 255),
    width: 2,
    height: 1,
  }, shifted);
  assert.deepEqual([...hiddenRedBesideBlue.surface.data], [
    0, 0, 0, 0,
    0, 0, 255, 128,
    0, 0, 255, 128,
  ]);
  assert.equal(hiddenRedBesideBlue.observedWork.bilinearSamplesEvaluated, 3);

  const translucent = rasterReferenceProjectiveWarp({
    data: Uint8Array.of(200, 100, 50, 128),
    width: 1,
    height: 1,
  }, plan(1, 1, rectangle(1, 1, 0.5, 0), bounds(0, 0, 2, 1)));
  assert.deepEqual([...translucent.surface.data], [200, 100, 50, 64, 200, 100, 50, 64]);

  const fullyHidden = rasterReferenceProjectiveWarp({
    data: Uint8Array.of(250, 99, 17, 0),
    width: 1,
    height: 1,
  }, plan(1, 1, rectangle(1, 1, 0.5, 0.5), bounds(0, 0, 2, 2)));
  assert.deepEqual([...fullyHidden.surface.data], new Array(16).fill(0), "fractional zero-alpha output may not retain hidden source RGB");
});

test("a genuine perspective trapezoid maps its diagonal intersection to an analytic source-centre pixel", () => {
  const perspective = plan(1, 1, [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 2, y: 2 },
    { x: -1, y: 2 },
  ], bounds(0, 0, 1, 1));
  assert.equal(perspective.identityTransform, false);
  assert.ok(BigInt(perspective.homography.forward[6]!) !== 0n || BigInt(perspective.homography.forward[7]!) !== 0n, "golden must exercise a projective rather than affine matrix");
  const result = rasterReferenceProjectiveWarp({ data: Uint8Array.of(31, 127, 241, 203), width: 1, height: 1 }, perspective);
  assert.deepEqual([...result.surface.data], [31, 127, 241, 203], "the destination pixel centre is the exact diagonal intersection and therefore normalized source (1/2,1/2)");
  assert.deepEqual(result.observedWork, {
    destinationPixelsTested: 1,
    insideQuadPixels: 1,
    integerSamplesCopied: 1,
    bilinearSamplesEvaluated: 0,
    sourceTapsRead: 1,
  });
});

test("explicit clipping bounds alter allocation/origin but never the solved homography", () => {
  const quad: ReferenceProjectiveQuad = [
    { x: -0.25, y: 0.125 },
    { x: 4.5, y: 0.5 },
    { x: 3.75, y: 3.875 },
    { x: 0.375, y: 3.25 },
  ];
  const full = plan(4, 3, quad, bounds(-1, 0, 5, 4));
  const clipped = plan(4, 3, quad, bounds(1, 1, 4, 3));
  assert.deepEqual(clipped.homography, full.homography);
  assert.deepEqual(clipped.destination.quadQ16, full.destination.quadQ16);
  assert.notEqual(clipped.planIdentity, full.planIdentity, "allocation/clip bounds still belong in plan and cache identity");

  const source = { data: Uint8Array.from({ length: 4 * 3 * 4 }, (_, index) => (index * 37) % 256), width: 4, height: 3 };
  const fullFrame = rasterReferenceProjectiveWarp(source, full).surface;
  const clippedFrame = rasterReferenceProjectiveWarp(source, clipped).surface;
  assert.deepEqual({ x: clippedFrame.originX, y: clippedFrame.originY }, { x: 1, y: 1 });
  for (let y = clipped.destination.bounds.top; y < clipped.destination.bounds.bottom; y += 1) {
    for (let x = clipped.destination.bounds.left; x < clipped.destination.bounds.right; x += 1) {
      assert.deepEqual(
        pixel(clippedFrame.data, clippedFrame.width, x - clippedFrame.originX, y - clippedFrame.originY),
        pixel(fullFrame.data, fullFrame.width, x - fullFrame.originX, y - fullFrame.originY),
        `clipped global pixel ${x},${y}`,
      );
    }
  }
});

test("seeded convex quads satisfy exact forward/inverse corner properties after Q16 quantization", () => {
  let state = 0x5eed1234;
  const random = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
  const unitCorners = [[0n, 0n], [1n, 0n], [1n, 1n], [0n, 1n]] as const;
  const source = { data: Uint8Array.from({ length: 5 * 4 * 4 }, (_, index) => (index * 29 + 11) % 256), width: 5, height: 4 };
  for (let iteration = 0; iteration < 64; iteration += 1) {
    const left = -20 + random() * 40, top = -20 + random() * 40;
    const width = 8 + random() * 24, height = 8 + random() * 24;
    const jitter = Math.min(width, height) * 0.08;
    const quad: ReferenceProjectiveQuad = [
      { x: left + (random() - 0.5) * jitter, y: top + (random() - 0.5) * jitter },
      { x: left + width + (random() - 0.5) * jitter, y: top + (random() - 0.5) * jitter },
      { x: left + width + (random() - 0.5) * jitter, y: top + height + (random() - 0.5) * jitter },
      { x: left + (random() - 0.5) * jitter, y: top + height + (random() - 0.5) * jitter },
    ];
    const xs = quad.map((point) => point.x), ys = quad.map((point) => point.y);
    const rasterBounds = bounds(Math.floor(Math.min(...xs)), Math.floor(Math.min(...ys)), Math.ceil(Math.max(...xs)), Math.ceil(Math.max(...ys)));
    const admitted = plan(5, 4, quad, rasterBounds);
    const forward = admitted.homography.forward.map(BigInt), inverse = admitted.homography.inverseAdjugate.map(BigInt);
    for (let corner = 0; corner < 4; corner += 1) {
      const [u, v] = unitCorners[corner]!;
      const expectedX = BigInt(admitted.destination.quadQ16[corner].x), expectedY = BigInt(admitted.destination.quadQ16[corner].y);
      const forwardX = forward[0]! * u + forward[1]! * v + forward[2]!;
      const forwardY = forward[3]! * u + forward[4]! * v + forward[5]!;
      const forwardW = forward[6]! * u + forward[7]! * v + forward[8]!;
      assert.equal(forwardX, expectedX * forwardW, `iteration ${iteration} forward x corner ${corner}`);
      assert.equal(forwardY, expectedY * forwardW, `iteration ${iteration} forward y corner ${corner}`);

      const inverseU = inverse[0]! * expectedX + inverse[1]! * expectedY + inverse[2]!;
      const inverseV = inverse[3]! * expectedX + inverse[4]! * expectedY + inverse[5]!;
      const inverseW = inverse[6]! * expectedX + inverse[7]! * expectedY + inverse[8]!;
      assert.equal(inverseU, u * inverseW, `iteration ${iteration} inverse u corner ${corner}`);
      assert.equal(inverseV, v * inverseW, `iteration ${iteration} inverse v corner ${corner}`);
    }
    const first = rasterReferenceProjectiveWarp(source, admitted);
    const second = rasterReferenceProjectiveWarp(source, admitted);
    assert.deepEqual(second, first, `iteration ${iteration} must reproduce exact bytes and observed work`);
    assert.ok(first.observedWork.sourceTapsRead <= admitted.work.maximumBilinearSampleVisits);
  }
});

test("exact near-degeneracy and horizon margins reject unstable nonzero transforms", () => {
  const minimumHeight = referenceProjectiveWarpLimits.minimumQuadAreaPixelsSquared;
  const exactThin = plan(1, 1, rectangle(1, minimumHeight), bounds(0, 0, 1, 1));
  assert.equal(exactThin.identityTransform, false);
  assert.deepEqual([...rasterReferenceProjectiveWarp({ data: Uint8Array.of(1, 2, 3, 255), width: 1, height: 1 }, exactThin).surface.data], [0, 0, 0, 0]);
  assert.throws(
    () => plan(1, 1, rectangle(1, minimumHeight / 2), bounds(0, 0, 1, 1)),
    code("CUT_PROJECTIVE_WARP_QUAD_DEGENERATE"),
  );
  assert.throws(
    () => plan(1, 1, [
      { x: 0, y: 0 }, { x: 10_000, y: 0 }, { x: 20_000, y: 1 / referenceProjectiveWarpPhaseUnits }, { x: 10_000, y: 1 / referenceProjectiveWarpPhaseUnits },
    ], bounds(0, 0, 1, 1)),
    (error: unknown) => code("CUT_PROJECTIVE_WARP_QUAD_DEGENERATE")(error) && (error as Error).message.includes("turn sine"),
  );
  assert.throws(
    () => plan(1, 1, [
      { x: 0, y: 0 }, { x: 10_000, y: 0 }, { x: 5_000.5, y: 100 }, { x: 4_999.5, y: 100 },
    ], bounds(0, 0, 10_001, 100)),
    (error: unknown) => code("CUT_PROJECTIVE_WARP_HOMOGRAPHY_SINGULAR")(error) && (error as Error).message.includes("minimum corner-denominator ratio"),
  );
});

test("quad diagnostics distinguish exact degeneration, order, self-intersection, and non-convexity", () => {
  assert.throws(() => plan(1, 1, [
    { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 },
  ], bounds(0, 0, 2, 2)), code("CUT_PROJECTIVE_WARP_QUAD_DEGENERATE"));
  assert.throws(() => plan(1, 1, [
    { x: 0, y: 0 }, { x: 2, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 2 },
  ], bounds(0, 0, 4, 2)), code("CUT_PROJECTIVE_WARP_QUAD_DEGENERATE"));
  assert.throws(() => plan(1, 1, [
    { x: 0, y: 0 }, { x: 0, y: 2 }, { x: 2, y: 2 }, { x: 2, y: 0 },
  ], bounds(0, 0, 2, 2)), code("CUT_PROJECTIVE_WARP_QUAD_ORDER"));
  assert.throws(() => plan(1, 1, [
    { x: 0, y: 0 }, { x: 3, y: 3 }, { x: 3, y: 0 }, { x: 0, y: 3 },
  ], bounds(0, 0, 3, 3)), code("CUT_PROJECTIVE_WARP_QUAD_ORDER"));
  assert.throws(() => plan(1, 1, [
    { x: 0, y: 0 }, { x: 4, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 4 },
  ], bounds(0, 0, 4, 4)), code("CUT_PROJECTIVE_WARP_QUAD_NON_CONVEX"));
});

test("coordinates, surfaces, allocation, and total work are closed before output allocation", () => {
  assert.throws(
    () => plan(1, 1, [{ x: 0, y: 0 }, { x: Number.NaN, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], bounds(0, 0, 1, 1)),
    code("CUT_PROJECTIVE_WARP_COORDINATE"),
  );
  assert.throws(
    () => plan(1, 1, rectangle(1, 1), bounds(0, 0, 4_097, 4_097)),
    code("CUT_PROJECTIVE_WARP_WORK_LIMIT"),
  );
  assert.throws(
    () => plan(referenceProjectiveWarpLimits.maximumSourceAxis, referenceProjectiveWarpLimits.maximumSourceAxis, rectangle(1, 1), bounds(0, 0, 1, 1)),
    code("CUT_PROJECTIVE_WARP_WORK_LIMIT"),
  );

  const admitted = plan(1, 1, rectangle(1, 1), bounds(0, 0, 1, 1));
  let allocations = 0;
  assert.throws(
    () => rasterReferenceProjectiveWarp({ data: Uint8Array.of(1, 2, 3), width: 1, height: 1 }, admitted, {
      allocateOutput: (bytes) => { allocations += 1; return new Uint8Array(bytes); },
    }),
    code("CUT_PROJECTIVE_WARP_SURFACE"),
  );
  assert.equal(allocations, 0);
  assert.throws(
    () => rasterReferenceProjectiveWarp({ data: Uint8Array.of(1, 2, 3, 4), width: 1, height: 1, alphaMode: "premultiplied" as "straight" }, admitted, {
      allocateOutput: (bytes) => { allocations += 1; return new Uint8Array(bytes); },
    }),
    code("CUT_PROJECTIVE_WARP_SURFACE"),
  );
  assert.equal(allocations, 0);

  const translated = plan(1, 1, rectangle(1, 1, 1, 1), bounds(0, 0, 3, 3));
  const dirty = rasterReferenceProjectiveWarp({ data: Uint8Array.of(9, 8, 7, 255), width: 1, height: 1 }, translated, {
    allocateOutput: (bytes) => new Uint8Array(bytes).fill(231),
  }).surface;
  assert.deepEqual(pixel(dirty.data, dirty.width, 0, 0), [0, 0, 0, 0]);
  assert.deepEqual(pixel(dirty.data, dirty.width, 1, 1), [9, 8, 7, 255]);
  assert.deepEqual(pixel(dirty.data, dirty.width, 2, 2), [0, 0, 0, 0], "allocator garbage outside the quad must be cleared explicitly");
});

test("hostile plans receive exact singularity and coefficient-magnitude diagnostics before allocation", () => {
  const admitted = plan(1, 1, rectangle(1, 1), bounds(0, 0, 1, 1));
  const source = { data: Uint8Array.of(1, 2, 3, 255), width: 1, height: 1 };
  let allocations = 0;
  const singular = structuredClone(admitted) as unknown as { homography: { forward: string[] } };
  singular.homography.forward = new Array<string>(9).fill("0");
  assert.throws(
    () => rasterReferenceProjectiveWarp(source, singular as unknown as ReferenceProjectiveWarpPlan, {
      allocateOutput: (bytes) => { allocations += 1; return new Uint8Array(bytes); },
    }),
    code("CUT_PROJECTIVE_WARP_HOMOGRAPHY_SINGULAR"),
  );
  assert.equal(allocations, 0);

  const missingWork = structuredClone(admitted) as unknown as Record<string, unknown>;
  delete missingWork.work;
  assert.throws(
    () => rasterReferenceProjectiveWarp(source, missingWork as unknown as ReferenceProjectiveWarpPlan, {
      allocateOutput: (bytes) => { allocations += 1; return new Uint8Array(bytes); },
    }),
    (error: unknown) => code("CUT_PROJECTIVE_WARP_PLAN")(error) && (error as Error).message.includes("plan fields"),
  );
  assert.equal(allocations, 0, "missing nested plan structure must fail with a CUT diagnostic before allocation");

  const ignoredField = structuredClone(admitted) as unknown as Record<string, unknown> & { work: Record<string, unknown> };
  ignoredField.work.privateRenderer = "hidden";
  assert.throws(
    () => rasterReferenceProjectiveWarp(source, ignoredField as unknown as ReferenceProjectiveWarpPlan, {
      allocateOutput: (bytes) => { allocations += 1; return new Uint8Array(bytes); },
    }),
    (error: unknown) => code("CUT_PROJECTIVE_WARP_PLAN")(error) && (error as Error).message.includes("plan work fields"),
  );
  assert.equal(allocations, 0, "unknown plan fields may not be silently ignored");

  const excessive = structuredClone(admitted) as unknown as { homography: { forward: string[] } };
  excessive.homography.forward[0] = `1${"0".repeat(200)}`;
  assert.throws(
    () => rasterReferenceProjectiveWarp(source, excessive as unknown as ReferenceProjectiveWarpPlan, {
      allocateOutput: (bytes) => { allocations += 1; return new Uint8Array(bytes); },
    }),
    (error: unknown) => code("CUT_PROJECTIVE_WARP_WORK_LIMIT")(error) && (error as Error).message.includes("coefficient/denominator"),
  );
  assert.equal(allocations, 0);
});

test("hostile canonical-hash plans cannot separate the admitted quad from its homography", () => {
  const admitted = plan(1, 1, rectangle(4, 4), bounds(0, 0, 4, 4));
  const source = { data: Uint8Array.of(1, 2, 3, 255), width: 1, height: 1 };
  const phase = BigInt(referenceProjectiveWarpPhaseUnits);

  const mismatched = structuredClone(admitted) as unknown as Record<string, unknown> & {
    destination: { quadQ16: Array<{ x: string; y: string }> };
    identityTransform: boolean;
  };
  mismatched.destination.quadQ16 = mismatched.destination.quadQ16.map((point) => ({ x: String(BigInt(point.x) + phase), y: point.y }));
  mismatched.identityTransform = false;
  recomputePlanIdentity(mismatched);
  assert.throws(
    () => rasterReferenceProjectiveWarp(source, mismatched as unknown as ReferenceProjectiveWarpPlan),
    (error: unknown) => code("CUT_PROJECTIVE_WARP_PLAN")(error) && (error as Error).message.includes("same four-corner transform"),
  );

  const nonconvex = structuredClone(admitted) as unknown as Record<string, unknown> & {
    destination: { quadQ16: Array<{ x: string; y: string }> };
    identityTransform: boolean;
  };
  nonconvex.destination.quadQ16 = [
    { x: "0", y: "0" },
    { x: String(4n * phase), y: "0" },
    { x: String(phase), y: String(phase) },
    { x: "0", y: String(4n * phase) },
  ];
  nonconvex.identityTransform = false;
  recomputePlanIdentity(nonconvex);
  assert.throws(
    () => rasterReferenceProjectiveWarp(source, nonconvex as unknown as ReferenceProjectiveWarpPlan),
    code("CUT_PROJECTIVE_WARP_QUAD_NON_CONVEX"),
  );

  const signedZero = structuredClone(admitted) as unknown as Record<string, unknown> & {
    destination: { quadQ16: Array<{ x: string; y: string }> };
  };
  signedZero.destination.quadQ16[0]!.x = "-0";
  recomputePlanIdentity(signedZero);
  assert.throws(
    () => rasterReferenceProjectiveWarp(source, signedZero as unknown as ReferenceProjectiveWarpPlan),
    (error: unknown) => code("CUT_PROJECTIVE_WARP_PLAN")(error) && (error as Error).message.includes("signed zero"),
  );
});
