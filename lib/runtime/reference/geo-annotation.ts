import { hash } from "../../core/stable";
import type { CutAVIR, IRComposition, IRNode, IRSignal, IRValue } from "../../language/ir";
import { addRational, compareRational, rational, rationalToNumber, subtractRational, type Rational, zeroRational } from "../../language/rational";
import { referenceGeoMapPoint } from "./geo-projection";
import {
  referenceCalloutCandidateRect,
  referenceCalloutLeader,
  referenceCalloutRectsCollide,
  referenceCalloutSnap,
  type ReferenceCalloutLeader,
  type ReferenceCalloutLeaderKind,
  type ReferenceCalloutPlacement,
  type ReferenceCalloutPoint,
  type ReferenceCalloutRect,
} from "./callout-layout";
import {
  referenceParallaxCameraPlanAt,
  referenceParallaxCameraValidationTimes,
  referenceParallaxNodeSemanticIdentity,
  type ReferenceParallaxCameraConfig,
  type ReferenceParallaxCameraFramePlan,
  type ReferenceParallaxCameraState,
} from "./parallax-camera";
import { transformReferencePoint, type ReferenceAffine2D } from "./retained-visual";
import { propertyAt } from "./signals";
import { referenceVisualTransformAt, referenceWavefrontProjection } from "./visual-config";
import { referenceLocalSpaceStaticConfig, validateReferenceLocalSpaceGraph, type ReferenceLocalSpaceConfig } from "./local-space";

export const referenceGeoAnnotationAlgorithmVersion = "cut-reference-geo-annotation-map-v2" as const;
export const referenceGeoAnnotationMapCameraAlgorithmVersion = "cut-reference-geo-annotation-map-v3" as const;
export type ReferenceGeoAnnotationAlgorithmVersion = typeof referenceGeoAnnotationAlgorithmVersion
  | typeof referenceGeoAnnotationMapCameraAlgorithmVersion;

export const referenceGeoAnnotationLimits = Object.freeze({
  maximumAnnotationsPerCamera: 64,
  maximumAnnotationsPerComposition: 128,
  maximumPlacementsPerAnnotation: 4,
  maximumValidationSamplesPerComposition: 250_000,
  maximumValidationResolutionOperationsPerComposition: 50_000_000,
  maximumAggregateChildCanvasPixelsPerCameraSample: 67_108_864,
  maximumAggregateViewportPixelsPerCameraSample: 16_777_216,
  maximumAggregateOverlayCanvasPixelsPerCameraSample: 268_435_456,
  maximumAggregateOverlayCanvasBytesPerCameraSample: 1_073_741_824,
  maximumCandidateCollisionTestsPerCameraSample: 16_384,
  maximumLeaderSegmentsPerAnnotation: 3,
  maximumAbsolutePriority: 1_000_000,
  maximumAbsoluteDeliveryLengthPx: 65_536,
});

export type ReferenceGeoAnnotationErrorCode =
  | "CUT_GEO_ANNOTATION_TYPE"
  | "CUT_GEO_ANNOTATION_GRAPH"
  | "CUT_GEO_ANNOTATION_PROJECTION"
  | "CUT_GEO_ANNOTATION_STYLE"
  | "CUT_GEO_ANNOTATION_SAFE_AREA"
  | "CUT_GEO_ANNOTATION_VIEWPORT"
  | "CUT_GEO_ANNOTATION_LIMIT"
  | "CUT_GEO_ANNOTATION_NOOP";

export type ReferenceGeoAnnotationSource = Readonly<{
  module: string;
  line: number;
  column: number;
  nodeId: string;
}>;

export class ReferenceGeoAnnotationError extends Error {
  readonly source: ReferenceGeoAnnotationSource;

  constructor(readonly code: ReferenceGeoAnnotationErrorCode, readonly node: IRNode, detail: string) {
    const { module, span } = node.provenance;
    super(`${code}: GeoAnnotation at ${module}:${span.start.line}:${span.start.column} ${detail}`);
    this.name = "ReferenceGeoAnnotationError";
    this.source = Object.freeze({ module, line: span.start.line, column: span.start.column, nodeId: node.id });
  }
}

export type ReferenceGeoAnnotationPlacement = ReferenceCalloutPlacement;
export type ReferenceGeoAnnotationLeaderKind = ReferenceCalloutLeaderKind;

export type ReferenceGeoAnnotationPoint = ReferenceCalloutPoint;
export type ReferenceGeoAnnotationAnchor = Readonly<{ latitude: number; longitude: number }>;

export type ReferenceGeoAnnotationRect = ReferenceCalloutRect;

export type ReferenceGeoAnnotationLeader = ReferenceCalloutLeader;

export type ReferenceGeoAnnotationConfig = Readonly<{
  nodeId: string;
  childId: string;
  anchor: ReferenceGeoAnnotationAnchor;
  width: number;
  height: number;
  cropLeft: number;
  cropTop: number;
  /** Present only for the retained local-tile form. Legacy configurations
   * deliberately keep their pre-slice object shape and identity. */
  localSpace?: Readonly<{
    nodeId: string;
    origin: Readonly<{ x: Rational; y: Rational }>;
    rasterOriginQ16: Readonly<{ x: string; y: string }>;
  }>;
  placements: readonly ReferenceGeoAnnotationPlacement[];
  offset: number;
  safeArea: number;
  priority: number;
  priorityAuthored: boolean;
  leader: ReferenceGeoAnnotationLeaderKind;
  leaderColor?: string;
  leaderWidth?: number;
}>;

export type ReferenceGeoAnnotationProjectedEntry = Readonly<{
  config: ReferenceGeoAnnotationConfig;
  layerId: string;
  layerSourceOrder: number;
  childSourceOrder: number;
  anchor: ReferenceGeoAnnotationPoint;
  opacity: number;
  opacitySemanticIdentity: string;
  childSemanticIdentity: string;
  retainedChildSurfaceIds: readonly string[];
  layerMatrix: ReferenceAffine2D;
}>;

export type ReferenceGeoAnnotationBinding = Readonly<{
  config: ReferenceGeoAnnotationConfig;
  layerId: string;
  layerSourceOrder: number;
  childSourceOrder: number;
}>;

/** GeoAnnotation placement is camera-agnostic once its geographic anchor has
 * been projected into delivery pixels. Preserve the exact public camera state
 * in evidence without pretending every owner is a ParallaxCamera. */
export type ReferenceGeoAnnotationCameraState = ReferenceParallaxCameraState
  | Readonly<{ latitude: number; longitude: number; scale: number }>
  | Readonly<{
    latitude: number;
    longitude: number;
    scale: number;
    /** Authored/sample-exact unwrapped planar compass bearing. */
    bearing: number;
    /** Equivalent post-projection angle in [0,360). */
    effectiveBearing: number;
    /** Bounded flat-plane projective tilt in degrees. */
    pitch: number;
  }>;

export type ReferenceGeoAnnotationCameraConfig = Readonly<{
  cameraId: string;
  annotations: readonly ReferenceGeoAnnotationBinding[];
  validation: Readonly<{
    exactSamples: number;
    fallbackReached: Readonly<Record<string, readonly number[]>>;
    priorityAffected: readonly string[];
    everAccepted: readonly string[];
  }>;
}>;

export type ReferenceGeoAnnotationCandidate = Readonly<{
  placement: ReferenceGeoAnnotationPlacement;
  placementIndex: number;
  rect: ReferenceGeoAnnotationRect;
  safe: boolean;
  collisionWith?: string;
}>;

export type ReferenceGeoAnnotationDecision = Readonly<{
  nodeId: string;
  childId: string;
  layerId: string;
  layerSourceOrder: number;
  childSourceOrder: number;
  priority: number;
  resolutionOrder: number;
  paintOrder?: number;
  opacity: number;
  exactAnchor: ReferenceGeoAnnotationPoint;
  candidates: readonly ReferenceGeoAnnotationCandidate[];
  status: "accepted" | "hidden";
  reason?: "opacity-zero" | "anchor-offscreen" | "collision-overflow";
  chosenPlacement?: ReferenceGeoAnnotationPlacement;
  chosenPlacementIndex?: number;
  rect?: ReferenceGeoAnnotationRect;
  leader?: ReferenceGeoAnnotationLeader;
}>;

export type ReferenceGeoAnnotationFramePlan = Readonly<{
  format: "cut-reference-geo-annotation-frame-decisions";
  version: 1;
  algorithmVersion: ReferenceGeoAnnotationAlgorithmVersion;
  exactTime: Rational;
  camera: Readonly<{
    nodeId: string;
    state: ReferenceGeoAnnotationCameraState;
    semanticIdentity: string;
  }>;
  decisions: readonly ReferenceGeoAnnotationDecision[];
  resolutionOrder: readonly string[];
  paintOrder: readonly string[];
  work: Readonly<{
    activeAnnotations: number;
    acceptedAnnotations: number;
    aggregateChildCanvasPixels: number;
    aggregateViewportPixels: number;
    aggregateOverlayCanvasPixels: number;
    aggregateOverlayCanvasBytes: number;
    candidateEvaluations: number;
    candidateCollisionTests: number;
    leaderSegments: number;
  }>;
  decisionIdentity: string;
}>;

export type ReferenceGeoAnnotationVisibleAlpha = Readonly<{
  sourceVisiblePixels: number;
  sourceMaximum: number;
  visiblePixels: number;
  maximum: number;
}>;

/** Same-frame execution outcome after the accepted layout decision meets the
 * exact RGBA8 opacity boundary. Layout remains accepted in both cases so a
 * sub-pixel fade cannot perturb collision or paint ordering. The skipped form
 * records zero annotation-overlay work; child-tile materialization remains
 * accounted for by its owning LocalSpace receipt. */
export type ReferenceGeoAnnotationRenderedDecision = Readonly<{
  status: "painted" | "opacity-quantized-transparent";
  sourceVisiblePixels: number;
  sourceMaximum: number;
  maximumQuantizedAlpha: number;
  work: Readonly<{
    annotationOverlayPlacements: 0 | 1;
    annotationOverlayComposites: 0 | 1;
    overlayCanvasPixels: number;
    overlayCanvasBytes: number;
  }>;
}>;

export type ReferenceGeoAnnotationRenderedFrameEvidence = Omit<ReferenceGeoAnnotationFramePlan, "decisions"> & Readonly<{
  decisions: readonly (ReferenceGeoAnnotationDecision & Readonly<{
    visibleAlpha?: ReferenceGeoAnnotationVisibleAlpha;
    renderedDecision?: ReferenceGeoAnnotationRenderedDecision;
  }>)[];
  executionPath: readonly Readonly<{
    compositionId: string;
    instanceNodeId?: string;
    sourceCompositionId?: string;
  }>[];
  executionIdentity: string;
}>;

function fail(node: IRNode, code: ReferenceGeoAnnotationErrorCode, detail: string): never {
  throw new ReferenceGeoAnnotationError(code, node, detail);
}

function finite(value: number, label: string) {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite.`);
  return Object.is(value, -0) ? 0 : value;
}

function quantity(
  node: IRNode,
  value: IRValue | undefined,
  label: string,
  dimension: "length" | "ratio" | "scalar",
  minimum: number,
  maximum: number,
  code: ReferenceGeoAnnotationErrorCode = "CUT_GEO_ANNOTATION_TYPE",
) {
  const unit = dimension === "length" ? "px" : dimension;
  if (value?.kind !== "quantity" || value.dimension !== dimension || value.unit !== unit) {
    fail(node, "CUT_GEO_ANNOTATION_TYPE", `${label} must be a canonical ${dimension} quantity in ${unit}.`);
  }
  const result = rationalToNumber(value.magnitude);
  if (!Number.isFinite(result) || result < minimum || result > maximum) {
    fail(node, code, `${label} must be finite from ${minimum} through ${maximum}.`);
  }
  return Object.is(result, -0) ? 0 : result;
}

function wholeQuantity(
  node: IRNode,
  value: IRValue | undefined,
  label: string,
  dimension: "length" | "scalar",
  minimum: number,
  maximum: number,
  code: ReferenceGeoAnnotationErrorCode = "CUT_GEO_ANNOTATION_TYPE",
) {
  const result = quantity(node, value, label, dimension, minimum, maximum, code);
  if (!Number.isSafeInteger(result)) fail(node, code, `${label} must be a whole safe integer.`);
  return result;
}

function coordinate(node: IRNode, value: IRValue | undefined, label: string, minimum: number, maximum: number) {
  if (value?.kind !== "quantity" || (value.dimension !== "scalar" && value.dimension !== "angle")) {
    fail(node, "CUT_GEO_ANNOTATION_TYPE", `${label} must be a scalar or angle quantity.`);
  }
  const result = rationalToNumber(value.magnitude);
  if (!Number.isFinite(result) || result < minimum || result > maximum) {
    fail(node, "CUT_GEO_ANNOTATION_TYPE", `${label} must be finite from ${minimum} through ${maximum} degrees.`);
  }
  return Object.is(result, -0) ? 0 : result;
}

function anchor(node: IRNode): ReferenceGeoAnnotationAnchor {
  const value = node.inputs.anchor;
  if (value?.kind !== "object") fail(node, "CUT_GEO_ANNOTATION_TYPE", "input “anchor” must be a GeoPoint object.");
  const keys = Object.keys(value.entries);
  if (keys.length !== 2 || !keys.includes("latitude") || !keys.includes("longitude")) {
    fail(node, "CUT_GEO_ANNOTATION_TYPE", "input “anchor” must contain exactly latitude and longitude; label is not accepted.");
  }
  return Object.freeze({
    latitude: coordinate(node, value.entries.latitude, "input “anchor.latitude”", -90, 90),
    longitude: coordinate(node, value.entries.longitude, "input “anchor.longitude”", -180, 180),
  });
}

function placements(node: IRNode): readonly ReferenceGeoAnnotationPlacement[] {
  const value = node.inputs.placements;
  if (value?.kind !== "array") fail(node, "CUT_GEO_ANNOTATION_TYPE", "input “placements” must be a List<String>.");
  if (value.items.length < 1 || value.items.length > referenceGeoAnnotationLimits.maximumPlacementsPerAnnotation) {
    fail(node, "CUT_GEO_ANNOTATION_LIMIT", `input “placements” must contain 1 through ${referenceGeoAnnotationLimits.maximumPlacementsPerAnnotation} directions.`);
  }
  const allowed = new Set<ReferenceGeoAnnotationPlacement>(["right", "above", "below", "left"]), seen = new Set<string>();
  const result = value.items.map((item, index) => {
    if (item.kind !== "string" || !allowed.has(item.value as ReferenceGeoAnnotationPlacement)) {
      fail(node, "CUT_GEO_ANNOTATION_TYPE", `input “placements[${index}]” must be one of: right, above, below, left.`);
    }
    if (seen.has(item.value)) fail(node, "CUT_GEO_ANNOTATION_NOOP", `input “placements[${index}]” duplicates “${item.value}” and can never execute.`);
    seen.add(item.value);
    return item.value as ReferenceGeoAnnotationPlacement;
  });
  return Object.freeze(result);
}

function color(node: IRNode, value: IRValue | undefined, label: string) {
  if (value?.kind !== "color" || !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(value.value)) {
    fail(node, "CUT_GEO_ANNOTATION_STYLE", `${label} must be a canonical six- or eight-digit CUT color.`);
  }
  if (value.value.length === 9 && value.value.slice(-2).toLowerCase() === "00") {
    fail(node, "CUT_GEO_ANNOTATION_NOOP", `${label} cannot be fully transparent.`);
  }
  return value.value.toLowerCase();
}

function signalValues(signal: IRSignal) {
  if (signal.kind === "constant") return [signal.value];
  if (signal.kind === "step") return signal.points.map((point) => point.value);
  if (signal.kind === "keyframes") return signal.keyframes.map((keyframe) => keyframe.value);
  return [signal.initial, ...signal.events.flatMap((event) => event.kind === "set" ? [event.value] : [event.from, event.to])];
}

function validateOpacityValues(ir: CutAVIR, node: IRNode) {
  if (node.inputs.opacity !== undefined) quantity(node, node.inputs.opacity, "input “opacity”", "ratio", 0, 1);
  const property = node.properties.opacity;
  if (property === undefined) {
    if (node.inputs.opacity !== undefined) {
      const value = quantity(node, node.inputs.opacity, "input “opacity”", "ratio", 0, 1);
      if (value === 0) fail(node, "CUT_GEO_ANNOTATION_NOOP", "static opacity 0% hides the annotation for its complete interval.");
      if (value === 1) fail(node, "CUT_GEO_ANNOTATION_NOOP", "explicit opacity 100% repeats the default without an executing property signal; omit it.");
    }
    return;
  }
  const values = "signal" in property ? (() => {
    const signal = ir.signals[property.signal];
    if (!signal) fail(node, "CUT_GEO_ANNOTATION_TYPE", `property “opacity” references missing signal ${property.signal}.`);
    if (signal.valueType !== "Ratio") fail(node, "CUT_GEO_ANNOTATION_TYPE", `property “opacity” signal ${signal.id} must declare valueType Ratio.`);
    return signalValues(signal);
  })() : [property];
  for (const value of values) {
    if (value.kind === "null") continue;
    quantity(node, value, "property “opacity” value", "ratio", 0, 1);
  }
}

/** Decode and close one loaded typed-IR GeoAnnotation before graph planning. */
export function referenceGeoAnnotationConfig(
  ir: CutAVIR,
  composition: IRComposition,
  node: IRNode,
): ReferenceGeoAnnotationConfig | undefined {
  if (node.op !== "cut.geo.annotation") return undefined;
  const allowedInputs = new Set(["anchor", "width", "height", "placements", "offset", "safeArea", "priority", "leader", "leaderColor", "leaderWidth", "opacity"]);
  const unknownInput = Object.keys(node.inputs).find((name) => !allowedInputs.has(name));
  if (unknownInput !== undefined) {
    if (unknownInput === "projection") fail(node, "CUT_GEO_ANNOTATION_PROJECTION", "map projection is fixed by the versioned algorithm; public input “projection” is not accepted.");
    fail(node, "CUT_GEO_ANNOTATION_TYPE", `input “${unknownInput}” is not part of the closed public contract.`);
  }
  const unknownProperty = Object.keys(node.properties).find((name) => name !== "opacity");
  if (unknownProperty !== undefined) fail(node, "CUT_GEO_ANNOTATION_TYPE", `property “${unknownProperty}” is not part of the closed public contract.`);
  if (node.domain !== "visual") fail(node, "CUT_GEO_ANNOTATION_GRAPH", `must have visual domain, found ${node.domain}.`);
  if (node.children.length !== 1) fail(node, "CUT_GEO_ANNOTATION_GRAPH", `requires exactly one direct visual child; found ${node.children.length}.`);
  const child = ir.nodes[node.children[0]];
  if (!child || child.domain !== "visual") fail(node, "CUT_GEO_ANNOTATION_GRAPH", "requires one existing visual child.");
  const localSpace = child.op === "cut.visual.local_space" ? referenceLocalSpaceStaticConfig(child) : undefined;
  const hasWidth = node.inputs.width !== undefined, hasHeight = node.inputs.height !== undefined;
  if (localSpace && (hasWidth || hasHeight)) {
    fail(node, "CUT_GEO_ANNOTATION_VIEWPORT", "with a direct LocalSpace child derives its viewport and forbids width and height.");
  }
  if (!localSpace && (!hasWidth || !hasHeight)) {
    fail(node, "CUT_GEO_ANNOTATION_VIEWPORT", "with an ordinary visual child requires both width and height; only a direct LocalSpace child may omit them.");
  }
  const width = localSpace?.width ?? wholeQuantity(node, node.inputs.width, "input “width”", "length", 1, composition.width);
  const height = localSpace?.height ?? wholeQuantity(node, node.inputs.height, "input “height”", "length", 1, composition.height);
  if (width > composition.width || height > composition.height) {
    fail(node, "CUT_GEO_ANNOTATION_VIEWPORT", `derived ${width}x${height} LocalSpace viewport exceeds the ${composition.width}x${composition.height} delivery canvas.`);
  }
  const offset = quantity(node, node.inputs.offset, "input “offset”", "length", 1, referenceGeoAnnotationLimits.maximumAbsoluteDeliveryLengthPx);
  const safeArea = quantity(node, node.inputs.safeArea, "input “safeArea”", "length", Number.MIN_VALUE, Math.min(composition.width, composition.height) / 2, "CUT_GEO_ANNOTATION_SAFE_AREA");
  if (composition.width - 2 * safeArea <= 0 || composition.height - 2 * safeArea <= 0) {
    fail(node, "CUT_GEO_ANNOTATION_SAFE_AREA", "input “safeArea” leaves no positive half-open delivery rectangle.");
  }
  if (width > composition.width - 2 * safeArea || height > composition.height - 2 * safeArea) {
    fail(node, "CUT_GEO_ANNOTATION_SAFE_AREA", `declared ${width}x${height} viewport can never fit inside the uniform ${safeArea}px safe rectangle.`);
  }
  const priorityAuthored = node.inputs.priority !== undefined;
  const priority = priorityAuthored
    ? wholeQuantity(node, node.inputs.priority, "input “priority”", "scalar", -referenceGeoAnnotationLimits.maximumAbsolutePriority, referenceGeoAnnotationLimits.maximumAbsolutePriority)
    : 0;
  if (priorityAuthored && priority === 0) fail(node, "CUT_GEO_ANNOTATION_NOOP", "authored priority zero repeats omitted structural ordering.");
  const leaderValue = node.inputs.leader;
  if (leaderValue?.kind !== "string" || !["none", "straight", "elbow"].includes(leaderValue.value)) {
    fail(node, "CUT_GEO_ANNOTATION_STYLE", "input “leader” must be one of: none, straight, elbow.");
  }
  const leader = leaderValue.value as ReferenceGeoAnnotationLeaderKind;
  let leaderColor: string | undefined, leaderWidth: number | undefined;
  if (leader === "none") {
    if (node.inputs.leaderColor !== undefined || node.inputs.leaderWidth !== undefined) {
      fail(node, "CUT_GEO_ANNOTATION_NOOP", "leader: none forbids leaderColor and leaderWidth because neither could execute.");
    }
  } else {
    if (node.inputs.leaderColor === undefined || node.inputs.leaderWidth === undefined) {
      fail(node, "CUT_GEO_ANNOTATION_STYLE", `leader: ${leader} requires both leaderColor and leaderWidth.`);
    }
    leaderColor = color(node, node.inputs.leaderColor, "input “leaderColor”");
    leaderWidth = quantity(node, node.inputs.leaderWidth, "input “leaderWidth”", "length", Number.MIN_VALUE, Math.min(composition.width, composition.height), "CUT_GEO_ANNOTATION_STYLE");
  }
  validateOpacityValues(ir, node);
  return Object.freeze({
    nodeId: node.id,
    childId: child.id,
    anchor: anchor(node),
    width,
    height,
    cropLeft: localSpace ? 0 : Math.floor((composition.width - width) / 2),
    cropTop: localSpace ? 0 : Math.floor((composition.height - height) / 2),
    ...(localSpace ? {
      localSpace: Object.freeze({
        nodeId: child.id,
        origin: Object.freeze({ ...localSpace.origin }),
        rasterOriginQ16: Object.freeze({ ...localSpace.rasterOriginQ16 }),
      }),
    } : {}),
    placements: placements(node),
    offset,
    safeArea,
    priority,
    priorityAuthored,
    leader,
    ...(leaderColor === undefined ? {} : { leaderColor }),
    ...(leaderWidth === undefined ? {} : { leaderWidth }),
  });
}

export function referenceGeoAnnotationOpacityAt(ir: CutAVIR, node: IRNode, time: Rational) {
  const property = propertyAt(ir, node, "opacity", time);
  const baseline = node.inputs.opacity ?? { kind: "quantity", dimension: "ratio", unit: "ratio", magnitude: rational(1) } as IRValue;
  // Track null means "no property event owns this instant"; constructor/default
  // semantics remain active rather than silently jumping to 100% opacity.
  const sampled = property?.kind === "null" ? baseline : property ?? baseline;
  return quantity(node, sampled, "executed opacity", "ratio", 0, 1);
}

export function referenceGeoAnnotationSnap(value: number) {
  return referenceCalloutSnap(finite(value, "GeoAnnotation snap value"));
}

export function referenceGeoAnnotationCandidateRect(
  anchorValue: ReferenceGeoAnnotationPoint,
  width: number,
  height: number,
  offset: number,
  placement: ReferenceGeoAnnotationPlacement,
): ReferenceGeoAnnotationRect {
  return referenceCalloutCandidateRect(
    {
      x: finite(anchorValue.x, "GeoAnnotation anchor x"),
      y: finite(anchorValue.y, "GeoAnnotation anchor y"),
    },
    width,
    height,
    offset,
    placement,
  );
}

export function referenceGeoAnnotationRectsCollide(left: ReferenceGeoAnnotationRect, right: ReferenceGeoAnnotationRect) {
  return referenceCalloutRectsCollide(left, right);
}

function viewportIsSafe(composition: IRComposition, rect: ReferenceGeoAnnotationRect, safeArea: number) {
  return rect.left >= safeArea
    && rect.top >= safeArea
    && rect.right <= composition.width - safeArea
    && rect.bottom <= composition.height - safeArea;
}

function anchorIsOnscreen(composition: IRComposition, anchorValue: ReferenceGeoAnnotationPoint) {
  return anchorValue.x >= 0 && anchorValue.x < composition.width && anchorValue.y >= 0 && anchorValue.y < composition.height;
}

export function referenceGeoAnnotationLeader(
  node: IRNode,
  config: ReferenceGeoAnnotationConfig,
  anchorValue: ReferenceGeoAnnotationPoint,
  rect: ReferenceGeoAnnotationRect,
  placement: ReferenceGeoAnnotationPlacement,
): ReferenceGeoAnnotationLeader | undefined {
  return referenceCalloutLeader(Object.freeze({
    id: config.nodeId,
    sourceOrder: Object.freeze([]),
    priority: config.priority,
    anchor: Object.freeze({
      x: finite(anchorValue.x, "GeoAnnotation leader anchor x"),
      y: finite(anchorValue.y, "GeoAnnotation leader anchor y"),
    }),
    width: config.width,
    height: config.height,
    placements: config.placements,
    offset: config.offset,
    safeArea: config.safeArea,
    opacity: 1,
    leader: config.leader,
    ...(config.leaderColor === undefined ? {} : { leaderColor: config.leaderColor }),
    ...(config.leaderWidth === undefined ? {} : { leaderWidth: config.leaderWidth }),
  }), rect, placement, {
    maximumLeaderSegmentsPerEntry: referenceGeoAnnotationLimits.maximumLeaderSegmentsPerAnnotation,
    fail: (_entry, kind, detail) => fail(
      node,
      kind === "limit" ? "CUT_GEO_ANNOTATION_LIMIT" : "CUT_GEO_ANNOTATION_STYLE",
      detail,
    ),
  });
}

/** Resolve one camera's already-projected annotations without raster work. */
export function resolveReferenceGeoAnnotationsAt(
  ir: CutAVIR,
  composition: IRComposition,
  time: Rational,
  entriesValue: readonly ReferenceGeoAnnotationProjectedEntry[],
  camera: Readonly<{ nodeId: string; state: ReferenceGeoAnnotationCameraState; semanticIdentity: string }>,
  priorityOverrides: ReadonlyMap<string, number> = new Map(),
  algorithmVersion: ReferenceGeoAnnotationAlgorithmVersion = referenceGeoAnnotationAlgorithmVersion,
): ReferenceGeoAnnotationFramePlan {
  if (entriesValue.length > referenceGeoAnnotationLimits.maximumAnnotationsPerCamera) {
    const node = ir.nodes[entriesValue[0]?.config.nodeId ?? ""];
    if (!node) throw new Error("CUT GeoAnnotation camera budget has no source node.");
    fail(node, "CUT_GEO_ANNOTATION_LIMIT", `camera has ${entriesValue.length} active annotations; maximum is ${referenceGeoAnnotationLimits.maximumAnnotationsPerCamera}.`);
  }
  const entries = [...entriesValue].sort((left, right) => {
    const leftPriority = priorityOverrides.get(left.config.nodeId) ?? left.config.priority;
    const rightPriority = priorityOverrides.get(right.config.nodeId) ?? right.config.priority;
    return rightPriority - leftPriority
      || left.layerSourceOrder - right.layerSourceOrder
      || left.childSourceOrder - right.childSourceOrder;
  });
  const occupied: Array<{ nodeId: string; rect: ReferenceGeoAnnotationRect }> = [], decisions: ReferenceGeoAnnotationDecision[] = [];
  let collisionTests = 0;
  for (const [resolutionOrder, entry] of entries.entries()) {
    const node = ir.nodes[entry.config.nodeId];
    if (!node) throw new Error(`Internal CUT GeoAnnotation ${entry.config.nodeId} is missing.`);
    const priority = priorityOverrides.get(entry.config.nodeId) ?? entry.config.priority;
    if (entry.opacity === 0) {
      decisions.push(Object.freeze({
        nodeId: node.id, childId: entry.config.childId, layerId: entry.layerId,
        layerSourceOrder: entry.layerSourceOrder, childSourceOrder: entry.childSourceOrder,
        priority, resolutionOrder, opacity: entry.opacity, exactAnchor: entry.anchor,
        candidates: Object.freeze([]), status: "hidden", reason: "opacity-zero",
      }));
      continue;
    }
    if (!anchorIsOnscreen(composition, entry.anchor)) {
      decisions.push(Object.freeze({
        nodeId: node.id, childId: entry.config.childId, layerId: entry.layerId,
        layerSourceOrder: entry.layerSourceOrder, childSourceOrder: entry.childSourceOrder,
        priority, resolutionOrder, opacity: entry.opacity, exactAnchor: entry.anchor,
        candidates: Object.freeze([]), status: "hidden", reason: "anchor-offscreen",
      }));
      continue;
    }
    const candidates: ReferenceGeoAnnotationCandidate[] = [];
    let chosen: ReferenceGeoAnnotationCandidate | undefined;
    for (const [placementIndex, placement] of entry.config.placements.entries()) {
      const rect = referenceGeoAnnotationCandidateRect(entry.anchor, entry.config.width, entry.config.height, entry.config.offset, placement);
      const safe = viewportIsSafe(composition, rect, entry.config.safeArea);
      let collisionWith: string | undefined;
      if (safe) for (const accepted of occupied) {
        collisionTests += 1;
        if (collisionTests > referenceGeoAnnotationLimits.maximumCandidateCollisionTestsPerCameraSample) {
          fail(node, "CUT_GEO_ANNOTATION_LIMIT", `camera exceeds ${referenceGeoAnnotationLimits.maximumCandidateCollisionTestsPerCameraSample} candidate collision tests at ${time.numerator}/${time.denominator}s.`);
        }
        if (referenceGeoAnnotationRectsCollide(rect, accepted.rect)) { collisionWith = accepted.nodeId; break; }
      }
      const candidate = Object.freeze({ placement, placementIndex, rect, safe, ...(collisionWith === undefined ? {} : { collisionWith }) });
      candidates.push(candidate);
      if (safe && collisionWith === undefined) { chosen = candidate; break; }
    }
    if (!chosen) {
      decisions.push(Object.freeze({
        nodeId: node.id, childId: entry.config.childId, layerId: entry.layerId,
        layerSourceOrder: entry.layerSourceOrder, childSourceOrder: entry.childSourceOrder,
        priority, resolutionOrder, opacity: entry.opacity, exactAnchor: entry.anchor,
        candidates: Object.freeze(candidates), status: "hidden", reason: "collision-overflow",
      }));
      continue;
    }
    occupied.push({ nodeId: node.id, rect: chosen.rect });
    decisions.push(Object.freeze({
      nodeId: node.id, childId: entry.config.childId, layerId: entry.layerId,
      layerSourceOrder: entry.layerSourceOrder, childSourceOrder: entry.childSourceOrder,
      priority, resolutionOrder, opacity: entry.opacity, exactAnchor: entry.anchor,
      candidates: Object.freeze(candidates), status: "accepted",
      chosenPlacement: chosen.placement, chosenPlacementIndex: chosen.placementIndex,
      rect: chosen.rect,
      ...(entry.config.leader === "none" ? {} : { leader: referenceGeoAnnotationLeader(node, entry.config, entry.anchor, chosen.rect, chosen.placement) }),
    }));
  }
  const accepted = decisions.filter((decision) => decision.status === "accepted");
  const paintIds = [...accepted].reverse().map((decision) => decision.nodeId);
  const paintOrderById = new Map(paintIds.map((id, index) => [id, index]));
  const finalized = decisions.map((decision) => decision.status === "accepted"
    ? Object.freeze({ ...decision, paintOrder: paintOrderById.get(decision.nodeId)! })
    : decision);
  const canvasPixels = composition.width * composition.height;
  const entryById = new Map(entries.map((entry) => [entry.config.nodeId, entry]));
  const retainedChildSurfaceIds = new Set(accepted.flatMap((decision) => entryById.get(decision.nodeId)?.retainedChildSurfaceIds ?? []));
  const aggregateChildCanvasPixels = retainedChildSurfaceIds.size * canvasPixels;
  const aggregateViewportPixels = accepted.reduce((total, decision) => total + decision.rect!.width * decision.rect!.height, 0);
  // The public renderer incrementally composites one annotation at a time, so
  // accepted overlays are not retained as an unbounded array. Still account
  // every full-canvas allocation that the specified pipeline performs:
  // placement + optional leader + overlay + optional opacity copy + camera
  // composite. This closes the shared-child DAG resource bypass.
  const aggregateOverlayCanvasPixels = accepted.reduce((total, decision) => total + canvasPixels * (
    // placement transparent base + placement output; optional SVG leader;
    // overlay composite base + output; optional opacity copy; incremental
    // camera composite base + output.
    6 + (decision.leader ? 1 : 0) + (decision.opacity === 1 ? 0 : 1)
  ), 0);
  const aggregateOverlayCanvasBytes = aggregateOverlayCanvasPixels * 4;
  const candidateEvaluations = finalized.reduce((total, decision) => total + decision.candidates.length, 0);
  const leaderSegments = accepted.reduce((total, decision) => total + (decision.leader?.vertices.length ? decision.leader.vertices.length - 1 : 0), 0);
  for (const [value, maximum, label] of [
    [aggregateChildCanvasPixels, referenceGeoAnnotationLimits.maximumAggregateChildCanvasPixelsPerCameraSample, "aggregate full-canvas child pixels"],
    [aggregateViewportPixels, referenceGeoAnnotationLimits.maximumAggregateViewportPixelsPerCameraSample, "aggregate viewport pixels"],
    [aggregateOverlayCanvasPixels, referenceGeoAnnotationLimits.maximumAggregateOverlayCanvasPixelsPerCameraSample, "aggregate overlay/composite canvas pixels"],
    [aggregateOverlayCanvasBytes, referenceGeoAnnotationLimits.maximumAggregateOverlayCanvasBytesPerCameraSample, "aggregate overlay/composite RGBA bytes"],
  ] as const) {
    if (!Number.isSafeInteger(value) || value > maximum) {
      const node = ir.nodes[accepted[0]?.nodeId ?? entries[0]?.config.nodeId ?? ""];
      if (!node) throw new Error(`CUT GeoAnnotation ${label} budget has no source node.`);
      fail(node, "CUT_GEO_ANNOTATION_LIMIT", `${label} ${value} exceeds ${maximum} at ${time.numerator}/${time.denominator}s; the full-canvas budget covers every child surface retained by frameMemo until frame end.`);
    }
  }
  const work = Object.freeze({
    activeAnnotations: entries.length,
    acceptedAnnotations: accepted.length,
    aggregateChildCanvasPixels,
    aggregateViewportPixels,
    aggregateOverlayCanvasPixels,
    aggregateOverlayCanvasBytes,
    candidateEvaluations,
    candidateCollisionTests: collisionTests,
    leaderSegments,
  });
  const decisionIdentity = hash({
    algorithm: algorithmVersion,
    exactTime: time,
    delivery: { width: composition.width, height: composition.height },
    camera,
    activeEntries: entries.map((entry) => ({
      nodeId: entry.config.nodeId,
      childId: entry.config.childId,
      config: entry.config,
      opacity: entry.opacity,
      opacitySemanticIdentity: entry.opacitySemanticIdentity,
      childSemanticIdentity: entry.childSemanticIdentity,
      retainedChildSurfaceIds: entry.retainedChildSurfaceIds,
      layerId: entry.layerId,
      layerSourceOrder: entry.layerSourceOrder,
      childSourceOrder: entry.childSourceOrder,
      layerMatrix: entry.layerMatrix,
      projectedAnchor: entry.anchor,
    })),
    decisions: finalized.map((decision) => ({
      nodeId: decision.nodeId,
      childId: decision.childId,
      layerId: decision.layerId,
      priority: decision.priority,
      opacity: decision.opacity,
      exactAnchor: decision.exactAnchor,
      candidates: decision.candidates,
      status: decision.status,
      reason: decision.reason,
      chosenPlacement: decision.chosenPlacement,
      chosenPlacementIndex: decision.chosenPlacementIndex,
      rect: decision.rect,
      leader: decision.leader,
      resolutionOrder: decision.resolutionOrder,
      paintOrder: decision.paintOrder,
    })),
    resolutionOrder: finalized.map((decision) => decision.nodeId),
    paintOrder: paintIds,
    work,
  });
  return Object.freeze({
    format: "cut-reference-geo-annotation-frame-decisions",
    version: 1,
    algorithmVersion,
    exactTime: Object.freeze({ ...time }),
    camera: Object.freeze({ nodeId: camera.nodeId, state: Object.freeze({ ...camera.state }), semanticIdentity: camera.semanticIdentity }),
    decisions: Object.freeze(finalized),
    resolutionOrder: Object.freeze(finalized.map((decision) => decision.nodeId)),
    paintOrder: Object.freeze(paintIds),
    work,
    decisionIdentity,
  });
}

export function referenceGeoAnnotationIntervalsEqual(left: IRNode, right: IRNode) {
  return compareRational(left.interval.start, right.interval.start) === 0
    && compareRational(left.interval.duration, right.interval.duration) === 0;
}

export function referenceGeoAnnotationActive(node: IRNode, time: Rational) {
  const end = addRational(node.interval.start, node.interval.duration);
  return compareRational(time, node.interval.start) >= 0 && compareRational(time, end) < 0;
}

export function referenceGeoAnnotationOpacityIsPositive(ir: CutAVIR, node: IRNode, time: Rational) {
  const sampled = propertyAt(ir, node, "opacity", time);
  const magnitude = sampled?.kind === "quantity"
    ? sampled.magnitude
    : node.inputs.opacity?.kind === "quantity" ? node.inputs.opacity.magnitude : rational(1);
  return compareRational(magnitude, zeroRational) > 0;
}

function annotationParents(ir: CutAVIR) {
  const result = new Map<string, IRNode[]>();
  for (const parent of Object.values(ir.nodes)) for (const childId of parent.children) {
    const values = result.get(childId) ?? [];
    values.push(parent);
    result.set(childId, values);
  }
  return result;
}

function opacitySemanticIdentity(ir: CutAVIR, node: IRNode) {
  const authored = node.properties.opacity;
  const signal = authored && "signal" in authored ? ir.signals[authored.signal] : undefined;
  return hash({
    input: node.inputs.opacity,
    property: authored,
    signal: signal ? { id: signal.id, contentHash: signal.contentHash } : undefined,
  });
}

function activeDescendantSurfaceIds(ir: CutAVIR, rootId: string, time: Rational) {
  const result = new Set<string>(), visiting = new Set<string>();
  const visit = (nodeId: string, sample: Rational, prefix = "") => {
    const key = `${prefix}${nodeId}`;
    if (result.has(key)) return;
    const node = ir.nodes[nodeId];
    if (!node || !referenceGeoAnnotationActive(node, sample)) return;
    if (visiting.has(key)) fail(node, "CUT_GEO_ANNOTATION_GRAPH", `child/precomposition graph contains a cycle through ${nodeId}.`);
    visiting.add(key);
    result.add(key);
    node.children.forEach((childId) => visit(childId, sample, prefix));
    if (node.op === "cut.visual.precomp" || node.op === "cut.edit.nested_sequence") {
      const sourceValue = node.inputs.source;
      if (sourceValue?.kind !== "timeline-ref") fail(node, "CUT_GEO_ANNOTATION_GRAPH", "nested child has no canonical source timeline for retained-surface accounting.");
      const source = ir.compositions.find((candidate) => candidate.id === sourceValue.id);
      if (!source) fail(node, "CUT_GEO_ANNOTATION_GRAPH", `nested child references missing source composition ${sourceValue.id}.`);
      const local = subtractRational(sample, node.interval.start);
      const rangeStart = node.op === "cut.edit.nested_sequence" && node.inputs.range?.kind === "range"
        && node.inputs.range.start.kind === "quantity" ? node.inputs.range.start.magnitude : zeroRational;
      const sourceTime = addRational(rangeStart, local);
      const scene = source.sceneIds.map((sceneId) => ir.scenes[sceneId]).find((candidate) => candidate
        && compareRational(sourceTime, candidate.start) >= 0
        && compareRational(sourceTime, addRational(candidate.start, candidate.duration)) < 0);
      if (!scene) fail(node, "CUT_GEO_ANNOTATION_GRAPH", `nested source ${source.id} has no scene at ${sourceTime.numerator}/${sourceTime.denominator}s for retained-surface accounting.`);
      const sceneLocal = subtractRational(sourceTime, scene.start);
      const nestedPrefix = `${key}->${source.id}/`;
      [...scene.rootVisualIds, ...scene.rootAVIds].forEach((childId) => visit(childId, sceneLocal, nestedPrefix));
    }
    visiting.delete(key);
  };
  visit(rootId, time);
  return Object.freeze([...result].sort());
}

function mapProjectedGeoNode(node: IRNode) {
  if (node.op === "cut.geo.map" || node.op === "cut.geo.route" || node.op === "cut.geo.connections") return true;
  if (node.op === "cut.geo.marker") return !(node.inputs.projection?.kind === "string" && node.inputs.projection.value === "globe");
  if (node.op === "cut.geo.wavefront") return referenceWavefrontProjection(node) === "map";
  return false;
}

const nonAffineAlignmentAncestors = new Set(["cut.visual.motion_path", "cut.visual.track_2d", "cut.visual.stack"]);
const staticPositionContainers = new Set([
  "cut.kernel.fragment", "cut.visual.group", "cut.visual.motion_path", "cut.visual.track_2d", "cut.visual.precomp",
  "cut.visual.flow_text", "cut.edit.nested_sequence", "cut.visual.stack", "cut.visual.composite", "cut.visual.mask",
  "cut.visual.camera2d", "cut.visual.depth_layer", "cut.visual.color_convert", "cut.visual.tonal_curve", "cut.visual.color_grade",
  "cut.edit.sequence", "cut.edit.picture_track",
]);

function assertIdentityMapAlignment(
  ir: CutAVIR,
  composition: IRComposition,
  annotationNode: IRNode,
  node: IRNode,
  time: Rational,
) {
  if (nonAffineAlignmentAncestors.has(node.op)) {
    fail(annotationNode, "CUT_GEO_ANNOTATION_PROJECTION", `base map sibling path contains ${node.op} at node ${node.id}; v1 alignment accepts only identity geometry transforms between a map-projected geo node and its DepthLayer.`);
  }
  let transform;
  try {
    transform = referenceVisualTransformAt(ir, composition, node, time, {
      staticPosition: staticPositionContainers.has(node.op),
      staticRotation: node.op !== "cut.geo.globe",
    });
  } catch (error) {
    fail(annotationNode, "CUT_GEO_ANNOTATION_PROJECTION", `cannot validate base map sibling ${node.id} transform: ${error instanceof Error ? error.message : String(error)}.`);
  }
  if (transform.x !== 0 || transform.y !== 0 || transform.anchorX !== 0 || transform.anchorY !== 0
    || transform.scale !== 1 || transform.skewX !== 0 || transform.skewY !== 0 || transform.rotation !== 0) {
    fail(annotationNode, "CUT_GEO_ANNOTATION_PROJECTION", `base map sibling path node ${node.id} has a non-identity geometry transform at ${time.numerator}/${time.denominator}s; v1 cannot claim shared map alignment.`);
  }
}

function validateLayerMapAlignment(
  ir: CutAVIR,
  composition: IRComposition,
  annotationNode: IRNode,
  ordinaryChildIds: readonly string[],
  times: readonly Rational[],
) {
  type PathEntry = Readonly<{ node: IRNode; composition: IRComposition; time: Rational }>;
  const visit = (
    nodeId: string,
    owner: IRComposition,
    time: Rational,
    path: readonly PathEntry[],
    visiting: ReadonlySet<string>,
    prefix = "",
  ) => {
    const node = ir.nodes[nodeId];
    if (!node) fail(annotationNode, "CUT_GEO_ANNOTATION_GRAPH", `owning layer references missing ordinary child ${nodeId}.`);
    const key = `${prefix}${nodeId}`;
    if (visiting.has(key)) fail(annotationNode, "CUT_GEO_ANNOTATION_GRAPH", `owning layer child/precomposition graph contains a cycle through ${nodeId}.`);
    if (!referenceGeoAnnotationActive(node, time)) return;
    const nextPath = [...path, { node, composition: owner, time }];
    if (mapProjectedGeoNode(node)) for (const candidate of nextPath) {
      assertIdentityMapAlignment(ir, candidate.composition, annotationNode, candidate.node, candidate.time);
    }
    const nextVisiting = new Set(visiting); nextVisiting.add(key);
    node.children.forEach((childId) => {
      if (ir.nodes[childId]?.op !== "cut.geo.annotation") visit(childId, owner, time, nextPath, nextVisiting, prefix);
    });
    if (node.op === "cut.visual.precomp" || node.op === "cut.edit.nested_sequence") {
      const sourceValue = node.inputs.source;
      if (sourceValue?.kind !== "timeline-ref") fail(annotationNode, "CUT_GEO_ANNOTATION_GRAPH", `nested base-map path node ${node.id} has no canonical source timeline.`);
      const source = ir.compositions.find((candidate) => candidate.id === sourceValue.id);
      if (!source) fail(annotationNode, "CUT_GEO_ANNOTATION_GRAPH", `nested base-map path node ${node.id} references missing source composition ${sourceValue.id}.`);
      const local = subtractRational(time, node.interval.start);
      const rangeStart = node.op === "cut.edit.nested_sequence" && node.inputs.range?.kind === "range"
        && node.inputs.range.start.kind === "quantity" ? node.inputs.range.start.magnitude : zeroRational;
      const sourceTime = addRational(rangeStart, local);
      const scene = source.sceneIds.map((sceneId) => ir.scenes[sceneId]).find((candidate) => candidate
        && compareRational(sourceTime, candidate.start) >= 0
        && compareRational(sourceTime, addRational(candidate.start, candidate.duration)) < 0);
      if (!scene) fail(annotationNode, "CUT_GEO_ANNOTATION_GRAPH", `nested base-map source ${source.id} has no scene at ${sourceTime.numerator}/${sourceTime.denominator}s.`);
      const sceneLocal = subtractRational(sourceTime, scene.start), nestedPrefix = `${key}->${source.id}/`;
      [...scene.rootVisualIds, ...scene.rootAVIds].forEach((childId) => visit(childId, source, sceneLocal, nextPath, nextVisiting, nestedPrefix));
    }
  };
  for (const time of times) ordinaryChildIds.forEach((childId) => visit(childId, composition, time, [], new Set()));
}

function projectedEntriesAt(
  ir: CutAVIR,
  composition: IRComposition,
  config: ReferenceGeoAnnotationCameraConfig,
  cameraPlan: ReferenceParallaxCameraFramePlan,
  time: Rational,
) {
  return Object.freeze(config.annotations.flatMap((binding): ReferenceGeoAnnotationProjectedEntry[] => {
    const node = ir.nodes[binding.config.nodeId], layer = ir.nodes[binding.layerId];
    if (!node || !layer || !referenceGeoAnnotationActive(node, time) || !referenceGeoAnnotationActive(layer, time)) return [];
    const layerFrame = cameraPlan.layers.find((candidate) => candidate.nodeId === binding.layerId);
    if (!layerFrame) fail(node, "CUT_GEO_ANNOTATION_GRAPH", `is active while owning DepthLayer ${binding.layerId} has no active camera plan.`);
    let projected: ReferenceGeoAnnotationPoint;
    try {
      const mapPoint = referenceGeoMapPoint(composition.width, composition.height, binding.config.anchor);
      projected = transformReferencePoint(layerFrame.matrix, mapPoint[0], mapPoint[1]);
    } catch (error) {
      fail(node, "CUT_GEO_ANNOTATION_PROJECTION", `failed the fixed shared map projection and owning-layer affine: ${error instanceof Error ? error.message : String(error)}.`);
    }
    return [Object.freeze({
      config: binding.config,
      layerId: binding.layerId,
      layerSourceOrder: binding.layerSourceOrder,
      childSourceOrder: binding.childSourceOrder,
      anchor: projected,
      opacity: referenceGeoAnnotationOpacityAt(ir, node, time),
      opacitySemanticIdentity: opacitySemanticIdentity(ir, node),
      childSemanticIdentity: referenceParallaxNodeSemanticIdentity(ir, binding.config.childId),
      // LocalSpace owns one bounded retained tile and reports its actual work
      // through the same-frame LocalSpace receipt. It must never be charged or
      // executed as a legacy delivery-canvas child surface.
      retainedChildSurfaceIds: binding.config.localSpace
        ? Object.freeze([])
        : activeDescendantSurfaceIds(ir, binding.config.childId, time),
      layerMatrix: layerFrame.matrix,
    })];
  }));
}

/** Plan one camera-overlay sample from the exact camera state that drives its world planes. */
export function referenceGeoAnnotationPlanAt(
  ir: CutAVIR,
  composition: IRComposition,
  config: ReferenceGeoAnnotationCameraConfig,
  parallaxConfig: ReferenceParallaxCameraConfig,
  time: Rational,
  cameraPlan: ReferenceParallaxCameraFramePlan = referenceParallaxCameraPlanAt(ir, composition, parallaxConfig, time),
  priorityOverrides: ReadonlyMap<string, number> = new Map(),
) {
  if (config.cameraId !== parallaxConfig.nodeId || cameraPlan.state === undefined) {
    const node = ir.nodes[config.annotations[0]?.config.nodeId ?? config.cameraId];
    if (!node) throw new Error(`CUT GeoAnnotation camera ${config.cameraId} is missing.`);
    fail(node, "CUT_GEO_ANNOTATION_GRAPH", `camera configuration ${config.cameraId} does not match ${parallaxConfig.nodeId}.`);
  }
  const entries = projectedEntriesAt(ir, composition, config, cameraPlan, time);
  return resolveReferenceGeoAnnotationsAt(ir, composition, time, entries, {
    nodeId: config.cameraId,
    state: cameraPlan.state,
    semanticIdentity: cameraPlan.semanticIdentity,
  }, priorityOverrides);
}

function samePlacementDecision(left: ReferenceGeoAnnotationDecision | undefined, right: ReferenceGeoAnnotationDecision | undefined) {
  return left?.status === right?.status
    && left?.chosenPlacement === right?.chosenPlacement
    && left?.chosenPlacementIndex === right?.chosenPlacementIndex;
}

/**
 * Close loaded graph ownership and prove every authored annotation control over
 * bounded exact output-frame samples before any asset or raster is opened.
 */
export function validateReferenceGeoAnnotationGraph(
  ir: CutAVIR,
  composition: IRComposition,
  parallaxConfigs: ReadonlyMap<string, ReferenceParallaxCameraConfig>,
  selectedNodeIds?: ReadonlySet<string>,
  validatedLocalSpaceConfigs?: ReadonlyMap<string, ReferenceLocalSpaceConfig>,
) {
  const selected = (node: IRNode) => selectedNodeIds === undefined || selectedNodeIds.has(node.id);
  const localSpaceConfigs = validatedLocalSpaceConfigs
    ?? validateReferenceLocalSpaceGraph(ir, composition, selectedNodeIds);
  const parents = annotationParents(ir);
  // MapCamera owns a separate retained final-space projection/validation path.
  // Keep this legacy/Parallax validator exact by excluding only annotations
  // that are directly and exclusively owned by a MapCamera; malformed owners
  // still enter this validator and fail closed below.
  const annotations = Object.values(ir.nodes).filter((node) => {
    if (!selected(node) || node.op !== "cut.geo.annotation") return false;
    const direct = (parents.get(node.id) ?? []).filter(selected);
    return !(direct.length === 1 && direct[0].op === "cut.geo.map_camera");
  });
  if (annotations.length > referenceGeoAnnotationLimits.maximumAnnotationsPerComposition) {
    fail(annotations[0], "CUT_GEO_ANNOTATION_LIMIT", `composition contains ${annotations.length} annotations; maximum is ${referenceGeoAnnotationLimits.maximumAnnotationsPerComposition}.`);
  }
  const bindingsByCamera = new Map<string, ReferenceGeoAnnotationBinding[]>();
  for (const node of annotations) {
    const config = referenceGeoAnnotationConfig(ir, composition, node)!;
    const direct = (parents.get(node.id) ?? []).filter(selected);
    if (direct.length !== 1 || direct[0].op !== "cut.visual.depth_layer") {
      fail(node, "CUT_GEO_ANNOTATION_GRAPH", `must have exactly one direct DepthLayer parent; found ${direct.length === 0 ? "none" : direct.map((parent) => parent.op).join(", ")}.`);
    }
    const layer = direct[0], cameraParents = (parents.get(layer.id) ?? []).filter(selected);
    if (cameraParents.length !== 1 || cameraParents[0].op !== "cut.visual.parallax_camera") {
      fail(node, "CUT_GEO_ANNOTATION_GRAPH", `owning DepthLayer ${layer.id} must have exactly one direct ParallaxCamera parent.`);
    }
    const camera = cameraParents[0], parallax = parallaxConfigs.get(camera.id);
    if (!parallax) fail(node, "CUT_GEO_ANNOTATION_GRAPH", `owning ParallaxCamera ${camera.id} has no validated configuration.`);
    const layerConfig = parallax.layers.find((candidate) => candidate.nodeId === layer.id);
    if (!layerConfig) fail(node, "CUT_GEO_ANNOTATION_GRAPH", `owning DepthLayer ${layer.id} is absent from camera ${camera.id}.`);
    const child = ir.nodes[config.childId];
    if (!child || !referenceGeoAnnotationIntervalsEqual(node, child)) {
      fail(node, "CUT_GEO_ANNOTATION_GRAPH", `child ${config.childId} must have exactly the annotation's half-open interval.`);
    }
    const childParents = (parents.get(config.childId) ?? []).filter(selected);
    if (childParents.length !== 1 || childParents[0].id !== node.id) {
      fail(node, "CUT_GEO_ANNOTATION_GRAPH", `child ${config.childId} must be owned directly and exclusively by this GeoAnnotation; found ${childParents.length === 0 ? "no parent" : childParents.map((parent) => parent.id).join(", ")}.`);
    }
    if (config.localSpace) {
      const retained = localSpaceConfigs.get(config.childId);
      if (!retained || retained.owner !== "geo-annotation" || retained.ownerNodeId !== node.id) {
        fail(node, "CUT_GEO_ANNOTATION_VIEWPORT", `LocalSpace child ${config.childId} is not the validated direct retained tile owned by this annotation.`);
      }
    }
    const binding = Object.freeze({
      config,
      layerId: layer.id,
      layerSourceOrder: layerConfig.sourceOrder,
      childSourceOrder: layer.children.indexOf(node.id),
    });
    const values = bindingsByCamera.get(camera.id) ?? [];
    values.push(binding);
    bindingsByCamera.set(camera.id, values);
  }

  const provisional = new Map<string, ReferenceGeoAnnotationCameraConfig>();
  for (const [cameraId, bindings] of bindingsByCamera) {
    const node = ir.nodes[bindings[0].config.nodeId]!;
    if (bindings.length > referenceGeoAnnotationLimits.maximumAnnotationsPerCamera) {
      fail(node, "CUT_GEO_ANNOTATION_LIMIT", `camera contains ${bindings.length} annotations; maximum is ${referenceGeoAnnotationLimits.maximumAnnotationsPerCamera}.`);
    }
    provisional.set(cameraId, Object.freeze({
      cameraId,
      annotations: Object.freeze([...bindings]),
      validation: Object.freeze({ exactSamples: 0, fallbackReached: Object.freeze({}), priorityAffected: Object.freeze([]), everAccepted: Object.freeze([]) }),
    }));
  }

  let totalSamples = 0, validationResolutionOperations = 0;
  const result = new Map<string, ReferenceGeoAnnotationCameraConfig>();
  for (const [cameraId, config] of provisional) {
    const parallax = parallaxConfigs.get(cameraId)!;
    const cameraNode = ir.nodes[cameraId]!;
    const times = referenceParallaxCameraValidationTimes(composition, cameraNode);
    const bindingsByLayer = new Map<string, ReferenceGeoAnnotationBinding[]>();
    for (const binding of config.annotations) {
      const values = bindingsByLayer.get(binding.layerId) ?? [];
      values.push(binding); bindingsByLayer.set(binding.layerId, values);
    }
    for (const [layerId, bindings] of bindingsByLayer) {
      const layer = ir.nodes[layerId]!;
      const ordinary = layer.children.filter((childId) => ir.nodes[childId]?.op !== "cut.geo.annotation");
      validateLayerMapAlignment(ir, composition, ir.nodes[bindings[0].config.nodeId]!, ordinary, times);
    }
    const fallbackReached = new Map(config.annotations.map((binding) => [binding.config.nodeId, new Set<number>([0])]));
    const priorityAffected = new Set<string>(), everAccepted = new Set<string>(), rgba8VisibleOpacity = new Set<string>();
    const sampledOpacity = new Map<string, Set<number>>();
    for (const time of times) {
      const activeCount = config.annotations.filter((binding) => referenceGeoAnnotationActive(ir.nodes[binding.config.nodeId]!, time)).length;
      totalSamples += activeCount;
      if (totalSamples > referenceGeoAnnotationLimits.maximumValidationSamplesPerComposition) {
        fail(ir.nodes[config.annotations[0].config.nodeId]!, "CUT_GEO_ANNOTATION_LIMIT", `composition exceeds ${referenceGeoAnnotationLimits.maximumValidationSamplesPerComposition} active annotation validation samples.`);
      }
      const cameraPlan = referenceParallaxCameraPlanAt(ir, composition, parallax, time);
      const plan = referenceGeoAnnotationPlanAt(ir, composition, config, parallax, time, cameraPlan);
      validationResolutionOperations += plan.work.activeAnnotations + plan.work.candidateEvaluations + plan.work.candidateCollisionTests;
      if (!Number.isSafeInteger(validationResolutionOperations)
        || validationResolutionOperations > referenceGeoAnnotationLimits.maximumValidationResolutionOperationsPerComposition) {
        fail(ir.nodes[config.annotations[0].config.nodeId]!, "CUT_GEO_ANNOTATION_LIMIT", `composition exceeds ${referenceGeoAnnotationLimits.maximumValidationResolutionOperationsPerComposition} aggregate annotation validation resolution operations.`);
      }
      for (const decision of plan.decisions) {
        if (Math.round(255 * decision.opacity) > 0) rgba8VisibleOpacity.add(decision.nodeId);
        const values = sampledOpacity.get(decision.nodeId) ?? new Set<number>(); values.add(decision.opacity); sampledOpacity.set(decision.nodeId, values);
        if (decision.status === "accepted") {
          everAccepted.add(decision.nodeId);
          fallbackReached.get(decision.nodeId)?.add(decision.chosenPlacementIndex!);
        }
      }
      for (const binding of config.annotations.filter((candidate) => candidate.config.priorityAuthored)) {
        const counterfactual = referenceGeoAnnotationPlanAt(ir, composition, config, parallax, time, cameraPlan, new Map([[binding.config.nodeId, 0]]));
        validationResolutionOperations += counterfactual.work.activeAnnotations + counterfactual.work.candidateEvaluations + counterfactual.work.candidateCollisionTests;
        if (!Number.isSafeInteger(validationResolutionOperations)
          || validationResolutionOperations > referenceGeoAnnotationLimits.maximumValidationResolutionOperationsPerComposition) {
          fail(ir.nodes[binding.config.nodeId]!, "CUT_GEO_ANNOTATION_LIMIT", `composition exceeds ${referenceGeoAnnotationLimits.maximumValidationResolutionOperationsPerComposition} aggregate annotation validation resolution operations while proving authored priority.`);
        }
        const actual = plan.decisions.find((decision) => decision.nodeId === binding.config.nodeId);
        const reset = counterfactual.decisions.find((decision) => decision.nodeId === binding.config.nodeId);
        if (!samePlacementDecision(actual, reset)) priorityAffected.add(binding.config.nodeId);
      }
    }
    for (const binding of config.annotations) {
      const node = ir.nodes[binding.config.nodeId]!;
      if (!rgba8VisibleOpacity.has(node.id)) fail(node, "CUT_GEO_ANNOTATION_NOOP", "opacity never reaches the first fully-opaque RGBA8 visibility step at an exact executed camera sample.");
      if (!everAccepted.has(node.id)) fail(node, "CUT_GEO_ANNOTATION_NOOP", "never produces an accepted viewport at any exact executed camera sample.");
      const reached = fallbackReached.get(node.id)!;
      for (let index = 1; index < binding.config.placements.length; index += 1) if (!reached.has(index)) {
        fail(node, "CUT_GEO_ANNOTATION_NOOP", `placement fallback index ${index} (${binding.config.placements[index]}) is never selected at a bounded exact camera sample.`);
      }
      if (binding.config.priorityAuthored && !priorityAffected.has(node.id)) {
        fail(node, "CUT_GEO_ANNOTATION_NOOP", "authored priority does not change this annotation's placement or visibility versus priority zero at any bounded exact camera sample.");
      }
      const baseline = node.inputs.opacity?.kind === "quantity" ? rationalToNumber(node.inputs.opacity.magnitude) : 1;
      if (node.properties.opacity !== undefined && [...(sampledOpacity.get(node.id) ?? [])].every((value) => value === baseline)) {
        fail(node, "CUT_GEO_ANNOTATION_NOOP", "authored opacity property never differs from its constructor/default baseline at an exact camera sample.");
      }
    }
    result.set(cameraId, Object.freeze({
      ...config,
      validation: Object.freeze({
        exactSamples: times.length,
        fallbackReached: Object.freeze(Object.fromEntries([...fallbackReached].map(([id, indices]) => [id, Object.freeze([...indices].sort((a, b) => a - b))]))),
        priorityAffected: Object.freeze([...priorityAffected].sort()),
        everAccepted: Object.freeze([...everAccepted].sort()),
      }),
    }));
  }
  return result;
}

/** Static, asset-free inspection derived from the exact first camera sample. */
export function referenceGeoAnnotationInspect(
  ir: CutAVIR,
  composition: IRComposition,
  config: ReferenceGeoAnnotationCameraConfig,
  parallaxConfig: ReferenceParallaxCameraConfig,
) {
  const camera = ir.nodes[config.cameraId];
  if (!camera) throw new Error(`Internal CUT GeoAnnotation camera ${config.cameraId} is missing.`);
  const time = referenceParallaxCameraValidationTimes(composition, camera)[0];
  const plan = referenceGeoAnnotationPlanAt(ir, composition, config, parallaxConfig, time);
  return new Map(config.annotations.map((binding) => {
    const decision = plan.decisions.find((candidate) => candidate.nodeId === binding.config.nodeId);
    if (!decision) throw new Error(`Internal CUT GeoAnnotation ${binding.config.nodeId} has no first-sample decision.`);
    return [binding.config.nodeId, Object.freeze({
      kind: "fixed-map-camera-overlay" as const,
      algorithmVersion: referenceGeoAnnotationAlgorithmVersion,
      projection: "shared-natural-earth-map-then-owning-depth-layer-affine" as const,
      owningCameraId: config.cameraId,
      owningLayerId: binding.layerId,
      structuralOrder: { layer: binding.layerSourceOrder, child: binding.childSourceOrder },
      anchor: { ...binding.config.anchor },
      viewport: {
        width: binding.config.width,
        height: binding.config.height,
        cropLeft: binding.config.cropLeft,
        cropTop: binding.config.cropTop,
        coordinateSpace: "ParallaxCamera-output-delivery-pixels" as const,
        ...(binding.config.localSpace ? {
          source: "direct-LocalSpace-retained-tile" as const,
          localSpaceId: binding.config.localSpace.nodeId,
          origin: { ...binding.config.localSpace.origin },
          rasterOriginQ16: { ...binding.config.localSpace.rasterOriginQ16 },
          legacyDeliveryCanvasCrop: false as const,
        } : {}),
      },
      placements: [...binding.config.placements],
      offset: binding.config.offset,
      safeArea: binding.config.safeArea,
      priority: { value: binding.config.priority, authored: binding.config.priorityAuthored },
      leader: {
        kind: binding.config.leader,
        ...(binding.config.leaderColor ? { color: binding.config.leaderColor, width: binding.config.leaderWidth } : {}),
        paintOrder: "leader-before-own-viewport" as const,
      },
      child: {
        nodeId: binding.config.childId,
        semanticIdentity: referenceParallaxNodeSemanticIdentity(ir, binding.config.childId),
        ...(binding.config.localSpace ? { execution: "bounded-local-tile" as const } : {}),
      },
      validation: {
        exactSamples: config.validation.exactSamples,
        fallbackReached: config.validation.fallbackReached[binding.config.nodeId] ?? [],
        priorityAffected: config.validation.priorityAffected.includes(binding.config.nodeId),
        everAccepted: config.validation.everAccepted.includes(binding.config.nodeId),
      },
      firstSample: {
        exactTime: { ...plan.exactTime },
        camera: { ...plan.camera },
        decision: { ...decision },
        decisionIdentity: plan.decisionIdentity,
        work: { ...plan.work },
      },
      collision: {
        rectangles: "integer-half-open-positive-area-overlap" as const,
        touching: "not-collision" as const,
        resolution: "priority-descending-then-structural-order" as const,
        paint: "reverse-resolution-low-priority-first" as const,
      },
      limits: referenceGeoAnnotationLimits,
    })];
  }));
}
