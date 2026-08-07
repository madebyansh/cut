/**
 * Source-independent, bounded flat-plane pitch math for MapCamera. This file
 * does not make pitch a public CUT capability: the language/runtime boundary
 * must wrap these diagnostics with the authoring node's source location.
 *
 * Coordinates use CUT delivery space (x right, y down). Bearing and scale have
 * already been applied before this transform. Positive pitch makes the top of
 * the flat map plane recede and the bottom approach the camera. This is not a
 * terrain, globe, building, occlusion, or general Camera3D projection.
 */
export const referenceMapCameraProjectivePitchAlgorithmVersion = "cut-reference-map-camera-flat-pitch-v1" as const;

export const referenceMapCameraProjectivePitchLimits = Object.freeze({
  minimumPitchDegrees: 0,
  maximumPitchDegrees: 60,
  maximumDeliveryAxisPixels: 16_384,
  /** At 60deg, the inverse delivery rectangle reaches exactly this maximum
   * linear span relative to its corresponding delivery axis. */
  maximumPreimageAxisExpansion: 8,
  /** Delivery corners remain above this normalized projective denominator for
   * every accepted pitch. Refusing smaller values prevents horizon-adjacent
   * amplification when callers pass points outside the planned preimage. */
  minimumSafeDenominatorRatio: 1 / 16,
});

export type ReferenceMapCameraProjectivePitchErrorCode =
  | "CUT_MAP_CAMERA_PITCH_CONFIG"
  | "CUT_MAP_CAMERA_PITCH_RANGE"
  | "CUT_MAP_CAMERA_PITCH_POINT"
  | "CUT_MAP_CAMERA_PITCH_DENOMINATOR"
  | "CUT_MAP_CAMERA_PITCH_RESULT"
  | "CUT_MAP_CAMERA_PITCH_RESOURCE_LIMIT";

export class ReferenceMapCameraProjectivePitchError extends Error {
  constructor(readonly code: ReferenceMapCameraProjectivePitchErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "ReferenceMapCameraProjectivePitchError";
  }
}

export type ReferenceMapCameraProjectivePitchPoint = readonly [x: number, y: number];

export type ReferenceMapCameraProjectivePitchPlan = Readonly<{
  algorithmVersion: typeof referenceMapCameraProjectivePitchAlgorithmVersion;
  center: ReferenceMapCameraProjectivePitchPoint;
  deliveryHeight: number;
  /** Flat-plane pinhole focal distance. V1 fixes this to delivery height. */
  focalDistance: number;
  pitchDegrees: number;
  pitchRadians: number;
  cosine: number;
  sine: number;
  identity: boolean;
  minimumSafeDenominator: number;
}>;

export type ReferenceMapCameraProjectivePitchPreimage = Readonly<{
  algorithmVersion: typeof referenceMapCameraProjectivePitchAlgorithmVersion;
  plan: ReferenceMapCameraProjectivePitchPlan;
  delivery: Readonly<{
    width: number;
    height: number;
    corners: readonly [
      topLeft: ReferenceMapCameraProjectivePitchPoint,
      topRight: ReferenceMapCameraProjectivePitchPoint,
      bottomRight: ReferenceMapCameraProjectivePitchPoint,
      bottomLeft: ReferenceMapCameraProjectivePitchPoint,
    ];
  }>;
  /** Delivery corners transformed back onto the unpitched map plane. */
  inverseCorners: readonly [
    topLeft: ReferenceMapCameraProjectivePitchPoint,
    topRight: ReferenceMapCameraProjectivePitchPoint,
    bottomRight: ReferenceMapCameraProjectivePitchPoint,
    bottomLeft: ReferenceMapCameraProjectivePitchPoint,
  ];
  bounds: Readonly<{ left: number; top: number; right: number; bottom: number }>;
  expansion: Readonly<{
    x: number;
    y: number;
    maximumAxis: number;
    limit: typeof referenceMapCameraProjectivePitchLimits.maximumPreimageAxisExpansion;
  }>;
  denominators: Readonly<{
    /** The denominator is affine in y, so the minimum over the rectangular
     * preimage is attained on one of these measured boundary corners. */
    minimumForwardOverPreimageBounds: number;
    minimumInverseOverDeliveryCorners: number;
    minimumSafe: number;
  }>;
}>;

function fail(code: ReferenceMapCameraProjectivePitchErrorCode, message: string): never {
  throw new ReferenceMapCameraProjectivePitchError(code, message);
}

function finitePoint(
  point: ReferenceMapCameraProjectivePitchPoint,
  label: string,
  code: ReferenceMapCameraProjectivePitchErrorCode = "CUT_MAP_CAMERA_PITCH_POINT",
): ReferenceMapCameraProjectivePitchPoint {
  if (!Array.isArray(point) || point.length !== 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
    fail(code, `${label} must contain exactly two finite delivery coordinates.`);
  }
  return point;
}

function deliveryAxis(value: number, label: "width" | "height") {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail("CUT_MAP_CAMERA_PITCH_CONFIG", `delivery ${label} must be a positive safe integer.`);
  }
  if (value > referenceMapCameraProjectivePitchLimits.maximumDeliveryAxisPixels) {
    fail(
      "CUT_MAP_CAMERA_PITCH_RESOURCE_LIMIT",
      `delivery ${label} may not exceed ${referenceMapCameraProjectivePitchLimits.maximumDeliveryAxisPixels}px.`,
    );
  }
}

function checkedDenominator(plan: ReferenceMapCameraProjectivePitchPlan, denominator: number, label: string) {
  if (!Number.isFinite(denominator) || denominator <= 0 || denominator < plan.minimumSafeDenominator) {
    fail(
      "CUT_MAP_CAMERA_PITCH_DENOMINATOR",
      `${label} must be finite and at least ${referenceMapCameraProjectivePitchLimits.minimumSafeDenominatorRatio} of delivery height; the coordinate is horizon-adjacent or behind the flat camera plane.`,
    );
  }
  return denominator;
}

function finiteResult(x: number, y: number, label: string): ReferenceMapCameraProjectivePitchPoint {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    fail("CUT_MAP_CAMERA_PITCH_RESULT", `${label} produced a non-finite delivery coordinate.`);
  }
  return Object.freeze([x, y] as const);
}

/** Create one immutable sampled pitch state. Trigonometry is evaluated once,
 * not independently for each streamed geometry point. */
export function referenceMapCameraProjectivePitchPlan(
  center: ReferenceMapCameraProjectivePitchPoint,
  deliveryHeight: number,
  pitchDegrees: number,
): ReferenceMapCameraProjectivePitchPlan {
  finitePoint(center, "pitch center", "CUT_MAP_CAMERA_PITCH_CONFIG");
  deliveryAxis(deliveryHeight, "height");
  if (!Number.isFinite(pitchDegrees)) {
    fail("CUT_MAP_CAMERA_PITCH_CONFIG", "pitch must be a finite angle in degrees.");
  }
  if (
    pitchDegrees < referenceMapCameraProjectivePitchLimits.minimumPitchDegrees
    || pitchDegrees > referenceMapCameraProjectivePitchLimits.maximumPitchDegrees
  ) {
    fail(
      "CUT_MAP_CAMERA_PITCH_RANGE",
      `pitch must be from ${referenceMapCameraProjectivePitchLimits.minimumPitchDegrees}deg through ${referenceMapCameraProjectivePitchLimits.maximumPitchDegrees}deg.`,
    );
  }

  // A dedicated identity branch below preserves all input coordinates,
  // including negative zero, without routing them through trigonometry.
  const canonicalPitch = Object.is(pitchDegrees, -0) ? 0 : pitchDegrees;
  const identity = canonicalPitch === 0;
  const pitchRadians = identity ? 0 : canonicalPitch * Math.PI / 180;
  const cosine = identity ? 1 : Math.cos(pitchRadians);
  const sine = identity ? 0 : Math.sin(pitchRadians);
  if (!Number.isFinite(cosine) || !Number.isFinite(sine) || cosine <= 0 || sine < 0) {
    fail("CUT_MAP_CAMERA_PITCH_RESULT", "pitch trigonometry produced an invalid bounded-camera state.");
  }
  const minimumSafeDenominator = deliveryHeight * referenceMapCameraProjectivePitchLimits.minimumSafeDenominatorRatio;
  if (!Number.isFinite(minimumSafeDenominator) || minimumSafeDenominator <= 0) {
    fail("CUT_MAP_CAMERA_PITCH_RESULT", "pitch denominator floor is not finite and positive.");
  }
  return Object.freeze({
    algorithmVersion: referenceMapCameraProjectivePitchAlgorithmVersion,
    center: Object.freeze([center[0], center[1]] as const),
    deliveryHeight,
    focalDistance: deliveryHeight,
    pitchDegrees: canonicalPitch,
    pitchRadians,
    cosine,
    sine,
    identity,
    minimumSafeDenominator,
  });
}

/** Project one bearing/scale-resolved delivery-space point through flat-plane
 * pitch. At pitch zero this returns the exact authored numeric coordinates. */
export function referenceMapCameraProjectivePitchPoint(
  plan: ReferenceMapCameraProjectivePitchPlan,
  point: ReferenceMapCameraProjectivePitchPoint,
): ReferenceMapCameraProjectivePitchPoint {
  finitePoint(point, "unpitched point");
  if (plan.identity) return Object.freeze([point[0], point[1]] as const);
  const u = point[0] - plan.center[0], v = point[1] - plan.center[1], d = plan.deliveryHeight;
  const denominator = checkedDenominator(plan, d - v * plan.sine, "forward projective denominator");
  const x = plan.center[0] + d * u / denominator;
  const y = plan.center[1] + d * v * plan.cosine / denominator;
  return finiteResult(x, y, "forward pitch projection");
}

/** Invert one pitched point back onto the bearing/scale-resolved map plane. */
export function referenceMapCameraInverseProjectivePitchPoint(
  plan: ReferenceMapCameraProjectivePitchPlan,
  point: ReferenceMapCameraProjectivePitchPoint,
): ReferenceMapCameraProjectivePitchPoint {
  finitePoint(point, "pitched point");
  if (plan.identity) return Object.freeze([point[0], point[1]] as const);
  const x = point[0] - plan.center[0], y = point[1] - plan.center[1], d = plan.deliveryHeight;
  const denominator = checkedDenominator(plan, d * plan.cosine + y * plan.sine, "inverse projective denominator");
  const u = d * plan.cosine * x / denominator;
  const v = d * y / denominator;
  return finiteResult(plan.center[0] + u, plan.center[1] + v, "inverse pitch projection");
}

/** Plan the unpitched clipping rectangle needed to cover the final delivery
 * surface. The bounded 60deg contract guarantees no more than 8x linear
 * expansion on either axis. */
export function referenceMapCameraProjectivePitchPreimage(
  width: number,
  height: number,
  pitchDegrees: number,
): ReferenceMapCameraProjectivePitchPreimage {
  deliveryAxis(width, "width");
  deliveryAxis(height, "height");
  const plan = referenceMapCameraProjectivePitchPlan([width / 2, height / 2], height, pitchDegrees);
  const corners = Object.freeze([
    Object.freeze([0, 0] as const),
    Object.freeze([width, 0] as const),
    Object.freeze([width, height] as const),
    Object.freeze([0, height] as const),
  ] as const);
  const inverseCorners = Object.freeze(corners.map((corner) =>
    referenceMapCameraInverseProjectivePitchPoint(plan, corner)) as unknown as [
      ReferenceMapCameraProjectivePitchPoint,
      ReferenceMapCameraProjectivePitchPoint,
      ReferenceMapCameraProjectivePitchPoint,
      ReferenceMapCameraProjectivePitchPoint,
    ]);
  const xs = inverseCorners.map((point) => point[0]), ys = inverseCorners.map((point) => point[1]);
  const left = Math.min(...xs), top = Math.min(...ys), right = Math.max(...xs), bottom = Math.max(...ys);
  if (![left, top, right, bottom].every(Number.isFinite) || right <= left || bottom <= top) {
    fail("CUT_MAP_CAMERA_PITCH_RESULT", "inverse delivery corners did not produce finite positive preimage bounds.");
  }
  const expansionX = (right - left) / width, expansionY = (bottom - top) / height;
  const maximumAxis = Math.max(expansionX, expansionY);
  if (!Number.isFinite(maximumAxis) || maximumAxis > referenceMapCameraProjectivePitchLimits.maximumPreimageAxisExpansion) {
    fail(
      "CUT_MAP_CAMERA_PITCH_RESOURCE_LIMIT",
      `inverse delivery preimage expands ${String(maximumAxis)}x; maximum linear axis expansion is ${referenceMapCameraProjectivePitchLimits.maximumPreimageAxisExpansion}x.`,
    );
  }
  const forwardDenominators = inverseCorners.map((point) =>
    plan.deliveryHeight - (point[1] - plan.center[1]) * plan.sine);
  const inverseDenominators = corners.map((point) =>
    plan.deliveryHeight * plan.cosine + (point[1] - plan.center[1]) * plan.sine);
  const minimumForwardOverPreimageBounds = Math.min(...forwardDenominators);
  const minimumInverseOverDeliveryCorners = Math.min(...inverseDenominators);
  checkedDenominator(plan, minimumForwardOverPreimageBounds, "minimum forward preimage-bound denominator");
  checkedDenominator(plan, minimumInverseOverDeliveryCorners, "minimum inverse delivery-corner denominator");
  return Object.freeze({
    algorithmVersion: referenceMapCameraProjectivePitchAlgorithmVersion,
    plan,
    delivery: Object.freeze({ width, height, corners }),
    inverseCorners,
    bounds: Object.freeze({ left, top, right, bottom }),
    expansion: Object.freeze({
      x: expansionX,
      y: expansionY,
      maximumAxis,
      limit: referenceMapCameraProjectivePitchLimits.maximumPreimageAxisExpansion,
    }),
    denominators: Object.freeze({
      minimumForwardOverPreimageBounds,
      minimumInverseOverDeliveryCorners,
      minimumSafe: plan.minimumSafeDenominator,
    }),
  });
}
