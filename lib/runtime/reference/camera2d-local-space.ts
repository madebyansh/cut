import { hash } from "../../core/stable";
import type { CutAVIR, IRComposition, IRNode } from "../../language/ir";
import type { Rational } from "../../language/rational";
import {
  referenceLocalSpaceRasterOrigin,
  type ReferenceLocalSpaceConfig,
  type ReferenceLocalSpacePlacement,
} from "./local-space";
import {
  planReferenceLocalSpaceTileTransformWork,
  referenceLocalSpaceTransformWorkLimits,
  type ReferenceLocalSpaceUniformTileTransformWork,
} from "./local-space-transform-work";
import type { ReferencePreparedSignalResolver } from "./signals";
import { referenceVisualTransformAt } from "./visual-config";
import {
  referenceLocalSpaceScaleTranslationAlgorithmVersion,
  referenceLocalSpaceScaleTranslationSampler,
} from "./local-space-scale-translation";

/** Additive retained branch only. Historical Camera2D children continue down
 * the frozen delivery-canvas compositor path and never use this identity. */
export const referenceCamera2DLocalSpaceAlgorithmVersion = "cut-reference-camera2d-local-space-v1" as const;

export const referenceCamera2DLocalSpaceTransformOrder = Object.freeze([
  "local-registration",
  "scale",
  "rotation",
  "delivery-translation",
  "opacity",
] as const);

export type ReferenceCamera2DLocalSpaceErrorCode =
  | "CUT_CAMERA2D_LOCAL_GRAPH"
  | "CUT_CAMERA2D_LOCAL_TRANSFORM";

export class ReferenceCamera2DLocalSpaceError extends Error {
  readonly source: Readonly<{ module: string; line: number; column: number; nodeId: string }>;

  constructor(readonly code: ReferenceCamera2DLocalSpaceErrorCode, readonly node: IRNode, detail: string) {
    const { module, span } = node.provenance;
    super(`${code}: Camera2D retained LocalSpace at ${module}:${span.start.line}:${span.start.column} ${detail}`);
    this.name = "ReferenceCamera2DLocalSpaceError";
    this.source = Object.freeze({ module, line: span.start.line, column: span.start.column, nodeId: node.id });
  }
}

export type ReferenceCamera2DLocalSpacePlan = Readonly<{
  algorithmVersion: typeof referenceCamera2DLocalSpaceAlgorithmVersion;
  cameraNodeId: string;
  localSpaceNodeId: string;
  exactTime: Rational;
  transformOrder: typeof referenceCamera2DLocalSpaceTransformOrder;
  status: "visible" | "opacity-zero";
  placement: ReferenceLocalSpacePlacement;
  transformWork?: ReferenceLocalSpaceUniformTileTransformWork;
  planIdentity: string;
}>;

function fail(node: IRNode, code: ReferenceCamera2DLocalSpaceErrorCode, detail: string): never {
  throw new ReferenceCamera2DLocalSpaceError(code, node, detail);
}

function assertDirectRetainedOwner(camera: IRNode, localSpace: ReferenceLocalSpaceConfig) {
  if (camera.op !== "cut.visual.camera2d" || camera.domain !== "visual") {
    fail(camera, "CUT_CAMERA2D_LOCAL_GRAPH", `requires one cut.visual.camera2d visual owner; found ${camera.op}/${camera.domain}.`);
  }
  if (camera.children.length !== 1 || camera.children[0] !== localSpace.nodeId) {
    fail(camera, "CUT_CAMERA2D_LOCAL_GRAPH", "must own exactly one direct LocalSpace and no delivery-canvas siblings.");
  }
  if (localSpace.owner !== "camera-2d" || localSpace.ownerNodeId !== camera.id) {
    fail(camera, "CUT_CAMERA2D_LOCAL_GRAPH", `LocalSpace ${localSpace.nodeId} is not registered to this Camera2D owner.`);
  }
}

/** Resolve the same public Camera2D controls as the legacy compositor, then
 * bind them to the retained tile's authored registration point. Allocation is
 * admitted before the renderer asks LocalSpace for pixels. */
export function referenceCamera2DLocalSpacePlanAt(
  ir: CutAVIR,
  composition: IRComposition,
  camera: IRNode,
  localSpace: ReferenceLocalSpaceConfig,
  exactTime: Rational,
  resolver?: ReferencePreparedSignalResolver,
): ReferenceCamera2DLocalSpacePlan {
  assertDirectRetainedOwner(camera, localSpace);
  const transform = referenceVisualTransformAt(
    ir,
    composition,
    camera,
    exactTime,
    { staticPosition: true, staticRotation: true },
    resolver,
  );
  // Camera2D's public surface has no anchor/skew controls. Refuse any future
  // or hostile path that tries to smuggle them through the generic resolver.
  if (transform.anchorX !== 0 || transform.anchorY !== 0 || transform.skewX !== 0 || transform.skewY !== 0) {
    fail(camera, "CUT_CAMERA2D_LOCAL_TRANSFORM", "accepts only x, y, scale, rotation, and opacity; anchor/skew cannot alter the retained branch.");
  }
  const origin = referenceLocalSpaceRasterOrigin(localSpace);
  const contextIdentity = hash({
    algorithmVersion: referenceCamera2DLocalSpaceAlgorithmVersion,
    buildId: ir.buildId,
    composition: { id: composition.id, width: composition.width, height: composition.height },
    cameraContentHash: camera.contentHash,
  });
  const placement: ReferenceLocalSpacePlacement = Object.freeze({
    owner: "camera-2d",
    contextIdentity,
    destinationX: composition.width / 2 + transform.x,
    destinationY: composition.height / 2 + transform.y,
    registrationRasterX: origin.x,
    registrationRasterY: origin.y,
    scale: transform.scale,
    skewX: 0,
    skewY: 0,
    rotation: transform.rotation,
    opacity: transform.opacity,
  });
  const transformWork = transform.opacity === 0 ? undefined : planReferenceLocalSpaceTileTransformWork(camera, {
    source: Object.freeze({ width: localSpace.width, height: localSpace.height }),
    destination: Object.freeze({ width: composition.width, height: composition.height }),
    scale: transform.scale,
    rotation: transform.rotation,
    opacity: transform.opacity,
  });
  const receipt = Object.freeze({
    algorithmVersion: referenceCamera2DLocalSpaceAlgorithmVersion,
    cameraNodeId: camera.id,
    localSpaceNodeId: localSpace.nodeId,
    exactTime: Object.freeze({ ...exactTime }),
    transformOrder: referenceCamera2DLocalSpaceTransformOrder,
    status: transform.opacity === 0 ? "opacity-zero" as const : "visible" as const,
    placement,
    ...(transformWork ? { transformWork } : {}),
  });
  return Object.freeze({ ...receipt, planIdentity: hash(receipt) });
}

export function referenceCamera2DLocalSpaceInspect(camera: IRNode, localSpace: ReferenceLocalSpaceConfig) {
  assertDirectRetainedOwner(camera, localSpace);
  const receipt = Object.freeze({
    algorithmVersion: referenceCamera2DLocalSpaceAlgorithmVersion,
    materialization: "bounded-local-tile-before-camera-transform" as const,
    cameraNodeId: camera.id,
    localSpaceNodeId: localSpace.nodeId,
    dimensions: Object.freeze({ width: localSpace.width, height: localSpace.height }),
    registrationRasterQ16: Object.freeze({ ...localSpace.rasterOriginQ16 }),
    transformOrder: referenceCamera2DLocalSpaceTransformOrder,
    controls: Object.freeze(["x", "y", "scale", "rotation", "opacity"] as const),
    legacyOtherChildren: "unchanged-delivery-canvas-camera2d" as const,
    cache: Object.freeze({
      tileIdentity: "local-content-and-exact-time",
      placementIdentity: "tile-plus-sampled-camera-placement-and-transform-work",
    }),
    scaleTranslationSampling: Object.freeze({
      algorithmVersion: referenceLocalSpaceScaleTranslationAlgorithmVersion,
      sampler: referenceLocalSpaceScaleTranslationSampler,
      fusedWhen: "real-resize-plus-fractional-final-translation-or-legacy-work-ceiling" as const,
      preservedPaths: Object.freeze([
        "neutral-or-no-resize",
        "admitted-integer-phase-placement",
        "rotation",
        "skew",
      ] as const),
    }),
    limits: referenceLocalSpaceTransformWorkLimits,
    localTileSemanticIdentity: localSpace.semanticIdentity,
  });
  return Object.freeze({ ...receipt, semanticIdentity: hash(receipt) });
}
