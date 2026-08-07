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
  rasterRetainedMediaViewport: (...arguments_: readonly unknown[]) => unknown;
}>;

let loaded: NativeModule | undefined;

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
    || Object.keys(candidate).sort().join(",") !== "compositeNormalStraightInPlace,rasterRetainedMediaViewport"
    || typeof candidate.compositeNormalStraightInPlace !== "function"
    || typeof candidate.rasterRetainedMediaViewport !== "function") {
    fail("the authenticated native source-over module has an invalid closed export surface");
  }
  loaded = Object.freeze({
    compositeNormalStraightInPlace: candidate.compositeNormalStraightInPlace,
    rasterRetainedMediaViewport: candidate.rasterRetainedMediaViewport,
  });
  return loaded;
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
