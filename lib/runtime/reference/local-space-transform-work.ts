import { hash } from "../../core/stable";
import type { IRComposition, IRNode } from "../../language/ir";

/** Pure allocation planning for a retained LocalSpace tile. The reference
 * renderer consumes these plans through one per-renderer FIFO transform
 * scheduler; this module itself remains allocation-free. */
export const referenceLocalSpaceTransformWorkAlgorithmVersion = "cut-reference-local-space-transform-work-v2" as const;
/** Additive skew-aware planner. V2 remains the stable non-skew contract; the
 * affine entrypoint below returns V2 byte-for-byte when both shears are zero
 * and upgrades only transforms that execute the extra libvips affine stage. */
export const referenceLocalSpaceAffineTransformWorkAlgorithmVersion = "cut-reference-local-space-affine-transform-work-v3" as const;
/** Fallback for an otherwise admitted zero-rotation uniform scale whose
 * legacy associated-RGB16 intermediate would exceed the unchanged 512 MiB
 * per-transform ceiling. The renderer samples the original retained RGBA8
 * tile into an exact destination clip instead of materializing that
 * intermediate. */
export const referenceLocalSpaceDestinationClippedTransformWorkAlgorithmVersion =
  "cut-reference-local-space-destination-clipped-transform-work-v1" as const;
export const referenceLocalSpaceTransformRendererHandoff = "connected-reference-visual-renderer" as const;
export const referenceLocalSpaceTransformSchedulingEnforcement = "reference-visual-renderer-fifo-v1" as const;

/** Exact resize geometry consumed by the installed retained compositor.
 * Uniform authored scale is quantized to integer requested dimensions, then
 * Sharp's cover intermediate derives one effective raster scale. Allocation,
 * pixel placement, and owner-local anchor resolution share this helper. */
export function referenceLocalSpaceResizeGeometry(
  inputWidth: number,
  inputHeight: number,
  authoredScale: number,
) {
  if (!Number.isSafeInteger(inputWidth) || inputWidth < 1
    || !Number.isSafeInteger(inputHeight) || inputHeight < 1
    || !Number.isFinite(authoredScale) || authoredScale <= 0) {
    throw new Error("CUT_LOCAL_SPACE_TRANSFORM_TYPE: resize geometry requires positive integer source dimensions and finite positive scale.");
  }
  const requestedWidth = Math.max(1, Math.round(inputWidth * authoredScale));
  const requestedHeight = Math.max(1, Math.round(inputHeight * authoredScale));
  const effectiveScale = Math.max(requestedWidth / inputWidth, requestedHeight / inputHeight);
  const sharpCoverWidth = Math.max(1, Math.round(inputWidth * effectiveScale));
  const sharpCoverHeight = Math.max(1, Math.round(inputHeight * effectiveScale));
  const cropLeft = Math.max(0, Math.floor((sharpCoverWidth - requestedWidth + 1) / 2));
  const cropTop = Math.max(0, Math.floor((sharpCoverHeight - requestedHeight + 1) / 2));
  const reductionPhase = effectiveScale <= 1 ? -0.5 : 0;
  return Object.freeze({
    inputWidth,
    inputHeight,
    authoredScale,
    requestedWidth,
    requestedHeight,
    effectiveScale,
    sharpCoverWidth,
    sharpCoverHeight,
    cropLeft,
    cropTop,
    reductionPhase,
  });
}

export const referenceLocalSpaceTransformWorkLimits = Object.freeze({
  maximumSourceAxisPx: 16_384,
  maximumSourcePixels: 16_777_216,
  maximumIntermediateAxisPx: 16_384,
  maximumIntermediatePixels: 67_108_864,
  /** One process-local transform can otherwise materialize multiple RGBA16
   * copies far beyond its innocent-looking source dimensions. Keep this
   * conservative until a measured cropped/streaming affine path exists. */
  maximumPerTransformPeakBytes: 536_870_912,
  maximumCompositionTransforms: 256,
  /** Bounds the closed composition-frame admission array, including skipped
   * owner samples, so frame evidence cannot exceed its 100k-record schema
   * after otherwise successful pixel execution. */
  maximumCompositionPreflightEntries: 100_000,
  maximumCompositionLiveOutputBytes: 1_073_741_824,
  maximumCompositionUnscheduledPeakBytes: 2_147_483_648,
});

export type ReferenceLocalSpaceTransformWorkErrorCode =
  | "CUT_LOCAL_SPACE_TRANSFORM_TYPE"
  | "CUT_LOCAL_SPACE_TRANSFORM_LIMIT"
  | "CUT_LOCAL_SPACE_TRANSFORM_AGGREGATE";

export class ReferenceLocalSpaceTransformWorkError extends Error {
  readonly source: Readonly<{ module: string; line: number; column: number; nodeId: string }>;

  constructor(readonly code: ReferenceLocalSpaceTransformWorkErrorCode, readonly node: IRNode, detail: string) {
    const { module, span } = node.provenance;
    super(`${code}: retained LocalSpace transform at ${module}:${span.start.line}:${span.start.column} ${detail}`);
    this.name = "ReferenceLocalSpaceTransformWorkError";
    this.source = Object.freeze({ module, line: span.start.line, column: span.start.column, nodeId: node.id });
  }
}

export type ReferenceLocalSpaceTransformDimensions = Readonly<{
  width: number;
  height: number;
  pixels: number;
}>;

export type ReferenceLocalSpaceTransformRequest = Readonly<{
  source: Readonly<{ width: number; height: number }>;
  destination: Readonly<{ width: number; height: number }>;
  scale: number;
  rotation: number;
  opacity: number;
}>;

export type ReferenceLocalSpaceAffineTransformRequest = Readonly<{
  source: Readonly<{ width: number; height: number }>;
  destination: Readonly<{ width: number; height: number }>;
  scale: number;
  skewX: number;
  skewY: number;
  rotation: number;
  opacity: number;
}>;

export type ReferenceLocalSpaceRgb16FilterStageWork = Readonly<{
  input: ReferenceLocalSpaceTransformDimensions;
  output: ReferenceLocalSpaceTransformDimensions;
  associatedInputCopyBytes: number;
  sharpWorkingBytes: number;
  backendOutputBytes: number;
  copiedOutputBytes: number;
  peakLiveBytesUpperBound: number;
}>;

export type ReferenceLocalSpaceTileTransformWork = Readonly<{
  format: "cut-reference-local-space-transform-work";
  version: 2;
  kind: "retained-tile-transform";
  algorithmVersion: typeof referenceLocalSpaceTransformWorkAlgorithmVersion;
  rendererHandoff: typeof referenceLocalSpaceTransformRendererHandoff;
  scheduling: Readonly<{
    requiredDiscipline: "serialize-tile-transform-allocation-per-composition";
    enforcement: typeof referenceLocalSpaceTransformSchedulingEnforcement;
  }>;
  source: ReferenceLocalSpaceTransformDimensions & Readonly<{ retainedRgba8Bytes: number }>;
  requestedResize: ReferenceLocalSpaceTransformDimensions & Readonly<{ scale: number }>;
  sharpCover: ReferenceLocalSpaceTransformDimensions & Readonly<{ scale: number }>;
  rotation: ReferenceLocalSpaceTransformDimensions & Readonly<{ canonicalDegrees: number }>;
  stages: Readonly<{
    rgb16TransformPath: boolean;
    straightSourceRgb16Bytes: number;
    associatedRgb16StageCount: number;
    resize?: ReferenceLocalSpaceRgb16FilterStageWork;
    rotation?: ReferenceLocalSpaceRgb16FilterStageWork;
    straightTransformedRgba8Bytes: number;
    destinationCanvasRgba8Bytes: number;
    opacityDestinationCopies: 0 | 1;
    opacityDestinationCopyBytes: number;
  }>;
  perTransform: Readonly<{
    totalAllocatedBytesUpperBound: number;
    peakLiveBytesUpperBound: number;
  }>;
  compositionLiveOutput: Readonly<{
    surfaces: 1;
    pixels: number;
    rgba8Bytes: number;
  }>;
  workIdentity: string;
}>;

export type ReferenceLocalSpaceSkewTransformWork = Readonly<{
  format: "cut-reference-local-space-transform-work";
  version: 3;
  kind: "retained-tile-transform";
  algorithmVersion: typeof referenceLocalSpaceAffineTransformWorkAlgorithmVersion;
  rendererHandoff: typeof referenceLocalSpaceTransformRendererHandoff;
  scheduling: Readonly<{
    requiredDiscipline: "serialize-tile-transform-allocation-per-composition";
    enforcement: typeof referenceLocalSpaceTransformSchedulingEnforcement;
  }>;
  source: ReferenceLocalSpaceTransformDimensions & Readonly<{ retainedRgba8Bytes: number }>;
  requestedResize: ReferenceLocalSpaceTransformDimensions & Readonly<{ scale: number }>;
  sharpCover: ReferenceLocalSpaceTransformDimensions & Readonly<{ scale: number }>;
  skew: ReferenceLocalSpaceTransformDimensions & Readonly<{
    skewXDegrees: number;
    skewYDegrees: number;
    tangentX: number;
    tangentY: number;
  }>;
  rotation: ReferenceLocalSpaceTransformDimensions & Readonly<{ canonicalDegrees: number }>;
  stages: Readonly<{
    rgb16TransformPath: true;
    straightSourceRgb16Bytes: number;
    associatedRgb16StageCount: number;
    resize?: ReferenceLocalSpaceRgb16FilterStageWork;
    skew: ReferenceLocalSpaceRgb16FilterStageWork;
    rotation?: ReferenceLocalSpaceRgb16FilterStageWork;
    straightTransformedRgba8Bytes: number;
    destinationCanvasRgba8Bytes: number;
    opacityDestinationCopies: 0 | 1;
    opacityDestinationCopyBytes: number;
  }>;
  perTransform: Readonly<{
    totalAllocatedBytesUpperBound: number;
    peakLiveBytesUpperBound: number;
  }>;
  compositionLiveOutput: Readonly<{
    surfaces: 1;
    pixels: number;
    rgba8Bytes: number;
  }>;
  workIdentity: string;
}>;

export type ReferenceLocalSpaceDestinationClippedTransformWork = Readonly<{
  format: "cut-reference-local-space-transform-work";
  version: 4;
  kind: "retained-tile-transform";
  algorithmVersion: typeof referenceLocalSpaceDestinationClippedTransformWorkAlgorithmVersion;
  rendererHandoff: typeof referenceLocalSpaceTransformRendererHandoff;
  scheduling: Readonly<{
    requiredDiscipline: "serialize-tile-transform-allocation-per-composition";
    enforcement: typeof referenceLocalSpaceTransformSchedulingEnforcement;
  }>;
  source: ReferenceLocalSpaceTransformDimensions & Readonly<{ retainedRgba8Bytes: number }>;
  requestedResize: ReferenceLocalSpaceTransformDimensions & Readonly<{ scale: number }>;
  sharpCover: ReferenceLocalSpaceTransformDimensions & Readonly<{ scale: number }>;
  rotation: ReferenceLocalSpaceTransformDimensions & Readonly<{ canonicalDegrees: 0 }>;
  supersededLegacy: Readonly<{
    totalAllocatedBytesUpperBound: number;
    peakLiveBytesUpperBound: number;
    refusedByMaximumPerTransformPeakBytes: number;
  }>;
  stages: Readonly<{
    rgb16TransformPath: false;
    directDestinationClippedScaleTranslation: true;
    straightSourceRgb16Bytes: 0;
    associatedRgb16StageCount: 0;
    straightTransformedRgba8Bytes: 0;
    maximumSamplerOutputRgba8Bytes: number;
    destinationCanvasRgba8Bytes: number;
    opacityDestinationCopies: 0 | 1;
    opacityDestinationCopyBytes: number;
  }>;
  perTransform: Readonly<{
    totalAllocatedBytesUpperBound: number;
    peakLiveBytesUpperBound: number;
  }>;
  compositionLiveOutput: Readonly<{
    surfaces: 1;
    pixels: number;
    rgba8Bytes: number;
  }>;
  workIdentity: string;
}>;

export type ReferenceLocalSpaceUniformTileTransformWork =
  | ReferenceLocalSpaceTileTransformWork
  | ReferenceLocalSpaceDestinationClippedTransformWork;

export type ReferenceLocalSpaceAffineTileTransformWork =
  | ReferenceLocalSpaceUniformTileTransformWork
  | ReferenceLocalSpaceSkewTransformWork;

export type ReferenceLocalSpaceCompositionTransformWork = Readonly<{
  format: "cut-reference-local-space-composition-transform-work";
  version: 2;
  algorithmVersion: typeof referenceLocalSpaceTransformWorkAlgorithmVersion;
  compositionId: string;
  transformCount: number;
  scheduling: Readonly<{
    requiredDiscipline: "serialize-tile-transform-allocation-per-composition";
    enforcement: typeof referenceLocalSpaceTransformSchedulingEnforcement;
  }>;
  aggregateAllocatedBytesUpperBound: number;
  compositionLiveOutputSurfaces: number;
  compositionLiveOutputPixels: number;
  compositionLiveOutputBytes: number;
  maximumPerTransformPeakBytes: number;
  serializedCompositionPeakBytesUpperBound: number;
  unscheduledCompositionPeakBytesUpperBound: number;
  conservativeSafetyEnvelope: "unscheduled-sum";
  workIdentity: string;
}>;

export type ReferenceLocalSpaceAffineCompositionTransformWork = Readonly<{
  format: "cut-reference-local-space-composition-transform-work";
  version: 3;
  algorithmVersion: typeof referenceLocalSpaceAffineTransformWorkAlgorithmVersion;
  compositionId: string;
  transformCount: number;
  scheduling: Readonly<{
    requiredDiscipline: "serialize-tile-transform-allocation-per-composition";
    enforcement: typeof referenceLocalSpaceTransformSchedulingEnforcement;
  }>;
  aggregateAllocatedBytesUpperBound: number;
  compositionLiveOutputSurfaces: number;
  compositionLiveOutputPixels: number;
  compositionLiveOutputBytes: number;
  maximumPerTransformPeakBytes: number;
  serializedCompositionPeakBytesUpperBound: number;
  unscheduledCompositionPeakBytesUpperBound: number;
  conservativeSafetyEnvelope: "unscheduled-sum";
  workIdentity: string;
}>;

export type ReferenceLocalSpaceDestinationClippedCompositionTransformWork = Readonly<{
  format: "cut-reference-local-space-composition-transform-work";
  version: 4;
  algorithmVersion: typeof referenceLocalSpaceDestinationClippedTransformWorkAlgorithmVersion;
  compositionId: string;
  transformCount: number;
  scheduling: Readonly<{
    requiredDiscipline: "serialize-tile-transform-allocation-per-composition";
    enforcement: typeof referenceLocalSpaceTransformSchedulingEnforcement;
  }>;
  aggregateAllocatedBytesUpperBound: number;
  compositionLiveOutputSurfaces: number;
  compositionLiveOutputPixels: number;
  compositionLiveOutputBytes: number;
  maximumPerTransformPeakBytes: number;
  serializedCompositionPeakBytesUpperBound: number;
  unscheduledCompositionPeakBytesUpperBound: number;
  conservativeSafetyEnvelope: "unscheduled-sum";
  workIdentity: string;
}>;

export type ReferenceLocalSpaceUniformCompositionTransformWork =
  | ReferenceLocalSpaceCompositionTransformWork
  | ReferenceLocalSpaceDestinationClippedCompositionTransformWork;

export type ReferenceLocalSpaceCompositionTransformRequest = Readonly<{
  node: IRNode;
  transform: ReferenceLocalSpaceTransformRequest;
}>;

export type ReferenceLocalSpaceAffineCompositionTransformRequest = Readonly<{
  node: IRNode;
  transform: ReferenceLocalSpaceAffineTransformRequest;
}>;

function fail(node: IRNode, code: ReferenceLocalSpaceTransformWorkErrorCode, detail: string): never {
  throw new ReferenceLocalSpaceTransformWorkError(code, node, detail);
}

function closedRecord(node: IRNode, value: unknown, label: string, fields: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(node, "CUT_LOCAL_SPACE_TRANSFORM_TYPE", `${label} must be a plain object containing exactly ${fields.join(", ")}.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(node, "CUT_LOCAL_SPACE_TRANSFORM_TYPE", `${label} must have a plain or null prototype.`);
  }
  const keys = Reflect.ownKeys(value);
  const symbol = keys.find((key) => typeof key !== "string");
  if (symbol !== undefined) fail(node, "CUT_LOCAL_SPACE_TRANSFORM_TYPE", `${label} cannot contain symbol properties.`);
  const names = keys as string[];
  const unknown = names.find((key) => !fields.includes(key));
  if (unknown !== undefined) fail(node, "CUT_LOCAL_SPACE_TRANSFORM_TYPE", `${label} does not accept property ${JSON.stringify(unknown)}.`);
  const missing = fields.find((field) => !names.includes(field));
  if (missing !== undefined) fail(node, "CUT_LOCAL_SPACE_TRANSFORM_TYPE", `${label} requires property ${JSON.stringify(missing)}.`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const accessor = fields.find((field) => !descriptors[field] || !("value" in descriptors[field]!) || !descriptors[field]!.enumerable);
  if (accessor !== undefined) fail(node, "CUT_LOCAL_SPACE_TRANSFORM_TYPE", `${label}.${accessor} must be one enumerable data property.`);
}

function dimensions(
  node: IRNode,
  width: number,
  height: number,
  label: string,
  maximumAxis: number,
  maximumPixels: number,
): ReferenceLocalSpaceTransformDimensions {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    fail(node, "CUT_LOCAL_SPACE_TRANSFORM_TYPE", `${label} dimensions must be positive safe integers; received ${width}x${height}.`);
  }
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels)) {
    fail(node, "CUT_LOCAL_SPACE_TRANSFORM_LIMIT", `${label} pixel accounting exceeds the safe integer range.`);
  }
  if (width > maximumAxis || height > maximumAxis || pixels > maximumPixels) {
    fail(node, "CUT_LOCAL_SPACE_TRANSFORM_LIMIT", `${label} requires ${width}x${height} (${pixels} pixels); maximum is ${maximumAxis}px on an axis and ${maximumPixels} pixels.`);
  }
  return Object.freeze({ width, height, pixels });
}

function safeBytes(node: IRNode, values: readonly number[], label: string) {
  const result = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(result) || result < 0) {
    fail(node, "CUT_LOCAL_SPACE_TRANSFORM_LIMIT", `${label} byte accounting exceeds the safe integer range.`);
  }
  return result;
}

/** Canonical shortest signed turn used by both planning identity and the
 * future renderer handoff. Exact full turns collapse to positive zero. */
export function canonicalReferenceLocalSpaceRotationDegrees(rotation: number) {
  if (!Number.isFinite(rotation)) return rotation;
  let normalized = rotation % 360;
  if (normalized < 0) normalized += 360;
  if (normalized === 0 || Object.is(normalized, -0) || normalized === 360) return 0;
  return normalized > 180 ? normalized - 360 : normalized;
}

function sharpRotationDimensions(node: IRNode, input: ReferenceLocalSpaceTransformDimensions, canonicalDegrees: number) {
  const absolute = Math.abs(canonicalDegrees);
  if (canonicalDegrees === 0 || absolute === 180) {
    return dimensions(node, input.width, input.height, "Sharp rotation output", referenceLocalSpaceTransformWorkLimits.maximumIntermediateAxisPx, referenceLocalSpaceTransformWorkLimits.maximumIntermediatePixels);
  }
  if (absolute === 90) {
    return dimensions(node, input.height, input.width, "Sharp rotation output", referenceLocalSpaceTransformWorkLimits.maximumIntermediateAxisPx, referenceLocalSpaceTransformWorkLimits.maximumIntermediatePixels);
  }
  const radians = canonicalDegrees * Math.PI / 180;
  const width = Math.max(1, Math.round(Math.abs(Math.cos(radians)) * input.width + Math.abs(Math.sin(radians)) * input.height));
  const height = Math.max(1, Math.round(Math.abs(Math.sin(radians)) * input.width + Math.abs(Math.cos(radians)) * input.height));
  return dimensions(node, width, height, "Sharp rotation output", referenceLocalSpaceTransformWorkLimits.maximumIntermediateAxisPx, referenceLocalSpaceTransformWorkLimits.maximumIntermediatePixels);
}

function rgb16FilterStage(
  node: IRNode,
  retainedSourceRgba8Bytes: number,
  input: ReferenceLocalSpaceTransformDimensions,
  output: ReferenceLocalSpaceTransformDimensions,
  sharpWorkingPixels: number,
): ReferenceLocalSpaceRgb16FilterStageWork {
  // Structural typing permits richer dimension objects (for example the
  // public requestedResize value also carries `scale`). Normalize at the
  // evidence boundary so a stage receipt remains a genuinely closed record
  // instead of leaking caller-only metadata into its hash and JSON schema.
  const closedInput = Object.freeze({ width: input.width, height: input.height, pixels: input.pixels });
  const closedOutput = Object.freeze({ width: output.width, height: output.height, pixels: output.pixels });
  const inputBytes = closedInput.pixels * 8;
  const outputBytes = closedOutput.pixels * 8;
  const sharpWorkingBytes = sharpWorkingPixels * 8;
  const peakLiveBytesUpperBound = safeBytes(node, [
    retainedSourceRgba8Bytes,
    inputBytes,
    inputBytes,
    sharpWorkingBytes,
    outputBytes,
    outputBytes,
  ], "RGB16 filter-stage peak");
  return Object.freeze({
    input: closedInput,
    output: closedOutput,
    associatedInputCopyBytes: inputBytes,
    sharpWorkingBytes,
    backendOutputBytes: outputBytes,
    copiedOutputBytes: outputBytes,
    peakLiveBytesUpperBound,
  });
}

/** Plan the exact allocation geometry of the current retained placement path:
 * requested uniform resize -> Sharp's default cover intermediate -> Sharp
 * rotation. The result is planning evidence only; it cannot claim installed
 * serialization until the renderer consumes and enforces it. */
export function planReferenceLocalSpaceTileTransformWork(
  node: IRNode,
  request: ReferenceLocalSpaceTransformRequest,
): ReferenceLocalSpaceUniformTileTransformWork {
  closedRecord(node, request, "transform request", ["source", "destination", "scale", "rotation", "opacity"]);
  closedRecord(node, request.source, "transform request source", ["width", "height"]);
  closedRecord(node, request.destination, "transform request destination", ["width", "height"]);
  const sourceBase = dimensions(
    node,
    request.source.width,
    request.source.height,
    "retained RGBA8 source",
    referenceLocalSpaceTransformWorkLimits.maximumSourceAxisPx,
    referenceLocalSpaceTransformWorkLimits.maximumSourcePixels,
  );
  const destination = dimensions(
    node,
    request.destination.width,
    request.destination.height,
    "destination canvas",
    referenceLocalSpaceTransformWorkLimits.maximumIntermediateAxisPx,
    referenceLocalSpaceTransformWorkLimits.maximumIntermediatePixels,
  );
  if (!Number.isFinite(request.scale) || request.scale <= 0) {
    fail(node, "CUT_LOCAL_SPACE_TRANSFORM_TYPE", `scale must be finite and positive; received ${request.scale}.`);
  }
  if (!Number.isFinite(request.rotation)) {
    fail(node, "CUT_LOCAL_SPACE_TRANSFORM_TYPE", `rotation must be finite; received ${request.rotation}.`);
  }
  if (!Number.isFinite(request.opacity) || request.opacity < 0 || request.opacity > 1) {
    fail(node, "CUT_LOCAL_SPACE_TRANSFORM_TYPE", `opacity must be finite in the closed range 0 through 1; received ${request.opacity}.`);
  }

  const resizeGeometry = referenceLocalSpaceResizeGeometry(sourceBase.width, sourceBase.height, request.scale);
  const requestedWidth = resizeGeometry.requestedWidth;
  const requestedHeight = resizeGeometry.requestedHeight;
  const requestedBase = dimensions(
    node,
    requestedWidth,
    requestedHeight,
    "requested resize output",
    referenceLocalSpaceTransformWorkLimits.maximumIntermediateAxisPx,
    referenceLocalSpaceTransformWorkLimits.maximumIntermediatePixels,
  );
  const coverScale = resizeGeometry.effectiveScale;
  const coverBase = dimensions(
    node,
    resizeGeometry.sharpCoverWidth,
    resizeGeometry.sharpCoverHeight,
    "Sharp cover intermediate",
    referenceLocalSpaceTransformWorkLimits.maximumIntermediateAxisPx,
    referenceLocalSpaceTransformWorkLimits.maximumIntermediatePixels,
  );
  if (coverBase.width < requestedBase.width || coverBase.height < requestedBase.height) {
    fail(node, "CUT_LOCAL_SPACE_TRANSFORM_LIMIT", `Sharp cover accounting under-runs requested ${requestedBase.width}x${requestedBase.height} with ${coverBase.width}x${coverBase.height}.`);
  }

  const canonicalDegrees = canonicalReferenceLocalSpaceRotationDegrees(request.rotation);
  const rotatedBase = sharpRotationDimensions(node, requestedBase, canonicalDegrees);
  const retainedRgba8Bytes = sourceBase.pixels * 4;
  const source = Object.freeze({ ...sourceBase, retainedRgba8Bytes });
  const requestedResize = Object.freeze({ ...requestedBase, scale: request.scale });
  const sharpCover = Object.freeze({ ...coverBase, scale: coverScale });
  const rotation = Object.freeze({ ...rotatedBase, canonicalDegrees });

  const neutralFastPath = request.scale === 1 && canonicalDegrees === 0;
  const rgb16TransformPath = !neutralFastPath;
  const hasResizeFilter = requestedBase.width !== sourceBase.width || requestedBase.height !== sourceBase.height;
  const hasRotationFilter = canonicalDegrees !== 0;
  const straightSourceRgb16Bytes = rgb16TransformPath ? sourceBase.pixels * 8 : 0;
  const resize = hasResizeFilter
    ? rgb16FilterStage(node, retainedRgba8Bytes, sourceBase, requestedBase, coverBase.pixels)
    : undefined;
  const rotationStage = hasRotationFilter
    ? rgb16FilterStage(node, retainedRgba8Bytes, requestedBase, rotatedBase, rotatedBase.pixels)
    : undefined;
  const straightTransformedRgba8Bytes = rgb16TransformPath ? rotatedBase.pixels * 4 : 0;
  const destinationCanvasRgba8Bytes = destination.pixels * 4;
  const opacityDestinationCopies = request.opacity === 1 ? 0 as const : 1 as const;
  const opacityDestinationCopyBytes = opacityDestinationCopies * destinationCanvasRgba8Bytes;

  const totalAllocatedBytesUpperBound = safeBytes(node, [
    retainedRgba8Bytes,
    straightSourceRgb16Bytes,
    resize?.associatedInputCopyBytes ?? 0,
    resize?.sharpWorkingBytes ?? 0,
    resize?.backendOutputBytes ?? 0,
    resize?.copiedOutputBytes ?? 0,
    rotationStage?.associatedInputCopyBytes ?? 0,
    rotationStage?.sharpWorkingBytes ?? 0,
    rotationStage?.backendOutputBytes ?? 0,
    rotationStage?.copiedOutputBytes ?? 0,
    straightTransformedRgba8Bytes,
    destinationCanvasRgba8Bytes,
    opacityDestinationCopyBytes,
  ], "per-transform allocation envelope");
  const conversionPeak = safeBytes(node, [retainedRgba8Bytes, straightSourceRgb16Bytes], "RGBA8-to-RGB16 conversion peak");
  const finalStraightRgb16Bytes = rgb16TransformPath ? rotatedBase.pixels * 8 : 0;
  const conversionBackPeak = safeBytes(node, [retainedRgba8Bytes, finalStraightRgb16Bytes, straightTransformedRgba8Bytes], "RGB16-to-RGBA8 conversion peak");
  const translationPeak = safeBytes(node, [
    retainedRgba8Bytes,
    rgb16TransformPath ? straightTransformedRgba8Bytes : 0,
    destinationCanvasRgba8Bytes,
  ], "destination translation peak");
  const opacityPeak = safeBytes(node, [
    retainedRgba8Bytes,
    rgb16TransformPath ? straightTransformedRgba8Bytes : 0,
    destinationCanvasRgba8Bytes,
    opacityDestinationCopyBytes,
  ], "destination opacity peak");
  const peakLiveBytesUpperBound = Math.max(
    conversionPeak,
    resize?.peakLiveBytesUpperBound ?? 0,
    rotationStage?.peakLiveBytesUpperBound ?? 0,
    conversionBackPeak,
    translationPeak,
    opacityPeak,
  );
  if (!Number.isSafeInteger(peakLiveBytesUpperBound)
    || peakLiveBytesUpperBound > referenceLocalSpaceTransformWorkLimits.maximumPerTransformPeakBytes) {
    if (canonicalDegrees === 0 && hasResizeFilter) {
      // The exact destination clip is derived later from the retained
      // registration/translation plan. This allocator receipt binds its
      // conservative maximum (the complete destination canvas) so admission
      // remains fail-closed before the exact clip can allocate a byte.
      const maximumSamplerOutputRgba8Bytes = destinationCanvasRgba8Bytes;
      const directOpacityCopyBytes = opacityDestinationCopyBytes;
      const directTotalAllocatedBytesUpperBound = safeBytes(node, [
        retainedRgba8Bytes,
        maximumSamplerOutputRgba8Bytes,
        destinationCanvasRgba8Bytes,
        directOpacityCopyBytes,
      ], "destination-clipped direct scale+translation allocation envelope");
      const directPeakLiveBytesUpperBound = directTotalAllocatedBytesUpperBound;
      if (directPeakLiveBytesUpperBound > referenceLocalSpaceTransformWorkLimits.maximumPerTransformPeakBytes) {
        fail(
          node,
          "CUT_LOCAL_SPACE_TRANSFORM_LIMIT",
          `destination-clipped direct scale+translation peak is ${directPeakLiveBytesUpperBound} bytes; maximum remains ${referenceLocalSpaceTransformWorkLimits.maximumPerTransformPeakBytes}.`,
        );
      }
      const scheduling = Object.freeze({
        requiredDiscipline: "serialize-tile-transform-allocation-per-composition" as const,
        enforcement: referenceLocalSpaceTransformSchedulingEnforcement,
      });
      const directStages = Object.freeze({
        rgb16TransformPath: false as const,
        directDestinationClippedScaleTranslation: true as const,
        straightSourceRgb16Bytes: 0 as const,
        associatedRgb16StageCount: 0 as const,
        straightTransformedRgba8Bytes: 0 as const,
        maximumSamplerOutputRgba8Bytes,
        destinationCanvasRgba8Bytes,
        opacityDestinationCopies,
        opacityDestinationCopyBytes: directOpacityCopyBytes,
      });
      const directPerTransform = Object.freeze({
        totalAllocatedBytesUpperBound: directTotalAllocatedBytesUpperBound,
        peakLiveBytesUpperBound: directPeakLiveBytesUpperBound,
      });
      const directCompositionLiveOutput = Object.freeze({
        surfaces: 1 as const,
        pixels: destination.pixels,
        rgba8Bytes: destinationCanvasRgba8Bytes,
      });
      const directIdentityPayload = Object.freeze({
        algorithmVersion: referenceLocalSpaceDestinationClippedTransformWorkAlgorithmVersion,
        source,
        requestedResize,
        sharpCover,
        rotation,
        supersededLegacy: Object.freeze({
          totalAllocatedBytesUpperBound,
          peakLiveBytesUpperBound,
          refusedByMaximumPerTransformPeakBytes:
            referenceLocalSpaceTransformWorkLimits.maximumPerTransformPeakBytes,
        }),
        opacity: request.opacity,
        stages: directStages,
        perTransform: directPerTransform,
        compositionLiveOutput: directCompositionLiveOutput,
        scheduling,
      });
      return Object.freeze({
        format: "cut-reference-local-space-transform-work" as const,
        version: 4 as const,
        kind: "retained-tile-transform" as const,
        algorithmVersion: referenceLocalSpaceDestinationClippedTransformWorkAlgorithmVersion,
        rendererHandoff: referenceLocalSpaceTransformRendererHandoff,
        scheduling,
        source,
        requestedResize,
        sharpCover,
        rotation: Object.freeze({ ...rotation, canonicalDegrees: 0 as const }),
        supersededLegacy: directIdentityPayload.supersededLegacy,
        stages: directStages,
        perTransform: directPerTransform,
        compositionLiveOutput: directCompositionLiveOutput,
        workIdentity: hash(directIdentityPayload),
      });
    }
    fail(node, "CUT_LOCAL_SPACE_TRANSFORM_LIMIT", `per-transform peak is ${peakLiveBytesUpperBound} bytes; maximum is ${referenceLocalSpaceTransformWorkLimits.maximumPerTransformPeakBytes} until the renderer provides a measured cropped or streaming affine path.`);
  }

  const scheduling = Object.freeze({
    requiredDiscipline: "serialize-tile-transform-allocation-per-composition" as const,
    enforcement: referenceLocalSpaceTransformSchedulingEnforcement,
  });
  const stages = Object.freeze({
    rgb16TransformPath,
    straightSourceRgb16Bytes,
    associatedRgb16StageCount: Number(hasResizeFilter) + Number(hasRotationFilter),
    ...(resize ? { resize } : {}),
    ...(rotationStage ? { rotation: rotationStage } : {}),
    straightTransformedRgba8Bytes,
    destinationCanvasRgba8Bytes,
    opacityDestinationCopies,
    opacityDestinationCopyBytes,
  });
  const perTransform = Object.freeze({ totalAllocatedBytesUpperBound, peakLiveBytesUpperBound });
  const compositionLiveOutput = Object.freeze({ surfaces: 1 as const, pixels: destination.pixels, rgba8Bytes: destinationCanvasRgba8Bytes });
  const identityPayload = Object.freeze({
    algorithmVersion: referenceLocalSpaceTransformWorkAlgorithmVersion,
    source,
    requestedResize,
    sharpCover,
    rotation,
    opacity: request.opacity,
    stages,
    perTransform,
    compositionLiveOutput,
    scheduling,
  });
  return Object.freeze({
    format: "cut-reference-local-space-transform-work" as const,
    version: 2 as const,
    kind: "retained-tile-transform" as const,
    algorithmVersion: referenceLocalSpaceTransformWorkAlgorithmVersion,
    rendererHandoff: referenceLocalSpaceTransformRendererHandoff,
    scheduling,
    source,
    requestedResize,
    sharpCover,
    rotation,
    stages,
    perTransform,
    compositionLiveOutput,
    workIdentity: hash(identityPayload),
  });
}

function sharpSkewDimensions(
  node: IRNode,
  input: ReferenceLocalSpaceTransformDimensions,
  tangentX: number,
  tangentY: number,
) {
  // libvips expands affine output to the rounded continuous-edge bounding
  // box. For CUT's simultaneous shear matrix [[1, tx], [ty, 1]], the four
  // corners reduce exactly to these two ranges. The renderer verifies the
  // observed backend dimensions before the next filter can execute.
  return dimensions(
    node,
    Math.max(1, Math.round(input.width + Math.abs(tangentX) * input.height)),
    Math.max(1, Math.round(input.height + Math.abs(tangentY) * input.width)),
    "Sharp skew output",
    referenceLocalSpaceTransformWorkLimits.maximumIntermediateAxisPx,
    referenceLocalSpaceTransformWorkLimits.maximumIntermediatePixels,
  );
}

/** Plan the installed scale -> simultaneous two-axis shear -> rotation path.
 * Zero-skew requests deliberately delegate to V2 so historical work identity,
 * evidence, cache keys and downstream package contracts remain unchanged. */
export function planReferenceLocalSpaceAffineTileTransformWork(
  node: IRNode,
  request: ReferenceLocalSpaceAffineTransformRequest,
): ReferenceLocalSpaceAffineTileTransformWork {
  closedRecord(node, request, "affine transform request", ["source", "destination", "scale", "skewX", "skewY", "rotation", "opacity"]);
  closedRecord(node, request.source, "affine transform request source", ["width", "height"]);
  closedRecord(node, request.destination, "affine transform request destination", ["width", "height"]);
  if (!Number.isFinite(request.skewX) || request.skewX < -30 || request.skewX > 30) {
    fail(node, "CUT_LOCAL_SPACE_TRANSFORM_TYPE", `skewX must be finite in the closed range -30 through 30 degrees; received ${request.skewX}.`);
  }
  if (!Number.isFinite(request.skewY) || request.skewY < -30 || request.skewY > 30) {
    fail(node, "CUT_LOCAL_SPACE_TRANSFORM_TYPE", `skewY must be finite in the closed range -30 through 30 degrees; received ${request.skewY}.`);
  }
  if (request.skewX === 0 && request.skewY === 0) {
    return planReferenceLocalSpaceTileTransformWork(node, {
      source: request.source,
      destination: request.destination,
      scale: request.scale,
      rotation: request.rotation,
      opacity: request.opacity,
    });
  }

  // Let the stable V2 planner validate common scalar/source/destination
  // fields and derive the exact retained resize/cover geometry. Rotation is
  // intentionally zero here because V3 rotates the expanded skew surface.
  const base = planReferenceLocalSpaceTileTransformWork(node, {
    source: request.source,
    destination: request.destination,
    scale: request.scale,
    rotation: 0,
    opacity: request.opacity,
  });
  if (base.version === 4) {
    fail(
      node,
      "CUT_LOCAL_SPACE_TRANSFORM_LIMIT",
      "destination-clipped direct scale+translation cannot admit skew; the existing skew path remains under the unchanged intermediate-work ceiling.",
    );
  }
  const tangentX = Math.tan(request.skewX * Math.PI / 180);
  const tangentY = Math.tan(request.skewY * Math.PI / 180);
  if (!Number.isFinite(tangentX) || !Number.isFinite(tangentY)) {
    fail(node, "CUT_LOCAL_SPACE_TRANSFORM_TYPE", "skew tangents must remain finite at the installed affine boundary.");
  }
  const skewBase = sharpSkewDimensions(node, base.requestedResize, tangentX, tangentY);
  const canonicalDegrees = canonicalReferenceLocalSpaceRotationDegrees(request.rotation);
  if (!Number.isFinite(canonicalDegrees)) {
    fail(node, "CUT_LOCAL_SPACE_TRANSFORM_TYPE", `rotation must be finite; received ${request.rotation}.`);
  }
  const rotatedBase = sharpRotationDimensions(node, skewBase, canonicalDegrees);
  const skew = Object.freeze({
    ...skewBase,
    skewXDegrees: request.skewX,
    skewYDegrees: request.skewY,
    tangentX,
    tangentY,
  });
  const rotation = Object.freeze({ ...rotatedBase, canonicalDegrees });
  const retainedRgba8Bytes = base.source.retainedRgba8Bytes;
  const straightSourceRgb16Bytes = base.source.pixels * 8;
  const resize = base.stages.resize;
  const skewStage = rgb16FilterStage(node, retainedRgba8Bytes, base.requestedResize, skewBase, skewBase.pixels);
  const hasRotationFilter = canonicalDegrees !== 0;
  const rotationStage = hasRotationFilter
    ? rgb16FilterStage(node, retainedRgba8Bytes, skewBase, rotatedBase, rotatedBase.pixels)
    : undefined;
  const straightTransformedRgba8Bytes = rotatedBase.pixels * 4;
  const destinationCanvasRgba8Bytes = base.stages.destinationCanvasRgba8Bytes;
  const opacityDestinationCopies = request.opacity === 1 ? 0 as const : 1 as const;
  const opacityDestinationCopyBytes = opacityDestinationCopies * destinationCanvasRgba8Bytes;
  const totalAllocatedBytesUpperBound = safeBytes(node, [
    retainedRgba8Bytes,
    straightSourceRgb16Bytes,
    resize?.associatedInputCopyBytes ?? 0,
    resize?.sharpWorkingBytes ?? 0,
    resize?.backendOutputBytes ?? 0,
    resize?.copiedOutputBytes ?? 0,
    skewStage.associatedInputCopyBytes,
    skewStage.sharpWorkingBytes,
    skewStage.backendOutputBytes,
    skewStage.copiedOutputBytes,
    rotationStage?.associatedInputCopyBytes ?? 0,
    rotationStage?.sharpWorkingBytes ?? 0,
    rotationStage?.backendOutputBytes ?? 0,
    rotationStage?.copiedOutputBytes ?? 0,
    straightTransformedRgba8Bytes,
    destinationCanvasRgba8Bytes,
    opacityDestinationCopyBytes,
  ], "skew-aware per-transform allocation envelope");
  const conversionPeak = safeBytes(node, [retainedRgba8Bytes, straightSourceRgb16Bytes], "RGBA8-to-RGB16 conversion peak");
  const finalStraightRgb16Bytes = rotatedBase.pixels * 8;
  const conversionBackPeak = safeBytes(node, [retainedRgba8Bytes, finalStraightRgb16Bytes, straightTransformedRgba8Bytes], "RGB16-to-RGBA8 conversion peak");
  const translationPeak = safeBytes(node, [retainedRgba8Bytes, straightTransformedRgba8Bytes, destinationCanvasRgba8Bytes], "destination translation peak");
  const opacityPeak = safeBytes(node, [retainedRgba8Bytes, straightTransformedRgba8Bytes, destinationCanvasRgba8Bytes, opacityDestinationCopyBytes], "destination opacity peak");
  const peakLiveBytesUpperBound = Math.max(
    conversionPeak,
    resize?.peakLiveBytesUpperBound ?? 0,
    skewStage.peakLiveBytesUpperBound,
    rotationStage?.peakLiveBytesUpperBound ?? 0,
    conversionBackPeak,
    translationPeak,
    opacityPeak,
  );
  if (!Number.isSafeInteger(peakLiveBytesUpperBound)
    || peakLiveBytesUpperBound > referenceLocalSpaceTransformWorkLimits.maximumPerTransformPeakBytes) {
    fail(node, "CUT_LOCAL_SPACE_TRANSFORM_LIMIT", `skew-aware per-transform peak is ${peakLiveBytesUpperBound} bytes; maximum is ${referenceLocalSpaceTransformWorkLimits.maximumPerTransformPeakBytes} until the renderer provides a measured cropped or streaming affine path.`);
  }
  const scheduling = Object.freeze({
    requiredDiscipline: "serialize-tile-transform-allocation-per-composition" as const,
    enforcement: referenceLocalSpaceTransformSchedulingEnforcement,
  });
  const stages = Object.freeze({
    rgb16TransformPath: true as const,
    straightSourceRgb16Bytes,
    associatedRgb16StageCount: Number(Boolean(resize)) + 1 + Number(hasRotationFilter),
    ...(resize ? { resize } : {}),
    skew: skewStage,
    ...(rotationStage ? { rotation: rotationStage } : {}),
    straightTransformedRgba8Bytes,
    destinationCanvasRgba8Bytes,
    opacityDestinationCopies,
    opacityDestinationCopyBytes,
  });
  const perTransform = Object.freeze({ totalAllocatedBytesUpperBound, peakLiveBytesUpperBound });
  const compositionLiveOutput = Object.freeze({ ...base.compositionLiveOutput });
  const identityPayload = Object.freeze({
    algorithmVersion: referenceLocalSpaceAffineTransformWorkAlgorithmVersion,
    source: base.source,
    requestedResize: base.requestedResize,
    sharpCover: base.sharpCover,
    skew,
    rotation,
    opacity: request.opacity,
    stages,
    perTransform,
    compositionLiveOutput,
    scheduling,
  });
  return Object.freeze({
    format: "cut-reference-local-space-transform-work" as const,
    version: 3 as const,
    kind: "retained-tile-transform" as const,
    algorithmVersion: referenceLocalSpaceAffineTransformWorkAlgorithmVersion,
    rendererHandoff: referenceLocalSpaceTransformRendererHandoff,
    scheduling,
    source: base.source,
    requestedResize: base.requestedResize,
    sharpCover: base.sharpCover,
    skew,
    rotation,
    stages,
    perTransform,
    compositionLiveOutput,
    workIdentity: hash(identityPayload),
  });
}

/** Aggregate owner outputs conservatively. The connected renderer enforces
 * FIFO transform execution, while the unscheduled sum remains the stricter
 * admission envelope so alternate consumers cannot assume that scheduler. */
function aggregateFreshReferenceLocalSpaceCompositionTransformWork(
  node: IRNode,
  composition: IRComposition,
  work: readonly ReferenceLocalSpaceAffineTileTransformWork[],
): ReferenceLocalSpaceCompositionTransformWork | ReferenceLocalSpaceDestinationClippedCompositionTransformWork {
  if (!Array.isArray(work) || work.length > referenceLocalSpaceTransformWorkLimits.maximumCompositionTransforms) {
    fail(node, "CUT_LOCAL_SPACE_TRANSFORM_AGGREGATE", `composition transform count exceeds ${referenceLocalSpaceTransformWorkLimits.maximumCompositionTransforms}.`);
  }
  let aggregateAllocatedBytesUpperBound = 0;
  let compositionLiveOutputPixels = 0;
  let compositionLiveOutputBytes = 0;
  let maximumPerTransformPeakBytes = 0;
  let unscheduledCompositionPeakBytesUpperBound = 0;
  for (const entry of work) {
    // An affine retained placement may publish either a delivery-canvas
    // surface or an intermediate parent-LocalSpace surface. Both remain live
    // inside the same composition-frame transaction and therefore share this
    // one aggregate memory envelope. Per-entry planning already validates the
    // exact destination dimensions; do not erase smaller nested outputs by
    // pretending every placement targets delivery size.
    aggregateAllocatedBytesUpperBound = safeBytes(node, [aggregateAllocatedBytesUpperBound, entry.perTransform.totalAllocatedBytesUpperBound], "aggregate allocated-work envelope");
    compositionLiveOutputPixels += entry.compositionLiveOutput.pixels;
    compositionLiveOutputBytes = safeBytes(node, [compositionLiveOutputBytes, entry.compositionLiveOutput.rgba8Bytes], "composition-live output envelope");
    maximumPerTransformPeakBytes = Math.max(maximumPerTransformPeakBytes, entry.perTransform.peakLiveBytesUpperBound);
    unscheduledCompositionPeakBytesUpperBound = safeBytes(node, [unscheduledCompositionPeakBytesUpperBound, entry.perTransform.peakLiveBytesUpperBound], "unscheduled composition peak envelope");
  }
  if (compositionLiveOutputBytes > referenceLocalSpaceTransformWorkLimits.maximumCompositionLiveOutputBytes) {
    fail(node, "CUT_LOCAL_SPACE_TRANSFORM_AGGREGATE", `composition-live outputs require ${compositionLiveOutputBytes} bytes; maximum is ${referenceLocalSpaceTransformWorkLimits.maximumCompositionLiveOutputBytes}.`);
  }
  if (unscheduledCompositionPeakBytesUpperBound > referenceLocalSpaceTransformWorkLimits.maximumCompositionUnscheduledPeakBytes) {
    fail(node, "CUT_LOCAL_SPACE_TRANSFORM_AGGREGATE", `unscheduled transform peaks total ${unscheduledCompositionPeakBytesUpperBound} bytes; maximum is ${referenceLocalSpaceTransformWorkLimits.maximumCompositionUnscheduledPeakBytes} until renderer serialization is enforced.`);
  }
  const serializedCompositionPeakBytesUpperBound = safeBytes(node, [compositionLiveOutputBytes, maximumPerTransformPeakBytes], "serialized composition peak envelope");
  const scheduling = Object.freeze({
    requiredDiscipline: "serialize-tile-transform-allocation-per-composition" as const,
    enforcement: referenceLocalSpaceTransformSchedulingEnforcement,
  });
  const destinationClipped = work.some((entry) => entry.version === 4);
  const identityFields = Object.freeze({
    composition: Object.freeze({ id: composition.id, width: composition.width, height: composition.height }),
    workIdentities: Object.freeze(work.map((entry) => entry.workIdentity).sort()),
    scheduling,
    aggregateAllocatedBytesUpperBound,
    compositionLiveOutputPixels,
    compositionLiveOutputBytes,
    maximumPerTransformPeakBytes,
    serializedCompositionPeakBytesUpperBound,
    unscheduledCompositionPeakBytesUpperBound,
  });
  const outputFields = Object.freeze({
    format: "cut-reference-local-space-composition-transform-work" as const,
    compositionId: composition.id,
    transformCount: work.length,
    scheduling,
    aggregateAllocatedBytesUpperBound,
    compositionLiveOutputSurfaces: work.length,
    compositionLiveOutputPixels,
    compositionLiveOutputBytes,
    maximumPerTransformPeakBytes,
    serializedCompositionPeakBytesUpperBound,
    unscheduledCompositionPeakBytesUpperBound,
    conservativeSafetyEnvelope: "unscheduled-sum" as const,
  });
  if (destinationClipped) {
    const algorithmVersion = referenceLocalSpaceDestinationClippedTransformWorkAlgorithmVersion;
    return Object.freeze({
      ...outputFields,
      version: 4 as const,
      algorithmVersion,
      workIdentity: hash(Object.freeze({ algorithmVersion, ...identityFields })),
    });
  }
  const algorithmVersion = referenceLocalSpaceTransformWorkAlgorithmVersion;
  return Object.freeze({
    ...outputFields,
    version: 2 as const,
    algorithmVersion,
    workIdentity: hash(Object.freeze({ algorithmVersion, ...identityFields })),
  });
}

/** Plan and aggregate raw owner requests in one closed operation. Callers
 * cannot forge a smaller receipt or work identity because individual plans
 * never cross this exported aggregation boundary. */
export function planReferenceLocalSpaceCompositionTransformWork(
  node: IRNode,
  composition: IRComposition,
  requests: readonly ReferenceLocalSpaceCompositionTransformRequest[],
): ReferenceLocalSpaceUniformCompositionTransformWork {
  if (!Array.isArray(requests) || requests.length > referenceLocalSpaceTransformWorkLimits.maximumCompositionTransforms) {
    fail(node, "CUT_LOCAL_SPACE_TRANSFORM_AGGREGATE", `composition transform count exceeds ${referenceLocalSpaceTransformWorkLimits.maximumCompositionTransforms}.`);
  }
  const planned: Array<ReferenceLocalSpaceTileTransformWork | ReferenceLocalSpaceDestinationClippedTransformWork> = [];
  for (let index = 0; index < requests.length; index += 1) {
    if (!Object.hasOwn(requests, index)) {
      fail(node, "CUT_LOCAL_SPACE_TRANSFORM_AGGREGATE", `composition transform requests cannot contain a hole at index ${index}.`);
    }
    const unknownEntry = requests[index] as unknown;
    if (!unknownEntry || typeof unknownEntry !== "object" || Array.isArray(unknownEntry)) {
      fail(node, "CUT_LOCAL_SPACE_TRANSFORM_AGGREGATE", `request ${index} must contain exactly node and transform.`);
    }
    const keys = Reflect.ownKeys(unknownEntry);
    if (keys.length !== 2 || !keys.includes("node") || !keys.includes("transform") || keys.some((key) => typeof key !== "string")) {
      fail(node, "CUT_LOCAL_SPACE_TRANSFORM_AGGREGATE", `request ${index} must contain exactly node and transform; precomputed or forged work receipts are forbidden.`);
    }
    const entry = unknownEntry as ReferenceLocalSpaceCompositionTransformRequest;
    if (!entry.node || typeof entry.node !== "object" || !entry.node.provenance
      || !entry.transform || typeof entry.transform !== "object" || Array.isArray(entry.transform)) {
      fail(node, "CUT_LOCAL_SPACE_TRANSFORM_AGGREGATE", `request ${index} must contain one source-located IR owner node and one transform request.`);
    }
    planned.push(planReferenceLocalSpaceTileTransformWork(entry.node, entry.transform));
  }
  return aggregateFreshReferenceLocalSpaceCompositionTransformWork(node, composition, planned);
}

/** Closed aggregate entrypoint for the installed affine path. As with the
 * tile planner, a wholly non-skew request set preserves the V2 aggregate
 * identity. Mixed V2/V3 work is admitted under one V3 composition envelope. */
export function planReferenceLocalSpaceAffineCompositionTransformWork(
  node: IRNode,
  composition: IRComposition,
  requests: readonly ReferenceLocalSpaceAffineCompositionTransformRequest[],
): ReferenceLocalSpaceCompositionTransformWork
  | ReferenceLocalSpaceAffineCompositionTransformWork
  | ReferenceLocalSpaceDestinationClippedCompositionTransformWork {
  if (!Array.isArray(requests) || requests.length > referenceLocalSpaceTransformWorkLimits.maximumCompositionTransforms) {
    fail(node, "CUT_LOCAL_SPACE_TRANSFORM_AGGREGATE", `composition transform count exceeds ${referenceLocalSpaceTransformWorkLimits.maximumCompositionTransforms}.`);
  }
  const planned: ReferenceLocalSpaceAffineTileTransformWork[] = [];
  for (let index = 0; index < requests.length; index += 1) {
    if (!Object.hasOwn(requests, index)) {
      fail(node, "CUT_LOCAL_SPACE_TRANSFORM_AGGREGATE", `composition affine transform requests cannot contain a hole at index ${index}.`);
    }
    const unknownEntry = requests[index] as unknown;
    if (!unknownEntry || typeof unknownEntry !== "object" || Array.isArray(unknownEntry)) {
      fail(node, "CUT_LOCAL_SPACE_TRANSFORM_AGGREGATE", `affine request ${index} must contain exactly node and transform.`);
    }
    const keys = Reflect.ownKeys(unknownEntry);
    if (keys.length !== 2 || !keys.includes("node") || !keys.includes("transform") || keys.some((key) => typeof key !== "string")) {
      fail(node, "CUT_LOCAL_SPACE_TRANSFORM_AGGREGATE", `affine request ${index} must contain exactly node and transform; precomputed or forged work receipts are forbidden.`);
    }
    const entry = unknownEntry as ReferenceLocalSpaceAffineCompositionTransformRequest;
    if (!entry.node || typeof entry.node !== "object" || !entry.node.provenance
      || !entry.transform || typeof entry.transform !== "object" || Array.isArray(entry.transform)) {
      fail(node, "CUT_LOCAL_SPACE_TRANSFORM_AGGREGATE", `affine request ${index} must contain one source-located IR owner node and one transform request.`);
    }
    planned.push(planReferenceLocalSpaceAffineTileTransformWork(entry.node, entry.transform));
  }
  if (planned.some((entry) => entry.version === 4)) {
    return aggregateFreshReferenceLocalSpaceCompositionTransformWork(
      node,
      composition,
      planned,
    );
  }
  if (planned.every((entry) => entry.version === 2)) {
    return aggregateFreshReferenceLocalSpaceCompositionTransformWork(
      node,
      composition,
      planned,
    );
  }

  let aggregateAllocatedBytesUpperBound = 0;
  let compositionLiveOutputPixels = 0;
  let compositionLiveOutputBytes = 0;
  let maximumPerTransformPeakBytes = 0;
  let unscheduledCompositionPeakBytesUpperBound = 0;
  for (const entry of planned) {
    aggregateAllocatedBytesUpperBound = safeBytes(node, [aggregateAllocatedBytesUpperBound, entry.perTransform.totalAllocatedBytesUpperBound], "affine aggregate allocated-work envelope");
    compositionLiveOutputPixels += entry.compositionLiveOutput.pixels;
    compositionLiveOutputBytes = safeBytes(node, [compositionLiveOutputBytes, entry.compositionLiveOutput.rgba8Bytes], "affine composition-live output envelope");
    maximumPerTransformPeakBytes = Math.max(maximumPerTransformPeakBytes, entry.perTransform.peakLiveBytesUpperBound);
    unscheduledCompositionPeakBytesUpperBound = safeBytes(node, [unscheduledCompositionPeakBytesUpperBound, entry.perTransform.peakLiveBytesUpperBound], "unscheduled affine composition peak envelope");
  }
  if (!Number.isSafeInteger(compositionLiveOutputPixels)) {
    fail(node, "CUT_LOCAL_SPACE_TRANSFORM_AGGREGATE", "affine composition-live output pixels exceed the safe integer range.");
  }
  if (compositionLiveOutputBytes > referenceLocalSpaceTransformWorkLimits.maximumCompositionLiveOutputBytes) {
    fail(node, "CUT_LOCAL_SPACE_TRANSFORM_AGGREGATE", `affine composition-live outputs require ${compositionLiveOutputBytes} bytes; maximum is ${referenceLocalSpaceTransformWorkLimits.maximumCompositionLiveOutputBytes}.`);
  }
  if (unscheduledCompositionPeakBytesUpperBound > referenceLocalSpaceTransformWorkLimits.maximumCompositionUnscheduledPeakBytes) {
    fail(node, "CUT_LOCAL_SPACE_TRANSFORM_AGGREGATE", `unscheduled affine transform peaks total ${unscheduledCompositionPeakBytesUpperBound} bytes; maximum is ${referenceLocalSpaceTransformWorkLimits.maximumCompositionUnscheduledPeakBytes} until renderer serialization is enforced.`);
  }
  const serializedCompositionPeakBytesUpperBound = safeBytes(node, [compositionLiveOutputBytes, maximumPerTransformPeakBytes], "serialized affine composition peak envelope");
  const scheduling = Object.freeze({
    requiredDiscipline: "serialize-tile-transform-allocation-per-composition" as const,
    enforcement: referenceLocalSpaceTransformSchedulingEnforcement,
  });
  const identityPayload = Object.freeze({
    algorithmVersion: referenceLocalSpaceAffineTransformWorkAlgorithmVersion,
    composition: Object.freeze({ id: composition.id, width: composition.width, height: composition.height }),
    workIdentities: Object.freeze(planned.map((entry) => entry.workIdentity).sort()),
    scheduling,
    aggregateAllocatedBytesUpperBound,
    compositionLiveOutputPixels,
    compositionLiveOutputBytes,
    maximumPerTransformPeakBytes,
    serializedCompositionPeakBytesUpperBound,
    unscheduledCompositionPeakBytesUpperBound,
  });
  return Object.freeze({
    format: "cut-reference-local-space-composition-transform-work" as const,
    version: 3 as const,
    algorithmVersion: referenceLocalSpaceAffineTransformWorkAlgorithmVersion,
    compositionId: composition.id,
    transformCount: planned.length,
    scheduling,
    aggregateAllocatedBytesUpperBound,
    compositionLiveOutputSurfaces: planned.length,
    compositionLiveOutputPixels,
    compositionLiveOutputBytes,
    maximumPerTransformPeakBytes,
    serializedCompositionPeakBytesUpperBound,
    unscheduledCompositionPeakBytesUpperBound,
    conservativeSafetyEnvelope: "unscheduled-sum" as const,
    workIdentity: hash(identityPayload),
  });
}
