import { hash } from "../../core/stable";

/**
 * Isolated reference math/raster kernel. This is not a public CUT node or a
 * language capability. A future owner must wrap these source-independent
 * diagnostics at the public IR boundary.
 */
export const referenceProjectiveWarpAlgorithmVersion = "cut-reference-projective-warp-q16-v1";
export const referenceProjectiveWarpPhaseUnits = 65_536;

export const referenceProjectiveWarpLimits = Object.freeze({
  maximumAbsoluteDestinationCoordinate: 131_072,
  maximumSourceAxis: 32_768,
  maximumSourcePixels: 67_108_864,
  maximumSourceRgbaBytes: 268_435_456,
  maximumDestinationAxis: 16_384,
  maximumDestinationPixels: 16_777_216,
  maximumDestinationRgbaBytes: 67_108_864,
  maximumBilinearSampleWork: 67_108_864,
  /** Q16-exact near-degenerate refusal: shorter edges and smaller areas are
   * unstable tracking surfaces rather than useful professional planes. */
  minimumQuadEdgePixels: 1 / 256,
  minimumQuadAreaPixelsSquared: 1 / 256,
  minimumCornerSine: 1 / 4_096,
  /** The projective homogeneous denominator may vary, but a plane whose
   * nearest corner is below this fraction of its farthest corner is refused as
   * horizon-adjacent before raster work. */
  minimumHomogeneousDenominatorRatio: 1 / 4_096,
  maximumExactCoefficientBits: 512,
  maximumExactEvaluationBits: 768,
});

export type ReferenceProjectiveWarpDiagnosticCode =
  | "CUT_PROJECTIVE_WARP_INPUT"
  | "CUT_PROJECTIVE_WARP_SURFACE"
  | "CUT_PROJECTIVE_WARP_COORDINATE"
  | "CUT_PROJECTIVE_WARP_BOUNDS"
  | "CUT_PROJECTIVE_WARP_QUAD_ORDER"
  | "CUT_PROJECTIVE_WARP_QUAD_DEGENERATE"
  | "CUT_PROJECTIVE_WARP_QUAD_NON_CONVEX"
  | "CUT_PROJECTIVE_WARP_HOMOGRAPHY_SINGULAR"
  | "CUT_PROJECTIVE_WARP_WORK_LIMIT"
  | "CUT_PROJECTIVE_WARP_PLAN";

export class ReferenceProjectiveWarpError extends Error {
  constructor(readonly code: ReferenceProjectiveWarpDiagnosticCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "ReferenceProjectiveWarpError";
  }
}

function fail(code: ReferenceProjectiveWarpDiagnosticCode, message: string): never {
  throw new ReferenceProjectiveWarpError(code, message);
}

export type ReferenceProjectivePoint = Readonly<{ x: number; y: number }>;
export type ReferenceProjectiveQuad = readonly [
  topLeft: ReferenceProjectivePoint,
  topRight: ReferenceProjectivePoint,
  bottomRight: ReferenceProjectivePoint,
  bottomLeft: ReferenceProjectivePoint,
];

/** Integer pixel bounds in the same coordinate system as the quad. right and
 * bottom are exclusive. The returned raster carries left/top as its origin. */
export type ReferenceProjectiveRasterBounds = Readonly<{
  left: number;
  top: number;
  right: number;
  bottom: number;
}>;

type Q16Point = Readonly<{ x: bigint; y: bigint }>;

export type ReferenceProjectiveWarpPlan = Readonly<{
  algorithmVersion: typeof referenceProjectiveWarpAlgorithmVersion;
  phaseUnits: typeof referenceProjectiveWarpPhaseUnits;
  source: Readonly<{ width: number; height: number; pixels: number; rgbaBytes: number }>;
  destination: Readonly<{
    /** Quantized screen-space corners in source TL,TR,BR,BL correspondence. */
    quadQ16: readonly [
      Readonly<{ x: string; y: string }>,
      Readonly<{ x: string; y: string }>,
      Readonly<{ x: string; y: string }>,
      Readonly<{ x: string; y: string }>,
    ];
    bounds: ReferenceProjectiveRasterBounds;
    width: number;
    height: number;
    pixels: number;
    rgbaBytes: number;
  }>;
  /** Row-major exact homogeneous matrices. The forward matrix maps normalized
   * source outer-edge coordinates [0,1]^2 to destination Q16 coordinates. */
  homography: Readonly<{
    forward: readonly string[];
    inverseAdjugate: readonly string[];
    determinant: string;
  }>;
  work: Readonly<{
    maximumDestinationPixelTests: number;
    maximumBilinearSampleVisits: number;
    maximumForwardCoefficientBits: number;
    maximumInverseCoefficientBits: number;
    determinantBits: number;
    maximumEvaluationBits: number;
  }>;
  identityTransform: boolean;
  planIdentity: string;
}>;

export type ReferenceStraightRgbaWarpSurface = Readonly<{
  data: Uint8Array;
  width: number;
  height: number;
  alphaMode?: "straight";
}>;

export type ReferenceProjectiveWarpResult = Readonly<{
  surface: Readonly<{
    data: Uint8Array;
    width: number;
    height: number;
    originX: number;
    originY: number;
    alphaMode: "straight";
  }>;
  observedWork: Readonly<{
    destinationPixelsTested: number;
    insideQuadPixels: number;
    integerSamplesCopied: number;
    bilinearSamplesEvaluated: number;
    sourceTapsRead: number;
  }>;
}>;

export type ReferenceProjectiveWarpExecutionOptions = Readonly<{
  /** @internal Allocation seam used to prove all validation precedes output allocation. */
  allocateOutput?: (bytes: number) => Uint8Array;
  /** @internal Exact scalar parity seam for the authenticated Q16 native raster. */
  disableNativeScaleTranslation?: boolean;
}>;

const q16 = BigInt(referenceProjectiveWarpPhaseUnits);
const q16Half = q16 / 2n;

function exactProduct(values: readonly number[], label: string) {
  let product = 1;
  for (const value of values) {
    product *= value;
    if (!Number.isSafeInteger(product)) fail("CUT_PROJECTIVE_WARP_WORK_LIMIT", `${label} exceeds safe integer accounting.`);
  }
  return product;
}

function validateSourceDimensions(width: number, height: number) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    fail("CUT_PROJECTIVE_WARP_INPUT", "source width and height must be positive safe integers.");
  }
  if (width > referenceProjectiveWarpLimits.maximumSourceAxis || height > referenceProjectiveWarpLimits.maximumSourceAxis) {
    fail("CUT_PROJECTIVE_WARP_WORK_LIMIT", `source axes may not exceed ${referenceProjectiveWarpLimits.maximumSourceAxis}px.`);
  }
  const pixels = exactProduct([width, height], "source pixel work");
  const rgbaBytes = exactProduct([pixels, 4], "source RGBA bytes");
  if (pixels > referenceProjectiveWarpLimits.maximumSourcePixels || rgbaBytes > referenceProjectiveWarpLimits.maximumSourceRgbaBytes) {
    fail("CUT_PROJECTIVE_WARP_WORK_LIMIT", `source exceeds ${referenceProjectiveWarpLimits.maximumSourcePixels} pixels / ${referenceProjectiveWarpLimits.maximumSourceRgbaBytes} RGBA bytes.`);
  }
  return { pixels, rgbaBytes };
}

function validateBounds(bounds: ReferenceProjectiveRasterBounds) {
  if (!bounds || typeof bounds !== "object") fail("CUT_PROJECTIVE_WARP_BOUNDS", "destination bounds are required.");
  const entries = [bounds.left, bounds.top, bounds.right, bounds.bottom];
  if (!entries.every(Number.isSafeInteger)) {
    fail("CUT_PROJECTIVE_WARP_BOUNDS", "destination bounds must contain safe integer pixel coordinates.");
  }
  if (entries.some((value) => Math.abs(value) > referenceProjectiveWarpLimits.maximumAbsoluteDestinationCoordinate)) {
    fail("CUT_PROJECTIVE_WARP_BOUNDS", `destination bounds must remain within +/-${referenceProjectiveWarpLimits.maximumAbsoluteDestinationCoordinate}px.`);
  }
  if (bounds.right <= bounds.left || bounds.bottom <= bounds.top) {
    fail("CUT_PROJECTIVE_WARP_BOUNDS", "destination bounds must have positive right-exclusive width and bottom-exclusive height.");
  }
  const width = bounds.right - bounds.left, height = bounds.bottom - bounds.top;
  if (width > referenceProjectiveWarpLimits.maximumDestinationAxis || height > referenceProjectiveWarpLimits.maximumDestinationAxis) {
    fail("CUT_PROJECTIVE_WARP_WORK_LIMIT", `destination axes may not exceed ${referenceProjectiveWarpLimits.maximumDestinationAxis}px.`);
  }
  const pixels = exactProduct([width, height], "destination pixel work");
  const rgbaBytes = exactProduct([pixels, 4], "destination RGBA bytes");
  const samples = exactProduct([pixels, 4], "bilinear sample work");
  if (
    pixels > referenceProjectiveWarpLimits.maximumDestinationPixels
    || rgbaBytes > referenceProjectiveWarpLimits.maximumDestinationRgbaBytes
    || samples > referenceProjectiveWarpLimits.maximumBilinearSampleWork
  ) {
    fail(
      "CUT_PROJECTIVE_WARP_WORK_LIMIT",
      `destination exceeds ${referenceProjectiveWarpLimits.maximumDestinationPixels} pixels / ${referenceProjectiveWarpLimits.maximumDestinationRgbaBytes} RGBA bytes / ${referenceProjectiveWarpLimits.maximumBilinearSampleWork} bilinear sample visits.`,
    );
  }
  return { width, height, pixels, rgbaBytes, samples };
}

function quantizeCoordinate(value: number, label: string) {
  if (!Number.isFinite(value)) fail("CUT_PROJECTIVE_WARP_COORDINATE", `${label} must be finite.`);
  if (Math.abs(value) > referenceProjectiveWarpLimits.maximumAbsoluteDestinationCoordinate) {
    fail("CUT_PROJECTIVE_WARP_COORDINATE", `${label} must remain within +/-${referenceProjectiveWarpLimits.maximumAbsoluteDestinationCoordinate}px.`);
  }
  const scaled = value * referenceProjectiveWarpPhaseUnits;
  if (!Number.isSafeInteger(Math.round(scaled))) {
    fail("CUT_PROJECTIVE_WARP_COORDINATE", `${label} cannot be represented as a safe Q16 coordinate.`);
  }
  return BigInt(Math.round(scaled));
}

function subtract(a: Q16Point, b: Q16Point): Q16Point {
  return { x: a.x - b.x, y: a.y - b.y };
}

function crossVectors(a: Q16Point, b: Q16Point) {
  return a.x * b.y - a.y * b.x;
}

function orient(a: Q16Point, b: Q16Point, c: Q16Point) {
  return crossVectors(subtract(b, a), subtract(c, a));
}

function pointsEqual(a: Q16Point, b: Q16Point) {
  return a.x === b.x && a.y === b.y;
}

function properSegmentsIntersect(a: Q16Point, b: Q16Point, c: Q16Point, d: Q16Point) {
  const abC = orient(a, b, c), abD = orient(a, b, d), cdA = orient(c, d, a), cdB = orient(c, d, b);
  return ((abC < 0n && abD > 0n) || (abC > 0n && abD < 0n))
    && ((cdA < 0n && cdB > 0n) || (cdA > 0n && cdB < 0n));
}

function validateQuantizedQuad(points: [Q16Point, Q16Point, Q16Point, Q16Point]) {
  for (let first = 0; first < points.length; first += 1) {
    for (let second = first + 1; second < points.length; second += 1) {
      if (pointsEqual(points[first]!, points[second]!)) {
        fail("CUT_PROJECTIVE_WARP_QUAD_DEGENERATE", `quad points ${first} and ${second} collapse to the same exact Q16 coordinate.`);
      }
    }
  }

  const minimumEdgeQ16 = BigInt(Math.round(referenceProjectiveWarpLimits.minimumQuadEdgePixels * referenceProjectiveWarpPhaseUnits));
  const minimumEdgeSquared = minimumEdgeQ16 * minimumEdgeQ16;
  const edgeLengthsSquared: bigint[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const edge = subtract(points[(index + 1) % 4]!, points[index]!);
    const lengthSquared = edge.x * edge.x + edge.y * edge.y;
    edgeLengthsSquared.push(lengthSquared);
    if (lengthSquared < minimumEdgeSquared) {
      fail("CUT_PROJECTIVE_WARP_QUAD_DEGENERATE", `destination quad edge ${index} is shorter than the exact ${referenceProjectiveWarpLimits.minimumQuadEdgePixels}px near-degeneracy floor.`);
    }
  }

  const turns = points.map((point, index) => orient(point, points[(index + 1) % 4]!, points[(index + 2) % 4]!));
  if (turns.some((turn) => turn === 0n)) {
    fail("CUT_PROJECTIVE_WARP_QUAD_DEGENERATE", "destination quad contains an exact Q16 collinear corner or zero-area edge turn.");
  }
  if (properSegmentsIntersect(points[0], points[1], points[2], points[3]) || properSegmentsIntersect(points[1], points[2], points[3], points[0])) {
    fail("CUT_PROJECTIVE_WARP_QUAD_ORDER", "destination quad edges self-intersect; provide source TL,TR,BR,BL in clockwise screen-space perimeter order.");
  }
  const positive = turns.every((turn) => turn > 0n), negative = turns.every((turn) => turn < 0n);
  if (negative) {
    fail("CUT_PROJECTIVE_WARP_QUAD_ORDER", "destination quad uses reverse winding; provide source TL,TR,BR,BL in clockwise screen-space order.");
  }
  if (!positive) {
    fail("CUT_PROJECTIVE_WARP_QUAD_NON_CONVEX", "destination quad must be strictly convex after exact Q16 quantization.");
  }
  const twiceArea = points.reduce((sum, point, index) => {
    const next = points[(index + 1) % 4]!;
    return sum + point.x * next.y - point.y * next.x;
  }, 0n);
  if (twiceArea === 0n) fail("CUT_PROJECTIVE_WARP_QUAD_DEGENERATE", "destination quad has zero exact Q16 area.");
  if (twiceArea < 0n) fail("CUT_PROJECTIVE_WARP_QUAD_ORDER", "destination quad has reverse screen-space winding.");
  const minimumTwiceAreaQ32 = q16 * q16 * 2n / BigInt(Math.round(1 / referenceProjectiveWarpLimits.minimumQuadAreaPixelsSquared));
  if (twiceArea < minimumTwiceAreaQ32) {
    fail("CUT_PROJECTIVE_WARP_QUAD_DEGENERATE", `destination quad area is below the exact ${referenceProjectiveWarpLimits.minimumQuadAreaPixelsSquared}px^2 near-degeneracy floor.`);
  }
  const cornerRatioDenominator = BigInt(Math.round(1 / referenceProjectiveWarpLimits.minimumCornerSine));
  for (let index = 0; index < turns.length; index += 1) {
    if (turns[index]! ** 2n * cornerRatioDenominator ** 2n < edgeLengthsSquared[index]! * edgeLengthsSquared[(index + 1) % 4]!) {
      fail(
        "CUT_PROJECTIVE_WARP_QUAD_DEGENERATE",
        `destination quad corner ${index + 1} has an exact turn sine below ${referenceProjectiveWarpLimits.minimumCornerSine}; near-collinear planes are refused.`,
      );
    }
  }
  return Object.freeze(points);
}

function quantizeAndValidateQuad(quad: ReferenceProjectiveQuad): readonly [Q16Point, Q16Point, Q16Point, Q16Point] {
  if (!Array.isArray(quad) || quad.length !== 4) {
    fail("CUT_PROJECTIVE_WARP_INPUT", "destination quad must contain exactly four TL,TR,BR,BL points.");
  }
  const points = quad.map((point, index) => {
    if (!point || typeof point !== "object") fail("CUT_PROJECTIVE_WARP_COORDINATE", `quad point ${index} must contain x/y coordinates.`);
    return Object.freeze({
      x: quantizeCoordinate(point.x, `quad[${index}].x`),
      y: quantizeCoordinate(point.y, `quad[${index}].y`),
    });
  }) as [Q16Point, Q16Point, Q16Point, Q16Point];
  return validateQuantizedQuad(points);
}

function absolute(value: bigint) {
  return value < 0n ? -value : value;
}

function greatestCommonDivisor(a: bigint, b: bigint): bigint {
  let left = absolute(a), right = absolute(b);
  while (right !== 0n) {
    const remainder = left % right;
    left = right;
    right = remainder;
  }
  return left;
}

function canonicalMatrix(matrix: readonly bigint[]) {
  let divisor = 0n;
  for (const value of matrix) divisor = greatestCommonDivisor(divisor, value);
  if (divisor === 0n) fail("CUT_PROJECTIVE_WARP_HOMOGRAPHY_SINGULAR", "homography has no nonzero exact coefficient.");
  const divided = matrix.map((value) => value / divisor);
  const lastNonzero = [...divided].reverse().find((value) => value !== 0n)!;
  return Object.freeze(lastNonzero < 0n ? divided.map((value) => -value) : divided);
}

function determinant3(matrix: readonly bigint[]) {
  const [a, b, c, d, e, f, g, h, i] = matrix as readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
  return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
}

function adjugate3(matrix: readonly bigint[]) {
  const [a, b, c, d, e, f, g, h, i] = matrix as readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
  return Object.freeze([
    e * i - f * h, c * h - b * i, b * f - c * e,
    f * g - d * i, a * i - c * g, c * d - a * f,
    d * h - e * g, b * g - a * h, a * e - b * d,
  ]);
}

function bitLength(value: bigint) {
  const magnitude = absolute(value);
  return magnitude === 0n ? 0 : magnitude.toString(2).length;
}

function maximumBits(values: readonly bigint[]) {
  return values.reduce((maximum, value) => Math.max(maximum, bitLength(value)), 0);
}

function assertExactArithmeticBounds(forward: readonly bigint[], inverse: readonly bigint[], determinant: bigint, evaluationBits: number) {
  const forwardBits = maximumBits(forward), inverseBits = maximumBits(inverse), determinantBits = bitLength(determinant);
  if (
    forwardBits > referenceProjectiveWarpLimits.maximumExactCoefficientBits
    || inverseBits > referenceProjectiveWarpLimits.maximumExactCoefficientBits
    || determinantBits > referenceProjectiveWarpLimits.maximumExactCoefficientBits
    || evaluationBits > referenceProjectiveWarpLimits.maximumExactEvaluationBits
  ) {
    fail(
      "CUT_PROJECTIVE_WARP_WORK_LIMIT",
      `exact coefficient/denominator arithmetic exceeds ${referenceProjectiveWarpLimits.maximumExactCoefficientBits}-bit coefficients or ${referenceProjectiveWarpLimits.maximumExactEvaluationBits}-bit sample evaluation.`,
    );
  }
  return { forwardBits, inverseBits, determinantBits };
}

function exactHomography(points: readonly [Q16Point, Q16Point, Q16Point, Q16Point]) {
  const [p0, p1, p2, p3] = points;
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y, dy2 = p3.y - p2.y, dy3 = p0.y - p1.y + p2.y - p3.y;
  const denominator = dx1 * dy2 - dx2 * dy1;
  if (denominator === 0n) fail("CUT_PROJECTIVE_WARP_HOMOGRAPHY_SINGULAR", "four-corner solve has an exact zero denominator.");
  const projectiveX = dx3 * dy2 - dx2 * dy3;
  const projectiveY = dx1 * dy3 - dx3 * dy1;
  const forward = canonicalMatrix([
    (p1.x - p0.x) * denominator + projectiveX * p1.x,
    (p3.x - p0.x) * denominator + projectiveY * p3.x,
    p0.x * denominator,
    (p1.y - p0.y) * denominator + projectiveX * p1.y,
    (p3.y - p0.y) * denominator + projectiveY * p3.y,
    p0.y * denominator,
    projectiveX,
    projectiveY,
    denominator,
  ]);
  const determinant = determinant3(forward);
  if (determinant === 0n) fail("CUT_PROJECTIVE_WARP_HOMOGRAPHY_SINGULAR", "exact Q16 homography determinant is zero.");
  const inverse = adjugate3(forward);

  const forwardDenominators = [forward[8]!, forward[6]! + forward[8]!, forward[6]! + forward[7]! + forward[8]!, forward[7]! + forward[8]!];
  const signs = forwardDenominators.map((value) => value < 0n ? -1 : value > 0n ? 1 : 0);
  if (signs.includes(0) || !signs.every((value) => value === signs[0])) {
    fail("CUT_PROJECTIVE_WARP_HOMOGRAPHY_SINGULAR", "exact homography horizon touches or crosses the normalized source square.");
  }
  const denominatorMagnitudes = forwardDenominators.map(absolute);
  const minimumDenominator = denominatorMagnitudes.reduce((minimum, value) => value < minimum ? value : minimum);
  const maximumDenominator = denominatorMagnitudes.reduce((maximum, value) => value > maximum ? value : maximum);
  const horizonRatioDenominator = BigInt(Math.round(1 / referenceProjectiveWarpLimits.minimumHomogeneousDenominatorRatio));
  if (minimumDenominator * horizonRatioDenominator < maximumDenominator) {
    fail(
      "CUT_PROJECTIVE_WARP_HOMOGRAPHY_SINGULAR",
      `exact homography approaches its horizon beyond the ${referenceProjectiveWarpLimits.minimumHomogeneousDenominatorRatio} minimum corner-denominator ratio.`,
    );
  }
  return { forward, inverse, determinant };
}

function evaluationBitBound(inverse: readonly bigint[], bounds: ReferenceProjectiveRasterBounds) {
  const xs = [BigInt(bounds.left) * q16 + q16Half, BigInt(bounds.right - 1) * q16 + q16Half];
  const ys = [BigInt(bounds.top) * q16 + q16Half, BigInt(bounds.bottom - 1) * q16 + q16Half];
  let bits = 0;
  for (let row = 0; row < 3; row += 1) {
    for (const x of xs) for (const y of ys) {
      bits = Math.max(bits, bitLength(inverse[row * 3]! * x + inverse[row * 3 + 1]! * y + inverse[row * 3 + 2]!));
    }
  }
  return bits;
}

function stablePlanIdentity(value: unknown) {
  return hash(value);
}

function q16Json(points: readonly [Q16Point, Q16Point, Q16Point, Q16Point]) {
  return points.map((point) => Object.freeze({ x: String(point.x), y: String(point.y) })) as [
    Readonly<{ x: string; y: string }>,
    Readonly<{ x: string; y: string }>,
    Readonly<{ x: string; y: string }>,
    Readonly<{ x: string; y: string }>,
  ];
}

function identityQuad(points: readonly [Q16Point, Q16Point, Q16Point, Q16Point], width: number, height: number) {
  const right = BigInt(width) * q16, bottom = BigInt(height) * q16;
  const expected: readonly Q16Point[] = [{ x: 0n, y: 0n }, { x: right, y: 0n }, { x: right, y: bottom }, { x: 0n, y: bottom }];
  return points.every((point, index) => pointsEqual(point, expected[index]!));
}

/** Plan one exact four-corner transform. Quad coordinates describe pixel outer
 * edges in source TL,TR,BR,BL correspondence and must use clockwise screen
 * winding. The explicit bounds are a clip/allocation tile; changing only those
 * bounds never changes the solved homography. */
export function planReferenceProjectiveWarp(input: Readonly<{
  sourceWidth: number;
  sourceHeight: number;
  destinationQuad: ReferenceProjectiveQuad;
  destinationBounds: ReferenceProjectiveRasterBounds;
}>): ReferenceProjectiveWarpPlan {
  if (!input || typeof input !== "object") fail("CUT_PROJECTIVE_WARP_INPUT", "projective warp planning input is required.");
  const source = validateSourceDimensions(input.sourceWidth, input.sourceHeight);
  const destination = validateBounds(input.destinationBounds);
  const points = quantizeAndValidateQuad(input.destinationQuad);
  const { forward, inverse, determinant } = exactHomography(points);
  const evaluationBits = evaluationBitBound(inverse, input.destinationBounds);
  const arithmetic = assertExactArithmeticBounds(forward, inverse, determinant, evaluationBits);
  const quadQ16 = q16Json(points);
  const identityValue: Omit<ReferenceProjectiveWarpPlan, "planIdentity"> = {
    algorithmVersion: referenceProjectiveWarpAlgorithmVersion,
    phaseUnits: referenceProjectiveWarpPhaseUnits,
    source: { width: input.sourceWidth, height: input.sourceHeight, pixels: source.pixels, rgbaBytes: source.rgbaBytes },
    destination: {
      quadQ16,
      bounds: { ...input.destinationBounds },
      width: destination.width,
      height: destination.height,
      pixels: destination.pixels,
      rgbaBytes: destination.rgbaBytes,
    },
    homography: {
      forward: forward.map(String),
      inverseAdjugate: inverse.map(String),
      determinant: String(determinant),
    },
    work: {
      maximumDestinationPixelTests: destination.pixels,
      maximumBilinearSampleVisits: destination.samples,
      maximumForwardCoefficientBits: arithmetic.forwardBits,
      maximumInverseCoefficientBits: arithmetic.inverseBits,
      determinantBits: arithmetic.determinantBits,
      maximumEvaluationBits: evaluationBits,
    },
    identityTransform: identityQuad(points, input.sourceWidth, input.sourceHeight),
  };
  return Object.freeze({
    ...identityValue,
    source: Object.freeze(identityValue.source),
    destination: Object.freeze({
      ...identityValue.destination,
      quadQ16: Object.freeze(quadQ16),
      bounds: Object.freeze(identityValue.destination.bounds),
    }),
    homography: Object.freeze({
      forward: Object.freeze(identityValue.homography.forward),
      inverseAdjugate: Object.freeze(identityValue.homography.inverseAdjugate),
      determinant: identityValue.homography.determinant,
    }),
    work: Object.freeze(identityValue.work),
    planIdentity: stablePlanIdentity(identityValue),
  });
}

function parseExactIntegers(values: readonly string[], label: string) {
  if (!Array.isArray(values) || values.length !== 9) fail("CUT_PROJECTIVE_WARP_PLAN", `${label} must contain exactly nine exact integer strings.`);
  try {
    return values.map((value) => {
      if (typeof value !== "string" || !/^-?(?:0|[1-9][0-9]*)$/u.test(value)) throw new Error("noncanonical integer");
      const exact = BigInt(value);
      if (String(exact) !== value) throw new Error("noncanonical integer");
      return exact;
    });
  } catch {
    return fail("CUT_PROJECTIVE_WARP_PLAN", `${label} must contain canonical exact integer strings.`);
  }
}

function exactObjectKeys(value: unknown, label: string, expected: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("CUT_PROJECTIVE_WARP_PLAN", `${label} must be an object with the closed projective-warp plan shape.`);
  }
  const actual = Object.keys(value).sort(), closed = [...expected].sort();
  if (actual.length !== closed.length || actual.some((key, index) => key !== closed[index])) {
    fail("CUT_PROJECTIVE_WARP_PLAN", `${label} fields must be exactly ${closed.join(", ")}.`);
  }
}

function parsePlanQuad(value: ReferenceProjectiveWarpPlan["destination"]["quadQ16"]) {
  if (!Array.isArray(value) || value.length !== 4) fail("CUT_PROJECTIVE_WARP_PLAN", "plan destination quad must contain exactly four Q16 points.");
  const maximumQ16 = BigInt(referenceProjectiveWarpLimits.maximumAbsoluteDestinationCoordinate) * q16;
  const points = value.map((point, index) => {
    exactObjectKeys(point, `plan destination quad point ${index}`, ["x", "y"]);
    const parse = (coordinate: unknown, axis: "x" | "y") => {
      if (typeof coordinate !== "string" || !/^-?(?:0|[1-9][0-9]*)$/u.test(coordinate)) {
        fail("CUT_PROJECTIVE_WARP_PLAN", `plan destination quad point ${index}.${axis} must be a canonical exact Q16 integer string.`);
      }
      const exact = BigInt(coordinate);
      if (String(exact) !== coordinate) fail("CUT_PROJECTIVE_WARP_PLAN", `plan destination quad point ${index}.${axis} must not use a noncanonical signed zero.`);
      if (absolute(exact) > maximumQ16) {
        fail("CUT_PROJECTIVE_WARP_COORDINATE", `plan destination quad point ${index}.${axis} exceeds the bounded Q16 coordinate envelope.`);
      }
      return exact;
    };
    return Object.freeze({ x: parse(point.x, "x"), y: parse(point.y, "y") });
  }) as [Q16Point, Q16Point, Q16Point, Q16Point];
  return validateQuantizedQuad(points);
}

function validatePlanForExecution(plan: ReferenceProjectiveWarpPlan) {
  if (!plan || typeof plan !== "object" || plan.algorithmVersion !== referenceProjectiveWarpAlgorithmVersion || plan.phaseUnits !== referenceProjectiveWarpPhaseUnits) {
    fail("CUT_PROJECTIVE_WARP_PLAN", `plan must use ${referenceProjectiveWarpAlgorithmVersion} and Q16 phase units.`);
  }
  exactObjectKeys(plan, "plan", ["algorithmVersion", "phaseUnits", "source", "destination", "homography", "work", "identityTransform", "planIdentity"]);
  exactObjectKeys(plan.source, "plan source", ["width", "height", "pixels", "rgbaBytes"]);
  exactObjectKeys(plan.destination, "plan destination", ["quadQ16", "bounds", "width", "height", "pixels", "rgbaBytes"]);
  exactObjectKeys(plan.destination.bounds, "plan destination bounds", ["left", "top", "right", "bottom"]);
  exactObjectKeys(plan.homography, "plan homography", ["forward", "inverseAdjugate", "determinant"]);
  exactObjectKeys(plan.work, "plan work", [
    "maximumDestinationPixelTests",
    "maximumBilinearSampleVisits",
    "maximumForwardCoefficientBits",
    "maximumInverseCoefficientBits",
    "determinantBits",
    "maximumEvaluationBits",
  ]);
  const source = validateSourceDimensions(plan.source?.width, plan.source?.height);
  const destination = validateBounds(plan.destination?.bounds);
  if (
    plan.source.pixels !== source.pixels || plan.source.rgbaBytes !== source.rgbaBytes
    || plan.destination.width !== destination.width || plan.destination.height !== destination.height
    || plan.destination.pixels !== destination.pixels || plan.destination.rgbaBytes !== destination.rgbaBytes
    || plan.work.maximumDestinationPixelTests !== destination.pixels
    || plan.work.maximumBilinearSampleVisits !== destination.samples
  ) {
    fail("CUT_PROJECTIVE_WARP_PLAN", "plan carries inconsistent source, destination, or sample-work accounting.");
  }
  const forward = parseExactIntegers(plan.homography?.forward, "forward homography");
  const inverse = parseExactIntegers(plan.homography?.inverseAdjugate, "inverse homography adjugate");
  if (maximumBits(forward) > referenceProjectiveWarpLimits.maximumExactCoefficientBits || maximumBits(inverse) > referenceProjectiveWarpLimits.maximumExactCoefficientBits) {
    fail("CUT_PROJECTIVE_WARP_WORK_LIMIT", `plan coefficient/denominator magnitude exceeds ${referenceProjectiveWarpLimits.maximumExactCoefficientBits} bits.`);
  }
  const determinant = determinant3(forward);
  if (determinant === 0n) fail("CUT_PROJECTIVE_WARP_HOMOGRAPHY_SINGULAR", "execution plan carries an exact singular homography.");
  let declaredDeterminant: bigint;
  try {
    declaredDeterminant = BigInt(plan.homography.determinant);
  } catch {
    return fail("CUT_PROJECTIVE_WARP_PLAN", "homography determinant must be a canonical exact integer string.");
  }
  if (String(declaredDeterminant) !== plan.homography.determinant || declaredDeterminant !== determinant) {
    fail("CUT_PROJECTIVE_WARP_PLAN", "declared homography determinant disagrees with exact coefficients.");
  }
  const expectedInverse = adjugate3(forward);
  if (inverse.some((value, index) => value !== expectedInverse[index])) {
    fail("CUT_PROJECTIVE_WARP_PLAN", "inverse adjugate disagrees with exact forward coefficients.");
  }
  const points = parsePlanQuad(plan.destination.quadQ16);
  const solved = exactHomography(points);
  if (
    forward.some((value, index) => value !== solved.forward[index])
    || inverse.some((value, index) => value !== solved.inverse[index])
    || determinant !== solved.determinant
  ) {
    fail("CUT_PROJECTIVE_WARP_PLAN", "quad, exact forward homography, inverse adjugate, and determinant do not describe the same four-corner transform.");
  }
  const evaluationBits = evaluationBitBound(inverse, plan.destination.bounds);
  const arithmetic = assertExactArithmeticBounds(forward, inverse, determinant, evaluationBits);
  if (
    plan.work.maximumForwardCoefficientBits !== arithmetic.forwardBits
    || plan.work.maximumInverseCoefficientBits !== arithmetic.inverseBits
    || plan.work.determinantBits !== arithmetic.determinantBits
    || plan.work.maximumEvaluationBits !== evaluationBits
  ) {
    fail("CUT_PROJECTIVE_WARP_PLAN", "plan exact-arithmetic accounting is inconsistent with its coefficients and bounds.");
  }
  const quad = plan.destination.quadQ16;
  const identityValue = {
    algorithmVersion: plan.algorithmVersion,
    phaseUnits: plan.phaseUnits,
    source: { ...plan.source },
    destination: {
      quadQ16: quad.map((point) => ({ ...point })),
      bounds: { ...plan.destination.bounds },
      width: plan.destination.width,
      height: plan.destination.height,
      pixels: plan.destination.pixels,
      rgbaBytes: plan.destination.rgbaBytes,
    },
    homography: {
      forward: [...plan.homography.forward],
      inverseAdjugate: [...plan.homography.inverseAdjugate],
      determinant: plan.homography.determinant,
    },
    work: { ...plan.work },
    identityTransform: plan.identityTransform,
  };
  if (plan.identityTransform !== identityQuad(points, plan.source.width, plan.source.height) || stablePlanIdentity(identityValue) !== plan.planIdentity) {
    fail("CUT_PROJECTIVE_WARP_PLAN", "plan semantic identity or identity-transform declaration is stale.");
  }
  return { forward, inverse, points };
}

function validateSurface(surface: ReferenceStraightRgbaWarpSurface, plan: ReferenceProjectiveWarpPlan) {
  if (!surface || typeof surface !== "object" || !(surface.data instanceof Uint8Array)) {
    fail("CUT_PROJECTIVE_WARP_SURFACE", "input must be a straight RGBA Uint8Array surface.");
  }
  if (surface.alphaMode !== undefined && surface.alphaMode !== "straight") {
    fail("CUT_PROJECTIVE_WARP_SURFACE", "input alpha mode must be straight; premultiplied bytes require an explicit conversion.");
  }
  if (surface.width !== plan.source.width || surface.height !== plan.source.height || surface.data.byteLength !== plan.source.rgbaBytes) {
    fail("CUT_PROJECTIVE_WARP_SURFACE", `input must match the admitted ${plan.source.width}x${plan.source.height} / ${plan.source.rgbaBytes}-byte source.`);
  }
}

function floorDivision(numerator: bigint, denominator: bigint) {
  if (denominator <= 0n) throw new Error("positive denominator required");
  let quotient = numerator / denominator;
  if (numerator < 0n && numerator % denominator !== 0n) quotient -= 1n;
  return quotient;
}

/** Exact equivalent of Math.round(numerator/denominator): ties move toward
 * positive infinity. */
function roundRationalToInteger(numerator: bigint, denominator: bigint) {
  let n = numerator, d = denominator;
  if (d === 0n) fail("CUT_PROJECTIVE_WARP_HOMOGRAPHY_SINGULAR", "inverse homography produced an exact zero sample denominator.");
  if (d < 0n) { n = -n; d = -d; }
  return floorDivision(2n * n + d, 2n * d);
}

function pointInsideClockwiseQuad(pointX: bigint, pointY: bigint, quad: readonly Q16Point[]) {
  const point = { x: pointX, y: pointY };
  for (let index = 0; index < 4; index += 1) {
    if (orient(quad[index]!, quad[(index + 1) % 4]!, point) < 0n) return false;
  }
  return true;
}

function sourceByte(surface: ReferenceStraightRgbaWarpSurface, x: number, y: number, channel: number) {
  if (x < 0 || y < 0 || x >= surface.width || y >= surface.height) return 0;
  return surface.data[(y * surface.width + x) * 4 + channel]!;
}

function roundedRatio(numerator: number, denominator: number) {
  return Math.floor((numerator * 2 + denominator) / (denominator * 2));
}

/**
 * Execute the admitted inverse projective map into its explicit destination
 * tile. Pixel centers are tested against the exact Q16 quad. Sample positions
 * are quantized to Q16 before a zero-extended, alpha-associated bilinear read.
 * Exact integer samples preserve every source byte (including independent
 * hidden RGB); fractional samples ignore transparent hidden RGB and clear RGB
 * whenever output alpha quantizes to zero.
 */
export function rasterReferenceProjectiveWarp(
  surface: ReferenceStraightRgbaWarpSurface,
  plan: ReferenceProjectiveWarpPlan,
  options: ReferenceProjectiveWarpExecutionOptions = {},
): ReferenceProjectiveWarpResult {
  const { inverse, points } = validatePlanForExecution(plan);
  validateSurface(surface, plan);
  const allocate = options.allocateOutput ?? ((bytes: number) => new Uint8Array(bytes));
  const output = allocate(plan.destination.rgbaBytes);
  if (!(output instanceof Uint8Array) || output.byteLength !== plan.destination.rgbaBytes) {
    fail("CUT_PROJECTIVE_WARP_SURFACE", `output allocator must return exactly ${plan.destination.rgbaBytes} Uint8Array bytes.`);
  }
  // Custom allocators may return reused or intentionally dirty storage. The
  // transparent destination contract cannot depend on allocator initialization.
  output.fill(0);

  let insideQuadPixels = 0, integerSamplesCopied = 0, bilinearSamplesEvaluated = 0, sourceTapsRead = 0;
  const bounds = plan.destination.bounds;
  for (let destinationY = bounds.top; destinationY < bounds.bottom; destinationY += 1) {
    const destinationYQ16 = BigInt(destinationY) * q16 + q16Half;
    for (let destinationX = bounds.left; destinationX < bounds.right; destinationX += 1) {
      const destinationXQ16 = BigInt(destinationX) * q16 + q16Half;
      if (!pointInsideClockwiseQuad(destinationXQ16, destinationYQ16, points)) continue;
      insideQuadPixels += 1;
      const normalizedXNumerator = inverse[0]! * destinationXQ16 + inverse[1]! * destinationYQ16 + inverse[2]!;
      const normalizedYNumerator = inverse[3]! * destinationXQ16 + inverse[4]! * destinationYQ16 + inverse[5]!;
      const normalizedDenominator = inverse[6]! * destinationXQ16 + inverse[7]! * destinationYQ16 + inverse[8]!;
      if (normalizedDenominator === 0n) fail("CUT_PROJECTIVE_WARP_HOMOGRAPHY_SINGULAR", "inverse homography horizon crosses an admitted destination pixel center.");
      const sourceXQ16 = roundRationalToInteger(
        (2n * normalizedXNumerator * BigInt(plan.source.width) - normalizedDenominator) * q16,
        2n * normalizedDenominator,
      );
      const sourceYQ16 = roundRationalToInteger(
        (2n * normalizedYNumerator * BigInt(plan.source.height) - normalizedDenominator) * q16,
        2n * normalizedDenominator,
      );
      const outputX = destinationX - bounds.left, outputY = destinationY - bounds.top;
      const outputOffset = (outputY * plan.destination.width + outputX) * 4;

      if (sourceXQ16 % q16 === 0n && sourceYQ16 % q16 === 0n) {
        const sourceX = Number(sourceXQ16 / q16), sourceY = Number(sourceYQ16 / q16);
        if (sourceX >= 0 && sourceY >= 0 && sourceX < surface.width && sourceY < surface.height) {
          const sourceOffset = (sourceY * surface.width + sourceX) * 4;
          output.set(surface.data.subarray(sourceOffset, sourceOffset + 4), outputOffset);
          integerSamplesCopied += 1;
          sourceTapsRead += 1;
        }
        continue;
      }

      bilinearSamplesEvaluated += 1;
      const x0Exact = floorDivision(sourceXQ16, q16), y0Exact = floorDivision(sourceYQ16, q16);
      const fractionX = Number(sourceXQ16 - x0Exact * q16), fractionY = Number(sourceYQ16 - y0Exact * q16);
      const x0 = Number(x0Exact), y0 = Number(y0Exact);
      const inverseX = referenceProjectiveWarpPhaseUnits - fractionX, inverseY = referenceProjectiveWarpPhaseUnits - fractionY;
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
      const denominator = referenceProjectiveWarpPhaseUnits ** 2;
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
      width: plan.destination.width,
      height: plan.destination.height,
      originX: bounds.left,
      originY: bounds.top,
      alphaMode: "straight" as const,
    }),
    observedWork: Object.freeze({
      destinationPixelsTested: plan.destination.pixels,
      insideQuadPixels,
      integerSamplesCopied,
      bilinearSamplesEvaluated,
      sourceTapsRead,
    }),
  });
}
