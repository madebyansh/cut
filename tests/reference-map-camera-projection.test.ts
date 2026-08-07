import assert from "node:assert/strict";
import test from "node:test";
import {
  ReferenceGeoProjectionError,
  referenceGeoMapCameraPoint,
  referenceGeoMapCameraProjection,
  referenceGeoMapPoint,
} from "../lib/runtime/reference/geo-projection";

const aspects = [
  { width: 640, height: 360 },
  { width: 360, height: 640 },
  { width: 512, height: 512 },
] as const;

test("MapCamera centres the sampled geographic anchor exactly across delivery aspects", () => {
  const center = { latitude: 29.97, longitude: 32.55 };
  for (const aspect of aspects) {
    for (const scale of [0.25, 1, 3, 9, 64]) {
      for (const bearing of [0, 90, -450, 359_999]) {
        const projected = referenceGeoMapCameraPoint(aspect.width, aspect.height, center, scale, center, bearing);
        assert.ok(Math.abs(projected[0] - aspect.width / 2) < 1e-10);
        assert.ok(Math.abs(projected[1] - aspect.height / 2) < 1e-10);
      }
    }
  }
});

test("MapCamera bearing is clockwise camera heading, so +90deg rotates east geography counterclockwise above centre", () => {
  const width = 640, height = 360;
  const center = { latitude: 0, longitude: 0 };
  const east = { latitude: 0, longitude: 30 };
  const northUp = referenceGeoMapCameraPoint(width, height, center, 2, east);
  const eastUp = referenceGeoMapCameraPoint(width, height, center, 2, east, 90);
  assert.ok(northUp[0] > width / 2, JSON.stringify({ northUp }));
  assert.ok(Math.abs(northUp[1] - height / 2) < 1e-9, JSON.stringify({ northUp }));
  assert.ok(Math.abs(eastUp[0] - width / 2) < 1e-9, JSON.stringify({ eastUp }));
  assert.ok(eastUp[1] < height / 2, JSON.stringify({ eastUp }));

  const fullTurn = referenceGeoMapCameraPoint(width, height, center, 2, east, 360);
  assert.ok(Math.abs(fullTurn[0] - northUp[0]) < 1e-9);
  assert.ok(Math.abs(fullTurn[1] - northUp[1]) < 1e-9);
  const negativeTurn = referenceGeoMapCameraPoint(width, height, center, 2, east, -720);
  assert.ok(Math.abs(negativeTurn[0] - northUp[0]) < 1e-9);
  assert.ok(Math.abs(negativeTurn[1] - northUp[1]) < 1e-9);
});

test("MapCamera executes the published final-vector Q algebra without mutating standalone projection", () => {
  const width = 640, height = 360;
  const center = { latitude: 18.5, longitude: -77.2 };
  const point = { latitude: 52.52, longitude: 13.405 };
  const base = referenceGeoMapCameraProjection(width, height, { latitude: 0, longitude: 0 }, 1);
  const basePoint = base([point.longitude, point.latitude])!;
  const baseCenter = base([center.longitude, center.latitude])!;
  const deliveryCenter = [width / 2, height / 2] as const;
  const scale = 9;
  const projected = referenceGeoMapCameraPoint(width, height, center, scale, point);
  assert.ok(Math.abs(projected[0] - (deliveryCenter[0] + scale * (basePoint[0] - baseCenter[0]))) < 1e-9);
  assert.ok(Math.abs(projected[1] - (deliveryCenter[1] + scale * (basePoint[1] - baseCenter[1]))) < 1e-9);

  const standaloneBefore = referenceGeoMapPoint(width, height, point);
  referenceGeoMapCameraProjection(width, height, center, scale);
  assert.deepEqual(referenceGeoMapPoint(width, height, point), standaloneBefore);
  assert.notDeepEqual(referenceGeoMapPoint(width, height, { latitude: 0, longitude: 0 }), [...deliveryCenter]);
});

test("MapCamera projection rejects malformed camera state before geometry work", () => {
  for (const run of [
    () => referenceGeoMapCameraProjection(0, 360, { latitude: 0, longitude: 0 }, 1),
    () => referenceGeoMapCameraProjection(640, 360, { latitude: 91, longitude: 0 }, 1),
    () => referenceGeoMapCameraProjection(640, 360, { latitude: 0, longitude: 181 }, 1),
    () => referenceGeoMapCameraProjection(640, 360, { latitude: 0, longitude: 0 }, 0),
    () => referenceGeoMapCameraProjection(640, 360, { latitude: 0, longitude: 0 }, Number.NaN),
    () => referenceGeoMapCameraProjection(640, 360, { latitude: 0, longitude: 0 }, 1, Number.NaN),
    () => referenceGeoMapCameraProjection(640, 360, { latitude: 0, longitude: 0 }, 1, 360_001),
  ]) {
    assert.throws(run, (error: unknown) => error instanceof ReferenceGeoProjectionError && /^CUT_GEO_PROJECTION_/.test(error.code));
  }
});
