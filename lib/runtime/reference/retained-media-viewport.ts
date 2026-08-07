import sharp from "sharp";
import { createHash } from "node:crypto";
import { hash } from "../../core/stable";
import type { CutAVIR, IRComposition, IRNode } from "../../language/ir";
import { addRational, compareRational, type Rational } from "../../language/rational";
import { referenceMediaProfileResourceState } from "./media-profile-state";
import { referenceRetainedVisualAffine } from "./retained-path-chain";
import {
  composeReferenceAffine2D,
  intersectReferenceRects,
  referenceIdentityAffine2D,
  referenceIntegerRasterBounds,
  referenceRect,
  transformReferenceRect,
  type ReferenceAffine2D,
  type ReferenceIntegerRasterBounds,
} from "./retained-visual";
import { referenceShapeNodeConfig, type ReferenceNormalizedCrop } from "./shape-config";
import { referenceVideoInputConfig, referenceVideoStaticInputConfig, type ReferenceVideoInputConfig } from "./video-config";
import type { ReferencePreparedSignalResolver } from "./signals";
import { referenceVisualTransformAt } from "./visual-config";
import { compositeRgba } from "./compositing";
import {
  executeReferenceNativeRetainedMediaViewportRaster,
  referenceNativeSourceOverIdentity,
} from "./native-source-over";
import { referenceRetainedMediaViewportLimits } from "./retained-media-viewport-limits";
import { publishReferenceRetainedSurfaceExactAlphaSupport } from "./retained-surface";

export { referenceRetainedMediaViewportLimits } from "./retained-media-viewport-limits";

export const referenceRetainedMediaViewportAlgorithmVersion = "cut-reference-retained-media-viewport-v2" as const;
export const referenceRetainedMediaCompositionAlgorithmVersion = "cut-reference-retained-media-local-composition-v2" as const;
export const referenceRetainedMediaLocalCompositorAlgorithmVersion = "cut-reference-retained-media-under-local-compositor-v2" as const;
export const referenceRetainedMediaViewportQ16TapKernelAlgorithmVersion =
  "cut-reference-retained-media-q16-native-raster-v2" as const;
export const referenceRetainedMediaViewportBackendIdentity = `cut-rgba-q16-bilinear-native-raster-v3;native-pixel-kernels@${referenceNativeSourceOverIdentity.algorithm};sharp@${sharp.versions.sharp ?? "missing"};libvips@${sharp.versions.vips ?? "missing"}`;

export type ReferenceRetainedMediaViewportErrorCode =
  | "CUT_RETAINED_MEDIA_VIEWPORT_GRAPH"
  | "CUT_RETAINED_MEDIA_VIEWPORT_RESOURCE"
  | "CUT_RETAINED_MEDIA_VIEWPORT_LIMIT"
  | "CUT_RETAINED_MEDIA_VIEWPORT_RASTER";

export class ReferenceRetainedMediaViewportError extends Error {
  readonly source: Readonly<{ module: string; line: number; column: number; nodeId: string }>;

  constructor(readonly code: ReferenceRetainedMediaViewportErrorCode, readonly node: IRNode, detail: string) {
    const { module, span } = node.provenance;
    super(`${code}: retained media viewport at ${module}:${span.start.line}:${span.start.column} ${detail}`);
    this.name = "ReferenceRetainedMediaViewportError";
    this.source = Object.freeze({ module, line: span.start.line, column: span.start.column, nodeId: node.id });
  }
}

export type ReferenceRetainedMediaViewportResample =
  | "sharp-bicubic-fit-then-cut-q16-associated-bilinear-affine"
  | "cut-q16-associated-bilinear-direct-affine";

export type ReferenceRetainedMediaViewportPlan = Readonly<{
  localSpaceNodeId: string;
  rootId: string;
  leafId: string;
  leafKind: "image" | "video";
  nodeIds: readonly string[];
  wrapperOps: readonly string[];
  colorGradeNodeId?: string;
  sourceId: string;
  sourceSha256: string;
  selectedVariant: "master" | "proxy" | "not-applicable";
  videoExecution?: Readonly<{
    streamIndex: number;
    config: ReferenceVideoInputConfig;
    configIdentity: string;
    cadenceIdentity?: string;
  }>;
  native: Readonly<{ width: number; height: number }>;
  crop?: ReferenceNormalizedCrop;
  cropped: Readonly<{ left: number; top: number; width: number; height: number }>;
  fit: "cover" | "contain" | "fill";
  fitted: Readonly<{ width: number; height: number }>;
  viewport: Readonly<{ width: number; height: number }>;
  resample: ReferenceRetainedMediaViewportResample;
  maximumPixelWorkPerFrame: number;
  semanticIdentity: string;
}>;

/** Asset-independent shape of the historical retained Image/Video island.
 * Keeping this separate from the locked execution plan lets `cut check`
 * validate the exact closed grammar before a project has a lockfile, without
 * weakening the resource/probe requirements of lock, inspect, or render. */
export type ReferenceRetainedMediaBranchTopology = Readonly<{
  rootId: string;
  leafId: string;
  leafKind: "image" | "video";
  nodeIds: readonly string[];
  wrapperOps: readonly string[];
  colorGradeNodeId?: string;
}>;

export type ReferenceRetainedMediaStaticLocalTopology = Readonly<{
  localSpaceNodeId: string;
  directLegacyRootIds: readonly string[];
  v2RootIds: readonly string[];
  materializationRootIds: readonly string[];
  materializationNodeIds: ReadonlySet<string>;
  operationNodeIds: ReadonlySet<string>;
  treeNodeCount: number;
  semanticIdentity: string;
}>;

export type ReferenceRetainedMediaCompositionChild = Readonly<{
  sourceOrder: number;
  childId: string;
  childContentHash: string;
  role: "retained-media" | "ordinary-local-raster";
  branchIdentity?: string;
}>;

export type ReferenceRetainedMediaCompositionPlan = Readonly<{
  algorithmVersion: typeof referenceRetainedMediaCompositionAlgorithmVersion;
  localSpaceNodeId: string;
  children: readonly ReferenceRetainedMediaCompositionChild[];
  branches: readonly ReferenceRetainedMediaViewportPlan[];
  totals: Readonly<{
    branches: number;
    nativePixels: number;
    croppedPixels: number;
    fittedPixels: number;
    viewportSurfaces: number;
    viewportPixels: number;
    viewportRgbaBytes: number;
    sourceOverPixelPasses: number;
    maximumPixelWorkPerFrame: number;
  }>;
  semanticIdentity: string;
}>;

export type ReferenceRetainedMediaLocalCompositorTreeNode = Readonly<{
  inspectPreorder: number;
  traversalPath: readonly number[];
  nodeId: string;
  op: string;
  childIds: readonly string[];
  role: "wrapper" | "materialization-island" | "ordinary-local-raster";
  semanticIdentity: string;
}>;

export type ReferenceRetainedMediaLocalCompositorIsland = Readonly<{
  inspectPreorder: number;
  traversalPath: readonly number[];
  rootId: string;
  plan: ReferenceRetainedMediaViewportPlan;
}>;

export type ReferenceRetainedMediaLocalCompositorDiscovery = Readonly<{
  algorithmVersion: typeof referenceRetainedMediaLocalCompositorAlgorithmVersion;
  localSpaceNodeId: string;
  dimensions: Readonly<{ width: number; height: number }>;
  directChildren: readonly Readonly<{
    sourceOrder: number;
    childId: string;
    childContentHash: string;
    role: "legacy-retained-media-island" | "retained-media-compositor-v2" | "ordinary-local-raster";
  }>[];
  roots: readonly Readonly<{ sourceOrder: number; rootId: string; traversalPath: readonly number[]; semanticIdentity: string }>[];
  islands: readonly ReferenceRetainedMediaLocalCompositorIsland[];
  tree: readonly ReferenceRetainedMediaLocalCompositorTreeNode[];
  materializationNodeIds: ReadonlySet<string>;
  operationNodeIds: ReadonlySet<string>;
  legacyCompositionPlanIdentity?: string;
  wrapperTreeIdentity: string;
  sourceOverSteps: number;
  conservativeTileSurfaces: number;
}>;

export type ReferenceRetainedMediaLocalCompositorOperationPlan = Readonly<{
  /** Position in the complete authored wrapper tree. */
  inspectPreorder: number;
  traversalPath: readonly number[];
  /** Unique contiguous execution position after all operation descendants. */
  executionPostorder: number;
  nodeId: string;
  op: string;
  semanticIdentity: string;
  estimatedPixelWorkPerFrame: number;
}>;

export type ReferenceRetainedMediaLocalCompositorPlan = Readonly<{
  algorithmVersion: typeof referenceRetainedMediaLocalCompositorAlgorithmVersion;
  localSpaceNodeId: string;
  dimensions: Readonly<{ width: number; height: number }>;
  directChildren: ReferenceRetainedMediaLocalCompositorDiscovery["directChildren"];
  roots: ReferenceRetainedMediaLocalCompositorDiscovery["roots"];
  islands: readonly ReferenceRetainedMediaLocalCompositorIsland[];
  tree: readonly ReferenceRetainedMediaLocalCompositorTreeNode[];
  wrapperTreeIdentity: string;
  inspectOrder: "authored-preorder";
  executionOrder: "child-first-postorder";
  /** Same immutable operation records ordered for author-facing inspection. */
  operationInspectionPlan: readonly ReferenceRetainedMediaLocalCompositorOperationPlan[];
  /** Normative runtime order; indices are contiguous from zero. */
  operationExecutionPlan: readonly ReferenceRetainedMediaLocalCompositorOperationPlan[];
  operationInspectionPlanIdentity: string;
  operationExecutionPlanIdentity: string;
  legacyCompositionPlanIdentity?: string;
  totals: Readonly<{
    mediaLeaves: number;
    nativePixels: number;
    croppedPixels: number;
    fittedPixels: number;
    mediaViewportPixels: number;
    mediaViewportRgbaBytes: number;
    operatorPixelWorkPerFrame: number;
    sourceOverSteps: number;
    sourceOverPixelPasses: number;
    conservativePeakTileSurfaces: number;
    conservativePeakRgbaBytes: number;
    maximumPixelWorkPerFrame: number;
  }>;
  semanticIdentity: string;
}>;

export type ReferenceRetainedMediaLocalCompositorOperationExecution = Readonly<{
  executionPostorder: number;
  nodeId: string;
  op: string;
  status: "rendered" | "skipped";
  skipReason?: ReferenceRetainedMediaLocalCompositorSkipReason;
  outputRgbaSha256?: string;
  outputRgbaBytes?: number;
}>;

export type ReferenceRetainedMediaLocalCompositorDirectChildExecution = Readonly<{
  sourceOrder: number;
  childId: string;
  childContentHash: string;
  role: ReferenceRetainedMediaLocalCompositorPlan["directChildren"][number]["role"];
  status: "rendered" | "skipped";
  skipReason?: ReferenceRetainedMediaLocalCompositorDirectChildSkipReason;
  rgbaSha256?: string;
}>;

export type ReferenceRetainedMediaLocalCompositorDirectChildSkipReason =
  | ReferenceRetainedMediaLocalCompositorSkipReason
  | "no-visible-local-surface"
  | "descendant-suppressed";

export type ReferenceRetainedMediaLocalCompositorSkipReason =
  | "inactive-node"
  | "ancestor-inactive"
  | "opacity-zero"
  | "ancestor-opacity-zero"
  | "outside-output-bounds";

export type ReferenceRetainedMediaLocalCompositorMaterializationExecution = Readonly<{
  rootId: string;
  status: "rendered" | "skipped";
  skipReason?: ReferenceRetainedMediaLocalCompositorSkipReason;
  receipt?: ReferenceRetainedMediaViewportExecutionEvidence;
}>;

export type ReferenceRetainedMediaLocalCompositorExecutionEvidence = Readonly<{
  format: "cut-reference-retained-media-local-compositor-frame-evidence";
  /** v2 closes operation-plan identity, direct-child paint evidence, and
   * conditional legacy-link authority. Persisted v1 receipts remain schema
   * readable but are not emitted by the current runtime. */
  version: 2;
  evidenceKind: "completed-retained-media-local-compositor";
  algorithmVersion: typeof referenceRetainedMediaLocalCompositorAlgorithmVersion;
  backendIdentity: string;
  compositionId: string;
  localSpaceNodeId: string;
  exactTime: Rational;
  outputFrame: string;
  planIdentity: string;
  wrapperTreeIdentity: string;
  operationExecutionPlanIdentity: string;
  order: Readonly<{ inspect: "authored-preorder"; execution: "child-first-postorder" }>;
  directChildren: ReferenceRetainedMediaLocalCompositorPlan["directChildren"];
  directChildExecutions: readonly ReferenceRetainedMediaLocalCompositorDirectChildExecution[];
  materializations: readonly Readonly<{
    inspectPreorder: number;
    traversalPath: readonly number[];
    rootId: string;
    leafId: string;
    planIdentity: string;
    status: "rendered" | "skipped";
    skipReason?: ReferenceRetainedMediaLocalCompositorSkipReason;
    executionIdentity?: string;
    outputRgbaSha256?: string;
  }>[];
  legacyCompositionLink?: Readonly<{
    planIdentity: string;
    executionIdentity: string;
    allocationIdentity: string;
    finalLocalTileRgbaSha256: string;
  }>;
  operations: readonly ReferenceRetainedMediaLocalCompositorOperationExecution[];
  allocations: Readonly<{
    sourceOpens: number;
    decodedFramesRead: number;
    decodedSurfaces: number;
    decodedRgbaBytes: number;
    colorGradeSurfaces: number;
    colorGradeRgbaBytes: number;
    fittedSurfaces: number;
    fittedRgbaBytes: number;
    mediaViewportSurfaces: number;
    mediaViewportRgbaBytes: number;
    operatorOutputSurfaces: number;
    operatorOutputRgbaBytes: number;
    directChildSourceOverSteps: number;
    executedSourceOverSteps: number;
    conservativePeakTileSurfaces: number;
    conservativePeakRgbaBytes: number;
    deliveryPrerasterSurfaces: 0;
    deliveryPrerasterRgbaBytes: 0;
  }>;
  plannedWork: ReferenceRetainedMediaLocalCompositorPlan["totals"];
  finalLocalTile: Readonly<{ width: number; height: number; rgbaSha256: string }>;
  executionIdentity: string;
}>;

export type ReferenceRetainedMediaViewportState = Readonly<{
  active: boolean;
  hidden: boolean;
  opacity: number;
  affine: ReferenceAffine2D;
  sourceToViewport: ReferenceAffine2D;
  sourceBounds: Readonly<{ minX: number; minY: number; maxX: number; maxY: number }>;
  outputBounds?: ReferenceIntegerRasterBounds;
  workIdentity: string;
}>;

export type ReferenceRetainedMediaViewportExecutionEvidence = Readonly<{
  format: "cut-reference-retained-media-viewport-frame-evidence";
  version: 1;
  evidenceKind: "completed-frame-execution";
  algorithmVersion: typeof referenceRetainedMediaViewportAlgorithmVersion;
  backendIdentity: string;
  compositionId: string;
  localSpaceNodeId: string;
  rootId: string;
  leafId: string;
  leafKind: "image" | "video";
  exactTime: Rational;
  outputFrame: string;
  source: Readonly<{
    resourceId: string;
    sha256: string;
    selectedVariant: "master" | "proxy" | "not-applicable";
    video?: Readonly<{
      streamIndex: number;
      inputColor: ReferenceVideoInputConfig["inputColor"];
      configIdentity: string;
      cadenceIdentity?: string;
    }>;
  }>;
  geometry: Readonly<{
    native: Readonly<{ width: number; height: number }>;
    decodedCrop: Readonly<{ left: number; top: number; width: number; height: number }>;
    fitted: Readonly<{ width: number; height: number }>;
    viewport: Readonly<{ width: number; height: number }>;
    outputBounds: ReferenceIntegerRasterBounds;
    sourceToViewportQ16: ReferenceAffine2D;
  }>;
  allocations: Readonly<{
    sourceOpens: number;
    decodedFramesRead: number;
    decodedSurfaces: number;
    decodedRgbaBytes: number;
    colorGradeSurfaces: number;
    colorGradeRgbaBytes: number;
    fittedSurfaces: number;
    fittedRgbaBytes: number;
    viewportSurfaces: 1;
    viewportRgbaBytes: number;
    compositionPrerasterSurfaces: 0;
    compositionPrerasterRgbaBytes: 0;
  }>;
  work: Readonly<{
    planIdentity: string;
    workIdentity: string;
    planMaximumPixelPasses: number;
    fitResampleInvocations: 0 | 1;
    affineResampleInvocations: 1;
    totalResampleInvocations: 1 | 2;
    affineDestinationPixels: number;
  }>;
  outputRgbaSha256: string;
  executionIdentity: string;
}>;

export type ReferenceRetainedMediaCompositionChildExecution = Readonly<{
  sourceOrder: number;
  childId: string;
  childContentHash: string;
  role: "retained-media" | "ordinary-local-raster";
  status: "rendered" | "skipped";
  rgbaSha256?: string;
  branchPlanIdentity?: string;
  branchExecutionIdentity?: string;
}>;

export type ReferenceRetainedMediaCompositionExecutionEvidence = Readonly<{
  format: "cut-reference-retained-media-composition-frame-evidence";
  version: 1;
  evidenceKind: "completed-source-ordered-local-composition";
  algorithmVersion: typeof referenceRetainedMediaCompositionAlgorithmVersion;
  backendIdentity: string;
  compositionId: string;
  localSpaceNodeId: string;
  exactTime: Rational;
  outputFrame: string;
  planIdentity: string;
  admission: Readonly<{
    executionDomain: string;
    retainedBranchesInExecutionDomain: number;
    maximumBranchesPerExecutionDomain: number;
  }>;
  paintOrder: readonly ReferenceRetainedMediaCompositionChildExecution[];
  allocations: Readonly<{
    renderedMediaViewportSurfaces: number;
    renderedOrdinaryLocalSurfaces: number;
    localSourceOverSteps: number;
    finalLocalTileSurfaces: 1;
    compositionPrerasterSurfaces: 0;
    compositionPrerasterRgbaBytes: 0;
  }>;
  plannedWork: ReferenceRetainedMediaCompositionPlan["totals"];
  finalLocalTile: Readonly<{ width: number; height: number; rgbaSha256: string }>;
  executionIdentity: string;
}>;

/** Live process authority is intentionally not serializable. A cloned receipt
 * with every public hash recomputed is still not a completed renderer
 * invocation and cannot be linked into a V2 compositor receipt. */
const authorizedRetainedMediaViewportReceipts = new WeakSet<object>();
const authorizedRetainedMediaCompositionReceipts = new WeakSet<object>();

export type ReferenceRetainedMediaViewportSurface = Readonly<{
  data: Uint8Array;
  width: number;
  height: number;
}>;

type ReferenceRetainedMediaViewportRasterAuthorityRecord = Readonly<{
  planIdentity: string;
  compositionId: string;
  exactTime: Rational;
  outputFrame: string;
  state: ReferenceRetainedMediaViewportState;
  sourceOpens: number;
  decodedFramesRead: number;
  decodedSurfaces: number;
  colorGradeSurfaces: number;
  fittedSurfaces: 0 | 1;
  outputRgbaSha256: string;
  outputWidth: number;
  outputHeight: number;
}>;

const retainedMediaViewportRasterAuthorities = new WeakMap<object, ReferenceRetainedMediaViewportRasterAuthorityRecord>();

export type ReferenceRetainedMediaCompositionLiveChild = Readonly<{
  execution: ReferenceRetainedMediaCompositionChildExecution;
  surface?: ReferenceRetainedMediaViewportSurface;
  branchReceipt?: ReferenceRetainedMediaViewportExecutionEvidence;
}>;

type ReferenceRetainedMediaCompositionAuthorityRecord = Readonly<{
  planIdentity: string;
  compositionId: string;
  exactTime: Rational;
  outputFrame: string;
  admission: Readonly<{ executionDomain: string; retainedBranchesInExecutionDomain: number }>;
  paintOrder: readonly ReferenceRetainedMediaCompositionChildExecution[];
  finalLocalTile: Readonly<{ width: number; height: number; rgbaSha256: string }>;
}>;

const retainedMediaCompositionAuthorities = new WeakMap<object, ReferenceRetainedMediaCompositionAuthorityRecord>();

function fail(node: IRNode, code: ReferenceRetainedMediaViewportErrorCode, detail: string): never {
  throw new ReferenceRetainedMediaViewportError(code, node, detail);
}

export const referenceRetainedMediaViewportQ16Units = 65_536;

export type ReferenceRetainedMediaViewportQ16SamplingTransform = Readonly<{
  affine: ReferenceAffine2D;
  inverse: Readonly<{ a: number; b: number; c: number; d: number }>;
}>;

export type ReferenceRetainedMediaViewportQ16BilinearTap = readonly [
  weight: number,
  sampleX: number,
  sampleY: number,
];

export type ReferenceRetainedMediaViewportQ16TapDiagnosticMode =
  | "automatic"
  | "forced-allocated-control";

export type ReferenceRetainedMediaViewportQ16TapDiagnostic = Readonly<{
  format: "cut-reference-retained-media-q16-tap-kernel-controller";
  version: 2;
  mode: ReferenceRetainedMediaViewportQ16TapDiagnosticMode;
  snapshot: () => ReferenceRetainedMediaViewportQ16TapDiagnosticSnapshot;
}>;

export type ReferenceRetainedMediaViewportQ16TapDiagnosticSnapshot = Readonly<{
  format: "cut-reference-retained-media-q16-tap-kernel";
  version: 2;
  mode: ReferenceRetainedMediaViewportQ16TapDiagnosticMode;
  algorithmVersion: typeof referenceRetainedMediaViewportQ16TapKernelAlgorithmVersion;
  observationIdentity: string;
  rasterRequests: number;
  skippedRasterRequests: number;
  visibleRasterRequests: number;
  visibleDestinationPixels: number;
  allocatedControlPixels: number;
  reusableScratchPixels: number;
  nativePixels: number;
  tapEvaluations: number;
  zeroWeightTaps: number;
  outputPixelsWritten: number;
  scratchAllocations: number;
  nativeExecutions: number;
  scalarExecutions: number;
}>;

type MutableReferenceRetainedMediaViewportQ16TapDiagnostic = {
  rasterRequests: number;
  skippedRasterRequests: number;
  visibleRasterRequests: number;
  visibleDestinationPixels: number;
  allocatedControlPixels: number;
  reusableScratchPixels: number;
  nativePixels: number;
  tapEvaluations: number;
  zeroWeightTaps: number;
  outputPixelsWritten: number;
  scratchAllocations: number;
  nativeExecutions: number;
  scalarExecutions: number;
};

const retainedMediaViewportQ16TapDiagnosticAuthority =
  new WeakMap<
    ReferenceRetainedMediaViewportQ16TapDiagnostic,
    MutableReferenceRetainedMediaViewportQ16TapDiagnostic
  >();

const retainedMediaViewportQ16TapObservationIdentities = Object.freeze({
  automatic: createHash("sha256").update(
    `${referenceRetainedMediaViewportQ16TapKernelAlgorithmVersion};mode=automatic`,
  ).digest("hex"),
  "forced-allocated-control": createHash("sha256").update(
    `${referenceRetainedMediaViewportQ16TapKernelAlgorithmVersion};mode=forced-allocated-control`,
  ).digest("hex"),
});

function retainedMediaViewportQ16TapDiagnosticError(detail: string): never {
  throw new Error(`CUT_RETAINED_MEDIA_VIEWPORT_RASTER: ${detail}`);
}

export function createReferenceRetainedMediaViewportQ16TapDiagnostic(
  mode: ReferenceRetainedMediaViewportQ16TapDiagnosticMode,
): ReferenceRetainedMediaViewportQ16TapDiagnostic {
  if (mode !== "automatic" && mode !== "forced-allocated-control") {
    retainedMediaViewportQ16TapDiagnosticError(
      "Q16 tap diagnostic mode must be automatic or forced-allocated-control.",
    );
  }
  const diagnostic: ReferenceRetainedMediaViewportQ16TapDiagnostic = Object.freeze({
    format: "cut-reference-retained-media-q16-tap-kernel-controller",
    version: 2,
    mode,
    snapshot: () => referenceRetainedMediaViewportQ16TapDiagnosticSnapshot(diagnostic),
  });
  retainedMediaViewportQ16TapDiagnosticAuthority.set(diagnostic, {
    rasterRequests: 0,
    skippedRasterRequests: 0,
    visibleRasterRequests: 0,
    visibleDestinationPixels: 0,
    allocatedControlPixels: 0,
    reusableScratchPixels: 0,
    nativePixels: 0,
    tapEvaluations: 0,
    zeroWeightTaps: 0,
    outputPixelsWritten: 0,
    scratchAllocations: 0,
    nativeExecutions: 0,
    scalarExecutions: 0,
  });
  return diagnostic;
}

export function referenceRetainedMediaViewportQ16TapDiagnosticSnapshot(
  diagnostic: ReferenceRetainedMediaViewportQ16TapDiagnostic,
): ReferenceRetainedMediaViewportQ16TapDiagnosticSnapshot {
  const counters = retainedMediaViewportQ16TapDiagnosticAuthority.get(diagnostic);
  if (!counters) {
    retainedMediaViewportQ16TapDiagnosticError(
      "Q16 tap diagnostic authority was not issued by this runtime.",
    );
  }
  return Object.freeze({
    format: "cut-reference-retained-media-q16-tap-kernel",
    version: 2,
    mode: diagnostic.mode,
    algorithmVersion: referenceRetainedMediaViewportQ16TapKernelAlgorithmVersion,
    observationIdentity: retainedMediaViewportQ16TapObservationIdentities[diagnostic.mode],
    ...counters,
  });
}

export function validateReferenceRetainedMediaViewportQ16TapKernelEvidence(
  candidate: unknown,
): ReferenceRetainedMediaViewportQ16TapDiagnosticSnapshot {
  if (!candidate || typeof candidate !== "object") {
    retainedMediaViewportQ16TapDiagnosticError("Q16 tap evidence must be an object.");
  }
  const evidence = candidate as Partial<ReferenceRetainedMediaViewportQ16TapDiagnosticSnapshot>;
  if (evidence.format !== "cut-reference-retained-media-q16-tap-kernel"
    || evidence.version !== 2
    || (evidence.mode !== "automatic" && evidence.mode !== "forced-allocated-control")
    || evidence.algorithmVersion !== referenceRetainedMediaViewportQ16TapKernelAlgorithmVersion
    || evidence.observationIdentity !== retainedMediaViewportQ16TapObservationIdentities[evidence.mode]) {
    retainedMediaViewportQ16TapDiagnosticError(
      "Q16 tap evidence identity does not match the current runtime.",
    );
  }
  const integerFields = [
    "rasterRequests",
    "skippedRasterRequests",
    "visibleRasterRequests",
    "visibleDestinationPixels",
    "allocatedControlPixels",
    "reusableScratchPixels",
    "nativePixels",
    "tapEvaluations",
    "zeroWeightTaps",
    "outputPixelsWritten",
    "scratchAllocations",
    "nativeExecutions",
    "scalarExecutions",
  ] as const;
  for (const field of integerFields) {
    if (!Number.isSafeInteger(evidence[field]) || (evidence[field] ?? -1) < 0) {
      retainedMediaViewportQ16TapDiagnosticError(
        `Q16 tap evidence ${field} must be a nonnegative safe integer.`,
      );
    }
  }
  const rasterRequests = evidence.rasterRequests as number;
  const skippedRasterRequests = evidence.skippedRasterRequests as number;
  const visibleRasterRequests = evidence.visibleRasterRequests as number;
  const visibleDestinationPixels = evidence.visibleDestinationPixels as number;
  const allocatedControlPixels = evidence.allocatedControlPixels as number;
  const reusableScratchPixels = evidence.reusableScratchPixels as number;
  const nativePixels = evidence.nativePixels as number;
  const tapEvaluations = evidence.tapEvaluations as number;
  const zeroWeightTaps = evidence.zeroWeightTaps as number;
  const outputPixelsWritten = evidence.outputPixelsWritten as number;
  const scratchAllocations = evidence.scratchAllocations as number;
  const nativeExecutions = evidence.nativeExecutions as number;
  const scalarExecutions = evidence.scalarExecutions as number;
  if (rasterRequests !== skippedRasterRequests + visibleRasterRequests
    || visibleDestinationPixels !== allocatedControlPixels + reusableScratchPixels + nativePixels
    || tapEvaluations !== visibleDestinationPixels * 4
    || !Number.isSafeInteger(tapEvaluations)
    || zeroWeightTaps > tapEvaluations
    || outputPixelsWritten > visibleDestinationPixels
    || nativeExecutions + scalarExecutions !== visibleRasterRequests
    || (evidence.mode === "automatic"
      && (allocatedControlPixels !== 0
        || reusableScratchPixels + nativePixels !== visibleDestinationPixels
        || scratchAllocations !== scalarExecutions))
    || (evidence.mode === "forced-allocated-control"
      && (reusableScratchPixels !== 0
        || nativePixels !== 0
        || allocatedControlPixels !== visibleDestinationPixels
        || scratchAllocations !== 0
        || nativeExecutions !== 0
        || scalarExecutions !== visibleRasterRequests))) {
    retainedMediaViewportQ16TapDiagnosticError(
      "Q16 tap evidence counters do not describe one terminal execution per raster and visible destination pixel.",
    );
  }
  return Object.freeze({
    ...(evidence as ReferenceRetainedMediaViewportQ16TapDiagnosticSnapshot),
  });
}

type MutableReferenceRetainedMediaViewportQ16BilinearTap = [
  weight: number,
  sampleX: number,
  sampleY: number,
];

type ReferenceRetainedMediaViewportQ16TapScratch = {
  taps: [
    MutableReferenceRetainedMediaViewportQ16BilinearTap,
    MutableReferenceRetainedMediaViewportQ16BilinearTap,
    MutableReferenceRetainedMediaViewportQ16BilinearTap,
    MutableReferenceRetainedMediaViewportQ16BilinearTap,
  ];
};

function createReferenceRetainedMediaViewportQ16TapScratch():
  ReferenceRetainedMediaViewportQ16TapScratch {
  return {
    taps: [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ],
  };
}

/**
 * Private allocation-free form of the public Q16 tap law. Keep every
 * multiply/add, rounding boundary and tap order identical to the frozen public
 * result; the audited IEEE half-phase is sensitive to algebraic reordering.
 */
function populateReferenceRetainedMediaViewportQ16BilinearTapScratch(
  transform: ReferenceRetainedMediaViewportQ16SamplingTransform,
  x: number,
  y: number,
  scratch: ReferenceRetainedMediaViewportQ16TapScratch,
) {
  const { affine, inverse } = transform;
  const units = referenceRetainedMediaViewportQ16Units;
  const dx = x - affine.tx, dy = y - affine.ty;
  const sxQ = Math.round((inverse.a * dx + inverse.c * dy) * units);
  const syQ = Math.round((inverse.b * dx + inverse.d * dy) * units);
  const x0 = Math.floor(sxQ / units), y0 = Math.floor(syQ / units);
  const fx = sxQ - x0 * units, fy = syQ - y0 * units;
  const [topLeft, topRight, bottomLeft, bottomRight] = scratch.taps;
  topLeft[0] = (units - fx) * (units - fy);
  topLeft[1] = x0;
  topLeft[2] = y0;
  topRight[0] = fx * (units - fy);
  topRight[1] = x0 + 1;
  topRight[2] = y0;
  bottomLeft[0] = (units - fx) * fy;
  bottomLeft[1] = x0;
  bottomLeft[2] = y0 + 1;
  bottomRight[0] = fx * fy;
  bottomRight[1] = x0 + 1;
  bottomRight[2] = y0 + 1;
  return scratch;
}

/**
 * Build the exact quantized transform consumed by CUT's retained-media
 * sampler. Observability imports this pure kernel instead of maintaining a
 * second, approximately equivalent inverse-affine implementation.
 */
export function referenceRetainedMediaViewportQ16SamplingTransform(
  affineInput: ReferenceAffine2D,
): ReferenceRetainedMediaViewportQ16SamplingTransform | undefined {
  const units = referenceRetainedMediaViewportQ16Units;
  const quantized = (value: number) => Math.round(value * units) / units;
  const affine = Object.freeze({
    a: quantized(affineInput.a), b: quantized(affineInput.b),
    c: quantized(affineInput.c), d: quantized(affineInput.d),
    tx: quantized(affineInput.tx), ty: quantized(affineInput.ty),
  });
  const determinant = affine.a * affine.d - affine.b * affine.c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1 / units ** 2) return undefined;
  return Object.freeze({
    affine,
    inverse: Object.freeze({
      a: affine.d / determinant,
      b: -affine.b / determinant,
      c: -affine.c / determinant,
      d: affine.a / determinant,
    }),
  });
}

/** Exact Q16 source taps and integer bilinear weights for one output pixel. */
export function referenceRetainedMediaViewportQ16BilinearTapsAt(
  transform: ReferenceRetainedMediaViewportQ16SamplingTransform,
  x: number,
  y: number,
): readonly ReferenceRetainedMediaViewportQ16BilinearTap[] {
  const { affine, inverse } = transform;
  const units = referenceRetainedMediaViewportQ16Units;
  const dx = x - affine.tx, dy = y - affine.ty;
  const sxQ = Math.round((inverse.a * dx + inverse.c * dy) * units);
  const syQ = Math.round((inverse.b * dx + inverse.d * dy) * units);
  const x0 = Math.floor(sxQ / units), y0 = Math.floor(syQ / units);
  const fx = sxQ - x0 * units, fy = syQ - y0 * units;
  return Object.freeze([
    Object.freeze([(units - fx) * (units - fy), x0, y0] as const),
    Object.freeze([fx * (units - fy), x0 + 1, y0] as const),
    Object.freeze([(units - fx) * fy, x0, y0 + 1] as const),
    Object.freeze([fx * fy, x0 + 1, y0 + 1] as const),
  ]);
}

/**
 * Internal authority-backed diagnostic witness for the private scratch law.
 * The returned tuples are detached and deeply frozen; production raster work
 * continues to reuse its own renderer-local scratch without exposing it.
 */
export function referenceRetainedMediaViewportQ16TapDiagnosticSample(
  diagnostic: ReferenceRetainedMediaViewportQ16TapDiagnostic,
  transform: ReferenceRetainedMediaViewportQ16SamplingTransform,
  x: number,
  y: number,
): readonly ReferenceRetainedMediaViewportQ16BilinearTap[] {
  if (!retainedMediaViewportQ16TapDiagnosticAuthority.has(diagnostic)) {
    retainedMediaViewportQ16TapDiagnosticError(
      "Q16 tap diagnostic authority was not issued by this runtime.",
    );
  }
  const taps = diagnostic.mode === "forced-allocated-control"
    ? referenceRetainedMediaViewportQ16BilinearTapsAt(transform, x, y)
    : populateReferenceRetainedMediaViewportQ16BilinearTapScratch(
      transform,
      x,
      y,
      createReferenceRetainedMediaViewportQ16TapScratch(),
    ).taps;
  return Object.freeze(taps.map(
    ([weight, sampleX, sampleY]) => Object.freeze([weight, sampleX, sampleY] as const),
  ));
}

function quantizedAffine(node: IRNode, affine: ReferenceAffine2D) {
  const quantized = (value: number) => Math.round(value * referenceRetainedMediaViewportQ16Units) / referenceRetainedMediaViewportQ16Units;
  const result = Object.freeze({
    a: quantized(affine.a), b: quantized(affine.b), c: quantized(affine.c), d: quantized(affine.d),
    tx: quantized(affine.tx), ty: quantized(affine.ty),
  });
  const determinant = result.a * result.d - result.b * result.c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1 / referenceRetainedMediaViewportQ16Units ** 2) {
    fail(node, "CUT_RETAINED_MEDIA_VIEWPORT_RASTER", "affine becomes singular after the normative Q16 quantization; change the nested scale/skew transform.");
  }
  return result;
}

function active(node: IRNode, time: Rational) {
  return compareRational(time, node.interval.start) >= 0
    && compareRational(time, addRational(node.interval.start, node.interval.duration)) < 0;
}

function exactPure(node: IRNode) {
  return node.domain === "visual"
    && node.editorial === undefined
    && node.effects.length === 1
    && node.effects[0] === "pure";
}

function imageNative(ir: CutAVIR, node: IRNode, sourceId: string) {
  const resource = ir.resources[sourceId], metadata = resource?.metadata as {
    lockVersion?: unknown;
    probe?: { kind?: unknown; identity?: { format?: unknown; version?: unknown; image?: { width?: unknown; height?: unknown } } };
  } | undefined;
  const probe = metadata?.probe, identity = probe?.identity;
  const width = identity?.image?.width, height = identity?.image?.height;
  if (resource?.state !== "locked" || metadata?.lockVersion !== 2 || probe?.kind !== "image"
    || identity?.format !== "cut-image-probe" || identity.version !== 1
    || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || Number(width) < 1 || Number(height) < 1) {
    fail(node, "CUT_RETAINED_MEDIA_VIEWPORT_RESOURCE", `ImageAsset ${sourceId} requires a complete locked cut-image-probe with positive native dimensions.`);
  }
  return Object.freeze({ width: Number(width), height: Number(height) });
}

export function referenceRetainedMediaCropPixels(
  native: Readonly<{ width: number; height: number }>,
  crop?: ReferenceNormalizedCrop,
) {
  if (!crop) return Object.freeze({ left: 0, top: 0, width: native.width, height: native.height });
  const left = Math.max(0, Math.min(native.width - 1, Math.round(crop.x * native.width)));
  const top = Math.max(0, Math.min(native.height - 1, Math.round(crop.y * native.height)));
  const width = Math.max(1, Math.min(native.width - left, Math.round(crop.width * native.width)));
  const height = Math.max(1, Math.min(native.height - top, Math.round(crop.height * native.height)));
  return Object.freeze({ left, top, width, height });
}

export function referenceRetainedMediaFitDimensions(
  source: Readonly<{ width: number; height: number }>,
  viewport: Readonly<{ width: number; height: number }>,
  fit: "cover" | "contain" | "fill",
) {
  if (fit === "fill") return Object.freeze({ width: viewport.width, height: viewport.height });
  const factor = fit === "contain"
    ? Math.min(viewport.width / source.width, viewport.height / source.height)
    : Math.max(viewport.width / source.width, viewport.height / source.height);
  return Object.freeze({
    width: Math.max(1, Math.round(source.width * factor)),
    height: Math.max(1, Math.round(source.height * factor)),
  });
}

function assertDimensions(node: IRNode, native: Readonly<{ width: number; height: number }>, fitted: Readonly<{ width: number; height: number }>) {
  const nativePixels = native.width * native.height, fitPixels = fitted.width * fitted.height;
  if (native.width > referenceRetainedMediaViewportLimits.maximumNativeAxisPx
    || native.height > referenceRetainedMediaViewportLimits.maximumNativeAxisPx
    || !Number.isSafeInteger(nativePixels) || nativePixels > referenceRetainedMediaViewportLimits.maximumNativePixels) {
    fail(node, "CUT_RETAINED_MEDIA_VIEWPORT_LIMIT", `locked native source ${native.width}x${native.height} exceeds the bounded retained decode envelope.`);
  }
  if (!Number.isSafeInteger(fitPixels) || fitPixels > referenceRetainedMediaViewportLimits.maximumFitPixels) {
    fail(node, "CUT_RETAINED_MEDIA_VIEWPORT_LIMIT", `fit would allocate ${fitted.width}x${fitted.height}; crop or choose a less extreme source/aspect ratio.`);
  }
}

/** Nested LocalSpace is an explicit materialization boundary. Its own graph
 * validator admits or refuses any media below it; an outer LocalSpace must not
 * mistake that nested tile for one of its direct retained-media branches. */
function referenceSubtreeContainsRetainedMedia(ir: CutAVIR, id: string, visiting = new Set<string>()): boolean {
  const node = ir.nodes[id];
  if (!node || visiting.has(id) || node.op === "cut.visual.local_space") return false;
  if (node.op === "cut.visual.image" || node.op === "cut.visual.video") return true;
  visiting.add(id);
  const result = node.children.some((child) => referenceSubtreeContainsRetainedMedia(ir, child, visiting));
  visiting.delete(id);
  return result;
}

/** Structural classifier only. Validation remains in the planner below so a
 * forged effect capability, missing lock, or invalid transform cannot hide
 * behind candidate detection. Keeping this exact grammar is what preserves
 * every historical v1 branch identity and pre-fit ColorGrade pixel. */
export function referenceRetainedMediaLegacyIslandRoot(ir: CutAVIR, rootId: string) {
  let node = ir.nodes[rootId], groupDepth = 0, colorGrades = 0;
  const visited = new Set<string>();
  while (node) {
    if (visited.has(node.id)) return false;
    visited.add(node.id);
    if (node.op === "cut.visual.image" || node.op === "cut.visual.video") return node.children.length === 0;
    if (node.op !== "cut.visual.group" && node.op !== "cut.visual.color_grade" || node.children.length !== 1) return false;
    if (node.op === "cut.visual.group" && ++groupDepth > referenceRetainedMediaViewportLimits.maximumGroupDepth) return false;
    if (node.op === "cut.visual.color_grade" && ++colorGrades > 1) return false;
    node = ir.nodes[node.children[0]!];
  }
  return false;
}

/** Direct-root compatibility detector. It admits no additional semantics: it
 * routes an over-depth or repeated-grade historical unary branch back through
 * the unchanged V1 validator so its stable source diagnostic is preserved. */
function referenceRetainedMediaLegacyUnaryCandidateRoot(ir: CutAVIR, rootId: string) {
  let node = ir.nodes[rootId];
  const visited = new Set<string>();
  while (node) {
    if (visited.has(node.id)) return false;
    visited.add(node.id);
    if (node.op === "cut.visual.image" || node.op === "cut.visual.video") return node.children.length === 0;
    if ((node.op !== "cut.visual.group" && node.op !== "cut.visual.color_grade") || node.children.length !== 1) return false;
    node = ir.nodes[node.children[0]!];
  }
  return false;
}

/** Validate the complete historical unary island without consulting a
 * resource lock or native probe. This is intentionally the same topology
 * walk used by the locked planner below, rather than a looser check-only
 * approximation. */
export function referenceRetainedMediaBranchTopology(
  ir: CutAVIR,
  localSpace: IRNode,
  rootId: string,
): ReferenceRetainedMediaBranchTopology {
  const nodeIds: string[] = [], wrapperOps: string[] = [];
  let colorGradeNodeId: string | undefined, groupDepth = 0;
  let node = ir.nodes[rootId];
  if (!node) fail(localSpace, "CUT_RETAINED_MEDIA_VIEWPORT_GRAPH", `direct retained-media root ${rootId} is missing.`);
  const visited = new Set<string>();
  while (node) {
    if (visited.has(node.id)) fail(node, "CUT_RETAINED_MEDIA_VIEWPORT_GRAPH", "unary retained-media branch cycles.");
    visited.add(node.id); nodeIds.push(node.id);
    if (!exactPure(node)) fail(node, "CUT_RETAINED_MEDIA_VIEWPORT_GRAPH", "requires an ordinary pure visual node without editorial payload or hidden effect capabilities.");
    if (node.op === "cut.visual.image" || node.op === "cut.visual.video") break;
    if (node.op !== "cut.visual.group" && node.op !== "cut.visual.color_grade") {
      fail(node, "CUT_RETAINED_MEDIA_VIEWPORT_GRAPH", `${node.op} is not part of the closed unary Group/optional ColorGrade retained-media grammar.`);
    }
    if (node.children.length !== 1) fail(node, "CUT_RETAINED_MEDIA_VIEWPORT_GRAPH", `${node.op} must own exactly one direct child in a retained-media branch.`);
    if (node.op === "cut.visual.group") {
      groupDepth += 1;
      if (groupDepth > referenceRetainedMediaViewportLimits.maximumGroupDepth) {
        fail(node, "CUT_RETAINED_MEDIA_VIEWPORT_LIMIT", `Group depth exceeds ${referenceRetainedMediaViewportLimits.maximumGroupDepth}.`);
      }
    } else {
      if (colorGradeNodeId) fail(node, "CUT_RETAINED_MEDIA_VIEWPORT_GRAPH", "permits at most one ColorGrade in the first retained-media slice.");
      colorGradeNodeId = node.id;
    }
    wrapperOps.push(node.op);
    node = ir.nodes[node.children[0]!];
  }
  if (!node || (node.op !== "cut.visual.image" && node.op !== "cut.visual.video") || node.children.length !== 0) {
    fail(node ?? localSpace, "CUT_RETAINED_MEDIA_VIEWPORT_GRAPH", "branch must terminate in exactly one childless Image or Video leaf.");
  }
  return Object.freeze({
    rootId,
    leafId: node.id,
    leafKind: node.op === "cut.visual.image" ? "image" as const : "video" as const,
    nodeIds: Object.freeze(nodeIds),
    wrapperOps: Object.freeze(wrapperOps),
    ...(colorGradeNodeId ? { colorGradeNodeId } : {}),
  });
}

/** Close one direct retained-media branch before source bytes are opened:
 * zero or more unary Group wrappers, at most one unary ColorGrade, and exactly
 * one Image or Video leaf. */
export function referenceRetainedMediaBranchPlan(
  ir: CutAVIR,
  localSpace: IRNode,
  rootId: string,
  viewport: Readonly<{ width: number; height: number }>,
): ReferenceRetainedMediaViewportPlan {
  const topology = referenceRetainedMediaBranchTopology(ir, localSpace, rootId);
  const { nodeIds, wrapperOps, colorGradeNodeId, leafKind } = topology;
  const leaf = ir.nodes[topology.leafId]!;
  let sourceId: string, native: Readonly<{ width: number; height: number }>, fit: "cover" | "contain" | "fill", crop: ReferenceNormalizedCrop | undefined;
  let selectedVariant: "master" | "proxy" | "not-applicable" = "not-applicable";
  let videoExecution: ReferenceRetainedMediaViewportPlan["videoExecution"];
  if (leafKind === "image") {
    const config = referenceShapeNodeConfig(ir, { ...({} as IRComposition), width: viewport.width, height: viewport.height }, leaf);
    if (!config || config.kind !== "image") fail(leaf, "CUT_RETAINED_MEDIA_VIEWPORT_RESOURCE", "does not have a valid public Image configuration.");
    sourceId = config.sourceId; fit = config.fit; crop = config.crop; native = imageNative(ir, leaf, sourceId);
  } else {
    const config = referenceVideoInputConfig(ir, leaf);
    if (!config) fail(leaf, "CUT_RETAINED_MEDIA_VIEWPORT_RESOURCE", "does not have a valid public Video configuration.");
    sourceId = config.resourceId; fit = config.fit; crop = config.crop;
    native = Object.freeze({ width: config.nativeWidth, height: config.nativeHeight });
    selectedVariant = referenceMediaProfileResourceState(ir, sourceId)?.selected
      ?? ((ir.resources[sourceId]?.metadata as { activeMediaVariant?: unknown } | undefined)?.activeMediaVariant === "proxy" ? "proxy" : "master");
    videoExecution = Object.freeze({
      streamIndex: config.streamIndex,
      config,
      configIdentity: hash(config),
      ...(config.decodedVideoCadence ? { cadenceIdentity: hash(config.decodedVideoCadence) } : {}),
    });
  }
  const resource = ir.resources[sourceId];
  if (!resource?.sha256 || !/^[a-f0-9]{64}$/u.test(resource.sha256)) {
    fail(leaf, "CUT_RETAINED_MEDIA_VIEWPORT_RESOURCE", `resource ${sourceId} requires a locked SHA-256 identity.`);
  }
  const cropped = referenceRetainedMediaCropPixels(native, crop), fitted = referenceRetainedMediaFitDimensions(cropped, viewport, fit);
  assertDimensions(leaf, native, fitted);
  const maximumPixelWorkPerFrame = cropped.width * cropped.height * (colorGradeNodeId ? 3 : 1)
    + fitted.width * fitted.height * 2 + viewport.width * viewport.height;
  if (!Number.isSafeInteger(maximumPixelWorkPerFrame)
    || maximumPixelWorkPerFrame > referenceRetainedMediaViewportLimits.maximumPixelWorkPerFrame) {
    fail(leaf, "CUT_RETAINED_MEDIA_VIEWPORT_LIMIT", `planned crop/color/fit/affine work exceeds ${referenceRetainedMediaViewportLimits.maximumPixelWorkPerFrame} pixel-passes per frame.`);
  }
  const semantic = {
    algorithmVersion: referenceRetainedMediaViewportAlgorithmVersion,
    backendIdentity: referenceRetainedMediaViewportBackendIdentity,
    localSpaceNodeId: localSpace.id,
    rootId,
    leafId: leaf.id,
    nodeHashes: nodeIds.map((id) => ir.nodes[id]!.contentHash),
    sourceId,
    sourceSha256: resource.sha256,
    selectedVariant,
    ...(videoExecution ? { videoExecution } : {}),
    native,
    crop,
    cropped,
    fit,
    fitted,
    viewport,
    resample: "sharp-bicubic-fit-then-cut-q16-associated-bilinear-affine",
  } as const;
  return Object.freeze({
    localSpaceNodeId: localSpace.id,
    rootId,
    leafId: leaf.id,
    leafKind,
    nodeIds: Object.freeze(nodeIds),
    wrapperOps: Object.freeze(wrapperOps),
    ...(colorGradeNodeId ? { colorGradeNodeId } : {}),
    sourceId,
    sourceSha256: resource.sha256,
    selectedVariant,
    ...(videoExecution ? { videoExecution } : {}),
    native,
    ...(crop ? { crop } : {}),
    cropped,
    fit,
    fitted,
    viewport: Object.freeze({ ...viewport }),
    resample: "sharp-bicubic-fit-then-cut-q16-associated-bilinear-affine",
    maximumPixelWorkPerFrame,
    semanticIdentity: hash(semantic),
  });
}

const retainedMediaLocalCompositorOps = new Set([
  "cut.visual.composite",
  "cut.visual.mask",
  "cut.visual.clip_path",
  "cut.visual.blur",
  "cut.visual.vignette",
  "cut.visual.sharpen",
  "cut.visual.grain",
  "cut.visual.duotone",
  "cut.visual.color_grade",
]);

const retainedMediaLocalCompositorGraphOps = new Set([
  "cut.kernel.fragment",
  "cut.visual.group",
  "cut.visual.local_space",
  "cut.visual.rect",
  "cut.visual.circle",
  "cut.visual.path",
  "cut.visual.trace",
  "cut.visual.text",
  "cut.visual.flow_text",
  ...retainedMediaLocalCompositorOps,
]);

function validateReferenceRetainedMediaStaticLeaf(
  ir: CutAVIR,
  localSpace: IRNode,
  topology: ReferenceRetainedMediaBranchTopology,
) {
  const leaf = ir.nodes[topology.leafId];
  if (!leaf) fail(localSpace, "CUT_RETAINED_MEDIA_VIEWPORT_GRAPH", `retained-media leaf ${topology.leafId} is missing.`);
  if (topology.leafKind === "image") {
    const config = referenceShapeNodeConfig(ir, { ...({} as IRComposition), width: 1, height: 1 }, leaf);
    if (!config || config.kind !== "image") fail(leaf, "CUT_RETAINED_MEDIA_VIEWPORT_RESOURCE", "does not have a valid public Image configuration.");
    return;
  }
  if (!referenceVideoStaticInputConfig(ir, leaf)) {
    fail(leaf, "CUT_RETAINED_MEDIA_VIEWPORT_RESOURCE", "does not have a valid public Video configuration.");
  }
}

/** Asset-free retained-media admission used only for structural checking.
 * It closes the same direct-v1 versus maximal-island-v2 topology, operation
 * set, cycle bounds, and materialization counts as the locked planner. Native
 * dimensions, crop/fit work, resource hashes, and allocator budgets remain
 * deliberately deferred to lock/inspect/render, where they are knowable. */
export function referenceRetainedMediaStaticLocalTopology(
  ir: CutAVIR,
  localSpace: IRNode,
): ReferenceRetainedMediaStaticLocalTopology {
  const mediaRoots = localSpace.children.filter((id) => referenceSubtreeContainsRetainedMedia(ir, id));
  const directLegacyRootIds = mediaRoots.filter((id) => referenceRetainedMediaLegacyUnaryCandidateRoot(ir, id));
  const directLegacyRoots = new Set(directLegacyRootIds);
  const v2RootIds = mediaRoots.filter((id) => !directLegacyRoots.has(id));
  const materializationRootIds: string[] = [];
  const materializationNodeIds = new Set<string>();
  const operationNodeIds = new Set<string>();
  let treeNodeCount = 0;

  for (const rootId of directLegacyRootIds) {
    const topology = referenceRetainedMediaBranchTopology(ir, localSpace, rootId);
    validateReferenceRetainedMediaStaticLeaf(ir, localSpace, topology);
    materializationRootIds.push(rootId);
    topology.nodeIds.forEach((id) => materializationNodeIds.add(id));
  }

  const visiting = new Set<string>();
  const visit = (nodeId: string): number => {
    const node = ir.nodes[nodeId];
    if (!node) fail(localSpace, "CUT_RETAINED_MEDIA_VIEWPORT_GRAPH", `V2 compositor tree references missing descendant ${nodeId}.`);
    if (visiting.has(node.id)) fail(node, "CUT_RETAINED_MEDIA_VIEWPORT_GRAPH", "V2 compositor tree cycles.");
    treeNodeCount += 1;
    if (treeNodeCount > referenceRetainedMediaViewportLimits.maximumLocalCompositorTreeNodes) {
      fail(node, "CUT_RETAINED_MEDIA_VIEWPORT_LIMIT", `V2 compositor tree node count exceeds ${referenceRetainedMediaViewportLimits.maximumLocalCompositorTreeNodes}.`);
    }
    if (referenceRetainedMediaLegacyIslandRoot(ir, node.id)) {
      const topology = referenceRetainedMediaBranchTopology(ir, localSpace, node.id);
      validateReferenceRetainedMediaStaticLeaf(ir, localSpace, topology);
      materializationRootIds.push(node.id);
      topology.nodeIds.forEach((id) => materializationNodeIds.add(id));
      return 0;
    }
    if (!exactPure(node)) {
      fail(node, "CUT_RETAINED_MEDIA_VIEWPORT_GRAPH", "V2 compositor trees require ordinary pure visual nodes without editorial payload or hidden effect capabilities.");
    }
    if (node.op === "cut.visual.shadow" || node.op === "cut.visual.glow") {
      fail(node, "CUT_RETAINED_MEDIA_VIEWPORT_GRAPH", `${node.op} remains refused because no LocalSpace halo expansion/clipping policy is public.`);
    }
    if (!retainedMediaLocalCompositorGraphOps.has(node.op)) {
      fail(node, "CUT_RETAINED_MEDIA_VIEWPORT_GRAPH", `${node.op} is outside the closed retained-media local compositor V2 grammar; delivery-canvas fallback is forbidden.`);
    }
    if (node.op === "cut.visual.local_space") return 0;
    visiting.add(node.id);
    const childOperations = node.children.reduce((sum, childId) => sum + visit(childId), 0);
    visiting.delete(node.id);
    const ownOperation = retainedMediaLocalCompositorOps.has(node.op) ? 1 : 0;
    if (ownOperation) operationNodeIds.add(node.id);
    return ownOperation + childOperations;
  };

  for (const rootId of v2RootIds) {
    const operations = visit(rootId);
    if (operations < 1) {
      const root = ir.nodes[rootId] ?? localSpace;
      fail(root, "CUT_RETAINED_MEDIA_VIEWPORT_GRAPH", "a media-bearing V2 direct child requires at least one admitted Composite/Mask/ClipPath/finishing wrapper; Group-only multi-media topology remains unsupported.");
    }
  }
  if (v2RootIds.length > 0) {
    const sourceOverSteps = referenceRetainedMediaLocalCompositorSourceOverSteps(ir, localSpace);
    if (sourceOverSteps > referenceRetainedMediaViewportLimits.maximumLocalCompositorSourceOverSteps) {
      fail(localSpace, "CUT_RETAINED_MEDIA_VIEWPORT_LIMIT", `whole-LocalSpace source-over step count ${sourceOverSteps} exceeds ${referenceRetainedMediaViewportLimits.maximumLocalCompositorSourceOverSteps}.`);
    }
  }
  if (materializationRootIds.length > referenceRetainedMediaViewportLimits.maximumBranchesPerLocalSpace) {
    fail(localSpace, "CUT_RETAINED_MEDIA_VIEWPORT_LIMIT", `retained-media materialization count ${materializationRootIds.length} exceeds ${referenceRetainedMediaViewportLimits.maximumBranchesPerLocalSpace} per LocalSpace.`);
  }
  const semanticIdentity = hash({
    algorithmVersion: referenceRetainedMediaLocalCompositorAlgorithmVersion,
    phase: "asset-free-static-topology",
    localSpaceNodeId: localSpace.id,
    directLegacyRootIds,
    v2RootIds,
    materializationRootIds,
    materializationNodeIds: [...materializationNodeIds],
    operationNodeIds: [...operationNodeIds],
    treeNodeCount,
  });
  return Object.freeze({
    localSpaceNodeId: localSpace.id,
    directLegacyRootIds: Object.freeze([...directLegacyRootIds]),
    v2RootIds: Object.freeze([...v2RootIds]),
    materializationRootIds: Object.freeze([...materializationRootIds]),
    materializationNodeIds,
    operationNodeIds,
    treeNodeCount,
    semanticIdentity,
  });
}

function referenceRetainedMediaLocalCompositorSourceOverSteps(ir: CutAVIR, localSpace: IRNode) {
  const visiting = new Set<string>();
  const inside = (nodeId: string): number => {
    const node = ir.nodes[nodeId];
    if (!node) fail(localSpace, "CUT_RETAINED_MEDIA_VIEWPORT_GRAPH", `source-over accounting references missing descendant ${nodeId}.`);
    if (node.op === "cut.visual.local_space" || referenceRetainedMediaLegacyIslandRoot(ir, node.id)) return 0;
    if (visiting.has(node.id)) fail(node, "CUT_RETAINED_MEDIA_VIEWPORT_GRAPH", "source-over accounting graph cycles.");
    visiting.add(node.id);
    const own = node.op === "cut.kernel.fragment" || node.op === "cut.visual.group" || node.op === "cut.visual.composite"
      ? node.children.length
      : 0;
    const descendants = node.children.reduce((sum, childId) => sum + inside(childId), 0);
    visiting.delete(node.id);
    return own + descendants;
  };
  return localSpace.children.length + localSpace.children.reduce((sum, childId) => sum + inside(childId), 0);
}

/** Discover maximal historical media islands beneath new local compositor
 * wrappers. No source locator is opened: every island is planned exclusively
 * from already locked resource/probe metadata. */
export function discoverReferenceRetainedMediaLocalCompositor(
  ir: CutAVIR,
  localSpace: IRNode,
  viewport: Readonly<{ width: number; height: number }>,
  legacyComposition?: ReferenceRetainedMediaCompositionPlan,
): ReferenceRetainedMediaLocalCompositorDiscovery | undefined {
  const legacyRoots = new Set((legacyComposition?.branches ?? []).map((branch) => branch.rootId));
  const v2RootIds = localSpace.children.filter((id) => referenceSubtreeContainsRetainedMedia(ir, id) && !legacyRoots.has(id));
  if (v2RootIds.length === 0) return undefined;

  const islands: ReferenceRetainedMediaLocalCompositorIsland[] = [];
  const tree: ReferenceRetainedMediaLocalCompositorTreeNode[] = [];
  const materializationNodeIds = new Set<string>();
  const operationNodeIds = new Set<string>();
  const visiting = new Set<string>();
  let preorder = 0;

  const signalIdentities = (node: IRNode) => Object.entries(node.properties).flatMap(([property, value]) => {
    if (!("signal" in value)) return [];
    const signal = ir.signals[value.signal];
    if (!signal) fail(node, "CUT_RETAINED_MEDIA_VIEWPORT_GRAPH", `property “${property}” references missing signal ${value.signal}.`);
    return [{ property, signalId: signal.id, contentHash: signal.contentHash }];
  }).sort((left, right) => left.property.localeCompare(right.property) || left.signalId.localeCompare(right.signalId));

  const visit = (nodeId: string, path: readonly number[]): Readonly<{ identity: string; compositorOperations: number }> => {
    const node = ir.nodes[nodeId];
    if (!node) fail(localSpace, "CUT_RETAINED_MEDIA_VIEWPORT_GRAPH", `V2 compositor tree references missing descendant ${nodeId}.`);
    if (visiting.has(node.id)) fail(node, "CUT_RETAINED_MEDIA_VIEWPORT_GRAPH", "V2 compositor tree cycles.");
    const inspectPreorder = preorder++;
    if (preorder > referenceRetainedMediaViewportLimits.maximumLocalCompositorTreeNodes) {
      fail(node, "CUT_RETAINED_MEDIA_VIEWPORT_LIMIT", `V2 compositor tree node count exceeds ${referenceRetainedMediaViewportLimits.maximumLocalCompositorTreeNodes}.`);
    }

    if (referenceRetainedMediaLegacyIslandRoot(ir, node.id)) {
      const plan = referenceRetainedMediaBranchPlan(ir, localSpace, node.id, viewport);
      plan.nodeIds.forEach((id) => materializationNodeIds.add(id));
      islands.push(Object.freeze({ inspectPreorder, traversalPath: Object.freeze([...path]), rootId: node.id, plan }));
      const semanticIdentity = hash({
        algorithmVersion: referenceRetainedMediaLocalCompositorAlgorithmVersion,
        role: "materialization-island",
        traversalPath: path,
        planIdentity: plan.semanticIdentity,
      });
      tree.push(Object.freeze({
        inspectPreorder,
        traversalPath: Object.freeze([...path]),
        nodeId: node.id,
        op: node.op,
        childIds: Object.freeze([...node.children]),
        role: "materialization-island",
        semanticIdentity,
      }));
      return Object.freeze({ identity: semanticIdentity, compositorOperations: 0 });
    }

    if (!exactPure(node)) {
      fail(node, "CUT_RETAINED_MEDIA_VIEWPORT_GRAPH", "V2 compositor trees require ordinary pure visual nodes without editorial payload or hidden effect capabilities.");
    }
    if (node.op === "cut.visual.shadow" || node.op === "cut.visual.glow") {
      fail(node, "CUT_RETAINED_MEDIA_VIEWPORT_GRAPH", `${node.op} remains refused because no LocalSpace halo expansion/clipping policy is public.`);
    }
    if (!retainedMediaLocalCompositorGraphOps.has(node.op)) {
      fail(node, "CUT_RETAINED_MEDIA_VIEWPORT_GRAPH", `${node.op} is outside the closed retained-media local compositor V2 grammar; delivery-canvas fallback is forbidden.`);
    }
    // A nested LocalSpace is a materialization boundary owned by its own
    // planner. It cannot contribute a media leaf to this outer V2 tree.
    if (node.op === "cut.visual.local_space") {
      const semanticIdentity = hash({ role: "ordinary-local-raster", node: node.contentHash, traversalPath: path });
      tree.push(Object.freeze({
        inspectPreorder,
        traversalPath: Object.freeze([...path]),
        nodeId: node.id,
        op: node.op,
        childIds: Object.freeze([...node.children]),
        role: "ordinary-local-raster",
        semanticIdentity,
      }));
      return Object.freeze({ identity: semanticIdentity, compositorOperations: 0 });
    }

    visiting.add(node.id);
    const childResults = node.children.map((childId, index) => visit(childId, Object.freeze([...path, index])));
    visiting.delete(node.id);
    const ownOperation = retainedMediaLocalCompositorOps.has(node.op) ? 1 : 0;
    if (ownOperation) operationNodeIds.add(node.id);
    const semanticIdentity = hash({
      algorithmVersion: referenceRetainedMediaLocalCompositorAlgorithmVersion,
      node: {
        op: node.op,
        domain: node.domain,
        inputs: node.inputs,
        properties: node.properties,
        effects: node.effects,
        interval: node.interval,
        ownership: node.ownership,
      },
      signals: signalIdentities(node),
      traversalPath: path,
      children: node.children.map((childId, index) => ({ childId, identity: childResults[index]!.identity })),
    });
    tree.push(Object.freeze({
      inspectPreorder,
      traversalPath: Object.freeze([...path]),
      nodeId: node.id,
      op: node.op,
      childIds: Object.freeze([...node.children]),
      role: retainedMediaLocalCompositorOps.has(node.op) || node.op === "cut.visual.group" || node.op === "cut.kernel.fragment"
        ? "wrapper"
        : "ordinary-local-raster",
      semanticIdentity,
    }));
    return Object.freeze({ identity: semanticIdentity, compositorOperations: ownOperation + childResults.reduce((sum, child) => sum + child.compositorOperations, 0) });
  };

  const roots = Object.freeze(v2RootIds.map((rootId) => {
    const sourceOrder = localSpace.children.indexOf(rootId), result = visit(rootId, Object.freeze([sourceOrder]));
    const root = ir.nodes[rootId]!;
    if (result.compositorOperations < 1) {
      fail(root, "CUT_RETAINED_MEDIA_VIEWPORT_GRAPH", "a media-bearing V2 direct child requires at least one admitted Composite/Mask/ClipPath/finishing wrapper; Group-only multi-media topology remains unsupported.");
    }
    return Object.freeze({ sourceOrder, rootId, traversalPath: Object.freeze([sourceOrder]), semanticIdentity: result.identity });
  }));
  if (islands.length < 1) fail(localSpace, "CUT_RETAINED_MEDIA_VIEWPORT_GRAPH", "V2 compositor discovery produced no maximal retained-media islands.");
  if (islands.length + (legacyComposition?.branches.length ?? 0) > referenceRetainedMediaViewportLimits.maximumBranchesPerLocalSpace) {
    fail(localSpace, "CUT_RETAINED_MEDIA_VIEWPORT_LIMIT", `retained-media materialization count ${islands.length + (legacyComposition?.branches.length ?? 0)} exceeds ${referenceRetainedMediaViewportLimits.maximumBranchesPerLocalSpace} per LocalSpace.`);
  }
  const v2Roots = new Set(v2RootIds);
  const sourceOverSteps = referenceRetainedMediaLocalCompositorSourceOverSteps(ir, localSpace);
  if (sourceOverSteps > referenceRetainedMediaViewportLimits.maximumLocalCompositorSourceOverSteps) {
    fail(localSpace, "CUT_RETAINED_MEDIA_VIEWPORT_LIMIT", `whole-LocalSpace source-over step count ${sourceOverSteps} exceeds ${referenceRetainedMediaViewportLimits.maximumLocalCompositorSourceOverSteps}.`);
  }
  const directChildren = Object.freeze(localSpace.children.map((childId, sourceOrder) => {
    const child = ir.nodes[childId];
    if (!child) fail(localSpace, "CUT_RETAINED_MEDIA_VIEWPORT_GRAPH", `direct child ${childId} is missing.`);
    return Object.freeze({
      sourceOrder,
      childId,
      childContentHash: child.contentHash,
      role: legacyRoots.has(childId) ? "legacy-retained-media-island" as const
        : v2Roots.has(childId) ? "retained-media-compositor-v2" as const
          : "ordinary-local-raster" as const,
    });
  }));
  const authoredTree = Object.freeze([...tree].sort((left, right) => left.inspectPreorder - right.inspectPreorder));
  const wrapperTreeIdentity = hash({
    algorithmVersion: referenceRetainedMediaLocalCompositorAlgorithmVersion,
    localSpaceNodeId: localSpace.id,
    dimensions: viewport,
    directChildren,
    roots,
    islands: islands.map((island) => ({ traversalPath: island.traversalPath, rootId: island.rootId, planIdentity: island.plan.semanticIdentity })),
    tree: authoredTree,
  });
  return Object.freeze({
    algorithmVersion: referenceRetainedMediaLocalCompositorAlgorithmVersion,
    localSpaceNodeId: localSpace.id,
    dimensions: Object.freeze({ ...viewport }),
    directChildren,
    roots,
    islands: Object.freeze([...islands].sort((left, right) => left.inspectPreorder - right.inspectPreorder)),
    tree: authoredTree,
    materializationNodeIds,
    operationNodeIds,
    ...(legacyComposition ? { legacyCompositionPlanIdentity: legacyComposition.semanticIdentity } : {}),
    wrapperTreeIdentity,
    sourceOverSteps,
    conservativeTileSurfaces: authoredTree.length + 1,
  });
}

export function finalizeReferenceRetainedMediaLocalCompositorPlan(
  discovery: ReferenceRetainedMediaLocalCompositorDiscovery,
  localOperations: readonly Readonly<{ nodeId: string; op: string; semanticIdentity: string; estimatedPixelWorkPerFrame: number }>[],
  diagnosticNode: IRNode,
): ReferenceRetainedMediaLocalCompositorPlan {
  const sourceOperations = localOperations.filter((operation) => discovery.operationNodeIds.has(operation.nodeId));
  if (sourceOperations.length !== discovery.operationNodeIds.size) {
    fail(diagnosticNode, "CUT_RETAINED_MEDIA_VIEWPORT_GRAPH", "V2 compositor discovery and admitted local-operation plan diverged.");
  }
  const sourceOperationByNode = new Map(sourceOperations.map((operation) => [operation.nodeId, operation]));
  const treeByNode = new Map(discovery.tree.map((entry) => [entry.nodeId, entry]));
  const executionNodeIds: string[] = [], visitedExecutionNodes = new Set<string>();
  const visitExecutionPostorder = (nodeId: string) => {
    const treeNode = treeByNode.get(nodeId);
    if (!treeNode || treeNode.role === "materialization-island") return;
    for (const childId of treeNode.childIds) visitExecutionPostorder(childId);
    if (!sourceOperationByNode.has(nodeId)) return;
    if (visitedExecutionNodes.has(nodeId)) {
      fail(diagnosticNode, "CUT_RETAINED_MEDIA_VIEWPORT_GRAPH", `V2 compositor operation ${nodeId} appears more than once in the authored tree.`);
    }
    visitedExecutionNodes.add(nodeId);
    executionNodeIds.push(nodeId);
  };
  for (const root of [...discovery.roots].sort((left, right) => left.sourceOrder - right.sourceOrder)) {
    visitExecutionPostorder(root.rootId);
  }
  if (executionNodeIds.length !== sourceOperations.length) {
    fail(diagnosticNode, "CUT_RETAINED_MEDIA_VIEWPORT_GRAPH", "V2 compositor could not derive one complete child-first operation execution plan from its authored tree.");
  }
  const operationExecutionPlan = Object.freeze(executionNodeIds.map((nodeId, executionPostorder) => {
    const operation = sourceOperationByNode.get(nodeId)!, treeNode = treeByNode.get(nodeId)!;
    return Object.freeze({
      inspectPreorder: treeNode.inspectPreorder,
      traversalPath: Object.freeze([...treeNode.traversalPath]),
      executionPostorder,
      nodeId: operation.nodeId,
      op: operation.op,
      semanticIdentity: operation.semanticIdentity,
      estimatedPixelWorkPerFrame: operation.estimatedPixelWorkPerFrame,
    });
  }));
  const operationInspectionPlan = Object.freeze([...operationExecutionPlan]
    .sort((left, right) => left.inspectPreorder - right.inspectPreorder));
  const operationInspectionPlanIdentity = hash({
    algorithmVersion: referenceRetainedMediaLocalCompositorAlgorithmVersion,
    order: "authored-preorder",
    operations: operationInspectionPlan,
  });
  const operationExecutionPlanIdentity = hash({
    algorithmVersion: referenceRetainedMediaLocalCompositorAlgorithmVersion,
    order: "child-first-postorder",
    operations: operationExecutionPlan,
  });
  const media = discovery.islands.reduce((sum, island) => ({
    mediaLeaves: sum.mediaLeaves + 1,
    nativePixels: sum.nativePixels + island.plan.native.width * island.plan.native.height,
    croppedPixels: sum.croppedPixels + island.plan.cropped.width * island.plan.cropped.height,
    fittedPixels: sum.fittedPixels + island.plan.fitted.width * island.plan.fitted.height,
    mediaViewportPixels: sum.mediaViewportPixels + island.plan.viewport.width * island.plan.viewport.height,
    mediaViewportRgbaBytes: sum.mediaViewportRgbaBytes + island.plan.viewport.width * island.plan.viewport.height * 4,
    maximumPixelWorkPerFrame: sum.maximumPixelWorkPerFrame + island.plan.maximumPixelWorkPerFrame,
  }), { mediaLeaves: 0, nativePixels: 0, croppedPixels: 0, fittedPixels: 0, mediaViewportPixels: 0, mediaViewportRgbaBytes: 0, maximumPixelWorkPerFrame: 0 });
  const tilePixels = discovery.dimensions.width * discovery.dimensions.height;
  const operatorPixelWorkPerFrame = operationExecutionPlan.reduce((sum, operation) => sum + operation.estimatedPixelWorkPerFrame, 0);
  const sourceOverPixelPasses = discovery.sourceOverSteps * tilePixels;
  const conservativePeakRgbaBytes = discovery.conservativeTileSurfaces * tilePixels * 4
    + media.croppedPixels * 4 + media.fittedPixels * 4;
  const totals = Object.freeze({
    ...media,
    operatorPixelWorkPerFrame,
    sourceOverSteps: discovery.sourceOverSteps,
    sourceOverPixelPasses,
    conservativePeakTileSurfaces: discovery.conservativeTileSurfaces,
    conservativePeakRgbaBytes,
    maximumPixelWorkPerFrame: media.maximumPixelWorkPerFrame + operatorPixelWorkPerFrame + sourceOverPixelPasses,
  });
  if (Object.values(totals).some((value) => !Number.isSafeInteger(value) || value < 0)) {
    fail(diagnosticNode, "CUT_RETAINED_MEDIA_VIEWPORT_LIMIT", "V2 compositor accounting exceeds the safe integer range.");
  }
  if (totals.conservativePeakRgbaBytes > referenceRetainedMediaViewportLimits.maximumLocalCompositorPeakRgbaBytes) {
    fail(diagnosticNode, "CUT_RETAINED_MEDIA_VIEWPORT_LIMIT", `V2 compositor conservative peak RGBA bytes ${totals.conservativePeakRgbaBytes} exceeds ${referenceRetainedMediaViewportLimits.maximumLocalCompositorPeakRgbaBytes}.`);
  }
  if (totals.maximumPixelWorkPerFrame > referenceRetainedMediaViewportLimits.maximumAggregatePixelWorkPerFrame) {
    fail(diagnosticNode, "CUT_RETAINED_MEDIA_VIEWPORT_LIMIT", `V2 compositor pixel work ${totals.maximumPixelWorkPerFrame} exceeds ${referenceRetainedMediaViewportLimits.maximumAggregatePixelWorkPerFrame}.`);
  }
  const semantic = Object.freeze({
    algorithmVersion: referenceRetainedMediaLocalCompositorAlgorithmVersion,
    backendIdentity: referenceRetainedMediaViewportBackendIdentity,
    localSpaceNodeId: discovery.localSpaceNodeId,
    dimensions: discovery.dimensions,
    directChildren: discovery.directChildren,
    roots: discovery.roots,
    islandPlanIdentities: discovery.islands.map((island) => island.plan.semanticIdentity),
    wrapperTreeIdentity: discovery.wrapperTreeIdentity,
    inspectOrder: "authored-preorder",
    executionOrder: "child-first-postorder",
    operationInspectionPlan,
    operationInspectionPlanIdentity,
    operationExecutionPlan,
    operationExecutionPlanIdentity,
    ...(discovery.legacyCompositionPlanIdentity
      ? { legacyCompositionPlanIdentity: discovery.legacyCompositionPlanIdentity }
      : {}),
    totals,
    deliveryPreraster: "forbidden",
  });
  return Object.freeze({
    algorithmVersion: referenceRetainedMediaLocalCompositorAlgorithmVersion,
    localSpaceNodeId: discovery.localSpaceNodeId,
    dimensions: discovery.dimensions,
    directChildren: discovery.directChildren,
    roots: discovery.roots,
    islands: discovery.islands,
    tree: discovery.tree,
    wrapperTreeIdentity: discovery.wrapperTreeIdentity,
    inspectOrder: "authored-preorder",
    executionOrder: "child-first-postorder",
    operationInspectionPlan,
    operationExecutionPlan,
    operationInspectionPlanIdentity,
    operationExecutionPlanIdentity,
    ...(discovery.legacyCompositionPlanIdentity
      ? { legacyCompositionPlanIdentity: discovery.legacyCompositionPlanIdentity }
      : {}),
    totals,
    semanticIdentity: hash(semantic),
  });
}

/** Plan every direct retained-media sibling plus ordinary local-raster
 * siblings in authored source order. Planning is metadata-only: aggregate
 * decode/fit/viewport/work limits close before any source or decoder opens. */
export function referenceRetainedMediaCompositionPlan(
  ir: CutAVIR,
  localSpace: IRNode,
  viewport: Readonly<{ width: number; height: number }>,
): ReferenceRetainedMediaCompositionPlan | undefined {
  // Preserve the historical planner as a set of maximal old islands. A root
  // whose media is surrounded by a new local compositor belongs to the V2
  // planner below; it must never be rerouted through or mutate this v1 path.
  const mediaRoots = localSpace.children.filter((id) => referenceSubtreeContainsRetainedMedia(ir, id)
    && referenceRetainedMediaLegacyUnaryCandidateRoot(ir, id));
  if (mediaRoots.length === 0) return undefined;
  if (mediaRoots.length > referenceRetainedMediaViewportLimits.maximumBranchesPerLocalSpace) {
    fail(localSpace, "CUT_RETAINED_MEDIA_VIEWPORT_LIMIT", `direct retained-media branch count ${mediaRoots.length} exceeds ${referenceRetainedMediaViewportLimits.maximumBranchesPerLocalSpace}.`);
  }
  const branches = Object.freeze(mediaRoots.map((rootId) => referenceRetainedMediaBranchPlan(ir, localSpace, rootId, viewport)));
  const branchByRoot = new Map(branches.map((branch) => [branch.rootId, branch]));
  const children = Object.freeze(localSpace.children.map((childId, sourceOrder) => {
    const branch = branchByRoot.get(childId);
    const child = ir.nodes[childId];
    if (!child) fail(localSpace, "CUT_RETAINED_MEDIA_VIEWPORT_GRAPH", `direct composition child ${childId} is missing.`);
    return Object.freeze({
      sourceOrder,
      childId,
      childContentHash: child.contentHash,
      role: branch ? "retained-media" as const : "ordinary-local-raster" as const,
      ...(branch ? { branchIdentity: branch.semanticIdentity } : {}),
    });
  }));
  const branchTotals = branches.reduce((sum, branch) => ({
    branches: sum.branches + 1,
    nativePixels: sum.nativePixels + branch.native.width * branch.native.height,
    croppedPixels: sum.croppedPixels + branch.cropped.width * branch.cropped.height,
    fittedPixels: sum.fittedPixels + branch.fitted.width * branch.fitted.height,
    viewportSurfaces: sum.viewportSurfaces + 1,
    viewportPixels: sum.viewportPixels + branch.viewport.width * branch.viewport.height,
    viewportRgbaBytes: sum.viewportRgbaBytes + branch.viewport.width * branch.viewport.height * 4,
    maximumPixelWorkPerFrame: sum.maximumPixelWorkPerFrame + branch.maximumPixelWorkPerFrame,
  }), {
    branches: 0,
    nativePixels: 0,
    croppedPixels: 0,
    fittedPixels: 0,
    viewportSurfaces: 0,
    viewportPixels: 0,
    viewportRgbaBytes: 0,
    maximumPixelWorkPerFrame: 0,
  });
  const totals = Object.freeze({
    ...branchTotals,
    sourceOverPixelPasses: branchTotals.viewportPixels,
    maximumPixelWorkPerFrame: branchTotals.maximumPixelWorkPerFrame + branchTotals.viewportPixels,
  });
  const invalidTotal = Object.values(totals).some((value) => !Number.isSafeInteger(value) || value < 0);
  if (invalidTotal) fail(localSpace, "CUT_RETAINED_MEDIA_VIEWPORT_LIMIT", "aggregate retained-media branch accounting exceeds the safe integer range.");
  const exceeded = [
    ["native pixels", totals.nativePixels, referenceRetainedMediaViewportLimits.maximumAggregateNativePixels],
    ["decoded crop pixels", totals.croppedPixels, referenceRetainedMediaViewportLimits.maximumAggregateCroppedPixels],
    ["fitted pixels", totals.fittedPixels, referenceRetainedMediaViewportLimits.maximumAggregateFitPixels],
    ["viewport RGBA bytes", totals.viewportRgbaBytes, referenceRetainedMediaViewportLimits.maximumAggregateViewportRgbaBytes],
    ["pixel-passes per frame", totals.maximumPixelWorkPerFrame, referenceRetainedMediaViewportLimits.maximumAggregatePixelWorkPerFrame],
  ] as const;
  const violation = exceeded.find(([, actual, maximum]) => actual > maximum);
  if (violation) {
    fail(localSpace, "CUT_RETAINED_MEDIA_VIEWPORT_LIMIT", `aggregate retained-media ${violation[0]} ${violation[1]} exceeds ${violation[2]}; reduce branches, crop, source dimensions, fit expansion, or viewport size.`);
  }
  const semantic = Object.freeze({
    algorithmVersion: referenceRetainedMediaCompositionAlgorithmVersion,
    backendIdentity: referenceRetainedMediaViewportBackendIdentity,
    localSpaceNodeId: localSpace.id,
    children,
    branchIdentities: branches.map((branch) => branch.semanticIdentity),
    totals,
    alpha: "straight-rgba8-source-over",
    compositionPreraster: "forbidden",
  });
  return Object.freeze({
    algorithmVersion: referenceRetainedMediaCompositionAlgorithmVersion,
    localSpaceNodeId: localSpace.id,
    children,
    branches,
    totals,
    semanticIdentity: hash(semantic),
  });
}

/** Historical singular planner. Keep the exact one-child public contract and
 * v1 branch identity for callers that explicitly request it. LocalSpace uses
 * the additive ordered composition planner for sibling-capable execution. */
export function referenceRetainedMediaViewportPlan(
  ir: CutAVIR,
  localSpace: IRNode,
  viewport: Readonly<{ width: number; height: number }>,
): ReferenceRetainedMediaViewportPlan | undefined {
  const composition = referenceRetainedMediaCompositionPlan(ir, localSpace, viewport);
  if (!composition) return undefined;
  if (localSpace.children.length !== 1 || composition.branches.length !== 1) {
    fail(localSpace, "CUT_RETAINED_MEDIA_VIEWPORT_GRAPH", "the singular retained-media planner requires one exact direct branch; use the ordered LocalSpace composition plan for media plus local overlays or multiple media siblings.");
  }
  return composition.branches[0];
}

export function referenceRetainedMediaViewportStateAt(
  ir: CutAVIR,
  composition: IRComposition,
  plan: ReferenceRetainedMediaViewportPlan,
  time: Rational,
  preparedSignalResolver?: ReferencePreparedSignalResolver,
): ReferenceRetainedMediaViewportState {
  let affine = referenceIdentityAffine2D, opacity = 1;
  for (const nodeId of plan.nodeIds) {
    const node = ir.nodes[nodeId];
    if (!node || !active(node, time)) {
      const sourceToViewport = composeReferenceAffine2D(affine, {
        a: 1, b: 0, c: 0, d: 1,
        tx: (plan.viewport.width - plan.fitted.width) / 2,
        ty: (plan.viewport.height - plan.fitted.height) / 2,
      });
      return Object.freeze({ active: false, hidden: false, opacity: 0, affine, sourceToViewport, sourceBounds: referenceRect(0, 0, plan.fitted.width, plan.fitted.height), workIdentity: hash({ plan: plan.semanticIdentity, time, active: false }) });
    }
    const transform = referenceVisualTransformAt(ir, composition, node, time, { staticPosition: true, staticRotation: true }, preparedSignalResolver);
    affine = composeReferenceAffine2D(affine, referenceRetainedVisualAffine(composition, transform));
    opacity *= transform.opacity;
  }
  const base = { a: 1, b: 0, c: 0, d: 1, tx: (plan.viewport.width - plan.fitted.width) / 2, ty: (plan.viewport.height - plan.fitted.height) / 2 } as const;
  const sourceToViewport = quantizedAffine(
    ir.nodes[plan.rootId] ?? ir.nodes[plan.leafId]!,
    composeReferenceAffine2D(affine, base),
  );
  const sourceBounds = referenceRect(0, 0, plan.fitted.width, plan.fitted.height);
  const visible = intersectReferenceRects(transformReferenceRect(sourceBounds, sourceToViewport), referenceRect(0, 0, plan.viewport.width, plan.viewport.height));
  const outputBounds = visible ? referenceIntegerRasterBounds(visible) : undefined;
  return Object.freeze({
    active: true,
    hidden: opacity === 0 || !outputBounds,
    opacity,
    affine,
    sourceToViewport,
    sourceBounds,
    ...(outputBounds ? { outputBounds } : {}),
    workIdentity: hash({
      algorithmVersion: referenceRetainedMediaViewportAlgorithmVersion,
      plan: plan.semanticIdentity,
      time: `${time.numerator}/${time.denominator}`,
      affine,
      sourceToViewport,
      opacity,
      outputBounds,
    }),
  });
}

function sourceSample(surface: ReferenceRetainedMediaViewportSurface, x: number, y: number, channel: number) {
  if (x < 0 || y < 0 || x >= surface.width || y >= surface.height) return 0;
  return surface.data[(y * surface.width + x) * 4 + channel]!;
}

/** One final-viewport inverse affine. RGB interpolation is alpha-associated;
 * output is straight RGBA and hidden RGB is cleared. Matrix coefficients and
 * sample coordinates are quantized to Q16 before filtering. */
function rasterReferenceRetainedMediaViewport(
  source: ReferenceRetainedMediaViewportSurface,
  plan: ReferenceRetainedMediaViewportPlan,
  state: ReferenceRetainedMediaViewportState,
  diagnosticNode: IRNode,
  runtime: Readonly<{
    compositionId: string;
    exactTime: Rational;
    outputFrame: string;
    sourceOpens: number;
    decodedFramesRead: number;
    decodedSurfaces: number;
    colorGradeSurfaces: number;
    fittedSurfaces: 0 | 1;
  }>,
  diagnostic?: ReferenceRetainedMediaViewportQ16TapDiagnostic,
) {
  if (source.width !== plan.fitted.width || source.height !== plan.fitted.height || source.data.byteLength !== source.width * source.height * 4) {
    fail(diagnosticNode, "CUT_RETAINED_MEDIA_VIEWPORT_RASTER", `fitted source dimensions or RGBA bytes disagree with the admitted ${plan.fitted.width}x${plan.fitted.height}x4 plan.`);
  }
  const diagnosticCounters = diagnostic
    ? retainedMediaViewportQ16TapDiagnosticAuthority.get(diagnostic)
    : undefined;
  if (diagnostic && !diagnosticCounters) {
    fail(
      diagnosticNode,
      "CUT_RETAINED_MEDIA_VIEWPORT_RASTER",
      "Q16 tap diagnostic authority was not issued by this runtime.",
    );
  }
  const output = new Uint8Array(plan.viewport.width * plan.viewport.height * 4);
  const outputSupport = {
    left: plan.viewport.width,
    top: plan.viewport.height,
    right: 0,
    bottom: 0,
    nonzeroAlphaPixels: 0,
  };
  const complete = (alphaBytesObserved: number, destinationPixelsVisited: number) => {
    const empty = outputSupport.nonzeroAlphaPixels === 0;
    publishReferenceRetainedSurfaceExactAlphaSupport(
      { data: output, width: plan.viewport.width, height: plan.viewport.height },
      Object.freeze({
        empty,
        left: empty ? 0 : outputSupport.left,
        top: empty ? 0 : outputSupport.top,
        right: empty ? 0 : outputSupport.right,
        bottom: empty ? 0 : outputSupport.bottom,
        nonzeroAlphaPixels: outputSupport.nonzeroAlphaPixels,
      }),
      alphaBytesObserved,
      destinationPixelsVisited,
    );
    const executionAuthority = Object.freeze({});
    retainedMediaViewportRasterAuthorities.set(executionAuthority, Object.freeze({
      planIdentity: plan.semanticIdentity,
      compositionId: runtime.compositionId,
      exactTime: Object.freeze({ ...runtime.exactTime }),
      outputFrame: runtime.outputFrame,
      state: Object.freeze({ ...state, ...(state.outputBounds ? { outputBounds: Object.freeze({ ...state.outputBounds }) } : {}) }),
      sourceOpens: runtime.sourceOpens,
      decodedFramesRead: runtime.decodedFramesRead,
      decodedSurfaces: runtime.decodedSurfaces,
      colorGradeSurfaces: runtime.colorGradeSurfaces,
      fittedSurfaces: runtime.fittedSurfaces,
      outputRgbaSha256: createHash("sha256").update(output).digest("hex"),
      outputWidth: plan.viewport.width,
      outputHeight: plan.viewport.height,
    }));
    return Object.freeze({ data: output, width: plan.viewport.width, height: plan.viewport.height, executionAuthority });
  };
  if (!state.active || state.hidden || !state.outputBounds || state.opacity === 0) {
    const completed = complete(0, 0);
    if (diagnosticCounters) {
      diagnosticCounters.rasterRequests += 1;
      diagnosticCounters.skippedRasterRequests += 1;
    }
    return completed;
  }
  const units = referenceRetainedMediaViewportQ16Units;
  const samplingTransform = referenceRetainedMediaViewportQ16SamplingTransform(state.sourceToViewport);
  if (!samplingTransform) {
    fail(diagnosticNode, "CUT_RETAINED_MEDIA_VIEWPORT_RASTER", "affine is singular after the normative Q16 quantization.");
  }
  const { left, top, right, bottom } = state.outputBounds;
  const rasterLeft = Math.max(0, left), rasterTop = Math.max(0, top);
  const rasterRight = Math.min(plan.viewport.width, right);
  const rasterBottom = Math.min(plan.viewport.height, bottom);
  const forcedAllocatedControl = diagnostic?.mode === "forced-allocated-control";
  const native = !forcedAllocatedControl
    ? executeReferenceNativeRetainedMediaViewportRaster({
      source: source.data,
      output,
      sourceWidth: source.width,
      sourceHeight: source.height,
      outputWidth: plan.viewport.width,
      outputHeight: plan.viewport.height,
      bounds: Object.freeze({
        left: rasterLeft,
        top: rasterTop,
        right: rasterRight,
        bottom: rasterBottom,
      }),
      affine: samplingTransform.affine,
      inverse: samplingTransform.inverse,
      opacity: state.opacity,
    })
    : undefined;
  const visibleDestinationPixels = Math.max(0, rasterRight - rasterLeft)
    * Math.max(0, rasterBottom - rasterTop);
  if (native) {
    if (native.tapEvaluations !== visibleDestinationPixels * 4
      || native.zeroWeightTaps > native.tapEvaluations
      || native.outputPixelsWritten > visibleDestinationPixels) {
      fail(diagnosticNode, "CUT_RETAINED_MEDIA_VIEWPORT_RASTER", "native Q16 raster returned inconsistent bounded work counters.");
    }
    outputSupport.left = native.support.left;
    outputSupport.top = native.support.top;
    outputSupport.right = native.support.right;
    outputSupport.bottom = native.support.bottom;
    outputSupport.nonzeroAlphaPixels = native.support.nonzeroAlphaPixels;
    const completed = complete(native.alphaTapReads, visibleDestinationPixels);
    if (diagnosticCounters) {
      diagnosticCounters.rasterRequests += 1;
      diagnosticCounters.visibleRasterRequests += 1;
      diagnosticCounters.visibleDestinationPixels += visibleDestinationPixels;
      diagnosticCounters.nativePixels += visibleDestinationPixels;
      diagnosticCounters.tapEvaluations += native.tapEvaluations;
      diagnosticCounters.zeroWeightTaps += native.zeroWeightTaps;
      diagnosticCounters.outputPixelsWritten += native.outputPixelsWritten;
      diagnosticCounters.nativeExecutions += 1;
    }
    return completed;
  }
  const scratch = forcedAllocatedControl
    ? undefined
    : createReferenceRetainedMediaViewportQ16TapScratch();
  let allocatedControlPixels = 0;
  let reusableScratchPixels = 0;
  let tapEvaluations = 0;
  let alphaTapReads = 0;
  let zeroWeightTaps = 0;
  let outputPixelsWritten = 0;
  if (diagnosticCounters) diagnosticCounters.scalarExecutions += 1;
  for (let y = rasterTop; y < rasterBottom; y += 1) {
    for (let x = rasterLeft; x < rasterRight; x += 1) {
      const taps = forcedAllocatedControl
        ? referenceRetainedMediaViewportQ16BilinearTapsAt(samplingTransform, x, y)
        : populateReferenceRetainedMediaViewportQ16BilinearTapScratch(
          samplingTransform,
          x,
          y,
          scratch!,
        ).taps;
      if (diagnosticCounters) {
        if (forcedAllocatedControl) allocatedControlPixels += 1;
        else reusableScratchPixels += 1;
      }
      let alpha = 0, red = 0, green = 0, blue = 0;
      for (const [weightQ, sampleX, sampleY] of taps) {
        if (diagnosticCounters) tapEvaluations += 1;
        if (weightQ === 0) {
          if (diagnosticCounters) zeroWeightTaps += 1;
          continue;
        }
        const weight = weightQ / units ** 2;
        if (sampleX < 0 || sampleY < 0 || sampleX >= source.width || sampleY >= source.height) continue;
        const a = sourceSample(source, sampleX, sampleY, 3);
        alphaTapReads += 1;
        alpha += a * weight;
        red += sourceSample(source, sampleX, sampleY, 0) * a * weight;
        green += sourceSample(source, sampleX, sampleY, 1) * a * weight;
        blue += sourceSample(source, sampleX, sampleY, 2) * a * weight;
      }
      const scaledAlpha = Math.round(Math.max(0, Math.min(255, alpha * state.opacity)));
      if (scaledAlpha === 0 || alpha <= 0) continue;
      const offset = (y * plan.viewport.width + x) * 4;
      output[offset] = Math.round(Math.max(0, Math.min(255, red / alpha)));
      output[offset + 1] = Math.round(Math.max(0, Math.min(255, green / alpha)));
      output[offset + 2] = Math.round(Math.max(0, Math.min(255, blue / alpha)));
      output[offset + 3] = scaledAlpha;
      outputPixelsWritten += 1;
      outputSupport.nonzeroAlphaPixels += 1;
      if (x < outputSupport.left) outputSupport.left = x;
      if (y < outputSupport.top) outputSupport.top = y;
      if (x + 1 > outputSupport.right) outputSupport.right = x + 1;
      if (y + 1 > outputSupport.bottom) outputSupport.bottom = y + 1;
    }
  }
  const completed = complete(alphaTapReads, visibleDestinationPixels);
  if (diagnosticCounters) {
    diagnosticCounters.rasterRequests += 1;
    diagnosticCounters.visibleRasterRequests += 1;
    diagnosticCounters.visibleDestinationPixels += visibleDestinationPixels;
    diagnosticCounters.allocatedControlPixels += allocatedControlPixels;
    diagnosticCounters.reusableScratchPixels += reusableScratchPixels;
    diagnosticCounters.tapEvaluations += tapEvaluations;
    diagnosticCounters.zeroWeightTaps += zeroWeightTaps;
    diagnosticCounters.outputPixelsWritten += outputPixelsWritten;
    if (!forcedAllocatedControl) diagnosticCounters.scratchAllocations += 1;
  }
  return completed;
}

function referenceRetainedMediaViewportExecutionEvidence(input: Readonly<{
  plan: ReferenceRetainedMediaViewportPlan;
  executionAuthority: object;
}>): ReferenceRetainedMediaViewportExecutionEvidence {
  const { plan } = input;
  const authority = retainedMediaViewportRasterAuthorities.get(input.executionAuthority);
  retainedMediaViewportRasterAuthorities.delete(input.executionAuthority);
  if (!authority || authority.planIdentity !== plan.semanticIdentity
    || authority.outputWidth !== plan.viewport.width || authority.outputHeight !== plan.viewport.height
    || !authority.state.active || authority.state.hidden || authority.state.opacity === 0 || !authority.state.outputBounds) {
    throw new Error("CUT_RETAINED_MEDIA_VIEWPORT_RASTER: viewport receipt construction requires one unconsumed live raster execution authority for the exact admitted plan.");
  }
  const state = authority.state as ReferenceRetainedMediaViewportState & { outputBounds: ReferenceIntegerRasterBounds };
  const cropPixels = plan.cropped.width * plan.cropped.height;
  const fittedPixels = plan.fitted.width * plan.fitted.height;
  const viewportPixels = plan.viewport.width * plan.viewport.height;
  const receipt = Object.freeze({
    format: "cut-reference-retained-media-viewport-frame-evidence" as const,
    version: 1 as const,
    evidenceKind: "completed-frame-execution" as const,
    algorithmVersion: referenceRetainedMediaViewportAlgorithmVersion,
    backendIdentity: referenceRetainedMediaViewportBackendIdentity,
    compositionId: authority.compositionId,
    localSpaceNodeId: plan.localSpaceNodeId,
    rootId: plan.rootId,
    leafId: plan.leafId,
    leafKind: plan.leafKind,
    exactTime: Object.freeze({ ...authority.exactTime }),
    outputFrame: authority.outputFrame,
    source: Object.freeze({
      resourceId: plan.sourceId,
      sha256: plan.sourceSha256,
      selectedVariant: plan.selectedVariant,
      ...(plan.videoExecution ? {
        video: Object.freeze({
          streamIndex: plan.videoExecution.streamIndex,
          inputColor: plan.videoExecution.config.inputColor,
          configIdentity: plan.videoExecution.configIdentity,
          ...(plan.videoExecution.cadenceIdentity ? { cadenceIdentity: plan.videoExecution.cadenceIdentity } : {}),
        }),
      } : {}),
    }),
    geometry: Object.freeze({
      native: Object.freeze({ ...plan.native }),
      decodedCrop: Object.freeze({ ...plan.cropped }),
      fitted: Object.freeze({ ...plan.fitted }),
      viewport: Object.freeze({ ...plan.viewport }),
      outputBounds: Object.freeze({ ...state.outputBounds }),
      sourceToViewportQ16: Object.freeze({ ...state.sourceToViewport }),
    }),
    allocations: Object.freeze({
      sourceOpens: authority.sourceOpens,
      decodedFramesRead: authority.decodedFramesRead,
      decodedSurfaces: authority.decodedSurfaces,
      decodedRgbaBytes: authority.decodedSurfaces * cropPixels * 4,
      colorGradeSurfaces: authority.colorGradeSurfaces,
      colorGradeRgbaBytes: authority.colorGradeSurfaces * cropPixels * 4,
      fittedSurfaces: authority.fittedSurfaces,
      fittedRgbaBytes: authority.fittedSurfaces * fittedPixels * 4,
      viewportSurfaces: 1 as const,
      viewportRgbaBytes: viewportPixels * 4,
      compositionPrerasterSurfaces: 0 as const,
      compositionPrerasterRgbaBytes: 0 as const,
    }),
    work: Object.freeze({
      planIdentity: plan.semanticIdentity,
      workIdentity: state.workIdentity,
      planMaximumPixelPasses: plan.maximumPixelWorkPerFrame,
      fitResampleInvocations: authority.fittedSurfaces,
      affineResampleInvocations: 1 as const,
      totalResampleInvocations: (authority.fittedSurfaces + 1) as 1 | 2,
      affineDestinationPixels: state.outputBounds.pixels,
    }),
    outputRgbaSha256: authority.outputRgbaSha256,
  });
  const completed = Object.freeze({ ...receipt, executionIdentity: hash(receipt) });
  authorizedRetainedMediaViewportReceipts.add(completed);
  return completed;
}

/** The only public receipt-producing viewport path. Raster pixels, geometry,
 * work, counters and output hash are captured in one one-shot execution; the
 * lower-level receipt constructor is deliberately module-private. */
export function executeReferenceRetainedMediaViewportFrame(input: Readonly<{
  source: ReferenceRetainedMediaViewportSurface;
  plan: ReferenceRetainedMediaViewportPlan;
  state: ReferenceRetainedMediaViewportState;
  diagnosticNode: IRNode;
  diagnostic?: ReferenceRetainedMediaViewportQ16TapDiagnostic;
  runtime: Readonly<{
    compositionId: string;
    exactTime: Rational;
    outputFrame: string;
    sourceOpens: number;
    decodedFramesRead: number;
    decodedSurfaces: number;
    colorGradeSurfaces: number;
    fittedSurfaces: 0 | 1;
  }>;
}>) {
  if (input.plan.resample === "cut-q16-associated-bilinear-direct-affine" && input.runtime.fittedSurfaces !== 0) {
    fail(input.diagnosticNode, "CUT_RETAINED_MEDIA_VIEWPORT_RASTER", "direct-affine sampling forbids a preliminary fit resample.");
  }
  const raster = rasterReferenceRetainedMediaViewport(
    input.source,
    input.plan,
    input.state,
    input.diagnosticNode,
    input.runtime,
    input.diagnostic,
  );
  const receipt = referenceRetainedMediaViewportExecutionEvidence({ plan: input.plan, executionAuthority: raster.executionAuthority });
  return Object.freeze({
    surface: Object.freeze({ data: raster.data, width: raster.width, height: raster.height }),
    receipt,
  });
}

function createReferenceRetainedMediaCompositionExecutionAuthority(input: Readonly<{
  compositionId: string;
  exactTime: Rational;
  outputFrame: string;
  plan: ReferenceRetainedMediaCompositionPlan;
  admission: Readonly<{ executionDomain: string; retainedBranchesInExecutionDomain: number }>;
  children: readonly ReferenceRetainedMediaCompositionLiveChild[];
  finalLocalTile: ReferenceRetainedMediaViewportSurface;
}>) {
  const viewport = input.plan.branches[0]?.viewport;
  if (!viewport || input.children.length !== input.plan.children.length
    || input.finalLocalTile.width !== viewport.width || input.finalLocalTile.height !== viewport.height
    || input.finalLocalTile.data.byteLength !== viewport.width * viewport.height * 4) {
    throw new Error("CUT_RETAINED_MEDIA_VIEWPORT_RASTER: live ordered-composition authority does not cover the admitted local tile.");
  }
  const branchReceiptsToConsume = new Set<ReferenceRetainedMediaViewportExecutionEvidence>();
  const paintOrder = Object.freeze(input.children.map(({ execution, surface, branchReceipt }, index) => {
    const planned = input.plan.children[index];
    if (!planned || planned.sourceOrder !== index || execution.sourceOrder !== index
      || planned.childId !== execution.childId || planned.childContentHash !== execution.childContentHash
      || planned.role !== execution.role) {
      throw new Error("CUT_RETAINED_MEDIA_VIEWPORT_RASTER: live ordered-composition authority diverges from its admitted direct-child plan.");
    }
    if (execution.status === "rendered") {
      if (!surface || surface.width !== viewport.width || surface.height !== viewport.height
        || surface.data.byteLength !== viewport.width * viewport.height * 4) {
        throw new Error("CUT_RETAINED_MEDIA_VIEWPORT_RASTER: rendered ordered-composition authority requires exact live child pixels.");
      }
      const rgbaSha256 = createHash("sha256").update(surface.data).digest("hex");
      if (execution.rgbaSha256 !== rgbaSha256) {
        throw new Error("CUT_RETAINED_MEDIA_VIEWPORT_RASTER: ordered-composition child receipt hash diverges from its live surface.");
      }
    } else if (surface) {
      throw new Error("CUT_RETAINED_MEDIA_VIEWPORT_RASTER: skipped ordered-composition authority cannot retain a live child surface.");
    }
    if (planned.role === "retained-media" && execution.status === "rendered") {
      const branch = input.plan.branches.find((candidate) => candidate.rootId === planned.childId);
      if (!branch || !branchReceipt || !authorizedRetainedMediaViewportReceipts.has(branchReceipt)
        || branchReceiptsToConsume.has(branchReceipt)
        || branchReceipt.executionIdentity !== execution.branchExecutionIdentity
        || branchReceipt.work.planIdentity !== branch.semanticIdentity
        || branchReceipt.outputRgbaSha256 !== execution.rgbaSha256
        || branchReceipt.rootId !== branch.rootId || branchReceipt.leafId !== branch.leafId) {
        throw new Error("CUT_RETAINED_MEDIA_VIEWPORT_RASTER: retained composition child lacks its exact authorized live branch receipt and pixels.");
      }
      branchReceiptsToConsume.add(branchReceipt);
    } else if (branchReceipt) {
      throw new Error("CUT_RETAINED_MEDIA_VIEWPORT_RASTER: skipped or ordinary composition child cannot claim a live retained-branch receipt.");
    }
    return Object.freeze({ ...execution });
  }));
  for (const branchReceipt of branchReceiptsToConsume) authorizedRetainedMediaViewportReceipts.delete(branchReceipt);
  const executionAuthority = Object.freeze({});
  retainedMediaCompositionAuthorities.set(executionAuthority, Object.freeze({
    planIdentity: input.plan.semanticIdentity,
    compositionId: input.compositionId,
    exactTime: Object.freeze({ ...input.exactTime }),
    outputFrame: input.outputFrame,
    admission: Object.freeze({ ...input.admission }),
    paintOrder,
    finalLocalTile: Object.freeze({
      width: input.finalLocalTile.width,
      height: input.finalLocalTile.height,
      rgbaSha256: createHash("sha256").update(input.finalLocalTile.data).digest("hex"),
    }),
  }));
  return executionAuthority;
}

function referenceRetainedMediaCompositionExecutionEvidence(input: Readonly<{
  plan: ReferenceRetainedMediaCompositionPlan;
  executionAuthority: object;
}>): ReferenceRetainedMediaCompositionExecutionEvidence {
  const authority = retainedMediaCompositionAuthorities.get(input.executionAuthority);
  retainedMediaCompositionAuthorities.delete(input.executionAuthority);
  if (!authority || authority.planIdentity !== input.plan.semanticIdentity) {
    throw new Error("CUT_RETAINED_MEDIA_VIEWPORT_RASTER: ordered-composition receipt construction requires one unconsumed live compositor authority for the exact admitted plan.");
  }
  if (authority.paintOrder.length !== input.plan.children.length) {
    throw new Error("CUT_RETAINED_MEDIA_VIEWPORT_RASTER: completed ordered composition evidence does not cover every admitted direct child.");
  }
  if (!Number.isSafeInteger(authority.admission.retainedBranchesInExecutionDomain)
    || authority.admission.retainedBranchesInExecutionDomain < input.plan.totals.branches
    || authority.admission.retainedBranchesInExecutionDomain > referenceRetainedMediaViewportLimits.maximumBranchesPerExecutionDomain) {
    throw new Error("CUT_RETAINED_MEDIA_VIEWPORT_RASTER: ordered composition execution-domain branch admission is invalid.");
  }
  for (let index = 0; index < input.plan.children.length; index += 1) {
    const planned = input.plan.children[index]!, executed = authority.paintOrder[index]!;
    if (planned.sourceOrder !== index || executed.sourceOrder !== index
      || planned.childId !== executed.childId || planned.childContentHash !== executed.childContentHash
      || planned.role !== executed.role) {
      throw new Error("CUT_RETAINED_MEDIA_VIEWPORT_RASTER: ordered composition execution diverged from its admitted child plan.");
    }
    if (executed.status === "rendered" && !executed.rgbaSha256) {
      throw new Error("CUT_RETAINED_MEDIA_VIEWPORT_RASTER: a rendered ordered-composition child is missing its RGBA identity.");
    }
    if (executed.status === "skipped" && (executed.rgbaSha256 || executed.branchExecutionIdentity)) {
      throw new Error("CUT_RETAINED_MEDIA_VIEWPORT_RASTER: a skipped ordered-composition child cannot claim pixels or completed branch execution.");
    }
    if (executed.role === "retained-media") {
      if (!executed.branchPlanIdentity || executed.branchPlanIdentity !== planned.branchIdentity) {
        throw new Error("CUT_RETAINED_MEDIA_VIEWPORT_RASTER: a retained child execution lost its admitted branch identity.");
      }
      if (executed.status === "rendered" && !executed.branchExecutionIdentity) {
        throw new Error("CUT_RETAINED_MEDIA_VIEWPORT_RASTER: a rendered retained child is missing its completed v1 branch receipt binding.");
      }
    } else if (executed.branchPlanIdentity || executed.branchExecutionIdentity) {
      throw new Error("CUT_RETAINED_MEDIA_VIEWPORT_RASTER: an ordinary local raster child cannot claim retained-branch identities.");
    }
  }
  const paintOrder = Object.freeze(authority.paintOrder.map((entry) => Object.freeze({ ...entry })));
  const renderedMediaViewportSurfaces = paintOrder.filter((entry) => entry.role === "retained-media" && entry.status === "rendered").length;
  const renderedOrdinaryLocalSurfaces = paintOrder.filter((entry) => entry.role === "ordinary-local-raster" && entry.status === "rendered").length;
  const receipt = Object.freeze({
    format: "cut-reference-retained-media-composition-frame-evidence" as const,
    version: 1 as const,
    evidenceKind: "completed-source-ordered-local-composition" as const,
    algorithmVersion: referenceRetainedMediaCompositionAlgorithmVersion,
    backendIdentity: referenceRetainedMediaViewportBackendIdentity,
    compositionId: authority.compositionId,
    localSpaceNodeId: input.plan.localSpaceNodeId,
    exactTime: Object.freeze({ ...authority.exactTime }),
    outputFrame: authority.outputFrame,
    planIdentity: input.plan.semanticIdentity,
    admission: Object.freeze({
      executionDomain: authority.admission.executionDomain,
      retainedBranchesInExecutionDomain: authority.admission.retainedBranchesInExecutionDomain,
      maximumBranchesPerExecutionDomain: referenceRetainedMediaViewportLimits.maximumBranchesPerExecutionDomain,
    }),
    paintOrder,
    allocations: Object.freeze({
      renderedMediaViewportSurfaces,
      renderedOrdinaryLocalSurfaces,
      localSourceOverSteps: renderedMediaViewportSurfaces + renderedOrdinaryLocalSurfaces,
      finalLocalTileSurfaces: 1 as const,
      compositionPrerasterSurfaces: 0 as const,
      compositionPrerasterRgbaBytes: 0 as const,
    }),
    plannedWork: Object.freeze({ ...input.plan.totals }),
    finalLocalTile: Object.freeze({ ...authority.finalLocalTile }),
  });
  const completed = Object.freeze({ ...receipt, executionIdentity: hash(receipt) });
  authorizedRetainedMediaCompositionReceipts.add(completed);
  return completed;
}

/** Execute the actual source-ordered local blend and issue its receipt from
 * the same live child surfaces/authorized branch receipts. Callers cannot
 * supply a final hash or invoke the receipt constructor independently. */
export function executeReferenceRetainedMediaComposition(input: Readonly<{
  compositionId: string;
  exactTime: Rational;
  outputFrame: string;
  plan: ReferenceRetainedMediaCompositionPlan;
  admission: Readonly<{ executionDomain: string; retainedBranchesInExecutionDomain: number }>;
  children: readonly ReferenceRetainedMediaCompositionLiveChild[];
}>) {
  const viewport = input.plan.branches[0]?.viewport;
  if (!viewport) throw new Error("CUT_RETAINED_MEDIA_VIEWPORT_RASTER: ordered composition has no admitted media viewport.");
  let surface: ReferenceRetainedMediaViewportSurface = Object.freeze({
    data: new Uint8Array(viewport.width * viewport.height * 4),
    width: viewport.width,
    height: viewport.height,
  });
  for (const child of input.children) {
    if (!child.surface) continue;
    surface = Object.freeze(compositeRgba(surface, child.surface, { mode: "normal" }));
  }
  const executionAuthority = createReferenceRetainedMediaCompositionExecutionAuthority({
    compositionId: input.compositionId,
    exactTime: input.exactTime,
    outputFrame: input.outputFrame,
    plan: input.plan,
    admission: input.admission,
    children: input.children,
    finalLocalTile: surface,
  });
  const receipt = referenceRetainedMediaCompositionExecutionEvidence({ plan: input.plan, executionAuthority });
  return Object.freeze({ surface, receipt });
}

export function referenceRetainedMediaLocalCompositorExecutionEvidence(input: Readonly<{
  compositionId: string;
  exactTime: Rational;
  outputFrame: string;
  plan: ReferenceRetainedMediaLocalCompositorPlan;
  directChildExecutions: readonly ReferenceRetainedMediaLocalCompositorDirectChildExecution[];
  executedSourceOverSteps: number;
  materializationExecutions: readonly ReferenceRetainedMediaLocalCompositorMaterializationExecution[];
  operationExecutions: readonly ReferenceRetainedMediaLocalCompositorOperationExecution[];
  legacyCompositionReceipt?: ReferenceRetainedMediaCompositionExecutionEvidence;
  finalLocalTile: Readonly<{ width: number; height: number; rgbaSha256: string }>;
}>): ReferenceRetainedMediaLocalCompositorExecutionEvidence {
  if (input.finalLocalTile.width !== input.plan.dimensions.width || input.finalLocalTile.height !== input.plan.dimensions.height) {
    throw new Error("CUT_RETAINED_MEDIA_VIEWPORT_RASTER: V2 compositor final tile dimensions diverge from the admitted LocalSpace.");
  }
  if (input.directChildExecutions.length !== input.plan.directChildren.length) {
    throw new Error("CUT_RETAINED_MEDIA_VIEWPORT_RASTER: V2 compositor direct-child execution evidence does not cover every admitted LocalSpace child.");
  }
  const directChildExecutions = Object.freeze(input.directChildExecutions.map((execution, index) => {
    const planned = input.plan.directChildren[index];
    const renderedFieldsValid = execution.status === "rendered"
      && typeof execution.rgbaSha256 === "string"
      && /^[a-f0-9]{64}$/u.test(execution.rgbaSha256)
      && execution.skipReason === undefined;
    const skippedFieldsValid = execution.status === "skipped"
      && execution.rgbaSha256 === undefined
      && execution.skipReason !== undefined;
    if (!planned || planned.sourceOrder !== index || execution.sourceOrder !== index
      || execution.childId !== planned.childId || execution.childContentHash !== planned.childContentHash
      || execution.role !== planned.role || (!renderedFieldsValid && !skippedFieldsValid)) {
      throw new Error("CUT_RETAINED_MEDIA_VIEWPORT_RASTER: V2 compositor direct-child execution diverges from its admitted source-ordered LocalSpace plan.");
    }
    return Object.freeze({ ...execution });
  }));
  const directChildSourceOverSteps = directChildExecutions.filter((child) => child.status === "rendered").length;
  if (!Number.isSafeInteger(input.executedSourceOverSteps)
    || input.executedSourceOverSteps < directChildSourceOverSteps
    || input.executedSourceOverSteps > input.plan.totals.sourceOverSteps) {
    throw new Error("CUT_RETAINED_MEDIA_VIEWPORT_RASTER: V2 compositor executed source-over count exceeds or undercuts its admitted source-ordered work.");
  }
  const plannedOperations = input.plan.operationExecutionPlan;
  if (input.operationExecutions.length !== plannedOperations.length) {
    throw new Error("CUT_RETAINED_MEDIA_VIEWPORT_RASTER: V2 compositor operation evidence is incomplete for the admitted child-first postorder plan.");
  }
  const requiresLegacyCompositionLink = input.plan.directChildren.some((child) => child.role === "legacy-retained-media-island");
  const legacyReceipt = input.legacyCompositionReceipt;
  const expectedLegacyCompositionPlanIdentity = input.plan.legacyCompositionPlanIdentity;
  if (requiresLegacyCompositionLink !== Boolean(expectedLegacyCompositionPlanIdentity)) {
    throw new Error("CUT_RETAINED_MEDIA_VIEWPORT_RASTER: V2 compositor plan lost the exact legacy composition identity required by its direct-child topology.");
  }
  if (Boolean(expectedLegacyCompositionPlanIdentity) !== Boolean(legacyReceipt)) {
    throw new Error("CUT_RETAINED_MEDIA_VIEWPORT_RASTER: mixed legacy/V2 LocalSpace requires exactly one linked source-ordered composition execution.");
  }
  const executionByRoot = new Map<string, ReferenceRetainedMediaLocalCompositorMaterializationExecution>();
  for (const execution of input.materializationExecutions) {
    if (executionByRoot.has(execution.rootId)) {
      throw new Error("CUT_RETAINED_MEDIA_VIEWPORT_RASTER: V2 compositor materialization executions have duplicate roots.");
    }
    executionByRoot.set(execution.rootId, execution);
  }
  const materializationReceiptsToConsume = new Set<ReferenceRetainedMediaViewportExecutionEvidence>();
  const materializations = Object.freeze(input.plan.islands.map((island) => {
    const execution = executionByRoot.get(island.rootId);
    if (!execution) {
      throw new Error("CUT_RETAINED_MEDIA_VIEWPORT_RASTER: V2 compositor omitted a planned materialization execution status.");
    }
    const receipt = execution.receipt;
    if (execution.status === "rendered" && (!receipt || execution.skipReason !== undefined
      || !authorizedRetainedMediaViewportReceipts.has(receipt)
      || materializationReceiptsToConsume.has(receipt))) {
      throw new Error("CUT_RETAINED_MEDIA_VIEWPORT_RASTER: rendered V2 materialization requires exactly one same-invocation-authorized receipt and no skip reason.");
    }
    if (execution.status === "skipped" && (receipt || execution.skipReason === undefined)) {
      throw new Error("CUT_RETAINED_MEDIA_VIEWPORT_RASTER: skipped V2 materialization requires one closed runtime skip reason and no receipt authority.");
    }
    if (receipt) {
      const { executionIdentity: claimedExecutionIdentity, ...receiptBody } = receipt;
      const expectedVideo = island.plan.videoExecution, observedVideo = receipt.source.video;
      const videoAuthorityMatches = expectedVideo
        ? Boolean(observedVideo
          && observedVideo.streamIndex === expectedVideo.streamIndex
          && observedVideo.configIdentity === expectedVideo.configIdentity
          && observedVideo.cadenceIdentity === expectedVideo.cadenceIdentity
          && hash({ value: observedVideo.inputColor }) === hash({ value: expectedVideo.config.inputColor }))
        : observedVideo === undefined;
      const sameInvocationAndPlan = receipt.format === "cut-reference-retained-media-viewport-frame-evidence"
        && receipt.version === 1
        && receipt.evidenceKind === "completed-frame-execution"
        && receipt.algorithmVersion === referenceRetainedMediaViewportAlgorithmVersion
        && receipt.backendIdentity === referenceRetainedMediaViewportBackendIdentity
        && receipt.compositionId === input.compositionId
        && compareRational(receipt.exactTime, input.exactTime) === 0
        && receipt.outputFrame === input.outputFrame
        && receipt.localSpaceNodeId === input.plan.localSpaceNodeId
        && receipt.rootId === island.rootId
        && receipt.leafId === island.plan.leafId
        && receipt.leafKind === island.plan.leafKind
        && receipt.work.planIdentity === island.plan.semanticIdentity
        && receipt.work.planMaximumPixelPasses === island.plan.maximumPixelWorkPerFrame
        && receipt.source.resourceId === island.plan.sourceId
        && receipt.source.sha256 === island.plan.sourceSha256
        && receipt.source.selectedVariant === island.plan.selectedVariant
        && videoAuthorityMatches
        && hash(receipt.geometry.native) === hash(island.plan.native)
        && hash(receipt.geometry.decodedCrop) === hash(island.plan.cropped)
        && hash(receipt.geometry.fitted) === hash(island.plan.fitted)
        && hash(receipt.geometry.viewport) === hash(island.plan.viewport)
        && /^[a-f0-9]{64}$/u.test(receipt.outputRgbaSha256)
        && /^[a-f0-9]{64}$/u.test(claimedExecutionIdentity)
        && claimedExecutionIdentity === hash(receiptBody);
      if (!sameInvocationAndPlan) {
        throw new Error("CUT_RETAINED_MEDIA_VIEWPORT_RASTER: V2 compositor materialization receipt diverges from its admitted same-invocation frame, backend, source, geometry, or island plan authority.");
      }
      materializationReceiptsToConsume.add(receipt);
    }
    return Object.freeze({
      inspectPreorder: island.inspectPreorder,
      traversalPath: Object.freeze([...island.traversalPath]),
      rootId: island.rootId,
      leafId: island.plan.leafId,
      planIdentity: island.plan.semanticIdentity,
      status: execution.status,
      ...(execution.skipReason ? { skipReason: execution.skipReason } : {}),
      ...(receipt ? { executionIdentity: receipt.executionIdentity, outputRgbaSha256: receipt.outputRgbaSha256 } : {}),
    });
  }));
  if (executionByRoot.size !== materializations.length) {
    throw new Error("CUT_RETAINED_MEDIA_VIEWPORT_RASTER: V2 compositor published a status for an unplanned materialization island.");
  }
  const operations = Object.freeze(input.operationExecutions.map((execution, index) => {
    const planned = plannedOperations[index];
    const renderedFieldsValid = execution.status === "rendered"
      && execution.skipReason === undefined
      && typeof execution.outputRgbaSha256 === "string"
      && /^[a-f0-9]{64}$/u.test(execution.outputRgbaSha256)
      && execution.outputRgbaBytes === input.plan.dimensions.width * input.plan.dimensions.height * 4;
    const skippedFieldsValid = execution.status === "skipped"
      && execution.skipReason !== undefined
      && execution.outputRgbaSha256 === undefined
      && execution.outputRgbaBytes === undefined;
    if (!planned || planned.nodeId !== execution.nodeId || planned.op !== execution.op
      || planned.executionPostorder !== index || execution.executionPostorder !== planned.executionPostorder
      || (!renderedFieldsValid && !skippedFieldsValid)) {
      throw new Error("CUT_RETAINED_MEDIA_VIEWPORT_RASTER: V2 compositor operation execution diverges from its admitted child-first postorder plan.");
    }
    return Object.freeze({ ...execution });
  }));
  const renderedReceipts = materializations.flatMap((entry) => {
    const receipt = executionByRoot.get(entry.rootId)?.receipt;
    return receipt ? [receipt] : [];
  });
  if (legacyReceipt) {
    if (!authorizedRetainedMediaCompositionReceipts.has(legacyReceipt)) {
      throw new Error("CUT_RETAINED_MEDIA_VIEWPORT_RASTER: linked legacy composition execution lacks same-invocation live authority.");
    }
    const { executionIdentity: claimedLegacyExecutionIdentity, ...legacyReceiptBody } = legacyReceipt;
    const sameLegacyInvocationAndPlan = legacyReceipt.format === "cut-reference-retained-media-composition-frame-evidence"
      && legacyReceipt.version === 1
      && legacyReceipt.evidenceKind === "completed-source-ordered-local-composition"
      && legacyReceipt.algorithmVersion === referenceRetainedMediaCompositionAlgorithmVersion
      && legacyReceipt.backendIdentity === referenceRetainedMediaViewportBackendIdentity
      && legacyReceipt.planIdentity === expectedLegacyCompositionPlanIdentity
      && legacyReceipt.localSpaceNodeId === input.plan.localSpaceNodeId
      && legacyReceipt.compositionId === input.compositionId
      && legacyReceipt.outputFrame === input.outputFrame
      && compareRational(legacyReceipt.exactTime, input.exactTime) === 0
      && legacyReceipt.finalLocalTile.width === input.finalLocalTile.width
      && legacyReceipt.finalLocalTile.height === input.finalLocalTile.height
      && legacyReceipt.finalLocalTile.rgbaSha256 === input.finalLocalTile.rgbaSha256
      && /^[a-f0-9]{64}$/u.test(claimedLegacyExecutionIdentity)
      && claimedLegacyExecutionIdentity === hash(legacyReceiptBody);
    if (!sameLegacyInvocationAndPlan) {
      throw new Error("CUT_RETAINED_MEDIA_VIEWPORT_RASTER: linked legacy composition execution diverges from its admitted same-invocation format, backend, plan, or final-tile authority.");
    }
  }
  const legacyCompositionLink = legacyReceipt ? Object.freeze({
    planIdentity: legacyReceipt.planIdentity,
    executionIdentity: legacyReceipt.executionIdentity,
    allocationIdentity: hash(legacyReceipt.allocations),
    finalLocalTileRgbaSha256: legacyReceipt.finalLocalTile.rgbaSha256,
  }) : undefined;
  const allocations = Object.freeze({
    sourceOpens: renderedReceipts.reduce((sum, receipt) => sum + receipt.allocations.sourceOpens, 0),
    decodedFramesRead: renderedReceipts.reduce((sum, receipt) => sum + receipt.allocations.decodedFramesRead, 0),
    decodedSurfaces: renderedReceipts.reduce((sum, receipt) => sum + receipt.allocations.decodedSurfaces, 0),
    decodedRgbaBytes: renderedReceipts.reduce((sum, receipt) => sum + receipt.allocations.decodedRgbaBytes, 0),
    colorGradeSurfaces: renderedReceipts.reduce((sum, receipt) => sum + receipt.allocations.colorGradeSurfaces, 0),
    colorGradeRgbaBytes: renderedReceipts.reduce((sum, receipt) => sum + receipt.allocations.colorGradeRgbaBytes, 0),
    fittedSurfaces: renderedReceipts.reduce((sum, receipt) => sum + receipt.allocations.fittedSurfaces, 0),
    fittedRgbaBytes: renderedReceipts.reduce((sum, receipt) => sum + receipt.allocations.fittedRgbaBytes, 0),
    mediaViewportSurfaces: renderedReceipts.length,
    mediaViewportRgbaBytes: renderedReceipts.reduce((sum, receipt) => sum + receipt.allocations.viewportRgbaBytes, 0),
    operatorOutputSurfaces: operations.filter((operation) => operation.status === "rendered").length,
    operatorOutputRgbaBytes: operations.filter((operation) => operation.status === "rendered").length
      * input.plan.dimensions.width * input.plan.dimensions.height * 4,
    directChildSourceOverSteps,
    executedSourceOverSteps: input.executedSourceOverSteps,
    conservativePeakTileSurfaces: input.plan.totals.conservativePeakTileSurfaces,
    conservativePeakRgbaBytes: input.plan.totals.conservativePeakRgbaBytes,
    deliveryPrerasterSurfaces: 0 as const,
    deliveryPrerasterRgbaBytes: 0 as const,
  });
  for (const receiptToConsume of materializationReceiptsToConsume) {
    authorizedRetainedMediaViewportReceipts.delete(receiptToConsume);
  }
  if (legacyReceipt) authorizedRetainedMediaCompositionReceipts.delete(legacyReceipt);
  const receipt = Object.freeze({
    format: "cut-reference-retained-media-local-compositor-frame-evidence" as const,
    version: 2 as const,
    evidenceKind: "completed-retained-media-local-compositor" as const,
    algorithmVersion: referenceRetainedMediaLocalCompositorAlgorithmVersion,
    backendIdentity: referenceRetainedMediaViewportBackendIdentity,
    compositionId: input.compositionId,
    localSpaceNodeId: input.plan.localSpaceNodeId,
    exactTime: Object.freeze({ ...input.exactTime }),
    outputFrame: input.outputFrame,
    planIdentity: input.plan.semanticIdentity,
    wrapperTreeIdentity: input.plan.wrapperTreeIdentity,
    operationExecutionPlanIdentity: input.plan.operationExecutionPlanIdentity,
    order: Object.freeze({ inspect: "authored-preorder" as const, execution: "child-first-postorder" as const }),
    directChildren: input.plan.directChildren,
    directChildExecutions,
    materializations,
    ...(legacyCompositionLink ? { legacyCompositionLink } : {}),
    operations,
    allocations,
    plannedWork: input.plan.totals,
    finalLocalTile: Object.freeze({ ...input.finalLocalTile }),
  });
  return Object.freeze({ ...receipt, executionIdentity: hash(receipt) });
}

export function referenceRetainedMediaViewportInspect(plan: ReferenceRetainedMediaViewportPlan) {
  return Object.freeze({
    status: "bounded-executable-v1" as const,
    algorithmVersion: referenceRetainedMediaViewportAlgorithmVersion,
    backendIdentity: referenceRetainedMediaViewportBackendIdentity,
    rootId: plan.rootId,
    leafId: plan.leafId,
    leafKind: plan.leafKind,
    nodeIds: [...plan.nodeIds],
    wrapperOps: [...plan.wrapperOps],
    ...(plan.colorGradeNodeId ? { colorGradeNodeId: plan.colorGradeNodeId } : {}),
    source: {
      resourceId: plan.sourceId,
      sha256: plan.sourceSha256,
      selectedVariant: plan.selectedVariant,
      ...(plan.videoExecution ? {
        video: {
          streamIndex: plan.videoExecution.streamIndex,
          configIdentity: plan.videoExecution.configIdentity,
          ...(plan.videoExecution.cadenceIdentity ? { cadenceIdentity: plan.videoExecution.cadenceIdentity } : {}),
          config: plan.videoExecution.config,
        },
      } : {}),
    },
    native: { ...plan.native },
    ...(plan.crop ? { normalizedCrop: { ...plan.crop } } : {}),
    decodedCrop: { ...plan.cropped },
    viewport: { ...plan.viewport },
    fit: { mode: plan.fit, output: { ...plan.fitted } },
    affine: { grammar: "unary-groups-plus-optional-color-grade", maximumGroupDepth: referenceRetainedMediaViewportLimits.maximumGroupDepth, sampledBeforeAllocation: true },
    resample: plan.resample,
    outputBounds: { maximum: { left: 0, top: 0, right: plan.viewport.width, bottom: plan.viewport.height, width: plan.viewport.width, height: plan.viewport.height } },
    work: { maximumPixelPassesPerFrame: plan.maximumPixelWorkPerFrame, allocationCheckedBeforeSourceOpen: true },
    semanticIdentity: plan.semanticIdentity,
    fallback: "CUT_RETAINED_MEDIA_VIEWPORT_GRAPH",
  });
}

export function referenceRetainedMediaCompositionInspect(plan: ReferenceRetainedMediaCompositionPlan) {
  return Object.freeze({
    status: "bounded-source-ordered-composition-v2" as const,
    algorithmVersion: referenceRetainedMediaCompositionAlgorithmVersion,
    backendIdentity: referenceRetainedMediaViewportBackendIdentity,
    paintOrder: plan.children.map((child) => Object.freeze({ ...child })),
    branches: plan.branches.map((branch) => referenceRetainedMediaViewportInspect(branch)),
    alpha: {
      mode: "straight-rgba8" as const,
      operator: "source-over" as const,
      ordering: "authored-direct-child-order" as const,
      opacityApplied: "once-per-branch-before-source-over" as const,
    },
    allocation: {
      mediaBranchViewportSurfaces: plan.totals.viewportSurfaces,
      compositionPrerasterSurfaces: 0 as const,
      compositionPrerasterRgbaBytes: 0 as const,
    },
    totals: { ...plan.totals },
    limits: {
      maximumBranchesPerLocalSpace: referenceRetainedMediaViewportLimits.maximumBranchesPerLocalSpace,
      maximumBranchesPerExecutionDomain: referenceRetainedMediaViewportLimits.maximumBranchesPerExecutionDomain,
      maximumAggregateNativePixels: referenceRetainedMediaViewportLimits.maximumAggregateNativePixels,
      maximumAggregateCroppedPixels: referenceRetainedMediaViewportLimits.maximumAggregateCroppedPixels,
      maximumAggregateFitPixels: referenceRetainedMediaViewportLimits.maximumAggregateFitPixels,
      maximumAggregateViewportRgbaBytes: referenceRetainedMediaViewportLimits.maximumAggregateViewportRgbaBytes,
      maximumAggregatePixelWorkPerFrame: referenceRetainedMediaViewportLimits.maximumAggregatePixelWorkPerFrame,
    },
    semanticIdentity: plan.semanticIdentity,
    fallback: "CUT_RETAINED_MEDIA_VIEWPORT_GRAPH" as const,
  });
}

export function referenceRetainedMediaLocalCompositorInspect(plan: ReferenceRetainedMediaLocalCompositorPlan) {
  return Object.freeze({
    status: "bounded-retained-media-under-local-compositor-v2" as const,
    algorithmVersion: plan.algorithmVersion,
    backendIdentity: referenceRetainedMediaViewportBackendIdentity,
    dimensions: Object.freeze({ ...plan.dimensions }),
    directChildren: plan.directChildren.map((child) => Object.freeze({ ...child })),
    roots: plan.roots.map((root) => Object.freeze({ ...root, traversalPath: Object.freeze([...root.traversalPath]) })),
    tree: Object.freeze({
      order: plan.inspectOrder,
      nodes: plan.tree.map((node) => Object.freeze({ ...node, traversalPath: Object.freeze([...node.traversalPath]), childIds: Object.freeze([...node.childIds]) })),
    }),
    materializationIslands: plan.islands.map((island) => Object.freeze({
      inspectPreorder: island.inspectPreorder,
      traversalPath: Object.freeze([...island.traversalPath]),
      rootId: island.rootId,
      viewport: referenceRetainedMediaViewportInspect(island.plan),
    })),
    operationPlans: Object.freeze({
      inspection: Object.freeze({
        order: plan.inspectOrder,
        identity: plan.operationInspectionPlanIdentity,
        operations: plan.operationInspectionPlan.map((operation) => Object.freeze({ ...operation, traversalPath: Object.freeze([...operation.traversalPath]) })),
      }),
      execution: Object.freeze({
        order: plan.executionOrder,
        identity: plan.operationExecutionPlanIdentity,
        operations: plan.operationExecutionPlan.map((operation) => Object.freeze({ ...operation, traversalPath: Object.freeze([...operation.traversalPath]) })),
      }),
    }),
    totals: Object.freeze({ ...plan.totals }),
    limits: Object.freeze({
      maximumMediaLeavesPerLocalSpace: referenceRetainedMediaViewportLimits.maximumBranchesPerLocalSpace,
      maximumMediaLeavesPerExecutionDomain: referenceRetainedMediaViewportLimits.maximumBranchesPerExecutionDomain,
      maximumTreeNodes: referenceRetainedMediaViewportLimits.maximumLocalCompositorTreeNodes,
      maximumSourceOverSteps: referenceRetainedMediaViewportLimits.maximumLocalCompositorSourceOverSteps,
      maximumPeakRgbaBytes: referenceRetainedMediaViewportLimits.maximumLocalCompositorPeakRgbaBytes,
      maximumPixelWorkPerFrame: referenceRetainedMediaViewportLimits.maximumAggregatePixelWorkPerFrame,
    }),
    wrapperTreeIdentity: plan.wrapperTreeIdentity,
    semanticIdentity: plan.semanticIdentity,
    deliveryCanvasFallback: "forbidden" as const,
  });
}
