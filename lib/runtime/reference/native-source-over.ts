import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import identityJson from "./native-source-over-identity.json";

type NativeSourceOverIdentity = Readonly<{
  format: "cut-reference-native-source-over-identity";
  version: 1;
  algorithm: string;
  platform: "darwin";
  architecture: "arm64";
  nodeApi: string;
  compiler: string;
  source: Readonly<{ locator: string; bytes: number; sha256: string }>;
  binary: Readonly<{ sourceLocator: string; runtimeName: string; bytes: number; sha256: string }>;
}>;

export const referenceNativeSourceOverIdentity = Object.freeze(identityJson as NativeSourceOverIdentity);

export const referenceJavascriptSourceOverImplementation =
  "cut-reference-javascript-source-over-v1" as const;

export type ReferenceNativeSourceOverBackend =
  | Readonly<{
    mode: "native";
    platform: NodeJS.Platform;
    architecture: string;
    algorithm: string;
    binarySha256: string;
  }>
  | Readonly<{
    mode: "javascript";
    platform: NodeJS.Platform;
    architecture: string;
    algorithm: string;
    implementation: typeof referenceJavascriptSourceOverImplementation;
  }>;

type ReferenceNativeSourceOverBackendCommon = Readonly<{
  platform: NodeJS.Platform;
  architecture: string;
  algorithm: string;
}>;

export type ReferenceNativeSourceOverTables = Readonly<{
  srgbToLinear: Float64Array;
  thresholds: Float64Array;
  bucketBase: Uint8Array;
  sourceOutside: Float64Array;
  sourceInside: Float64Array;
  backdropOutside: Float64Array;
  outputAlpha: Float64Array;
}>;

export type ReferenceNativeSourceOverResult = Readonly<{
  fastPixels: number;
  fallbackChannels: number;
  newlyCoveredPixels: number;
}>;

type NativeModule = Readonly<{
  compositeNormalStraightInPlace: (...arguments_: readonly unknown[]) => unknown;
  deriveLimiterEnvelopeRange: (...arguments_: readonly unknown[]) => unknown;
  deriveRgbaAlphaBounds: (...arguments_: readonly unknown[]) => unknown;
  rasterLocalSpaceScaleTranslationQ16: (...arguments_: readonly unknown[]) => unknown;
  rasterRetainedMediaViewport: (...arguments_: readonly unknown[]) => unknown;
  scaleRetainedAlpha: (...arguments_: readonly unknown[]) => unknown;
  translateRetainedSurfaceQ16: (...arguments_: readonly unknown[]) => unknown;
}>;

let loaded: NativeModule | undefined;

function typedArrayByteRangesOverlap(first: ArrayBufferView, second: ArrayBufferView) {
  if (first.buffer !== second.buffer) return false;
  const firstEnd = first.byteOffset + first.byteLength;
  const secondEnd = second.byteOffset + second.byteLength;
  return first.byteOffset < secondEnd && second.byteOffset < firstEnd;
}

function fail(message: string): never {
  throw new Error(`CUT_NATIVE_SOURCE_OVER: ${message}`);
}

function stableBinary(locator: string) {
  const lexical = resolve(locator);
  let pathState;
  try { pathState = lstatSync(lexical); }
  catch { fail("the supported native source-over binary is missing"); }
  if (pathState.isSymbolicLink() || !pathState.isFile()
    || pathState.size !== referenceNativeSourceOverIdentity.binary.bytes
    || realpathSync(lexical) !== lexical) {
    fail("the supported native source-over binary is not the exact regular non-link artifact");
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(lexical, "r");
    const before = fstatSync(descriptor);
    if (before.dev !== pathState.dev || before.ino !== pathState.ino
      || before.size !== pathState.size || before.mtimeMs !== pathState.mtimeMs
      || before.ctimeMs !== pathState.ctimeMs) {
      fail("the supported native source-over binary changed before verification");
    }
    const bytes = readFileSync(descriptor), after = fstatSync(descriptor);
    if (bytes.byteLength !== before.size
      || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
      || createHash("sha256").update(bytes).digest("hex") !== referenceNativeSourceOverIdentity.binary.sha256) {
      fail("the supported native source-over binary bytes do not match their implementation authority");
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  return lexical;
}

function runtimeModule() {
  if (process.platform !== referenceNativeSourceOverIdentity.platform
    || process.arch !== referenceNativeSourceOverIdentity.architecture) return undefined;
  if (process.versions.napi === undefined
    || !/^\d+$/u.test(process.versions.napi)
    || Number(process.versions.napi) < Number(referenceNativeSourceOverIdentity.nodeApi)) {
    fail(`the supported host requires Node-API ${referenceNativeSourceOverIdentity.nodeApi} or newer`);
  }
  if (loaded) return loaded;
  const locator = stableBinary(resolve(dirname(__filename), referenceNativeSourceOverIdentity.binary.runtimeName));
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const candidate = require(locator) as Partial<NativeModule>;
  if (!candidate || typeof candidate !== "object"
    || Object.keys(candidate).sort().join(",") !== "compositeNormalStraightInPlace,deriveLimiterEnvelopeRange,deriveRgbaAlphaBounds,rasterLocalSpaceScaleTranslationQ16,rasterRetainedMediaViewport,scaleRetainedAlpha,translateRetainedSurfaceQ16"
    || typeof candidate.compositeNormalStraightInPlace !== "function"
    || typeof candidate.deriveLimiterEnvelopeRange !== "function"
    || typeof candidate.deriveRgbaAlphaBounds !== "function"
    || typeof candidate.rasterLocalSpaceScaleTranslationQ16 !== "function"
    || typeof candidate.rasterRetainedMediaViewport !== "function"
    || typeof candidate.scaleRetainedAlpha !== "function"
    || typeof candidate.translateRetainedSurfaceQ16 !== "function") {
    fail("the authenticated native source-over module has an invalid closed export surface");
  }
  loaded = Object.freeze({
    compositeNormalStraightInPlace: candidate.compositeNormalStraightInPlace,
    deriveLimiterEnvelopeRange: candidate.deriveLimiterEnvelopeRange,
    deriveRgbaAlphaBounds: candidate.deriveRgbaAlphaBounds,
    rasterLocalSpaceScaleTranslationQ16: candidate.rasterLocalSpaceScaleTranslationQ16,
    rasterRetainedMediaViewport: candidate.rasterRetainedMediaViewport,
    scaleRetainedAlpha: candidate.scaleRetainedAlpha,
    translateRetainedSurfaceQ16: candidate.translateRetainedSurfaceQ16,
  });
  return loaded;
}

export type ReferenceNativeLimiterEnvelopeResult = Readonly<{
  frames: number;
  firBaseFrames: number;
}>;

export type ReferenceNativeAlphaSupportResult = Readonly<{
  empty: boolean;
  left: number;
  top: number;
  right: number;
  bottom: number;
  nonzeroAlphaPixels: number;
}>;

export type ReferenceNativeScaleTranslationResult = Readonly<{
  integerSamplesCopied: number;
  bilinearSamplesEvaluated: number;
  sourceTapsRead: number;
}>;

function nativeAlphaSupportResult(
  value: unknown,
  width: number,
  height: number,
  maximumPixels: number,
  label: string,
): ReferenceNativeAlphaSupportResult {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "bottom,empty,left,nonzeroAlphaPixels,right,top") {
    fail(`native ${label} returned an invalid closed support receipt`);
  }
  const result = value as Record<string, unknown>;
  if (typeof result.empty !== "boolean") fail(`native ${label} returned an invalid empty flag`);
  const support = Object.freeze({
    empty: result.empty,
    left: exactCount(result.left, `${label} left`, width),
    top: exactCount(result.top, `${label} top`, height),
    right: exactCount(result.right, `${label} right`, width),
    bottom: exactCount(result.bottom, `${label} bottom`, height),
    nonzeroAlphaPixels: exactCount(result.nonzeroAlphaPixels, `${label} nonzero-alpha count`, maximumPixels),
  });
  if (support.left > support.right || support.top > support.bottom
    || support.empty !== (support.nonzeroAlphaPixels === 0)
    || support.empty !== (support.left === support.right || support.top === support.bottom)) {
    fail(`native ${label} support counters are inconsistent`);
  }
  return support;
}

/** Exact native alpha-support scan; unsupported platforms retain JS parity. */
export function executeReferenceNativeRgbaAlphaBounds(input: Readonly<{
  source: Uint8Array;
  width: number;
  height: number;
}>): ReferenceNativeAlphaSupportResult | undefined {
  const implementation = runtimeModule();
  if (!implementation) return undefined;
  const pixels = input.width * input.height;
  if (!(input.source instanceof Uint8Array)
    || !Number.isSafeInteger(input.width) || !Number.isSafeInteger(input.height)
    || input.width < 1 || input.height < 1
    || !Number.isSafeInteger(pixels) || pixels < 1
    || input.source.byteLength !== pixels * 4) {
    fail("native alpha-bounds arguments are outside their exact typed boundary");
  }
  return nativeAlphaSupportResult(
    implementation.deriveRgbaAlphaBounds(input.source, input.width, input.height),
    input.width,
    input.height,
    pixels,
    "alpha-bounds",
  );
}

/** Exact native retained owner-opacity copy, rounding, and support pass. */
export function executeReferenceNativeRetainedAlphaScale(input: Readonly<{
  source: Uint8Array;
  output: Uint8Array;
  width: number;
  height: number;
  bounds: Readonly<{ left: number; top: number; right: number; bottom: number }>;
  opacity: number;
}>): ReferenceNativeAlphaSupportResult | undefined {
  const implementation = runtimeModule();
  if (!implementation) return undefined;
  const pixels = input.width * input.height;
  const boundsPixels = (input.bounds.right - input.bounds.left)
    * (input.bounds.bottom - input.bounds.top);
  if (!(input.source instanceof Uint8Array) || !(input.output instanceof Uint8Array)
    || typedArrayByteRangesOverlap(input.source, input.output)
    || !Number.isSafeInteger(input.width) || !Number.isSafeInteger(input.height)
    || input.width < 1 || input.height < 1
    || !Number.isSafeInteger(pixels) || pixels < 1
    || input.source.byteLength !== pixels * 4 || input.output.byteLength !== pixels * 4
    || !Number.isSafeInteger(boundsPixels) || boundsPixels < 0
    || ![input.bounds.left, input.bounds.top, input.bounds.right, input.bounds.bottom].every(Number.isSafeInteger)
    || input.bounds.left < 0 || input.bounds.top < 0
    || input.bounds.right < input.bounds.left || input.bounds.bottom < input.bounds.top
    || input.bounds.right > input.width || input.bounds.bottom > input.height
    || !Number.isFinite(input.opacity) || input.opacity <= 0 || input.opacity >= 1) {
    fail("native retained-alpha arguments are outside their exact typed boundary");
  }
  const support = nativeAlphaSupportResult(
    implementation.scaleRetainedAlpha(
      input.source,
      input.output,
      input.width,
      input.height,
      input.bounds.left,
      input.bounds.top,
      input.bounds.right,
      input.bounds.bottom,
      input.opacity,
    ),
    input.width,
    input.height,
    boundsPixels,
    "retained-alpha",
  );
  if (!support.empty && (support.left < input.bounds.left || support.top < input.bounds.top
    || support.right > input.bounds.right || support.bottom > input.bounds.bottom)) {
    fail("native retained-alpha support escapes its admitted source bounds");
  }
  return support;
}

/** Exact native pixel loop over CUT's authoritative precomputed Q16 axes. */
export function executeReferenceNativeScaleTranslationQ16(input: Readonly<{
  source: Uint8Array;
  output: Uint8Array;
  sourceWidth: number;
  sourceHeight: number;
  sourceXQ16: Float64Array;
  sourceYQ16: Float64Array;
  outputWidth: number;
  outputHeight: number;
}>): ReferenceNativeScaleTranslationResult | undefined {
  const implementation = runtimeModule();
  if (!implementation) return undefined;
  const sourcePixels = input.sourceWidth * input.sourceHeight;
  const outputPixels = input.outputWidth * input.outputHeight;
  if (!(input.source instanceof Uint8Array) || !(input.output instanceof Uint8Array)
    || !(input.sourceXQ16 instanceof Float64Array) || !(input.sourceYQ16 instanceof Float64Array)
    || typedArrayByteRangesOverlap(input.source, input.output)
    || ![input.sourceWidth, input.sourceHeight, input.outputWidth, input.outputHeight].every(Number.isSafeInteger)
    || input.sourceWidth < 1 || input.sourceHeight < 1 || input.outputWidth < 1 || input.outputHeight < 1
    || !Number.isSafeInteger(sourcePixels) || !Number.isSafeInteger(outputPixels)
    || input.source.byteLength !== sourcePixels * 4 || input.output.byteLength !== outputPixels * 4
    || input.sourceXQ16.length !== input.outputWidth || input.sourceYQ16.length !== input.outputHeight
    || input.sourceXQ16.some((value) => !Number.isSafeInteger(value))
    || input.sourceYQ16.some((value) => !Number.isSafeInteger(value))) {
    fail("native local-space Q16 raster arguments are outside their exact typed boundary");
  }
  const result = implementation.rasterLocalSpaceScaleTranslationQ16(
    input.source,
    input.output,
    input.sourceWidth,
    input.sourceHeight,
    input.sourceXQ16,
    input.sourceYQ16,
    input.outputWidth,
    input.outputHeight,
  );
  if (!result || typeof result !== "object" || Array.isArray(result)
    || Object.keys(result).sort().join(",") !== "bilinearSamplesEvaluated,integerSamplesCopied,sourceTapsRead") {
    fail("native local-space Q16 raster returned an invalid closed counter receipt");
  }
  const counters = result as Record<string, unknown>;
  const integerSamplesCopied = exactCount(counters.integerSamplesCopied, "local-space integer-sample count", outputPixels);
  const bilinearSamplesEvaluated = exactCount(counters.bilinearSamplesEvaluated, "local-space bilinear-sample count", outputPixels);
  if (integerSamplesCopied + bilinearSamplesEvaluated > outputPixels) {
    fail("native local-space Q16 raster sample counters exceed admitted destination work");
  }
  return Object.freeze({
    integerSamplesCopied,
    bilinearSamplesEvaluated,
    sourceTapsRead: exactCount(counters.sourceTapsRead, "local-space source-tap count", outputPixels * 4),
  });
}

export type ReferenceNativeRetainedTranslationResult = ReferenceNativeAlphaSupportResult & Readonly<{
  alphaBytesObserved: number;
  destinationPixelsVisited: number;
}>;

/** Exact native fractional retained translation over one trusted alpha bound. */
export function executeReferenceNativeRetainedTranslationQ16(input: Readonly<{
  source: Uint8Array;
  output: Uint8Array;
  sourceWidth: number;
  sourceHeight: number;
  canvasWidth: number;
  canvasHeight: number;
  integerX: number;
  integerY: number;
  phaseX: number;
  phaseY: number;
  bounds: Readonly<{ left: number; top: number; right: number; bottom: number }>;
}>): ReferenceNativeRetainedTranslationResult | undefined {
  const implementation = runtimeModule();
  if (!implementation) return undefined;
  const sourcePixels = input.sourceWidth * input.sourceHeight;
  const canvasPixels = input.canvasWidth * input.canvasHeight;
  if (!(input.source instanceof Uint8Array) || !(input.output instanceof Uint8Array)
    || typedArrayByteRangesOverlap(input.source, input.output)
    || ![input.sourceWidth, input.sourceHeight, input.canvasWidth, input.canvasHeight,
      input.integerX, input.integerY, input.phaseX, input.phaseY,
      input.bounds.left, input.bounds.top, input.bounds.right, input.bounds.bottom].every(Number.isSafeInteger)
    || input.sourceWidth < 1 || input.sourceHeight < 1 || input.canvasWidth < 1 || input.canvasHeight < 1
    || !Number.isSafeInteger(sourcePixels) || !Number.isSafeInteger(canvasPixels)
    || input.source.byteLength !== sourcePixels * 4 || input.output.byteLength !== canvasPixels * 4
    || (input.phaseX === 0 && input.phaseY === 0)
    || input.phaseX < 0 || input.phaseX >= 65_536 || input.phaseY < 0 || input.phaseY >= 65_536
    || input.bounds.left < 0 || input.bounds.top < 0
    || input.bounds.right < input.bounds.left || input.bounds.bottom < input.bounds.top
    || input.bounds.right > input.sourceWidth || input.bounds.bottom > input.sourceHeight) {
    fail("native retained-translation arguments are outside their exact typed boundary");
  }
  const result = implementation.translateRetainedSurfaceQ16(
    input.source,
    input.output,
    input.sourceWidth,
    input.sourceHeight,
    input.canvasWidth,
    input.canvasHeight,
    input.integerX,
    input.integerY,
    input.phaseX,
    input.phaseY,
    input.bounds.left,
    input.bounds.top,
    input.bounds.right,
    input.bounds.bottom,
  );
  const expectedKeys = "alphaBytesObserved,bottom,destinationPixelsVisited,empty,left,nonzeroAlphaPixels,right,top";
  if (!result || typeof result !== "object" || Array.isArray(result)
    || Object.keys(result).sort().join(",") !== expectedKeys) {
    fail("native retained-translation returned an invalid closed counter receipt");
  }
  const record = result as Record<string, unknown>;
  const support = nativeAlphaSupportResult(
    {
      empty: record.empty,
      left: record.left,
      top: record.top,
      right: record.right,
      bottom: record.bottom,
      nonzeroAlphaPixels: record.nonzeroAlphaPixels,
    },
    input.canvasWidth,
    input.canvasHeight,
    canvasPixels,
    "retained-translation",
  );
  return Object.freeze({
    ...support,
    alphaBytesObserved: exactCount(record.alphaBytesObserved, "retained-translation alpha-byte count", canvasPixels * 4),
    destinationPixelsVisited: exactCount(record.destinationPixelsVisited, "retained-translation destination-pixel count", canvasPixels),
  });
}

/** Exact private acceleration for the phase-specialized limiter envelope. */
export function executeReferenceNativeLimiterEnvelopeRange(input: Readonly<{
  decoded: Float32Array;
  output: Float64Array;
  coefficients: Float64Array;
  totalFrames: number;
  rangeStart: number;
  rangeEnd: number;
  readStart: number;
  oversampledStart: number;
  oversampledEnd: number;
  maximumAbsoluteInputSample: number;
  maximumEnvelopeLinear: number;
}>): ReferenceNativeLimiterEnvelopeResult | undefined {
  const implementation = runtimeModule();
  if (!implementation) return undefined;
  const frames = input.rangeEnd - input.rangeStart;
  const exactUint32 = (value: number) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff;
  if (!Number.isSafeInteger(frames) || frames < 1
    || !exactUint32(input.totalFrames) || input.totalFrames < 1
    || !exactUint32(input.rangeStart) || !exactUint32(input.rangeEnd)
    || !exactUint32(input.readStart)
    || !exactUint32(input.oversampledStart)
    || !exactUint32(input.oversampledEnd) || input.oversampledEnd < input.oversampledStart
    || !(input.decoded instanceof Float32Array)
    || !(input.output instanceof Float64Array) || input.output.length !== frames
    || !(input.coefficients instanceof Float64Array) || input.coefficients.length !== 48
    || typedArrayByteRangesOverlap(input.output, input.decoded)
    || typedArrayByteRangesOverlap(input.output, input.coefficients)
    || typedArrayByteRangesOverlap(input.decoded, input.coefficients)
    || !Number.isFinite(input.maximumAbsoluteInputSample) || input.maximumAbsoluteInputSample <= 0
    || !Number.isFinite(input.maximumEnvelopeLinear) || input.maximumEnvelopeLinear <= 0
    || input.coefficients.some((coefficient) => !Number.isFinite(coefficient))) {
    fail("native limiter-envelope arguments are outside their exact typed boundary");
  }
  const result = implementation.deriveLimiterEnvelopeRange(
    input.decoded,
    input.output,
    input.coefficients,
    input.totalFrames,
    input.rangeStart,
    input.rangeEnd,
    input.readStart,
    input.oversampledStart,
    input.oversampledEnd,
    input.maximumAbsoluteInputSample,
    input.maximumEnvelopeLinear,
  );
  if (!result || typeof result !== "object" || Array.isArray(result)
    || Object.keys(result).sort().join(",") !== "firBaseFrames,frames") {
    fail("native limiter-envelope returned an invalid closed counter receipt");
  }
  const counters = result as Record<string, unknown>;
  return Object.freeze({
    frames: exactCount(counters.frames, "limiter-envelope frame count", frames),
    firBaseFrames: exactCount(
      counters.firBaseFrames,
      "limiter-envelope FIR-base-frame count",
      Math.ceil((input.oversampledEnd - input.oversampledStart) / 4),
    ),
  });
}

export function referenceNativeSourceOverBackend(): ReferenceNativeSourceOverBackend {
  const common: ReferenceNativeSourceOverBackendCommon = {
    platform: process.platform,
    architecture: process.arch,
    algorithm: referenceNativeSourceOverIdentity.algorithm,
  };
  return runtimeModule()
    ? Object.freeze({
      mode: "native",
      ...common,
      binarySha256: referenceNativeSourceOverIdentity.binary.sha256,
    })
    : Object.freeze({
      mode: "javascript",
      ...common,
      implementation: referenceJavascriptSourceOverImplementation,
    });
}

export type ReferenceNativeRetainedMediaRasterResult = Readonly<{
  alphaTapReads: number;
  tapEvaluations: number;
  zeroWeightTaps: number;
  outputPixelsWritten: number;
  support: Readonly<{
    empty: boolean;
    left: number;
    top: number;
    right: number;
    bottom: number;
    nonzeroAlphaPixels: number;
  }>;
}>;

export function executeReferenceNativeRetainedMediaViewportRaster(input: Readonly<{
  source: Uint8Array;
  output: Uint8Array;
  sourceWidth: number;
  sourceHeight: number;
  outputWidth: number;
  outputHeight: number;
  bounds: Readonly<{ left: number; top: number; right: number; bottom: number }>;
  affine: Readonly<{ tx: number; ty: number }>;
  inverse: Readonly<{ a: number; b: number; c: number; d: number }>;
  opacity: number;
}>): ReferenceNativeRetainedMediaRasterResult | undefined {
  const implementation = runtimeModule();
  if (!implementation) return undefined;
  const destinationPixels = (input.bounds.right - input.bounds.left)
    * (input.bounds.bottom - input.bounds.top);
  if (!Number.isSafeInteger(destinationPixels) || destinationPixels < 0) {
    fail("native retained-raster work is not one safe exact pixel count");
  }
  const result = implementation.rasterRetainedMediaViewport(
    input.source,
    input.output,
    input.sourceWidth,
    input.sourceHeight,
    input.outputWidth,
    input.outputHeight,
    input.bounds.left,
    input.bounds.top,
    input.bounds.right,
    input.bounds.bottom,
    input.affine.tx,
    input.affine.ty,
    input.inverse.a,
    input.inverse.b,
    input.inverse.c,
    input.inverse.d,
    input.opacity,
  );
  const expectedKeys = "alphaTapReads,bottom,left,nonzeroAlphaPixels,outputPixelsWritten,right,tapEvaluations,top,zeroWeightTaps";
  if (!result || typeof result !== "object" || Array.isArray(result)
    || Object.keys(result).sort().join(",") !== expectedKeys) {
    fail("native retained-raster returned an invalid closed counter receipt");
  }
  const counters = result as Record<string, unknown>;
  const outputPixelsWritten = exactCount(
    counters.outputPixelsWritten,
    "retained-raster output-pixel count",
    destinationPixels,
  );
  const nonzeroAlphaPixels = exactCount(
    counters.nonzeroAlphaPixels,
    "retained-raster nonzero-alpha count",
    destinationPixels,
  );
  const support = Object.freeze({
    left: exactCount(counters.left, "retained-raster support left", input.outputWidth),
    top: exactCount(counters.top, "retained-raster support top", input.outputHeight),
    right: exactCount(counters.right, "retained-raster support right", input.outputWidth),
    bottom: exactCount(counters.bottom, "retained-raster support bottom", input.outputHeight),
  });
  const empty = nonzeroAlphaPixels === 0;
  if (outputPixelsWritten !== nonzeroAlphaPixels
    || support.left > support.right || support.top > support.bottom
    || empty !== (support.left === support.right || support.top === support.bottom)
    || (!empty && (support.left < input.bounds.left || support.top < input.bounds.top
      || support.right > input.bounds.right || support.bottom > input.bounds.bottom))) {
    fail("native retained-raster support counters are inconsistent");
  }
  return Object.freeze({
    alphaTapReads: exactCount(
      counters.alphaTapReads,
      "retained-raster alpha-tap-read count",
      destinationPixels * 4,
    ),
    tapEvaluations: exactCount(
      counters.tapEvaluations,
      "retained-raster tap-evaluation count",
      destinationPixels * 4,
    ),
    zeroWeightTaps: exactCount(
      counters.zeroWeightTaps,
      "retained-raster zero-weight-tap count",
      destinationPixels * 4,
    ),
    outputPixelsWritten,
    support: Object.freeze({
      empty,
      ...support,
      nonzeroAlphaPixels,
    }),
  });
}

function exactCount(value: unknown, label: string, maximum: number) {
  if (typeof value !== "bigint" || value < 0n || value > BigInt(maximum)) {
    fail(`native ${label} is outside its admitted exact bound`);
  }
  return Number(value);
}

export function executeReferenceNativeSourceOver(input: Readonly<{
  backdrop: Uint8Array;
  source: Uint8Array;
  width: number;
  bounds: Readonly<{ left: number; top: number; right: number; bottom: number }>;
  tables: ReferenceNativeSourceOverTables;
}>): ReferenceNativeSourceOverResult | undefined {
  const implementation = runtimeModule();
  if (!implementation) return undefined;
  const pixels = (input.bounds.right - input.bounds.left) * (input.bounds.bottom - input.bounds.top);
  if (!Number.isSafeInteger(pixels) || pixels < 0) fail("native source-over work is not one safe exact pixel count");
  const result = implementation.compositeNormalStraightInPlace(
    input.backdrop,
    input.source,
    input.width,
    input.bounds.left,
    input.bounds.top,
    input.bounds.right,
    input.bounds.bottom,
    input.tables.srgbToLinear,
    input.tables.thresholds,
    input.tables.bucketBase,
    input.tables.sourceOutside,
    input.tables.sourceInside,
    input.tables.backdropOutside,
    input.tables.outputAlpha,
  );
  if (!result || typeof result !== "object" || Array.isArray(result)
    || Object.keys(result).sort().join(",") !== "fallbackChannels,fastPixels,newlyCoveredPixels") {
    fail("native source-over returned an invalid closed counter receipt");
  }
  const counters = result as Record<string, unknown>;
  return Object.freeze({
    fastPixels: exactCount(counters.fastPixels, "fast-pixel count", pixels),
    fallbackChannels: exactCount(counters.fallbackChannels, "fallback-channel count", pixels * 3),
    newlyCoveredPixels: exactCount(counters.newlyCoveredPixels, "new-coverage count", pixels),
  });
}

/** Internal hostile-test boundary. Product execution always resolves the
 * adjacent compiled artifact through `executeReferenceNativeSourceOver`. */
export function verifyReferenceNativeSourceOverBinaryForTest(locator: string) {
  return stableBinary(locator);
}
