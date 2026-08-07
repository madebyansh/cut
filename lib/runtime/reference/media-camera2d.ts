import { createHash } from "node:crypto";
import { hash } from "../../core/stable";
import { cutReferenceRuntimeIdentity } from "../../version";
import { cutSignalContentHash } from "../graph";
import {
  cutMediaCamera2DMaximumNativeEffectDepth,
  cutMediaCamera2DNativeEffectOps,
} from "../../language/media-camera2d-contract";
import {
  CutResponsiveStackError,
  decodeCutResponsiveSlotMediaContext,
  decodeCutResponsiveStackPlan,
  type CutResponsiveSlotMediaContext,
} from "../../language/responsive-layout";
import type { CutAVIR, IRComposition, IRNode, IRSignal, IRValue } from "../../language/ir";
import { compareRational, multiplyRational, rational, rationalToNumber, subtractRational, type Rational, zeroRational } from "../../language/rational";
import { referenceColorGradeConfigAt, validateReferenceColorGradeConfig } from "./color-grade-config";
import { referenceMediaProfileResourceState } from "./media-profile-state";
import {
  executeReferenceRetainedMediaViewportFrame,
  referenceRetainedMediaCropPixels,
  type ReferenceRetainedMediaViewportPlan,
  type ReferenceRetainedMediaViewportQ16TapDiagnostic,
  type ReferenceRetainedMediaViewportState,
  type ReferenceRetainedMediaViewportSurface,
} from "./retained-media-viewport";
import { referenceRetainedMediaViewportLimits } from "./retained-media-viewport-limits";
import {
  intersectReferenceRects,
  referenceIntegerRasterBounds,
  referenceRect,
  transformReferenceRect,
  type ReferenceAffine2D,
  type ReferenceIntegerRasterBounds,
} from "./retained-visual";
import { referenceShapeNodeConfig, type ReferenceNormalizedCrop } from "./shape-config";
import { propertyAt, type ReferencePreparedSignalResolver } from "./signals";
import { referenceVideoInputConfig, type ReferenceVideoInputConfig } from "./video-config";
import {
  referenceVisualEffectConfig,
  referenceVisualEffectLimits,
  type ReferenceVisualEffectConfig,
} from "./visual-effects";
import {
  referenceMediaCamera2DClampPadding,
  referenceMediaCamera2DInverseAffine,
  referenceMediaCamera2DObservabilityLimits,
  referenceMediaCamera2DOpacityPhase,
  referenceMediaCamera2DOpacityPhaseUnits,
  referenceMediaCamera2DPhaseUnits as referenceMediaCamera2DObservabilityPhaseUnits,
  referenceMediaCamera2DQuantizedAffine,
  validateReferenceMediaCamera2DQ16Observability,
  type ReferenceMediaCamera2DObservabilityReport,
} from "./media-camera2d-observability";

export const referenceMediaCamera2DAlgorithmVersion = "cut-reference-media-camera2d-v1" as const;
// The camera receipt identifies the CUT sampler that actually performs its
// geometry. Decoder/color operations are separately locked in source/profile
// evidence; naming Sharp here would falsely imply a preliminary Sharp fit.
export const referenceMediaCamera2DBackendIdentity = "cut-q16-associated-alpha-bilinear-direct-affine-v1" as const;
export const referenceMediaCamera2DPhaseUnits = referenceMediaCamera2DObservabilityPhaseUnits;
export const referenceMediaCamera2DNativeEffectChainAlgorithmVersion =
  "cut-reference-media-camera2d-native-effect-chain-v1" as const;

export const referenceMediaCamera2DLimits = Object.freeze({
  maximumCamerasPerComposition: 32,
  maximumNativeAxisPx: referenceRetainedMediaViewportLimits.maximumNativeAxisPx,
  maximumNativePixels: referenceRetainedMediaViewportLimits.maximumNativePixels,
  maximumDecodedCropPixels: referenceRetainedMediaViewportLimits.maximumNativePixels,
  maximumClampPaddedAxisPx: 32_768,
  maximumClampPaddedPixels: referenceRetainedMediaViewportLimits.maximumNativePixels,
  maximumOutputAxisPx: 16_384,
  maximumOutputPixels: 16_777_216,
  maximumFramePixelWork: 536_870_912,
  maximumSourceBytes: 8 * 1024 * 1024 * 1024,
  maximumCompositionUniqueSourceBytes: 16 * 1024 * 1024 * 1024,
  maximumSceneUniqueSourceBytes: 16 * 1024 * 1024 * 1024,
  maximumSceneNativePixels: 134_217_728,
  maximumSceneDecodedCropPixels: 134_217_728,
  maximumSceneClampPaddedPixels: 134_217_728,
  maximumSceneOutputPixels: 67_108_864,
  maximumSceneColorGradePixelWork: 134_217_728,
  maximumSceneNativeEffectPixelWork: 536_870_912,
  maximumSceneDecodedFrameSurfaces: 512,
  maximumSceneDecodedFrameRgbaBytes: 2_147_483_648,
  maximumSceneManagedColorConversionPasses: 512,
  maximumSceneManagedColorConversionRgbaBytes: 2_147_483_648,
  maximumSceneBilinearSampleVisits: 268_435_456,
  maximumSceneFramePixelWork: 536_870_912,
  maximumSceneKnownRgbaBytes: 1_073_741_824,
  maximumConcurrentVideoDecoders: 4,
  maximumColorGradeNoOpProofFrames: 1_000_000,
  colorGradeNoOpPropertiesPerFrame: 7,
  maximumNativeEffectDepth: cutMediaCamera2DMaximumNativeEffectDepth,
  maximumSequentialVideoFramesReadPerSceneFrame: 512,
});

export type ReferenceMediaCamera2DDiagnosticCode =
  | "CUT_MEDIA_CAMERA_GRAPH"
  | "CUT_MEDIA_CAMERA_INPUT"
  | "CUT_MEDIA_CAMERA_RESOURCE"
  | "CUT_MEDIA_CAMERA_RANGE"
  | "CUT_MEDIA_CAMERA_LIMIT"
  | "CUT_MEDIA_CAMERA_RASTER"
  | "CUT_MEDIA_CAMERA_PREFLIGHT";

export class ReferenceMediaCamera2DError extends Error {
  readonly source: Readonly<{ module: string; line: number; column: number; nodeId: string }>;

  constructor(readonly code: ReferenceMediaCamera2DDiagnosticCode, readonly node: IRNode, detail: string) {
    const { module, span } = node.provenance;
    super(`${code}: MediaCamera2D at ${module}:${span.start.line}:${span.start.column} ${detail}`);
    this.name = "ReferenceMediaCamera2DError";
    this.source = Object.freeze({ module, line: span.start.line, column: span.start.column, nodeId: node.id });
  }
}

export type ReferenceMediaCamera2DSourcePlan = Readonly<{
  resourceId: string;
  sha256: string;
  selectedVariant: "master" | "proxy" | "not-applicable";
  resourceBytes: number;
  leafKind: "image" | "video";
  streamIndex?: number;
  inputColor?: ReferenceVideoInputConfig["inputColor"];
  videoConfigIdentity?: string;
  cadenceIdentity?: string;
}>;

export type ReferenceMediaCamera2DOutputContext =
  | Readonly<{
    kind: "composition";
    compositionId: string;
    width: number;
    height: number;
    semanticIdentity: string;
  }>
  | Readonly<{
    kind: "responsive-slot";
    compositionId: string;
    compositionWidth: number;
    compositionHeight: number;
    stackNodeId: string;
    slotNodeId: string;
    index: number;
    compilerContextIdentity: string;
    planIdentity: string;
    exactSlot: CutResponsiveSlotMediaContext["exactSlot"];
    rasterSlot: CutResponsiveSlotMediaContext["rasterSlot"];
    localContext: CutResponsiveSlotMediaContext["localContext"];
    width: number;
    height: number;
    clip: "half-open-raster-slot";
    semanticIdentity: string;
  }>;

type ReferenceMediaCamera2DNativeEffectOp =
  typeof cutMediaCamera2DNativeEffectOps[number];

export type ReferenceMediaCamera2DNativeEffectOperationPlan = Readonly<{
  inspectionOrder: number;
  executionOrder: number;
  nodeId: string;
  op: ReferenceMediaCamera2DNativeEffectOp;
  executableContentHash: string;
  executableIdentity: string;
  staticConfigIdentity?: string;
  maximumPixelWork: number;
  maximumOutputSurfaces: 0 | 1 | 2;
  maximumOutputRgbaBytes: number;
  semanticIdentity: string;
}>;

export type ReferenceMediaCamera2DNativeEffectChainPlan = Readonly<{
  algorithmVersion: typeof referenceMediaCamera2DNativeEffectChainAlgorithmVersion;
  basis: "post-crop-source-straight-rgba8";
  order: "inner-to-outer-before-edge-and-affine";
  operations: readonly ReferenceMediaCamera2DNativeEffectOperationPlan[];
  maximumPixelWork: number;
  maximumOutputSurfaces: number;
  maximumOutputRgbaBytes: number;
  semanticIdentity: string;
}>;

export type ReferenceMediaCamera2DNativeEffectFramePlan = Readonly<{
  algorithmVersion: typeof referenceMediaCamera2DNativeEffectChainAlgorithmVersion;
  basis: "post-crop-source-straight-rgba8";
  order: "inner-to-outer-before-edge-and-affine";
  status: "execute" | "opacity-zero";
  operations: readonly Readonly<{
    executionOrder: number;
    nodeId: string;
    op: ReferenceMediaCamera2DNativeEffectOp;
    configIdentity: string;
    pixelWork: number;
    outputSurfaces: 0 | 1 | 2;
    outputRgbaBytes: number;
  }>[];
  pixelWork: number;
  outputSurfaces: number;
  outputRgbaBytes: number;
  planIdentity: string;
}>;

export type ReferenceMediaCamera2DNativeEffectRuntime = Readonly<{
  operations: readonly Readonly<{
    executionOrder: number;
    nodeId: string;
    op: ReferenceMediaCamera2DNativeEffectOp;
    configIdentity: string;
    outputRgbaSha256: string;
    outputRgbaBytes: number;
  }>[];
  finalRgbaSha256: string;
}>;

export const referenceMediaCamera2DStaticGradeCacheAlgorithmVersion =
  "cut-reference-static-media-grade-cache-v2" as const;
export const referenceMediaCamera2DStaticGradeCacheLimits = Object.freeze({
  maximumBytes: 64 * 1024 * 1024,
  maximumEntries: 8,
});
export const referenceMediaCamera2DStaticGradeBackendIdentity = hash({
  runtime: cutReferenceRuntimeIdentity,
  mediaCamera2D: referenceMediaCamera2DBackendIdentity,
  colorGradePixelContract: "rgba8-straight-native-crop-color-grade",
});

export function referenceMediaCamera2DStaticGradeCacheIdentity(input: Readonly<{
  sourceSemanticIdentity: string;
  sourceRgbaSha256: string;
  width: number;
  height: number;
  gradeNodeId: string;
  gradeExecutionIdentity: string;
  backendIdentity: string;
}>) {
  return hash({
    algorithmVersion: referenceMediaCamera2DStaticGradeCacheAlgorithmVersion,
    ...input,
    pixelContract: "rgba8-straight-native-crop-color-grade",
  });
}

export type ReferenceMediaCamera2DStaticGradeCacheEvidence = Readonly<{
  algorithmVersion: typeof referenceMediaCamera2DStaticGradeCacheAlgorithmVersion;
  status: "hit" | "miss" | "bypass-capacity" | "bypass-dynamic";
  cacheIdentity: string;
  sourceRgbaSha256: string;
  outputRgbaSha256: string;
  residentBytes: number;
  entries: number;
  residentCopies: 0 | 1;
  residentCopyRgbaBytes: number;
  handoffCopies: 0 | 1;
  handoffRgbaBytes: number;
  leaseHandoffs: 0 | 1;
  leaseRgbaBytes: number;
}>;

export type ReferenceMediaCamera2DStaticGradeLeaseExecutionAuthority = Readonly<{
  format: "cut-reference-media-camera2d-static-grade-lease-execution-authority";
  version: 1;
}>;
const staticGradeLeaseExecutionAuthorities = new WeakMap<object, Readonly<{
  source: ReferenceRetainedMediaViewportSurface;
  data: Uint8Array;
  evidence: ReferenceMediaCamera2DStaticGradeCacheEvidence;
}>>();

/** Internal renderer/cache bridge. The opaque authority is one-shot and is
 * consumed by the fixed Q16 camera executor before it may trust the resident
 * cache hash without rereading the complete surface. */
export function createReferenceMediaCamera2DStaticGradeLeaseExecutionAuthority(
  source: ReferenceRetainedMediaViewportSurface,
  evidence: ReferenceMediaCamera2DStaticGradeCacheEvidence,
): ReferenceMediaCamera2DStaticGradeLeaseExecutionAuthority {
  if (evidence.algorithmVersion !== referenceMediaCamera2DStaticGradeCacheAlgorithmVersion
    || evidence.status !== "hit"
    || evidence.handoffCopies !== 0 || evidence.handoffRgbaBytes !== 0
    || evidence.leaseHandoffs !== 1 || evidence.leaseRgbaBytes !== source.data.byteLength
    || !/^[a-f0-9]{64}$/u.test(evidence.outputRgbaSha256)
    || source.data.byteLength !== source.width * source.height * 4) {
    throw new Error("CUT_MEDIA_CAMERA_RASTER: immutable static-grade execution authority requires one exact resident lease.");
  }
  const authority = Object.freeze({
    format: "cut-reference-media-camera2d-static-grade-lease-execution-authority" as const,
    version: 1 as const,
  });
  staticGradeLeaseExecutionAuthorities.set(authority, Object.freeze({
    source,
    data: source.data,
    evidence,
  }));
  return authority;
}

function consumeReferenceMediaCamera2DStaticGradeLeaseExecutionAuthority(
  authority: ReferenceMediaCamera2DStaticGradeLeaseExecutionAuthority | undefined,
  source: ReferenceRetainedMediaViewportSurface,
  evidence: ReferenceMediaCamera2DStaticGradeCacheEvidence | undefined,
) {
  if (!authority) return false;
  const binding = staticGradeLeaseExecutionAuthorities.get(authority);
  staticGradeLeaseExecutionAuthorities.delete(authority);
  if (!binding || binding.source !== source || binding.data !== source.data || binding.evidence !== evidence) {
    throw new Error("CUT_MEDIA_CAMERA_RASTER: static-grade lease execution authority is foreign, replayed, or bound to different bytes/evidence.");
  }
  return true;
}

export type ReferenceMediaCamera2DNativeEffectEvidence = Readonly<{
  algorithmVersion: typeof referenceMediaCamera2DNativeEffectChainAlgorithmVersion;
  basis: "post-crop-source-straight-rgba8";
  order: "inner-to-outer-before-edge-and-affine";
  status: "executed" | "skipped-opacity-zero";
  planIdentity: string;
  operations: readonly Readonly<{
    executionOrder: number;
    nodeId: string;
    op: ReferenceMediaCamera2DNativeEffectOp;
    configIdentity: string;
    outputRgbaSha256?: string;
    outputRgbaBytes: number;
  }>[];
  finalRgbaSha256?: string;
  executionIdentity: string;
}>;

export type ReferenceMediaCamera2DPlan = Readonly<{
  algorithmVersion: typeof referenceMediaCamera2DAlgorithmVersion;
  backendIdentity: typeof referenceMediaCamera2DBackendIdentity;
  compositionId: string;
  sceneId: string;
  cameraNodeId: string;
  cameraExecutableContentHash: string;
  cameraExecutableIdentity: string;
  gradeNodeId?: string;
  gradeExecutableContentHash?: string;
  gradeExecutableIdentity?: string;
  nativeEffectChain?: ReferenceMediaCamera2DNativeEffectChainPlan;
  leafNodeId: string;
  leafExecutableContentHash: string;
  leafExecutableIdentity: string;
  leafKind: "image" | "video";
  fit: "cover" | "contain" | "fill";
  crop?: ReferenceNormalizedCrop;
  native: Readonly<{ width: number; height: number; pixels: number }>;
  decodedCrop: Readonly<{ left: number; top: number; width: number; height: number; pixels: number }>;
  output: Readonly<{ width: number; height: number; pixels: number; rgbaBytes: number }>;
  outputContext: ReferenceMediaCamera2DOutputContext;
  source: ReferenceMediaCamera2DSourcePlan;
  edge: "transparent" | "clamp";
  controls: Readonly<{
    focusX: "ratio-0-to-1";
    focusY: "ratio-0-to-1";
    zoom: "scalar-1-to-8";
    rotation: "degrees-around-delivery-centre";
    opacity: "ratio-0-to-1";
  }>;
  transformOrder: readonly ["fit-scale", "focus-to-delivery-centre", "zoom", "rotate-about-delivery-centre", "opacity"];
  decodePlan: ReferenceRetainedMediaViewportPlan;
  maximumStaticWork: Readonly<{
    sourceFileBytes: number;
    nativePixels: number;
    decodedCropPixels: number;
    decodedCropRgbaBytes: number;
    outputPixels: number;
    outputRgbaBytes: number;
    maximumColorGradePixelPasses: 0 | 2;
    maximumColorGradePixelWork: number;
    maximumColorGradeRgbaBytes: number;
    maximumNativeEffectPixelWork?: number;
    maximumNativeEffectOutputSurfaces?: number;
    maximumNativeEffectOutputRgbaBytes?: number;
  }>;
  observability: ReferenceMediaCamera2DObservabilityReport;
  semanticIdentity: string;
}>;

type Q16Point = Readonly<{ x: string; y: string }>;

export type ReferenceMediaCamera2DFramePlan = Readonly<{
  algorithmVersion: typeof referenceMediaCamera2DAlgorithmVersion;
  compositionId: string;
  sceneId: string;
  cameraNodeId: string;
  leafNodeId: string;
  outputContext: ReferenceMediaCamera2DOutputContext;
  exactTime: Rational;
  status: "visible" | "opacity-zero";
  controls: Readonly<{
    focusX: number;
    focusY: number;
    zoom: number;
    rotationDegrees: number;
    opacity: number;
    opacityPhase: number;
    edge: "transparent" | "clamp";
  }>;
  geometry: Readonly<{
    sourceToDeliveryQ16: Readonly<{ a: string; b: string; c: string; d: string; tx: string; ty: string }>;
    sourceQuadQ16: readonly [Q16Point, Q16Point, Q16Point, Q16Point];
    deliveryOuterEdgesInSourceQ16: readonly [Q16Point, Q16Point, Q16Point, Q16Point];
    outputBounds?: ReferenceIntegerRasterBounds;
    clampPadding: Readonly<{ left: number; top: number; right: number; bottom: number }>;
    rasterSource: Readonly<{ width: number; height: number; pixels: number; rgbaBytes: number }>;
  }>;
  work: Readonly<{
    sourceFileBytes: number;
    nativePixels: number;
    decodedCropPixels: number;
    decodedCropRgbaBytes: number;
    clampPaddedPixels: number;
    clampPaddedRgbaBytes: number;
    outputPixels: number;
    outputRgbaBytes: number;
    maximumDecodePixelWork: number;
    maximumManagedColorConversionPixelWork: number;
    colorGradePixelPasses: 0 | 1 | 2;
    maximumColorGradePixelWork: number;
    nativeEffectOperationCount?: number;
    maximumNativeEffectPixelWork?: number;
    maximumNativeEffectOutputRgbaBytes?: number;
    maximumBilinearSampleVisits: number;
    maximumPixelWork: number;
    compositionPrerasterCount: 0;
    geometricResampleCount: 0 | 1;
  }>;
  gradeExecutionIdentity?: string;
  nativeEffectChain?: ReferenceMediaCamera2DNativeEffectFramePlan;
  videoDecode?: ReferenceMediaCamera2DVideoDecodePlan;
  rasterPlan?: ReferenceRetainedMediaViewportPlan;
  rasterState?: ReferenceRetainedMediaViewportState;
  planIdentity: string;
}>;

export const referenceMediaCamera2DAnchorAlgorithmVersion =
  "cut-reference-media-camera2d-source-anchor-v1" as const;
export const referenceMediaCamera2DResponsiveSlotAnchorAlgorithmVersion =
  "cut-reference-media-camera2d-responsive-slot-anchor-v1" as const;
export const referenceMediaCamera2DResponsiveSlotPixelPlacementAlgorithmVersion =
  "cut-reference-responsive-slot-integer-translate-clip-v1" as const;

export type ReferenceMediaCamera2DResponsiveSlotAnchorPlacement = Readonly<{
  algorithmVersion: typeof referenceMediaCamera2DResponsiveSlotAnchorAlgorithmVersion;
  pixelPlacementAlgorithmVersion: typeof referenceMediaCamera2DResponsiveSlotPixelPlacementAlgorithmVersion;
  compositionId: string;
  stackNodeId: string;
  slotNodeId: string;
  index: number;
  compilerContextIdentity: string;
  outputContextIdentity: string;
  responsivePlanIdentity: string;
  sourceToSlotQ16: Readonly<{
    a: string;
    b: string;
    c: string;
    d: string;
    tx: string;
    ty: string;
  }>;
  sourceToSlotAffineIdentity: string;
  slotBasis: Readonly<{
    kind: "responsive-slot-pixel-centres";
    width: number;
    height: number;
    semanticIdentity: string;
  }>;
  slotToCompositionQ16: Readonly<{
    a: "65536";
    b: "0";
    c: "0";
    d: "65536";
    tx: string;
    ty: string;
  }>;
  compositionBasis: Readonly<{
    kind: "composition-pixel-centres";
    width: number;
    height: number;
    semanticIdentity: string;
  }>;
  rasterSlot: Readonly<{
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
  }>;
  clip: "half-open-raster-slot";
  placementPlanIdentity: string;
}>;

/**
 * Pixel-free coordinate basis exported to generic anchored geometry.
 *
 * The basis is the locked post-crop source raster: (0,0) is the first source
 * pixel centre and (width-1,height-1) is the last. The affine is the exact
 * Q16 source-to-delivery matrix used by the native camera sampler. No decoder,
 * grade surface, or media pixel participates in this plan.
 */
export type ReferenceMediaCamera2DAnchorPlan = Readonly<{
  algorithmVersion: typeof referenceMediaCamera2DAnchorAlgorithmVersion;
  cameraNodeId: string;
  exactTime: Rational;
  status: "visible" | "opacity-zero";
  basis: Readonly<{
    kind: "post-crop-source-pixel-centres";
    width: number;
    height: number;
    semanticIdentity: string;
  }>;
  controls: Readonly<{
    focusX: number;
    focusY: number;
    zoom: number;
    rotationDegrees: number;
    opacity: number;
    opacityPhase: number;
  }>;
  sourceToDeliveryQ16: Readonly<{
    a: string;
    b: string;
    c: string;
    d: string;
    tx: string;
    ty: string;
  }>;
  sourceToDelivery: ReferenceAffine2D;
  /** Present only when the camera renders into one authenticated
   * ResponsiveSlot. `sourceToDelivery*` is then the exact composed
   * source-to-composition affine; this receipt preserves the sampler's
   * source-to-slot affine and the zero-resample integer slot placement as
   * separately auditable bases. */
  responsiveSlotComposition?: ReferenceMediaCamera2DResponsiveSlotAnchorPlacement;
  affineIdentity: string;
  /** Audit-only owner receipt; downstream geometry/cache identity must use
   * affineIdentity instead so grade/media bytes and opacity cannot leak in. */
  ownerPlanIdentity: string;
}>;

type ReferenceMediaCamera2DPlanAuthority = Readonly<{
  ir: CutAVIR;
  composition: IRComposition;
  staticStateIdentity: string;
}>;

const mediaCamera2DPlanAuthorities =
  new WeakMap<ReferenceMediaCamera2DPlan, ReferenceMediaCamera2DPlanAuthority>();
const mediaCamera2DFramePlanAuthorities =
  new WeakMap<ReferenceMediaCamera2DFramePlan, Readonly<{
    ir: CutAVIR;
    composition: IRComposition;
    plan: ReferenceMediaCamera2DPlan;
  }>>();
const mediaCamera2DAnchorPlanAuthorities =
  new WeakMap<ReferenceMediaCamera2DAnchorPlan, Readonly<{
    ir: CutAVIR;
    composition: IRComposition;
    plan: ReferenceMediaCamera2DPlan;
  }>>();

export type ReferenceMediaCamera2DExecutionEvidence = Readonly<{
  format: "cut-reference-media-camera2d-frame-evidence";
  version: 1;
  evidenceKind: "completed-media-camera2d-frame";
  algorithmVersion: typeof referenceMediaCamera2DAlgorithmVersion;
  backendIdentity: typeof referenceMediaCamera2DBackendIdentity;
  status: "rendered" | "opacity-zero";
  compositionId: string;
  sceneId: string;
  cameraNodeId: string;
  gradeNodeId?: string;
  leafNodeId: string;
  leafKind: "image" | "video";
  exactTime: Rational;
  outputFrame: string;
  source: ReferenceMediaCamera2DSourcePlan;
  outputContext: ReferenceMediaCamera2DOutputContext;
  observability: ReferenceMediaCamera2DObservabilityReport;
  sceneAdmission: ReferenceMediaCamera2DSceneAdmission;
  controls: ReferenceMediaCamera2DFramePlan["controls"];
  geometry: ReferenceMediaCamera2DFramePlan["geometry"];
  videoDecode?: ReferenceMediaCamera2DVideoDecodePlan;
  nativeEffectChain?: ReferenceMediaCamera2DNativeEffectEvidence;
  staticGradeCache?: ReferenceMediaCamera2DStaticGradeCacheEvidence;
  allocations: Readonly<{
    sourceOpens: number;
    readerPullAttempts: number;
    decodedFramesRead: number;
    decodedSurfaces: number;
    decodedRgbaBytes: number;
    managedColorConversionSurfaces: number;
    managedColorConversionRgbaBytes: number;
    decoderRetainedFrameCopies: 0;
    decoderRetainedFrameCopyRgbaBytes: 0;
    linearBalanceSurfaces: 0 | 1;
    linearBalanceRgbaBytes: number;
    backendGradeSurfaces: 0 | 1;
    backendGradeRgbaBytes: number;
    colorGradeSurfaces: 0 | 1 | 2;
    colorGradeRgbaBytes: number;
    nativeEffectSurfaces?: number;
    nativeEffectRgbaBytes?: number;
    clampPaddingSurfaces: 0 | 1;
    clampPaddingRgbaBytes: number;
    compositionPrerasterCount: 0;
    compositionPrerasterRgbaBytes: 0;
    geometricResampleCount: 0 | 1;
    outputSurfaces: 1;
    outputRgbaBytes: number;
    outputHandoffCopies: 0;
    outputHandoffRgbaBytes: 0;
  }>;
  work: ReferenceMediaCamera2DFramePlan["work"];
  gradeExecutionIdentity?: string;
  framePlanIdentity: string;
  samplerExecutionIdentity?: string;
  outputRgbaSha256: string;
  executionIdentity: string;
}>;

export type ReferenceMediaCamera2DDecodedRuntime = Readonly<{
  sourceOpens: number;
  readerPullAttempts: number;
  decodedFramesRead: number;
  decodedSurfaces: number;
  managedColorConversionSurfaces: number;
  linearBalanceSurfaces: 0 | 1;
  backendGradeSurfaces: 0 | 1;
  nativeEffect?: ReferenceMediaCamera2DNativeEffectRuntime;
  staticGradeCache?: ReferenceMediaCamera2DStaticGradeCacheEvidence;
  staticGradeSourceRgbaSha256?: string;
}>;

export type ReferenceMediaCamera2DVideoDecoderState = Readonly<{
  status: "unopened" | "open" | "ended";
  lastFrame: number;
  hasCurrentFrame: boolean;
  frameLimit?: number;
}>;

export type ReferenceMediaCamera2DVideoDecodePlan = Readonly<{
  targetFrame: number;
  frameLimit: number;
  strategy: "opacity-zero-skip" | "reuse-current" | "sequential-catch-up" | "sequential-to-hold" | "held-frame";
  stateAtPreflight: ReferenceMediaCamera2DVideoDecoderState;
  planned: Readonly<{
    sourceOpens: 0 | 1;
    readerPullAttempts: number;
    decodedFramesRead: number;
    decodedSurfaces: number;
    decodedRgbaBytes: number;
    managedColorConversionPasses: number;
    managedColorConversionSurfaces: number;
    managedColorConversionRgbaBytes: number;
    decoderRetainedFrameCopies: 0;
    decoderRetainedFrameCopyRgbaBytes: 0;
  }>;
  maximum: Readonly<{
    decodePixelWork: number;
    managedColorConversionPixelWork: number;
    decoderPeakResidentSurfaces: number;
    decoderPeakResidentRgbaBytes: number;
  }>;
  planIdentity: string;
}>;

export type ReferenceMediaCamera2DSceneAdmission = Readonly<{
  format: "cut-reference-media-camera2d-scene-admission";
  version: 1;
  algorithmVersion: typeof referenceMediaCamera2DAlgorithmVersion;
  compositionId: string;
  sceneId: string;
  exactTime: Rational;
  cameraCount: number;
  visibleCameraCount: number;
  opacityZeroCameraCount: number;
  members: readonly Readonly<{
    cameraNodeId: string;
    planIdentity: string;
    framePlanIdentity: string;
  }>[];
  aggregate: Readonly<{
    uniqueSourceFileBytes: number;
    nativePixels: number;
    nativeRgbaBytes: number;
    decodedCropPixels: number;
    decodedCropRgbaBytes: number;
    clampPaddedPixels: number;
    clampPaddedRgbaBytes: number;
    outputPixels: number;
    outputRgbaBytes: number;
    plannedSourceOpens: number;
    plannedReaderPullAttempts: number;
    plannedDecodedFramesRead: number;
    plannedDecodedSurfaces: number;
    plannedDecodedRgbaBytes: number;
    plannedManagedColorConversionPasses: number;
    plannedManagedColorConversionSurfaces: number;
    plannedManagedColorConversionRgbaBytes: number;
    maximumDecodePixelWork: number;
    maximumManagedColorConversionPixelWork: number;
    maximumDecoderPeakResidentSurfaces: number;
    maximumDecoderPeakResidentRgbaBytes: number;
    colorGradePixelPasses: number;
    maximumColorGradePixelWork: number;
    maximumColorGradeRgbaBytes: number;
    nativeEffectOperations?: number;
    maximumNativeEffectPixelWork?: number;
    maximumNativeEffectOutputRgbaBytes?: number;
    maximumBilinearSampleVisits: number;
    maximumPixelWork: number;
    conservativePeakRgbaBytes: number;
    concurrentVideoDecoders: number;
  }>;
  admissionIdentity: string;
}>;

function fail(node: IRNode, code: ReferenceMediaCamera2DDiagnosticCode, detail: string): never {
  throw new ReferenceMediaCamera2DError(code, node, detail);
}

/** Bind the executable node plus the complete definitions of every directly
 * attached signal. Node content hashes alone are not a TOCTOU boundary: a
 * hostile mutable IR can alter a signal object without rebuilding its owner. */
function executableNodeIdentity(ir: CutAVIR, node: IRNode) {
  const signals = Object.fromEntries(
    Object.entries(node.properties)
      .filter((entry): entry is [string, Extract<IRNode["properties"][string], { signal: string }>] =>
        Boolean(entry[1] && "signal" in entry[1]))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([property, attached]) => {
        const signal = ir.signals[attached.signal];
        return [property, signal ? cutSignalContentHash(signal) : `missing:${attached.signal}`];
      }),
  );
  const executableNode = Object.fromEntries(
    Object.entries(node).filter(([field]) => field !== "contentHash" && field !== "provenance"),
  );
  return hash(Object.freeze({ node: executableNode, signals }));
}

function sameRational(left: Rational, right: Rational) {
  return compareRational(left, right) === 0;
}

function exactPureVisual(node: IRNode) {
  return node.domain === "visual"
    && node.editorial === undefined
    && node.effects.length === 1
    && node.effects[0] === "pure";
}

function assertClosedKeys(node: IRNode, value: Record<string, unknown>, allowed: readonly string[], label: string) {
  const unsupported = Object.keys(value).filter((key) => !allowed.includes(key)).sort();
  if (unsupported.length) fail(node, "CUT_MEDIA_CAMERA_GRAPH", `${label} contains unsupported field${unsupported.length === 1 ? "" : "s"} ${unsupported.join(", ")}; MediaCamera2D never accepts and ignores descendant or camera controls.`);
}

function quantity(
  node: IRNode,
  value: IRValue | undefined,
  label: string,
  dimension: string,
  unit: string,
  minimum: number,
  maximum: number,
  fallback: number,
) {
  if (value === undefined || value.kind === "null") return fallback;
  if (value.kind !== "quantity" || value.dimension !== dimension || value.unit !== unit) {
    fail(node, "CUT_MEDIA_CAMERA_INPUT", `${label} must be a canonical ${dimension} quantity in ${unit}.`);
  }
  const result = rationalToNumber(value.magnitude);
  if (!Number.isFinite(result) || result < minimum || result > maximum) {
    fail(node, "CUT_MEDIA_CAMERA_RANGE", `${label} must be between ${minimum} and ${maximum}, inclusive.`);
  }
  return result;
}

function signalValues(signal: IRSignal) {
  if (signal.kind === "constant") return [signal.value];
  if (signal.kind === "step") return signal.points.map((point) => point.value);
  if (signal.kind === "keyframes") return signal.keyframes.map((keyframe) => keyframe.value);
  return [signal.initial, ...signal.events.flatMap((event) => event.kind === "set" ? [event.value] : [event.from, event.to])];
}

type CameraControl = "focusX" | "focusY" | "zoom" | "rotation" | "opacity";

function controlValue(node: IRNode, name: CameraControl, value: IRValue | undefined) {
  if (name === "focusX" || name === "focusY" || name === "opacity") {
    return quantity(node, value, name, "ratio", "ratio", 0, 1, name === "opacity" ? 1 : 0.5);
  }
  if (name === "zoom") return quantity(node, value, name, "scalar", "scalar", 1, 8, 1);
  return quantity(node, value, name, "angle", "deg", -360_000, 360_000, 0);
}

function validateCameraControls(ir: CutAVIR, node: IRNode) {
  assertClosedKeys(node, node.inputs, ["focusX", "focusY", "zoom", "rotation", "opacity", "edge", "responsiveSlotContext"], "inputs");
  assertClosedKeys(node, node.properties, ["focusX", "focusY", "zoom", "rotation", "opacity"], "properties");
  for (const name of ["focusX", "focusY", "zoom", "rotation", "opacity"] as const) {
    controlValue(node, name, node.inputs[name]);
    const property = node.properties[name];
    if (!property) continue;
    if (!("signal" in property)) {
      controlValue(node, name, property);
      continue;
    }
    const signal = ir.signals[property.signal];
    if (!signal) fail(node, "CUT_MEDIA_CAMERA_INPUT", `property ${name} references missing signal ${property.signal}.`);
    for (const value of signalValues(signal)) {
      if (value.kind === "null" && node.inputs[name] === undefined) continue;
      controlValue(node, name, value.kind === "null" ? node.inputs[name] : value);
    }
  }
  const edge = node.inputs.edge;
  if (edge !== undefined && (edge.kind !== "string" || edge.value !== "transparent" && edge.value !== "clamp")) {
    fail(node, "CUT_MEDIA_CAMERA_INPUT", "edge must be exactly transparent or clamp.");
  }
}

function imageNative(ir: CutAVIR, node: IRNode, sourceId: string) {
  const resource = ir.resources[sourceId];
  const metadata = resource?.metadata as {
    lockVersion?: unknown;
    bytes?: unknown;
    probe?: { kind?: unknown; identity?: { format?: unknown; version?: unknown; image?: { width?: unknown; height?: unknown } } };
  } | undefined;
  const image = metadata?.probe?.identity?.image;
  if (resource?.state !== "locked" || metadata?.lockVersion !== 2 || metadata.probe?.kind !== "image"
    || metadata.probe.identity?.format !== "cut-image-probe" || metadata.probe.identity.version !== 1
    || !Number.isSafeInteger(image?.width) || !Number.isSafeInteger(image?.height)
    || Number(image?.width) < 1 || Number(image?.height) < 1) {
    fail(node, "CUT_MEDIA_CAMERA_RESOURCE", `ImageAsset ${sourceId} requires a complete locked native image probe.`);
  }
  return Object.freeze({ width: Number(image!.width), height: Number(image!.height) });
}

function lockedSource(ir: CutAVIR, node: IRNode, sourceId: string) {
  const resource = ir.resources[sourceId], bytes = resource?.metadata?.bytes;
  if (!resource || resource.state !== "locked" || resource.metadata?.lockVersion !== 2
    || typeof resource.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(resource.sha256)
    || !Number.isSafeInteger(bytes) || Number(bytes) < 1 || Number(bytes) > referenceMediaCamera2DLimits.maximumSourceBytes) {
    fail(node, "CUT_MEDIA_CAMERA_RESOURCE", `resource ${sourceId} requires lock v2, a canonical SHA-256, and 1..${referenceMediaCamera2DLimits.maximumSourceBytes} locked bytes.`);
  }
  return Object.freeze({ resource, bytes: Number(bytes) });
}

function structuralParents(ir: CutAVIR, childId: string) {
  return Object.values(ir.nodes).filter((candidate) => candidate.children.includes(childId));
}

function referenceMediaCamera2DOutputContext(
  ir: CutAVIR,
  composition: IRComposition,
  camera: IRNode,
): ReferenceMediaCamera2DOutputContext {
  const scene = camera.sceneId ? ir.scenes[camera.sceneId] : undefined;
  const sceneRootMembership = scene?.items.filter((item) => item.id === camera.id && item.domain === "visual").length ?? 0;
  const parents = structuralParents(ir, camera.id);
  const contextValue = camera.inputs.responsiveSlotContext;
  if (camera.ownership === "root" && sceneRootMembership === 1 && parents.length === 0) {
    if (contextValue !== undefined) {
      fail(camera, "CUT_MEDIA_CAMERA_GRAPH", "direct scene-root MediaCamera2D must omit compiler-owned responsiveSlotContext.");
    }
    const receipt = Object.freeze({
      kind: "composition" as const,
      compositionId: composition.id,
      width: composition.width,
      height: composition.height,
    });
    return Object.freeze({ ...receipt, semanticIdentity: hash(receipt) });
  }
  if (camera.ownership !== "child" || sceneRootMembership !== 0 || parents.length !== 1) {
    fail(
      camera,
      "CUT_MEDIA_CAMERA_GRAPH",
      `must be either one direct visual scene root or the sole direct MediaCamera2D child of ResponsiveSlot; found ownership ${camera.ownership}, ${sceneRootMembership} scene-root memberships, and ${parents.length} structural parents.`,
    );
  }
  const slot = parents[0]!;
  if (slot.op !== "cut.visual.responsive_slot"
    || slot.children.length !== 1
    || slot.children[0] !== camera.id
    || slot.sceneId !== camera.sceneId
    || !sameRational(slot.interval.start, camera.interval.start)
    || !sameRational(slot.interval.duration, camera.interval.duration)) {
    fail(
      camera,
      "CUT_MEDIA_CAMERA_GRAPH",
      `nested MediaCamera2D must be the sole exact-interval child of one ResponsiveSlot; found parent ${slot.op} ${slot.id}.`,
    );
  }
  const slotParents = structuralParents(ir, slot.id);
  if (slotParents.length !== 1 || slotParents[0]!.op !== "cut.visual.responsive_stack") {
    fail(camera, "CUT_MEDIA_CAMERA_GRAPH", `ResponsiveSlot ${slot.id} must be owned directly by exactly one ResponsiveStack.`);
  }
  const stack = slotParents[0]!;
  const index = stack.children.indexOf(slot.id);
  if (index < 0
    || stack.children.filter((childId) => childId === slot.id).length !== 1
    || stack.sceneId !== camera.sceneId
    || !sameRational(stack.interval.start, camera.interval.start)
    || !sameRational(stack.interval.duration, camera.interval.duration)) {
    fail(camera, "CUT_MEDIA_CAMERA_GRAPH", `ResponsiveStack ${stack.id} does not retain one exact-interval slot ancestry for this camera.`);
  }
  if (contextValue === undefined) {
    fail(camera, "CUT_MEDIA_CAMERA_GRAPH", "slot-bound MediaCamera2D is missing compiler-owned responsiveSlotContext.");
  }
  if (Object.keys(stack.inputs).length !== 1 || stack.inputs.plan === undefined) {
    fail(camera, "CUT_MEDIA_CAMERA_GRAPH", `owning ResponsiveStack ${stack.id} must retain exactly its compiler-derived plan input.`);
  }
  let decoded: CutResponsiveSlotMediaContext;
  try {
    decoded = decodeCutResponsiveSlotMediaContext(
      contextValue,
      stack.inputs.plan,
      { stackNodeId: stack.id, slotNodeId: slot.id, index },
      `${camera.id}.inputs.responsiveSlotContext`,
    );
    const plan = decodeCutResponsiveStackPlan(stack.inputs.plan, `${stack.id}.inputs.plan`);
    if (compareRational(plan.context.width, rational(composition.width)) !== 0
      || compareRational(plan.context.height, rational(composition.height)) !== 0) {
      fail(camera, "CUT_MEDIA_CAMERA_GRAPH", `responsiveSlotContext belongs to ${plan.context.width.numerator}x${plan.context.height.numerator}px, not active composition ${composition.width}x${composition.height}px.`);
    }
  } catch (error) {
    if (error instanceof ReferenceMediaCamera2DError) throw error;
    if (error instanceof CutResponsiveStackError) {
      fail(camera, "CUT_MEDIA_CAMERA_GRAPH", `responsiveSlotContext is invalid: ${error.message}`);
    }
    throw error;
  }
  const receipt = Object.freeze({
    kind: "responsive-slot" as const,
    compositionId: composition.id,
    compositionWidth: composition.width,
    compositionHeight: composition.height,
    stackNodeId: decoded.stackNodeId,
    slotNodeId: decoded.slotNodeId,
    index: decoded.index,
    compilerContextIdentity: decoded.contextIdentity,
    planIdentity: decoded.planIdentity,
    exactSlot: decoded.exactSlot,
    rasterSlot: decoded.rasterSlot,
    localContext: decoded.localContext,
    width: decoded.rasterSlot.width,
    height: decoded.rasterSlot.height,
    clip: "half-open-raster-slot" as const,
  });
  return Object.freeze({ ...receipt, semanticIdentity: hash(receipt) });
}

function checkedProduct(node: IRNode, values: readonly number[], label: string) {
  let result = 1;
  for (const value of values) {
    result *= value;
    if (!Number.isSafeInteger(result) || result < 0) fail(node, "CUT_MEDIA_CAMERA_LIMIT", `${label} exceeds safe integer accounting.`);
  }
  return result;
}

function validateDimensions(
  node: IRNode,
  native: Readonly<{ width: number; height: number }>,
  crop: Readonly<{ width: number; height: number }>,
  output: Readonly<{ width: number; height: number }>,
) {
  const nativePixels = checkedProduct(node, [native.width, native.height], "native pixels");
  const cropPixels = checkedProduct(node, [crop.width, crop.height], "decoded crop pixels");
  const outputPixels = checkedProduct(node, [output.width, output.height], "output pixels");
  if (native.width > referenceMediaCamera2DLimits.maximumNativeAxisPx || native.height > referenceMediaCamera2DLimits.maximumNativeAxisPx
    || nativePixels > referenceMediaCamera2DLimits.maximumNativePixels) {
    fail(node, "CUT_MEDIA_CAMERA_LIMIT", `native source ${native.width}x${native.height} exceeds the bounded camera envelope.`);
  }
  if (cropPixels > referenceMediaCamera2DLimits.maximumDecodedCropPixels) fail(node, "CUT_MEDIA_CAMERA_LIMIT", "decoded crop exceeds the camera pixel budget.");
  if (output.width > referenceMediaCamera2DLimits.maximumOutputAxisPx || output.height > referenceMediaCamera2DLimits.maximumOutputAxisPx
    || outputPixels > referenceMediaCamera2DLimits.maximumOutputPixels) {
    fail(node, "CUT_MEDIA_CAMERA_LIMIT", `output context ${output.width}x${output.height} exceeds the camera output envelope.`);
  }
  return Object.freeze({ nativePixels, cropPixels, outputPixels });
}

const mediaCamera2DNativeEffectInputs: Readonly<Record<
  Exclude<ReferenceMediaCamera2DNativeEffectOp, "cut.visual.color_grade">,
  readonly string[]
>> = Object.freeze({
  "cut.visual.blur": Object.freeze(["radius"]),
  "cut.visual.sharpen": Object.freeze(["radius", "amount"]),
  "cut.visual.vignette": Object.freeze(["amount", "radius", "softness", "color"]),
  "cut.visual.grain": Object.freeze(["amount", "size", "seed", "mode", "monochrome"]),
  "cut.visual.duotone": Object.freeze(["shadows", "highlights", "amount"]),
});

function nativeEffectWork(
  node: IRNode,
  pixels: number,
  config: ReferenceVisualEffectConfig,
) {
  if (pixels > referenceVisualEffectLimits.maximumCanvasPixels) {
    fail(
      node,
      "CUT_MEDIA_CAMERA_LIMIT",
      `native-crop visual effects are bounded to ${referenceVisualEffectLimits.maximumCanvasPixels} source pixels; crop or proxy this ${pixels}-pixel raster before execution.`,
    );
  }
  if (config.kind === "shadow" || config.kind === "glow") {
    fail(node, "CUT_MEDIA_CAMERA_GRAPH", `${node.op} expands a halo and is outside the native-crop V1 bounds policy.`);
  }
  if (config.kind === "grain" && config.mode !== "static") {
    fail(node, "CUT_MEDIA_CAMERA_GRAPH", "native-crop V1 accepts static Grain only.");
  }
  if (config.kind === "blur" && config.radius === 0) {
    fail(node, "CUT_MEDIA_CAMERA_GRAPH", "Blur radius 0px is an identity wrapper; remove it.");
  }
  const multiplier = config.kind === "blur"
    ? 2 + Math.max(1, Math.ceil(config.radius) * 4)
    : config.kind === "sharpen"
      ? 3 + Math.max(1, Math.ceil(config.radius) * 4)
      : 2;
  return Object.freeze({
    maximumPixelWork: checkedProduct(node, [pixels, multiplier], `${node.op} native-crop pixel work`),
    maximumOutputSurfaces: 1 as const,
    maximumOutputRgbaBytes: checkedProduct(node, [pixels, 4], `${node.op} native-crop output bytes`),
  });
}

function planNativeEffectChain(
  ir: CutAVIR,
  camera: IRNode,
  wrappersOuterToInner: readonly IRNode[],
  cropPixels: number,
) {
  if (!wrappersOuterToInner.some((node) => node.op !== "cut.visual.color_grade")) return undefined;
  if (wrappersOuterToInner.length < 1 || wrappersOuterToInner.length > referenceMediaCamera2DLimits.maximumNativeEffectDepth) {
    fail(camera, "CUT_MEDIA_CAMERA_LIMIT", `native-crop effect depth must be 1..${referenceMediaCamera2DLimits.maximumNativeEffectDepth}.`);
  }
  const inspectionOrder = new Map(wrappersOuterToInner.map((node, index) => [node.id, index]));
  let maximumPixelWork = 0, maximumOutputSurfaces = 0, maximumOutputRgbaBytes = 0;
  const operations = Object.freeze([...wrappersOuterToInner].reverse().map((node, executionOrder) => {
    const op = node.op as ReferenceMediaCamera2DNativeEffectOp;
    let staticConfigIdentity: string | undefined;
    let work: Readonly<{
      maximumPixelWork: number;
      maximumOutputSurfaces: 0 | 1 | 2;
      maximumOutputRgbaBytes: number;
    }>;
    if (op === "cut.visual.color_grade") {
      validateReferenceColorGradeConfig(ir, node);
      work = Object.freeze({
        maximumPixelWork: checkedProduct(node, [cropPixels, 2], "ColorGrade native-crop pixel work"),
        maximumOutputSurfaces: 2 as const,
        maximumOutputRgbaBytes: checkedProduct(node, [cropPixels, 8], "ColorGrade native-crop output bytes"),
      });
    } else {
      assertClosedKeys(node, node.inputs, mediaCamera2DNativeEffectInputs[op], `${node.op} inputs`);
      assertClosedKeys(node, node.properties, [], `${node.op} properties`);
      const config = referenceVisualEffectConfig(node);
      if (!config) fail(node, "CUT_MEDIA_CAMERA_GRAPH", "did not produce a closed public visual-effect configuration.");
      staticConfigIdentity = hash(config);
      work = nativeEffectWork(node, cropPixels, config);
    }
    maximumPixelWork += work.maximumPixelWork;
    maximumOutputSurfaces += work.maximumOutputSurfaces;
    maximumOutputRgbaBytes += work.maximumOutputRgbaBytes;
    if (!Number.isSafeInteger(maximumPixelWork) || !Number.isSafeInteger(maximumOutputSurfaces)
      || !Number.isSafeInteger(maximumOutputRgbaBytes)) {
      fail(node, "CUT_MEDIA_CAMERA_LIMIT", "native-crop effect-chain work exceeds safe integer accounting.");
    }
    const receipt = Object.freeze({
      inspectionOrder: inspectionOrder.get(node.id)!,
      executionOrder,
      nodeId: node.id,
      op,
      executableContentHash: node.contentHash,
      executableIdentity: executableNodeIdentity(ir, node),
      ...(staticConfigIdentity ? { staticConfigIdentity } : {}),
      ...work,
    });
    return Object.freeze({ ...receipt, semanticIdentity: hash(receipt) });
  }));
  const receipt = Object.freeze({
    algorithmVersion: referenceMediaCamera2DNativeEffectChainAlgorithmVersion,
    basis: "post-crop-source-straight-rgba8" as const,
    order: "inner-to-outer-before-edge-and-affine" as const,
    operations,
    maximumPixelWork,
    maximumOutputSurfaces,
    maximumOutputRgbaBytes,
  });
  return Object.freeze({ ...receipt, semanticIdentity: hash(receipt) });
}

function selectedVideoVariant(ir: CutAVIR, sourceId: string) {
  const selected = referenceMediaProfileResourceState(ir, sourceId)?.selected;
  if (selected) return selected;
  return (ir.resources[sourceId]?.metadata as { activeMediaVariant?: unknown } | undefined)?.activeMediaVariant === "proxy" ? "proxy" as const : "master" as const;
}

function makeDecodePlan(input: Readonly<{
  camera: IRNode;
  grade?: IRNode;
  leaf: IRNode;
  leafKind: "image" | "video";
  sourceId: string;
  sourceSha256: string;
  selectedVariant: "master" | "proxy" | "not-applicable";
  native: Readonly<{ width: number; height: number }>;
  crop?: ReferenceNormalizedCrop;
  cropped: Readonly<{ left: number; top: number; width: number; height: number }>;
  fit: "cover" | "contain" | "fill";
  output: Readonly<{ width: number; height: number }>;
  video?: ReferenceVideoInputConfig;
}>) {
  const videoExecution = input.video ? Object.freeze({
    streamIndex: input.video.streamIndex,
    config: input.video,
    configIdentity: hash(input.video),
    ...(input.video.decodedVideoCadence ? { cadenceIdentity: hash(input.video.decodedVideoCadence) } : {}),
  }) : undefined;
  const semantic = Object.freeze({
    kind: "media-camera2d-native-decode-v1",
    cameraNodeId: input.camera.id,
    gradeNodeId: input.grade?.id,
    leafNodeId: input.leaf.id,
    leafContentHash: input.leaf.contentHash,
    sourceId: input.sourceId,
    sourceSha256: input.sourceSha256,
    selectedVariant: input.selectedVariant,
    native: input.native,
    crop: input.crop,
    cropped: input.cropped,
    fit: input.fit,
    videoExecution,
  });
  return Object.freeze({
    localSpaceNodeId: input.camera.id,
    rootId: input.camera.id,
    leafId: input.leaf.id,
    leafKind: input.leafKind,
    nodeIds: Object.freeze([input.leaf.id]),
    wrapperOps: Object.freeze([]),
    sourceId: input.sourceId,
    sourceSha256: input.sourceSha256,
    selectedVariant: input.selectedVariant,
    ...(videoExecution ? { videoExecution } : {}),
    native: Object.freeze({ ...input.native }),
    ...(input.crop ? { crop: input.crop } : {}),
    cropped: Object.freeze({ ...input.cropped }),
    fit: input.fit,
    // Deliberately no fit surface: the existing retained decoder returns this
    // native crop and the camera's one Q16 sampler maps it to delivery.
    fitted: Object.freeze({ width: input.cropped.width, height: input.cropped.height }),
    viewport: Object.freeze({ width: input.output.width, height: input.output.height }),
    resample: "cut-q16-associated-bilinear-direct-affine" as const,
    maximumPixelWorkPerFrame: input.cropped.width * input.cropped.height + input.output.width * input.output.height * 4,
    semanticIdentity: hash(semantic),
  }) satisfies ReferenceRetainedMediaViewportPlan;
}

function assertNodeInterval(node: IRNode, camera: IRNode, role: string) {
  if (node.sceneId !== camera.sceneId || !sameRational(node.interval.start, camera.interval.start) || !sameRational(node.interval.duration, camera.interval.duration)) {
    fail(node, "CUT_MEDIA_CAMERA_GRAPH", `${role} must share the camera's exact scene and complete interval.`);
  }
}

function assertExclusiveStructuralParent(ir: CutAVIR, node: IRNode, expectedParent: IRNode, role: string) {
  const parents = Object.values(ir.nodes).filter((candidate) => candidate.children.includes(node.id));
  if (parents.length !== 1 || parents[0]!.id !== expectedParent.id) {
    fail(
      node,
      "CUT_MEDIA_CAMERA_GRAPH",
      `${role} must have exactly one structural parent (${expectedParent.id}); found ${parents.map((parent) => parent.id).sort().join(", ") || "none"}.`,
    );
  }
}

function validateColorGradeChangesExactOutputGrid(
  ir: CutAVIR,
  composition: IRComposition,
  sceneDuration: Rational,
  grade: IRNode,
  maximumWorkUnits: number,
) {
  const exactCount = multiplyRational(sceneDuration, composition.fps);
  if (exactCount.denominator !== "1") fail(grade, "CUT_MEDIA_CAMERA_GRAPH", "ColorGrade owner duration does not land on the exact composition frame grid.");
  const count = BigInt(exactCount.numerator);
  if (count < 1n || count > BigInt(referenceMediaCamera2DLimits.maximumColorGradeNoOpProofFrames)) {
    fail(grade, "CUT_MEDIA_CAMERA_LIMIT", `ColorGrade exact-grid no-op proof needs ${count} frames, outside 1..${referenceMediaCamera2DLimits.maximumColorGradeNoOpProofFrames}.`);
  }
  const workUnitsBig = count * BigInt(referenceMediaCamera2DLimits.colorGradeNoOpPropertiesPerFrame);
  if (workUnitsBig > BigInt(maximumWorkUnits)) {
    fail(
      grade,
      "CUT_MEDIA_CAMERA_LIMIT",
      `ColorGrade exact-grid no-op proof requires ${workUnitsBig} property evaluations across ${count} frames; ${maximumWorkUnits} remain in the bounded composition admission-proof budget.`,
    );
  }
  for (let frame = 0n; frame < count; frame += 1n) {
    const time = rational(frame * BigInt(composition.fps.denominator), composition.fps.numerator);
    const config = referenceColorGradeConfigAt(ir, grade, time);
    if (config.exposureStops !== 0 || config.temperature !== 0 || config.tint !== 0
      || config.brightness !== 1 || config.saturation !== 1 || config.hueDegrees !== 0 || config.contrast !== 1) return Number(workUnitsBig);
  }
  fail(grade, "CUT_MEDIA_CAMERA_GRAPH", "ColorGrade is identity on every exact output-frame sample; remove the no-op wrapper.");
}

function validateStaticSceneAggregates(ir: CutAVIR, plans: ReadonlyMap<string, ReferenceMediaCamera2DPlan>) {
  const compositionSources = new Set<string>();
  let compositionUniqueSourceBytes = 0;
  for (const plan of [...plans.values()].sort((left, right) => left.cameraNodeId.localeCompare(right.cameraNodeId))) {
    const camera = ir.nodes[plan.cameraNodeId];
    if (!camera) throw new Error(`CUT_MEDIA_CAMERA_GRAPH: missing planned MediaCamera2D ${plan.cameraNodeId}.`);
    const sourceIdentity = `${plan.source.resourceId}\0${plan.source.sha256}\0${plan.source.selectedVariant}`;
    if (compositionSources.has(sourceIdentity)) continue;
    compositionSources.add(sourceIdentity);
    compositionUniqueSourceBytes += plan.source.resourceBytes;
    if (!Number.isSafeInteger(compositionUniqueSourceBytes)) fail(camera, "CUT_MEDIA_CAMERA_LIMIT", "composition camera source bytes exceed safe integer accounting.");
    if (compositionUniqueSourceBytes > referenceMediaCamera2DLimits.maximumCompositionUniqueSourceBytes) {
      fail(camera, "CUT_MEDIA_CAMERA_LIMIT", `composition camera source bytes ${compositionUniqueSourceBytes} exceed ${referenceMediaCamera2DLimits.maximumCompositionUniqueSourceBytes} before verified-input snapshots are created.`);
    }
  }
  const byScene = new Map<string, ReferenceMediaCamera2DPlan[]>();
  for (const plan of plans.values()) {
    const entries = byScene.get(plan.sceneId) ?? [];
    entries.push(plan);
    byScene.set(plan.sceneId, entries);
  }
  for (const scenePlans of byScene.values()) {
    scenePlans.sort((left, right) => left.cameraNodeId.localeCompare(right.cameraNodeId));
    const sources = new Set<string>();
    let uniqueSourceBytes = 0, nativePixels = 0, cropPixels = 0, outputPixels = 0;
    let maximumColorGradePixelWork = 0, maximumNativeEffectPixelWork = 0;
    let maximumBilinearSampleVisits = 0, maximumPixelWork = 0, conservativePeakRgbaBytes = 0, videoDecoders = 0;
    const add = (camera: IRNode, current: number, value: number, label: string) => {
      const next = current + value;
      if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(next)) fail(camera, "CUT_MEDIA_CAMERA_LIMIT", `static scene aggregate ${label} exceeds safe integer accounting.`);
      return next;
    };
    const limit = (camera: IRNode, value: number, maximum: number, label: string) => {
      if (value > maximum) fail(camera, "CUT_MEDIA_CAMERA_LIMIT", `static scene aggregate ${label} ${value} exceeds ${maximum} before resource locators are resolved.`);
    };
    for (const plan of scenePlans) {
      const camera = ir.nodes[plan.cameraNodeId];
      if (!camera) throw new Error(`CUT_MEDIA_CAMERA_GRAPH: missing planned MediaCamera2D ${plan.cameraNodeId}.`);
      const sourceIdentity = `${plan.source.resourceId}\0${plan.source.sha256}\0${plan.source.selectedVariant}`;
      if (!sources.has(sourceIdentity)) {
        sources.add(sourceIdentity);
        uniqueSourceBytes = add(camera, uniqueSourceBytes, plan.source.resourceBytes, "unique source bytes");
      }
      nativePixels = add(camera, nativePixels, plan.native.pixels, "native pixels");
      cropPixels = add(camera, cropPixels, plan.decodedCrop.pixels, "decoded crop pixels");
      outputPixels = add(camera, outputPixels, plan.output.pixels, "output pixels");
      maximumColorGradePixelWork = add(camera, maximumColorGradePixelWork, plan.maximumStaticWork.maximumColorGradePixelWork, "ColorGrade pixel work");
      maximumNativeEffectPixelWork = add(
        camera,
        maximumNativeEffectPixelWork,
        plan.maximumStaticWork.maximumNativeEffectPixelWork ?? 0,
        "native-effect pixel work",
      );
      maximumBilinearSampleVisits = add(camera, maximumBilinearSampleVisits, plan.output.pixels * 4, "bilinear sample visits");
      maximumPixelWork = add(
        camera,
        maximumPixelWork,
        plan.decodedCrop.pixels + plan.maximumStaticWork.maximumColorGradePixelWork
          + (plan.maximumStaticWork.maximumNativeEffectPixelWork ?? 0) + plan.output.pixels * 6,
        "pixel work excluding frame-dependent clamp padding and decoder catch-up",
      );
      conservativePeakRgbaBytes = add(camera, conservativePeakRgbaBytes,
        plan.native.pixels * 4 + plan.decodedCrop.pixels * 4 + plan.maximumStaticWork.maximumColorGradeRgbaBytes
          + (plan.maximumStaticWork.maximumNativeEffectOutputRgbaBytes ?? 0) + plan.output.rgbaBytes,
        "conservative peak RGBA bytes excluding frame-dependent clamp padding");
      if (plan.leafKind === "video") videoDecoders = add(camera, videoDecoders, 1, "concurrent video decoders");
      limit(camera, uniqueSourceBytes, referenceMediaCamera2DLimits.maximumSceneUniqueSourceBytes, "unique source bytes");
      limit(camera, nativePixels, referenceMediaCamera2DLimits.maximumSceneNativePixels, "native pixels");
      limit(camera, cropPixels, referenceMediaCamera2DLimits.maximumSceneDecodedCropPixels, "decoded crop pixels");
      limit(camera, outputPixels, referenceMediaCamera2DLimits.maximumSceneOutputPixels, "output pixels");
      limit(camera, maximumColorGradePixelWork, referenceMediaCamera2DLimits.maximumSceneColorGradePixelWork, "ColorGrade pixel work");
      limit(camera, maximumNativeEffectPixelWork, referenceMediaCamera2DLimits.maximumSceneNativeEffectPixelWork, "native-effect pixel work");
      limit(camera, maximumBilinearSampleVisits, referenceMediaCamera2DLimits.maximumSceneBilinearSampleVisits, "bilinear sample visits");
      limit(camera, maximumPixelWork, referenceMediaCamera2DLimits.maximumSceneFramePixelWork, "pixel work excluding frame-dependent clamp padding and decoder catch-up");
      limit(camera, conservativePeakRgbaBytes, referenceMediaCamera2DLimits.maximumSceneKnownRgbaBytes, "conservative peak RGBA bytes excluding frame-dependent clamp padding");
      limit(camera, videoDecoders, referenceMediaCamera2DLimits.maximumConcurrentVideoDecoders, "concurrent video decoders");
    }
  }
}

function referenceMediaCamera2DStaticStateIdentity(
  ir: CutAVIR,
  composition: IRComposition,
  plan: ReferenceMediaCamera2DPlan,
) {
  const resource = ir.resources[plan.source.resourceId];
  const scene = ir.scenes[plan.sceneId];
  const responsiveSlot = plan.outputContext.kind === "responsive-slot"
    ? ir.nodes[plan.outputContext.slotNodeId]
    : undefined;
  const responsiveStack = plan.outputContext.kind === "responsive-slot"
    ? ir.nodes[plan.outputContext.stackNodeId]
    : undefined;
  return hash({
    composition: {
      id: composition.id,
      width: composition.width,
      height: composition.height,
      fps: composition.fps,
      sampleRate: composition.sampleRate,
      duration: composition.duration,
      sceneIds: composition.sceneIds,
      rootVisualIds: composition.rootVisualIds,
      rootAudioIds: composition.rootAudioIds,
      rootAVIds: composition.rootAVIds,
      items: composition.items,
    },
    scene: scene ? {
      id: scene.id,
      start: scene.start,
      duration: scene.duration,
      rootVisualIds: scene.rootVisualIds,
      rootAudioIds: scene.rootAudioIds,
      rootAVIds: scene.rootAVIds,
      items: scene.items,
    } : null,
    resource: resource ? {
      id: resource.id,
      name: resource.name,
      kind: resource.kind,
      locator: resource.locator,
      streamSelection: resource.streamSelection,
      proxy: resource.proxy,
      state: resource.state,
      sha256: resource.sha256,
      metadata: resource.metadata,
    } : null,
    outputContext: plan.outputContext,
    responsiveSlot: responsiveSlot ? {
      id: responsiveSlot.id,
      op: responsiveSlot.op,
      ownership: responsiveSlot.ownership,
      sceneId: responsiveSlot.sceneId,
      interval: responsiveSlot.interval,
      inputs: responsiveSlot.inputs,
      children: responsiveSlot.children,
      properties: responsiveSlot.properties,
      contentHash: responsiveSlot.contentHash,
    } : null,
    responsiveStack: responsiveStack ? {
      id: responsiveStack.id,
      op: responsiveStack.op,
      ownership: responsiveStack.ownership,
      sceneId: responsiveStack.sceneId,
      interval: responsiveStack.interval,
      inputs: responsiveStack.inputs,
      children: responsiveStack.children,
      properties: responsiveStack.properties,
      contentHash: responsiveStack.contentHash,
    } : null,
  });
}

/** Metadata-only graph/resource planner. It never resolves or opens a locator. */
export function validateReferenceMediaCamera2DGraph(
  ir: CutAVIR,
  composition: IRComposition,
  reachableNodeIds?: ReadonlySet<string>,
) {
  const result = new Map<string, ReferenceMediaCamera2DPlan>();
  let remainingAdmissionProofWorkUnits = referenceMediaCamera2DObservabilityLimits.maximumWorkUnitsPerComposition;
  const sceneIds = new Set(composition.sceneIds);
  const cameras = Object.values(ir.nodes)
    .filter((node) => node.op === "cut.visual.media_camera2d" && (!reachableNodeIds || reachableNodeIds.has(node.id)))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (cameras.length > referenceMediaCamera2DLimits.maximumCamerasPerComposition) {
    fail(cameras[0]!, "CUT_MEDIA_CAMERA_LIMIT", `composition exceeds ${referenceMediaCamera2DLimits.maximumCamerasPerComposition} MediaCamera2D nodes.`);
  }
  for (const camera of cameras) {
    if (!camera.sceneId || !sceneIds.has(camera.sceneId)) fail(camera, "CUT_MEDIA_CAMERA_GRAPH", "must belong to a scene in the selected composition.");
    const scene = ir.scenes[camera.sceneId];
    if (!scene) fail(camera, "CUT_MEDIA_CAMERA_GRAPH", "must belong to an existing scene in the selected composition.");
    const outputContext = referenceMediaCamera2DOutputContext(ir, composition, camera);
    if (!sameRational(camera.interval.start, zeroRational) || !sameRational(camera.interval.duration, scene.duration)) {
      fail(camera, "CUT_MEDIA_CAMERA_GRAPH", "must span the complete owning scene interval from exact zero.");
    }
    if (!exactPureVisual(camera) || camera.children.length !== 1) {
      fail(camera, "CUT_MEDIA_CAMERA_GRAPH", "must be a pure visual camera with exactly one direct media branch.");
    }
    validateCameraControls(ir, camera);
    const edgeValue = camera.inputs.edge;
    const edge = edgeValue?.kind === "string" ? edgeValue.value as "transparent" | "clamp" : "transparent";

    let grade: IRNode | undefined;
    const nativeWrappersOuterToInner: IRNode[] = [];
    let leaf = ir.nodes[camera.children[0]!];
    if (!leaf) fail(camera, "CUT_MEDIA_CAMERA_GRAPH", "references a missing direct child.");
    let parent = camera;
    const wrapperIds = new Set<string>();
    while (leaf && cutMediaCamera2DNativeEffectOps.includes(leaf.op as ReferenceMediaCamera2DNativeEffectOp)) {
      const wrapper = leaf;
      if (wrapperIds.has(wrapper.id)) fail(wrapper, "CUT_MEDIA_CAMERA_GRAPH", "native-crop effect branch cycles.");
      wrapperIds.add(wrapper.id);
      nativeWrappersOuterToInner.push(wrapper);
      if (nativeWrappersOuterToInner.length > referenceMediaCamera2DLimits.maximumNativeEffectDepth) {
        fail(wrapper, "CUT_MEDIA_CAMERA_LIMIT", `native-crop effect depth exceeds ${referenceMediaCamera2DLimits.maximumNativeEffectDepth}.`);
      }
      if (!exactPureVisual(wrapper) || wrapper.ownership !== "child" || wrapper.children.length !== 1) {
        fail(wrapper, "CUT_MEDIA_CAMERA_GRAPH", `${wrapper.op} must be one pure unary child in the camera-owned native-crop chain.`);
      }
      const wrapperRole = wrapper.op === "cut.visual.color_grade" ? "ColorGrade" : wrapper.op;
      assertNodeInterval(wrapper, camera, wrapperRole);
      assertExclusiveStructuralParent(ir, wrapper, parent, wrapperRole);
      if (wrapper.op === "cut.visual.color_grade") {
        if (grade) fail(wrapper, "CUT_MEDIA_CAMERA_GRAPH", "permits at most one ColorGrade in the native-crop effect chain.");
        grade = wrapper;
        assertClosedKeys(wrapper, wrapper.inputs, ["exposure", "temperature", "tint", "brightness", "saturation", "hue", "contrast"], "ColorGrade inputs");
        assertClosedKeys(wrapper, wrapper.properties, ["exposure", "temperature", "tint", "brightness", "saturation", "hue", "contrast"], "ColorGrade properties");
        validateReferenceColorGradeConfig(ir, wrapper);
        remainingAdmissionProofWorkUnits -= validateColorGradeChangesExactOutputGrid(
          ir,
          composition,
          scene.duration,
          wrapper,
          remainingAdmissionProofWorkUnits,
        );
      } else {
        const op = wrapper.op as Exclude<ReferenceMediaCamera2DNativeEffectOp, "cut.visual.color_grade">;
        assertClosedKeys(wrapper, wrapper.inputs, mediaCamera2DNativeEffectInputs[op], `${wrapper.op} inputs`);
        assertClosedKeys(wrapper, wrapper.properties, [], `${wrapper.op} properties`);
        const config = referenceVisualEffectConfig(wrapper);
        if (!config) fail(wrapper, "CUT_MEDIA_CAMERA_GRAPH", "did not produce a closed public native-crop effect configuration.");
        nativeEffectWork(wrapper, 1, config);
      }
      parent = wrapper;
      leaf = ir.nodes[wrapper.children[0]!]!;
      if (!leaf) fail(wrapper, "CUT_MEDIA_CAMERA_GRAPH", "references a missing native-crop child.");
    }
    if (leaf.op !== "cut.visual.image" && leaf.op !== "cut.visual.video") {
      fail(
        leaf,
        "CUT_MEDIA_CAMERA_GRAPH",
        "branch must end in exactly Image or Video; only ColorGrade, Blur, Sharpen, Vignette, static Grain, and Duotone are admitted before it.",
      );
    }
    if (!exactPureVisual(leaf) || leaf.ownership !== "child" || leaf.children.length !== 0) {
      fail(leaf, "CUT_MEDIA_CAMERA_GRAPH", "media leaf must be a pure child with no descendants.");
    }
    assertNodeInterval(leaf, camera, "media leaf");
    assertExclusiveStructuralParent(ir, leaf, parent, "media leaf");
    assertClosedKeys(leaf, leaf.properties, [], "media leaf properties");
    if (leaf.op === "cut.visual.image") assertClosedKeys(leaf, leaf.inputs, ["source", "fit", "crop"], "Image inputs");
    else assertClosedKeys(leaf, leaf.inputs, ["source", "range", "fit", "loop", "endBehavior", "inputColor", "inputColorInterpretation", "crop"], "Video inputs");

    const leafKind = leaf.op === "cut.visual.image" ? "image" as const : "video" as const;
    let image: Extract<ReturnType<typeof referenceShapeNodeConfig>, { kind: "image" }> | undefined;
    let video: ReferenceVideoInputConfig | undefined;
    if (leafKind === "image") {
      const configured = referenceShapeNodeConfig(ir, composition, leaf);
      if (!configured || configured.kind !== "image") fail(leaf, "CUT_MEDIA_CAMERA_RESOURCE", "does not have a valid public Image configuration.");
      image = configured;
    } else {
      video = referenceVideoInputConfig(ir, leaf);
    }
    const sourceId = image ? image.sourceId : video!.resourceId;
    const locked = lockedSource(ir, leaf, sourceId);
    const native = leafKind === "image" ? imageNative(ir, leaf, sourceId) : Object.freeze({ width: video!.nativeWidth, height: video!.nativeHeight });
    const crop = leafKind === "image" ? image!.crop : video!.crop;
    const fit = leafKind === "image" ? image!.fit : video!.fit;
    const croppedBase = referenceRetainedMediaCropPixels(native, crop);
    const dimensions = validateDimensions(leaf, native, croppedBase, outputContext);
    const cropped = Object.freeze({ ...croppedBase, pixels: dimensions.cropPixels });
    const nativeEffectChain = planNativeEffectChain(
      ir,
      camera,
      nativeWrappersOuterToInner,
      dimensions.cropPixels,
    );
    const observability = validateReferenceMediaCamera2DQ16Observability(
      ir,
      composition,
      camera,
      Object.freeze({
        source: Object.freeze({ width: cropped.width, height: cropped.height }),
        output: Object.freeze({ width: outputContext.width, height: outputContext.height }),
        fit,
        edge,
      }),
      { maximumWorkUnits: remainingAdmissionProofWorkUnits },
    );
    remainingAdmissionProofWorkUnits -= observability.workUnits;
    const selectedVariant = leafKind === "video" ? selectedVideoVariant(ir, sourceId) : "not-applicable" as const;
    const source: ReferenceMediaCamera2DSourcePlan = Object.freeze({
      resourceId: sourceId,
      sha256: locked.resource.sha256!,
      selectedVariant,
      resourceBytes: locked.bytes,
      leafKind,
      ...(video ? {
        streamIndex: video.streamIndex,
        inputColor: video.inputColor,
        videoConfigIdentity: hash(video),
        ...(video.decodedVideoCadence ? { cadenceIdentity: hash(video.decodedVideoCadence) } : {}),
      } : {}),
    });
    const decodePlan = makeDecodePlan({
      camera, grade, leaf, leafKind, sourceId, sourceSha256: source.sha256, selectedVariant,
      native, crop, cropped, fit, output: outputContext, ...(video ? { video } : {}),
    });
    const receipt = Object.freeze({
      algorithmVersion: referenceMediaCamera2DAlgorithmVersion,
      backendIdentity: referenceMediaCamera2DBackendIdentity,
      compositionId: composition.id,
      sceneId: camera.sceneId,
      cameraNodeId: camera.id,
      cameraExecutableContentHash: camera.contentHash,
      cameraExecutableIdentity: executableNodeIdentity(ir, camera),
      ...(grade ? {
        gradeNodeId: grade.id,
        gradeExecutableContentHash: grade.contentHash,
        gradeExecutableIdentity: executableNodeIdentity(ir, grade),
      } : {}),
      ...(nativeEffectChain ? { nativeEffectChain } : {}),
      leafNodeId: leaf.id,
      leafExecutableContentHash: leaf.contentHash,
      leafExecutableIdentity: executableNodeIdentity(ir, leaf),
      leafKind,
      fit,
      ...(crop ? { crop } : {}),
      native: Object.freeze({ ...native, pixels: dimensions.nativePixels }),
      decodedCrop: cropped,
      output: Object.freeze({ width: outputContext.width, height: outputContext.height, pixels: dimensions.outputPixels, rgbaBytes: dimensions.outputPixels * 4 }),
      outputContext,
      source,
      edge,
      controls: Object.freeze({
        focusX: "ratio-0-to-1" as const,
        focusY: "ratio-0-to-1" as const,
        zoom: "scalar-1-to-8" as const,
        rotation: "degrees-around-delivery-centre" as const,
        opacity: "ratio-0-to-1" as const,
      }),
      transformOrder: Object.freeze(["fit-scale", "focus-to-delivery-centre", "zoom", "rotate-about-delivery-centre", "opacity"] as const),
      decodePlan,
      maximumStaticWork: Object.freeze({
        sourceFileBytes: source.resourceBytes,
        nativePixels: dimensions.nativePixels,
        decodedCropPixels: dimensions.cropPixels,
        decodedCropRgbaBytes: dimensions.cropPixels * 4,
        outputPixels: dimensions.outputPixels,
        outputRgbaBytes: dimensions.outputPixels * 4,
        maximumColorGradePixelPasses: grade ? 2 as const : 0 as const,
        maximumColorGradePixelWork: dimensions.cropPixels * (grade ? 2 : 0),
        maximumColorGradeRgbaBytes: dimensions.cropPixels * (grade ? 8 : 0),
        ...(nativeEffectChain ? {
          maximumNativeEffectPixelWork: nativeEffectChain.operations
            .filter((operation) => operation.op !== "cut.visual.color_grade")
            .reduce((sum, operation) => sum + operation.maximumPixelWork, 0),
          maximumNativeEffectOutputSurfaces: nativeEffectChain.operations
            .filter((operation) => operation.op !== "cut.visual.color_grade")
            .reduce((sum, operation) => sum + operation.maximumOutputSurfaces, 0),
          maximumNativeEffectOutputRgbaBytes: nativeEffectChain.operations
            .filter((operation) => operation.op !== "cut.visual.color_grade")
            .reduce((sum, operation) => sum + operation.maximumOutputRgbaBytes, 0),
        } : {}),
      }),
      observability,
    });
    const plan = Object.freeze({ ...receipt, semanticIdentity: hash(receipt) });
    mediaCamera2DPlanAuthorities.set(plan, Object.freeze({
      ir,
      composition,
      staticStateIdentity: referenceMediaCamera2DStaticStateIdentity(ir, composition, plan),
    }));
    result.set(camera.id, plan);
  }
  validateStaticSceneAggregates(ir, result);
  return result;
}

function resolvedControl(
  ir: CutAVIR,
  node: IRNode,
  name: CameraControl,
  time: Rational,
  resolver?: ReferencePreparedSignalResolver,
) {
  const sampled = propertyAt(ir, node, name, time, resolver);
  // Track initial:null is the public runtime-default sentinel. The compiler
  // copies an explicit constructor baseline into a track when that baseline
  // is meant to survive before the first event; a hostile loaded IR cannot
  // revive a conflicting input through this fallback.
  return controlValue(node, name, sampled?.kind === "null" ? undefined : sampled ?? node.inputs[name]);
}

function q16(value: number) {
  return String(Math.round(value * referenceMediaCamera2DPhaseUnits));
}

function q16Matrix(value: ReferenceAffine2D) {
  return Object.freeze({ a: q16(value.a), b: q16(value.b), c: q16(value.c), d: q16(value.d), tx: q16(value.tx), ty: q16(value.ty) });
}

function checkedQ16Component(node: IRNode, value: string, label: string) {
  if (!/^(?:0|-?[1-9][0-9]*)$/u.test(value)) {
    fail(node, "CUT_MEDIA_CAMERA_PREFLIGHT", `${label} must be one canonical integer Q16 component.`);
  }
  const units = Number(value);
  if (!Number.isSafeInteger(units)) {
    fail(node, "CUT_MEDIA_CAMERA_PREFLIGHT", `${label} exceeds the safe Q16 integer range.`);
  }
  const result = units / referenceMediaCamera2DPhaseUnits;
  if (!Number.isFinite(result)) {
    fail(node, "CUT_MEDIA_CAMERA_PREFLIGHT", `${label} cannot be represented as one finite affine component.`);
  }
  return Object.is(result, -0) ? 0 : result;
}

function affineFromQ16(
  node: IRNode,
  value: ReferenceMediaCamera2DFramePlan["geometry"]["sourceToDeliveryQ16"],
) {
  return Object.freeze({
    a: checkedQ16Component(node, value.a, "sourceToDeliveryQ16.a"),
    b: checkedQ16Component(node, value.b, "sourceToDeliveryQ16.b"),
    c: checkedQ16Component(node, value.c, "sourceToDeliveryQ16.c"),
    d: checkedQ16Component(node, value.d, "sourceToDeliveryQ16.d"),
    tx: checkedQ16Component(node, value.tx, "sourceToDeliveryQ16.tx"),
    ty: checkedQ16Component(node, value.ty, "sourceToDeliveryQ16.ty"),
  });
}

function applyAffine(affine: ReferenceAffine2D, x: number, y: number) {
  return Object.freeze({ x: affine.a * x + affine.c * y + affine.tx, y: affine.b * x + affine.d * y + affine.ty });
}

function q16Points(points: readonly Readonly<{ x: number; y: number }>[]) {
  return Object.freeze(points.map((point) => Object.freeze({ x: q16(point.x), y: q16(point.y) }))) as unknown as readonly [Q16Point, Q16Point, Q16Point, Q16Point];
}

function adjustedForPadding(affine: ReferenceAffine2D, padding: Readonly<{ left: number; top: number }>) {
  return Object.freeze({
    ...affine,
    tx: affine.tx - affine.a * padding.left - affine.c * padding.top,
    ty: affine.ty - affine.b * padding.left - affine.d * padding.top,
  });
}

function outputBoundsFor(
  affine: ReferenceAffine2D,
  source: Readonly<{ width: number; height: number }>,
  output: Readonly<{ width: number; height: number }>,
) {
  // Bilinear zero-extension has support until one sample beyond the first/last
  // source centre. Admit that conservative support so a rotated/translating
  // edge pixel can never be cropped before the sampler decides its exact alpha.
  const visible = intersectReferenceRects(
    transformReferenceRect(referenceRect(-1, -1, source.width + 1, source.height + 1), affine),
    referenceRect(0, 0, output.width, output.height),
  );
  return visible ? referenceIntegerRasterBounds(visible) : undefined;
}

function colorGradeWorkAt(
  ir: CutAVIR,
  plan: ReferenceMediaCamera2DPlan,
  exactTime: Rational,
  visible: boolean,
) {
  if (!visible || !plan.gradeNodeId) {
    return Object.freeze({
      linearBalance: false,
      backendGrade: false,
      colorGradePixelPasses: 0 as const,
      maximumColorGradePixelWork: 0,
      gradeExecutionIdentity: undefined,
    });
  }
  const grade = ir.nodes[plan.gradeNodeId];
  if (!grade) throw new Error(`CUT_MEDIA_CAMERA_GRAPH: missing planned ColorGrade ${plan.gradeNodeId}.`);
  const config = referenceColorGradeConfigAt(ir, grade, exactTime);
  const linearBalance = config.exposureStops !== 0 || config.temperature !== 0 || config.tint !== 0;
  const backendGrade = config.brightness !== 1 || config.saturation !== 1 || config.hueDegrees !== 0 || config.contrast !== 1;
  const colorGradePixelPasses = Number(linearBalance) + Number(backendGrade) as 0 | 1 | 2;
  return Object.freeze({
    linearBalance,
    backendGrade,
    colorGradePixelPasses,
    maximumColorGradePixelWork: checkedProduct(grade, [plan.decodedCrop.pixels, colorGradePixelPasses], "ColorGrade pixel work"),
    gradeExecutionIdentity: hash(config),
  });
}

function nativeEffectChainAt(
  ir: CutAVIR,
  plan: ReferenceMediaCamera2DPlan,
  exactTime: Rational,
  visible: boolean,
) {
  const chain = plan.nativeEffectChain;
  if (!chain) return undefined;
  let pixelWork = 0, outputSurfaces = 0, outputRgbaBytes = 0;
  const operations = Object.freeze(chain.operations.map((operation) => {
    const node = ir.nodes[operation.nodeId];
    if (!node || node.op !== operation.op) {
      const camera = ir.nodes[plan.cameraNodeId] ?? ({ id: plan.cameraNodeId } as IRNode);
      fail(camera, "CUT_MEDIA_CAMERA_PREFLIGHT", `native-effect operation ${operation.nodeId} is missing or changed kind after static planning.`);
    }
    let configIdentity: string, work: Readonly<{
      maximumPixelWork: number;
      maximumOutputSurfaces: 0 | 1 | 2;
      maximumOutputRgbaBytes: number;
    }>;
    if (operation.op === "cut.visual.color_grade") {
      const config = referenceColorGradeConfigAt(ir, node, exactTime);
      configIdentity = hash(config);
      const linearBalance = config.exposureStops !== 0 || config.temperature !== 0 || config.tint !== 0;
      const backendGrade = config.brightness !== 1 || config.saturation !== 1 || config.hueDegrees !== 0 || config.contrast !== 1;
      const passes = Number(linearBalance) + Number(backendGrade) as 0 | 1 | 2;
      work = Object.freeze({
        maximumPixelWork: checkedProduct(node, [plan.decodedCrop.pixels, passes], "ColorGrade native-crop frame work"),
        maximumOutputSurfaces: passes,
        maximumOutputRgbaBytes: checkedProduct(node, [plan.decodedCrop.pixels, passes, 4], "ColorGrade native-crop frame bytes"),
      });
    } else {
      const config = referenceVisualEffectConfig(node);
      if (!config) fail(node, "CUT_MEDIA_CAMERA_PREFLIGHT", "lost its closed native-crop visual-effect configuration.");
      configIdentity = hash(config);
      if (operation.staticConfigIdentity !== configIdentity) {
        fail(node, "CUT_MEDIA_CAMERA_PREFLIGHT", "native-crop visual-effect configuration changed after static planning.");
      }
      work = nativeEffectWork(node, plan.decodedCrop.pixels, config);
    }
    const executed = visible ? work : Object.freeze({
      maximumPixelWork: 0,
      maximumOutputSurfaces: 0 as const,
      maximumOutputRgbaBytes: 0,
    });
    pixelWork += executed.maximumPixelWork;
    outputSurfaces += executed.maximumOutputSurfaces;
    outputRgbaBytes += executed.maximumOutputRgbaBytes;
    if (!Number.isSafeInteger(pixelWork) || !Number.isSafeInteger(outputSurfaces) || !Number.isSafeInteger(outputRgbaBytes)) {
      fail(node, "CUT_MEDIA_CAMERA_LIMIT", "native-crop exact-frame effect work exceeds safe integer accounting.");
    }
    return Object.freeze({
      executionOrder: operation.executionOrder,
      nodeId: operation.nodeId,
      op: operation.op,
      configIdentity,
      pixelWork: executed.maximumPixelWork,
      outputSurfaces: executed.maximumOutputSurfaces,
      outputRgbaBytes: executed.maximumOutputRgbaBytes,
    });
  }));
  const receipt = Object.freeze({
    algorithmVersion: referenceMediaCamera2DNativeEffectChainAlgorithmVersion,
    basis: chain.basis,
    order: chain.order,
    status: visible ? "execute" as const : "opacity-zero" as const,
    operations,
    pixelWork,
    outputSurfaces,
    outputRgbaBytes,
  });
  return Object.freeze({ ...receipt, planIdentity: hash(receipt) });
}

function exactMediaTargetFrame(node: IRNode, exactTime: Rational, intervalStart: Rational, fps: Rational) {
  const exact = multiplyRational(subtractRational(exactTime, intervalStart), fps);
  if (exact.denominator !== "1") fail(node, "CUT_MEDIA_CAMERA_PREFLIGHT", "video target time does not land on the exact composition frame grid.");
  const value = BigInt(exact.numerator);
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) fail(node, "CUT_MEDIA_CAMERA_PREFLIGHT", "video target frame exceeds the safe non-negative integer range.");
  return Number(value);
}

function boundedVideoFrameCount(node: IRNode, duration: Rational, fps: Rational) {
  const exact = multiplyRational(duration, fps), numerator = BigInt(exact.numerator), denominator = BigInt(exact.denominator);
  if (numerator <= 0n) fail(node, "CUT_MEDIA_CAMERA_PREFLIGHT", "video decode duration must contain at least one output frame.");
  const count = (numerator + denominator - 1n) / denominator;
  if (count > BigInt(Number.MAX_SAFE_INTEGER)) fail(node, "CUT_MEDIA_CAMERA_LIMIT", "video decode frame limit exceeds safe integer accounting.");
  return Number(count);
}

function managedColorConversionRequired(inputColor: ReferenceVideoInputConfig["inputColor"]) {
  return inputColor !== "legacy" && inputColor !== "srgb";
}

function referenceMediaCamera2DVideoDecodePlanAt(
  ir: CutAVIR,
  composition: IRComposition,
  plan: ReferenceMediaCamera2DPlan,
  exactTime: Rational,
  visible: boolean,
  decoderState?: ReferenceMediaCamera2DVideoDecoderState,
): ReferenceMediaCamera2DVideoDecodePlan | undefined {
  if (plan.leafKind !== "video") return undefined;
  const camera = ir.nodes[plan.cameraNodeId], leaf = ir.nodes[plan.leafNodeId], video = plan.decodePlan.videoExecution?.config;
  if (!camera || !leaf || !video) throw new Error(`CUT_MEDIA_CAMERA_GRAPH: planned Video camera ${plan.cameraNodeId} lost its closed decode configuration.`);
  const decodeDuration = video.loop || compareRational(video.sourceDuration, leaf.interval.duration) >= 0
    ? leaf.interval.duration
    : video.sourceDuration;
  const frameLimit = boundedVideoFrameCount(camera, decodeDuration, composition.fps);
  const targetFrame = exactMediaTargetFrame(camera, exactTime, leaf.interval.start, composition.fps);
  const state: ReferenceMediaCamera2DVideoDecoderState = decoderState
    ?? Object.freeze({ status: "unopened" as const, lastFrame: -1, hasCurrentFrame: false });
  if (!Number.isSafeInteger(state.lastFrame) || state.lastFrame < -1
    || (state.frameLimit !== undefined && state.frameLimit !== frameLimit)
    || (state.status === "unopened" && (state.lastFrame !== -1 || state.hasCurrentFrame || state.frameLimit !== undefined))
    || (state.status === "ended" && !state.hasCurrentFrame)
    || (state.status !== "unopened" && state.frameLimit === undefined)
    || (state.status === "open" && ((state.lastFrame === -1 && state.hasCurrentFrame) || (state.lastFrame >= 0 && !state.hasCurrentFrame)))) {
    fail(camera, "CUT_MEDIA_CAMERA_PREFLIGHT", "video decoder state is not canonical for the admitted source and frame limit.");
  }
  let strategy: ReferenceMediaCamera2DVideoDecodePlan["strategy"];
  let decodedFramesRead = 0, readerPullAttempts = 0;
  if (!visible) {
    strategy = "opacity-zero-skip";
  } else if (state.status === "ended") {
    if (targetFrame < state.lastFrame) fail(camera, "CUT_MEDIA_CAMERA_PREFLIGHT", `video target frame ${targetFrame} precedes held decoder frame ${state.lastFrame}.`);
    strategy = "held-frame";
  } else {
    if (targetFrame < state.lastFrame) fail(camera, "CUT_MEDIA_CAMERA_PREFLIGHT", `video target frame ${targetFrame} precedes decoder frame ${state.lastFrame}; backward decoding is not admitted.`);
    const desiredFrames = targetFrame - state.lastFrame;
    const remainingFrames = Math.max(0, frameLimit - (state.lastFrame + 1));
    decodedFramesRead = Math.min(desiredFrames, remainingFrames);
    const reachesHeldEnd = desiredFrames > remainingFrames;
    if (reachesHeldEnd && video.endBehavior !== "hold") {
      fail(camera, "CUT_MEDIA_CAMERA_PREFLIGHT", `video target frame ${targetFrame} exceeds decoder frame limit ${frameLimit} without endBehavior: “hold”.`);
    }
    readerPullAttempts = decodedFramesRead + (reachesHeldEnd ? 1 : 0);
    strategy = desiredFrames === 0 ? "reuse-current" : reachesHeldEnd ? "sequential-to-hold" : "sequential-catch-up";
  }
  if (decodedFramesRead > referenceMediaCamera2DLimits.maximumSequentialVideoFramesReadPerSceneFrame) {
    fail(camera, "CUT_MEDIA_CAMERA_LIMIT", `sequential catch-up needs ${decodedFramesRead} decoded frames for target ${targetFrame}, exceeding ${referenceMediaCamera2DLimits.maximumSequentialVideoFramesReadPerSceneFrame}; bounded cadence-locked sparse seek is not implemented.`);
  }
  const cropPixels = plan.decodedCrop.pixels, cropBytes = checkedProduct(camera, [cropPixels, 4], "decoded crop RGBA bytes");
  const converted = managedColorConversionRequired(video.inputColor) ? decodedFramesRead : 0;
  const decodedRgbaBytes = checkedProduct(camera, [decodedFramesRead, cropBytes], "planned decoded RGBA bytes");
  const managedColorConversionRgbaBytes = checkedProduct(camera, [converted, cropBytes], "planned managed-color RGBA bytes");
  const hadCurrent = state.hasCurrentFrame;
  const decoderPeakResidentSurfaces = decodedFramesRead === 0
    ? (hadCurrent ? 1 : 0)
    : 1 + (converted > 0 ? 1 : 0) + (hadCurrent || decodedFramesRead > 1 ? 1 : 0);
  const maximum = Object.freeze({
    decodePixelWork: checkedProduct(camera, [decodedFramesRead, cropPixels], "video decode pixel work"),
    managedColorConversionPixelWork: checkedProduct(camera, [converted, cropPixels], "managed-color conversion pixel work"),
    decoderPeakResidentSurfaces,
    decoderPeakResidentRgbaBytes: checkedProduct(camera, [decoderPeakResidentSurfaces, cropBytes], "decoder peak resident RGBA bytes"),
  });
  const planned = Object.freeze({
    sourceOpens: visible && state.status === "unopened" ? 1 as const : 0 as const,
    readerPullAttempts,
    decodedFramesRead,
    decodedSurfaces: decodedFramesRead,
    decodedRgbaBytes,
    managedColorConversionPasses: converted,
    managedColorConversionSurfaces: converted,
    managedColorConversionRgbaBytes,
    decoderRetainedFrameCopies: 0 as const,
    decoderRetainedFrameCopyRgbaBytes: 0 as const,
  });
  const receipt = Object.freeze({
    targetFrame,
    frameLimit,
    strategy,
    stateAtPreflight: Object.freeze({ ...state }),
    planned,
    maximum,
  });
  return Object.freeze({ ...receipt, planIdentity: hash(receipt) });
}

function assertReferenceMediaCamera2DPlanFresh(
  ir: CutAVIR,
  plan: ReferenceMediaCamera2DPlan,
  composition?: IRComposition,
) {
  const camera = ir.nodes[plan.cameraNodeId];
  if (!camera || camera.op !== "cut.visual.media_camera2d") {
    throw new Error(`CUT_MEDIA_CAMERA_GRAPH: missing planned MediaCamera2D ${plan.cameraNodeId}.`);
  }
  const authority = mediaCamera2DPlanAuthorities.get(plan);
  if (!authority
    || authority.ir !== ir
    || (composition !== undefined && authority.composition !== composition)
    || referenceMediaCamera2DStaticStateIdentity(ir, authority.composition, plan)
      !== authority.staticStateIdentity) {
    fail(camera, "CUT_MEDIA_CAMERA_PREFLIGHT", "camera plan is forged, detached, or stale relative to its locked IR, composition, scene, or source resource; rebuild static MediaCamera2D validation.");
  }
  const grade = plan.gradeNodeId ? ir.nodes[plan.gradeNodeId] : undefined;
  const leaf = ir.nodes[plan.leafNodeId];
  if (camera.contentHash !== plan.cameraExecutableContentHash
    || executableNodeIdentity(ir, camera) !== plan.cameraExecutableIdentity
    || (plan.gradeNodeId !== undefined && grade?.contentHash !== plan.gradeExecutableContentHash)
    || (plan.gradeNodeId !== undefined && grade !== undefined
      && executableNodeIdentity(ir, grade) !== plan.gradeExecutableIdentity)
    || leaf?.contentHash !== plan.leafExecutableContentHash
    || (leaf !== undefined && executableNodeIdentity(ir, leaf) !== plan.leafExecutableIdentity)) {
    fail(camera, "CUT_MEDIA_CAMERA_PREFLIGHT", "camera, grade, or media executable content changed after locked static planning; rebuild the MediaCamera2D plan before frame admission.");
  }
  for (const operation of plan.nativeEffectChain?.operations ?? []) {
    const effect = ir.nodes[operation.nodeId];
    if (!effect
      || effect.op !== operation.op
      || effect.contentHash !== operation.executableContentHash
      || executableNodeIdentity(ir, effect) !== operation.executableIdentity) {
      fail(camera, "CUT_MEDIA_CAMERA_PREFLIGHT", `native-crop effect ${operation.nodeId} changed after locked static planning; rebuild the MediaCamera2D plan before frame admission.`);
    }
    if (operation.op !== "cut.visual.color_grade") {
      const config = referenceVisualEffectConfig(effect);
      if (!config || hash(config) !== operation.staticConfigIdentity) {
        fail(camera, "CUT_MEDIA_CAMERA_PREFLIGHT", `native-crop effect ${operation.nodeId} lost its admitted static configuration after planning.`);
      }
    }
  }
  return Object.freeze({ camera, grade, leaf, authority });
}

export function assertReferenceMediaCamera2DPlanAuthority(
  ir: CutAVIR,
  composition: IRComposition,
  plan: ReferenceMediaCamera2DPlan,
) {
  assertReferenceMediaCamera2DPlanFresh(ir, plan, composition);
}

export function referenceMediaCamera2DAnchorBasis(plan: ReferenceMediaCamera2DPlan) {
  if (!mediaCamera2DPlanAuthorities.has(plan)) {
    throw new Error("CUT_MEDIA_CAMERA_PREFLIGHT: source-anchor basis requires the exact locked MediaCamera2D plan object minted by graph validation.");
  }
  const receipt = Object.freeze({
    algorithmVersion: referenceMediaCamera2DAnchorAlgorithmVersion,
    cameraNodeId: plan.cameraNodeId,
    kind: "post-crop-source-pixel-centres" as const,
    width: plan.decodedCrop.width,
    height: plan.decodedCrop.height,
    crop: plan.crop,
    fit: plan.fit,
    output: plan.output,
  });
  return Object.freeze({
    kind: receipt.kind,
    width: receipt.width,
    height: receipt.height,
    semanticIdentity: hash(receipt),
  });
}

function mediaCamera2DAnchorPlanFromParts(
  plan: ReferenceMediaCamera2DPlan,
  exactTime: Rational,
  controls: ReferenceMediaCamera2DAnchorPlan["controls"],
  sourceToOutputQ16: ReferenceMediaCamera2DAnchorPlan["sourceToDeliveryQ16"],
  sourceToOutput: ReferenceAffine2D,
): ReferenceMediaCamera2DAnchorPlan {
  const basis = referenceMediaCamera2DAnchorBasis(plan);
  const responsiveSlotComposition = plan.outputContext.kind !== "responsive-slot"
    ? undefined
    : (() => {
        const output = plan.outputContext;
        const sourceToSlotAffineIdentity = hash({
          algorithmVersion: referenceMediaCamera2DAnchorAlgorithmVersion,
          coordinateSpace: "responsive-slot",
          cameraNodeId: plan.cameraNodeId,
          basisSemanticIdentity: basis.semanticIdentity,
          outputContextIdentity: output.semanticIdentity,
          sourceToSlotQ16: sourceToOutputQ16,
        });
        const slotBasis = Object.freeze({
          kind: "responsive-slot-pixel-centres" as const,
          width: output.width,
          height: output.height,
          semanticIdentity: hash({
            kind: "responsive-slot-pixel-centres",
            compositionId: output.compositionId,
            stackNodeId: output.stackNodeId,
            slotNodeId: output.slotNodeId,
            index: output.index,
            outputContextIdentity: output.semanticIdentity,
            width: output.width,
            height: output.height,
          }),
        });
        const slotToCompositionQ16 = Object.freeze({
          a: "65536" as const,
          b: "0" as const,
          c: "0" as const,
          d: "65536" as const,
          tx: String(BigInt(output.rasterSlot.left) * 65_536n),
          ty: String(BigInt(output.rasterSlot.top) * 65_536n),
        });
        const compositionBasis = Object.freeze({
          kind: "composition-pixel-centres" as const,
          width: output.compositionWidth,
          height: output.compositionHeight,
          semanticIdentity: hash({
            kind: "composition-pixel-centres",
            compositionId: output.compositionId,
            width: output.compositionWidth,
            height: output.compositionHeight,
          }),
        });
        const receipt = {
          algorithmVersion: referenceMediaCamera2DResponsiveSlotAnchorAlgorithmVersion,
          pixelPlacementAlgorithmVersion: referenceMediaCamera2DResponsiveSlotPixelPlacementAlgorithmVersion,
          compositionId: output.compositionId,
          stackNodeId: output.stackNodeId,
          slotNodeId: output.slotNodeId,
          index: output.index,
          compilerContextIdentity: output.compilerContextIdentity,
          outputContextIdentity: output.semanticIdentity,
          responsivePlanIdentity: output.planIdentity,
          sourceToSlotQ16: sourceToOutputQ16,
          sourceToSlotAffineIdentity,
          slotBasis,
          slotToCompositionQ16,
          compositionBasis,
          rasterSlot: output.rasterSlot,
          clip: output.clip,
        } as const;
        return Object.freeze({
          ...receipt,
          placementPlanIdentity: hash(receipt),
        });
      })();
  const sourceToDeliveryQ16 = !responsiveSlotComposition
    ? sourceToOutputQ16
    : Object.freeze({
        a: sourceToOutputQ16.a,
        b: sourceToOutputQ16.b,
        c: sourceToOutputQ16.c,
        d: sourceToOutputQ16.d,
        tx: String(BigInt(sourceToOutputQ16.tx) + BigInt(responsiveSlotComposition.slotToCompositionQ16.tx)),
        ty: String(BigInt(sourceToOutputQ16.ty) + BigInt(responsiveSlotComposition.slotToCompositionQ16.ty)),
      });
  const sourceToDelivery = !responsiveSlotComposition
    ? sourceToOutput
    : Object.freeze({
        ...sourceToOutput,
        tx: sourceToOutput.tx + responsiveSlotComposition.rasterSlot.left,
        ty: sourceToOutput.ty + responsiveSlotComposition.rasterSlot.top,
      });
  const affineIdentity = hash({
    algorithmVersion: referenceMediaCamera2DAnchorAlgorithmVersion,
    cameraNodeId: plan.cameraNodeId,
    basisSemanticIdentity: basis.semanticIdentity,
    sourceToDeliveryQ16,
    ...(responsiveSlotComposition ? {
      coordinateSpace: "responsive-slot-composition",
      responsiveSlotPlacementPlanIdentity: responsiveSlotComposition.placementPlanIdentity,
    } : {}),
  });
  const status = controls.opacityPhase === 0 ? "opacity-zero" as const : "visible" as const;
  return Object.freeze({
    algorithmVersion: referenceMediaCamera2DAnchorAlgorithmVersion,
    cameraNodeId: plan.cameraNodeId,
    exactTime: Object.freeze({ ...exactTime }),
    status,
    basis,
    controls,
    sourceToDeliveryQ16,
    sourceToDelivery,
    ...(responsiveSlotComposition ? { responsiveSlotComposition } : {}),
    affineIdentity,
    ownerPlanIdentity: hash({
      algorithmVersion: referenceMediaCamera2DAnchorAlgorithmVersion,
      cameraPlanSemanticIdentity: plan.semanticIdentity,
      exactTime,
      status,
      controls,
      affineIdentity,
      ...(responsiveSlotComposition ? {
        responsiveSlotPlacementPlanIdentity: responsiveSlotComposition.placementPlanIdentity,
      } : {}),
    }),
  });
}

function authorizeReferenceMediaCamera2DAnchorPlan(
  anchorPlan: ReferenceMediaCamera2DAnchorPlan,
  ir: CutAVIR,
  plan: ReferenceMediaCamera2DPlan,
) {
  const { authority } = assertReferenceMediaCamera2DPlanFresh(ir, plan);
  mediaCamera2DAnchorPlanAuthorities.set(anchorPlan, Object.freeze({
    ir,
    composition: authority.composition,
    plan,
  }));
  return anchorPlan;
}

export function isAuthorizedReferenceMediaCamera2DAnchorPlan(
  anchorPlan: ReferenceMediaCamera2DAnchorPlan,
  ownerNodeId: string,
  exactTime: Rational,
) {
  const authority = mediaCamera2DAnchorPlanAuthorities.get(anchorPlan);
  if (authority === undefined
    || authority.plan.cameraNodeId !== ownerNodeId
    || anchorPlan.cameraNodeId !== ownerNodeId
    || compareRational(anchorPlan.exactTime, exactTime) !== 0) {
    return false;
  }
  try {
    assertReferenceMediaCamera2DPlanFresh(
      authority.ir,
      authority.plan,
      authority.composition,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Sample only the MediaCamera2D coordinate semantics. This path never opens a
 * source, plans a decoder catch-up, allocates a surface, grades pixels, or
 * requests a geometric resample.
 */
export function referenceMediaCamera2DAnchorPlanAt(
  ir: CutAVIR,
  composition: IRComposition,
  plan: ReferenceMediaCamera2DPlan,
  exactTime: Rational,
  resolver?: ReferencePreparedSignalResolver,
): ReferenceMediaCamera2DAnchorPlan {
  const { camera } = assertReferenceMediaCamera2DPlanFresh(ir, plan, composition);
  if (plan.compositionId !== composition.id) {
    fail(camera, "CUT_MEDIA_CAMERA_PREFLIGHT", `locked camera plan belongs to composition ${plan.compositionId}, not ${composition.id}.`);
  }
  const authoredOpacity = resolvedControl(ir, camera, "opacity", exactTime, resolver);
  const controls = Object.freeze({
    focusX: resolvedControl(ir, camera, "focusX", exactTime, resolver),
    focusY: resolvedControl(ir, camera, "focusY", exactTime, resolver),
    zoom: resolvedControl(ir, camera, "zoom", exactTime, resolver),
    rotationDegrees: resolvedControl(ir, camera, "rotation", exactTime, resolver),
    opacity: authoredOpacity,
    opacityPhase: referenceMediaCamera2DOpacityPhase(camera, authoredOpacity),
  });
  const affine = referenceMediaCamera2DQuantizedAffine(camera, {
    source: Object.freeze({ width: plan.decodedCrop.width, height: plan.decodedCrop.height }),
    output: Object.freeze({ width: plan.output.width, height: plan.output.height }),
    fit: plan.fit,
    edge: plan.edge,
  }, {
    focusX: controls.focusX,
    focusY: controls.focusY,
    zoom: controls.zoom,
    rotationDegrees: controls.rotationDegrees,
  });
  const sourceToDeliveryQ16 = q16Matrix(affine);
  const sourceToDelivery = affineFromQ16(camera, sourceToDeliveryQ16);
  return authorizeReferenceMediaCamera2DAnchorPlan(mediaCamera2DAnchorPlanFromParts(
    plan,
    exactTime,
    controls,
    sourceToDeliveryQ16,
    sourceToDelivery,
  ), ir, plan);
}

/** Reuse an already-admitted frame's exact Q16 geometry without sampling the
 * camera signals a second time. */
export function referenceMediaCamera2DAnchorPlanFromFramePlan(
  ir: CutAVIR,
  plan: ReferenceMediaCamera2DPlan,
  framePlan: ReferenceMediaCamera2DFramePlan,
): ReferenceMediaCamera2DAnchorPlan {
  const { camera, authority } = assertReferenceMediaCamera2DPlanFresh(ir, plan);
  const frameAuthority = mediaCamera2DFramePlanAuthorities.get(framePlan);
  if (!frameAuthority
    || frameAuthority.ir !== ir
    || frameAuthority.plan !== plan
    || frameAuthority.composition !== authority.composition) {
    fail(camera, "CUT_MEDIA_CAMERA_PREFLIGHT", "anchor reuse requires the exact same-invocation frame-plan object minted for this locked camera; cloned, forged, stale, or cross-plan receipts are evidence only.");
  }
  if (framePlan.cameraNodeId !== plan.cameraNodeId
    || framePlan.compositionId !== plan.compositionId
    || framePlan.sceneId !== plan.sceneId
    || framePlan.leafNodeId !== plan.leafNodeId) {
    fail(camera, "CUT_MEDIA_CAMERA_PREFLIGHT", "anchor reuse received a foreign MediaCamera2D frame plan.");
  }
  const controls = Object.freeze({
    focusX: framePlan.controls.focusX,
    focusY: framePlan.controls.focusY,
    zoom: framePlan.controls.zoom,
    rotationDegrees: framePlan.controls.rotationDegrees,
    opacity: framePlan.controls.opacity,
    opacityPhase: framePlan.controls.opacityPhase,
  });
  const sourceToDelivery = affineFromQ16(camera, framePlan.geometry.sourceToDeliveryQ16);
  return authorizeReferenceMediaCamera2DAnchorPlan(mediaCamera2DAnchorPlanFromParts(
    plan,
    framePlan.exactTime,
    controls,
    framePlan.geometry.sourceToDeliveryQ16,
    sourceToDelivery,
  ), ir, plan);
}

/** Resolve one exact output-frame plan before any resource path or decoder is touched. */
export function referenceMediaCamera2DFramePlanAt(
  ir: CutAVIR,
  composition: IRComposition,
  plan: ReferenceMediaCamera2DPlan,
  exactTime: Rational,
  resolver?: ReferencePreparedSignalResolver,
  videoDecoderState?: ReferenceMediaCamera2DVideoDecoderState,
): ReferenceMediaCamera2DFramePlan {
  const { camera } = assertReferenceMediaCamera2DPlanFresh(ir, plan, composition);
  const authoredOpacity = resolvedControl(ir, camera, "opacity", exactTime, resolver);
  const controls = Object.freeze({
    focusX: resolvedControl(ir, camera, "focusX", exactTime, resolver),
    focusY: resolvedControl(ir, camera, "focusY", exactTime, resolver),
    zoom: resolvedControl(ir, camera, "zoom", exactTime, resolver),
    rotationDegrees: resolvedControl(ir, camera, "rotation", exactTime, resolver),
    opacity: authoredOpacity,
    opacityPhase: referenceMediaCamera2DOpacityPhase(camera, authoredOpacity),
    edge: plan.edge,
  });
  const source = Object.freeze({ width: plan.decodedCrop.width, height: plan.decodedCrop.height });
  const output = Object.freeze({ width: plan.output.width, height: plan.output.height });
  const observabilityGrid = Object.freeze({ source, output, fit: plan.fit, edge: controls.edge });
  const affine = referenceMediaCamera2DQuantizedAffine(camera, observabilityGrid, controls);
  const inverse = referenceMediaCamera2DInverseAffine(affine);
  const sourceQuad = [
    applyAffine(affine, -0.5, -0.5),
    applyAffine(affine, source.width - 0.5, -0.5),
    applyAffine(affine, source.width - 0.5, source.height - 0.5),
    applyAffine(affine, -0.5, source.height - 0.5),
  ] as const;
  const deliveryInSource = [
    applyAffine(inverse, -0.5, -0.5),
    applyAffine(inverse, output.width - 0.5, -0.5),
    applyAffine(inverse, output.width - 0.5, output.height - 0.5),
    applyAffine(inverse, -0.5, output.height - 0.5),
  ] as const;
  const padding = controls.edge === "clamp"
    ? referenceMediaCamera2DClampPadding(affine, source, output)
    : Object.freeze({ left: 0, top: 0, right: 0, bottom: 0 });
  const rasterSource = Object.freeze({
    width: source.width + padding.left + padding.right,
    height: source.height + padding.top + padding.bottom,
  });
  const rasterPixels = checkedProduct(camera, [rasterSource.width, rasterSource.height], "camera raster-source pixels");
  if (rasterSource.width > referenceMediaCamera2DLimits.maximumClampPaddedAxisPx || rasterSource.height > referenceMediaCamera2DLimits.maximumClampPaddedAxisPx
    || rasterPixels > referenceMediaCamera2DLimits.maximumClampPaddedPixels) {
    fail(camera, "CUT_MEDIA_CAMERA_LIMIT", `edge padding requires ${rasterSource.width}x${rasterSource.height}; crop, cover, reduce rotation, or use transparent edge.`);
  }
  const adjusted = controls.edge === "clamp" ? adjustedForPadding(affine, padding) : affine;
  const clampPaddingAllocated = padding.left !== 0 || padding.top !== 0 || padding.right !== 0 || padding.bottom !== 0;
  const clampPaddedPixels = clampPaddingAllocated ? rasterPixels : 0;
  const outputBounds = controls.edge === "clamp"
    ? Object.freeze({ left: 0, top: 0, right: output.width, bottom: output.height, width: output.width, height: output.height, pixels: plan.output.pixels })
    : outputBoundsFor(adjusted, rasterSource, output);
  const visible = controls.opacityPhase !== 0 && outputBounds !== undefined;
  const videoDecode = referenceMediaCamera2DVideoDecodePlanAt(ir, composition, plan, exactTime, visible, videoDecoderState);
  const colorGradeWork = colorGradeWorkAt(ir, plan, exactTime, visible);
  const nativeEffectChain = nativeEffectChainAt(ir, plan, exactTime, visible);
  const nativeEffectOperations = nativeEffectChain?.operations.filter((operation) => operation.op !== "cut.visual.color_grade") ?? [];
  const nativeEffectPixelWork = nativeEffectOperations.reduce((sum, operation) => sum + operation.pixelWork, 0);
  const nativeEffectOutputRgbaBytes = nativeEffectOperations.reduce((sum, operation) => sum + operation.outputRgbaBytes, 0);
  const maximumSampleVisits = visible ? outputBounds.pixels * 4 : 0;
  const maximumDecodePixelWork = !visible ? 0 : videoDecode ? videoDecode.maximum.decodePixelWork : plan.decodedCrop.pixels;
  const maximumManagedColorConversionPixelWork = videoDecode?.maximum.managedColorConversionPixelWork ?? 0;
  const maximumPixelWork = maximumDecodePixelWork + maximumManagedColorConversionPixelWork + clampPaddedPixels
    + colorGradeWork.maximumColorGradePixelWork + nativeEffectPixelWork
    + plan.output.pixels + (visible ? outputBounds.pixels : 0) + maximumSampleVisits;
  if (!Number.isSafeInteger(maximumPixelWork) || maximumPixelWork > referenceMediaCamera2DLimits.maximumFramePixelWork) {
    fail(camera, "CUT_MEDIA_CAMERA_LIMIT", `frame pixel work ${maximumPixelWork} exceeds ${referenceMediaCamera2DLimits.maximumFramePixelWork}.`);
  }
  const geometry = Object.freeze({
    sourceToDeliveryQ16: q16Matrix(affine),
    sourceQuadQ16: q16Points(sourceQuad),
    deliveryOuterEdgesInSourceQ16: q16Points(deliveryInSource),
    ...(outputBounds ? { outputBounds } : {}),
    clampPadding: padding,
    rasterSource: Object.freeze({ ...rasterSource, pixels: rasterPixels, rgbaBytes: rasterPixels * 4 }),
  });
  const work = Object.freeze({
    sourceFileBytes: plan.source.resourceBytes,
    nativePixels: plan.native.pixels,
    decodedCropPixels: plan.decodedCrop.pixels,
    decodedCropRgbaBytes: plan.decodedCrop.pixels * 4,
    clampPaddedPixels,
    clampPaddedRgbaBytes: clampPaddedPixels * 4,
    outputPixels: plan.output.pixels,
    outputRgbaBytes: plan.output.rgbaBytes,
    maximumDecodePixelWork,
    maximumManagedColorConversionPixelWork,
    colorGradePixelPasses: colorGradeWork.colorGradePixelPasses,
    maximumColorGradePixelWork: colorGradeWork.maximumColorGradePixelWork,
    ...(nativeEffectChain ? {
      nativeEffectOperationCount: nativeEffectOperations.length,
      maximumNativeEffectPixelWork: nativeEffectPixelWork,
      maximumNativeEffectOutputRgbaBytes: nativeEffectOutputRgbaBytes,
    } : {}),
    maximumBilinearSampleVisits: maximumSampleVisits,
    maximumPixelWork,
    compositionPrerasterCount: 0 as const,
    geometricResampleCount: visible ? 1 as const : 0 as const,
  });
  const status = visible ? "visible" as const : "opacity-zero" as const;
  let rasterPlan: ReferenceRetainedMediaViewportPlan | undefined;
  let rasterState: ReferenceRetainedMediaViewportState | undefined;
  if (visible) {
    const rasterIdentity = hash({
      kind: "media-camera2d-q16-raster-v1",
      decodePlan: plan.decodePlan.semanticIdentity,
      outputContextIdentity: plan.outputContext.semanticIdentity,
      grid: plan.observability.grid,
      exactTime,
      adjusted,
      geometry,
      work,
      gradeExecutionIdentity: colorGradeWork.gradeExecutionIdentity,
      ...(nativeEffectChain ? { nativeEffectChainPlanIdentity: nativeEffectChain.planIdentity } : {}),
    });
    rasterPlan = Object.freeze({
      localSpaceNodeId: camera.id,
      rootId: camera.id,
      leafId: plan.leafNodeId,
      leafKind: plan.leafKind,
      nodeIds: Object.freeze([camera.id]),
      wrapperOps: Object.freeze([]),
      sourceId: plan.source.resourceId,
      sourceSha256: plan.source.sha256,
      selectedVariant: plan.source.selectedVariant,
      native: Object.freeze({ width: rasterSource.width, height: rasterSource.height }),
      cropped: Object.freeze({ left: 0, top: 0, width: rasterSource.width, height: rasterSource.height }),
      fit: "fill",
      fitted: Object.freeze({ width: rasterSource.width, height: rasterSource.height }),
      viewport: Object.freeze({ width: output.width, height: output.height }),
      resample: "cut-q16-associated-bilinear-direct-affine",
      maximumPixelWorkPerFrame: maximumPixelWork,
      semanticIdentity: rasterIdentity,
    });
    rasterState = Object.freeze({
      active: true,
      hidden: false,
      opacity: controls.opacityPhase / referenceMediaCamera2DOpacityPhaseUnits,
      affine: adjusted,
      sourceToViewport: adjusted,
      sourceBounds: referenceRect(0, 0, rasterSource.width, rasterSource.height),
      outputBounds,
      workIdentity: hash({ rasterIdentity, exactTime, adjusted, opacityPhase: controls.opacityPhase, outputBounds }),
    });
  }
  const receipt = Object.freeze({
    algorithmVersion: referenceMediaCamera2DAlgorithmVersion,
    compositionId: composition.id,
    sceneId: plan.sceneId,
    cameraNodeId: camera.id,
    leafNodeId: plan.leafNodeId,
    outputContext: plan.outputContext,
    exactTime: Object.freeze({ ...exactTime }),
    status,
    controls,
    geometry,
    work,
    ...(colorGradeWork.gradeExecutionIdentity ? { gradeExecutionIdentity: colorGradeWork.gradeExecutionIdentity } : {}),
    ...(nativeEffectChain ? { nativeEffectChain } : {}),
    ...(videoDecode ? { videoDecode } : {}),
    ...(rasterPlan && rasterState ? { rasterPlan, rasterState } : {}),
  });
  const executedIdentity = Object.freeze({
    algorithmVersion: receipt.algorithmVersion,
    compositionId: receipt.compositionId,
    sceneId: receipt.sceneId,
    cameraNodeId: receipt.cameraNodeId,
    leafNodeId: receipt.leafNodeId,
    outputContextIdentity: receipt.outputContext.semanticIdentity,
    exactTime: receipt.exactTime,
    status: receipt.status,
    opacityPhase: controls.opacityPhase,
    edge: controls.edge,
    geometry,
    work,
    ...(colorGradeWork.gradeExecutionIdentity ? { gradeExecutionIdentity: colorGradeWork.gradeExecutionIdentity } : {}),
    ...(nativeEffectChain ? { nativeEffectChainPlanIdentity: nativeEffectChain.planIdentity } : {}),
    ...(videoDecode ? { videoDecodePlanIdentity: videoDecode.planIdentity } : {}),
    ...(rasterPlan ? { rasterPlanIdentity: rasterPlan.semanticIdentity } : {}),
  });
  const framePlan = Object.freeze({ ...receipt, planIdentity: hash(executedIdentity) });
  mediaCamera2DFramePlanAuthorities.set(framePlan, Object.freeze({ ir, composition, plan }));
  return framePlan;
}

function checkedAggregateAdd(node: IRNode, current: number, value: number, label: string) {
  const result = current + value;
  if (!Number.isSafeInteger(value) || value < 0 || !Number.isSafeInteger(result)) {
    fail(node, "CUT_MEDIA_CAMERA_LIMIT", `scene aggregate ${label} exceeds safe integer accounting.`);
  }
  return result;
}

// A persisted receipt is evidence, not execution authority. Only the exact
// frozen object minted by the complete scene admission call may authorize
// per-camera completion during that invocation; JSON or a guessed digest
// cannot mint completed evidence.
const mediaCamera2DSceneAdmissionAuthorities = new WeakMap<object, Set<string>>();

/** Admit the complete set of reachable camera executions that sceneFrame will
 * schedule. Direct roots execute from the scene list; responsive-slot cameras
 * execute exactly once when their owning stack materializes that slot. This
 * function is metadata-only: it runs before a locator is resolved, a source is
 * opened, or a decoder is started. */
export function admitReferenceMediaCamera2DSceneFrame(
  ir: CutAVIR,
  composition: IRComposition,
  sceneId: string,
  exactTime: Rational,
  frames: readonly Readonly<{ plan: ReferenceMediaCamera2DPlan; framePlan: ReferenceMediaCamera2DFramePlan }>[],
): ReferenceMediaCamera2DSceneAdmission {
  const ordered = [...frames].sort((left, right) => left.plan.cameraNodeId.localeCompare(right.plan.cameraNodeId));
  const scene = ir.scenes[sceneId];
  const reachable = new Set<string>();
  const pending = !scene ? [] : scene.items
    .filter((item) => item.domain === "visual" || item.domain === "av")
    .map((item) => item.id);
  while (pending.length) {
    const nodeId = pending.pop()!;
    if (reachable.has(nodeId)) continue;
    reachable.add(nodeId);
    const node = ir.nodes[nodeId];
    if (node) pending.push(...node.children);
  }
  const expectedCameraIds = [...reachable]
    .filter((nodeId) => {
      const node = ir.nodes[nodeId];
      return node?.op === "cut.visual.media_camera2d" && node.sceneId === sceneId;
    })
    .sort();
  const providedCameraIds = ordered.map(({ plan }) => plan.cameraNodeId);
  const uniqueProvided = new Set(providedCameraIds);
  const mismatch = expectedCameraIds.length !== providedCameraIds.length
    || uniqueProvided.size !== providedCameraIds.length
    || expectedCameraIds.some((id, index) => id !== providedCameraIds[index]);
  if (mismatch) {
    const diagnostic = ordered[0]?.plan.cameraNodeId
      ? ir.nodes[ordered[0].plan.cameraNodeId]
      : expectedCameraIds[0]
        ? ir.nodes[expectedCameraIds[0]]
        : undefined;
    if (!diagnostic) throw new Error("CUT_MEDIA_CAMERA_GRAPH: scene camera admission references a missing/empty owning scene.");
    fail(
      diagnostic,
      "CUT_MEDIA_CAMERA_PREFLIGHT",
      `scene admission must contain exactly one frame plan for each direct MediaCamera2D root and each reachable ResponsiveSlot-owned MediaCamera2D execution; expected [${expectedCameraIds.join(", ")}], received [${providedCameraIds.join(", ")}].`,
    );
  }
  const uniqueSources = new Set<string>();
  const aggregate = {
    uniqueSourceFileBytes: 0,
    nativePixels: 0,
    nativeRgbaBytes: 0,
    decodedCropPixels: 0,
    decodedCropRgbaBytes: 0,
    clampPaddedPixels: 0,
    clampPaddedRgbaBytes: 0,
    outputPixels: 0,
    outputRgbaBytes: 0,
    plannedSourceOpens: 0,
    plannedReaderPullAttempts: 0,
    plannedDecodedFramesRead: 0,
    plannedDecodedSurfaces: 0,
    plannedDecodedRgbaBytes: 0,
    plannedManagedColorConversionPasses: 0,
    plannedManagedColorConversionSurfaces: 0,
    plannedManagedColorConversionRgbaBytes: 0,
    maximumDecodePixelWork: 0,
    maximumManagedColorConversionPixelWork: 0,
    maximumDecoderPeakResidentSurfaces: 0,
    maximumDecoderPeakResidentRgbaBytes: 0,
    colorGradePixelPasses: 0,
    maximumColorGradePixelWork: 0,
    maximumColorGradeRgbaBytes: 0,
    maximumBilinearSampleVisits: 0,
    maximumPixelWork: 0,
    conservativePeakRgbaBytes: 0,
    concurrentVideoDecoders: 0,
  };
  let visibleCameraCount = 0, opacityZeroCameraCount = 0;
  let hasNativeEffectChain = false;
  let nativeEffectOperations = 0;
  let maximumNativeEffectPixelWork = 0;
  let maximumNativeEffectOutputRgbaBytes = 0;
  const limit = (node: IRNode, value: number, maximum: number, label: string) => {
    if (value > maximum) fail(node, "CUT_MEDIA_CAMERA_LIMIT", `scene aggregate ${label} ${value} exceeds ${maximum} before camera roots begin.`);
  };
  for (const { plan, framePlan } of ordered) {
    const camera = ir.nodes[plan.cameraNodeId];
    if (!camera || camera.op !== "cut.visual.media_camera2d") throw new Error(`CUT_MEDIA_CAMERA_GRAPH: missing planned MediaCamera2D ${plan.cameraNodeId}.`);
    assertReferenceMediaCamera2DPlanFresh(ir, plan, composition);
    const planAuthority = mediaCamera2DPlanAuthorities.get(plan);
    const frameAuthority = mediaCamera2DFramePlanAuthorities.get(framePlan);
    if (!planAuthority
      || planAuthority.ir !== ir
      || planAuthority.composition !== composition
      || !frameAuthority
      || frameAuthority.ir !== ir
      || frameAuthority.composition !== composition
      || frameAuthority.plan !== plan) {
      fail(camera, "CUT_MEDIA_CAMERA_PREFLIGHT", "scene admission requires the exact authorized static and frame-plan objects minted for this locked IR and composition; cloned, forged, stale, or cross-plan receipts are evidence only.");
    }
    if (plan.compositionId !== composition.id || plan.sceneId !== sceneId || framePlan.compositionId !== composition.id
      || framePlan.sceneId !== sceneId || framePlan.cameraNodeId !== plan.cameraNodeId
      || compareRational(framePlan.exactTime, exactTime) !== 0) {
      fail(camera, "CUT_MEDIA_CAMERA_PREFLIGHT", "scene admission received a camera/frame plan from a different composition, scene, node, or exact time.");
    }
    if (framePlan.nativeEffectChain) {
      hasNativeEffectChain = true;
      nativeEffectOperations = checkedAggregateAdd(
        camera,
        nativeEffectOperations,
        framePlan.work.nativeEffectOperationCount ?? 0,
        "native-effect operations",
      );
      maximumNativeEffectPixelWork = checkedAggregateAdd(
        camera,
        maximumNativeEffectPixelWork,
        framePlan.work.maximumNativeEffectPixelWork ?? 0,
        "native-effect pixel work",
      );
      maximumNativeEffectOutputRgbaBytes = checkedAggregateAdd(
        camera,
        maximumNativeEffectOutputRgbaBytes,
        framePlan.work.maximumNativeEffectOutputRgbaBytes ?? 0,
        "native-effect output RGBA bytes",
      );
      aggregate.conservativePeakRgbaBytes = checkedAggregateAdd(
        camera,
        aggregate.conservativePeakRgbaBytes,
        framePlan.work.maximumNativeEffectOutputRgbaBytes ?? 0,
        "conservative peak RGBA bytes",
      );
      limit(
        camera,
        maximumNativeEffectPixelWork,
        referenceMediaCamera2DLimits.maximumSceneNativeEffectPixelWork,
        "native-effect pixel work",
      );
    }
    aggregate.outputPixels = checkedAggregateAdd(camera, aggregate.outputPixels, plan.output.pixels, "output pixels");
    aggregate.outputRgbaBytes = checkedAggregateAdd(camera, aggregate.outputRgbaBytes, plan.output.rgbaBytes, "output RGBA bytes");
    aggregate.conservativePeakRgbaBytes = checkedAggregateAdd(camera, aggregate.conservativePeakRgbaBytes, plan.output.rgbaBytes, "conservative peak RGBA bytes");
    limit(camera, aggregate.outputPixels, referenceMediaCamera2DLimits.maximumSceneOutputPixels, "output pixels");
    if (framePlan.videoDecode) {
      aggregate.maximumDecoderPeakResidentSurfaces = checkedAggregateAdd(camera, aggregate.maximumDecoderPeakResidentSurfaces, framePlan.videoDecode.maximum.decoderPeakResidentSurfaces, "decoder peak resident surfaces");
      aggregate.maximumDecoderPeakResidentRgbaBytes = checkedAggregateAdd(camera, aggregate.maximumDecoderPeakResidentRgbaBytes, framePlan.videoDecode.maximum.decoderPeakResidentRgbaBytes, "decoder peak resident RGBA bytes");
      aggregate.conservativePeakRgbaBytes = checkedAggregateAdd(camera, aggregate.conservativePeakRgbaBytes, framePlan.videoDecode.maximum.decoderPeakResidentRgbaBytes, "conservative peak RGBA bytes");
      if (framePlan.videoDecode.stateAtPreflight.status !== "unopened" || framePlan.status === "visible") {
        aggregate.concurrentVideoDecoders = checkedAggregateAdd(camera, aggregate.concurrentVideoDecoders, 1, "concurrent video decoders");
      }
    }

    if (framePlan.status === "opacity-zero") {
      opacityZeroCameraCount += 1;
      limit(camera, aggregate.conservativePeakRgbaBytes, referenceMediaCamera2DLimits.maximumSceneKnownRgbaBytes, "conservative peak RGBA bytes");
      limit(camera, aggregate.concurrentVideoDecoders, referenceMediaCamera2DLimits.maximumConcurrentVideoDecoders, "concurrent video decoders");
      continue;
    }
    visibleCameraCount += 1;
    const sourceIdentity = `${plan.source.resourceId}\0${plan.source.sha256}\0${plan.source.selectedVariant}`;
    if (!uniqueSources.has(sourceIdentity)) {
      uniqueSources.add(sourceIdentity);
      aggregate.uniqueSourceFileBytes = checkedAggregateAdd(camera, aggregate.uniqueSourceFileBytes, plan.source.resourceBytes, "unique source bytes");
    }
    aggregate.nativePixels = checkedAggregateAdd(camera, aggregate.nativePixels, plan.native.pixels, "native pixels");
    aggregate.nativeRgbaBytes = checkedAggregateAdd(camera, aggregate.nativeRgbaBytes, checkedProduct(camera, [plan.native.pixels, 4], "native RGBA bytes"), "native RGBA bytes");
    aggregate.decodedCropPixels = checkedAggregateAdd(camera, aggregate.decodedCropPixels, plan.decodedCrop.pixels, "decoded crop pixels");
    aggregate.decodedCropRgbaBytes = checkedAggregateAdd(camera, aggregate.decodedCropRgbaBytes, plan.decodedCrop.pixels * 4, "decoded crop RGBA bytes");
    aggregate.clampPaddedPixels = checkedAggregateAdd(camera, aggregate.clampPaddedPixels, framePlan.work.clampPaddedPixels, "clamp-padded pixels");
    aggregate.clampPaddedRgbaBytes = checkedAggregateAdd(camera, aggregate.clampPaddedRgbaBytes, framePlan.work.clampPaddedRgbaBytes, "clamp-padded RGBA bytes");
    const decode = framePlan.videoDecode?.planned ?? Object.freeze({
      sourceOpens: 1, readerPullAttempts: 1, decodedFramesRead: 1, decodedSurfaces: 1,
      decodedRgbaBytes: plan.decodedCrop.pixels * 4,
      managedColorConversionPasses: 0, managedColorConversionSurfaces: 0, managedColorConversionRgbaBytes: 0,
    });
    const decoderMaximum = framePlan.videoDecode?.maximum ?? Object.freeze({
      decoderPeakResidentSurfaces: 1,
      decoderPeakResidentRgbaBytes: plan.decodedCrop.pixels * 4,
    });
    aggregate.plannedSourceOpens = checkedAggregateAdd(camera, aggregate.plannedSourceOpens, decode.sourceOpens, "planned source opens");
    aggregate.plannedReaderPullAttempts = checkedAggregateAdd(camera, aggregate.plannedReaderPullAttempts, decode.readerPullAttempts, "planned reader pull attempts");
    aggregate.plannedDecodedFramesRead = checkedAggregateAdd(camera, aggregate.plannedDecodedFramesRead, decode.decodedFramesRead, "planned decoded frames read");
    aggregate.plannedDecodedSurfaces = checkedAggregateAdd(camera, aggregate.plannedDecodedSurfaces, decode.decodedSurfaces, "planned decoded surfaces");
    aggregate.plannedDecodedRgbaBytes = checkedAggregateAdd(camera, aggregate.plannedDecodedRgbaBytes, decode.decodedRgbaBytes, "planned decoded RGBA bytes");
    aggregate.plannedManagedColorConversionPasses = checkedAggregateAdd(camera, aggregate.plannedManagedColorConversionPasses, decode.managedColorConversionPasses, "planned managed-color conversion passes");
    aggregate.plannedManagedColorConversionSurfaces = checkedAggregateAdd(camera, aggregate.plannedManagedColorConversionSurfaces, decode.managedColorConversionSurfaces, "planned managed-color conversion surfaces");
    aggregate.plannedManagedColorConversionRgbaBytes = checkedAggregateAdd(camera, aggregate.plannedManagedColorConversionRgbaBytes, decode.managedColorConversionRgbaBytes, "planned managed-color conversion RGBA bytes");
    aggregate.maximumDecodePixelWork = checkedAggregateAdd(camera, aggregate.maximumDecodePixelWork, framePlan.work.maximumDecodePixelWork, "decode pixel work");
    aggregate.maximumManagedColorConversionPixelWork = checkedAggregateAdd(camera, aggregate.maximumManagedColorConversionPixelWork, framePlan.work.maximumManagedColorConversionPixelWork, "managed-color conversion pixel work");
    if (!framePlan.videoDecode) {
      aggregate.maximumDecoderPeakResidentSurfaces = checkedAggregateAdd(camera, aggregate.maximumDecoderPeakResidentSurfaces, decoderMaximum.decoderPeakResidentSurfaces, "decoder peak resident surfaces");
      aggregate.maximumDecoderPeakResidentRgbaBytes = checkedAggregateAdd(camera, aggregate.maximumDecoderPeakResidentRgbaBytes, decoderMaximum.decoderPeakResidentRgbaBytes, "decoder peak resident RGBA bytes");
    }
    aggregate.colorGradePixelPasses = checkedAggregateAdd(camera, aggregate.colorGradePixelPasses, framePlan.work.colorGradePixelPasses, "ColorGrade pixel passes");
    aggregate.maximumColorGradePixelWork = checkedAggregateAdd(camera, aggregate.maximumColorGradePixelWork, framePlan.work.maximumColorGradePixelWork, "ColorGrade pixel work");
    aggregate.maximumColorGradeRgbaBytes = checkedAggregateAdd(camera, aggregate.maximumColorGradeRgbaBytes, framePlan.work.maximumColorGradePixelWork * 4, "ColorGrade RGBA bytes");
    aggregate.maximumBilinearSampleVisits = checkedAggregateAdd(camera, aggregate.maximumBilinearSampleVisits, framePlan.work.maximumBilinearSampleVisits, "bilinear sample visits");
    aggregate.maximumPixelWork = checkedAggregateAdd(camera, aggregate.maximumPixelWork, framePlan.work.maximumPixelWork, "pixel work");
    aggregate.conservativePeakRgbaBytes = checkedAggregateAdd(
      camera,
      aggregate.conservativePeakRgbaBytes,
      plan.native.pixels * 4 + (framePlan.videoDecode ? 0 : decoderMaximum.decoderPeakResidentRgbaBytes)
        + framePlan.work.maximumColorGradePixelWork * 4 + framePlan.work.clampPaddedRgbaBytes,
      "conservative peak RGBA bytes",
    );

    limit(camera, aggregate.uniqueSourceFileBytes, referenceMediaCamera2DLimits.maximumSceneUniqueSourceBytes, "unique source bytes");
    limit(camera, aggregate.nativePixels, referenceMediaCamera2DLimits.maximumSceneNativePixels, "native pixels");
    limit(camera, aggregate.decodedCropPixels, referenceMediaCamera2DLimits.maximumSceneDecodedCropPixels, "decoded crop pixels");
    limit(camera, aggregate.clampPaddedPixels, referenceMediaCamera2DLimits.maximumSceneClampPaddedPixels, "clamp-padded pixels");
    limit(camera, aggregate.plannedDecodedSurfaces, referenceMediaCamera2DLimits.maximumSceneDecodedFrameSurfaces, "planned decoded surfaces");
    limit(camera, aggregate.plannedDecodedRgbaBytes, referenceMediaCamera2DLimits.maximumSceneDecodedFrameRgbaBytes, "planned decoded RGBA bytes");
    limit(camera, aggregate.plannedManagedColorConversionPasses, referenceMediaCamera2DLimits.maximumSceneManagedColorConversionPasses, "planned managed-color conversion passes");
    limit(camera, aggregate.plannedManagedColorConversionRgbaBytes, referenceMediaCamera2DLimits.maximumSceneManagedColorConversionRgbaBytes, "planned managed-color conversion RGBA bytes");
    limit(camera, aggregate.maximumColorGradePixelWork, referenceMediaCamera2DLimits.maximumSceneColorGradePixelWork, "ColorGrade pixel work");
    limit(camera, aggregate.maximumBilinearSampleVisits, referenceMediaCamera2DLimits.maximumSceneBilinearSampleVisits, "bilinear sample visits");
    limit(camera, aggregate.maximumPixelWork, referenceMediaCamera2DLimits.maximumSceneFramePixelWork, "pixel work");
    limit(camera, aggregate.conservativePeakRgbaBytes, referenceMediaCamera2DLimits.maximumSceneKnownRgbaBytes, "conservative peak RGBA bytes");
    limit(camera, aggregate.concurrentVideoDecoders, referenceMediaCamera2DLimits.maximumConcurrentVideoDecoders, "concurrent video decoders");
  }
  const receipt = Object.freeze({
    format: "cut-reference-media-camera2d-scene-admission" as const,
    version: 1 as const,
    algorithmVersion: referenceMediaCamera2DAlgorithmVersion,
    compositionId: composition.id,
    sceneId,
    exactTime: Object.freeze({ ...exactTime }),
    cameraCount: ordered.length,
    visibleCameraCount,
    opacityZeroCameraCount,
    members: Object.freeze(ordered.map(({ plan, framePlan }) => Object.freeze({
      cameraNodeId: plan.cameraNodeId,
      planIdentity: plan.semanticIdentity,
      framePlanIdentity: framePlan.planIdentity,
    }))),
    aggregate: Object.freeze({
      ...aggregate,
      ...(hasNativeEffectChain ? {
        nativeEffectOperations,
        maximumNativeEffectPixelWork,
        maximumNativeEffectOutputRgbaBytes,
      } : {}),
    }),
  });
  const admission = Object.freeze({ ...receipt, admissionIdentity: hash(receipt) });
  mediaCamera2DSceneAdmissionAuthorities.set(admission, new Set(admission.members.map((member) => member.cameraNodeId)));
  return admission;
}

/** Revoke any still-unused completion authority when a renderer frame ends or
 * aborts. Persisted receipts remain inspectable but can never be replayed. */
export function closeReferenceMediaCamera2DSceneAdmission(admission: ReferenceMediaCamera2DSceneAdmission | undefined) {
  if (admission) mediaCamera2DSceneAdmissionAuthorities.delete(admission);
}

function assertMediaCamera2DSceneAdmissionAuthority(
  node: IRNode,
  plan: ReferenceMediaCamera2DPlan,
  framePlan: ReferenceMediaCamera2DFramePlan,
  admission: ReferenceMediaCamera2DSceneAdmission,
) {
  const member = admission.members.find((item) => item.cameraNodeId === plan.cameraNodeId);
  const unusedMembers = mediaCamera2DSceneAdmissionAuthorities.get(admission);
  if (!unusedMembers?.has(plan.cameraNodeId)
    || admission.compositionId !== plan.compositionId
    || admission.sceneId !== plan.sceneId
    || compareRational(admission.exactTime, framePlan.exactTime) !== 0
    || member?.planIdentity !== plan.semanticIdentity
    || member?.framePlanIdentity !== framePlan.planIdentity) {
    fail(node, "CUT_MEDIA_CAMERA_RASTER", "camera completion requires membership in the exact same-invocation aggregate scene admission receipt.");
  }
  unusedMembers.delete(plan.cameraNodeId);
  if (unusedMembers.size === 0) mediaCamera2DSceneAdmissionAuthorities.delete(admission);
}

function padClampSurface(
  source: ReferenceRetainedMediaViewportSurface,
  padding: Readonly<{ left: number; top: number; right: number; bottom: number }>,
) {
  if (padding.left === 0 && padding.top === 0 && padding.right === 0 && padding.bottom === 0) {
    return Object.freeze({ surface: source, allocated: false as const });
  }
  if (source.data.byteLength !== source.width * source.height * 4) throw new Error("CUT_MEDIA_CAMERA_RASTER: source RGBA byte length does not match its dimensions.");
  const width = source.width + padding.left + padding.right, height = source.height + padding.top + padding.bottom;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.max(0, Math.min(source.height - 1, y - padding.top));
    const sourceRow = sourceY * source.width * 4, outputRow = y * width * 4;
    const first = source.data.subarray(sourceRow, sourceRow + 4), last = source.data.subarray(sourceRow + (source.width - 1) * 4, sourceRow + source.width * 4);
    for (let x = 0; x < padding.left; x += 1) data.set(first, outputRow + x * 4);
    data.set(source.data.subarray(sourceRow, sourceRow + source.width * 4), outputRow + padding.left * 4);
    for (let x = 0; x < padding.right; x += 1) data.set(last, outputRow + (padding.left + source.width + x) * 4);
  }
  return Object.freeze({ surface: Object.freeze({ data, width, height }), allocated: true as const });
}

function completedEvidence(input: Omit<ReferenceMediaCamera2DExecutionEvidence, "executionIdentity">) {
  return Object.freeze({ ...input, executionIdentity: hash(input) });
}

function skippedNativeEffectEvidence(
  framePlan: ReferenceMediaCamera2DFramePlan,
): ReferenceMediaCamera2DNativeEffectEvidence | undefined {
  const chain = framePlan.nativeEffectChain;
  if (!chain) return undefined;
  const receipt = Object.freeze({
    algorithmVersion: referenceMediaCamera2DNativeEffectChainAlgorithmVersion,
    basis: chain.basis,
    order: chain.order,
    status: "skipped-opacity-zero" as const,
    planIdentity: chain.planIdentity,
    operations: Object.freeze(chain.operations.map((operation) => Object.freeze({
      executionOrder: operation.executionOrder,
      nodeId: operation.nodeId,
      op: operation.op,
      configIdentity: operation.configIdentity,
      outputRgbaBytes: 0,
    }))),
  });
  return Object.freeze({ ...receipt, executionIdentity: hash(receipt) });
}

function executedNativeEffectEvidence(
  diagnosticNode: IRNode,
  plan: ReferenceMediaCamera2DPlan,
  framePlan: ReferenceMediaCamera2DFramePlan,
  source: ReferenceRetainedMediaViewportSurface,
  runtime: ReferenceMediaCamera2DNativeEffectRuntime | undefined,
): ReferenceMediaCamera2DNativeEffectEvidence | undefined {
  const chain = framePlan.nativeEffectChain;
  if (!chain) {
    if (runtime) {
      fail(diagnosticNode, "CUT_MEDIA_CAMERA_RASTER", "observed native-crop effect execution without an admitted effect-chain plan.");
    }
    return undefined;
  }
  if (chain.status !== "execute" || !runtime || runtime.operations.length !== chain.operations.length) {
    fail(diagnosticNode, "CUT_MEDIA_CAMERA_RASTER", "native-crop effect execution did not match the exact admitted visible chain.");
  }
  const expectedBytes = checkedProduct(
    diagnosticNode,
    [plan.decodedCrop.pixels, 4],
    "native-crop effect output RGBA bytes",
  );
  const operations = Object.freeze(chain.operations.map((operation, index) => {
    const observed = runtime.operations[index];
    if (!observed
      || observed.executionOrder !== operation.executionOrder
      || observed.nodeId !== operation.nodeId
      || observed.op !== operation.op
      || observed.configIdentity !== operation.configIdentity
      || observed.outputRgbaBytes !== expectedBytes
      || !/^[0-9a-f]{64}$/u.test(observed.outputRgbaSha256)) {
      fail(diagnosticNode, "CUT_MEDIA_CAMERA_RASTER", `native-crop effect operation ${index} diverged from its exact-frame plan or fixed-size RGBA boundary.`);
    }
    return Object.freeze({ ...observed });
  }));
  const finalRgbaSha256 = createHash("sha256").update(source.data).digest("hex");
  if (runtime.finalRgbaSha256 !== finalRgbaSha256
    || operations.at(-1)?.outputRgbaSha256 !== finalRgbaSha256) {
    fail(diagnosticNode, "CUT_MEDIA_CAMERA_RASTER", "native-crop effect runtime final hash does not identify the exact source surface passed to the one affine sampler.");
  }
  const receipt = Object.freeze({
    algorithmVersion: referenceMediaCamera2DNativeEffectChainAlgorithmVersion,
    basis: chain.basis,
    order: chain.order,
    status: "executed" as const,
    planIdentity: chain.planIdentity,
    operations,
    finalRgbaSha256,
  });
  return Object.freeze({ ...receipt, executionIdentity: hash(receipt) });
}

export function referenceMediaCamera2DOpacityZeroFrame(
  plan: ReferenceMediaCamera2DPlan,
  framePlan: ReferenceMediaCamera2DFramePlan,
  outputFrame: string,
  sceneAdmission: ReferenceMediaCamera2DSceneAdmission,
) {
  const camera = { id: plan.cameraNodeId, provenance: { module: "<runtime>", span: { start: { line: 1, column: 1 } } } } as IRNode;
  assertMediaCamera2DSceneAdmissionAuthority(camera, plan, framePlan, sceneAdmission);
  if (framePlan.status !== "opacity-zero" || framePlan.work.geometricResampleCount !== 0) {
    const node = { id: plan.cameraNodeId } as IRNode;
    throw new Error(`CUT_MEDIA_CAMERA_RASTER: MediaCamera2D ${node.id} opacity-zero completion received a visible plan.`);
  }
  const output = new Uint8Array(plan.output.rgbaBytes);
  const nativeEffectChain = skippedNativeEffectEvidence(framePlan);
  const evidence = completedEvidence({
    format: "cut-reference-media-camera2d-frame-evidence",
    version: 1,
    evidenceKind: "completed-media-camera2d-frame",
    algorithmVersion: referenceMediaCamera2DAlgorithmVersion,
    backendIdentity: referenceMediaCamera2DBackendIdentity,
    status: "opacity-zero",
    compositionId: plan.compositionId,
    sceneId: plan.sceneId,
    cameraNodeId: plan.cameraNodeId,
    ...(plan.gradeNodeId ? { gradeNodeId: plan.gradeNodeId } : {}),
    leafNodeId: plan.leafNodeId,
    leafKind: plan.leafKind,
    exactTime: framePlan.exactTime,
    outputFrame,
    source: plan.source,
    outputContext: plan.outputContext,
    observability: plan.observability,
    sceneAdmission,
    controls: framePlan.controls,
    geometry: framePlan.geometry,
    ...(framePlan.videoDecode ? { videoDecode: framePlan.videoDecode } : {}),
    ...(nativeEffectChain ? { nativeEffectChain } : {}),
    allocations: Object.freeze({
      sourceOpens: 0, readerPullAttempts: 0, decodedFramesRead: 0, decodedSurfaces: 0, decodedRgbaBytes: 0,
      managedColorConversionSurfaces: 0, managedColorConversionRgbaBytes: 0,
      decoderRetainedFrameCopies: 0, decoderRetainedFrameCopyRgbaBytes: 0,
      linearBalanceSurfaces: 0, linearBalanceRgbaBytes: 0,
      backendGradeSurfaces: 0, backendGradeRgbaBytes: 0,
      colorGradeSurfaces: 0, colorGradeRgbaBytes: 0,
      ...(nativeEffectChain ? { nativeEffectSurfaces: 0, nativeEffectRgbaBytes: 0 } : {}),
      clampPaddingSurfaces: 0, clampPaddingRgbaBytes: 0,
      compositionPrerasterCount: 0, compositionPrerasterRgbaBytes: 0,
      geometricResampleCount: 0, outputSurfaces: 1, outputRgbaBytes: output.byteLength,
      outputHandoffCopies: 0, outputHandoffRgbaBytes: 0,
    }),
    work: framePlan.work,
    framePlanIdentity: framePlan.planIdentity,
    outputRgbaSha256: createHash("sha256").update(output).digest("hex"),
  });
  return Object.freeze({ surface: Object.freeze({ data: output, width: plan.output.width, height: plan.output.height }), evidence });
}

/** Execute one already-preflighted frame through CUT's existing Q16
 * associated-alpha affine sampler. No resize or delivery-sized media surface
 * exists before this single call. */
export function executeReferenceMediaCamera2DFrame(input: Readonly<{
  source: ReferenceRetainedMediaViewportSurface;
  plan: ReferenceMediaCamera2DPlan;
  framePlan: ReferenceMediaCamera2DFramePlan;
  diagnosticNode: IRNode;
  outputFrame: string;
  sceneAdmission: ReferenceMediaCamera2DSceneAdmission;
  decoded: ReferenceMediaCamera2DDecodedRuntime;
  q16TapDiagnostic?: ReferenceRetainedMediaViewportQ16TapDiagnostic;
  staticGradeLeaseExecutionAuthority?: ReferenceMediaCamera2DStaticGradeLeaseExecutionAuthority;
}>) {
  const { plan, framePlan, diagnosticNode } = input;
  assertMediaCamera2DSceneAdmissionAuthority(diagnosticNode, plan, framePlan, input.sceneAdmission);
  if (framePlan.status !== "visible" || !framePlan.rasterPlan || !framePlan.rasterState || framePlan.work.geometricResampleCount !== 1) {
    fail(diagnosticNode, "CUT_MEDIA_CAMERA_RASTER", "visible execution requires one preflighted raster plan and exactly one geometric resample.");
  }
  if (input.source.width !== plan.decodedCrop.width || input.source.height !== plan.decodedCrop.height
    || input.source.data.byteLength !== plan.decodedCrop.pixels * 4) {
    fail(diagnosticNode, "CUT_MEDIA_CAMERA_RASTER", `decoded/graded source must match the admitted ${plan.decodedCrop.width}x${plan.decodedCrop.height} native crop.`);
  }
  const colorGradeSurfaces = (
    input.decoded.linearBalanceSurfaces + input.decoded.backendGradeSurfaces
  ) as 0 | 1 | 2;
  const staticGradeCache = input.decoded.staticGradeCache;
  const staticGradeCacheHit = staticGradeCache?.status === "hit";
  const trustedStaticGradeLease = consumeReferenceMediaCamera2DStaticGradeLeaseExecutionAuthority(
    input.staticGradeLeaseExecutionAuthority,
    input.source,
    staticGradeCache,
  );
  if (staticGradeCache) {
    const statuses = new Set(["hit", "miss", "bypass-capacity", "bypass-dynamic"]);
    if (staticGradeCache.algorithmVersion !== referenceMediaCamera2DStaticGradeCacheAlgorithmVersion
      || plan.leafKind !== "image"
      || !plan.gradeNodeId
      || !framePlan.gradeExecutionIdentity
      || framePlan.nativeEffectChain !== undefined
      || !statuses.has(staticGradeCache.status)
      || !/^[0-9a-f]{64}$/u.test(staticGradeCache.cacheIdentity)
      || !/^[0-9a-f]{64}$/u.test(staticGradeCache.sourceRgbaSha256)
      || !/^[0-9a-f]{64}$/u.test(staticGradeCache.outputRgbaSha256)
      || !Number.isSafeInteger(staticGradeCache.residentBytes)
      || staticGradeCache.residentBytes < 0
      || staticGradeCache.residentBytes > referenceMediaCamera2DStaticGradeCacheLimits.maximumBytes
      || !Number.isSafeInteger(staticGradeCache.entries)
      || staticGradeCache.entries < 0
      || staticGradeCache.entries > referenceMediaCamera2DStaticGradeCacheLimits.maximumEntries
      || (staticGradeCache.residentCopies !== 0 && staticGradeCache.residentCopies !== 1)
      || !Number.isSafeInteger(staticGradeCache.residentCopyRgbaBytes)
      || staticGradeCache.residentCopyRgbaBytes < 0
      || staticGradeCache.residentCopyRgbaBytes > plan.decodedCrop.pixels * 4
      || (staticGradeCache.handoffCopies !== 0 && staticGradeCache.handoffCopies !== 1)
      || !Number.isSafeInteger(staticGradeCache.handoffRgbaBytes)
      || staticGradeCache.handoffRgbaBytes < 0
      || staticGradeCache.handoffRgbaBytes > plan.decodedCrop.pixels * 4
      || (staticGradeCache.leaseHandoffs !== 0 && staticGradeCache.leaseHandoffs !== 1)
      || !Number.isSafeInteger(staticGradeCache.leaseRgbaBytes)
      || staticGradeCache.leaseRgbaBytes < 0
      || staticGradeCache.leaseRgbaBytes > plan.decodedCrop.pixels * 4
      || !input.decoded.staticGradeSourceRgbaSha256
      || staticGradeCache.sourceRgbaSha256 !== input.decoded.staticGradeSourceRgbaSha256) {
      fail(diagnosticNode, "CUT_MEDIA_CAMERA_RASTER", "static Image ColorGrade cache evidence is malformed or attached outside its closed authority.");
    }
    if (staticGradeCache.leaseHandoffs === 1 && !trustedStaticGradeLease) {
      fail(diagnosticNode, "CUT_MEDIA_CAMERA_RASTER", "static Image ColorGrade lease evidence lacks its one-shot live cache execution authority.");
    }
    if (staticGradeCache.leaseHandoffs === 0 && trustedStaticGradeLease) {
      fail(diagnosticNode, "CUT_MEDIA_CAMERA_RASTER", "static Image ColorGrade execution authority was attached to a copied/materialized surface.");
    }
    if (!trustedStaticGradeLease
      && staticGradeCache.outputRgbaSha256 !== createHash("sha256").update(input.source.data).digest("hex")) {
      fail(diagnosticNode, "CUT_MEDIA_CAMERA_RASTER", "static Image ColorGrade cache output hash does not bind the exact graded source passed to the sampler.");
    }
    if (staticGradeCache.cacheIdentity !== referenceMediaCamera2DStaticGradeCacheIdentity({
      sourceSemanticIdentity: plan.decodePlan.semanticIdentity,
      sourceRgbaSha256: staticGradeCache.sourceRgbaSha256,
      width: plan.decodedCrop.width,
      height: plan.decodedCrop.height,
      gradeNodeId: plan.gradeNodeId,
      gradeExecutionIdentity: framePlan.gradeExecutionIdentity,
      backendIdentity: referenceMediaCamera2DStaticGradeBackendIdentity,
    })) {
      fail(diagnosticNode, "CUT_MEDIA_CAMERA_RASTER", "static Image ColorGrade cache identity does not bind the admitted source/config/backend authority.");
    }
    if (staticGradeCacheHit) {
      if (colorGradeSurfaces !== 0 || staticGradeCache.entries < 1
        || staticGradeCache.residentBytes < plan.decodedCrop.pixels * 4
        || staticGradeCache.residentCopies !== 0
        || staticGradeCache.residentCopyRgbaBytes !== 0
        || ((staticGradeCache.handoffCopies === 1
          && staticGradeCache.handoffRgbaBytes === plan.decodedCrop.pixels * 4
          && staticGradeCache.leaseHandoffs === 0
          && staticGradeCache.leaseRgbaBytes === 0)
          ? false
          : !(staticGradeCache.handoffCopies === 0
            && staticGradeCache.handoffRgbaBytes === 0
            && staticGradeCache.leaseHandoffs === 1
            && staticGradeCache.leaseRgbaBytes === plan.decodedCrop.pixels * 4))) {
        fail(diagnosticNode, "CUT_MEDIA_CAMERA_RASTER", "static Image ColorGrade cache hit claimed new grade allocations or no exact copied/leased resident handoff.");
      }
    } else if (staticGradeCache.status === "miss"
      && (staticGradeCache.entries < 1 || staticGradeCache.residentBytes < plan.decodedCrop.pixels * 4
        || staticGradeCache.residentCopies !== 1
        || staticGradeCache.residentCopyRgbaBytes !== plan.decodedCrop.pixels * 4
        || staticGradeCache.handoffCopies !== 0 || staticGradeCache.handoffRgbaBytes !== 0
        || staticGradeCache.leaseHandoffs !== 0 || staticGradeCache.leaseRgbaBytes !== 0)) {
      fail(diagnosticNode, "CUT_MEDIA_CAMERA_RASTER", "static Image ColorGrade cache miss did not publish its exact resident surface.");
    } else if ((staticGradeCache.status === "bypass-capacity" || staticGradeCache.status === "bypass-dynamic")
      && (staticGradeCache.residentCopies !== 0 || staticGradeCache.residentCopyRgbaBytes !== 0
        || staticGradeCache.handoffCopies !== 0 || staticGradeCache.handoffRgbaBytes !== 0
        || staticGradeCache.leaseHandoffs !== 0 || staticGradeCache.leaseRgbaBytes !== 0)) {
      fail(diagnosticNode, "CUT_MEDIA_CAMERA_RASTER", "static Image ColorGrade cache bypass claimed a cache handoff allocation.");
    } else if (colorGradeSurfaces !== framePlan.work.colorGradePixelPasses) {
      fail(diagnosticNode, "CUT_MEDIA_CAMERA_RASTER", "static Image ColorGrade cache miss/bypass did not execute the exact preflighted grade stages.");
    }
  }
  if ((input.decoded.linearBalanceSurfaces !== 0 && input.decoded.linearBalanceSurfaces !== 1)
    || (input.decoded.backendGradeSurfaces !== 0 && input.decoded.backendGradeSurfaces !== 1)
    || (!staticGradeCache && colorGradeSurfaces !== framePlan.work.colorGradePixelPasses)) {
    fail(diagnosticNode, "CUT_MEDIA_CAMERA_RASTER", "observed ColorGrade stage allocations diverged from exact-frame preflight.");
  }
  const plannedVideo = framePlan.videoDecode?.planned;
  if (plan.leafKind === "video") {
    if (!plannedVideo
      || input.decoded.sourceOpens !== plannedVideo.sourceOpens
      || input.decoded.readerPullAttempts !== plannedVideo.readerPullAttempts
      || input.decoded.decodedFramesRead !== plannedVideo.decodedFramesRead
      || input.decoded.decodedSurfaces !== plannedVideo.decodedSurfaces
      || input.decoded.managedColorConversionSurfaces !== plannedVideo.managedColorConversionSurfaces) {
      fail(diagnosticNode, "CUT_MEDIA_CAMERA_RASTER", "observed Video decoder/color allocations diverged from exact-frame preflight.");
    }
  } else if (framePlan.videoDecode || input.decoded.readerPullAttempts !== input.decoded.decodedFramesRead
    || input.decoded.managedColorConversionSurfaces !== 0) {
    fail(diagnosticNode, "CUT_MEDIA_CAMERA_RASTER", "Image execution cannot claim a Video decoder or managed-color conversion plan.");
  }
  const nativeEffectChain = executedNativeEffectEvidence(
    diagnosticNode,
    plan,
    framePlan,
    input.source,
    input.decoded.nativeEffect,
  );
  const nativeEffectOperations = framePlan.nativeEffectChain?.operations
    .filter((operation) => operation.op !== "cut.visual.color_grade") ?? [];
  const padded = padClampSurface(input.source, framePlan.geometry.clampPadding);
  if (padded.surface.width !== framePlan.geometry.rasterSource.width || padded.surface.height !== framePlan.geometry.rasterSource.height
    || padded.surface.data.byteLength !== framePlan.geometry.rasterSource.rgbaBytes) {
    fail(diagnosticNode, "CUT_MEDIA_CAMERA_RASTER", "clamp padding allocation diverged from frame preflight.");
  }
  const sampled = executeReferenceRetainedMediaViewportFrame({
    source: padded.surface,
    plan: framePlan.rasterPlan,
    state: framePlan.rasterState,
    diagnosticNode,
    ...(input.q16TapDiagnostic
      ? { diagnostic: input.q16TapDiagnostic }
      : {}),
    runtime: Object.freeze({
      compositionId: plan.compositionId,
      exactTime: framePlan.exactTime,
      outputFrame: input.outputFrame,
      // The outer camera receipt owns decode/grade accounting. This inner
      // existing-kernel receipt proves only the one direct affine sample.
      sourceOpens: 0,
      decodedFramesRead: 0,
      decodedSurfaces: 0,
      colorGradeSurfaces: 0,
      fittedSurfaces: 0,
    }),
  });
  if (sampled.receipt.work.fitResampleInvocations !== 0 || sampled.receipt.work.affineResampleInvocations !== 1
    || sampled.receipt.work.totalResampleInvocations !== 1
    || sampled.receipt.allocations.compositionPrerasterSurfaces !== 0) {
    fail(diagnosticNode, "CUT_MEDIA_CAMERA_RASTER", "shared Q16 sampler did not preserve the one-resample/no-preraster invariant.");
  }
  const output = sampled.surface;
  const evidence = completedEvidence({
    format: "cut-reference-media-camera2d-frame-evidence",
    version: 1,
    evidenceKind: "completed-media-camera2d-frame",
    algorithmVersion: referenceMediaCamera2DAlgorithmVersion,
    backendIdentity: referenceMediaCamera2DBackendIdentity,
    status: "rendered",
    compositionId: plan.compositionId,
    sceneId: plan.sceneId,
    cameraNodeId: plan.cameraNodeId,
    ...(plan.gradeNodeId ? { gradeNodeId: plan.gradeNodeId } : {}),
    leafNodeId: plan.leafNodeId,
    leafKind: plan.leafKind,
    exactTime: framePlan.exactTime,
    outputFrame: input.outputFrame,
    source: plan.source,
    outputContext: plan.outputContext,
    observability: plan.observability,
    sceneAdmission: input.sceneAdmission,
    controls: framePlan.controls,
    geometry: framePlan.geometry,
    ...(framePlan.videoDecode ? { videoDecode: framePlan.videoDecode } : {}),
    ...(nativeEffectChain ? { nativeEffectChain } : {}),
    ...(staticGradeCache ? { staticGradeCache } : {}),
    allocations: Object.freeze({
      sourceOpens: input.decoded.sourceOpens,
      readerPullAttempts: input.decoded.readerPullAttempts,
      decodedFramesRead: input.decoded.decodedFramesRead,
      decodedSurfaces: input.decoded.decodedSurfaces,
      decodedRgbaBytes: input.decoded.decodedSurfaces * plan.decodedCrop.pixels * 4,
      managedColorConversionSurfaces: input.decoded.managedColorConversionSurfaces,
      managedColorConversionRgbaBytes: input.decoded.managedColorConversionSurfaces * plan.decodedCrop.pixels * 4,
      decoderRetainedFrameCopies: 0 as const,
      decoderRetainedFrameCopyRgbaBytes: 0 as const,
      linearBalanceSurfaces: input.decoded.linearBalanceSurfaces,
      linearBalanceRgbaBytes: input.decoded.linearBalanceSurfaces * plan.decodedCrop.pixels * 4,
      backendGradeSurfaces: input.decoded.backendGradeSurfaces,
      backendGradeRgbaBytes: input.decoded.backendGradeSurfaces * plan.decodedCrop.pixels * 4,
      colorGradeSurfaces,
      colorGradeRgbaBytes: colorGradeSurfaces * plan.decodedCrop.pixels * 4,
      ...(nativeEffectChain ? {
        nativeEffectSurfaces: nativeEffectOperations.length,
        nativeEffectRgbaBytes: nativeEffectOperations.length * plan.decodedCrop.pixels * 4,
      } : {}),
      clampPaddingSurfaces: padded.allocated ? 1 as const : 0 as const,
      clampPaddingRgbaBytes: padded.allocated ? padded.surface.data.byteLength : 0,
      compositionPrerasterCount: 0 as const,
      compositionPrerasterRgbaBytes: 0 as const,
      geometricResampleCount: 1 as const,
      outputSurfaces: 1 as const,
      outputRgbaBytes: output.data.byteLength,
      outputHandoffCopies: 0 as const,
      outputHandoffRgbaBytes: 0 as const,
    }),
    work: framePlan.work,
    ...(framePlan.gradeExecutionIdentity ? { gradeExecutionIdentity: framePlan.gradeExecutionIdentity } : {}),
    framePlanIdentity: framePlan.planIdentity,
    samplerExecutionIdentity: sampled.receipt.executionIdentity,
    outputRgbaSha256: createHash("sha256").update(output.data).digest("hex"),
  });
  return Object.freeze({ surface: output, evidence });
}
