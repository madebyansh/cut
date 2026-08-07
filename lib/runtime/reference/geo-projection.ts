import { geoNaturalEarth1, type GeoPermissibleObjects, type GeoProjection, type GeoStream, type GeoStreamWrapper } from "d3-geo";
import { feature } from "topojson-client";
import countries from "world-atlas/countries-110m.json";
import {
  referenceMapCameraProjectivePitchPoint,
  referenceMapCameraProjectivePitchPreimage,
  type ReferenceMapCameraProjectivePitchPreimage,
} from "./map-camera-projective-pitch";

export const referenceGeoMapProjectionAlgorithm = "cut-reference-natural-earth-map-v1";
export const referenceGeoMapCameraProjectionAlgorithm = "cut-reference-natural-earth-map-camera-v3";
export const referenceGeoMapInset = 40;
export const referenceGeoMapCameraMaximumProjectedStreamPointEvents = 2_097_152;

export type ReferenceGeoMapPoint = Readonly<{
  latitude: number;
  longitude: number;
}>;

export type ReferenceGeoProjectedPoint = [number, number];

export interface ReferenceGeoMapCameraProjection extends GeoStreamWrapper {
  (point: [number, number]): [number, number] | null;
  clipExtent(): [[number, number], [number, number]] | null;
  clipExtent(extent: [[number, number], [number, number]] | null): this;
  referencePitchEvidence(): Readonly<{
    preimage: ReferenceMapCameraProjectivePitchPreimage;
    projectedStreamPointEvents: number;
  }>;
}

/** MapCamera preserves authored bearing for interpolation and receipts, while
 * projection uses this canonical planar-equivalent angle. Positive bearing is
 * a clockwise camera heading, so geography rotates counterclockwise on the
 * delivery plane. */
export function referenceGeoMapCameraEffectiveBearing(bearingDegrees: number) {
  if (!Number.isFinite(bearingDegrees) || bearingDegrees < -360_000 || bearingDegrees > 360_000) {
    fail("CUT_GEO_PROJECTION_CONFIG", "MapCamera bearing must be finite from -360000 through 360000 degrees.");
  }
  const normalized = ((bearingDegrees % 360) + 360) % 360;
  return Object.is(normalized, -0) || normalized === 360 ? 0 : normalized;
}

export type ReferenceGeoProjectionErrorCode =
  | "CUT_GEO_PROJECTION_CONFIG"
  | "CUT_GEO_PROJECTION_POINT"
  | "CUT_GEO_PROJECTION_RESULT"
  | "CUT_GEO_PROJECTION_LIMIT";

export class ReferenceGeoProjectionError extends Error {
  constructor(readonly code: ReferenceGeoProjectionErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "ReferenceGeoProjectionError";
  }
}

const topology = countries as unknown as { objects: { countries: object } };
const referenceGeoWorld = feature(topology as never, topology.objects.countries as never) as GeoPermissibleObjects;

function fail(code: ReferenceGeoProjectionErrorCode, message: string): never {
  throw new ReferenceGeoProjectionError(code, message);
}

function validateDeliveryDimension(name: "width" | "height", value: number) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail("CUT_GEO_PROJECTION_CONFIG", `Natural Earth delivery ${name} must be a positive safe integer, found ${String(value)}.`);
  }
}

function validatePoint(point: ReferenceGeoMapPoint, label = "Natural Earth point") {
  if (
    !point
    || !Number.isFinite(point.latitude)
    || !Number.isFinite(point.longitude)
    || point.latitude < -90
    || point.latitude > 90
    || point.longitude < -180
    || point.longitude > 180
  ) {
    fail("CUT_GEO_PROJECTION_POINT", `${label} must contain finite latitude [-90, 90] and longitude [-180, 180].`);
  }
}

/**
 * Construct the one canonical Natural Earth map projection used by CUT's
 * reference geo kernels. A new d3 projection is returned on every call, so
 * callers cannot mutate shared projection state across nodes or frames.
 */
export function referenceGeoMapProjection(width: number, height: number): GeoProjection {
  validateDeliveryDimension("width", width);
  validateDeliveryDimension("height", height);
  let projection: GeoProjection;
  try {
    projection = geoNaturalEarth1().fitExtent(
      [[referenceGeoMapInset, referenceGeoMapInset], [width - referenceGeoMapInset, height - referenceGeoMapInset]],
      referenceGeoWorld,
    );
  } catch (error) {
    fail("CUT_GEO_PROJECTION_CONFIG", `Natural Earth fit geometry is invalid: ${error instanceof Error ? error.message : String(error)}.`);
  }
  const scale = projection.scale(), translate = projection.translate();
  if (!Number.isFinite(scale) || !Number.isFinite(translate[0]) || !Number.isFinite(translate[1])) {
    fail("CUT_GEO_PROJECTION_RESULT", "Natural Earth fit produced a non-finite projection.");
  }
  return projection;
}

/** Project one validated geographic anchor through CUT's canonical map fit. */
export function referenceGeoMapPoint(
  width: number,
  height: number,
  point: ReferenceGeoMapPoint,
): ReferenceGeoProjectedPoint {
  validatePoint(point);
  const projected = referenceGeoMapProjection(width, height)([point.longitude, point.latitude]);
  if (!projected || !Number.isFinite(projected[0]) || !Number.isFinite(projected[1])) {
    fail("CUT_GEO_PROJECTION_RESULT", "Natural Earth point projection produced no finite delivery coordinate.");
  }
  return projected;
}

/**
 * Construct MapCamera's canonical Natural Earth projection at one sampled
 * camera state. This is deliberately separate from the frozen standalone map
 * projection: `fitExtent` derives a scale and a content-balanced translation,
 * but the geographic origin is not guaranteed to equal the delivery centre.
 * MapCamera keeps the fitted scale and explicitly recentres (0°, 0°), then
 * applies the published camera algebra without raster resampling.
 */
export function referenceGeoMapCameraProjection(
  width: number,
  height: number,
  center: ReferenceGeoMapPoint,
  scale: number,
  bearingDegrees = 0,
  pitchDegrees = 0,
): ReferenceGeoMapCameraProjection {
  validateDeliveryDimension("width", width);
  validateDeliveryDimension("height", height);
  validatePoint(center, "MapCamera centre");
  if (!Number.isFinite(scale) || scale < 0.25 || scale > 64) {
    fail("CUT_GEO_PROJECTION_CONFIG", "MapCamera scale must be finite from 0.25 through 64.");
  }
  const effectiveBearing = referenceGeoMapCameraEffectiveBearing(bearingDegrees);

  const fitted = referenceGeoMapProjection(width, height);
  const deliveryCenter: [number, number] = [width / 2, height / 2];
  // Preserve the v1 arithmetic branch exactly for omitted/default-equivalent
  // bearing so existing north-up projects retain their pixels.
  let projection: GeoProjection;
  if (effectiveBearing === 0) {
    const base = geoNaturalEarth1().scale(fitted.scale()).translate(deliveryCenter);
    const projectedCenter = base([center.longitude, center.latitude]);
    if (!projectedCenter || !Number.isFinite(projectedCenter[0]) || !Number.isFinite(projectedCenter[1])) {
      fail("CUT_GEO_PROJECTION_RESULT", "MapCamera centre projection produced no finite delivery coordinate.");
    }
    projection = geoNaturalEarth1()
      .scale(base.scale() * scale)
      .translate([
        deliveryCenter[0] - scale * (projectedCenter[0] - deliveryCenter[0]),
        deliveryCenter[1] - scale * (projectedCenter[1] - deliveryCenter[1]),
      ]);
    const actualCenter = projection([center.longitude, center.latitude]);
    if (!actualCenter || !Number.isFinite(actualCenter[0]) || !Number.isFinite(actualCenter[1])) {
      fail("CUT_GEO_PROJECTION_RESULT", "MapCamera transformed centre produced no finite delivery coordinate.");
    }
  } else {
    // d3's positive post-projection angle rotates geography counterclockwise in
    // screen coordinates. Recompute translation from the rotated base so the
    // sampled geographic camera centre remains exactly at delivery centre.
    const base = geoNaturalEarth1().scale(fitted.scale()).translate(deliveryCenter).angle(effectiveBearing);
    const projectedCenter = base([center.longitude, center.latitude]);
    if (!projectedCenter || !Number.isFinite(projectedCenter[0]) || !Number.isFinite(projectedCenter[1])) {
      fail("CUT_GEO_PROJECTION_RESULT", "MapCamera rotated centre projection produced no finite delivery coordinate.");
    }
    projection = geoNaturalEarth1()
      .scale(base.scale() * scale)
      .angle(effectiveBearing)
      .translate([
        deliveryCenter[0] - scale * (projectedCenter[0] - deliveryCenter[0]),
        deliveryCenter[1] - scale * (projectedCenter[1] - deliveryCenter[1]),
      ]);
    const actualCenter = projection([center.longitude, center.latitude]);
    if (!actualCenter || !Number.isFinite(actualCenter[0]) || !Number.isFinite(actualCenter[1])) {
      fail("CUT_GEO_PROJECTION_RESULT", "MapCamera rotated transformed centre produced no finite delivery coordinate.");
    }
  }

  const preimage = referenceMapCameraProjectivePitchPreimage(width, height, pitchDegrees);
  if (preimage.plan.identity) {
    // Add receipt access without interposing another stream or numeric
    // operation. Omitted/default pitch therefore preserves v2 path arithmetic
    // and pixels exactly while current receipts can still close the work proof.
    Object.defineProperty(projection, "referencePitchEvidence", {
      enumerable: false,
      configurable: false,
      writable: false,
      value: () => Object.freeze({ preimage, projectedStreamPointEvents: 0 }),
    });
    return projection as unknown as ReferenceGeoMapCameraProjection;
  }

  let projectedStreamPointEvents = 0;
  let finalClip: [[number, number], [number, number]] | null = null;
  const wrapped = ((point: [number, number]) => {
    const unpitched = projection(point);
    if (!unpitched) return null;
    if (unpitched[0] < preimage.bounds.left || unpitched[0] > preimage.bounds.right
      || unpitched[1] < preimage.bounds.top || unpitched[1] > preimage.bounds.bottom) return null;
    const pitched = referenceMapCameraProjectivePitchPoint(preimage.plan, unpitched);
    return [pitched[0], pitched[1]] as [number, number];
  }) as ReferenceGeoMapCameraProjection;
  Object.defineProperties(wrapped, {
    stream: {
      enumerable: false,
      value(output: GeoStream) {
        const pitched: GeoStream = {
          point(x, y, z) {
            projectedStreamPointEvents += 1;
            if (projectedStreamPointEvents > referenceGeoMapCameraMaximumProjectedStreamPointEvents) {
              fail("CUT_GEO_PROJECTION_LIMIT", `MapCamera pitch exceeds ${referenceGeoMapCameraMaximumProjectedStreamPointEvents} projected stream point events in one sampled projection.`);
            }
            const result = referenceMapCameraProjectivePitchPoint(preimage.plan, [x, y]);
            output.point(result[0], result[1], z);
          },
          lineStart() { output.lineStart(); },
          lineEnd() { output.lineEnd(); },
          polygonStart() { output.polygonStart(); },
          polygonEnd() { output.polygonEnd(); },
          ...(output.sphere ? { sphere() { output.sphere!(); } } : {}),
        };
        return projection.stream(pitched);
      },
    },
    clipExtent: {
      enumerable: false,
      value(extent?: [[number, number], [number, number]] | null) {
        if (arguments.length === 0) return finalClip;
        if (extent === null) {
          finalClip = null;
          projection.clipExtent(null);
          return wrapped;
        }
        if (!extent
          || extent[0][0] !== 0 || extent[0][1] !== 0
          || extent[1][0] !== width || extent[1][1] !== height) {
          fail("CUT_GEO_PROJECTION_CONFIG", "pitched MapCamera accepts only its exact full delivery rectangle as final clip extent.");
        }
        finalClip = [[0, 0], [width, height]];
        projection.clipExtent([
          [preimage.bounds.left, preimage.bounds.top],
          [preimage.bounds.right, preimage.bounds.bottom],
        ]);
        return wrapped;
      },
    },
    referencePitchEvidence: {
      enumerable: false,
      value: () => Object.freeze({ preimage, projectedStreamPointEvents }),
    },
  });
  return wrapped;
}

/** Project through the retained MapCamera path, with no intermediate raster. */
export function referenceGeoMapCameraPoint(
  width: number,
  height: number,
  center: ReferenceGeoMapPoint,
  scale: number,
  point: ReferenceGeoMapPoint,
  bearingDegrees = 0,
  pitchDegrees = 0,
): ReferenceGeoProjectedPoint {
  validatePoint(point);
  const projected = referenceGeoMapCameraProjection(width, height, center, scale, bearingDegrees, pitchDegrees)([point.longitude, point.latitude]);
  if (!projected || !Number.isFinite(projected[0]) || !Number.isFinite(projected[1])) {
    fail("CUT_GEO_PROJECTION_RESULT", "MapCamera point projection produced no finite delivery coordinate.");
  }
  return projected;
}

/** Canonical geometry for paths that share CUT's locked world-atlas source. */
export function referenceGeoWorldGeometry(): unknown {
  return referenceGeoWorld;
}
