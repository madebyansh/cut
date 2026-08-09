import { hash } from "../../core/stable";
import type { IRNode } from "../../language/ir";
import type { ReferenceLocalSpacePlacement } from "./local-space";
import {
  planReferenceLocalSpaceTileTransformWork,
  referenceLocalSpaceResizeGeometry,
} from "./local-space-transform-work";
import { placeReferenceProjectiveWarpOnCanvas } from "./projective-warp-canvas";
import { executeReferenceNativeScaleTranslationQ16 } from "./native-source-over";
import {
  planReferenceProjectiveWarp,
  referenceProjectiveWarpAlgorithmVersion,
  referenceProjectiveWarpPhaseUnits,
  type ReferenceProjectiveWarpPlan,
  type ReferenceProjectiveWarpResult,
  type ReferenceProjectiveWarpExecutionOptions,
  type ReferenceStraightRgbaWarpSurface,
} from "./projective-warp-kernel";

/**
 * A scaled retained tile whose final translation has a fractional phase must
 * not be resized and then bilinearly translated a second time. This plan
 * preserves the established integer resize geometry while sampling the
 * source tile into the destination canvas exactly once.
 */
export const referenceLocalSpaceScaleTranslationAlgorithmVersion =
  "cut-reference-local-space-scale-translation-v2" as const;
export const referenceLocalSpaceScaleTranslationSampler =
  "cut-q16-associated-bilinear-destination-clipped-affine" as const;

export type ReferenceLocalSpaceScaleTranslationErrorCode =
  | "CUT_LOCAL_SPACE_SCALE_TRANSLATION_PLAN"
  | "CUT_LOCAL_SPACE_SCALE_TRANSLATION_RASTER";

export class ReferenceLocalSpaceScaleTranslationError extends Error {
  readonly source: Readonly<{ module: string; line: number; column: number; nodeId: string }>;

  constructor(
    readonly code: ReferenceLocalSpaceScaleTranslationErrorCode,
    readonly node: IRNode,
    detail: string,
  ) {
    const { module, span } = node.provenance;
    super(`${code}: retained scale+translation at ${module}:${span.start.line}:${span.start.column} ${detail}`);
    this.name = "ReferenceLocalSpaceScaleTranslationError";
    this.source = Object.freeze({
      module,
      line: span.start.line,
      column: span.start.column,
      nodeId: node.id,
    });
  }
}

type Dimensions = Readonly<{ width: number; height: number }>;

export type ReferenceLocalSpaceScaleTranslationPlan = Readonly<{
  algorithmVersion: typeof referenceLocalSpaceScaleTranslationAlgorithmVersion;
  sampler: typeof referenceLocalSpaceScaleTranslationSampler;
  projectiveAlgorithmVersion: typeof referenceProjectiveWarpAlgorithmVersion;
  source: Dimensions;
  destination: Dimensions;
  authored: Readonly<{
    scale: number;
    opacity: number;
    destinationX: number;
    destinationY: number;
    registrationRasterX: number;
    registrationRasterY: number;
  }>;
  raster: Readonly<{
    effectiveScale: number;
    requestedResize: Dimensions;
    legacyTranslationQ16: Readonly<{
      integerX: number;
      integerY: number;
      phaseX: number;
      phaseY: number;
    }>;
  }>;
  activation: "fractional-phase" | "legacy-work-ceiling";
  destinationClip: Readonly<{
    status: "visible" | "off-canvas";
    bounds: Readonly<{ left: number; top: number; right: number; bottom: number }>;
    width: number;
    height: number;
    pixels: number;
    rgbaBytes: number;
  }>;
  projective?: ReferenceProjectiveWarpPlan;
  transformWorkIdentity: string;
  planIdentity: string;
}>;

export type ReferenceLocalSpaceScaleTranslationExecutionEvidence = Readonly<{
  algorithmVersion: typeof referenceLocalSpaceScaleTranslationAlgorithmVersion;
  sampler: typeof referenceLocalSpaceScaleTranslationSampler;
  projectiveAlgorithmVersion: typeof referenceProjectiveWarpAlgorithmVersion;
  planIdentity: string;
  projectivePlanIdentity: string;
  transformWorkIdentity: string;
  activation: ReferenceLocalSpaceScaleTranslationPlan["activation"];
  destinationClip: ReferenceLocalSpaceScaleTranslationPlan["destinationClip"];
  effectiveScale: number;
  legacyTranslationQ16: ReferenceLocalSpaceScaleTranslationPlan["raster"]["legacyTranslationQ16"];
  observedWork: ReferenceProjectiveWarpResult["observedWork"] & Readonly<{
    canvasPixelsAllocated: number;
    canvasRgbaBytesAllocated: number;
    canvasPixelsCopied: number;
    canvasRgbaBytesCopied: number;
  }>;
}>;

function q16Placement(value: number, node: IRNode, axis: "x" | "y") {
  if (!Number.isFinite(value)) {
    throw new ReferenceLocalSpaceScaleTranslationError(
      "CUT_LOCAL_SPACE_SCALE_TRANSLATION_PLAN",
      node,
      `${axis} placement must be finite.`,
    );
  }
  let integer = Math.floor(value);
  let phase = Math.round((value - integer) * referenceProjectiveWarpPhaseUnits);
  if (phase === referenceProjectiveWarpPhaseUnits) {
    integer += 1;
    phase = 0;
  }
  return Object.freeze({ integer, phase });
}

function planFailure(node: IRNode, error: unknown): never {
  if (error instanceof ReferenceLocalSpaceScaleTranslationError) throw error;
  throw new ReferenceLocalSpaceScaleTranslationError(
    "CUT_LOCAL_SPACE_SCALE_TRANSLATION_PLAN",
    node,
    error instanceof Error ? error.message : String(error),
  );
}

function floorDivision(numerator: bigint, denominator: bigint) {
  if (denominator <= 0n) throw new Error("positive denominator required");
  let quotient = numerator / denominator;
  if (numerator < 0n && numerator % denominator !== 0n) quotient -= 1n;
  return quotient;
}

function ceilDivision(numerator: bigint, denominator: bigint) {
  return -floorDivision(-numerator, denominator);
}

/** Exact equivalent of Math.round(numerator / denominator): ties advance
 * toward positive infinity. This is deliberately the same frozen law as the
 * generic projective kernel, but the axis-aligned affine owner computes it
 * once per destination column/row instead of re-evaluating a 3x3 BigInt
 * homography at every pixel. */
function roundRationalToInteger(numerator: bigint, denominator: bigint) {
  let n = numerator, d = denominator;
  if (d === 0n) throw new Error("scale+translation inverse map has a zero span.");
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  return floorDivision(2n * n + d, 2n * d);
}

function clippedPixelBounds(
  quad: readonly Readonly<{ x: number; y: number }>[],
  destination: Dimensions,
) {
  const units = BigInt(referenceProjectiveWarpPhaseUnits);
  const half = units / 2n;
  const q = (value: number) => BigInt(Math.round(value * referenceProjectiveWarpPhaseUnits));
  const xs = quad.map((point) => q(point.x));
  const ys = quad.map((point) => q(point.y));
  const minimumX = xs.reduce((minimum, value) => value < minimum ? value : minimum);
  const maximumX = xs.reduce((maximum, value) => value > maximum ? value : maximum);
  const minimumY = ys.reduce((minimum, value) => value < minimum ? value : minimum);
  const maximumY = ys.reduce((maximum, value) => value > maximum ? value : maximum);
  const unclippedLeft = Number(ceilDivision(minimumX - half, units));
  const unclippedTop = Number(ceilDivision(minimumY - half, units));
  const unclippedRight = Number(floorDivision(maximumX - half, units) + 1n);
  const unclippedBottom = Number(floorDivision(maximumY - half, units) + 1n);
  const left = Math.max(0, Math.min(destination.width, unclippedLeft));
  const top = Math.max(0, Math.min(destination.height, unclippedTop));
  const right = Math.max(left, Math.max(0, Math.min(destination.width, unclippedRight)));
  const bottom = Math.max(top, Math.max(0, Math.min(destination.height, unclippedBottom)));
  const width = right - left, height = bottom - top, pixels = width * height, rgbaBytes = pixels * 4;
  if (![left, top, right, bottom, width, height, pixels, rgbaBytes].every(Number.isSafeInteger)) {
    throw new Error("destination clip exceeds safe integer accounting.");
  }
  return Object.freeze({
    status: pixels === 0 ? "off-canvas" as const : "visible" as const,
    bounds: Object.freeze({ left, top, right, bottom }),
    width,
    height,
    pixels,
    rgbaBytes,
  });
}

/**
 * Return a direct plan for every historical real-resize plus fractional-Q16
 * placement, and for an integer-phase resize only when the unchanged legacy
 * RGB16 intermediate exceeds the admitted work ceiling. Neutral/no-resize,
 * admitted integer-phase, rotation and skew retain their established byte
 * path.
 */
export function planReferenceLocalSpaceScaleTranslation(
  node: IRNode,
  source: Dimensions,
  destination: Dimensions,
  placement: ReferenceLocalSpacePlacement,
): ReferenceLocalSpaceScaleTranslationPlan | undefined {
  if (placement.rotation !== 0 || placement.skewX !== 0 || placement.skewY !== 0) return undefined;
  let resize: ReturnType<typeof referenceLocalSpaceResizeGeometry>;
  try {
    resize = referenceLocalSpaceResizeGeometry(source.width, source.height, placement.scale);
  } catch (error) {
    return planFailure(node, error);
  }
  if (resize.requestedWidth === source.width && resize.requestedHeight === source.height) return undefined;

  const transformedRegistrationX =
    placement.registrationRasterX * resize.effectiveScale + resize.reductionPhase - resize.cropLeft;
  const transformedRegistrationY =
    placement.registrationRasterY * resize.effectiveScale + resize.reductionPhase - resize.cropTop;
  const horizontal = q16Placement(
    placement.destinationX - transformedRegistrationX,
    node,
    "x",
  );
  const vertical = q16Placement(
    placement.destinationY - transformedRegistrationY,
    node,
    "y",
  );
  let transformWork: ReturnType<typeof planReferenceLocalSpaceTileTransformWork>;
  try {
    transformWork = planReferenceLocalSpaceTileTransformWork(node, {
      source,
      destination,
      scale: placement.scale,
      rotation: 0,
      opacity: placement.opacity,
    });
  } catch (error) {
    return planFailure(node, error);
  }
  const activation = transformWork.version === 4
    ? "legacy-work-ceiling" as const
    : "fractional-phase" as const;
  if (horizontal.phase === 0 && vertical.phase === 0 && activation !== "legacy-work-ceiling") return undefined;

  const mapX = (sourceRasterX: number) =>
    placement.destinationX
      + (sourceRasterX - placement.registrationRasterX) * resize.effectiveScale;
  const mapY = (sourceRasterY: number) =>
    placement.destinationY
      + (sourceRasterY - placement.registrationRasterY) * resize.effectiveScale;
  const destinationQuad = [
    { x: mapX(-0.5), y: mapY(-0.5) },
    { x: mapX(source.width - 0.5), y: mapY(-0.5) },
    { x: mapX(source.width - 0.5), y: mapY(source.height - 0.5) },
    { x: mapX(-0.5), y: mapY(source.height - 0.5) },
  ] as const;
  let destinationClip: ReturnType<typeof clippedPixelBounds>;
  let projective: ReferenceProjectiveWarpPlan | undefined;
  try {
    destinationClip = clippedPixelBounds(destinationQuad, destination);
    if (destinationClip.status === "visible") {
      projective = planReferenceProjectiveWarp({
        sourceWidth: source.width,
        sourceHeight: source.height,
        destinationQuad,
        destinationBounds: destinationClip.bounds,
      });
    } else {
      // Off-canvas is an execution no-op, not a validation bypass. Exercise
      // the same exact coordinate/quad/homography limits against one bounded
      // validation pixel without publishing or allocating a raster plan.
      planReferenceProjectiveWarp({
        sourceWidth: source.width,
        sourceHeight: source.height,
        destinationQuad,
        destinationBounds: { left: 0, top: 0, right: 1, bottom: 1 },
      });
    }
  } catch (error) {
    return planFailure(node, error);
  }
  const value = Object.freeze({
    algorithmVersion: referenceLocalSpaceScaleTranslationAlgorithmVersion,
    sampler: referenceLocalSpaceScaleTranslationSampler,
    projectiveAlgorithmVersion: referenceProjectiveWarpAlgorithmVersion,
    source: Object.freeze({ ...source }),
    destination: Object.freeze({ ...destination }),
    authored: Object.freeze({
      scale: placement.scale,
      opacity: placement.opacity,
      destinationX: placement.destinationX,
      destinationY: placement.destinationY,
      registrationRasterX: placement.registrationRasterX,
      registrationRasterY: placement.registrationRasterY,
    }),
    raster: Object.freeze({
      effectiveScale: resize.effectiveScale,
      requestedResize: Object.freeze({
        width: resize.requestedWidth,
        height: resize.requestedHeight,
      }),
      legacyTranslationQ16: Object.freeze({
        integerX: horizontal.integer,
        integerY: vertical.integer,
        phaseX: horizontal.phase,
        phaseY: vertical.phase,
      }),
    }),
    activation,
    destinationClip,
    ...(projective ? { projective } : {}),
    transformWorkIdentity: transformWork.workIdentity,
  });
  return Object.freeze({ ...value, planIdentity: hash(value) });
}

function sourceByte(surface: ReferenceStraightRgbaWarpSurface, x: number, y: number, channel: number) {
  if (x < 0 || y < 0 || x >= surface.width || y >= surface.height) return 0;
  return surface.data[(y * surface.width + x) * 4 + channel]!;
}

function roundedRatio(numerator: number, denominator: number) {
  return Math.floor((numerator * 2 + denominator) / (denominator * 2));
}

/**
 * Execute the axis-aligned subset of the frozen projective law. The admitted
 * Q16 quad remains the semantic authority. Separating X/Y exact evaluation
 * reduces BigInt work from O(destination pixels) to O(width + height), while
 * the associated-alpha bilinear law remains byte-identical.
 */
function rasterDestinationClippedScaleTranslation(
  surface: ReferenceStraightRgbaWarpSurface,
  plan: ReferenceLocalSpaceScaleTranslationPlan,
  options: ReferenceProjectiveWarpExecutionOptions,
): ReferenceProjectiveWarpResult {
  const projective = plan.projective;
  if (!projective || plan.destinationClip.status !== "visible") {
    throw new Error("visible destination-clipped execution requires one projective plan.");
  }
  if (!(surface.data instanceof Uint8Array)
    || (surface.alphaMode !== undefined && surface.alphaMode !== "straight")
    || surface.width !== projective.source.width
    || surface.height !== projective.source.height
    || surface.data.byteLength !== projective.source.rgbaBytes) {
    throw new Error(
      `input must match the admitted ${projective.source.width}x${projective.source.height} / ${projective.source.rgbaBytes}-byte straight RGBA8 source.`,
    );
  }

  const quad = projective.destination.quadQ16.map((point) => Object.freeze({
    x: BigInt(point.x),
    y: BigInt(point.y),
  }));
  const [topLeft, topRight, bottomRight, bottomLeft] = quad;
  if (!topLeft || !topRight || !bottomRight || !bottomLeft
    || topLeft.y !== topRight.y
    || bottomLeft.y !== bottomRight.y
    || topLeft.x !== bottomLeft.x
    || topRight.x !== bottomRight.x
    || topRight.x <= topLeft.x
    || bottomLeft.y <= topLeft.y) {
    throw new Error("scale+translation projective plan is not one positive axis-aligned Q16 quad.");
  }
  const bounds = projective.destination.bounds;
  const clip = plan.destinationClip;
  if (bounds.left !== clip.bounds.left || bounds.top !== clip.bounds.top
    || bounds.right !== clip.bounds.right || bounds.bottom !== clip.bounds.bottom
    || projective.destination.width !== clip.width
    || projective.destination.height !== clip.height
    || projective.destination.pixels !== clip.pixels
    || projective.destination.rgbaBytes !== clip.rgbaBytes) {
    throw new Error("projective destination work does not match the admitted destination clip.");
  }

  const q16 = BigInt(referenceProjectiveWarpPhaseUnits);
  const q16Half = q16 / 2n;
  const horizontalSpan = topRight.x - topLeft.x;
  const verticalSpan = bottomLeft.y - topLeft.y;
  const sourceXQ16 = new Float64Array(clip.width);
  const sourceYQ16 = new Float64Array(clip.height);
  for (let index = 0; index < clip.width; index += 1) {
    const destination = BigInt(clip.bounds.left + index) * q16 + q16Half;
    sourceXQ16[index] = Number(roundRationalToInteger(
      (2n * (destination - topLeft.x) * BigInt(surface.width) - horizontalSpan) * q16,
      2n * horizontalSpan,
    ));
  }
  for (let index = 0; index < clip.height; index += 1) {
    const destination = BigInt(clip.bounds.top + index) * q16 + q16Half;
    sourceYQ16[index] = Number(roundRationalToInteger(
      (2n * (destination - topLeft.y) * BigInt(surface.height) - verticalSpan) * q16,
      2n * verticalSpan,
    ));
  }
  if (!sourceXQ16.every(Number.isSafeInteger) || !sourceYQ16.every(Number.isSafeInteger)) {
    throw new Error("scale+translation source samples exceed safe exact Q16 integer accounting.");
  }

  const allocate = options.allocateOutput ?? ((bytes: number) => new Uint8Array(bytes));
  const output = allocate(clip.rgbaBytes);
  if (!(output instanceof Uint8Array) || output.byteLength !== clip.rgbaBytes) {
    throw new Error(`output allocator must return exactly ${clip.rgbaBytes} Uint8Array bytes.`);
  }
  output.fill(0);

  const native = options.disableNativeScaleTranslation === true
    ? undefined
    : executeReferenceNativeScaleTranslationQ16({
      source: surface.data,
      output,
      sourceWidth: surface.width,
      sourceHeight: surface.height,
      sourceXQ16,
      sourceYQ16,
      outputWidth: clip.width,
      outputHeight: clip.height,
    });
  if (native) {
    return Object.freeze({
      surface: Object.freeze({
        data: output,
        width: clip.width,
        height: clip.height,
        originX: clip.bounds.left,
        originY: clip.bounds.top,
        alphaMode: "straight" as const,
      }),
      observedWork: Object.freeze({
        destinationPixelsTested: clip.pixels,
        insideQuadPixels: clip.pixels,
        ...native,
      }),
    });
  }

  let integerSamplesCopied = 0;
  let bilinearSamplesEvaluated = 0;
  let sourceTapsRead = 0;
  const units = referenceProjectiveWarpPhaseUnits;
  for (let destinationY = 0; destinationY < clip.height; destinationY += 1) {
    const yQ16 = sourceYQ16[destinationY]!;
    for (let destinationX = 0; destinationX < clip.width; destinationX += 1) {
      const xQ16 = sourceXQ16[destinationX]!;
      const outputOffset = (destinationY * clip.width + destinationX) * 4;
      if (xQ16 % units === 0 && yQ16 % units === 0) {
        const sourceX = xQ16 / units, sourceY = yQ16 / units;
        if (sourceX >= 0 && sourceY >= 0 && sourceX < surface.width && sourceY < surface.height) {
          const sourceOffset = (sourceY * surface.width + sourceX) * 4;
          output.set(surface.data.subarray(sourceOffset, sourceOffset + 4), outputOffset);
          integerSamplesCopied += 1;
          sourceTapsRead += 1;
        }
        continue;
      }

      bilinearSamplesEvaluated += 1;
      const x0 = Math.floor(xQ16 / units), y0 = Math.floor(yQ16 / units);
      const fractionX = xQ16 - x0 * units, fractionY = yQ16 - y0 * units;
      const inverseX = units - fractionX, inverseY = units - fractionY;
      const samples = [
        [x0, y0, inverseX * inverseY],
        [x0 + 1, y0, fractionX * inverseY],
        [x0, y0 + 1, inverseX * fractionY],
        [x0 + 1, y0 + 1, fractionX * fractionY],
      ] as const;
      let alphaNumerator = 0, redNumerator = 0, greenNumerator = 0, blueNumerator = 0;
      for (const [sampleX, sampleY, weight] of samples) {
        if (weight === 0 || sampleX < 0 || sampleY < 0 || sampleX >= surface.width || sampleY >= surface.height) continue;
        sourceTapsRead += 1;
        const alpha = sourceByte(surface, sampleX, sampleY, 3);
        if (alpha === 0) continue;
        alphaNumerator += alpha * weight;
        redNumerator += sourceByte(surface, sampleX, sampleY, 0) * alpha * weight;
        greenNumerator += sourceByte(surface, sampleX, sampleY, 1) * alpha * weight;
        blueNumerator += sourceByte(surface, sampleX, sampleY, 2) * alpha * weight;
      }
      const denominator = units ** 2;
      const alpha = roundedRatio(alphaNumerator, denominator);
      if (alpha === 0 || alphaNumerator === 0) continue;
      output[outputOffset] = roundedRatio(redNumerator, alphaNumerator);
      output[outputOffset + 1] = roundedRatio(greenNumerator, alphaNumerator);
      output[outputOffset + 2] = roundedRatio(blueNumerator, alphaNumerator);
      output[outputOffset + 3] = alpha;
    }
  }
  return Object.freeze({
    surface: Object.freeze({
      data: output,
      width: clip.width,
      height: clip.height,
      originX: clip.bounds.left,
      originY: clip.bounds.top,
      alphaMode: "straight" as const,
    }),
    observedWork: Object.freeze({
      destinationPixelsTested: clip.pixels,
      insideQuadPixels: clip.pixels,
      integerSamplesCopied,
      bilinearSamplesEvaluated,
      sourceTapsRead,
    }),
  });
}

export function executeReferenceLocalSpaceScaleTranslation(
  node: IRNode,
  surface: ReferenceStraightRgbaWarpSurface,
  plan: ReferenceLocalSpaceScaleTranslationPlan,
  options: ReferenceProjectiveWarpExecutionOptions = {},
): Readonly<{
  surface: ReferenceProjectiveWarpResult["surface"];
  evidence: ReferenceLocalSpaceScaleTranslationExecutionEvidence;
}> {
  const derived = planReferenceLocalSpaceScaleTranslation(
    node,
    plan.source,
    plan.destination,
    Object.freeze({
      owner: "scene-root",
      contextIdentity: plan.planIdentity,
      destinationX: plan.authored.destinationX,
      destinationY: plan.authored.destinationY,
      registrationRasterX: plan.authored.registrationRasterX,
      registrationRasterY: plan.authored.registrationRasterY,
      scale: plan.authored.scale,
      skewX: 0,
      skewY: 0,
      rotation: 0,
      opacity: plan.authored.opacity,
    }),
  );
  if (!derived || hash(derived) !== hash(plan)) {
    throw new ReferenceLocalSpaceScaleTranslationError(
      "CUT_LOCAL_SPACE_SCALE_TRANSLATION_RASTER",
      node,
      "runtime plan is stale, forged, or no longer requires fused sampling.",
    );
  }
  let rendered: ReferenceProjectiveWarpResult;
  let canvas;
  try {
    if (!(surface.data instanceof Uint8Array)
      || (surface.alphaMode !== undefined && surface.alphaMode !== "straight")
      || surface.width !== plan.source.width
      || surface.height !== plan.source.height
      || surface.data.byteLength !== plan.source.width * plan.source.height * 4) {
      throw new Error(
        `input must match the admitted ${plan.source.width}x${plan.source.height} / ${plan.source.width * plan.source.height * 4}-byte straight RGBA8 source.`,
      );
    }
    if (plan.destinationClip.status === "visible") {
      if (!plan.projective) throw new Error("visible destination clip has no projective plan.");
      rendered = rasterDestinationClippedScaleTranslation(surface, plan, options);
      canvas = placeReferenceProjectiveWarpOnCanvas(rendered, plan.destination.width, plan.destination.height, 1);
    } else {
      rendered = Object.freeze({
        surface: Object.freeze({
          data: new Uint8Array(0),
          width: 0,
          height: 0,
          originX: plan.destinationClip.bounds.left,
          originY: plan.destinationClip.bounds.top,
          alphaMode: "straight" as const,
        }),
        observedWork: Object.freeze({
          destinationPixelsTested: 0,
          insideQuadPixels: 0,
          integerSamplesCopied: 0,
          bilinearSamplesEvaluated: 0,
          sourceTapsRead: 0,
        }),
      });
      const pixels = plan.destination.width * plan.destination.height;
      canvas = Object.freeze({
        surface: Object.freeze({
          data: new Uint8Array(pixels * 4),
          width: plan.destination.width,
          height: plan.destination.height,
          alphaMode: "straight" as const,
        }),
        copy: Object.freeze({
          sourceOriginX: plan.destinationClip.bounds.left,
          sourceOriginY: plan.destinationClip.bounds.top,
          clippedLeft: plan.destinationClip.bounds.left,
          clippedTop: plan.destinationClip.bounds.top,
          clippedRight: plan.destinationClip.bounds.right,
          clippedBottom: plan.destinationClip.bounds.bottom,
          coveredPixels: 0,
          copiedPixels: 0,
          copiedRgbaBytes: 0,
          opacityScaledPixels: 0,
        }),
      });
    }
  } catch (error) {
    throw new ReferenceLocalSpaceScaleTranslationError(
      "CUT_LOCAL_SPACE_SCALE_TRANSLATION_RASTER",
      node,
      error instanceof Error ? error.message : String(error),
    );
  }
  return Object.freeze({
    surface: Object.freeze({
      data: canvas.surface.data,
      width: canvas.surface.width,
      height: canvas.surface.height,
      originX: 0,
      originY: 0,
      alphaMode: "straight" as const,
    }),
    evidence: Object.freeze({
      algorithmVersion: plan.algorithmVersion,
      sampler: plan.sampler,
      projectiveAlgorithmVersion: plan.projectiveAlgorithmVersion,
      planIdentity: plan.planIdentity,
      projectivePlanIdentity: plan.projective?.planIdentity ?? hash({
        algorithmVersion: plan.algorithmVersion,
        status: "off-canvas",
        destinationClip: plan.destinationClip,
      }),
      transformWorkIdentity: plan.transformWorkIdentity,
      activation: plan.activation,
      destinationClip: plan.destinationClip,
      effectiveScale: plan.raster.effectiveScale,
      legacyTranslationQ16: plan.raster.legacyTranslationQ16,
      observedWork: Object.freeze({
        ...rendered.observedWork,
        canvasPixelsAllocated: plan.destination.width * plan.destination.height,
        canvasRgbaBytesAllocated: plan.destination.width * plan.destination.height * 4,
        canvasPixelsCopied: canvas.copy.copiedPixels,
        canvasRgbaBytesCopied: canvas.copy.copiedRgbaBytes,
      }),
    }),
  });
}
