import { hash } from "../../core/stable";
import type { CutAVIR, IRComposition, IRNode, IRSignal, IRValue } from "../../language/ir";
import {
  addRational,
  compareRational,
  divideRational,
  multiplyRational,
  rational,
  rationalToNumber,
  type Rational,
} from "../../language/rational";
import { propertyAt } from "./signals";
import { validateReferenceEasings } from "./easing";
import { referenceLocalSpaceRasterOrigin, validateReferenceLocalSpaceGraph, type ReferenceLocalSpaceConfig } from "./local-space";
import {
  planReferenceLocalSpaceCompositionTransformWork,
  planReferenceLocalSpaceTileTransformWork,
  referenceLocalSpaceTransformRendererHandoff,
  type ReferenceLocalSpaceCompositionTransformRequest,
  type ReferenceLocalSpaceUniformCompositionTransformWork,
  type ReferenceLocalSpaceUniformTileTransformWork,
  type ReferenceLocalSpaceTransformRequest,
} from "./local-space-transform-work";
import {
  referenceAffine2D,
  referenceRect,
  transformReferencePoint,
  transformReferenceRect,
  type ReferenceAffine2D,
  type ReferenceRect,
} from "./retained-visual";

/**
 * One shared typed camera driving parallel retained planes. This is a closed,
 * deterministic 2.5D model, not a 3D scene graph or a Camera3D substitute.
 */
export const referenceParallaxCameraAlgorithmVersion = "cut-reference-parallax-camera-v2" as const;
export const referenceParallaxCameraProjection = "planar-perspective" as const;
export const referenceParallaxCameraPlanBackendIdentity = "cut-reference-parallax-plan-only-v1" as const;

export const referenceParallaxCameraLimits = Object.freeze({
  maximumLayers: 64,
  maximumDirectChildrenPerLayer: 16,
  maximumAbsoluteCoordinatePx: 65_536,
  minimumFocalLengthPx: 1,
  maximumFocalLengthPx: 65_536,
  minimumProjectionScale: 0.05,
  maximumProjectionScale: 20,
  maximumFocusRangePx: 65_536,
  minimumFocusBlurSigmaPx: 0.3,
  maximumBlurSigmaPx: 64,
  maximumValidationSamples: 250_000,
  maximumExtendedRasterAxis: 16_384,
  maximumExtendedRasterPixels: 67_108_864,
  maximumProjectedRasterAxis: 16_384,
  maximumProjectedRasterPixels: 67_108_864,
  maximumAggregateLayerPixels: 268_435_456,
  maximumAggregateLayerBytes: 1_073_741_824,
  maximumCompositionCameraPixels: 268_435_456,
  maximumCompositionCameraBytes: 1_073_741_824,
  maximumCompositionCameraFrameSamples: 250_000,
  clampAntialiasGuardPx: 2,
});

export type ReferenceParallaxCameraErrorCode =
  | "CUT_PARALLAX_TYPE"
  | "CUT_PARALLAX_GRAPH"
  | "CUT_PARALLAX_RANGE"
  | "CUT_PARALLAX_PROJECTION"
  | "CUT_PARALLAX_FOCUS"
  | "CUT_PARALLAX_ORDERING"
  | "CUT_PARALLAX_EDGE"
  | "CUT_PARALLAX_LIMIT"
  | "CUT_PARALLAX_NOOP";

export class ReferenceParallaxCameraError extends Error {
  readonly source: { module: string; line: number; column: number; nodeId: string };

  constructor(readonly code: ReferenceParallaxCameraErrorCode, readonly nodeId: string, node: IRNode, detail: string) {
    const { module, span } = node.provenance;
    super(`${code}: ${node.op === "cut.visual.depth_layer" ? "DepthLayer" : "ParallaxCamera"} at ${module}:${span.start.line}:${span.start.column} ${detail}`);
    this.name = "ReferenceParallaxCameraError";
    this.source = { module, line: span.start.line, column: span.start.column, nodeId };
  }
}

export type ReferenceParallaxOrdering = "depth" | "source";
export type ReferenceParallaxFocusMode = "off" | "linear";
export type ReferenceDepthLayerEdge = "transparent" | "clamp";

export type ReferenceDepthLayerConfig = Readonly<{
  nodeId: string;
  depth: number;
  edge: ReferenceDepthLayerEdge;
  sourceOrder: number;
  childIds: readonly string[];
  /** Present only when direct GeoAnnotation children are deferred to the camera overlay pass. */
  ordinaryChildIds?: readonly string[];
  geoAnnotationIds?: readonly string[];
  /** Present only for the exact direct `DepthLayer { LocalSpace { ... } }`
   * planning boundary. Pixel execution is a separate renderer handoff. */
  localSpaceSource?: Readonly<{
    nodeId: string;
    width: number;
    height: number;
    origin: ReferenceLocalSpaceConfig["origin"];
    rasterOriginQ16: ReferenceLocalSpaceConfig["rasterOriginQ16"];
    view: ReferenceLocalSpaceConfig["view"];
    semanticIdentity: string;
  }>;
}>;

export type ReferenceParallaxFocusConfig =
  | Readonly<{ mode: "off" }>
  | Readonly<{ mode: "linear"; range: number; maxBlur: number }>;

export type ReferenceParallaxCameraConfig = Readonly<{
  nodeId: string;
  projection: typeof referenceParallaxCameraProjection;
  focalLength: number;
  ordering: ReferenceParallaxOrdering;
  focus: ReferenceParallaxFocusConfig;
  layers: readonly ReferenceDepthLayerConfig[];
}>;

export type ReferenceParallaxCameraState = Readonly<{
  x: number;
  y: number;
  z: number;
  focusDepth?: number;
}>;

export type ReferenceParallaxClampPadding = Readonly<{
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  pixels: number;
  needed: boolean;
  /** Clamp replicates only the selected source surface's declared border. */
  sourceBoundary: "materialized-canvas-border" | "declared-local-space-border";
}>;

export type ReferenceParallaxLayerSourceSpace = Readonly<{
  kind: "composition-canvas" | "local-space";
  width: number;
  height: number;
  /** Exact authored bounds remain inspectable and semantic without collapsing
   * sub-Q16 differences when translated by a large composition centre. */
  authoredParentBounds: Readonly<{ minX: Rational; minY: Rational; maxX: Rational; maxY: Rational }>;
  /** Q16-quantized raster bounds drive clamp/allocation/pixel execution. */
  rasterParentBounds: ReferenceRect;
  /** Raster point corresponding to `parentRegistration`. */
  rasterRegistration: Readonly<{ x: number; y: number }>;
  parentRegistration: Readonly<{ x: number; y: number }>;
  localSpaceNodeId?: string;
  localSpaceSemanticIdentity?: string;
  rendererHandoff: "legacy-full-canvas" | typeof referenceLocalSpaceTransformRendererHandoff;
}>;

export type ReferenceParallaxLayerSourcePlacement = Readonly<{
  rasterRegistration: Readonly<{ x: number; y: number }>;
  destinationRegistration: Readonly<{ x: number; y: number }>;
  scale: number;
}>;

export type ReferenceParallaxProjectedRaster = Readonly<{
  sourceWidth: number;
  sourceHeight: number;
  width: number;
  height: number;
  pixels: number;
  bytes: number;
  allocated: boolean;
}>;

export type ReferenceParallaxLayerFrame = Readonly<{
  nodeId: string;
  sourceOrder: number;
  paintOrder: number;
  depth: number;
  edge: ReferenceDepthLayerEdge;
  opticalDistance: number;
  projectionScale: number;
  matrix: ReferenceAffine2D;
  projectedCanvasBounds: ReferenceRect;
  sourceSpace: ReferenceParallaxLayerSourceSpace;
  materialization: "composition-canvas" | "retained-local-space";
  projectedSourceBounds: ReferenceRect;
  sourcePlacement: ReferenceParallaxLayerSourcePlacement;
  focusRawSigma: number;
  focusBlurSigma: number;
  clamp: ReferenceParallaxClampPadding;
  projectedRaster: ReferenceParallaxProjectedRaster;
  activeDirectChildSurfaces: number;
  activeDirectChildPixels: number;
  /** Present only for an active retained LocalSpace source. This is the exact
   * shared allocator receipt for post-edge-policy source dimensions. */
  localSpaceTransformWork?: ReferenceLocalSpaceUniformTileTransformWork;
}>;

export type ReferenceParallaxCameraFramePlan = Readonly<{
  algorithmVersion: typeof referenceParallaxCameraAlgorithmVersion;
  projection: typeof referenceParallaxCameraProjection;
  exactTime: Rational;
  state: ReferenceParallaxCameraState;
  layers: readonly ReferenceParallaxLayerFrame[];
  pipeline: readonly [
    "materialize-layer-source",
    "apply-source-edge-policy",
    "project-and-delivery-crop",
    "delivery-space-focus-blur",
    "paint-order-composite",
  ];
  work: Readonly<{
    layerSurfaces: number;
    clampLayers: number;
    focusPasses: number;
    aggregateDirectChildPixels: number;
    aggregateLayerCompositePixels: number;
    aggregateClampPixels: number;
    aggregateProjectedResizePixels: number;
    aggregateProjectedDeliveryPixels: number;
    aggregateFocusPixels: number;
    aggregateCameraCompositePixels: number;
    aggregateLayerPixels: number;
    aggregateLayerBytes: number;
    /** Omitted when every active layer uses the ordinary composition canvas. */
    localSpaceTransformAggregate?: ReferenceLocalSpaceUniformCompositionTransformWork;
  }>;
  semanticIdentity: string;
  cacheIdentity: string;
}>;

function fail(node: IRNode, code: ReferenceParallaxCameraErrorCode, detail: string): never {
  throw new ReferenceParallaxCameraError(code, node.id, node, detail);
}

function active(node: IRNode, time: Rational) {
  const end = addRational(node.interval.start, node.interval.duration);
  return compareRational(time, node.interval.start) >= 0 && compareRational(time, end) < 0;
}

function intervalContains(outer: IRNode, inner: IRNode) {
  const outerEnd = addRational(outer.interval.start, outer.interval.duration);
  const innerEnd = addRational(inner.interval.start, inner.interval.duration);
  return compareRational(inner.interval.start, outer.interval.start) >= 0 && compareRational(innerEnd, outerEnd) <= 0;
}

function length(
  node: IRNode,
  value: IRValue | undefined,
  label: string,
  minimum: number,
  maximum: number,
  code: ReferenceParallaxCameraErrorCode = "CUT_PARALLAX_RANGE",
) {
  if (value?.kind !== "quantity" || value.dimension !== "length" || value.unit !== "px") {
    fail(node, "CUT_PARALLAX_TYPE", `${label} must be a canonical Length in px.`);
  }
  const result = rationalToNumber(value.magnitude);
  if (!Number.isFinite(result) || result < minimum || result > maximum) {
    fail(node, code, `${label} must be finite from ${minimum}px through ${maximum}px.`);
  }
  return Object.is(result, -0) ? 0 : result;
}

function optionalLength(
  node: IRNode,
  value: IRValue | undefined,
  label: string,
  minimum: number,
  maximum: number,
  fallback: number,
) {
  return value === undefined ? fallback : length(node, value, label, minimum, maximum);
}

function stringChoice<T extends string>(
  node: IRNode,
  name: string,
  values: readonly T[],
  fallback: T,
  code: ReferenceParallaxCameraErrorCode,
) {
  const value = node.inputs[name];
  if (value === undefined) return fallback;
  if (value.kind !== "string" || !values.includes(value.value as T)) {
    fail(node, code, `input “${name}” must be one of: ${values.join(", ")}.`);
  }
  return value.value as T;
}

function signalValues(signal: IRSignal) {
  if (signal.kind === "constant") return [{ label: ".value", value: signal.value, allowNull: false }];
  if (signal.kind === "step") return signal.points.map((point, index) => ({ label: `.points[${index}].value`, value: point.value, allowNull: false }));
  if (signal.kind === "keyframes") return signal.keyframes.map((point, index) => ({ label: `.keyframes[${index}].value`, value: point.value, allowNull: false }));
  return [
    { label: ".initial", value: signal.initial, allowNull: true },
    ...signal.events.flatMap((event, index) => event.kind === "set"
      ? [{ label: `.events[${index}].value`, value: event.value, allowNull: false }]
      : [
        { label: `.events[${index}].from`, value: event.from, allowNull: false },
        { label: `.events[${index}].to`, value: event.to, allowNull: false },
      ]),
  ];
}

function validateLengthProperty(ir: CutAVIR, node: IRNode, name: "x" | "y" | "z" | "focusDepth") {
  const authored = node.properties[name];
  if (authored === undefined) return;
  if (!("signal" in authored)) {
    length(node, authored, `property “${name}”`, -referenceParallaxCameraLimits.maximumAbsoluteCoordinatePx, referenceParallaxCameraLimits.maximumAbsoluteCoordinatePx);
    return;
  }
  const signal = ir.signals[authored.signal];
  if (!signal) fail(node, "CUT_PARALLAX_TYPE", `property “${name}” references missing signal ${authored.signal}.`);
  if (signal.valueType !== "Length") fail(node, "CUT_PARALLAX_TYPE", `property “${name}” signal ${signal.id} must declare valueType Length.`);
  for (const item of signalValues(signal)) {
    if (item.allowNull && item.value.kind === "null") continue;
    length(node, item.value, `property “${name}” signal ${signal.id}${item.label}`, -referenceParallaxCameraLimits.maximumAbsoluteCoordinatePx, referenceParallaxCameraLimits.maximumAbsoluteCoordinatePx);
  }
}

function validateConstructorBaselineOwnership(ir: CutAVIR, node: IRNode, name: "x" | "y" | "z" | "focusDepth") {
  const input = node.inputs[name], property = node.properties[name];
  if (input === undefined || property === undefined) return;
  if (!("signal" in property)) {
    fail(node, "CUT_PARALLAX_NOOP", `property “${name}” shadows the same-named constructor input for the complete interval; author one control path.`);
  }
  const executed = propertyAt(ir, node, name, node.interval.start);
  if (executed?.kind !== "quantity" || executed.dimension !== "length" || executed.unit !== "px"
    || input.kind !== "quantity" || input.dimension !== "length" || input.unit !== "px") {
    // The closed type validator reports the malformed value after this helper
    // declines to claim baseline ownership.
    fail(node, "CUT_PARALLAX_TYPE", `input/property “${name}” cannot establish one canonical Length baseline.`);
  }
  if (compareRational(executed.magnitude, input.magnitude) !== 0) {
    fail(node, "CUT_PARALLAX_NOOP", `input “${name}” is immediately shadowed at the first executed sample; its value must equal the signal baseline or be omitted.`);
  }
}

function exactCameraLength(ir: CutAVIR, node: IRNode, property: "x" | "y" | "z" | "focusDepth", time: Rational, fallback: number) {
  const sampled = propertyAt(ir, node, property, time) ?? node.inputs[property];
  return optionalLength(
    node,
    sampled,
    `executed ${property}`,
    -referenceParallaxCameraLimits.maximumAbsoluteCoordinatePx,
    referenceParallaxCameraLimits.maximumAbsoluteCoordinatePx,
    fallback,
  );
}

function unknownControls(node: IRNode, allowedInputs: readonly string[], allowedProperties: readonly string[]) {
  const unknownInput = Object.keys(node.inputs).find((name) => !allowedInputs.includes(name));
  if (unknownInput === "projection") {
    fail(node, "CUT_PARALLAX_PROJECTION", "projection is fixed to planar-perspective by this deterministic 2.5D kernel; an authored projection selector would be redundant.");
  }
  if (unknownInput !== undefined) fail(node, "CUT_PARALLAX_TYPE", `input “${unknownInput}” is not part of the closed public contract.`);
  const unknownProperty = Object.keys(node.properties).find((name) => !allowedProperties.includes(name));
  if (unknownProperty !== undefined) fail(node, "CUT_PARALLAX_TYPE", `property “${unknownProperty}” is not part of the closed public contract.`);
}

export function referenceDepthLayerConfig(
  node: IRNode,
  sourceOrder = 0,
  localSpaces?: ReadonlyMap<string, ReferenceLocalSpaceConfig>,
): ReferenceDepthLayerConfig | undefined {
  if (node.op !== "cut.visual.depth_layer") return undefined;
  unknownControls(node, ["depth", "edge"], []);
  if (node.domain !== "visual") fail(node, "CUT_PARALLAX_GRAPH", `must have visual domain, found ${node.domain}.`);
  if (node.children.length < 1) fail(node, "CUT_PARALLAX_GRAPH", "requires at least one direct visual child.");
  if (node.children.length > referenceParallaxCameraLimits.maximumDirectChildrenPerLayer) {
    fail(node, "CUT_PARALLAX_LIMIT", `accepts at most ${referenceParallaxCameraLimits.maximumDirectChildrenPerLayer} direct visual children in this v1 slice; found ${node.children.length}.`);
  }
  const depth = length(
    node,
    node.inputs.depth,
    "input “depth”",
    -referenceParallaxCameraLimits.maximumAbsoluteCoordinatePx,
    referenceParallaxCameraLimits.maximumAbsoluteCoordinatePx,
  );
  const authoredEdge = node.inputs.edge;
  if (authoredEdge === undefined) fail(node, "CUT_PARALLAX_EDGE", "requires explicit input “edge”: transparent or clamp.");
  const edge = stringChoice(node, "edge", ["transparent", "clamp"] as const, "transparent", "CUT_PARALLAX_EDGE");
  const localChildIds = node.children.filter((childId) => localSpaces?.has(childId));
  if (localChildIds.length) {
    if (node.children.length !== 1 || localChildIds.length !== 1) {
      fail(node, "CUT_PARALLAX_GRAPH", "a DepthLayer using a local coordinate basis must own exactly one direct LocalSpace and no delivery-canvas siblings.");
    }
    const local = localSpaces!.get(localChildIds[0]!)!;
    return Object.freeze({
      nodeId: node.id,
      depth,
      edge,
      sourceOrder,
      childIds: Object.freeze([...node.children]),
      localSpaceSource: Object.freeze({
        nodeId: local.nodeId,
        width: local.width,
        height: local.height,
        origin: local.origin,
        rasterOriginQ16: local.rasterOriginQ16,
        view: local.view,
        semanticIdentity: local.semanticIdentity,
      }),
    });
  }
  return Object.freeze({ nodeId: node.id, depth, edge, sourceOrder, childIds: Object.freeze([...node.children]) });
}

function focusConfig(node: IRNode): ReferenceParallaxFocusConfig {
  const mode = stringChoice(node, "focus", ["off", "linear"] as const, "off", "CUT_PARALLAX_FOCUS");
  if (mode === "off") {
    if (node.inputs.focus?.kind === "string" && node.inputs.focus.value === "off") {
      fail(node, "CUT_PARALLAX_NOOP", "authored focus: off repeats the default; omit it.");
    }
    const forbidden = ["focusDepth", "focusRange", "maxBlur"].filter((name) => node.inputs[name] !== undefined || node.properties[name] !== undefined);
    if (forbidden.length) fail(node, "CUT_PARALLAX_FOCUS", `focus is off, so ${forbidden.map((name) => `“${name}”`).join(", ")} would not execute.`);
    return Object.freeze({ mode: "off" });
  }
  if (node.inputs.focusDepth === undefined) fail(node, "CUT_PARALLAX_FOCUS", "focus: linear requires input “focusDepth” as its typed initial value.");
  const range = length(node, node.inputs.focusRange, "input “focusRange”", Number.MIN_VALUE, referenceParallaxCameraLimits.maximumFocusRangePx, "CUT_PARALLAX_FOCUS");
  const maxBlur = length(node, node.inputs.maxBlur, "input “maxBlur”", referenceParallaxCameraLimits.minimumFocusBlurSigmaPx, referenceParallaxCameraLimits.maximumBlurSigmaPx, "CUT_PARALLAX_FOCUS");
  return Object.freeze({ mode, range, maxBlur });
}

function authoredNeutralCameraControl(ir: CutAVIR, composition: IRComposition, node: IRNode, property: "x" | "y" | "z", times: readonly Rational[]) {
  if (node.inputs[property] === undefined && node.properties[property] === undefined) return;
  const values = times.map((time) => exactCameraLength(ir, node, property, time, 0));
  if (!values.some((value) => value !== 0)) fail(node, "CUT_PARALLAX_NOOP", `authored ${property} remains exactly 0px at every executed output-frame sample.`);
  if (values.length > referenceParallaxCameraLimits.maximumValidationSamples) {
    fail(node, "CUT_PARALLAX_LIMIT", `cannot prove ${property} execution beyond ${referenceParallaxCameraLimits.maximumValidationSamples} samples.`);
  }
  void composition;
}

function directParents(ir: CutAVIR) {
  const result = new Map<string, IRNode[]>();
  for (const parent of Object.values(ir.nodes)) for (const child of parent.children) {
    const parents = result.get(child) ?? [];
    parents.push(parent);
    result.set(child, parents);
  }
  return result;
}

function hasReachableAncestorOperation(
  parents: ReadonlyMap<string, readonly IRNode[]>,
  nodeId: string,
  operation: string,
  selected: (node: IRNode) => boolean,
) {
  const pending = [...(parents.get(nodeId) ?? [])], visited = new Set<string>();
  while (pending.length) {
    const candidate = pending.pop()!;
    if (visited.has(candidate.id)) continue;
    visited.add(candidate.id);
    if (!selected(candidate)) continue;
    if (candidate.op === operation) return true;
    pending.push(...(parents.get(candidate.id) ?? []));
  }
  return false;
}

function ceilRational(value: Rational) {
  const numerator = BigInt(value.numerator), denominator = BigInt(value.denominator);
  if (numerator >= 0n) return (numerator + denominator - 1n) / denominator;
  return numerator / denominator;
}

/** Exact ordinary output-frame samples in the camera's half-open interval. */
export function referenceParallaxCameraValidationTimes(composition: IRComposition, node: IRNode) {
  const startFrame = ceilRational(multiplyRational(node.interval.start, composition.fps));
  const endFrame = ceilRational(multiplyRational(addRational(node.interval.start, node.interval.duration), composition.fps));
  const count = endFrame - startFrame;
  if (count < 1n) fail(node, "CUT_PARALLAX_GRAPH", "has no exact output-frame sample in its half-open interval.");
  if (count > BigInt(referenceParallaxCameraLimits.maximumValidationSamples)) {
    fail(node, "CUT_PARALLAX_LIMIT", `requires ${count} output-frame samples; the deterministic no-op proof limit is ${referenceParallaxCameraLimits.maximumValidationSamples}.`);
  }
  const result: Rational[] = [];
  for (let frame = startFrame; frame < endFrame; frame += 1n) result.push(divideRational(rational(frame), composition.fps));
  return Object.freeze(result);
}

export function referenceParallaxCameraStateAt(ir: CutAVIR, node: IRNode, focus: ReferenceParallaxFocusConfig, time: Rational): ReferenceParallaxCameraState {
  const x = exactCameraLength(ir, node, "x", time, 0);
  const y = exactCameraLength(ir, node, "y", time, 0);
  const z = exactCameraLength(ir, node, "z", time, 0);
  if (focus.mode === "off") return Object.freeze({ x, y, z });
  return Object.freeze({ x, y, z, focusDepth: exactCameraLength(ir, node, "focusDepth", time, 0) });
}

function projectionMatrix(composition: IRComposition, camera: ReferenceParallaxCameraState, scale: number) {
  const centerX = composition.width / 2, centerY = composition.height / 2;
  return referenceAffine2D({
    a: scale,
    b: 0,
    c: 0,
    d: scale,
    tx: centerX * (1 - scale) - scale * camera.x,
    ty: centerY * (1 - scale) - scale * camera.y,
  });
}

function layerSourceSpace(composition: IRComposition, layer: ReferenceDepthLayerConfig): ReferenceParallaxLayerSourceSpace {
  const centerX = composition.width / 2, centerY = composition.height / 2;
  const exactCenterX = rational(composition.width, 2), exactCenterY = rational(composition.height, 2);
  const local = layer.localSpaceSource;
  if (!local) return Object.freeze({
    kind: "composition-canvas" as const,
    width: composition.width,
    height: composition.height,
    authoredParentBounds: Object.freeze({ minX: rational(0), minY: rational(0), maxX: rational(composition.width), maxY: rational(composition.height) }),
    rasterParentBounds: referenceRect(0, 0, composition.width, composition.height),
    rasterRegistration: Object.freeze({ x: centerX, y: centerY }),
    parentRegistration: Object.freeze({ x: centerX, y: centerY }),
    rendererHandoff: "legacy-full-canvas" as const,
  });
  const authoredParentBounds = Object.freeze({
    minX: addRational(exactCenterX, local.view.minX),
    minY: addRational(exactCenterY, local.view.minY),
    maxX: addRational(exactCenterX, local.view.maxX),
    maxY: addRational(exactCenterY, local.view.maxY),
  });
  const rasterRegistration = referenceLocalSpaceRasterOrigin(local);
  const rasterMinX = centerX - rasterRegistration.x, rasterMinY = centerY - rasterRegistration.y;
  return Object.freeze({
    kind: "local-space" as const,
    width: local.width,
    height: local.height,
    authoredParentBounds,
    rasterParentBounds: referenceRect(rasterMinX, rasterMinY, rasterMinX + local.width, rasterMinY + local.height),
    rasterRegistration,
    parentRegistration: Object.freeze({ x: centerX, y: centerY }),
    localSpaceNodeId: local.nodeId,
    localSpaceSemanticIdentity: local.semanticIdentity,
    rendererHandoff: referenceLocalSpaceTransformRendererHandoff,
  });
}

function clampPadding(
  composition: IRComposition,
  matrix: ReferenceAffine2D,
  source: ReferenceParallaxLayerSourceSpace,
): ReferenceParallaxClampPadding {
  const scale = matrix.a;
  const guard = referenceParallaxCameraLimits.clampAntialiasGuardPx;
  const inverseMinimumX = (0 - matrix.tx) / scale;
  const inverseMaximumX = (composition.width - matrix.tx) / scale;
  const inverseMinimumY = (0 - matrix.ty) / scale;
  const inverseMaximumY = (composition.height - matrix.ty) / scale;
  const rawLeft = Math.max(0, source.rasterParentBounds.minX - inverseMinimumX);
  const rawRight = Math.max(0, inverseMaximumX - source.rasterParentBounds.maxX);
  const rawTop = Math.max(0, source.rasterParentBounds.minY - inverseMinimumY);
  const rawBottom = Math.max(0, inverseMaximumY - source.rasterParentBounds.maxY);
  const needed = rawLeft > 1e-9 || rawRight > 1e-9 || rawTop > 1e-9 || rawBottom > 1e-9;
  const left = needed && rawLeft > 0 ? Math.ceil(rawLeft + guard) : 0;
  const right = needed && rawRight > 0 ? Math.ceil(rawRight + guard) : 0;
  const top = needed && rawTop > 0 ? Math.ceil(rawTop + guard) : 0;
  const bottom = needed && rawBottom > 0 ? Math.ceil(rawBottom + guard) : 0;
  const width = source.width + left + right, height = source.height + top + bottom, pixels = width * height;
  return Object.freeze({
    left,
    top,
    right,
    bottom,
    width,
    height,
    pixels,
    needed,
    sourceBoundary: source.kind === "local-space" ? "declared-local-space-border" as const : "materialized-canvas-border" as const,
  });
}

function validateClampAllocation(node: IRNode, clamp: ReferenceParallaxClampPadding) {
  if (clamp.width > referenceParallaxCameraLimits.maximumExtendedRasterAxis
    || clamp.height > referenceParallaxCameraLimits.maximumExtendedRasterAxis
    || clamp.pixels > referenceParallaxCameraLimits.maximumExtendedRasterPixels) {
    fail(
      node,
      "CUT_PARALLAX_LIMIT",
      `edge: clamp would allocate a ${clamp.width}x${clamp.height} extended raster; limits are ${referenceParallaxCameraLimits.maximumExtendedRasterAxis}px per axis and ${referenceParallaxCameraLimits.maximumExtendedRasterPixels} pixels.`,
    );
  }
}

function projectedRaster(
  node: IRNode,
  composition: IRComposition,
  edge: ReferenceDepthLayerEdge,
  matrix: ReferenceAffine2D,
  scale: number,
  clamp: ReferenceParallaxClampPadding,
  source: ReferenceParallaxLayerSourceSpace,
): ReferenceParallaxProjectedRaster {
  const sourceWidth = edge === "clamp" && clamp.needed ? clamp.width : source.width;
  const sourceHeight = edge === "clamp" && clamp.needed ? clamp.height : source.height;
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const pixels = width * height, bytes = pixels * 4;
  const centerX = composition.width / 2, centerY = composition.height / 2;
  const cameraOffsetX = matrix.tx - centerX * (1 - scale);
  const cameraOffsetY = matrix.ty - centerY * (1 - scale);
  const paddedCenterDeltaX = edge === "clamp" ? (clamp.left - clamp.right) / 2 : 0;
  const paddedCenterDeltaY = edge === "clamp" ? (clamp.top - clamp.bottom) / 2 : 0;
  const placementX = cameraOffsetX - scale * paddedCenterDeltaX;
  const placementY = cameraOffsetY - scale * paddedCenterDeltaY;
  const allocated = source.kind === "local-space" || !(scale === 1 && placementX === 0 && placementY === 0);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || !Number.isSafeInteger(pixels) || !Number.isSafeInteger(bytes)
    || width > referenceParallaxCameraLimits.maximumProjectedRasterAxis
    || height > referenceParallaxCameraLimits.maximumProjectedRasterAxis
    || pixels > referenceParallaxCameraLimits.maximumProjectedRasterPixels) {
    fail(
      node,
      "CUT_PARALLAX_LIMIT",
      `projection would resize the ${sourceWidth}x${sourceHeight} source raster to ${width}x${height} (${pixels} pixels / ${bytes} RGBA bytes); limits are ${referenceParallaxCameraLimits.maximumProjectedRasterAxis}px per axis and ${referenceParallaxCameraLimits.maximumProjectedRasterPixels} pixels.`,
    );
  }
  return Object.freeze({ sourceWidth, sourceHeight, width, height, pixels, bytes, allocated });
}

function localSpaceTransformRequest(
  composition: IRComposition,
  layer: ReferenceParallaxLayerFrame,
): ReferenceLocalSpaceTransformRequest {
  return Object.freeze({
    source: Object.freeze({
      width: layer.projectedRaster.sourceWidth,
      height: layer.projectedRaster.sourceHeight,
    }),
    destination: Object.freeze({ width: composition.width, height: composition.height }),
    scale: layer.projectionScale,
    rotation: 0,
    opacity: 1,
  });
}

function semanticValueIdentity(ir: CutAVIR, value: IRValue): unknown {
  if (value.kind === "resource-ref") {
    const resource = ir.resources[value.id];
    return {
      ...value,
      resource: resource ? {
        kind: resource.kind,
        locator: resource.locator,
        state: resource.state,
        sha256: resource.sha256,
        // Full locked probe/selection metadata is semantic here: changing a
        // selected stream or active variant can change decoded pixels without
        // changing the resource bytes.
        metadata: resource.metadata,
      } : null,
    };
  }
  if (value.kind === "array") return { ...value, items: value.items.map((item) => semanticValueIdentity(ir, item)) };
  if (value.kind === "object") return { ...value, entries: Object.fromEntries(Object.entries(value.entries).map(([key, item]) => [key, semanticValueIdentity(ir, item)])) };
  if (value.kind === "range") return { ...value, start: semanticValueIdentity(ir, value.start), end: semanticValueIdentity(ir, value.end) };
  if (value.kind === "unary") return { ...value, value: semanticValueIdentity(ir, value.value) };
  if (value.kind === "binary") return { ...value, left: semanticValueIdentity(ir, value.left), right: semanticValueIdentity(ir, value.right) };
  if (value.kind === "member") return { ...value, object: semanticValueIdentity(ir, value.object) };
  if (value.kind === "index") return { ...value, object: semanticValueIdentity(ir, value.object), index: semanticValueIdentity(ir, value.index) };
  if (value.kind === "call") return {
    ...value,
    positional: value.positional.map((item) => semanticValueIdentity(ir, item)),
    named: Object.fromEntries(Object.entries(value.named).map(([key, item]) => [key, semanticValueIdentity(ir, item)])),
  };
  return value;
}

export function referenceParallaxNodeSemanticIdentity(ir: CutAVIR, nodeId: string, memo = new Map<string, string>(), visiting = new Set<string>()): string {
  const cached = memo.get(nodeId);
  if (cached) return cached;
  const node = ir.nodes[nodeId];
  if (!node) throw new Error(`CUT ParallaxCamera cache graph references missing node ${nodeId}.`);
  if (visiting.has(nodeId)) fail(node, "CUT_PARALLAX_GRAPH", `cache identity found a visual cycle at node ${nodeId}.`);
  visiting.add(nodeId);
  const properties = Object.fromEntries(Object.entries(node.properties).map(([name, authored]) => {
    if (!("signal" in authored)) return [name, semanticValueIdentity(ir, authored)];
    const signal = ir.signals[authored.signal];
    return [name, {
      signal: authored.signal,
      contentHash: signal?.contentHash,
      semantic: signal
        ? Object.fromEntries(Object.entries(signal).filter(([key]) => key !== "provenance" && key !== "contentHash"))
        : null,
    }];
  }));
  const identity = hash({
    op: node.op,
    domain: node.domain,
    interval: node.interval,
    inputs: Object.fromEntries(Object.entries(node.inputs).map(([name, value]) => [name, semanticValueIdentity(ir, value)])),
    properties,
    children: node.children.map((child) => ({ id: child, identity: referenceParallaxNodeSemanticIdentity(ir, child, memo, visiting) })),
    editorial: node.editorial,
    effects: node.effects,
    canonicalContentHash: node.contentHash,
  });
  visiting.delete(nodeId);
  memo.set(nodeId, identity);
  return identity;
}

/** Resolve exact projection/focus/order/edge state for one runtime sample. */
export function referenceParallaxCameraPlanAt(
  ir: CutAVIR,
  composition: IRComposition,
  config: ReferenceParallaxCameraConfig,
  time: Rational,
  backendIdentity: string = referenceParallaxCameraPlanBackendIdentity,
): ReferenceParallaxCameraFramePlan {
  const cameraNode = ir.nodes[config.nodeId];
  if (!cameraNode || cameraNode.op !== "cut.visual.parallax_camera") throw new Error(`Internal CUT ParallaxCamera ${config.nodeId} is missing.`);
  const state = referenceParallaxCameraStateAt(ir, cameraNode, config.focus, time);
  const activeLayers = config.layers.filter((layer) => {
    const node = ir.nodes[layer.nodeId];
    return Boolean(node && active(node, time));
  });
  const ordered = config.ordering === "source"
    ? [...activeLayers]
    : [...activeLayers].sort((left, right) => right.depth - left.depth || left.sourceOrder - right.sourceOrder);
  const canvasBounds = referenceRect(0, 0, composition.width, composition.height);
  const baseLayers = ordered.map((layer, paintOrder): ReferenceParallaxLayerFrame => {
    const layerNode = ir.nodes[layer.nodeId];
    if (!layerNode) throw new Error(`Internal CUT DepthLayer ${layer.nodeId} is missing.`);
    const opticalDistance = config.focalLength + layer.depth - state.z;
    if (!Number.isFinite(opticalDistance) || opticalDistance <= 0) {
      fail(layerNode, "CUT_PARALLAX_PROJECTION", `has non-positive optical distance ${opticalDistance}px at ${time.numerator}/${time.denominator}s (focalLength + depth - camera.z).`);
    }
    const projectionScale = config.focalLength / opticalDistance;
    if (!Number.isFinite(projectionScale)
      || projectionScale < referenceParallaxCameraLimits.minimumProjectionScale
      || projectionScale > referenceParallaxCameraLimits.maximumProjectionScale) {
      fail(layerNode, "CUT_PARALLAX_RANGE", `projection scale ${projectionScale} at ${time.numerator}/${time.denominator}s must stay from ${referenceParallaxCameraLimits.minimumProjectionScale} through ${referenceParallaxCameraLimits.maximumProjectionScale}.`);
    }
    const matrix = projectionMatrix(composition, state, projectionScale);
    const projectedCanvasBounds = transformReferenceRect(canvasBounds, matrix);
    const sourceSpace = layerSourceSpace(composition, layer);
    const projectedSourceBounds = transformReferenceRect(sourceSpace.rasterParentBounds, matrix);
    const focusRawSigma = config.focus.mode === "linear"
      ? config.focus.maxBlur * Math.max(0, Math.min(1, Math.abs(layer.depth - state.focusDepth!) / config.focus.range))
      : 0;
    const focusBlurSigma = focusRawSigma < referenceParallaxCameraLimits.minimumFocusBlurSigmaPx ? 0 : focusRawSigma;
    const clamp = clampPadding(composition, matrix, sourceSpace);
    if (layer.edge === "clamp") validateClampAllocation(layerNode, clamp);
    const raster = projectedRaster(layerNode, composition, layer.edge, matrix, projectionScale, clamp, sourceSpace);
    const activeDirectChildSurfaces = (layer.ordinaryChildIds ?? layer.childIds).filter((childId) => {
      const child = ir.nodes[childId];
      return Boolean(child && active(child, time));
    }).length;
    const activeDirectChildPixels = layer.localSpaceSource
      ? activeDirectChildSurfaces * layer.localSpaceSource.width * layer.localSpaceSource.height
      : activeDirectChildSurfaces * composition.width * composition.height;
    const destinationRegistration = transformReferencePoint(
      matrix,
      sourceSpace.parentRegistration.x,
      sourceSpace.parentRegistration.y,
    );
    const sourcePlacement = Object.freeze({
      rasterRegistration: Object.freeze({
        x: sourceSpace.rasterRegistration.x + (layer.edge === "clamp" ? clamp.left : 0),
        y: sourceSpace.rasterRegistration.y + (layer.edge === "clamp" ? clamp.top : 0),
      }),
      destinationRegistration,
      scale: projectionScale,
    });
    return Object.freeze({
      nodeId: layer.nodeId,
      sourceOrder: layer.sourceOrder,
      paintOrder,
      depth: layer.depth,
      edge: layer.edge,
      opticalDistance,
      projectionScale,
      matrix,
      projectedCanvasBounds,
      sourceSpace,
      materialization: sourceSpace.kind === "local-space" ? "retained-local-space" as const : "composition-canvas" as const,
      projectedSourceBounds,
      sourcePlacement,
      focusRawSigma,
      focusBlurSigma,
      clamp,
      projectedRaster: raster,
      activeDirectChildSurfaces,
      activeDirectChildPixels,
    });
  });
  const transformRequests: ReferenceLocalSpaceCompositionTransformRequest[] = [];
  const transformRequestByLayer = new Map<string, ReferenceLocalSpaceTransformRequest>();
  for (const layer of baseLayers) {
    if (layer.sourceSpace.kind !== "local-space") continue;
    const layerNode = ir.nodes[layer.nodeId];
    if (!layerNode) throw new Error(`Internal CUT DepthLayer ${layer.nodeId} is missing.`);
    const transform = localSpaceTransformRequest(composition, layer);
    transformRequests.push(Object.freeze({ node: layerNode, transform }));
    transformRequestByLayer.set(layer.nodeId, transform);
  }
  // The raw requests, rather than caller-supplied receipts, cross the shared
  // aggregate boundary first. Thus a single hostile Sharp-cover geometry or
  // the combined live/unscheduled envelope fails before any receipt is
  // exposed as a successful Parallax frame plan.
  const localSpaceTransformAggregate = transformRequests.length
    ? planReferenceLocalSpaceCompositionTransformWork(cameraNode, composition, transformRequests)
    : undefined;
  const layers = baseLayers.map((layer): ReferenceParallaxLayerFrame => {
    const transform = transformRequestByLayer.get(layer.nodeId);
    if (!transform) return layer;
    const layerNode = ir.nodes[layer.nodeId];
    if (!layerNode) throw new Error(`Internal CUT DepthLayer ${layer.nodeId} is missing.`);
    return Object.freeze({
      ...layer,
      localSpaceTransformWork: planReferenceLocalSpaceTileTransformWork(layerNode, transform),
    });
  });
  const deliveryPixels = composition.width * composition.height;
  const aggregateDirectChildPixels = layers.reduce((total, layer) => total + layer.activeDirectChildPixels, 0);
  const aggregateLayerCompositePixels = layers.reduce((total, layer) => total
    + (layer.sourceSpace.kind === "local-space" ? layer.sourceSpace.width * layer.sourceSpace.height + deliveryPixels : 2 * deliveryPixels), 0);
  const aggregateClampPixels = layers.reduce((total, layer) => total + (layer.edge === "clamp" && layer.clamp.needed ? layer.clamp.pixels : 0), 0);
  const aggregateProjectedResizePixels = layers.reduce((total, layer) => total + (layer.projectedRaster.allocated ? layer.projectedRaster.pixels : 0), 0);
  const aggregateProjectedDeliveryPixels = layers.filter((layer) => layer.projectedRaster.allocated).length * deliveryPixels;
  const focusPasses = layers.filter((layer) => layer.focusBlurSigma > 0).length;
  const aggregateFocusPixels = focusPasses * deliveryPixels;
  const aggregateCameraCompositePixels = 2 * deliveryPixels;
  const aggregateLayerPixels = aggregateDirectChildPixels
    + aggregateLayerCompositePixels
    + aggregateClampPixels
    + aggregateProjectedResizePixels
    + aggregateProjectedDeliveryPixels
    + aggregateFocusPixels
    + aggregateCameraCompositePixels;
  const aggregateLayerBytes = aggregateLayerPixels * 4;
  if (!Number.isSafeInteger(aggregateLayerPixels)
    || aggregateLayerPixels > referenceParallaxCameraLimits.maximumAggregateLayerPixels
    || !Number.isSafeInteger(aggregateLayerBytes)
    || aggregateLayerBytes > referenceParallaxCameraLimits.maximumAggregateLayerBytes) {
    fail(
      cameraNode,
      "CUT_PARALLAX_LIMIT",
      `active layer rasters total ${aggregateLayerPixels} pixels / ${aggregateLayerBytes} RGBA bytes at ${time.numerator}/${time.denominator}s; aggregate limits are ${referenceParallaxCameraLimits.maximumAggregateLayerPixels} pixels / ${referenceParallaxCameraLimits.maximumAggregateLayerBytes} bytes.`,
    );
  }
  const work = Object.freeze({
    layerSurfaces: layers.length,
    clampLayers: layers.filter((layer) => layer.edge === "clamp").length,
    focusPasses,
    aggregateDirectChildPixels,
    aggregateLayerCompositePixels,
    aggregateClampPixels,
    aggregateProjectedResizePixels,
    aggregateProjectedDeliveryPixels,
    aggregateFocusPixels,
    aggregateCameraCompositePixels,
    aggregateLayerPixels,
    aggregateLayerBytes,
    ...(localSpaceTransformAggregate ? { localSpaceTransformAggregate } : {}),
  });
  const semanticIdentity = hash({
    algorithmVersion: referenceParallaxCameraAlgorithmVersion,
    projection: config.projection,
    cameraSubgraph: referenceParallaxNodeSemanticIdentity(ir, cameraNode.id),
  });
  const cacheIdentity = hash({
    algorithmVersion: referenceParallaxCameraAlgorithmVersion,
    backendIdentity,
    semanticIdentity,
    time: `${time.numerator}/${time.denominator}`,
    state,
    pipeline: [
      "materialize-layer-source",
      "apply-source-edge-policy",
      "project-and-delivery-crop",
      "delivery-space-focus-blur",
      "paint-order-composite",
    ],
    work,
    layers: layers.map((layer) => ({
      nodeId: layer.nodeId,
      paintOrder: layer.paintOrder,
      matrix: layer.matrix,
      focusRawSigma: layer.focusRawSigma,
      focusBlurSigma: layer.focusBlurSigma,
      edge: layer.edge,
      materialization: layer.materialization,
      sourceSpace: layer.sourceSpace,
      projectedSourceBounds: layer.projectedSourceBounds,
      sourcePlacement: layer.sourcePlacement,
      clamp: layer.edge === "clamp" ? layer.clamp : undefined,
      projectedRaster: layer.projectedRaster,
      activeDirectChildSurfaces: layer.activeDirectChildSurfaces,
      activeDirectChildPixels: layer.activeDirectChildPixels,
      ...(layer.localSpaceTransformWork ? { localSpaceTransformWork: layer.localSpaceTransformWork } : {}),
    })),
  });
  return Object.freeze({
    algorithmVersion: referenceParallaxCameraAlgorithmVersion,
    projection: referenceParallaxCameraProjection,
    exactTime: Object.freeze({ ...time }),
    state,
    layers: Object.freeze(layers),
    pipeline: Object.freeze([
      "materialize-layer-source",
      "apply-source-edge-policy",
      "project-and-delivery-crop",
      "delivery-space-focus-blur",
      "paint-order-composite",
    ] as const),
    work,
    semanticIdentity,
    cacheIdentity,
  });
}

function validateNoOps(
  ir: CutAVIR,
  composition: IRComposition,
  node: IRNode,
  config: ReferenceParallaxCameraConfig,
  observePlan?: (plan: ReferenceParallaxCameraFramePlan) => void,
) {
  const times = referenceParallaxCameraValidationTimes(composition, node);
  for (const property of ["x", "y", "z"] as const) authoredNeutralCameraControl(ir, composition, node, property, times);
  if (node.inputs.ordering !== undefined) {
    if (config.ordering === "depth") fail(node, "CUT_PARALLAX_NOOP", "authored ordering: depth repeats the default; omit it.");
  }
  let sourceOrderingAffects = config.ordering !== "source";
  let simultaneousDistinctDepth = false;
  let focusAffects = config.focus.mode === "off";
  let focusHasExecutedUnsaturatedLayer = config.focus.mode === "off";
  const focusMaxBlur = config.focus.mode === "linear" ? config.focus.maxBlur : undefined;
  const focusProfilesByLayer = new Map<string, Set<number>>();
  const clampReachable = new Map(config.layers.filter((layer) => layer.edge === "clamp").map((layer) => [layer.nodeId, false]));
  const activeLayerIds = new Set<string>();
  const activeChildIds = new Set<string>();
  for (const time of times) {
    const plan = referenceParallaxCameraPlanAt(ir, composition, config, time);
    observePlan?.(plan);
    if (!plan.layers.length) fail(node, "CUT_PARALLAX_GRAPH", `is active at ${time.numerator}/${time.denominator}s but has no active DepthLayer; the camera never invents a transparent plane.`);
    if (config.ordering === "source") {
      const activeSource = config.layers.filter((layer) => active(ir.nodes[layer.nodeId]!, time));
      const activeDepth = [...activeSource].sort((left, right) => right.depth - left.depth || left.sourceOrder - right.sourceOrder);
      if (activeSource.some((layer, index) => layer.nodeId !== activeDepth[index]?.nodeId)) sourceOrderingAffects = true;
    }
    if (new Set(plan.layers.map((layer) => layer.depth)).size >= 2) simultaneousDistinctDepth = true;
    if (plan.layers.some((layer) => layer.focusBlurSigma >= referenceParallaxCameraLimits.minimumFocusBlurSigmaPx)) focusAffects = true;
    if (focusMaxBlur !== undefined && plan.layers.some((layer) => layer.focusBlurSigma > 0 && layer.focusRawSigma < focusMaxBlur)) {
      focusHasExecutedUnsaturatedLayer = true;
    }
    for (const layer of plan.layers) {
      const profile = focusProfilesByLayer.get(layer.nodeId) ?? new Set<number>();
      profile.add(layer.focusBlurSigma);
      focusProfilesByLayer.set(layer.nodeId, profile);
      activeLayerIds.add(layer.nodeId);
      if (layer.edge === "clamp" && layer.clamp.needed) clampReachable.set(layer.nodeId, true);
      const configLayer = config.layers.find((candidate) => candidate.nodeId === layer.nodeId)!;
      const ordinaryChildIds = configLayer.ordinaryChildIds ?? configLayer.childIds;
      const activeChildren = ordinaryChildIds.filter((childId) => active(ir.nodes[childId]!, time));
      if (!activeChildren.length) {
        fail(ir.nodes[layer.nodeId]!, "CUT_PARALLAX_GRAPH", `is active at ${time.numerator}/${time.denominator}s but no direct child is active; DepthLayer never silently substitutes a transparent frame.`);
      }
      activeChildren.forEach((childId) => activeChildIds.add(childId));
      (configLayer.geoAnnotationIds ?? []).filter((childId) => active(ir.nodes[childId]!, time)).forEach((childId) => activeChildIds.add(childId));
    }
  }
  if (!sourceOrderingAffects) fail(node, "CUT_PARALLAX_NOOP", "ordering: source resolves to the same paint order as depth for every executed active layer subset.");
  if (!simultaneousDistinctDepth) fail(node, "CUT_PARALLAX_NOOP", "no exact output frame contains two active layers at distinct depths; a shared depth camera would not be demonstrated.");
  if (!focusAffects) fail(node, "CUT_PARALLAX_NOOP", "focus: linear produces 0px blur for every reachable layer over the executed output-frame path.");
  if (config.focus.mode === "linear" && node.properties.focusDepth !== undefined
    && ![...focusProfilesByLayer.values()].some((profile) => profile.size > 1)) {
    fail(node, "CUT_PARALLAX_NOOP", "authored focusDepth automation leaves every executed per-layer sigma profile unchanged after the 0.3px deadband.");
  }
  if (!focusHasExecutedUnsaturatedLayer) fail(node, "CUT_PARALLAX_NOOP", "focus: linear is saturated or inside the 0.3px deadband for every reachable layer; focusDepth and focusRange would not influence an executed blur sigma.");
  for (const [layerId, reachable] of clampReachable) if (!reachable) {
    const layer = ir.nodes[layerId]!;
    fail(layer, "CUT_PARALLAX_NOOP", "edge: clamp is never reached over the executed output-frame path; use edge: transparent instead.");
  }
  for (const layer of config.layers) {
    const layerNode = ir.nodes[layer.nodeId]!;
    if (!activeLayerIds.has(layer.nodeId)) fail(layerNode, "CUT_PARALLAX_NOOP", "has no active exact output-frame sample inside its owning camera interval.");
    for (const childId of layer.childIds) if (!activeChildIds.has(childId)) {
      fail(ir.nodes[childId]!, "CUT_PARALLAX_NOOP", `is never active at an exact output-frame sample while its owning DepthLayer is active.`);
    }
  }
}

function cameraConfig(
  ir: CutAVIR,
  composition: IRComposition,
  node: IRNode,
  localSpaces: ReadonlyMap<string, ReferenceLocalSpaceConfig>,
): ReferenceParallaxCameraConfig {
  unknownControls(node, ["focalLength", "ordering", "focus", "focusDepth", "focusRange", "maxBlur", "x", "y", "z"], ["x", "y", "z", "focusDepth"]);
  if (node.domain !== "visual") fail(node, "CUT_PARALLAX_GRAPH", `must have visual domain, found ${node.domain}.`);
  if (node.children.length < 2 || node.children.length > referenceParallaxCameraLimits.maximumLayers) {
    fail(node, "CUT_PARALLAX_GRAPH", `requires 2 through ${referenceParallaxCameraLimits.maximumLayers} direct DepthLayer children; found ${node.children.length}.`);
  }
  const focalLength = length(
    node,
    node.inputs.focalLength,
    "input “focalLength”",
    referenceParallaxCameraLimits.minimumFocalLengthPx,
    referenceParallaxCameraLimits.maximumFocalLengthPx,
  );
  const layers = node.children.map((childId, sourceOrder) => {
    const child = ir.nodes[childId];
    if (!child) fail(node, "CUT_PARALLAX_GRAPH", `references missing child ${childId}.`);
    if (child.op !== "cut.visual.depth_layer") fail(node, "CUT_PARALLAX_GRAPH", `direct child ${childId} is ${child.op}; only DepthLayer is accepted.`);
    if (child.ownership !== "child") fail(child, "CUT_PARALLAX_GRAPH", `must have child ownership inside ParallaxCamera; found ${child.ownership}.`);
    if (!intervalContains(node, child)) fail(child, "CUT_PARALLAX_GRAPH", "half-open interval must be contained by its direct ParallaxCamera interval.");
    const base = referenceDepthLayerConfig(child, sourceOrder, localSpaces)!;
    const geoAnnotationIds = child.children.filter((nodeId) => ir.nodes[nodeId]?.op === "cut.geo.annotation");
    if (!geoAnnotationIds.length) return base;
    const ordinaryChildIds = child.children.filter((nodeId) => ir.nodes[nodeId]?.op !== "cut.geo.annotation");
    return Object.freeze({
      ...base,
      ordinaryChildIds: Object.freeze(ordinaryChildIds),
      geoAnnotationIds: Object.freeze(geoAnnotationIds),
    });
  });
  if (new Set(layers.map((layer) => layer.depth)).size < 2) fail(node, "CUT_PARALLAX_NOOP", "requires at least two distinct authored layer depths.");
  for (const layer of layers) for (const childId of layer.childIds) {
    const child = ir.nodes[childId];
    if (!child || child.domain !== "visual") fail(ir.nodes[layer.nodeId]!, "CUT_PARALLAX_GRAPH", `child ${childId} must resolve to one visual node.`);
    if (child.ownership !== "child") fail(child, "CUT_PARALLAX_GRAPH", `must have child ownership inside DepthLayer; found ${child.ownership}.`);
    if (!intervalContains(ir.nodes[layer.nodeId]!, child)) fail(child, "CUT_PARALLAX_GRAPH", "half-open interval must be contained by its direct DepthLayer interval.");
  }
  for (const property of ["x", "y", "z", "focusDepth"] as const) validateLengthProperty(ir, node, property);
  for (const property of ["x", "y", "z", "focusDepth"] as const) validateConstructorBaselineOwnership(ir, node, property);
  for (const property of ["x", "y", "z"] as const) if (node.inputs[property] !== undefined) {
    length(node, node.inputs[property], `input “${property}”`, -referenceParallaxCameraLimits.maximumAbsoluteCoordinatePx, referenceParallaxCameraLimits.maximumAbsoluteCoordinatePx);
  }
  const ordering = stringChoice(node, "ordering", ["depth", "source"] as const, "depth", "CUT_PARALLAX_ORDERING");
  const focus = focusConfig(node);
  if (focus.mode === "linear") {
    length(node, node.inputs.focusDepth, "input “focusDepth”", -referenceParallaxCameraLimits.maximumAbsoluteCoordinatePx, referenceParallaxCameraLimits.maximumAbsoluteCoordinatePx, "CUT_PARALLAX_FOCUS");
  }
  void composition;
  return Object.freeze({
    nodeId: node.id,
    projection: referenceParallaxCameraProjection,
    focalLength,
    ordering,
    focus,
    layers: Object.freeze(layers),
  });
}

/**
 * Validate the closed graph, exact projection path, accepted-control no-ops,
 * focus reachability, and clamp reachability. Returned configs are ready for
 * runtime preparation and inspect; no hidden title/project branch exists.
 */
export function validateReferenceParallaxCameraGraph(
  ir: CutAVIR,
  composition: IRComposition,
  selectedNodeIds?: ReadonlySet<string>,
  options: Readonly<{
    easingsValidated?: boolean;
    /** Lets an upstream asset-free check reuse the exact LocalSpace topology
     * closure instead of silently re-entering locked media planning. */
    localSpaceConfigs?: ReadonlyMap<string, ReferenceLocalSpaceConfig>;
  }> = {},
) {
  if (!options.easingsValidated) validateReferenceEasings(ir);
  const selected = (node: IRNode) => selectedNodeIds === undefined || selectedNodeIds.has(node.id);
  const parents = directParents(ir);
  // Close LocalSpace ownership/descendants/work before deriving a plane
  // source. This is asset-free planning and cannot fall back to a delivery
  // canvas when the local graph is malformed.
  const localSpaces = options.localSpaceConfigs
    ?? validateReferenceLocalSpaceGraph(ir, composition, selectedNodeIds);
  const cameras = Object.values(ir.nodes).filter((node) => selected(node) && node.op === "cut.visual.parallax_camera");
  const layers = Object.values(ir.nodes).filter((node) => selected(node) && node.op === "cut.visual.depth_layer");
  for (const layer of layers) {
    const direct = (parents.get(layer.id) ?? []).filter(selected);
    if (direct.length !== 1 || direct[0].op !== "cut.visual.parallax_camera") {
      fail(layer, "CUT_PARALLAX_GRAPH", `must have exactly one direct ParallaxCamera parent; found ${direct.length === 0 ? "none" : direct.map((node) => node.op).join(", ")}.`);
    }
  }
  const configs = new Map<string, ReferenceParallaxCameraConfig>();
  const compositionWorkByTime = new Map<string, { pixels: number; bytes: number; cameraIds: string[] }>();
  let cameraFrameSamples = 0;
  for (const camera of cameras) {
    if (hasReachableAncestorOperation(parents, camera.id, "cut.visual.motion_blur", selected)) {
      fail(camera, "CUT_PARALLAX_GRAPH", "cannot execute beneath a reachable MotionBlur ancestor in the v1 slice because shutter subframes are outside the output-frame validation domain; move MotionBlur inside a DepthLayer or remove it.");
    }
    const config = cameraConfig(ir, composition, camera, localSpaces);
    configs.set(camera.id, config);
    validateNoOps(ir, composition, camera, config, (plan) => {
      cameraFrameSamples += 1;
      if (cameraFrameSamples > referenceParallaxCameraLimits.maximumCompositionCameraFrameSamples) {
        fail(camera, "CUT_PARALLAX_LIMIT", `composition requires more than ${referenceParallaxCameraLimits.maximumCompositionCameraFrameSamples} camera-frame validation samples.`);
      }
      const sceneStart = camera.sceneId ? ir.scenes[camera.sceneId]?.start : undefined;
      const absoluteTime = sceneStart ? addRational(sceneStart, plan.exactTime) : plan.exactTime;
      const key = `${absoluteTime.numerator}/${absoluteTime.denominator}`;
      const aggregate = compositionWorkByTime.get(key) ?? { pixels: 0, bytes: 0, cameraIds: [] };
      aggregate.pixels += plan.work.aggregateLayerPixels;
      aggregate.bytes += plan.work.aggregateLayerBytes;
      aggregate.cameraIds.push(camera.id);
      compositionWorkByTime.set(key, aggregate);
      if (!Number.isSafeInteger(aggregate.pixels)
        || !Number.isSafeInteger(aggregate.bytes)
        || aggregate.pixels > referenceParallaxCameraLimits.maximumCompositionCameraPixels
        || aggregate.bytes > referenceParallaxCameraLimits.maximumCompositionCameraBytes) {
        fail(
          camera,
          "CUT_PARALLAX_LIMIT",
          `simultaneously active cameras ${aggregate.cameraIds.join(", ")} total ${aggregate.pixels} logical pixels / ${aggregate.bytes} RGBA bytes at ${key}s; composition camera limits are ${referenceParallaxCameraLimits.maximumCompositionCameraPixels} pixels / ${referenceParallaxCameraLimits.maximumCompositionCameraBytes} bytes.`,
        );
      }
    });
  }
  return configs;
}

/** Stable machine-facing projection of public and derived camera semantics. */
export function referenceParallaxCameraInspect(
  ir: CutAVIR,
  composition: IRComposition,
  config: ReferenceParallaxCameraConfig,
) {
  const node = ir.nodes[config.nodeId];
  if (!node) throw new Error(`Internal CUT ParallaxCamera ${config.nodeId} is missing.`);
  const validationTimes = referenceParallaxCameraValidationTimes(composition, node);
  const planCache = new Map<string, ReferenceParallaxCameraFramePlan>();
  const planAt = (time: Rational) => {
    const key = `${time.numerator}/${time.denominator}`;
    const cached = planCache.get(key);
    if (cached) return cached;
    const planned = referenceParallaxCameraPlanAt(ir, composition, config, time);
    planCache.set(key, planned);
    return planned;
  };
  const plan = planAt(validationTimes[0]);
  return Object.freeze({
    kind: "deterministic-2.5d" as const,
    algorithmVersion: referenceParallaxCameraAlgorithmVersion,
    projection: {
      kind: referenceParallaxCameraProjection,
      coordinateSpace: "composition-pixels" as const,
      planes: "parallel" as const,
      cameraAxes: { positiveX: "right", positiveY: "down", positiveZ: "toward-planes" },
      opticalDistance: "focalLength + layer.depth - camera.z" as const,
      scale: "focalLength / opticalDistance" as const,
      point: "C + scale * (p - C - camera.xy)" as const,
      isCamera3D: false as const,
    },
    focalLength: config.focalLength,
    ordering: {
      resolved: config.ordering,
      depthPolicy: "greater-depth-first" as const,
      tieBreak: "source-order" as const,
    },
    focus: config.focus.mode === "off" ? { mode: "off" as const } : {
      mode: "linear" as const,
      range: config.focus.range,
      maxBlur: config.focus.maxBlur,
      rawFormula: "maxBlur * clamp(abs(layer.depth - focusDepth) / focusRange, 0, 1)" as const,
      executedFormula: "rawSigma < 0.3px ? 0px : rawSigma" as const,
      deadband: referenceParallaxCameraLimits.minimumFocusBlurSigmaPx,
      space: "delivery-pixel-gaussian-sigma" as const,
    },
    edgeBoundary: {
      transparent: "outside the selected materialized source surface's declared boundary is transparent" as const,
      clamp: "replicate only the selected materialized source surface's declared border samples; off-canvas authored geometry is not recovered for composition-canvas sources and geometry outside a LocalSpace boundary is not recovered" as const,
    },
    pipeline: [
      "materialize each DepthLayer from its declared composition-canvas or retained-local-space source",
      "apply that layer's transparent or border-sample clamp policy in source space",
      "project the parallel plane and crop to the delivery canvas",
      "apply the exact focus sigma to that projected delivery-space surface",
      "composite the finished layer surfaces in resolved paint order",
    ] as const,
    layers: config.layers.map((layer) => {
      const layerNode = ir.nodes[layer.nodeId];
      if (!layerNode) throw new Error(`Internal CUT DepthLayer ${layer.nodeId} is missing.`);
      const sampleTime = validationTimes.find((candidate) => active(layerNode, candidate));
      if (!sampleTime) fail(layerNode, "CUT_PARALLAX_GRAPH", "has no active output-frame sample available for deterministic inspection.");
      const frame = planAt(sampleTime).layers.find((candidate) => candidate.nodeId === layer.nodeId);
      if (!frame) throw new Error(`Internal CUT DepthLayer ${layer.nodeId} was absent from its active inspection plan.`);
      return {
        nodeId: layer.nodeId,
        depth: layer.depth,
        edge: layer.edge,
        sourceOrder: layer.sourceOrder,
        paintOrder: frame.paintOrder,
        childIds: [...layer.childIds],
        materialization: layer.localSpaceSource ? "retained-local-space" as const : "composition-canvas" as const,
        ...(layer.ordinaryChildIds ? { ordinaryChildIds: [...layer.ordinaryChildIds], geoAnnotationIds: [...layer.geoAnnotationIds!] } : {}),
        sample: {
          exactTime: { ...sampleTime },
          projectionScale: frame.projectionScale,
          focusRawSigma: frame.focusRawSigma,
          focusBlurSigma: frame.focusBlurSigma,
          matrix: { ...frame.matrix },
          projectedCanvasBounds: { ...frame.projectedCanvasBounds },
          sourceSpace: {
            ...frame.sourceSpace,
            authoredParentBounds: { ...frame.sourceSpace.authoredParentBounds },
            rasterParentBounds: { ...frame.sourceSpace.rasterParentBounds },
            rasterRegistration: { ...frame.sourceSpace.rasterRegistration },
            parentRegistration: { ...frame.sourceSpace.parentRegistration },
          },
          projectedSourceBounds: { ...frame.projectedSourceBounds },
          sourcePlacement: {
            rasterRegistration: { ...frame.sourcePlacement.rasterRegistration },
            destinationRegistration: { ...frame.sourcePlacement.destinationRegistration },
            scale: frame.sourcePlacement.scale,
          },
          clamp: { ...frame.clamp },
          projectedRaster: { ...frame.projectedRaster },
          activeDirectChildSurfaces: frame.activeDirectChildSurfaces,
          ...(frame.localSpaceTransformWork ? { localSpaceTransformWork: frame.localSpaceTransformWork } : {}),
        },
      };
    }),
    inspectionSample: {
      exactTime: { ...plan.exactTime },
      camera: { ...plan.state },
      semanticIdentity: plan.semanticIdentity,
      cacheIdentity: plan.cacheIdentity,
      work: { ...plan.work },
    },
  });
}
