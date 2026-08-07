import { createHash } from "node:crypto";

/**
 * Geometry and accounting primitives for the future retained visual
 * compositor. This module is deliberately independent from the current
 * full-canvas renderer: importing it cannot change legacy render behavior.
 */

export const referenceRetainedVisualCacheSchema = "cut.reference.retained-visual.v1" as const;

export const referenceRetainedVisualLimits = Object.freeze({
  maximumAffineMagnitude: 1_000_000_000,
  maximumAbsoluteRasterCoordinate: 2_147_483_647,
  maximumRasterAxis: 16_384,
  maximumRasterPixels: 67_108_864,
  maximumRgbaBytes: 268_435_456,
  maximumPixelWork: 1_073_741_824,
  maximumPasses: 16_384,
  maximumCacheStringBytes: 4_096,
  maximumCacheDependencies: 1_024,
  maximumCacheIdentityBytes: 1_048_576,
  maximumStrokeWidthPx: 65_536,
  maximumMiterLimit: 1_024,
  maximumAntialiasGuardPx: 16,
});

export type ReferenceRetainedVisualErrorCode =
  | "CUT_RETAINED_VISUAL_SHAPE"
  | "CUT_RETAINED_VISUAL_VALUE_RANGE"
  | "CUT_RETAINED_VISUAL_SURFACE"
  | "CUT_RETAINED_VISUAL_RESOURCE_LIMIT"
  | "CUT_RETAINED_VISUAL_CACHE_IDENTITY"
  | "CUT_RETAINED_BOUNDS_UNDERRUN";

export class ReferenceRetainedVisualError extends Error {
  constructor(readonly code: ReferenceRetainedVisualErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "ReferenceRetainedVisualError";
  }
}

export type ReferenceRect = Readonly<{
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}>;

/** `x' = a*x + c*y + tx`; `y' = b*x + d*y + ty`. */
export type ReferenceAffine2D = Readonly<{
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
}>;

export type ReferenceIntegerRasterBounds = Readonly<{
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  pixels: number;
}>;

/** `originX/Y` locate raster sample (0, 0) in retained coordinates. */
export type ReferencePositionedSurface = Readonly<{
  data: Uint8Array;
  width: number;
  height: number;
  originX: number;
  originY: number;
  alphaMode: "straight";
}>;

export type ReferenceRetainedVisualWork = Readonly<{
  rasterPixels: number;
  rgbaBytes: number;
  pixelWork: number;
}>;

export type ReferenceRetainedCacheIdentity = Readonly<{
  serialized: string;
  sha256: string;
}>;

export type ReferenceStrokeLineCap = "butt" | "round" | "square";
export type ReferenceStrokeLineJoin = "miter" | "round" | "bevel";

const affineSnapEpsilon = 2 ** -48;
const utf8 = new TextEncoder();

function fail(code: ReferenceRetainedVisualErrorCode, detail: string): never {
  throw new ReferenceRetainedVisualError(code, detail);
}

function closedRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("CUT_RETAINED_VISUAL_SHAPE", `${label} must be a plain data object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("CUT_RETAINED_VISUAL_SHAPE", `${label} must have a plain or null prototype.`);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) {
    fail("CUT_RETAINED_VISUAL_SHAPE", `${label} cannot contain symbol keys.`);
  }
  const unknown = (ownKeys as string[]).find((key) => !keys.includes(key));
  if (unknown !== undefined) fail("CUT_RETAINED_VISUAL_SHAPE", `${label} does not accept property ${JSON.stringify(unknown)}.`);
  const missing = keys.find((key) => !ownKeys.includes(key));
  if (missing !== undefined) fail("CUT_RETAINED_VISUAL_SHAPE", `${label} requires property ${JSON.stringify(missing)}.`);
  if (ownKeys.length !== keys.length) fail("CUT_RETAINED_VISUAL_SHAPE", `${label} must contain exactly ${keys.join(", ")}.`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      fail("CUT_RETAINED_VISUAL_SHAPE", `${label} property ${JSON.stringify(key)} must be an enumerable data property.`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function finiteNumber(value: unknown, label: string, maximumMagnitude = Number.MAX_VALUE) {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > maximumMagnitude) {
    fail("CUT_RETAINED_VISUAL_VALUE_RANGE", `${label} must be finite and have magnitude at most ${maximumMagnitude}.`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function positiveSafeInteger(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    fail("CUT_RETAINED_VISUAL_VALUE_RANGE", `${label} must be a positive safe integer.`);
  }
  return value;
}

function canonicalAffineNumber(value: number, label: string) {
  const finite = finiteNumber(value, label, referenceRetainedVisualLimits.maximumAffineMagnitude);
  if (Math.abs(finite) <= affineSnapEpsilon) return 0;
  if (Math.abs(finite - 1) <= affineSnapEpsilon) return 1;
  if (Math.abs(finite + 1) <= affineSnapEpsilon) return -1;
  return finite;
}

function canonicalCoordinate(value: unknown, label: string) {
  return finiteNumber(value, label, referenceRetainedVisualLimits.maximumAbsoluteRasterCoordinate);
}

export function referenceRect(minX: number, minY: number, maxX: number, maxY: number): ReferenceRect {
  const values = [
    finiteNumber(minX, "retained rect minX"),
    finiteNumber(minY, "retained rect minY"),
    finiteNumber(maxX, "retained rect maxX"),
    finiteNumber(maxY, "retained rect maxY"),
  ] as const;
  if (values[2] < values[0] || values[3] < values[1]) {
    fail("CUT_RETAINED_VISUAL_VALUE_RANGE", "retained rect maximums must not be less than minimums.");
  }
  return Object.freeze({ minX: values[0], minY: values[1], maxX: values[2], maxY: values[3] });
}

export function canonicalReferenceRect(value: unknown, label = "retained rect"): ReferenceRect {
  const record = closedRecord(value, ["minX", "minY", "maxX", "maxY"], label);
  return referenceRect(
    finiteNumber(record.minX, `${label}.minX`),
    finiteNumber(record.minY, `${label}.minY`),
    finiteNumber(record.maxX, `${label}.maxX`),
    finiteNumber(record.maxY, `${label}.maxY`),
  );
}

export function unionReferenceRects(rects: readonly ReferenceRect[]): ReferenceRect {
  if (!Array.isArray(rects) || rects.length < 1) fail("CUT_RETAINED_VISUAL_SHAPE", "retained rect union requires at least one rect.");
  let result = canonicalReferenceRect(rects[0], "retained rect union[0]");
  for (let index = 1; index < rects.length; index += 1) {
    const rect = canonicalReferenceRect(rects[index], `retained rect union[${index}]`);
    result = referenceRect(
      Math.min(result.minX, rect.minX),
      Math.min(result.minY, rect.minY),
      Math.max(result.maxX, rect.maxX),
      Math.max(result.maxY, rect.maxY),
    );
  }
  return result;
}

export function expandReferenceRect(rectValue: ReferenceRect, amountValue: number): ReferenceRect {
  const rect = canonicalReferenceRect(rectValue), amount = finiteNumber(amountValue, "retained rect expansion");
  if (amount < 0) fail("CUT_RETAINED_VISUAL_VALUE_RANGE", "retained rect expansion must be non-negative.");
  return referenceRect(rect.minX - amount, rect.minY - amount, rect.maxX + amount, rect.maxY + amount);
}

export function intersectReferenceRects(leftValue: ReferenceRect, rightValue: ReferenceRect): ReferenceRect | undefined {
  const left = canonicalReferenceRect(leftValue, "retained rect intersection left");
  const right = canonicalReferenceRect(rightValue, "retained rect intersection right");
  const minX = Math.max(left.minX, right.minX), minY = Math.max(left.minY, right.minY);
  const maxX = Math.min(left.maxX, right.maxX), maxY = Math.min(left.maxY, right.maxY);
  return maxX <= minX || maxY <= minY ? undefined : referenceRect(minX, minY, maxX, maxY);
}

export function referenceAffine2D(value: unknown): ReferenceAffine2D {
  const record = closedRecord(value, ["a", "b", "c", "d", "tx", "ty"], "retained affine");
  return Object.freeze({
    a: canonicalAffineNumber(record.a as number, "retained affine.a"),
    b: canonicalAffineNumber(record.b as number, "retained affine.b"),
    c: canonicalAffineNumber(record.c as number, "retained affine.c"),
    d: canonicalAffineNumber(record.d as number, "retained affine.d"),
    tx: canonicalAffineNumber(record.tx as number, "retained affine.tx"),
    ty: canonicalAffineNumber(record.ty as number, "retained affine.ty"),
  });
}

export const referenceIdentityAffine2D: ReferenceAffine2D = Object.freeze({ a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 });

export function referenceTranslationAffine2D(tx: number, ty: number): ReferenceAffine2D {
  return referenceAffine2D({ a: 1, b: 0, c: 0, d: 1, tx, ty });
}

export function referenceScaleAffine2D(scaleX: number, scaleY = scaleX): ReferenceAffine2D {
  return referenceAffine2D({ a: scaleX, b: 0, c: 0, d: scaleY, tx: 0, ty: 0 });
}

/** Compose an outer transform with an inner transform: result(p)=outer(inner(p)). */
export function composeReferenceAffine2D(outerValue: ReferenceAffine2D, innerValue: ReferenceAffine2D): ReferenceAffine2D {
  const outer = referenceAffine2D(outerValue), inner = referenceAffine2D(innerValue);
  return referenceAffine2D({
    a: outer.a * inner.a + outer.c * inner.b,
    b: outer.b * inner.a + outer.d * inner.b,
    c: outer.a * inner.c + outer.c * inner.d,
    d: outer.b * inner.c + outer.d * inner.d,
    tx: outer.a * inner.tx + outer.c * inner.ty + outer.tx,
    ty: outer.b * inner.tx + outer.d * inner.ty + outer.ty,
  });
}

export function transformReferencePoint(affineValue: ReferenceAffine2D, xValue: number, yValue: number) {
  const affine = referenceAffine2D(affineValue);
  const x = finiteNumber(xValue, "retained point.x"), y = finiteNumber(yValue, "retained point.y");
  return Object.freeze({
    x: finiteNumber(affine.a * x + affine.c * y + affine.tx, "transformed retained point.x"),
    y: finiteNumber(affine.b * x + affine.d * y + affine.ty, "transformed retained point.y"),
  });
}

export function transformReferenceRect(rectValue: ReferenceRect, affineValue: ReferenceAffine2D): ReferenceRect {
  const rect = canonicalReferenceRect(rectValue), affine = referenceAffine2D(affineValue);
  const corners = [
    transformReferencePoint(affine, rect.minX, rect.minY),
    transformReferencePoint(affine, rect.maxX, rect.minY),
    transformReferencePoint(affine, rect.minX, rect.maxY),
    transformReferencePoint(affine, rect.maxX, rect.maxY),
  ];
  return referenceRect(
    Math.min(...corners.map((point) => point.x)),
    Math.min(...corners.map((point) => point.y)),
    Math.max(...corners.map((point) => point.x)),
    Math.max(...corners.map((point) => point.y)),
  );
}

/** Largest singular value of the affine's linear 2x2 matrix. */
export function referenceAffineOperatorNorm(affineValue: ReferenceAffine2D) {
  const affine = referenceAffine2D(affineValue);
  const sum = affine.a ** 2 + affine.b ** 2 + affine.c ** 2 + affine.d ** 2;
  const determinant = affine.a * affine.d - affine.b * affine.c;
  const discriminant = Math.max(0, sum ** 2 - 4 * determinant ** 2);
  return finiteNumber(Math.sqrt((sum + Math.sqrt(discriminant)) / 2), "retained affine operator norm");
}

function strokeStyle(value: unknown) {
  const record = closedRecord(value, ["width", "lineCap", "lineJoin", "miterLimit", "antialiasGuard"], "retained stroke style");
  const width = finiteNumber(record.width, "retained stroke width", referenceRetainedVisualLimits.maximumStrokeWidthPx);
  if (width <= 0) fail("CUT_RETAINED_VISUAL_VALUE_RANGE", "retained stroke width must be greater than zero.");
  const lineCap = record.lineCap;
  if (lineCap !== "butt" && lineCap !== "round" && lineCap !== "square") {
    fail("CUT_RETAINED_VISUAL_VALUE_RANGE", "retained stroke lineCap must be butt, round, or square.");
  }
  const lineJoin = record.lineJoin;
  if (lineJoin !== "miter" && lineJoin !== "round" && lineJoin !== "bevel") {
    fail("CUT_RETAINED_VISUAL_VALUE_RANGE", "retained stroke lineJoin must be miter, round, or bevel.");
  }
  const miterLimit = finiteNumber(record.miterLimit, "retained stroke miterLimit", referenceRetainedVisualLimits.maximumMiterLimit);
  if (miterLimit < 1) fail("CUT_RETAINED_VISUAL_VALUE_RANGE", "retained stroke miterLimit must be at least one.");
  const antialiasGuard = finiteNumber(record.antialiasGuard, "retained stroke antialiasGuard", referenceRetainedVisualLimits.maximumAntialiasGuardPx);
  if (antialiasGuard < 0) fail("CUT_RETAINED_VISUAL_VALUE_RANGE", "retained stroke antialiasGuard must be non-negative.");
  return { width, lineCap, lineJoin, miterLimit, antialiasGuard } as const;
}

export function referenceConservativeStrokeExpansion(
  affineValue: ReferenceAffine2D,
  styleValue: Readonly<{
    width: number;
    lineCap: ReferenceStrokeLineCap;
    lineJoin: ReferenceStrokeLineJoin;
    miterLimit: number;
    antialiasGuard: number;
  }>,
) {
  const affine = referenceAffine2D(affineValue), style = strokeStyle(styleValue);
  const capFactor = style.lineCap === "square" ? Math.SQRT2 : 1;
  const joinFactor = style.lineJoin === "miter" ? style.miterLimit : 1;
  return finiteNumber(
    style.width / 2 * Math.max(capFactor, joinFactor) * referenceAffineOperatorNorm(affine) + style.antialiasGuard,
    "retained stroke expansion",
  );
}

export function referenceConservativeStrokeBounds(
  centerlineBounds: ReferenceRect,
  affine: ReferenceAffine2D,
  style: Readonly<{
    width: number;
    lineCap: ReferenceStrokeLineCap;
    lineJoin: ReferenceStrokeLineJoin;
    miterLimit: number;
    antialiasGuard: number;
  }>,
) {
  const transformed = transformReferenceRect(centerlineBounds, affine);
  return expandReferenceRect(transformed, referenceConservativeStrokeExpansion(affine, style));
}

export function referenceIntegerRasterBounds(rectValue: ReferenceRect): ReferenceIntegerRasterBounds {
  const rect = canonicalReferenceRect(rectValue);
  const left = Math.floor(rect.minX), top = Math.floor(rect.minY), right = Math.ceil(rect.maxX), bottom = Math.ceil(rect.maxY);
  for (const [name, value] of Object.entries({ left, top, right, bottom })) {
    if (!Number.isSafeInteger(value) || Math.abs(value) > referenceRetainedVisualLimits.maximumAbsoluteRasterCoordinate) {
      fail("CUT_RETAINED_VISUAL_RESOURCE_LIMIT", `retained raster ${name} exceeds the safe coordinate envelope.`);
    }
  }
  const width = right - left, height = bottom - top;
  if (width < 1 || height < 1) fail("CUT_RETAINED_VISUAL_VALUE_RANGE", "retained raster bounds must cover at least one pixel on each axis.");
  if (width > referenceRetainedVisualLimits.maximumRasterAxis || height > referenceRetainedVisualLimits.maximumRasterAxis) {
    fail("CUT_RETAINED_VISUAL_RESOURCE_LIMIT", `retained raster exceeds the ${referenceRetainedVisualLimits.maximumRasterAxis}px per-axis limit.`);
  }
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > referenceRetainedVisualLimits.maximumRasterPixels) {
    fail("CUT_RETAINED_VISUAL_RESOURCE_LIMIT", `retained raster exceeds the ${referenceRetainedVisualLimits.maximumRasterPixels}-pixel limit.`);
  }
  return Object.freeze({ left, top, right, bottom, width, height, pixels });
}

function canonicalRasterBounds(value: unknown): ReferenceIntegerRasterBounds {
  const record = closedRecord(value, ["left", "top", "right", "bottom", "width", "height", "pixels"], "retained raster bounds");
  const names = ["left", "top", "right", "bottom", "width", "height", "pixels"] as const;
  for (const name of names) {
    if (typeof record[name] !== "number" || !Number.isSafeInteger(record[name])) {
      fail("CUT_RETAINED_VISUAL_SHAPE", `retained raster bounds.${name} must be a safe integer.`);
    }
  }
  const canonical = referenceIntegerRasterBounds(referenceRect(record.left as number, record.top as number, record.right as number, record.bottom as number));
  if (canonical.width !== record.width || canonical.height !== record.height || canonical.pixels !== record.pixels) {
    fail("CUT_RETAINED_VISUAL_SHAPE", "retained raster bounds derived dimensions are inconsistent.");
  }
  return canonical;
}

export function referencePositionedSurface(value: unknown): ReferencePositionedSurface {
  const record = closedRecord(value, ["data", "width", "height", "originX", "originY", "alphaMode"], "retained positioned surface");
  if (!(record.data instanceof Uint8Array)) fail("CUT_RETAINED_VISUAL_SURFACE", "retained positioned surface data must be a Uint8Array or Buffer.");
  const width = positiveSafeInteger(record.width, "retained positioned surface width");
  const height = positiveSafeInteger(record.height, "retained positioned surface height");
  if (width > referenceRetainedVisualLimits.maximumRasterAxis || height > referenceRetainedVisualLimits.maximumRasterAxis) {
    fail("CUT_RETAINED_VISUAL_RESOURCE_LIMIT", `retained positioned surface exceeds the ${referenceRetainedVisualLimits.maximumRasterAxis}px per-axis limit.`);
  }
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > referenceRetainedVisualLimits.maximumRasterPixels) {
    fail("CUT_RETAINED_VISUAL_RESOURCE_LIMIT", `retained positioned surface exceeds the ${referenceRetainedVisualLimits.maximumRasterPixels}-pixel limit.`);
  }
  if (record.data.byteLength !== pixels * 4) fail("CUT_RETAINED_VISUAL_SURFACE", "retained positioned surface byte length must equal width x height x 4.");
  if (record.alphaMode !== "straight") fail("CUT_RETAINED_VISUAL_SURFACE", "retained positioned surface alphaMode must be straight.");
  const originX = canonicalCoordinate(record.originX, "retained positioned surface originX");
  const originY = canonicalCoordinate(record.originY, "retained positioned surface originY");
  return Object.freeze({ data: record.data, width, height, originX, originY, alphaMode: "straight" });
}

export function referencePositionedSurfaceBounds(surfaceValue: ReferencePositionedSurface): ReferenceRect {
  const surface = referencePositionedSurface(surfaceValue);
  return referenceRect(surface.originX, surface.originY, surface.originX + surface.width, surface.originY + surface.height);
}

/** Fail closed if a supposedly padded retained tile has clipped visible alpha. */
export function assertReferenceRetainedBoundsCovered(surfaceValue: ReferencePositionedSurface) {
  const surface = referencePositionedSurface(surfaceValue);
  const visit = (x: number, y: number) => {
    const alpha = surface.data[(y * surface.width + x) * 4 + 3];
    if (alpha !== 0) {
      fail(
        "CUT_RETAINED_BOUNDS_UNDERRUN",
        `retained raster has nonzero edge alpha at local (${x}, ${y}), retained (${surface.originX + x}, ${surface.originY + y}); expand the declared bounds before rasterization.`,
      );
    }
  };
  for (let x = 0; x < surface.width; x += 1) {
    visit(x, 0);
    if (surface.height > 1) visit(x, surface.height - 1);
  }
  for (let y = 1; y + 1 < surface.height; y += 1) {
    visit(0, y);
    if (surface.width > 1) visit(surface.width - 1, y);
  }
}

export function referenceRetainedRasterWork(boundsValue: ReferenceIntegerRasterBounds, passesValue = 1): ReferenceRetainedVisualWork {
  const bounds = canonicalRasterBounds(boundsValue), passes = positiveSafeInteger(passesValue, "retained raster passes");
  if (passes > referenceRetainedVisualLimits.maximumPasses) {
    fail("CUT_RETAINED_VISUAL_RESOURCE_LIMIT", `retained raster passes exceed ${referenceRetainedVisualLimits.maximumPasses}.`);
  }
  const rgbaBytes = bounds.pixels * 4, pixelWork = bounds.pixels * passes;
  if (!Number.isSafeInteger(rgbaBytes) || rgbaBytes > referenceRetainedVisualLimits.maximumRgbaBytes
    || !Number.isSafeInteger(pixelWork) || pixelWork > referenceRetainedVisualLimits.maximumPixelWork) {
    fail("CUT_RETAINED_VISUAL_RESOURCE_LIMIT", "retained raster work exceeds the bounded byte or pixel-pass budget.");
  }
  return Object.freeze({ rasterPixels: bounds.pixels, rgbaBytes, pixelWork });
}

function canonicalWork(value: unknown, label: string): ReferenceRetainedVisualWork {
  const record = closedRecord(value, ["rasterPixels", "rgbaBytes", "pixelWork"], label);
  for (const name of ["rasterPixels", "rgbaBytes", "pixelWork"] as const) {
    if (typeof record[name] !== "number" || !Number.isSafeInteger(record[name]) || (record[name] as number) < 0) {
      fail("CUT_RETAINED_VISUAL_SHAPE", `${label}.${name} must be a non-negative safe integer.`);
    }
  }
  const rasterPixels = record.rasterPixels as number, rgbaBytes = record.rgbaBytes as number, pixelWork = record.pixelWork as number;
  if (rgbaBytes !== rasterPixels * 4 || (rasterPixels === 0 ? pixelWork !== 0 : pixelWork < rasterPixels)) {
    fail("CUT_RETAINED_VISUAL_SHAPE", `${label} carries inconsistent pixel, RGBA-byte, or pixel-pass accounting.`);
  }
  return Object.freeze({
    rasterPixels,
    rgbaBytes,
    pixelWork,
  });
}

export function combineReferenceRetainedWork(entries: readonly ReferenceRetainedVisualWork[]): ReferenceRetainedVisualWork {
  if (!Array.isArray(entries)) fail("CUT_RETAINED_VISUAL_SHAPE", "retained work entries must be an array.");
  let rasterPixels = 0, rgbaBytes = 0, pixelWork = 0;
  for (const [index, value] of entries.entries()) {
    const entry = canonicalWork(value, `retained work[${index}]`);
    rasterPixels += entry.rasterPixels;
    rgbaBytes += entry.rgbaBytes;
    pixelWork += entry.pixelWork;
    if (!Number.isSafeInteger(rasterPixels) || rasterPixels > referenceRetainedVisualLimits.maximumRasterPixels
      || !Number.isSafeInteger(rgbaBytes) || rgbaBytes > referenceRetainedVisualLimits.maximumRgbaBytes
      || !Number.isSafeInteger(pixelWork) || pixelWork > referenceRetainedVisualLimits.maximumPixelWork) {
      fail("CUT_RETAINED_VISUAL_RESOURCE_LIMIT", "aggregate retained raster work exceeds the bounded pixel, byte, or pixel-pass budget.");
    }
  }
  return Object.freeze({ rasterPixels, rgbaBytes, pixelWork });
}

function boundedCacheString(value: unknown, label: string) {
  if (typeof value !== "string" || value.length === 0) fail("CUT_RETAINED_VISUAL_CACHE_IDENTITY", `${label} must be a non-empty string.`);
  if (utf8.encode(value).byteLength > referenceRetainedVisualLimits.maximumCacheStringBytes) {
    fail("CUT_RETAINED_VISUAL_CACHE_IDENTITY", `${label} exceeds the ${referenceRetainedVisualLimits.maximumCacheStringBytes}-byte limit.`);
  }
  return value;
}

function canonicalDependencies(value: unknown) {
  if (!Array.isArray(value)) fail("CUT_RETAINED_VISUAL_CACHE_IDENTITY", "retained cache dependencies must be an array.");
  if (value.length > referenceRetainedVisualLimits.maximumCacheDependencies) {
    fail("CUT_RETAINED_VISUAL_CACHE_IDENTITY", `retained cache dependencies exceed ${referenceRetainedVisualLimits.maximumCacheDependencies} entries.`);
  }
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) fail("CUT_RETAINED_VISUAL_CACHE_IDENTITY", "retained cache dependencies cannot contain holes.");
    result.push(boundedCacheString(value[index], `retained cache dependency[${index}]`));
  }
  result.sort();
  if (result.some((item, index) => index > 0 && item === result[index - 1])) {
    fail("CUT_RETAINED_VISUAL_CACHE_IDENTITY", "retained cache dependencies must be unique.");
  }
  return Object.freeze(result);
}

/** Fixed-order, closed serialization for future retained raster cache keys. */
export function referenceRetainedCacheIdentity(value: unknown): ReferenceRetainedCacheIdentity {
  const record = closedRecord(
    value,
    ["algorithmVersion", "backendIdentity", "semanticIdentity", "timeIdentity", "affine", "rasterBounds", "dependencies"],
    "retained cache identity",
  );
  const affine = referenceAffine2D(record.affine), bounds = canonicalRasterBounds(record.rasterBounds);
  const payload = [
    referenceRetainedVisualCacheSchema,
    boundedCacheString(record.algorithmVersion, "retained cache algorithmVersion"),
    boundedCacheString(record.backendIdentity, "retained cache backendIdentity"),
    boundedCacheString(record.semanticIdentity, "retained cache semanticIdentity"),
    boundedCacheString(record.timeIdentity, "retained cache timeIdentity"),
    [affine.a, affine.b, affine.c, affine.d, affine.tx, affine.ty],
    [bounds.left, bounds.top, bounds.right, bounds.bottom, bounds.width, bounds.height, bounds.pixels],
    canonicalDependencies(record.dependencies),
  ] as const;
  const serialized = JSON.stringify(payload);
  if (utf8.encode(serialized).byteLength > referenceRetainedVisualLimits.maximumCacheIdentityBytes) {
    fail("CUT_RETAINED_VISUAL_CACHE_IDENTITY", `retained cache identity exceeds ${referenceRetainedVisualLimits.maximumCacheIdentityBytes} bytes.`);
  }
  return Object.freeze({ serialized, sha256: createHash("sha256").update(serialized).digest("hex") });
}
