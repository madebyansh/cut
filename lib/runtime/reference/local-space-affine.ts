import { hash } from "../../core/stable";
import {
  referenceLocalSpaceRasterOrigin,
  type ReferenceLocalSpaceConfig,
  type ReferenceLocalSpacePlacement,
} from "./local-space";
import {
  canonicalReferenceLocalSpaceRotationDegrees,
  referenceLocalSpaceResizeGeometry,
} from "./local-space-transform-work";
import {
  composeReferenceAffine2D,
  referenceAffine2D,
  referenceScaleAffine2D,
  referenceTranslationAffine2D,
  referenceRetainedVisualLimits,
  transformReferencePoint,
  type ReferenceAffine2D,
} from "./retained-visual";

/**
 * Continuous authored-point meaning of the retained LocalSpace placement
 * rasterized by `placeRegisteredSurfaceOnCanvas`.
 *
 * The pixel backend may expand intermediate raster bounds, but those expansion
 * translations cancel because both the authored point and the registered
 * origin cross the same scale/skew/rotation stack. This affine deliberately
 * consumes the already-sampled placement; it never samples owner properties or
 * tracking data a second time.
 */
export const referenceLocalSpaceAuthoredPointAffineAlgorithmVersion =
  "cut-reference-local-space-authored-point-affine-v2" as const;

export type ReferenceLocalSpaceAffineErrorCode =
  | "CUT_LOCAL_SPACE_AFFINE_TYPE"
  | "CUT_LOCAL_SPACE_AFFINE_RANGE"
  | "CUT_LOCAL_SPACE_AFFINE_SINGULAR"
  | "CUT_LOCAL_SPACE_AFFINE_GRAPH";

/** Stable internal boundary error. The anchored-path consumer catches this
 * and re-emits its own source-located diagnostic; callers that use the affine
 * primitive directly still receive a machine-stable code and LocalSpace id. */
export class ReferenceLocalSpaceAffineError extends Error {
  constructor(
    readonly code: ReferenceLocalSpaceAffineErrorCode,
    readonly localSpaceNodeId: string,
    detail: string,
  ) {
    super(`${code}: LocalSpace ${localSpaceNodeId} ${detail}`);
    this.name = "ReferenceLocalSpaceAffineError";
  }
}

export type ReferenceLocalSpaceAuthoredPointAffinePlan = Readonly<{
  algorithmVersion: typeof referenceLocalSpaceAuthoredPointAffineAlgorithmVersion;
  localSpaceNodeId: string;
  owner: ReferenceLocalSpacePlacement["owner"];
  contextIdentity: string;
  rasterOrigin: Readonly<{ x: number; y: number }>;
  registrationRaster: Readonly<{ x: number; y: number }>;
  destinationRegistration: Readonly<{ x: number; y: number }>;
  resizeGeometry: ReturnType<typeof referenceLocalSpaceResizeGeometry>;
  transformOrder: readonly [
    "authored-local-to-raster",
    "registration",
    "scale",
    "skew",
    "rotation",
    "destination-translation",
  ];
  affine: ReferenceAffine2D;
  affineIdentity: string;
}>;

function rotationAffine(degrees: number) {
  const canonical = canonicalReferenceLocalSpaceRotationDegrees(degrees);
  if (canonical === 0) return referenceAffine2D({ a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 });
  if (canonical === 90) return referenceAffine2D({ a: 0, b: 1, c: -1, d: 0, tx: 0, ty: 0 });
  if (canonical === 180) return referenceAffine2D({ a: -1, b: 0, c: 0, d: -1, tx: 0, ty: 0 });
  if (canonical === -90) return referenceAffine2D({ a: 0, b: -1, c: 1, d: 0, tx: 0, ty: 0 });
  const radians = canonical * Math.PI / 180;
  return referenceAffine2D({
    a: Math.cos(radians),
    b: Math.sin(radians),
    c: -Math.sin(radians),
    d: Math.cos(radians),
    tx: 0,
    ty: 0,
  });
}

/**
 * Map one authored LocalSpace coordinate into the placement destination.
 *
 * `q` is authored relative to LocalSpace origin. Its raster coordinate is
 * therefore `q + rasterOrigin`. The installed compositor then evaluates:
 *
 * `D * R * K * S * T(-registrationRaster) * T(rasterOrigin) * q`.
 */
export function referenceLocalSpaceAuthoredPointAffinePlan(
  config: Pick<ReferenceLocalSpaceConfig, "nodeId" | "owner" | "width" | "height" | "rasterOriginQ16">,
  placement: ReferenceLocalSpacePlacement,
): ReferenceLocalSpaceAuthoredPointAffinePlan {
  if (placement.owner !== config.owner) {
    throw new ReferenceLocalSpaceAffineError(
      "CUT_LOCAL_SPACE_AFFINE_GRAPH",
      config.nodeId,
      `placement owner ${placement.owner} does not match validated owner ${config.owner}.`,
    );
  }
  const fields = [
    ["destinationX", placement.destinationX],
    ["destinationY", placement.destinationY],
    ["registrationRasterX", placement.registrationRasterX],
    ["registrationRasterY", placement.registrationRasterY],
    ["scale", placement.scale],
    ["skewX", placement.skewX],
    ["skewY", placement.skewY],
    ["rotation", placement.rotation],
    ["opacity", placement.opacity],
  ] as const;
  const invalid = fields.find(([, value]) => !Number.isFinite(value));
  if (invalid) {
    throw new ReferenceLocalSpaceAffineError(
      "CUT_LOCAL_SPACE_AFFINE_TYPE",
      config.nodeId,
      `placement.${invalid[0]} must be finite.`,
    );
  }
  const excessive = fields
    .filter(([name]) => name !== "opacity")
    .find(([, value]) => Math.abs(value) > referenceRetainedVisualLimits.maximumAffineMagnitude);
  if (excessive) {
    throw new ReferenceLocalSpaceAffineError(
      "CUT_LOCAL_SPACE_AFFINE_RANGE",
      config.nodeId,
      `placement.${excessive[0]} exceeds the bounded affine magnitude ${referenceRetainedVisualLimits.maximumAffineMagnitude}.`,
    );
  }
  if (!(placement.scale > 0)) {
    throw new ReferenceLocalSpaceAffineError(
      "CUT_LOCAL_SPACE_AFFINE_RANGE",
      config.nodeId,
      "placement.scale must be greater than zero.",
    );
  }
  if (placement.opacity < 0 || placement.opacity > 1) {
    throw new ReferenceLocalSpaceAffineError(
      "CUT_LOCAL_SPACE_AFFINE_RANGE",
      config.nodeId,
      "placement.opacity must remain in the closed 0 through 1 range.",
    );
  }
  const rasterOrigin = referenceLocalSpaceRasterOrigin(config);
  const registrationRaster = Object.freeze({
    x: placement.registrationRasterX,
    y: placement.registrationRasterY,
  });
  const destinationRegistration = Object.freeze({
    x: placement.destinationX,
    y: placement.destinationY,
  });
  const basisOffsetX = rasterOrigin.x - registrationRaster.x;
  const basisOffsetY = rasterOrigin.y - registrationRaster.y;
  if (!Number.isFinite(rasterOrigin.x) || !Number.isFinite(rasterOrigin.y)
    || Math.abs(basisOffsetX) > referenceRetainedVisualLimits.maximumAffineMagnitude
    || Math.abs(basisOffsetY) > referenceRetainedVisualLimits.maximumAffineMagnitude) {
    throw new ReferenceLocalSpaceAffineError(
      "CUT_LOCAL_SPACE_AFFINE_RANGE",
      config.nodeId,
      "authored origin and raster registration exceed the bounded affine translation envelope.",
    );
  }
  const authoredToRegisteredRaster = referenceTranslationAffine2D(
    basisOffsetX,
    basisOffsetY,
  );
  let resizeGeometry: ReturnType<typeof referenceLocalSpaceResizeGeometry>;
  try { resizeGeometry = referenceLocalSpaceResizeGeometry(config.width, config.height, placement.scale); }
  catch (error) {
    throw new ReferenceLocalSpaceAffineError(
      "CUT_LOCAL_SPACE_AFFINE_RANGE",
      config.nodeId,
      `placement could not derive bounded resize geometry: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Number.isFinite(resizeGeometry.effectiveScale)
    || resizeGeometry.effectiveScale > referenceRetainedVisualLimits.maximumAffineMagnitude) {
    throw new ReferenceLocalSpaceAffineError(
      "CUT_LOCAL_SPACE_AFFINE_RANGE",
      config.nodeId,
      "placement effective raster scale exceeds the bounded affine envelope.",
    );
  }
  const scale = referenceScaleAffine2D(resizeGeometry.effectiveScale);
  const radians = Math.PI / 180;
  const tangentX = Math.tan(placement.skewX * radians);
  const tangentY = Math.tan(placement.skewY * radians);
  const skewDeterminant = 1 - tangentX * tangentY;
  if (!Number.isFinite(tangentX) || !Number.isFinite(tangentY)) {
    throw new ReferenceLocalSpaceAffineError(
      "CUT_LOCAL_SPACE_AFFINE_RANGE",
      config.nodeId,
      "placement skew produces a non-finite affine basis.",
    );
  }
  if (Math.abs(tangentX) > referenceRetainedVisualLimits.maximumAffineMagnitude
    || Math.abs(tangentY) > referenceRetainedVisualLimits.maximumAffineMagnitude
    || Math.abs(tangentX * resizeGeometry.effectiveScale) > referenceRetainedVisualLimits.maximumAffineMagnitude
    || Math.abs(tangentY * resizeGeometry.effectiveScale) > referenceRetainedVisualLimits.maximumAffineMagnitude) {
    throw new ReferenceLocalSpaceAffineError(
      "CUT_LOCAL_SPACE_AFFINE_RANGE",
      config.nodeId,
      `placement scale/skew exceeds the bounded affine magnitude ${referenceRetainedVisualLimits.maximumAffineMagnitude}.`,
    );
  }
  if (!Number.isFinite(skewDeterminant) || Math.abs(skewDeterminant) <= 1e-12) {
    throw new ReferenceLocalSpaceAffineError(
      "CUT_LOCAL_SPACE_AFFINE_SINGULAR",
      config.nodeId,
      "placement scale/skew basis is singular or numerically non-invertible.",
    );
  }
  const skew = referenceAffine2D({
    a: 1,
    b: tangentY,
    c: tangentX,
    d: 1,
    tx: 0,
    ty: 0,
  });
  const rotation = rotationAffine(placement.rotation);
  const destination = referenceTranslationAffine2D(
    destinationRegistration.x,
    destinationRegistration.y,
  );
  let affine: ReferenceAffine2D;
  try {
    affine = composeReferenceAffine2D(
      destination,
      composeReferenceAffine2D(
        rotation,
        composeReferenceAffine2D(
          skew,
          composeReferenceAffine2D(scale, authoredToRegisteredRaster),
        ),
      ),
    );
  } catch (error) {
    throw new ReferenceLocalSpaceAffineError(
      "CUT_LOCAL_SPACE_AFFINE_RANGE",
      config.nodeId,
      `placement could not produce one bounded affine basis: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const identityInput = Object.freeze({
    algorithmVersion: referenceLocalSpaceAuthoredPointAffineAlgorithmVersion,
    localSpaceNodeId: config.nodeId,
    owner: placement.owner,
    rasterOrigin,
    registrationRaster,
    destinationRegistration,
    resizeGeometry,
    placement: Object.freeze({
      scale: placement.scale,
      skewX: placement.skewX,
      skewY: placement.skewY,
      rotation: placement.rotation,
    }),
    affine,
  });
  return Object.freeze({
    algorithmVersion: referenceLocalSpaceAuthoredPointAffineAlgorithmVersion,
    localSpaceNodeId: config.nodeId,
    owner: placement.owner,
    contextIdentity: placement.contextIdentity,
    rasterOrigin,
    registrationRaster,
    destinationRegistration,
    resizeGeometry,
    transformOrder: Object.freeze([
      "authored-local-to-raster",
      "registration",
      "scale",
      "skew",
      "rotation",
      "destination-translation",
    ] as const),
    affine,
    affineIdentity: hash(identityInput),
  });
}

export function referenceLocalSpaceAuthoredPointAffine(
  config: Pick<ReferenceLocalSpaceConfig, "nodeId" | "owner" | "width" | "height" | "rasterOriginQ16">,
  placement: ReferenceLocalSpacePlacement,
) {
  return referenceLocalSpaceAuthoredPointAffinePlan(config, placement).affine;
}

export function referenceLocalSpaceAuthoredPointAt(
  config: Pick<ReferenceLocalSpaceConfig, "nodeId" | "owner" | "width" | "height" | "rasterOriginQ16">,
  placement: ReferenceLocalSpacePlacement,
  point: Readonly<{ x: number; y: number }>,
) {
  return transformReferencePoint(referenceLocalSpaceAuthoredPointAffine(config, placement), point.x, point.y);
}
