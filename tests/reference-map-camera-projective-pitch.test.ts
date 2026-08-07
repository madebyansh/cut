import test from "node:test";
import assert from "node:assert/strict";
import {
  ReferenceMapCameraProjectivePitchError,
  referenceMapCameraInverseProjectivePitchPoint,
  referenceMapCameraProjectivePitchLimits,
  referenceMapCameraProjectivePitchPlan,
  referenceMapCameraProjectivePitchPoint,
  referenceMapCameraProjectivePitchPreimage,
} from "../lib/runtime/reference/map-camera-projective-pitch";

function close(actual: number, expected: number, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);
}

function closePoint(actual: readonly [number, number], expected: readonly [number, number], tolerance = 1e-9) {
  close(actual[0], expected[0], tolerance);
  close(actual[1], expected[1], tolerance);
}

function code(expected: ReferenceMapCameraProjectivePitchError["code"]) {
  return (error: unknown) => error instanceof ReferenceMapCameraProjectivePitchError && error.code === expected;
}

test("zero pitch is an exact coordinate identity without trigonometric drift", () => {
  const plan = referenceMapCameraProjectivePitchPlan([960, 540], 1_080, -0);
  assert.equal(plan.identity, true);
  assert.equal(plan.focalDistance, 1_080);
  assert.equal(plan.pitchDegrees, 0);
  assert.equal(Object.is(plan.pitchDegrees, -0), false);
  const fixtures = [
    [-0, 0],
    [1 / 3, -1 / 7],
    [Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER],
  ] as const;
  for (const point of fixtures) {
    const projected = referenceMapCameraProjectivePitchPoint(plan, point);
    const inverse = referenceMapCameraInverseProjectivePitchPoint(plan, point);
    assert.equal(projected[0], point[0]);
    assert.equal(projected[1], point[1]);
    assert.equal(inverse[0], point[0]);
    assert.equal(inverse[1], point[1]);
    assert.equal(Object.is(projected[0], -0), Object.is(point[0], -0));
    assert.equal(Object.is(inverse[0], -0), Object.is(point[0], -0));
  }
  const preimage = referenceMapCameraProjectivePitchPreimage(1_920, 1_080, 0);
  assert.deepEqual(preimage.bounds, {
    left: 0,
    top: 0,
    right: 1_920,
    bottom: 1_080,
  });
  assert.deepEqual(preimage.expansion, { x: 1, y: 1, maximumAxis: 1, limit: 8 });
  assert.deepEqual(preimage.denominators, {
    minimumForwardOverPreimageBounds: 1_080,
    minimumInverseOverDeliveryCorners: 1_080,
    minimumSafe: 67.5,
  });
});

test("forward and inverse implement the published flat-plane equations and round-trip", () => {
  for (const pitch of [1, 18, 37.5, 60]) {
    const plan = referenceMapCameraProjectivePitchPlan([960, 540], 1_080, pitch);
    for (const point of [[960, 540], [480, 270], [1_420, 810], [777.25, -350.5]] as const) {
      const u = point[0] - plan.center[0], v = point[1] - plan.center[1], d = plan.deliveryHeight;
      const denominator = d - v * plan.sine;
      const expected = [
        plan.center[0] + d * u / denominator,
        plan.center[1] + d * v * plan.cosine / denominator,
      ] as const;
      const projected = referenceMapCameraProjectivePitchPoint(plan, point);
      closePoint(projected, expected);
      closePoint(referenceMapCameraInverseProjectivePitchPoint(plan, projected), point, 2e-9);
    }
  }
});

test("inverse delivery corners produce a finite bounded preimage in landscape, portrait, and square", () => {
  for (const [width, height] of [[1_920, 1_080], [1_080, 1_920], [1_024, 1_024]] as const) {
    for (const pitch of [15, 30, 45, 60]) {
      const preimage = referenceMapCameraProjectivePitchPreimage(width, height, pitch);
      assert.ok(preimage.expansion.x >= 1);
      assert.ok(preimage.expansion.y >= 1);
      assert.ok(preimage.expansion.maximumAxis <= referenceMapCameraProjectivePitchLimits.maximumPreimageAxisExpansion);
      assert.equal(preimage.expansion.limit, 8);
      assert.ok(Number.isFinite(preimage.denominators.minimumForwardOverPreimageBounds));
      assert.ok(Number.isFinite(preimage.denominators.minimumInverseOverDeliveryCorners));
      assert.ok(preimage.denominators.minimumForwardOverPreimageBounds >= preimage.denominators.minimumSafe);
      assert.ok(preimage.denominators.minimumInverseOverDeliveryCorners >= preimage.denominators.minimumSafe);
      for (let index = 0; index < preimage.delivery.corners.length; index += 1) {
        const inverse = preimage.inverseCorners[index]!;
        assert.ok(inverse.every(Number.isFinite));
        closePoint(referenceMapCameraProjectivePitchPoint(preimage.plan, inverse), preimage.delivery.corners[index]!, 2e-9);
      }
    }
  }
  const maximum = referenceMapCameraProjectivePitchPreimage(1_920, 1_080, 60);
  assert.ok(maximum.expansion.maximumAxis > 7.99);
  assert.ok(maximum.expansion.maximumAxis <= 8);
  const largestDelivery = referenceMapCameraProjectivePitchPreimage(16_384, 16_384, 60);
  assert.ok(largestDelivery.bounds.right - largestDelivery.bounds.left <= 16_384 * 8);
  assert.ok(largestDelivery.bounds.bottom - largestDelivery.bounds.top <= 16_384 * 8);
});

test("configuration, point, denominator, result, and resource hazards fail deterministically", () => {
  const invalidPlans: Array<[readonly [number, number], number, number, ReferenceMapCameraProjectivePitchError["code"]]> = [
    [[Number.NaN, 0], 1_080, 20, "CUT_MAP_CAMERA_PITCH_CONFIG"],
    [[0, 0], 0, 20, "CUT_MAP_CAMERA_PITCH_CONFIG"],
    [[0, 0], 1_080, Number.POSITIVE_INFINITY, "CUT_MAP_CAMERA_PITCH_CONFIG"],
    [[0, 0], 1_080, -0.000_001, "CUT_MAP_CAMERA_PITCH_RANGE"],
    [[0, 0], 1_080, 60.000_001, "CUT_MAP_CAMERA_PITCH_RANGE"],
    [[0, 0], referenceMapCameraProjectivePitchLimits.maximumDeliveryAxisPixels + 1, 20, "CUT_MAP_CAMERA_PITCH_RESOURCE_LIMIT"],
  ];
  for (const fixture of invalidPlans) {
    const run = () => referenceMapCameraProjectivePitchPlan(fixture[0], fixture[1], fixture[2]);
    assert.throws(run, code(fixture[3]));
    let first = "", second = "";
    try { run(); } catch (error) { first = String(error); }
    try { run(); } catch (error) { second = String(error); }
    assert.equal(second, first);
  }
  assert.throws(
    () => referenceMapCameraProjectivePitchPreimage(16_385, 1_080, 30),
    code("CUT_MAP_CAMERA_PITCH_RESOURCE_LIMIT"),
  );

  const plan = referenceMapCameraProjectivePitchPlan([960, 540], 1_080, 30);
  assert.throws(() => referenceMapCameraProjectivePitchPoint(plan, [Number.NaN, 0]), code("CUT_MAP_CAMERA_PITCH_POINT"));
  assert.throws(() => referenceMapCameraInverseProjectivePitchPoint(plan, [0, Number.NaN]), code("CUT_MAP_CAMERA_PITCH_POINT"));
  const forwardHorizonY = plan.center[1] + plan.deliveryHeight / plan.sine;
  assert.throws(
    () => referenceMapCameraProjectivePitchPoint(plan, [plan.center[0], forwardHorizonY]),
    code("CUT_MAP_CAMERA_PITCH_DENOMINATOR"),
  );
  const unsafeForwardY = plan.center[1]
    + (plan.deliveryHeight - plan.minimumSafeDenominator / 2) / plan.sine;
  assert.throws(
    () => referenceMapCameraProjectivePitchPoint(plan, [plan.center[0], unsafeForwardY]),
    code("CUT_MAP_CAMERA_PITCH_DENOMINATOR"),
  );
  const inverseHorizonY = plan.center[1] - plan.deliveryHeight * plan.cosine / plan.sine;
  assert.throws(
    () => referenceMapCameraInverseProjectivePitchPoint(plan, [plan.center[0], inverseHorizonY]),
    code("CUT_MAP_CAMERA_PITCH_DENOMINATOR"),
  );
  const unsafeInverseY = plan.center[1]
    + (plan.minimumSafeDenominator / 2 - plan.deliveryHeight * plan.cosine) / plan.sine;
  assert.throws(
    () => referenceMapCameraInverseProjectivePitchPoint(plan, [plan.center[0], unsafeInverseY]),
    code("CUT_MAP_CAMERA_PITCH_DENOMINATOR"),
  );
  assert.throws(
    () => referenceMapCameraProjectivePitchPoint(plan, [Number.MAX_VALUE, plan.center[1]]),
    code("CUT_MAP_CAMERA_PITCH_RESULT"),
  );
});
