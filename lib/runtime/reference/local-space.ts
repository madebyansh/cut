import { hash } from "../../core/stable";
import type { CutAVIR, IRComposition, IRNode, IRValue } from "../../language/ir";
import { addRational, compareRational, rational, rationalToNumber, subtractRational, type Rational, zeroRational } from "../../language/rational";
import { referenceRetainedSurfacePhaseUnits } from "./retained-surface";
import { referenceTextConfig, type ReferenceTextLayoutContext } from "./text-config";
import { referenceFlowTextConfig } from "./text-flow";
import { prepareReferenceTraceNode } from "./trace";
import {
  planReferenceLocalCompositing,
  referenceLocalCompositingInspect,
  referenceLocalCompositingLimits,
  type ReferenceLocalCompositingPlan,
} from "./local-compositing";
import {
  discoverReferenceRetainedMediaLocalCompositor,
  finalizeReferenceRetainedMediaLocalCompositorPlan,
  referenceRetainedMediaCompositionInspect,
  referenceRetainedMediaCompositionPlan,
  referenceRetainedMediaLocalCompositorInspect,
  referenceRetainedMediaStaticLocalTopology,
  referenceRetainedMediaViewportInspect,
  referenceRetainedMediaViewportLimits,
  type ReferenceRetainedMediaCompositionPlan,
  type ReferenceRetainedMediaLocalCompositorPlan,
  type ReferenceRetainedMediaViewportPlan,
} from "./retained-media-viewport";
import {
  createReferenceComponentFragmentLocalSpaceAdmissionIndex,
  referenceComponentFragmentLocalSpaceAdmissionIssue,
  type ReferenceComponentFragmentLocalSpaceAdmissionIndex,
} from "./component-fragment-local-space";
import { referencePlanarTrackMatteConfig } from "./planar-track-matte";
import { isReferenceAnchoredPathGeometryValue } from "./anchored-path";
import type {
  ReferenceLocalSpaceScaleTranslationExecutionEvidence,
} from "./local-space-scale-translation";
import {
  referenceLocalSpaceScaleTranslationAlgorithmVersion,
  referenceLocalSpaceScaleTranslationSampler,
} from "./local-space-scale-translation";

export const referenceLocalSpaceAlgorithmVersion = "cut-reference-local-space-v1" as const;
export const referenceLocalSpaceFrameEvidenceFormat = "cut-reference-local-space-frame-evidence" as const;
export const referenceLocalMotionPathAlgorithmVersion = "cut-reference-local-motion-path-v1" as const;

export const referenceLocalSpaceLimits = Object.freeze({
  maximumAxisPx: 16_384,
  /** The current Q16 translator's destination-canvas ceiling. Keeping the
   * checkpoint tighter prevents a 16M-67M nested tile from failing late under
   * a foreign retained-surface diagnostic. */
  maximumSurfacePixels: 16_777_216,
  maximumSurfaceRgbaBytes: 67_108_864,
  maximumDirectChildren: 256,
  maximumRetainedMediaBranchesPerExecutionDomain: referenceRetainedMediaViewportLimits.maximumBranchesPerExecutionDomain,
  /** Frame-v2 LocalSpace receipts publish one tile and one placement for each
   * active LocalSpace. Keep admission aligned with the closed evidence schema
   * instead of allowing a render that can only fail while serializing proof. */
  maximumLocalSpacesPerExecutionDomain: 4_096,
  maximumNestedLocalSpaces: 16,
  maximumLiveLocalSurfacePixelsPerFrame: 67_108_864,
  maximumPixelPassesPerFrame: 1_073_741_824,
  /** Prepared Trace vertices visited by all concurrently renderable
   * LocalSpaces in one scene/composition execution domain. This admits one
   * worst-case cubic Trace while bounding SVG construction before raster. */
  maximumPreparedTracePointsPerExecutionDomain: 65_536,
});

export type ReferenceLocalSpaceErrorCode =
  | "CUT_LOCAL_SPACE_TYPE"
  | "CUT_LOCAL_SPACE_BOUNDS"
  | "CUT_LOCAL_SPACE_GRAPH"
  | "CUT_LOCAL_SPACE_UNSUPPORTED"
  | "CUT_LOCAL_SPACE_LIMIT"
  | "CUT_LOCAL_SPACE_RASTER";

export class ReferenceLocalSpaceError extends Error {
  readonly source: Readonly<{ module: string; line: number; column: number; nodeId: string }>;

  constructor(readonly code: ReferenceLocalSpaceErrorCode, readonly node: IRNode, detail: string) {
    const { module, span } = node.provenance;
    super(`${code}: LocalSpace at ${module}:${span.start.line}:${span.start.column} ${detail}`);
    this.name = "ReferenceLocalSpaceError";
    this.source = Object.freeze({ module, line: span.start.line, column: span.start.column, nodeId: node.id });
  }
}

export type ReferenceLocalSpaceConfig = Readonly<{
  nodeId: string;
  width: number;
  height: number;
  /** Exact through planning and identity; conversion to a backend number is
   * permitted only at the documented retained-surface Q16 raster boundary. */
  origin: Readonly<{ x: Rational; y: Rational }>;
  /** One exact round-half-up quantization shared by local raster coordinates
   * and registered placement. Values are total Q16 pixel units. */
  rasterOriginQ16: Readonly<{ x: string; y: string }>;
  view: Readonly<{ minX: Rational; minY: Rational; maxX: Rational; maxY: Rational }>;
  childIds: readonly string[];
  nestingDepth: number;
  estimatedPixelPassesPerFrame: number;
  preparedTracePointsPerFrame: number;
  owner: "scene-root" | "component-fragment" | "group" | "motion-path" | "camera-2d" | "local-space" | "geo-annotation" | "callout" | "track-2d" | "planar-track" | "depth-layer" | "plane-3d";
  ownerNodeId?: string;
  semanticIdentity: string;
  /** Kept for source/API compatibility whenever exactly one retained-media
   * branch exists, including a branch composed with ordinary local overlays. */
  retainedMediaViewport?: ReferenceRetainedMediaViewportPlan;
  /** Additive only for non-legacy source-ordered compositions: one retained
   * branch plus siblings, or multiple retained branches. */
  retainedMediaComposition?: ReferenceRetainedMediaCompositionPlan;
  /** Closed graphical operation plan executed on this exact tile before the
   * owner places or warps it. Empty plans preserve historical LocalSpace
   * pixels and identity except for the additive inspect field. */
  localCompositing: ReferenceLocalCompositingPlan;
  /** Additive V2 plan for locked Image/Video islands admitted beneath the
   * already-public LocalSpace compositor. Historical direct retained-media
   * branches never receive this field or a changed identity. */
  retainedMediaLocalCompositor?: ReferenceRetainedMediaLocalCompositorPlan;
  /** Additive identity and inspect projection for ordinary MotionPath
   * descendants executed in this LocalSpace's authored coordinate basis.
   * MotionPath-owning-LocalSpace remains the separate historical owner path. */
  localMotionPath?: Readonly<{
    algorithmVersion: typeof referenceLocalMotionPathAlgorithmVersion;
    nodeIds: readonly string[];
    coordinateBasis: "authored-local-pixel-edges";
    authoredSampleContract: "path-head-before-centre-relative-raster-placement";
  }>;
}>;

export type ReferenceLocalSpaceValidationOptions = Readonly<{
  /** `topology-only` is reserved for asset-free `cut check`. The default
   * locked phase retains exact hashes/probes/native/crop/fit/allocation work. */
  retainedMediaPlanning?: "locked" | "topology-only";
  /** One immutable structural snapshot may be shared by every composition
   * validation in the same already-loaded IR. Callers must not reuse it after
   * mutating/replacing that IR. */
  structuralIndex?: ReferenceLocalSpaceStructuralValidationIndex;
}>;

export type ReferenceLocalSpaceStructuralValidationIndex = Readonly<{
  parentNodesForChild(id: string): readonly IRNode[];
  rootMembershipCount(id: string): number;
  componentFragmentAdmissionIndex: ReferenceComponentFragmentLocalSpaceAdmissionIndex;
}>;

/** Build all whole-document ownership facts once. The backing Maps remain
 * private to lookup closures, so untrusted JavaScript cannot mutate a
 * `ReadonlyMap` cast and alter a later admission decision. */
export function createReferenceLocalSpaceStructuralValidationIndex(
  ir: CutAVIR,
): ReferenceLocalSpaceStructuralValidationIndex {
  const parents = new Map<string, IRNode[]>();
  for (const parent of Object.values(ir.nodes)) for (const childId of parent.children) {
    const values = parents.get(childId) ?? [];
    values.push(parent);
    parents.set(childId, values);
  }
  const frozenParents = new Map([...parents].map(([id, values]) => [id, Object.freeze([...values])]));
  const emptyParents = Object.freeze([]) as readonly IRNode[];
  const rootMembership = new Map<string, number>();
  const markRoot = (id: string) => rootMembership.set(id, (rootMembership.get(id) ?? 0) + 1);
  for (const composition of ir.compositions) {
    for (const item of composition.items) if (item.kind === "node") markRoot(item.id);
  }
  for (const scene of Object.values(ir.scenes)) for (const item of scene.items) markRoot(item.id);
  return Object.freeze({
    parentNodesForChild: (id: string) => frozenParents.get(id) ?? emptyParents,
    rootMembershipCount: (id: string) => rootMembership.get(id) ?? 0,
    componentFragmentAdmissionIndex: createReferenceComponentFragmentLocalSpaceAdmissionIndex(ir),
  });
}

export function referenceLocalSpaceRetainedMediaPlans(config: ReferenceLocalSpaceConfig) {
  if (config.retainedMediaComposition) return config.retainedMediaComposition.branches;
  return config.retainedMediaViewport ? Object.freeze([config.retainedMediaViewport]) : Object.freeze([]);
}

export function referenceLocalSpaceRetainedMediaPlanForRoot(config: ReferenceLocalSpaceConfig, rootId: string) {
  return referenceLocalSpaceRetainedMediaPlans(config).find((plan) => plan.rootId === rootId);
}

/** All materialization islands visible to the runtime. Kept separate from the
 * historical direct-branch helpers so their public meaning and receipts stay
 * byte-for-byte stable. */
export function referenceLocalSpaceAllRetainedMediaPlans(config: ReferenceLocalSpaceConfig) {
  return Object.freeze([
    ...referenceLocalSpaceRetainedMediaPlans(config),
    ...(config.retainedMediaLocalCompositor?.islands.map((island) => island.plan) ?? []),
  ]);
}

export function referenceLocalSpaceRetainedMediaMaterializationForRoot(config: ReferenceLocalSpaceConfig, rootId: string) {
  return referenceLocalSpaceAllRetainedMediaPlans(config).find((plan) => plan.rootId === rootId);
}

export type ReferenceLocalSpacePlacement = Readonly<{
  owner: "scene-root" | "component-fragment" | "group" | "motion-path" | "camera-2d" | "local-space" | "geo-annotation" | "callout" | "track-2d" | "depth-layer" | "plane-3d";
  /** Composition or parent LocalSpace executable identity. */
  contextIdentity: string;
  destinationX: number;
  destinationY: number;
  registrationRasterX: number;
  registrationRasterY: number;
  scale: number;
  skewX: number;
  skewY: number;
  rotation: number;
  opacity: number;
}>;

export type ReferenceLocalSpaceExecutionCounters = Readonly<{
  tileRequests: number;
  tileRasterizations: number;
  tileMemoHits: number;
  tilePixelsRasterized: number;
  placementRequests: number;
  placementRasterizations: number;
  placementMemoHits: number;
  placementDestinationPixels: number;
  /** Actual allocation-heavy retained transform invocations in this frame. */
  transformExecutions: number;
  /** Must remain one under the installed per-renderer FIFO discipline. */
  maximumConcurrentTransforms: number;
  localNodeRasterizations: number;
  localNodePixelsRasterized: number;
  localNodeRgbaBytesRasterized: number;
  /** Eligible immutable Rect/Path base-raster requests served from cache. */
  localPaintSurfaceCacheHits: number;
  /** Eligible immutable Rect/Path base-raster materializations admitted. */
  localPaintSurfaceCacheMisses: number;
  /** Ineligible dynamic or bounded-capacity requests rendered uncached. */
  localPaintSurfaceCacheBypasses: number;
  /** Completed cache entries evicted while admitting this frame's work. */
  localPaintSurfaceCacheEvictions: number;
  /** Renderer-tree cache residency after the latest request in this frame. */
  localPaintSurfaceCacheResidentBytes: number;
  inactiveNodeSkips: number;
  ownerOpacitySkips: number;
  ownerPolicySkips: number;
  localNodeOpacitySkips: number;
}>;

export type ReferenceLocalSpaceRenderedTileEvidence = Readonly<{
  nodeId: string;
  tileIdentity: string;
  width: number;
  height: number;
  localCompositing?: Readonly<{
    algorithmVersion: "cut-reference-local-compositing-v1";
    planIdentity: string;
    operations: readonly Readonly<{
      sourceOrder: number;
      nodeId: string;
      op: string;
      semanticIdentity: string;
      estimatedPixelWorkPerFrame: number;
    }>[];
    finalRgbaSha256: string;
  }>;
}>;

/** Actual geometry observed by the retained transform invocation after its
 * admitted allocator receipt has been re-derived from the runtime request.
 * This is execution evidence, not a second estimate. Track2D and DepthLayer
 * placements must carry it; historical and other-owner receipts remain
 * compatible without it. */
export type ReferenceLocalSpaceTransformExecutionEvidence = Readonly<{
  workIdentity: string;
  algorithmVersion:
    | "cut-reference-local-space-transform-work-v2"
    | "cut-reference-local-space-affine-transform-work-v3"
    | "cut-reference-local-space-destination-clipped-transform-work-v1";
  rendererHandoff: "connected-reference-visual-renderer";
  schedulingEnforcement: "reference-visual-renderer-fifo-v1";
  source: Readonly<{ width: number; height: number }>;
  requestedResize: Readonly<{ width: number; height: number }>;
  sharpCover: Readonly<{ width: number; height: number }>;
  /** Present only when the installed simultaneous-shear filter executed. */
  skew?: Readonly<{
    width: number;
    height: number;
    skewXDegrees: number;
    skewYDegrees: number;
  }>;
  rotation: Readonly<{ width: number; height: number; canonicalDegrees: number }>;
  destination: Readonly<{ width: number; height: number }>;
  opacityDestinationCopies: 0 | 1;
  /** Present when a real resize plus fractional placement is fused, or when
   * the legacy integer-phase RGB16 intermediate exceeds the unchanged work
   * ceiling and the destination-clipped direct sampler is required. */
  scaleTranslation?: ReferenceLocalSpaceScaleTranslationExecutionEvidence;
}>;

export type ReferenceLocalSpaceRenderedPlacementEvidence = Readonly<{
  nodeId: string;
  placementIdentity: string;
  tileIdentity: string;
  owner: ReferenceLocalSpacePlacement["owner"];
  contextIdentity: string;
  destinationWidth: number;
  destinationHeight: number;
  /** Additive v1 evidence. Historical receipts without this execution detail
   * remain valid; current Track/Depth writers must populate it. */
  transform?: Readonly<{
    destinationX: number;
    destinationY: number;
    registrationRasterX: number;
    registrationRasterY: number;
    scale: number;
    skewX: number;
    skewY: number;
    rotation: number;
    opacity: number;
  }>;
  transformWork?: ReferenceLocalSpaceTransformExecutionEvidence;
}>;

type ReferenceLocalSpaceOrdinaryRenderSkipEvidence = Readonly<{
  nodeId: string;
  ownerNodeId?: string;
  /** Exact renderer sample that produced this skip. Additive for frozen v1
   * receipt compatibility; every current writer supplies it. */
  sampleTime?: Rational;
  kind: "inactive-node" | "owner-opacity" | "local-node-opacity" | "owner-policy";
  reason: "outside-interval" | "opacity-zero" | "tracking-policy-hidden";
}>;

/** A Callout can be admitted and materialize its retained tile, yet have a
 * positive opacity so small that every possible RGBA8 sample quantizes to
 * transparent. This is a real zero-transform execution state, not a painted
 * placement. Preserve the admitted placement descriptor so locked-IR
 * validation can still reproduce the composition preflight exactly. */
export type ReferenceLocalSpaceQuantizedOpacitySkipEvidence = Readonly<{
  nodeId: string;
  ownerNodeId: string;
  sampleTime: Rational;
  kind: "owner-opacity";
  reason: "opacity-quantized-transparent";
  tileIdentity: string;
  admissionPlanIdentity: string;
  placementIdentity: string;
  destinationWidth: number;
  destinationHeight: number;
  placement: ReferenceLocalSpacePlacement;
}>;

export type ReferenceLocalSpaceRenderSkipEvidence =
  | ReferenceLocalSpaceOrdinaryRenderSkipEvidence
  | ReferenceLocalSpaceQuantizedOpacitySkipEvidence;

export type ReferenceLocalSpaceFrameEvidence = Readonly<{
  format: typeof referenceLocalSpaceFrameEvidenceFormat;
  version: 1;
  evidenceKind: "completed-frame-execution";
  algorithmVersion: typeof referenceLocalSpaceAlgorithmVersion;
  compositionId: string;
  exactTime: Rational;
  outputFrame: string;
  backendIdentity: string;
  counters: ReferenceLocalSpaceExecutionCounters;
  tiles: readonly ReferenceLocalSpaceRenderedTileEvidence[];
  placements: readonly ReferenceLocalSpaceRenderedPlacementEvidence[];
  skips: readonly ReferenceLocalSpaceRenderSkipEvidence[];
  /** Stable rendered-execution meaning with cache-history counters projected out. */
  executionIdentity: string;
  /** Exact observed receipt, including cold/warm cache behavior. */
  observationIdentity: string;
}>;

export type ReferenceLocalSpaceFrameEvidenceInput = Readonly<{
  compositionId: string;
  exactTime: Rational;
  outputFrame: string;
  backendIdentity: string;
  counters: ReferenceLocalSpaceExecutionCounters;
  tiles: readonly ReferenceLocalSpaceRenderedTileEvidence[];
  placements: readonly ReferenceLocalSpaceRenderedPlacementEvidence[];
  skips: readonly ReferenceLocalSpaceRenderSkipEvidence[];
}>;

/** Finalize actual same-invocation execution evidence. This receipt is kept
 * deliberately separate from `referenceLocalSpaceInspect`, whose work values
 * are conservative preflight estimates rather than observed runtime counts. */
export function referenceLocalSpaceFrameEvidence(input: ReferenceLocalSpaceFrameEvidenceInput): ReferenceLocalSpaceFrameEvidence {
  const tiles = Object.freeze(input.tiles.map((entry) => Object.freeze({ ...entry })).sort((left, right) =>
    left.tileIdentity.localeCompare(right.tileIdentity) || left.nodeId.localeCompare(right.nodeId)));
  const placements = Object.freeze(input.placements.map((entry) => Object.freeze({ ...entry })).sort((left, right) =>
    left.placementIdentity.localeCompare(right.placementIdentity) || left.nodeId.localeCompare(right.nodeId)));
  const skips = Object.freeze(input.skips.map((entry) => Object.freeze({ ...entry })).sort((left, right) =>
    left.nodeId.localeCompare(right.nodeId)
      || (left.ownerNodeId ?? "").localeCompare(right.ownerNodeId ?? "")
      || (left.sampleTime?.numerator ?? "").localeCompare(right.sampleTime?.numerator ?? "")
      || (left.sampleTime?.denominator ?? "").localeCompare(right.sampleTime?.denominator ?? "")
      || left.kind.localeCompare(right.kind)
      || left.reason.localeCompare(right.reason)));
  const receipt = Object.freeze({
    format: referenceLocalSpaceFrameEvidenceFormat,
    version: 1 as const,
    evidenceKind: "completed-frame-execution" as const,
    algorithmVersion: referenceLocalSpaceAlgorithmVersion,
    compositionId: input.compositionId,
    exactTime: Object.freeze({ ...input.exactTime }),
    outputFrame: input.outputFrame,
    backendIdentity: input.backendIdentity,
    counters: Object.freeze({ ...input.counters }),
    tiles,
    placements,
    skips,
  });
  const {
    localNodeRasterizations: _localNodeRasterizations,
    localNodePixelsRasterized: _localNodePixelsRasterized,
    localNodeRgbaBytesRasterized: _localNodeRgbaBytesRasterized,
    localPaintSurfaceCacheHits: _localPaintSurfaceCacheHits,
    localPaintSurfaceCacheMisses: _localPaintSurfaceCacheMisses,
    localPaintSurfaceCacheBypasses: _localPaintSurfaceCacheBypasses,
    localPaintSurfaceCacheEvictions: _localPaintSurfaceCacheEvictions,
    localPaintSurfaceCacheResidentBytes: _localPaintSurfaceCacheResidentBytes,
    ...semanticCounters
  } = receipt.counters;
  const semanticExecution = Object.freeze({ ...receipt, counters: Object.freeze(semanticCounters) });
  return Object.freeze({
    ...receipt,
    executionIdentity: hash(semanticExecution),
    observationIdentity: hash(receipt),
  });
}

function fail(node: IRNode, code: ReferenceLocalSpaceErrorCode, detail: string): never {
  throw new ReferenceLocalSpaceError(code, node, detail);
}

function exactLength(node: IRNode, value: IRValue | undefined, label: string) {
  if (value?.kind !== "quantity" || value.dimension !== "length" || value.unit !== "px") {
    fail(node, "CUT_LOCAL_SPACE_TYPE", `${label} must be an exact pixel Length.`);
  }
  const number = rationalToNumber(value.magnitude);
  if (!Number.isFinite(number)) fail(node, "CUT_LOCAL_SPACE_BOUNDS", `${label} must be finite.`);
  return value.magnitude;
}

function wholeDimension(node: IRNode, value: IRValue | undefined, label: string) {
  const exact = exactLength(node, value, label), number = rationalToNumber(exact);
  if (exact.denominator !== "1" || !Number.isSafeInteger(number) || number < 1 || number > referenceLocalSpaceLimits.maximumAxisPx) {
    fail(node, "CUT_LOCAL_SPACE_BOUNDS", `${label} must be a positive whole-pixel Length no larger than ${referenceLocalSpaceLimits.maximumAxisPx}px.`);
  }
  return number;
}

/** Quantize a nonnegative exact pixel coordinate to one Q16 phase with exact
 * BigInt round-half-up arithmetic. No floating conversion participates. */
export function referenceLocalSpaceOriginQ16(value: Rational) {
  const numerator = BigInt(value.numerator), denominator = BigInt(value.denominator);
  if (numerator < 0n || denominator <= 0n) throw new Error("CUT LocalSpace Q16 origin requires a nonnegative canonical Rational.");
  const units = BigInt(referenceRetainedSurfacePhaseUnits);
  return (2n * numerator * units + denominator) / (2n * denominator);
}

export function referenceLocalSpaceRasterOrigin(config: Pick<ReferenceLocalSpaceConfig, "rasterOriginQ16">) {
  const units = referenceRetainedSurfacePhaseUnits;
  return Object.freeze({
    x: Number(BigInt(config.rasterOriginQ16.x)) / units,
    y: Number(BigInt(config.rasterOriginQ16.y)) / units,
  });
}

/** Canonical local Text/FlowText layout context. Defaults and explicit
 * coordinates are authored in the LocalSpace view; the same Q16 origin used
 * for placement is the sole raster translation. */
export function referenceLocalSpaceTextLayoutContext(
  config: Pick<ReferenceLocalSpaceConfig, "width" | "height" | "rasterOriginQ16">,
): ReferenceTextLayoutContext {
  const origin = referenceLocalSpaceRasterOrigin(config);
  return Object.freeze({ kind: "local-space", width: config.width, height: config.height, originX: origin.x, originY: origin.y });
}

function origin(node: IRNode, width: number, height: number) {
  const value = node.inputs.origin;
  if (value?.kind !== "object") fail(node, "CUT_LOCAL_SPACE_TYPE", "input “origin” must be a Vec2 object containing exactly x and y.");
  const keys = Object.keys(value.entries);
  if (keys.length !== 2 || !keys.includes("x") || !keys.includes("y")) {
    fail(node, "CUT_LOCAL_SPACE_TYPE", "input “origin” must contain exactly x and y; additional fields are unsupported.");
  }
  const x = exactLength(node, value.entries.x, "input “origin.x”"), y = exactLength(node, value.entries.y, "input “origin.y”");
  if (compareRational(x, zeroRational) < 0 || compareRational(x, rational(width)) > 0) fail(node, "CUT_LOCAL_SPACE_BOUNDS", `input “origin.x” must be inside the closed 0px through ${width}px range.`);
  if (compareRational(y, zeroRational) < 0 || compareRational(y, rational(height)) > 0) fail(node, "CUT_LOCAL_SPACE_BOUNDS", `input “origin.y” must be inside the closed 0px through ${height}px range.`);
  return Object.freeze({ x, y });
}

export function referenceLocalSpaceStaticConfig(node: IRNode) {
  if (node.op !== "cut.visual.local_space") return undefined;
  if (node.domain !== "visual") fail(node, "CUT_LOCAL_SPACE_GRAPH", `must have visual domain, found ${node.domain}.`);
  if (node.properties && Object.keys(node.properties).length) {
    fail(node, "CUT_LOCAL_SPACE_TYPE", `does not accept properties; found ${Object.keys(node.properties).join(", ")}.`);
  }
  const allowed = new Set(["width", "height", "origin"]), unknown = Object.keys(node.inputs).find((name) => !allowed.has(name));
  if (unknown) fail(node, "CUT_LOCAL_SPACE_TYPE", `input “${unknown}” is not part of the closed public contract.`);
  const width = wholeDimension(node, node.inputs.width, "input “width”"), height = wholeDimension(node, node.inputs.height, "input “height”");
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > referenceLocalSpaceLimits.maximumSurfacePixels || pixels * 4 > referenceLocalSpaceLimits.maximumSurfaceRgbaBytes) {
    fail(node, "CUT_LOCAL_SPACE_LIMIT", `declared ${width}x${height} tile exceeds the bounded pixel or straight-RGBA byte envelope.`);
  }
  if (node.children.length < 1 || node.children.length > referenceLocalSpaceLimits.maximumDirectChildren) {
    fail(node, "CUT_LOCAL_SPACE_GRAPH", `requires 1 through ${referenceLocalSpaceLimits.maximumDirectChildren} direct visual children; found ${node.children.length}.`);
  }
  const point = origin(node, width, height);
  const rasterOriginQ16 = Object.freeze({
    x: String(referenceLocalSpaceOriginQ16(point.x)),
    y: String(referenceLocalSpaceOriginQ16(point.y)),
  });
  return Object.freeze({
    width,
    height,
    origin: point,
    rasterOriginQ16,
    view: Object.freeze({
      minX: subtractRational(zeroRational, point.x),
      minY: subtractRational(zeroRational, point.y),
      maxX: subtractRational(rational(width), point.x),
      maxY: subtractRational(rational(height), point.y),
    }),
  });
}

const supportedOwners = new Set([
  "cut.kernel.fragment",
  "cut.visual.group",
  "cut.visual.motion_path",
  "cut.visual.camera2d",
  "cut.visual.local_space",
  "cut.geo.annotation",
  "cut.visual.callout",
  "cut.visual.track_2d",
  "cut.visual.planar_track",
  "cut.visual.depth_layer",
  "cut.visual.plane3d",
]);
const supportedDescendants = new Set([
  "cut.kernel.fragment",
  "cut.visual.group",
  "cut.visual.motion_path",
  "cut.visual.local_space",
  "cut.visual.rect",
  "cut.visual.circle",
  "cut.visual.path",
  "cut.visual.trace",
  "cut.visual.text",
  "cut.visual.flow_text",
  "cut.visual.image",
  "cut.visual.video",
  "cut.visual.color_grade",
  "cut.visual.composite",
  "cut.visual.mask",
  "cut.visual.clip_path",
  "cut.visual.blur",
  "cut.visual.vignette",
  "cut.visual.sharpen",
  "cut.visual.grain",
  "cut.visual.duotone",
]);

function intervalContains(parent: IRNode, child: IRNode) {
  return compareRational(child.interval.start, parent.interval.start) >= 0
    && compareRational(addRational(child.interval.start, child.interval.duration), addRational(parent.interval.start, parent.interval.duration)) <= 0;
}

/** Close LocalSpace context ownership before assets are opened or pixels are allocated. */
export function validateReferenceLocalSpaceGraph(
  ir: CutAVIR,
  _composition: IRComposition,
  selectedNodeIds?: ReadonlySet<string>,
  options?: ReferenceLocalSpaceValidationOptions,
) {
  const retainedMediaPlanning = options?.retainedMediaPlanning ?? "locked";
  const selected = (id: string) => selectedNodeIds === undefined || selectedNodeIds.has(id);
  // Structural ownership is a property of the complete IR graph. Building
  // this snapshot after selection would let an off-scope second parent
  // disappear from an otherwise selected LocalSpace validation path.
  const structuralIndex = options?.structuralIndex ?? createReferenceLocalSpaceStructuralValidationIndex(ir);
  const componentFragmentAdmissionIndex = structuralIndex.componentFragmentAdmissionIndex;
  // Selected composition callers already paid for reachability. Iterate those
  // ids directly instead of rescanning a possible 100k-node document for every
  // composition.
  const localNodes = (selectedNodeIds === undefined
    ? Object.values(ir.nodes)
    : [...selectedNodeIds].map((id) => ir.nodes[id]).filter((node): node is IRNode => node !== undefined))
    .filter((node) => selected(node.id) && node.op === "cut.visual.local_space");
  const staticConfigs = new Map(localNodes.map((node) => [node.id, referenceLocalSpaceStaticConfig(node)!]));
  const aggregatePixelsByExecutionDomain = new Map<string, number>();
  const localSpacesByExecutionDomain = new Map<string, number>();
  for (const [nodeId, config] of staticConfigs) {
    const localNode = ir.nodes[nodeId]!;
    const executionDomain = localNode.sceneId ? `scene:${localNode.sceneId}` : `composition-root:${_composition.id}`;
    const localSpaces = (localSpacesByExecutionDomain.get(executionDomain) ?? 0) + 1;
    localSpacesByExecutionDomain.set(executionDomain, localSpaces);
    if (localSpaces > referenceLocalSpaceLimits.maximumLocalSpacesPerExecutionDomain) {
      fail(localNode, "CUT_LOCAL_SPACE_LIMIT", `${executionDomain} LocalSpace count ${localSpaces} exceeds ${referenceLocalSpaceLimits.maximumLocalSpacesPerExecutionDomain}; this is the closed per-frame evidence bound.`);
    }
    const aggregatePixels = (aggregatePixelsByExecutionDomain.get(executionDomain) ?? 0) + config.width * config.height;
    aggregatePixelsByExecutionDomain.set(executionDomain, aggregatePixels);
    if (!Number.isSafeInteger(aggregatePixels) || aggregatePixels > referenceLocalSpaceLimits.maximumLiveLocalSurfacePixelsPerFrame) {
      fail(localNode, "CUT_LOCAL_SPACE_LIMIT", `${executionDomain} aggregate declared local tiles exceed ${referenceLocalSpaceLimits.maximumLiveLocalSurfacePixelsPerFrame} simultaneously live pixels.`);
    }
  }

  const result = new Map<string, ReferenceLocalSpaceConfig>();
  const aggregatePixelPassesByExecutionDomain = new Map<string, number>();
  const aggregateTracePointsByExecutionDomain = new Map<string, number>();
  const aggregateLocalCompositingOperationsByExecutionDomain = new Map<string, number>();
  const aggregateLocalCompositingWorkByExecutionDomain = new Map<string, number>();
  const aggregateRetainedByExecutionDomain = new Map<string, {
    branches: number;
    nativePixels: number;
    croppedPixels: number;
    fittedPixels: number;
    viewportRgbaBytes: number;
    maximumPixelWorkPerFrame: number;
  }>();
  for (const node of localNodes) {
    const config = staticConfigs.get(node.id)!;
    const executionDomain = node.sceneId ? `scene:${node.sceneId}` : `composition-root:${_composition.id}`;
    const localComposition = { ..._composition, width: config.width, height: config.height };
    const textLayoutContext = referenceLocalSpaceTextLayoutContext(config);
    const directParents = structuralIndex.parentNodesForChild(node.id);
    if (directParents.length > 1) fail(node, "CUT_LOCAL_SPACE_GRAPH", `must have at most one structural parent; found ${directParents.map((parent) => parent.id).join(", ")}.`);
    const directParent = directParents[0];
    const roots = structuralIndex.rootMembershipCount(node.id);
    if (!directParent && node.ownership !== "root") {
      fail(node, "CUT_LOCAL_SPACE_GRAPH", "a parentless LocalSpace must be a scene/composition root; detached and reference-only coordinate contexts are forbidden.");
    }
    if (!directParent && roots !== 1) {
      fail(node, "CUT_LOCAL_SPACE_GRAPH", `a parentless root LocalSpace must appear in exactly one scene/composition item owner; found ${roots}.`);
    }
    if (directParent && node.ownership !== "child") {
      fail(node, "CUT_LOCAL_SPACE_GRAPH", "a structurally owned LocalSpace must have child ownership.");
    }
    if (directParent && roots !== 0) {
      fail(node, "CUT_LOCAL_SPACE_GRAPH", `a structurally owned LocalSpace cannot also appear as a scene/composition root; found ${roots} root memberships.`);
    }
    if (directParent && !intervalContains(directParent, node)) {
      fail(node, "CUT_LOCAL_SPACE_GRAPH", `interval escapes its direct owner ${directParent.id} interval.`);
    }
    if (directParent && !supportedOwners.has(directParent.op)) {
      fail(node, "CUT_LOCAL_SPACE_UNSUPPORTED", `owner ${directParent.op} has no local positioned-surface vertical slice in ${referenceLocalSpaceAlgorithmVersion}.`);
    }
    if (directParent?.op === "cut.kernel.fragment") {
      const admission = referenceComponentFragmentLocalSpaceAdmissionIssue(componentFragmentAdmissionIndex, directParent, node, _composition);
      if (admission) fail(admission.subject === "owner" ? directParent : node, admission.runtimeCode, admission.detail);
    }
    if (directParent?.op === "cut.visual.group" && directParent.children.length !== 1) {
      fail(node, "CUT_LOCAL_SPACE_UNSUPPORTED", "a Group owning LocalSpace must be an exact unary placement chain in the first checkpoint; multi-child parent composition remains unsupported.");
    }
    if (directParent?.op === "cut.visual.motion_path" && directParent.children.length !== 1) {
      fail(node, "CUT_LOCAL_SPACE_UNSUPPORTED", "a MotionPath owning LocalSpace must be an exact unary placement chain; additional children would escape retained-tile execution.");
    }
    if (directParent?.op === "cut.visual.camera2d" && directParent.children.length !== 1) {
      fail(node, "CUT_LOCAL_SPACE_GRAPH", "a Camera2D using retained local composition must own exactly one direct LocalSpace and no delivery-canvas siblings.");
    }
    if (directParent?.op === "cut.geo.annotation" && directParent.children.length !== 1) {
      fail(node, "CUT_LOCAL_SPACE_GRAPH", "a GeoAnnotation owning LocalSpace must own that exact tile directly and exclusively.");
    }
    if (directParent?.op === "cut.visual.callout" && directParent.children.length !== 1) {
      fail(node, "CUT_LOCAL_SPACE_GRAPH", "a Callout owning LocalSpace must own that exact tile directly and exclusively.");
    }
    if (directParent?.op === "cut.visual.callout"
      && (compareRational(directParent.interval.start, node.interval.start) !== 0
        || compareRational(directParent.interval.duration, node.interval.duration) !== 0)) {
      fail(node, "CUT_LOCAL_SPACE_GRAPH", "a Callout LocalSpace must share its owner's exact start and duration.");
    }
    if (directParent?.op === "cut.visual.track_2d" && directParent.children.length !== 1) {
      fail(node, "CUT_LOCAL_SPACE_GRAPH", "a Track2D owning LocalSpace must own that exact tile directly and exclusively.");
    }
    if (directParent?.op === "cut.visual.planar_track" && directParent.children.length !== 1) {
      fail(node, "CUT_LOCAL_SPACE_GRAPH", "a PlanarTrack owning LocalSpace must own that exact tile directly and exclusively.");
    }
    if (directParent?.op === "cut.visual.planar_track"
      && (compareRational(directParent.interval.start, node.interval.start) !== 0
        || compareRational(directParent.interval.duration, node.interval.duration) !== 0)) {
      fail(node, "CUT_LOCAL_SPACE_GRAPH", "a PlanarTrack LocalSpace must share its owner's exact start and duration; shortened or offset projective tiles are forbidden.");
    }
    if (directParent?.op === "cut.visual.planar_track") {
      // Contextual admission is intentionally repeated at the runtime graph
      // boundary. A caller that bypasses source checking or strict JSON
      // loading still cannot execute multiple/non-alpha plane-local mattes.
      referencePlanarTrackMatteConfig(ir, directParent);
    }
    if (directParent?.op === "cut.visual.depth_layer" && directParent.children.length !== 1) {
      fail(node, "CUT_LOCAL_SPACE_GRAPH", "a DepthLayer using a local coordinate basis must own exactly one direct LocalSpace and no delivery-canvas siblings.");
    }
    if (directParent?.op === "cut.visual.plane3d" && directParent.children.length !== 1) {
      fail(node, "CUT_LOCAL_SPACE_GRAPH", "a Plane3D must own exactly one direct LocalSpace retained tile and no delivery-canvas siblings.");
    }
    if (directParent?.op === "cut.visual.plane3d"
      && (compareRational(directParent.interval.start, node.interval.start) !== 0
        || compareRational(directParent.interval.duration, node.interval.duration) !== 0)) {
      fail(node, "CUT_LOCAL_SPACE_GRAPH", "a Plane3D LocalSpace must share its owner's exact start and duration.");
    }
    let nestingDepth = 1, ancestor = directParent;
    const seenAncestors = new Set<string>();
    while (ancestor) {
      if (seenAncestors.has(ancestor.id)) fail(node, "CUT_LOCAL_SPACE_GRAPH", `ancestor graph cycles through ${ancestor.id}.`);
      seenAncestors.add(ancestor.id);
      if (!supportedOwners.has(ancestor.op)) {
        fail(node, "CUT_LOCAL_SPACE_UNSUPPORTED", `ancestor ${ancestor.op} has no local positioned-surface vertical slice in ${referenceLocalSpaceAlgorithmVersion}.`);
      }
      if (ancestor.op === "cut.visual.local_space") nestingDepth += 1;
      // These owners are intentional retained-surface consumption boundaries.
      // Their ancestors position the completed owner result, not the
      // LocalSpace tile itself. The renderer half of the Track2D/DepthLayer
      // handoff is deliberately separate from this closed planning contract.
      if (ancestor.op === "cut.geo.annotation"
        || ancestor.op === "cut.visual.callout"
        || ancestor.op === "cut.visual.camera2d"
        || ancestor.op === "cut.visual.track_2d"
        || ancestor.op === "cut.visual.planar_track"
        || ancestor.op === "cut.visual.depth_layer"
        || ancestor.op === "cut.visual.plane3d") break;
      const candidates = structuralIndex.parentNodesForChild(ancestor.id);
      if (candidates.length > 1) fail(node, "CUT_LOCAL_SPACE_GRAPH", `ancestor ${ancestor.id} has ambiguous multiple structural parents.`);
      if ((ancestor.op === "cut.visual.group" || ancestor.op === "cut.visual.motion_path")
        && candidates[0] && candidates[0].op !== "cut.visual.local_space") {
        fail(
          node,
          "CUT_LOCAL_SPACE_UNSUPPORTED",
          `owner chain ${candidates[0].op} -> ${ancestor.op} -> LocalSpace would materialize and pre-clip a delivery-sized intermediate; checkpoint 1 permits only a direct root owner or an owner directly inside another LocalSpace.`,
        );
      }
      ancestor = candidates[0];
    }
    if (nestingDepth > referenceLocalSpaceLimits.maximumNestedLocalSpaces) {
      fail(node, "CUT_LOCAL_SPACE_LIMIT", `nesting depth ${nestingDepth} exceeds ${referenceLocalSpaceLimits.maximumNestedLocalSpaces}.`);
    }

    const visiting = new Set<string>();
    const tilePixels = config.width * config.height;
    const retainedMediaStaticTopology = retainedMediaPlanning === "topology-only"
      ? referenceRetainedMediaStaticLocalTopology(ir, node)
      : undefined;
    const plannedRetainedMediaComposition = retainedMediaPlanning === "locked"
      ? referenceRetainedMediaCompositionPlan(ir, node, { width: config.width, height: config.height })
      : undefined;
    const retainedMediaDiscovery = retainedMediaPlanning === "locked"
      ? discoverReferenceRetainedMediaLocalCompositor(
        ir,
        node,
        { width: config.width, height: config.height },
        plannedRetainedMediaComposition,
      )
      : undefined;
    const retainedMediaPlans = plannedRetainedMediaComposition?.branches ?? Object.freeze([]);
    const retainedMediaViewport = retainedMediaPlans.length === 1 ? retainedMediaPlans[0] : undefined;
    // Preserve the historical singular configuration/identity for an exact
    // one-child branch. Mixed or multi-branch graphs receive an additive v2
    // composition identity without changing the v1 branch receipt.
    const retainedMediaComposition = plannedRetainedMediaComposition
      && (node.children.length > 1 || retainedMediaPlans.length > 1)
      ? plannedRetainedMediaComposition
      : undefined;
    const retainedMediaNodeIds = new Set([
      ...retainedMediaPlans.flatMap((plan) => [...plan.nodeIds]),
      ...(retainedMediaDiscovery ? [...retainedMediaDiscovery.materializationNodeIds] : []),
      ...(retainedMediaStaticTopology ? [...retainedMediaStaticTopology.materializationNodeIds] : []),
    ]);
    const localCompositing = planReferenceLocalCompositing(
      ir,
      node,
      { width: config.width, height: config.height },
      retainedMediaNodeIds,
    );
    const retainedMediaLocalCompositor = retainedMediaDiscovery
      ? finalizeReferenceRetainedMediaLocalCompositorPlan(retainedMediaDiscovery, localCompositing.operations, node)
      : undefined;
    const directRetainedTotals = plannedRetainedMediaComposition?.totals;
    const staticRetainedBranches = retainedMediaStaticTopology?.materializationRootIds.length ?? 0;
    if (directRetainedTotals || retainedMediaLocalCompositor || staticRetainedBranches) {
      const aggregateRetained = aggregateRetainedByExecutionDomain.get(executionDomain) ?? {
        branches: 0,
        nativePixels: 0,
        croppedPixels: 0,
        fittedPixels: 0,
        viewportRgbaBytes: 0,
        maximumPixelWorkPerFrame: 0,
      };
      aggregateRetained.branches += (directRetainedTotals?.branches ?? 0)
        + (retainedMediaLocalCompositor?.totals.mediaLeaves ?? 0)
        + staticRetainedBranches;
      aggregateRetained.nativePixels += (directRetainedTotals?.nativePixels ?? 0)
        + (retainedMediaLocalCompositor?.totals.nativePixels ?? 0);
      aggregateRetained.croppedPixels += (directRetainedTotals?.croppedPixels ?? 0)
        + (retainedMediaLocalCompositor?.totals.croppedPixels ?? 0);
      aggregateRetained.fittedPixels += (directRetainedTotals?.fittedPixels ?? 0)
        + (retainedMediaLocalCompositor?.totals.fittedPixels ?? 0);
      aggregateRetained.viewportRgbaBytes += (directRetainedTotals?.viewportRgbaBytes ?? 0)
        + (retainedMediaLocalCompositor?.totals.mediaViewportRgbaBytes ?? 0);
      aggregateRetained.maximumPixelWorkPerFrame += (directRetainedTotals?.maximumPixelWorkPerFrame ?? 0)
        + (retainedMediaLocalCompositor?.totals.maximumPixelWorkPerFrame ?? 0);
      aggregateRetainedByExecutionDomain.set(executionDomain, aggregateRetained);
      const aggregateLimits = [
        ["retained branches", aggregateRetained.branches, referenceRetainedMediaViewportLimits.maximumBranchesPerExecutionDomain],
        ["native pixels", aggregateRetained.nativePixels, referenceRetainedMediaViewportLimits.maximumAggregateNativePixels],
        ["decoded crop pixels", aggregateRetained.croppedPixels, referenceRetainedMediaViewportLimits.maximumAggregateCroppedPixels],
        ["fitted pixels", aggregateRetained.fittedPixels, referenceRetainedMediaViewportLimits.maximumAggregateFitPixels],
        ["viewport RGBA bytes", aggregateRetained.viewportRgbaBytes, referenceRetainedMediaViewportLimits.maximumAggregateViewportRgbaBytes],
        ["pixel-passes per frame", aggregateRetained.maximumPixelWorkPerFrame, referenceRetainedMediaViewportLimits.maximumAggregatePixelWorkPerFrame],
      ] as const;
      if (Object.values(aggregateRetained).some((value) => !Number.isSafeInteger(value) || value < 0)) {
        fail(node, "CUT_LOCAL_SPACE_LIMIT", "composition-wide retained-media accounting exceeds the safe integer range.");
      }
      const violation = aggregateLimits.find(([, actual, maximum]) => actual > maximum);
      if (violation) {
        fail(node, "CUT_LOCAL_SPACE_LIMIT", `${executionDomain} retained-media ${violation[0]} ${violation[1]} exceeds ${violation[2]} across concurrently renderable LocalSpace roots.`);
      }
    }
    const aggregateLocalCompositingOperations = (aggregateLocalCompositingOperationsByExecutionDomain.get(executionDomain) ?? 0)
      + localCompositing.operations.length;
    aggregateLocalCompositingOperationsByExecutionDomain.set(executionDomain, aggregateLocalCompositingOperations);
    if (!Number.isSafeInteger(aggregateLocalCompositingOperations)
      || aggregateLocalCompositingOperations > referenceLocalCompositingLimits.maximumOperationsPerExecutionDomain) {
      fail(node, "CUT_LOCAL_SPACE_LIMIT", `${executionDomain} local compositing operation count ${aggregateLocalCompositingOperations} exceeds ${referenceLocalCompositingLimits.maximumOperationsPerExecutionDomain}.`);
    }
    const aggregateLocalCompositingWork = (aggregateLocalCompositingWorkByExecutionDomain.get(executionDomain) ?? 0)
      + localCompositing.estimatedPixelWorkPerFrame;
    aggregateLocalCompositingWorkByExecutionDomain.set(executionDomain, aggregateLocalCompositingWork);
    if (!Number.isSafeInteger(aggregateLocalCompositingWork)
      || aggregateLocalCompositingWork > referenceLocalCompositingLimits.maximumOperatorPixelWorkPerExecutionDomain) {
      fail(node, "CUT_LOCAL_SPACE_LIMIT", `${executionDomain} local compositing operator work ${Number.isSafeInteger(aggregateLocalCompositingWork) ? aggregateLocalCompositingWork : "non-safe"} exceeds ${referenceLocalCompositingLimits.maximumOperatorPixelWorkPerExecutionDomain}.`);
    }
    // One transparent tile allocation plus a conservative raster/transform/
    // composite charge for every ordinary descendant. A nested LocalSpace's
    // own work is charged by its independent configuration; its parent pays
    // only registered placement and source-over into the surrounding tile.
    let estimatedPixelPassesPerFrame = tilePixels;
    let preparedTracePointsPerFrame = 0;
    const localMotionPathNodeIds: string[] = [];
    const visit = (childId: string) => {
      const child = ir.nodes[childId];
      if (!child || !selected(child.id)) fail(node, "CUT_LOCAL_SPACE_GRAPH", `references missing or unreachable child ${childId}.`);
      if (visiting.has(child.id)) fail(node, "CUT_LOCAL_SPACE_GRAPH", `child graph cycles through ${child.id}.`);
      if (child.domain !== "visual") fail(node, "CUT_LOCAL_SPACE_GRAPH", `child ${child.id} has ${child.domain} domain; visual is required.`);
      if (!intervalContains(node, child)) fail(node, "CUT_LOCAL_SPACE_GRAPH", `child ${child.id} interval escapes its LocalSpace interval.`);
      const owners = structuralIndex.parentNodesForChild(child.id);
      if (owners.length !== 1) fail(node, "CUT_LOCAL_SPACE_GRAPH", `child ${child.id} must belong to exactly one structural coordinate context; found ${owners.length}.`);
      if (!supportedDescendants.has(child.op)) {
        fail(child, "CUT_LOCAL_SPACE_UNSUPPORTED", `${child.op} has no local-coordinate raster slice in ${referenceLocalSpaceAlgorithmVersion}; delivery-canvas fallback is forbidden.`);
      }
      if ((child.op === "cut.visual.image" || child.op === "cut.visual.video")
        && !retainedMediaNodeIds.has(child.id)) {
        fail(child, "CUT_LOCAL_SPACE_UNSUPPORTED", `${child.op} is executable inside LocalSpace only as part of its exact bounded retained-media viewport branch.`);
      }
      if (child.op === "cut.visual.motion_path"
        && isReferenceAnchoredPathGeometryValue(child.inputs.geometry)) {
        fail(
          child,
          "CUT_LOCAL_SPACE_UNSUPPORTED",
          "AnchoredPathGeometry cannot execute as a LocalSpace MotionPath descendant because its owner-resolved composition coordinates do not define a local-coordinate basis; use ordinary points or VectorPathGeometry.",
        );
      }
      if (child.op === "cut.visual.motion_path") localMotionPathNodeIds.push(child.id);
      // Close Text/FlowText inputs, locked-resource references, local defaults,
      // shaping boundary, and exact-fps motion schedule before any font bytes
      // are opened or a local/delivery surface can be allocated.
      if (child.op === "cut.visual.text") referenceTextConfig(child, ir, localComposition, textLayoutContext);
      if (child.op === "cut.visual.flow_text") referenceFlowTextConfig(child, ir, localComposition, textLayoutContext);
      if (child.op === "cut.visual.trace") {
        const trace = prepareReferenceTraceNode(child);
        if (!trace) fail(child, "CUT_LOCAL_SPACE_UNSUPPORTED", "Trace did not produce its public prepared geometry during local-coordinate admission.");
        preparedTracePointsPerFrame += trace.trace.points.length;
        if (!Number.isSafeInteger(preparedTracePointsPerFrame)) fail(child, "CUT_LOCAL_SPACE_LIMIT", "prepared Trace point accounting exceeds the safe integer range.");
      }
      if (child.op === "cut.visual.local_space") {
        estimatedPixelPassesPerFrame += tilePixels * 2;
        return;
      }
      estimatedPixelPassesPerFrame += retainedMediaNodeIds.has(child.id) ? 0 : tilePixels * 3;
      if (!Number.isSafeInteger(estimatedPixelPassesPerFrame)) fail(node, "CUT_LOCAL_SPACE_LIMIT", "pixel-pass accounting exceeds the safe integer range.");
      visiting.add(child.id); child.children.forEach(visit); visiting.delete(child.id);
    };
    node.children.forEach(visit);
    const aggregateTracePoints = (aggregateTracePointsByExecutionDomain.get(executionDomain) ?? 0) + preparedTracePointsPerFrame;
    aggregateTracePointsByExecutionDomain.set(executionDomain, aggregateTracePoints);
    if (!Number.isSafeInteger(aggregateTracePoints)
      || aggregateTracePoints > referenceLocalSpaceLimits.maximumPreparedTracePointsPerExecutionDomain) {
      fail(
        node,
        "CUT_LOCAL_SPACE_LIMIT",
        `${executionDomain} prepared LocalSpace Trace geometry costs ${aggregateTracePoints} points per frame; the execution-domain limit is ${referenceLocalSpaceLimits.maximumPreparedTracePointsPerExecutionDomain}.`,
      );
    }
    if (plannedRetainedMediaComposition) {
      estimatedPixelPassesPerFrame += plannedRetainedMediaComposition.totals.maximumPixelWorkPerFrame;
    }
    if (retainedMediaLocalCompositor) {
      // The outer wrappers are already charged by the generic descendant and
      // LocalSpace compositor plans above. Add only the exact retained island
      // decode/crop/fit/viewport work here to avoid counting those operators a
      // second time while keeping all media work closed before source open.
      estimatedPixelPassesPerFrame += retainedMediaLocalCompositor.islands
        .reduce((sum, island) => sum + island.plan.maximumPixelWorkPerFrame, 0);
    }
    estimatedPixelPassesPerFrame += localCompositing.estimatedPixelWorkPerFrame;
    const aggregatePixelPasses = (aggregatePixelPassesByExecutionDomain.get(executionDomain) ?? 0) + estimatedPixelPassesPerFrame;
    aggregatePixelPassesByExecutionDomain.set(executionDomain, aggregatePixelPasses);
    if (!Number.isSafeInteger(aggregatePixelPasses) || aggregatePixelPasses > referenceLocalSpaceLimits.maximumPixelPassesPerFrame) {
      fail(node, "CUT_LOCAL_SPACE_LIMIT", `${executionDomain} preflight local raster work exceeds ${referenceLocalSpaceLimits.maximumPixelPassesPerFrame} pixel-passes per frame.`);
    }
    const localMotionPath = localMotionPathNodeIds.length
      ? Object.freeze({
          algorithmVersion: referenceLocalMotionPathAlgorithmVersion,
          nodeIds: Object.freeze([...localMotionPathNodeIds].sort()),
          coordinateBasis: "authored-local-pixel-edges" as const,
          authoredSampleContract: "path-head-before-centre-relative-raster-placement" as const,
        })
      : undefined;

    const owner = !directParent ? "scene-root"
      : directParent.op === "cut.kernel.fragment" ? "component-fragment"
        : directParent.op === "cut.visual.group" ? "group"
        : directParent.op === "cut.visual.motion_path" ? "motion-path"
          : directParent.op === "cut.visual.camera2d" ? "camera-2d"
            : directParent.op === "cut.geo.annotation" ? "geo-annotation"
              : directParent.op === "cut.visual.callout" ? "callout"
                : directParent.op === "cut.visual.track_2d" ? "track-2d"
                : directParent.op === "cut.visual.planar_track" ? "planar-track"
                  : directParent.op === "cut.visual.depth_layer" ? "depth-layer"
                    : directParent.op === "cut.visual.plane3d" ? "plane-3d"
                  : "local-space";
    result.set(node.id, Object.freeze({
      nodeId: node.id,
      ...config,
      childIds: Object.freeze([...node.children]),
      nestingDepth,
      estimatedPixelPassesPerFrame,
      preparedTracePointsPerFrame,
      owner,
      ...(directParent ? { ownerNodeId: directParent.id } : {}),
      semanticIdentity: hash({
        algorithm: referenceLocalSpaceAlgorithmVersion,
        nodeContentHash: node.contentHash,
        width: config.width,
        height: config.height,
        origin: config.origin,
        rasterOriginQ16: config.rasterOriginQ16,
        view: config.view,
        retainedMediaViewport: retainedMediaViewport?.semanticIdentity,
        ...(retainedMediaComposition ? { retainedMediaComposition: retainedMediaComposition.semanticIdentity } : {}),
        ...(retainedMediaLocalCompositor ? { retainedMediaLocalCompositor: retainedMediaLocalCompositor.semanticIdentity } : {}),
        ...(retainedMediaStaticTopology ? { retainedMediaStaticTopology: retainedMediaStaticTopology.semanticIdentity } : {}),
        ...(localCompositing.operations.length ? { localCompositing: localCompositing.semanticIdentity } : {}),
        ...(localMotionPath ? { localMotionPath } : {}),
      }),
      localCompositing,
      ...(retainedMediaViewport ? { retainedMediaViewport } : {}),
      ...(retainedMediaComposition ? { retainedMediaComposition } : {}),
      ...(retainedMediaLocalCompositor ? { retainedMediaLocalCompositor } : {}),
      ...(localMotionPath ? { localMotionPath } : {}),
    }));
  }
  return result;
}

/** Return the innermost validated LocalSpace that owns each ordinary
 * descendant. A nested LocalSpace is a materialization boundary and its own
 * descendants are deliberately not attributed to the parent context. */
export function referenceLocalSpaceDescendantContexts(
  ir: CutAVIR,
  configs: ReadonlyMap<string, ReferenceLocalSpaceConfig>,
) {
  const result = new Map<string, ReferenceLocalSpaceConfig>();
  for (const config of [...configs.values()].sort((left, right) => left.nodeId.localeCompare(right.nodeId))) {
    const visit = (nodeId: string) => {
      const node = ir.nodes[nodeId];
      if (!node || node.op === "cut.visual.local_space") return;
      const existing = result.get(nodeId);
      if (existing && existing.nodeId !== config.nodeId) {
        throw new ReferenceLocalSpaceError("CUT_LOCAL_SPACE_GRAPH", node, `belongs to multiple validated LocalSpace contexts ${existing.nodeId} and ${config.nodeId}.`);
      }
      result.set(nodeId, config);
      node.children.forEach(visit);
    };
    config.childIds.forEach(visit);
  }
  return result;
}

export function referenceLocalSpaceTileIdentity(config: ReferenceLocalSpaceConfig, exactTime: Rational, backendIdentity: string) {
  return hash({
    kind: "local-space-tile",
    algorithm: referenceLocalSpaceAlgorithmVersion,
    semanticIdentity: config.semanticIdentity,
    ...(config.retainedMediaViewport ? { retainedMediaViewport: referenceRetainedMediaViewportInspect(config.retainedMediaViewport) } : {}),
    ...(config.retainedMediaComposition ? { retainedMediaComposition: referenceRetainedMediaCompositionInspect(config.retainedMediaComposition) } : {}),
    ...(config.retainedMediaLocalCompositor ? { retainedMediaLocalCompositor: referenceRetainedMediaLocalCompositorInspect(config.retainedMediaLocalCompositor) } : {}),
    ...(config.localMotionPath ? { localMotionPath: {
      algorithmVersion: config.localMotionPath.algorithmVersion,
      nodeIds: [...config.localMotionPath.nodeIds],
      coordinateBasis: config.localMotionPath.coordinateBasis,
      authoredSampleContract: config.localMotionPath.authoredSampleContract,
      originTranslation: "exact-q16-derived-raster-origin" as const,
      clipping: "declared-half-open-local-tile" as const,
      composition: "source-over" as const,
      deliveryCanvasFallback: "forbidden" as const,
    } } : {}),
    ...(config.localCompositing.operations.length ? { localCompositing: referenceLocalCompositingInspect(config.localCompositing) } : {}),
    exactTime: `${exactTime.numerator}/${exactTime.denominator}`,
    backendIdentity,
    alpha: "straight-rgba8",
    clip: [0, 0, config.width, config.height],
  });
}

export function referenceLocalSpacePlacementIdentity(
  config: ReferenceLocalSpaceConfig,
  tileIdentity: string,
  placement: ReferenceLocalSpacePlacement,
  transformWorkIdentity?: string,
) {
  return hash({
    kind: "local-space-placement",
    algorithm: referenceLocalSpaceAlgorithmVersion,
    localSpaceId: config.nodeId,
    tileIdentity,
    placement,
    ...(transformWorkIdentity ? { transformWorkIdentity } : {}),
  });
}

export function referenceLocalSpaceInspect(config: ReferenceLocalSpaceConfig) {
  return Object.freeze({
    status: "checkpoint-3" as const,
    algorithmVersion: referenceLocalSpaceAlgorithmVersion,
    dimensions: { width: config.width, height: config.height },
    origin: { ...config.origin },
    rasterOriginQ16: {
      unitsPerPixel: referenceRetainedSurfacePhaseUnits,
      x: config.rasterOriginQ16.x,
      y: config.rasterOriginQ16.y,
    },
    authoredView: { ...config.view },
    retainedSurface: {
      originX: config.view.minX,
      originY: config.view.minY,
      width: config.width,
      height: config.height,
      alphaMode: "straight" as const,
      clip: "declared-half-open-tile" as const,
    },
    owner: { kind: config.owner, ...(config.ownerNodeId ? { nodeId: config.ownerNodeId } : {}) },
    children: [...config.childIds],
    nestingDepth: config.nestingDepth,
    work: {
      kind: "preflight-estimate" as const,
      estimatedPixelPassesPerFrame: config.estimatedPixelPassesPerFrame,
      preparedTracePointsPerFrame: config.preparedTracePointsPerFrame,
      maximumPreparedTracePointsPerExecutionDomain: referenceLocalSpaceLimits.maximumPreparedTracePointsPerExecutionDomain,
      maximumPixelPassesPerFrame: referenceLocalSpaceLimits.maximumPixelPassesPerFrame,
    },
    semanticIdentity: config.semanticIdentity,
    ...(config.retainedMediaViewport ? { retainedMediaViewport: referenceRetainedMediaViewportInspect(config.retainedMediaViewport) } : {}),
    ...(config.retainedMediaComposition ? { retainedMediaComposition: referenceRetainedMediaCompositionInspect(config.retainedMediaComposition) } : {}),
    ...(config.retainedMediaLocalCompositor ? { retainedMediaLocalCompositor: referenceRetainedMediaLocalCompositorInspect(config.retainedMediaLocalCompositor) } : {}),
    ...(config.localMotionPath ? { localMotionPath: {
      algorithmVersion: config.localMotionPath.algorithmVersion,
      nodeIds: [...config.localMotionPath.nodeIds],
      coordinateBasis: config.localMotionPath.coordinateBasis,
      authoredSampleContract: config.localMotionPath.authoredSampleContract,
      originTranslation: "exact-q16-derived-raster-origin" as const,
      clipping: "declared-half-open-local-tile" as const,
      composition: "source-over" as const,
      deliveryCanvasFallback: "forbidden" as const,
    } } : {}),
    localCompositing: referenceLocalCompositingInspect(config.localCompositing),
    executionSupport: {
      owners: [
        "scene-root",
        "cut.kernel.fragment-direct-scene-root-unary",
        "cut.visual.group-unary",
        "cut.visual.motion_path",
        "cut.visual.camera2d-direct-local-space",
        "cut.visual.local_space",
        "cut.geo.annotation",
        "cut.visual.callout",
        "cut.visual.track_2d",
        "cut.visual.planar_track",
        "cut.visual.depth_layer",
        "cut.visual.plane3d",
      ],
      validatedRendererHandoffs: ["cut.visual.callout", "cut.visual.track_2d", "cut.visual.planar_track", "cut.visual.depth_layer", "cut.visual.plane3d"],
      rendererHandoffStatus: "implemented" as const,
      descendants: [...supportedDescendants].sort(),
      fallback: "CUT_LOCAL_SPACE_UNSUPPORTED",
      scaleTranslationSampling: {
        algorithmVersion: referenceLocalSpaceScaleTranslationAlgorithmVersion,
        sampler: referenceLocalSpaceScaleTranslationSampler,
        fusedWhen: "real-resize-plus-fractional-final-translation-or-legacy-work-ceiling" as const,
        preservedPaths: [
          "neutral-or-no-resize",
          "admitted-integer-phase-placement",
          "rotation",
          "skew",
        ] as const,
      },
    },
    limits: referenceLocalSpaceLimits,
  });
}
