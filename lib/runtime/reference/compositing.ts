import { Buffer } from "node:buffer";
import { referenceRetainedSurfaceAlphaSupport } from "./retained-surface";
import { executeReferenceNativeSourceOver } from "./native-source-over";

export const rgbaBlendModes = [
  "normal",
  "source-over",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "add",
  "plus",
  "difference",
] as const;

export type RgbaBlendMode = typeof rgbaBlendModes[number];
export const rgbaMaskModes = ["alpha", "luminance", "red", "green", "blue"] as const;
export type RgbaMaskMode = typeof rgbaMaskModes[number];
export type RgbaAlphaMode = "straight" | "premultiplied";

export const rgbaMaskMaximumRadiusPx = 64;
export const rgbaMaskMaximumCanvasPixels = 16_777_216;

/** Missing alphaMode means ordinary straight-alpha RGBA. */
export type RgbaSurface = Readonly<{
  data: Uint8Array;
  width: number;
  height: number;
  alphaMode?: RgbaAlphaMode;
}>;

export type RgbaCompositeOptions = Readonly<{
  mode?: RgbaBlendMode;
  outputAlphaMode?: RgbaAlphaMode;
}>;

export type RgbaMaskOptions = Readonly<{
  mode?: RgbaMaskMode;
  invert?: boolean;
  /** Positive dilates and negative erodes using an exact square neighborhood. */
  expandPx?: number;
  /** Exact support radius of the deterministic separable tent feather. */
  featherPx?: number;
}>;

type RgbaIterationBounds = Readonly<{
  left: number;
  top: number;
  right: number;
  bottom: number;
}>;

export type RgbaCompositeResult = {
  data: Uint8Array;
  width: number;
  height: number;
  alphaMode: RgbaAlphaMode;
};

const blendModeSet = new Set<string>(rgbaBlendModes);
const maskModeSet = new Set<string>(rgbaMaskModes);
const alphaModeSet = new Set<string>(["straight", "premultiplied"]);
const srgbToLinearBytes = Float64Array.from({ length: 256 }, (_, value) => {
  const encoded = value / 255;
  return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
});

// Exact inverse-sRGB half-code thresholds for the frozen byte quantizer.
const srgbByteMidpointLinearThresholds = Float64Array.from({ length: 255 }, (_, value) => {
  const encoded = (value + 0.5) / 255;
  return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
});
const srgbLinearQuantizerBucketMaximum = 65_535;
const srgbLinearQuantizerBucketBase = (() => {
  const result = new Uint8Array(srgbLinearQuantizerBucketMaximum + 1);
  let outputByte = 0;
  for (let bucket = 0; bucket <= srgbLinearQuantizerBucketMaximum; bucket += 1) {
    const lowerBound = bucket / srgbLinearQuantizerBucketMaximum;
    while (outputByte < 255 && lowerBound >= srgbByteMidpointLinearThresholds[outputByte]!) outputByte += 1;
    result[bucket] = outputByte;
  }
  return result;
})();
const exactSrgbBoundaryFallbackRadius = 1e-12;

type ReferencePrivateCompositeCounters = {
  executions: number;
  fastNormalStraightPixels: number;
  scalarPixels: number;
  quantizerBoundaryFallbacks: number;
  nativeExecutions: number;
  nativeFastNormalStraightPixels: number;
};

export type ReferencePrivateStraightRgbaCompositeDiagnostic = object;
const privateCompositeDiagnosticAuthority = new WeakMap<object, ReferencePrivateCompositeCounters>();

export function createReferencePrivateStraightRgbaCompositeDiagnostic(
  mode: "automatic" | "forced-js-fast" | "forced-scalar" = "automatic",
): ReferencePrivateStraightRgbaCompositeDiagnostic {
  const diagnostic = Object.freeze({ mode });
  privateCompositeDiagnosticAuthority.set(diagnostic, {
    executions: 0,
    fastNormalStraightPixels: 0,
    scalarPixels: 0,
    quantizerBoundaryFallbacks: 0,
    nativeExecutions: 0,
    nativeFastNormalStraightPixels: 0,
  });
  return diagnostic;
}

export function referencePrivateStraightRgbaCompositeDiagnosticSnapshot(
  diagnostic: ReferencePrivateStraightRgbaCompositeDiagnostic,
) {
  const counters = privateCompositeDiagnosticAuthority.get(diagnostic);
  if (!counters) throw new Error("CUT private RGBA composite diagnostic authority is invalid.");
  const mode = (diagnostic as { mode?: unknown }).mode;
  if (mode !== "automatic" && mode !== "forced-js-fast" && mode !== "forced-scalar") {
    throw new Error("CUT private RGBA composite diagnostic mode is invalid.");
  }
  return Object.freeze({ mode, ...counters });
}

const clampUnit = (value: number) => value <= 0 ? 0 : value >= 1 ? 1 : value;

function byte(value: number) { return Math.round(clampUnit(value) * 255); }

function linearToSrgb(value: number) {
  const linear = clampUnit(value);
  return linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
}

function exactLinearToSrgbByte(value: number, counters?: ReferencePrivateCompositeCounters) {
  const linear = clampUnit(value);
  const bucket = Math.min(srgbLinearQuantizerBucketMaximum, Math.floor(linear * srgbLinearQuantizerBucketMaximum));
  let outputByte = srgbLinearQuantizerBucketBase[bucket]!;
  while (outputByte < 255 && linear >= srgbByteMidpointLinearThresholds[outputByte]!) outputByte += 1;
  while (outputByte > 0 && linear < srgbByteMidpointLinearThresholds[outputByte - 1]!) outputByte -= 1;
  const lower = outputByte > 0 ? srgbByteMidpointLinearThresholds[outputByte - 1]! : undefined;
  const upper = outputByte < 255 ? srgbByteMidpointLinearThresholds[outputByte]! : undefined;
  if ((lower !== undefined && Math.abs(linear - lower) <= exactSrgbBoundaryFallbackRadius)
    || (upper !== undefined && Math.abs(linear - upper) <= exactSrgbBoundaryFallbackRadius)) {
    if (counters) counters.quantizerBoundaryFallbacks += 1;
    return byte(linearToSrgb(linear));
  }
  return outputByte;
}

const normalStraightAlphaTerms = (() => {
  const sourceOutsideBackdrop = new Float64Array(65_536);
  const sourceInsideBackdrop = new Float64Array(65_536);
  const backdropOutsideSource = new Float64Array(65_536);
  const outputAlpha = new Float64Array(65_536);
  const outputAlphaByte = new Uint8Array(65_536);
  for (let backdropAlphaByte = 0; backdropAlphaByte < 256; backdropAlphaByte += 1) {
    const backdropAlpha = backdropAlphaByte / 255;
    for (let sourceAlphaByte = 0; sourceAlphaByte < 256; sourceAlphaByte += 1) {
      const sourceAlpha = sourceAlphaByte / 255;
      const index = backdropAlphaByte * 256 + sourceAlphaByte;
      const alpha = sourceAlpha + backdropAlpha * (1 - sourceAlpha);
      sourceOutsideBackdrop[index] = sourceAlpha * (1 - backdropAlpha);
      sourceInsideBackdrop[index] = sourceAlpha * backdropAlpha;
      backdropOutsideSource[index] = backdropAlpha * (1 - sourceAlpha);
      outputAlpha[index] = alpha;
      outputAlphaByte[index] = byte(alpha);
    }
  }
  return Object.freeze({ sourceOutsideBackdrop, sourceInsideBackdrop, backdropOutsideSource, outputAlpha, outputAlphaByte });
})();

function alphaMode(surface: RgbaSurface, label: string): RgbaAlphaMode {
  const mode = surface.alphaMode ?? "straight";
  if (!alphaModeSet.has(mode)) throw new Error(`${label} alphaMode must be “straight” or “premultiplied”.`);
  return mode;
}

function validateSurface(surface: RgbaSurface, label: string): RgbaAlphaMode {
  if (!surface || typeof surface !== "object") throw new Error(`${label} must be an RGBA surface.`);
  if (!Number.isSafeInteger(surface.width) || !Number.isSafeInteger(surface.height) || surface.width < 1 || surface.height < 1) throw new Error(`${label} dimensions must be positive safe integers.`);
  const pixels = surface.width * surface.height;
  if (!Number.isSafeInteger(pixels) || pixels > Math.floor(Number.MAX_SAFE_INTEGER / 4)) throw new Error(`${label} dimensions exceed the RGBA addressable range.`);
  if (!(surface.data instanceof Uint8Array)) throw new Error(`${label} data must be a Uint8Array or Buffer.`);
  if (surface.data.byteLength !== pixels * 4) throw new Error(`${label} RGBA buffer length must equal width × height × 4.`);
  return alphaMode(surface, label);
}

function validatePair(first: RgbaSurface, second: RgbaSurface, firstLabel: string, secondLabel: string) {
  const firstAlpha = validateSurface(first, firstLabel);
  const secondAlpha = validateSurface(second, secondLabel);
  if (first.width !== second.width || first.height !== second.height) throw new Error(`${firstLabel} and ${secondLabel} dimensions must match.`);
  return { firstAlpha, secondAlpha };
}

function decodeChannel(data: Uint8Array, offset: number, alpha: number, mode: RgbaAlphaMode) {
  if (mode === "straight") return srgbToLinearBytes[data[offset]];
  if (alpha <= 0) return 0;
  const straightSrgb = clampUnit((data[offset] / 255) / alpha);
  return straightSrgb <= 0.04045 ? straightSrgb / 12.92 : ((straightSrgb + 0.055) / 1.055) ** 2.4;
}

function encodeChannel(linear: number, alpha: number, mode: RgbaAlphaMode) {
  const encoded = linearToSrgb(linear);
  return byte(mode === "premultiplied" ? encoded * alpha : encoded);
}

function blendChannel(mode: RgbaBlendMode, backdrop: number, source: number) {
  if (mode === "normal" || mode === "source-over") return source;
  if (mode === "multiply") return backdrop * source;
  if (mode === "screen") return backdrop + source - backdrop * source;
  if (mode === "overlay") return backdrop <= 0.5 ? 2 * backdrop * source : 1 - 2 * (1 - backdrop) * (1 - source);
  if (mode === "darken") return Math.min(backdrop, source);
  if (mode === "lighten") return Math.max(backdrop, source);
  if (mode === "add" || mode === "plus") return Math.min(1, backdrop + source);
  return Math.abs(backdrop - source);
}

function writeMaskedPixel(output: Uint8Array, target: RgbaSurface, offset: number, targetMode: RgbaAlphaMode, factor: number) {
  const amount = clampUnit(factor);
  if (targetMode === "straight") {
    output[offset] = target.data[offset];
    output[offset + 1] = target.data[offset + 1];
    output[offset + 2] = target.data[offset + 2];
  } else {
    output[offset] = byte((target.data[offset] / 255) * amount);
    output[offset + 1] = byte((target.data[offset + 1] / 255) * amount);
    output[offset + 2] = byte((target.data[offset + 2] / 255) * amount);
  }
  output[offset + 3] = byte((target.data[offset + 3] / 255) * amount);
}

/**
 * Composite `source` over `backdrop` in linear-light sRGB.
 *
 * Blend functions use straight linear RGB. Coverage uses the W3C source-over
 * blend equation:
 *
 *   co = as(1-ab)Cs + as*ab*B(Cb,Cs) + ab(1-as)Cb
 *   ao = as + ab(1-as)
 *
 * `co` is premultiplied linear RGB and is divided by `ao` before encoding.
 * Premultiplied byte surfaces are defined as encoded-sRGB bytes multiplied by
 * alpha, which matches conventional 8-bit RGBA interchange.
 */
function compositeRgbaTo(
  backdrop: RgbaSurface,
  source: RgbaSurface,
  options: RgbaCompositeOptions,
  suppliedOutput?: Uint8Array,
  iterationBounds?: RgbaIterationBounds,
  privateDiagnostic?: ReferencePrivateStraightRgbaCompositeDiagnostic,
): RgbaCompositeResult {
  const mode = options.mode ?? "normal";
  if (!blendModeSet.has(mode)) throw new Error(`Unsupported CUT RGBA blend mode “${String(mode)}”.`);
  const outputAlphaMode = options.outputAlphaMode ?? backdrop.alphaMode ?? "straight";
  if (!alphaModeSet.has(outputAlphaMode)) throw new Error("outputAlphaMode must be “straight” or “premultiplied”.");
  const { firstAlpha: backdropAlphaMode, secondAlpha: sourceAlphaMode } = validatePair(backdrop, source, "backdrop", "source");
  const output = suppliedOutput ?? new Uint8Array(backdrop.data.byteLength);
  if (!(output instanceof Uint8Array) || output.byteLength !== backdrop.data.byteLength) {
    throw new Error("CUT RGBA composite output must be a matching Uint8Array or Buffer.");
  }
  const transparentSourceKeepsBackdrop = backdropAlphaMode === "straight" && outputAlphaMode === "straight";
  const clearBackdropKeepsSource = sourceAlphaMode === "straight" && outputAlphaMode === "straight";
  const normalSourceOver = mode === "normal" || mode === "source-over";
  const diagnosticCounters = privateDiagnostic
    ? privateCompositeDiagnosticAuthority.get(privateDiagnostic)
    : undefined;
  if (privateDiagnostic && !diagnosticCounters) {
    throw new Error("CUT private RGBA composite diagnostic authority is invalid.");
  }
  const diagnosticMode = privateDiagnostic
    ? (privateDiagnostic as { mode?: unknown }).mode
    : "automatic";
  if (diagnosticMode !== "automatic" && diagnosticMode !== "forced-js-fast" && diagnosticMode !== "forced-scalar") {
    throw new Error("CUT private RGBA composite diagnostic mode is invalid.");
  }
  if (diagnosticCounters) diagnosticCounters.executions += 1;
  const fastNormalStraight = diagnosticMode !== "forced-scalar"
    && normalSourceOver
    && backdropAlphaMode === "straight"
    && sourceAlphaMode === "straight"
    && outputAlphaMode === "straight";

  // Most retained layers are sparse full-canvas surfaces. Copying a straight
  // backdrop once lets transparent source pixels bypass every linear-light
  // decode/blend/encode operation while preserving exact source order. A clear
  // backdrop still canonicalizes hidden RGB to zero below.
  if (transparentSourceKeepsBackdrop && output !== backdrop.data) output.set(backdrop.data);

  const left = iterationBounds?.left ?? 0;
  const top = iterationBounds?.top ?? 0;
  const right = iterationBounds?.right ?? backdrop.width;
  const bottom = iterationBounds?.bottom ?? backdrop.height;
  for (let y = top; y < bottom; y += 1) {
    const rowEnd = (y * backdrop.width + right) * 4;
    for (let offset = (y * backdrop.width + left) * 4; offset < rowEnd; offset += 4) {
      const backdropAlphaByte = backdrop.data[offset + 3];
      const sourceAlphaByte = source.data[offset + 3];

      if (sourceAlphaByte === 0) {
        if (backdropAlphaByte === 0) {
          // The frozen law emits canonical transparent black regardless of
          // hidden RGB or input/output alpha modes.
          output[offset] = 0;
          output[offset + 1] = 0;
          output[offset + 2] = 0;
          output[offset + 3] = 0;
          continue;
        }
        if (transparentSourceKeepsBackdrop) continue;
      }

      if (sourceAlphaByte === 255 && (normalSourceOver || backdropAlphaByte === 0)) {
        // At full source coverage, normal/source-over is exactly the source.
        // Alpha mode is immaterial at alpha=1. A clear backdrop has the same
        // result for every blend mode because the blend term has zero weight.
        output[offset] = source.data[offset];
        output[offset + 1] = source.data[offset + 1];
        output[offset + 2] = source.data[offset + 2];
        output[offset + 3] = 255;
        continue;
      }

      if (backdropAlphaByte === 0 && sourceAlphaByte > 0 && clearBackdropKeepsSource) {
        // With no backdrop coverage, every blend mode reduces to the straight
        // source. This is byte-exact for straight sRGB input/output.
        output[offset] = source.data[offset];
        output[offset + 1] = source.data[offset + 1];
        output[offset + 2] = source.data[offset + 2];
        output[offset + 3] = sourceAlphaByte;
        continue;
      }

      if (fastNormalStraight) {
        const alphaIndex = backdropAlphaByte * 256 + sourceAlphaByte;
        const outputAlpha = normalStraightAlphaTerms.outputAlpha[alphaIndex]!;
        const sourceOutsideBackdrop = normalStraightAlphaTerms.sourceOutsideBackdrop[alphaIndex]!;
        const sourceInsideBackdrop = normalStraightAlphaTerms.sourceInsideBackdrop[alphaIndex]!;
        const backdropOutsideSource = normalStraightAlphaTerms.backdropOutsideSource[alphaIndex]!;
        for (let channel = 0; channel < 3; channel += 1) {
          const backdropChannel = srgbToLinearBytes[backdrop.data[offset + channel]!]!;
          const sourceChannel = srgbToLinearBytes[source.data[offset + channel]!]!;
          const premultiplied = sourceOutsideBackdrop * sourceChannel
            + sourceInsideBackdrop * sourceChannel
            + backdropOutsideSource * backdropChannel;
          output[offset + channel] = exactLinearToSrgbByte(
            outputAlpha > 0 ? premultiplied / outputAlpha : 0,
            diagnosticCounters,
          );
        }
        output[offset + 3] = normalStraightAlphaTerms.outputAlphaByte[alphaIndex]!;
        if (diagnosticCounters) diagnosticCounters.fastNormalStraightPixels += 1;
        continue;
      }

      const backdropAlpha = backdropAlphaByte / 255;
      const sourceAlpha = sourceAlphaByte / 255;
      const outputAlpha = sourceAlpha + backdropAlpha * (1 - sourceAlpha);
      for (let channel = 0; channel < 3; channel += 1) {
        const backdropChannel = decodeChannel(backdrop.data, offset + channel, backdropAlpha, backdropAlphaMode);
        const sourceChannel = decodeChannel(source.data, offset + channel, sourceAlpha, sourceAlphaMode);
        const blended = blendChannel(mode, backdropChannel, sourceChannel);
        const premultiplied = sourceAlpha * (1 - backdropAlpha) * sourceChannel
          + sourceAlpha * backdropAlpha * blended
          + backdropAlpha * (1 - sourceAlpha) * backdropChannel;
        const straight = outputAlpha > 0 ? premultiplied / outputAlpha : 0;
        output[offset + channel] = encodeChannel(straight, outputAlpha, outputAlphaMode);
      }
      output[offset + 3] = byte(outputAlpha);
      if (diagnosticCounters) diagnosticCounters.scalarPixels += 1;
    }
  }
  return { data: output, width: backdrop.width, height: backdrop.height, alphaMode: outputAlphaMode };
}

export function compositeRgba(backdrop: RgbaSurface, source: RgbaSurface, options: RgbaCompositeOptions = {}): RgbaCompositeResult {
  return compositeRgbaTo(backdrop, source, options);
}

/**
 * Exact-order allocation-bounded source-over into caller-owned backdrop bytes.
 *
 * This deliberately mutates only `backdrop.data`; `source` remains read-only.
 * In-place execution cannot change alpha representation because doing so would
 * make the caller's backdrop metadata false. The scalar pixel law and every
 * transparent/opaque fast path are otherwise identical to `compositeRgba`.
 */
export function compositeRgbaInPlace(
  backdrop: RgbaSurface,
  source: RgbaSurface,
  options: RgbaCompositeOptions = {},
): RgbaCompositeResult {
  const backdropAlphaMode = backdrop.alphaMode ?? "straight";
  const outputAlphaMode = options.outputAlphaMode ?? backdropAlphaMode;
  if (outputAlphaMode !== backdropAlphaMode) {
    throw new Error("CUT in-place RGBA compositing cannot change the backdrop alphaMode.");
  }
  return compositeRgbaTo(backdrop, source, { ...options, outputAlphaMode }, backdrop.data);
}

/**
 * Internal LocalSpace authority for one canonical, private, straight-alpha
 * accumulator. This is deliberately not part of CUT's public generic
 * compositing law.
 */
export type ReferencePrivateStraightRgbaAccumulator = {
  data: Buffer;
  width: number;
  height: number;
  alphaMode: "straight";
};

export type ReferencePrivateRgbaSourceAlphaBounds = Readonly<{
  format: "cut-reference-private-rgba-source-alpha-bounds";
  version: 1;
  empty: boolean;
  left: number;
  top: number;
  right: number;
  bottom: number;
  nonzeroAlphaPixels: number;
  pixelsScanned: number;
}>;

export const referencePrivateStraightRgbaBoundsAlgorithmVersion =
  "cut-reference-private-straight-rgba-bounded-source-over-v3";
const referencePrivateRgbaMaximumPixels = 16_777_216;
const privateAccumulatorAuthority = new WeakSet<object>();
type PrivateAccumulatorAlphaSupport = {
  empty: boolean;
  left: number;
  top: number;
  right: number;
  bottom: number;
  nonzeroAlphaPixels: number;
  revision: number;
};
const privateAccumulatorAlphaSupport = new WeakMap<object, PrivateAccumulatorAlphaSupport>();
const privateSourceBoundsAuthority = new WeakMap<object, Readonly<{
  source: RgbaSurface;
  data: Uint8Array;
  width: number;
  height: number;
  accumulatorRevision?: number;
}>>();

export function createReferencePrivateStraightRgbaAccumulator(
  width: number,
  height: number,
): ReferencePrivateStraightRgbaAccumulator {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error("CUT private RGBA accumulator dimensions must be positive safe integers.");
  }
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > referencePrivateRgbaMaximumPixels) {
    throw new Error(`CUT private RGBA accumulator exceeds the ${referencePrivateRgbaMaximumPixels}-pixel resource limit.`);
  }
  const accumulator: ReferencePrivateStraightRgbaAccumulator = {
    data: Buffer.alloc(pixels * 4),
    width,
    height,
    alphaMode: "straight",
  };
  privateAccumulatorAuthority.add(accumulator);
  privateAccumulatorAlphaSupport.set(accumulator, {
    empty: true,
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    nonzeroAlphaPixels: 0,
    revision: 0,
  });
  return accumulator;
}

/**
 * Return the exact alpha support already maintained by CUT's private
 * accumulator. This avoids rescanning a completed nested LocalSpace tile when
 * it becomes a source for its parent. Arbitrary/caller-owned surfaces remain
 * ineligible and must use byte-derived bounds.
 */
export function referencePrivateStraightRgbaAccumulatorAlphaBounds(
  source: RgbaSurface,
): ReferencePrivateRgbaSourceAlphaBounds | undefined {
  if (!privateAccumulatorAuthority.has(source)) return undefined;
  const support = privateAccumulatorAlphaSupport.get(source);
  if (!support) throw new Error("CUT private RGBA accumulator alpha-support authority is missing.");
  const receipt: ReferencePrivateRgbaSourceAlphaBounds = Object.freeze({
    format: "cut-reference-private-rgba-source-alpha-bounds",
    version: 1,
    empty: support.empty,
    left: support.left,
    top: support.top,
    right: support.right,
    bottom: support.bottom,
    nonzeroAlphaPixels: support.nonzeroAlphaPixels,
    pixelsScanned: 0,
  });
  privateSourceBoundsAuthority.set(receipt, Object.freeze({
    source,
    data: source.data,
    width: source.width,
    height: source.height,
    accumulatorRevision: support.revision,
  }));
  return receipt;
}

/**
 * Derive one unforgeable half-open rectangle from the source's actual alpha
 * bytes. The caller must retain the source as immutable while this receipt is
 * live; the private compositor never mutates it.
 */
export function deriveReferencePrivateRgbaSourceAlphaBounds(
  source: RgbaSurface,
): ReferencePrivateRgbaSourceAlphaBounds {
  validateSurface(source, "private source");
  const maintainedAccumulatorBounds = referencePrivateStraightRgbaAccumulatorAlphaBounds(source);
  if (maintainedAccumulatorBounds) return maintainedAccumulatorBounds;
  const retainedSupport = referenceRetainedSurfaceAlphaSupport(source);
  if (retainedSupport) {
    const receipt: ReferencePrivateRgbaSourceAlphaBounds = Object.freeze({
      format: "cut-reference-private-rgba-source-alpha-bounds",
      version: 1,
      empty: retainedSupport.empty,
      left: retainedSupport.left,
      top: retainedSupport.top,
      right: retainedSupport.right,
      bottom: retainedSupport.bottom,
      nonzeroAlphaPixels: retainedSupport.nonzeroAlphaPixels,
      pixelsScanned: 0,
    });
    privateSourceBoundsAuthority.set(receipt, Object.freeze({
      source,
      data: source.data,
      width: source.width,
      height: source.height,
    }));
    return receipt;
  }

  let left = source.width;
  let top = source.height;
  let right = 0;
  let bottom = 0;
  let nonzeroAlphaPixels = 0;
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < source.width; x += 1) {
      if (source.data[(y * source.width + x) * 4 + 3] === 0) continue;
      nonzeroAlphaPixels += 1;
      if (x < left) left = x;
      if (x + 1 > right) right = x + 1;
      if (y < top) top = y;
      if (y + 1 > bottom) bottom = y + 1;
    }
  }
  const empty = nonzeroAlphaPixels === 0;
  const receipt: ReferencePrivateRgbaSourceAlphaBounds = Object.freeze({
    format: "cut-reference-private-rgba-source-alpha-bounds",
    version: 1,
    empty,
    left: empty ? 0 : left,
    top: empty ? 0 : top,
    right: empty ? 0 : right,
    bottom: empty ? 0 : bottom,
    nonzeroAlphaPixels,
    pixelsScanned: source.width * source.height,
  });
  privateSourceBoundsAuthority.set(receipt, Object.freeze({
    source,
    data: source.data,
    width: source.width,
    height: source.height,
  }));
  return receipt;
}

/**
 * Derive exact source support while scanning only a renderer-proved
 * conservative paint rectangle. This is an internal retained-raster boundary:
 * callers must derive the rectangle from the same geometry that authored the
 * immutable pixels. The returned receipt remains exact because every alpha
 * byte inside the conservative rectangle is inspected; pixels outside are
 * known transparent by that producer contract.
 */
export function deriveReferencePrivateRgbaSourceAlphaBoundsWithin(
  source: RgbaSurface,
  scanBounds: Readonly<{ left: number; top: number; right: number; bottom: number }>,
): ReferencePrivateRgbaSourceAlphaBounds {
  validateSurface(source, "private source");
  if (![scanBounds.left, scanBounds.top, scanBounds.right, scanBounds.bottom].every(Number.isSafeInteger)
    || scanBounds.left < 0 || scanBounds.top < 0
    || scanBounds.right < scanBounds.left || scanBounds.bottom < scanBounds.top
    || scanBounds.right > source.width || scanBounds.bottom > source.height) {
    throw new Error("CUT private RGBA source scan bounds must be one valid half-open source rectangle.");
  }
  const maintainedAccumulatorBounds = referencePrivateStraightRgbaAccumulatorAlphaBounds(source);
  if (maintainedAccumulatorBounds) return maintainedAccumulatorBounds;
  const retainedSupport = referenceRetainedSurfaceAlphaSupport(source);
  if (retainedSupport) {
    const receipt: ReferencePrivateRgbaSourceAlphaBounds = Object.freeze({
      format: "cut-reference-private-rgba-source-alpha-bounds",
      version: 1,
      empty: retainedSupport.empty,
      left: retainedSupport.left,
      top: retainedSupport.top,
      right: retainedSupport.right,
      bottom: retainedSupport.bottom,
      nonzeroAlphaPixels: retainedSupport.nonzeroAlphaPixels,
      pixelsScanned: 0,
    });
    privateSourceBoundsAuthority.set(receipt, Object.freeze({
      source,
      data: source.data,
      width: source.width,
      height: source.height,
    }));
    return receipt;
  }

  let left = source.width;
  let top = source.height;
  let right = 0;
  let bottom = 0;
  let nonzeroAlphaPixels = 0;
  for (let y = scanBounds.top; y < scanBounds.bottom; y += 1) {
    for (let x = scanBounds.left; x < scanBounds.right; x += 1) {
      if (source.data[(y * source.width + x) * 4 + 3] === 0) continue;
      nonzeroAlphaPixels += 1;
      if (x < left) left = x;
      if (x + 1 > right) right = x + 1;
      if (y < top) top = y;
      if (y + 1 > bottom) bottom = y + 1;
    }
  }
  const empty = nonzeroAlphaPixels === 0;
  const receipt: ReferencePrivateRgbaSourceAlphaBounds = Object.freeze({
    format: "cut-reference-private-rgba-source-alpha-bounds",
    version: 1,
    empty,
    left: empty ? 0 : left,
    top: empty ? 0 : top,
    right: empty ? 0 : right,
    bottom: empty ? 0 : bottom,
    nonzeroAlphaPixels,
    pixelsScanned: (scanBounds.right - scanBounds.left) * (scanBounds.bottom - scanBounds.top),
  });
  privateSourceBoundsAuthority.set(receipt, Object.freeze({
    source,
    data: source.data,
    width: source.width,
    height: source.height,
  }));
  return receipt;
}

function byteRangesOverlap(left: Uint8Array, right: Uint8Array) {
  if (left.buffer !== right.buffer) return false;
  const leftEnd = left.byteOffset + left.byteLength;
  const rightEnd = right.byteOffset + right.byteLength;
  return left.byteOffset < rightEnd && right.byteOffset < leftEnd;
}

/**
 * Exact-order LocalSpace source-over/blend into a private canonical
 * accumulator, visiting only the actual nonzero-source-alpha rectangle.
 */
export function compositeRgbaIntoReferencePrivateStraightAccumulator(
  backdrop: ReferencePrivateStraightRgbaAccumulator,
  source: RgbaSurface,
  bounds: ReferencePrivateRgbaSourceAlphaBounds,
  options: Readonly<{
    mode?: RgbaBlendMode;
    diagnostic?: ReferencePrivateStraightRgbaCompositeDiagnostic;
  }> = {},
): ReferencePrivateStraightRgbaAccumulator {
  if (!privateAccumulatorAuthority.has(backdrop)) {
    throw new Error("CUT bounded RGBA compositing requires its private accumulator authority.");
  }
  const trusted = privateSourceBoundsAuthority.get(bounds);
  if (!trusted
    || trusted.source !== source
    || trusted.data !== source.data
    || trusted.width !== source.width
    || trusted.height !== source.height) {
    throw new Error("CUT bounded RGBA compositing requires source bounds derived for these exact immutable bytes.");
  }
  const sourceAccumulatorSupport = privateAccumulatorAlphaSupport.get(source);
  if (trusted.accumulatorRevision !== undefined
    && trusted.accumulatorRevision !== sourceAccumulatorSupport?.revision) {
    throw new Error("CUT bounded RGBA compositing refuses a stale private accumulator alpha-support receipt.");
  }
  if (backdrop.width !== source.width || backdrop.height !== source.height) {
    throw new Error("CUT bounded RGBA accumulator and source dimensions must match.");
  }
  if (byteRangesOverlap(backdrop.data, source.data)) {
    throw new Error("CUT bounded RGBA source bytes must not alias the private accumulator.");
  }
  const validBounds = Number.isSafeInteger(bounds.left)
    && Number.isSafeInteger(bounds.top)
    && Number.isSafeInteger(bounds.right)
    && Number.isSafeInteger(bounds.bottom)
    && bounds.left >= 0
    && bounds.top >= 0
    && bounds.right >= bounds.left
    && bounds.bottom >= bounds.top
    && bounds.right <= source.width
    && bounds.bottom <= source.height
    && bounds.empty === (bounds.left === bounds.right || bounds.top === bounds.bottom);
  if (!validBounds) {
    throw new Error("CUT bounded RGBA source receipt contains an invalid half-open rectangle.");
  }
  const backdropSupport = privateAccumulatorAlphaSupport.get(backdrop);
  if (!backdropSupport) {
    throw new Error("CUT private RGBA accumulator alpha-support authority is missing.");
  }
  const diagnosticCounters = options.diagnostic
    ? privateCompositeDiagnosticAuthority.get(options.diagnostic)
    : undefined;
  if (options.diagnostic && !diagnosticCounters) {
    throw new Error("CUT private RGBA composite diagnostic authority is invalid.");
  }
  const diagnosticMode = options.diagnostic
    ? (options.diagnostic as { mode?: unknown }).mode
    : "automatic";
  if (diagnosticMode !== "automatic" && diagnosticMode !== "forced-js-fast" && diagnosticMode !== "forced-scalar") {
    throw new Error("CUT private RGBA composite diagnostic mode is invalid.");
  }
  const sourceAlphaMode = validateSurface(source, "private source");
  const blendMode = options.mode ?? "normal";
  const native = diagnosticMode === "automatic"
    && sourceAlphaMode === "straight"
    && (blendMode === "normal" || blendMode === "source-over")
    ? executeReferenceNativeSourceOver({
      backdrop: backdrop.data,
      source: source.data,
      width: source.width,
      bounds,
      tables: {
        srgbToLinear: srgbToLinearBytes,
        thresholds: srgbByteMidpointLinearThresholds,
        bucketBase: srgbLinearQuantizerBucketBase,
        sourceOutside: normalStraightAlphaTerms.sourceOutsideBackdrop,
        sourceInside: normalStraightAlphaTerms.sourceInsideBackdrop,
        backdropOutside: normalStraightAlphaTerms.backdropOutsideSource,
        outputAlpha: normalStraightAlphaTerms.outputAlpha,
      },
    })
    : undefined;
  let newlyCoveredPixels = 0;
  if (native) {
    newlyCoveredPixels = native.newlyCoveredPixels;
    if (diagnosticCounters) {
      diagnosticCounters.executions += 1;
      diagnosticCounters.fastNormalStraightPixels += native.fastPixels;
      diagnosticCounters.quantizerBoundaryFallbacks += native.fallbackChannels;
      diagnosticCounters.nativeExecutions += 1;
      diagnosticCounters.nativeFastNormalStraightPixels += native.fastPixels;
    }
  } else {
    if (!bounds.empty) {
      for (let y = bounds.top; y < bounds.bottom; y += 1) {
        const rowEnd = (y * source.width + bounds.right) * 4;
        for (let offset = (y * source.width + bounds.left) * 4; offset < rowEnd; offset += 4) {
          if (source.data[offset + 3] !== 0 && backdrop.data[offset + 3] === 0) newlyCoveredPixels += 1;
        }
      }
    }
    compositeRgbaTo(backdrop, source, {
      mode: options.mode,
      outputAlphaMode: "straight",
    }, backdrop.data, bounds, options.diagnostic);
  }
  if (!bounds.empty) {
    const previouslyEmpty = backdropSupport.empty;
    backdropSupport.empty = false;
    backdropSupport.left = previouslyEmpty ? bounds.left : Math.min(backdropSupport.left, bounds.left);
    backdropSupport.top = previouslyEmpty ? bounds.top : Math.min(backdropSupport.top, bounds.top);
    backdropSupport.right = previouslyEmpty ? bounds.right : Math.max(backdropSupport.right, bounds.right);
    backdropSupport.bottom = previouslyEmpty ? bounds.bottom : Math.max(backdropSupport.bottom, bounds.bottom);
    backdropSupport.nonzeroAlphaPixels += newlyCoveredPixels;
  }
  backdropSupport.revision += 1;
  return backdrop;
}

/** Multiply target coverage by the mask's alpha channel. */
export function applyAlphaMaskRgba(target: RgbaSurface, mask: RgbaSurface): RgbaCompositeResult {
  const { firstAlpha: targetMode } = validatePair(target, mask, "target", "mask");
  const output = new Uint8Array(target.data.byteLength);
  for (let offset = 0; offset < output.length; offset += 4) writeMaskedPixel(output, target, offset, targetMode, mask.data[offset + 3] / 255);
  return { data: output, width: target.width, height: target.height, alphaMode: targetMode };
}

/**
 * Multiply target coverage by linear-light Rec. 709 mask luminance and mask
 * alpha. Transparent white therefore masks out rather than behaving as white.
 */
export function applyLuminanceMaskRgba(target: RgbaSurface, mask: RgbaSurface): RgbaCompositeResult {
  const { firstAlpha: targetMode, secondAlpha: maskMode } = validatePair(target, mask, "target", "mask");
  const output = new Uint8Array(target.data.byteLength);
  for (let offset = 0; offset < output.length; offset += 4) {
    const maskAlpha = mask.data[offset + 3] / 255;
    const red = decodeChannel(mask.data, offset, maskAlpha, maskMode);
    const green = decodeChannel(mask.data, offset + 1, maskAlpha, maskMode);
    const blue = decodeChannel(mask.data, offset + 2, maskAlpha, maskMode);
    const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    writeMaskedPixel(output, target, offset, targetMode, luminance * maskAlpha);
  }
  return { data: output, width: target.width, height: target.height, alphaMode: targetMode };
}

function validateMaskOptions(options: RgbaMaskOptions) {
  const mode = options.mode ?? "alpha";
  if (!maskModeSet.has(mode)) throw new Error(`Unsupported CUT RGBA mask mode “${String(mode)}”.`);
  const invert = options.invert ?? false;
  if (typeof invert !== "boolean") throw new Error("CUT RGBA mask invert must be Boolean.");
  const expandPx = options.expandPx ?? 0, featherPx = options.featherPx ?? 0;
  if (!Number.isSafeInteger(expandPx) || Math.abs(expandPx) > rgbaMaskMaximumRadiusPx) {
    throw new Error(`CUT RGBA mask expansion must be an exact integer from -${rgbaMaskMaximumRadiusPx} through ${rgbaMaskMaximumRadiusPx} pixels.`);
  }
  if (!Number.isSafeInteger(featherPx) || featherPx < 0 || featherPx > rgbaMaskMaximumRadiusPx) {
    throw new Error(`CUT RGBA mask feather must be an exact integer from 0 through ${rgbaMaskMaximumRadiusPx} pixels.`);
  }
  return { mode, invert, expandPx, featherPx };
}

function maskCoverage(mask: RgbaSurface, mode: RgbaMaskMode, maskAlphaMode: RgbaAlphaMode) {
  const pixels = mask.width * mask.height;
  if (pixels > rgbaMaskMaximumCanvasPixels) throw new Error(`CUT RGBA mask exceeds the ${rgbaMaskMaximumCanvasPixels}-pixel CPU budget.`);
  const output = new Float32Array(pixels);
  for (let index = 0, offset = 0; index < pixels; index += 1, offset += 4) {
    const alpha = mask.data[offset + 3] / 255;
    if (mode === "alpha") { output[index] = alpha; continue; }
    // Color-derived coverage is associated with matte alpha. Hidden RGB under
    // zero alpha can therefore never reveal target pixels or contaminate a
    // feathered edge.
    if (alpha <= 0) continue;
    const red = decodeChannel(mask.data, offset, alpha, maskAlphaMode);
    const green = decodeChannel(mask.data, offset + 1, alpha, maskAlphaMode);
    const blue = decodeChannel(mask.data, offset + 2, alpha, maskAlphaMode);
    const selected = mode === "red" ? red
      : mode === "green" ? green
        : mode === "blue" ? blue
          : 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    output[index] = clampUnit(selected * alpha);
  }
  return output;
}

/** One zero-padded horizontal or vertical square max/min filter in O(pixels). */
function extremaPass(input: Float32Array, width: number, height: number, radius: number, horizontal: boolean, dilate: boolean) {
  if (radius === 0) return input;
  const lineLength = horizontal ? width : height, lineCount = horizontal ? height : width;
  const paddedLength = lineLength + radius * 2, window = radius * 2 + 1;
  const dequeIndexes = new Int32Array(paddedLength), dequeValues = new Float32Array(paddedLength);
  const output = new Float32Array(input.length);
  for (let line = 0; line < lineCount; line += 1) {
    let head = 0, tail = 0;
    for (let padded = 0; padded < paddedLength; padded += 1) {
      const coordinate = padded - radius;
      const value = coordinate < 0 || coordinate >= lineLength
        ? 0
        : input[horizontal ? line * width + coordinate : coordinate * width + line];
      while (head < tail && (dilate ? dequeValues[tail - 1] <= value : dequeValues[tail - 1] >= value)) tail -= 1;
      dequeIndexes[tail] = padded; dequeValues[tail] = value; tail += 1;
      const minimumIndex = padded - window + 1;
      while (head < tail && dequeIndexes[head] < minimumIndex) head += 1;
      if (minimumIndex < 0) continue;
      output[horizontal ? line * width + minimumIndex : minimumIndex * width + line] = dequeValues[head];
    }
  }
  return output;
}

function morphology(input: Float32Array, width: number, height: number, expansion: number) {
  if (expansion === 0) return input;
  const radius = Math.abs(expansion), dilate = expansion > 0;
  return extremaPass(extremaPass(input, width, height, radius, true, dilate), width, height, radius, false, dilate);
}

/** One normalized zero-padded box pass with a fixed denominator. */
function boxPass(input: Float32Array, width: number, height: number, radius: number, horizontal: boolean) {
  if (radius === 0) return input;
  const lineLength = horizontal ? width : height, lineCount = horizontal ? height : width, denominator = radius * 2 + 1;
  const output = new Float32Array(input.length);
  const read = (line: number, coordinate: number) => coordinate < 0 || coordinate >= lineLength
    ? 0
    : input[horizontal ? line * width + coordinate : coordinate * width + line];
  for (let line = 0; line < lineCount; line += 1) {
    let sum = 0;
    for (let coordinate = -radius; coordinate <= radius; coordinate += 1) sum += read(line, coordinate);
    for (let coordinate = 0; coordinate < lineLength; coordinate += 1) {
      output[horizontal ? line * width + coordinate : coordinate * width + line] = clampUnit(sum / denominator);
      sum += read(line, coordinate + radius + 1) - read(line, coordinate - radius);
    }
  }
  return output;
}

function boxBlur(input: Float32Array, width: number, height: number, radius: number) {
  return radius === 0 ? input : boxPass(boxPass(input, width, height, radius, true), width, height, radius, false);
}

/**
 * A deterministic separable tent kernel. Convolving normalized boxes with
 * radii floor(r/2) and ceil(r/2) gives exact finite support `r`; coverage
 * outside the canvas is always zero rather than edge-extended.
 */
function feather(input: Float32Array, width: number, height: number, radius: number) {
  if (radius === 0) return input;
  return boxBlur(boxBlur(input, width, height, Math.floor(radius / 2)), width, height, Math.ceil(radius / 2));
}

function straightTargetChannel(target: RgbaSurface, offset: number, targetAlpha: number, targetMode: RgbaAlphaMode) {
  if (targetAlpha <= 0) return 0;
  if (targetMode === "straight") return target.data[offset];
  return byte((target.data[offset] / 255) / targetAlpha);
}

/**
 * Execute the public advanced Mask contract.
 *
 * Order is channel extraction -> signed expansion/erosion -> feather ->
 * inversion -> target-alpha multiplication. The returned boundary is always
 * straight alpha. RGB is preserved unassociated while coverage remains
 * non-zero and zeroed when output alpha is zero, preventing hidden-RGB leaks.
 */
export function applyMaskRgba(target: RgbaSurface, mask: RgbaSurface, options: RgbaMaskOptions = {}): RgbaCompositeResult {
  const { firstAlpha: targetMode, secondAlpha: maskMode } = validatePair(target, mask, "target", "mask");
  const config = validateMaskOptions(options);
  const pixels = target.width * target.height;
  if (pixels > rgbaMaskMaximumCanvasPixels) throw new Error(`CUT RGBA mask exceeds the ${rgbaMaskMaximumCanvasPixels}-pixel CPU budget.`);
  let coverage: Float32Array = maskCoverage(mask, config.mode, maskMode);
  coverage = morphology(coverage, target.width, target.height, config.expandPx);
  coverage = feather(coverage, target.width, target.height, config.featherPx);
  const output = new Uint8Array(target.data.byteLength);
  for (let index = 0, offset = 0; index < pixels; index += 1, offset += 4) {
    const amount = clampUnit(config.invert ? 1 - coverage[index] : coverage[index]);
    const targetAlpha = target.data[offset + 3] / 255, outputAlpha = byte(targetAlpha * amount);
    output[offset + 3] = outputAlpha;
    if (outputAlpha === 0) continue;
    output[offset] = straightTargetChannel(target, offset, targetAlpha, targetMode);
    output[offset + 1] = straightTargetChannel(target, offset + 1, targetAlpha, targetMode);
    output[offset + 2] = straightTargetChannel(target, offset + 2, targetAlpha, targetMode);
  }
  return { data: output, width: target.width, height: target.height, alphaMode: "straight" };
}
