import { createHash } from "node:crypto";
import { lstat, mkdtemp, open, readFile, realpath, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import sharp from "sharp";
import { geoDistance, geoGraticule10, geoOrthographic, geoPath } from "d3-geo";
import type { CutAVIR, IRComposition, IRNode, IRScene, IRSignal, IRValue } from "../../language/ir";
import { CutDiagramContractError, cutDiagramOps, decodeCutDiagramLayout, type CutDiagramDiagnosticCode, type CutDiagramLayoutContract } from "../../language/diagram-contract";
import { createCutBuiltinImplementationIdentity } from "../../language/builtin-implementation-identity";
import { kernelPropertyInputIsIntrinsic, referenceKernelSchema } from "../../language/kernel-registry";
import type { CutLockedTableInput } from "../../language/table-query";
import { addRational, compareRational, divideRational, multiplyRational, rational, rationalToNumber, subtractRational, type Rational, zeroRational } from "../../language/rational";
import { hash } from "../../core/stable";
import { cutReferenceRuntimeIdentity } from "../../version";
import { resolveLockedProjectPath, type LockedResourceProbe } from "../../language/lock";
import { propertyAt, ReferencePreparedSignalResolver } from "./signals";
import { RawVideoReader, runFfmpeg } from "./ffmpeg";
import {
  applyMaskRgba,
  compositeRgba,
  compositeRgbaInPlace,
  compositeRgbaIntoReferencePrivateStraightAccumulator,
  createReferencePrivateStraightRgbaCompositeDiagnostic,
  createReferencePrivateStraightRgbaAccumulator,
  deriveReferencePrivateRgbaSourceAlphaBounds,
  deriveReferencePrivateRgbaSourceAlphaBoundsWithin,
  referencePrivateStraightRgbaCompositeDiagnosticSnapshot,
  referencePrivateStraightRgbaAccumulatorAlphaBounds,
  referencePrivateStraightRgbaBoundsAlgorithmVersion,
  rgbaBlendModes,
  type ReferencePrivateRgbaSourceAlphaBounds,
  type ReferencePrivateStraightRgbaCompositeDiagnostic,
  type ReferencePrivateStraightRgbaAccumulator,
  type RgbaBlendMode,
} from "./compositing";
import { applyReferenceVisualEffect, referenceVisualEffectConfig, type ReferenceVisualEffectConfig } from "./visual-effects";
import {
  createReferenceCaptionPreparationCache,
  prepareReferenceCaptions,
  prepareReferenceCaptionTrack,
  referenceCaptionConfig,
  referenceCaptionCueAt,
  referenceCaptionLimits,
  referenceCaptionSvg,
  referenceTranscriptCaptionConfig,
  type PreparedReferenceCaptions,
  type ReferenceCaptionConfig,
  type ReferenceCaptionAppearanceConfig,
  type ReferenceTranscriptCaptionConfig,
} from "./caption-render";
import { prepareReferenceEvidence, referenceEvidenceConfig, referenceEvidenceLimits, referenceEvidenceSvg, type PreparedReferenceEvidence, type ReferenceEvidenceConfig } from "./evidence";
import { lockedGlyphAdvance, lockedGlyphRun, parseLockedOpenTypeFont, type LockedGlyphRun, type LockedOpenTypeFont } from "./locked-font";
import { ReferencePictureEditorialError, referenceReachableCompositionNodes } from "./validate";
import { ensureProjectWriteDirectory, publishStagedFile } from "../../project/write-boundary";
import { easeReferenceTrace, prepareReferenceTrace, prepareReferenceTraceNode, referenceTracePrefixWithTangent, type PreparedReferenceTraceNode, type ReferenceTraceEasing } from "./trace";
import { referenceAlphaBounds, referenceStackConfig, referenceStackPlacements, type ReferenceStackConfig } from "./layout";
import {
  referenceVisualTransformAt,
  referenceWavefrontProjection,
  validateReferenceVisualTransformAllocation,
} from "./visual-config";
import {
  createReferenceRetainedAlphaScaleDiagnostic,
  type ReferenceRetainedAlphaScaleDiagnostic,
  validateReferenceRetainedAlphaScaleKernelEvidence,
  referenceRetainedSurfaceAlphaSupportAlgorithmVersion,
  shareReferenceRetainedSurfaceAlphaSupportAuthority,
  scaleReferenceRetainedSurfaceAlpha,
  translateReferenceRetainedSurface,
  translateReferenceRetainedSurfaceWithinAlphaSupport,
} from "./retained-surface";

export {
  createReferenceRetainedAlphaScaleDiagnostic,
  validateReferenceRetainedAlphaScaleKernelEvidence,
};
import {
  ReferenceRetainedVisualError,
  assertReferenceRetainedBoundsCovered,
  intersectReferenceRects,
  expandReferenceRect,
  referenceIdentityAffine2D,
  referenceIntegerRasterBounds,
  referencePositionedSurface,
  referenceRect,
} from "./retained-visual";
import {
  ReferenceRetainedPathChainError,
  referenceRetainedPathChain,
  referenceRetainedPathChainExecutionAt,
  type ReferenceRetainedPathChain,
} from "./retained-path-chain";
import {
  prepareReferenceAnchoredMotionPathNode,
  prepareReferenceMotionPathNode,
  referenceAnchoredMotionPathResolutionAt,
  referenceMotionPathAt,
  validateReferenceAnchoredMotionPathFrameStates,
  validateReferenceAnchoredMotionPathCompositionWork,
  type ReferenceAnchoredMotionPathPlan,
  type ReferenceAnchoredMotionPathResolution,
  type ReferenceAnchoredMotionPathWork,
  type ReferenceMotionPathPlan,
} from "./motion-path";
import { referenceShapeNodeConfig } from "./shape-config";
import { referenceChartConfig, referenceChartRevealAt, referenceChartSvg, type ReferenceChartConfig } from "./chart-config";
import { ReferenceSeriesChartError, referenceSeriesChartConfig, type ReferenceSeriesChartConfig } from "./series-chart-config";
import {
  CutSeriesChartError,
  cutSeriesChartLimits,
  cutSeriesChartStyleFromAdapter,
  prepareReferenceSeriesChart,
  referenceSeriesChartSvg,
  type PreparedReferenceSeriesChart,
} from "./series-chart";
import { referenceColorGradeConfigAt } from "./color-grade-config";
import {
  ReferenceLutError,
  parseReferenceCubeLut,
  referenceCubeLutLimits,
  referenceLutConfig,
  referenceLutStrengthAt,
  sampleReferenceCubeLut,
  validateReferenceLutResourceOwnership,
  type ReferenceCubeLut,
  type ReferenceLutConfig,
} from "./lut-config";
import { referenceMaskConfig, validateReferenceMaskCanvas, type ReferenceMaskConfig } from "./mask-config";
import { applyReferenceChromaKey, referenceChromaKeyConfig, validateReferenceChromaKeyCompositionBudget, type ReferenceChromaKeyConfig } from "./chroma-key";
import { applyReferenceClipPath, prepareReferenceClipPath, referenceClipPathConfig, validateReferenceClipPathContextBudget, type PreparedReferenceClipPath } from "./clip-path";
import {
  accumulateReferenceMotionBlur,
  ReferenceMotionBlurError,
  referenceMotionBlurConfig,
  throwReferenceMotionBlurNodeError,
  validateReferenceMotionBlurCompositionBudget,
} from "./motion-blur";
import {
  createReferenceMotionBlurBoundaryPlan,
  prepareReferenceMotionBlurBoundary,
  type ReferenceMotionBlurBoundaryConfig,
} from "./motion-blur-boundary";
import {
  applyReferenceTonalCurve,
  convertReferenceBt470bgSmpte170mInputToSrgb,
  convertReferenceColorSurface,
  referenceColorConvertConfig,
  referenceTonalCurveConfig,
  type ReferenceColorConvertConfig,
  type ReferenceTonalCurveConfig,
  type ReferenceVideoInputColorProfile,
} from "./color-management";
import { referenceTextConfig, referenceTextFailure, referenceTextLimits, type ReferenceTextConfig } from "./text-config";
import {
  prepareReferenceComplexFlowText,
  prepareReferenceFlowText,
  referenceFlowTextConfig,
  ReferenceFlowTextError,
  referenceFlowTextLimits,
  referenceFlowTextSvg,
  type PreparedReferenceFlowText,
  type ReferenceFlowTextConfig,
} from "./text-flow";
import {
  referenceVideoConfig,
  referenceVideoInputConfig,
  referenceVideoInputColorConfig,
  type ReferenceVideoConfig,
  type ReferenceVideoInputColorConfig,
} from "./video-config";
import {
  prepareReferenceImageSequence,
  referenceImageSequenceConfig,
  referenceImageSequenceSelectionAt,
  type PreparedReferenceImageSequence,
  type ReferenceImageSequenceConfig,
} from "./image-sequence";
import { applyReferencePictureTransition, type ReferencePictureTransition, type ReferenceTransitionColor } from "./transition";
import { ReferenceTransitionContractError, referenceTransitionContract, referenceTransitionProgress } from "./transition-config";
import { referenceLinkedSplitContract } from "./linked-split-config";
import {
  prefixReferencePictureTimeMapFrameEvidence,
  ReferencePictureTimeMapFrameEvidenceError,
  referencePictureDecoderSample,
  referencePictureDecoderSampleAtSourceTime,
  referencePictureTimeMapConfigIdentity,
  referencePictureTimeMapFrameEvidence,
  referencePictureTimeMapFrameEvidenceLimits,
  referencePictureTimeMapConfig,
  validateReferencePictureTimeMapFrameEvidence,
  type ReferencePictureTimeMapFrameEvidence,
  type ReferencePictureTimeMapFrameRequest,
  type ReferencePictureTimeMapConfig,
} from "./picture-time-map";
import {
  blendReferencePictureFrames,
  referencePictureFrameBlendPolicyIdentity,
} from "./picture-frame-blend";
import {
  parseReferenceGeoLabelFont,
  prepareReferenceGeoLabels,
  referenceGeoLabelCandidates,
  referenceGeoLabelConfig,
  referenceGeoLabelFailure,
  referenceGeoLabelLimits,
  referenceGeoLabelPath,
  referenceGeoPoints,
  type PreparedReferenceGeoLabels,
  type ReferenceGeoLabelConfig,
  type ReferenceGeoPoint,
} from "./geo-labels";
import { referenceGeoMapPoint, referenceGeoMapProjection, referenceGeoWorldGeometry } from "./geo-projection";
import { validateReferencePrecompGraph, type ReferencePrecompConfig } from "./precomp-config";
import { validateReferenceLinkedEditTransactions } from "./linked-edit";
import { validateReferencePictureTrackOperationPlan } from "./picture-edit-operations";
import type { ReferenceVerifiedInputSession } from "./verified-input-session";
import {
  prepareReferenceAudioReactiveSignals,
  type ReferenceAudioReactivePreparationEvidence,
} from "./audio-reactive-preparation";
import {
  prepareReferenceTrack2D,
  referenceTrack2DAt,
  referenceTrack2DConfig,
  referenceTrack2DLocalSpacePlanAt,
  referenceTrack2DLimits,
  ReferenceTrack2DError,
  type PreparedReferenceTrack2D,
  type ReferenceTrack2DConfig,
  type ReferenceTrack2DLocalSpacePlan,
} from "./tracking-2d";
import {
  prepareReferencePlanarTrack,
  referencePlanarTrackAt,
  referencePlanarTrackAlgorithmVersion,
  referencePlanarTrackConfig,
  referencePlanarTrackLimits,
  ReferencePlanarTrackError,
  type PreparedReferencePlanarTrack,
  type ReferencePlanarTrackConfig,
} from "./planar-tracking";
import {
  rasterReferenceProjectiveWarp,
  referenceProjectiveWarpAlgorithmVersion,
} from "./projective-warp-kernel";
import {
  executeReferenceLocalSpaceScaleTranslation,
  planReferenceLocalSpaceScaleTranslation,
  referenceLocalSpaceScaleTranslationAlgorithmVersion,
  type ReferenceLocalSpaceScaleTranslationPlan,
} from "./local-space-scale-translation";
import {
  placeReferenceProjectiveWarpOnCanvas,
  referenceProjectiveWarpCanvasAlgorithmVersion,
} from "./projective-warp-canvas";
import {
  referencePlanarTrackRenderedFrameExecution,
  referencePlanarTrackSkippedFrameExecution,
  type ReferencePlanarTrackFrameEvidence,
  type ReferencePlanarTrackFrameEvidenceExecution,
  type ReferencePlanarTrackFrameEvidenceTrustedContext,
} from "./planar-track-evidence";
import {
  referencePlanarTrackMatteConfig,
  type ReferencePlanarTrackMatteConfig,
} from "./planar-track-matte";
import {
  prepareReferenceAnchoredVectorPathNode,
  prepareReferenceVectorPathNode,
  referenceAnchoredVectorPathFrameResolutionAt,
  referenceVectorPathFrameAt,
  referenceVectorPathSvg,
  referenceVectorPathTransformedSvg,
  referenceVectorPathVisibleBounds,
  validateReferenceAnchoredVectorPathFrameStates,
  validateReferenceVectorPathCompositionWork,
  validateReferenceVectorPathFrameStates,
  type ReferenceAnchoredVectorPathFrameResolution,
  type ReferenceAnchoredVectorPathPlan,
  type ReferenceAnchoredVectorPathWork,
  type ReferenceVectorPathPlan,
  type ReferenceVectorPathWork,
} from "./vector-path";
import {
  decodeReferenceAnchoredPathGeometry,
  isReferenceAnchoredPathGeometryValue,
  validateReferenceAnchoredPathGeometry,
  type ReferenceAnchoredPathOwnerResolution,
  type ReferenceAnchoredPathResolution,
  type ReferenceValidatedAnchoredPathGeometry,
} from "./anchored-path";
import {
  referenceParallaxCameraPlanAt,
  validateReferenceParallaxCameraGraph,
  type ReferenceParallaxCameraConfig,
  type ReferenceParallaxCameraFramePlan,
  type ReferenceParallaxLayerFrame,
} from "./parallax-camera";
import {
  referenceMapCameraGeoAnnotationPlanAt,
  validateReferenceMapCameraGeoAnnotations,
  type ReferenceMapCameraAnnotationConfig,
  type ReferenceMapCameraConfig,
} from "./map-camera";
import {
  ReferenceMapCameraCanonicalRasterCache,
  prepareReferenceMapCameraRenderInvocation,
  referenceMapCameraPublicFrameEvidence,
  referenceMapCameraPreparedConfigurations,
  renderReferenceMapCameraFrame,
  type ReferenceMapCameraPublicFrameEvidence,
  type ReferenceMapCameraRenderPreparation,
} from "./map-camera-render";
import {
  ReferenceGeoAnnotationError,
  referenceGeoAnnotationPlanAt,
  validateReferenceGeoAnnotationGraph,
  type ReferenceGeoAnnotationCameraConfig,
  type ReferenceGeoAnnotationDecision,
  type ReferenceGeoAnnotationRenderedDecision,
  type ReferenceGeoAnnotationRenderedFrameEvidence,
} from "./geo-annotation";
import {
  ReferenceCalloutError,
  referenceCalloutExecutionIdentity,
  referenceCalloutPlanAt,
  validateReferenceCalloutFrameEvidenceSemantics,
  validateReferenceCalloutGraph,
  type ReferenceCalloutDecision,
  type ReferenceCalloutLayerConfig,
  type ReferenceCalloutRenderedDecision,
  type ReferenceCalloutRenderedFrameEvidence,
} from "./callout";
import {
  createReferenceLocalSpaceStructuralValidationIndex,
  ReferenceLocalSpaceError,
  referenceLocalSpaceAllRetainedMediaPlans,
  referenceLocalSpaceDescendantContexts,
  referenceLocalSpaceFrameEvidence,
  referenceLocalSpacePlacementIdentity,
  referenceLocalSpaceRasterOrigin,
  referenceLocalSpaceRetainedMediaMaterializationForRoot,
  referenceLocalSpaceRetainedMediaPlanForRoot,
  referenceLocalSpaceLimits,
  referenceLocalSpaceTileIdentity,
  referenceLocalSpaceTextLayoutContext,
  validateReferenceLocalSpaceGraph,
  type ReferenceLocalSpaceConfig,
  type ReferenceLocalSpaceExecutionCounters,
  type ReferenceLocalSpaceFrameEvidence,
  type ReferenceLocalSpaceStructuralValidationIndex,
  type ReferenceLocalSpacePlacement,
  type ReferenceLocalSpaceRenderedPlacementEvidence,
  type ReferenceLocalSpaceRenderedTileEvidence,
  type ReferenceLocalSpaceRenderSkipEvidence,
  type ReferenceLocalSpaceTransformExecutionEvidence,
} from "./local-space";
import {
  planReferenceLocalSpaceAffineTileTransformWork,
  referenceLocalSpaceResizeGeometry,
  referenceLocalSpaceTransformRendererHandoff,
  referenceLocalSpaceTransformSchedulingEnforcement,
  type ReferenceLocalSpaceAffineTileTransformWork,
  type ReferenceLocalSpaceAffineTransformRequest,
} from "./local-space-transform-work";
import { referenceCamera2DLocalSpacePlanAt } from "./camera2d-local-space";
import {
  referenceComponentFragmentLocalSpaceFramePreflight,
  referenceComponentFragmentLocalSpacePlanAt,
  referenceLocalSpaceCompositionTransformPreflight,
  type ReferenceAffineLocalSpaceOwnerKind,
  type ReferenceComponentFragmentLocalSpaceFramePreflight,
  type ReferenceComponentFragmentLocalSpacePlan,
  type ReferenceLocalSpaceCompositionTransformPreflightEntry,
  type ReferenceLocalSpaceCompositionTransformPreflightEvidence,
} from "./component-fragment-local-space";
import {
  referenceCamera3DFrameEvidence,
  referenceCamera3DPlanAt,
  validateReferenceCamera3DGraph,
  type ReferenceCamera3DConfig,
  type ReferenceCamera3DFrameEvidence,
  type ReferenceCamera3DPlaneExecution,
} from "./camera3d";
import {
  applyReferenceSemanticMatchColor,
  prepareReferenceSemanticMatches,
  referenceSemanticMatchFrameEvidence,
  type ReferencePreparedSemanticMatches,
  type ReferenceSemanticMatchSample,
  type ReferenceSemanticMatchFrameEvidence,
} from "./semantic-match";
import {
  ReferenceResponsiveStackError,
  referenceResponsiveStackMediaPlacementAlgorithm,
  referenceResponsiveStackDescendantContexts,
  referenceResponsiveStackTextLayoutContext,
  validateReferenceResponsiveStackMediaFrameEvidence,
  validateReferenceResponsiveStackGraph,
  type ReferenceResponsiveStackConfig,
  type ReferenceResponsiveStackFrameEvidence,
  type ReferenceResponsiveStackFrameSlotEvidence,
  type ReferenceResponsiveStackLocalContext,
} from "./responsive-layout";
import {
  bindReferenceResponsiveSlotMediaAnchorFrameEvidence,
  type ReferenceResponsiveSlotMediaAnchorLinkEvidence,
} from "./responsive-slot-media-anchor";
import {
  assertReferenceIdentityComponentFragmentFresh,
  ReferenceIdentityComponentFragmentError,
  referenceIdentityComponentFragmentFrameEvidence,
  validateReferenceIdentityComponentFragments,
  type ReferenceIdentityComponentFragmentConfig,
  type ReferenceIdentityComponentFragmentFrameEvidence,
} from "./identity-component-fragment";
import {
  validateReferenceIdentityComponentFragmentFrameEvidence,
} from "./identity-component-fragment-evidence";
import {
  ReferenceRetainedMediaViewportError,
  createReferenceRetainedMediaViewportQ16TapDiagnostic,
  executeReferenceRetainedMediaComposition,
  executeReferenceRetainedMediaViewportFrame,
  referenceRetainedMediaCropPixels,
  referenceRetainedMediaLocalCompositorExecutionEvidence,
  referenceRetainedMediaViewportStateAt,
  validateReferenceRetainedMediaViewportQ16TapKernelEvidence,
  type ReferenceRetainedMediaCompositionExecutionEvidence,
  type ReferenceRetainedMediaCompositionLiveChild,
  type ReferenceRetainedMediaLocalCompositorDirectChildExecution,
  type ReferenceRetainedMediaLocalCompositorExecutionEvidence,
  type ReferenceRetainedMediaLocalCompositorOperationExecution,
  type ReferenceRetainedMediaViewportQ16TapDiagnostic,
  type ReferenceRetainedMediaViewportExecutionEvidence,
  type ReferenceRetainedMediaViewportPlan,
} from "./retained-media-viewport";

export {
  createReferenceRetainedMediaViewportQ16TapDiagnostic,
  validateReferenceRetainedMediaViewportQ16TapKernelEvidence,
};
import {
  ReferenceMediaCamera2DError,
  admitReferenceMediaCamera2DSceneFrame,
  closeReferenceMediaCamera2DSceneAdmission,
  createReferenceMediaCamera2DStaticGradeLeaseExecutionAuthority,
  executeReferenceMediaCamera2DFrame,
  referenceMediaCamera2DAnchorPlanAt,
  referenceMediaCamera2DAnchorPlanFromFramePlan,
  referenceMediaCamera2DBackendIdentity,
  referenceMediaCamera2DFramePlanAt,
  referenceMediaCamera2DOpacityZeroFrame,
  referenceMediaCamera2DStaticGradeBackendIdentity,
  referenceMediaCamera2DStaticGradeCacheAlgorithmVersion,
  referenceMediaCamera2DStaticGradeCacheIdentity,
  referenceMediaCamera2DStaticGradeCacheLimits,
  validateReferenceMediaCamera2DGraph,
  type ReferenceMediaCamera2DExecutionEvidence,
  type ReferenceMediaCamera2DFramePlan,
  type ReferenceMediaCamera2DNativeEffectRuntime,
  type ReferenceMediaCamera2DPlan,
  type ReferenceMediaCamera2DSceneAdmission,
  type ReferenceMediaCamera2DStaticGradeLeaseExecutionAuthority,
  type ReferenceMediaCamera2DStaticGradeCacheEvidence,
  type ReferenceMediaCamera2DVideoDecoderState,
  type ReferenceMediaCamera2DVideoDecodePlan,
} from "./media-camera2d";
import {
  planReferenceDiagramLayout,
  referenceDiagramLayoutAlgorithmVersion,
  referenceDiagramLayoutFrameAt,
  referenceDiagramLayoutQ16Scale,
  referenceDiagramNodeRasterContexts,
  referenceDiagramTransitionSamplesAtOutputFrames,
  type ReferenceDiagramNodeRasterContext,
} from "./diagram-layout";
import {
  createReferenceDiagramRasterCache,
  referenceDiagramRasterCacheIdentity,
  type ReferenceDiagramRasterCache,
  type ReferenceDiagramRasterCacheIdentityInput,
  type ReferenceDiagramRasterCacheReceipt,
} from "./diagram-raster-cache";
export type RawSurface = { data: Buffer; width: number; height: number };

type ReferenceRetainedMediaMaterializationRuntime = Readonly<{
  rootId: string;
  status: "rendered" | "skipped";
  skipReason?: import("./retained-media-viewport").ReferenceRetainedMediaLocalCompositorSkipReason;
  receipt?: ReferenceRetainedMediaViewportExecutionEvidence;
}>;

type ReferenceRetainedMediaLocalOperationRuntime = ReferenceRetainedMediaLocalCompositorOperationExecution;

type ReferenceLocalNodeFrameResult = Readonly<{
  surface?: RawSurface;
  /** Exact CUT-owned source-over calls performed while building this subtree. */
  sourceOverSteps: number;
  /** Present only when this result exposes no surface to its direct parent. */
  directChildSkipReason?: import("./retained-media-viewport").ReferenceRetainedMediaLocalCompositorDirectChildSkipReason;
  materializations: readonly ReferenceRetainedMediaMaterializationRuntime[];
  operations: readonly ReferenceRetainedMediaLocalOperationRuntime[];
}>;

type ReferenceGeoAnnotationOverlayResult =
  | Readonly<{
    status: "painted";
    surface: RawSurface;
    visibleAlpha: Readonly<{ sourceVisiblePixels: number; sourceMaximum: number; visiblePixels: number; maximum: number }>;
    renderedDecision: ReferenceGeoAnnotationRenderedDecision;
  }>
  | Readonly<{
    status: "opacity-quantized-transparent";
    renderedDecision: ReferenceGeoAnnotationRenderedDecision;
  }>;

type ReferenceCalloutOverlayResult =
  | Readonly<{
    status: "painted";
    surface: RawSurface;
    visibleAlpha: Readonly<{
      sourceVisiblePixels: number;
      sourceMaximum: number;
      visiblePixels: number;
      maximum: number;
    }>;
    renderedDecision: ReferenceCalloutRenderedDecision;
  }>
  | Readonly<{
    status: "opacity-quantized-transparent";
    renderedDecision: ReferenceCalloutRenderedDecision;
  }>;

function referenceGeoAnnotationExecutionIdentity(
  decisionIdentity: string,
  decisions: ReferenceGeoAnnotationRenderedFrameEvidence["decisions"],
  executionPath: ReferenceGeoAnnotationRenderedFrameEvidence["executionPath"],
) {
  return hash({
    decisionIdentity,
    renderedDecisions: decisions.flatMap((decision) => decision.renderedDecision
      ? [Object.freeze({ nodeId: decision.nodeId, renderedDecision: decision.renderedDecision })]
      : []),
    executionPath,
  });
}
type StraightRgba16Surface = { data: Uint16Array; width: number; height: number };

export const referenceLocalSpaceRendererFrameExecutionFormat = "cut-reference-local-space-renderer-frame-execution" as const;

/** Stable renderer-instance path for one completed LocalSpace frame. The final
 * segment names the renderer that produced `execution`/`preflight`; every
 * preceding segment identifies the exact Precomp/NestedSequence instance that
 * entered the following source composition. */
export type ReferenceLocalSpaceRendererExecutionPathSegment = Readonly<{
  compositionId: string;
  instanceNodeId?: string;
  sourceCompositionId?: string;
}>;

export type ReferenceLocalSpaceRendererFrameExecutionEvidence = Readonly<{
  format: typeof referenceLocalSpaceRendererFrameExecutionFormat;
  version: 1;
  evidenceKind: "completed-renderer-frame-local-space-execution";
  executionPath: readonly ReferenceLocalSpaceRendererExecutionPathSegment[];
  execution: ReferenceLocalSpaceFrameEvidence;
  preflight: ReferenceLocalSpaceCompositionTransformPreflightEvidence;
  rendererFrameIdentity: string;
}>;

/** Independently copied per-entry comparison context. This legacy/additive
 * shape is caller-constructible and therefore is not a completeness or
 * authenticity authority; only the branded tree authority below serves that
 * role. */
export type ReferenceLocalSpaceRendererFrameExecutionTrustedContext = Readonly<{
  authority: "locked-ir-and-live-frame-execution";
  expected: ReferenceLocalSpaceRendererFrameExecutionEvidence;
}>;

export const referenceLocalSpaceRendererFrameExecutionTreeFormat = "cut-reference-local-space-renderer-frame-execution-tree" as const;
export const referenceLocalSpaceRendererFrameExecutionTreeLimits = Object.freeze({
  maximumRendererFrames: 1025,
  maximumEvidenceRecords: 65_536,
  maximumEvidenceCopyUnits: 262_144,
});

/** Closed public summary for the complete renderer-instance tree. The two
 * ordered digests make removal, insertion, reordering, path substitution, or
 * receipt substitution observable without duplicating the nested receipts. */
export type ReferenceLocalSpaceRendererFrameExecutionTreeEvidence = Readonly<{
  format: typeof referenceLocalSpaceRendererFrameExecutionTreeFormat;
  version: 1;
  evidenceKind: "completed-renderer-frame-local-space-execution-tree";
  rootCompositionId: string;
  rendererFrameCount: number;
  executionPathsIdentity: string;
  rendererFramesIdentity: string;
  rendererTreeIdentity: string;
}>;

/** Opaque same-invocation authority. Runtime authenticity is branded through
 * a module-private WeakSet, so copying or spreading this public shape cannot
 * manufacture a trusted complete-tree authority. */
export type ReferenceLocalSpaceRendererFrameExecutionTreeTrustedAuthority = Readonly<{
  authority: "locked-ir-and-live-renderer-tree";
  ir: CutAVIR;
  rootCompositionId: string;
  executions: readonly ReferenceLocalSpaceRendererFrameExecutionEvidence[];
  expectedTree: ReferenceLocalSpaceRendererFrameExecutionTreeEvidence;
  expectedReceipts: readonly ReferenceLocalSpaceRendererFrameExecutionEvidence[];
}>;

type ReferenceLocalSpaceRendererFrameExecution = Readonly<{
  receipt: ReferenceLocalSpaceRendererFrameExecutionEvidence;
  trustedContext: ReferenceLocalSpaceRendererFrameExecutionTrustedContext;
}>;

function deepFrozenEvidenceCopy<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map((item) => deepFrozenEvidenceCopy(item))) as T;
  if (value && typeof value === "object") {
    const copy = Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, deepFrozenEvidenceCopy(item)]));
    return Object.freeze(copy) as T;
  }
  return value;
}

function closedLocalSpaceExecutionPath(path: readonly ReferenceLocalSpaceRendererExecutionPathSegment[]) {
  if (!Array.isArray(path) || path.length < 1 || path.length > 17) {
    throw new Error("CUT_LOCAL_SPACE_RASTER: renderer executionPath must contain 1 through 17 composition segments.");
  }
  const closed = path.map((segment, index) => {
    const names = Object.keys(segment).sort();
    const terminal = index === path.length - 1;
    const expected = terminal
      ? ["compositionId"]
      : ["compositionId", "instanceNodeId", "sourceCompositionId"];
    if (names.length !== expected.length || names.some((name, key) => name !== expected[key])) {
      throw new Error(`CUT_LOCAL_SPACE_RASTER: renderer executionPath segment ${index} is not the closed ${terminal ? "terminal composition" : "nested instance"} shape.`);
    }
    if (typeof segment.compositionId !== "string" || !segment.compositionId
      || (!terminal && (typeof segment.instanceNodeId !== "string" || !segment.instanceNodeId
        || typeof segment.sourceCompositionId !== "string" || !segment.sourceCompositionId))) {
      throw new Error(`CUT_LOCAL_SPACE_RASTER: renderer executionPath segment ${index} contains an empty or non-string identifier.`);
    }
    if (!terminal && segment.sourceCompositionId !== path[index + 1]?.compositionId) {
      throw new Error(`CUT_LOCAL_SPACE_RASTER: renderer executionPath segment ${index} source composition does not match its child segment.`);
    }
    return Object.freeze({ ...segment });
  });
  return Object.freeze(closed);
}

export function referenceLocalSpaceRendererFrameExecutionEvidence(input: Readonly<{
  executionPath: readonly ReferenceLocalSpaceRendererExecutionPathSegment[];
  execution: ReferenceLocalSpaceFrameEvidence;
  preflight: ReferenceLocalSpaceCompositionTransformPreflightEvidence;
}>): ReferenceLocalSpaceRendererFrameExecutionEvidence {
  const executionPath = closedLocalSpaceExecutionPath(input.executionPath);
  const terminalCompositionId = executionPath.at(-1)!.compositionId;
  if (input.execution.compositionId !== terminalCompositionId
    || input.preflight.compositionId !== terminalCompositionId
    || compareRational(input.execution.exactTime, input.preflight.exactTime) !== 0
    || input.execution.outputFrame !== input.preflight.outputFrame) {
    throw new Error("CUT_LOCAL_SPACE_RASTER: renderer executionPath does not pair one exact completed LocalSpace execution and affine preflight.");
  }
  const receipt = Object.freeze({
    format: referenceLocalSpaceRendererFrameExecutionFormat,
    version: 1 as const,
    evidenceKind: "completed-renderer-frame-local-space-execution" as const,
    executionPath,
    execution: input.execution,
    preflight: input.preflight,
  });
  const semanticReceipt = Object.freeze({
    format: receipt.format,
    version: receipt.version,
    evidenceKind: receipt.evidenceKind,
    executionPath,
    executionIdentity: input.execution.executionIdentity,
    preflightIdentity: input.preflight.preflightIdentity,
  });
  return Object.freeze({ ...receipt, rendererFrameIdentity: hash(semanticReceipt) });
}

function trustedLocalSpaceRendererFrameExecution(
  receipt: ReferenceLocalSpaceRendererFrameExecutionEvidence,
  independentExpected: ReferenceLocalSpaceRendererFrameExecutionEvidence = receipt,
): ReferenceLocalSpaceRendererFrameExecution {
  return Object.freeze({
    receipt,
    trustedContext: Object.freeze({
      authority: "locked-ir-and-live-frame-execution" as const,
      expected: deepFrozenEvidenceCopy(independentExpected),
    }),
  });
}

function compareLocalSpaceExecutionPaths(
  left: readonly ReferenceLocalSpaceRendererExecutionPathSegment[],
  right: readonly ReferenceLocalSpaceRendererExecutionPathSegment[],
) {
  const count = Math.min(left.length, right.length);
  for (let index = 0; index < count; index += 1) {
    const leftSegment = left[index]!, rightSegment = right[index]!;
    for (const [leftValue, rightValue] of [
      [leftSegment.compositionId, rightSegment.compositionId],
      [leftSegment.instanceNodeId ?? "", rightSegment.instanceNodeId ?? ""],
      [leftSegment.sourceCompositionId ?? "", rightSegment.sourceCompositionId ?? ""],
    ] as const) {
      const compared = leftValue.localeCompare(rightValue);
      if (compared !== 0) return compared;
    }
  }
  return left.length - right.length;
}

function localSpaceExecutionPathIdentity(path: readonly ReferenceLocalSpaceRendererExecutionPathSegment[]) {
  return path.map((segment) => `${segment.compositionId}\u0000${segment.instanceNodeId ?? ""}\u0000${segment.sourceCompositionId ?? ""}`).join("\u0001");
}

export function referenceLocalSpaceRendererFrameExecutionTreeEvidence(
  rootCompositionId: string,
  receipts: readonly ReferenceLocalSpaceRendererFrameExecutionEvidence[],
): ReferenceLocalSpaceRendererFrameExecutionTreeEvidence {
  if (!rootCompositionId || receipts.length < 1
    || receipts.length > referenceLocalSpaceRendererFrameExecutionTreeLimits.maximumRendererFrames) {
    throw new Error("CUT_LOCAL_SPACE_RASTER: renderer execution tree requires one root and at most 1024 nested renderer frames.");
  }
  referenceLocalSpaceRendererFrameExecutionTreeWork(receipts);
  if (receipts[0]?.executionPath.length !== 1
    || receipts[0]?.executionPath[0]?.compositionId !== rootCompositionId) {
    throw new Error(`CUT_LOCAL_SPACE_RASTER: renderer execution tree must begin with root composition ${rootCompositionId}.`);
  }
  const paths = new Set<string>();
  for (const [index, receipt] of receipts.entries()) {
    if (receipt.executionPath[0]?.compositionId !== rootCompositionId) {
      throw new Error(`CUT_LOCAL_SPACE_RASTER: renderer execution tree entry ${index} does not begin at root composition ${rootCompositionId}.`);
    }
    if (index > 0 && compareLocalSpaceExecutionPaths(receipts[index - 1]!.executionPath, receipt.executionPath) >= 0) {
      throw new Error(`CUT_LOCAL_SPACE_RASTER: renderer execution tree entry ${index} is not in strict path order.`);
    }
    const pathIdentity = localSpaceExecutionPathIdentity(receipt.executionPath);
    if (paths.has(pathIdentity)) {
      throw new Error(`CUT_LOCAL_SPACE_RASTER: renderer execution tree repeats path ${JSON.stringify(receipt.executionPath)}.`);
    }
    paths.add(pathIdentity);
  }
  const evidence = Object.freeze({
    format: referenceLocalSpaceRendererFrameExecutionTreeFormat,
    version: 1 as const,
    evidenceKind: "completed-renderer-frame-local-space-execution-tree" as const,
    rootCompositionId,
    rendererFrameCount: receipts.length,
    executionPathsIdentity: hash({
      format: "cut-reference-local-space-renderer-execution-paths",
      version: 1,
      paths: receipts.map((receipt) => receipt.executionPath),
    }),
    rendererFramesIdentity: hash({
      format: "cut-reference-local-space-renderer-frame-identities",
      version: 1,
      rendererFrameIdentities: receipts.map((receipt) => receipt.rendererFrameIdentity),
    }),
  });
  return Object.freeze({ ...evidence, rendererTreeIdentity: hash(evidence) });
}

/** O(renderer-count + tile-count) aggregate bound checked before any
 * per-record hashing or authority deep-copy. Each completed renderer wrapper,
 * execution tile, embedded local-compositing operation, placement, skip,
 * preflight admission, and preflight skip counts once. */
export function referenceLocalSpaceRendererFrameExecutionTreeWork(
  receipts: readonly ReferenceLocalSpaceRendererFrameExecutionEvidence[],
) {
  if (!Array.isArray(receipts)
    || receipts.length > referenceLocalSpaceRendererFrameExecutionTreeLimits.maximumRendererFrames) {
    throw new Error("CUT_LOCAL_SPACE_RASTER: renderer execution tree exceeds its renderer-frame evidence bound.");
  }
  let records = 0, copyUnits = 0;
  for (const [index, receipt] of receipts.entries()) {
    const execution = receipt?.execution, preflight = receipt?.preflight;
    if (!execution || !preflight
      || !Array.isArray(execution.tiles)
      || !Array.isArray(execution.placements)
      || !Array.isArray(execution.skips)
      || !Array.isArray(preflight.admissions)
      || !Array.isArray(preflight.skips)) {
      throw new Error(`CUT_LOCAL_SPACE_RASTER: renderer execution tree entry ${index} has malformed evidence record arrays.`);
    }
    const depth = receipt.executionPath?.length;
    if (!Number.isSafeInteger(depth) || depth < 1 || depth > 17) {
      throw new Error(`CUT_LOCAL_SPACE_RASTER: renderer execution tree entry ${index} has an invalid execution-path depth.`);
    }
    let localCompositingOperationRecords = 0;
    for (const [tileIndex, tile] of execution.tiles.entries()) {
      const operations = tile?.localCompositing?.operations;
      if (operations !== undefined && !Array.isArray(operations)) {
        throw new Error(`CUT_LOCAL_SPACE_RASTER: renderer execution tree entry ${index} tile ${tileIndex} has a malformed local-compositing operation array.`);
      }
      localCompositingOperationRecords += operations?.length ?? 0;
      if (!Number.isSafeInteger(localCompositingOperationRecords)
        || localCompositingOperationRecords > referenceLocalSpaceRendererFrameExecutionTreeLimits.maximumEvidenceRecords) {
        throw new Error(
          `CUT_LOCAL_SPACE_RASTER: renderer execution tree evidence requires more than ${referenceLocalSpaceRendererFrameExecutionTreeLimits.maximumEvidenceRecords} embedded local-compositing operation records.`,
        );
      }
    }
    const entryRecords = 1
      + execution.tiles.length
      + localCompositingOperationRecords
      + execution.placements.length
      + execution.skips.length
      + preflight.admissions.length
      + preflight.skips.length;
    records += entryRecords;
    copyUnits += entryRecords * depth;
    if (!Number.isSafeInteger(records)
      || records > referenceLocalSpaceRendererFrameExecutionTreeLimits.maximumEvidenceRecords) {
      throw new Error(
        `CUT_LOCAL_SPACE_RASTER: renderer execution tree evidence requires ${records} records; maximum is ${referenceLocalSpaceRendererFrameExecutionTreeLimits.maximumEvidenceRecords}.`,
      );
    }
    if (!Number.isSafeInteger(copyUnits)
      || copyUnits > referenceLocalSpaceRendererFrameExecutionTreeLimits.maximumEvidenceCopyUnits) {
      throw new Error(
        `CUT_LOCAL_SPACE_RASTER: renderer execution tree evidence requires ${copyUnits} depth-weighted copy units; maximum is ${referenceLocalSpaceRendererFrameExecutionTreeLimits.maximumEvidenceCopyUnits}.`,
      );
    }
  }
  return Object.freeze({ records, copyUnits });
}

export function referenceLocalSpaceRendererFrameExecutionTreeRecordCount(
  receipts: readonly ReferenceLocalSpaceRendererFrameExecutionEvidence[],
) {
  return referenceLocalSpaceRendererFrameExecutionTreeWork(receipts).records;
}

const trustedLocalSpaceRendererFrameExecutionTreeAuthorities = new WeakSet<object>();

function trustedLocalSpaceRendererFrameExecutionTreeAuthority(
  ir: CutAVIR,
  rootCompositionId: string,
  executions: readonly ReferenceLocalSpaceRendererFrameExecutionEvidence[],
  expectedTree: ReferenceLocalSpaceRendererFrameExecutionTreeEvidence,
  expectedReceipts: readonly ReferenceLocalSpaceRendererFrameExecutionEvidence[],
) {
  const authority: ReferenceLocalSpaceRendererFrameExecutionTreeTrustedAuthority = Object.freeze({
    authority: "locked-ir-and-live-renderer-tree" as const,
    ir,
    rootCompositionId,
    executions,
    expectedTree: deepFrozenEvidenceCopy(expectedTree),
    expectedReceipts: deepFrozenEvidenceCopy(expectedReceipts),
  });
  trustedLocalSpaceRendererFrameExecutionTreeAuthorities.add(authority);
  return authority;
}

export function requireReferenceLocalSpaceRendererFrameExecutionTreeTrustedAuthority(
  candidate: unknown,
): ReferenceLocalSpaceRendererFrameExecutionTreeTrustedAuthority {
  if (!candidate || typeof candidate !== "object"
    || !trustedLocalSpaceRendererFrameExecutionTreeAuthorities.has(candidate)) {
    throw new Error("CUT_LOCAL_SPACE_FRAME_EVIDENCE: renderer-tree authority was not issued by this locked live renderer invocation.");
  }
  return candidate as ReferenceLocalSpaceRendererFrameExecutionTreeTrustedAuthority;
}

const referenceVisualRendererTreeAuthority = Object.freeze({ kind: "cut-reference-visual-renderer-tree" as const });
type ReferenceVisualRendererTreeContext = Readonly<{
  authority: typeof referenceVisualRendererTreeAuthority;
  ir: CutAVIR;
  localSpaceStructuralIndex: ReferenceLocalSpaceStructuralValidationIndex;
  evidenceBudget: { current?: ReferenceLocalSpaceRendererFrameEvidenceGeneration };
  localPaintSurfaceCache: ReferenceLocalPaintSurfaceCache;
  staticMediaGradeCache: ReferenceStaticMediaGradeCache;
  mapCameraCanonicalRasterCache: ReferenceMapCameraCanonicalRasterCache;
  surfaceCacheByteLimit: number;
  nestedCompositionPreparation: "eager" | "lazy-active";
  retainedAlphaScaleDiagnostic?: ReferenceRetainedAlphaScaleDiagnostic;
  retainedMediaViewportQ16TapDiagnostic?: ReferenceRetainedMediaViewportQ16TapDiagnostic;
  privateStraightCompositeDiagnostic?: ReferencePrivateStraightRgbaCompositeDiagnostic;
  privateLocalPaintAlphaBoundsMode: "automatic" | "forced-full-surface";
}>;
export type ReferenceVisualRendererRootCacheOptions = Readonly<{
  /**
   * Internal renderer-pool reuse only. Cache entries are immutable RGBA
   * surfaces and the cache coalesces concurrent pending materializations.
   */
  sharedLocalPaintSurfaceCache?: ReferenceLocalPaintSurfaceCache;
  /** Internal exact A/B boundary; four bytes forces capacity bypass. */
  staticMediaGradeCacheByteLimit?: number;
  /** Internal exact copied-handoff/immutable-lease A/B boundary. */
  staticMediaGradeHandoffMode?: "copied" | "immutable-lease";
  /**
   * Per-renderer bound applied independently to caption, text, local-text and
   * evidence LRU maps. This changes reuse only, never authored pixels.
   */
  surfaceCacheByteLimit?: number;
  /**
   * Internal selected-range preview policy. Whole-graph validation and
   * verified-input authority remain eager; only nested renderer construction
   * and runtime preparation are deferred until an active Precomp or
   * NestedSequence first reaches pixels.
   */
  lazyNestedCompositionPreparation?: boolean;
  /**
   * Internal same-build opacity scalar/kernel comparison only. This
   * authority-backed diagnostic changes execution selection, never pixels.
   */
  retainedAlphaScaleDiagnostic?: ReferenceRetainedAlphaScaleDiagnostic;
  /**
   * Internal same-build retained-media Q16 allocated/scratch comparison only.
   * This authority-backed diagnostic changes execution selection, never pixels.
   */
  retainedMediaViewportQ16TapDiagnostic?: ReferenceRetainedMediaViewportQ16TapDiagnostic;
  /** Internal same-build scalar/JS-fast/native private compositor comparison. */
  privateStraightCompositeMode?: "automatic" | "forced-js-fast" | "forced-scalar";
  /** Internal same-build full-surface/bounded vector support comparison. */
  privateLocalPaintAlphaBoundsMode?: "automatic" | "forced-full-surface";
}>;
type ReferenceLocalSpaceRendererFrameEvidenceGeneration = {
  readonly token: object;
  active: boolean;
  records: number;
  copyUnits: number;
};

type ReferenceLocalSpaceTransformAdmission = Readonly<{
  sourceNode: IRNode;
  admittedWork: ReferenceLocalSpaceAffineTileTransformWork;
  scaleTranslationPlan?: ReferenceLocalSpaceScaleTranslationPlan;
}>;
type ReferenceLocalSpaceTransformExecutionBinding = ReferenceLocalSpaceTransformAdmission & Readonly<{
  opacity: number;
}>;
type MutableReferenceLocalSpaceExecutionCounters = { -readonly [Key in keyof ReferenceLocalSpaceExecutionCounters]: number };
type MutableReferenceLocalSpaceFrameEvidence = {
  exactTime: Rational;
  outputFrame: string;
  counters: MutableReferenceLocalSpaceExecutionCounters;
  tiles: ReferenceLocalSpaceRenderedTileEvidence[];
  placements: ReferenceLocalSpaceRenderedPlacementEvidence[];
  skips: ReferenceLocalSpaceRenderSkipEvidence[];
};
type ReferenceDiagramNodeLocalContext = Readonly<{
  contextKind: "diagram-node";
  nodeId: string;
  layoutNodeId: string;
  diagramNodeId: string;
  width: number;
  height: number;
  origin: Readonly<{ x: Rational; y: Rational }>;
  rasterOriginQ16: Readonly<{ x: string; y: string }>;
  view: Readonly<{ minX: Rational; minY: Rational; maxX: Rational; maxY: Rational }>;
  childIds: readonly string[];
  semanticIdentity: string;
  subtreePaintIdentity: string;
  temporalRasterMode: "static" | "sampled";
  plannerContext: ReferenceDiagramNodeRasterContext;
}>;
type ReferenceBoundedLocalRasterContext = ReferenceLocalSpaceConfig | ReferenceResponsiveStackLocalContext | ReferenceDiagramNodeLocalContext;
type ReferenceDiagramLayoutPlan = ReturnType<typeof planReferenceDiagramLayout>;
type ReferenceDiagramLayoutFrame = ReturnType<typeof referenceDiagramLayoutFrameAt>;

type ReferencePreparedAffineLocalSpacePlan = Readonly<{
  ownerNodeId: string;
  localSpaceNodeId: string;
  ownerKind: ReferenceAffineLocalSpaceOwnerKind;
  exactTime: Rational;
  status: "visible" | "opacity-zero" | "policy-hidden";
  planIdentity: string;
  /** Canonical composition-wide admission identity derived after all affine
   * requests have been closed over the same exact frame. */
  admissionPlanIdentity?: string;
  placement?: ReferenceLocalSpacePlacement;
  transformWork?: ReferenceLocalSpaceAffineTileTransformWork;
  scaleTranslationPlan?: ReferenceLocalSpaceScaleTranslationPlan;
  transform?: ReferenceLocalSpaceAffineTransformRequest;
  policyHiddenBy?: ReferenceLocalSpaceCompositionTransformPreflightEntry["policyHiddenBy"];
  componentPlan?: ReferenceComponentFragmentLocalSpacePlan;
  semanticMatch?: ReferenceSemanticMatchSample;
  trackPlan?: ReferenceTrack2DLocalSpacePlan;
}>;

export type ReferenceAnchoredPathFrameEvidence = Readonly<{
  schema: "cut.reference.anchored-path-frame.v1" | "cut.reference.anchored-path-frame.v2";
  algorithmVersion?: "cut-reference-anchored-path-media-camera-v2";
  consumerNodeId: string;
  consumerOp: "cut.visual.path" | "cut.visual.motion_path";
  exactTime: Rational;
  outputFrame?: string;
  authoredGeometryIdentity: string;
  identityComponentFragment?: NonNullable<
    ReferenceValidatedAnchoredPathGeometry["identityComponentFragment"]
  >;
  status: "resolved" | "policy-hidden";
  executionIdentity: string;
  /** Final composition-sized RGBA output of this consumer when it reached the
   * renderer. Optional only for historical receipts and policy-hidden
   * preflight evidence that never produced a surface. */
  outputRgbaSha256?: string;
  geometryIdentity?: string;
  anchors?: Extract<ReferenceAnchoredPathResolution, { status: "resolved" }>["anchors"];
  geometry?: Extract<ReferenceAnchoredPathResolution, { status: "resolved" }>["geometry"];
  suppressedBy?: Extract<ReferenceAnchoredPathResolution, { status: "policy-hidden" }>["suppressedBy"];
  zeroWork?: Extract<ReferenceAnchoredPathResolution, { status: "policy-hidden" }>["zeroWork"];
  evidenceIdentity: string;
}>;

export type ReferenceDiagramLayoutRenderedNodeEvidence = Readonly<{
  id: string;
  nodeId: string;
  phase: string;
  displayCenterQ16: ReferenceDiagramLayoutFrame["nodes"][number]["displayCenterQ16"];
  displayRectQ16: ReferenceDiagramLayoutFrame["nodes"][number]["displayRectQ16"];
  opacityQ16: number;
  tileIdentity: string;
  rasterCacheKey: string;
  rasterCacheRequest: "materialized" | "scene-frame-memo-hit";
  rasterCacheReceiptIdentity: string;
  tileRgbaSha256: string;
  placementIdentity: string;
  placedRgbaSha256: string;
  visibleAlphaPixels: number;
  maximumAlpha: number;
}>;

export type ReferenceDiagramLayoutRenderedEdgeEvidence = Readonly<{
  id: string;
  phase: string;
  pointsQ16: ReferenceDiagramLayoutFrame["edges"][number]["pointsQ16"];
  visiblePointsQ16: ReferenceDiagramLayoutFrame["edges"][number]["visiblePointsQ16"];
  trimEndQ16: number;
  terminalTangentQ16: ReferenceDiagramLayoutFrame["edges"][number]["terminalTangentQ16"];
  paint: ReferenceDiagramLayoutFrame["edges"][number]["paint"];
  rasterIdentity: string;
  rasterCacheKey: string;
  rasterCacheRequest: "materialized" | "scene-frame-memo-hit";
  rasterCacheReceiptIdentity: string;
  rasterBounds: Readonly<{ left: number; top: number; width: number; height: number }>;
  rasterTileRgbaSha256: string;
  rgbaSha256: string;
  visibleAlphaPixels: number;
  maximumAlpha: number;
}>;

export type ReferenceDiagramLayoutFrameEvidence = Readonly<{
  format: "cut-reference-diagram-layout-frame-evidence";
  version: 2;
  evidenceKind: "completed-public-diagram-layout-frame";
  algorithmVersion: typeof referenceDiagramLayoutAlgorithmVersion;
  compositionId: string;
  nodeId: string;
  exactTime: Rational;
  sceneLocalTime: Rational;
  outputFrame: string;
  plannerFrame: ReferenceDiagramLayoutFrame;
  cacheScope: "persistent-cross-render";
  rasterCache: Readonly<{
    cacheLayer: "diagram-subscene-rgba";
    multiProcessCoordination: "not-claimed";
    receipts: readonly ReferenceDiagramRasterCacheReceipt[];
  }>;
  nodes: readonly ReferenceDiagramLayoutRenderedNodeEvidence[];
  edges: readonly ReferenceDiagramLayoutRenderedEdgeEvidence[];
  counters: Readonly<{
    admittedCanvasPixels: number;
    admittedPixelPasses: number;
    maximumLiveSurfacePixels: number;
    maximumConcurrentDiagramLayouts: number;
    nodeTileRequests: number;
    nodeTileRasterizations: number;
    nodeTileMemoHits: number;
    edgeRasterRequests: number;
    edgeRasterizations: number;
    edgeRasterMemoHits: number;
    persistentLookups: number;
    persistentHits: number;
    persistentMisses: number;
    sameProcessCoalescedWaits: number;
    persistentBuilderExecutions: number;
    persistentBytesRead: number;
    persistentBytesWritten: number;
    persistentManifestsValidated: number;
    persistentEvictedEntries: number;
    persistentEvictedBytes: number;
  }>;
  outputRgbaSha256: string;
  executionIdentity: string;
  observationIdentity: string;
}>;

type MutableReferenceDiagramLayoutCounters = {
  admittedCanvasPixels: number;
  admittedPixelPasses: number;
  maximumLiveSurfacePixels: number;
  maximumConcurrentDiagramLayouts: number;
  nodeTileRequests: number;
  nodeTileRasterizations: number;
  nodeTileMemoHits: number;
  edgeRasterRequests: number;
  edgeRasterizations: number;
  edgeRasterMemoHits: number;
  persistentLookups: number;
  persistentHits: number;
  persistentMisses: number;
  sameProcessCoalescedWaits: number;
  persistentBuilderExecutions: number;
  persistentBytesRead: number;
  persistentBytesWritten: number;
  persistentManifestsValidated: number;
  persistentEvictedEntries: number;
  persistentEvictedBytes: number;
};

type ReferenceDiagramCachedSurface = Readonly<{
  surface: RawSurface;
  receipt: ReferenceDiagramRasterCacheReceipt;
  rasterBounds?: Readonly<{ left: number; top: number; width: number; height: number }>;
}>;

const referenceDiagramLocalRasterOps = new Set([
  "cut.kernel.fragment",
  "cut.visual.group",
  "cut.visual.rect",
  "cut.visual.circle",
  "cut.visual.path",
  "cut.visual.trace",
  "cut.visual.text",
  "cut.visual.flow_text",
]);

export class ReferenceDiagramLayoutRenderError extends Error {
  readonly source: Readonly<{ module: string; line: number; column: number; nodeId: string }>;

  constructor(
    readonly code: CutDiagramDiagnosticCode,
    readonly path: string,
    node: IRNode,
    detail: string,
    readonly nodeId = node.id,
    cause?: unknown,
  ) {
    const { module, span } = node.provenance;
    super(`${code}: DiagramLayout at ${module}:${span.start.line}:${span.start.column} ${detail} (${path})`, { cause });
    this.name = "ReferenceDiagramLayoutRenderError";
    this.source = Object.freeze({ module, line: span.start.line, column: span.start.column, nodeId });
  }
}

function referenceDiagramRenderFailure(
  code: "CUT_DIAGRAM_BOUNDS" | "CUT_DIAGRAM_TYPE" | "CUT_DIAGRAM_LIMIT",
  node: IRNode,
  detail: string,
): never {
  throw new ReferenceDiagramLayoutRenderError(
    code,
    `$.nodes.${JSON.stringify(node.id)}`,
    node,
    `${node.op} ${detail}`,
  );
}

function referenceDiagramPlannerFailure(layoutNode: IRNode, error: unknown): never {
  if (!(error instanceof CutDiagramContractError)) throw error;
  throw new ReferenceDiagramLayoutRenderError(
    error.code,
    error.path,
    layoutNode,
    error.message.replace(new RegExp(`^${error.code}:\\s*`, "u"), ""),
    error.nodeId ?? layoutNode.id,
    error,
  );
}

function referenceDiagramNodeLocalContext(
  ir: CutAVIR,
  layout: CutDiagramLayoutContract,
  diagramNode: CutDiagramLayoutContract["nodes"][number],
  plannerContext: ReferenceDiagramNodeRasterContext,
) {
  const width = Number(diagramNode.width.numerator), height = Number(diagramNode.height.numerator);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
    return referenceDiagramRenderFailure("CUT_DIAGRAM_BOUNDS", diagramNode.node, "has non-whole raster bounds after contract validation.");
  }
  if (plannerContext.layoutNodeId !== layout.id || plannerContext.diagramNodeIrId !== diagramNode.node.id
    || plannerContext.diagramNodeId !== diagramNode.id || plannerContext.width !== width || plannerContext.height !== height) {
    return referenceDiagramRenderFailure("CUT_DIAGRAM_BOUNDS", diagramNode.node, "does not match its prepared planner-owned local raster context.");
  }
  const descendants: IRNode[] = [], visited = new Set<string>(), pending = [...diagramNode.node.children].reverse();
  while (pending.length) {
    const nodeId = pending.pop()!;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    const node = ir.nodes[nodeId];
    if (!node) return referenceDiagramRenderFailure("CUT_DIAGRAM_BOUNDS", diagramNode.node, `references missing bounded descendant ${JSON.stringify(nodeId)}.`);
    if (!referenceDiagramLocalRasterOps.has(node.op)) {
      return referenceDiagramRenderFailure("CUT_DIAGRAM_TYPE", node, "is unsupported in the DiagramNode bounded local raster; no delivery-canvas fallback is permitted.");
    }
    descendants.push(node);
    pending.push(...[...node.children].reverse());
  }
  const origin = Object.freeze({ x: rational(width, 2), y: rational(height, 2) });
  const subtreePaintIdentity = hash(descendants.map((node) => Object.freeze({ op: node.op, contentHash: node.contentHash })));
  const layoutEnd = addRational(layout.node.interval.start, layout.node.interval.duration);
  const temporalRasterMode = descendants.every((node) => {
    const nodeEnd = addRational(node.interval.start, node.interval.duration);
    const hasPropertySignal = Object.values(node.properties).some((value) => "signal" in value);
    const hasIntrinsicMotion = node.op === "cut.visual.trace"
      || (node.op === "cut.visual.flow_text" && node.inputs.motions !== undefined);
    return !hasIntrinsicMotion
      && !hasPropertySignal
      && compareRational(node.interval.start, layout.node.interval.start) <= 0
      && compareRational(nodeEnd, layoutEnd) >= 0;
  }) ? "static" as const : "sampled" as const;
  const context: ReferenceDiagramNodeLocalContext = Object.freeze({
    contextKind: "diagram-node",
    nodeId: diagramNode.node.id,
    layoutNodeId: layout.id,
    diagramNodeId: diagramNode.id,
    width,
    height,
    origin,
    rasterOriginQ16: Object.freeze({ x: String(plannerContext.originQ16.xQ16), y: String(plannerContext.originQ16.yQ16) }),
    view: Object.freeze({ minX: rational(-width, 2), minY: rational(-height, 2), maxX: rational(width, 2), maxY: rational(height, 2) }),
    childIds: Object.freeze([...diagramNode.node.children]),
    semanticIdentity: plannerContext.semanticIdentity,
    subtreePaintIdentity,
    temporalRasterMode,
    plannerContext,
  });
  return Object.freeze({ context, descendants: Object.freeze(descendants) });
}

function referenceDiagramTransitionSamples(
  ir: CutAVIR,
  composition: IRComposition,
  contract: CutDiagramLayoutContract,
  resolver: ReferencePreparedSignalResolver,
) {
  if (!contract.fromState) return undefined;
  const node = contract.node;
  return referenceDiagramTransitionSamplesAtOutputFrames({
    intervalStart: node.interval.start,
    intervalDuration: node.interval.duration,
    fps: composition.fps,
    layoutId: node.id,
    path: `$.nodes.${JSON.stringify(node.id)}.interval`,
    progressAt: (at) => {
      const value = propertyAt(ir, node, "progress", at, resolver) ?? node.inputs.progress;
      if (value?.kind !== "quantity" || value.dimension !== "ratio" || value.unit !== "ratio") {
        return referenceDiagramRenderFailure("CUT_DIAGRAM_TYPE", node, "progress did not evaluate to an exact Ratio at an admitted output sample.");
      }
      return rational(value.magnitude.numerator, value.magnitude.denominator);
    },
  });
}

const localSpaceCodeValueScale16 = 257;

function straightRgba8To16(surface: RawSurface): StraightRgba16Surface {
  const data = new Uint16Array(surface.width * surface.height * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = surface.data[offset] * localSpaceCodeValueScale16;
    data[offset + 1] = surface.data[offset + 1] * localSpaceCodeValueScale16;
    data[offset + 2] = surface.data[offset + 2] * localSpaceCodeValueScale16;
    data[offset + 3] = surface.data[offset + 3] * localSpaceCodeValueScale16;
  }
  return { data, width: surface.width, height: surface.height };
}

function associateStraightRgba16(surface: StraightRgba16Surface) {
  const data = new Uint16Array(surface.data.length);
  for (let offset = 0; offset < data.length; offset += 4) {
    const alpha = surface.data[offset + 3];
    data[offset] = Math.round(surface.data[offset] * alpha / 65_535);
    data[offset + 1] = Math.round(surface.data[offset + 1] * alpha / 65_535);
    data[offset + 2] = Math.round(surface.data[offset + 2] * alpha / 65_535);
    data[offset + 3] = alpha;
  }
  return data;
}

/** libvips accepts an explicitly associated rgb16 input and returns
 * unassociated rgb16 samples. Every filtering stage re-associates its input,
 * so transparent or low-coverage RGB cannot bleed into the next stage. */
async function filterLocalSpaceAssociatedRgba16(
  surface: StraightRgba16Surface,
  operation: (pipeline: ReturnType<typeof sharp>) => ReturnType<typeof sharp>,
): Promise<StraightRgba16Surface> {
  const associated = associateStraightRgba16(surface);
  const rendered = await operation(sharp(associated, {
    raw: { width: surface.width, height: surface.height, channels: 4, premultiplied: true },
  }).pipelineColourspace("rgb16"))
    .toColourspace("rgb16")
    .raw({ depth: "ushort" })
    .toBuffer({ resolveWithObject: true });
  const pixels = rendered.info.width * rendered.info.height;
  if (rendered.info.channels !== 4 || rendered.data.byteLength !== pixels * 8) {
    throw new Error("CUT_LOCAL_SPACE_RASTER: associated rgb16 transform returned an invalid four-channel surface.");
  }
  const view = new Uint16Array(rendered.data.buffer, rendered.data.byteOffset, rendered.data.byteLength / Uint16Array.BYTES_PER_ELEMENT);
  return { data: new Uint16Array(view), width: rendered.info.width, height: rendered.info.height };
}

function straightRgba16To8(surface: StraightRgba16Surface): RawSurface {
  const data = Buffer.alloc(surface.width * surface.height * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    const alpha = Math.max(0, Math.min(255, Math.round(surface.data[offset + 3] / localSpaceCodeValueScale16)));
    data[offset + 3] = alpha;
    if (alpha === 0) continue;
    data[offset] = Math.max(0, Math.min(255, Math.round(surface.data[offset] / localSpaceCodeValueScale16)));
    data[offset + 1] = Math.max(0, Math.min(255, Math.round(surface.data[offset + 1] / localSpaceCodeValueScale16)));
    data[offset + 2] = Math.max(0, Math.min(255, Math.round(surface.data[offset + 2] / localSpaceCodeValueScale16)));
  }
  return { data, width: surface.width, height: surface.height };
}

async function applyParallaxFocusBlur(surface: RawSurface, sigma: number) {
  if (sigma === 0) return surface;
  return applyReferenceVisualEffect({ kind: "blur", radius: sigma }, surface);
}

type PreparedReferenceText = {
  config: ReferenceTextConfig;
  font: LockedOpenTypeFont;
  lines: readonly (LockedGlyphRun | undefined)[];
  outlineCommands: number;
  outlineBytes: number;
};

const raw = (surface: RawSurface) => ({ raw: { width: surface.width, height: surface.height, channels: 4 as const } });
const colorGradeSrgbToLinearBytes = Float64Array.from({ length: 256 }, (_, value) => {
  const encoded = value / 255;
  return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
});

function colorGradeLinearToSrgb(value: number) {
  const bounded = Math.max(0, Math.min(1, value));
  return bounded <= 0.0031308 ? bounded * 12.92 : 1.055 * bounded ** (1 / 2.4) - 0.055;
}

/**
 * Execute CUT's bounded creative-balance stage in straight-alpha linear-light
 * sRGB. The fixed channel exponents sum to zero, so temperature/tint keep a
 * neutral geometric-mean gain while exposure alone supplies overall gain:
 *
 *   R = 2^(exposure + temperature/2 + tint/4)
 *   G = 2^(exposure - tint/2)
 *   B = 2^(exposure - temperature/2 + tint/4)
 *
 * This is deliberately a deterministic creative control, not chromatic
 * adaptation from Kelvin/camera metadata and not a color-management transform.
 */
function applyReferenceLinearColorBalance(surface: RawSurface, exposureStops: number, temperature: number, tint: number): RawSurface {
  if (exposureStops === 0 && temperature === 0 && tint === 0) return surface;
  const gains = [
    2 ** (exposureStops + temperature / 2 + tint / 4),
    2 ** (exposureStops - tint / 2),
    2 ** (exposureStops - temperature / 2 + tint / 4),
  ];
  // CUT's input contract is exactly one encoded-sRGB byte per channel. Build
  // the complete 256-entry result law once per channel so every source byte
  // retains the frozen scalar result without repeating pow() for every pixel.
  const channelLuts = gains.map((gain) => Uint8Array.from(
    { length: 256 },
    (_, value) => Math.round(colorGradeLinearToSrgb(colorGradeSrgbToLinearBytes[value] * gain) * 255),
  ));
  const data = Buffer.alloc(surface.data.byteLength);
  for (let offset = 0; offset < data.byteLength; offset += 4) {
    data[offset] = channelLuts[0][surface.data[offset]];
    data[offset + 1] = channelLuts[1][surface.data[offset + 1]];
    data[offset + 2] = channelLuts[2][surface.data[offset + 2]];
    data[offset + 3] = surface.data[offset + 3];
  }
  return { ...surface, data };
}

function quantityNumber(value: IRValue | undefined, fallback = 0) { return value?.kind === "quantity" ? rationalToNumber(value.magnitude) : fallback; }
function stringValue(value: IRValue | undefined, fallback = "") { return value?.kind === "string" ? value.value : value?.kind === "symbol" ? value.name.split("#").at(-1) ?? value.name : fallback; }
function booleanValue(value: IRValue | undefined, fallback = false) { return value?.kind === "boolean" ? value.value : fallback; }
function colorValue(value: IRValue | undefined, fallback = "#ffffff") { return value?.kind === "color" ? value.value : value?.kind === "string" ? value.value : fallback; }
function objectValue(value: IRValue | undefined) { return value?.kind === "object" ? value.entries : undefined; }
function arrayValue(value: IRValue | undefined) { return value?.kind === "array" ? value.items : []; }

/**
 * The kernel registry is the single ownership contract for same-named static
 * geometry and compositor controls. A primitive that draws at its own x/y
 * must not also receive the constructor coordinates as an outer transform;
 * ordinary media and retained leaves, conversely, must not silently discard
 * those coordinates. The intrinsic registry flag concerns the constructor
 * input; property-track ownership remains with the operation-specific
 * executor or the generic compositor contract.
 */
function referenceGenericVisualTransformOwnership(node: IRNode) {
  const schema = referenceKernelSchema(node.op);
  if (!schema || schema.support !== "supported") {
    return Object.freeze({ staticPosition: true, staticRotation: true });
  }
  const intrinsicX = kernelPropertyInputIsIntrinsic(schema, "x");
  const intrinsicY = kernelPropertyInputIsIntrinsic(schema, "y");
  if (intrinsicX !== intrinsicY) {
    throw new Error(`CUT_VISUAL_KERNEL_OWNERSHIP: ${node.op} must declare x and y constructor ownership together.`);
  }
  const intrinsicRotation = kernelPropertyInputIsIntrinsic(schema, "rotation");
  return Object.freeze({
    staticPosition: !intrinsicX,
    staticRotation: !intrinsicRotation,
  });
}

function exactMediaFrameIndex(local: Rational, fps: Rational) {
  const exact = multiplyRational(local, fps);
  const numerator = BigInt(exact.numerator), denominator = BigInt(exact.denominator);
  if (numerator <= 0n) return 0;
  const index = numerator / denominator;
  if (index > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("CUT exact media frame index exceeds the safe integer range.");
  return Number(index);
}

function executeMotionBlurOwned<T>(node: IRNode, work: () => T): T {
  try { return work(); }
  catch (error) {
    if (error instanceof ReferenceMotionBlurError) throwReferenceMotionBlurNodeError(node, error);
    throw error;
  }
}

function transitionColor(value: string): ReferenceTransitionColor {
  if (!/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(value)) throw new Error("CUT PictureTrack dip transition carries an invalid typed color.");
  return [
    Number.parseInt(value.slice(1, 3), 16) / 255,
    Number.parseInt(value.slice(3, 5), 16) / 255,
    Number.parseInt(value.slice(5, 7), 16) / 255,
    value.length === 9 ? Number.parseInt(value.slice(7, 9), 16) / 255 : 1,
  ];
}

function pictureTrackTransitionStyle(style: NonNullable<Extract<NonNullable<IRNode["editorial"]>, { kind: "picture-track" }>["transitions"]>[number]["style"]): ReferencePictureTransition {
  if (style.kind === "cross-dissolve") return { kind: style.kind, direction: "left", softness: 0, dipColor: [0, 0, 0, 1] };
  if (style.kind === "dip") return { kind: style.kind, direction: "left", softness: 0, dipColor: transitionColor(style.color) };
  if (style.kind === "wipe") return { kind: style.kind, direction: style.direction, softness: rationalToNumber(style.softness), dipColor: [0, 0, 0, 1] };
  return { kind: style.kind, direction: style.direction, softness: 0, dipColor: [0, 0, 0, 1] };
}

function referencesResource(value: IRValue, resourceId: string): boolean {
  if (value.kind === "resource-ref") return value.id === resourceId;
  if (value.kind === "array") return value.items.some((item) => referencesResource(item, resourceId));
  if (value.kind === "object") return Object.values(value.entries).some((item) => referencesResource(item, resourceId));
  if (value.kind === "range") return referencesResource(value.start, resourceId) || referencesResource(value.end, resourceId);
  if (value.kind === "unary") return referencesResource(value.value, resourceId);
  if (value.kind === "binary") return referencesResource(value.left, resourceId) || referencesResource(value.right, resourceId);
  if (value.kind === "member") return referencesResource(value.object, resourceId);
  if (value.kind === "index") return referencesResource(value.object, resourceId) || referencesResource(value.index, resourceId);
  if (value.kind === "call") return value.positional.some((item) => referencesResource(item, resourceId)) || Object.values(value.named).some((item) => referencesResource(item, resourceId));
  return false;
}

function collectReferencedResourceIds(value: IRValue, result: Set<string>) {
  if (value.kind === "resource-ref") result.add(value.id);
  else if (value.kind === "array") value.items.forEach((item) => collectReferencedResourceIds(item, result));
  else if (value.kind === "object") Object.values(value.entries).forEach((item) => collectReferencedResourceIds(item, result));
  else if (value.kind === "range") {
    collectReferencedResourceIds(value.start, result);
    collectReferencedResourceIds(value.end, result);
  } else if (value.kind === "unary") collectReferencedResourceIds(value.value, result);
  else if (value.kind === "binary") {
    collectReferencedResourceIds(value.left, result);
    collectReferencedResourceIds(value.right, result);
  } else if (value.kind === "member") collectReferencedResourceIds(value.object, result);
  else if (value.kind === "index") {
    collectReferencedResourceIds(value.object, result);
    collectReferencedResourceIds(value.index, result);
  } else if (value.kind === "call") {
    value.positional.forEach((item) => collectReferencedResourceIds(item, result));
    Object.values(value.named).forEach((item) => collectReferencedResourceIds(item, result));
  }
}

async function readBoundedLockedBytes(path: string, expectedBytes: number, maximumBytes: number, expectedSha256: string | undefined, label: string) {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > maximumBytes) throw new Error(`${label} is missing a safe byte count or exceeds its ${maximumBytes}-byte budget.`);
  if (!expectedSha256 || !/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error(`${label} is missing its locked SHA-256.`);
  const handle = await open(path, "r");
  try {
    const before = await handle.stat();
    if (before.size !== expectedBytes) throw new Error(`${label} byte count changed before preparation.`);
    const bytes = Buffer.alloc(expectedBytes); let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesRead === 0) throw new Error(`${label} ended before its locked byte count.`);
      offset += result.bytesRead;
    }
    const trailing = Buffer.alloc(1), extra = await handle.read(trailing, 0, 1, expectedBytes);
    if (extra.bytesRead !== 0) throw new Error(`${label} grew beyond its locked byte count during preparation.`);
    const after = await handle.stat();
    if (after.size !== expectedBytes) throw new Error(`${label} byte count changed during preparation.`);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== expectedSha256) throw new Error(`${label} bytes changed before preparation.`);
    return bytes;
  } finally { await handle.close(); }
}

function lockedVideoSelection(ir: CutAVIR, resourceId: string) {
  const probe = ir.resources[resourceId]?.metadata?.probe as LockedResourceProbe | undefined;
  const selected = probe?.kind === "media" ? probe.selected.video : undefined, streamIndex = selected?.streamIndex;
  if (typeof streamIndex !== "number" || !Number.isSafeInteger(streamIndex) || streamIndex < 0) {
    throw new Error(`Locked video resource ${resourceId} has no validated selected video stream.`);
  }
  const stream = probe?.kind === "media" ? probe.identity.streams.find((candidate) => candidate.index === streamIndex && candidate.type === "video") : undefined;
  if (!stream) throw new Error(`Locked video resource ${resourceId} selected stream is absent from its raw probe.`);
  if (!stream.start || compareRational(stream.start, zeroRational) < 0) throw new Error(`Locked video resource ${resourceId} selected stream has no exact non-negative start.`);
  if (!stream.timeBase || compareRational(stream.timeBase, zeroRational) <= 0) throw new Error(`Locked video resource ${resourceId} selected stream has no positive exact time base.`);
  const frameRate = selected?.frameRate ?? stream.frameRate;
  if (!frameRate || compareRational(frameRate, zeroRational) <= 0) throw new Error(`Locked video resource ${resourceId} selected stream has no positive exact selected frame rate.`);
  return { streamIndex, durationSource: selected!.durationSource, start: stream.start, timeBase: stream.timeBase, frameRate, decodedVideoCadence: selected!.decodedVideoCadence };
}

function lockedAudioSelection(ir: CutAVIR, resourceId: string) {
  const probe = ir.resources[resourceId]?.metadata?.probe as LockedResourceProbe | undefined;
  const selected = probe?.kind === "media" ? probe.selected.audio : undefined, streamIndex = selected?.streamIndex;
  if (typeof streamIndex !== "number" || !Number.isSafeInteger(streamIndex) || streamIndex < 0) {
    throw new Error(`Locked audio resource ${resourceId} has no validated selected audio stream.`);
  }
  const stream = probe?.kind === "media" ? probe.identity.streams.find((candidate) => candidate.index === streamIndex && candidate.type === "audio") : undefined;
  if (!stream?.sampleRate || !Number.isSafeInteger(stream.sampleRate) || stream.sampleRate < 1 || !selected) throw new Error(`Locked audio resource ${resourceId} selected stream has no exact sample rate or duration.`);
  return { streamIndex, sampleRate: stream.sampleRate, duration: selected.duration };
}

function exactDecodedFrameIndex(value: Rational, frameRate: Rational, label: string) {
  const exact = multiplyRational(value, frameRate);
  if (exact.denominator !== "1") throw new Error(`${label} does not land on the selected stream's exact ideal frame grid.`);
  const frame = BigInt(exact.numerator);
  if (frame < 0n || frame > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} exceeds the safe decoded-frame range.`);
  return Number(frame);
}

function boundedOutputFrameCount(duration: Rational, frameRate: Rational, label: string) {
  const exact = multiplyRational(duration, frameRate), numerator = BigInt(exact.numerator), denominator = BigInt(exact.denominator);
  if (numerator <= 0n) throw new Error(`${label} must contain at least one output frame.`);
  const count = (numerator + denominator - 1n) / denominator;
  if (count > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} exceeds the safe output-frame range.`);
  return Number(count);
}

function transparent(width: number, height: number): RawSurface { return { data: Buffer.alloc(width * height * 4), width, height }; }

/** Share an immutable completed Uint8Array allocation with the Buffer-typed
 * compositor boundary. Buffer.from(view) would silently allocate a second
 * delivery- or crop-sized surface and make the camera receipt false. */
function sharedBufferView(view: Uint8Array) {
  if (Buffer.isBuffer(view)) return view;
  const shared = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
  shareReferenceRetainedSurfaceAlphaSupportAuthority(view, shared);
  return shared;
}

function blendMode(node: IRNode): RgbaBlendMode {
  const value = node.inputs.blend;
  if (value === undefined) return "normal";
  if (value.kind !== "string" || !rgbaBlendModes.includes(value.value as RgbaBlendMode)) {
    throw new Error(`${node.op} blend at ${node.provenance.module}:${node.provenance.span.start.line}:${node.provenance.span.start.column} must be one of: ${rgbaBlendModes.join(", ")}.`);
  }
  return value.value as RgbaBlendMode;
}

function rgbaResultSurface(result: ReturnType<typeof compositeRgba>): RawSurface {
  return { data: Buffer.from(result.data), width: result.width, height: result.height };
}

/** Mutate only a private, caller-owned composition accumulator. This keeps the
 * public pure compositor contract intact while removing one output allocation
 * and one full-surface Buffer copy per ordered retained layer. */
function compositeIntoPrivateAccumulator(
  backdrop: RawSurface,
  source: RawSurface,
  mode: RgbaBlendMode,
): RawSurface {
  const result = compositeRgbaInPlace(backdrop, source, {
    mode,
    outputAlphaMode: "straight",
  });
  return {
    data: sharedBufferView(result.data),
    width: result.width,
    height: result.height,
  };
}

type ReferenceLocalPrivateSourceAlphaBoundsEntry = Readonly<{
  data: Buffer;
  width: number;
  height: number;
  bounds: ReferencePrivateRgbaSourceAlphaBounds;
}>;
const localPrivateSourceAlphaBounds = new WeakMap<RawSurface, ReferenceLocalPrivateSourceAlphaBoundsEntry>();
export const referenceLocalSpaceAlphaBoundedTranslationAlgorithmVersion =
  "cut-reference-local-space-alpha-bounded-translation-v2" as const;

function localPrivateAccumulator(width: number, height: number) {
  return createReferencePrivateStraightRgbaAccumulator(width, height);
}

/**
 * Reuse one unforgeable receipt only while the runtime-owned surface wrapper
 * still names the exact same bytes and dimensions. Video/native stages may
 * deliberately reuse a wrapper while replacing its current frame Buffer; a
 * wrapper-only WeakMap key would then hand the compositor authority for the
 * previous frame and correctly trip its immutable-byte boundary.
 */
function localPrivateAlphaBounds(source: RawSurface) {
  const cached = localPrivateSourceAlphaBounds.get(source);
  if (cached
    && cached.data === source.data
    && cached.width === source.width
    && cached.height === source.height) {
    return cached.bounds;
  }
  const bounds = referencePrivateStraightRgbaAccumulatorAlphaBounds(source)
    ?? deriveReferencePrivateRgbaSourceAlphaBounds(source);
  localPrivateSourceAlphaBounds.set(source, Object.freeze({
    data: source.data,
    width: source.width,
    height: source.height,
    bounds,
  }));
  return bounds;
}

/** Cache exact support derived inside a producer-proved conservative paint
 * rectangle. The full-surface mode is an internal same-build counterfactual;
 * it changes scan work only, never authored pixels. */
function primeLocalPrivateAlphaBounds(
  source: RawSurface,
  scanBounds: Readonly<{ left: number; top: number; right: number; bottom: number }>,
  mode: "automatic" | "forced-full-surface",
) {
  const bounds = mode === "automatic"
    ? deriveReferencePrivateRgbaSourceAlphaBoundsWithin(source, scanBounds)
    : deriveReferencePrivateRgbaSourceAlphaBounds(source);
  localPrivateSourceAlphaBounds.set(source, Object.freeze({
    data: source.data,
    width: source.width,
    height: source.height,
    bounds,
  }));
  return source;
}

/** LocalSpace-only bounded composition. The source receipt is derived from its
 * actual alpha bytes once per immutable surface object; only the branded
 * canonical accumulator is mutated. */
function compositeIntoLocalPrivateAccumulator(
  backdrop: ReferencePrivateStraightRgbaAccumulator,
  source: RawSurface,
  mode: RgbaBlendMode,
  diagnostic?: ReferencePrivateStraightRgbaCompositeDiagnostic,
) {
  const bounds = localPrivateAlphaBounds(source);
  // A completed accumulator may later become a source for its parent, but it
  // cannot retain a stale source-bounds receipt if it is mutated again first.
  localPrivateSourceAlphaBounds.delete(backdrop);
  return compositeRgbaIntoReferencePrivateStraightAccumulator(backdrop, source, bounds, { mode, diagnostic });
}

/**
 * LocalSpace-only exact translation. Fractional retained sampling ignores
 * hidden RGB under zero alpha by contract, so one authority-derived tight
 * source crop is byte-equivalent to sampling the surrounding transparent
 * canvas. Integer placement retains the untouched hidden-RGB byte path while
 * propagating the already-derived exact support when clipping admits it whole.
 */
export function translateReferenceLocalSpaceSurface(
  surface: RawSurface,
  canvasWidth: number,
  canvasHeight: number,
  left: number,
  top: number,
) {
  const bounds = localPrivateAlphaBounds(surface);
  return translateReferenceRetainedSurfaceWithinAlphaSupport(
    surface,
    canvasWidth,
    canvasHeight,
    left,
    top,
    bounds,
  );
}

/** Local compositing publishes a strict straight-alpha boundary. RGB beneath
 * zero alpha is canonical zero even when an RGB-only backend stage (notably
 * ColorGrade contrast) would otherwise leave unobservable code values. */
function canonicalLocalStraightRgba(surface: RawSurface): RawSurface {
  let output: Buffer | undefined;
  for (let offset = 0; offset < surface.data.byteLength; offset += 4) {
    if (surface.data[offset + 3] !== 0 || surface.data[offset] === 0 && surface.data[offset + 1] === 0 && surface.data[offset + 2] === 0) continue;
    output ??= Buffer.from(surface.data);
    output[offset] = 0; output[offset + 1] = 0; output[offset + 2] = 0;
  }
  return output ? { ...surface, data: output } : surface;
}

async function svgSurface(svg: string, width: number, height: number): Promise<RawSurface> {
  const data = await sharp(Buffer.from(svg), { density: 144 }).resize(width, height).ensureAlpha().raw().toBuffer(); return { data, width, height };
}

async function composite(width: number, height: number, surfaces: Array<RawSurface | undefined>) {
  const visible = surfaces.filter((item): item is RawSurface => Boolean(item)); if (!visible.length) return transparent(width, height);
  const base = transparent(width, height); const data = await sharp(base.data, raw(base)).composite(visible.map((item) => ({ input: item.data, raw: raw(item).raw, left: 0, top: 0 }))).raw().toBuffer();
  return { data, width, height };
}

/** LocalSpace paint-order composition shares CUT's explicit straight-alpha
 * source-over implementation rather than delegating blend arithmetic to the
 * backend. Every layer is already clipped to the exact declared tile. */
function compositeStraightLayers(width: number, height: number, surfaces: Array<RawSurface | undefined>) {
  let result = transparent(width, height);
  for (const surface of surfaces) {
    if (!surface) continue;
    if (surface.width !== width || surface.height !== height) {
      throw new Error(`CUT LocalSpace layer ${surface.width}x${surface.height} does not match its ${width}x${height} coordinate context.`);
    }
    result = compositeIntoPrivateAccumulator(result, surface, "normal");
  }
  return result;
}

function scaleAlpha(surface: RawSurface, opacity: number) {
  if (opacity === 1) return surface; const data = Buffer.from(surface.data); const amount = opacity;
  for (let offset = 3; offset < data.length; offset += 4) data[offset] = Math.round(data[offset] * amount);
  return { ...surface, data };
}

function scaleLocalSpaceAlpha(
  surface: RawSurface,
  opacity: number,
  diagnostic?: ReferenceRetainedAlphaScaleDiagnostic,
) {
  if (opacity === 1 && !diagnostic) return surface;
  const scaled = scaleReferenceRetainedSurfaceAlpha(surface, opacity, diagnostic);
  return { data: sharedBufferView(scaled.data), width: scaled.width, height: scaled.height };
}

function referenceVisibleAlpha(surface: RawSurface) {
  let visibleAlphaPixels = 0, maximumAlpha = 0;
  for (let offset = 3; offset < surface.data.length; offset += 4) {
    const alpha = surface.data[offset];
    if (alpha > 0) visibleAlphaPixels += 1;
    maximumAlpha = Math.max(maximumAlpha, alpha);
  }
  return Object.freeze({ visibleAlphaPixels, maximumAlpha });
}

function referenceDiagramPointPixels(point: Readonly<{ xQ16: number; yQ16: number }>) {
  return Object.freeze({ x: point.xQ16 / referenceDiagramLayoutQ16Scale, y: point.yQ16 / referenceDiagramLayoutQ16Scale });
}

function placeReferenceDiagramRasterTile(
  tile: RawSurface,
  bounds: Readonly<{ left: number; top: number; width: number; height: number }>,
  canvasWidth: number,
  canvasHeight: number,
) {
  if (tile.width !== bounds.width || tile.height !== bounds.height
    || bounds.left < 0 || bounds.top < 0
    || bounds.left + bounds.width > canvasWidth || bounds.top + bounds.height > canvasHeight) {
    throw new Error("CUT_DIAGRAM_BOUNDS: cached edge tile does not match its admitted delivery-canvas bounds.");
  }
  const surface = transparent(canvasWidth, canvasHeight), rowBytes = bounds.width * 4;
  for (let row = 0; row < bounds.height; row += 1) {
    const source = row * rowBytes, destination = ((bounds.top + row) * canvasWidth + bounds.left) * 4;
    tile.data.copy(surface.data, destination, source, source + rowBytes);
  }
  return surface;
}

function centredResizeRasterOrigin(inputWidth: number, inputHeight: number, outputWidth: number, outputHeight: number) {
  // sharp's default two-dimensional resize is a centre-cropped uniform
  // `cover`, not two independent axis scales. libvips samples enlargements at
  // (source + .5) * scale and reductions at that coordinate minus .5. Track
  // that raster origin explicitly: the rounded output buffer's geometric
  // centre is not, in general, the transformed CUT composition centre.
  const resizeScale = Math.max(outputWidth / inputWidth, outputHeight / inputHeight);
  const intermediateWidth = Math.max(1, Math.round(inputWidth * resizeScale));
  const intermediateHeight = Math.max(1, Math.round(inputHeight * resizeScale));
  const cropLeft = Math.max(0, Math.floor((intermediateWidth - outputWidth + 1) / 2));
  const cropTop = Math.max(0, Math.floor((intermediateHeight - outputHeight + 1) / 2));
  const reductionPhase = resizeScale <= 1 ? -0.5 : 0;
  return {
    x: inputWidth / 2 * resizeScale + reductionPhase - cropLeft,
    y: inputHeight / 2 * resizeScale + reductionPhase - cropTop,
    scale: resizeScale,
  };
}

function affineRasterOrigin(
  x: number,
  y: number,
  inputWidth: number,
  inputHeight: number,
  a: number,
  b: number,
  c: number,
  d: number,
) {
  // libvips expands an arbitrary affine to the rounded bounding box of the
  // four continuous image-edge corners. Its automatic output displacement is
  // the negated, rounded minimum. Reproduce that displacement so placement is
  // based on the transformed CUT origin rather than the output bbox centre.
  const minimumX = Math.min(0, a * inputWidth, b * inputHeight, a * inputWidth + b * inputHeight);
  const minimumY = Math.min(0, c * inputWidth, d * inputHeight, c * inputWidth + d * inputHeight);
  return {
    x: a * x + b * y + Math.round(-minimumX),
    y: c * x + d * y + Math.round(-minimumY),
  };
}

function rotatedRasterOrigin(x: number, y: number, inputWidth: number, inputHeight: number, outputWidth: number, outputHeight: number, rotation: number) {
  const normalized = ((rotation % 360) + 360) % 360;
  // sharp/libvips reduces arbitrary rotations to the shortest signed turn.
  // Match that reduction before trig so an exact negative half-coordinate
  // does not round to the opposite pixel after a large equivalent angle.
  const signed = normalized > 180 ? normalized - 360 : normalized;
  const radians = signed * Math.PI / 180, cosine = Math.cos(radians), sine = Math.sin(radians);
  if (normalized === 0 || normalized === 90 || normalized === 180 || normalized === 270) {
    // sharp uses lossless quarter-turn operations for exact multiples of 90,
    // whose pixel-centre convention differs from arbitrary-angle rotate.
    const inputCenterX = (inputWidth - 1) / 2, inputCenterY = (inputHeight - 1) / 2;
    const deltaX = x - inputCenterX, deltaY = y - inputCenterY;
    return {
      x: (outputWidth - 1) / 2 + cosine * deltaX - sine * deltaY,
      y: (outputHeight - 1) / 2 + sine * deltaX + cosine * deltaY,
    };
  }
  return affineRasterOrigin(x, y, inputWidth, inputHeight, cosine, -sine, sine, cosine);
}

function resizedRasterPoint(
  x: number,
  y: number,
  inputWidth: number,
  inputHeight: number,
  outputWidth: number,
  outputHeight: number,
) {
  if (inputWidth === outputWidth && inputHeight === outputHeight) return { x, y };
  const resizeScale = Math.max(outputWidth / inputWidth, outputHeight / inputHeight);
  const intermediateWidth = Math.max(1, Math.round(inputWidth * resizeScale));
  const intermediateHeight = Math.max(1, Math.round(inputHeight * resizeScale));
  const cropLeft = Math.max(0, Math.floor((intermediateWidth - outputWidth + 1) / 2));
  const cropTop = Math.max(0, Math.floor((intermediateHeight - outputHeight + 1) / 2));
  const reductionPhase = resizeScale <= 1 ? -0.5 : 0;
  return { x: x * resizeScale + reductionPhase - cropLeft, y: y * resizeScale + reductionPhase - cropTop };
}

type ReferenceLocalSpaceRuntimeTransformRequest = Readonly<{
  source: Readonly<{ width: number; height: number }>;
  destination: Readonly<{ width: number; height: number }>;
  scale: number;
  rotation: number;
  opacity: number;
  skewX: number;
  skewY: number;
}>;

/** Re-derive the allocator receipt from the values that will actually cross
 * the raster boundary. A stale, forged, or owner-mismatched plan therefore
 * fails at the source location before straight-RGBA is expanded to RGB16. */
export function validateReferenceLocalSpaceTransformExecutionPlan(
  sourceNode: IRNode,
  admittedWork: ReferenceLocalSpaceAffineTileTransformWork,
  request: ReferenceLocalSpaceRuntimeTransformRequest,
) {
  const derived = planReferenceLocalSpaceAffineTileTransformWork(sourceNode, {
    source: request.source,
    destination: request.destination,
    scale: request.scale,
    skewX: request.skewX,
    skewY: request.skewY,
    rotation: request.rotation,
    opacity: request.opacity,
  });
  if (hash(admittedWork) !== hash(derived)) {
    throw new ReferenceLocalSpaceError(
      "CUT_LOCAL_SPACE_RASTER",
      sourceNode,
      `admitted transform work ${admittedWork.workIdentity} does not match runtime-derived work ${derived.workIdentity}.`,
    );
  }
  return derived;
}

export function assertReferenceLocalSpaceObservedDimensions(
  sourceNode: IRNode,
  label: string,
  actual: Readonly<{ width: number; height: number }>,
  expected: Readonly<{ width: number; height: number }>,
) {
  if (actual.width !== expected.width || actual.height !== expected.height) {
    throw new ReferenceLocalSpaceError(
      "CUT_LOCAL_SPACE_RASTER",
      sourceNode,
      `${label} produced ${actual.width}x${actual.height}; admitted transform work requires ${expected.width}x${expected.height}.`,
    );
  }
}

type ReferenceRegisteredPlacementResult = Readonly<{
  surface: RawSurface;
  transformWork?: ReferenceLocalSpaceTransformExecutionEvidence;
}>;

/** Place an arbitrary retained registration point, not an inferred alpha-box
 * centre. Neutral placement reaches CUT's Q16 translator without backend
 * resampling, so exact half-pixel/fractional origins have one quantizer. */
async function placeRegisteredSurfaceOnCanvas(
  surface: RawSurface,
  width: number,
  height: number,
  registrationRasterX: number,
  registrationRasterY: number,
  destinationX: number,
  destinationY: number,
  scale: number,
  rotation: number,
  skewX = 0,
  skewY = 0,
  execution?: ReferenceLocalSpaceTransformExecutionBinding,
): Promise<ReferenceRegisteredPlacementResult> {
  const admitted = execution
    ? validateReferenceLocalSpaceTransformExecutionPlan(execution.sourceNode, execution.admittedWork, {
      source: Object.freeze({ width: surface.width, height: surface.height }),
      destination: Object.freeze({ width, height }),
      scale,
      rotation,
      opacity: execution.opacity,
      skewX,
      skewY,
    })
    : undefined;
  if (admitted) assertReferenceLocalSpaceObservedDimensions(execution!.sourceNode, "retained source", surface, admitted.source);
  const executionEvidence = (
    rotationSurface: Readonly<{ width: number; height: number }>,
    scaleTranslation?: ReferenceLocalSpaceTransformExecutionEvidence["scaleTranslation"],
  ): ReferenceLocalSpaceTransformExecutionEvidence | undefined => admitted
    ? Object.freeze({
      workIdentity: admitted.workIdentity,
      algorithmVersion: admitted.algorithmVersion,
      rendererHandoff: referenceLocalSpaceTransformRendererHandoff,
      schedulingEnforcement: referenceLocalSpaceTransformSchedulingEnforcement,
      source: Object.freeze({ width: surface.width, height: surface.height }),
      requestedResize: Object.freeze({ width: admitted.requestedResize.width, height: admitted.requestedResize.height }),
      sharpCover: Object.freeze({ width: admitted.sharpCover.width, height: admitted.sharpCover.height }),
      ...(admitted.version === 3 ? { skew: Object.freeze({
        width: admitted.skew.width,
        height: admitted.skew.height,
        skewXDegrees: admitted.skew.skewXDegrees,
        skewYDegrees: admitted.skew.skewYDegrees,
      }) } : {}),
      rotation: Object.freeze({
        width: rotationSurface.width,
        height: rotationSurface.height,
        canonicalDegrees: admitted.rotation.canonicalDegrees,
      }),
      destination: Object.freeze({ width, height }),
      opacityDestinationCopies: execution!.opacity === 1 ? 0 as const : 1 as const,
      ...(scaleTranslation ? { scaleTranslation } : {}),
    })
    : undefined;
  if (execution?.scaleTranslationPlan) {
    if (!admitted) {
      throw new ReferenceLocalSpaceError(
        "CUT_LOCAL_SPACE_RASTER",
        execution.sourceNode,
        "fused scale+translation reached execution without admitted transform work.",
      );
    }
    const rendered = executeReferenceLocalSpaceScaleTranslation(
      execution.sourceNode,
      { data: surface.data, width: surface.width, height: surface.height, alphaMode: "straight" },
      execution.scaleTranslationPlan,
    );
    if (rendered.surface.width !== width || rendered.surface.height !== height
      || rendered.surface.originX !== 0 || rendered.surface.originY !== 0) {
      throw new ReferenceLocalSpaceError(
        "CUT_LOCAL_SPACE_RASTER",
        execution.sourceNode,
        `fused scale+translation produced ${rendered.surface.width}x${rendered.surface.height} at (${rendered.surface.originX}, ${rendered.surface.originY}); expected ${width}x${height} at (0, 0).`,
      );
    }
    return Object.freeze({
      surface: {
        data: Buffer.from(
          rendered.surface.data.buffer,
          rendered.surface.data.byteOffset,
          rendered.surface.data.byteLength,
        ),
        width,
        height,
      },
      transformWork: executionEvidence(admitted.rotation, rendered.evidence)!,
    });
  }
  if (scale === 1 && skewX === 0 && skewY === 0 && rotation === 0) {
    const placed = translateReferenceLocalSpaceSurface(
      surface,
      width,
      height,
      destinationX - registrationRasterX,
      destinationY - registrationRasterY,
    );
    if (admitted) {
      assertReferenceLocalSpaceObservedDimensions(execution!.sourceNode, "neutral requested resize", surface, admitted.requestedResize);
      assertReferenceLocalSpaceObservedDimensions(execution!.sourceNode, "neutral Sharp cover", surface, admitted.sharpCover);
      assertReferenceLocalSpaceObservedDimensions(execution!.sourceNode, "neutral rotation output", surface, admitted.rotation);
      assertReferenceLocalSpaceObservedDimensions(execution!.sourceNode, "destination translation", placed, { width, height });
    }
    return Object.freeze({
      surface: { data: sharedBufferView(placed.data), width, height },
      ...(admitted ? { transformWork: executionEvidence(surface)! } : {}),
    });
  }
  const resizeGeometry = referenceLocalSpaceResizeGeometry(surface.width, surface.height, scale);
  const resizedWidth = resizeGeometry.requestedWidth, resizedHeight = resizeGeometry.requestedHeight;
  let transformedRegistration = resizedRasterPoint(
    registrationRasterX,
    registrationRasterY,
    surface.width,
    surface.height,
    resizedWidth,
    resizedHeight,
  );
  // Every non-neutral filter operates on associated rgb16 samples. Stages are
  // materialized in semantic order (scale -> skew -> rotate), then explicitly
  // re-associated before the next filter. This prevents hidden or
  // low-coverage straight RGB from becoming a visible transform halo.
  let transformed = straightRgba8To16(surface);
  if (resizedWidth !== surface.width || resizedHeight !== surface.height) {
    transformed = await filterLocalSpaceAssociatedRgba16(transformed, (pipeline) => {
      if (!admitted) return pipeline.resize(resizedWidth, resizedHeight);
      // Make the allocator's Sharp-cover geometry an explicit backend
      // operation, then crop with the same centre convention used by the
      // registered-point transform. It is no longer an unobservable estimate
      // hidden inside Sharp's default two-dimensional resize.
      const resized = pipeline.resize(admitted.sharpCover.width, admitted.sharpCover.height, { fit: "fill" });
      if (admitted.sharpCover.width === admitted.requestedResize.width
        && admitted.sharpCover.height === admitted.requestedResize.height) return resized;
      const left = Math.max(0, Math.floor((admitted.sharpCover.width - admitted.requestedResize.width + 1) / 2));
      const top = Math.max(0, Math.floor((admitted.sharpCover.height - admitted.requestedResize.height + 1) / 2));
      return resized.extract({
        left,
        top,
        width: admitted.requestedResize.width,
        height: admitted.requestedResize.height,
      });
    });
  }
  if (admitted) assertReferenceLocalSpaceObservedDimensions(execution!.sourceNode, "resize output", transformed, admitted.requestedResize);
  if (skewX !== 0 || skewY !== 0) {
    const inputWidth = transformed.width, inputHeight = transformed.height;
    const radians = Math.PI / 180, tangentX = Math.tan(skewX * radians), tangentY = Math.tan(skewY * radians);
    transformed = await filterLocalSpaceAssociatedRgba16(transformed, (pipeline) => pipeline.affine(
      [[1, tangentX], [tangentY, 1]],
      { background: { r: 0, g: 0, b: 0, alpha: 0 }, interpolator: sharp.interpolators.bicubic },
    ));
    if (!admitted || admitted.version !== 3) {
      if (execution) throw new ReferenceLocalSpaceError("CUT_LOCAL_SPACE_RASTER", execution.sourceNode, "skew execution has no skew-aware V3 admission.");
    } else {
      assertReferenceLocalSpaceObservedDimensions(execution!.sourceNode, "skew output", transformed, admitted.skew);
    }
    transformedRegistration = affineRasterOrigin(transformedRegistration.x, transformedRegistration.y, inputWidth, inputHeight, 1, tangentX, tangentY, 1);
  }
  if (rotation !== 0) {
    const inputWidth = transformed.width, inputHeight = transformed.height;
    transformed = await filterLocalSpaceAssociatedRgba16(transformed, (pipeline) => pipeline.rotate(
      rotation,
      { background: { r: 0, g: 0, b: 0, alpha: 0 } },
    ));
    transformedRegistration = rotatedRasterOrigin(transformedRegistration.x, transformedRegistration.y, inputWidth, inputHeight, transformed.width, transformed.height, rotation);
  }
  if (admitted) assertReferenceLocalSpaceObservedDimensions(execution!.sourceNode, "rotation output", transformed, admitted.rotation);
  const straightTransformed = straightRgba16To8(transformed);
  if (admitted) assertReferenceLocalSpaceObservedDimensions(execution!.sourceNode, "straight RGBA8 transform output", straightTransformed, admitted.rotation);
  const placed = translateReferenceLocalSpaceSurface(
    straightTransformed,
    width,
    height,
    destinationX - transformedRegistration.x,
    destinationY - transformedRegistration.y,
  );
  if (admitted) assertReferenceLocalSpaceObservedDimensions(execution!.sourceNode, "destination translation", placed, { width, height });
  return Object.freeze({
    surface: { data: sharedBufferView(placed.data), width, height },
    ...(admitted ? { transformWork: executionEvidence(transformed)! } : {}),
  });
}

async function placeOnCanvas(
  surface: RawSurface,
  width: number,
  height: number,
  x: number,
  y: number,
  scale: number,
  rotation: number,
  skewX = 0,
  skewY = 0,
  anchorX = 0,
  anchorY = 0,
  anchorAware = false,
  exactAlphaSupport = false,
) {
  if (scale === 1 && skewX === 0 && skewY === 0 && rotation === 0 && x === 0 && y === 0 && anchorX === 0 && anchorY === 0) return surface;
  const resizedWidth = Math.max(1, Math.round(surface.width * scale)), resizedHeight = Math.max(1, Math.round(surface.height * scale));
  const resizedOrigin = centredResizeRasterOrigin(surface.width, surface.height, resizedWidth, resizedHeight);
  let transformedOrigin = { x: resizedOrigin.x, y: resizedOrigin.y };
  let transformed;
  if (skewX === 0 && skewY === 0) {
    // Preserve the established scale/rotation pixel path byte-for-byte when
    // no skew is authored.
    transformed = await sharp(surface.data, raw(surface)).resize(resizedWidth, resizedHeight).rotate(rotation, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    transformedOrigin = rotatedRasterOrigin(transformedOrigin.x, transformedOrigin.y, resizedWidth, resizedHeight, transformed.info.width, transformed.info.height, rotation);
  } else {
    // Materialize between operations because libvips otherwise reorders
    // affine after rotate. CUT's public order is scale -> skew -> rotation.
    const resized = await sharp(surface.data, raw(surface)).resize(resizedWidth, resizedHeight).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const radians = Math.PI / 180;
    const sheared = await sharp(resized.data, { raw: resized.info }).affine(
      [[1, Math.tan(skewX * radians)], [Math.tan(skewY * radians), 1]],
      { background: { r: 0, g: 0, b: 0, alpha: 0 }, interpolator: sharp.interpolators.bicubic },
    ).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    transformedOrigin = affineRasterOrigin(transformedOrigin.x, transformedOrigin.y, resized.info.width, resized.info.height, 1, Math.tan(skewX * radians), Math.tan(skewY * radians), 1);
    transformed = await sharp(sheared.data, { raw: sheared.info }).rotate(rotation, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    transformedOrigin = rotatedRasterOrigin(transformedOrigin.x, transformedOrigin.y, sheared.info.width, sheared.info.height, transformed.info.width, transformed.info.height, rotation);
  }
  // Group anchors are offsets from the local composition centre.  Position is
  // the destination of that pivot, also relative to the destination centre.
  // Existing anchor-less renders retain their byte-identical placement path.
  const radians = Math.PI / 180;
  const scaledAnchorX = anchorX * resizedOrigin.scale, scaledAnchorY = anchorY * resizedOrigin.scale;
  const skewedAnchorX = scaledAnchorX + Math.tan(skewX * radians) * scaledAnchorY;
  const skewedAnchorY = Math.tan(skewY * radians) * scaledAnchorX + scaledAnchorY;
  const normalizedRotation = ((rotation % 360) + 360) % 360;
  const signedRotation = normalizedRotation > 180 ? normalizedRotation - 360 : normalizedRotation;
  const cosine = Math.cos(signedRotation * radians), sine = Math.sin(signedRotation * radians);
  const transformedAnchorX = cosine * skewedAnchorX - sine * skewedAnchorY;
  const transformedAnchorY = sine * skewedAnchorX + cosine * skewedAnchorY;
  const left = anchorAware
    ? (width - 1) / 2 + x - transformedOrigin.x - transformedAnchorX
    : (width - transformed.info.width) / 2 + x - transformedAnchorX;
  const top = anchorAware
    ? (height - 1) / 2 + y - transformedOrigin.y - transformedAnchorY
    : (height - transformed.info.height) / 2 + y - transformedAnchorY;
  const placed = (exactAlphaSupport ? translateReferenceLocalSpaceSurface : translateReferenceRetainedSurface)(
    { data: transformed.data, width: transformed.info.width, height: transformed.info.height },
    width,
    height,
    left,
    top,
  );
  return { data: sharedBufferView(placed.data), width, height };
}

function textFailure(node: IRNode, message: string): never {
  return referenceTextFailure(node, "CUT_TEXT_BUDGET", message);
}

function textAdvance(font: LockedOpenTypeFont, value: string, size: number, tracking: number) {
  return lockedGlyphAdvance(font, value, size, tracking);
}

function splitLongTextToken(node: IRNode, font: LockedOpenTypeFont, token: string, config: ReferenceTextConfig) {
  const chunks: string[] = []; let current = "";
  for (const character of token) {
    const candidate = current + character;
    if (textAdvance(font, candidate, config.size, config.tracking) <= config.maxWidth + 1e-7) { current = candidate; continue; }
    if (!current) textFailure(node, `cannot fit U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")} inside maxWidth at the configured font size.`);
    chunks.push(current); current = character;
    if (textAdvance(font, current, config.size, config.tracking) > config.maxWidth + 1e-7) textFailure(node, `cannot fit U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")} inside maxWidth at the configured font size.`);
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Deterministic, fixed-font word wrapping. Explicit newlines remain lines; other whitespace collapses to one space. */
function wrapLockedText(node: IRNode, font: LockedOpenTypeFont, config: ReferenceTextConfig) {
  const lines: string[] = [];
  for (const paragraph of config.content.split(/\r\n?|\n/)) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (!words.length) { lines.push(""); continue; }
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (textAdvance(font, candidate, config.size, config.tracking) <= config.maxWidth + 1e-7) { current = candidate; continue; }
      if (current) { lines.push(current); current = ""; }
      if (textAdvance(font, word, config.size, config.tracking) <= config.maxWidth + 1e-7) { current = word; continue; }
      const chunks = splitLongTextToken(node, font, word, config);
      lines.push(...chunks.slice(0, -1)); current = chunks.at(-1) ?? "";
    }
    lines.push(current);
  }
  if (lines.length <= config.maxLines) return lines;
  const visible = lines.slice(0, config.maxLines), last = visible.length - 1;
  if (textAdvance(font, "…", config.size, config.tracking) > config.maxWidth + 1e-7) textFailure(node, "cannot fit deterministic truncation marker inside maxWidth at the configured font size.");
  let prefix = "";
  for (const character of visible[last]) {
    const candidate = `${prefix}${character}…`;
    if (textAdvance(font, candidate, config.size, config.tracking) > config.maxWidth + 1e-7) break;
    prefix += character;
  }
  visible[last] = `${prefix}…`;
  return visible;
}

function prepareReferenceText(node: IRNode, config: ReferenceTextConfig, font: LockedOpenTypeFont): PreparedReferenceText {
  try {
    const lines = wrapLockedText(node, font, config), outlines: Array<LockedGlyphRun | undefined> = [];
    let outlineCommands = 0, outlineBytes = 0;
    for (const line of lines) {
      if (!line) { outlines.push(undefined); continue; }
      const commandBudget = referenceTextLimits.maxOutlineCommandsPerNode - outlineCommands, byteBudget = referenceTextLimits.maxOutlineBytesPerNode - outlineBytes;
      if (commandBudget < 1 || byteBudget < 1) textFailure(node, "exceeds its locked-font outline budget before all wrapped lines are prepared.");
      const outline = lockedGlyphRun(font, line, config.size, { maxCommands: commandBudget, maxPathBytes: byteBudget }, config.tracking);
      if (outline.advance > config.maxWidth + 1e-7) textFailure(node, "produced a line wider than maxWidth after locked-font shaping.");
      outlines.push(outline); outlineCommands += outline.commands; outlineBytes += outline.pathBytes;
    }
    return { config, font, lines: outlines, outlineCommands, outlineBytes };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Text at ")) throw error;
    textFailure(node, error instanceof Error ? error.message : String(error));
  }
}

export type ReferenceVideoDecoderEvidence = Readonly<{
  nodeId: string;
  streamIndex: number;
  mode: "decoded-cfr-frame-index" | "untrimmed-source-pts" | "retained-native-crop-cfr-frame-index" | "retained-native-crop-source-pts";
  frameLimit: number;
  sourceStartFrame?: number;
  sourceEndFrame?: number;
  loop: boolean;
  outputFps: Rational;
  semanticSeek: false;
  frameSelection?: "floor" | "nearest" | "frame-blend";
  frameBlendPolicyIdentity?: string;
}>;

type Decoder = {
  reader: RawVideoReader;
  lastFrame: number;
  current?: Buffer;
  frameCache: Map<number, Buffer>;
  ended?: boolean;
  inputColor: ReferenceVideoInputColorProfile | "legacy";
  evidence: ReferenceVideoDecoderEvidence;
};

/**
 * Closed decoder constants for an already validated profile. Authored observed
 * metadata is intentionally absent from this API and therefore cannot become
 * an FFmpeg filter or subprocess argument.
 */
export function referenceVideoDecoderColorPlan(inputColor: ReferenceVideoInputColorProfile | "legacy") {
  if (inputColor === "legacy") return Object.freeze({ managedYuv: false, scaleSuffix: "" });
  if (inputColor === "rec709-full") return Object.freeze({ managedYuv: true, scaleSuffix: ":in_range=pc:out_range=pc:in_color_matrix=bt709:out_color_matrix=bt709" });
  if (inputColor === "rec709-limited") return Object.freeze({ managedYuv: true, scaleSuffix: ":in_range=tv:out_range=pc:in_color_matrix=bt709:out_color_matrix=bt709" });
  if (inputColor === "bt470bg-smpte170m-limited") return Object.freeze({ managedYuv: true, scaleSuffix: ":in_range=tv:out_range=pc:in_color_matrix=bt601:out_color_matrix=bt601" });
  if (inputColor === "srgb" || inputColor === "linear-srgb") return Object.freeze({ managedYuv: false, scaleSuffix: "" });
  throw new Error(`Unsupported validated video input color profile ${JSON.stringify(inputColor)}.`);
}
const maximumCaptionSurfaceCacheBytes = 128 * 1024 * 1024;
export const maximumStaticMediaGradeCacheBytes =
  referenceMediaCamera2DStaticGradeCacheLimits.maximumBytes;
export const maximumStaticMediaGradeCacheEntries =
  referenceMediaCamera2DStaticGradeCacheLimits.maximumEntries;

type ReferenceStaticMediaGradeCacheEntry = {
  cacheIdentity: string;
  sourceRgbaSha256: string;
  outputRgbaSha256: string;
  surface: RawSurface;
  bytes: number;
  activeLeases: number;
};

type ReferenceStaticMediaGradeSourceAuthority = Readonly<{
  format: "cut-reference-static-media-grade-source-authority";
  version: 1;
}>;
const staticMediaGradeSourceAuthorities = new WeakMap<object, Readonly<{
  source: RawSurface;
  data: Buffer;
  width: number;
  height: number;
  sourceSemanticIdentity: string;
  sourceRgbaSha256: string;
}>>();

function issueReferenceStaticMediaGradeSourceAuthority(
  source: RawSurface,
  sourceSemanticIdentity: string,
): ReferenceStaticMediaGradeSourceAuthority {
  const expectedBytes = source.width * source.height * 4;
  if (!Buffer.isBuffer(source.data) || !sourceSemanticIdentity
    || !Number.isSafeInteger(expectedBytes) || expectedBytes < 4
    || source.data.byteLength !== expectedBytes) {
    throw new Error("CUT_STATIC_MEDIA_GRADE_CACHE_INPUT: decoded source authority requires exact private RGBA bytes and one semantic identity.");
  }
  const authority = Object.freeze({
    format: "cut-reference-static-media-grade-source-authority" as const,
    version: 1 as const,
  });
  staticMediaGradeSourceAuthorities.set(authority, Object.freeze({
    source,
    data: source.data,
    width: source.width,
    height: source.height,
    sourceSemanticIdentity,
    sourceRgbaSha256: createHash("sha256").update(source.data).digest("hex"),
  }));
  return authority;
}

type ReferenceStaticMediaGradeLease = Readonly<{
  format: "cut-reference-static-media-grade-lease";
  version: 1;
  cacheIdentity: string;
  outputRgbaSha256: string;
}>;
const staticMediaGradeLeaseAuthorities = new WeakMap<object, Readonly<{
  cache: ReferenceStaticMediaGradeCache;
  entry: ReferenceStaticMediaGradeCacheEntry;
}>>();

type ReferenceStaticMediaGradeMaterialization = Readonly<{
  surface: RawSurface;
  linearBalanceSurfaces: 0 | 1;
  backendGradeSurfaces: 0 | 1;
}>;

type ReferenceStaticMediaGradeRequest = Readonly<{
  source: RawSurface;
  sourceAuthority?: ReferenceStaticMediaGradeSourceAuthority;
  sourceSemanticIdentity: string;
  gradeNodeId: string;
  gradeExecutionIdentity: string;
  backendIdentity: string;
  materialize: () => Promise<ReferenceStaticMediaGradeMaterialization>;
}>;

type ReferenceStaticMediaGradeResult = Readonly<{
  surface?: RawSurface;
  lease?: ReferenceStaticMediaGradeLease;
  linearBalanceSurfaces: 0 | 1;
  backendGradeSurfaces: 0 | 1;
  evidence: ReferenceMediaCamera2DStaticGradeCacheEvidence;
}>;

/** Renderer-tree-owned, exact reuse for one immutable still and one static
 * ColorGrade configuration. Actual decoded bytes and the runtime/backend law
 * are part of the key; dynamic signal-bearing graphs never enter the cache. */
export class ReferenceStaticMediaGradeCache {
  private readonly entries = new Map<string, ReferenceStaticMediaGradeCacheEntry>();
  private readonly activeLeases = new Set<ReferenceStaticMediaGradeLease>();
  private requestTail: Promise<void> = Promise.resolve();
  private readonly activeRequests = new Set<symbol>();
  private bytes = 0;
  private closed = false;
  private readonly events = {
    hit: 0,
    miss: 0,
    bypassCapacity: 0,
    bypassDynamic: 0,
    residentCopies: 0,
    residentCopyRgbaBytes: 0,
    handoffCopies: 0,
    handoffRgbaBytes: 0,
    leaseHandoffs: 0,
    leaseRgbaBytes: 0,
  };

  constructor(
    readonly maximumBytes: number = maximumStaticMediaGradeCacheBytes,
    readonly maximumEntries: number = maximumStaticMediaGradeCacheEntries,
    readonly handoffMode: "copied" | "immutable-lease" = "immutable-lease",
  ) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 4
      || maximumBytes > maximumStaticMediaGradeCacheBytes
      || !Number.isSafeInteger(maximumEntries) || maximumEntries < 1
      || maximumEntries > maximumStaticMediaGradeCacheEntries) {
      throw new Error(
        `CUT_STATIC_MEDIA_GRADE_CACHE_LIMIT: byte/entry bounds must be 4..${maximumStaticMediaGradeCacheBytes} and 1..${maximumStaticMediaGradeCacheEntries}.`,
      );
    }
    if (handoffMode !== "copied" && handoffMode !== "immutable-lease") {
      throw new Error("CUT_STATIC_MEDIA_GRADE_CACHE_INPUT: handoff mode must be copied or immutable-lease.");
    }
  }

  get residentBytes() { return this.bytes; }
  get entryCount() { return this.entries.size; }
  get pendingCount() { return this.closed ? 0 : this.activeRequests.size; }
  get activeLeaseCount() { return this.activeLeases.size; }
  evidenceSnapshot() { return Object.freeze({ ...this.events, residentBytes: this.bytes, entries: this.entries.size }); }
  recordDynamicBypass() {
    if (this.closed) throw new Error("CUT_STATIC_MEDIA_GRADE_CACHE_CLOSED: cache use after renderer-tree close is forbidden.");
    this.events.bypassDynamic += 1;
  }

  private integrity(entry: ReferenceStaticMediaGradeCacheEntry) {
    const outputRgbaSha256 = createHash("sha256").update(entry.surface.data).digest("hex");
    if (outputRgbaSha256 !== entry.outputRgbaSha256) {
      throw new Error("CUT_STATIC_MEDIA_GRADE_CACHE_MUTATION: cached graded RGBA bytes changed after publication.");
    }
  }

  private evictOldest() {
    const oldest = [...this.entries.entries()].find(([, candidate]) => candidate.activeLeases === 0);
    if (!oldest) return false;
    const [key, entry] = oldest;
    this.integrity(entry);
    this.entries.delete(key);
    this.bytes -= entry.bytes;
    return true;
  }

  private cacheHit(
    cacheIdentity: string,
    sourceRgbaSha256: string,
    width: number,
    height: number,
    expectedBytes: number,
  ) {
    const existing = this.entries.get(cacheIdentity);
    if (!existing) return undefined;
    if (existing.sourceRgbaSha256 !== sourceRgbaSha256
      || existing.surface.width !== width
      || existing.surface.height !== height
      || existing.surface.data.byteLength !== expectedBytes) {
      throw new Error("CUT_STATIC_MEDIA_GRADE_CACHE_IDENTITY: cached surface diverged from its exact source/config authority.");
    }
    this.entries.delete(cacheIdentity);
    this.entries.set(cacheIdentity, existing);
    this.events.hit += 1;
    if (this.handoffMode === "immutable-lease") {
      const lease: ReferenceStaticMediaGradeLease = Object.freeze({
        format: "cut-reference-static-media-grade-lease",
        version: 1,
        cacheIdentity,
        outputRgbaSha256: existing.outputRgbaSha256,
      });
      existing.activeLeases += 1;
      this.activeLeases.add(lease);
      staticMediaGradeLeaseAuthorities.set(lease, Object.freeze({ cache: this, entry: existing }));
      this.events.leaseHandoffs += 1;
      this.events.leaseRgbaBytes += expectedBytes;
      return Object.freeze({
        lease,
        linearBalanceSurfaces: 0 as const,
        backendGradeSurfaces: 0 as const,
        evidence: Object.freeze({
          algorithmVersion: referenceMediaCamera2DStaticGradeCacheAlgorithmVersion,
          status: "hit" as const,
          cacheIdentity,
          sourceRgbaSha256,
          outputRgbaSha256: existing.outputRgbaSha256,
          residentBytes: this.bytes,
          entries: this.entries.size,
          residentCopies: 0 as const,
          residentCopyRgbaBytes: 0,
          handoffCopies: 0 as const,
          handoffRgbaBytes: 0,
          leaseHandoffs: 1 as const,
          leaseRgbaBytes: expectedBytes,
        }),
      });
    }
    this.integrity(existing);
    this.events.handoffCopies += 1;
    this.events.handoffRgbaBytes += expectedBytes;
    return Object.freeze({
      // The resident bytes are cache-private. A consumer always receives an
      // isolated handoff so later source-over or hostile mutation cannot alter
      // the authority used by a future hit.
      surface: Object.freeze({
        data: Buffer.from(existing.surface.data),
        width: existing.surface.width,
        height: existing.surface.height,
      }),
      linearBalanceSurfaces: 0 as const,
      backendGradeSurfaces: 0 as const,
      evidence: Object.freeze({
        algorithmVersion: referenceMediaCamera2DStaticGradeCacheAlgorithmVersion,
        status: "hit" as const,
        cacheIdentity,
        sourceRgbaSha256,
        outputRgbaSha256: existing.outputRgbaSha256,
        residentBytes: this.bytes,
        entries: this.entries.size,
        residentCopies: 0 as const,
        residentCopyRgbaBytes: 0,
        handoffCopies: 1 as const,
        handoffRgbaBytes: expectedBytes,
        leaseHandoffs: 0 as const,
        leaseRgbaBytes: 0,
      }),
    });
  }

  consumeLease<T>(
    lease: ReferenceStaticMediaGradeLease,
    consume: (surface: RawSurface) => T,
  ): T {
    if (this.closed) {
      throw new Error("CUT_STATIC_MEDIA_GRADE_CACHE_LEASE: graded-surface lease consumer is not the live renderer-tree authority.");
    }
    const binding = staticMediaGradeLeaseAuthorities.get(lease);
    if (!binding || binding.cache !== this || binding.entry.activeLeases < 1
      || this.entries.get(lease.cacheIdentity) !== binding.entry
      || binding.entry.cacheIdentity !== lease.cacheIdentity
      || binding.entry.outputRgbaSha256 !== lease.outputRgbaSha256) {
      throw new Error("CUT_STATIC_MEDIA_GRADE_CACHE_LEASE: graded-surface lease is foreign, stale, duplicated, or detached from its resident authority.");
    }
    staticMediaGradeLeaseAuthorities.delete(lease);
    const release = () => {
      this.activeLeases.delete(lease);
      binding.entry.activeLeases -= 1;
    };
    let result: T;
    try {
      result = consume(binding.entry.surface);
    } catch (error) {
      release();
      throw error;
    }
    if (result && typeof result === "object" && "then" in result
      && typeof (result as { then?: unknown }).then === "function") {
      return Promise.resolve(result).finally(release) as T;
    }
    release();
    return result;
  }

  request(input: ReferenceStaticMediaGradeRequest): Promise<ReferenceStaticMediaGradeResult> {
    if (this.closed) {
      return Promise.reject(new Error("CUT_STATIC_MEDIA_GRADE_CACHE_CLOSED: cache use after renderer-tree close is forbidden."));
    }
    const token = Symbol("static-media-grade-request");
    this.activeRequests.add(token);
    const operation = this.requestTail.then(() => this.requestSerialized(input));
    this.requestTail = operation.then(() => undefined, () => undefined);
    return operation.finally(() => { this.activeRequests.delete(token); });
  }

  private async requestSerialized(input: ReferenceStaticMediaGradeRequest): Promise<ReferenceStaticMediaGradeResult> {
    if (this.closed) {
      throw new Error("CUT_STATIC_MEDIA_GRADE_CACHE_CLOSED: cache use after renderer-tree close is forbidden.");
    }
    const expectedBytes = input.source.width * input.source.height * 4;
    if (!Buffer.isBuffer(input.source.data)
      || !Number.isSafeInteger(input.source.width) || input.source.width < 1
      || !Number.isSafeInteger(input.source.height) || input.source.height < 1
      || !Number.isSafeInteger(expectedBytes)
      || input.source.data.byteLength !== expectedBytes
      || !/^[a-f0-9]{64}$/u.test(input.gradeExecutionIdentity)
      || !input.sourceSemanticIdentity || !input.gradeNodeId || !input.backendIdentity) {
      throw new Error("CUT_STATIC_MEDIA_GRADE_CACHE_INPUT: cache authority requires exact RGBA dimensions and closed semantic identities.");
    }
    const sourceBinding = input.sourceAuthority
      ? staticMediaGradeSourceAuthorities.get(input.sourceAuthority)
      : undefined;
    if (input.sourceAuthority && (!sourceBinding
      || sourceBinding.source !== input.source
      || sourceBinding.data !== input.source.data
      || sourceBinding.width !== input.source.width
      || sourceBinding.height !== input.source.height
      || sourceBinding.sourceSemanticIdentity !== input.sourceSemanticIdentity)) {
      throw new Error("CUT_STATIC_MEDIA_GRADE_CACHE_IDENTITY: decoded source authority is foreign, stale, or bound to different bytes.");
    }
    const sourceRgbaSha256 = sourceBinding?.sourceRgbaSha256
      ?? createHash("sha256").update(input.source.data).digest("hex");
    const cacheIdentity = referenceMediaCamera2DStaticGradeCacheIdentity({
      sourceSemanticIdentity: input.sourceSemanticIdentity,
      sourceRgbaSha256,
      width: input.source.width,
      height: input.source.height,
      gradeNodeId: input.gradeNodeId,
      gradeExecutionIdentity: input.gradeExecutionIdentity,
      backendIdentity: input.backendIdentity,
    });
    const hit = this.cacheHit(
      cacheIdentity,
      sourceRgbaSha256,
      input.source.width,
      input.source.height,
      expectedBytes,
    );
    if (hit) return hit;

    if (expectedBytes > this.maximumBytes) {
      const rendered = await input.materialize();
      if (this.closed) {
        throw new Error("CUT_STATIC_MEDIA_GRADE_CACHE_CLOSED: cache closed before uncached materialization completed.");
      }
      if (!Buffer.isBuffer(rendered.surface.data)
        || rendered.surface.width !== input.source.width
        || rendered.surface.height !== input.source.height
        || rendered.surface.data.byteLength !== expectedBytes) {
        throw new Error("CUT_STATIC_MEDIA_GRADE_CACHE_OUTPUT: ColorGrade changed its admitted native-crop RGBA dimensions.");
      }
      const outputRgbaSha256 = createHash("sha256").update(rendered.surface.data).digest("hex");
      this.events.bypassCapacity += 1;
      return Object.freeze({
        ...rendered,
        evidence: Object.freeze({
          algorithmVersion: referenceMediaCamera2DStaticGradeCacheAlgorithmVersion,
          status: "bypass-capacity" as const,
          cacheIdentity,
          sourceRgbaSha256,
          outputRgbaSha256,
          residentBytes: this.bytes,
          entries: this.entries.size,
          residentCopies: 0 as const,
          residentCopyRgbaBytes: 0,
          handoffCopies: 0 as const,
          handoffRgbaBytes: 0,
          leaseHandoffs: 0 as const,
          leaseRgbaBytes: 0,
        }),
      });
    }

    const rendered = await input.materialize();
    if (this.closed) {
      throw new Error("CUT_STATIC_MEDIA_GRADE_CACHE_CLOSED: cache closed before materialization completed.");
    }
    if (!Buffer.isBuffer(rendered.surface.data)
      || rendered.surface.width !== input.source.width
      || rendered.surface.height !== input.source.height
      || rendered.surface.data.byteLength !== expectedBytes) {
      throw new Error("CUT_STATIC_MEDIA_GRADE_CACHE_OUTPUT: ColorGrade changed its admitted native-crop RGBA dimensions.");
    }
    const outputRgbaSha256 = createHash("sha256").update(rendered.surface.data).digest("hex");
    while ((this.bytes + expectedBytes > this.maximumBytes || this.entries.size >= this.maximumEntries)
      && this.evictOldest()) {
      // Deterministic LRU eviction closes both resident-byte and entry caps.
    }
    if (this.bytes + expectedBytes > this.maximumBytes || this.entries.size >= this.maximumEntries) {
      this.events.bypassCapacity += 1;
      return Object.freeze({
        ...rendered,
        evidence: Object.freeze({
          algorithmVersion: referenceMediaCamera2DStaticGradeCacheAlgorithmVersion,
          status: "bypass-capacity" as const,
          cacheIdentity,
          sourceRgbaSha256,
          outputRgbaSha256,
          residentBytes: this.bytes,
          entries: this.entries.size,
          residentCopies: 0 as const,
          residentCopyRgbaBytes: 0,
          handoffCopies: 0 as const,
          handoffRgbaBytes: 0,
          leaseHandoffs: 0 as const,
          leaseRgbaBytes: 0,
        }),
      });
    }
    const entry: ReferenceStaticMediaGradeCacheEntry = {
      cacheIdentity,
      sourceRgbaSha256,
      outputRgbaSha256,
      surface: {
        data: Buffer.from(rendered.surface.data),
        width: rendered.surface.width,
        height: rendered.surface.height,
      },
      bytes: expectedBytes,
      activeLeases: 0,
    };
    this.entries.set(cacheIdentity, entry);
    this.bytes += expectedBytes;
    this.integrity(entry);
    this.events.miss += 1;
    this.events.residentCopies += 1;
    this.events.residentCopyRgbaBytes += expectedBytes;
    return Object.freeze({
      ...rendered,
      evidence: Object.freeze({
        algorithmVersion: referenceMediaCamera2DStaticGradeCacheAlgorithmVersion,
        status: "miss" as const,
        cacheIdentity,
        sourceRgbaSha256,
        outputRgbaSha256: entry.outputRgbaSha256,
        residentBytes: this.bytes,
        entries: this.entries.size,
        residentCopies: 1 as const,
        residentCopyRgbaBytes: expectedBytes,
        handoffCopies: 0 as const,
        handoffRgbaBytes: 0,
        leaseHandoffs: 0 as const,
        leaseRgbaBytes: 0,
      }),
    });
  }

  clear() {
    this.closed = true;
    this.activeRequests.clear();
    try {
      for (const entry of this.entries.values()) this.integrity(entry);
    } finally {
      for (const lease of this.activeLeases) staticMediaGradeLeaseAuthorities.delete(lease);
      this.activeLeases.clear();
      this.entries.clear();
      this.bytes = 0;
    }
  }
}

export const maximumLocalPaintSurfaceCacheBytes = 256 * 1024 * 1024;
export const maximumLocalPaintSurfaceCacheEntries = 128;
export const referenceLocalPaintSurfaceCacheAlgorithmVersion =
  "cut-reference-local-paint-surface-cache-v1";

export type ReferenceLocalPaintSurfaceCacheEvent = Readonly<{
  kind: "hit" | "miss" | "bypass" | "eviction";
  residentBytes: number;
  entries: number;
}>;

type ReferenceLocalPaintSurfaceCacheEntry = {
  pending: Promise<RawSurface>;
  bytes: number;
};

/**
 * Renderer-tree-owned, byte-bounded LRU for immutable Sharp-produced local
 * paint surfaces. Pending work counts toward the entry bound but not the byte
 * bound; a full pending set fails open to an uncached materialization rather
 * than allowing the cache itself to grow without limit.
 */
export class ReferenceLocalPaintSurfaceCache {
  private readonly entries = new Map<string, ReferenceLocalPaintSurfaceCacheEntry>();
  private bytes = 0;

  constructor(
    readonly maximumBytes = maximumLocalPaintSurfaceCacheBytes,
    readonly maximumEntries = maximumLocalPaintSurfaceCacheEntries,
  ) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1
      || !Number.isSafeInteger(maximumEntries) || maximumEntries < 1) {
      throw new Error("CUT_LOCAL_PAINT_CACHE_LIMIT: cache byte and entry bounds must be positive safe integers.");
    }
  }

  get residentBytes() { return this.bytes; }
  get entryCount() { return this.entries.size; }

  private event(
    kind: ReferenceLocalPaintSurfaceCacheEvent["kind"],
    observe?: (event: ReferenceLocalPaintSurfaceCacheEvent) => void,
  ) {
    observe?.(Object.freeze({ kind, residentBytes: this.bytes, entries: this.entries.size }));
  }

  private evictOldestCompleted(
    observe?: (event: ReferenceLocalPaintSurfaceCacheEvent) => void,
  ) {
    for (const [key, entry] of this.entries) {
      if (entry.bytes === 0) continue;
      this.entries.delete(key);
      this.bytes -= entry.bytes;
      this.event("eviction", observe);
      return true;
    }
    return false;
  }

  request(
    key: string,
    expectedBytes: number,
    materialize: () => Promise<RawSurface>,
    observe?: (event: ReferenceLocalPaintSurfaceCacheEvent) => void,
  ): Promise<RawSurface> {
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 4) {
      throw new Error("CUT_LOCAL_PAINT_CACHE_LIMIT: expected surface bytes must be a positive safe rgba8 allocation.");
    }
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key);
      this.entries.set(key, existing);
      this.event("hit", observe);
      return existing.pending;
    }

    if (expectedBytes > this.maximumBytes) {
      this.event("bypass", observe);
      return Promise.resolve().then(materialize);
    }
    while ((this.entries.size >= this.maximumEntries
      || this.bytes + expectedBytes > this.maximumBytes)
      && this.evictOldestCompleted(observe)) {
      // Evict completed LRU entries before admitting a new in-flight request.
    }
    if (this.entries.size >= this.maximumEntries
      || this.bytes + expectedBytes > this.maximumBytes) {
      this.event("bypass", observe);
      return Promise.resolve().then(materialize);
    }
    // The materialization callback compares against the promise installed in
    // the entry immediately afterward; this delayed self-reference is exact.
    let pending!: Promise<RawSurface>;
    const materialization = Promise.resolve().then(materialize).then((surface) => {
      const materializedBytes = surface.width * surface.height * 4;
      if (!Buffer.isBuffer(surface.data)
        || !Number.isSafeInteger(surface.width) || surface.width < 1
        || !Number.isSafeInteger(surface.height) || surface.height < 1
        || !Number.isSafeInteger(materializedBytes)
        || materializedBytes !== expectedBytes
        || surface.data.byteLength !== expectedBytes) {
        throw new Error("CUT_LOCAL_PAINT_CACHE_SURFACE: materialized surfaces must be bounded rgba8 buffers matching their positive integer dimensions.");
      }
      const live = this.entries.get(key);
      if (!live || live.pending !== pending) {
        this.event("bypass", observe);
        return surface;
      }
      this.entries.delete(key);
      while ((this.bytes + expectedBytes > this.maximumBytes
        || this.entries.size >= this.maximumEntries)
        && this.evictOldestCompleted(observe)) {
        // The representative 45-surface working set fits the default 256 MiB
        // domain; eviction remains exact and bounded for other projects.
      }
      if (this.bytes + expectedBytes > this.maximumBytes
        || this.entries.size >= this.maximumEntries) {
        this.event("bypass", observe);
        return surface;
      }
      this.entries.set(key, { pending, bytes: expectedBytes });
      this.bytes += expectedBytes;
      this.event("miss", observe);
      return surface;
    });
    pending = materialization.catch((error) => {
      const live = this.entries.get(key);
      if (live?.pending === pending) this.entries.delete(key);
      throw error;
    });
    this.entries.set(key, { pending, bytes: 0 });
    return pending;
  }

  clear() {
    this.entries.clear();
    this.bytes = 0;
  }
}

export type ReferenceLocalPaintSurfaceCacheIdentityInput = Readonly<{
  kind: "shape" | "static-vector-path";
  svg: string;
  width: number;
  height: number;
  rasterOriginQ16: Readonly<{ x: string; y: string }>;
  localSpaceSemanticIdentity: string;
  backendIdentity: string;
  rasterContract: "svg-density-144-resize-rgba8" | "svg-native-dimensions-rgba8";
  lockedResources: readonly Readonly<{ id: string; sha256: string }>[];
}>;

export function referenceLocalPaintSurfaceCacheIdentity(
  input: ReferenceLocalPaintSurfaceCacheIdentityInput,
) {
  return hash({
    format: referenceLocalPaintSurfaceCacheAlgorithmVersion,
    kind: input.kind,
    svg: input.svg,
    width: input.width,
    height: input.height,
    rasterOriginQ16: input.rasterOriginQ16,
    localSpaceSemanticIdentity: input.localSpaceSemanticIdentity,
    backendIdentity: input.backendIdentity,
    pixelFormat: "rgba8-straight",
    rasterContract: input.rasterContract,
    lockedResources: input.lockedResources,
  });
}

export class ReferenceVisualRendererStateError extends Error {
  readonly code = "CUT_VISUAL_RENDER_REENTRANT";
  constructor(readonly compositionId: string) {
    super(`CUT_VISUAL_RENDER_REENTRANT: ReferenceVisualRenderer ${compositionId} cannot evaluate concurrent sceneFrame calls on one mutable renderer instance; await the active frame or use a separate instance.`);
    this.name = "ReferenceVisualRendererStateError";
  }
}

export class ReferenceVisualRenderer {
  private readonly preparedSignalResolver: ReferencePreparedSignalResolver;
  private readonly paths = new Map<string, string>();
  private readonly dataAssets = new Map<string, unknown>();
  private readonly decoders = new Map<string, Decoder>();
  private readonly retainedMediaDecoders = new Map<string, Decoder>();
  private readonly videoConfigs = new Map<string, ReferenceVideoConfig>();
  private readonly imageSequenceConfigs = new Map<string, ReferenceImageSequenceConfig>();
  private readonly preparedImageSequences = new Map<string, PreparedReferenceImageSequence>();
  private readonly imageSequenceSurfaces = new Map<string, RawSurface>();
  private imageSequenceSurfaceBytes = 0;
  private readonly videoInputColorConfigs = new Map<string, ReferenceVideoInputColorConfig>();
  private readonly pictureTimeMapConfigs = new Map<string, ReferencePictureTimeMapConfig>();
  private readonly pictureTimeMapConfigIdentities = new Map<string, string>();
  private activePictureTimeMapFrameEvidence?: {
    reserved: number;
    receipts: ReferencePictureTimeMapFrameEvidence[];
  };
  private completedPictureTimeMapFrameEvidence:
    readonly ReferencePictureTimeMapFrameEvidence[] = Object.freeze([]);
  private readonly staticImages = new Map<string, RawSurface>();
  private readonly retainedMediaStaticImages = new Map<string, Readonly<{
    surface: RawSurface;
    sourceAuthority?: ReferenceStaticMediaGradeSourceAuthority;
  }>>();
  private activeRetainedMediaViewportFrameEvidence?: ReferenceRetainedMediaViewportExecutionEvidence[];
  private completedRetainedMediaViewportFrameEvidence: readonly ReferenceRetainedMediaViewportExecutionEvidence[] = Object.freeze([]);
  private activeRetainedMediaCompositionFrameEvidence?: ReferenceRetainedMediaCompositionExecutionEvidence[];
  private completedRetainedMediaCompositionFrameEvidence: readonly ReferenceRetainedMediaCompositionExecutionEvidence[] = Object.freeze([]);
  private activeRetainedMediaLocalCompositorFrameEvidence?: ReferenceRetainedMediaLocalCompositorExecutionEvidence[];
  private completedRetainedMediaLocalCompositorFrameEvidence: readonly ReferenceRetainedMediaLocalCompositorExecutionEvidence[] = Object.freeze([]);
  private readonly mediaCamera2DConfigs = new Map<string, ReferenceMediaCamera2DPlan>();
  private readonly activeMediaCamera2DFramePlans = new Map<string, ReferenceMediaCamera2DFramePlan>();
  private readonly activeMediaCamera2DAnchorPlans =
    new Map<string, ReturnType<typeof referenceMediaCamera2DAnchorPlanAt>>();
  private activeMediaCamera2DFrameEvidence?: ReferenceMediaCamera2DExecutionEvidence[];
  private completedMediaCamera2DFrameEvidence: readonly ReferenceMediaCamera2DExecutionEvidence[] = Object.freeze([]);
  private activeMediaCamera2DOutputFrame?: string;
  private activeMediaCamera2DSceneAdmission?: ReferenceMediaCamera2DSceneAdmission;
  private readonly frameMemo = new Map<string, RawSurface | undefined>();
  private readonly retainedPathChains = new Map<string, ReferenceRetainedPathChain>();
  private readonly retainedPathRasterMemo = new Map<string, Promise<RawSurface>>();
  private readonly compositeModes = new Map<string, RgbaBlendMode>();
  private readonly maskConfigs = new Map<string, ReferenceMaskConfig>();
  private readonly chromaKeyConfigs = new Map<string, ReferenceChromaKeyConfig>();
  private readonly clipPathPlans = new Map<string, PreparedReferenceClipPath>();
  private readonly motionBlurConfigs = new Map<string, ReferenceMotionBlurBoundaryConfig>();
  private readonly track2DConfigs = new Map<string, ReferenceTrack2DConfig>();
  private readonly preparedTrack2D = new Map<string, PreparedReferenceTrack2D>();
  private readonly planarTrackConfigs = new Map<string, ReferencePlanarTrackConfig>();
  private readonly planarTrackMatteConfigs = new Map<string, ReferencePlanarTrackMatteConfig>();
  private readonly preparedPlanarTracks = new Map<string, PreparedReferencePlanarTrack>();
  private readonly preparedPlanarTrackOpacityNodes = new Set<string>();
  private activePlanarTrackFrameEvidence?: {
    compositionTime: Rational;
    sceneLocalTime: Rational;
    outputFrame: string;
    reservedExecutions: number;
    reservedLocalSpaceTiles: number;
    reservedSourceTilePixels: number;
    reservedLocalPixelPasses: number;
    reservedDestinationPixels: number;
    reservedCanvasRgbaBytes: number;
    preflightReservations: Map<string, number>;
    executions: ReferencePlanarTrackFrameEvidenceExecution[];
  };
  private completedPlanarTrackFrameEvidence: readonly ReferencePlanarTrackFrameEvidence[] = Object.freeze([]);
  private completedPlanarTrackFrameTrustedContexts: readonly ReferencePlanarTrackFrameEvidenceTrustedContext[] = Object.freeze([]);
  private readonly visualEffects = new Map<string, ReferenceVisualEffectConfig>();
  private readonly captionConfigs = new Map<string, ReferenceCaptionConfig>();
  private readonly transcriptCaptionConfigs =
    new Map<string, ReferenceTranscriptCaptionConfig>();
  private readonly preparedCaptions = new Map<string, PreparedReferenceCaptions>();
  private readonly captionSurfaces = new Map<string, RawSurface>();
  private captionSurfaceBytes = 0;
  private readonly textConfigs = new Map<string, ReferenceTextConfig>();
  private readonly preparedTexts = new Map<string, PreparedReferenceText>();
  private readonly textSurfaces = new Map<string, RawSurface>();
  private textSurfaceBytes = 0;
  private readonly localTextSurfaces = new Map<string, RawSurface>();
  private localTextSurfaceBytes = 0;
  private readonly flowTextConfigs = new Map<string, ReferenceFlowTextConfig>();
  private readonly preparedFlowTexts = new Map<string, PreparedReferenceFlowText>();
  private readonly evidenceConfigs = new Map<string, ReferenceEvidenceConfig>();
  private readonly preparedEvidence = new Map<string, PreparedReferenceEvidence>();
  private readonly evidenceSurfaces = new Map<string, RawSurface>();
  private evidenceSurfaceBytes = 0;
  private readonly geoLabelConfigs = new Map<string, ReferenceGeoLabelConfig>();
  private readonly preparedGeoLabels = new Map<string, PreparedReferenceGeoLabels>();
  private readonly tracePlans = new Map<string, PreparedReferenceTraceNode>();
  private readonly vectorPathPlans = new Map<string, ReferenceVectorPathPlan>();
  private readonly vectorPathWork = new Map<string, ReferenceVectorPathWork>();
  private readonly anchoredVectorPathPlans = new Map<string, ReferenceAnchoredVectorPathPlan>();
  /** Immutable validated geometry plans; cubic flattening happens once per
   * renderer instance, never once per output or shutter frame. */
  private readonly motionPathPlans = new Map<string, ReferenceMotionPathPlan>();
  private readonly anchoredMotionPathPlans = new Map<string, ReferenceAnchoredMotionPathPlan>();
  private readonly validatedAnchoredGeometry = new Map<string, ReferenceValidatedAnchoredPathGeometry>();
  private readonly anchoredVectorPathWork = new Map<string, ReferenceAnchoredVectorPathWork>();
  private readonly anchoredMotionPathWork = new Map<string, ReferenceAnchoredMotionPathWork>();
  private readonly anchoredFrameStateValidated = new Set<string>();
  private activeAnchoredPathFrameEvidence?: Map<string, ReferenceAnchoredPathFrameEvidence>;
  private completedAnchoredPathFrameEvidence: readonly ReferenceAnchoredPathFrameEvidence[] = Object.freeze([]);
  private readonly parallaxCameraConfigs = new Map<string, ReferenceParallaxCameraConfig>();
  private readonly camera3DConfigs = new Map<string, ReferenceCamera3DConfig>();
  private activeCamera3DFrameEvidence?: ReferenceCamera3DFrameEvidence[];
  private completedCamera3DFrameEvidence: readonly ReferenceCamera3DFrameEvidence[] = Object.freeze([]);
  private readonly mapCameraConfigs = new Map<string, ReferenceMapCameraConfig>();
  private readonly mapCameraRenderPreparation: ReferenceMapCameraRenderPreparation;
  private readonly mapCameraAnnotationConfigs = new Map<string, ReferenceMapCameraAnnotationConfig>();
  private mapCameraFrameEvidence: readonly ReferenceMapCameraPublicFrameEvidence[] = Object.freeze([]);
  private readonly geoAnnotationCameraConfigs = new Map<string, ReferenceGeoAnnotationCameraConfig>();
  private geoAnnotationFrameEvidence: readonly ReferenceGeoAnnotationRenderedFrameEvidence[] = Object.freeze([]);
  private readonly calloutLayerConfigs = new Map<string, ReferenceCalloutLayerConfig>();
  private readonly activeCalloutLayerPlans = new Map<string, ReturnType<typeof referenceCalloutPlanAt>>();
  private activeCalloutFrameEvidence?: ReferenceCalloutRenderedFrameEvidence[];
  private completedCalloutFrameEvidence: readonly ReferenceCalloutRenderedFrameEvidence[] = Object.freeze([]);
  private readonly identityComponentFragments =
    new Map<string, ReferenceIdentityComponentFragmentConfig>();
  private completedIdentityComponentFragmentFrameEvidence:
    readonly ReferenceIdentityComponentFragmentFrameEvidence[] = Object.freeze([]);
  private readonly localSpaceConfigs = new Map<string, ReferenceLocalSpaceConfig>();
  /** One immutable whole-IR ownership snapshot shared by this renderer tree.
   * A Precomp renderer must not rebuild it for the same already-loaded IR. */
  private readonly localSpaceStructuralIndex: ReferenceLocalSpaceStructuralValidationIndex;
  private readonly rendererTreeContext: ReferenceVisualRendererTreeContext;
  private readonly ownsRendererTreeContext: boolean;
  private readonly rendererTreeDepth: number;
  private activeRendererFrameEvidenceGeneration?: ReferenceLocalSpaceRendererFrameEvidenceGeneration;
  private readonly localSpaceDescendantContexts = new Map<string, ReferenceLocalSpaceConfig>();
  private readonly responsiveStackConfigs = new Map<string, ReferenceResponsiveStackConfig>();
  private readonly responsiveDescendantContexts = new Map<string, ReferenceResponsiveStackLocalContext>();
  private readonly responsiveSlotTileMemo = new Map<string, Promise<RawSurface>>();
  private activeResponsiveStackFrameEvidence?: ReferenceResponsiveStackFrameEvidence[];
  private completedResponsiveStackFrameEvidence: readonly ReferenceResponsiveStackFrameEvidence[] = Object.freeze([]);
  private completedResponsiveSlotMediaAnchorFrameEvidence:
    readonly ReferenceResponsiveSlotMediaAnchorLinkEvidence[] = Object.freeze([]);
  private readonly diagramLayouts = new Map<string, Readonly<{ contract: CutDiagramLayoutContract; plan?: ReferenceDiagramLayoutPlan }>>();
  private readonly diagramNodeContexts = new Map<string, ReferenceDiagramNodeLocalContext>();
  private readonly diagramDescendantContexts = new Map<string, ReferenceDiagramNodeLocalContext>();
  private readonly diagramNodeTileMemo = new Map<string, Promise<ReferenceDiagramCachedSurface>>();
  private readonly diagramEdgeRasterMemo = new Map<string, Promise<ReferenceDiagramCachedSurface>>();
  private diagramRasterCache?: Promise<ReferenceDiagramRasterCache>;
  private diagramRasterBackend?: string;
  private localPaintRasterBackend?: string;
  private diagramLayoutTail: Promise<void> = Promise.resolve();
  private diagramLayoutsInFlight = 0;
  private activeDiagramLayoutFrameEvidence?: ReferenceDiagramLayoutFrameEvidence[];
  private completedDiagramLayoutFrameEvidence: readonly ReferenceDiagramLayoutFrameEvidence[] = Object.freeze([]);
  private readonly localSpaceTileMemo = new Map<string, Promise<RawSurface>>();
  private readonly localSpacePlacementMemo = new Map<string, Promise<RawSurface>>();
  /** One renderer may evaluate sibling visual branches concurrently, but
   * retained-tile transforms have a bounded single-transform memory model.
   * Keep their allocation-heavy scale/rotate/translate path strictly FIFO. */
  private localSpaceTransformTail: Promise<void> = Promise.resolve();
  private localSpaceTransformsInFlight = 0;
  private activeLocalSpaceFrameEvidence?: MutableReferenceLocalSpaceFrameEvidence;
  private completedLocalSpaceFrameEvidence?: ReferenceLocalSpaceFrameEvidence;
  private activeNestedLocalSpaceRendererFrameExecutions?: ReferenceLocalSpaceRendererFrameExecution[];
  private completedLocalSpaceRendererFrameExecutions: readonly ReferenceLocalSpaceRendererFrameExecution[] = Object.freeze([]);
  private completedLocalSpaceRendererFrameExecutionReceipts: readonly ReferenceLocalSpaceRendererFrameExecutionEvidence[] = Object.freeze([]);
  private completedLocalSpaceRendererFrameExecutionTree?: ReferenceLocalSpaceRendererFrameExecutionTreeEvidence;
  private completedLocalSpaceRendererFrameExecutionTreeAuthority?: ReferenceLocalSpaceRendererFrameExecutionTreeTrustedAuthority;
  private activeLocalSpaceCompositionTransformPreflight?: ReferenceLocalSpaceCompositionTransformPreflightEvidence;
  private activeComponentFragmentLocalSpacePreflight?: ReferenceComponentFragmentLocalSpaceFramePreflight;
  private readonly activeAffineLocalSpacePlans = new Map<string, ReferencePreparedAffineLocalSpacePlan>();
  private completedLocalSpaceCompositionTransformPreflight?: ReferenceLocalSpaceCompositionTransformPreflightEvidence;
  private completedComponentFragmentLocalSpacePreflight?: ReferenceComponentFragmentLocalSpaceFramePreflight;
  private readonly activeParallaxCameraPlans = new Map<string, ReferenceParallaxCameraFramePlan>();
  private readonly activeGeoAnnotationPlans = new Map<string, ReturnType<typeof referenceGeoAnnotationPlanAt>>();
  private readonly activeMapCameraGeoAnnotationPlans = new Map<string, ReturnType<typeof referenceMapCameraGeoAnnotationPlanAt>>();
  private readonly semanticMatches?: ReferencePreparedSemanticMatches;
  private activeSemanticMatchFrameEvidence?: ReferenceSemanticMatchFrameEvidence[];
  private completedSemanticMatchFrameEvidence: readonly ReferenceSemanticMatchFrameEvidence[] = Object.freeze([]);
  private readonly stackConfigs = new Map<string, ReferenceStackConfig>();
  private readonly chartConfigs = new Map<string, ReferenceChartConfig>();
  private readonly seriesChartConfigs = new Map<string, ReferenceSeriesChartConfig>();
  private readonly preparedSeriesCharts = new Map<string, PreparedReferenceSeriesChart>();
  private readonly completedTraceSurfaces = new Map<string, RawSurface>();
  private readonly lutConfigs = new Map<string, ReferenceLutConfig>();
  private readonly colorConvertConfigs = new Map<string, ReferenceColorConvertConfig>();
  private readonly tonalCurveConfigs = new Map<string, ReferenceTonalCurveConfig>();
  private readonly projectLutSourceIds: ReadonlySet<string>;
  private readonly preparedLuts = new Map<string, ReferenceCubeLut>();
  private readonly precompConfigs = new Map<string, ReferencePrecompConfig>();
  private readonly precompRenderers = new Map<string, ReferenceVisualRenderer>();
  private readonly precompRendererPreparations =
    new Map<string, Promise<ReferenceVisualRenderer>>();
  private readonly precompFrames = new Map<string, Promise<RawSurface>>();
  private readonly activeNodeFrameWork = new Set<Promise<RawSurface | undefined>>();
  private audioReactivePreparationEvidence: readonly ReferenceAudioReactivePreparationEvidence[] = Object.freeze([]);
  private readonly reachableNodeIds: Set<string>;
  private readonly world: unknown;
  private outputFrameIndex = 0;
  private activeSceneId?: string;
  private sceneFrameActive = false;
  private closing?: Promise<void>;
  private closed = false;
  constructor(
    readonly ir: CutAVIR,
    readonly composition: IRComposition,
    readonly projectRoot: string,
    readonly cacheRoot: string,
    private readonly verifiedResourcePath?: ReferenceVerifiedInputSession["pathFor"],
    rendererTreeContext?: ReferenceVisualRendererTreeContext,
    rendererTreeDepth = 1,
    rootCacheOptions: ReferenceVisualRendererRootCacheOptions = {},
  ) {
    this.ownsRendererTreeContext = rendererTreeContext === undefined;
    if (!Number.isSafeInteger(rendererTreeDepth) || rendererTreeDepth < 1 || rendererTreeDepth > 17) {
      throw new Error("CUT_LOCAL_SPACE_GRAPH: renderer-tree depth must be an integer from 1 through 17.");
    }
    this.rendererTreeDepth = rendererTreeDepth;
    if (rendererTreeContext !== undefined
      && (rendererTreeContext.authority !== referenceVisualRendererTreeAuthority || rendererTreeContext.ir !== ir)) {
      throw new Error("CUT_LOCAL_SPACE_GRAPH: a nested renderer received an untrusted or foreign whole-IR structural context.");
    }
    const surfaceCacheByteLimit = rootCacheOptions.surfaceCacheByteLimit
      ?? maximumCaptionSurfaceCacheBytes;
    if (!Number.isSafeInteger(surfaceCacheByteLimit) || surfaceCacheByteLimit < 4
      || surfaceCacheByteLimit > maximumCaptionSurfaceCacheBytes) {
      throw new Error(`CUT_VISUAL_CACHE_LIMIT: renderer surface-cache byte limit must be from 4 through ${maximumCaptionSurfaceCacheBytes}.`);
    }
    const privateLocalPaintAlphaBoundsMode = rootCacheOptions.privateLocalPaintAlphaBoundsMode ?? "automatic";
    if (privateLocalPaintAlphaBoundsMode !== "automatic"
      && privateLocalPaintAlphaBoundsMode !== "forced-full-surface") {
      throw new Error("CUT_LOCAL_SPACE_RASTER: private LocalSpace paint alpha-bounds mode is invalid.");
    }
    this.rendererTreeContext = rendererTreeContext ?? Object.freeze({
      authority: referenceVisualRendererTreeAuthority,
      ir,
      localSpaceStructuralIndex: createReferenceLocalSpaceStructuralValidationIndex(ir),
      evidenceBudget: {},
      localPaintSurfaceCache: rootCacheOptions.sharedLocalPaintSurfaceCache
        ?? new ReferenceLocalPaintSurfaceCache(),
      staticMediaGradeCache: new ReferenceStaticMediaGradeCache(
        rootCacheOptions.staticMediaGradeCacheByteLimit
          ?? maximumStaticMediaGradeCacheBytes,
        maximumStaticMediaGradeCacheEntries,
        rootCacheOptions.staticMediaGradeHandoffMode ?? "immutable-lease",
      ),
      mapCameraCanonicalRasterCache: new ReferenceMapCameraCanonicalRasterCache(),
      surfaceCacheByteLimit,
      nestedCompositionPreparation: rootCacheOptions.lazyNestedCompositionPreparation
        ? "lazy-active"
        : "eager",
      retainedAlphaScaleDiagnostic: rootCacheOptions.retainedAlphaScaleDiagnostic,
      retainedMediaViewportQ16TapDiagnostic:
        rootCacheOptions.retainedMediaViewportQ16TapDiagnostic,
      privateStraightCompositeDiagnostic: rootCacheOptions.privateStraightCompositeMode
        ? createReferencePrivateStraightRgbaCompositeDiagnostic(rootCacheOptions.privateStraightCompositeMode)
        : undefined,
      privateLocalPaintAlphaBoundsMode,
    });
    this.localSpaceStructuralIndex = this.rendererTreeContext.localSpaceStructuralIndex;
    this.preparedSignalResolver = new ReferencePreparedSignalResolver(ir);
    this.reachableNodeIds = referenceReachableCompositionNodes(ir, composition);
    for (const [nodeId, config] of validateReferenceIdentityComponentFragments(
      ir,
      composition,
      this.reachableNodeIds,
      this.localSpaceStructuralIndex.componentFragmentAdmissionIndex,
    )) {
      this.identityComponentFragments.set(nodeId, config);
    }
    for (const [nodeId, config] of validateReferenceMediaCamera2DGraph(ir, composition, this.reachableNodeIds)) {
      this.mediaCamera2DConfigs.set(nodeId, config);
    }
    for (const [nodeId, config] of validateReferenceLocalSpaceGraph(ir, composition, this.reachableNodeIds, {
      structuralIndex: this.localSpaceStructuralIndex,
    })) {
      this.localSpaceConfigs.set(nodeId, config);
    }
    for (const [nodeId, config] of validateReferenceCamera3DGraph(ir, composition, this.reachableNodeIds, this.localSpaceConfigs)) {
      this.camera3DConfigs.set(nodeId, config);
    }
    for (const [nodeId, config] of referenceLocalSpaceDescendantContexts(ir, this.localSpaceConfigs)) {
      this.localSpaceDescendantContexts.set(nodeId, config);
    }
    for (const nodeId of this.reachableNodeIds) {
      const node = ir.nodes[nodeId];
      if (!node
        || (node.op !== "cut.visual.path" && node.op !== "cut.visual.motion_path")
        || !isReferenceAnchoredPathGeometryValue(node.inputs.geometry)) continue;
      const decoded = decodeReferenceAnchoredPathGeometry(node, node.inputs.geometry, "input \u201cgeometry\u201d");
      this.validatedAnchoredGeometry.set(
        node.id,
        validateReferenceAnchoredPathGeometry(
          ir,
          composition,
          node,
          decoded,
          this.localSpaceConfigs,
          this.mediaCamera2DConfigs,
          this.identityComponentFragments,
        ),
      );
    }
    for (const [nodeId, config] of validateReferenceCalloutGraph(
      ir,
      composition,
      this.reachableNodeIds,
      this.localSpaceConfigs,
      this.mediaCamera2DConfigs,
      {},
      this.identityComponentFragments,
    )) {
      this.calloutLayerConfigs.set(nodeId, config);
    }
    this.semanticMatches = prepareReferenceSemanticMatches(
      ir,
      composition,
      this.localSpaceConfigs,
      this.preparedSignalResolver,
    );
    for (const [nodeId, config] of validateReferenceResponsiveStackGraph(
      ir,
      composition,
      this.reachableNodeIds,
      this.identityComponentFragments,
    )) {
      this.responsiveStackConfigs.set(nodeId, config);
      for (const slot of config.slots) {
        if (!slot.mediaCamera2D) continue;
        const camera = ir.nodes[slot.mediaCamera2D.cameraNodeId];
        const plan = this.mediaCamera2DConfigs.get(slot.mediaCamera2D.cameraNodeId);
        if (!camera || !plan || plan.outputContext.kind !== "responsive-slot") {
          throw new ReferenceResponsiveStackError(
            "CUT_RESPONSIVE_STACK_GRAPH",
            camera ?? ir.nodes[slot.slotNodeId]!,
            `slot-bound MediaCamera2D ${slot.mediaCamera2D.cameraNodeId} has no matching native camera output plan.`,
          );
        }
        const output = plan.outputContext;
        if (output.compositionId !== composition.id
          || output.stackNodeId !== config.nodeId
          || output.slotNodeId !== slot.slotNodeId
          || output.index !== slot.context.index
          || output.planIdentity !== config.plan.id
          || output.compilerContextIdentity !== slot.mediaCamera2D.compilerContext.contextIdentity
          || output.width !== slot.context.width
          || output.height !== slot.context.height
          || output.rasterSlot.left !== slot.context.rasterSlot.left
          || output.rasterSlot.top !== slot.context.rasterSlot.top
          || output.rasterSlot.right !== slot.context.rasterSlot.right
          || output.rasterSlot.bottom !== slot.context.rasterSlot.bottom) {
          throw new ReferenceResponsiveStackError(
            "CUT_RESPONSIVE_STACK_IDENTITY",
            camera,
            "native MediaCamera2D output context diverges from its validated ResponsiveStack slot geometry or compiler context.",
          );
        }
      }
    }
    for (const [nodeId, config] of referenceResponsiveStackDescendantContexts(this.responsiveStackConfigs)) {
      if (this.localSpaceDescendantContexts.has(nodeId)) {
        const node = ir.nodes[nodeId];
        if (!node) throw new Error(`CUT responsive/local context conflict references missing node ${nodeId}.`);
        throw new ReferenceResponsiveStackError("CUT_RESPONSIVE_STACK_GRAPH", node, "cannot belong to both LocalSpace and ResponsiveSlot coordinate contexts.");
      }
      this.responsiveDescendantContexts.set(nodeId, config);
    }
    const diagramLayoutNodes = [...this.reachableNodeIds]
      .map((nodeId) => ir.nodes[nodeId])
      .filter((node): node is IRNode => node?.op === cutDiagramOps.layout)
      .sort((left, right) => left.provenance.module.localeCompare(right.provenance.module)
        || left.provenance.span.start.line - right.provenance.span.start.line
        || left.provenance.span.start.column - right.provenance.span.start.column
        || left.id.localeCompare(right.id));
    for (const node of diagramLayoutNodes) {
      const { contract, plannerContexts } = (() => {
        try {
          const contract_ = decodeCutDiagramLayout(ir, node);
          return Object.freeze({ contract: contract_, plannerContexts: referenceDiagramNodeRasterContexts(contract_) });
        } catch (error) {
          return referenceDiagramPlannerFailure(node, error);
        }
      })();
      this.diagramLayouts.set(node.id, Object.freeze({ contract }));
      const contextsByIrNode = new Map(plannerContexts.map((context) => [context.diagramNodeIrId, context]));
      for (const diagramNode of contract.nodes) {
        const plannerContext = contextsByIrNode.get(diagramNode.node.id);
        if (!plannerContext) referenceDiagramRenderFailure("CUT_DIAGRAM_BOUNDS", diagramNode.node, "has no prepared planner-owned local raster context.");
        const { context, descendants } = referenceDiagramNodeLocalContext(ir, contract, diagramNode, plannerContext);
        this.diagramNodeContexts.set(diagramNode.node.id, context);
        for (const descendant of descendants) {
          if (this.localSpaceDescendantContexts.has(descendant.id) || this.responsiveDescendantContexts.has(descendant.id) || this.diagramDescendantContexts.has(descendant.id)) {
            referenceDiagramRenderFailure("CUT_DIAGRAM_BOUNDS", descendant, "belongs to more than one bounded coordinate owner.");
          }
          this.diagramDescendantContexts.set(descendant.id, context);
        }
      }
    }
    this.mapCameraRenderPreparation =
      prepareReferenceMapCameraRenderInvocation(ir, composition, this.reachableNodeIds);
    const mapCameraConfigs =
      referenceMapCameraPreparedConfigurations(this.mapCameraRenderPreparation);
    for (const [nodeId, config] of mapCameraConfigs) {
      this.mapCameraConfigs.set(nodeId, config);
      const annotations = validateReferenceMapCameraGeoAnnotations(ir, composition, config);
      if (annotations) this.mapCameraAnnotationConfigs.set(nodeId, annotations);
    }
    const parallaxConfigs = validateReferenceParallaxCameraGraph(ir, composition, this.reachableNodeIds);
    for (const [nodeId, config] of parallaxConfigs) {
      this.parallaxCameraConfigs.set(nodeId, config);
    }
    for (const [nodeId, config] of validateReferenceGeoAnnotationGraph(ir, composition, parallaxConfigs, this.reachableNodeIds, this.localSpaceConfigs)) {
      this.geoAnnotationCameraConfigs.set(nodeId, config);
    }
    for (const nodeId of this.reachableNodeIds) {
      const chain = referenceRetainedPathChain(ir, nodeId);
      if (chain) this.retainedPathChains.set(nodeId, chain);
    }
    const linkedEditAuthorizations = validateReferenceLinkedEditTransactions(ir, composition);
    for (const nodeId of this.reachableNodeIds) {
      const node = ir.nodes[nodeId];
      if (node?.op === "cut.edit.picture_track") validateReferencePictureTrackOperationPlan(
        ir,
        composition,
        node,
        linkedEditAuthorizations.pictureByTrackId.get(node.id),
      );
    }
    this.projectLutSourceIds = new Set(validateReferenceLutResourceOwnership(ir).keys());
    const precompGraph = validateReferencePrecompGraph(ir, composition);
    for (const nodeId of this.reachableNodeIds) {
      const config = precompGraph.configs.get(nodeId);
      if (config) this.precompConfigs.set(nodeId, config);
    }
    this.world = referenceGeoWorldGeometry();
    validateReferenceChromaKeyCompositionBudget(
      [...this.reachableNodeIds].flatMap((id) => {
        const node = ir.nodes[id];
        return node?.op === "cut.visual.chroma_key" ? [node] : [];
      }),
      this.composition.width,
      this.composition.height,
    );
    const reachableClipPaths = [...this.reachableNodeIds].flatMap((id) => {
      const node = ir.nodes[id];
      if (!node || node.op !== "cut.visual.clip_path") return [];
      const config = referenceClipPathConfig(ir, node);
      if (!config) throw new Error("Internal CUT ClipPath configuration mismatch.");
      const context = this.localSpaceDescendantContexts.get(node.id);
      return [{
        node,
        config,
        width: context?.width ?? this.composition.width,
        height: context?.height ?? this.composition.height,
      }];
    });
    validateReferenceClipPathContextBudget(reachableClipPaths);
    validateReferenceMotionBlurCompositionBudget(ir, this.reachableNodeIds, this.composition.width, this.composition.height);
    for (const node of Object.values(ir.nodes)) {
      const visualEffect = referenceVisualEffectConfig(node);
      if (visualEffect) this.visualEffects.set(node.id, visualEffect);
      const lut = referenceLutConfig(ir, node);
      if (lut && this.reachableNodeIds.has(node.id)) this.lutConfigs.set(node.id, lut);
      const colorConvert = referenceColorConvertConfig(node);
      if (colorConvert && this.reachableNodeIds.has(node.id)) this.colorConvertConfigs.set(node.id, colorConvert);
      const tonalCurve = referenceTonalCurveConfig(node);
      if (tonalCurve && this.reachableNodeIds.has(node.id)) this.tonalCurveConfigs.set(node.id, tonalCurve);
      const captions = this.reachableNodeIds.has(node.id) ? referenceCaptionConfig(node, ir, composition) : undefined;
      if (captions) this.captionConfigs.set(node.id, captions);
      const transcriptCaptions = this.reachableNodeIds.has(node.id)
        ? referenceTranscriptCaptionConfig(node, ir, composition)
        : undefined;
      if (transcriptCaptions) {
        this.transcriptCaptionConfigs.set(node.id, transcriptCaptions);
      }
      if (this.reachableNodeIds.has(node.id) && node.op === "cut.visual.text") {
        const localSpace = this.localSpaceDescendantContexts.get(node.id), responsive = this.responsiveDescendantContexts.get(node.id), diagram = this.diagramDescendantContexts.get(node.id);
        const localContext = localSpace ?? responsive ?? diagram;
        const text = referenceTextConfig(
          node,
          ir,
          localContext ? this.localComposition(localContext) : composition,
          localSpace || diagram ? referenceLocalSpaceTextLayoutContext(localSpace ?? diagram!) : responsive ? referenceResponsiveStackTextLayoutContext(responsive) : undefined,
        );
        if (!text) throw new Error("Internal CUT Text configuration mismatch.");
        this.textConfigs.set(node.id, text);
      }
      if (this.reachableNodeIds.has(node.id) && node.op === "cut.visual.flow_text") {
        const localSpace = this.localSpaceDescendantContexts.get(node.id), responsive = this.responsiveDescendantContexts.get(node.id), diagram = this.diagramDescendantContexts.get(node.id);
        const localContext = localSpace ?? responsive ?? diagram;
        const flowText = referenceFlowTextConfig(
          node,
          ir,
          localContext ? this.localComposition(localContext) : composition,
          localSpace || diagram ? referenceLocalSpaceTextLayoutContext(localSpace ?? diagram!) : responsive ? referenceResponsiveStackTextLayoutContext(responsive) : undefined,
        );
        if (!flowText) throw new Error("Internal CUT FlowText configuration mismatch.");
        this.flowTextConfigs.set(node.id, flowText);
      }
      if (this.reachableNodeIds.has(node.id) && node.op === "cut.visual.video") {
        const video = referenceVideoConfig(ir, composition, node);
        if (!video) throw new Error("Internal CUT Video configuration mismatch.");
        this.videoConfigs.set(node.id, video);
      }
      if (this.reachableNodeIds.has(node.id) && node.op === "cut.visual.image_sequence") {
        const sequence = referenceImageSequenceConfig(ir, composition, node);
        if (!sequence) throw new Error("Internal CUT ImageSequence configuration mismatch.");
        this.imageSequenceConfigs.set(node.id, sequence);
      }
      if (this.reachableNodeIds.has(node.id)) {
        const inputColor = referenceVideoInputColorConfig(ir, node);
        if (inputColor) this.videoInputColorConfigs.set(node.id, inputColor);
      }
      if (this.reachableNodeIds.has(node.id) && node.op === "cut.edit.picture_clip") {
        const timeMap = referencePictureTimeMapConfig(ir, composition, node);
        if (!timeMap) throw new Error("Internal CUT PictureClip time-map configuration mismatch.");
        this.pictureTimeMapConfigs.set(node.id, timeMap);
        this.pictureTimeMapConfigIdentities.set(
          node.id,
          referencePictureTimeMapConfigIdentity(timeMap),
        );
      }
      const evidence = this.reachableNodeIds.has(node.id) ? referenceEvidenceConfig(node, ir, composition) : undefined;
      if (evidence) this.evidenceConfigs.set(node.id, evidence);
      const geoLabels = this.reachableNodeIds.has(node.id) ? referenceGeoLabelConfig(node, ir) : undefined;
      if (geoLabels) {
        if (this.geoLabelConfigs.size >= referenceGeoLabelLimits.maxNodesPerComposition) referenceGeoLabelFailure(node, "CUT_GEO_FONT_BUDGET", `composition exceeds the ${referenceGeoLabelLimits.maxNodesPerComposition}-geo-label-node limit.`);
        this.geoLabelConfigs.set(node.id, geoLabels);
      }
      if (this.reachableNodeIds.has(node.id) && node.op === "cut.visual.trace") {
        const plan = prepareReferenceTraceNode(node);
        if (!plan) throw new Error(`Reference Trace ${node.id} has no prepared geometry.`);
        this.tracePlans.set(node.id, plan);
      }
      if (this.reachableNodeIds.has(node.id) && node.op === "cut.visual.motion_path") {
        const anchored = this.validatedAnchoredGeometry.get(node.id);
        if (anchored) {
          const plan = prepareReferenceAnchoredMotionPathNode(node, anchored);
          if (!plan) throw new Error(`Reference anchored MotionPath ${node.id} did not produce a prepared plan.`);
          this.anchoredMotionPathPlans.set(node.id, plan);
        } else {
          this.motionPathPlans.set(node.id, prepareReferenceMotionPathNode(node));
        }
      }
      if (this.reachableNodeIds.has(node.id) && node.op === "cut.visual.path" && node.inputs.geometry !== undefined) {
        const anchored = this.validatedAnchoredGeometry.get(node.id);
        if (anchored) {
          const plan = prepareReferenceAnchoredVectorPathNode(ir, node, anchored);
          if (!plan) throw new Error(`Reference anchored Path ${node.id} has no prepared geometry.`);
          this.anchoredVectorPathPlans.set(node.id, plan);
        } else {
          const plan = prepareReferenceVectorPathNode(ir, node);
          if (!plan) throw new Error(`Reference retained Path ${node.id} has no prepared geometry.`);
          this.vectorPathPlans.set(node.id, plan);
          this.vectorPathWork.set(node.id, validateReferenceVectorPathFrameStates(ir, composition, node, plan));
        }
      }
      if (node.op === "cut.visual.composite") this.compositeModes.set(node.id, blendMode(node));
      const stack = referenceStackConfig(node, this.composition);
      if (stack) this.stackConfigs.set(node.id, stack);
      const chart = referenceChartConfig(this.ir, node, this.composition);
      if (chart && this.reachableNodeIds.has(node.id)) this.chartConfigs.set(node.id, chart);
      const seriesChart = this.reachableNodeIds.has(node.id) ? referenceSeriesChartConfig(this.ir, node, this.composition) : undefined;
      if (seriesChart) this.seriesChartConfigs.set(node.id, seriesChart);
      const mask = referenceMaskConfig(ir, node);
      if (mask && this.reachableNodeIds.has(node.id)) {
        const context = this.localSpaceDescendantContexts.get(node.id);
        validateReferenceMaskCanvas(node, context?.width ?? this.composition.width, context?.height ?? this.composition.height);
        this.maskConfigs.set(node.id, mask);
      }
      const chromaKey = referenceChromaKeyConfig(ir, node);
      if (chromaKey && this.reachableNodeIds.has(node.id)) this.chromaKeyConfigs.set(node.id, chromaKey);
      const clipPath = referenceClipPathConfig(ir, node);
      if (clipPath && this.reachableNodeIds.has(node.id)) {
        const context = this.localSpaceDescendantContexts.get(node.id);
        this.clipPathPlans.set(node.id, prepareReferenceClipPath(
          node,
          clipPath,
          context?.width ?? this.composition.width,
          context?.height ?? this.composition.height,
        ));
      }
      const motionBlur = referenceMotionBlurConfig(node);
      if (motionBlur && this.reachableNodeIds.has(node.id)) {
        const child = this.ir.nodes[node.children[0]];
        if (!child) throw new Error(`Reference MotionBlur ${node.id} has no direct child for boundary preflight.`);
        this.motionBlurConfigs.set(node.id, prepareReferenceMotionBlurBoundary(
          node,
          child,
          divideRational(rational(1), this.composition.fps),
          motionBlur,
        ));
      }
      const track2D = referenceTrack2DConfig(ir, node);
      if (track2D && this.reachableNodeIds.has(node.id)) this.track2DConfigs.set(node.id, track2D);
      const planarTrack = referencePlanarTrackConfig(ir, node);
      if (planarTrack && this.reachableNodeIds.has(node.id)) {
        this.planarTrackConfigs.set(node.id, planarTrack);
        const matte = referencePlanarTrackMatteConfig(ir, node);
        if (matte) this.planarTrackMatteConfigs.set(node.id, matte);
      }
    }
  }

  private async cacheLocator(...segments: string[]) {
    const lexicalProject = resolve(this.projectRoot), physicalProject = await realpath(lexicalProject), target = resolve(this.cacheRoot, ...segments);
    const local = [physicalProject, lexicalProject].map((root) => relative(root, target)).find((candidate) => candidate && candidate !== ".." && !candidate.startsWith(`..${sep}`) && !isAbsolute(candidate));
    if (!local) throw new Error("CUT reference visual cache must be a dedicated directory inside the project root.");
    return local.split(sep).join("/");
  }

  private async cacheDirectory(...segments: string[]) {
    return ensureProjectWriteDirectory(this.projectRoot, await this.cacheLocator(...segments));
  }

  private compositeLayers(surfaces: Array<RawSurface | undefined>, mode: RgbaBlendMode): RawSurface {
    let result = transparent(this.composition.width, this.composition.height);
    for (const surface of surfaces) {
      if (!surface) continue;
      result = compositeIntoPrivateAccumulator(result, surface, mode);
    }
    return result;
  }

  private maskedSurface(surfaces: Array<RawSurface | undefined>, config: ReferenceMaskConfig): RawSurface {
    const target = surfaces[0], matte = surfaces[1];
    if (!target || !matte) return transparent(this.composition.width, this.composition.height);
    return rgbaResultSurface(applyMaskRgba(target, matte, {
      mode: config.mode,
      invert: config.invert,
      featherPx: config.featherPx,
      expandPx: config.expandPx,
    }));
  }

  private async stackSurface(node: IRNode, time: Rational, frame: number) {
    const config = this.stackConfigs.get(node.id);
    if (!config) throw new Error(`Reference Stack ${node.id} has no validated layout configuration.`);
    const children = await Promise.all(node.children.map((child) => this.nodeFrame(child, time, frame)));
    const transparentAnchor = {
      left: this.composition.width / 2, right: this.composition.width / 2,
      top: this.composition.height / 2, bottom: this.composition.height / 2,
      width: 0, height: 0, centerX: this.composition.width / 2, centerY: this.composition.height / 2,
    };
    const bounds = children.map((child) => child ? referenceAlphaBounds(child) : transparentAnchor);
    const placements = referenceStackPlacements(bounds, config);
    const placed = await Promise.all(children.map((child, index) => child
      ? placeOnCanvas(child, this.composition.width, this.composition.height, placements[index].x, placements[index].y, 1, 0)
      : undefined));
    return composite(this.composition.width, this.composition.height, placed);
  }

  private prepareDiagramLayoutPlans() {
    const bindings = [...this.diagramLayouts.values()].sort((left, right) => {
      const a = left.contract.node, b = right.contract.node;
      return a.provenance.module.localeCompare(b.provenance.module)
        || a.provenance.span.start.line - b.provenance.span.start.line
        || a.provenance.span.start.column - b.provenance.span.start.column
        || a.id.localeCompare(b.id);
    });
    let priorValidationTests = 0;
    for (const binding of bindings) {
      const node = binding.contract.node;
      try {
        const transitionSamples = referenceDiagramTransitionSamples(this.ir, this.composition, binding.contract, this.preparedSignalResolver);
        const plan = planReferenceDiagramLayout(binding.contract, {
          canvasWidth: this.composition.width,
          canvasHeight: this.composition.height,
          priorValidationTests,
          ...(transitionSamples ? { transitionSamples } : {}),
        });
        for (const plannerContext of plan.descendantContexts) {
          const rendererContext = this.diagramNodeContexts.get(plannerContext.diagramNodeIrId);
          if (!rendererContext || rendererContext.semanticIdentity !== plannerContext.semanticIdentity) {
            referenceDiagramRenderFailure("CUT_DIAGRAM_BOUNDS", node, `prepared local raster context for ${JSON.stringify(plannerContext.diagramNodeId)} diverged after signal preparation.`);
          }
        }
        priorValidationTests = plan.validationBudget.totalValidationTests;
        this.diagramLayouts.set(node.id, Object.freeze({ contract: binding.contract, plan }));
      } catch (error) {
        referenceDiagramPlannerFailure(node, error);
      }
    }
  }

  private async preparedPrecompRenderer(
    nodeId: string,
    config: ReferencePrecompConfig,
  ) {
    const prepared = this.precompRenderers.get(nodeId);
    if (prepared) return prepared;
    const pending = this.precompRendererPreparations.get(nodeId);
    if (pending) return pending;
    if (this.closed) throw new ReferenceVisualRendererStateError(this.composition.id);
    const source = this.ir.compositions.find(
      (candidate) => candidate.id === config.sourceCompositionId,
    );
    if (!source) {
      throw new Error(
        `Reference Precomp ${nodeId} cannot resolve source composition ${config.sourceCompositionId}.`,
      );
    }
    const renderer = new ReferenceVisualRenderer(
      this.ir,
      source,
      this.projectRoot,
      this.cacheRoot,
      this.verifiedResourcePath,
      this.rendererTreeContext,
      this.rendererTreeDepth + 1,
    );
    const preparation = (async () => {
      try {
        await renderer.prepare();
        if (this.closed) {
          throw new ReferenceVisualRendererStateError(this.composition.id);
        }
        this.precompRenderers.set(nodeId, renderer);
        return renderer;
      } catch (error) {
        if (this.precompRenderers.get(nodeId) === renderer) {
          this.precompRenderers.delete(nodeId);
        }
        await renderer.closeAndWait();
        throw error;
      }
    })();
    this.precompRendererPreparations.set(nodeId, preparation);
    try {
      return await preparation;
    } finally {
      if (this.precompRendererPreparations.get(nodeId) === preparation) {
        this.precompRendererPreparations.delete(nodeId);
      }
    }
  }

  async prepare() {
    if (this.closed) throw new ReferenceVisualRendererStateError(this.composition.id);
    const track2DSourceIds = new Set([...this.track2DConfigs.values()].map((config) => config.sourceId));
    const planarTrackSourceIds = new Set([...this.planarTrackConfigs.values()].map((config) => config.sourceId));
    const captionSourceIds = new Set([...this.captionConfigs.values()].map((config) => config.sourceId));
    const transcriptCaptionSourceIds = new Set(
      [...this.transcriptCaptionConfigs.values()].map((config) => {
        const binding = this.ir.transcriptBindings?.find(
          (candidate) => candidate.id === config.transcriptBindingId,
        );
        if (!binding) {
          throw new Error(`Reference transcript captions ${config.nodeId} lost binding ${config.transcriptBindingId}.`);
        }
        return binding.transcriptResourceId;
      }),
    );
    const captionFontIds = new Set([
      ...[...this.captionConfigs.values()].map((config) => config.fontId),
      ...[...this.transcriptCaptionConfigs.values()].map((config) => config.fontId),
    ]);
    const textFontIds = new Set([...this.textConfigs.values()].map((config) => config.fontId));
    const flowTextFontIds = new Set([...this.flowTextConfigs.values()].flatMap((config) => config.fontIds));
    const evidenceSourceIds = new Set([...this.evidenceConfigs.values()].map((config) => config.sourceId));
    const evidenceFontIds = new Set([...this.evidenceConfigs.values()].map((config) => config.fontId));
    const geoFontIds = new Set([...this.geoLabelConfigs.values()].flatMap((config) => config.fontId ? [config.fontId] : []));
    const lutSourceIds = new Set([...this.lutConfigs.values()].map((config) => config.sourceId));
    const seriesChartSourceIds = new Set([...this.seriesChartConfigs.values()].flatMap((config) => config.sourceIds));
    const seriesChartFontIds = new Set([...this.seriesChartConfigs.values()].map((config) => config.fontId));
    const imageSequenceManifestIds = new Set([...this.imageSequenceConfigs.values()].map((config) => config.source.manifestResourceId));
    const reachableInputResourceIds = new Set<string>();
    for (const nodeId of this.reachableNodeIds) {
      const node = this.ir.nodes[nodeId];
      if (!node) continue;
      Object.values(node.inputs).forEach((value) => collectReferencedResourceIds(value, reachableInputResourceIds));
    }
    if (this.track2DConfigs.size > referenceTrack2DLimits.maxNodesPerComposition) throw new Error(`CUT composition exceeds the ${referenceTrack2DLimits.maxNodesPerComposition}-Track2D-node reference limit.`);
    if (this.planarTrackConfigs.size > referencePlanarTrackLimits.maxNodesPerComposition) {
      const config = this.planarTrackConfigs.values().next().value as ReferencePlanarTrackConfig | undefined;
      const node = config ? this.ir.nodes[config.nodeId] : undefined;
      if (!node) throw new Error("Internal CUT PlanarTrack composition budget has no source-located consumer.");
      throw new ReferencePlanarTrackError("CUT_PLANAR_TRACK_LIMIT", node.id, node, `composition exceeds the ${referencePlanarTrackLimits.maxNodesPerComposition}-PlanarTrack-node reference limit.`);
    }
    if (planarTrackSourceIds.size > referencePlanarTrackLimits.maxDistinctResourcesPerComposition) {
      const config = this.planarTrackConfigs.values().next().value as ReferencePlanarTrackConfig | undefined;
      const node = config ? this.ir.nodes[config.nodeId] : undefined;
      if (!node) throw new Error("Internal CUT PlanarTrack resource budget has no source-located consumer.");
      throw new ReferencePlanarTrackError("CUT_PLANAR_TRACK_LIMIT", node.id, node, `composition references more than ${referencePlanarTrackLimits.maxDistinctResourcesPerComposition} distinct planar-track resources.`);
    }
    if (this.captionConfigs.size + this.transcriptCaptionConfigs.size
      > referenceCaptionLimits.maxNodesPerComposition) {
      throw new Error(`CUT composition exceeds the ${referenceCaptionLimits.maxNodesPerComposition}-caption-node reference limit.`);
    }
    if (this.textConfigs.size > referenceTextLimits.maxNodesPerComposition) throw new Error(`CUT composition exceeds the ${referenceTextLimits.maxNodesPerComposition}-Text-node reference limit.`);
    if (this.flowTextConfigs.size > referenceFlowTextLimits.maxNodesPerComposition) {
      const config = this.flowTextConfigs.values().next().value as ReferenceFlowTextConfig | undefined, node = config ? this.ir.nodes[config.nodeId] : undefined;
      if (!node) throw new Error(`Internal CUT FlowText composition budget has no source-located consumer.`);
      throw new ReferenceFlowTextError("CUT_FLOW_TEXT_BUDGET", node.id, node, `composition exceeds the ${referenceFlowTextLimits.maxNodesPerComposition}-FlowText-node reference limit.`);
    }
    if (this.evidenceConfigs.size > referenceEvidenceLimits.maxNodesPerComposition) throw new Error(`CUT composition exceeds the ${referenceEvidenceLimits.maxNodesPerComposition}-Evidence-node reference limit.`);
    if (this.seriesChartConfigs.size > 64) {
      const [nodeId] = this.seriesChartConfigs.keys(), node = nodeId ? this.ir.nodes[nodeId] : undefined;
      if (!node) throw new Error("Internal CUT SeriesChart composition budget has no source-located consumer.");
      throw new ReferenceSeriesChartError("CUT_SERIES_CHART_LIMIT", node, "composition exceeds the 64-SeriesChart-node reference limit");
    }
    if (lutSourceIds.size > referenceCubeLutLimits.maxCompositionTables) {
      const config = this.lutConfigs.values().next().value as ReferenceLutConfig | undefined, node = config ? this.ir.nodes[config.nodeId] : undefined;
      if (!node) throw new Error("Internal CUT LUT composition budget has no source-located consumer.");
      throw new ReferenceLutError("CUT_LUT_LIMIT", node, `composition references more than ${referenceCubeLutLimits.maxCompositionTables} distinct LUT tables.`);
    }
    let lutResourceBytes = 0;
    for (const sourceId of lutSourceIds) {
      const lutConfig = [...this.lutConfigs.values()].find((candidate) => candidate.sourceId === sourceId), lutNode = lutConfig ? this.ir.nodes[lutConfig.nodeId] : undefined;
      if (!lutNode) throw new Error(`Internal CUT LUT source ${sourceId} has no reachable consumer.`);
      const resource = this.ir.resources[sourceId], expectedBytes = resource?.metadata?.bytes;
      if (!resource || resource.kind !== "data" || typeof expectedBytes !== "number" || !Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > referenceCubeLutLimits.maxBytes) {
        throw new ReferenceLutError("CUT_LUT_LIMIT", lutNode, `locked .cube resource ${sourceId} is missing a safe byte count or exceeds ${referenceCubeLutLimits.maxBytes} bytes.`);
      }
      lutResourceBytes += expectedBytes;
      if (!Number.isSafeInteger(lutResourceBytes) || lutResourceBytes > referenceCubeLutLimits.maxCompositionBytes) {
        throw new ReferenceLutError("CUT_LUT_LIMIT", lutNode, `composition LUT bytes exceed ${referenceCubeLutLimits.maxCompositionBytes}.`);
      }
    }
    let captionResourceBytes = 0;
    let trackingResourceBytes = 0;
    for (const sourceId of track2DSourceIds) {
      const config = [...this.track2DConfigs.values()].find((candidate) => candidate.sourceId === sourceId), node = config ? this.ir.nodes[config.nodeId] : undefined;
      if (!node) throw new Error(`Internal CUT Track2D source ${sourceId} has no source-located consumer.`);
      const resource = this.ir.resources[sourceId], expectedBytes = resource?.metadata?.bytes;
      if (!resource || resource.kind !== "data" || typeof expectedBytes !== "number" || !Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > referenceTrack2DLimits.maxBytes) {
        throw new ReferenceTrack2DError("CUT_TRACK2D_LIMIT", node.id, node, `locked DataAsset ${sourceId} is missing a safe byte count or exceeds ${referenceTrack2DLimits.maxBytes} bytes.`);
      }
      trackingResourceBytes += expectedBytes;
      if (!Number.isSafeInteger(trackingResourceBytes) || trackingResourceBytes > referenceTrack2DLimits.maxCompositionBytes) {
        throw new ReferenceTrack2DError("CUT_TRACK2D_LIMIT", node.id, node, `composition tracking bytes exceed ${referenceTrack2DLimits.maxCompositionBytes}.`);
      }
    }
    let planarTrackingResourceBytes = 0;
    for (const sourceId of planarTrackSourceIds) {
      const config = [...this.planarTrackConfigs.values()].find((candidate) => candidate.sourceId === sourceId), node = config ? this.ir.nodes[config.nodeId] : undefined;
      if (!node) throw new Error(`Internal CUT PlanarTrack source ${sourceId} has no source-located consumer.`);
      const resource = this.ir.resources[sourceId], expectedBytes = resource?.metadata?.bytes;
      if (!resource || resource.kind !== "data" || resource.state !== "locked"
        || typeof expectedBytes !== "number" || !Number.isSafeInteger(expectedBytes)
        || expectedBytes < 1 || expectedBytes > referencePlanarTrackLimits.maxBytes) {
        throw new ReferencePlanarTrackError("CUT_PLANAR_TRACK_LIMIT", node.id, node, `locked DataAsset ${sourceId} is missing a safe byte count or exceeds ${referencePlanarTrackLimits.maxBytes} bytes.`);
      }
      planarTrackingResourceBytes += expectedBytes;
      if (!Number.isSafeInteger(planarTrackingResourceBytes) || planarTrackingResourceBytes > referencePlanarTrackLimits.maxCompositionBytes) {
        throw new ReferencePlanarTrackError("CUT_PLANAR_TRACK_LIMIT", node.id, node, `composition planar tracking bytes exceed ${referencePlanarTrackLimits.maxCompositionBytes}.`);
      }
    }
    for (const resourceId of new Set([...captionSourceIds, ...captionFontIds])) {
      const resource = this.ir.resources[resourceId], expectedBytes = resource?.metadata?.bytes;
      if (!resource || typeof expectedBytes !== "number" || !Number.isSafeInteger(expectedBytes) || expectedBytes < 0) throw new Error(`Locked caption resource ${resourceId} is missing a safe byte count.`);
      const perResourceLimit = resource.kind === "font" ? referenceCaptionLimits.maxFontBytes : referenceCaptionLimits.maxBytes;
      if (expectedBytes > perResourceLimit) throw new Error(`Locked caption resource ${resourceId} exceeds its ${perResourceLimit}-byte resource budget.`);
      captionResourceBytes += expectedBytes;
      if (!Number.isSafeInteger(captionResourceBytes) || captionResourceBytes > referenceCaptionLimits.maxSessionResourceBytes) throw new Error(`Locked caption resources exceed the ${referenceCaptionLimits.maxSessionResourceBytes}-byte composition budget.`);
    }
    let textResourceBytes = 0;
    for (const resourceId of new Set([...textFontIds, ...flowTextFontIds])) {
      const resource = this.ir.resources[resourceId], expectedBytes = resource?.metadata?.bytes;
      const flowConfig = [...this.flowTextConfigs.values()].find((candidate) => candidate.fontIds.includes(resourceId)), flowNode = flowConfig ? this.ir.nodes[flowConfig.nodeId] : undefined;
      if (!resource || resource.kind !== "font" || typeof expectedBytes !== "number" || !Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > referenceTextLimits.maxFontBytes) {
        if (flowNode) throw new ReferenceFlowTextError("CUT_FLOW_TEXT_RESOURCE", flowNode.id, flowNode, `locked FontAsset ${resourceId} is missing a safe byte count or exceeds the ${referenceTextLimits.maxFontBytes}-byte font budget.`);
        throw new Error(`Locked Text FontAsset ${resourceId} is missing a safe byte count or exceeds the ${referenceTextLimits.maxFontBytes}-byte font budget.`);
      }
      textResourceBytes += expectedBytes;
      if (!Number.isSafeInteger(textResourceBytes) || textResourceBytes > referenceTextLimits.maxSessionResourceBytes) {
        if (flowNode) throw new ReferenceFlowTextError("CUT_FLOW_TEXT_BUDGET", flowNode.id, flowNode, `combined locked Text/FlowText font resources exceed the ${referenceTextLimits.maxSessionResourceBytes}-byte composition budget.`);
        throw new Error(`Locked Text font resources exceed the ${referenceTextLimits.maxSessionResourceBytes}-byte composition budget.`);
      }
    }
    let evidenceResourceBytes = 0;
    for (const resourceId of new Set([...evidenceSourceIds, ...evidenceFontIds])) {
      const resource = this.ir.resources[resourceId], expectedBytes = resource?.metadata?.bytes;
      const maximum = resource?.kind === "font" ? referenceEvidenceLimits.maxFontBytes : referenceEvidenceLimits.maxResearchBytes;
      if (!resource || (resource.kind !== "font" && resource.kind !== "data") || typeof expectedBytes !== "number" || !Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > maximum) {
        throw new Error(`Locked Evidence resource ${resourceId} is missing a safe byte count or exceeds its ${maximum}-byte resource budget.`);
      }
      evidenceResourceBytes += expectedBytes;
      if (!Number.isSafeInteger(evidenceResourceBytes) || evidenceResourceBytes > referenceEvidenceLimits.maxSessionResourceBytes) throw new Error(`Locked Evidence resources exceed the ${referenceEvidenceLimits.maxSessionResourceBytes}-byte composition budget.`);
    }
    let geoResourceBytes = 0;
    for (const resourceId of geoFontIds) {
      const config = [...this.geoLabelConfigs.values()].find((candidate) => candidate.fontId === resourceId), node = config ? this.ir.nodes[config.nodeId] : undefined;
      if (!node) throw new Error(`Internal CUT geo FontAsset ${resourceId} has no reachable consumer.`);
      const resource = this.ir.resources[resourceId], expectedBytes = resource?.metadata?.bytes;
      if (!resource || resource.kind !== "font" || typeof expectedBytes !== "number" || !Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > referenceGeoLabelLimits.maxFontBytes) {
        referenceGeoLabelFailure(node, "CUT_GEO_FONT_RESOURCE", `locked FontAsset ${resourceId} is missing a safe byte count or exceeds the ${referenceGeoLabelLimits.maxFontBytes}-byte font budget.`);
      }
      geoResourceBytes += expectedBytes;
      if (!Number.isSafeInteger(geoResourceBytes) || geoResourceBytes > referenceGeoLabelLimits.maxSessionResourceBytes) referenceGeoLabelFailure(node, "CUT_GEO_FONT_BUDGET", `locked geo font resources exceed the ${referenceGeoLabelLimits.maxSessionResourceBytes}-byte composition budget.`);
    }
    let seriesChartResourceBytes = 0;
    for (const resourceId of seriesChartSourceIds) {
      const config = [...this.seriesChartConfigs.values()].find((candidate) => candidate.sourceIds.includes(resourceId)), node = config ? this.ir.nodes[config.nodeId] : undefined;
      if (!node) throw new Error(`Internal CUT SeriesChart DataAsset ${resourceId} has no reachable consumer.`);
      const resource = this.ir.resources[resourceId], expectedBytes = resource?.metadata?.bytes;
      if (!resource || resource.kind !== "data" || resource.state !== "locked" || resource.metadata?.lockVersion !== 2
        || typeof expectedBytes !== "number" || !Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > cutSeriesChartLimits.maxDataBytesPerSource) {
        throw new ReferenceSeriesChartError("CUT_SERIES_CHART_RESOURCE_STATE", node, `locked cut-table DataAsset ${resourceId} is missing cut.lock v2 state, a safe byte count, or exceeds ${cutSeriesChartLimits.maxDataBytesPerSource} bytes`);
      }
      seriesChartResourceBytes += expectedBytes;
      if (!Number.isSafeInteger(seriesChartResourceBytes) || seriesChartResourceBytes > 64 * 1024 * 1024) {
        throw new ReferenceSeriesChartError("CUT_SERIES_CHART_LIMIT", node, "composition SeriesChart table resources exceed the 64 MiB preparation budget");
      }
    }
    let seriesChartFontBytes = 0;
    for (const resourceId of seriesChartFontIds) {
      const config = [...this.seriesChartConfigs.values()].find((candidate) => candidate.fontId === resourceId), node = config ? this.ir.nodes[config.nodeId] : undefined;
      if (!node) throw new Error(`Internal CUT SeriesChart FontAsset ${resourceId} has no reachable consumer.`);
      const resource = this.ir.resources[resourceId], expectedBytes = resource?.metadata?.bytes;
      if (!resource || resource.kind !== "font" || resource.state !== "locked" || resource.metadata?.lockVersion !== 2
        || typeof expectedBytes !== "number" || !Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > cutSeriesChartLimits.maxFontBytes) {
        throw new ReferenceSeriesChartError("CUT_SERIES_CHART_RESOURCE_STATE", node, `locked FontAsset ${resourceId} is missing cut.lock v2 state, a safe byte count, or exceeds ${cutSeriesChartLimits.maxFontBytes} bytes`);
      }
      seriesChartFontBytes += expectedBytes;
      if (!Number.isSafeInteger(seriesChartFontBytes) || seriesChartFontBytes > 32 * 1024 * 1024) {
        throw new ReferenceSeriesChartError("CUT_SERIES_CHART_LIMIT", node, "composition SeriesChart fonts exceed the 32 MiB preparation budget");
      }
    }
    for (const sourceId of captionSourceIds) {
      const consumer = Object.values(this.ir.nodes).find((node) => this.reachableNodeIds.has(node.id) && node.op !== "cut.visual.captions" && Object.values(node.inputs).some((value) => referencesResource(value, sourceId)));
      if (consumer) throw new Error(`Locked DataAsset ${sourceId} is a caption byte stream and cannot also be consumed as JSON by ${consumer.op}. Declare two assets if the same file needs distinct format semantics.`);
    }
    for (const sourceId of transcriptCaptionSourceIds) {
      const consumer = Object.values(this.ir.nodes).find((node) =>
        this.reachableNodeIds.has(node.id)
        && Object.values(node.inputs).some((value) =>
          referencesResource(value, sourceId)));
      if (consumer) {
        throw new Error(`Locked DataAsset ${sourceId} is transcript ledger authority and cannot also be reinterpreted by ${consumer.op}. Declare a separate DataAsset for another format.`);
      }
    }
    const captionBytes = new Map<string, Buffer>(), evidenceBytes = new Map<string, Buffer>(), trackingBytes = new Map<string, Buffer>(), planarTrackingBytes = new Map<string, Buffer>(), seriesTableBytes = new Map<string, Buffer>(), resolvedBytes = new Map<string, number>();
    for (const resource of Object.values(this.ir.resources)) {
      const resolvedResource = this.verifiedResourcePath
        ? await (async () => {
          const path = this.verifiedResourcePath!(resource.id), metadata = await lstat(path);
          if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`Verified CUT resource ${resource.id} is not a direct regular file.`);
          return { path, bytes: metadata.size };
        })()
        : await resolveLockedProjectPath(this.projectRoot, resource.locator);
      const path = resolvedResource.path;
      this.paths.set(resource.id, path);
      resolvedBytes.set(resource.id, resolvedResource.bytes);
      if (resource.kind === "data") {
        const expectedBytes = resource.metadata?.bytes;
        if (captionSourceIds.has(resource.id) && (typeof expectedBytes !== "number" || !Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > referenceCaptionLimits.maxBytes)) {
          throw new Error(`Locked caption DataAsset ${resource.name} is missing a safe byte count or exceeds the ${referenceCaptionLimits.maxBytes}-byte caption budget.`);
        }
        if (resolvedResource.bytes > 16 * 1024 * 1024) throw new Error(`CUT reference data asset ${resource.name} exceeds the 16 MiB safety limit.`);
        if (lutSourceIds.has(resource.id)) {
          const config = [...this.lutConfigs.values()].find((candidate) => candidate.sourceId === resource.id), node = config ? this.ir.nodes[config.nodeId] : undefined;
          if (!node) throw new Error(`Internal CUT LUT resource ${resource.id} has no source-located consumer.`);
          const bytes = await readBoundedLockedBytes(path, expectedBytes as number, referenceCubeLutLimits.maxBytes, resource.sha256, `Locked LUT DataAsset ${resource.name}`);
          this.preparedLuts.set(resource.id, parseReferenceCubeLut(node, bytes));
        }
        else if (this.projectLutSourceIds.has(resource.id)) continue;
        else if (imageSequenceManifestIds.has(resource.id)) continue;
        else if (captionSourceIds.has(resource.id)) captionBytes.set(resource.id, await readBoundedLockedBytes(path, expectedBytes as number, referenceCaptionLimits.maxBytes, resource.sha256, `Locked caption DataAsset ${resource.name}`));
        else if (transcriptCaptionSourceIds.has(resource.id)) continue;
        else if (evidenceSourceIds.has(resource.id)) evidenceBytes.set(resource.id, await readBoundedLockedBytes(path, expectedBytes as number, referenceEvidenceLimits.maxResearchBytes, resource.sha256, `Locked Evidence DataAsset ${resource.name}`));
        else if (track2DSourceIds.has(resource.id)) {
          const config = [...this.track2DConfigs.values()].find((candidate) => candidate.sourceId === resource.id), node = config ? this.ir.nodes[config.nodeId] : undefined;
          if (!node) throw new Error(`Internal CUT Track2D resource ${resource.id} has no source-located consumer.`);
          try {
            trackingBytes.set(resource.id, await readBoundedLockedBytes(path, expectedBytes as number, referenceTrack2DLimits.maxBytes, resource.sha256, `Locked Track2D DataAsset ${resource.name}`));
          } catch (error) {
            throw new ReferenceTrack2DError("CUT_TRACK2D_RESOURCE", node.id, node, error instanceof Error ? error.message : String(error));
          }
        }
        else if (planarTrackSourceIds.has(resource.id)) {
          const config = [...this.planarTrackConfigs.values()].find((candidate) => candidate.sourceId === resource.id), node = config ? this.ir.nodes[config.nodeId] : undefined;
          if (!node) throw new Error(`Internal CUT PlanarTrack resource ${resource.id} has no source-located consumer.`);
          try {
            planarTrackingBytes.set(resource.id, await readBoundedLockedBytes(path, expectedBytes as number, referencePlanarTrackLimits.maxBytes, resource.sha256, `Locked PlanarTrack DataAsset ${resource.name}`));
          } catch (error) {
            throw new ReferencePlanarTrackError("CUT_PLANAR_TRACK_RESOURCE", node.id, node, error instanceof Error ? error.message : String(error));
          }
        }
        else if (seriesChartSourceIds.has(resource.id)) {
          const config = [...this.seriesChartConfigs.values()].find((candidate) => candidate.sourceIds.includes(resource.id)), node = config ? this.ir.nodes[config.nodeId] : undefined;
          if (!node) throw new Error(`Internal CUT SeriesChart resource ${resource.id} has no source-located consumer.`);
          try {
            seriesTableBytes.set(resource.id, await readBoundedLockedBytes(path, expectedBytes as number, cutSeriesChartLimits.maxDataBytesPerSource, resource.sha256, `Locked SeriesChart DataAsset ${resource.name}`));
          } catch (error) {
            throw new ReferenceSeriesChartError("CUT_SERIES_CHART_RESOURCE_INTEGRITY", node, error instanceof Error ? error.message : String(error));
          }
        }
        else if (!reachableInputResourceIds.has(resource.id)) continue;
        else {
          const bytes = await readFile(path);
          try { this.dataAssets.set(resource.id, JSON.parse(bytes.toString("utf8")) as unknown); }
          catch { throw new Error(`CUT data asset ${resource.name} is not valid JSON for its consuming reference kernel.`); }
        }
      }
    }
    for (const [nodeId, config] of this.imageSequenceConfigs) {
      const node = this.ir.nodes[nodeId], manifest = this.ir.resources[config.source.manifestResourceId];
      const path = this.paths.get(config.source.manifestResourceId), expectedBytes = manifest?.metadata?.bytes;
      if (!node || !manifest || manifest.kind !== "data" || !path
        || typeof expectedBytes !== "number" || !Number.isSafeInteger(expectedBytes)
        || expectedBytes < 1) {
        throw new Error(`Reference ImageSequence ${nodeId} cannot resolve its locked manifest DataAsset.`);
      }
      const bytes = await readBoundedLockedBytes(
        path,
        expectedBytes,
        1024 * 1024,
        manifest.sha256,
        `Locked ImageSequence manifest ${manifest.name}`,
      );
      this.preparedImageSequences.set(nodeId, prepareReferenceImageSequence(this.ir, node, config, bytes));
    }
    const fontBytes = new Map<string, Buffer>(), preparationCache = createReferenceCaptionPreparationCache();
    for (const [nodeId, config] of this.track2DConfigs) {
      const node = this.ir.nodes[nodeId], bytes = trackingBytes.get(config.sourceId);
      if (!node || !bytes) throw new Error(`Reference Track2D ${nodeId} cannot resolve its locked DataAsset.`);
      this.preparedTrack2D.set(nodeId, prepareReferenceTrack2D(node, config, this.composition, bytes));
    }
    let planarTrackingSamples = 0;
    for (const [nodeId, config] of this.planarTrackConfigs) {
      const node = this.ir.nodes[nodeId], bytes = planarTrackingBytes.get(config.sourceId);
      if (!node || !bytes) throw new Error(`Reference PlanarTrack ${nodeId} cannot resolve its locked DataAsset.`);
      const prepared = prepareReferencePlanarTrack(this.ir, node, config, this.composition, bytes);
      planarTrackingSamples += prepared.samples.length;
      if (!Number.isSafeInteger(planarTrackingSamples) || planarTrackingSamples > referencePlanarTrackLimits.maxSamplesPerComposition) {
        throw new ReferencePlanarTrackError("CUT_PLANAR_TRACK_LIMIT", node.id, node, `composition planar-track observations exceed ${referencePlanarTrackLimits.maxSamplesPerComposition}.`);
      }
      this.preparedPlanarTracks.set(nodeId, prepared);
    }
    let captionOutlineCommands = 0, captionOutlineBytes = 0;
    const lockedCaptionFont = async (
      config: ReferenceCaptionAppearanceConfig,
    ) => {
      const fontPath = this.paths.get(config.fontId);
      const fontResource = this.ir.resources[config.fontId];
      if (!fontPath || !fontResource || fontResource.kind !== "font") {
        throw new Error(`Reference captions ${config.nodeId} cannot resolve locked FontAsset ${config.fontId}.`);
      }
      let bytes = fontBytes.get(config.fontId);
      if (!bytes) {
        const expectedBytes = fontResource.metadata?.bytes;
        const actualBytes = resolvedBytes.get(config.fontId);
        if (typeof expectedBytes !== "number"
          || !Number.isSafeInteger(expectedBytes)
          || expectedBytes < 0
          || expectedBytes > referenceCaptionLimits.maxFontBytes) {
          throw new Error(`Locked caption FontAsset ${config.fontId} is missing a safe byte count or exceeds the ${referenceCaptionLimits.maxFontBytes}-byte font budget.`);
        }
        if (actualBytes !== expectedBytes) {
          throw new Error(`Locked caption FontAsset ${config.fontId} byte count changed before preparation.`);
        }
        bytes = await readBoundedLockedBytes(
          fontPath,
          expectedBytes,
          referenceCaptionLimits.maxFontBytes,
          fontResource.sha256,
          `Locked caption FontAsset ${config.fontId}`,
        );
        fontBytes.set(config.fontId, bytes);
      }
      return { bytes, locator: fontResource.locator };
    };
    const registerPreparedCaptions = (
      nodeId: string,
      prepared: PreparedReferenceCaptions,
    ) => {
      captionOutlineCommands += prepared.outlineCommands;
      captionOutlineBytes += prepared.outlineBytes;
      if (!Number.isSafeInteger(captionOutlineCommands)
        || captionOutlineCommands > referenceCaptionLimits.maxSessionOutlineCommands) {
        throw new Error(`Locked caption outlines exceed the ${referenceCaptionLimits.maxSessionOutlineCommands}-command composition budget.`);
      }
      if (!Number.isSafeInteger(captionOutlineBytes)
        || captionOutlineBytes > referenceCaptionLimits.maxSessionOutlineBytes) {
        throw new Error(`Locked caption outlines exceed the ${referenceCaptionLimits.maxSessionOutlineBytes}-byte composition budget.`);
      }
      this.preparedCaptions.set(nodeId, prepared);
    };
    for (const [nodeId, config] of this.captionConfigs) {
      const node = this.ir.nodes[nodeId];
      const source = captionBytes.get(config.sourceId);
      if (!node || !source) {
        throw new Error(`Reference captions ${nodeId} cannot resolve its locked caption source.`);
      }
      const font = await lockedCaptionFont(config);
      registerPreparedCaptions(
        nodeId,
        prepareReferenceCaptions(
          node,
          config,
          source,
          font.locator,
          font.bytes,
          preparationCache,
        ),
      );
    }
    for (const [nodeId, config] of this.transcriptCaptionConfigs) {
      const node = this.ir.nodes[nodeId];
      if (!node) {
        throw new Error(`Reference transcript captions ${nodeId} lost its reachable node.`);
      }
      const font = await lockedCaptionFont(config);
      registerPreparedCaptions(
        nodeId,
        prepareReferenceCaptionTrack(
          node,
          config,
          config.track,
          font.locator,
          font.bytes,
          preparationCache,
        ),
      );
    }
    let textOutlineCommands = 0, textOutlineBytes = 0;
    const parsedTextFonts = new Map<string, LockedOpenTypeFont>();
    for (const [nodeId, config] of this.seriesChartConfigs) {
      const node = this.ir.nodes[nodeId], fontPath = this.paths.get(config.fontId), fontResource = this.ir.resources[config.fontId];
      if (!node || !fontPath || !fontResource) throw new Error(`Reference SeriesChart ${nodeId} cannot resolve its locked FontAsset.`);
      let lockedFont = fontBytes.get(config.fontId);
      try {
        if (!lockedFont) {
          const expectedBytes = fontResource.metadata?.bytes, actualBytes = resolvedBytes.get(config.fontId);
          if (typeof expectedBytes !== "number" || !Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > cutSeriesChartLimits.maxFontBytes) {
            throw new ReferenceSeriesChartError("CUT_SERIES_CHART_RESOURCE_STATE", node, `locked FontAsset ${config.fontId} is missing a safe byte count or exceeds ${cutSeriesChartLimits.maxFontBytes} bytes`);
          }
          if (actualBytes !== expectedBytes) throw new ReferenceSeriesChartError("CUT_SERIES_CHART_RESOURCE_INTEGRITY", node, `locked FontAsset ${config.fontId} byte count changed before preparation`);
          lockedFont = await readBoundedLockedBytes(fontPath, expectedBytes, cutSeriesChartLimits.maxFontBytes, fontResource.sha256, `Locked SeriesChart FontAsset ${fontResource.name}`);
          fontBytes.set(config.fontId, lockedFont);
        }
        let parsedFont = parsedTextFonts.get(config.fontId);
        if (!parsedFont) {
          parsedFont = parseLockedOpenTypeFont(lockedFont, fontResource.locator, { maxBytes: cutSeriesChartLimits.maxFontBytes, maxGlyphs: cutSeriesChartLimits.maxFontGlyphs });
          parsedTextFonts.set(config.fontId, parsedFont);
        }
        const resources: CutLockedTableInput[] = config.sourceIds.map((resourceId) => {
          const resource = this.ir.resources[resourceId], bytes = seriesTableBytes.get(resourceId), expectedBytes = resource?.metadata?.bytes;
          if (!resource || resource.kind !== "data" || resource.state !== "locked" || resource.metadata?.lockVersion !== 2 || !resource.sha256
            || typeof expectedBytes !== "number" || !bytes) {
            throw new ReferenceSeriesChartError("CUT_SERIES_CHART_RESOURCE_STATE", node, `query source ${resourceId} did not resolve as locked cut-table bytes`);
          }
          return Object.freeze({
            resource: Object.freeze({ id: resource.id, kind: "data" as const, state: "locked" as const, lockVersion: 2 as const, sha256: resource.sha256, bytes: expectedBytes }),
            bytes,
          });
        });
        const style = cutSeriesChartStyleFromAdapter(Object.freeze({
          series: config.series.map(({ field, color }) => Object.freeze({ field, color })),
          kind: config.kind,
          labelSize: config.labelSize,
          axisColor: config.axisColor,
          gridColor: config.gridColor,
          background: config.background,
          strokeWidth: config.strokeWidth,
          pointRadius: config.pointRadius,
          showLegend: config.showLegend,
        }), { width: this.composition.width, height: this.composition.height });
        this.preparedSeriesCharts.set(nodeId, prepareReferenceSeriesChart(
          config.query,
          resources,
          config.layout,
          Object.freeze({ kind: "parsed" as const, resourceId: config.fontId, font: parsedFont }),
          style,
        ));
      } catch (error) {
        if (error instanceof ReferenceSeriesChartError) throw error;
        if (error instanceof CutSeriesChartError) throw new ReferenceSeriesChartError(error.code, node, error.message);
        throw new ReferenceSeriesChartError("CUT_SERIES_CHART_RESOURCE_INTEGRITY", node, error instanceof Error ? error.message : String(error));
      }
    }
    for (const [nodeId, config] of this.textConfigs) {
      const node = this.ir.nodes[nodeId], fontPath = this.paths.get(config.fontId), resource = this.ir.resources[config.fontId];
      if (!node || !fontPath || !resource) throw new Error(`Reference Text ${nodeId} cannot resolve its locked FontAsset.`);
      let lockedFont = fontBytes.get(config.fontId);
      if (!lockedFont) {
        const expectedBytes = resource.metadata?.bytes, actualBytes = resolvedBytes.get(config.fontId);
        if (typeof expectedBytes !== "number" || !Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > referenceTextLimits.maxFontBytes) {
          throw new Error(`Locked Text FontAsset ${config.fontId} is missing a safe byte count or exceeds the ${referenceTextLimits.maxFontBytes}-byte font budget.`);
        }
        if (actualBytes !== expectedBytes) throw new Error(`Locked Text FontAsset ${config.fontId} byte count changed before preparation.`);
        lockedFont = await readBoundedLockedBytes(fontPath, expectedBytes, referenceTextLimits.maxFontBytes, resource.sha256, `Locked Text FontAsset ${resource.name}`);
        fontBytes.set(config.fontId, lockedFont);
      }
      let parsedFont = parsedTextFonts.get(config.fontId);
      if (!parsedFont) {
        try { parsedFont = parseLockedOpenTypeFont(lockedFont, resource.locator, { maxBytes: referenceTextLimits.maxFontBytes, maxGlyphs: referenceTextLimits.maxFontGlyphs }); }
        catch (error) { textFailure(node, error instanceof Error ? error.message : String(error)); }
        parsedTextFonts.set(config.fontId, parsedFont);
      }
      const prepared = prepareReferenceText(node, config, parsedFont);
      textOutlineCommands += prepared.outlineCommands;
      textOutlineBytes += prepared.outlineBytes;
      if (!Number.isSafeInteger(textOutlineCommands) || textOutlineCommands > referenceTextLimits.maxSessionOutlineCommands) {
        throw new Error(`Locked Text outlines exceed the ${referenceTextLimits.maxSessionOutlineCommands}-command composition budget.`);
      }
      if (!Number.isSafeInteger(textOutlineBytes) || textOutlineBytes > referenceTextLimits.maxSessionOutlineBytes) {
        throw new Error(`Locked Text outlines exceed the ${referenceTextLimits.maxSessionOutlineBytes}-byte composition budget.`);
      }
      this.preparedTexts.set(nodeId, prepared);
    }
    for (const [nodeId, config] of this.flowTextConfigs) {
      const node = this.ir.nodes[nodeId];
      if (!node) throw new Error(`Internal CUT FlowText ${nodeId} has no source-located node.`);
      const preparedFonts = new Map<string, LockedOpenTypeFont>();
      for (const fontId of config.fontIds) {
        const fontPath = this.paths.get(fontId), resource = this.ir.resources[fontId];
        if (!fontPath || !resource) throw new ReferenceFlowTextError("CUT_FLOW_TEXT_RESOURCE", node.id, node, `cannot resolve locked FontAsset ${fontId}.`);
        let lockedFont = fontBytes.get(fontId);
        if (!lockedFont) {
          const expectedBytes = resource.metadata?.bytes, actualBytes = resolvedBytes.get(fontId);
          if (typeof expectedBytes !== "number" || !Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > referenceTextLimits.maxFontBytes) {
            throw new ReferenceFlowTextError("CUT_FLOW_TEXT_RESOURCE", node.id, node, `locked FontAsset ${fontId} is missing a safe byte count or exceeds the ${referenceTextLimits.maxFontBytes}-byte font budget.`);
          }
          if (actualBytes !== expectedBytes) throw new ReferenceFlowTextError("CUT_FLOW_TEXT_RESOURCE", node.id, node, `locked FontAsset ${fontId} byte count changed before preparation.`);
          try { lockedFont = await readBoundedLockedBytes(fontPath, expectedBytes, referenceTextLimits.maxFontBytes, resource.sha256, `Locked FlowText FontAsset ${resource.name}`); }
          catch (error) { throw new ReferenceFlowTextError("CUT_FLOW_TEXT_RESOURCE", node.id, node, error instanceof Error ? error.message : String(error)); }
          fontBytes.set(fontId, lockedFont);
        }
        let parsedFont = parsedTextFonts.get(fontId);
        if (!parsedFont) {
          try { parsedFont = parseLockedOpenTypeFont(lockedFont, resource.locator, { maxBytes: referenceTextLimits.maxFontBytes, maxGlyphs: referenceTextLimits.maxFontGlyphs }); }
          catch (error) { throw new ReferenceFlowTextError("CUT_FLOW_TEXT_SHAPING", node.id, node, error instanceof Error ? error.message : String(error)); }
          parsedTextFonts.set(fontId, parsedFont);
        }
        preparedFonts.set(fontId, parsedFont);
      }
      const localContext = this.localSpaceDescendantContexts.get(node.id) ?? this.responsiveDescendantContexts.get(node.id);
      const prepared = config.shaping
        ? await prepareReferenceComplexFlowText(
            node,
            config,
            preparedFonts,
            new Map(config.fontIds.map((fontId) => {
              const locked = fontBytes.get(fontId);
              if (!locked) throw new ReferenceFlowTextError("CUT_FLOW_TEXT_RESOURCE", node.id, node, `locked FontAsset ${fontId} bytes were not retained for complex shaping.`);
              return [fontId, locked] as const;
            })),
            localContext ? this.localComposition(localContext) : this.composition,
          )
        : prepareReferenceFlowText(node, config, preparedFonts, localContext ? this.localComposition(localContext) : this.composition);
      textOutlineCommands += prepared.outlineCommands;
      textOutlineBytes += prepared.outlineBytes;
      if (!Number.isSafeInteger(textOutlineCommands) || textOutlineCommands > referenceTextLimits.maxSessionOutlineCommands) {
        throw new ReferenceFlowTextError("CUT_FLOW_TEXT_BUDGET", node.id, node, `combined locked Text/FlowText outlines exceed the ${referenceTextLimits.maxSessionOutlineCommands}-command composition budget.`);
      }
      if (!Number.isSafeInteger(textOutlineBytes) || textOutlineBytes > referenceTextLimits.maxSessionOutlineBytes) {
        throw new ReferenceFlowTextError("CUT_FLOW_TEXT_BUDGET", node.id, node, `combined locked Text/FlowText outlines exceed the ${referenceTextLimits.maxSessionOutlineBytes}-byte composition budget.`);
      }
      this.preparedFlowTexts.set(nodeId, prepared);
    }
    let evidenceOutlineCommands = 0, evidenceOutlineBytes = 0;
    for (const [nodeId, config] of this.evidenceConfigs) {
      const node = this.ir.nodes[nodeId], researchBytes = evidenceBytes.get(config.sourceId), fontPath = this.paths.get(config.fontId), resource = this.ir.resources[config.fontId];
      if (!node || !researchBytes || !fontPath || !resource) throw new Error(`Reference Evidence ${nodeId} cannot resolve its locked research/font resources.`);
      let lockedFont = fontBytes.get(config.fontId);
      if (!lockedFont) {
        const expectedBytes = resource.metadata?.bytes, actualBytes = resolvedBytes.get(config.fontId);
        if (typeof expectedBytes !== "number" || !Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > referenceEvidenceLimits.maxFontBytes) {
          throw new Error(`Locked Evidence FontAsset ${config.fontId} is missing a safe byte count or exceeds the ${referenceEvidenceLimits.maxFontBytes}-byte font budget.`);
        }
        if (actualBytes !== expectedBytes) throw new Error(`Locked Evidence FontAsset ${config.fontId} byte count changed before preparation.`);
        lockedFont = await readBoundedLockedBytes(fontPath, expectedBytes, referenceEvidenceLimits.maxFontBytes, resource.sha256, `Locked Evidence FontAsset ${resource.name}`);
        fontBytes.set(config.fontId, lockedFont);
      }
      let parsedFont = parsedTextFonts.get(config.fontId);
      if (!parsedFont) {
        try { parsedFont = parseLockedOpenTypeFont(lockedFont, resource.locator, { maxBytes: referenceEvidenceLimits.maxFontBytes, maxGlyphs: referenceEvidenceLimits.maxFontGlyphs }); }
        catch (error) { throw new Error(`Evidence at ${node.provenance.module}:${node.provenance.span.start.line}:${node.provenance.span.start.column} ${error instanceof Error ? error.message : String(error)}`); }
        parsedTextFonts.set(config.fontId, parsedFont);
      }
      const prepared = prepareReferenceEvidence(node, config, researchBytes, parsedFont);
      evidenceOutlineCommands += prepared.outlineCommands; evidenceOutlineBytes += prepared.outlineBytes;
      if (!Number.isSafeInteger(evidenceOutlineCommands) || evidenceOutlineCommands > referenceEvidenceLimits.maxSessionOutlineCommands) throw new Error(`Locked Evidence outlines exceed the ${referenceEvidenceLimits.maxSessionOutlineCommands}-command composition budget.`);
      if (!Number.isSafeInteger(evidenceOutlineBytes) || evidenceOutlineBytes > referenceEvidenceLimits.maxSessionOutlineBytes) throw new Error(`Locked Evidence outlines exceed the ${referenceEvidenceLimits.maxSessionOutlineBytes}-byte composition budget.`);
      this.preparedEvidence.set(nodeId, prepared);
      this.dataAssets.set(config.sourceId, prepared.pack);
    }
    let geoOutlineCommands = 0, geoOutlineBytes = 0;
    for (const [nodeId, config] of this.geoLabelConfigs) {
      const node = this.ir.nodes[nodeId];
      if (!node) throw new Error(`Internal CUT geo-label node ${nodeId} is missing.`);
      const pointInput = config.kind === "map" ? node.inputs.points : config.kind === "marker" ? node.inputs.point : node.inputs.target;
      const candidates = referenceGeoLabelCandidates(node, this.geoPoints(pointInput));
      if (!candidates.length || !config.fontId) {
        this.preparedGeoLabels.set(nodeId, prepareReferenceGeoLabels(node, config, candidates, undefined));
        continue;
      }
      const resource = this.ir.resources[config.fontId], fontPath = this.paths.get(config.fontId);
      if (!resource || resource.kind !== "font" || !fontPath) referenceGeoLabelFailure(node, "CUT_GEO_FONT_RESOURCE", `cannot resolve locked FontAsset ${config.fontId}.`);
      let lockedFont = fontBytes.get(config.fontId);
      if (!lockedFont) {
        const expectedBytes = resource.metadata?.bytes, actualBytes = resolvedBytes.get(config.fontId);
        if (typeof expectedBytes !== "number" || !Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > referenceGeoLabelLimits.maxFontBytes) {
          referenceGeoLabelFailure(node, "CUT_GEO_FONT_RESOURCE", `locked FontAsset ${config.fontId} is missing a safe byte count or exceeds the ${referenceGeoLabelLimits.maxFontBytes}-byte font budget.`);
        }
        if (actualBytes !== expectedBytes) referenceGeoLabelFailure(node, "CUT_GEO_FONT_RESOURCE", `locked FontAsset ${config.fontId} byte count changed before preparation.`);
        try {
          lockedFont = await readBoundedLockedBytes(fontPath, expectedBytes, referenceGeoLabelLimits.maxFontBytes, resource.sha256, `Locked geo FontAsset ${resource.name}`);
        } catch (error) {
          referenceGeoLabelFailure(node, "CUT_GEO_FONT_RESOURCE", error instanceof Error ? error.message : String(error));
        }
        fontBytes.set(config.fontId, lockedFont);
      }
      let parsedFont = parsedTextFonts.get(config.fontId);
      if (!parsedFont) {
        parsedFont = parseReferenceGeoLabelFont(node, lockedFont, resource.locator);
        parsedTextFonts.set(config.fontId, parsedFont);
      }
      const prepared = prepareReferenceGeoLabels(node, config, candidates, parsedFont);
      geoOutlineCommands += prepared.outlineCommands; geoOutlineBytes += prepared.outlineBytes;
      if (!Number.isSafeInteger(geoOutlineCommands) || geoOutlineCommands > referenceGeoLabelLimits.maxSessionOutlineCommands) referenceGeoLabelFailure(node, "CUT_GEO_FONT_BUDGET", `locked geo label outlines exceed the ${referenceGeoLabelLimits.maxSessionOutlineCommands}-command composition budget.`);
      if (!Number.isSafeInteger(geoOutlineBytes) || geoOutlineBytes > referenceGeoLabelLimits.maxSessionOutlineBytes) referenceGeoLabelFailure(node, "CUT_GEO_FONT_BUDGET", `locked geo label outlines exceed the ${referenceGeoLabelLimits.maxSessionOutlineBytes}-byte composition budget.`);
      this.preparedGeoLabels.set(nodeId, prepared);
    }
    await this.cacheDirectory();
    this.audioReactivePreparationEvidence = await prepareReferenceAudioReactiveSignals({
      ir: this.ir,
      composition: this.composition,
      reachableNodeIds: this.reachableNodeIds,
      verifiedResourcePath: this.verifiedResourcePath,
      cacheDirectoryForKey: (key) => this.cacheDirectory("audio-reactive", key),
      resolver: this.preparedSignalResolver,
    });
    this.prepareDiagramLayoutPlans();
    this.preparePlanarTrackOpacityProperties();
    if (this.rendererTreeContext.nestedCompositionPreparation === "eager") {
      for (const [nodeId, config] of this.precompConfigs) {
        await this.preparedPrecompRenderer(nodeId, config);
      }
    }
  }

  private async evidence(node: IRNode) {
    const prepared = this.preparedEvidence.get(node.id);
    if (!prepared) throw new Error(`Reference Evidence ${node.id} was not prepared from locked resources.`);
    const cached = this.evidenceSurfaces.get(node.id);
    if (cached) { this.evidenceSurfaces.delete(node.id); this.evidenceSurfaces.set(node.id, cached); return cached; }
    const surface = await svgSurface(referenceEvidenceSvg(prepared), this.composition.width, this.composition.height);
    this.evidenceSurfaces.set(node.id, surface); this.evidenceSurfaceBytes += surface.data.byteLength;
    while (this.evidenceSurfaceBytes > this.rendererTreeContext.surfaceCacheByteLimit && this.evidenceSurfaces.size > 1) {
      const oldestKey = this.evidenceSurfaces.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      const oldest = this.evidenceSurfaces.get(oldestKey); this.evidenceSurfaces.delete(oldestKey);
      if (oldest) this.evidenceSurfaceBytes -= oldest.data.byteLength;
    }
    return surface;
  }

  private async captions(node: IRNode, local: Rational) {
    const prepared = this.preparedCaptions.get(node.id);
    if (!prepared) throw new Error(`Reference captions ${node.id} was not prepared from locked resources.`);
    const cue = referenceCaptionCueAt(prepared.track, local);
    if (!cue) return transparent(this.composition.width, this.composition.height);
    const key = `${node.id}\0${cue.id}`, cached = this.captionSurfaces.get(key);
    if (cached) { this.captionSurfaces.delete(key); this.captionSurfaces.set(key, cached); return cached; }
    const surface = await svgSurface(referenceCaptionSvg(prepared, cue, this.composition.width, this.composition.height), this.composition.width, this.composition.height);
    this.captionSurfaces.set(key, surface);
    this.captionSurfaceBytes += surface.data.byteLength;
    while (this.captionSurfaceBytes > this.rendererTreeContext.surfaceCacheByteLimit && this.captionSurfaces.size > 1) {
      const oldestKey = this.captionSurfaces.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      const oldest = this.captionSurfaces.get(oldestKey); this.captionSurfaces.delete(oldestKey);
      if (oldest) this.captionSurfaceBytes -= oldest.data.byteLength;
    }
    return surface;
  }

  private async decoder(node: IRNode) {
    const existing = this.decoders.get(node.id); if (existing) return existing;
    const source = node.inputs.source; if (source?.kind !== "resource-ref") throw new Error(`${node.op} needs a locked resource-ref source.`);
    const path = this.paths.get(source.id); if (!path) throw new Error(`Missing locked path for ${source.id}.`);
    const video = node.op === "cut.visual.video" ? this.videoConfigs.get(node.id) : undefined;
    const pictureTimeMap = node.op === "cut.edit.picture_clip" ? this.pictureTimeMapConfigs.get(node.id) : undefined;
    const inputColor = this.videoInputColorConfigs.get(node.id);
    if (node.op === "cut.visual.video" && !video) throw new Error(`Reference Video ${node.id} has no validated runtime configuration.`);
    if (node.op === "cut.edit.picture_clip" && !pictureTimeMap) throw new Error(`Reference PictureClip ${node.id} has no validated time-map configuration.`);
    if (["cut.visual.video", "cut.edit.clip", "cut.edit.picture_clip"].includes(node.op) && !inputColor) throw new Error(`Reference video consumer ${node.id} has no validated input-color configuration.`);
    const lockedSelection = lockedVideoSelection(this.ir, source.id);
    const streamIndex = video?.streamIndex ?? pictureTimeMap?.streamIndex ?? lockedSelection.streamIndex;
    if (inputColor && inputColor.streamIndex !== streamIndex) throw new Error(`Reference video consumer ${node.id} input-color stream disagrees with its decoder stream.`);
    const range = node.inputs.range;
    const rangeStart = range?.kind === "range" && range.start.kind === "quantity" ? range.start.magnitude : zeroRational;
    const rangeEnd = range?.kind === "range" && range.end.kind === "quantity" ? range.end.magnitude : undefined;
    const relativeStart = video ? video.sourceStart : pictureTimeMap ? pictureTimeMap.decodeStart : rangeStart;
    const sourceDurationExact = video ? video.sourceDuration : pictureTimeMap ? pictureTimeMap.decodeDuration : rangeEnd ? subtractRational(rangeEnd, rangeStart) : node.interval.duration;
    const loop = video?.loop ?? booleanValue(node.inputs.loop), durationExact = video ? video.decodeDuration : loop ? node.interval.duration : sourceDurationExact;
    if (compareRational(sourceDurationExact, zeroRational) <= 0 || compareRational(durationExact, zeroRational) <= 0) throw new Error(`${node.op} has a non-positive source range.`);
    const sourceFrameRate = video?.selectedFrameRate ?? pictureTimeMap?.selectedFrameRate ?? lockedSelection.frameRate;
    const cadence = video?.decodedVideoCadence ?? (pictureTimeMap ? lockedSelection.decodedVideoCadence : undefined) ?? lockedSelection.decodedVideoCadence;
    const usesSourceWindow = node.op !== "cut.visual.video" || video?.sourceStart.numerator !== "0" || compareRational(video.sourceEnd, video.selectedDuration) !== 0 || loop;
    if (usesSourceWindow && !cadence) throw new Error(`${node.op} source-window decoding requires a locked decoded-video-cadence witness.`);
    const sourceStartFrame = cadence ? exactDecodedFrameIndex(relativeStart, sourceFrameRate, `${node.op} source-range start`) : undefined;
    const sourceEndFrame = cadence ? exactDecodedFrameIndex(addRational(relativeStart, sourceDurationExact), sourceFrameRate, `${node.op} source-range end`) : undefined;
    if (sourceStartFrame !== undefined && sourceEndFrame! <= sourceStartFrame) throw new Error(`${node.op} source range contains no selected-stream frames.`);
    const decodeFrameRate = pictureTimeMap?.selectedFrameRate ?? this.composition.fps;
    const fps = `${decodeFrameRate.numerator}/${decodeFrameRate.denominator}`, fit = video?.fit ?? stringValue(node.inputs.fit, "cover");
    const decoderColor = referenceVideoDecoderColorPlan(inputColor?.inputColor ?? "legacy");
    const managedYuv = decoderColor.managedYuv, scaleColor = decoderColor.scaleSuffix;
    const normalizedCrop = video?.crop;
    const crop = video && normalizedCrop
      ? referenceRetainedMediaCropPixels({ width: video.nativeWidth, height: video.nativeHeight }, normalizedCrop)
      : undefined;
    const cropFilter = crop ? `crop=${crop.width}:${crop.height}:${crop.left}:${crop.top}:exact=1,` : "";
    const scale = fit === "contain"
      ? `scale=${this.composition.width}:${this.composition.height}:force_original_aspect_ratio=decrease:flags=bicubic${scaleColor},pad=${this.composition.width}:${this.composition.height}:(ow-iw)/2:(oh-ih)/2:color=black@0`
      : fit === "fill"
        ? `scale=${this.composition.width}:${this.composition.height}:flags=bicubic${scaleColor}`
        : `scale=${this.composition.width}:${this.composition.height}:force_original_aspect_ratio=increase:flags=bicubic${scaleColor},crop=${this.composition.width}:${this.composition.height}`;
    // Omitted inputColor retains the exact historical filter order. Managed
    // Rec.709 expands its locked YUV matrix/range before RGBA conversion.
    const resize = managedYuv ? `${scale},format=rgba` : `format=rgba,${scale}`;
    const input = ["-v", "error", ...(loop ? ["-stream_loop", "-1"] : []), "-i", path, "-map", `0:${streamIndex}`];
    const trim = cadence ? `trim=start_frame=${sourceStartFrame}${loop ? "" : `:end_frame=${sourceEndFrame}`},` : "";
    const sourceFps = `${sourceFrameRate.numerator}/${sourceFrameRate.denominator}`;
    // Frame-indexed consumers require a rebuilt CFR clock. A plain untrimmed
    // Video is the sole path that may preserve decoded VFR spacing before the
    // delivery-fps policy samples it.
    const resetPts = cadence ? `setpts=N/(${sourceFps}*TB)` : "setpts=PTS-STARTPTS";
    const filter = `${trim}${pictureTimeMap?.reverseDecode ? `reverse,${resetPts}` : resetPts},fps=fps=${fps}:start_time=0:round=near:eof_action=pass,${cropFilter}${resize}`;
    const frameCount = pictureTimeMap?.sourceFrameCount ?? boundedOutputFrameCount(durationExact, decodeFrameRate, `${node.op} decoded output`);
    const reader = new RawVideoReader([...input, "-vf", filter, "-an", "-frames:v", String(frameCount), "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], this.composition.width * this.composition.height * 4);
    const decoder: Decoder = {
      reader,
      lastFrame: -1,
      frameCache: new Map(),
      inputColor: inputColor?.inputColor ?? "legacy",
      evidence: Object.freeze({
        nodeId: node.id,
        streamIndex,
        mode: cadence ? "decoded-cfr-frame-index" : "untrimmed-source-pts",
        frameLimit: frameCount,
        sourceStartFrame,
        sourceEndFrame: loop ? undefined : sourceEndFrame,
        loop,
        outputFps: decodeFrameRate,
        semanticSeek: false,
        ...(pictureTimeMap ? {
          frameSelection: pictureTimeMap.map.frameSelection ?? "floor",
          ...(pictureTimeMap.frameBlendPolicyIdentity
            ? { frameBlendPolicyIdentity: pictureTimeMap.frameBlendPolicyIdentity }
            : {}),
        } : {}),
      }),
    };
    this.decoders.set(node.id, decoder); return decoder;
  }

  private async retainedMediaDecoder(node: IRNode, plan: ReferenceRetainedMediaViewportPlan) {
    const existing = this.retainedMediaDecoders.get(node.id); if (existing) return existing;
    const source = node.inputs.source;
    if (source?.kind !== "resource-ref" || source.id !== plan.sourceId) throw new ReferenceRetainedMediaViewportError("CUT_RETAINED_MEDIA_VIEWPORT_GRAPH", node, "runtime plan lost its locked source binding.");
    const video = this.videoConfigs.get(node.id), inputColor = this.videoInputColorConfigs.get(node.id);
    if (!video || !inputColor) throw new ReferenceRetainedMediaViewportError("CUT_RETAINED_MEDIA_VIEWPORT_GRAPH", node, "has no validated Video/color configuration.");
    const plannedInput = referenceVideoInputConfig(this.ir, node);
    if (!plannedInput || !plan.videoExecution
      || plan.videoExecution.streamIndex !== plannedInput.streamIndex
      || plan.videoExecution.configIdentity !== hash(plannedInput)) {
      throw new ReferenceRetainedMediaViewportError("CUT_RETAINED_MEDIA_VIEWPORT_GRAPH", node, "runtime Video stream/cadence/color/input configuration disagrees with its admitted retained-media plan.");
    }
    const path = this.paths.get(source.id); if (!path) throw new ReferenceRetainedMediaViewportError("CUT_RETAINED_MEDIA_VIEWPORT_RESOURCE", node, `cannot resolve verified source ${source.id}.`);
    if (video.nativeWidth !== plan.native.width || video.nativeHeight !== plan.native.height
      || video.fit !== plan.fit || video.streamIndex !== plan.videoExecution.streamIndex) {
      throw new ReferenceRetainedMediaViewportError("CUT_RETAINED_MEDIA_VIEWPORT_GRAPH", node, "runtime Video config disagrees with its admitted native/fit/stream plan.");
    }
    const relativeStart = video.sourceStart, sourceDurationExact = video.sourceDuration, durationExact = video.decodeDuration;
    const sourceFrameRate = video.selectedFrameRate, cadence = video.decodedVideoCadence;
    const usesSourceWindow = video.sourceStart.numerator !== "0" || compareRational(video.sourceEnd, video.selectedDuration) !== 0 || video.loop;
    if (usesSourceWindow && !cadence) throw new ReferenceRetainedMediaViewportError("CUT_RETAINED_MEDIA_VIEWPORT_RESOURCE", node, "source-window decoding requires a locked decoded-video-cadence witness.");
    const sourceStartFrame = cadence ? exactDecodedFrameIndex(relativeStart, sourceFrameRate, `${node.op} retained source-range start`) : undefined;
    const sourceEndFrame = cadence ? exactDecodedFrameIndex(addRational(relativeStart, sourceDurationExact), sourceFrameRate, `${node.op} retained source-range end`) : undefined;
    if (sourceStartFrame !== undefined && sourceEndFrame! <= sourceStartFrame) throw new ReferenceRetainedMediaViewportError("CUT_RETAINED_MEDIA_VIEWPORT_RESOURCE", node, "source range contains no selected-stream frames.");
    const decodeFrameRate = this.composition.fps, fps = `${decodeFrameRate.numerator}/${decodeFrameRate.denominator}`;
    const decoderColor = referenceVideoDecoderColorPlan(inputColor.inputColor), scaleColor = decoderColor.scaleSuffix;
    const crop = plan.cropped;
    const cropFilter = `crop=${crop.width}:${crop.height}:${crop.left}:${crop.top}:exact=1`;
    const colorFilter = decoderColor.managedYuv
      ? `${cropFilter},scale=iw:ih:flags=bicubic${scaleColor},format=rgba`
      : `${cropFilter},format=rgba`;
    const input = ["-v", "error", ...(video.loop ? ["-stream_loop", "-1"] : []), "-i", path, "-map", `0:${video.streamIndex}`];
    const trim = cadence ? `trim=start_frame=${sourceStartFrame}${video.loop ? "" : `:end_frame=${sourceEndFrame}`},` : "";
    const sourceFps = `${sourceFrameRate.numerator}/${sourceFrameRate.denominator}`;
    const resetPts = cadence ? `setpts=N/(${sourceFps}*TB)` : "setpts=PTS-STARTPTS";
    const filter = `${trim}${resetPts},fps=fps=${fps}:start_time=0:round=near:eof_action=pass,${colorFilter}`;
    const frameCount = boundedOutputFrameCount(durationExact, decodeFrameRate, `${node.op} retained decoded output`);
    const reader = new RawVideoReader([...input, "-vf", filter, "-an", "-frames:v", String(frameCount), "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], crop.width * crop.height * 4);
    const decoder: Decoder = {
      reader,
      lastFrame: -1,
      frameCache: new Map(),
      inputColor: inputColor.inputColor,
      evidence: Object.freeze({
        nodeId: node.id,
        streamIndex: video.streamIndex,
        mode: cadence ? "retained-native-crop-cfr-frame-index" as const : "retained-native-crop-source-pts" as const,
        frameLimit: frameCount,
        sourceStartFrame,
        sourceEndFrame: video.loop ? undefined : sourceEndFrame,
        loop: video.loop,
        outputFps: decodeFrameRate,
        semanticSeek: false as const,
      }),
    };
    this.retainedMediaDecoders.set(node.id, decoder);
    return decoder;
  }

  private async retainedMediaCroppedFrame(
    node: IRNode,
    plan: ReferenceRetainedMediaViewportPlan,
    frame: number,
    expectedVideoDecode?: ReferenceMediaCamera2DVideoDecodePlan,
    staticGradeSourceSemanticIdentity?: string,
  ) {
    if (plan.leafKind === "image") {
      if (expectedVideoDecode) throw new ReferenceRetainedMediaViewportError("CUT_RETAINED_MEDIA_VIEWPORT_GRAPH", node, "Image execution cannot carry a MediaCamera2D Video decode plan.");
      let cached = this.retainedMediaStaticImages.get(plan.semanticIdentity);
      if (cached) {
        if (staticGradeSourceSemanticIdentity !== undefined) {
          const existingBinding = cached.sourceAuthority
            ? staticMediaGradeSourceAuthorities.get(cached.sourceAuthority)
            : undefined;
          if (existingBinding && existingBinding.sourceSemanticIdentity !== staticGradeSourceSemanticIdentity) {
            throw new ReferenceRetainedMediaViewportError("CUT_RETAINED_MEDIA_VIEWPORT_RESOURCE", node, "cached Image source authority disagrees with the exact decode-plan identity.");
          }
          if (!cached.sourceAuthority) {
            cached = Object.freeze({
              ...cached,
              sourceAuthority: issueReferenceStaticMediaGradeSourceAuthority(
                cached.surface,
                staticGradeSourceSemanticIdentity,
              ),
            });
            this.retainedMediaStaticImages.set(plan.semanticIdentity, cached);
          }
        }
        return { ...cached, sourceOpens: 0, readerPullAttempts: 0, decodedFramesRead: 0, decodedSurfaces: 0, managedColorConversionSurfaces: 0 } as const;
      }
      const path = this.paths.get(plan.sourceId); if (!path) throw new ReferenceRetainedMediaViewportError("CUT_RETAINED_MEDIA_VIEWPORT_RESOURCE", node, `cannot resolve verified Image source ${plan.sourceId}.`);
      const crop = plan.cropped;
      const rendered = await sharp(path)
        .extract({ left: crop.left, top: crop.top, width: crop.width, height: crop.height })
        .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      if (rendered.info.width !== crop.width || rendered.info.height !== crop.height || rendered.info.channels !== 4) {
        throw new ReferenceRetainedMediaViewportError("CUT_RETAINED_MEDIA_VIEWPORT_RASTER", node, `Image decoded ${rendered.info.width}x${rendered.info.height}x${rendered.info.channels}; admitted crop is ${crop.width}x${crop.height}x4.`);
      }
      const result = { data: rendered.data, width: crop.width, height: crop.height };
      const sourceAuthority = staticGradeSourceSemanticIdentity === undefined
        ? undefined
        : issueReferenceStaticMediaGradeSourceAuthority(result, staticGradeSourceSemanticIdentity);
      const cachedResult = Object.freeze({ surface: result, ...(sourceAuthority ? { sourceAuthority } : {}) });
      this.retainedMediaStaticImages.set(plan.semanticIdentity, cachedResult);
      return { ...cachedResult, sourceOpens: 1, readerPullAttempts: 1, decodedFramesRead: 1, decodedSurfaces: 1, managedColorConversionSurfaces: 0 } as const;
    }
    const before = this.retainedMediaDecoders.get(node.id);
    if (expectedVideoDecode) {
      const expected = expectedVideoDecode.stateAtPreflight;
      const actual = before ? {
        status: before.ended ? "ended" as const : "open" as const,
        lastFrame: before.lastFrame,
        hasCurrentFrame: before.current !== undefined,
        frameLimit: before.evidence.frameLimit,
      } : { status: "unopened" as const, lastFrame: -1, hasCurrentFrame: false };
      if (frame !== expectedVideoDecode.targetFrame || hash(actual) !== hash(expected)) {
        throw new ReferenceRetainedMediaViewportError("CUT_RETAINED_MEDIA_VIEWPORT_RASTER", node, "MediaCamera2D Video decoder state/target diverged after whole-scene preflight and before decoder open.");
      }
    }
    const sourceOpens = this.retainedMediaDecoders.has(node.id) ? 0 : 1;
    const decoder = await this.retainedMediaDecoder(node, plan);
    if (expectedVideoDecode && decoder.evidence.frameLimit !== expectedVideoDecode.frameLimit) {
      throw new ReferenceRetainedMediaViewportError("CUT_RETAINED_MEDIA_VIEWPORT_RASTER", node, "MediaCamera2D Video decoder frame limit diverged from whole-scene preflight.");
    }
    if (frame < decoder.lastFrame) throw new ReferenceRetainedMediaViewportError("CUT_RETAINED_MEDIA_VIEWPORT_RASTER", node, "decoder cannot seek backwards within one scene render.");
    const endBehavior = this.videoConfigs.get(node.id)?.endBehavior ?? "error";
    if (decoder.ended) {
      decoder.lastFrame = frame;
      const held = { surface: { data: decoder.current!, width: plan.cropped.width, height: plan.cropped.height }, sourceOpens, readerPullAttempts: 0, decodedFramesRead: 0, decodedSurfaces: 0, managedColorConversionSurfaces: 0 } as const;
      if (expectedVideoDecode && (held.sourceOpens !== expectedVideoDecode.planned.sourceOpens
        || held.readerPullAttempts !== expectedVideoDecode.planned.readerPullAttempts
        || held.decodedFramesRead !== expectedVideoDecode.planned.decodedFramesRead
        || held.managedColorConversionSurfaces !== expectedVideoDecode.planned.managedColorConversionSurfaces)) {
        throw new ReferenceRetainedMediaViewportError("CUT_RETAINED_MEDIA_VIEWPORT_RASTER", node, "held Video execution diverged from MediaCamera2D preflight.");
      }
      return held;
    }
    let readerPullAttempts = 0, decodedFramesRead = 0, managedColorConversionSurfaces = 0;
    while (decoder.lastFrame < frame) {
      readerPullAttempts += 1;
      const next = await decoder.reader.nextFrame();
      if (!next) {
        if (endBehavior === "hold" && decoder.current) { decoder.ended = true; decoder.lastFrame = frame; break; }
        throw new ReferenceRetainedMediaViewportError("CUT_RETAINED_MEDIA_VIEWPORT_RASTER", node, "source media ended early; use endBehavior: “hold” to freeze the final decoded frame.");
      }
      decodedFramesRead += 1;
      const size = { width: plan.cropped.width, height: plan.cropped.height };
      const managedColorConversion = decoder.inputColor !== "legacy" && decoder.inputColor !== "srgb";
      const managed = decoder.inputColor === "bt470bg-smpte170m-limited"
        ? convertReferenceBt470bgSmpte170mInputToSrgb({ data: next, ...size }).data
        : (() => {
            const decodedProfile = decoder.inputColor === "rec709-limited" ? "rec709-full" : decoder.inputColor;
            return decodedProfile === "legacy" || decodedProfile === "srgb"
              ? next
              : convertReferenceColorSurface({ data: next, ...size }, decodedProfile, "srgb").data;
          })();
      if (managedColorConversion) managedColorConversionSurfaces += 1;
      // Retain the final raw/managed allocation itself. Copying it here used
      // to allocate one extra crop-sized surface for every catch-up frame.
      decoder.current = sharedBufferView(managed); decoder.lastFrame += 1;
    }
    const completed = {
      surface: { data: decoder.current!, width: plan.cropped.width, height: plan.cropped.height },
      sourceOpens,
      readerPullAttempts,
      decodedFramesRead,
      decodedSurfaces: decodedFramesRead,
      managedColorConversionSurfaces,
    } as const;
    if (expectedVideoDecode && (completed.sourceOpens !== expectedVideoDecode.planned.sourceOpens
      || completed.readerPullAttempts !== expectedVideoDecode.planned.readerPullAttempts
      || completed.decodedFramesRead !== expectedVideoDecode.planned.decodedFramesRead
      || completed.decodedSurfaces !== expectedVideoDecode.planned.decodedSurfaces
      || completed.managedColorConversionSurfaces !== expectedVideoDecode.planned.managedColorConversionSurfaces)) {
      throw new ReferenceRetainedMediaViewportError("CUT_RETAINED_MEDIA_VIEWPORT_RASTER", node, "Video catch-up/color execution diverged from MediaCamera2D preflight.");
    }
    return completed;
  }

  /** Resolve every reachable camera frame and its complete allocation/work
   * envelope before a decoder or image source is touched for this frame. */
  private mediaCamera2DAnchorPlanKey(ownerNodeId: string, exactTime: Rational) {
    return `${ownerNodeId}\u0000${exactTime.numerator}/${exactTime.denominator}`;
  }

  private preflightMediaCamera2DFrame(scene: IRScene, time: Rational, outputFrame: string) {
    this.activeMediaCamera2DFramePlans.clear();
    this.activeMediaCamera2DAnchorPlans.clear();
    const staged: Array<Readonly<{ plan: ReferenceMediaCamera2DPlan; framePlan: ReferenceMediaCamera2DFramePlan }>> = [];
    for (const plan of this.mediaCamera2DConfigs.values()) {
      if (plan.sceneId !== scene.id) continue;
      const decoder = plan.leafKind === "video" ? this.retainedMediaDecoders.get(plan.leafNodeId) : undefined;
      const decoderState: ReferenceMediaCamera2DVideoDecoderState | undefined = !decoder ? undefined : Object.freeze({
        status: decoder.ended ? "ended" as const : "open" as const,
        lastFrame: decoder.lastFrame,
        hasCurrentFrame: decoder.current !== undefined,
        frameLimit: decoder.evidence.frameLimit,
      });
      staged.push(Object.freeze({
        plan,
        framePlan: referenceMediaCamera2DFramePlanAt(this.ir, this.composition, plan, time, this.preparedSignalResolver, decoderState),
      }));
    }
    this.activeMediaCamera2DSceneAdmission = admitReferenceMediaCamera2DSceneFrame(this.ir, this.composition, scene.id, time, staged);
    for (const item of staged) {
      this.activeMediaCamera2DFramePlans.set(item.plan.cameraNodeId, item.framePlan);
      const anchorPlan = referenceMediaCamera2DAnchorPlanFromFramePlan(this.ir, item.plan, item.framePlan);
      this.activeMediaCamera2DAnchorPlans.set(
        this.mediaCamera2DAnchorPlanKey(item.plan.cameraNodeId, item.framePlan.exactTime),
        anchorPlan,
      );
    }
    this.activeMediaCamera2DFrameEvidence = [];
    this.activeMediaCamera2DOutputFrame = outputFrame;
  }

  private stagedMediaCamera2DFrameEvidence() {
    const active = this.activeMediaCamera2DFrameEvidence;
    if (!active) throw new Error("CUT_MEDIA_CAMERA_RASTER: no active MediaCamera2D frame evidence to stage.");
    return Object.freeze(
      [...active].sort((left, right) => left.cameraNodeId.localeCompare(right.cameraNodeId)
        || left.executionIdentity.localeCompare(right.executionIdentity)),
    );
  }

  private async mediaCamera2DFrame(node: IRNode, time: Rational) {
    const plan = this.mediaCamera2DConfigs.get(node.id), framePlan = this.activeMediaCamera2DFramePlans.get(node.id);
    const evidence = this.activeMediaCamera2DFrameEvidence, outputFrame = this.activeMediaCamera2DOutputFrame;
    const sceneAdmission = this.activeMediaCamera2DSceneAdmission;
    if (!plan || !framePlan || !evidence || outputFrame === undefined || !sceneAdmission) {
      throw new Error(`CUT_MEDIA_CAMERA_RASTER: MediaCamera2D ${node.id} reached pixels without its exact-frame preflight.`);
    }
    if (framePlan.status === "opacity-zero") {
      const completed = referenceMediaCamera2DOpacityZeroFrame(plan, framePlan, outputFrame, sceneAdmission);
      evidence.push(completed.evidence);
      return { data: sharedBufferView(completed.surface.data), width: completed.surface.width, height: completed.surface.height };
    }
    const leaf = this.ir.nodes[plan.leafNodeId];
    if (!leaf) throw new Error(`CUT_MEDIA_CAMERA_GRAPH: MediaCamera2D ${node.id} lost admitted media leaf ${plan.leafNodeId}.`);
    const local = subtractRational(time, leaf.interval.start), mediaFrame = exactMediaFrameIndex(local, this.composition.fps);
    const staticGradeNode = plan.gradeNodeId === undefined ? undefined : this.ir.nodes[plan.gradeNodeId];
    const staticGradeSourceSemanticIdentity = staticGradeNode
      && !this.irValueContainsSignal(staticGradeNode.inputs)
      && !this.irValueContainsSignal(staticGradeNode.properties)
      ? plan.decodePlan.semanticIdentity
      : undefined;
    const decoded = await this.retainedMediaCroppedFrame(
      leaf,
      plan.decodePlan,
      mediaFrame,
      framePlan.videoDecode,
      staticGradeSourceSemanticIdentity,
    );
    let source: RawSurface = decoded.surface;
    let staticGradeLease: ReferenceStaticMediaGradeLease | undefined;
    let linearBalanceSurfaces: 0 | 1 = 0, backendGradeSurfaces: 0 | 1 = 0;
    let staticGradeCache: ReferenceMediaCamera2DStaticGradeCacheEvidence | undefined;
    let nativeEffect: ReferenceMediaCamera2DNativeEffectRuntime | undefined;
    if (framePlan.nativeEffectChain) {
      const operations: Array<ReferenceMediaCamera2DNativeEffectRuntime["operations"][number]> = [];
      for (const operation of framePlan.nativeEffectChain.operations) {
        const effect = this.ir.nodes[operation.nodeId];
        if (!effect || effect.op !== operation.op) {
          throw new ReferenceMediaCamera2DError(
            "CUT_MEDIA_CAMERA_PREFLIGHT",
            node,
            `native-crop effect ${operation.nodeId} is missing or changed kind after exact-frame preflight.`,
          );
        }
        if (operation.op === "cut.visual.color_grade") {
          if (!framePlan.gradeExecutionIdentity
            || framePlan.gradeExecutionIdentity !== operation.configIdentity) {
            throw new ReferenceMediaCamera2DError(
              "CUT_MEDIA_CAMERA_PREFLIGHT",
              effect,
              "native-crop ColorGrade lost the single sampled execution identity shared by work and effect-chain planning.",
            );
          }
          const graded = await this.colorGradeExecution(effect, source, time, operation.configIdentity);
          source = graded.surface;
          linearBalanceSurfaces = graded.linearBalanceSurfaces;
          backendGradeSurfaces = graded.backendGradeSurfaces;
        } else {
          const config = this.visualEffects.get(effect.id);
          if (!config || hash(config) !== operation.configIdentity) {
            throw new ReferenceMediaCamera2DError(
              "CUT_MEDIA_CAMERA_PREFLIGHT",
              effect,
              "native-crop visual-effect configuration changed after exact-frame preflight.",
            );
          }
          source = await applyReferenceVisualEffect(config, source, { frame: this.outputFrameIndex });
        }
        if (source.width !== plan.decodedCrop.width || source.height !== plan.decodedCrop.height
          || source.data.byteLength !== plan.decodedCrop.pixels * 4) {
          throw new ReferenceMediaCamera2DError(
            "CUT_MEDIA_CAMERA_RASTER",
            effect,
            "native-crop effect changed the locked post-crop source bounds or RGBA byte length.",
          );
        }
        operations.push(Object.freeze({
          executionOrder: operation.executionOrder,
          nodeId: operation.nodeId,
          op: operation.op,
          configIdentity: operation.configIdentity,
          outputRgbaSha256: createHash("sha256").update(source.data).digest("hex"),
          outputRgbaBytes: source.data.byteLength,
        }));
      }
      nativeEffect = Object.freeze({
        operations: Object.freeze(operations),
        finalRgbaSha256: createHash("sha256").update(source.data).digest("hex"),
      });
    } else if (plan.gradeNodeId) {
      const grade = this.ir.nodes[plan.gradeNodeId];
      if (!grade) throw new Error(`CUT_MEDIA_CAMERA_GRAPH: MediaCamera2D ${node.id} lost admitted ColorGrade ${plan.gradeNodeId}.`);
      if (!framePlan.gradeExecutionIdentity) {
        throw new ReferenceMediaCamera2DError("CUT_MEDIA_CAMERA_PREFLIGHT", grade, "visible ColorGrade camera frame lost its sampled grade execution identity.");
      }
      if (plan.leafKind === "image") {
        const decodedImage = decoded as typeof decoded & Readonly<{
          sourceAuthority?: ReferenceStaticMediaGradeSourceAuthority;
        }>;
        const graded = await this.staticMediaColorGradeExecution(
          grade,
          source,
          time,
          plan.decodePlan.semanticIdentity,
          framePlan.gradeExecutionIdentity,
          decodedImage.sourceAuthority,
        );
        if (graded.surface !== undefined && graded.lease === undefined) {
          source = graded.surface;
        } else if (graded.lease !== undefined && graded.surface === undefined) {
          staticGradeLease = graded.lease;
        } else {
          throw new ReferenceMediaCamera2DError(
            "CUT_MEDIA_CAMERA_RASTER",
            grade,
            "static Image ColorGrade execution must return exactly one materialized surface or one cache-private lease.",
          );
        }
        staticGradeCache = graded.evidence;
        linearBalanceSurfaces = graded.linearBalanceSurfaces;
        backendGradeSurfaces = graded.backendGradeSurfaces;
      } else {
        const graded = await this.colorGradeExecution(
          grade,
          source,
          time,
          framePlan.gradeExecutionIdentity,
        );
        source = graded.surface;
        linearBalanceSurfaces = graded.linearBalanceSurfaces;
        backendGradeSurfaces = graded.backendGradeSurfaces;
      }
    }
    const executeWithSource = (
      resolvedSource: RawSurface,
      staticGradeLeaseExecutionAuthority?: ReferenceMediaCamera2DStaticGradeLeaseExecutionAuthority,
    ) => executeReferenceMediaCamera2DFrame({
      source: resolvedSource,
      plan,
      framePlan,
      diagnosticNode: node,
      outputFrame,
      sceneAdmission,
      ...(staticGradeLeaseExecutionAuthority ? { staticGradeLeaseExecutionAuthority } : {}),
      ...(this.rendererTreeContext.retainedMediaViewportQ16TapDiagnostic
        ? {
          q16TapDiagnostic:
            this.rendererTreeContext.retainedMediaViewportQ16TapDiagnostic,
        }
        : {}),
      decoded: Object.freeze({
        sourceOpens: decoded.sourceOpens,
        readerPullAttempts: decoded.readerPullAttempts,
        decodedFramesRead: decoded.decodedFramesRead,
        decodedSurfaces: decoded.decodedSurfaces,
        managedColorConversionSurfaces: decoded.managedColorConversionSurfaces,
        linearBalanceSurfaces,
        backendGradeSurfaces,
        ...(staticGradeCache ? {
          staticGradeCache,
          staticGradeSourceRgbaSha256: staticGradeCache.sourceRgbaSha256,
        } : {}),
        ...(nativeEffect ? { nativeEffect } : {}),
      }),
    });
    const completed = staticGradeLease
      ? this.rendererTreeContext.staticMediaGradeCache.consumeLease(
        staticGradeLease,
        (leasedSource) => executeWithSource(
          leasedSource,
          createReferenceMediaCamera2DStaticGradeLeaseExecutionAuthority(
            leasedSource,
            staticGradeCache!,
          ),
        ),
      )
      : executeWithSource(source);
    evidence.push(completed.evidence);
    return { data: sharedBufferView(completed.surface.data), width: completed.surface.width, height: completed.surface.height };
  }

  private async retainedMediaViewportFrame(
    config: ReferenceLocalSpaceConfig,
    plan: ReferenceRetainedMediaViewportPlan,
    time: Rational,
  ): Promise<Readonly<{ surface?: RawSurface; execution: ReferenceRetainedMediaMaterializationRuntime }>> {
    const root = this.ir.nodes[plan.rootId], leaf = this.ir.nodes[plan.leafId];
    if (!root || !leaf) throw new ReferenceLocalSpaceError("CUT_LOCAL_SPACE_GRAPH", root ?? leaf ?? this.ir.nodes[config.nodeId]!, "retained-media plan references a missing root or leaf.");
    const localComposition = this.localComposition(config);
    const state = referenceRetainedMediaViewportStateAt(this.ir, localComposition, plan, time, this.preparedSignalResolver);
    if (!state.active) {
      this.recordLocalSpaceSkip(root, "inactive-node", "outside-interval", undefined, time);
      return Object.freeze({
        execution: Object.freeze({ rootId: plan.rootId, status: "skipped" as const, skipReason: "inactive-node" as const }),
      });
    }
    if (state.opacity === 0) {
      this.recordLocalSpaceSkip(root, "local-node-opacity", "opacity-zero", undefined, time);
      return Object.freeze({
        execution: Object.freeze({ rootId: plan.rootId, status: "skipped" as const, skipReason: "opacity-zero" as const }),
      });
    }
    if (state.hidden || !state.outputBounds) {
      return Object.freeze({
        execution: Object.freeze({ rootId: plan.rootId, status: "skipped" as const, skipReason: "outside-output-bounds" as const }),
      });
    }
    const local = subtractRational(time, leaf.interval.start), mediaFrame = exactMediaFrameIndex(local, this.composition.fps);
    const decoded = await this.retainedMediaCroppedFrame(leaf, plan, mediaFrame);
    let cropped = decoded.surface;
    let colorGradeSurfaces = 0;
    if (plan.colorGradeNodeId) {
      const grade = this.ir.nodes[plan.colorGradeNodeId];
      if (!grade) throw new ReferenceLocalSpaceError("CUT_LOCAL_SPACE_GRAPH", leaf, `missing admitted ColorGrade ${plan.colorGradeNodeId}.`);
      const input = cropped;
      cropped = await this.colorGrade(grade, cropped, time);
      colorGradeSurfaces = cropped !== input || cropped.data !== input.data ? 1 : 0;
    }
    let fitted = cropped;
    let fittedSurfaces: 0 | 1 = 0;
    if (cropped.width !== plan.fitted.width || cropped.height !== plan.fitted.height) {
      const rendered = await sharp(cropped.data, raw(cropped)).resize(plan.fitted.width, plan.fitted.height, { fit: "fill", kernel: sharp.kernel.cubic }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      if (rendered.info.width !== plan.fitted.width || rendered.info.height !== plan.fitted.height || rendered.info.channels !== 4) {
        throw new ReferenceLocalSpaceError("CUT_LOCAL_SPACE_RASTER", leaf, `fit produced ${rendered.info.width}x${rendered.info.height}x${rendered.info.channels}; admitted output is ${plan.fitted.width}x${plan.fitted.height}x4.`);
      }
      fitted = { data: rendered.data, width: plan.fitted.width, height: plan.fitted.height };
      fittedSurfaces = 1;
    }
    const executed = executeReferenceRetainedMediaViewportFrame({
      source: fitted,
      plan,
      state,
      diagnosticNode: leaf,
      ...(this.rendererTreeContext.retainedMediaViewportQ16TapDiagnostic
        ? {
          diagnostic:
            this.rendererTreeContext.retainedMediaViewportQ16TapDiagnostic,
        }
        : {}),
      runtime: {
        compositionId: this.composition.id,
        exactTime: time,
        outputFrame: String(this.outputFrameIndex),
        sourceOpens: decoded.sourceOpens,
        decodedFramesRead: decoded.decodedFramesRead,
        decodedSurfaces: decoded.decodedSurfaces,
        colorGradeSurfaces,
        fittedSurfaces,
      },
    });
    if (!state.outputBounds) throw new ReferenceRetainedMediaViewportError("CUT_RETAINED_MEDIA_VIEWPORT_RASTER", leaf, "visible execution lost its admitted output bounds.");
    const activeEvidence = this.activeRetainedMediaViewportFrameEvidence;
    if (!activeEvidence) throw new ReferenceLocalSpaceError("CUT_LOCAL_SPACE_RASTER", root, "retained-media execution occurred outside an active staged frame receipt.");
    const receipt = executed.receipt;
    activeEvidence.push(receipt);
    this.recordLocalNodeRasterization(config);
    const surface = {
      data: Buffer.from(executed.surface.data.buffer, executed.surface.data.byteOffset, executed.surface.data.byteLength),
      width: executed.surface.width,
      height: executed.surface.height,
    };
    return Object.freeze({
      surface,
      execution: Object.freeze({
        rootId: plan.rootId,
        status: "rendered" as const,
        receipt,
      }),
    });
  }

  private beginPictureTimeMapFrameEvidence() {
    this.activePictureTimeMapFrameEvidence = {
      reserved: 0,
      receipts: [],
    };
  }

  private reservePictureTimeMapFrameEvidence(count = 1) {
    const active = this.activePictureTimeMapFrameEvidence;
    if (!active) {
      throw new ReferencePictureTimeMapFrameEvidenceError(
        "PictureClip executed outside an active scene-frame evidence transaction.",
      );
    }
    if (!Number.isSafeInteger(count) || count < 0
      || active.reserved + count
        > referencePictureTimeMapFrameEvidenceLimits.maximumReceiptsPerRendererFrame) {
      throw new ReferencePictureTimeMapFrameEvidenceError(
        `typed-time frame receipts exceed the ${referencePictureTimeMapFrameEvidenceLimits.maximumReceiptsPerRendererFrame}-receipt renderer-frame limit.`,
      );
    }
    active.reserved += count;
  }

  private assertPictureTimeMapConfigFresh(
    node: IRNode,
    config: ReferencePictureTimeMapConfig,
  ) {
    const prepared = this.pictureTimeMapConfigIdentities.get(node.id);
    const current = referencePictureTimeMapConfigIdentity(config);
    if (!prepared || current !== prepared) {
      throw new ReferencePictureTimeMapFrameEvidenceError(
        `PictureClip ${node.id} time-map configuration changed after validated preparation.`,
      );
    }
    return prepared;
  }

  private stagePictureTimeMapFrameEvidence(
    node: IRNode,
    config: ReferencePictureTimeMapConfig,
    request: ReferencePictureTimeMapFrameRequest,
    surface: RawSurface,
  ) {
    const active = this.activePictureTimeMapFrameEvidence;
    if (!active || active.receipts.length >= active.reserved) {
      throw new ReferencePictureTimeMapFrameEvidenceError(
        `PictureClip ${node.id} completed without one reserved typed-time receipt.`,
      );
    }
    const input = Object.freeze({
      compositionId: this.composition.id,
      nodeId: node.id,
      outputFrame: String(this.outputFrameIndex),
      config,
      request,
      width: surface.width,
      height: surface.height,
      rgbaSha256: createHash("sha256").update(surface.data).digest("hex"),
    });
    const evidence = referencePictureTimeMapFrameEvidence(input);
    if (evidence.configIdentity !== this.assertPictureTimeMapConfigFresh(node, config)) {
      throw new ReferencePictureTimeMapFrameEvidenceError(
        `PictureClip ${node.id} frame receipt lost its prepared configuration identity.`,
      );
    }
    validateReferencePictureTimeMapFrameEvidence(evidence, input);
    active.receipts.push(evidence);
  }

  private stagedPictureTimeMapFrameEvidence() {
    const active = this.activePictureTimeMapFrameEvidence;
    if (!active || active.receipts.length !== active.reserved) {
      throw new ReferencePictureTimeMapFrameEvidenceError(
        "completed scene frame did not publish every reserved typed-time receipt.",
      );
    }
    return Object.freeze(
      [...active.receipts].sort((left, right) =>
        left.executionPath.length - right.executionPath.length
        || left.nodeId.localeCompare(right.nodeId)
        || left.executionIdentity.localeCompare(right.executionIdentity)),
    );
  }

  private async imageSequenceFrame(node: IRNode, local: Rational): Promise<RawSurface> {
    const config = this.preparedImageSequences.get(node.id);
    if (!config) throw new Error(`Reference ImageSequence ${node.id} was not prepared from locked manifest bytes.`);
    const selected = referenceImageSequenceSelectionAt(config, local);
    const cached = this.imageSequenceSurfaces.get(selected.cacheIdentity);
    if (cached) {
      this.imageSequenceSurfaces.delete(selected.cacheIdentity);
      this.imageSequenceSurfaces.set(selected.cacheIdentity, cached);
      return cached;
    }
    const path = this.paths.get(selected.resourceId);
    if (!path) throw new Error(`Reference ImageSequence ${node.id} cannot resolve selected member ${selected.resourceId}.`);
    let pipeline = sharp(path);
    if (config.crop) {
      const { x, y, width, height } = config.crop;
      const left = Math.max(0, Math.min(config.source.width - 1, Math.round(x * config.source.width)));
      const top = Math.max(0, Math.min(config.source.height - 1, Math.round(y * config.source.height)));
      const extractWidth = Math.max(1, Math.min(config.source.width - left, Math.round(width * config.source.width)));
      const extractHeight = Math.max(1, Math.min(config.source.height - top, Math.round(height * config.source.height)));
      pipeline = pipeline.extract({ left, top, width: extractWidth, height: extractHeight });
    }
    const rendered = await pipeline
      .resize(this.composition.width, this.composition.height, {
        fit: config.fit,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (rendered.info.width !== this.composition.width
      || rendered.info.height !== this.composition.height
      || rendered.info.channels !== 4) {
      throw new Error(`Reference ImageSequence ${node.id} selected member produced an unexpected RGBA surface.`);
    }
    const surface = { data: rendered.data, width: rendered.info.width, height: rendered.info.height };
    const maximumBytes = 64 * 1024 * 1024, maximumEntries = 8;
    if (surface.data.byteLength <= maximumBytes) {
      this.imageSequenceSurfaces.set(selected.cacheIdentity, surface);
      this.imageSequenceSurfaceBytes += surface.data.byteLength;
      while ((this.imageSequenceSurfaceBytes > maximumBytes || this.imageSequenceSurfaces.size > maximumEntries)
        && this.imageSequenceSurfaces.size > 1) {
        const oldestKey = this.imageSequenceSurfaces.keys().next().value as string | undefined;
        if (!oldestKey) break;
        const oldest = this.imageSequenceSurfaces.get(oldestKey);
        this.imageSequenceSurfaces.delete(oldestKey);
        if (oldest) this.imageSequenceSurfaceBytes -= oldest.data.byteLength;
      }
    }
    return surface;
  }

  private async mediaFrame(node: IRNode, frame: number, sourceTime?: Rational) {
    if (node.op === "cut.visual.image") {
      const cached = this.staticImages.get(node.id); if (cached) return cached;
      const config = referenceShapeNodeConfig(this.ir, this.composition, node); if (config?.kind !== "image") throw new Error("Internal CUT Image config mismatch.");
      const path = this.paths.get(config.sourceId)!; let pipeline = sharp(path); const crop = config.crop;
      if (crop) {
        const metadata = await pipeline.metadata(); if (!metadata.width || !metadata.height) throw new Error(`Image ${config.sourceId} has no decodable dimensions.`);
        const { x, y, width: cropWidth, height: cropHeight } = crop;
        const left = Math.max(0, Math.min(metadata.width - 1, Math.round(x * metadata.width))), top = Math.max(0, Math.min(metadata.height - 1, Math.round(y * metadata.height))), extractWidth = Math.max(1, Math.min(metadata.width - left, Math.round(cropWidth * metadata.width))), extractHeight = Math.max(1, Math.min(metadata.height - top, Math.round(cropHeight * metadata.height)));
        pipeline = sharp(path).extract({ left, top, width: extractWidth, height: extractHeight });
      }
      // `contain` is a layer operation, not a request to bake black bars into
      // an image. Keep uncovered pixels transparent so layers below remain
      // visible; `cover` and `fill` have no uncovered output pixels.
      const data = await pipeline.resize(this.composition.width, this.composition.height, { fit: config.fit, background: { r: 0, g: 0, b: 0, alpha: 0 } }).ensureAlpha().raw().toBuffer(); const surface = { data, width: this.composition.width, height: this.composition.height }; this.staticImages.set(node.id, surface); return surface;
    }
    const pictureTimeMap = node.op === "cut.edit.picture_clip" ? this.pictureTimeMapConfigs.get(node.id) : undefined;
    if (node.op === "cut.edit.picture_clip" && !pictureTimeMap) {
      throw new Error(`Reference PictureClip ${node.id} has no validated time-map configuration.`);
    }
    const pictureRequest: ReferencePictureTimeMapFrameRequest | undefined =
      pictureTimeMap
        ? sourceTime === undefined
          ? Object.freeze({ kind: "destination-frame" as const, destinationFrame: frame })
          : Object.freeze({ kind: "absolute-source-time" as const, sourceTime })
        : undefined;
    if (pictureTimeMap) {
      this.assertPictureTimeMapConfigFresh(node, pictureTimeMap);
      this.reservePictureTimeMapFrameEvidence();
    }
    const decoderSample = pictureTimeMap
      ? sourceTime === undefined
        ? referencePictureDecoderSample(pictureTimeMap, frame)
        : referencePictureDecoderSampleAtSourceTime(pictureTimeMap, sourceTime)
      : Object.freeze({
          firstFrame: frame,
          secondFrame: frame,
          phaseQ16: 0,
          frameSelection: "floor" as const,
        });
    const decoder = await this.decoder(node);
    const endBehavior = node.op === "cut.visual.video" ? this.videoConfigs.get(node.id)?.endBehavior : stringValue(node.inputs.endBehavior, "error");
    if (endBehavior !== "error" && endBehavior !== "hold") throw new Error(`${node.op} endBehavior must be “error” or “hold”.`);
    const decodedFrame = async (target: number) => {
      const cached = decoder.frameCache.get(target);
      if (cached) return cached;
      if (target < decoder.lastFrame) throw new Error("Reference decoder cannot seek backwards beyond its bounded frame-blend cache within one scene render.");
      if (decoder.ended) {
        decoder.lastFrame = target;
        const held = decoder.current!;
        decoder.frameCache.set(target, held);
        while (decoder.frameCache.size > 2) decoder.frameCache.delete(decoder.frameCache.keys().next().value!);
        return held;
      }
      while (decoder.lastFrame < target) {
        const next = await decoder.reader.nextFrame();
        if (!next) {
          if (endBehavior === "hold" && decoder.current) {
            decoder.ended = true;
            decoder.lastFrame = target;
            decoder.frameCache.set(target, decoder.current);
            break;
          }
          throw new Error(`Source media ended before CUT node ${node.id}. Use endBehavior: “hold” to freeze the final decoded frame.`);
        }
        const managed = decoder.inputColor === "bt470bg-smpte170m-limited"
          ? convertReferenceBt470bgSmpte170mInputToSrgb({ data: next, width: this.composition.width, height: this.composition.height }).data
          : (() => {
              const decodedProfile = decoder.inputColor === "rec709-limited" ? "rec709-full" : decoder.inputColor;
              return decodedProfile === "legacy" || decodedProfile === "srgb"
                ? next
                : convertReferenceColorSurface({ data: next, width: this.composition.width, height: this.composition.height }, decodedProfile, "srgb").data;
            })();
        decoder.current = Buffer.from(managed);
        decoder.lastFrame += 1;
        decoder.frameCache.set(decoder.lastFrame, decoder.current);
        while (decoder.frameCache.size > 2) decoder.frameCache.delete(decoder.frameCache.keys().next().value!);
      }
      const result = decoder.frameCache.get(target) ?? decoder.current;
      if (!result) throw new Error(`Reference decoder did not materialize requested frame ${target}.`);
      return result;
    };
    const first = await decodedFrame(decoderSample.firstFrame);
    if (decoderSample.firstFrame === decoderSample.secondFrame || decoderSample.phaseQ16 === 0) {
      const surface = {
        data: first,
        width: this.composition.width,
        height: this.composition.height,
      };
      if (pictureTimeMap && pictureRequest) {
        this.stagePictureTimeMapFrameEvidence(
          node,
          pictureTimeMap,
          pictureRequest,
          surface,
        );
      }
      return surface;
    }
    if (decoderSample.frameSelection !== "frame-blend"
      || decoderSample.frameBlendPolicyIdentity !== referencePictureFrameBlendPolicyIdentity) {
      throw new Error("PictureClip two-frame sample lacks the authenticated frame-blend policy.");
    }
    const second = await decodedFrame(decoderSample.secondFrame);
    const blended = blendReferencePictureFrames(
      { data: first, width: this.composition.width, height: this.composition.height },
      { data: second, width: this.composition.width, height: this.composition.height },
      decoderSample.phaseQ16,
    );
    const surface = {
      data: Buffer.from(
        blended.surface.data.buffer,
        blended.surface.data.byteOffset,
        blended.surface.data.byteLength,
      ),
      width: this.composition.width,
      height: this.composition.height,
    };
    if (pictureTimeMap && pictureRequest) {
      this.stagePictureTimeMapFrameEvidence(
        node,
        pictureTimeMap,
        pictureRequest,
        surface,
      );
    }
    return surface;
  }

  private async text(node: IRNode) {
    const cached = this.textSurfaces.get(node.id); if (cached) { this.textSurfaces.delete(node.id); this.textSurfaces.set(node.id, cached); return cached; }
    const prepared = this.preparedTexts.get(node.id);
    if (!prepared) throw new Error(`Reference Text ${node.id} was not prepared from its locked FontAsset.`);
    const { config } = prepared, width = this.composition.width, height = this.composition.height;
    if (!prepared.lines.some(Boolean)) return transparent(width, height);
    const paths = prepared.lines.map((outline, index) => {
      if (!outline) return "";
      const start = config.align === "start" ? config.x : config.align === "middle" ? config.x - outline.advance / 2 : config.x - outline.advance;
      return `<path d="${outline.pathData}" transform="translate(${start} ${config.y + index * config.lineHeight})"/>`;
    }).join("");
    const shadow = config.shadowOpacity > 0
      ? `<filter id="cut-locked-text-shadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="${Math.max(1, config.shadowBlur * .28)}" stdDeviation="${config.shadowBlur}" flood-color="${config.shadowColor.color}" flood-opacity="${config.shadowOpacity * config.shadowColor.opacity}"/></filter>`
      : "";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs>${shadow}</defs><g fill="${config.color.color}" fill-opacity="${config.color.opacity}"${shadow ? ' filter="url(#cut-locked-text-shadow)"' : ""}>${paths}</g></svg>`;
    const surface = await svgSurface(svg, width, height);
    this.textSurfaces.set(node.id, surface); this.textSurfaceBytes += surface.data.byteLength;
    while (this.textSurfaceBytes > this.rendererTreeContext.surfaceCacheByteLimit && this.textSurfaces.size > 1) {
      const oldestKey = this.textSurfaces.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      const oldest = this.textSurfaces.get(oldestKey); this.textSurfaces.delete(oldestKey);
      if (oldest) this.textSurfaceBytes -= oldest.data.byteLength;
    }
    return surface;
  }

  private async flowText(node: IRNode, local: Rational) {
    const prepared = this.preparedFlowTexts.get(node.id);
    if (!prepared) throw new Error(`Reference FlowText ${node.id} was not prepared from its locked FontAsset.`);
    const staticSurface = prepared.motions.length === 0 ? this.staticImages.get(node.id) : undefined;
    if (staticSurface) return staticSurface;
    const surface = await svgSurface(referenceFlowTextSvg(prepared, local, this.composition.width, this.composition.height), this.composition.width, this.composition.height);
    if (prepared.motions.length === 0) this.staticImages.set(node.id, surface);
    return surface;
  }

  private cacheLocalTypographySurface(key: string, surface: RawSurface) {
    this.localTextSurfaces.set(key, surface);
    this.localTextSurfaceBytes += surface.data.byteLength;
    while (this.localTextSurfaceBytes > this.rendererTreeContext.surfaceCacheByteLimit && this.localTextSurfaces.size > 1) {
      const oldestKey = this.localTextSurfaces.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      const oldest = this.localTextSurfaces.get(oldestKey);
      this.localTextSurfaces.delete(oldestKey);
      if (oldest) this.localTextSurfaceBytes -= oldest.data.byteLength;
    }
  }

  /** Local Text is shaped from the same locked font preparation as ordinary
   * Text, but rasterizes directly into the declared local tile. It never asks
   * the ordinary delivery-canvas Text path for pixels and then crops them. */
  private async localTextSurface(node: IRNode, localSpace: ReferenceBoundedLocalRasterContext) {
    const prepared = this.preparedTexts.get(node.id);
    if (!prepared) throw new Error(`Reference Text ${node.id} was not prepared from its locked FontAsset.`);
    const cacheKey = hash({
      kind: "local-space-text-surface",
      localSpace: localSpace.semanticIdentity,
      node: node.contentHash,
      font: this.ir.resources[prepared.config.fontId]?.sha256,
      backend: this.localSpaceBackendIdentity(),
    });
    const cached = this.localTextSurfaces.get(cacheKey);
    if (cached) {
      this.localTextSurfaces.delete(cacheKey);
      this.localTextSurfaces.set(cacheKey, cached);
      return cached;
    }
    const { config } = prepared, width = localSpace.width, height = localSpace.height, origin = this.localSpaceOrigin(localSpace);
    if (!prepared.lines.some(Boolean)) {
      const empty = transparent(width, height);
      this.recordLocalNodeRasterization(localSpace);
      return empty;
    }
    const paths = prepared.lines.map((outline, index) => {
      if (!outline) return "";
      const authoredStart = config.align === "start" ? config.x : config.align === "middle" ? config.x - outline.advance / 2 : config.x - outline.advance;
      return `<path d="${outline.pathData}" transform="translate(${authoredStart + origin.x} ${config.y + origin.y + index * config.lineHeight})"/>`;
    }).join("");
    const shadow = config.shadowOpacity > 0
      ? `<filter id="cut-locked-text-shadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="${Math.max(1, config.shadowBlur * .28)}" stdDeviation="${config.shadowBlur}" flood-color="${config.shadowColor.color}" flood-opacity="${config.shadowOpacity * config.shadowColor.opacity}"/></filter>`
      : "";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs>${shadow}</defs><g fill="${config.color.color}" fill-opacity="${config.color.opacity}"${shadow ? ' filter="url(#cut-locked-text-shadow)"' : ""}>${paths}</g></svg>`;
    const surface = await svgSurface(svg, width, height);
    this.recordLocalNodeRasterization(localSpace);
    this.cacheLocalTypographySurface(cacheKey, surface);
    return surface;
  }

  /** FlowText keeps exact schedule sampling against the owning timeline fps,
   * while its outline SVG and static cache are bounded by the LocalSpace. */
  private async localFlowTextSurface(node: IRNode, localSpace: ReferenceBoundedLocalRasterContext, localTime: Rational) {
    const prepared = this.preparedFlowTexts.get(node.id);
    if (!prepared) throw new Error(`Reference FlowText ${node.id} was not prepared from its locked FontAsset.`);
    const cacheKey = hash({
      kind: "local-space-flow-text-surface",
      localSpace: localSpace.semanticIdentity,
      node: node.contentHash,
      fonts: prepared.config.fontIds.map((fontId) => ({ id: fontId, sha256: this.ir.resources[fontId]?.sha256 })),
      shapingBackend: prepared.complexShaping?.backendIntegrity ?? "legacy-flow-text-v2",
      backend: this.localSpaceBackendIdentity(),
    });
    if (prepared.motions.length === 0) {
      const cached = this.localTextSurfaces.get(cacheKey);
      if (cached) {
        this.localTextSurfaces.delete(cacheKey);
        this.localTextSurfaces.set(cacheKey, cached);
        return cached;
      }
    }
    const origin = this.localSpaceOrigin(localSpace);
    const surface = await svgSurface(
      referenceFlowTextSvg(prepared, localTime, localSpace.width, localSpace.height, origin),
      localSpace.width,
      localSpace.height,
    );
    this.recordLocalNodeRasterization(localSpace);
    if (prepared.motions.length === 0) this.cacheLocalTypographySurface(cacheKey, surface);
    return surface;
  }

  private async shape(node: IRNode) {
    const cached = this.staticImages.get(node.id); if (cached) return cached;
    const width = this.composition.width, height = this.composition.height; const x = quantityNumber(node.inputs.x, width / 2), y = quantityNumber(node.inputs.y, height / 2), config = referenceShapeNodeConfig(this.ir, this.composition, node);
    let surface: RawSurface;
    if (config?.kind === "rect") { const paint = config.paint.kind === "linear-gradient" ? "url(#rect-gradient)" : config.paint.color, gradient = config.paint.kind === "linear-gradient" ? `<linearGradient id="rect-gradient" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${config.paint.from}"/><stop offset="1" stop-color="${config.paint.to}"/></linearGradient>` : ""; surface = await svgSurface(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs>${gradient}</defs><rect x="${x - config.width / 2}" y="${y - config.height / 2}" width="${config.width}" height="${config.height}" rx="${config.radius}" fill="${paint}"/></svg>`, width, height); this.staticImages.set(node.id, surface); return surface; }
    if (config?.kind === "circle") { surface = await svgSurface(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><circle cx="${x}" cy="${y}" r="${config.radius}" fill="${config.paint.color}"/></svg>`, width, height); this.staticImages.set(node.id, surface); return surface; }
    const fill = colorValue(node.inputs.fill, "#ffffff");
    const points = arrayValue(node.inputs.points).map((item) => { const entry = objectValue(item); return entry ? `${quantityNumber(entry.x)},${quantityNumber(entry.y)}` : ""; }).filter(Boolean).join(" "); const stroke = colorValue(node.inputs.stroke, fill), strokeWidth = quantityNumber(node.inputs.width, 4);
    surface = await svgSurface(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><polyline points="${points}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/></svg>`, width, height); this.staticImages.set(node.id, surface); return surface;
  }

  private async vectorPath(node: IRNode, time: Rational) {
    const anchoredPlan = this.anchoredVectorPathPlans.get(node.id);
    if (anchoredPlan) {
      const resolution = this.anchoredVectorPathResolution(node, anchoredPlan, time);
      if (resolution.status === "policy-hidden") return transparent(this.composition.width, this.composition.height);
      return svgSurface(
        referenceVectorPathSvg(resolution.frame, this.composition.width, this.composition.height, node),
        this.composition.width,
        this.composition.height,
      );
    }
    const plan = this.vectorPathPlans.get(node.id);
    if (!plan) throw new Error(`Reference retained Path ${node.id} was not prepared.`);
    if (!plan.frameDynamic) {
      const cached = this.staticImages.get(node.id);
      if (cached) return cached;
    }
    const frame = referenceVectorPathFrameAt(this.ir, node, plan, time);
    const surface = await svgSurface(referenceVectorPathSvg(frame, this.composition.width, this.composition.height, node), this.composition.width, this.composition.height);
    if (!plan.frameDynamic) this.staticImages.set(node.id, surface);
    return surface;
  }

  private track2DTransform(node: IRNode, time: Rational) {
    const config = this.track2DConfigs.get(node.id), track = this.preparedTrack2D.get(node.id);
    if (!config || !track) throw new Error(`Reference Track2D ${node.id} was not prepared from locked data.`);
    return referenceTrack2DAt(node, track, config, subtractRational(time, node.interval.start));
  }

  private motionPathPlan(node: IRNode) {
    const plan = this.motionPathPlans.get(node.id);
    if (!plan) throw new Error(`Reference MotionPath ${node.id} has no immutable prepared geometry plan.`);
    return plan;
  }

  private anchoredMotionPathPlan(node: IRNode) {
    const plan = this.anchoredMotionPathPlans.get(node.id);
    if (!plan) throw new Error(`Reference anchored MotionPath ${node.id} has no immutable owner-resolved geometry plan.`);
    return plan;
  }

  private anchoredOutputFrame() {
    return Number.isSafeInteger(this.outputFrameIndex) && this.outputFrameIndex >= 0
      ? BigInt(this.outputFrameIndex)
      : undefined;
  }

  private anchoredPathOwnerResolution(
    consumer: IRNode,
    geometry: ReferenceValidatedAnchoredPathGeometry,
    ownerNodeId: string,
    exactTime: Rational,
  ): ReferenceAnchoredPathOwnerResolution {
    const binding = geometry.ownerBindings.find((candidate) => candidate.ownerNodeId === ownerNodeId);
    if (!binding) throw new Error(`CUT_ANCHORED_PATH_GRAPH: ${consumer.id} has no validated coordinate binding for owner ${ownerNodeId}.`);
    if (binding.ownerKind === "media-camera-2d") {
      const anchorPlan = this.activeMediaCamera2DAnchorPlans.get(
        this.mediaCamera2DAnchorPlanKey(ownerNodeId, exactTime),
      );
      if (!anchorPlan) {
        throw new Error(`CUT_ANCHORED_PATH_RESOLUTION: ${consumer.id} MediaCamera2D owner ${ownerNodeId} has no admitted exact-frame coordinate plan.`);
      }
      if (anchorPlan.basis.semanticIdentity !== binding.basisSemanticIdentity
        || anchorPlan.basis.width !== binding.basisWidth
        || anchorPlan.basis.height !== binding.basisHeight) {
        throw new Error(`CUT_ANCHORED_PATH_RESOLUTION: MediaCamera2D owner ${ownerNodeId} source basis changed after anchored-geometry validation.`);
      }
      return Object.freeze({
        status: anchorPlan.status,
        ownerNodeId,
        ownerKind: "media-camera-2d" as const,
        basis: anchorPlan.basis,
        sourceToComposition: anchorPlan.sourceToDelivery,
        affineIdentity: anchorPlan.affineIdentity,
        ...(anchorPlan.responsiveSlotComposition
          ? { responsiveSlotComposition: anchorPlan.responsiveSlotComposition }
          : {}),
        ownerPlanIdentity: anchorPlan.ownerPlanIdentity,
        coordinatePlan: anchorPlan,
      });
    }
    const plan = this.activeAffineLocalSpacePlan(ownerNodeId, binding.localSpaceNodeId, exactTime);
    if (plan.status === "policy-hidden") {
      if (plan.ownerKind !== "track-2d") {
        throw new Error(`CUT_ANCHORED_PATH_RESOLUTION: only Track2D may directly suppress anchored geometry; ${ownerNodeId} is ${plan.ownerKind}.`);
      }
      return Object.freeze({
        status: "policy-hidden" as const,
        ownerNodeId,
        ownerKind: "track-2d" as const,
        localSpaceNodeId: binding.localSpaceNodeId,
        ownerPlanIdentity: plan.planIdentity,
      });
    }
    if (!plan.placement) {
      throw new Error(`CUT_ANCHORED_PATH_RESOLUTION: ${consumer.id} owner ${ownerNodeId} has ${plan.status} preflight without a placement.`);
    }
    const localSpace = this.localSpaceConfigs.get(binding.localSpaceNodeId);
    if (!localSpace) throw new Error(`CUT_ANCHORED_PATH_GRAPH: missing validated LocalSpace ${binding.localSpaceNodeId}.`);
    return Object.freeze({
      status: plan.status,
      ownerNodeId,
      localSpace,
      placement: plan.placement,
      ownerPlanIdentity: plan.planIdentity,
    });
  }

  private recordAnchoredPathResolution(
    consumer: IRNode,
    authoredGeometryIdentity: string,
    resolution: ReferenceAnchoredPathResolution,
  ) {
    const active = this.activeAnchoredPathFrameEvidence;
    if (!active) return;
    const identityComponentFragment =
      this.validatedAnchoredGeometry.get(consumer.id)?.identityComponentFragment;
    const mediaCameraResolution = resolution.algorithmVersion === "cut-reference-anchored-path-media-camera-v2";
    const base = {
      schema: mediaCameraResolution
        ? "cut.reference.anchored-path-frame.v2" as const
        : "cut.reference.anchored-path-frame.v1" as const,
      ...(mediaCameraResolution ? { algorithmVersion: resolution.algorithmVersion } : {}),
      consumerNodeId: consumer.id,
      consumerOp: consumer.op as "cut.visual.path" | "cut.visual.motion_path",
      exactTime: Object.freeze({ ...resolution.exactTime }),
      ...(resolution.frame === undefined ? {} : { outputFrame: String(resolution.frame) }),
      authoredGeometryIdentity,
      ...(identityComponentFragment ? { identityComponentFragment } : {}),
      status: resolution.status,
      executionIdentity: resolution.executionIdentity,
      ...(resolution.status === "resolved" ? {
        geometryIdentity: resolution.geometryIdentity,
        anchors: resolution.anchors,
        geometry: resolution.geometry,
      } : {
        suppressedBy: resolution.suppressedBy,
        zeroWork: resolution.zeroWork,
      }),
    };
    const evidence = Object.freeze({ ...base, evidenceIdentity: hash(base) });
    active.set(`${consumer.id}\u0000${resolution.exactTime.numerator}/${resolution.exactTime.denominator}\u0000${resolution.executionIdentity}`, evidence);
  }

  private bindAnchoredPathRenderedOutput(
    consumer: IRNode,
    exactTime: Rational,
    surface: RawSurface,
  ) {
    const active = this.activeAnchoredPathFrameEvidence;
    if (!active) return;
    const matches = [...active.entries()].filter(([, evidence]) =>
      evidence.consumerNodeId === consumer.id
      && compareRational(evidence.exactTime, exactTime) === 0);
    if (matches.length !== 1) {
      throw new Error(
        `CUT_ANCHORED_PATH_EVIDENCE: rendered consumer ${consumer.id} has ${matches.length} exact-time geometry receipts; expected one.`,
      );
    }
    const [key, evidence] = matches[0]!;
    const outputRgbaSha256 = createHash("sha256")
      .update(surface.data)
      .digest("hex");
    const priorBody = Object.fromEntries(
      Object.entries(evidence).filter(([name]) => name !== "evidenceIdentity"),
    ) as Omit<ReferenceAnchoredPathFrameEvidence, "evidenceIdentity">;
    const body = Object.freeze({ ...priorBody, outputRgbaSha256 });
    active.set(
      key,
      Object.freeze({ ...body, evidenceIdentity: hash(body) }),
    );
  }

  private anchoredGeometryEvidenceIdentity(geometry: ReferenceValidatedAnchoredPathGeometry) {
    return geometry.resolutionAlgorithmVersion === "cut-reference-anchored-path-media-camera-v2"
      ? geometry.validationIdentity
      : geometry.semanticIdentity;
  }

  private anchoredVectorPathResolution(
    node: IRNode,
    plan: ReferenceAnchoredVectorPathPlan,
    time: Rational,
  ): ReferenceAnchoredVectorPathFrameResolution {
    const resolution = referenceAnchoredVectorPathFrameResolutionAt(
      this.ir,
      node,
      plan,
      time,
      (ownerNodeId, exactTime) => this.anchoredPathOwnerResolution(node, plan.geometry as ReferenceValidatedAnchoredPathGeometry, ownerNodeId, exactTime),
      this.anchoredOutputFrame(),
    );
    const geometry = plan.geometry as ReferenceValidatedAnchoredPathGeometry;
    this.recordAnchoredPathResolution(node, this.anchoredGeometryEvidenceIdentity(geometry), resolution.anchored);
    return resolution;
  }

  private anchoredMotionPathResolution(
    node: IRNode,
    plan: ReferenceAnchoredMotionPathPlan,
    time: Rational,
    composition: IRComposition = this.composition,
  ): ReferenceAnchoredMotionPathResolution {
    const resolution = referenceAnchoredMotionPathResolutionAt(
      this.ir,
      composition,
      node,
      time,
      plan,
      (ownerNodeId, exactTime) => this.anchoredPathOwnerResolution(node, plan.geometry as ReferenceValidatedAnchoredPathGeometry, ownerNodeId, exactTime),
      this.anchoredOutputFrame(),
    );
    const geometry = plan.geometry as ReferenceValidatedAnchoredPathGeometry;
    this.recordAnchoredPathResolution(node, this.anchoredGeometryEvidenceIdentity(geometry), resolution.anchored);
    return resolution;
  }

  /** Render one exact unary retained chain from explicit Path geometry into a
   * tight final-space viewport, then perform one integer placement copy. */
  private async retainedPathChainFrame(chain: ReferenceRetainedPathChain, time: Rational) {
    const pathNode = this.ir.nodes[chain.pathId], plan = this.vectorPathPlans.get(chain.pathId) ?? this.anchoredVectorPathPlans.get(chain.pathId);
    if (!pathNode || !plan) throw new Error(`Reference retained Path chain ${chain.rootId} has no prepared Path leaf.`);
    const outputFrame = this.anchoredOutputFrame();
    const anchoredConsumers = chain.nodeIds.flatMap((nodeId) => {
      const consumer = this.ir.nodes[nodeId], geometry = this.validatedAnchoredGeometry.get(nodeId);
      return consumer && geometry ? [Object.freeze({ consumer, geometry })] : [];
    });
    const execution = referenceRetainedPathChainExecutionAt(this.ir, this.composition, chain, plan, time, {
      resolveTrack2D: (node, sampleTime) => this.track2DTransform(node, sampleTime),
      resolveMotionPath: (node) => this.motionPathPlan(node),
      resolveAnchoredMotionPath: (node) => this.anchoredMotionPathPlan(node),
      resolveAnchoredPathOwner: (ownerNodeId, exactTime) => {
        const candidates = anchoredConsumers.filter(({ geometry }) => geometry.ownerBindings.some((binding) => binding.ownerNodeId === ownerNodeId));
        const selected = candidates[0];
        if (!selected) {
          throw new Error(`CUT_ANCHORED_PATH_GRAPH: retained chain ${chain.rootId} requested owner ${ownerNodeId} without one unambiguous anchored consumer.`);
        }
        const coordinateBases = new Set(candidates.flatMap(({ geometry }) => geometry.ownerBindings
          .filter((binding) => binding.ownerNodeId === ownerNodeId)
          .map((binding) => binding.ownerKind === "media-camera-2d"
            ? `media-camera-2d:${binding.basisSemanticIdentity}`
            : `local-space:${binding.localSpaceNodeId}`)));
        if (coordinateBases.size !== 1) {
          throw new Error(`CUT_ANCHORED_PATH_GRAPH: retained chain ${chain.rootId} binds owner ${ownerNodeId} to conflicting coordinate bases.`);
        }
        return this.anchoredPathOwnerResolution(selected.consumer, selected.geometry, ownerNodeId, exactTime);
      },
      preparedSignalResolver: this.preparedSignalResolver,
      ...(outputFrame === undefined ? {} : { outputFrame }),
    });
    if (execution.anchoredPathResolution && plan.geometryKind === "anchored-v1") {
      const geometry = plan.geometry as ReferenceValidatedAnchoredPathGeometry;
      this.recordAnchoredPathResolution(pathNode, this.anchoredGeometryEvidenceIdentity(geometry), execution.anchoredPathResolution);
    }
    if (execution.state.anchoredMotionPathResolution) {
      const motionNodeId = chain.nodeIds.find((nodeId) => this.anchoredMotionPathPlans.has(nodeId));
      const motionNode = motionNodeId ? this.ir.nodes[motionNodeId] : undefined;
      const motionPlan = motionNodeId ? this.anchoredMotionPathPlans.get(motionNodeId) : undefined;
      if (!motionNode || !motionPlan) throw new Error(`CUT_ANCHORED_PATH_GRAPH: retained chain ${chain.rootId} returned anchored MotionPath evidence without its consumer plan.`);
      const geometry = motionPlan.geometry as ReferenceValidatedAnchoredPathGeometry;
      this.recordAnchoredPathResolution(motionNode, this.anchoredGeometryEvidenceIdentity(geometry), execution.state.anchoredMotionPathResolution.anchored);
    }
    if (!execution.frame || !execution.visibleRasterBounds || !execution.cacheIdentity) {
      return transparent(this.composition.width, this.composition.height);
    }
    const key = execution.cacheIdentity.sha256;
    let pending = this.retainedPathRasterMemo.get(key);
    if (!pending) {
      pending = (async () => {
        try {
          const bounds = execution.visibleRasterBounds!;
          const svg = referenceVectorPathTransformedSvg(execution.frame!, bounds, execution.state.affine, execution.state.opacity, pathNode);
          const rendered = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
          if (rendered.info.width !== bounds.width || rendered.info.height !== bounds.height || rendered.info.channels !== 4) {
            throw new ReferenceRetainedPathChainError("CUT_RETAINED_PATH_CHAIN", pathNode, `backend returned ${rendered.info.width}x${rendered.info.height}x${rendered.info.channels} for declared ${bounds.width}x${bounds.height}x4 final-space raster bounds.`);
          }
          const positioned = referencePositionedSurface({
            data: rendered.data,
            width: bounds.width,
            height: bounds.height,
            originX: bounds.left,
            originY: bounds.top,
            alphaMode: "straight",
          });
          if (!execution.deliveryClipped) assertReferenceRetainedBoundsCovered(positioned);
          const placed = translateReferenceRetainedSurface(positioned, this.composition.width, this.composition.height, bounds.left, bounds.top);
          return { data: sharedBufferView(placed.data), width: placed.width, height: placed.height };
        } catch (error) {
          if (error instanceof ReferenceRetainedVisualError) throw new ReferenceRetainedPathChainError(error.code, pathNode, error.message);
          throw error;
        }
      })();
      this.retainedPathRasterMemo.set(key, pending);
      pending.catch(() => this.retainedPathRasterMemo.delete(key));
    }
    return pending;
  }

  private async trace(node: IRNode, local: Rational) {
    const width = this.composition.width, height = this.composition.height;
    const delay = node.inputs.delay?.kind === "quantity" ? node.inputs.delay.magnitude : zeroRational;
    const duration = node.inputs.duration?.kind === "quantity" ? node.inputs.duration.magnitude : zeroRational;
    if (compareRational(local, delay) < 0) return transparent(width, height);

    const trace = this.tracePlans.get(node.id);
    if (!trace) throw new Error(`Reference Trace ${node.id} was not prepared.`);
    const position = subtractRational(local, delay), completed = compareRational(position, duration) >= 0;
    const easing = stringValue(node.inputs.easing, "linear") as ReferenceTraceEasing;
    const linearProgress = completed ? 1 : rationalToNumber(divideRational(position, duration));
    const prefix = referenceTracePrefixWithTangent(trace.trace, easeReferenceTrace(linearProgress, easing));
    const polyline = prefix.points.length < 2 ? "" : `<polyline points="${prefix.points.map((point) => `${point.x},${point.y}`).join(" ")}" fill="none" stroke="${colorValue(node.inputs.stroke)}" stroke-width="${quantityNumber(node.inputs.width)}" stroke-linecap="round" stroke-linejoin="round"/>`;

    const headRadius = quantityNumber(node.inputs.headRadius, 0);
    const headFade = node.inputs.headFade?.kind === "quantity" ? node.inputs.headFade.magnitude : rational(3, 25);
    const sinceCompletion = completed ? subtractRational(position, duration) : zeroRational;
    const headOpacity = headRadius <= 0 ? 0
      : !completed ? 1
        : compareRational(headFade, zeroRational) <= 0 || compareRational(sinceCompletion, headFade) >= 0 ? 0
          : 1 - rationalToNumber(divideRational(sinceCompletion, headFade));
    const head = headOpacity <= 0 ? "" : `<circle cx="${prefix.head.x}" cy="${prefix.head.y}" r="${headRadius}" fill="${colorValue(node.inputs.headColor, colorValue(node.inputs.stroke))}" fill-opacity="${headOpacity}"/>`;
    const arrow = trace.arrow ? (() => {
      const tip = prefix.head, tangent = prefix.tangent;
      const baseX = tip.x - tangent.x * trace.arrow!.length, baseY = tip.y - tangent.y * trace.arrow!.length;
      const halfWidth = trace.arrow!.width / 2, perpendicularX = -tangent.y * halfWidth, perpendicularY = tangent.x * halfWidth;
      return `<polygon points="${tip.x},${tip.y} ${baseX + perpendicularX},${baseY + perpendicularY} ${baseX - perpendicularX},${baseY - perpendicularY}" fill="${trace.arrow!.color}"/>`;
    })() : "";
    if (!completed) return svgSurface(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${polyline}${head}${arrow}</svg>`, width, height);

    let stroke = this.completedTraceSurfaces.get(node.id);
    if (!stroke) {
      stroke = await svgSurface(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${polyline}</svg>`, width, height);
      this.completedTraceSurfaces.set(node.id, stroke);
    }
    if (!head && !arrow) return stroke;
    const headSurface = await svgSurface(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${head}${arrow}</svg>`, width, height);
    return composite(width, height, [stroke, headSurface]);
  }

  private irValueContainsSignal(value: unknown, seen = new WeakSet<object>()): boolean {
    if (!value || typeof value !== "object") return false;
    if (seen.has(value)) return true;
    seen.add(value);
    if ("signal" in value || (value as { kind?: unknown }).kind === "signal-ref") return true;
    if (Array.isArray(value)) return value.some((item) => this.irValueContainsSignal(item, seen));
    return Object.values(value).some((item) => this.irValueContainsSignal(item, seen));
  }

  private async staticMediaColorGradeExecution(
    node: IRNode,
    source: RawSurface,
    time: Rational,
    sourceSemanticIdentity: string,
    gradeExecutionIdentity: string,
    sourceAuthority?: ReferenceStaticMediaGradeSourceAuthority,
  ): Promise<ReferenceStaticMediaGradeResult> {
    const dynamic = this.irValueContainsSignal(node.inputs)
      || this.irValueContainsSignal(node.properties);
    if (!dynamic) {
      return this.rendererTreeContext.staticMediaGradeCache.request({
        source,
        ...(sourceAuthority ? { sourceAuthority } : {}),
        sourceSemanticIdentity,
        gradeNodeId: node.id,
        gradeExecutionIdentity,
        backendIdentity: referenceMediaCamera2DStaticGradeBackendIdentity,
        materialize: () => this.colorGradeExecution(node, source, time, gradeExecutionIdentity),
      });
    }
    const rendered = await this.colorGradeExecution(node, source, time, gradeExecutionIdentity);
    this.rendererTreeContext.staticMediaGradeCache.recordDynamicBypass();
    const sourceRgbaSha256 = createHash("sha256").update(source.data).digest("hex");
    const outputRgbaSha256 = createHash("sha256").update(rendered.surface.data).digest("hex");
    return Object.freeze({
      ...rendered,
      evidence: Object.freeze({
        algorithmVersion: referenceMediaCamera2DStaticGradeCacheAlgorithmVersion,
        status: "bypass-dynamic" as const,
        cacheIdentity: referenceMediaCamera2DStaticGradeCacheIdentity({
          sourceSemanticIdentity,
          sourceRgbaSha256,
          width: source.width,
          height: source.height,
          gradeNodeId: node.id,
          gradeExecutionIdentity,
          backendIdentity: referenceMediaCamera2DStaticGradeBackendIdentity,
        }),
        sourceRgbaSha256,
        outputRgbaSha256,
        residentBytes: this.rendererTreeContext.staticMediaGradeCache.residentBytes,
        entries: this.rendererTreeContext.staticMediaGradeCache.entryCount,
        residentCopies: 0 as const,
        residentCopyRgbaBytes: 0,
        handoffCopies: 0 as const,
        handoffRgbaBytes: 0,
        leaseHandoffs: 0 as const,
        leaseRgbaBytes: 0,
      }),
    });
  }

  private async colorGradeExecution(node: IRNode, surface: RawSurface, time: Rational, expectedExecutionIdentity?: string) {
    const config = referenceColorGradeConfigAt(this.ir, node, time);
    if (expectedExecutionIdentity !== undefined && hash(config) !== expectedExecutionIdentity) {
      throw new ReferenceMediaCamera2DError(
        "CUT_MEDIA_CAMERA_PREFLIGHT",
        node,
        "ColorGrade configuration changed after exact-frame camera preflight; aborting before grade pixels execute.",
      );
    }
    const linearBalance = config.exposureStops !== 0 || config.temperature !== 0 || config.tint !== 0;
    const backendGrade = config.brightness !== 1 || config.saturation !== 1 || config.hueDegrees !== 0 || config.contrast !== 1;
    if (!linearBalance && !backendGrade) {
      return Object.freeze({ surface, linearBalanceSurfaces: 0 as const, backendGradeSurfaces: 0 as const });
    }
    const balanced = applyReferenceLinearColorBalance(surface, config.exposureStops, config.temperature, config.tint);
    if (!backendGrade) {
      return Object.freeze({ surface: balanced, linearBalanceSurfaces: 1 as const, backendGradeSurfaces: 0 as const });
    }
    let pipeline = sharp(balanced.data, raw(balanced));
    if (config.brightness !== 1 || config.saturation !== 1 || config.hueDegrees !== 0) {
      pipeline = pipeline.modulate({ brightness: config.brightness, saturation: config.saturation, hue: config.hueDegrees });
    }
    if (config.contrast !== 1) pipeline = pipeline.linear(config.contrast, 128 * (1 - config.contrast));
    const data = await pipeline.ensureAlpha().raw().toBuffer();
    // The public boundary is straight-alpha RGBA. Sharp operations above are
    // RGB-only, but restore the exact input alpha bytes so this is a tested CUT
    // guarantee rather than a backend-version assumption.
    for (let offset = 3; offset < data.byteLength; offset += 4) data[offset] = balanced.data[offset];
    return Object.freeze({
      surface: { ...balanced, data },
      linearBalanceSurfaces: linearBalance ? 1 as const : 0 as const,
      backendGradeSurfaces: 1 as const,
    });
  }

  private async colorGrade(node: IRNode, surface: RawSurface, time: Rational) {
    return (await this.colorGradeExecution(node, surface, time)).surface;
  }

  private lut(node: IRNode, surface: RawSurface, time: Rational) {
    const config = this.lutConfigs.get(node.id);
    if (!config) throw new ReferenceLutError("CUT_LUT_GRAPH", node, "has no validated runtime configuration.");
    const lut = this.preparedLuts.get(config.sourceId);
    if (!lut) throw new ReferenceLutError("CUT_LUT_RESOURCE", node, `has no prepared locked .cube table for ${config.sourceId}.`);
    const strength = referenceLutStrengthAt(this.ir, node, time);
    if (strength === 0) return surface;
    const data = Buffer.alloc(surface.data.byteLength);
    for (let offset = 0; offset < data.byteLength; offset += 4) {
      const original = [surface.data[offset] / 255, surface.data[offset + 1] / 255, surface.data[offset + 2] / 255] as const;
      const graded = sampleReferenceCubeLut(lut, original[0], original[1], original[2]);
      for (let channel = 0; channel < 3; channel += 1) {
        const value = strength === 1 ? graded[channel] : original[channel] + (graded[channel] - original[channel]) * strength;
        data[offset + channel] = Math.round(Math.max(0, Math.min(1, value)) * 255);
      }
      data[offset + 3] = surface.data[offset + 3];
    }
    return { ...surface, data };
  }

  private plainValue(value: IRValue | undefined): unknown {
    if (!value) return undefined;
    if (value.kind === "resource-ref") return this.dataAssets.get(value.id);
    if (value.kind === "array") return value.items.map((item) => this.plainValue(item));
    if (value.kind === "object") return Object.fromEntries(Object.entries(value.entries).map(([key, item]) => [key, this.plainValue(item)]));
    if (value.kind === "quantity") return rationalToNumber(value.magnitude);
    if (value.kind === "boolean" || value.kind === "string" || value.kind === "color") return value.value;
    if (value.kind === "null") return null;
    return undefined;
  }

  private geoPoints(value: IRValue | undefined): ReferenceGeoPoint[] {
    return referenceGeoPoints(this.plainValue(value));
  }

  private async globe(node: IRNode, time: Rational, local: Rational) {
    const width = this.composition.width, height = this.composition.height; const rotation = quantityNumber(propertyAt(this.ir, node, "rotation", time) ?? node.inputs.rotation, 0); const tilt = quantityNumber(propertyAt(this.ir, node, "tilt", time) ?? node.inputs.tilt, -12); const radius = quantityNumber(node.inputs.radius, Math.min(width, height) * .41); const centerX = quantityNumber(node.inputs.x, width / 2), centerY = quantityNumber(node.inputs.y, height / 2); const ocean = colorValue(node.inputs.ocean, "#07141f"), land = colorValue(node.inputs.land, "#1f4854"), line = colorValue(node.inputs.line, "#5f8d97"), signal = colorValue(node.inputs.signal, "#ff6b45");
    const projection = geoOrthographic().translate([centerX, centerY]).scale(radius).rotate([-rotation, -tilt, 0]).clipAngle(90); const path = geoPath(projection); const worldPath = path(this.world as never) ?? "", graticule = path(geoGraticule10()) ?? "", sphere = path({ type: "Sphere" } as never) ?? "";
    const reveal = Math.max(0, Math.min(1, quantityNumber(propertyAt(this.ir, node, "reveal", time) ?? node.inputs.reveal, 1))), markerRadius = quantityNumber(node.inputs.markerRadius, 3.2);
    const points = this.geoPoints(node.inputs.points ?? node.inputs.stations).map((point) => {
      if (geoDistance([point.longitude, point.latitude], [rotation, tilt]) > Math.PI / 2) return "";
      const position = projection([point.longitude, point.latitude]); if (!position) return "";
      const rank = parseInt(hash({ id: point.id, latitude: point.latitude, longitude: point.longitude }).slice(0, 8), 16) / 0xffffffff;
      const appeared = Math.max(0, Math.min(1, (reveal - rank) * 10)); if (appeared <= 0) return "";
      const r = point.emphasis ? markerRadius * 2.1 : markerRadius; const pulse = point.emphasis ? 1 + .25 * Math.sin(rationalToNumber(local) * Math.PI * 3) : 1;
      return `<circle cx="${position[0]}" cy="${position[1]}" r="${r * pulse}" fill="${point.emphasis ? signal : "#70d6c5"}" opacity="${appeared * (point.emphasis ? .98 : .78)}"/>`;
    }).join("");
    return svgSurface(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><radialGradient id="o"><stop stop-color="#173747"/><stop offset="1" stop-color="${ocean}"/></radialGradient><filter id="g"><feGaussianBlur stdDeviation="12"/></filter></defs><circle cx="${centerX}" cy="${centerY}" r="${radius + 18}" fill="none" stroke="${signal}" opacity=".18" stroke-width="20" filter="url(#g)"/><path d="${sphere}" fill="url(#o)" stroke="${line}" stroke-width="2"/><path d="${worldPath}" fill="${land}" stroke="#6e9ba3" stroke-width="1.5"/><path d="${graticule}" fill="none" stroke="${line}" opacity=".22"/>${points}</svg>`, width, height);
  }

  private async map(node: IRNode, time: Rational) {
    const width = this.composition.width, height = this.composition.height; const points = this.geoPoints(node.inputs.points); const projection = referenceGeoMapProjection(width, height); const path = geoPath(projection); const land = path(this.world as never) ?? ""; const signal = colorValue(node.inputs.signal, "#ff6b45");
    const preparedLabels = this.preparedGeoLabels.get(node.id); if (!preparedLabels) throw new Error(`Reference Map ${node.id} has no prepared geo-label contract.`);
    const reveal = Math.max(0, Math.min(1, quantityNumber(propertyAt(this.ir, node, "reveal", time) ?? node.inputs.reveal, 1)));
    const marks = points.map((point, index) => { const rank = parseInt(hash({ id: point.id, latitude: point.latitude, longitude: point.longitude }).slice(0, 8), 16) / 0xffffffff, appeared = Math.max(0, Math.min(1, (reveal - rank) * 10)); if (appeared <= 0) return ""; const p = projection([point.longitude, point.latitude]); return p ? `<circle cx="${p[0]}" cy="${p[1]}" r="${point.emphasis ? 12 : 6}" fill="${point.emphasis ? signal : "#72d6c9"}" opacity="${appeared}"/>${referenceGeoLabelPath(preparedLabels.runs.get(index), { x: p[0] + 16, y: p[1] - 12, fill: "#f5f7f2", opacity: appeared })}` : ""; }).join("");
    return svgSurface(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#07141f"/><path d="${land}" fill="#193b46" stroke="#557e87"/><path d="${path(geoGraticule10()) ?? ""}" fill="none" stroke="#557e87" opacity=".2"/>${marks}</svg>`, width, height);
  }

  private async route(node: IRNode, time: Rational) {
    const width = this.composition.width, height = this.composition.height, projection = referenceGeoMapProjection(width, height), points = this.geoPoints(node.inputs.points).map((point) => projection([point.longitude, point.latitude])).filter((point): point is [number, number] => Boolean(point));
    const reveal = Math.max(0, Math.min(1, quantityNumber(propertyAt(this.ir, node, "reveal", time) ?? node.inputs.reveal, 1))), color = colorValue(node.inputs.color ?? node.inputs.stroke, "#ff6b45"), strokeWidth = quantityNumber(node.inputs.width, 5), d = points.map((point, index) => `${index ? "L" : "M"}${point[0]},${point[1]}`).join(" ");
    return svgSurface(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><path d="${d}" pathLength="1" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="1" stroke-dashoffset="${1 - reveal}"/></svg>`, width, height);
  }

  private async marker(node: IRNode, time: Rational) {
    const width = this.composition.width, height = this.composition.height, point = this.geoPoints(node.inputs.point)[0]; if (!point) throw new Error("cut.geo.marker needs a valid geographic point.");
    const preparedLabels = this.preparedGeoLabels.get(node.id); if (!preparedLabels) throw new Error(`Reference Marker ${node.id} has no prepared geo-label contract.`);
    const projectionName = stringValue(node.inputs.projection, "map"), color = colorValue(node.inputs.color, "#ff6b45"), radius = quantityNumber(node.inputs.radius, 9), pulse = 1 + .18 * Math.sin(rationalToNumber(time) * Math.PI * 3); let projected: [number, number] | null = null;
    if (projectionName === "globe") {
      const rotation = quantityNumber(node.inputs.globeRotation, 0), tilt = quantityNumber(node.inputs.globeTilt, -12); if (geoDistance([point.longitude, point.latitude], [rotation, tilt]) > Math.PI / 2) return transparent(width, height); projected = geoOrthographic().translate([quantityNumber(node.inputs.globeX, width / 2), quantityNumber(node.inputs.globeY, height / 2)]).scale(quantityNumber(node.inputs.globeRadius, Math.min(width, height) * .41)).rotate([-rotation, -tilt, 0])([point.longitude, point.latitude]);
    } else projected = referenceGeoMapPoint(width, height, point);
    if (!projected) return transparent(width, height);
    const labelOnRight = projected[0] <= width * .72, labelX = labelOnRight ? projected[0] + radius + 14 : projected[0] - radius - 14;
    const labelBelow = projected[1] < 90, labelY = labelBelow ? projected[1] + radius + 36 : projected[1] - radius - 10;
    const anchor = labelOnRight ? "start" : "end";
    const labelPath = referenceGeoLabelPath(preparedLabels.runs.get(0), { x: labelX, y: labelY, anchor, fill: "#f5f7f2", stroke: "#050816", strokeWidth: 9 });
    return svgSurface(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><circle cx="${projected[0]}" cy="${projected[1]}" r="${radius * 2.8 * pulse}" fill="none" stroke="${color}" stroke-width="2" opacity=".28"/><circle cx="${projected[0]}" cy="${projected[1]}" r="${radius}" fill="${color}"/>${labelPath}</svg>`, width, height);
  }

  private async connections(node: IRNode, time: Rational) {
    const width = this.composition.width, height = this.composition.height, target = this.geoPoints(node.inputs.target)[0]; if (!target) throw new Error("cut.geo.connections needs a valid target point.");
    const preparedLabels = this.preparedGeoLabels.get(node.id); if (!preparedLabels) throw new Error(`Reference Connections ${node.id} has no prepared geo-label contract.`);
    const projection = referenceGeoMapProjection(width, height), end = projection([target.longitude, target.latitude]); if (!end) return transparent(width, height);
    const count = Math.max(1, Math.min(500, Math.round(quantityNumber(node.inputs.count, 24)))), reveal = Math.max(0, Math.min(1, quantityNumber(propertyAt(this.ir, node, "reveal", time) ?? node.inputs.reveal, 1))), color = colorValue(node.inputs.color, "#22d3ee"), strokeWidth = quantityNumber(node.inputs.width, 2.5);
    const selected = this.geoPoints(node.inputs.points ?? node.inputs.stations).sort((left, right) => hash({ id: left.id }).localeCompare(hash({ id: right.id }))).slice(0, count);
    const paths = selected.map((point, index) => { const start = projection([point.longitude, point.latitude]); if (!start) return ""; const local = Math.max(0, Math.min(1, reveal * count - index)); if (local <= 0) return ""; const middleX = (start[0] + end[0]) / 2, middleY = (start[1] + end[1]) / 2 - Math.min(180, Math.abs(start[0] - end[0]) * .16 + 24); return `<path d="M${start[0]},${start[1]} Q${middleX},${middleY} ${end[0]},${end[1]}" pathLength="1" fill="none" stroke="${color}" stroke-width="${strokeWidth}" opacity="${.18 + .62 * local}" stroke-dasharray="1" stroke-dashoffset="${1 - local}"/>`; }).join("");
    const targetLabel = referenceGeoLabelPath(preparedLabels.runs.get(0), { x: end[0] + 18, y: end[1] - 18, fill: "#f5f7f2", stroke: "#050816", strokeWidth: 8 });
    return svgSurface(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${paths}<circle cx="${end[0]}" cy="${end[1]}" r="${8 + reveal * 5}" fill="${color}"/><circle cx="${end[0]}" cy="${end[1]}" r="${20 + reveal * 18}" fill="none" stroke="${color}" opacity="${.35 * reveal}"/>${targetLabel}</svg>`, width, height);
  }

  private async wavefront(node: IRNode, time: Rational, local: Rational) {
    const width = this.composition.width, height = this.composition.height, origin = this.plainValue(node.inputs.origin) as Record<string, unknown> | undefined;
    const projectionName = referenceWavefrontProjection(node); if (!projectionName) throw new Error("Internal CUT Wavefront projection mismatch."); let x = quantityNumber(node.inputs.x, width / 2), y = quantityNumber(node.inputs.y, height / 2), clip = "";
    if (origin && Number.isFinite(Number(origin.latitude ?? origin.lat)) && Number.isFinite(Number(origin.longitude ?? origin.lon ?? origin.lng))) {
      const latitude = Number(origin.latitude ?? origin.lat), longitude = Number(origin.longitude ?? origin.lon ?? origin.lng);
      if (projectionName === "globe") {
        const rotation = quantityNumber(node.inputs.globeRotation, 0), tilt = quantityNumber(node.inputs.globeTilt, -12), globeRadius = quantityNumber(node.inputs.globeRadius, Math.min(width, height) * .41), centerX = quantityNumber(node.inputs.globeX, width / 2), centerY = quantityNumber(node.inputs.globeY, height / 2);
        if (geoDistance([longitude, latitude], [rotation, tilt]) > Math.PI / 2) return transparent(width, height);
        const projected = geoOrthographic().translate([centerX, centerY]).scale(globeRadius).rotate([-rotation, -tilt, 0])([longitude, latitude]); if (projected) [x, y] = projected;
        clip = `<clipPath id="waveclip"><circle cx="${centerX}" cy="${centerY}" r="${globeRadius}"/></clipPath>`;
      } else if (projectionName === "map") {
        [x, y] = referenceGeoMapPoint(width, height, { latitude, longitude });
      }
    }
    const max = quantityNumber(node.inputs.radius, Math.min(width, height) * .7); const progress = Math.max(0, Math.min(1, quantityNumber(propertyAt(this.ir, node, "reveal", time) ?? node.inputs.reveal, Math.min(1, rationalToNumber(local) / Math.max(.001, rationalToNumber(node.interval.duration)))))); const color = colorValue(node.inputs.color, "#ff6b45"); const count = Math.max(1, Math.min(12, Math.round(quantityNumber(node.inputs.count, 5))));
    const rings = Array.from({ length: count }, (_, index) => { const phase = (progress * 1.4 - index * .17 + 1) % 1; return `<circle cx="${x}" cy="${y}" r="${Math.max(0, phase * max)}" fill="none" stroke="${color}" stroke-width="${3 + (1 - phase) * 8}" opacity="${Math.max(0, (1 - phase) * .8)}"/>`; }).join("");
    return svgSurface(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs>${clip}</defs><g${clip ? ' clip-path="url(#waveclip)"' : ""}>${rings}</g></svg>`, width, height);
  }

  private async chart(node: IRNode, time: Rational) {
    const config = this.chartConfigs.get(node.id);
    if (!config) throw new Error(`Reference Chart ${node.id} has no validated configuration.`);
    const width = this.composition.width, height = this.composition.height;
    return svgSurface(referenceChartSvg(config, referenceChartRevealAt(this.ir, node, time), width, height), width, height);
  }

  private async seriesChart(node: IRNode, time: Rational) {
    const prepared = this.preparedSeriesCharts.get(node.id);
    if (!prepared) throw new ReferenceSeriesChartError("CUT_SERIES_CHART_IDENTITY", node, "was not prepared from its locked table and font resources");
    const value = propertyAt(this.ir, node, "reveal", time) ?? node.inputs.reveal;
    if (value !== undefined && (value.kind !== "quantity" || value.dimension !== "ratio" || value.unit !== "ratio")) {
      throw new ReferenceSeriesChartError("CUT_SERIES_CHART_REVEAL", node, "reveal must evaluate to an exact Ratio");
    }
    const progress = value?.kind === "quantity"
      ? rational(value.magnitude.numerator, value.magnitude.denominator)
      : rational(1);
    try {
      return await svgSurface(referenceSeriesChartSvg(prepared, Object.freeze({ format: "cut-series-chart-reveal", version: 1, progress })), this.composition.width, this.composition.height);
    } catch (error) {
      if (error instanceof CutSeriesChartError) throw new ReferenceSeriesChartError(error.code, node, error.message);
      throw error;
    }
  }

  private async analysisGraphic(node: IRNode, time: Rational) {
    const source = node.inputs.source; if (source?.kind !== "resource-ref") throw new Error(`${node.op} needs an audio resource.`);
    const input = this.paths.get(source.id)!, selected = lockedAudioSelection(this.ir, source.id), range = node.inputs.range;
    const start = range?.kind === "range" && range.start.kind === "quantity" ? range.start.magnitude : zeroRational;
    const end = range?.kind === "range" && range.end.kind === "quantity" ? range.end.magnitude : selected.duration;
    if (compareRational(end, start) <= 0) throw new Error(`${node.op} has a non-positive analysis range.`);
    const startSamples = multiplyRational(start, rational(selected.sampleRate)), endSamples = multiplyRational(end, rational(selected.sampleRate));
    if (startSamples.denominator !== "1" || endSamples.denominator !== "1") throw new Error(`${node.op} analysis range is not exact on the locked ${selected.sampleRate} Hz sample grid.`);
    const key = hash({ op: node.op, source: this.ir.resources[source.id].sha256, streamIndex: selected.streamIndex, sampleRate: selected.sampleRate, start, end, startSamples: startSamples.numerator, endSamples: endSamples.numerator, width: this.composition.width, height: this.composition.height }); const directory = await this.cacheDirectory("analysis"); const output = resolve(directory, `${key}.png`);
    const exists = await lstat(output).then((metadata) => metadata.isFile()).catch(() => false);
    if (!exists) {
      const visualization = node.op === "cut.data.spectrogram" ? `showspectrumpic=s=${this.composition.width}x${this.composition.height}:legend=disabled:color=fiery:scale=log` : `showwavespic=s=${this.composition.width}x${this.composition.height}:colors=0x55d6be`;
      const filter = `atrim=start_sample=${startSamples.numerator}:end_sample=${endSamples.numerator},asetpts=PTS-STARTPTS,${visualization}`;
      const staging = await mkdtemp(resolve(directory, ".cut-analysis-")), staged = resolve(staging, "analysis.png");
      try {
        await runFfmpeg(["-y", "-v", "error", "-i", input, "-filter_complex", `[0:${selected.streamIndex}]${filter}[analysis]`, "-map", "[analysis]", "-frames:v", "1", staged]);
        if (!(await lstat(staged)).isFile()) throw new Error(`${node.op} did not produce a regular analysis cache artifact.`);
        await publishStagedFile(staged, output);
      } finally { await rm(staging, { recursive: true, force: true }); }
    }
    const full = await sharp(output).ensureAlpha().raw().toBuffer(); const reveal = Math.max(0, Math.min(1, quantityNumber(propertyAt(this.ir, node, "reveal", time) ?? node.inputs.reveal, 1)));
    if (reveal <= 0) return transparent(this.composition.width, this.composition.height);
    const visibleWidth = Math.max(1, Math.round(this.composition.width * reveal)); const strip = await sharp(full, { raw: { width: this.composition.width, height: this.composition.height, channels: 4 } }).extract({ left: 0, top: 0, width: visibleWidth, height: this.composition.height }).raw().toBuffer(); const base = transparent(this.composition.width, this.composition.height); const data = await sharp(base.data, raw(base)).composite([{ input: strip, raw: { width: visibleWidth, height: this.composition.height, channels: 4 }, left: 0, top: 0 }]).raw().toBuffer(); return { data, width: this.composition.width, height: this.composition.height };
  }

  private localSpaceConfig(node: IRNode) {
    const config = this.localSpaceConfigs.get(node.id);
    if (!config) throw new ReferenceLocalSpaceError("CUT_LOCAL_SPACE_GRAPH", node, "has no validated reachable local-coordinate configuration.");
    return config;
  }

  private recordLocalNodeRasterization(config: ReferenceBoundedLocalRasterContext) {
    if ("contextKind" in config) return;
    const counters = this.activeLocalSpaceFrameEvidence?.counters;
    if (!counters) return;
    const pixels = config.width * config.height;
    counters.localNodeRasterizations += 1;
    counters.localNodePixelsRasterized += pixels;
    counters.localNodeRgbaBytesRasterized += pixels * 4;
  }

  private recordLocalPaintSurfaceCacheEvent(
    event: ReferenceLocalPaintSurfaceCacheEvent,
    config: ReferenceBoundedLocalRasterContext,
  ) {
    // Contextual retained rasters (for example DiagramNode tiles) own their
    // materialization evidence in the enclosing feature receipt. They share
    // the bounded paint cache, but are deliberately excluded from the parent
    // LocalSpace node-rasterization counters. Exclude their cache events from
    // that parent domain as well.
    if ("contextKind" in config) return;
    const counters = this.activeLocalSpaceFrameEvidence?.counters;
    if (!counters) return;
    if (event.kind === "hit") counters.localPaintSurfaceCacheHits += 1;
    else if (event.kind === "miss") counters.localPaintSurfaceCacheMisses += 1;
    else if (event.kind === "bypass") counters.localPaintSurfaceCacheBypasses += 1;
    else counters.localPaintSurfaceCacheEvictions += 1;
    counters.localPaintSurfaceCacheResidentBytes = event.residentBytes;
  }

  private localPaintSurfaceCacheKey(
    kind: ReferenceLocalPaintSurfaceCacheIdentityInput["kind"],
    svg: string,
    config: ReferenceBoundedLocalRasterContext,
    rasterContract: ReferenceLocalPaintSurfaceCacheIdentityInput["rasterContract"],
  ) {
    return referenceLocalPaintSurfaceCacheIdentity({
      kind,
      svg,
      width: config.width,
      height: config.height,
      rasterOriginQ16: config.rasterOriginQ16,
      localSpaceSemanticIdentity: config.semanticIdentity,
      backendIdentity: this.localPaintRasterBackendIdentity(),
      rasterContract,
      lockedResources: Object.freeze([]),
    });
  }

  private localPaintSurface(
    kind: ReferenceLocalPaintSurfaceCacheIdentityInput["kind"],
    svg: string,
    config: ReferenceBoundedLocalRasterContext,
    rasterContract: ReferenceLocalPaintSurfaceCacheIdentityInput["rasterContract"],
    materialize: () => Promise<RawSurface>,
  ) {
    const cache = this.rendererTreeContext.localPaintSurfaceCache;
    const pending = cache.request(
      this.localPaintSurfaceCacheKey(kind, svg, config, rasterContract),
      config.width * config.height * 4,
      async () => {
        const surface = await materialize();
        this.recordLocalNodeRasterization(config);
        return surface;
      },
      (event) => this.recordLocalPaintSurfaceCacheEvent(event, config),
    );
    return pending.then((surface) => {
      const counters = this.activeLocalSpaceFrameEvidence?.counters;
      if (counters) counters.localPaintSurfaceCacheResidentBytes = cache.residentBytes;
      return surface;
    });
  }

  private bypassLocalPaintSurfaceCache(config: ReferenceBoundedLocalRasterContext) {
    const cache = this.rendererTreeContext.localPaintSurfaceCache;
    this.recordLocalPaintSurfaceCacheEvent(Object.freeze({
      kind: "bypass",
      residentBytes: cache.residentBytes,
      entries: cache.entryCount,
    }), config);
    this.recordLocalNodeRasterization(config);
  }

  private localSpaceOrigin(config: ReferenceBoundedLocalRasterContext) {
    // The exact rational remains in config and every identity. One exact Q16
    // plan is shared by SVG-local coordinates and registered placement.
    return referenceLocalSpaceRasterOrigin(config);
  }

  private localComposition(config: ReferenceBoundedLocalRasterContext): IRComposition {
    return { ...this.composition, width: config.width, height: config.height };
  }

  private localPaintScanBounds(
    config: ReferenceBoundedLocalRasterContext,
    geometricBounds: Readonly<{ minX: number; minY: number; maxX: number; maxY: number }>,
  ) {
    const clipped = intersectReferenceRects(
      expandReferenceRect(referenceRect(
        geometricBounds.minX,
        geometricBounds.minY,
        geometricBounds.maxX,
        geometricBounds.maxY,
      ), 2),
      referenceRect(0, 0, config.width, config.height),
    );
    return clipped
      ? referenceIntegerRasterBounds(clipped)
      : Object.freeze({ left: 0, top: 0, right: 0, bottom: 0 });
  }

  private async localShapeSurface(node: IRNode, config: ReferenceBoundedLocalRasterContext) {
    const width = config.width, height = config.height, origin = this.localSpaceOrigin(config);
    const authoredCenterX = width / 2 - origin.x, authoredCenterY = height / 2 - origin.y;
    const x = quantityNumber(node.inputs.x, authoredCenterX) + origin.x;
    const y = quantityNumber(node.inputs.y, authoredCenterY) + origin.y;
    const shape = referenceShapeNodeConfig(this.ir, this.localComposition(config), node);
    if (shape?.kind === "rect") {
      const paint = shape.paint.kind === "linear-gradient" ? "url(#local-rect-gradient)" : shape.paint.color;
      const gradient = shape.paint.kind === "linear-gradient"
        ? `<linearGradient id="local-rect-gradient" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${shape.paint.from}"/><stop offset="1" stop-color="${shape.paint.to}"/></linearGradient>`
        : "";
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs>${gradient}</defs><rect x="${x - shape.width / 2}" y="${y - shape.height / 2}" width="${shape.width}" height="${shape.height}" rx="${shape.radius}" fill="${paint}"/></svg>`;
      const scanBounds = this.localPaintScanBounds(config, {
        minX: x - shape.width / 2,
        minY: y - shape.height / 2,
        maxX: x + shape.width / 2,
        maxY: y + shape.height / 2,
      });
      return this.localPaintSurface("shape", svg, config, "svg-density-144-resize-rgba8", async () => primeLocalPrivateAlphaBounds(
        await svgSurface(svg, width, height),
        scanBounds,
        this.rendererTreeContext.privateLocalPaintAlphaBoundsMode,
      ));
    }
    if (shape?.kind === "circle") {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><circle cx="${x}" cy="${y}" r="${shape.radius}" fill="${shape.paint.color}"/></svg>`;
      const scanBounds = this.localPaintScanBounds(config, {
        minX: x - shape.radius,
        minY: y - shape.radius,
        maxX: x + shape.radius,
        maxY: y + shape.radius,
      });
      return this.localPaintSurface("shape", svg, config, "svg-density-144-resize-rgba8", async () => primeLocalPrivateAlphaBounds(
        await svgSurface(svg, width, height),
        scanBounds,
        this.rendererTreeContext.privateLocalPaintAlphaBoundsMode,
      ));
    }
    const pointValues = arrayValue(node.inputs.points).flatMap((item) => {
      const entry = objectValue(item);
      return entry ? [{ x: quantityNumber(entry.x) + origin.x, y: quantityNumber(entry.y) + origin.y }] : [];
    });
    if (pointValues.length < 2) {
      throw new ReferenceLocalSpaceError("CUT_LOCAL_SPACE_RASTER", node, "legacy Path lost its validated point geometry before local rasterization.");
    }
    const points = pointValues.map((point) => `${point.x},${point.y}`).join(" ");
    const fill = colorValue(node.inputs.fill, "#ffffff"), stroke = colorValue(node.inputs.stroke, fill), strokeWidth = quantityNumber(node.inputs.width, 4);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><polyline points="${points}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    const scanBounds = this.localPaintScanBounds(config, {
      minX: Math.min(...pointValues.map((point) => point.x)) - strokeWidth / 2,
      minY: Math.min(...pointValues.map((point) => point.y)) - strokeWidth / 2,
      maxX: Math.max(...pointValues.map((point) => point.x)) + strokeWidth / 2,
      maxY: Math.max(...pointValues.map((point) => point.y)) + strokeWidth / 2,
    });
    return this.localPaintSurface("shape", svg, config, "svg-density-144-resize-rgba8", async () => primeLocalPrivateAlphaBounds(
      await svgSurface(svg, width, height),
      scanBounds,
      this.rendererTreeContext.privateLocalPaintAlphaBoundsMode,
    ));
  }

  private async localVectorPathSurface(node: IRNode, config: ReferenceBoundedLocalRasterContext, time: Rational) {
    const plan = this.vectorPathPlans.get(node.id);
    if (!plan) throw new ReferenceLocalSpaceError("CUT_LOCAL_SPACE_RASTER", node, "retained Path has no prepared public geometry plan.");
    const frame = referenceVectorPathFrameAt(this.ir, node, plan, time);
    const origin = this.localSpaceOrigin(config), bounds = {
      left: 0,
      top: 0,
      right: config.width,
      bottom: config.height,
      width: config.width,
      height: config.height,
      pixels: config.width * config.height,
    };
    const visible = referenceVectorPathVisibleBounds(frame, {
      ...referenceIdentityAffine2D,
      tx: origin.x,
      ty: origin.y,
    });
    const clipped = visible
      ? intersectReferenceRects(visible, referenceRect(0, 0, config.width, config.height))
      : undefined;
    const scanBounds = clipped
      ? referenceIntegerRasterBounds(clipped)
      : Object.freeze({ left: 0, top: 0, right: 0, bottom: 0 });
    const svg = referenceVectorPathTransformedSvg(frame, bounds, { a: 1, b: 0, c: 0, d: 1, tx: origin.x, ty: origin.y }, 1, node);
    const materialize = async () => {
      const rendered = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      if (rendered.info.width !== config.width || rendered.info.height !== config.height || rendered.info.channels !== 4) {
        throw new ReferenceLocalSpaceError("CUT_LOCAL_SPACE_RASTER", node, `backend returned ${rendered.info.width}x${rendered.info.height}x${rendered.info.channels} for declared ${config.width}x${config.height}x4 tile.`);
      }
      return primeLocalPrivateAlphaBounds(
        { data: rendered.data, width: config.width, height: config.height },
        scanBounds,
        this.rendererTreeContext.privateLocalPaintAlphaBoundsMode,
      );
    };
    if (plan.frameDynamic) {
      const surface = await materialize();
      this.bypassLocalPaintSurfaceCache(config);
      return surface;
    }
    return this.localPaintSurface("static-vector-path", svg, config, "svg-native-dimensions-rgba8", materialize);
  }

  /** Execute Trace directly in the declared LocalSpace tile. Coordinates are
   * translated by the LocalSpace's one Q16-derived raster origin before SVG
   * rasterization; no delivery-canvas Trace surface is created or cropped.
   * Returning undefined before delay lets the caller bypass both SVG work and
   * the subsequent local transform pass. */
  private async localTraceSurface(node: IRNode, config: ReferenceBoundedLocalRasterContext, time: Rational): Promise<RawSurface | undefined> {
    const local = subtractRational(time, node.interval.start);
    const delay = node.inputs.delay?.kind === "quantity" ? node.inputs.delay.magnitude : zeroRational;
    const duration = node.inputs.duration?.kind === "quantity" ? node.inputs.duration.magnitude : zeroRational;
    if (compareRational(local, delay) < 0) return undefined;

    const trace = this.tracePlans.get(node.id);
    if (!trace) throw new ReferenceLocalSpaceError("CUT_LOCAL_SPACE_RASTER", node, "Trace has no prepared public geometry for local-coordinate execution.");
    const position = subtractRational(local, delay), completed = compareRational(position, duration) >= 0;
    const easing = stringValue(node.inputs.easing, "linear") as ReferenceTraceEasing;
    const linearProgress = completed ? 1 : rationalToNumber(divideRational(position, duration));
    const prefix = referenceTracePrefixWithTangent(trace.trace, easeReferenceTrace(linearProgress, easing));
    const origin = this.localSpaceOrigin(config);
    const translate = (point: Readonly<{ x: number; y: number }>) => Object.freeze({ x: point.x + origin.x, y: point.y + origin.y });
    const localPoints = prefix.points.map(translate), localHead = translate(prefix.head);
    const polyline = localPoints.length < 2 ? "" : `<polyline points="${localPoints.map((point) => `${point.x},${point.y}`).join(" ")}" fill="none" stroke="${colorValue(node.inputs.stroke)}" stroke-width="${quantityNumber(node.inputs.width)}" stroke-linecap="round" stroke-linejoin="round"/>`;

    const headRadius = quantityNumber(node.inputs.headRadius, 0);
    const headFade = node.inputs.headFade?.kind === "quantity" ? node.inputs.headFade.magnitude : rational(3, 25);
    const sinceCompletion = completed ? subtractRational(position, duration) : zeroRational;
    const headOpacity = headRadius <= 0 ? 0
      : !completed ? 1
        : compareRational(headFade, zeroRational) <= 0 || compareRational(sinceCompletion, headFade) >= 0 ? 0
          : 1 - rationalToNumber(divideRational(sinceCompletion, headFade));
    const head = headOpacity <= 0 ? "" : `<circle cx="${localHead.x}" cy="${localHead.y}" r="${headRadius}" fill="${colorValue(node.inputs.headColor, colorValue(node.inputs.stroke))}" fill-opacity="${headOpacity}"/>`;
    const arrow = trace.arrow ? (() => {
      const tip = localHead, tangent = prefix.tangent;
      const baseX = tip.x - tangent.x * trace.arrow!.length, baseY = tip.y - tangent.y * trace.arrow!.length;
      const halfWidth = trace.arrow!.width / 2, perpendicularX = -tangent.y * halfWidth, perpendicularY = tangent.x * halfWidth;
      return `<polygon points="${tip.x},${tip.y} ${baseX + perpendicularX},${baseY + perpendicularY} ${baseX - perpendicularX},${baseY - perpendicularY}" fill="${trace.arrow!.color}"/>`;
    })() : "";
    return svgSurface(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${config.width}" height="${config.height}" viewBox="0 0 ${config.width} ${config.height}">${polyline}${head}${arrow}</svg>`,
      config.width,
      config.height,
    );
  }

  private skippedRetainedMediaV2Subtree(
    config: ReferenceBoundedLocalRasterContext,
    nodeId: string,
    nodeReason: "inactive-node" | "opacity-zero",
    ancestorReason: "ancestor-inactive" | "ancestor-opacity-zero",
  ): Pick<ReferenceLocalNodeFrameResult, "sourceOverSteps" | "directChildSkipReason" | "materializations" | "operations"> {
    if ("contextKind" in config || !config.retainedMediaLocalCompositor) {
      return Object.freeze({ sourceOverSteps: 0, directChildSkipReason: nodeReason, materializations: Object.freeze([]), operations: Object.freeze([]) });
    }
    const plan = config.retainedMediaLocalCompositor;
    const root = plan.tree.find((entry) => entry.nodeId === nodeId);
    if (!root) return Object.freeze({ sourceOverSteps: 0, directChildSkipReason: nodeReason, materializations: Object.freeze([]), operations: Object.freeze([]) });
    const within = (path: readonly number[]) => root.traversalPath.every((part, index) => path[index] === part);
    const materializations = Object.freeze(plan.islands
      .filter((island) => within(island.traversalPath))
      .map((island) => Object.freeze({
        rootId: island.rootId,
        status: "skipped" as const,
        skipReason: island.rootId === nodeId ? nodeReason : ancestorReason,
      })));
    const operationByNode = new Map(plan.operationExecutionPlan.map((operation) => [operation.nodeId, operation]));
    const treeByNode = new Map(plan.tree.map((entry) => [entry.nodeId, entry]));
    const operations: ReferenceRetainedMediaLocalOperationRuntime[] = [];
    const visit = (currentId: string) => {
      const tree = treeByNode.get(currentId);
      if (!tree || tree.role === "materialization-island" || !within(tree.traversalPath)) return;
      for (const childId of tree.childIds) visit(childId);
      const planned = operationByNode.get(currentId);
      if (planned) operations.push(Object.freeze({
        executionPostorder: planned.executionPostorder,
        nodeId: planned.nodeId,
        op: planned.op,
        status: "skipped" as const,
        skipReason: planned.nodeId === nodeId ? nodeReason : ancestorReason,
      }));
    };
    visit(nodeId);
    return Object.freeze({ sourceOverSteps: 0, directChildSkipReason: nodeReason, materializations, operations: Object.freeze(operations) });
  }

  private async localNodeFrameResult(
    nodeId: string,
    config: ReferenceBoundedLocalRasterContext,
    time: Rational,
    frame: number,
  ): Promise<ReferenceLocalNodeFrameResult> {
    const node = this.ir.nodes[nodeId];
    if (!node) return Object.freeze({ sourceOverSteps: 0, directChildSkipReason: "no-visible-local-surface", materializations: Object.freeze([]), operations: Object.freeze([]) });
    if (!this.active(node, time)) {
      this.recordLocalSpaceSkip(node, "inactive-node", "outside-interval", undefined, time);
      return Object.freeze({
        ...this.skippedRetainedMediaV2Subtree(config, node.id, "inactive-node", "ancestor-inactive"),
      });
    }
    if (!("contextKind" in config)) {
      const retainedPlan = referenceLocalSpaceRetainedMediaMaterializationForRoot(config, node.id);
      if (retainedPlan) {
        const rendered = await this.retainedMediaViewportFrame(config, retainedPlan, time);
        return Object.freeze({
          ...(rendered.surface ? { surface: rendered.surface } : {}),
          sourceOverSteps: 0,
          ...(!rendered.surface ? { directChildSkipReason: rendered.execution.skipReason ?? "no-visible-local-surface" } : {}),
          materializations: Object.freeze([rendered.execution]),
          operations: Object.freeze([]),
        });
      }
    }
    if (node.op === "cut.visual.local_space") {
      const nestedConfig = this.localSpaceConfig(node), plan = this.activeAffineLocalSpacePlan(config.nodeId, nestedConfig.nodeId, time);
      if (plan.status !== "visible" || !plan.placement || !plan.transformWork) {
        throw new ReferenceLocalSpaceError("CUT_LOCAL_SPACE_RASTER", node, `nested LocalSpace ${nestedConfig.nodeId} has no visible affine admission.`);
      }
      const nested = await this.localSpaceTile(nestedConfig, time, frame);
      return Object.freeze({
        surface: await this.placeLocalSpaceTile(
          nestedConfig, nested, plan.placement, config.width, config.height, time, nested,
          {
            sourceNode: this.ir.nodes[config.nodeId]!,
            admittedWork: plan.transformWork,
            ...(plan.scaleTranslationPlan ? { scaleTranslationPlan: plan.scaleTranslationPlan } : {}),
          },
        ),
        sourceOverSteps: 0,
        materializations: Object.freeze([]),
        operations: Object.freeze([]),
      });
    }
    if (node.op === "cut.visual.group" && node.children.length === 1) {
      const nestedNode = this.ir.nodes[node.children[0]];
      if (nestedNode?.op === "cut.visual.local_space") {
        const nestedConfig = this.localSpaceConfig(nestedNode), plan = this.activeAffineLocalSpacePlan(node.id, nestedConfig.nodeId, time);
        if (plan.status !== "visible") {
          this.recordLocalSpaceSkip(nestedNode, "owner-opacity", "opacity-zero", node.id, time);
          return Object.freeze({ sourceOverSteps: 0, directChildSkipReason: "descendant-suppressed", materializations: Object.freeze([]), operations: Object.freeze([]) });
        }
        if (!plan.placement || !plan.transformWork) throw new ReferenceLocalSpaceError("CUT_LOCAL_SPACE_RASTER", node, `nested Group affine plan for ${nestedConfig.nodeId} is incomplete.`);
        const nested = await this.localSpaceTile(nestedConfig, time, frame);
        return Object.freeze({
          surface: await this.placeLocalSpaceTile(
            nestedConfig, nested, plan.placement, config.width, config.height, time, nested,
            {
              sourceNode: node,
              admittedWork: plan.transformWork,
              ...(plan.scaleTranslationPlan ? { scaleTranslationPlan: plan.scaleTranslationPlan } : {}),
            },
          ),
          sourceOverSteps: 0,
          materializations: Object.freeze([]),
          operations: Object.freeze([]),
        });
      }
    }

    const transformOwnership = referenceGenericVisualTransformOwnership(node);
    const localComposition = this.localComposition(config);
    const transform = referenceVisualTransformAt(
      this.ir,
      localComposition,
      node,
      time,
      transformOwnership,
      this.preparedSignalResolver,
    );
    if (node.op === "cut.visual.motion_path") {
      if (this.anchoredMotionPathPlans.has(node.id)) {
        throw new ReferenceLocalSpaceError(
          "CUT_LOCAL_SPACE_UNSUPPORTED",
          node,
          "anchored MotionPath geometry reached local raster execution despite the closed local-coordinate admission.",
        );
      }
      const path = referenceMotionPathAt(this.ir, localComposition, node, time, this.motionPathPlan(node));
      const origin = this.localSpaceOrigin(config);
      // MotionPath's public direct-canvas sampler returns a centre-relative
      // destination from authored pixel coordinates. LocalSpace coordinates
      // are authored relative to its declared origin, so translate that exact
      // Q16-derived origin before applying the common retained transform.
      transform.x += path.x + origin.x;
      transform.y += path.y + origin.y;
      transform.rotation += path.rotation;
      validateReferenceVisualTransformAllocation(node, localComposition, transform);
    }
    if (transform.opacity === 0) {
      this.recordLocalSpaceSkip(node, "local-node-opacity", "opacity-zero", undefined, time);
      return Object.freeze({
        ...this.skippedRetainedMediaV2Subtree(config, node.id, "opacity-zero", "ancestor-opacity-zero"),
      });
    }
    let surface: RawSurface;
    const materializations: ReferenceRetainedMediaMaterializationRuntime[] = [];
    const operations: ReferenceRetainedMediaLocalOperationRuntime[] = [];
    let sourceOverSteps = 0;
    const append = (result: ReferenceLocalNodeFrameResult) => {
      materializations.push(...result.materializations);
      operations.push(...result.operations);
      sourceOverSteps += result.sourceOverSteps;
      return result.surface;
    };
    if (node.op === "cut.kernel.fragment"
      || node.op === "cut.visual.group"
      || node.op === "cut.visual.motion_path") {
      let result = localPrivateAccumulator(config.width, config.height);
      for (const childId of node.children) {
        const child = append(await this.localNodeFrameResult(childId, config, time, frame));
        if (child) {
          result = compositeIntoLocalPrivateAccumulator(
            result,
            child,
            "normal",
            this.rendererTreeContext.privateStraightCompositeDiagnostic,
          );
          sourceOverSteps += 1;
        }
      }
      surface = result;
    } else if (node.op === "cut.visual.composite") {
      let result = localPrivateAccumulator(config.width, config.height);
      const mode = this.compositeModes.get(node.id);
      if (!mode) throw new ReferenceLocalSpaceError("CUT_LOCAL_SPACE_RASTER", node, "Composite has no admitted blend-mode configuration.");
      // Authored child order is semantic. Keep execution serialized so a
      // future stateful child cannot race ahead of the layer it follows.
      for (const childId of node.children) {
        const child = append(await this.localNodeFrameResult(childId, config, time, frame));
        if (child) {
          result = compositeIntoLocalPrivateAccumulator(
            result,
            child,
            mode,
            this.rendererTreeContext.privateStraightCompositeDiagnostic,
          );
          sourceOverSteps += 1;
        }
      }
      surface = result;
    } else if (node.op === "cut.visual.mask") {
      const mask = this.maskConfigs.get(node.id);
      if (!mask) throw new ReferenceLocalSpaceError("CUT_LOCAL_SPACE_RASTER", node, "Mask has no admitted exact-tile configuration.");
      const target = append(await this.localNodeFrameResult(node.children[0]!, config, time, frame)) ?? transparent(config.width, config.height);
      const matte = append(await this.localNodeFrameResult(node.children[1]!, config, time, frame)) ?? transparent(config.width, config.height);
      surface = rgbaResultSurface(applyMaskRgba(target, matte, {
        mode: mask.mode,
        invert: mask.invert,
        featherPx: mask.featherPx,
        expandPx: mask.expandPx,
      }));
    } else if (node.op === "cut.visual.clip_path") {
      const child = append(await this.localNodeFrameResult(node.children[0]!, config, time, frame)) ?? transparent(config.width, config.height);
      const plan = this.clipPathPlans.get(node.id);
      if (!plan || plan.width !== config.width || plan.height !== config.height) {
        throw new ReferenceLocalSpaceError("CUT_LOCAL_SPACE_RASTER", node, `ClipPath has no admitted ${config.width}x${config.height} local coverage plan.`);
      }
      surface = rgbaResultSurface(applyReferenceClipPath(child, plan));
    } else if (node.op === "cut.visual.color_grade") {
      const child = append(await this.localNodeFrameResult(node.children[0]!, config, time, frame)) ?? transparent(config.width, config.height);
      surface = canonicalLocalStraightRgba(await this.colorGrade(node, child, time));
    } else if (this.visualEffects.has(node.id)) {
      const effect = this.visualEffects.get(node.id)!;
      if (effect.kind === "shadow" || effect.kind === "glow") {
        throw new ReferenceLocalSpaceError("CUT_LOCAL_SPACE_UNSUPPORTED", node, "halo effects reached LocalSpace execution despite the closed V1 bounds-policy refusal.");
      }
      const child = append(await this.localNodeFrameResult(node.children[0]!, config, time, frame)) ?? transparent(config.width, config.height);
      surface = await applyReferenceVisualEffect(effect, child, { frame: this.outputFrameIndex });
    } else if (node.op === "cut.visual.path" && node.inputs.geometry !== undefined) {
      surface = await this.localVectorPathSurface(node, config, time);
    } else if (node.op === "cut.visual.trace") {
      const traced = await this.localTraceSurface(node, config, time);
      if (!traced) return Object.freeze({
        sourceOverSteps,
        directChildSkipReason: "no-visible-local-surface" as const,
        materializations: Object.freeze(materializations),
        operations: Object.freeze(operations),
      });
      surface = traced;
      this.recordLocalNodeRasterization(config);
    } else if (node.op === "cut.visual.rect" || node.op === "cut.visual.circle" || node.op === "cut.visual.path") {
      surface = await this.localShapeSurface(node, config);
    } else if (node.op === "cut.visual.text") {
      surface = await this.localTextSurface(node, config);
    } else if (node.op === "cut.visual.flow_text") {
      surface = await this.localFlowTextSurface(node, config, subtractRational(time, node.interval.start));
    } else {
      throw new ReferenceLocalSpaceError("CUT_LOCAL_SPACE_UNSUPPORTED", node, `${node.op} reached local raster execution without a public checkpoint-1 implementation.`);
    }

    const anchorAware = (node.op === "cut.visual.group" || node.op === "cut.visual.motion_path")
      && (quantityNumber(node.inputs.anchorX) !== 0 || quantityNumber(node.inputs.anchorY) !== 0 || Object.hasOwn(node.properties, "anchorX") || Object.hasOwn(node.properties, "anchorY"));
    const transformed = await placeOnCanvas(
      surface,
      config.width,
      config.height,
      transform.x,
      transform.y,
      transform.scale,
      transform.rotation,
      transform.skewX,
      transform.skewY,
      transform.anchorX,
      transform.anchorY,
      anchorAware,
      true,
    );
    const finalSurface = scaleLocalSpaceAlpha(
      transformed,
      transform.opacity,
      this.rendererTreeContext.retainedAlphaScaleDiagnostic,
    );
    if (!("contextKind" in config)) {
      const plannedOperation = config.retainedMediaLocalCompositor?.operationExecutionPlan.find((operation) => operation.nodeId === node.id);
      if (plannedOperation) operations.push(Object.freeze({
        executionPostorder: plannedOperation.executionPostorder,
        nodeId: node.id,
        op: plannedOperation.op,
        status: "rendered" as const,
        outputRgbaSha256: createHash("sha256").update(finalSurface.data).digest("hex"),
        outputRgbaBytes: finalSurface.data.byteLength,
      }));
    }
    return Object.freeze({
      surface: finalSurface,
      sourceOverSteps,
      materializations: Object.freeze(materializations),
      operations: Object.freeze(operations),
    });
  }

  private async localNodeFrame(nodeId: string, config: ReferenceBoundedLocalRasterContext, time: Rational, frame: number): Promise<RawSurface | undefined> {
    return (await this.localNodeFrameResult(nodeId, config, time, frame)).surface;
  }

  private async responsiveStackFrame(node: IRNode, time: Rational, frame: number) {
    const config = this.responsiveStackConfigs.get(node.id);
    if (!config) throw new ReferenceResponsiveStackError("CUT_RESPONSIVE_STACK_GRAPH", node, "has no validated composition-bound execution configuration.");
    if (!this.activeResponsiveStackFrameEvidence) {
      throw new ReferenceResponsiveStackError("CUT_RESPONSIVE_STACK_GRAPH", node, "reached pixels outside an active transactional scene-frame evidence generation.");
    }
    const placedSlots: RawSurface[] = [];
    const evidenceSlots: ReferenceResponsiveStackFrameSlotEvidence[] = [];
    const backendIdentity = this.localSpaceBackendIdentity();
    for (const slot of config.slots) {
      const mediaPlan = slot.mediaCamera2D
        ? this.mediaCamera2DConfigs.get(slot.mediaCamera2D.cameraNodeId)
        : undefined;
      const mediaFramePlan = slot.mediaCamera2D
        ? this.activeMediaCamera2DFramePlans.get(slot.mediaCamera2D.cameraNodeId)
        : undefined;
      if (slot.mediaCamera2D && (!mediaPlan || !mediaFramePlan || mediaPlan.outputContext.kind !== "responsive-slot")) {
        const camera = this.ir.nodes[slot.mediaCamera2D.cameraNodeId] ?? node;
        throw new ReferenceResponsiveStackError(
          "CUT_RESPONSIVE_STACK_GRAPH",
          camera,
          "slot-bound MediaCamera2D reached rasterization without its validated static and exact-frame native output plans.",
        );
      }
      const tileIdentity = hash({
        kind: "responsive-slot-tile",
        algorithm: config.execution.algorithm,
        semanticIdentity: slot.context.semanticIdentity,
        exactTime: `${time.numerator}/${time.denominator}`,
        backendIdentity,
        ...(mediaPlan && mediaFramePlan ? {
          mediaCamera2D: Object.freeze({
            outputContextIdentity: mediaPlan.outputContext.semanticIdentity,
            staticPlanIdentity: mediaPlan.semanticIdentity,
            framePlanIdentity: mediaFramePlan.planIdentity,
            backendIdentity: mediaPlan.backendIdentity,
          }),
        } : {}),
      });
      let pending = this.responsiveSlotTileMemo.get(tileIdentity);
      if (!pending) {
        pending = (async () => {
          if (slot.mediaCamera2D) {
            const camera = this.ir.nodes[slot.mediaCamera2D.cameraNodeId];
            if (!camera) throw new ReferenceResponsiveStackError("CUT_RESPONSIVE_STACK_GRAPH", node, `lost slot-bound MediaCamera2D ${slot.mediaCamera2D.cameraNodeId}.`);
            const rendered = await this.mediaCamera2DFrame(camera, time);
            if (rendered.width !== slot.context.width || rendered.height !== slot.context.height) {
              throw new ReferenceResponsiveStackError(
                "CUT_RESPONSIVE_STACK_OVERFLOW",
                camera,
                `native camera produced ${rendered.width}x${rendered.height}; its quantized ResponsiveSlot is ${slot.context.width}x${slot.context.height}.`,
              );
            }
            return rendered;
          }
          const child = await this.localNodeFrame(slot.childId, slot.context, time, frame);
          return compositeStraightLayers(slot.context.width, slot.context.height, [child]);
        })();
        this.responsiveSlotTileMemo.set(tileIdentity, pending);
        pending.catch(() => this.responsiveSlotTileMemo.delete(tileIdentity));
      }
      const tile = await pending;
      let visibleAlphaPixels = 0;
      for (let offset = 3; offset < tile.data.length; offset += 4) if (tile.data[offset] > 0) visibleAlphaPixels += 1;
      const flowText = Object.freeze(slot.descendantIds.flatMap((nodeId) => {
        const prepared = this.preparedFlowTexts.get(nodeId);
        return prepared ? [Object.freeze({ nodeId, lineCount: prepared.lineCount, maxWidth: prepared.config.maxWidth })] : [];
      }));
      let mediaCamera2D: ReferenceResponsiveStackFrameSlotEvidence["mediaCamera2D"];
      let placed: RawSurface | undefined;
      if (slot.mediaCamera2D && mediaPlan && mediaFramePlan) {
        const completed = this.activeMediaCamera2DFrameEvidence?.filter(
          (candidate) => candidate.cameraNodeId === slot.mediaCamera2D!.cameraNodeId
            && candidate.framePlanIdentity === mediaFramePlan.planIdentity,
        ) ?? [];
        if (completed.length !== 1) {
          const camera = this.ir.nodes[slot.mediaCamera2D.cameraNodeId] ?? node;
          throw new ReferenceResponsiveStackError(
            "CUT_RESPONSIVE_STACK_IDENTITY",
            camera,
            `expected exactly one completed native camera receipt for slot tile ${tileIdentity}; found ${completed.length}.`,
          );
        }
        const cameraEvidence = completed[0]!;
        const tileRgbaSha256 = createHash("sha256").update(tile.data).digest("hex");
        if (cameraEvidence.outputRgbaSha256 !== tileRgbaSha256
          || cameraEvidence.outputContext.semanticIdentity !== mediaPlan.outputContext.semanticIdentity
          || cameraEvidence.outputContext.kind !== "responsive-slot") {
          const camera = this.ir.nodes[slot.mediaCamera2D.cameraNodeId] ?? node;
          throw new ReferenceResponsiveStackError(
            "CUT_RESPONSIVE_STACK_IDENTITY",
            camera,
            "native camera output pixels or output-context authority diverged before ResponsiveStack placement.",
          );
        }
        let placementStatus: "placed" | "skipped-opacity-zero";
        let placementSurfaceCount: 0 | 1;
        let placedRgbaSha256: string | undefined;
        if (cameraEvidence.status === "opacity-zero") {
          placementStatus = "skipped-opacity-zero";
          placementSurfaceCount = 0;
        } else {
          placed = (await placeRegisteredSurfaceOnCanvas(
            tile,
            this.composition.width,
            this.composition.height,
            0,
            0,
            slot.context.rasterSlot.left,
            slot.context.rasterSlot.top,
            1,
            0,
          )).surface;
          placementStatus = "placed";
          placementSurfaceCount = 1;
          placedRgbaSha256 = createHash("sha256").update(placed.data).digest("hex");
        }
        const placementReceipt = Object.freeze({
          algorithmVersion: referenceResponsiveStackMediaPlacementAlgorithm,
          status: placementStatus,
          source: Object.freeze({
            width: tile.width,
            height: tile.height,
            rgbaSha256: tileRgbaSha256,
          }),
          destination: slot.context.rasterSlot,
          clip: "half-open-raster-slot" as const,
          geometricResampleCount: 0 as const,
          placementSurfaceCount,
          ...(placedRgbaSha256 ? { placedRgbaSha256 } : {}),
        });
        const placement = Object.freeze({
          ...placementReceipt,
          placementIdentity: hash(placementReceipt),
        });
        const mediaReceipt = Object.freeze({
          cameraNodeId: cameraEvidence.cameraNodeId,
          status: cameraEvidence.status,
          backendIdentity: cameraEvidence.backendIdentity,
          outputContextIdentity: mediaPlan.outputContext.semanticIdentity,
          staticPlanIdentity: mediaPlan.semanticIdentity,
          framePlanIdentity: cameraEvidence.framePlanIdentity,
          cameraExecutionIdentity: cameraEvidence.executionIdentity,
          source: Object.freeze({
            resourceId: cameraEvidence.source.resourceId,
            sha256: cameraEvidence.source.sha256,
            selectedVariant: cameraEvidence.source.selectedVariant,
            leafKind: cameraEvidence.source.leafKind,
          }),
          controlsIdentity: hash(cameraEvidence.controls),
          workIdentity: hash(cameraEvidence.work),
          allocationsIdentity: hash(cameraEvidence.allocations),
          outputRgbaSha256: cameraEvidence.outputRgbaSha256,
          placement,
        });
        mediaCamera2D = Object.freeze({
          ...mediaReceipt,
          semanticIdentity: hash(mediaReceipt),
        });
      } else {
        placed = (await placeRegisteredSurfaceOnCanvas(
          tile,
          this.composition.width,
          this.composition.height,
          0,
          0,
          slot.context.rasterSlot.left,
          slot.context.rasterSlot.top,
          1,
          0,
        )).surface;
      }
      evidenceSlots.push(Object.freeze({
        index: slot.context.index,
        slotNodeId: slot.slotNodeId,
        childId: slot.childId,
        exactSlot: slot.context.exactSlot,
        rasterSlot: slot.context.rasterSlot,
        semanticIdentity: slot.context.semanticIdentity,
        tileIdentity,
        rgbaSha256: createHash("sha256").update(tile.data).digest("hex"),
        visibleAlphaPixels,
        flowText,
        ...(mediaCamera2D ? { mediaCamera2D } : {}),
      }));
      if (placed) placedSlots.push(placed);
    }
    const surface = compositeStraightLayers(this.composition.width, this.composition.height, placedSlots);
    const receipt = Object.freeze({
      format: "cut-reference-responsive-stack-frame-evidence" as const,
      version: 1 as const,
      evidenceKind: "completed-public-responsive-stack-frame" as const,
      algorithmVersion: config.execution.algorithm,
      compositionId: this.composition.id,
      nodeId: node.id,
      exactTime: Object.freeze({ ...time }),
      outputFrame: String(this.outputFrameIndex),
      planIdentity: config.plan.id,
      axis: config.plan.axis,
      rasterPolicy: config.execution.rasterPolicy,
      slots: Object.freeze(evidenceSlots),
      outputRgbaSha256: createHash("sha256").update(surface.data).digest("hex"),
    });
    this.activeResponsiveStackFrameEvidence.push(Object.freeze({
      ...receipt,
      executionIdentity: hash(receipt),
    }));
    return surface;
  }

  private persistentDiagramRasterCache() {
    this.diagramRasterCache ??= createReferenceDiagramRasterCache({
      projectRoot: this.projectRoot,
      cacheRoot: this.cacheRoot,
    });
    return this.diagramRasterCache;
  }

  private diagramRasterCacheKey(input: ReferenceDiagramRasterCacheIdentityInput) {
    return referenceDiagramRasterCacheIdentity(input).key;
  }

  private recordDiagramRasterCacheReceipt(
    counters: MutableReferenceDiagramLayoutCounters,
    receipt: ReferenceDiagramRasterCacheReceipt,
  ) {
    counters.persistentLookups += receipt.counters.persistentLookups;
    counters.persistentHits += receipt.counters.persistentHits;
    counters.persistentMisses += receipt.counters.persistentMisses;
    counters.sameProcessCoalescedWaits += receipt.counters.sameProcessCoalescedWaits;
    counters.persistentBuilderExecutions += receipt.counters.builderExecutions;
    counters.persistentBytesRead += receipt.counters.bytesRead;
    counters.persistentBytesWritten += receipt.counters.bytesWritten;
    counters.persistentManifestsValidated += receipt.counters.manifestsValidated;
    counters.persistentEvictedEntries += receipt.counters.evictedEntries;
    counters.persistentEvictedBytes += receipt.counters.evictedBytes;
  }

  private diagramTraceTemporalState(node: IRNode, time: Rational) {
    const local = subtractRational(time, node.interval.start);
    const delay = node.inputs.delay?.kind === "quantity" ? node.inputs.delay.magnitude : zeroRational;
    const duration = node.inputs.duration?.kind === "quantity" ? node.inputs.duration.magnitude : zeroRational;
    if (compareRational(local, delay) < 0) return Object.freeze({ phase: "before-delay" as const });

    const position = subtractRational(local, delay);
    if (compareRational(position, duration) < 0) {
      return Object.freeze({ phase: "drawing" as const, position: Object.freeze({ ...position }) });
    }

    const headRadius = quantityNumber(node.inputs.headRadius, 0);
    const headFade = node.inputs.headFade?.kind === "quantity" ? node.inputs.headFade.magnitude : rational(3, 25);
    const sinceCompletion = subtractRational(position, duration);
    if (headRadius <= 0 || compareRational(headFade, zeroRational) <= 0 || compareRational(sinceCompletion, headFade) >= 0) {
      return Object.freeze({ phase: "settled" as const });
    }
    return Object.freeze({ phase: "head-fade" as const, sinceCompletion: Object.freeze({ ...sinceCompletion }) });
  }

  /**
   * Bind a DiagramNode raster to values that can actually change its bounded
   * pixels. The supported operation set is closed during context validation;
   * the default branch remains an exact-time/frame fallback so admitting a new
   * operation cannot accidentally inherit reuse before its temporal contract
   * is implemented here.
   */
  private diagramNodeTemporalIdentity(
    context: ReferenceDiagramNodeLocalContext,
    time: Rational,
    frame: number,
  ) {
    if (context.temporalRasterMode === "static") return hash({ kind: "diagram-node-static-time-v2" });

    const states: unknown[] = [], visited = new Set<string>(), pending = [...context.childIds].reverse();
    while (pending.length) {
      const nodeId = pending.pop()!;
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);
      const node = this.ir.nodes[nodeId];
      if (!node) {
        states.push(Object.freeze({ nodeId, missing: true, exactTime: time, frame }));
        continue;
      }
      pending.push(...[...node.children].reverse());
      const active = this.active(node, time);
      if (!active) {
        states.push(Object.freeze({ op: node.op, active: false }));
        continue;
      }
      const properties = Object.freeze(Object.fromEntries(Object.keys(node.properties).sort().map((name) => [
        name,
        propertyAt(this.ir, node, name, time, this.preparedSignalResolver),
      ])));
      let intrinsic: unknown;
      switch (node.op) {
        case "cut.visual.trace":
          intrinsic = this.diagramTraceTemporalState(node, time);
          break;
        case "cut.visual.flow_text": {
          const prepared = this.preparedFlowTexts.get(node.id);
          if (!prepared && node.inputs.motions !== undefined) {
            intrinsic = Object.freeze({ kind: "conservative-sampled-time", exactTime: time, frame });
          } else if (prepared?.motions.length) {
            intrinsic = Object.freeze({
              kind: prepared.complexShaping ? "flow-text-svg-v2-complex" : "flow-text-svg-v1",
              svgIdentity: hash(referenceFlowTextSvg(
                prepared,
                subtractRational(time, node.interval.start),
                context.width,
                context.height,
                this.localSpaceOrigin(context),
              )),
            });
          } else intrinsic = Object.freeze({ kind: "static" });
          break;
        }
        case "cut.kernel.fragment":
        case "cut.visual.group":
        case "cut.visual.rect":
        case "cut.visual.circle":
        case "cut.visual.path":
        case "cut.visual.text":
          intrinsic = Object.freeze({ kind: "static" });
          break;
        default:
          intrinsic = Object.freeze({ kind: "conservative-sampled-time", exactTime: time, frame });
          break;
      }
      states.push(Object.freeze({ op: node.op, active: true, properties, intrinsic }));
    }
    return hash({ kind: "diagram-node-visual-dependencies-v2", states });
  }

  private diagramNodeTile(
    frameNode: ReferenceDiagramLayoutFrame["nodes"][number],
    time: Rational,
    frame: number,
    counters: MutableReferenceDiagramLayoutCounters,
  ) {
    const context = this.diagramNodeContexts.get(frameNode.irNodeId);
    const diagramNode = this.ir.nodes[frameNode.irNodeId];
    if (!context || !diagramNode) {
      if (!diagramNode) throw new Error(`CUT_DIAGRAM_BOUNDS: prepared DiagramNode ${frameNode.irNodeId} is missing from IR.`);
      return referenceDiagramRenderFailure("CUT_DIAGRAM_BOUNDS", diagramNode, "has no validated bounded local raster context.");
    }
    if (context.semanticIdentity !== frameNode.localRasterContext.semanticIdentity) {
      return referenceDiagramRenderFailure("CUT_DIAGRAM_BOUNDS", diagramNode, "runtime planner context diverged from constructor validation.");
    }
    const cacheIdentity: ReferenceDiagramRasterCacheIdentityInput = {
      kind: "node-tile" as const,
      width: context.width,
      height: context.height,
      splitIdentities: Object.freeze({
        topology: hash({
          kind: "diagram-node-topology-v1",
          algorithmVersion: referenceDiagramLayoutAlgorithmVersion,
          orderedOps: context.childIds.map((childId) => this.ir.nodes[childId]?.op ?? "missing"),
        }),
        geometry: hash({
          kind: "diagram-node-local-geometry-v1",
          width: context.width,
          height: context.height,
          origin: context.origin,
          rasterOriginQ16: context.rasterOriginQ16,
          view: context.view,
        }),
        paint: hash({
          kind: "diagram-node-paint-v1",
          subtreePaintIdentity: context.subtreePaintIdentity,
        }),
        temporal: this.diagramNodeTemporalIdentity(context, time, frame),
      }),
      backendIdentity: this.diagramRasterBackendIdentity(),
      runtimeIdentity: cutReferenceRuntimeIdentity,
    };
    const tileIdentity = this.diagramRasterCacheKey(cacheIdentity);
    counters.nodeTileRequests += 1;
    let pending = this.diagramNodeTileMemo.get(tileIdentity);
    const memoHit = Boolean(pending);
    if (!pending) {
      pending = (async () => {
        const cache = await this.persistentDiagramRasterCache();
        const result = await cache.materialize(cacheIdentity, async () => {
          let surface = transparent(context.width, context.height);
          for (const childId of context.childIds) {
            const child = await this.localNodeFrame(childId, context, time, frame);
            surface = compositeStraightLayers(context.width, context.height, [surface, child]);
          }
          return surface;
        });
        return Object.freeze({ surface: result.surface, receipt: result.receipt });
      })();
      this.diagramNodeTileMemo.set(tileIdentity, pending);
      pending.catch(() => this.diagramNodeTileMemo.delete(tileIdentity));
    } else counters.nodeTileMemoHits += 1;
    return Object.freeze({ tileIdentity, rasterCacheKey: tileIdentity, pending, context, memoHit });
  }

  private referenceDiagramEdgeRasterPlan(
    layoutNode: IRNode,
    edge: ReferenceDiagramLayoutFrame["edges"][number],
  ) {
    if (edge.trimEndQ16 <= 0) return Object.freeze({
      transparent: true as const,
      bounds: Object.freeze({ left: 0, top: 0, width: 1, height: 1 }),
      markup: "",
    });
    const fullPoints = edge.pointsQ16.map(referenceDiagramPointPixels);
    const trace = prepareReferenceTrace(fullPoints);
    const prefix = referenceTracePrefixWithTangent(trace, edge.trimEndQ16 / referenceDiagramLayoutQ16Scale);
    const plannedHead = edge.visiblePointsQ16.at(-1);
    if (!plannedHead || Math.abs(prefix.head.x - plannedHead.xQ16 / referenceDiagramLayoutQ16Scale) > 1 / referenceDiagramLayoutQ16Scale
      || Math.abs(prefix.head.y - plannedHead.yQ16 / referenceDiagramLayoutQ16Scale) > 1 / referenceDiagramLayoutQ16Scale) {
      return referenceDiagramRenderFailure("CUT_DIAGRAM_BOUNDS", layoutNode, `edge ${JSON.stringify(edge.id)} retained Trace prefix diverged from the exact planner trim.`);
    }
    const plannedTangent = edge.terminalTangentQ16;
    if ((plannedTangent.xQ16 !== 0 || plannedTangent.yQ16 !== 0)
      && (Math.sign(prefix.tangent.x) !== Math.sign(plannedTangent.xQ16) || Math.sign(prefix.tangent.y) !== Math.sign(plannedTangent.yQ16))) {
      return referenceDiagramRenderFailure("CUT_DIAGRAM_BOUNDS", layoutNode, `edge ${JSON.stringify(edge.id)} retained Trace tangent diverged from the exact planner tangent.`);
    }
    const polyline = prefix.points.length < 2 ? "" : `<polyline points="${prefix.points.map((point) => `${point.x},${point.y}`).join(" ")}" fill="none" stroke="${edge.paint.stroke}" stroke-width="${edge.paint.widthQ16 / referenceDiagramLayoutQ16Scale}" stroke-linecap="round" stroke-linejoin="round"/>`;
    const arrowPoints = edge.paint.arrow && prefix.points.length >= 2 ? (() => {
      const tip = prefix.head, tangent = prefix.tangent;
      const length = edge.paint.arrow!.lengthQ16 / referenceDiagramLayoutQ16Scale;
      const width = edge.paint.arrow!.widthQ16 / referenceDiagramLayoutQ16Scale;
      const baseX = tip.x - tangent.x * length, baseY = tip.y - tangent.y * length;
      const perpendicularX = -tangent.y * width / 2, perpendicularY = tangent.x * width / 2;
      return Object.freeze([
        Object.freeze({ x: tip.x, y: tip.y }),
        Object.freeze({ x: baseX + perpendicularX, y: baseY + perpendicularY }),
        Object.freeze({ x: baseX - perpendicularX, y: baseY - perpendicularY }),
      ]);
    })() : Object.freeze([]);
    const arrow = arrowPoints.length
      ? `<polygon points="${arrowPoints.map((point) => `${point.x},${point.y}`).join(" ")}" fill="${edge.paint.arrow!.color}"/>`
      : "";
    const visiblePoints = [...prefix.points, ...arrowPoints];
    const guard = Math.ceil(edge.paint.widthQ16 / referenceDiagramLayoutQ16Scale / 2 + 1);
    const left = Math.max(0, Math.floor(Math.min(...visiblePoints.map((point) => point.x)) - guard));
    const top = Math.max(0, Math.floor(Math.min(...visiblePoints.map((point) => point.y)) - guard));
    const right = Math.min(this.composition.width, Math.ceil(Math.max(...visiblePoints.map((point) => point.x)) + guard));
    const bottom = Math.min(this.composition.height, Math.ceil(Math.max(...visiblePoints.map((point) => point.y)) + guard));
    if (right <= left || bottom <= top) {
      return referenceDiagramRenderFailure("CUT_DIAGRAM_BOUNDS", layoutNode, `edge ${JSON.stringify(edge.id)} has no positive clipped raster bounds.`);
    }
    return Object.freeze({
      transparent: false as const,
      bounds: Object.freeze({ left, top, width: right - left, height: bottom - top }),
      markup: `${polyline}${arrow}`,
    });
  }

  private diagramEdgeSurface(
    layoutNode: IRNode,
    edge: ReferenceDiagramLayoutFrame["edges"][number],
    counters: MutableReferenceDiagramLayoutCounters,
  ) {
    const rasterPlan = this.referenceDiagramEdgeRasterPlan(layoutNode, edge);
    const cacheIdentity: ReferenceDiagramRasterCacheIdentityInput = {
      kind: "edge-raster" as const,
      width: rasterPlan.bounds.width,
      height: rasterPlan.bounds.height,
      splitIdentities: Object.freeze({
        topology: hash({
          kind: rasterPlan.transparent ? "diagram-edge-transparent-topology-v1" : "diagram-edge-bounded-topology-v1",
          algorithmVersion: referenceDiagramLayoutAlgorithmVersion,
        }),
        geometry: rasterPlan.transparent
          ? hash({ kind: "diagram-edge-transparent-geometry-v1", width: 1, height: 1 })
          : hash({
            kind: "diagram-edge-bounded-geometry-v1",
            canvasWidth: this.composition.width,
            canvasHeight: this.composition.height,
            bounds: rasterPlan.bounds,
            pointsQ16: edge.pointsQ16,
            visiblePointsQ16: edge.visiblePointsQ16,
            trimEndQ16: edge.trimEndQ16,
            terminalTangentQ16: edge.terminalTangentQ16,
          }),
        paint: rasterPlan.transparent
          ? hash({ kind: "diagram-edge-transparent-paint-v1" })
          : hash({ kind: "diagram-edge-paint-v1", paint: edge.paint }),
        // Edge rasterization consumes only the exact retained geometry and
        // paint above; it has no hidden wall-clock or output-frame input.
        temporal: hash({ kind: "diagram-edge-static-time-v1" }),
      }),
      backendIdentity: this.diagramRasterBackendIdentity(),
      runtimeIdentity: cutReferenceRuntimeIdentity,
    };
    // Edge pixels are a pure function of exact retained geometry, paint,
    // canvas, backend and runtime. Authored edge IDs/topology remain in the
    // planner receipt but cannot fragment or contradict the pixel memo/cache.
    const rasterIdentity = this.diagramRasterCacheKey(cacheIdentity);
    counters.edgeRasterRequests += 1;
    let pending = this.diagramEdgeRasterMemo.get(rasterIdentity);
    const memoHit = Boolean(pending);
    if (!pending) {
      pending = (async () => {
        const cache = await this.persistentDiagramRasterCache();
        const result = await cache.materialize(cacheIdentity, async () => {
          if (rasterPlan.transparent) return transparent(1, 1);
          return svgSurface(
            `<svg xmlns="http://www.w3.org/2000/svg" width="${rasterPlan.bounds.width}" height="${rasterPlan.bounds.height}" viewBox="${rasterPlan.bounds.left} ${rasterPlan.bounds.top} ${rasterPlan.bounds.width} ${rasterPlan.bounds.height}">${rasterPlan.markup}</svg>`,
            rasterPlan.bounds.width,
            rasterPlan.bounds.height,
          );
        });
        return Object.freeze({
          surface: rasterPlan.transparent
            ? transparent(this.composition.width, this.composition.height)
            : placeReferenceDiagramRasterTile(result.surface, rasterPlan.bounds, this.composition.width, this.composition.height),
          receipt: result.receipt,
          rasterBounds: rasterPlan.bounds,
        });
      })();
      this.diagramEdgeRasterMemo.set(rasterIdentity, pending);
      pending.catch(() => this.diagramEdgeRasterMemo.delete(rasterIdentity));
    } else counters.edgeRasterMemoHits += 1;
    return Object.freeze({ rasterIdentity, rasterCacheKey: rasterIdentity, rasterBounds: rasterPlan.bounds, pending, memoHit });
  }

  private async diagramLayoutFrame(node: IRNode, time: Rational, frame: number) {
    const previous = this.diagramLayoutTail;
    let release!: () => void;
    this.diagramLayoutTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    this.diagramLayoutsInFlight += 1;
    try {
      if (this.diagramLayoutsInFlight !== 1) throw new Error("CUT_DIAGRAM_LIMIT: DiagramLayout FIFO admitted concurrent full-canvas executions.");
      return await this.diagramLayoutFrameExclusive(node, time, frame);
    } finally {
      this.diagramLayoutsInFlight -= 1;
      release();
    }
  }

  private async diagramLayoutFrameExclusive(node: IRNode, time: Rational, frame: number) {
    const binding = this.diagramLayouts.get(node.id);
    if (!binding) return referenceDiagramRenderFailure("CUT_DIAGRAM_BOUNDS", node, "has no constructor-validated planner configuration.");
    const plan = binding.plan;
    if (!plan) return referenceDiagramRenderFailure("CUT_DIAGRAM_BOUNDS", node, "was rendered before async preparation completed its exact transition preflight.");
    let progress = rational(1);
    if (binding.contract.fromState) {
      const value = propertyAt(this.ir, node, "progress", time, this.preparedSignalResolver) ?? node.inputs.progress;
      if (value?.kind !== "quantity" || value.dimension !== "ratio" || value.unit !== "ratio") {
        return referenceDiagramRenderFailure("CUT_DIAGRAM_TYPE", node, "progress did not evaluate to an exact Ratio during frame execution.");
      }
      progress = rational(value.magnitude.numerator, value.magnitude.denominator);
    }
    // This call performs exact transition collision validation before any node
    // or edge pixel work. Runtime never renders the static-input displayFrame.
    const plannerFrame = (() => {
      try { return referenceDiagramLayoutFrameAt(plan, { at: time, progress }); }
      catch (error) { return referenceDiagramPlannerFailure(node, error); }
    })();
    if (binding.contract.fromState) {
      const admitted = plan.frames.find((candidate) => compareRational(candidate.at, time) === 0);
      if (!admitted || admitted.receiptIdentity !== plannerFrame.receiptIdentity) {
        return referenceDiagramRenderFailure("CUT_DIAGRAM_BOUNDS", node, "runtime progress did not match its constructor-preflighted exact output sample.");
      }
    }
    const canvasPixels = this.composition.width * this.composition.height;
    const localTilePixels = plannerFrame.nodes.reduce((sum, candidate) => sum + candidate.width * candidate.height, 0);
    const layers = plannerFrame.edges.length + plannerFrame.nodes.length;
    const admittedPixelPasses = localTilePixels + canvasPixels * (layers * 2 + 1);
    const maximumLiveSurfacePixels = canvasPixels * 3 + Math.max(0, ...plannerFrame.nodes.map((candidate) => candidate.width * candidate.height));
    if (!Number.isSafeInteger(canvasPixels) || canvasPixels > referenceLocalSpaceLimits.maximumSurfacePixels) {
      return referenceDiagramRenderFailure("CUT_DIAGRAM_LIMIT", node, `canvas requires ${canvasPixels} pixels; the retained destination limit is ${referenceLocalSpaceLimits.maximumSurfacePixels}.`);
    }
    if (!Number.isSafeInteger(localTilePixels) || localTilePixels > referenceLocalSpaceLimits.maximumLiveLocalSurfacePixelsPerFrame) {
      return referenceDiagramRenderFailure("CUT_DIAGRAM_LIMIT", node, `active bounded node tiles require ${localTilePixels} pixels; the per-frame limit is ${referenceLocalSpaceLimits.maximumLiveLocalSurfacePixelsPerFrame}.`);
    }
    if (!Number.isSafeInteger(admittedPixelPasses) || admittedPixelPasses > referenceLocalSpaceLimits.maximumPixelPassesPerFrame) {
      return referenceDiagramRenderFailure("CUT_DIAGRAM_LIMIT", node, `frame requires ${admittedPixelPasses} admitted raster/composite pixel-passes; the limit is ${referenceLocalSpaceLimits.maximumPixelPassesPerFrame}.`);
    }
    if (!Number.isSafeInteger(maximumLiveSurfacePixels) || maximumLiveSurfacePixels > referenceLocalSpaceLimits.maximumLiveLocalSurfacePixelsPerFrame) {
      return referenceDiagramRenderFailure("CUT_DIAGRAM_LIMIT", node, `incremental paint requires at most ${maximumLiveSurfacePixels} simultaneously live pixels; the limit is ${referenceLocalSpaceLimits.maximumLiveLocalSurfacePixelsPerFrame}.`);
    }
    const counters: MutableReferenceDiagramLayoutCounters = {
      admittedCanvasPixels: canvasPixels,
      admittedPixelPasses,
      maximumLiveSurfacePixels,
      maximumConcurrentDiagramLayouts: this.diagramLayoutsInFlight,
      nodeTileRequests: 0,
      nodeTileRasterizations: 0,
      nodeTileMemoHits: 0,
      edgeRasterRequests: 0,
      edgeRasterizations: 0,
      edgeRasterMemoHits: 0,
      persistentLookups: 0,
      persistentHits: 0,
      persistentMisses: 0,
      sameProcessCoalescedWaits: 0,
      persistentBuilderExecutions: 0,
      persistentBytesRead: 0,
      persistentBytesWritten: 0,
      persistentManifestsValidated: 0,
      persistentEvictedEntries: 0,
      persistentEvictedBytes: 0,
    };
    let surface = transparent(this.composition.width, this.composition.height);
    const rasterCacheReceipts: ReferenceDiagramRasterCacheReceipt[] = [];
    const edgeEvidence: ReferenceDiagramLayoutRenderedEdgeEvidence[] = [];
    for (const edge of plannerFrame.edges) {
      const raster = this.diagramEdgeSurface(node, edge, counters), materialized = await raster.pending, edgeSurface = materialized.surface;
      if (!raster.memoHit) {
        counters.edgeRasterizations += materialized.receipt.counters.builderExecutions;
        this.recordDiagramRasterCacheReceipt(counters, materialized.receipt);
      }
      if (!rasterCacheReceipts.some((item) => item.executionIdentity === materialized.receipt.executionIdentity)) rasterCacheReceipts.push(materialized.receipt);
      const alpha = referenceVisibleAlpha(edgeSurface);
      edgeEvidence.push(Object.freeze({
        id: edge.id,
        phase: edge.phase,
        pointsQ16: edge.pointsQ16,
        visiblePointsQ16: edge.visiblePointsQ16,
        trimEndQ16: edge.trimEndQ16,
        terminalTangentQ16: edge.terminalTangentQ16,
        paint: edge.paint,
        rasterIdentity: raster.rasterIdentity,
        rasterCacheKey: raster.rasterCacheKey,
        rasterCacheRequest: raster.memoHit ? "scene-frame-memo-hit" as const : "materialized" as const,
        rasterCacheReceiptIdentity: materialized.receipt.executionIdentity,
        rasterBounds: raster.rasterBounds,
        rasterTileRgbaSha256: materialized.receipt.artifact.sha256,
        rgbaSha256: createHash("sha256").update(edgeSurface.data).digest("hex"),
        ...alpha,
      }));
      // Deliberately incremental: a high-cardinality graph never retains an
      // array of full-canvas edge rasters.
      surface = compositeIntoPrivateAccumulator(surface, edgeSurface, "normal");
    }
    const nodeEvidence: ReferenceDiagramLayoutRenderedNodeEvidence[] = [];
    for (const frameNode of plannerFrame.nodes) {
      const tileRequest = this.diagramNodeTile(frameNode, time, frame, counters), materialized = await tileRequest.pending, tile = materialized.surface;
      if (!tileRequest.memoHit) {
        counters.nodeTileRasterizations += materialized.receipt.counters.builderExecutions;
        this.recordDiagramRasterCacheReceipt(counters, materialized.receipt);
      }
      if (!rasterCacheReceipts.some((item) => item.executionIdentity === materialized.receipt.executionIdentity)) rasterCacheReceipts.push(materialized.receipt);
      const origin = this.localSpaceOrigin(tileRequest.context), center = referenceDiagramPointPixels(frameNode.displayCenterQ16);
      const placementIdentity = hash({
        kind: "diagram-node-placement",
        algorithmVersion: referenceDiagramLayoutAlgorithmVersion,
        tileIdentity: tileRequest.tileIdentity,
        displayCenterQ16: frameNode.displayCenterQ16,
        opacityQ16: frameNode.opacityQ16,
        width: this.composition.width,
        height: this.composition.height,
      });
      const registered = await placeRegisteredSurfaceOnCanvas(
        tile,
        this.composition.width,
        this.composition.height,
        origin.x,
        origin.y,
        center.x,
        center.y,
        1,
        0,
      );
      const placed = scaleLocalSpaceAlpha(
        registered.surface,
        frameNode.opacityQ16 / referenceDiagramLayoutQ16Scale,
        this.rendererTreeContext.retainedAlphaScaleDiagnostic,
      );
      const alpha = referenceVisibleAlpha(placed);
      nodeEvidence.push(Object.freeze({
        id: frameNode.id,
        nodeId: frameNode.irNodeId,
        phase: frameNode.phase,
        displayCenterQ16: frameNode.displayCenterQ16,
        displayRectQ16: frameNode.displayRectQ16,
        opacityQ16: frameNode.opacityQ16,
        tileIdentity: tileRequest.tileIdentity,
        rasterCacheKey: tileRequest.rasterCacheKey,
        rasterCacheRequest: tileRequest.memoHit ? "scene-frame-memo-hit" as const : "materialized" as const,
        rasterCacheReceiptIdentity: materialized.receipt.executionIdentity,
        tileRgbaSha256: createHash("sha256").update(tile.data).digest("hex"),
        placementIdentity,
        placedRgbaSha256: createHash("sha256").update(placed.data).digest("hex"),
        ...alpha,
      }));
      surface = compositeIntoPrivateAccumulator(surface, placed, "normal");
    }
    // Declared state/source order is retained within each class; every edge is
    // painted before every bounded node so endpoint caps/arrowheads cannot
    // overwrite node artwork.
    const receipt = Object.freeze({
      format: "cut-reference-diagram-layout-frame-evidence" as const,
      version: 2 as const,
      evidenceKind: "completed-public-diagram-layout-frame" as const,
      algorithmVersion: referenceDiagramLayoutAlgorithmVersion,
      compositionId: this.composition.id,
      nodeId: node.id,
      exactTime: Object.freeze({ ...addRational(node.sceneId ? this.ir.scenes[node.sceneId]?.start ?? zeroRational : zeroRational, time) }),
      sceneLocalTime: Object.freeze({ ...time }),
      outputFrame: String(this.outputFrameIndex),
      plannerFrame,
      cacheScope: "persistent-cross-render" as const,
      rasterCache: Object.freeze({
        cacheLayer: "diagram-subscene-rgba" as const,
        multiProcessCoordination: "not-claimed" as const,
        receipts: Object.freeze(rasterCacheReceipts),
      }),
      nodes: Object.freeze(nodeEvidence),
      edges: Object.freeze(edgeEvidence),
      counters: Object.freeze({ ...counters }),
      outputRgbaSha256: createHash("sha256").update(surface.data).digest("hex"),
    });
    const semanticExecution = Object.freeze({
      format: receipt.format,
      version: receipt.version,
      evidenceKind: receipt.evidenceKind,
      algorithmVersion: receipt.algorithmVersion,
      compositionId: receipt.compositionId,
      nodeId: receipt.nodeId,
      exactTime: receipt.exactTime,
      sceneLocalTime: receipt.sceneLocalTime,
      outputFrame: receipt.outputFrame,
      plannerReceiptIdentity: receipt.plannerFrame.receiptIdentity,
      nodes: receipt.nodes.map((candidate) => {
        const semantic = { ...candidate };
        Reflect.deleteProperty(semantic, "rasterCacheRequest");
        Reflect.deleteProperty(semantic, "rasterCacheReceiptIdentity");
        return semantic;
      }),
      edges: receipt.edges.map((candidate) => {
        const semantic = { ...candidate };
        Reflect.deleteProperty(semantic, "rasterCacheRequest");
        Reflect.deleteProperty(semantic, "rasterCacheReceiptIdentity");
        return semantic;
      }),
      outputRgbaSha256: receipt.outputRgbaSha256,
    });
    // Semantic execution identity stays equal across a verified cold/warm
    // replay. Observation identity separately binds lookup status, counters,
    // repairs and eviction without turning cache history into rendered meaning.
    const evidence: ReferenceDiagramLayoutFrameEvidence = Object.freeze({
      ...receipt,
      executionIdentity: hash(semanticExecution),
      observationIdentity: hash(receipt),
    });
    const active = this.activeDiagramLayoutFrameEvidence;
    if (!active) throw new Error("CUT_DIAGRAM_BOUNDS: DiagramLayout executed outside an active staged frame receipt.");
    active.push(evidence);
    return surface;
  }

  private beginLocalSpaceExecutionEvidence(exactTime: Rational, outputFrame: string) {
    this.activeLocalSpaceFrameEvidence = {
      exactTime,
      outputFrame,
      counters: {
        tileRequests: 0,
        tileRasterizations: 0,
        tileMemoHits: 0,
        tilePixelsRasterized: 0,
        placementRequests: 0,
        placementRasterizations: 0,
        placementMemoHits: 0,
        placementDestinationPixels: 0,
        transformExecutions: 0,
        maximumConcurrentTransforms: 0,
        localNodeRasterizations: 0,
        localNodePixelsRasterized: 0,
        localNodeRgbaBytesRasterized: 0,
        localPaintSurfaceCacheHits: 0,
        localPaintSurfaceCacheMisses: 0,
        localPaintSurfaceCacheBypasses: 0,
        localPaintSurfaceCacheEvictions: 0,
        localPaintSurfaceCacheResidentBytes: this.rendererTreeContext.localPaintSurfaceCache.residentBytes,
        inactiveNodeSkips: 0,
        ownerOpacitySkips: 0,
        ownerPolicySkips: 0,
        localNodeOpacitySkips: 0,
      },
      tiles: [],
      placements: [],
      skips: [],
    };
  }

  private beginPlanarTrackExecutionEvidence(sceneLocalTime: Rational, compositionTime: Rational, outputFrame: string) {
    this.activePlanarTrackFrameEvidence = {
      compositionTime: Object.freeze({ ...compositionTime }),
      sceneLocalTime: Object.freeze({ ...sceneLocalTime }),
      outputFrame,
      reservedExecutions: 0,
      reservedLocalSpaceTiles: 0,
      reservedSourceTilePixels: 0,
      reservedLocalPixelPasses: 0,
      reservedDestinationPixels: 0,
      reservedCanvasRgbaBytes: 0,
      preflightReservations: new Map(),
      executions: [],
    };
  }

  private publishPlanarTrackExecutionEvidence() {
    const active = this.activePlanarTrackFrameEvidence;
    if (!active) throw new Error("CUT_PLANAR_TRACK_EVIDENCE: no staged exact-frame receipt is active.");
    this.completedPlanarTrackFrameEvidence = Object.freeze(active.executions.map((execution) => execution.receipt));
    this.completedPlanarTrackFrameTrustedContexts = Object.freeze(active.executions.map((execution) => execution.trustedContext));
  }

  private beginRetainedMediaExecutionEvidence() {
    this.activeRetainedMediaViewportFrameEvidence = [];
    this.activeRetainedMediaCompositionFrameEvidence = [];
    this.activeRetainedMediaLocalCompositorFrameEvidence = [];
  }

  private publishRetainedMediaExecutionEvidence() {
    if (!this.activeRetainedMediaViewportFrameEvidence || !this.activeRetainedMediaCompositionFrameEvidence
      || !this.activeRetainedMediaLocalCompositorFrameEvidence) {
      throw new Error("CUT_RETAINED_MEDIA_VIEWPORT_RASTER: no active retained-media frame evidence to publish.");
    }
    this.completedRetainedMediaViewportFrameEvidence = Object.freeze([...this.activeRetainedMediaViewportFrameEvidence]);
    this.completedRetainedMediaCompositionFrameEvidence = Object.freeze([...this.activeRetainedMediaCompositionFrameEvidence]);
    this.completedRetainedMediaLocalCompositorFrameEvidence = Object.freeze([...this.activeRetainedMediaLocalCompositorFrameEvidence]);
  }

  private publishLocalSpaceExecutionEvidence() {
    const active = this.activeLocalSpaceFrameEvidence;
    if (!active) throw new Error("CUT_LOCAL_SPACE_RASTER: no active frame execution receipt to publish.");
    this.completedLocalSpaceFrameEvidence = referenceLocalSpaceFrameEvidence({
      compositionId: this.composition.id,
      exactTime: active.exactTime,
      outputFrame: active.outputFrame,
      backendIdentity: this.localSpaceBackendIdentity(),
      counters: active.counters,
      tiles: active.tiles,
      placements: active.placements,
      skips: active.skips,
    });
  }

  private prefixedNestedLocalSpaceRendererFrameExecution(
    instance: IRNode,
    sourceCompositionId: string,
    nested: ReferenceLocalSpaceRendererFrameExecution,
  ) {
    const prefix = Object.freeze({
      compositionId: this.composition.id,
      instanceNodeId: instance.id,
      sourceCompositionId,
    });
    const receipt = referenceLocalSpaceRendererFrameExecutionEvidence({
      executionPath: Object.freeze([prefix, ...nested.receipt.executionPath]),
      execution: nested.receipt.execution,
      preflight: nested.receipt.preflight,
    });
    const expected = referenceLocalSpaceRendererFrameExecutionEvidence({
      executionPath: Object.freeze([prefix, ...nested.trustedContext.expected.executionPath]),
      execution: nested.trustedContext.expected.execution,
      preflight: nested.trustedContext.expected.preflight,
    });
    return trustedLocalSpaceRendererFrameExecution(receipt, expected);
  }

  private publishLocalSpaceRendererFrameExecutionTree() {
    const execution = this.completedLocalSpaceFrameEvidence;
    const preflight = this.activeLocalSpaceCompositionTransformPreflight;
    const nested = this.activeNestedLocalSpaceRendererFrameExecutions;
    if (!execution || !preflight || !nested) {
      throw new Error("CUT_LOCAL_SPACE_RASTER: completed frame cannot publish an incomplete renderer-tree LocalSpace execution.");
    }
    const rootReceipt = referenceLocalSpaceRendererFrameExecutionEvidence({
      executionPath: Object.freeze([Object.freeze({ compositionId: this.composition.id })]),
      execution,
      preflight,
    });
    const executions = [trustedLocalSpaceRendererFrameExecution(rootReceipt), ...nested]
      .sort((left, right) => compareLocalSpaceExecutionPaths(left.receipt.executionPath, right.receipt.executionPath));
    const paths = new Set<string>();
    for (const entry of executions) {
      const key = localSpaceExecutionPathIdentity(entry.receipt.executionPath);
      if (paths.has(key)) {
        throw new Error(`CUT_LOCAL_SPACE_RASTER: renderer-tree LocalSpace execution path ${JSON.stringify(entry.receipt.executionPath)} was published twice.`);
      }
      paths.add(key);
    }
    this.completedLocalSpaceRendererFrameExecutions = Object.freeze(executions);
    const receipts = Object.freeze(executions.map((entry) => entry.receipt));
    if (this.ownsRendererTreeContext) {
      const generation = this.activeRendererFrameEvidenceGeneration;
      const work = referenceLocalSpaceRendererFrameExecutionTreeWork(receipts);
      if (!generation || !generation.active
        || this.rendererTreeContext.evidenceBudget.current !== generation
        || generation.records !== work.records
        || generation.copyUnits !== work.copyUnits) {
        throw new Error(
          `CUT_LOCAL_SPACE_RASTER: renderer-tree evidence ledger ${generation?.records ?? "missing"}/${generation?.copyUnits ?? "missing"} does not close over completed work ${work.records}/${work.copyUnits}.`,
        );
      }
    }
    const expectedReceipts = Object.freeze(executions.map((entry) => entry.trustedContext.expected));
    const tree = referenceLocalSpaceRendererFrameExecutionTreeEvidence(this.composition.id, receipts);
    const expectedTree = referenceLocalSpaceRendererFrameExecutionTreeEvidence(this.composition.id, expectedReceipts);
    if (this.completedLocalSpaceRendererFrameExecutionTreeAuthority) {
      trustedLocalSpaceRendererFrameExecutionTreeAuthorities.delete(this.completedLocalSpaceRendererFrameExecutionTreeAuthority);
    }
    this.completedLocalSpaceRendererFrameExecutionReceipts = receipts;
    this.completedLocalSpaceRendererFrameExecutionTree = tree;
    this.completedLocalSpaceRendererFrameExecutionTreeAuthority = trustedLocalSpaceRendererFrameExecutionTreeAuthority(
      this.ir,
      this.composition.id,
      receipts,
      expectedTree,
      expectedReceipts,
    );
  }

  private reserveLocalSpaceRendererTreeEvidenceRecords(count: number) {
    const generation = this.activeRendererFrameEvidenceGeneration;
    if (!generation || !generation.active
      || this.rendererTreeContext.evidenceBudget.current !== generation
      || !Number.isSafeInteger(count) || count < 0) {
      throw new Error("CUT_LOCAL_SPACE_RASTER: renderer-tree evidence reservation occurred outside one active root frame.");
    }
    const nextRecords = generation.records + count;
    const nextCopyUnits = generation.copyUnits + count * this.rendererTreeDepth;
    if (!Number.isSafeInteger(nextRecords)
      || nextRecords > referenceLocalSpaceRendererFrameExecutionTreeLimits.maximumEvidenceRecords) {
      throw new Error(
        `CUT_LOCAL_SPACE_RASTER: renderer execution tree evidence requires ${nextRecords} records; maximum is ${referenceLocalSpaceRendererFrameExecutionTreeLimits.maximumEvidenceRecords}.`,
      );
    }
    if (!Number.isSafeInteger(nextCopyUnits)
      || nextCopyUnits > referenceLocalSpaceRendererFrameExecutionTreeLimits.maximumEvidenceCopyUnits) {
      throw new Error(
        `CUT_LOCAL_SPACE_RASTER: renderer execution tree evidence requires ${nextCopyUnits} depth-weighted copy units; maximum is ${referenceLocalSpaceRendererFrameExecutionTreeLimits.maximumEvidenceCopyUnits}.`,
      );
    }
    generation.records = nextRecords;
    generation.copyUnits = nextCopyUnits;
  }

  private async drainActiveNodeFrameWork() {
    while (this.activeNodeFrameWork.size) {
      await Promise.allSettled([...this.activeNodeFrameWork]);
    }
  }

  private recordLocalSpaceSkip(
    node: IRNode,
    kind: ReferenceLocalSpaceRenderSkipEvidence["kind"],
    reason: Exclude<ReferenceLocalSpaceRenderSkipEvidence["reason"], "opacity-quantized-transparent">,
    ownerNodeId?: string,
    sampleTime?: Rational,
  ) {
    if (this.responsiveDescendantContexts.has(node.id) || this.diagramDescendantContexts.has(node.id)) return;
    const active = this.activeLocalSpaceFrameEvidence;
    if (!active) return;
    this.reserveLocalSpaceRendererTreeEvidenceRecords(1);
    if (kind === "inactive-node") active.counters.inactiveNodeSkips += 1;
    else if (kind === "owner-opacity") active.counters.ownerOpacitySkips += 1;
    else if (kind === "owner-policy") active.counters.ownerPolicySkips += 1;
    else active.counters.localNodeOpacitySkips += 1;
    active.skips.push(Object.freeze({
      nodeId: node.id,
      ...(ownerNodeId ? { ownerNodeId } : {}),
      ...(sampleTime ? { sampleTime: Object.freeze({ ...sampleTime }) } : {}),
      kind,
      reason,
    }));
  }

  private recordCalloutQuantizedOpacitySkip(
    localNode: IRNode,
    owner: IRNode,
    sampleTime: Rational,
    tileIdentity: string,
    admissionPlanIdentity: string,
    transformWorkIdentity: string,
    placement: ReferenceLocalSpacePlacement,
  ) {
    const active = this.activeLocalSpaceFrameEvidence;
    if (!active) return;
    this.reserveLocalSpaceRendererTreeEvidenceRecords(1);
    active.counters.ownerOpacitySkips += 1;
    active.skips.push(Object.freeze({
      nodeId: localNode.id,
      ownerNodeId: owner.id,
      sampleTime: Object.freeze({ ...sampleTime }),
      kind: "owner-opacity" as const,
      reason: "opacity-quantized-transparent" as const,
      tileIdentity,
      admissionPlanIdentity,
      placementIdentity: referenceLocalSpacePlacementIdentity(
        this.localSpaceConfig(localNode),
        tileIdentity,
        placement,
        transformWorkIdentity,
      ),
      destinationWidth: this.composition.width,
      destinationHeight: this.composition.height,
      placement: Object.freeze({ ...placement }),
    }));
  }

  private localSpaceBackendIdentity() {
    return `local-space@2;sharp@${sharp.versions.sharp ?? "missing"};libvips@${sharp.versions.vips ?? "missing"};rgba@associated-rgb16-filter-straight-q16;scale-translation@${referenceLocalSpaceScaleTranslationAlgorithmVersion};alpha-bounded-translation@${referenceLocalSpaceAlphaBoundedTranslationAlgorithmVersion};retained-alpha-support@${referenceRetainedSurfaceAlphaSupportAlgorithmVersion};source-alpha-bounds@${referencePrivateStraightRgbaBoundsAlgorithmVersion}`;
  }

  private localPaintRasterBackendIdentity() {
    if (this.localPaintRasterBackend) return this.localPaintRasterBackend;
    const implementation = Object.entries(sharp.versions)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, version]) => `${name}@${version}`)
      .join(";");
    const closure = createCutBuiltinImplementationIdentity("cut:visual").integrity;
    this.localPaintRasterBackend = [
      referenceLocalPaintSurfaceCacheAlgorithmVersion,
      `runtime@${cutReferenceRuntimeIdentity}`,
      `platform@${process.platform}`,
      `arch@${process.arch}`,
      `node@${process.version}`,
      `abi@${process.versions.modules ?? "missing"}`,
      `implementation@${closure}`,
      implementation,
      "rgba@straight",
    ].join(";");
    return this.localPaintRasterBackend;
  }

  private diagramRasterBackendIdentity() {
    if (this.diagramRasterBackend) return this.diagramRasterBackend;
    const implementation = Object.entries(sharp.versions)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, version]) => `${name}@${version}`)
      .join(";");
    const closure = createCutBuiltinImplementationIdentity("@cut/diagram").integrity;
    this.diagramRasterBackend = `diagram-raster@1;platform@${process.platform};arch@${process.arch};node@${process.version};implementation@${closure};${implementation};rgba@straight`;
    return this.diagramRasterBackend;
  }

  private planarTrackBackendIdentity() {
    return `${referencePlanarTrackAlgorithmVersion};${referenceProjectiveWarpAlgorithmVersion};${referenceProjectiveWarpCanvasAlgorithmVersion};${this.localSpaceBackendIdentity()}`;
  }

  private async serializeLocalSpaceTransform<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.localSpaceTransformTail;
    let release!: () => void;
    this.localSpaceTransformTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    this.localSpaceTransformsInFlight += 1;
    const counters = this.activeLocalSpaceFrameEvidence?.counters;
    if (counters) {
      counters.transformExecutions += 1;
      counters.maximumConcurrentTransforms = Math.max(counters.maximumConcurrentTransforms, this.localSpaceTransformsInFlight);
    }
    try {
      return await work();
    } finally {
      this.localSpaceTransformsInFlight -= 1;
      release();
    }
  }

  private localSpaceTile(config: ReferenceLocalSpaceConfig, time: Rational, frame: number) {
    const key = referenceLocalSpaceTileIdentity(config, time, this.localSpaceBackendIdentity());
    const evidence = this.activeLocalSpaceFrameEvidence;
    if (evidence) evidence.counters.tileRequests += 1;
    let pending = this.localSpaceTileMemo.get(key);
    if (!pending) {
      if (evidence) {
        evidence.counters.tileRasterizations += 1;
        evidence.counters.tilePixelsRasterized += config.width * config.height;
      }
      pending = (async () => {
        let localAccumulator = localPrivateAccumulator(config.width, config.height);
        const orderedLiveExecution: ReferenceRetainedMediaCompositionLiveChild[] = [];
        const retainedMediaV2DirectChildExecutions: ReferenceRetainedMediaLocalCompositorDirectChildExecution[] = [];
        const materializationExecutions: ReferenceRetainedMediaMaterializationRuntime[] = [];
        const operationExecutions: ReferenceRetainedMediaLocalOperationRuntime[] = [];
        let retainedMediaV2ExecutedSourceOverSteps = 0;
        for (let sourceOrder = 0; sourceOrder < config.childIds.length; sourceOrder += 1) {
          const childId = config.childIds[sourceOrder]!;
          const childResult = await this.localNodeFrameResult(childId, config, time, frame);
          const child = childResult.surface;
          materializationExecutions.push(...childResult.materializations);
          operationExecutions.push(...childResult.operations);
          retainedMediaV2ExecutedSourceOverSteps += childResult.sourceOverSteps;
          const plannedV2Child = config.retainedMediaLocalCompositor?.directChildren[sourceOrder];
          if (config.retainedMediaLocalCompositor) {
            if (!plannedV2Child || plannedV2Child.childId !== childId || plannedV2Child.sourceOrder !== sourceOrder) {
              throw new ReferenceLocalSpaceError("CUT_LOCAL_SPACE_RASTER", this.ir.nodes[config.nodeId]!, "V2 retained-media compositor direct-child plan diverged from LocalSpace source order.");
            }
            if (!child && childResult.directChildSkipReason === undefined) {
              throw new ReferenceLocalSpaceError("CUT_LOCAL_SPACE_RASTER", this.ir.nodes[childId]!, "V2 retained-media compositor direct child produced no surface or closed skip reason.");
            }
            retainedMediaV2DirectChildExecutions.push(Object.freeze({
              sourceOrder,
              childId,
              childContentHash: plannedV2Child.childContentHash,
              role: plannedV2Child.role,
              status: child ? "rendered" as const : "skipped" as const,
              ...(child ? { rgbaSha256: createHash("sha256").update(child.data).digest("hex") } : {}),
              ...(!child ? { skipReason: childResult.directChildSkipReason! } : {}),
            }));
          }
          const plannedChild = config.retainedMediaComposition?.children[sourceOrder];
          if (config.retainedMediaComposition) {
            if (!plannedChild || plannedChild.childId !== childId || plannedChild.sourceOrder !== sourceOrder) {
              throw new ReferenceLocalSpaceError("CUT_LOCAL_SPACE_RASTER", this.ir.nodes[config.nodeId]!, "ordered retained-media composition plan diverged from LocalSpace child order.");
            }
            const branch = plannedChild.role === "retained-media"
              ? referenceLocalSpaceRetainedMediaPlanForRoot(config, childId)
              : undefined;
            const branchExecution = branch
              ? childResult.materializations.find((execution) => execution.rootId === branch.rootId)
              : undefined;
            const branchReceipt = branchExecution?.receipt;
            if (branch && child && !branchReceipt) {
              throw new ReferenceLocalSpaceError("CUT_LOCAL_SPACE_RASTER", this.ir.nodes[childId]!, "rendered retained-media branch has no staged v1 execution receipt.");
            }
            const childExecution = Object.freeze({
              sourceOrder,
              childId,
              childContentHash: plannedChild.childContentHash,
              role: plannedChild.role,
              status: child ? "rendered" as const : "skipped" as const,
              ...(child ? { rgbaSha256: createHash("sha256").update(child.data).digest("hex") } : {}),
              ...(branch ? { branchPlanIdentity: branch.semanticIdentity } : {}),
              ...(branchReceipt ? { branchExecutionIdentity: branchReceipt.executionIdentity } : {}),
            });
            orderedLiveExecution.push(Object.freeze({
              execution: childExecution,
              ...(child ? { surface: child } : {}),
              ...(branchReceipt ? { branchReceipt } : {}),
            }));
          }
          if (child && !config.retainedMediaComposition) {
            if (child.width !== config.width || child.height !== config.height) {
              throw new ReferenceLocalSpaceError("CUT_LOCAL_SPACE_RASTER", this.ir.nodes[childId]!, `ordered child surface ${child.width}x${child.height} disagrees with LocalSpace ${config.width}x${config.height}.`);
            }
            localAccumulator = compositeIntoLocalPrivateAccumulator(
              localAccumulator,
              child,
              "normal",
              this.rendererTreeContext.privateStraightCompositeDiagnostic,
            );
            retainedMediaV2ExecutedSourceOverSteps += 1;
          }
        }
        let result: RawSurface = localAccumulator;
        let legacyCompositionReceipt: ReferenceRetainedMediaCompositionExecutionEvidence | undefined;
        if (config.retainedMediaComposition) {
          const active = this.activeRetainedMediaCompositionFrameEvidence;
          if (!active) throw new ReferenceLocalSpaceError("CUT_LOCAL_SPACE_RASTER", this.ir.nodes[config.nodeId]!, "ordered retained-media composition executed outside an active staged frame receipt.");
          const admission = (() => {
            const localNode = this.ir.nodes[config.nodeId]!;
            const executionDomain = localNode.sceneId ? `scene:${localNode.sceneId}` : `composition-root:${this.composition.id}`;
            const retainedBranchesInExecutionDomain = [...this.localSpaceConfigs.values()]
              .filter((candidate) => {
                const candidateNode = this.ir.nodes[candidate.nodeId];
                return (candidateNode?.sceneId ? `scene:${candidateNode.sceneId}` : `composition-root:${this.composition.id}`) === executionDomain;
              })
              .reduce((sum, candidate) => sum + referenceLocalSpaceAllRetainedMediaPlans(candidate).length, 0);
            return Object.freeze({ executionDomain, retainedBranchesInExecutionDomain });
          })();
          const executed = executeReferenceRetainedMediaComposition({
            compositionId: this.composition.id,
            exactTime: time,
            outputFrame: String(this.outputFrameIndex),
            plan: config.retainedMediaComposition,
            admission,
            children: Object.freeze(orderedLiveExecution),
          });
          result = {
            data: Buffer.from(executed.surface.data.buffer, executed.surface.data.byteOffset, executed.surface.data.byteLength),
            width: executed.surface.width,
            height: executed.surface.height,
          };
          legacyCompositionReceipt = executed.receipt;
          retainedMediaV2ExecutedSourceOverSteps += legacyCompositionReceipt.allocations.localSourceOverSteps;
          active.push(legacyCompositionReceipt);
        }
        if (config.retainedMediaLocalCompositor) {
          const active = this.activeRetainedMediaLocalCompositorFrameEvidence;
          if (!active) throw new ReferenceLocalSpaceError("CUT_LOCAL_SPACE_RASTER", this.ir.nodes[config.nodeId]!, "V2 retained-media local compositor executed outside an active staged frame receipt.");
          const islandRoots = new Set(config.retainedMediaLocalCompositor.islands.map((island) => island.rootId));
          active.push(referenceRetainedMediaLocalCompositorExecutionEvidence({
            compositionId: this.composition.id,
            exactTime: time,
            outputFrame: String(this.outputFrameIndex),
            plan: config.retainedMediaLocalCompositor,
            directChildExecutions: Object.freeze(retainedMediaV2DirectChildExecutions),
            executedSourceOverSteps: retainedMediaV2ExecutedSourceOverSteps,
            materializationExecutions: Object.freeze(materializationExecutions.filter((execution) => islandRoots.has(execution.rootId))),
            operationExecutions: Object.freeze(operationExecutions),
            ...(legacyCompositionReceipt ? { legacyCompositionReceipt } : {}),
            finalLocalTile: Object.freeze({
              width: result.width,
              height: result.height,
              rgbaSha256: createHash("sha256").update(result.data).digest("hex"),
            }),
          }));
        }
        if (evidence) this.reserveLocalSpaceRendererTreeEvidenceRecords(1 + config.localCompositing.operations.length);
        evidence?.tiles.push(Object.freeze({
          nodeId: config.nodeId,
          tileIdentity: key,
          width: config.width,
          height: config.height,
          ...(config.localCompositing.operations.length ? {
            localCompositing: Object.freeze({
              algorithmVersion: config.localCompositing.algorithmVersion,
              planIdentity: config.localCompositing.semanticIdentity,
              operations: Object.freeze(config.localCompositing.operations.map((operation) => Object.freeze({
                sourceOrder: operation.sourceOrder,
                nodeId: operation.nodeId,
                op: operation.op,
                semanticIdentity: operation.semanticIdentity,
                estimatedPixelWorkPerFrame: operation.estimatedPixelWorkPerFrame,
              }))),
              finalRgbaSha256: createHash("sha256").update(result.data).digest("hex"),
            }),
          } : {}),
        }));
        return result;
      })();
      this.localSpaceTileMemo.set(key, pending);
      pending.catch(() => this.localSpaceTileMemo.delete(key));
    } else if (evidence) evidence.counters.tileMemoHits += 1;
    return pending;
  }

  private placeLocalSpaceTile(
    config: ReferenceLocalSpaceConfig,
    tile: RawSurface,
    placement: ReferenceLocalSpacePlacement,
    width: number,
    height: number,
    time: Rational,
    materializedSource: RawSurface = tile,
    transformExecution?: ReferenceLocalSpaceTransformAdmission,
  ) {
    const tileIdentity = referenceLocalSpaceTileIdentity(config, time, this.localSpaceBackendIdentity());
    const key = referenceLocalSpacePlacementIdentity(config, tileIdentity, placement, transformExecution?.admittedWork.workIdentity);
    const evidence = this.activeLocalSpaceFrameEvidence;
    if (evidence) evidence.counters.placementRequests += 1;
    let pending = this.localSpacePlacementMemo.get(key);
    if (!pending) {
      if (evidence) {
        evidence.counters.placementRasterizations += 1;
        evidence.counters.placementDestinationPixels += width * height;
      }
      pending = this.serializeLocalSpaceTransform(async () => {
        const registered = await placeRegisteredSurfaceOnCanvas(
          materializedSource,
          width,
          height,
          placement.registrationRasterX,
          placement.registrationRasterY,
          placement.destinationX,
          placement.destinationY,
          placement.scale,
          placement.rotation,
          placement.skewX,
          placement.skewY,
          transformExecution ? Object.freeze({ ...transformExecution, opacity: placement.opacity }) : undefined,
        );
        const placed = scaleLocalSpaceAlpha(
          registered.surface,
          placement.opacity,
          this.rendererTreeContext.retainedAlphaScaleDiagnostic,
        );
        if (evidence) this.reserveLocalSpaceRendererTreeEvidenceRecords(1);
        evidence?.placements.push(Object.freeze({
          nodeId: config.nodeId,
          placementIdentity: key,
          tileIdentity,
          owner: placement.owner,
          contextIdentity: placement.contextIdentity,
          destinationWidth: width,
          destinationHeight: height,
          transform: Object.freeze({
            destinationX: placement.destinationX,
            destinationY: placement.destinationY,
            registrationRasterX: placement.registrationRasterX,
            registrationRasterY: placement.registrationRasterY,
            scale: placement.scale,
            skewX: placement.skewX,
            skewY: placement.skewY,
            rotation: placement.rotation,
            opacity: placement.opacity,
          }),
          ...(registered.transformWork ? { transformWork: registered.transformWork } : {}),
        }));
        return placed;
      });
      this.localSpacePlacementMemo.set(key, pending);
      pending.catch(() => this.localSpacePlacementMemo.delete(key));
    } else if (evidence) evidence.counters.placementMemoHits += 1;
    return pending;
  }

  private async localSpaceOwnedFrame(owner: IRNode | undefined, localNode: IRNode, time: Rational, frame: number) {
    const config = this.localSpaceConfig(localNode), executionOwner = owner ?? localNode;
    const plan = this.activeAffineLocalSpacePlan(executionOwner.id, config.nodeId, time);
    if (plan.status !== "visible") {
      this.recordLocalSpaceSkip(
        localNode,
        plan.status === "policy-hidden" ? "owner-policy" : "owner-opacity",
        plan.status === "policy-hidden" ? "tracking-policy-hidden" : "opacity-zero",
        executionOwner.id,
        time,
      );
      return undefined;
    }
    if (!plan.placement || !plan.transformWork) throw new ReferenceLocalSpaceError("CUT_LOCAL_SPACE_RASTER", executionOwner, `visible affine plan for ${config.nodeId} is incomplete.`);
    const tile = await this.localSpaceTile(config, time, frame);
    return this.placeLocalSpaceTile(
      config, tile, plan.placement, this.composition.width, this.composition.height, time, tile,
      {
        sourceNode: executionOwner,
        admittedWork: plan.transformWork,
        ...(plan.scaleTranslationPlan ? { scaleTranslationPlan: plan.scaleTranslationPlan } : {}),
      },
    );
  }

  /** A public Visual component lowers to an ordinary fragment. Only the
   * constructor-validated direct scene-root unary fragment slice reaches this
   * handoff. Planning and allocation admission happen before tile pixels. */
  private async componentFragmentLocalSpaceFrame(owner: IRNode, localNode: IRNode, time: Rational, frame: number) {
    const config = this.localSpaceConfig(localNode);
    const plan = this.activeAffineLocalSpacePlan(owner.id, config.nodeId, time);
    if (plan.status === "opacity-zero") {
      this.recordLocalSpaceSkip(localNode, "owner-opacity", "opacity-zero", owner.id, time);
      return undefined;
    }
    if (!plan.placement || !plan.transformWork) throw new ReferenceLocalSpaceError("CUT_LOCAL_SPACE_RASTER", owner, `component affine plan for ${config.nodeId} is incomplete.`);
    const tile = await this.localSpaceTile(config, time, frame);
    return this.placeLocalSpaceTile(
      config,
      tile,
      plan.placement,
      this.composition.width,
      this.composition.height,
      time,
      tile,
      {
        sourceNode: owner,
        admittedWork: plan.transformWork,
        ...(plan.scaleTranslationPlan ? { scaleTranslationPlan: plan.scaleTranslationPlan } : {}),
      },
    );
  }

  /** Camera2D's retained branch materializes one bounded local tile before
   * applying the historical public x/y/scale/rotation/opacity controls. All
   * other Camera2D child graphs stay on the legacy delivery-canvas path. */
  private async camera2DLocalSpaceFrame(owner: IRNode, localNode: IRNode, time: Rational, frame: number) {
    if (!this.active(localNode, time)) {
      this.recordLocalSpaceSkip(localNode, "inactive-node", "outside-interval", owner.id, time);
      return undefined;
    }
    const config = this.localSpaceConfig(localNode);
    const plan = this.activeAffineLocalSpacePlan(owner.id, config.nodeId, time);
    const match = plan.semanticMatch;
    if (match) {
      const tile = await this.localSpaceTile(config, time, frame);
      const tinted = applyReferenceSemanticMatchColor(tile, match);
      const placed = await this.placeLocalSpaceTile(
        config,
        tile,
        match.placement,
        this.composition.width,
        this.composition.height,
        time,
        tinted.surface,
        {
          sourceNode: owner,
          admittedWork: match.transformWork,
          ...(plan.scaleTranslationPlan ? { scaleTranslationPlan: plan.scaleTranslationPlan } : {}),
        },
      );
      const active = this.activeSemanticMatchFrameEvidence;
      if (!active) throw new Error(`CUT_MATCH_RENDER: semantic match ${match.transitionId} executed outside one staged frame receipt.`);
      active.push(referenceSemanticMatchFrameEvidence({
        compositionId: this.composition.id,
        sample: match,
        tile,
        tinted: tinted.surface,
        placed,
        tintedPixels: tinted.tintedPixels,
      }));
      return placed;
    }
    if (plan.status === "opacity-zero") {
      this.recordLocalSpaceSkip(localNode, "owner-opacity", "opacity-zero", owner.id, time);
      return undefined;
    }
    if (!plan.placement || !plan.transformWork) throw new ReferenceLocalSpaceError("CUT_LOCAL_SPACE_RASTER", owner, `Camera2D affine plan for ${config.nodeId} is incomplete.`);
    const tile = await this.localSpaceTile(config, time, frame);
    return this.placeLocalSpaceTile(
      config,
      tile,
      plan.placement,
      this.composition.width,
      this.composition.height,
      time,
      tile,
      {
        sourceNode: owner,
        admittedWork: plan.transformWork,
        ...(plan.scaleTranslationPlan ? { scaleTranslationPlan: plan.scaleTranslationPlan } : {}),
      },
    );
  }

  /** Consume the exact public Track2D retained-source plan. Hidden tracking
   * policy and zero owner opacity terminate before tile rasterization; a
   * visible plan is the sole source of placement and cache identity. */
  private async track2DLocalSpaceFrame(owner: IRNode, localNode: IRNode, time: Rational, frame: number) {
    const local = this.localSpaceConfig(localNode), affine = this.activeAffineLocalSpacePlan(owner.id, local.nodeId, time), plan = affine.trackPlan;
    if (!plan) throw new ReferenceLocalSpaceError("CUT_LOCAL_SPACE_RASTER", localNode, `Track2D owner ${owner.id} has no exact preflight sample.`);
    if (plan.skip?.classification === "tracking-policy-hidden") {
      this.recordLocalSpaceSkip(localNode, "owner-policy", "tracking-policy-hidden", owner.id, time);
      return undefined;
    }
    if (plan.skip?.classification === "owner-opacity") {
      this.recordLocalSpaceSkip(localNode, "owner-opacity", "opacity-zero", owner.id, time);
      return undefined;
    }
    if (plan.hidden
      || plan.work.kind !== "retained-tile-transform"
      || !plan.destinationRegistration
      || plan.scale === undefined
      || plan.rotation === undefined
      || plan.opacity === undefined) {
      throw new ReferenceLocalSpaceError("CUT_LOCAL_SPACE_RASTER", localNode, `Track2D owner ${owner.id} returned an incomplete visible retained-source plan.`);
    }
    if (!affine.placement || !affine.transformWork) throw new ReferenceLocalSpaceError("CUT_LOCAL_SPACE_RASTER", localNode, `Track2D owner ${owner.id} has incomplete affine admission.`);
    const tile = await this.localSpaceTile(local, time, frame);
    return this.placeLocalSpaceTile(local, tile, affine.placement, this.composition.width, this.composition.height, time, tile, Object.freeze({
      sourceNode: owner,
      admittedWork: affine.transformWork,
      ...(affine.scaleTranslationPlan ? { scaleTranslationPlan: affine.scaleTranslationPlan } : {}),
    }));
  }

  private validateAuthoredPlanarTrackOpacity(owner: IRNode, value: IRValue, label: string) {
    if (value.kind !== "quantity" || value.dimension !== "ratio" || value.unit !== "ratio") {
      throw new ReferencePlanarTrackError("CUT_PLANAR_TRACK_INPUT_TYPE", owner.id, owner, `${label} must be a canonical Ratio.`);
    }
    const { numerator, denominator } = value.magnitude;
    if (!/^-?(?:0|[1-9][0-9]*)$/u.test(numerator) || numerator === "-0" || !/^[1-9][0-9]*$/u.test(denominator)
      || numerator.replace("-", "").length > referencePlanarTrackLimits.maxRuntimeRationalDigits
      || denominator.length > referencePlanarTrackLimits.maxRuntimeRationalDigits) {
      throw new ReferencePlanarTrackError("CUT_PLANAR_TRACK_INPUT_TYPE", owner.id, owner, `${label} must contain bounded canonical integer strings and a positive denominator.`);
    }
    const canonical = rational(numerator, denominator);
    if (canonical.numerator !== numerator || canonical.denominator !== denominator) {
      throw new ReferencePlanarTrackError("CUT_PLANAR_TRACK_INPUT_TYPE", owner.id, owner, `${label} must be reduced to canonical lowest terms.`);
    }
    if (compareRational(canonical, zeroRational) < 0 || compareRational(canonical, rational(1)) > 0) {
      throw new ReferencePlanarTrackError("CUT_PLANAR_TRACK_RANGE", owner.id, owner, `${label} must be between 0% and 100%.`);
    }
    return canonical;
  }

  private visitPlanarTrackOpacitySignalValues(signal: IRSignal, visit: (value: IRValue) => void) {
    if (signal.kind === "constant") visit(signal.value);
    else if (signal.kind === "step") for (const point of signal.points) visit(point.value);
    else if (signal.kind === "keyframes") for (const keyframe of signal.keyframes) visit(keyframe.value);
    else {
      visit(signal.initial);
      for (const event of signal.events) {
        if (event.kind === "set") visit(event.value);
        else { visit(event.from); visit(event.to); }
      }
    }
  }

  /** Validate every accepted authored/prepared opacity value once. Runtime
   * sampling then uses the shared logarithmic signal evaluator and performs
   * only O(1) result-range checks per projective execution. */
  private preparePlanarTrackOpacityProperties() {
    const validatedSignals = new Set<string>();
    let signalValues = 0;
    for (const nodeId of this.planarTrackConfigs.keys()) {
      const owner = this.ir.nodes[nodeId];
      if (!owner) throw new Error(`Internal CUT PlanarTrack ${nodeId} is missing during opacity preparation.`);
      const property = owner.properties.opacity;
      if (property === undefined) {
        this.preparedPlanarTrackOpacityNodes.add(nodeId);
        continue;
      }
      if (!("signal" in property)) {
        this.validateAuthoredPlanarTrackOpacity(owner, property, "authored opacity property");
        this.preparedPlanarTrackOpacityNodes.add(nodeId);
        continue;
      }
      const authored = this.ir.signals[property.signal];
      if (!authored) throw new ReferencePlanarTrackError("CUT_PLANAR_TRACK_INPUT_TYPE", owner.id, owner, `opacity property references missing signal ${property.signal}.`);
      const resolved = this.preparedSignalResolver.resolve(this.ir, authored);
      if (authored.kind === "track" && authored.producer && !resolved) {
        throw new ReferencePlanarTrackError("CUT_PLANAR_TRACK_INPUT_TYPE", owner.id, owner, `produced opacity signal ${property.signal} was not prepared before PlanarTrack admission.`);
      }
      const signal = resolved ?? authored;
      if (signal.valueType !== "Ratio") {
        throw new ReferencePlanarTrackError("CUT_PLANAR_TRACK_INPUT_TYPE", owner.id, owner, `opacity signal ${property.signal} must declare Ratio values.`);
      }
      if (!validatedSignals.has(signal.id)) {
        this.visitPlanarTrackOpacitySignalValues(signal, (value) => {
          signalValues += 1;
          if (!Number.isSafeInteger(signalValues) || signalValues > referencePlanarTrackLimits.maxOpacitySignalValuesPerComposition) {
            throw new ReferencePlanarTrackError(
              "CUT_PLANAR_TRACK_LIMIT",
              owner.id,
              owner,
              `PlanarTrack opacity signals contain more than ${referencePlanarTrackLimits.maxOpacitySignalValuesPerComposition} prepared values in this composition.`,
            );
          }
          this.validateAuthoredPlanarTrackOpacity(owner, value, `authored opacity signal ${property.signal} value`);
        });
        validatedSignals.add(signal.id);
      }
      this.preparedPlanarTrackOpacityNodes.add(nodeId);
    }
  }

  private planarTrackOpacityAt(owner: IRNode, config: ReferencePlanarTrackConfig, time: Rational) {
    if (!this.preparedPlanarTrackOpacityNodes.has(owner.id)) {
      throw new ReferencePlanarTrackError("CUT_PLANAR_TRACK_INPUT_TYPE", owner.id, owner, "opacity was sampled before prepared-once PlanarTrack property admission.");
    }
    const property = owner.properties.opacity;
    if (property === undefined) return config.opacity;
    const sampled = propertyAt(this.ir, owner, "opacity", time, this.preparedSignalResolver);
    if (sampled === undefined || sampled.kind === "null") return config.opacity;
    if (!("signal" in property)) return this.validateAuthoredPlanarTrackOpacity(owner, sampled, "executed opacity property");
    if (sampled.kind !== "quantity" || sampled.dimension !== "ratio" || sampled.unit !== "ratio") {
      throw new ReferencePlanarTrackError("CUT_PLANAR_TRACK_INPUT_TYPE", owner.id, owner, "executed opacity signal must produce an exact Ratio.");
    }
    const { numerator, denominator } = sampled.magnitude;
    if (!/^-?(?:0|[1-9][0-9]*)$/u.test(numerator) || numerator === "-0" || !/^[1-9][0-9]*$/u.test(denominator)
      || numerator.replace("-", "").length > referencePlanarTrackLimits.maxRuntimeRationalDigits
      || denominator.length > referencePlanarTrackLimits.maxRuntimeRationalDigits) {
      throw new ReferencePlanarTrackError("CUT_PLANAR_TRACK_INPUT_TYPE", owner.id, owner, "evaluated opacity signal produced an invalid bounded exact Ratio.");
    }
    const opacity = rational(numerator, denominator);
    if (compareRational(opacity, zeroRational) < 0 || compareRational(opacity, rational(1)) > 0) {
      throw new ReferencePlanarTrackError("CUT_PLANAR_TRACK_RANGE", owner.id, owner, "executed opacity signal must remain between 0% and 100%.");
    }
    return opacity;
  }

  private reservePlanarTrackFrameWork(
    owner: IRNode,
    local: ReferenceLocalSpaceConfig,
    sample: ReturnType<typeof referencePlanarTrackAt>,
    preflight = false,
  ) {
    const active = this.activePlanarTrackFrameEvidence;
    if (!active) throw new ReferencePlanarTrackError("CUT_PLANAR_TRACK_LIMIT", owner.id, owner, "cannot reserve projective work outside an active exact frame.");
    const alreadyReserved = active.preflightReservations.get(sample.sampleIdentity) ?? 0;
    if (!preflight && alreadyReserved > 0) {
      if (alreadyReserved === 1) active.preflightReservations.delete(sample.sampleIdentity);
      else active.preflightReservations.set(sample.sampleIdentity, alreadyReserved - 1);
      return;
    }
    const nextExecutions = active.reservedExecutions + 1;
    if (!Number.isSafeInteger(nextExecutions) || nextExecutions > referencePlanarTrackLimits.maxExecutionsPerCompositionFrame) {
      throw new ReferencePlanarTrackError(
        "CUT_PLANAR_TRACK_LIMIT",
        owner.id,
        owner,
        `PlanarTrack sampling would execute ${nextExecutions} times in one composition frame, exceeding the ${referencePlanarTrackLimits.maxExecutionsPerCompositionFrame}-execution limit before tile rasterization.`,
      );
    }
    active.reservedExecutions = nextExecutions;
    if (sample.hidden) {
      if (preflight) active.preflightReservations.set(sample.sampleIdentity, alreadyReserved + 1);
      return;
    }
    this.reserveLocalSpaceFrameTile(local);
    const sourceTilePixels = local.width * local.height;
    const nextSourceTilePixels = active.reservedSourceTilePixels + sourceTilePixels;
    const nextLocalPixelPasses = active.reservedLocalPixelPasses + local.estimatedPixelPassesPerFrame;
    if (!Number.isSafeInteger(nextSourceTilePixels) || nextSourceTilePixels > referenceLocalSpaceLimits.maximumLiveLocalSurfacePixelsPerFrame) {
      throw new ReferencePlanarTrackError(
        "CUT_PLANAR_TRACK_LIMIT",
        owner.id,
        owner,
        `temporally sampled source LocalSpace tiles would retain ${nextSourceTilePixels} pixels in one composition frame, exceeding the ${referenceLocalSpaceLimits.maximumLiveLocalSurfacePixelsPerFrame}-pixel limit before tile rasterization.`,
      );
    }
    if (!Number.isSafeInteger(nextLocalPixelPasses) || nextLocalPixelPasses > referenceLocalSpaceLimits.maximumPixelPassesPerFrame) {
      throw new ReferencePlanarTrackError(
        "CUT_PLANAR_TRACK_LIMIT",
        owner.id,
        owner,
        `temporally sampled source LocalSpace work would require ${nextLocalPixelPasses} estimated pixel-passes in one composition frame, exceeding the ${referenceLocalSpaceLimits.maximumPixelPassesPerFrame}-pass limit before tile rasterization.`,
      );
    }
    active.reservedSourceTilePixels = nextSourceTilePixels;
    active.reservedLocalPixelPasses = nextLocalPixelPasses;
    const nextDestinationPixels = active.reservedDestinationPixels + sample.projectivePlan.destination.pixels;
    const canvasRgbaBytes = this.composition.width * this.composition.height * 4;
    const nextCanvasRgbaBytes = active.reservedCanvasRgbaBytes + canvasRgbaBytes;
    const destinationLimit = referencePlanarTrackLimits.maxDestinationPixelsPerCompositionFrame;
    const canvasByteLimit = destinationLimit * 4;
    if (!Number.isSafeInteger(nextDestinationPixels) || nextDestinationPixels > destinationLimit) {
      throw new ReferencePlanarTrackError("CUT_PLANAR_TRACK_LIMIT", owner.id, owner, `visible PlanarTrack destination pixels would reserve ${nextDestinationPixels}, exceeding the ${destinationLimit}-pixel composition-frame limit before tile rasterization.`);
    }
    if (!Number.isSafeInteger(nextCanvasRgbaBytes) || nextCanvasRgbaBytes > canvasByteLimit) {
      throw new ReferencePlanarTrackError("CUT_PLANAR_TRACK_LIMIT", owner.id, owner, `visible PlanarTrack canvas copies would reserve ${nextCanvasRgbaBytes} RGBA bytes, exceeding the ${canvasByteLimit}-byte composition-frame limit before tile rasterization.`);
    }
    active.reservedDestinationPixels = nextDestinationPixels;
    active.reservedCanvasRgbaBytes = nextCanvasRgbaBytes;
    if (preflight) active.preflightReservations.set(sample.sampleIdentity, alreadyReserved + 1);
  }

  private reserveLocalSpaceFrameTile(local: ReferenceLocalSpaceConfig) {
    const active = this.activePlanarTrackFrameEvidence;
    const node = this.ir.nodes[local.nodeId];
    if (!active || !node) throw new Error(`CUT_LOCAL_SPACE_LIMIT: cannot reserve LocalSpace ${local.nodeId} outside an active exact frame.`);
    const next = active.reservedLocalSpaceTiles + 1;
    if (!Number.isSafeInteger(next) || next > referenceLocalSpaceLimits.maximumLocalSpacesPerExecutionDomain) {
      throw new ReferenceLocalSpaceError(
        "CUT_LOCAL_SPACE_LIMIT",
        node,
        `temporal execution would publish ${next} LocalSpace tile receipts in one composition frame, exceeding the closed ${referenceLocalSpaceLimits.maximumLocalSpacesPerExecutionDomain}-tile frame-evidence limit before tile rasterization.`,
      );
    }
    active.reservedLocalSpaceTiles = next;
  }

  private affineLocalSpacePlanKey(ownerNodeId: string, localSpaceNodeId: string, sampleTime: Rational) {
    return `${ownerNodeId}\u0000${localSpaceNodeId}\u0000${sampleTime.numerator}/${sampleTime.denominator}`;
  }

  private affineTransformRequest(
    localSpace: ReferenceLocalSpaceConfig,
    placement: ReferenceLocalSpacePlacement,
    destination: Readonly<{ width: number; height: number }>,
  ): ReferenceLocalSpaceAffineTransformRequest {
    return Object.freeze({
      source: Object.freeze({ width: localSpace.width, height: localSpace.height }),
      destination: Object.freeze({ width: destination.width, height: destination.height }),
      scale: placement.scale,
      skewX: placement.skewX,
      skewY: placement.skewY,
      rotation: placement.rotation,
      opacity: placement.opacity,
    });
  }

  private activeAffineLocalSpacePlan(ownerNodeId: string, localSpaceNodeId: string, time: Rational) {
    const plan = this.activeAffineLocalSpacePlans.get(this.affineLocalSpacePlanKey(ownerNodeId, localSpaceNodeId, time));
    if (!plan || compareRational(plan.exactTime, time) !== 0) {
      const node = this.ir.nodes[ownerNodeId] ?? this.ir.nodes[localSpaceNodeId];
      if (!node) throw new Error(`CUT_LOCAL_SPACE_GRAPH: missing affine owner ${ownerNodeId}.`);
      throw new ReferenceLocalSpaceError("CUT_LOCAL_SPACE_GRAPH", node, `affine LocalSpace ${localSpaceNodeId} reached execution without its exact composition-frame preflight.`);
    }
    return plan;
  }

  /** Resolve every affine LocalSpace output in this composition frame—delivery
   * and nested parent-local alike—then admit their combined live/peak work
   * before any tile pixels can be requested. Owner render paths consume these
   * exact placements and samples instead of resampling dynamic state. */
  private preflightLocalSpaceCompositionTransformWork(scene: IRScene, time: Rational, outputFrame: string) {
    const sampleTimesByNode = new Map<string, Rational[]>(), visited = new Set<string>();
    const recordSample = (nodeId: string, sampleTime: Rational) => {
      const values = sampleTimesByNode.get(nodeId) ?? [];
      if (!values.some((value) => compareRational(value, sampleTime) === 0)) values.push(Object.freeze({ ...sampleTime }));
      sampleTimesByNode.set(nodeId, values);
    };
    const visit = (nodeId: string, sampleTime: Rational) => {
      const visitKey = `${nodeId}\u0000${sampleTime.numerator}/${sampleTime.denominator}`;
      if (visited.has(visitKey)) return;
      visited.add(visitKey);
      const node = this.ir.nodes[nodeId];
      if (!node || !this.active(node, sampleTime)) return;
      recordSample(node.id, sampleTime);
      if (node.op === "cut.visual.motion_blur") {
        const config = this.motionBlurConfigs.get(node.id), child = this.ir.nodes[node.children[0]];
        if (!config || !child) throw new Error(`Reference MotionBlur ${node.id} has no validated affine-preflight boundary.`);
        const boundary = executeMotionBlurOwned(node, () => createReferenceMotionBlurBoundaryPlan(node, child, sampleTime, config));
        for (const sample of boundary.samples) if (sample.sourceTime !== null) visit(child.id, sample.sourceTime);
        return;
      }
      if (node.op === "cut.visual.precomp" || node.op === "cut.edit.nested_sequence") return;
      for (const childId of node.children) visit(childId, sampleTime);
    };
    for (const root of scene.items.filter((item) => item.domain === "visual" || item.domain === "av")) visit(root.id, time);

    const preparedByLocal = new Map<string, ReferencePreparedAffineLocalSpacePlan | undefined>();
    const preparedMediaCameraAnchors = new Map<string, ReturnType<typeof referenceMediaCamera2DAnchorPlanAt>>();
    const preparing = new Set<string>();
    let fullValidationSampling = false;
    let fullValidationTimeKey: string | undefined;
    const resolveAnchoredOwnerDuringPreflight = (
      consumer: IRNode,
      geometry: ReferenceValidatedAnchoredPathGeometry,
      ownerNodeId: string,
      exactTime: Rational,
    ): ReferenceAnchoredPathOwnerResolution => {
      const validationTimeKey = `${exactTime.numerator}/${exactTime.denominator}`;
      if (fullValidationSampling && fullValidationTimeKey !== validationTimeKey) {
        preparedByLocal.clear();
        preparedMediaCameraAnchors.clear();
        preparing.clear();
        fullValidationTimeKey = validationTimeKey;
      }
      const binding = geometry.ownerBindings.find((candidate) => candidate.ownerNodeId === ownerNodeId);
      if (!binding) {
        throw new Error(`CUT_ANCHORED_PATH_GRAPH: ${consumer.id} has no validated coordinate binding for owner ${ownerNodeId}.`);
      }
      if (binding.ownerKind === "media-camera-2d") {
        const cameraPlan = this.mediaCamera2DConfigs.get(ownerNodeId);
        if (!cameraPlan) {
          throw new Error(`CUT_ANCHORED_PATH_GRAPH: ${consumer.id} has no locked MediaCamera2D plan for owner ${ownerNodeId}.`);
        }
        const key = this.mediaCamera2DAnchorPlanKey(ownerNodeId, exactTime);
        const anchorPlanCache = fullValidationSampling
          ? preparedMediaCameraAnchors
          : this.activeMediaCamera2DAnchorPlans;
        let anchorPlan = anchorPlanCache.get(key);
        if (!anchorPlan) {
          const admittedFrame = this.activeMediaCamera2DFramePlans.get(ownerNodeId);
          anchorPlan = admittedFrame && compareRational(admittedFrame.exactTime, exactTime) === 0
            ? referenceMediaCamera2DAnchorPlanFromFramePlan(this.ir, cameraPlan, admittedFrame)
            : referenceMediaCamera2DAnchorPlanAt(
              this.ir,
              this.composition,
              cameraPlan,
              exactTime,
              this.preparedSignalResolver,
            );
          anchorPlanCache.set(key, anchorPlan);
        }
        if (anchorPlan.basis.semanticIdentity !== binding.basisSemanticIdentity
          || anchorPlan.basis.width !== binding.basisWidth
          || anchorPlan.basis.height !== binding.basisHeight) {
          throw new Error(`CUT_ANCHORED_PATH_RESOLUTION: MediaCamera2D owner ${ownerNodeId} source basis changed after anchored-geometry validation.`);
        }
        return Object.freeze({
          status: anchorPlan.status,
          ownerNodeId,
          ownerKind: "media-camera-2d" as const,
          basis: anchorPlan.basis,
          sourceToComposition: anchorPlan.sourceToDelivery,
          affineIdentity: anchorPlan.affineIdentity,
          ...(anchorPlan.responsiveSlotComposition
            ? { responsiveSlotComposition: anchorPlan.responsiveSlotComposition }
            : {}),
          ownerPlanIdentity: anchorPlan.ownerPlanIdentity,
          coordinatePlan: anchorPlan,
        });
      }
      const localSpace = this.localSpaceConfigs.get(binding.localSpaceNodeId);
      if (!localSpace) {
        throw new Error(`CUT_ANCHORED_PATH_GRAPH: ${consumer.id} has no validated LocalSpace binding for owner ${ownerNodeId}.`);
      }
      const prepared = directPlan.call(this, localSpace, exactTime);
      if (!prepared) {
        throw new Error(`CUT_ANCHORED_PATH_RESOLUTION: ${consumer.id} owner ${ownerNodeId} has no active affine plan at ${exactTime.numerator}/${exactTime.denominator}s.`);
      }
      if (prepared.status === "policy-hidden") {
        if (prepared.ownerKind !== "track-2d") {
          throw new Error(`CUT_ANCHORED_PATH_RESOLUTION: only Track2D may directly suppress anchored geometry; ${ownerNodeId} is ${prepared.ownerKind}.`);
        }
        return Object.freeze({
          status: "policy-hidden" as const,
          ownerNodeId,
          ownerKind: "track-2d" as const,
          localSpaceNodeId: binding.localSpaceNodeId,
          ownerPlanIdentity: prepared.planIdentity,
        });
      }
      if (!prepared.placement) {
        throw new Error(`CUT_ANCHORED_PATH_RESOLUTION: ${consumer.id} owner ${ownerNodeId} has ${prepared.status} preflight without a placement.`);
      }
      return Object.freeze({
        status: prepared.status,
        ownerNodeId,
        localSpace,
        placement: prepared.placement,
        ownerPlanIdentity: prepared.planIdentity,
      });
    };
    function directPlan(this: ReferenceVisualRenderer, localSpace: ReferenceLocalSpaceConfig, sampleTime: Rational): ReferencePreparedAffineLocalSpacePlan | undefined {
      const memoKey = `${localSpace.nodeId}\u0000${sampleTime.numerator}/${sampleTime.denominator}`;
      if (preparedByLocal.has(memoKey)) return preparedByLocal.get(memoKey);
      if (preparing.has(memoKey)) throw new Error(`CUT_LOCAL_SPACE_GRAPH: recursive affine preflight at ${localSpace.nodeId}.`);
      preparing.add(memoKey);
      const localNode = this.ir.nodes[localSpace.nodeId];
      if (!localNode || localNode.sceneId !== scene.id || !this.active(localNode, sampleTime)) {
        preparing.delete(memoKey); preparedByLocal.set(memoKey, undefined); return undefined;
      }
      if (localSpace.owner === "geo-annotation"
        || localSpace.owner === "callout"
        || localSpace.owner === "depth-layer"
        || localSpace.owner === "plane-3d"
        || localSpace.owner === "planar-track") {
        preparing.delete(memoKey); preparedByLocal.set(memoKey, undefined); return undefined;
      }
      const owner = localSpace.owner === "scene-root" ? localNode : this.ir.nodes[localSpace.ownerNodeId!];
      if (!owner || owner.sceneId !== scene.id || !this.active(owner, sampleTime)) {
        preparing.delete(memoKey); preparedByLocal.set(memoKey, undefined); return undefined;
      }
      const parentContext = localSpace.owner === "local-space"
        ? this.localSpaceConfigs.get(owner.id)
        : this.localSpaceDescendantContexts.get(owner.id);
      if (parentContext) {
        const parentPlan = directPlan.call(this, parentContext, sampleTime);
        if (!parentPlan || parentPlan.status !== "visible") {
          preparing.delete(memoKey); preparedByLocal.set(memoKey, undefined); return undefined;
        }
      }
      const destination = parentContext
        ? Object.freeze({ width: parentContext.width, height: parentContext.height })
        : Object.freeze({ width: this.composition.width, height: this.composition.height });
      let plan: ReferencePreparedAffineLocalSpacePlan;
      if (localSpace.owner === "component-fragment") {
        const componentPlan = referenceComponentFragmentLocalSpacePlanAt(
          this.ir, this.composition, owner, localSpace, sampleTime, this.preparedSignalResolver,
        );
        plan = Object.freeze({
          ownerNodeId: owner.id,
          localSpaceNodeId: localSpace.nodeId,
          ownerKind: "component-fragment",
          exactTime: Object.freeze({ ...sampleTime }),
          status: componentPlan.status,
          planIdentity: componentPlan.planIdentity,
          placement: componentPlan.placement,
          ...(componentPlan.transformWork ? { transformWork: componentPlan.transformWork } : {}),
          ...(componentPlan.status === "visible" ? { transform: this.affineTransformRequest(localSpace, componentPlan.placement, destination) } : {}),
          componentPlan,
        });
      } else if (localSpace.owner === "camera-2d") {
        const semanticMatch = this.semanticMatches?.sampleAt(owner.id, addRational(scene.start, sampleTime), sampleTime);
        const cameraPlan = semanticMatch ? undefined : referenceCamera2DLocalSpacePlanAt(
          this.ir, this.composition, owner, localSpace, sampleTime, this.preparedSignalResolver,
        );
        const status = semanticMatch ? "visible" as const : cameraPlan!.status;
        const placement = semanticMatch?.placement ?? cameraPlan!.placement;
        const transformWork = semanticMatch?.transformWork ?? cameraPlan!.transformWork;
        plan = Object.freeze({
          ownerNodeId: owner.id,
          localSpaceNodeId: localSpace.nodeId,
          ownerKind: "camera-2d",
          exactTime: Object.freeze({ ...sampleTime }),
          status,
          planIdentity: semanticMatch?.executionIdentity ?? cameraPlan!.planIdentity,
          placement,
          ...(transformWork ? { transformWork } : {}),
          ...(status === "visible" ? { transform: this.affineTransformRequest(localSpace, placement, destination) } : {}),
          ...(semanticMatch ? { semanticMatch } : {}),
        });
      } else if (localSpace.owner === "track-2d") {
        const config = this.track2DConfigs.get(owner.id), track = this.preparedTrack2D.get(owner.id);
        if (!config || !track) throw new ReferenceLocalSpaceError("CUT_LOCAL_SPACE_GRAPH", localNode, `Track2D owner ${owner.id} has no prepared source during affine preflight.`);
        const trackPlan = referenceTrack2DLocalSpacePlanAt(
          this.ir, this.composition, owner, track, config, localSpace, sampleTime, this.preparedSignalResolver,
        );
        const status = trackPlan.skip?.classification === "tracking-policy-hidden" ? "policy-hidden" as const
          : trackPlan.skip?.classification === "owner-opacity" ? "opacity-zero" as const
            : "visible" as const;
        const placement = status !== "policy-hidden" ? Object.freeze({
          owner: "track-2d" as const,
          contextIdentity: trackPlan.cacheIdentity,
          destinationX: trackPlan.destinationRegistration!.x,
          destinationY: trackPlan.destinationRegistration!.y,
          registrationRasterX: trackPlan.sourceSpace.rasterRegistration.x,
          registrationRasterY: trackPlan.sourceSpace.rasterRegistration.y,
          scale: trackPlan.scale!,
          skewX: 0,
          skewY: 0,
          rotation: trackPlan.rotation!,
          opacity: trackPlan.opacity!,
        }) : undefined;
        plan = Object.freeze({
          ownerNodeId: owner.id,
          localSpaceNodeId: localSpace.nodeId,
          ownerKind: "track-2d",
          exactTime: Object.freeze({ ...sampleTime }),
          status,
          planIdentity: trackPlan.cacheIdentity,
          ...(placement ? { placement } : {}),
          ...(status === "visible" && placement ? { transform: this.affineTransformRequest(localSpace, placement, destination) } : {}),
          ...(trackPlan.work.kind === "retained-tile-transform" ? { transformWork: trackPlan.work } : {}),
          trackPlan,
        });
      } else {
        const destinationComposition = parentContext ? this.localComposition(parentContext) : this.composition;
        const origin = this.localSpaceOrigin(localSpace);
        let placement: ReferenceLocalSpacePlacement;
        if (localSpace.owner === "scene-root") {
          placement = Object.freeze({
            owner: "scene-root", contextIdentity: hash({ compositionId: this.composition.id, sceneId: scene.id }),
            destinationX: destination.width / 2, destinationY: destination.height / 2,
            registrationRasterX: origin.x, registrationRasterY: origin.y,
            scale: 1, skewX: 0, skewY: 0, rotation: 0, opacity: 1,
          });
        } else if (localSpace.owner === "local-space") {
          placement = Object.freeze({
            owner: "local-space", contextIdentity: parentContext!.semanticIdentity,
            destinationX: destination.width / 2, destinationY: destination.height / 2,
            registrationRasterX: origin.x, registrationRasterY: origin.y,
            scale: 1, skewX: 0, skewY: 0, rotation: 0, opacity: 1,
          });
        } else {
          const transform = referenceVisualTransformAt(
            this.ir, destinationComposition, owner, sampleTime,
            { staticPosition: true, staticRotation: true }, this.preparedSignalResolver,
          );
          let destinationX = destination.width / 2 + transform.x;
          let destinationY = destination.height / 2 + transform.y;
          let rotation = transform.rotation;
          if (localSpace.owner === "motion-path") {
            const anchoredPlan = this.anchoredMotionPathPlans.get(owner.id);
            const anchored = anchoredPlan ? referenceAnchoredMotionPathResolutionAt(
              this.ir,
              destinationComposition,
              owner,
              sampleTime,
              anchoredPlan,
              (ownerNodeId, exactTime) => resolveAnchoredOwnerDuringPreflight(
                owner,
                anchoredPlan.geometry as ReferenceValidatedAnchoredPathGeometry,
                ownerNodeId,
                exactTime,
              ),
              this.anchoredOutputFrame(),
            ) : undefined;
            if (anchored) {
              const geometry = anchoredPlan!.geometry as ReferenceValidatedAnchoredPathGeometry;
              this.recordAnchoredPathResolution(owner, this.anchoredGeometryEvidenceIdentity(geometry), anchored.anchored);
            }
            if (anchored?.status === "policy-hidden") {
              const policyHiddenBy = Object.freeze({
                kind: "anchored-path-owner-policy" as const,
                executionIdentity: anchored.executionIdentity,
                trackOwnerNodeIds: Object.freeze(anchored.anchored.suppressedBy.map((item) => item.ownerNodeId).sort()),
              });
              plan = Object.freeze({
                ownerNodeId: owner.id,
                localSpaceNodeId: localSpace.nodeId,
                ownerKind: "motion-path",
                exactTime: Object.freeze({ ...sampleTime }),
                status: "policy-hidden",
                planIdentity: anchored.executionIdentity,
                policyHiddenBy,
              });
              preparing.delete(memoKey);
              preparedByLocal.set(memoKey, plan);
              return plan;
            }
            const path = anchored?.sample ?? referenceMotionPathAt(this.ir, destinationComposition, owner, sampleTime, this.motionPathPlan(owner));
            destinationX += path.x; destinationY += path.y; rotation += path.rotation;
            validateReferenceVisualTransformAllocation(owner, destinationComposition, { ...transform, rotation });
          }
          placement = Object.freeze({
            owner: localSpace.owner,
            contextIdentity: parentContext
              ? hash({ parentLocalSpace: parentContext.semanticIdentity, owner: owner.contentHash })
              : hash({ compositionId: this.composition.id, owner: owner.contentHash }),
            destinationX, destinationY,
            registrationRasterX: origin.x + transform.anchorX,
            registrationRasterY: origin.y + transform.anchorY,
            scale: transform.scale, skewX: transform.skewX, skewY: transform.skewY,
            rotation, opacity: transform.opacity,
          });
        }
        const status = placement.opacity === 0 ? "opacity-zero" as const : "visible" as const;
        const transform = status === "visible" ? this.affineTransformRequest(localSpace, placement, destination) : undefined;
        plan = Object.freeze({
          ownerNodeId: owner.id,
          localSpaceNodeId: localSpace.nodeId,
          ownerKind: localSpace.owner as ReferenceAffineLocalSpaceOwnerKind,
          exactTime: Object.freeze({ ...sampleTime }),
          status,
          planIdentity: hash({ owner: owner.id, localSpace: localSpace.semanticIdentity, sampleTime, placement, transform }),
          placement,
          ...(transform ? { transform } : {}),
        });
      }
      preparing.delete(memoKey);
      preparedByLocal.set(memoKey, plan);
      return plan;
    }

    // The owner-independent structural pass ran during ordinary validation.
    // Before this renderer allocates the first dependent pixel, resolve every
    // exact output-frame state once to bound real flatten/dash work and prove
    // resolver-aware MotionPath orientation. Keep only one frame's pure plans
    // in memory while doing so; actual current-frame plans are rebuilt below.
    for (const [consumerNodeId, geometry] of this.validatedAnchoredGeometry) {
      if (this.anchoredFrameStateValidated.has(consumerNodeId)) continue;
      const consumer = this.ir.nodes[consumerNodeId];
      if (!consumer || consumer.sceneId !== scene.id) continue;
      fullValidationSampling = true;
      fullValidationTimeKey = undefined;
      try {
        const vectorPlan = this.anchoredVectorPathPlans.get(consumer.id);
        if (vectorPlan) {
          this.anchoredVectorPathWork.set(consumer.id, validateReferenceAnchoredVectorPathFrameStates(
            this.ir,
            this.composition,
            consumer,
            vectorPlan,
            (ownerNodeId, exactTime) => resolveAnchoredOwnerDuringPreflight(consumer, geometry, ownerNodeId, exactTime),
          ));
        }
        const motionPlan = this.anchoredMotionPathPlans.get(consumer.id);
        if (motionPlan) {
          this.anchoredMotionPathWork.set(consumer.id, validateReferenceAnchoredMotionPathFrameStates(
            this.ir,
            this.composition,
            consumer,
            motionPlan,
            (ownerNodeId, exactTime) => resolveAnchoredOwnerDuringPreflight(consumer, geometry, ownerNodeId, exactTime),
          ));
        }
        this.anchoredFrameStateValidated.add(consumer.id);
      } finally {
        fullValidationSampling = false;
        fullValidationTimeKey = undefined;
        preparedByLocal.clear();
        preparedMediaCameraAnchors.clear();
        preparing.clear();
      }
    }
    if (this.vectorPathWork.size || this.anchoredVectorPathWork.size) {
      validateReferenceVectorPathCompositionWork([...this.vectorPathWork, ...this.anchoredVectorPathWork].map(([nodeId, work]) => ({
        node: this.ir.nodes[nodeId]!,
        work,
      })));
    }
    if (this.anchoredMotionPathWork.size) {
      validateReferenceAnchoredMotionPathCompositionWork([...this.anchoredMotionPathWork].map(([nodeId, work]) => ({
        node: this.ir.nodes[nodeId]!,
        work,
      })));
    }

    const plans: ReferencePreparedAffineLocalSpacePlan[] = [];
    const appendedPlanKeys = new Set<string>();
    const appendPlan = (candidate: ReferencePreparedAffineLocalSpacePlan) => {
      const scaleTranslationPlan = candidate.status === "visible"
        && candidate.placement
        && candidate.transform
        ? planReferenceLocalSpaceScaleTranslation(
          this.ir.nodes[candidate.ownerNodeId]!,
          candidate.transform.source,
          candidate.transform.destination,
          candidate.placement,
        )
        : undefined;
      const plan = scaleTranslationPlan
        ? Object.freeze({ ...candidate, scaleTranslationPlan })
        : candidate;
      const key = this.affineLocalSpacePlanKey(plan.ownerNodeId, plan.localSpaceNodeId, plan.exactTime);
      if (appendedPlanKeys.has(key)) return;
      appendedPlanKeys.add(key);
      this.reserveLocalSpaceRendererTreeEvidenceRecords(1);
      plans.push(plan);
    };
    for (const localSpace of this.localSpaceConfigs.values()) {
      for (const sampleTime of sampleTimesByNode.get(localSpace.nodeId) ?? []) {
        const plan = directPlan.call(this, localSpace, sampleTime);
        if (plan) appendPlan(plan);
      }
    }
    // An anchored Path may reference a sibling owner rather than a child.
    // Add only those exact owner/time plans not already reached by the legacy
    // render DAG; this leaves the pre-extension ordering and identities intact.
    for (const [consumerNodeId, geometry] of this.validatedAnchoredGeometry) {
      for (const sampleTime of sampleTimesByNode.get(consumerNodeId) ?? []) {
        for (const binding of geometry.ownerBindings) {
          if (binding.ownerKind === "media-camera-2d") {
            resolveAnchoredOwnerDuringPreflight(
              this.ir.nodes[consumerNodeId]!,
              geometry,
              binding.ownerNodeId,
              sampleTime,
            );
            continue;
          }
          const localSpace = this.localSpaceConfigs.get(binding.localSpaceNodeId);
          if (!localSpace) throw new Error(`CUT_ANCHORED_PATH_GRAPH: missing LocalSpace ${binding.localSpaceNodeId} during exact frame preflight.`);
          const plan = directPlan.call(this, localSpace, sampleTime);
          if (!plan) throw new Error(`CUT_ANCHORED_PATH_RESOLUTION: owner ${binding.ownerNodeId} is inactive at required anchored sample ${sampleTime.numerator}/${sampleTime.denominator}s.`);
          appendPlan(plan);
        }
      }
    }

    // Generic CalloutLayer roots share the exact SpatialPoint owner resolver
    // with Path/MotionPath but own a separate collision/layout grammar. Resolve
    // only positive-opacity anchors, append any demanded sibling-owner affine
    // plans, then register accepted retained tiles in the same bounded
    // composition transform envelope.
    for (const [layerId, layerConfig] of this.calloutLayerConfigs) {
      const layerNode = this.ir.nodes[layerId];
      if (!layerNode || layerNode.sceneId !== scene.id) continue;
      for (const sampleTime of sampleTimesByNode.get(layerId) ?? []) {
        if (!this.active(layerNode, sampleTime)) continue;
        const calloutPlan = referenceCalloutPlanAt(
          this.ir,
          this.composition,
          layerConfig,
          sampleTime,
          (consumer, geometry, ownerNodeId, exactTime) => {
            const resolution = resolveAnchoredOwnerDuringPreflight(
              consumer,
              geometry,
              ownerNodeId,
              exactTime,
            );
            const binding = geometry.ownerBindings.find(
              (candidate) => candidate.ownerNodeId === ownerNodeId,
            );
            if (binding && binding.ownerKind !== "media-camera-2d") {
              const ownerLocalSpace = this.localSpaceConfigs.get(binding.localSpaceNodeId);
              if (!ownerLocalSpace) {
                throw new ReferenceCalloutError(
                  "CUT_CALLOUT_ANCHOR",
                  consumer,
                  `owner ${ownerNodeId} lost validated LocalSpace ${binding.localSpaceNodeId} during preflight.`,
                );
              }
              const ownerPlan = directPlan.call(this, ownerLocalSpace, exactTime);
              if (!ownerPlan) {
                throw new ReferenceCalloutError(
                  "CUT_CALLOUT_ANCHOR",
                  consumer,
                  `owner ${ownerNodeId} is inactive at a required callout sample.`,
                );
              }
              appendPlan(ownerPlan);
            }
            return resolution;
          },
          this.anchoredOutputFrame(),
        );
        this.activeCalloutLayerPlans.set(
          `${layerId}\u0000${sampleTime.numerator}/${sampleTime.denominator}`,
          calloutPlan,
        );
        for (const decision of calloutPlan.decisions) {
          const owner = this.ir.nodes[decision.nodeId];
          const localSpace = this.localSpaceConfigs.get(decision.localSpaceNodeId);
          if (!owner || !localSpace) {
            throw new ReferenceCalloutError(
              "CUT_CALLOUT_VIEWPORT",
              owner ?? layerNode,
              `decision lost LocalSpace ${decision.localSpaceNodeId}.`,
            );
          }
          if (decision.status === "hidden" && decision.reason === "opacity-zero") {
            appendPlan(Object.freeze({
              ownerNodeId: owner.id,
              localSpaceNodeId: localSpace.nodeId,
              ownerKind: "callout" as const,
              exactTime: Object.freeze({ ...sampleTime }),
              status: "opacity-zero" as const,
              planIdentity: hash({
                decisionIdentity: calloutPlan.decisionIdentity,
                nodeId: owner.id,
                status: decision.reason,
              }),
            }));
            continue;
          }
          if (decision.status === "hidden" && decision.reason === "owner-policy-hidden") {
            if (!decision.anchorExecutionIdentity || !decision.suppressedBy?.length) {
              throw new ReferenceCalloutError(
                "CUT_CALLOUT_ANCHOR",
                owner,
                "owner-policy-hidden decision has no authenticated Track2D suppression cause.",
              );
            }
            const policyHiddenBy = Object.freeze({
              kind: "anchored-path-owner-policy" as const,
              executionIdentity: decision.anchorExecutionIdentity,
              trackOwnerNodeIds: Object.freeze(
                decision.suppressedBy.map((entry) => entry.ownerNodeId).sort(),
              ),
            });
            appendPlan(Object.freeze({
              ownerNodeId: owner.id,
              localSpaceNodeId: localSpace.nodeId,
              ownerKind: "callout" as const,
              exactTime: Object.freeze({ ...sampleTime }),
              status: "policy-hidden" as const,
              planIdentity: hash({
                decisionIdentity: calloutPlan.decisionIdentity,
                nodeId: owner.id,
                status: decision.reason,
                policyHiddenBy,
              }),
              policyHiddenBy,
            }));
            continue;
          }
          if (decision.status !== "accepted" || !decision.rect) continue;
          const origin = this.localSpaceOrigin(localSpace);
          const placement = Object.freeze({
            owner: "callout" as const,
            contextIdentity: hash({
              compositionId: this.composition.id,
              layerSemanticIdentity: layerConfig.semanticIdentity,
              decisionIdentity: calloutPlan.decisionIdentity,
              nodeId: owner.id,
              rect: decision.rect,
            }),
            destinationX: decision.rect.left + origin.x,
            destinationY: decision.rect.top + origin.y,
            registrationRasterX: origin.x,
            registrationRasterY: origin.y,
            scale: 1,
            skewX: 0,
            skewY: 0,
            rotation: 0,
            opacity: 1,
          });
          appendPlan(Object.freeze({
            ownerNodeId: owner.id,
            localSpaceNodeId: localSpace.nodeId,
            ownerKind: "callout" as const,
            exactTime: Object.freeze({ ...sampleTime }),
            status: "visible" as const,
            planIdentity: hash({
              decisionIdentity: calloutPlan.decisionIdentity,
              nodeId: owner.id,
              placement,
            }),
            placement,
            transform: this.affineTransformRequest(
              localSpace,
              placement,
              this.composition,
            ),
          }));
        }
      }
    }

    // DepthLayer retained sources and accepted annotation viewports are
    // planned by their camera grammar, then folded into the same affine
    // composition envelope. Projective Plane3D/PlanarTrack remain under their
    // separate explicit projective budgets because they never call this path.
    for (const [cameraId, config] of this.parallaxCameraConfigs) {
      const camera = this.ir.nodes[cameraId];
      if (!camera || camera.sceneId !== scene.id) continue;
      for (const sampleTime of sampleTimesByNode.get(camera.id) ?? []) {
      if (!this.active(camera, sampleTime)) continue;
      const cameraPlan = referenceParallaxCameraPlanAt(
        this.ir, this.composition, config, sampleTime,
        `sharp@${sharp.versions.sharp ?? "missing"};libvips@${sharp.versions.vips ?? "missing"}`,
      );
      this.activeParallaxCameraPlans.set(`${camera.id}\u0000${sampleTime.numerator}/${sampleTime.denominator}`, cameraPlan);
      for (const layer of cameraPlan.layers) {
        if (layer.sourceSpace.kind !== "local-space" || !layer.sourceSpace.localSpaceNodeId || !layer.localSpaceTransformWork) continue;
        const owner = this.ir.nodes[layer.nodeId], localSpace = this.localSpaceConfigs.get(layer.sourceSpace.localSpaceNodeId);
        if (!owner || !localSpace) continue;
        const placement = Object.freeze({
          owner: "depth-layer" as const,
          contextIdentity: hash({ cameraPlanIdentity: cameraPlan.cacheIdentity, layerNodeId: layer.nodeId, sourcePlacement: layer.sourcePlacement, edge: layer.edge, clamp: layer.clamp }),
          destinationX: layer.sourcePlacement.destinationRegistration.x,
          destinationY: layer.sourcePlacement.destinationRegistration.y,
          registrationRasterX: layer.sourcePlacement.rasterRegistration.x,
          registrationRasterY: layer.sourcePlacement.rasterRegistration.y,
          scale: layer.sourcePlacement.scale, skewX: 0, skewY: 0, rotation: 0, opacity: 1,
        });
        appendPlan(Object.freeze({
          ownerNodeId: owner.id, localSpaceNodeId: localSpace.nodeId, ownerKind: "depth-layer",
          exactTime: Object.freeze({ ...sampleTime }), status: "visible",
          planIdentity: hash({ cameraPlan: cameraPlan.cacheIdentity, layer: layer.nodeId, placement }),
          placement, transformWork: layer.localSpaceTransformWork,
          transform: Object.freeze({
            source: Object.freeze({ width: layer.projectedRaster.sourceWidth, height: layer.projectedRaster.sourceHeight }),
            destination: Object.freeze({ width: this.composition.width, height: this.composition.height }),
            scale: layer.projectionScale, skewX: 0, skewY: 0, rotation: 0, opacity: 1,
          }),
        }));
      }
      const annotations = this.geoAnnotationCameraConfigs.get(camera.id);
      if (annotations) {
        const annotationPlan = referenceGeoAnnotationPlanAt(this.ir, this.composition, annotations, config, sampleTime, cameraPlan);
        this.activeGeoAnnotationPlans.set(`${camera.id}\u0000${sampleTime.numerator}/${sampleTime.denominator}`, annotationPlan);
        for (const decision of annotationPlan.decisions) {
          if (decision.status !== "accepted" || !decision.rect) continue;
          const owner = this.ir.nodes[decision.nodeId], localSpace = owner ? this.localSpaceConfigs.get(owner.children[0]!) : undefined;
          if (!owner || !localSpace) continue;
          const origin = this.localSpaceOrigin(localSpace);
          const placement = Object.freeze({
            owner: "geo-annotation" as const,
            contextIdentity: hash({ compositionId: this.composition.id, annotation: owner.contentHash, layerId: decision.layerId, rect: decision.rect }),
            destinationX: decision.rect.left + origin.x, destinationY: decision.rect.top + origin.y,
            registrationRasterX: origin.x, registrationRasterY: origin.y,
            scale: 1, skewX: 0, skewY: 0, rotation: 0, opacity: 1,
          });
          appendPlan(Object.freeze({
            ownerNodeId: owner.id, localSpaceNodeId: localSpace.nodeId, ownerKind: "geo-annotation",
            exactTime: Object.freeze({ ...sampleTime }), status: "visible",
            planIdentity: hash({ decisionIdentity: annotationPlan.decisionIdentity, nodeId: owner.id, placement }),
            placement, transform: this.affineTransformRequest(localSpace, placement, this.composition),
          }));
        }
      }
      }
    }
    for (const [cameraId, config] of this.mapCameraConfigs) {
      const camera = this.ir.nodes[cameraId], annotations = this.mapCameraAnnotationConfigs.get(cameraId);
      if (!camera || !annotations || camera.sceneId !== scene.id) continue;
      for (const sampleTime of sampleTimesByNode.get(camera.id) ?? []) {
      if (!this.active(camera, sampleTime)) continue;
      const annotationPlan = referenceMapCameraGeoAnnotationPlanAt(this.ir, this.composition, config, annotations, sampleTime);
      this.activeMapCameraGeoAnnotationPlans.set(`${camera.id}\u0000${sampleTime.numerator}/${sampleTime.denominator}`, annotationPlan);
      for (const decision of annotationPlan.decisions) {
        if (decision.status !== "accepted" || !decision.rect) continue;
        const owner = this.ir.nodes[decision.nodeId], localSpace = owner ? this.localSpaceConfigs.get(owner.children[0]!) : undefined;
        if (!owner || !localSpace) continue;
        const origin = this.localSpaceOrigin(localSpace);
        const placement = Object.freeze({
          owner: "geo-annotation" as const,
          contextIdentity: hash({ compositionId: this.composition.id, annotation: owner.contentHash, layerId: decision.layerId, rect: decision.rect }),
          destinationX: decision.rect.left + origin.x, destinationY: decision.rect.top + origin.y,
          registrationRasterX: origin.x, registrationRasterY: origin.y,
          scale: 1, skewX: 0, skewY: 0, rotation: 0, opacity: 1,
        });
        appendPlan(Object.freeze({
          ownerNodeId: owner.id, localSpaceNodeId: localSpace.nodeId, ownerKind: "geo-annotation",
          exactTime: Object.freeze({ ...sampleTime }), status: "visible",
          planIdentity: hash({ decisionIdentity: annotationPlan.decisionIdentity, nodeId: owner.id, placement }),
          placement, transform: this.affineTransformRequest(localSpace, placement, this.composition),
        }));
      }
      }
    }

    const entries: ReferenceLocalSpaceCompositionTransformPreflightEntry[] = plans.map((plan) => Object.freeze({
      owner: this.ir.nodes[plan.ownerNodeId]!,
      localSpace: this.localSpaceConfigs.get(plan.localSpaceNodeId)!,
      ownerKind: plan.ownerKind,
      exactTime: plan.exactTime,
      status: plan.status,
      ...(plan.transform ? { transform: plan.transform } : {}),
      ...(plan.policyHiddenBy ? { policyHiddenBy: plan.policyHiddenBy } : {}),
    }));
    const preflight = referenceLocalSpaceCompositionTransformPreflight(
      this.ir, this.composition, { sceneId: scene.id, exactTime: time, outputFrame }, entries,
    );
    const componentEntries = Object.freeze(plans.flatMap((plan) => plan.componentPlan ? [Object.freeze({
      owner: this.ir.nodes[plan.ownerNodeId]!,
      localSpace: this.localSpaceConfigs.get(plan.localSpaceNodeId)!,
      exactTime: plan.exactTime,
    })] : []));
    const componentPreflight = referenceComponentFragmentLocalSpaceFramePreflight(
      this.ir, this.composition, { sceneId: scene.id, exactTime: time, outputFrame }, componentEntries, this.preparedSignalResolver,
    );
    const admissionByPair = new Map(preflight.admissions.map((entry) => [
      this.affineLocalSpacePlanKey(entry.ownerNodeId, entry.localSpaceNodeId, entry.sampleTime),
      entry,
    ]));
    this.activeAffineLocalSpacePlans.clear();
    for (const plan of plans) {
      const key = this.affineLocalSpacePlanKey(plan.ownerNodeId, plan.localSpaceNodeId, plan.exactTime);
      const admission = admissionByPair.get(key);
      if (plan.status === "visible" && !admission) throw new Error(`CUT_LOCAL_SPACE_GRAPH: visible affine plan ${key} was omitted from aggregate admission.`);
      if (admission && plan.transformWork && admission.work.workIdentity !== plan.transformWork.workIdentity) {
        throw new ReferenceLocalSpaceError("CUT_LOCAL_SPACE_RASTER", this.ir.nodes[plan.ownerNodeId]!, `owner-specific work ${plan.transformWork.workIdentity} diverges from composition admission ${admission.work.workIdentity}.`);
      }
      this.activeAffineLocalSpacePlans.set(key, Object.freeze({
        ...plan,
        ...(admission ? {
          admissionPlanIdentity: admission.planIdentity,
          transformWork: admission.work,
        } : {}),
      }));
    }
    this.activeLocalSpaceCompositionTransformPreflight = preflight;
    this.activeComponentFragmentLocalSpacePreflight = componentPreflight;
  }

  /** Dry-run the same node/time DAG before any root evaluation. Ordinary
   * wrappers recurse at the same exact time; MotionBlur expands its already
   * validated shutter plan. The memo key mirrors nodeFrame, so shared DAG paths
   * and repeated shutter times reserve once, while nested temporal samples are
   * counted distinctly before any LocalSpace tile can start. */
  private preflightPlanarTrackFrameWork(scene: IRScene, time: Rational, frame: number) {
    const visited = new Set<string>();
    const visit = (nodeId: string, sampleTime: Rational) => {
      const key = `${frame}:${sampleTime.numerator}/${sampleTime.denominator}:${nodeId}`;
      if (visited.has(key)) return;
      visited.add(key);
      const node = this.ir.nodes[nodeId];
      if (!node || !this.active(node, sampleTime)) return;
      const config = this.planarTrackConfigs.get(node.id), track = this.preparedPlanarTracks.get(node.id);
      if (config && track && node.children.length === 1) {
        const localNode = this.ir.nodes[node.children[0]];
        if (localNode?.op !== "cut.visual.local_space") return;
        const local = this.localSpaceConfig(localNode);
        const sampled = referencePlanarTrackAt(node, track, config, subtractRational(sampleTime, node.interval.start), {
          sourceWidth: local.width,
          sourceHeight: local.height,
          opacity: this.planarTrackOpacityAt(node, config, sampleTime),
        });
        this.reservePlanarTrackFrameWork(node, local, sampled, true);
        return;
      }
      if (node.op === "cut.visual.motion_blur") {
        const config = this.motionBlurConfigs.get(node.id), child = this.ir.nodes[node.children[0]];
        if (!config || !child) throw new Error(`Reference MotionBlur ${node.id} has no validated preflight boundary.`);
        const boundary = executeMotionBlurOwned(node, () => createReferenceMotionBlurBoundaryPlan(node, child, sampleTime, config));
        for (const sample of boundary.samples) if (sample.sourceTime !== null) visit(child.id, sample.sourceTime);
        return;
      }
      if (node.op === "cut.visual.local_space") {
        const local = this.localSpaceConfig(node);
        this.reserveLocalSpaceFrameTile(local);
      }
      // Precomp owns a separate renderer/composition budget and performs its
      // own exact-frame preflight. Every other accepted visual wrapper reaches
      // direct children on this renderer; inactive descendants self-filter.
      if (node.op === "cut.visual.precomp" || node.op === "cut.edit.nested_sequence") return;
      for (const childId of node.children) visit(childId, sampleTime);
    };
    for (const root of scene.items.filter((item) => item.domain === "visual" || item.domain === "av")) visit(root.id, time);
  }

  /** PlanarTrack is a projective materialization boundary. It samples one
   * locked four-corner observation, rasterizes the direct LocalSpace once, and
   * consumes the isolated warp kernel without entering the affine placement
   * path. Hidden policies and dynamic zero opacity terminate before tile work. */
  private async planarTrackLocalSpaceFrame(owner: IRNode, localNode: IRNode, time: Rational, frame: number) {
    const config = this.planarTrackConfigs.get(owner.id), track = this.preparedPlanarTracks.get(owner.id), local = this.localSpaceConfig(localNode);
    if (!config || !track) throw new ReferenceLocalSpaceError("CUT_LOCAL_SPACE_RASTER", localNode, `PlanarTrack owner ${owner.id} has no prepared locked planar tracking source.`);
    const active = this.activePlanarTrackFrameEvidence;
    if (!active) throw new ReferenceLocalSpaceError("CUT_LOCAL_SPACE_RASTER", localNode, `PlanarTrack owner ${owner.id} executed outside a staged exact-frame receipt.`);
    const sampled = referencePlanarTrackAt(
      owner,
      track,
      config,
      subtractRational(time, owner.interval.start),
      {
        sourceWidth: local.width,
        sourceHeight: local.height,
        opacity: this.planarTrackOpacityAt(owner, config, time),
      },
    );
    this.reservePlanarTrackFrameWork(owner, local, sampled);
    const evidenceBase = {
      compositionId: this.composition.id,
      owner,
      localSpaceNode: localNode,
      exactTime: addRational(active.compositionTime, subtractRational(time, active.sceneLocalTime)),
      outputFrame: active.outputFrame,
      backendIdentity: this.planarTrackBackendIdentity(),
      prepared: track,
    } as const;
    if (sampled.hidden) {
      if (sampled.skip.classification === "tracking-policy-hidden") {
        this.recordLocalSpaceSkip(localNode, "owner-policy", "tracking-policy-hidden", owner.id, time);
      } else {
        this.recordLocalSpaceSkip(localNode, "owner-opacity", "opacity-zero", owner.id, time);
      }
      active.executions.push(referencePlanarTrackSkippedFrameExecution({ ...evidenceBase, sample: sampled }));
      return undefined;
    }

    const tileIdentity = referenceLocalSpaceTileIdentity(local, time, this.localSpaceBackendIdentity());
    const tile = await this.localSpaceTile(local, time, frame);
    const tileRgbaSha256 = createHash("sha256").update(tile.data).digest("hex");
    const matte = this.planarTrackMatteConfigs.get(owner.id);
    const matteOperation = matte
      ? local.localCompositing.operations.find((operation) => operation.nodeId === matte.maskNodeId)
      : undefined;
    if (matte && (!matteOperation || matteOperation.op !== "cut.visual.mask")) {
      throw new ReferenceLocalSpaceError(
        "CUT_LOCAL_SPACE_RASTER",
        localNode,
        `PlanarTrack matte ${matte.maskNodeId} is absent from the admitted pre-projective LocalSpace compositor plan.`,
      );
    }
    const preProjectiveMatte = matte && matteOperation ? Object.freeze({
      algorithmVersion: matte.algorithmVersion,
      maskNodeId: matte.maskNodeId,
      targetNodeId: matte.targetNodeId,
      matteNodeId: matte.matteNodeId,
      mode: matte.mode,
      coordinateSpace: matte.coordinateSpace,
      evaluationStage: matte.evaluationStage,
      authoring: matte.authoring,
      configIdentity: matte.semanticIdentity,
      localCompositingPlanIdentity: local.localCompositing.semanticIdentity,
      operationSemanticIdentity: matteOperation.semanticIdentity,
    }) : undefined;
    const executed = await this.serializeLocalSpaceTransform(async () => {
      const warp = rasterReferenceProjectiveWarp({ data: tile.data, width: tile.width, height: tile.height, alphaMode: "straight" }, sampled.projectivePlan);
      const canvas = placeReferenceProjectiveWarpOnCanvas(warp, this.composition.width, this.composition.height, rationalToNumber(sampled.opacity));
      return { warp, canvas };
    });
    const tightSurfaceRgbaSha256 = createHash("sha256").update(executed.warp.surface.data).digest("hex");
    const outputRgbaSha256 = createHash("sha256").update(executed.canvas.surface.data).digest("hex");
    active.executions.push(referencePlanarTrackRenderedFrameExecution({
      ...evidenceBase,
      sample: sampled,
      tileIdentity,
      tileRgbaSha256,
      ...(preProjectiveMatte ? { preProjectiveMatte } : {}),
      warp: executed.warp,
      tightSurfaceRgbaSha256,
      canvas: executed.canvas,
      outputRgbaSha256,
    }));
    return {
      data: Buffer.from(executed.canvas.surface.data),
      width: executed.canvas.surface.width,
      height: executed.canvas.surface.height,
    };
  }

  private active(node: IRNode, time: Rational) { return compareRational(time, node.interval.start) >= 0 && compareRational(time, addRational(node.interval.start, node.interval.duration)) < 0; }

  private linkedClipEdgeOpacity(node: IRNode, local: Rational) {
    if (node.op !== "cut.edit.clip") return 1;
    let duration = rationalToNumber(node.interval.duration);
    const range = node.inputs.range;
    if (node.inputs.duration === undefined && range?.kind === "range") duration = quantityNumber(range.end) - quantityNumber(range.start);
    const elapsed = rationalToNumber(local), fadeIn = quantityNumber(node.inputs.fadeIn), fadeOut = quantityNumber(node.inputs.fadeOut);
    const incoming = fadeIn > 0 ? Math.max(0, Math.min(1, elapsed / fadeIn)) : 1;
    const outgoing = fadeOut > 0 ? Math.max(0, Math.min(1, (duration - elapsed) / fadeOut)) : 1;
    return incoming * outgoing;
  }

  private async pictureClipTransitionFrame(nodeId: string, sourceTime: Rational, transformTime: Rational) {
    const node = this.ir.nodes[nodeId];
    if (!node || node.op !== "cut.edit.picture_clip") throw new Error(`CUT PictureTrack transition references non-PictureClip node ${nodeId}.`);
    const surface = await this.mediaFrame(node, 0, sourceTime);
    const transform = referenceVisualTransformAt(this.ir, this.composition, node, transformTime, { staticPosition: false, staticRotation: true }, this.preparedSignalResolver);
    if (transform.opacity === 0) return transparent(this.composition.width, this.composition.height);
    return scaleAlpha(
      await placeOnCanvas(surface, this.composition.width, this.composition.height, transform.x, transform.y, transform.scale, transform.rotation, transform.skewX, transform.skewY, transform.anchorX, transform.anchorY),
      transform.opacity,
    );
  }

  private async precompFrame(node: IRNode, local: Rational) {
    const config = this.precompConfigs.get(node.id);
    if (!config) throw new Error(`Reference nested composition ${node.id} has no validated source configuration.`);
    const renderer = await this.preparedPrecompRenderer(node.id, config);
    const source = renderer.composition;
    const sourceTime = addRational(config.sourceRange.start, local);
    const sourceFrame = multiplyRational(sourceTime, source.fps);
    if (sourceFrame.denominator !== "1") throw new Error(`${config.kind === "av" ? "CUT_NESTED_TIMING" : "CUT_PRECOMP_TIMING"}: ${config.kind === "av" ? "NestedSequence" : "Precomp"} ${node.id} source time does not land on the exact source frame grid.`);
    const scene = source.sceneIds.map((id) => this.ir.scenes[id]).find((candidate) => candidate
      && compareRational(sourceTime, candidate.start) >= 0
      && compareRational(sourceTime, addRational(candidate.start, candidate.duration)) < 0);
    if (!scene) throw new Error(`${config.kind === "av" ? "CUT_NESTED_TIMING" : "CUT_PRECOMP_TIMING"}: ${config.kind === "av" ? "NestedSequence" : "Precomp"} ${node.id} has no source scene covering frame ${sourceFrame.numerator}.`);
    const sceneFrame = multiplyRational(subtractRational(sourceTime, scene.start), source.fps);
    if (sceneFrame.denominator !== "1") throw new Error(`${config.kind === "av" ? "CUT_NESTED_TIMING" : "CUT_PRECOMP_TIMING"}: ${config.kind === "av" ? "NestedSequence" : "Precomp"} ${node.id} source scene time does not land on an exact frame.`);
    const key = `${node.id}:${sourceFrame.numerator}`;
    let pending = this.precompFrames.get(key);
    if (!pending) {
      pending = (async () => {
        const surface = await renderer.sceneFrame(scene, Number(BigInt(sceneFrame.numerator)), false);
        const activeLocalSpaceExecutions = this.activeNestedLocalSpaceRendererFrameExecutions;
        if (!activeLocalSpaceExecutions || renderer.completedLocalSpaceRendererFrameExecutions.length < 1) {
          throw new Error(`CUT_LOCAL_SPACE_RASTER: nested composition ${node.id} completed without one renderer-tree LocalSpace execution.`);
        }
        for (const execution of renderer.completedLocalSpaceRendererFrameExecutions) {
          this.reserveLocalSpaceRendererTreeEvidenceRecords(0);
          activeLocalSpaceExecutions.push(this.prefixedNestedLocalSpaceRendererFrameExecution(
            node,
            source.id,
            execution,
          ));
        }
        const prefix = Object.freeze({ compositionId: this.composition.id, instanceNodeId: node.id, sourceCompositionId: source.id });
        const nestedPictureTimeMapEvidence =
          renderer.referencePictureTimeMapExecutionEvidence().map((evidence) =>
            prefixReferencePictureTimeMapFrameEvidence(evidence, prefix));
        this.reservePictureTimeMapFrameEvidence(
          nestedPictureTimeMapEvidence.length,
        );
        const activePictureTimeMapEvidence =
          this.activePictureTimeMapFrameEvidence;
        if (!activePictureTimeMapEvidence) {
          throw new ReferencePictureTimeMapFrameEvidenceError(
            `nested composition ${node.id} completed outside a staged typed-time evidence transaction.`,
          );
        }
        activePictureTimeMapEvidence.receipts.push(
          ...nestedPictureTimeMapEvidence,
        );
        const nestedEvidence = renderer.referenceGeoAnnotationEvidence().map((evidence): ReferenceGeoAnnotationRenderedFrameEvidence => {
          const executionPath = Object.freeze([prefix, ...evidence.executionPath]);
          return Object.freeze({
            ...evidence,
            executionPath,
            executionIdentity: referenceGeoAnnotationExecutionIdentity(evidence.decisionIdentity, evidence.decisions, executionPath),
          });
        });
        this.geoAnnotationFrameEvidence = Object.freeze([...this.geoAnnotationFrameEvidence, ...nestedEvidence]);
        const nestedCallouts = renderer.referenceCalloutLayerEvidence().map(
          (evidence): ReferenceCalloutRenderedFrameEvidence => {
            const executionPath = Object.freeze([prefix, ...evidence.executionPath]);
            const { executionIdentity: priorExecutionIdentity, ...priorBody } = evidence;
            void priorExecutionIdentity;
            const body = Object.freeze({
              ...priorBody,
              executionPath,
            });
            return validateReferenceCalloutFrameEvidenceSemantics(Object.freeze({
              ...body,
              executionIdentity: referenceCalloutExecutionIdentity(body),
            }));
          },
        );
        if (!this.activeCalloutFrameEvidence) {
          throw new Error(
            `CUT_CALLOUT_GRAPH: nested composition ${node.id} completed outside a staged Callout evidence transaction.`,
          );
        }
        this.activeCalloutFrameEvidence.push(...nestedCallouts);
        return surface;
      })();
      this.precompFrames.set(key, pending);
    }
    return pending;
  }

  private async parallaxProjectedLayer(
    layer: ReferenceParallaxLayerFrame,
    time: Rational,
    frame: number,
    ordinaryChildIds: readonly string[] | undefined,
  ) {
    const retainedLocalNode = layer.sourceSpace.kind === "local-space" && layer.sourceSpace.localSpaceNodeId
      ? this.ir.nodes[layer.sourceSpace.localSpaceNodeId]
      : undefined;
    const retainedLocalConfig = retainedLocalNode ? this.localSpaceConfig(retainedLocalNode) : undefined;
    if (retainedLocalNode && !this.active(retainedLocalNode, time)) {
      this.recordLocalSpaceSkip(retainedLocalNode, "inactive-node", "outside-interval", layer.nodeId, time);
      return undefined;
    }
    const materialized = retainedLocalConfig
      ? await this.localSpaceTile(retainedLocalConfig, time, frame)
      : ordinaryChildIds === undefined
        ? await this.nodeFrame(layer.nodeId, time, frame)
      : await (async () => {
        const children: RawSurface[] = [];
        for (const childId of ordinaryChildIds) {
          const child = await this.nodeFrame(childId, time, frame);
          if (child) children.push(child);
        }
        return children.length ? composite(this.composition.width, this.composition.height, children) : undefined;
      })();
    if (!materialized) return undefined;
    let source = materialized;
    if (layer.edge === "clamp" && layer.clamp.needed) {
      const extended = await sharp(source.data, raw(source)).extend({
        left: layer.clamp.left,
        top: layer.clamp.top,
        right: layer.clamp.right,
        bottom: layer.clamp.bottom,
        extendWith: "copy",
      }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      if (extended.info.width !== layer.clamp.width || extended.info.height !== layer.clamp.height || extended.info.channels !== 4) {
        throw new Error(`CUT DepthLayer ${layer.nodeId} clamp backend returned an unexpected raster shape.`);
      }
      source = { data: extended.data, width: extended.info.width, height: extended.info.height };
    }
    if (source.width !== layer.projectedRaster.sourceWidth || source.height !== layer.projectedRaster.sourceHeight) {
      throw new Error(`CUT DepthLayer ${layer.nodeId} source raster ${source.width}x${source.height} does not match its validated ${layer.projectedRaster.sourceWidth}x${layer.projectedRaster.sourceHeight} projection plan.`);
    }
    const resizedWidth = Math.max(1, Math.round(source.width * layer.projectionScale));
    const resizedHeight = Math.max(1, Math.round(source.height * layer.projectionScale));
    if (resizedWidth !== layer.projectedRaster.width || resizedHeight !== layer.projectedRaster.height) {
      throw new Error(`CUT DepthLayer ${layer.nodeId} resized raster ${resizedWidth}x${resizedHeight} does not match its validated ${layer.projectedRaster.width}x${layer.projectedRaster.height} projection plan.`);
    }
    const depthLayerNode = retainedLocalConfig ? this.ir.nodes[layer.nodeId] : undefined;
    const affine = retainedLocalConfig && depthLayerNode
      ? this.activeAffineLocalSpacePlan(depthLayerNode.id, retainedLocalConfig.nodeId, time)
      : undefined;
    if (retainedLocalConfig && (!depthLayerNode || !layer.localSpaceTransformWork || !affine?.placement || !affine.transformWork)) {
      throw new ReferenceLocalSpaceError(
        "CUT_LOCAL_SPACE_RASTER",
        retainedLocalNode!,
        `DepthLayer ${layer.nodeId} has no admitted retained transform work at execution.`,
      );
    }
    const projected = retainedLocalConfig
      ? await this.placeLocalSpaceTile(retainedLocalConfig, materialized, affine!.placement!, this.composition.width, this.composition.height, time, source, Object.freeze({
        sourceNode: depthLayerNode!,
        admittedWork: affine!.transformWork!,
        ...(affine!.scaleTranslationPlan ? { scaleTranslationPlan: affine!.scaleTranslationPlan } : {}),
      }))
      : await (async () => {
        const scale = layer.projectionScale, centerX = this.composition.width / 2, centerY = this.composition.height / 2;
        const cameraOffsetX = layer.matrix.tx - centerX * (1 - scale);
        const cameraOffsetY = layer.matrix.ty - centerY * (1 - scale);
        const paddedCenterDeltaX = layer.edge === "clamp" ? (layer.clamp.left - layer.clamp.right) / 2 : 0;
        const paddedCenterDeltaY = layer.edge === "clamp" ? (layer.clamp.top - layer.clamp.bottom) / 2 : 0;
        return placeOnCanvas(
          source,
          this.composition.width,
          this.composition.height,
          cameraOffsetX - scale * paddedCenterDeltaX,
          cameraOffsetY - scale * paddedCenterDeltaY,
          scale,
          0,
        );
      })();
    // The public focus sigma is a delivery-pixel quantity. It executes only
    // after source edge policy, projection, and delivery crop, and before the
    // resolved paint-order composite.
    return applyParallaxFocusBlur(projected, layer.focusBlurSigma);
  }

  private camera3DBackendIdentity() {
    return `camera3d@${referenceProjectiveWarpAlgorithmVersion};canvas@${referenceProjectiveWarpCanvasAlgorithmVersion};${this.localSpaceBackendIdentity()}`;
  }

  private async camera3DFrame(node: IRNode, time: Rational, frame: number) {
    const config = this.camera3DConfigs.get(node.id);
    if (!config) throw new Error(`Reference Camera3D ${node.id} has no validated planar-3D configuration.`);
    const backendIdentity = this.camera3DBackendIdentity();
    const plan = referenceCamera3DPlanAt(this.ir, this.composition, config, time, backendIdentity);
    const byId = new Map(plan.planes.map((plane) => [plane.nodeId, plane]));
    const surfaces: RawSurface[] = [];
    const executions: ReferenceCamera3DPlaneExecution[] = [];
    for (const planeId of plan.paintOrder) {
      const plane = byId.get(planeId);
      if (!plane || plane.status !== "visible") throw new Error(`CUT Camera3D ${node.id} paint order references a missing visible plane ${planeId}.`);
      const localConfig = this.localSpaceConfigs.get(plane.localSpaceNodeId);
      if (!localConfig || localConfig.owner !== "plane-3d" || localConfig.ownerNodeId !== plane.nodeId) {
        throw new Error(`CUT Camera3D Plane3D ${plane.nodeId} lost its validated LocalSpace tile ${plane.localSpaceNodeId}.`);
      }
      const tile = await this.localSpaceTile(localConfig, time, frame);
      if (tile.width !== plane.projectivePlan.source.width || tile.height !== plane.projectivePlan.source.height) {
        throw new Error(`CUT Camera3D Plane3D ${plane.nodeId} tile ${tile.width}x${tile.height} diverges from its admitted ${plane.projectivePlan.source.width}x${plane.projectivePlan.source.height} warp source.`);
      }
      const warped = rasterReferenceProjectiveWarp({
        data: tile.data,
        width: tile.width,
        height: tile.height,
        alphaMode: "straight",
      }, plane.projectivePlan);
      const placed = placeReferenceProjectiveWarpOnCanvas(warped, this.composition.width, this.composition.height, plane.state.opacity);
      const surface: RawSurface = { data: Buffer.from(placed.surface.data), width: placed.surface.width, height: placed.surface.height };
      surfaces.push(surface);
      executions.push(Object.freeze({
        nodeId: plane.nodeId,
        localSpaceNodeId: plane.localSpaceNodeId,
        tileRgbaSha256: createHash("sha256").update(tile.data).digest("hex"),
        tightWarpRgbaSha256: createHash("sha256").update(warped.surface.data).digest("hex"),
        canvasRgbaSha256: createHash("sha256").update(surface.data).digest("hex"),
        observed: Object.freeze({ ...warped.observedWork }),
        canvasCopy: Object.freeze({
          coveredPixels: placed.copy.coveredPixels,
          copiedPixels: placed.copy.copiedPixels,
          copiedRgbaBytes: placed.copy.copiedRgbaBytes,
          opacityScaledPixels: placed.copy.opacityScaledPixels,
        }),
      }));
    }
    const output = await composite(this.composition.width, this.composition.height, surfaces);
    const evidence = referenceCamera3DFrameEvidence({ plan, backendIdentity, executions, output });
    if (!this.activeCamera3DFrameEvidence) throw new Error(`CUT Camera3D ${node.id} executed outside an active scene-frame evidence transaction.`);
    this.activeCamera3DFrameEvidence.push(evidence);
    return output;
  }

  private async calloutOverlay(
    decision: ReferenceCalloutDecision,
    time: Rational,
    frame: number,
  ): Promise<ReferenceCalloutOverlayResult> {
    if (decision.status !== "accepted" || !decision.rect) {
      throw new Error(`Internal CUT Callout ${decision.nodeId} overlay lacks an accepted rectangle.`);
    }
    const node = this.ir.nodes[decision.nodeId];
    const localNode = this.ir.nodes[decision.localSpaceNodeId];
    const localSpace = localNode ? this.localSpaceConfigs.get(localNode.id) : undefined;
    if (!node || !localNode || !localSpace
      || localSpace.owner !== "callout"
      || localSpace.ownerNodeId !== node.id) {
      const subject = node ?? localNode;
      if (!subject) {
        throw new Error(
          `CUT_CALLOUT_VIEWPORT: Callout ${decision.nodeId} lost LocalSpace ${decision.localSpaceNodeId}.`,
        );
      }
      throw new ReferenceCalloutError(
        "CUT_CALLOUT_VIEWPORT",
        subject,
        `validated LocalSpace ${decision.localSpaceNodeId} is missing at execution.`,
      );
    }
    const tile = await this.localSpaceTile(localSpace, time, frame);
    if (tile.width !== decision.rect.width || tile.height !== decision.rect.height) {
      throw new ReferenceCalloutError(
        "CUT_CALLOUT_VIEWPORT",
        node,
        `LocalSpace returned ${tile.width}x${tile.height}; layout admitted ${decision.rect.width}x${decision.rect.height}.`,
      );
    }
    const affine = this.activeAffineLocalSpacePlan(node.id, localSpace.nodeId, time);
    if (!affine.placement || !affine.transformWork || !affine.admissionPlanIdentity) {
      throw new ReferenceCalloutError(
        "CUT_CALLOUT_VIEWPORT",
        node,
        "accepted Callout has no exact affine admission.",
      );
    }
    let sourceVisiblePixels = 0;
    let sourceMaximum = 0;
    let visiblePixels = 0;
    for (let offset = 3; offset < tile.data.length; offset += 4) {
      const alpha = tile.data[offset]!;
      if (alpha > 0) sourceVisiblePixels += 1;
      if (alpha > sourceMaximum) sourceMaximum = alpha;
      const renderedAlpha = Math.round(alpha * decision.opacity);
      if (renderedAlpha > 0) visiblePixels += 1;
    }
    if (sourceVisiblePixels === 0) {
      throw new ReferenceCalloutError(
        "CUT_CALLOUT_NOOP",
        node,
        `accepted positive-opacity ${tile.width}x${tile.height} LocalSpace tile contains no visible child alpha.`,
      );
    }
    const tileIdentity = referenceLocalSpaceTileIdentity(
      localSpace,
      time,
      this.localSpaceBackendIdentity(),
    );
    const tileEvidence = Object.freeze({
      tileIdentity,
      admittedPlacementIdentity: referenceLocalSpacePlacementIdentity(
        localSpace,
        tileIdentity,
        affine.placement,
        affine.transformWork.workIdentity,
      ),
      affinePlanIdentity: affine.admissionPlanIdentity,
      transformWorkIdentity: affine.transformWork.workIdentity,
      width: tile.width,
      height: tile.height,
      rgbaSha256: createHash("sha256").update(tile.data).digest("hex"),
    });
    const leaderQuantizedMaximum = decision.leader
      ? Math.round(255 * decision.opacity)
      : 0;
    if (visiblePixels === 0 && leaderQuantizedMaximum === 0) {
      this.recordCalloutQuantizedOpacitySkip(
        localNode,
        node,
        time,
        tileIdentity,
        affine.admissionPlanIdentity,
        affine.transformWork.workIdentity,
        affine.placement,
      );
      return Object.freeze({
        status: "opacity-quantized-transparent" as const,
        renderedDecision: Object.freeze({
          status: "opacity-quantized-transparent" as const,
          sourceVisiblePixels,
          sourceMaximum,
          maximumQuantizedAlpha: 0,
          tile: tileEvidence,
          work: Object.freeze({
            calloutOverlayPlacements: 0 as const,
            calloutOverlayComposites: 0 as const,
            overlayCanvasPixels: 0,
            overlayCanvasBytes: 0,
          }),
        }),
      });
    }
    const placed = await this.placeLocalSpaceTile(
      localSpace,
      tile,
      affine.placement,
      this.composition.width,
      this.composition.height,
      time,
      tile,
      {
        sourceNode: node,
        admittedWork: affine.transformWork,
        ...(affine.scaleTranslationPlan ? { scaleTranslationPlan: affine.scaleTranslationPlan } : {}),
      },
    );
    const leader = decision.leader
      ? await svgSurface(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${this.composition.width}" height="${this.composition.height}" viewBox="0 0 ${this.composition.width} ${this.composition.height}"><polyline points="${decision.leader.vertices.map((point) => `${point.x},${point.y}`).join(" ")}" fill="none" stroke="${decision.leader.color}" stroke-width="${decision.leader.width}" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
        this.composition.width,
        this.composition.height,
      )
      : undefined;
    const overlay = await composite(
      this.composition.width,
      this.composition.height,
      leader ? [leader, placed] : [placed],
    );
    const scaledOverlay = scaleLocalSpaceAlpha(
      overlay,
      decision.opacity,
      this.rendererTreeContext.retainedAlphaScaleDiagnostic,
    );
    let overlayVisiblePixels = 0;
    let overlayMaximum = 0;
    for (let offset = 3; offset < scaledOverlay.data.length; offset += 4) {
      const alpha = scaledOverlay.data[offset]!;
      if (alpha > 0) overlayVisiblePixels += 1;
      if (alpha > overlayMaximum) overlayMaximum = alpha;
    }
    if (overlayVisiblePixels === 0 || overlayMaximum === 0) {
      throw new ReferenceCalloutError(
        "CUT_CALLOUT_NOOP",
        node,
        "positive-opacity accepted tile/leader produced no quantized overlay alpha.",
      );
    }
    const overlayCanvasPixels = this.composition.width * this.composition.height;
    return Object.freeze({
      status: "painted" as const,
      surface: scaledOverlay,
      visibleAlpha: Object.freeze({
        sourceVisiblePixels,
        sourceMaximum,
        visiblePixels: overlayVisiblePixels,
        maximum: overlayMaximum,
      }),
      renderedDecision: Object.freeze({
        status: "painted" as const,
        sourceVisiblePixels,
        sourceMaximum,
        maximumQuantizedAlpha: overlayMaximum,
        tile: tileEvidence,
        overlayRgbaSha256: createHash("sha256").update(scaledOverlay.data).digest("hex"),
        work: Object.freeze({
          calloutOverlayPlacements: 1 as const,
          calloutOverlayComposites: 1 as const,
          overlayCanvasPixels,
          overlayCanvasBytes: overlayCanvasPixels * 4,
        }),
      }),
    });
  }

  private async calloutLayerFrame(node: IRNode, time: Rational, frame: number) {
    const config = this.calloutLayerConfigs.get(node.id);
    if (!config) {
      throw new ReferenceCalloutError(
        "CUT_CALLOUT_GRAPH",
        node,
        "has no validated CalloutLayer configuration.",
      );
    }
    const plan = this.activeCalloutLayerPlans.get(
      `${node.id}\u0000${time.numerator}/${time.denominator}`,
    );
    if (!plan) {
      throw new ReferenceCalloutError(
        "CUT_CALLOUT_LAYOUT",
        node,
        "has no exact-frame collision/layout preflight.",
      );
    }
    for (const decision of plan.decisions) {
      if (decision.status !== "hidden") continue;
      const localNode = this.ir.nodes[decision.localSpaceNodeId];
      if (!localNode) continue;
      if (decision.reason === "opacity-zero") {
        this.recordLocalSpaceSkip(
          localNode,
          "owner-opacity",
          "opacity-zero",
          decision.nodeId,
          time,
        );
      } else if (decision.reason === "owner-policy-hidden") {
        this.recordLocalSpaceSkip(
          localNode,
          "owner-policy",
          "tracking-policy-hidden",
          decision.nodeId,
          time,
        );
      }
    }
    let layerSurface = transparent(this.composition.width, this.composition.height);
    const visibleAlpha = new Map<string, Readonly<{
      sourceVisiblePixels: number;
      sourceMaximum: number;
      visiblePixels: number;
      maximum: number;
    }>>();
    const renderedDecisions = new Map<string, ReferenceCalloutRenderedDecision>();
    const accepted = plan.decisions
      .filter((decision) => decision.status === "accepted")
      .sort((left, right) => left.paintOrder! - right.paintOrder!);
    for (const decision of accepted) {
      const rendered = await this.calloutOverlay(decision, time, frame);
      renderedDecisions.set(decision.nodeId, rendered.renderedDecision);
      if (rendered.status !== "painted") continue;
      visibleAlpha.set(decision.nodeId, rendered.visibleAlpha);
      layerSurface = await composite(
        this.composition.width,
        this.composition.height,
        [layerSurface, rendered.surface],
      );
    }
    // The identity fragment is a transparent structural dispatch scope, not a
    // nested renderer instance. Keep the raster execution path at the active
    // composition; `identityComponentFragment` separately authenticates the
    // fragment -> CalloutLayer ancestry without inventing a second compositor.
    const executionPath = Object.freeze([
      Object.freeze({ compositionId: this.composition.id }),
    ]);
    const decisions = Object.freeze(plan.decisions.map((decision) => Object.freeze({
      ...decision,
      ...(renderedDecisions.has(decision.nodeId)
        ? { renderedDecision: renderedDecisions.get(decision.nodeId)! }
        : {}),
      ...(visibleAlpha.has(decision.nodeId)
        ? { visibleAlpha: visibleAlpha.get(decision.nodeId)! }
        : {}),
    })));
    const renderedValues = [...renderedDecisions.values()];
    const outputRgbaSha256 = createHash("sha256").update(layerSurface.data).digest("hex");
    const work = Object.freeze({
      ...plan.work,
      tileRequests: renderedValues.length,
      tilePixels: renderedValues.reduce(
        (total, decision) => total + decision.tile.width * decision.tile.height,
        0,
      ),
      paintedCallouts: renderedValues.filter((decision) => decision.status === "painted").length,
      opacityQuantizedTransparentCallouts: renderedValues.filter(
        (decision) => decision.status === "opacity-quantized-transparent",
      ).length,
      leaderRasterizations: decisions.filter(
        (decision) => decision.renderedDecision?.status === "painted" && decision.leader,
      ).length,
      calloutOverlayPlacements: renderedValues.reduce(
        (total, decision) => total + decision.work.calloutOverlayPlacements,
        0,
      ),
      calloutOverlayComposites: renderedValues.reduce(
        (total, decision) => total + decision.work.calloutOverlayComposites,
        0,
      ),
      layerSourceOverComposites: renderedValues.filter(
        (decision) => decision.status === "painted",
      ).length,
      overlayCanvasPixels: renderedValues.reduce(
        (total, decision) => total + decision.work.overlayCanvasPixels,
        0,
      ),
      overlayCanvasBytes: renderedValues.reduce(
        (total, decision) => total + decision.work.overlayCanvasBytes,
        0,
      ),
    });
    if (plan.outputFrame === undefined) {
      throw new ReferenceCalloutError(
        "CUT_CALLOUT_GRAPH",
        node,
        "rendered Callout evidence requires the exact output-frame index.",
      );
    }
    const evidenceBody = Object.freeze({
      ...plan,
      outputFrame: plan.outputFrame,
      decisions,
      executionPath,
      work,
      outputRgbaSha256,
    });
    const evidence: ReferenceCalloutRenderedFrameEvidence =
      validateReferenceCalloutFrameEvidenceSemantics(Object.freeze({
      ...evidenceBody,
      executionIdentity: referenceCalloutExecutionIdentity(evidenceBody),
      }));
    if (!this.activeCalloutFrameEvidence) {
      throw new ReferenceCalloutError(
        "CUT_CALLOUT_GRAPH",
        node,
        "executed outside an active scene-frame evidence transaction.",
      );
    }
    this.activeCalloutFrameEvidence.push(evidence);
    return layerSurface;
  }

  private async geoAnnotationOverlay(
    decision: Extract<ReferenceGeoAnnotationDecision, { status: "accepted" }> | ReferenceGeoAnnotationDecision,
    time: Rational,
    frame: number,
  ): Promise<ReferenceGeoAnnotationOverlayResult> {
    if (decision.status !== "accepted" || !decision.rect) throw new Error(`Internal CUT GeoAnnotation ${decision.nodeId} overlay lacks an accepted rectangle.`);
    const node = this.ir.nodes[decision.nodeId];
    if (!node) throw new Error(`Internal CUT GeoAnnotation ${decision.nodeId} is missing.`);
    const config = [
      ...[...this.geoAnnotationCameraConfigs.values()].flatMap((camera) => camera.annotations),
      ...[...this.mapCameraAnnotationConfigs.values()].flatMap((camera) => camera.annotations),
    ].find((binding) => binding.config.nodeId === decision.nodeId)?.config;
    if (!config) throw new Error(`Internal CUT GeoAnnotation ${decision.nodeId} has no validated viewport configuration.`);
    let viewport: RawSurface;
    if (config.localSpace) {
      const localNode = this.ir.nodes[config.localSpace.nodeId];
      if (!localNode || localNode.op !== "cut.visual.local_space") {
        throw new ReferenceGeoAnnotationError("CUT_GEO_ANNOTATION_VIEWPORT", node, "validated LocalSpace child is missing at execution.");
      }
      const localConfig = this.localSpaceConfig(localNode);
      const tile = await this.localSpaceTile(localConfig, time, frame);
      if (tile.width !== config.width || tile.height !== config.height) {
        throw new ReferenceGeoAnnotationError("CUT_GEO_ANNOTATION_VIEWPORT", node, `LocalSpace returned ${tile.width}x${tile.height}; the derived viewport is ${config.width}x${config.height}.`);
      }
      viewport = tile;
    } else {
      const child = await this.nodeFrame(decision.childId, time, frame);
      if (!child) throw new ReferenceGeoAnnotationError("CUT_GEO_ANNOTATION_NOOP", node, "accepted positive-opacity child produced no active surface.");
      if (child.width !== this.composition.width || child.height !== this.composition.height) {
        throw new ReferenceGeoAnnotationError("CUT_GEO_ANNOTATION_GRAPH", node, `ordinary child returned ${child.width}x${child.height}; the legacy fixed viewport contract requires a composition-canvas surface.`);
      }
      const cropResult = await sharp(child.data, raw(child)).extract({
        left: config.cropLeft,
        top: config.cropTop,
        width: config.width,
        height: config.height,
      }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      viewport = { data: cropResult.data, width: cropResult.info.width, height: cropResult.info.height };
    }
    let sourceVisiblePixels = 0, sourceMaximum = 0, visiblePixels = 0, maximum = 0;
    for (let offset = 3; offset < viewport.data.length; offset += 4) {
      const alpha = viewport.data[offset];
      if (alpha > 0) sourceVisiblePixels += 1;
      if (alpha > sourceMaximum) sourceMaximum = alpha;
      const renderedAlpha = Math.round(alpha * decision.opacity);
      if (renderedAlpha > 0) visiblePixels += 1;
      if (renderedAlpha > maximum) maximum = renderedAlpha;
    }
    if (sourceVisiblePixels === 0) {
      throw new ReferenceGeoAnnotationError("CUT_GEO_ANNOTATION_NOOP", node, `accepted positive-opacity ${config.width}x${config.height} ${config.localSpace ? "LocalSpace tile" : "centered legacy viewport"} contains no visible child alpha before annotation opacity.`);
    }
    if (visiblePixels === 0) return Object.freeze({
      status: "opacity-quantized-transparent" as const,
      renderedDecision: Object.freeze({
        status: "opacity-quantized-transparent" as const,
        sourceVisiblePixels,
        sourceMaximum,
        maximumQuantizedAlpha: 0,
        work: Object.freeze({
          annotationOverlayPlacements: 0 as const,
          annotationOverlayComposites: 0 as const,
          overlayCanvasPixels: 0,
          overlayCanvasBytes: 0,
        }),
      }),
    });
    let placed: RawSurface;
    if (config.localSpace) {
      const localNode = this.ir.nodes[config.localSpace.nodeId]!;
      const localConfig = this.localSpaceConfig(localNode), affine = this.activeAffineLocalSpacePlan(node.id, localConfig.nodeId, time);
      if (!affine.placement || !affine.transformWork) throw new ReferenceGeoAnnotationError("CUT_GEO_ANNOTATION_VIEWPORT", node, "accepted LocalSpace annotation has no exact affine admission.");
      placed = await this.placeLocalSpaceTile(
        localConfig, viewport, affine.placement, this.composition.width, this.composition.height, time, viewport,
        {
          sourceNode: node,
          admittedWork: affine.transformWork,
          ...(affine.scaleTranslationPlan ? { scaleTranslationPlan: affine.scaleTranslationPlan } : {}),
        },
      );
    } else {
      const viewportBase = transparent(this.composition.width, this.composition.height);
      const placedData = await sharp(viewportBase.data, raw(viewportBase)).composite([{
        input: viewport.data,
        raw: { width: config.width, height: config.height, channels: 4 },
        left: decision.rect.left,
        top: decision.rect.top,
      }]).ensureAlpha().raw().toBuffer();
      placed = { data: placedData, width: this.composition.width, height: this.composition.height };
    }
    const leader = decision.leader
      ? await svgSurface(`<svg xmlns="http://www.w3.org/2000/svg" width="${this.composition.width}" height="${this.composition.height}" viewBox="0 0 ${this.composition.width} ${this.composition.height}"><polyline points="${decision.leader.vertices.map((point) => `${point.x},${point.y}`).join(" ")}" fill="none" stroke="${decision.leader.color}" stroke-width="${decision.leader.width}" stroke-linecap="round" stroke-linejoin="round"/></svg>`, this.composition.width, this.composition.height)
      : undefined;
    // Leader first, then its own viewport. This fixes edge-overlap pixels and
    // keeps higher-priority overlays wholly above lower-priority overlays.
    const overlay = await composite(this.composition.width, this.composition.height, leader ? [leader, placed] : [placed]);
    const overlayCanvasPixels = this.composition.width * this.composition.height;
    return Object.freeze({
      status: "painted" as const,
      surface: scaleAlpha(overlay, decision.opacity),
      visibleAlpha: Object.freeze({ sourceVisiblePixels, sourceMaximum, visiblePixels, maximum }),
      renderedDecision: Object.freeze({
        status: "painted" as const,
        sourceVisiblePixels,
        sourceMaximum,
        maximumQuantizedAlpha: maximum,
        work: Object.freeze({
          annotationOverlayPlacements: 1 as const,
          annotationOverlayComposites: 1 as const,
          overlayCanvasPixels,
          overlayCanvasBytes: overlayCanvasPixels * 4,
        }),
      }),
    });
  }

  private async parallaxCameraFrame(node: IRNode, time: Rational, frame: number) {
    const config = this.parallaxCameraConfigs.get(node.id);
    if (!config) throw new Error(`Reference ParallaxCamera ${node.id} has no validated deterministic 2.5D configuration.`);
    const plan = this.activeParallaxCameraPlans.get(`${node.id}\u0000${time.numerator}/${time.denominator}`);
    if (!plan) throw new Error(`Reference ParallaxCamera ${node.id} has no exact affine-preflight plan at ${time.numerator}/${time.denominator}.`);
    // Serialize layer materialization. This keeps peak working memory inside
    // the aggregate plan and preserves deterministic forward-only decoders;
    // returned surfaces are then composited in the resolved paint order.
    const surfaces: RawSurface[] = [];
    for (const layer of plan.layers) {
      const layerConfig = config.layers.find((candidate) => candidate.nodeId === layer.nodeId);
      const surface = await this.parallaxProjectedLayer(layer, time, frame, layerConfig?.ordinaryChildIds);
      if (surface) surfaces.push(surface);
    }
    let cameraSurface = await composite(this.composition.width, this.composition.height, surfaces);
    const annotationConfig = this.geoAnnotationCameraConfigs.get(node.id);
    if (!annotationConfig) return cameraSurface;
    const annotationPlan = this.activeGeoAnnotationPlans.get(`${node.id}\u0000${time.numerator}/${time.denominator}`);
    if (!annotationPlan) throw new Error(`Reference ParallaxCamera ${node.id} has no exact annotation preflight at ${time.numerator}/${time.denominator}.`);
    const visibleAlpha = new Map<string, Readonly<{ sourceVisiblePixels: number; sourceMaximum: number; visiblePixels: number; maximum: number }>>();
    const renderedDecisions = new Map<string, ReferenceGeoAnnotationRenderedDecision>();
    const accepted = annotationPlan.decisions.filter((decision) => decision.status === "accepted").sort((left, right) => left.paintOrder! - right.paintOrder!);
    for (const decision of accepted) {
      const rendered = await this.geoAnnotationOverlay(decision, time, frame);
      renderedDecisions.set(decision.nodeId, rendered.renderedDecision);
      if (rendered.status !== "painted") continue;
      visibleAlpha.set(decision.nodeId, rendered.visibleAlpha);
      // Incremental composition bounds retained full-canvas overlay memory;
      // the exact allocation work is independently budgeted by the plan.
      cameraSurface = await composite(this.composition.width, this.composition.height, [cameraSurface, rendered.surface]);
    }
    const executionPath = Object.freeze([Object.freeze({ compositionId: this.composition.id })]);
    const decisions = Object.freeze(annotationPlan.decisions.map((decision) => Object.freeze({
      ...decision,
      ...(renderedDecisions.has(decision.nodeId) ? { renderedDecision: renderedDecisions.get(decision.nodeId)! } : {}),
      ...(visibleAlpha.has(decision.nodeId) ? { visibleAlpha: visibleAlpha.get(decision.nodeId)! } : {}),
    })));
    const evidence: ReferenceGeoAnnotationRenderedFrameEvidence = Object.freeze({
      ...annotationPlan,
      decisions,
      executionPath,
      executionIdentity: referenceGeoAnnotationExecutionIdentity(annotationPlan.decisionIdentity, decisions, executionPath),
    });
    this.geoAnnotationFrameEvidence = Object.freeze([...this.geoAnnotationFrameEvidence, evidence]);
    return cameraSurface;
  }

  private async mapCameraFrame(node: IRNode, time: Rational, frame: number) {
    const config = this.mapCameraConfigs.get(node.id);
    if (!config) throw new Error(`Reference MapCamera ${node.id} has no validated retained geographic configuration.`);
    const rendered = await renderReferenceMapCameraFrame(this.ir, this.composition, config, time, {
      annotationMode: "defer-local-space",
      evidenceKind: "completed-public-retained-geo-pass",
      publicRuntimeStatus: "connected-reference-visual-renderer",
      cacheStatus: "renderer-invocation-canonical-raster-cache-no-persistent-cache",
      preparation: this.mapCameraRenderPreparation,
      canonicalRasterCache: this.rendererTreeContext.mapCameraCanonicalRasterCache,
    });
    let cameraSurface: RawSurface = {
      data: rendered.surface.data,
      width: rendered.surface.width,
      height: rendered.surface.height,
    };
    const annotationConfig = this.mapCameraAnnotationConfigs.get(node.id);
    if (!annotationConfig) {
      this.mapCameraFrameEvidence = Object.freeze([...this.mapCameraFrameEvidence, referenceMapCameraPublicFrameEvidence({ retained: rendered, finalSurface: cameraSurface })]);
      return cameraSurface;
    }
    const annotationPlan = this.activeMapCameraGeoAnnotationPlans.get(`${node.id}\u0000${time.numerator}/${time.denominator}`);
    if (!annotationPlan) throw new Error(`Reference MapCamera ${node.id} has no exact annotation preflight at ${time.numerator}/${time.denominator}.`);
    const visibleAlpha = new Map<string, Readonly<{ sourceVisiblePixels: number; sourceMaximum: number; visiblePixels: number; maximum: number }>>();
    const renderedDecisions = new Map<string, ReferenceGeoAnnotationRenderedDecision>();
    const accepted = annotationPlan.decisions.filter((decision) => decision.status === "accepted").sort((left, right) => left.paintOrder! - right.paintOrder!);
    for (const decision of accepted) {
      const overlay = await this.geoAnnotationOverlay(decision, time, frame);
      renderedDecisions.set(decision.nodeId, overlay.renderedDecision);
      if (overlay.status !== "painted") continue;
      visibleAlpha.set(decision.nodeId, overlay.visibleAlpha);
      cameraSurface = await composite(this.composition.width, this.composition.height, [cameraSurface, overlay.surface]);
    }
    const executionPath = Object.freeze([Object.freeze({ compositionId: this.composition.id })]);
    const decisions = Object.freeze(annotationPlan.decisions.map((decision) => Object.freeze({
      ...decision,
      ...(renderedDecisions.has(decision.nodeId) ? { renderedDecision: renderedDecisions.get(decision.nodeId)! } : {}),
      ...(visibleAlpha.has(decision.nodeId) ? { visibleAlpha: visibleAlpha.get(decision.nodeId)! } : {}),
    })));
    const evidence: ReferenceGeoAnnotationRenderedFrameEvidence = Object.freeze({
      ...annotationPlan,
      decisions,
      executionPath,
      executionIdentity: referenceGeoAnnotationExecutionIdentity(annotationPlan.decisionIdentity, decisions, executionPath),
    });
    this.geoAnnotationFrameEvidence = Object.freeze([...this.geoAnnotationFrameEvidence, evidence]);
    this.mapCameraFrameEvidence = Object.freeze([...this.mapCameraFrameEvidence, referenceMapCameraPublicFrameEvidence({
      retained: rendered,
      annotations: Object.freeze({
        active: annotationPlan.work.activeAnnotations,
        accepted: annotationPlan.work.acceptedAnnotations,
        localSpaceNodeIds: Object.freeze(annotationConfig.annotations.map((binding) => binding.config.localSpace!.nodeId)),
        subgraphSemanticIdentity: hash(annotationConfig.annotations.map((binding) => ({
          config: binding.config,
          childSemanticIdentity: binding.childSemanticIdentity,
        }))),
        decisionIdentity: annotationPlan.decisionIdentity,
        executionIdentity: evidence.executionIdentity,
        painted: [...renderedDecisions.values()].filter((decision) => decision.status === "painted").length,
        opacityQuantizedTransparent: [...renderedDecisions.values()].filter((decision) => decision.status === "opacity-quantized-transparent").length,
      }),
      finalSurface: cameraSurface,
    })]);
    return cameraSurface;
  }

  private nodeFrame(nodeId: string, time: Rational, frame: number): Promise<RawSurface | undefined> {
    const tracked = this.nodeFrameExecution(nodeId, time, frame).finally(() => {
      this.activeNodeFrameWork.delete(tracked);
    });
    this.activeNodeFrameWork.add(tracked);
    return tracked;
  }

  private async nodeFrameExecution(nodeId: string, time: Rational, frame: number): Promise<RawSurface | undefined> {
    // Exact temporal phase is part of one-frame memoization. MotionBlur keeps
    // `frame` (and therefore seeded temporal Grain) fixed while evaluating
    // transforms/signals at distinct exact shutter times.
    const memoKey = `${frame}:${time.numerator}/${time.denominator}:${nodeId}`; if (this.frameMemo.has(memoKey)) return this.frameMemo.get(memoKey);
    const node = this.ir.nodes[nodeId];
    if (!node) { this.frameMemo.set(memoKey, undefined); return undefined; }
    if (!this.active(node, time)) {
      const retained = node.op === "cut.visual.local_space" ? this.localSpaceConfigs.get(node.id) : undefined;
      for (const plan of retained ? referenceLocalSpaceAllRetainedMediaPlans(retained) : []) {
        const retainedRoot = this.ir.nodes[plan.rootId];
        if (retainedRoot) this.recordLocalSpaceSkip(retainedRoot, "inactive-node", "outside-interval", undefined, time);
      }
      this.frameMemo.set(memoKey, undefined);
      return undefined;
    }
    if (node.op === "cut.geo.annotation") {
      throw new ReferenceGeoAnnotationError("CUT_GEO_ANNOTATION_GRAPH", node, "reached generic visual rendering; GeoAnnotation must be deferred by its direct owning ParallaxCamera or MapCamera.");
    }
    if (node.op === "cut.visual.callout") {
      throw new ReferenceCalloutError(
        "CUT_CALLOUT_GRAPH",
        node,
        "reached generic visual rendering; its direct CalloutLayer must consume the retained tile.",
      );
    }
    if (node.op === "cut.visual.callout_layer") {
      const surface = await this.calloutLayerFrame(node, time, frame);
      this.frameMemo.set(memoKey, surface);
      return surface;
    }
    if (node.op === cutDiagramOps.layout) {
      const surface = await this.diagramLayoutFrame(node, time, frame);
      this.frameMemo.set(memoKey, surface);
      return surface;
    }
    if (node.op === cutDiagramOps.node) {
      return referenceDiagramRenderFailure("CUT_DIAGRAM_BOUNDS", node, "reached generic rendering; its owning DiagramLayout must consume the bounded local tile directly.");
    }
    if (node.op === "cut.visual.media_camera2d") {
      const surface = await this.mediaCamera2DFrame(node, time);
      this.frameMemo.set(memoKey, surface);
      return surface;
    }
    if (node.op === "cut.geo.map_camera") {
      const surface = await this.mapCameraFrame(node, time, frame);
      this.frameMemo.set(memoKey, surface);
      return surface;
    }
    if (node.op === "cut.visual.parallax_camera") {
      const surface = await this.parallaxCameraFrame(node, time, frame);
      this.frameMemo.set(memoKey, surface);
      return surface;
    }
    if (node.op === "cut.visual.camera3d") {
      const surface = await this.camera3DFrame(node, time, frame);
      this.frameMemo.set(memoKey, surface);
      return surface;
    }
    if (node.op === "cut.visual.plane3d") {
      throw new Error(`CUT Plane3D ${node.id} reached generic visual rendering; its direct Camera3D owner must consume the retained tile projectively.`);
    }
    if (node.op === "cut.visual.local_space") {
      const config = this.localSpaceConfig(node);
      if (config.owner !== "scene-root") {
        throw new ReferenceLocalSpaceError("CUT_LOCAL_SPACE_GRAPH", node, `reached generic rendering with structural owner ${config.owner}; its owner must consume the retained tile directly.`);
      }
      const surface = await this.localSpaceOwnedFrame(undefined, node, time, frame);
      this.frameMemo.set(memoKey, surface);
      return surface;
    }
    if (node.op === "cut.visual.responsive_stack") {
      const surface = await this.responsiveStackFrame(node, time, frame);
      this.frameMemo.set(memoKey, surface);
      return surface;
    }
    if (node.op === "cut.visual.responsive_slot") {
      throw new ReferenceResponsiveStackError("CUT_RESPONSIVE_STACK_GRAPH", node, "reached generic visual rendering; its owning ResponsiveStack must materialize the slot-local child directly.");
    }
    if (node.op === "cut.kernel.fragment" && node.children.length === 1) {
      const localNode = this.ir.nodes[node.children[0]];
      if (localNode?.op === "cut.visual.local_space") {
        const surface = await this.componentFragmentLocalSpaceFrame(node, localNode, time, frame);
        this.frameMemo.set(memoKey, surface);
        return surface;
      }
    }
    if ((node.op === "cut.visual.group" || node.op === "cut.visual.motion_path") && node.children.length === 1) {
      const localNode = this.ir.nodes[node.children[0]];
      if (localNode?.op === "cut.visual.local_space") {
        const surface = await this.localSpaceOwnedFrame(node, localNode, time, frame);
        this.frameMemo.set(memoKey, surface);
        return surface;
      }
    }
    if (node.op === "cut.visual.camera2d" && node.children.length === 1) {
      const localNode = this.ir.nodes[node.children[0]];
      if (localNode?.op === "cut.visual.local_space") {
        const surface = await this.camera2DLocalSpaceFrame(node, localNode, time, frame);
        this.frameMemo.set(memoKey, surface);
        return surface;
      }
    }
    if (node.op === "cut.visual.track_2d" && node.children.length === 1) {
      const localNode = this.ir.nodes[node.children[0]];
      if (localNode?.op === "cut.visual.local_space") {
        const surface = await this.track2DLocalSpaceFrame(node, localNode, time, frame);
        this.frameMemo.set(memoKey, surface);
        return surface;
      }
    }
    if (node.op === "cut.visual.planar_track" && node.children.length === 1) {
      const localNode = this.ir.nodes[node.children[0]];
      if (localNode?.op === "cut.visual.local_space") {
        const surface = await this.planarTrackLocalSpaceFrame(node, localNode, time, frame);
        this.frameMemo.set(memoKey, surface);
        return surface;
      }
    }
    const retainedChain = this.retainedPathChains.get(nodeId);
    if (retainedChain) {
      const retained = await this.retainedPathChainFrame(retainedChain, time);
      if ((node.op === "cut.visual.path"
          && this.anchoredVectorPathPlans.has(node.id))
        || (node.op === "cut.visual.motion_path"
          && this.anchoredMotionPathPlans.has(node.id))) {
        this.bindAnchoredPathRenderedOutput(node, time, retained);
      }
      this.frameMemo.set(memoKey, retained);
      return retained;
    }
    const transformOwnership = referenceGenericVisualTransformOwnership(node);
    const transform = referenceVisualTransformAt(
      this.ir,
      this.composition,
      node,
      time,
      transformOwnership,
      this.preparedSignalResolver,
    );
    if (node.op === "cut.visual.motion_path") {
      const anchoredPlan = this.anchoredMotionPathPlans.get(node.id);
      const anchored = anchoredPlan ? this.anchoredMotionPathResolution(node, anchoredPlan, time) : undefined;
      if (anchored?.status === "policy-hidden") { this.frameMemo.set(memoKey, undefined); return undefined; }
      const path = anchored?.sample ?? referenceMotionPathAt(this.ir, this.composition, node, time, this.motionPathPlan(node));
      transform.x += path.x;
      transform.y += path.y;
      transform.rotation += path.rotation;
      // Tangent orientation is part of the executed retained transform. Check
      // the composed value immediately before any Sharp intermediate exists;
      // validating authored rotation alone leaves a path-angle budget bypass.
      validateReferenceVisualTransformAllocation(node, this.composition, transform);
    }
    if (node.op === "cut.visual.track_2d") {
      const tracked = this.track2DTransform(node, time);
      if (tracked.hidden) { this.frameMemo.set(memoKey, undefined); return undefined; }
      transform.x += tracked.x;
      transform.y += tracked.y;
      transform.scale *= tracked.scale;
      transform.rotation += tracked.rotation;
      validateReferenceVisualTransformAllocation(node, this.composition, transform);
    }
    const local = subtractRational(time, node.interval.start), opacity = transform.opacity * this.linkedClipEdgeOpacity(node, local);
    if (opacity === 0) { this.frameMemo.set(memoKey, undefined); return undefined; }
    let surface: RawSurface;
    if (node.op === "cut.visual.precomp" || node.op === "cut.edit.nested_sequence") surface = await this.precompFrame(node, local);
    else if (node.op === "cut.visual.image_sequence") surface = await this.imageSequenceFrame(node, local);
    else if (["cut.visual.video", "cut.visual.image", "cut.edit.clip", "cut.edit.picture_clip"].includes(node.op)) {
      const localFrame = exactMediaFrameIndex(local, this.composition.fps); surface = await this.mediaFrame(node, localFrame);
    }
    else if (node.op === "cut.edit.sequence") {
      if (!node.editorial || node.editorial.kind !== "sequence") throw new ReferencePictureEditorialError("CUT_EDIT_SEQUENCE", node.id, node, "has no executable track order");
      const tracks = await Promise.all(node.editorial.tracks.map((track) => this.nodeFrame(track.nodeId, time, frame)));
      surface = await composite(this.composition.width, this.composition.height, tracks);
    }
    else if (node.op === "cut.edit.picture_track") {
      if (!node.editorial || node.editorial.kind !== "picture-track") throw new ReferencePictureEditorialError("CUT_EDIT_TRACK", node.id, node, "has no executable temporal item order");
      const transition = (node.editorial.transitions ?? []).find((candidate) => compareRational(time, candidate.overlap.start) >= 0 && compareRational(time, addRational(candidate.overlap.start, candidate.overlap.duration)) < 0);
      if (transition) {
        const outgoingNode = this.ir.nodes[transition.outgoingNodeId], incomingNode = this.ir.nodes[transition.incomingNodeId];
        if (!outgoingNode || !incomingNode) throw new ReferencePictureEditorialError("CUT_EDIT_TRACK", node.id, node, "transition references a missing PictureClip");
        const sourceDelta = subtractRational(time, transition.cut);
        const outgoingSource = addRational(transition.outgoingSource.start, sourceDelta);
        const incomingSource = addRational(addRational(transition.incomingSource.start, transition.incomingSource.duration), sourceDelta);
        const frameDuration = divideRational(rational(1), this.composition.fps);
        const outgoingTransformTime = compareRational(time, transition.cut) < 0 ? time : subtractRational(transition.cut, frameDuration);
        const incomingTransformTime = compareRational(time, transition.cut) < 0 ? transition.cut : time;
        const [outgoing, incoming] = await Promise.all([
          this.pictureClipTransitionFrame(transition.outgoingNodeId, outgoingSource, outgoingTransformTime),
          this.pictureClipTransitionFrame(transition.incomingNodeId, incomingSource, incomingTransformTime),
        ]);
        const progress = rationalToNumber(subtractRational(time, transition.overlap.start)) / rationalToNumber(transition.duration);
        const transitioned = applyReferencePictureTransition(outgoing, incoming, pictureTrackTransitionStyle(transition.style), progress);
        surface = { data: Buffer.from(transitioned.data), width: transitioned.width, height: transitioned.height };
      } else {
      const item = node.editorial.items.find((candidate) => compareRational(time, candidate.destination.start) >= 0 && compareRational(time, addRational(candidate.destination.start, candidate.destination.duration)) < 0);
      if (!item) throw new ReferencePictureEditorialError("CUT_EDIT_TRACK", node.id, node, "has no PictureClip or Gap covering the active picture time");
      surface = item.kind === "gap" ? transparent(this.composition.width, this.composition.height) : (await this.nodeFrame(item.nodeId, time, frame)) ?? transparent(this.composition.width, this.composition.height);
      }
    }
    else if (node.op === "cut.edit.gap") surface = transparent(this.composition.width, this.composition.height);
    else if (node.op === "cut.edit.transition") {
      const transition = referenceTransitionContract(this.ir, this.composition, node);
      const outgoing = await this.nodeFrame(transition.outgoingNodeId, time, frame);
      const incoming = await this.nodeFrame(transition.incomingNodeId, time, frame);
      if (compareRational(time, transition.overlapStart) < 0) {
        surface = outgoing ?? transparent(this.composition.width, this.composition.height);
      } else if (compareRational(time, transition.overlapEnd) >= 0) {
        surface = incoming ?? transparent(this.composition.width, this.composition.height);
      } else {
        if (!outgoing || !incoming) throw new ReferenceTransitionContractError(node, "both Clip children must be active throughout the exact overlap");
        const transitioned = applyReferencePictureTransition(outgoing, incoming, transition.picture, referenceTransitionProgress(transition, time));
        surface = { data: Buffer.from(transitioned.data), width: transitioned.width, height: transitioned.height };
      }
    }
    else if (node.op === "cut.edit.jcut" || node.op === "cut.edit.lcut") {
      const split = referenceLinkedSplitContract(this.ir, this.composition, node);
      // The picture boundary is independent from the exact hard audio boundary:
      // JCut keeps outgoing picture while incoming audio leads; LCut switches
      // to incoming picture while outgoing audio carries.
      const selected = compareRational(time, split.pictureCut) < 0
        ? split.outgoingNodeId
        : split.incomingNodeId;
      surface = (await this.nodeFrame(selected, time, frame)) ?? transparent(this.composition.width, this.composition.height);
    }
    else if (node.op === "cut.visual.captions"
      || node.op === "cut.visual.transcript_captions") {
      surface = await this.captions(node, local);
    }
    else if (node.op === "cut.visual.text") surface = await this.text(node);
    else if (node.op === "cut.visual.flow_text") surface = await this.flowText(node, local);
    else if (node.op === "cut.visual.path" && node.inputs.geometry !== undefined) surface = await this.vectorPath(node, time);
    else if (["cut.visual.rect", "cut.visual.circle", "cut.visual.path"].includes(node.op)) surface = await this.shape(node);
    else if (node.op === "cut.visual.trace") surface = await this.trace(node, local);
    else if (node.op === "cut.geo.globe") surface = await this.globe(node, time, local);
    else if (node.op === "cut.geo.map") surface = await this.map(node, local);
    else if (node.op === "cut.geo.wavefront") surface = await this.wavefront(node, time, local);
    else if (node.op === "cut.geo.route") surface = await this.route(node, time);
    else if (node.op === "cut.geo.marker") surface = await this.marker(node, local);
    else if (node.op === "cut.geo.connections") surface = await this.connections(node, time);
    else if (node.op === "cut.data.chart") surface = await this.chart(node, time);
    else if (node.op === "cut.data.series_chart") surface = await this.seriesChart(node, time);
    else if (["cut.data.waveform", "cut.data.spectrogram"].includes(node.op)) surface = await this.analysisGraphic(node, time);
    else if (node.op === "cut.documentary.evidence") surface = await this.evidence(node);
    else if (node.op === "cut.visual.composite") {
      const children = await Promise.all(node.children.map((child) => this.nodeFrame(child, time, frame)));
      surface = this.compositeLayers(children, this.compositeModes.get(node.id)!);
    }
    else if (node.op === "cut.visual.stack") surface = await this.stackSurface(node, time, frame);
    else if (node.op === "cut.visual.mask") {
      const children = await Promise.all(node.children.map((child) => this.nodeFrame(child, time, frame)));
      surface = this.maskedSurface(children, this.maskConfigs.get(node.id)!);
    }
    else if (node.op === "cut.visual.clip_path") {
      const child = await this.nodeFrame(node.children[0], time, frame);
      const plan = this.clipPathPlans.get(node.id);
      if (!plan) throw new Error(`Reference ClipPath ${node.id} has no validated coverage plan.`);
      const clipped = applyReferenceClipPath(child ?? transparent(this.composition.width, this.composition.height), plan);
      surface = { data: Buffer.from(clipped.data), width: clipped.width, height: clipped.height };
    }
    else if (node.op === "cut.visual.motion_blur") {
      const config = this.motionBlurConfigs.get(node.id);
      if (!config) throw new Error(`Reference MotionBlur ${node.id} has no validated runtime configuration.`);
      const child = this.ir.nodes[node.children[0]];
      if (!child) throw new Error(`Reference MotionBlur ${node.id} lost its direct child after boundary preflight.`);
      const boundary = executeMotionBlurOwned(node, () => createReferenceMotionBlurBoundaryPlan(node, child, time, config));
      const samples: RawSurface[] = [];
      // Keep exact shutter order serialized. Video and PictureClip deliberately
      // share one forward-only decoder per node, so concurrent sample reads can
      // consume or publish frames out of order even though the times are sorted.
      for (const sample of boundary.samples) {
        samples.push(sample.sourceTime === null
          ? transparent(this.composition.width, this.composition.height)
          : await this.nodeFrame(node.children[0], sample.sourceTime, frame)
            ?? transparent(this.composition.width, this.composition.height));
      }
      const blurred = executeMotionBlurOwned(node, () => accumulateReferenceMotionBlur(boundary.shutter, samples));
      surface = { data: Buffer.from(blurred.data), width: blurred.width, height: blurred.height };
    }
    else if (node.op === "cut.visual.color_convert") {
      const child = await this.nodeFrame(node.children[0], time, frame);
      const config = this.colorConvertConfigs.get(node.id);
      if (!config) throw new Error(`Reference ColorConvert ${node.id} has no validated runtime configuration.`);
      const converted = convertReferenceColorSurface(
        child ?? transparent(this.composition.width, this.composition.height),
        config.from,
        config.to,
        { node },
      );
      surface = { data: Buffer.from(converted.data), width: converted.width, height: converted.height };
    }
    else if (node.op === "cut.visual.tonal_curve") {
      const child = await this.nodeFrame(node.children[0], time, frame);
      const config = this.tonalCurveConfigs.get(node.id);
      if (!config) throw new Error(`Reference TonalCurve ${node.id} has no validated runtime configuration.`);
      const curved = applyReferenceTonalCurve(
        child ?? transparent(this.composition.width, this.composition.height),
        config,
        { node },
      );
      surface = { data: Buffer.from(curved.data), width: curved.width, height: curved.height };
    }
    else if (node.op === "cut.visual.chroma_key") {
      const child = await this.nodeFrame(node.children[0], time, frame);
      const config = this.chromaKeyConfigs.get(node.id);
      if (!config) throw new Error(`Reference ChromaKey ${node.id} has no validated runtime configuration.`);
      const keyed = applyReferenceChromaKey(
        node,
        config,
        child ?? transparent(this.composition.width, this.composition.height),
      );
      surface = { data: Buffer.from(keyed.data), width: keyed.width, height: keyed.height };
    }
    else if (this.visualEffects.has(node.id)) {
      const child = await this.nodeFrame(node.children[0], time, frame);
      surface = child ? await applyReferenceVisualEffect(this.visualEffects.get(node.id)!, child, { frame: this.outputFrameIndex }) : transparent(this.composition.width, this.composition.height);
    }
    else {
      surface = await composite(this.composition.width, this.composition.height, await Promise.all(node.children.map((child) => this.nodeFrame(child, time, frame))));
      if (node.op === "cut.visual.lut") surface = this.lut(node, surface, time);
      else if (node.op === "cut.visual.color_grade") surface = await this.colorGrade(node, surface, time);
    }
    const anchorAware = (node.op === "cut.visual.group" || node.op === "cut.visual.motion_path")
      && (quantityNumber(node.inputs.anchorX) !== 0 || quantityNumber(node.inputs.anchorY) !== 0 || Object.hasOwn(node.properties, "anchorX") || Object.hasOwn(node.properties, "anchorY"));
    surface = scaleAlpha(await placeOnCanvas(surface, this.composition.width, this.composition.height, transform.x, transform.y, transform.scale, transform.rotation, transform.skewX, transform.skewY, transform.anchorX, transform.anchorY, anchorAware), opacity);
    if ((node.op === "cut.visual.path"
        && this.anchoredVectorPathPlans.has(node.id))
      || (node.op === "cut.visual.motion_path"
        && this.anchoredMotionPathPlans.has(node.id))) {
      this.bindAnchoredPathRenderedOutput(node, time, surface);
    }
    this.frameMemo.set(memoKey, surface);
    return surface;
  }

  async sceneFrame(scene: IRScene, frame: number, includeDeliveryBackground = true) {
    if (this.closed || this.sceneFrameActive) throw new ReferenceVisualRendererStateError(this.composition.id);
    this.sceneFrameActive = true;
    try {
      const evidenceBudget = this.rendererTreeContext.evidenceBudget;
      if (this.ownsRendererTreeContext) {
        if (evidenceBudget.current?.active) throw new Error("CUT_LOCAL_SPACE_RASTER: root renderer-tree evidence budget is already active.");
        evidenceBudget.current = {
          token: Object.freeze({}),
          active: true,
          records: 0,
          copyUnits: 0,
        };
      } else if (!evidenceBudget.current?.active) {
        throw new Error("CUT_LOCAL_SPACE_RASTER: nested renderer executed outside its root renderer-tree frame.");
      }
      this.activeRendererFrameEvidenceGeneration = evidenceBudget.current;
      this.reserveLocalSpaceRendererTreeEvidenceRecords(1);
      if (this.activeSceneId !== undefined && this.activeSceneId !== scene.id) {
        const readers = [...this.decoders.values(), ...this.retainedMediaDecoders.values()].map((decoder) => decoder.reader);
        this.decoders.clear();
        this.retainedMediaDecoders.clear();
        this.staticImages.clear();
        this.retainedMediaStaticImages.clear();
        this.completedTraceSurfaces.clear();
        await Promise.all(readers.map((reader) => reader.closeAndWait()));
      }
      this.activeSceneId = scene.id;
      const sceneStartFrame = multiplyRational(scene.start, this.composition.fps);
      if (sceneStartFrame.denominator !== "1") throw new Error(`Scene “${scene.name}” start does not land on an exact output-frame boundary.`);
      const exactOutputFrame = BigInt(sceneStartFrame.numerator) + BigInt(frame);
      this.outputFrameIndex = exactOutputFrame >= 0n && exactOutputFrame <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(exactOutputFrame) : Number.NaN;
      this.frameMemo.clear(); this.precompFrames.clear(); this.retainedPathRasterMemo.clear(); this.localSpaceTileMemo.clear(); this.localSpacePlacementMemo.clear(); this.responsiveSlotTileMemo.clear(); this.diagramNodeTileMemo.clear(); this.diagramEdgeRasterMemo.clear(); this.geoAnnotationFrameEvidence = Object.freeze([]); this.mapCameraFrameEvidence = Object.freeze([]);
      this.activeResponsiveStackFrameEvidence = [];
      this.activeCalloutFrameEvidence = [];
      const time = rational(BigInt(frame) * BigInt(this.composition.fps.denominator), this.composition.fps.numerator);
      const activeIdentityComponentFragments = Object.freeze(
        [...this.identityComponentFragments.values()]
          .filter((config) => config.sceneId === scene.id)
          .sort((left, right) => left.rootSourceOrder - right.rootSourceOrder),
      );
      for (const config of activeIdentityComponentFragments) {
        assertReferenceIdentityComponentFragmentFresh(
          this.ir,
          this.composition,
          scene,
          config,
          this.localSpaceStructuralIndex.componentFragmentAdmissionIndex,
        );
      }
      this.activeDiagramLayoutFrameEvidence = [];
      this.activeAnchoredPathFrameEvidence = new Map();
      this.activeSemanticMatchFrameEvidence = [];
      this.activeCamera3DFrameEvidence = [];
      this.activeNestedLocalSpaceRendererFrameExecutions = [];
      this.beginPictureTimeMapFrameEvidence();
      this.beginLocalSpaceExecutionEvidence(time, String(exactOutputFrame));
      this.beginPlanarTrackExecutionEvidence(time, addRational(scene.start, time), String(exactOutputFrame));
      this.beginRetainedMediaExecutionEvidence();
      this.preflightMediaCamera2DFrame(scene, time, String(exactOutputFrame));
      this.activeParallaxCameraPlans.clear();
      this.activeGeoAnnotationPlans.clear();
      this.activeMapCameraGeoAnnotationPlans.clear();
      this.activeCalloutLayerPlans.clear();
      this.preflightLocalSpaceCompositionTransformWork(scene, time, String(exactOutputFrame));
      this.preflightPlanarTrackFrameWork(scene, time, frame);
      const roots = scene.items.filter((item) => item.domain === "visual" || item.domain === "av");
      const dispatches: Array<Readonly<{
        nodeId: string;
        fragmentNodeId?: string;
      }>> = [];
      for (const item of roots) {
        const fragment = this.identityComponentFragments.get(item.id);
        if (fragment && fragment.sceneId === scene.id) {
          dispatches.push(...fragment.childNodeIds.map((nodeId) => Object.freeze({
            nodeId,
            fragmentNodeId: fragment.fragmentNodeId,
          })));
        } else {
          dispatches.push(Object.freeze({ nodeId: item.id }));
        }
      }
      const renderedDispatches = await Promise.all(dispatches.map(async (dispatch) => Object.freeze({
        ...dispatch,
        surface: await this.nodeFrame(dispatch.nodeId, time, frame),
      })));
      for (const dispatch of renderedDispatches) {
        if (dispatch.fragmentNodeId && !dispatch.surface) {
          const node = this.ir.nodes[dispatch.nodeId] ?? this.ir.nodes[dispatch.fragmentNodeId]!;
          throw new ReferenceIdentityComponentFragmentError(
            "CUT_IDENTITY_FRAGMENT_EVIDENCE",
            node,
            `transparent structural dispatch ${dispatch.nodeId} returned no composition-space surface.`,
          );
        }
      }
      const layers = renderedDispatches.map((dispatch) => dispatch.surface);
      const rendered = !includeDeliveryBackground
        ? await composite(this.composition.width, this.composition.height, layers)
        : await (async () => {
          const background = await svgSurface(`<svg xmlns="http://www.w3.org/2000/svg" width="${this.composition.width}" height="${this.composition.height}"><rect width="100%" height="100%" fill="#050b10"/></svg>`, this.composition.width, this.composition.height);
          return composite(this.composition.width, this.composition.height, [background, ...layers]);
        })();
      const mediaCamera2DFrameEvidence = this.stagedMediaCamera2DFrameEvidence();
      validateReferenceResponsiveStackMediaFrameEvidence(
        this.activeResponsiveStackFrameEvidence ?? [],
        mediaCamera2DFrameEvidence,
      );
      const anchoredPathFrameEvidence = Object.freeze([...(this.activeAnchoredPathFrameEvidence?.values() ?? [])]
        .sort((left, right) => left.consumerNodeId.localeCompare(right.consumerNodeId)
          || compareRational(left.exactTime, right.exactTime)
          || left.executionIdentity.localeCompare(right.executionIdentity)));
      const calloutFrameEvidence = Object.freeze([...(this.activeCalloutFrameEvidence ?? [])]
        .sort((left, right) => left.executionIdentity.localeCompare(right.executionIdentity)));
      const responsiveStackFrameEvidence = Object.freeze(
        [...(this.activeResponsiveStackFrameEvidence ?? [])]
          .sort((left, right) => left.nodeId.localeCompare(right.nodeId)
            || left.executionIdentity.localeCompare(right.executionIdentity)),
      );
      const responsiveSlotMediaAnchorFrameEvidence =
        bindReferenceResponsiveSlotMediaAnchorFrameEvidence(
          this.composition.id,
          anchoredPathFrameEvidence,
          calloutFrameEvidence,
          mediaCamera2DFrameEvidence,
          responsiveStackFrameEvidence,
        );
      const sceneOutputRgbaSha256 =
        createHash("sha256").update(rendered.data).digest("hex");
      const identityComponentFragmentFrameEvidence = Object.freeze(
        activeIdentityComponentFragments.map((config) => {
          const children = renderedDispatches
            .filter((dispatch) => dispatch.fragmentNodeId === config.fragmentNodeId)
            .map((dispatch) => {
              const child = this.ir.nodes[dispatch.nodeId]!;
              return Object.freeze({
                nodeId: child.id,
                op: child.op,
                contentHash: child.contentHash,
                outputRgbaSha256: createHash("sha256")
                  .update(dispatch.surface!.data)
                  .digest("hex"),
              });
            });
          return referenceIdentityComponentFragmentFrameEvidence({
            config,
            exactTime: time,
            outputFrame: String(exactOutputFrame),
            children: Object.freeze(children),
            cameras: mediaCamera2DFrameEvidence,
            responsiveStacks: responsiveStackFrameEvidence,
            anchoredPaths: anchoredPathFrameEvidence,
            calloutLayers: calloutFrameEvidence,
            slotMediaAnchorLinks: responsiveSlotMediaAnchorFrameEvidence,
            sceneOutputRgbaSha256,
          });
        }),
      );
      for (const evidence of identityComponentFragmentFrameEvidence) {
        const config = this.identityComponentFragments.get(
          evidence.fragmentNodeId,
        );
        if (!config) {
          throw new Error(
            `CUT_IDENTITY_FRAGMENT_EVIDENCE: completed fragment ${evidence.fragmentNodeId} is not in the active authenticated graph.`,
          );
        }
        validateReferenceIdentityComponentFragmentFrameEvidence(
          evidence,
          config,
          {
            anchoredPaths: anchoredPathFrameEvidence,
            calloutLayers: calloutFrameEvidence,
            cameras: mediaCamera2DFrameEvidence,
            responsiveStacks: responsiveStackFrameEvidence,
            slotMediaAnchorLinks: responsiveSlotMediaAnchorFrameEvidence,
          },
          sceneOutputRgbaSha256,
        );
      }
      const pictureTimeMapFrameEvidence =
        this.stagedPictureTimeMapFrameEvidence();
      this.publishLocalSpaceExecutionEvidence();
      this.publishRetainedMediaExecutionEvidence();
      this.publishPlanarTrackExecutionEvidence();
      this.completedDiagramLayoutFrameEvidence = Object.freeze([...(this.activeDiagramLayoutFrameEvidence ?? [])]);
      this.completedSemanticMatchFrameEvidence = Object.freeze([...(this.activeSemanticMatchFrameEvidence ?? [])]
        .sort((left, right) => left.executionIdentity.localeCompare(right.executionIdentity)));
      this.completedCamera3DFrameEvidence = Object.freeze([...(this.activeCamera3DFrameEvidence ?? [])]
        .sort((left, right) => left.nodeId.localeCompare(right.nodeId)));
      this.completedLocalSpaceCompositionTransformPreflight = this.activeLocalSpaceCompositionTransformPreflight;
      this.completedComponentFragmentLocalSpacePreflight = this.activeComponentFragmentLocalSpacePreflight;
      this.publishLocalSpaceRendererFrameExecutionTree();
      // Callout receipts are committed only after every renderer-tree ledger
      // and authority check has succeeded. A failed frame cannot replace the
      // last completed Callout evidence.
      this.completedAnchoredPathFrameEvidence = anchoredPathFrameEvidence;
      this.completedCalloutFrameEvidence = calloutFrameEvidence;
      this.completedMediaCamera2DFrameEvidence = mediaCamera2DFrameEvidence;
      this.completedResponsiveStackFrameEvidence = responsiveStackFrameEvidence;
      this.completedResponsiveSlotMediaAnchorFrameEvidence =
        responsiveSlotMediaAnchorFrameEvidence;
      this.completedIdentityComponentFragmentFrameEvidence =
        identityComponentFragmentFrameEvidence;
      this.completedPictureTimeMapFrameEvidence =
        pictureTimeMapFrameEvidence;
      return rendered;
    } finally {
      await this.drainActiveNodeFrameWork();
      this.activeLocalSpaceFrameEvidence = undefined;
      this.activePlanarTrackFrameEvidence = undefined;
      this.activeRetainedMediaViewportFrameEvidence = undefined;
      this.activeRetainedMediaCompositionFrameEvidence = undefined;
      this.activeRetainedMediaLocalCompositorFrameEvidence = undefined;
      closeReferenceMediaCamera2DSceneAdmission(this.activeMediaCamera2DSceneAdmission);
      this.activeMediaCamera2DFrameEvidence = undefined;
      this.activeMediaCamera2DOutputFrame = undefined;
      this.activeMediaCamera2DSceneAdmission = undefined;
      this.activeMediaCamera2DFramePlans.clear();
      this.activeMediaCamera2DAnchorPlans.clear();
      this.activeDiagramLayoutFrameEvidence = undefined;
      this.activeAnchoredPathFrameEvidence = undefined;
      this.activeSemanticMatchFrameEvidence = undefined;
      this.activeCamera3DFrameEvidence = undefined;
      this.activeCalloutFrameEvidence = undefined;
      this.activeResponsiveStackFrameEvidence = undefined;
      this.activeNestedLocalSpaceRendererFrameExecutions = undefined;
      this.activePictureTimeMapFrameEvidence = undefined;
      this.activeLocalSpaceCompositionTransformPreflight = undefined;
      this.activeComponentFragmentLocalSpacePreflight = undefined;
      this.activeAffineLocalSpacePlans.clear();
      this.activeParallaxCameraPlans.clear();
      this.activeGeoAnnotationPlans.clear();
      this.activeMapCameraGeoAnnotationPlans.clear();
      this.activeCalloutLayerPlans.clear();
      if (this.ownsRendererTreeContext) {
        const generation = this.activeRendererFrameEvidenceGeneration;
        if (generation) generation.active = false;
        if (this.rendererTreeContext.evidenceBudget.current === generation) {
          this.rendererTreeContext.evidenceBudget.current = undefined;
        }
      }
      this.activeRendererFrameEvidenceGeneration = undefined;
      this.sceneFrameActive = false;
    }
  }

  /** Same-invocation renderer evidence for the most recently completed frame. */
  referenceGeoAnnotationEvidence() {
    return Object.freeze([...this.geoAnnotationFrameEvidence].sort((left, right) => left.executionIdentity.localeCompare(right.executionIdentity)));
  }

  /** Same-invocation generic CalloutLayer execution for the most recently
   * completed frame. Failed frames never replace this staged receipt. */
  referenceCalloutLayerEvidence() {
    return Object.freeze([...this.completedCalloutFrameEvidence]);
  }

  /** Same-invocation retained-geographic execution for the most recently
   * completed frame. RGBA bytes are represented by count/hash, never embedded. */
  referenceMapCameraEvidence() {
    return Object.freeze([...this.mapCameraFrameEvidence].sort((left, right) => left.executionIdentity.localeCompare(right.executionIdentity)));
  }

  /** Same-invocation retained planar-3D pixels, matrices, projective work and
   * paint order for the most recently completed frame. */
  referenceCamera3DEvidence() {
    return Object.freeze([...this.completedCamera3DFrameEvidence]);
  }

  /** Exact owner-local to composition-space route resolution used by the
   * most recently completed frame. Opaque owner-plan identities are retained
   * for audit but excluded from geometry/cache identity. */
  referenceAnchoredPathEvidence() {
    return Object.freeze([...this.completedAnchoredPathFrameEvidence]);
  }

  /** Actual work for the most recently completed frame. A failed invocation
   * never replaces the last completed receipt with partial counters. */
  referenceLocalSpaceEvidence() {
    return this.completedLocalSpaceFrameEvidence;
  }

  /** Root-first, path-stable proof for every renderer instance that contributed
   * LocalSpace pixels or zero-work execution to the most recently completed
   * frame. Distinct Precomp instances are retained even when their child
   * execution identities are byte-identical. */
  referenceLocalSpaceRendererFrameExecutionEvidence() {
    return this.completedLocalSpaceRendererFrameExecutionReceipts;
  }

  /** Independently copied per-entry comparison contexts in renderer-tree path
   * order. These are useful for semantic consistency tests but are not the
   * non-forgeable complete-tree authority. */
  referenceLocalSpaceRendererFrameExecutionTrustedContexts() {
    return Object.freeze(this.completedLocalSpaceRendererFrameExecutions.map((entry) => entry.trustedContext));
  }

  /** Closed count/path/receipt digest for the complete current renderer tree. */
  referenceLocalSpaceRendererFrameExecutionTreeEvidence() {
    if (!this.completedLocalSpaceRendererFrameExecutionTree) {
      throw new Error("CUT_LOCAL_SPACE_RASTER: no completed renderer-tree LocalSpace evidence is available.");
    }
    return this.completedLocalSpaceRendererFrameExecutionTree;
  }

  /** Opaque same-invocation completeness authority. Its WeakSet brand cannot
   * be reconstructed from serialized JSON or by spreading this object. */
  referenceLocalSpaceRendererFrameExecutionTreeTrustedAuthority() {
    if (!this.completedLocalSpaceRendererFrameExecutionTreeAuthority) {
      throw new Error("CUT_LOCAL_SPACE_RASTER: no completed renderer-tree LocalSpace authority is available.");
    }
    return this.completedLocalSpaceRendererFrameExecutionTreeAuthority;
  }

  /** Exact component placement plans and aggregate work for the most recently
   * completed frame. A failed frame leaves the previous receipt untouched. */
  referenceComponentFragmentLocalSpacePreflightEvidence() {
    return this.completedComponentFragmentLocalSpacePreflight;
  }

  /** Composition-wide affine LocalSpace admission, including nested
   * parent-local outputs and every MotionBlur shutter sample. */
  referenceLocalSpaceCompositionTransformPreflightEvidence() {
    return this.completedLocalSpaceCompositionTransformPreflight;
  }

  /** Same-invocation completed semantic-match execution receipts. */
  referenceSemanticMatchEvidence() {
    return this.completedSemanticMatchFrameEvidence;
  }

  /** Same-invocation completed PlanarTrack projective execution receipts. */
  referencePlanarTrackEvidence() {
    return Object.freeze([...this.completedPlanarTrackFrameEvidence]
      .sort((left, right) => left.executionIdentity.localeCompare(right.executionIdentity)));
  }

  /** Independently retained live locked-render authority for the PlanarTrack
   * receipts above. This context is intentionally not serialized into the
   * public frame manifest: doing so would let a JSON editor forge the receipt
   * and its supposed authority together. */
  referencePlanarTrackEvidenceTrustedContexts() {
    return Object.freeze([...this.completedPlanarTrackFrameTrustedContexts]
      .sort((left, right) => left.expected.executionIdentity.localeCompare(right.expected.executionIdentity)));
  }

  /** Same-invocation evidence for native media decoded, fitted, and affined
   * directly into a bounded LocalSpace viewport. */
  referenceRetainedMediaViewportEvidence() {
    return Object.freeze([...this.completedRetainedMediaViewportFrameEvidence].sort((left, right) => left.executionIdentity.localeCompare(right.executionIdentity)));
  }

  /** Same-invocation proof for the native-crop-to-delivery MediaCamera2D
   * path. No private paths or media bytes are embedded in these receipts. */
  referenceMediaCamera2DEvidence() {
    return Object.freeze([...this.completedMediaCamera2DFrameEvidence]);
  }

  /** Private same-build cache activation witness; never sourced from CUT. */
  referenceStaticMediaGradeCacheEvidence() {
    return this.rendererTreeContext.staticMediaGradeCache.evidenceSnapshot();
  }

  /** Private same-build activation witness for the exact source-over kernel. */
  referencePrivateStraightCompositeEvidence() {
    const diagnostic = this.rendererTreeContext.privateStraightCompositeDiagnostic;
    return diagnostic
      ? referencePrivateStraightRgbaCompositeDiagnosticSnapshot(diagnostic)
      : undefined;
  }

  /** Completed source-ordered LocalSpace media/overlay compositions. Each
   * receipt binds per-child results and the final bounded local tile hash. */
  referenceRetainedMediaCompositionEvidence() {
    return Object.freeze([...this.completedRetainedMediaCompositionFrameEvidence].sort((left, right) => left.executionIdentity.localeCompare(right.executionIdentity)));
  }

  /** Completed retained Image/Video materialization islands plus every
   * rendered or runtime-skipped LocalSpace compositor operation. */
  referenceRetainedMediaLocalCompositorEvidence() {
    return Object.freeze([...this.completedRetainedMediaLocalCompositorFrameEvidence]
      .sort((left, right) => left.executionIdentity.localeCompare(right.executionIdentity)));
  }

  /** Completed public responsive-layout executions for the most recent frame. */
  referenceResponsiveStackEvidence() {
    return Object.freeze([...this.completedResponsiveStackFrameEvidence]);
  }

  /** Cross-bound proof that each slot-camera visualAnchor consumed the exact
   * completed native camera frame and exact integer ResponsiveStack placement. */
  referenceResponsiveSlotMediaAnchorEvidence() {
    return Object.freeze([...this.completedResponsiveSlotMediaAnchorFrameEvidence]);
  }

  /** Completed zero-wrapper composition-space dispatch for public Visual
   * components containing ResponsiveStack plus anchored overlays. */
  referenceIdentityComponentFragmentEvidence() {
    return Object.freeze([...this.completedIdentityComponentFragmentFrameEvidence]);
  }

  /** Same-invocation completed DiagramLayout pixels and exact planner frame.
   * A failed sceneFrame never replaces the prior completed evidence. */
  referenceDiagramLayoutEvidence() {
    return Object.freeze([...this.completedDiagramLayoutFrameEvidence].sort((left, right) => left.nodeId.localeCompare(right.nodeId)));
  }

  /** Same-invocation, path-free evidence for prepared public audio producers. */
  referenceAudioReactivePreparationEvidence() {
    return Object.freeze([...this.audioReactivePreparationEvidence]);
  }

  /** Same-invocation, path-free proof of the exact selected-video decode plan.
   * The receipt exposes frame-index trimming and the bounded output-frame cap;
   * it intentionally cannot expose a private source path or subprocess PID. */
  referenceVideoDecoderEvidence() {
    return Object.freeze([...this.decoders.values(), ...this.retainedMediaDecoders.values()].map((decoder) => decoder.evidence).sort((left, right) => left.nodeId.localeCompare(right.nodeId) || left.mode.localeCompare(right.mode)));
  }

  /** Exact typed destination/source clock and selected decoder frames used by
   * every PictureClip contributing to the most recently completed scene
   * frame. Nested receipts carry their full instance path. A failed frame
   * leaves the prior completed set untouched. */
  referencePictureTimeMapExecutionEvidence() {
    return Object.freeze([...this.completedPictureTimeMapFrameEvidence]);
  }

  /**
   * Path-free preparation-state evidence for selected-range preview
   * verification. This proves which validated nested instances were actually
   * materialized; it does not relax whole-graph validation or locked-resource
   * authority.
   */
  referenceNestedCompositionPreparationEvidence() {
    return Object.freeze({
      format: "cut-reference-nested-composition-preparation" as const,
      version: 1 as const,
      policy: this.rendererTreeContext.nestedCompositionPreparation,
      configuredNodeIds: Object.freeze([...this.precompConfigs.keys()].sort()),
      preparedNodeIds: Object.freeze([...this.precompRenderers.keys()].sort()),
      pendingNodeIds: Object.freeze([...this.precompRendererPreparations.keys()].sort()),
    });
  }

  closeAndWait() {
    if (this.closing) return this.closing;
    this.closed = true;
    if (this.completedLocalSpaceRendererFrameExecutionTreeAuthority) {
      trustedLocalSpaceRendererFrameExecutionTreeAuthorities.delete(this.completedLocalSpaceRendererFrameExecutionTreeAuthority);
      this.completedLocalSpaceRendererFrameExecutionTreeAuthority = undefined;
    }
    const readers = [...this.decoders.values(), ...this.retainedMediaDecoders.values()].map((decoder) => decoder.reader);
    this.precompFrames.clear(); this.decoders.clear(); this.retainedMediaDecoders.clear();
    this.closing = (async () => {
      // A lazy nested renderer may be between construction and final
      // preparation. Drain every such transaction before closing the exact
      // renderer set, so no preparation can publish into a closed parent and
      // no nested decoder/cache survives failure cleanup.
      await Promise.allSettled([...this.precompRendererPreparations.values()]);
      const renderers = [...new Set(this.precompRenderers.values())];
      this.precompRendererPreparations.clear();
      this.precompRenderers.clear();
      const closeResults = await Promise.allSettled([
        ...renderers.map((renderer) => renderer.closeAndWait()),
        ...readers.map((reader) => reader.closeAndWait()),
      ]);
      const failures = closeResults
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      const cleanup = (operation: () => void) => {
        try { operation(); } catch (error) { failures.push(error); }
      };
      cleanup(() => { this.preparedLuts.clear(); this.captionSurfaces.clear(); this.captionSurfaceBytes = 0; });
      cleanup(() => { this.preparedFlowTexts.clear(); });
      cleanup(() => { this.textSurfaces.clear(); this.textSurfaceBytes = 0; });
      cleanup(() => { this.localTextSurfaces.clear(); this.localTextSurfaceBytes = 0; });
      cleanup(() => { this.evidenceSurfaces.clear(); this.evidenceSurfaceBytes = 0; });
      cleanup(() => { this.completedTraceSurfaces.clear(); this.staticImages.clear(); this.frameMemo.clear(); });
      cleanup(() => { this.preparedImageSequences.clear(); this.imageSequenceSurfaces.clear(); this.imageSequenceSurfaceBytes = 0; });
      cleanup(() => { this.retainedMediaStaticImages.clear(); });
      cleanup(() => { this.pictureTimeMapConfigs.clear(); });
      cleanup(() => { this.pictureTimeMapConfigIdentities.clear(); });
      cleanup(() => {
        this.activePictureTimeMapFrameEvidence = undefined;
        this.completedPictureTimeMapFrameEvidence = Object.freeze([]);
      });
      cleanup(() => { this.retainedPathRasterMemo.clear(); });
      cleanup(() => { this.diagramNodeTileMemo.clear(); this.diagramEdgeRasterMemo.clear(); });
      if (this.ownsRendererTreeContext) cleanup(() => { this.rendererTreeContext.localPaintSurfaceCache.clear(); });
      if (this.ownsRendererTreeContext) cleanup(() => { this.rendererTreeContext.staticMediaGradeCache.clear(); });
      if (this.ownsRendererTreeContext) cleanup(() => { this.rendererTreeContext.mapCameraCanonicalRasterCache.clear(); });
      cleanup(() => { this.preparedSignalResolver.close(); });
      if (failures.length > 0) throw failures[0];
    })();
    return this.closing;
  }

  close() { void this.closeAndWait(); }
}
