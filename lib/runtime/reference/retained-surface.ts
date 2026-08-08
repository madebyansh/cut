import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  executeReferenceNativeRetainedAlphaScale,
  executeReferenceNativeRetainedTranslationQ16,
  referenceNativeSourceOverBackend,
} from "./native-source-over";

export const referenceRetainedSurfacePhaseUnits = 65_536;
export const referenceRetainedSurfaceAlphaSupportAlgorithmVersion =
  "cut-reference-retained-surface-alpha-support-v4" as const;
export const referenceRetainedAlphaScaleKernelAlgorithmVersion =
  "cut-reference-retained-alpha-scale-kernel-v2" as const;

export const referenceRetainedSurfaceLimits = Object.freeze({
  maximumCanvasPixels: 16_777_216,
  maximumTransformedPixels: 67_108_864,
  maximumAbsolutePlacement: 131_072,
});

export type ReferenceStraightRgbaSurface = Readonly<{
  data: Uint8Array;
  width: number;
  height: number;
}>;

export type ReferenceRetainedSurfaceAlphaSupport = Readonly<{
  format: "cut-reference-retained-surface-alpha-support";
  version: 1;
  algorithmVersion: typeof referenceRetainedSurfaceAlphaSupportAlgorithmVersion;
  derivation:
    | "integer-copy-scan"
    | "integer-copy-propagated"
    | "fractional-sample"
    | "alpha-scale";
  empty: boolean;
  left: number;
  top: number;
  right: number;
  bottom: number;
  nonzeroAlphaPixels: number;
  alphaBytesObserved: number;
  destinationPixelsVisited: number;
}>;

export type ReferenceRetainedSurfaceExactAlphaBounds = Readonly<{
  empty: boolean;
  left: number;
  top: number;
  right: number;
  bottom: number;
}>;

export type ReferenceRetainedSurfaceExactAlphaSupport =
  ReferenceRetainedSurfaceExactAlphaBounds & Readonly<{
    nonzeroAlphaPixels: number;
  }>;

export type ReferenceRetainedAlphaScaleDiagnosticMode =
  | "automatic"
  | "forced-scalar";

export type ReferenceRetainedAlphaScaleDiagnostic = Readonly<{
  format: "cut-reference-retained-alpha-scale-kernel-controller";
  version: 1;
  mode: ReferenceRetainedAlphaScaleDiagnosticMode;
  snapshot: () => ReferenceRetainedAlphaScaleDiagnosticSnapshot;
}>;

export type ReferenceRetainedAlphaScaleDiagnosticSnapshot =
  Readonly<{
    format: "cut-reference-retained-alpha-scale-kernel";
    version: 1;
    mode: ReferenceRetainedAlphaScaleDiagnosticMode;
    algorithmVersion: typeof referenceRetainedAlphaScaleKernelAlgorithmVersion;
    observationIdentity: string;
    requests: number;
    identitySkips: number;
    zeroOpacityExecutions: number;
    automaticExecutions: number;
    scalarExecutions: number;
    alignedWordExecutions: number;
    nativeExecutions: number;
    unalignedFallbackExecutions: number;
    endianFallbackExecutions: number;
    alphaBytesObserved: number;
  }>;

export type ReferenceRetainedSurfaceDiagnosticCode =
  | "CUT_VISUAL_SUBPIXEL_POSITION"
  | "CUT_VISUAL_SUBPIXEL_SURFACE"
  | "CUT_VISUAL_SUBPIXEL_WORK_LIMIT";

export class ReferenceRetainedSurfaceError extends Error {
  constructor(readonly code: ReferenceRetainedSurfaceDiagnosticCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "ReferenceRetainedSurfaceError";
  }
}

function fail(code: ReferenceRetainedSurfaceDiagnosticCode, message: string): never {
  throw new ReferenceRetainedSurfaceError(code, message);
}

function validateSurface(surface: ReferenceStraightRgbaSurface, label: string, maximumPixels: number) {
  if (!surface || typeof surface !== "object" || !(surface.data instanceof Uint8Array)) {
    fail("CUT_VISUAL_SUBPIXEL_SURFACE", `${label} must be a straight RGBA Uint8Array surface.`);
  }
  if (!Number.isSafeInteger(surface.width) || !Number.isSafeInteger(surface.height) || surface.width < 1 || surface.height < 1) {
    fail("CUT_VISUAL_SUBPIXEL_SURFACE", `${label} dimensions must be positive safe integers.`);
  }
  const pixels = surface.width * surface.height;
  if (!Number.isSafeInteger(pixels) || pixels > maximumPixels) {
    fail("CUT_VISUAL_SUBPIXEL_WORK_LIMIT", `${label} exceeds the ${maximumPixels}-pixel retained-surface work limit.`);
  }
  if (surface.data.byteLength !== pixels * 4) {
    fail("CUT_VISUAL_SUBPIXEL_SURFACE", `${label} byte length must equal width × height × 4.`);
  }
}

type QuantizedPlacement = { integer: number; phase: number };

/** Quantize only the subpixel phase. Integer placement remains exact and a
 * rounded phase of one advances the integer coordinate instead of wrapping. */
function quantizedPlacement(value: number, label: string): QuantizedPlacement {
  if (!Number.isFinite(value) || Math.abs(value) > referenceRetainedSurfaceLimits.maximumAbsolutePlacement) {
    fail(
      "CUT_VISUAL_SUBPIXEL_POSITION",
      `${label} must be finite and no farther than ${referenceRetainedSurfaceLimits.maximumAbsolutePlacement}px from the canvas origin.`,
    );
  }
  let integer = Math.floor(value);
  let phase = Math.round((value - integer) * referenceRetainedSurfacePhaseUnits);
  if (phase === referenceRetainedSurfacePhaseUnits) {
    integer += 1;
    phase = 0;
  }
  return { integer, phase };
}

function roundedRatio(numerator: number, denominator: number) {
  // All operands are non-negative safe integers under the declared Q16 and
  // surface-byte bounds. This is exact round-half-up without a floating tie.
  return Math.floor((numerator * 2 + denominator) / (denominator * 2));
}

type MutableAlphaSupport = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  nonzeroAlphaPixels: number;
};

const retainedSurfaceAlphaSupportAuthority = new WeakMap<Uint8Array, Readonly<{
  width: number;
  height: number;
  support: ReferenceRetainedSurfaceAlphaSupport;
}>>();

type MutableReferenceRetainedAlphaScaleDiagnostic = {
  requests: number;
  identitySkips: number;
  zeroOpacityExecutions: number;
  automaticExecutions: number;
  scalarExecutions: number;
  alignedWordExecutions: number;
  nativeExecutions: number;
  unalignedFallbackExecutions: number;
  endianFallbackExecutions: number;
  alphaBytesObserved: number;
};

const retainedAlphaScaleDiagnosticAuthority =
  new WeakMap<ReferenceRetainedAlphaScaleDiagnostic, MutableReferenceRetainedAlphaScaleDiagnostic>();

const referenceRetainedAlphaScaleLittleEndian = (() => {
  const probe = new Uint32Array([0x0102_0304]);
  return new Uint8Array(probe.buffer)[0] === 0x04;
})();

const retainedAlphaScaleObservationIdentities = Object.freeze({
  automatic: createHash("sha256").update(
    `${referenceRetainedAlphaScaleKernelAlgorithmVersion};mode=automatic`,
  ).digest("hex"),
  "forced-scalar": createHash("sha256").update(
    `${referenceRetainedAlphaScaleKernelAlgorithmVersion};mode=forced-scalar`,
  ).digest("hex"),
});

export function createReferenceRetainedAlphaScaleDiagnostic(
  mode: ReferenceRetainedAlphaScaleDiagnosticMode,
): ReferenceRetainedAlphaScaleDiagnostic {
  if (mode !== "automatic" && mode !== "forced-scalar") {
    fail(
      "CUT_VISUAL_SUBPIXEL_SURFACE",
      "retained alpha-scale diagnostic mode must be automatic or forced-scalar.",
    );
  }
  const diagnostic: ReferenceRetainedAlphaScaleDiagnostic = Object.freeze({
    format: "cut-reference-retained-alpha-scale-kernel-controller",
    version: 1,
    mode,
    snapshot: () => referenceRetainedAlphaScaleDiagnosticSnapshot(diagnostic),
  });
  retainedAlphaScaleDiagnosticAuthority.set(diagnostic, {
    requests: 0,
    identitySkips: 0,
    zeroOpacityExecutions: 0,
    automaticExecutions: 0,
    scalarExecutions: 0,
    alignedWordExecutions: 0,
    nativeExecutions: 0,
    unalignedFallbackExecutions: 0,
    endianFallbackExecutions: 0,
    alphaBytesObserved: 0,
  });
  return diagnostic;
}

export function referenceRetainedAlphaScaleDiagnosticSnapshot(
  diagnostic: ReferenceRetainedAlphaScaleDiagnostic,
): ReferenceRetainedAlphaScaleDiagnosticSnapshot {
  const counters = retainedAlphaScaleDiagnosticAuthority.get(diagnostic);
  if (!counters) {
    fail(
      "CUT_VISUAL_SUBPIXEL_SURFACE",
      "retained alpha-scale diagnostic authority was not issued by this runtime.",
    );
  }
  return Object.freeze({
    format: "cut-reference-retained-alpha-scale-kernel",
    version: 1,
    mode: diagnostic.mode,
    algorithmVersion: referenceRetainedAlphaScaleKernelAlgorithmVersion,
    observationIdentity: retainedAlphaScaleObservationIdentities[diagnostic.mode],
    ...counters,
  });
}

export function validateReferenceRetainedAlphaScaleKernelEvidence(
  candidate: unknown,
): ReferenceRetainedAlphaScaleDiagnosticSnapshot {
  if (!candidate || typeof candidate !== "object") {
    fail("CUT_VISUAL_SUBPIXEL_SURFACE", "retained alpha-scale evidence must be an object.");
  }
  const evidence = candidate as Partial<ReferenceRetainedAlphaScaleDiagnosticSnapshot>;
  if (evidence.format !== "cut-reference-retained-alpha-scale-kernel"
    || evidence.version !== 1
    || (evidence.mode !== "automatic" && evidence.mode !== "forced-scalar")
    || evidence.algorithmVersion !== referenceRetainedAlphaScaleKernelAlgorithmVersion
    || evidence.observationIdentity !== retainedAlphaScaleObservationIdentities[evidence.mode]) {
    fail(
      "CUT_VISUAL_SUBPIXEL_SURFACE",
      "retained alpha-scale evidence identity does not match the current runtime.",
    );
  }
  const integerFields = [
    "requests",
    "identitySkips",
    "zeroOpacityExecutions",
    "automaticExecutions",
    "scalarExecutions",
    "alignedWordExecutions",
    "nativeExecutions",
    "unalignedFallbackExecutions",
    "endianFallbackExecutions",
    "alphaBytesObserved",
  ] as const;
  for (const field of integerFields) {
    if (!Number.isSafeInteger(evidence[field]) || (evidence[field] ?? -1) < 0) {
      fail(
        "CUT_VISUAL_SUBPIXEL_SURFACE",
        `retained alpha-scale evidence ${field} must be a nonnegative safe integer.`,
      );
    }
  }
  const requests = evidence.requests as number;
  const identitySkips = evidence.identitySkips as number;
  const zeroOpacityExecutions = evidence.zeroOpacityExecutions as number;
  const automaticExecutions = evidence.automaticExecutions as number;
  const scalarExecutions = evidence.scalarExecutions as number;
  const alignedWordExecutions = evidence.alignedWordExecutions as number;
  const nativeExecutions = evidence.nativeExecutions as number;
  const unalignedFallbackExecutions = evidence.unalignedFallbackExecutions as number;
  const endianFallbackExecutions = evidence.endianFallbackExecutions as number;
  const kernelExecutions = scalarExecutions + alignedWordExecutions + nativeExecutions;
  if (requests !== identitySkips + zeroOpacityExecutions + kernelExecutions
    || unalignedFallbackExecutions > scalarExecutions
    || endianFallbackExecutions > scalarExecutions
    || (evidence.mode === "automatic" && automaticExecutions !== kernelExecutions)
    || (evidence.mode === "forced-scalar"
      && (automaticExecutions !== 0
        || alignedWordExecutions !== 0
        || nativeExecutions !== 0
        || unalignedFallbackExecutions !== 0
        || endianFallbackExecutions !== 0))) {
    fail(
      "CUT_VISUAL_SUBPIXEL_SURFACE",
      "retained alpha-scale evidence counters do not describe one terminal execution per request.",
    );
  }
  return Object.freeze({ ...(evidence as ReferenceRetainedAlphaScaleDiagnosticSnapshot) });
}

function emptyMutableAlphaSupport(width: number, height: number): MutableAlphaSupport {
  return { left: width, top: height, right: 0, bottom: 0, nonzeroAlphaPixels: 0 };
}

function observeAlpha(
  support: MutableAlphaSupport,
  x: number,
  y: number,
  alpha: number,
) {
  if (alpha === 0) return;
  support.nonzeroAlphaPixels += 1;
  if (x < support.left) support.left = x;
  if (y < support.top) support.top = y;
  if (x + 1 > support.right) support.right = x + 1;
  if (y + 1 > support.bottom) support.bottom = y + 1;
}

function publishAlphaSupport(
  surface: ReferenceStraightRgbaSurface,
  derivation: ReferenceRetainedSurfaceAlphaSupport["derivation"],
  mutable: MutableAlphaSupport,
  alphaBytesObserved: number,
  destinationPixelsVisited: number,
) {
  const empty = mutable.nonzeroAlphaPixels === 0;
  const support: ReferenceRetainedSurfaceAlphaSupport = Object.freeze({
    format: "cut-reference-retained-surface-alpha-support",
    version: 1,
    algorithmVersion: referenceRetainedSurfaceAlphaSupportAlgorithmVersion,
    derivation,
    empty,
    left: empty ? 0 : mutable.left,
    top: empty ? 0 : mutable.top,
    right: empty ? 0 : mutable.right,
    bottom: empty ? 0 : mutable.bottom,
    nonzeroAlphaPixels: mutable.nonzeroAlphaPixels,
    alphaBytesObserved,
    destinationPixelsVisited,
  });
  retainedSurfaceAlphaSupportAuthority.set(surface.data, Object.freeze({
    width: surface.width,
    height: surface.height,
    support,
  }));
  return surface;
}

/**
 * Return exact support only for bytes materialized by CUT's retained
 * translator/alpha scaler. Arbitrary caller-owned bytes remain ineligible.
 * Runtime callers keep these surfaces immutable after publication.
 */
export function referenceRetainedSurfaceAlphaSupport(
  surface: ReferenceStraightRgbaSurface,
): ReferenceRetainedSurfaceAlphaSupport | undefined {
  const bound = retainedSurfaceAlphaSupportAuthority.get(surface.data);
  return bound?.width === surface.width && bound.height === surface.height
    ? bound.support
    : undefined;
}

/** Preserve renderer-owned alpha-support authority across an exact zero-copy
 * Uint8Array/Buffer view boundary. The target must cover the same bytes; an
 * arbitrary caller-owned copy or subview is never admitted. */
export function shareReferenceRetainedSurfaceAlphaSupportAuthority(
  source: Uint8Array,
  target: Uint8Array,
) {
  const bound = retainedSurfaceAlphaSupportAuthority.get(source);
  if (!bound) return;
  if (source.buffer !== target.buffer
    || source.byteOffset !== target.byteOffset
    || source.byteLength !== target.byteLength) {
    fail("CUT_VISUAL_SUBPIXEL_SURFACE", "retained alpha-support authority requires one exact shared byte view.");
  }
  retainedSurfaceAlphaSupportAuthority.set(target, bound);
}

/**
 * Bind exact alpha support that was derived while a trusted CUT raster kernel
 * wrote the destination. This avoids a second whole-surface alpha scan at the
 * next retained-compositing boundary. The support is still validated against
 * the destination dimensions; authored programs cannot call this runtime-only
 * boundary.
 */
export function publishReferenceRetainedSurfaceExactAlphaSupport(
  surface: ReferenceStraightRgbaSurface,
  support: ReferenceRetainedSurfaceExactAlphaSupport,
  alphaBytesObserved: number,
  destinationPixelsVisited: number,
) {
  validateSurface(surface, "retained alpha-support destination", referenceRetainedSurfaceLimits.maximumTransformedPixels);
  validateExactAlphaSupport(surface, support);
  const destinationPixels = surface.width * surface.height;
  if (!Number.isSafeInteger(alphaBytesObserved) || alphaBytesObserved < 0
    || !Number.isSafeInteger(destinationPixelsVisited) || destinationPixelsVisited < 0
    || destinationPixelsVisited > destinationPixels
    || alphaBytesObserved > destinationPixelsVisited * 4
    || support.nonzeroAlphaPixels > destinationPixelsVisited) {
    fail("CUT_VISUAL_SUBPIXEL_SURFACE", "retained alpha-support work counters must be exact bounded safe integers for the destination.");
  }
  const mutable: MutableAlphaSupport = {
    left: support.left,
    top: support.top,
    right: support.right,
    bottom: support.bottom,
    nonzeroAlphaPixels: support.nonzeroAlphaPixels,
  };
  return publishAlphaSupport(
    surface,
    "fractional-sample",
    mutable,
    alphaBytesObserved,
    destinationPixelsVisited,
  );
}

function scanCopiedAlphaSupport(
  surface: ReferenceStraightRgbaSurface,
  sourceLeft: number,
  sourceTop: number,
  copyWidth: number,
  copyHeight: number,
  targetLeft: number,
  targetTop: number,
  trustedSupport?: ReferenceRetainedSurfaceExactAlphaSupport,
) {
  const known = referenceRetainedSurfaceAlphaSupport(surface) ?? trustedSupport;
  const mutable = emptyMutableAlphaSupport(targetLeft + copyWidth, targetTop + copyHeight);
  if (known?.empty) {
    return Object.freeze({ mutable, alphaBytesObserved: 0, propagated: true });
  }
  const sourceRight = sourceLeft + copyWidth;
  const sourceBottom = sourceTop + copyHeight;
  if (known
    && known.left >= sourceLeft
    && known.top >= sourceTop
    && known.right <= sourceRight
    && known.bottom <= sourceBottom) {
    if (!known.empty) {
      const offsetX = targetLeft - sourceLeft, offsetY = targetTop - sourceTop;
      mutable.left = known.left + offsetX;
      mutable.top = known.top + offsetY;
      mutable.right = known.right + offsetX;
      mutable.bottom = known.bottom + offsetY;
      mutable.nonzeroAlphaPixels = known.nonzeroAlphaPixels;
    }
    return Object.freeze({ mutable, alphaBytesObserved: 0, propagated: true });
  }

  const scanLeft = known ? Math.max(sourceLeft, known.left) : sourceLeft;
  const scanTop = known ? Math.max(sourceTop, known.top) : sourceTop;
  const scanRight = known ? Math.min(sourceRight, known.right) : sourceRight;
  const scanBottom = known ? Math.min(sourceBottom, known.bottom) : sourceBottom;
  if (scanRight <= scanLeft || scanBottom <= scanTop) {
    return Object.freeze({ mutable, alphaBytesObserved: 0, propagated: false });
  }
  let alphaBytesObserved = 0;
  for (let sourceY = scanTop; sourceY < scanBottom; sourceY += 1) {
    const targetY = targetTop + sourceY - sourceTop;
    let rowLeft = scanRight;
    let rowRight = scanLeft;
    let rowNonzeroAlphaPixels = 0;
    const rowEnd = (sourceY * surface.width + scanRight) * 4;
    let sourceX = scanLeft;
    for (
      let offset = (sourceY * surface.width + scanLeft) * 4 + 3;
      offset < rowEnd;
      offset += 4, sourceX += 1
    ) {
      if (surface.data[offset] === 0) continue;
      rowNonzeroAlphaPixels += 1;
      if (rowLeft === scanRight) rowLeft = sourceX;
      rowRight = sourceX + 1;
    }
    alphaBytesObserved += scanRight - scanLeft;
    if (rowNonzeroAlphaPixels === 0) continue;
    mutable.nonzeroAlphaPixels += rowNonzeroAlphaPixels;
    const translatedLeft = targetLeft + rowLeft - sourceLeft;
    const translatedRight = targetLeft + rowRight - sourceLeft;
    if (translatedLeft < mutable.left) mutable.left = translatedLeft;
    if (targetY < mutable.top) mutable.top = targetY;
    if (translatedRight > mutable.right) mutable.right = translatedRight;
    if (targetY + 1 > mutable.bottom) mutable.bottom = targetY + 1;
  }
  return Object.freeze({ mutable, alphaBytesObserved, propagated: false });
}

/**
 * Translate one retained straight-RGBA surface onto a canvas.
 *
 * Pixel centers use integer coordinates. The fractional phase is Q16 and the
 * zero-extended separable bilinear kernel is evaluated in associated
 * encoded-sRGB: RGB is multiplied by alpha before interpolation, the result is
 * unassociated with round-half-up, and fractional samples clear RGB whenever
 * quantized alpha is zero. Integer phases bypass filtering and preserve every
 * straight-RGBA byte, including independent hidden RGB. A half-pixel shift gives
 * equal coverage to adjacent pixel centers without delegating placement or
 * interpolation to Sharp/libvips.
 */
function validateExactAlphaBounds(
  surface: ReferenceStraightRgbaSurface,
  bounds: ReferenceRetainedSurfaceExactAlphaBounds,
) {
  const valid = bounds
    && typeof bounds === "object"
    && [bounds.left, bounds.top, bounds.right, bounds.bottom].every(Number.isSafeInteger)
    && bounds.left >= 0
    && bounds.top >= 0
    && bounds.right >= bounds.left
    && bounds.bottom >= bounds.top
    && bounds.right <= surface.width
    && bounds.bottom <= surface.height
    && bounds.empty === (bounds.left === bounds.right || bounds.top === bounds.bottom);
  if (!valid) {
    fail("CUT_VISUAL_SUBPIXEL_SURFACE", "retained alpha bounds must be a valid exact half-open source rectangle.");
  }
}

function validateExactAlphaSupport(
  surface: ReferenceStraightRgbaSurface,
  support: ReferenceRetainedSurfaceExactAlphaSupport,
) {
  validateExactAlphaBounds(surface, support);
  const area = (support.right - support.left) * (support.bottom - support.top);
  if (!Number.isSafeInteger(support.nonzeroAlphaPixels)
    || support.nonzeroAlphaPixels < 0
    || support.nonzeroAlphaPixels > area
    || support.empty !== (support.nonzeroAlphaPixels === 0)) {
    fail(
      "CUT_VISUAL_SUBPIXEL_SURFACE",
      "retained alpha support must contain an exact nonzero-alpha count inside its half-open bounds.",
    );
  }
}

function translateReferenceRetainedSurfaceInternal(
  surface: ReferenceStraightRgbaSurface,
  canvasWidth: number,
  canvasHeight: number,
  left: number,
  top: number,
  exactAlphaBounds?: ReferenceRetainedSurfaceExactAlphaBounds,
  exactAlphaSupport?: ReferenceRetainedSurfaceExactAlphaSupport,
): ReferenceStraightRgbaSurface {
  validateSurface(surface, "retained input", referenceRetainedSurfaceLimits.maximumTransformedPixels);
  if (exactAlphaBounds) validateExactAlphaBounds(surface, exactAlphaBounds);
  if (exactAlphaSupport) {
    validateExactAlphaSupport(surface, exactAlphaSupport);
    if (exactAlphaBounds !== exactAlphaSupport) {
      fail(
        "CUT_VISUAL_SUBPIXEL_SURFACE",
        "retained alpha support must be the exact bounds authority used for sampling.",
      );
    }
  }
  const outputPixels = canvasWidth * canvasHeight;
  if (!Number.isSafeInteger(canvasWidth) || !Number.isSafeInteger(canvasHeight) || canvasWidth < 1 || canvasHeight < 1) {
    fail("CUT_VISUAL_SUBPIXEL_SURFACE", "destination canvas dimensions must be positive safe integers.");
  }
  if (!Number.isSafeInteger(outputPixels) || outputPixels > referenceRetainedSurfaceLimits.maximumCanvasPixels) {
    fail("CUT_VISUAL_SUBPIXEL_WORK_LIMIT", `destination canvas exceeds the ${referenceRetainedSurfaceLimits.maximumCanvasPixels}-pixel retained-surface work limit.`);
  }

  const horizontal = quantizedPlacement(left, "retained left"), vertical = quantizedPlacement(top, "retained top");
  const output = Buffer.alloc(outputPixels * 4);
  if (horizontal.phase === 0 && vertical.phase === 0) {
    const sourceLeft = Math.max(0, -horizontal.integer), sourceTop = Math.max(0, -vertical.integer);
    const targetLeft = Math.max(0, horizontal.integer), targetTop = Math.max(0, vertical.integer);
    const copyWidth = Math.min(surface.width - sourceLeft, canvasWidth - targetLeft);
    const copyHeight = Math.min(surface.height - sourceTop, canvasHeight - targetTop);
    if (copyWidth <= 0 || copyHeight <= 0) {
      return publishAlphaSupport(
        { data: output, width: canvasWidth, height: canvasHeight },
        "integer-copy-scan",
        emptyMutableAlphaSupport(canvasWidth, canvasHeight),
        0,
        0,
      );
    }
    const bytesPerRow = copyWidth * 4;
    for (let row = 0; row < copyHeight; row += 1) {
      const sourceOffset = ((sourceTop + row) * surface.width + sourceLeft) * 4;
      const targetOffset = ((targetTop + row) * canvasWidth + targetLeft) * 4;
      output.set(surface.data.subarray(sourceOffset, sourceOffset + bytesPerRow), targetOffset);
    }
    const observed = scanCopiedAlphaSupport(
      surface,
      sourceLeft,
      sourceTop,
      copyWidth,
      copyHeight,
      targetLeft,
      targetTop,
      exactAlphaSupport,
    );
    return publishAlphaSupport(
      { data: output, width: canvasWidth, height: canvasHeight },
      observed.propagated ? "integer-copy-propagated" : "integer-copy-scan",
      observed.mutable,
      observed.alphaBytesObserved,
      copyWidth * copyHeight,
    );
  }
  if (exactAlphaBounds?.empty) {
    return publishAlphaSupport(
      { data: output, width: canvasWidth, height: canvasHeight },
      "fractional-sample",
      emptyMutableAlphaSupport(canvasWidth, canvasHeight),
      0,
      0,
    );
  }
  const units = referenceRetainedSurfacePhaseUnits;
  const inverseX = units - horizontal.phase, inverseY = units - vertical.phase;
  const boundedLeft = exactAlphaBounds?.left ?? 0;
  const boundedTop = exactAlphaBounds?.top ?? 0;
  const boundedRight = exactAlphaBounds?.right ?? surface.width;
  const boundedBottom = exactAlphaBounds?.bottom ?? surface.height;
  const firstX = Math.max(0, horizontal.integer + boundedLeft);
  const firstY = Math.max(0, vertical.integer + boundedTop);
  const lastX = Math.min(canvasWidth - 1, horizontal.integer + boundedRight - 1 + (horizontal.phase === 0 ? 0 : 1));
  const lastY = Math.min(canvasHeight - 1, vertical.integer + boundedBottom - 1 + (vertical.phase === 0 ? 0 : 1));
  if (firstX > lastX || firstY > lastY) {
    return publishAlphaSupport(
      { data: output, width: canvasWidth, height: canvasHeight },
      "fractional-sample",
      emptyMutableAlphaSupport(canvasWidth, canvasHeight),
      0,
      0,
    );
  }

  const denominator = units * units;
  const native = executeReferenceNativeRetainedTranslationQ16({
    source: surface.data,
    output,
    sourceWidth: surface.width,
    sourceHeight: surface.height,
    canvasWidth,
    canvasHeight,
    integerX: horizontal.integer,
    integerY: vertical.integer,
    phaseX: horizontal.phase,
    phaseY: vertical.phase,
    bounds: { left: boundedLeft, top: boundedTop, right: boundedRight, bottom: boundedBottom },
  });
  if (native) {
    return publishAlphaSupport(
      { data: output, width: canvasWidth, height: canvasHeight },
      "fractional-sample",
      {
        left: native.left,
        top: native.top,
        right: native.right,
        bottom: native.bottom,
        nonzeroAlphaPixels: native.nonzeroAlphaPixels,
      },
      native.alphaBytesObserved,
      native.destinationPixelsVisited,
    );
  }
  const support = emptyMutableAlphaSupport(canvasWidth, canvasHeight);
  let alphaBytesObserved = 0;
  for (let destinationY = firstY; destinationY <= lastY; destinationY += 1) {
    const localY = destinationY - vertical.integer;
    const sourceYs = [localY - 1, localY] as const;
    const weightsY = [vertical.phase, inverseY] as const;
    for (let destinationX = firstX; destinationX <= lastX; destinationX += 1) {
      const localX = destinationX - horizontal.integer;
      const sourceXs = [localX - 1, localX] as const;
      const weightsX = [horizontal.phase, inverseX] as const;
      let alphaNumerator = 0, redNumerator = 0, greenNumerator = 0, blueNumerator = 0;
      for (let yIndex = 0; yIndex < 2; yIndex += 1) {
        const sourceY = sourceYs[yIndex], weightY = weightsY[yIndex];
        if (weightY === 0 || sourceY < boundedTop || sourceY >= boundedBottom) continue;
        for (let xIndex = 0; xIndex < 2; xIndex += 1) {
          const sourceX = sourceXs[xIndex], weightX = weightsX[xIndex];
          if (weightX === 0 || sourceX < boundedLeft || sourceX >= boundedRight) continue;
          const weight = weightX * weightY;
          const sourceOffset = (sourceY * surface.width + sourceX) * 4;
          alphaBytesObserved += 1;
          const alpha = surface.data[sourceOffset + 3];
          if (alpha === 0) continue;
          alphaNumerator += alpha * weight;
          redNumerator += surface.data[sourceOffset] * alpha * weight;
          greenNumerator += surface.data[sourceOffset + 1] * alpha * weight;
          blueNumerator += surface.data[sourceOffset + 2] * alpha * weight;
        }
      }
      const alpha = roundedRatio(alphaNumerator, denominator);
      if (alpha === 0 || alphaNumerator === 0) continue;
      const destinationOffset = (destinationY * canvasWidth + destinationX) * 4;
      output[destinationOffset] = roundedRatio(redNumerator, alphaNumerator);
      output[destinationOffset + 1] = roundedRatio(greenNumerator, alphaNumerator);
      output[destinationOffset + 2] = roundedRatio(blueNumerator, alphaNumerator);
      output[destinationOffset + 3] = alpha;
      observeAlpha(support, destinationX, destinationY, alpha);
    }
  }
  return publishAlphaSupport(
    { data: output, width: canvasWidth, height: canvasHeight },
    "fractional-sample",
    support,
    alphaBytesObserved,
    (lastX - firstX + 1) * (lastY - firstY + 1),
  );
}

export function translateReferenceRetainedSurface(
  surface: ReferenceStraightRgbaSurface,
  canvasWidth: number,
  canvasHeight: number,
  left: number,
  top: number,
): ReferenceStraightRgbaSurface {
  return translateReferenceRetainedSurfaceInternal(surface, canvasWidth, canvasHeight, left, top);
}

/**
 * Trusted retained-owner variant. The caller must supply bounds obtained from
 * CUT's immutable-byte alpha authority. Integer placement ignores the hint to
 * preserve independent hidden RGB; fractional placement visits only pixels
 * whose bilinear support can contain nonzero alpha.
 */
export function translateReferenceRetainedSurfaceWithinAlphaBounds(
  surface: ReferenceStraightRgbaSurface,
  canvasWidth: number,
  canvasHeight: number,
  left: number,
  top: number,
  exactAlphaBounds: ReferenceRetainedSurfaceExactAlphaBounds,
): ReferenceStraightRgbaSurface {
  return translateReferenceRetainedSurfaceInternal(
    surface,
    canvasWidth,
    canvasHeight,
    left,
    top,
    exactAlphaBounds,
  );
}

/**
 * Trusted retained-owner variant carrying the exact nonzero-alpha count from
 * CUT's immutable-byte authority. Integer placement still copies every
 * admitted straight-RGBA byte, including hidden RGB, but may propagate exact
 * support without rescanning when clipping contains the complete support.
 */
export function translateReferenceRetainedSurfaceWithinAlphaSupport(
  surface: ReferenceStraightRgbaSurface,
  canvasWidth: number,
  canvasHeight: number,
  left: number,
  top: number,
  exactAlphaSupport: ReferenceRetainedSurfaceExactAlphaSupport,
): ReferenceStraightRgbaSurface {
  return translateReferenceRetainedSurfaceInternal(
    surface,
    canvasWidth,
    canvasHeight,
    left,
    top,
    exactAlphaSupport,
    exactAlphaSupport,
  );
}

/**
 * Apply LocalSpace owner opacity while deriving exact support in the same
 * authoritative pass. When upstream support is known, sparse output avoids
 * copying or inspecting pixels outside its half-open alpha rectangle.
 */
export function scaleReferenceRetainedSurfaceAlpha(
  surface: ReferenceStraightRgbaSurface,
  opacity: number,
  diagnostic?: ReferenceRetainedAlphaScaleDiagnostic,
): ReferenceStraightRgbaSurface {
  validateSurface(surface, "retained alpha input", referenceRetainedSurfaceLimits.maximumTransformedPixels);
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) {
    fail("CUT_VISUAL_SUBPIXEL_SURFACE", "retained alpha opacity must be finite from 0 through 1.");
  }
  const diagnosticCounters = diagnostic
    ? retainedAlphaScaleDiagnosticAuthority.get(diagnostic)
    : undefined;
  if (diagnostic && !diagnosticCounters) {
    fail(
      "CUT_VISUAL_SUBPIXEL_SURFACE",
      "retained alpha-scale diagnostic authority was not issued by this runtime.",
    );
  }
  if (diagnosticCounters) diagnosticCounters.requests += 1;
  if (opacity === 1) {
    if (diagnosticCounters) diagnosticCounters.identitySkips += 1;
    return surface;
  }
  const pixels = surface.width * surface.height;
  if (opacity === 0) {
    if (diagnosticCounters) diagnosticCounters.zeroOpacityExecutions += 1;
    return publishAlphaSupport(
      { data: Buffer.alloc(pixels * 4), width: surface.width, height: surface.height },
      "alpha-scale",
      emptyMutableAlphaSupport(surface.width, surface.height),
      0,
      0,
    );
  }

  const known = referenceRetainedSurfaceAlphaSupport(surface);
  const support = emptyMutableAlphaSupport(surface.width, surface.height);
  const left = known ? known.left : 0;
  const top = known ? known.top : 0;
  const right = known ? known.right : surface.width;
  const bottom = known ? known.bottom : surface.height;
  const alphaBytesObserved = (right - left) * (bottom - top);
  if (diagnosticCounters) {
    diagnosticCounters.alphaBytesObserved += alphaBytesObserved;
    if (diagnostic?.mode === "automatic") diagnosticCounters.automaticExecutions += 1;
  }

  if (diagnostic?.mode !== "forced-scalar"
    && referenceNativeSourceOverBackend().mode === "native") {
    const output = Buffer.allocUnsafe(surface.data.byteLength);
    const native = executeReferenceNativeRetainedAlphaScale({
      source: surface.data,
      output,
      width: surface.width,
      height: surface.height,
      bounds: { left, top, right, bottom },
      opacity,
    });
    if (!native) {
      fail(
        "CUT_VISUAL_SUBPIXEL_SURFACE",
        "authenticated native retained-alpha backend disappeared during one execution.",
      );
    }
    if (diagnosticCounters) diagnosticCounters.nativeExecutions += 1;
    return publishAlphaSupport(
      { data: output, width: surface.width, height: surface.height },
      "alpha-scale",
      {
        left: native.left,
        top: native.top,
        right: native.right,
        bottom: native.bottom,
        nonzeroAlphaPixels: native.nonzeroAlphaPixels,
      },
      alphaBytesObserved,
      (right - left) * (bottom - top),
    );
  }

  const output = known ? Buffer.alloc(surface.data.byteLength) : Buffer.from(surface.data);
  if (known && !known.empty) {
    // Known retained support lets the zero-filled output remain authoritative
    // outside the exact alpha rectangle. Copy each admitted source row in the
    // native byte path, then let the scalar alpha pass below clear any hidden
    // RGB whose rounded coverage becomes zero. This preserves the frozen
    // owner-opacity law while avoiding three JavaScript byte assignments for
    // every surviving pixel in a retained tile.
    const rowBytes = (right - left) * 4;
    for (let y = top; y < bottom; y += 1) {
      const rowStart = (y * surface.width + left) * 4;
      output.set(surface.data.subarray(rowStart, rowStart + rowBytes), rowStart);
    }
  }

  // RGBA bytes form 0xAABBGGRR words only on little-endian hosts. Both views
  // must also begin on a Uint32 boundary; otherwise the exact scalar law below
  // remains the fail-closed portable path.
  const aligned = surface.data.byteOffset % Uint32Array.BYTES_PER_ELEMENT === 0
    && output.byteOffset % Uint32Array.BYTES_PER_ELEMENT === 0
    && surface.data.byteLength % Uint32Array.BYTES_PER_ELEMENT === 0
    && output.byteLength % Uint32Array.BYTES_PER_ELEMENT === 0;
  const useAlignedWords = diagnostic?.mode !== "forced-scalar"
    && referenceRetainedAlphaScaleLittleEndian
    && aligned;
  if (useAlignedWords) {
    diagnosticCounters && (diagnosticCounters.alignedWordExecutions += 1);
    const sourceWords = new Uint32Array(
      surface.data.buffer,
      surface.data.byteOffset,
      surface.data.byteLength / Uint32Array.BYTES_PER_ELEMENT,
    );
    const outputWords = new Uint32Array(
      output.buffer,
      output.byteOffset,
      output.byteLength / Uint32Array.BYTES_PER_ELEMENT,
    );
    for (let y = top; y < bottom; y += 1) {
      let rowLeft = right;
      let rowRight = left;
      let rowNonzeroAlphaPixels = 0;
      const rowStart = y * surface.width + left;
      const rowEnd = y * surface.width + right;
      for (let pixel = rowStart, x = left; pixel < rowEnd; pixel += 1, x += 1) {
        const sourceWord = sourceWords[pixel];
        const alpha = Math.round((sourceWord >>> 24) * opacity);
        if (alpha === 0) {
          outputWords[pixel] = 0;
          continue;
        }
        outputWords[pixel] = (
          (sourceWord & 0x00ff_ffff)
          | (alpha << 24)
        ) >>> 0;
        rowNonzeroAlphaPixels += 1;
        if (rowLeft === right) rowLeft = x;
        rowRight = x + 1;
      }
      if (rowNonzeroAlphaPixels === 0) continue;
      support.nonzeroAlphaPixels += rowNonzeroAlphaPixels;
      if (rowLeft < support.left) support.left = rowLeft;
      if (y < support.top) support.top = y;
      if (rowRight > support.right) support.right = rowRight;
      if (y + 1 > support.bottom) support.bottom = y + 1;
    }
  } else {
    if (diagnosticCounters) {
      diagnosticCounters.scalarExecutions += 1;
      if (diagnostic?.mode === "automatic" && !aligned) {
        diagnosticCounters.unalignedFallbackExecutions += 1;
      }
      if (diagnostic?.mode === "automatic" && !referenceRetainedAlphaScaleLittleEndian) {
        diagnosticCounters.endianFallbackExecutions += 1;
      }
    }
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        const offset = (y * surface.width + x) * 4;
        const alpha = Math.round(surface.data[offset + 3] * opacity);
        if (alpha === 0) {
          output[offset] = 0;
          output[offset + 1] = 0;
          output[offset + 2] = 0;
          output[offset + 3] = 0;
          continue;
        }
        output[offset + 3] = alpha;
        observeAlpha(support, x, y, alpha);
      }
    }
  }
  return publishAlphaSupport(
    { data: output, width: surface.width, height: surface.height },
    "alpha-scale",
    support,
    alphaBytesObserved,
    (right - left) * (bottom - top),
  );
}
