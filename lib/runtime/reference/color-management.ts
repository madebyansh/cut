import type { CutAVIR, IRNode, IRValue } from "../../language/ir";
import { compareRational, rational, rationalToNumber, type Rational, zeroRational } from "../../language/rational";
import {
  cutVideoColorInterpretationProfiles,
  cutVideoInputColorProfiles,
  type CutVideoColorInterpretationProfile,
  type CutVideoInputColorProfile,
} from "../../language/video-input-color";

/**
 * CUT's deliberately small 0.4 managed SDR set. sRGB and Rec. 709 share
 * BT.709 primaries and a D65 white point; their transfer functions differ.
 * `rec709-limited` additionally carries the 8-bit legal code range 16...235.
 */
export const referenceColorProfiles = ["srgb", "linear-srgb", "rec709-full", "rec709-limited"] as const;
export type ReferenceColorProfile = typeof referenceColorProfiles[number];
/**
 * Video-input assertions are deliberately a wider, input-only set. The SD
 * profile below is not a retained-surface or delivery profile: its name locks
 * the complete supported ffprobe tuple instead of pretending that a matrix,
 * transfer, or primaries tag can stand in for the other two.
 */
export const referenceVideoInputColorProfiles = cutVideoInputColorProfiles;
export type ReferenceVideoInputColorProfile = CutVideoInputColorProfile;
export type ReferenceVideoColorInterpretationProfile = CutVideoColorInterpretationProfile;
export type ReferenceColorTransfer = "srgb" | "linear" | "bt709";
export type ReferenceColorRange = "full" | "limited";

export type ReferenceColorProfileMetadata = Readonly<{
  profile: ReferenceColorProfile;
  primaries: "bt709";
  whitePoint: "d65";
  transfer: ReferenceColorTransfer;
  range: ReferenceColorRange;
}>;

const profileMetadata: Readonly<Record<ReferenceColorProfile, ReferenceColorProfileMetadata>> = Object.freeze({
  srgb: Object.freeze({ profile: "srgb", primaries: "bt709", whitePoint: "d65", transfer: "srgb", range: "full" }),
  "linear-srgb": Object.freeze({ profile: "linear-srgb", primaries: "bt709", whitePoint: "d65", transfer: "linear", range: "full" }),
  "rec709-full": Object.freeze({ profile: "rec709-full", primaries: "bt709", whitePoint: "d65", transfer: "bt709", range: "full" }),
  "rec709-limited": Object.freeze({ profile: "rec709-limited", primaries: "bt709", whitePoint: "d65", transfer: "bt709", range: "limited" }),
});

export function referenceColorProfileMetadata(profile: ReferenceColorProfile) {
  return profileMetadata[profile];
}

export type ReferenceColorErrorCode =
  | "CUT_COLOR_ALPHA"
  | "CUT_COLOR_CURVE_INPUT"
  | "CUT_COLOR_CURVE_POINTS"
  | "CUT_COLOR_CURVE_RANGE"
  | "CUT_COLOR_CURVE_RESOURCE"
  | "CUT_COLOR_GRAPH"
  | "CUT_COLOR_HISTOGRAM"
  | "CUT_COLOR_INPUT_COMBINATION"
  | "CUT_COLOR_INPUT_TYPE"
  | "CUT_COLOR_INTERPRETATION_OBSERVED"
  | "CUT_COLOR_INTERPRETATION_PIXEL_FORMAT"
  | "CUT_COLOR_INTERPRETATION_PROFILE"
  | "CUT_COLOR_INTERPRETATION_REDUNDANT"
  | "CUT_COLOR_INTERPRETATION_SCAN"
  | "CUT_COLOR_INTERPRETATION_SHAPE"
  | "CUT_COLOR_METADATA"
  | "CUT_COLOR_PROFILE"
  | "CUT_COLOR_RANGE"
  | "CUT_COLOR_SURFACE"
  | "CUT_COLOR_UNSUPPORTED";

export type ReferenceColorErrorSource = {
  module: string;
  line: number;
  column: number;
  nodeId: string;
};

export class ReferenceColorManagementError extends Error {
  constructor(
    readonly code: ReferenceColorErrorCode,
    message: string,
    readonly source?: ReferenceColorErrorSource,
  ) {
    super(`${code}: ${message}`);
    this.name = "ReferenceColorManagementError";
  }
}

function nodeSource(node: IRNode): ReferenceColorErrorSource {
  return {
    module: node.provenance.module,
    line: node.provenance.span.start.line,
    column: node.provenance.span.start.column,
    nodeId: node.id,
  };
}

function location(node: IRNode) {
  return `${node.provenance.module}:${node.provenance.span.start.line}:${node.provenance.span.start.column}`;
}

function fail(node: IRNode, code: ReferenceColorErrorCode, message: string): never {
  throw new ReferenceColorManagementError(code, `${node.op} at ${location(node)} ${message}`, nodeSource(node));
}

function profileInput(node: IRNode, name: string): ReferenceColorProfile {
  const value = node.inputs[name];
  if (value?.kind !== "string") fail(node, "CUT_COLOR_INPUT_TYPE", `input “${name}” must be a String.`);
  if (!referenceColorProfiles.includes(value.value as ReferenceColorProfile)) {
    fail(node, "CUT_COLOR_PROFILE", `input “${name}” must be one of: ${referenceColorProfiles.join(", ")}. HDR, log, ICC and OCIO profiles are not implemented by the reference runtime.`);
  }
  return value.value as ReferenceColorProfile;
}

export type ReferenceColorConvertConfig = Readonly<{
  nodeId: string;
  from: ReferenceColorProfile;
  to: ReferenceColorProfile;
  alpha: "straight";
}>;

/** Strict public/loaded-IR contract for the unary ColorConvert kernel. */
export function referenceColorConvertConfig(node: IRNode): ReferenceColorConvertConfig | undefined {
  if (node.op !== "cut.visual.color_convert") return undefined;
  const from = profileInput(node, "from"), to = profileInput(node, "to");
  const alphaValue = node.inputs.alpha;
  const alpha = alphaValue === undefined ? "straight" : alphaValue.kind === "string" ? alphaValue.value : undefined;
  if (alpha !== "straight") {
    if (alphaValue?.kind !== "string") fail(node, "CUT_COLOR_INPUT_TYPE", "input “alpha” must be String.");
    fail(node, "CUT_COLOR_ALPHA", "only straight (unassociated) RGBA is supported; premultiplied conversion must be made explicit at a future typed surface boundary.");
  }
  if (node.children.length !== 1) fail(node, "CUT_COLOR_GRAPH", `requires exactly one visual child; received ${node.children.length}.`);
  return Object.freeze({ nodeId: node.id, from, to, alpha });
}

export const referenceTonalCurveLimits = Object.freeze({
  minimumPoints: 2,
  maximumPoints: 32,
  maximumNodesPerComposition: 256,
  maximumPointsPerComposition: 4_096,
});

export const referenceTonalCurveChannels = ["rgb", "red", "green", "blue"] as const;
export type ReferenceTonalCurveChannel = typeof referenceTonalCurveChannels[number];
export const referenceTonalCurveSpaces = ["srgb", "linear-srgb"] as const;
export type ReferenceTonalCurveSpace = typeof referenceTonalCurveSpaces[number];

export type ReferenceTonalCurvePoint = Readonly<{ input: Rational; output: Rational }>;
export type ReferenceTonalCurveConfig = Readonly<{
  nodeId: string;
  points: readonly ReferenceTonalCurvePoint[];
  channel: ReferenceTonalCurveChannel;
  space: ReferenceTonalCurveSpace;
  alpha: "straight";
}>;

function canonicalCurveRational(node: IRNode, value: unknown, label: string) {
  if (!value || typeof value !== "object") fail(node, "CUT_COLOR_CURVE_INPUT", `${label} must carry a canonical exact Ratio.`);
  const candidate = value as { numerator?: unknown; denominator?: unknown };
  if (
    typeof candidate.numerator !== "string"
    || typeof candidate.denominator !== "string"
    || !/^-?(?:0|[1-9]\d*)$/.test(candidate.numerator)
    || !/^[1-9]\d*$/.test(candidate.denominator)
    || candidate.numerator.length > 256
    || candidate.denominator.length > 256
  ) fail(node, "CUT_COLOR_CURVE_INPUT", `${label} must carry a canonical exact Ratio within the 256-digit rational limit.`);
  try {
    const exact = rational(candidate.numerator, candidate.denominator);
    if (exact.numerator !== candidate.numerator || exact.denominator !== candidate.denominator) throw new Error("non-canonical");
    return exact;
  } catch {
    fail(node, "CUT_COLOR_CURVE_INPUT", `${label} must carry a canonical exact Ratio within the 256-digit rational limit.`);
  }
}

function curveRatio(node: IRNode, value: IRValue | undefined, label: string) {
  if (value?.kind !== "quantity" || value.dimension !== "ratio" || value.unit !== "ratio") {
    fail(node, "CUT_COLOR_CURVE_INPUT", `${label} must be a Ratio authored with curvePoint(input:, output:).`);
  }
  const exact = canonicalCurveRational(node, value.magnitude, label);
  if (compareRational(exact, zeroRational) < 0 || compareRational(exact, rational(1)) > 0) {
    fail(node, "CUT_COLOR_CURVE_RANGE", `${label} must be between 0% and 100% inclusive; received ${exact.numerator}/${exact.denominator}.`);
  }
  return exact;
}

function curveStringInput<T extends string>(node: IRNode, name: string, values: readonly T[], fallback?: T): T {
  const value = node.inputs[name];
  if (value === undefined && fallback !== undefined) return fallback;
  if (value?.kind !== "string") fail(node, "CUT_COLOR_CURVE_INPUT", `input “${name}” must be a String.`);
  if (!values.includes(value.value as T)) fail(node, "CUT_COLOR_CURVE_INPUT", `input “${name}” must be one of: ${values.join(", ")}.`);
  return value.value as T;
}

/** Strict public/loaded-IR contract for the unary TonalCurve kernel. */
export function referenceTonalCurveConfig(node: IRNode): ReferenceTonalCurveConfig | undefined {
  if (node.op !== "cut.visual.tonal_curve") return undefined;
  const authored = node.inputs.points;
  if (authored?.kind !== "array") fail(node, "CUT_COLOR_CURVE_INPUT", "input “points” must be a finite List<ColorCurvePoint>.");
  if (authored.items.length < referenceTonalCurveLimits.minimumPoints || authored.items.length > referenceTonalCurveLimits.maximumPoints) {
    fail(node, "CUT_COLOR_CURVE_POINTS", `input “points” must contain ${referenceTonalCurveLimits.minimumPoints} through ${referenceTonalCurveLimits.maximumPoints} control points.`);
  }
  const points: ReferenceTonalCurvePoint[] = [];
  authored.items.forEach((item, index) => {
    if (item.kind !== "object") fail(node, "CUT_COLOR_CURVE_INPUT", `point ${index + 1} must be authored with curvePoint(input:, output:).`);
    const keys = Object.keys(item.entries);
    if (keys.length !== 2 || !keys.includes("input") || !keys.includes("output")) {
      fail(node, "CUT_COLOR_CURVE_INPUT", `point ${index + 1} must contain exactly input and output.`);
    }
    const input = curveRatio(node, item.entries.input, `point ${index + 1} input`);
    const output = curveRatio(node, item.entries.output, `point ${index + 1} output`);
    if (points.length && compareRational(input, points.at(-1)!.input) <= 0) {
      fail(node, "CUT_COLOR_CURVE_POINTS", "control-point input values must be strictly increasing.");
    }
    points.push(Object.freeze({ input, output }));
  });
  if (compareRational(points[0].input, zeroRational) !== 0 || compareRational(points.at(-1)!.input, rational(1)) !== 0) {
    fail(node, "CUT_COLOR_CURVE_POINTS", "control points must cover the complete working-space domain: first input 0%, last input 100%.");
  }
  const space = curveStringInput(node, "space", referenceTonalCurveSpaces);
  const channel = curveStringInput(node, "channel", referenceTonalCurveChannels, "rgb");
  const alpha = curveStringInput(node, "alpha", ["straight"] as const, "straight");
  if (node.children.length !== 1) fail(node, "CUT_COLOR_GRAPH", `requires exactly one visual child; received ${node.children.length}.`);
  return Object.freeze({ nodeId: node.id, points: Object.freeze(points), channel, space, alpha });
}

/** Bound aggregate curve work independently for each reachable composition. */
export function validateReferenceTonalCurveNodeBudget(ir: CutAVIR, reachable: ReadonlySet<string>) {
  let nodes = 0, points = 0;
  for (const id of reachable) {
    const node = ir.nodes[id];
    if (!node || node.op !== "cut.visual.tonal_curve") continue;
    const config = referenceTonalCurveConfig(node)!;
    nodes += 1;
    points += config.points.length;
    if (nodes > referenceTonalCurveLimits.maximumNodesPerComposition) {
      fail(node, "CUT_COLOR_CURVE_RESOURCE", `composition exceeds the ${referenceTonalCurveLimits.maximumNodesPerComposition}-TonalCurve-node limit.`);
    }
    if (!Number.isSafeInteger(points) || points > referenceTonalCurveLimits.maximumPointsPerComposition) {
      fail(node, "CUT_COLOR_CURVE_RESOURCE", `composition exceeds the ${referenceTonalCurveLimits.maximumPointsPerComposition}-control-point TonalCurve limit.`);
    }
  }
}

export type ReferenceColorSurface = {
  data: Uint8Array;
  width: number;
  height: number;
  alphaMode?: "straight" | "premultiplied";
};

export type ReferenceColorInspection = Readonly<{
  profile: ReferenceColorProfile;
  pixels: number;
  transparentPixels: number;
  lowerLegalViolations: number;
  upperLegalViolations: number;
  clippedBlackChannels: number;
  clippedWhiteChannels: number;
}>;

function surfaceError(code: ReferenceColorErrorCode, message: string, node?: IRNode): never {
  if (node) fail(node, code, message);
  throw new ReferenceColorManagementError(code, message);
}

function validateSurface(surface: ReferenceColorSurface, node?: IRNode) {
  if (!Number.isSafeInteger(surface.width) || !Number.isSafeInteger(surface.height) || surface.width < 1 || surface.height < 1) {
    surfaceError("CUT_COLOR_SURFACE", "color surface dimensions must be positive safe integers.", node);
  }
  if (!(surface.data instanceof Uint8Array) || surface.data.byteLength !== surface.width * surface.height * 4) {
    surfaceError("CUT_COLOR_SURFACE", "color surface must contain exactly width * height straight RGBA bytes.", node);
  }
  const alphaMode = surface.alphaMode ?? "straight";
  if (alphaMode !== "straight") {
    surfaceError("CUT_COLOR_ALPHA", "color conversion accepts straight (unassociated) RGBA only; premultiplied bytes are refused to prevent double multiplication.", node);
  }
}

export function inspectReferenceColorSurface(surface: ReferenceColorSurface, profile: ReferenceColorProfile): ReferenceColorInspection {
  validateSurface(surface);
  if (!referenceColorProfiles.includes(profile)) throw new ReferenceColorManagementError("CUT_COLOR_PROFILE", `unsupported color profile ${String(profile)}.`);
  const limited = profileMetadata[profile].range === "limited";
  let transparentPixels = 0, lowerLegalViolations = 0, upperLegalViolations = 0, clippedBlackChannels = 0, clippedWhiteChannels = 0;
  for (let offset = 0; offset < surface.data.byteLength; offset += 4) {
    if (surface.data[offset + 3] === 0) transparentPixels += 1;
    for (let channel = 0; channel < 3; channel += 1) {
      const code = surface.data[offset + channel];
      if (limited && code < 16) lowerLegalViolations += 1;
      if (limited && code > 235) upperLegalViolations += 1;
      if (code === (limited ? 16 : 0)) clippedBlackChannels += 1;
      if (code === (limited ? 235 : 255)) clippedWhiteChannels += 1;
    }
  }
  return Object.freeze({ profile, pixels: surface.width * surface.height, transparentPixels, lowerLegalViolations, upperLegalViolations, clippedBlackChannels, clippedWhiteChannels });
}

function decodeTransfer(encoded: number, transfer: ReferenceColorTransfer) {
  const value = Math.max(0, Math.min(1, encoded));
  if (transfer === "linear") return value;
  if (transfer === "srgb") return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  return value < 0.081 ? value / 4.5 : ((value + 0.099) / 1.099) ** (1 / 0.45);
}

function encodeTransfer(linear: number, transfer: ReferenceColorTransfer) {
  const value = Math.max(0, Math.min(1, linear));
  if (transfer === "linear") return value;
  if (transfer === "srgb") return value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
  return value < 0.018 ? 4.5 * value : 1.099 * value ** 0.45 - 0.099;
}

function decodeCode(code: number, range: ReferenceColorRange) {
  return range === "limited" ? (code - 16) / 219 : code / 255;
}

function encodeCode(encoded: number, range: ReferenceColorRange) {
  return Math.round(range === "limited" ? 16 + encoded * 219 : encoded * 255);
}

const colorConversionTables = new Map<string, Uint8Array>();

/**
 * Every managed SDR surface is RGBA8 and each color channel is independent.
 * Derive the complete byte mapping once from CUT's existing scalar transfer
 * law, then reuse those exact bytes for every pixel. This is an execution
 * optimization only: the scalar law remains the authority that constructs the
 * table, including JavaScript exponentiation and rounding semantics.
 */
function colorConversionTable(from: ReferenceColorProfile, to: ReferenceColorProfile) {
  const key = `${from}\u0000${to}`;
  const existing = colorConversionTables.get(key);
  if (existing) return existing;
  const input = profileMetadata[from], output = profileMetadata[to];
  const table = new Uint8Array(256);
  for (let code = 0; code < table.length; code += 1) {
    const encoded = decodeCode(code, input.range);
    const linear = decodeTransfer(encoded, input.transfer);
    table[code] = encodeCode(encodeTransfer(linear, output.transfer), output.range);
  }
  colorConversionTables.set(key, table);
  return table;
}

function limitedRangeViolations(surface: ReferenceColorSurface) {
  let lower = 0, upper = 0;
  for (let offset = 0; offset < surface.data.byteLength; offset += 4) {
    for (let channel = 0; channel < 3; channel += 1) {
      const code = surface.data[offset + channel];
      if (code < 16) lower += 1;
      if (code > 235) upper += 1;
    }
  }
  return Object.freeze({ lower, upper });
}

function curveValue(points: readonly ReferenceTonalCurvePoint[], input: number) {
  const bounded = Math.max(0, Math.min(1, input));
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index], end = points[index + 1];
    const startInput = rationalToNumber(start.input), endInput = rationalToNumber(end.input);
    if (bounded <= endInput) {
      const progress = (bounded - startInput) / (endInput - startInput);
      return Math.max(0, Math.min(1, rationalToNumber(start.output) + progress * (rationalToNumber(end.output) - rationalToNumber(start.output))));
    }
  }
  return rationalToNumber(points.at(-1)!.output);
}

function identityCurve(points: readonly ReferenceTonalCurvePoint[]) {
  return points.every((point) => compareRational(point.input, point.output) === 0);
}

function tonalCurveTable(config: ReferenceTonalCurveConfig) {
  const table = new Uint8Array(256);
  for (let code = 0; code < 256; code += 1) {
    const encoded = code / 255;
    const working = config.space === "linear-srgb" ? decodeTransfer(encoded, "srgb") : encoded;
    const curved = curveValue(config.points, working);
    const output = config.space === "linear-srgb" ? encodeTransfer(curved, "srgb") : curved;
    table[code] = Math.round(output * 255);
  }
  return table;
}

/**
 * Apply one bounded piecewise-linear curve to a straight encoded-sRGB surface.
 * The control-point domain/range is interpreted in the authored working space;
 * alpha is copied exactly and hidden straight RGB is deliberately transformed.
 */
export function applyReferenceTonalCurve(
  surface: ReferenceColorSurface,
  config: ReferenceTonalCurveConfig,
  options: { node?: IRNode } = {},
): ReferenceColorSurface {
  validateSurface(surface, options.node);
  if (identityCurve(config.points)) return surface;
  const table = tonalCurveTable(config), data = Buffer.from(surface.data);
  const channels = config.channel === "rgb" ? [0, 1, 2] : config.channel === "red" ? [0] : config.channel === "green" ? [1] : [2];
  for (let offset = 0; offset < data.byteLength; offset += 4) {
    for (const channel of channels) data[offset + channel] = table[data[offset + channel]];
  }
  return { data, width: surface.width, height: surface.height, alphaMode: "straight" };
}

export const referenceColorHistogramLimits = Object.freeze({
  bins: Object.freeze([16, 32, 64, 128, 256] as const),
  maximumPixels: 16_777_216,
});

export type ReferenceColorHistogramReport = Readonly<{
  format: "cut-color-histogram";
  version: 1;
  width: number;
  height: number;
  pixels: number;
  sampledPixels: number;
  excludedTransparentPixels: number;
  bins: 16 | 32 | 64 | 128 | 256;
  rgbSpace: ReferenceTonalCurveSpace;
  lumaSpace: "linear-srgb";
  alpha: "all" | "nonzero";
  channels: Readonly<{
    red: readonly number[];
    green: readonly number[];
    blue: readonly number[];
    luma: readonly number[];
    alpha: readonly number[];
  }>;
}>;

/**
 * Bounded, JSON-serializable per-frame histogram for straight encoded-sRGB
 * retained surfaces. This is a conformance/inspection primitive, not a claim
 * of a temporal waveform, vectorscope, or legal-broadcast analyzer.
 */
export function inspectReferenceColorHistogram(
  surface: ReferenceColorSurface,
  options: { bins?: 16 | 32 | 64 | 128 | 256; space?: ReferenceTonalCurveSpace; alpha?: "all" | "nonzero" } = {},
): ReferenceColorHistogramReport {
  validateSurface(surface);
  const pixels = surface.width * surface.height;
  if (!Number.isSafeInteger(pixels) || pixels > referenceColorHistogramLimits.maximumPixels) {
    throw new ReferenceColorManagementError("CUT_COLOR_HISTOGRAM", `histogram input exceeds the ${referenceColorHistogramLimits.maximumPixels}-pixel limit.`);
  }
  const bins = options.bins ?? 64, rgbSpace = options.space ?? "srgb", alpha = options.alpha ?? "nonzero";
  if (!referenceColorHistogramLimits.bins.includes(bins)) throw new ReferenceColorManagementError("CUT_COLOR_HISTOGRAM", `histogram bins must be one of: ${referenceColorHistogramLimits.bins.join(", ")}.`);
  if (!referenceTonalCurveSpaces.includes(rgbSpace)) throw new ReferenceColorManagementError("CUT_COLOR_HISTOGRAM", `histogram space must be one of: ${referenceTonalCurveSpaces.join(", ")}.`);
  if (alpha !== "all" && alpha !== "nonzero") throw new ReferenceColorManagementError("CUT_COLOR_HISTOGRAM", 'histogram alpha policy must be "all" or "nonzero".');
  const red = Array<number>(bins).fill(0), green = Array<number>(bins).fill(0), blue = Array<number>(bins).fill(0), luma = Array<number>(bins).fill(0), alphaBins = Array<number>(bins).fill(0);
  const bucket = (value: number) => Math.min(bins - 1, Math.floor(Math.max(0, Math.min(1, value)) * bins));
  let sampledPixels = 0, excludedTransparentPixels = 0;
  for (let offset = 0; offset < surface.data.byteLength; offset += 4) {
    const alphaCode = surface.data[offset + 3];
    if (alpha === "nonzero" && alphaCode === 0) { excludedTransparentPixels += 1; continue; }
    const encoded = [surface.data[offset] / 255, surface.data[offset + 1] / 255, surface.data[offset + 2] / 255] as const;
    const linear = encoded.map((value) => decodeTransfer(value, "srgb"));
    const rgb = rgbSpace === "linear-srgb" ? linear : encoded;
    red[bucket(rgb[0])] += 1; green[bucket(rgb[1])] += 1; blue[bucket(rgb[2])] += 1;
    luma[bucket(linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722)] += 1;
    alphaBins[bucket(alphaCode / 255)] += 1;
    sampledPixels += 1;
  }
  return Object.freeze({
    format: "cut-color-histogram", version: 1, width: surface.width, height: surface.height, pixels,
    sampledPixels, excludedTransparentPixels, bins, rgbSpace, lumaSpace: "linear-srgb", alpha,
    channels: Object.freeze({ red: Object.freeze(red), green: Object.freeze(green), blue: Object.freeze(blue), luma: Object.freeze(luma), alpha: Object.freeze(alphaBins) }),
  });
}

/**
 * Convert one straight-alpha 8-bit RGBA surface. No chromatic-adaptation
 * matrix is needed because every profile in this bounded subset uses the same
 * BT.709/sRGB primaries and D65 white. Alpha and hidden RGB are preserved as
 * independent unassociated channels. Limited-range input outside 16...235 is
 * refused instead of being silently clipped.
 */
export function convertReferenceColorSurface(
  surface: ReferenceColorSurface,
  from: ReferenceColorProfile,
  to: ReferenceColorProfile,
  options: { node?: IRNode } = {},
): ReferenceColorSurface {
  validateSurface(surface, options.node);
  if (!referenceColorProfiles.includes(from) || !referenceColorProfiles.includes(to)) {
    surfaceError("CUT_COLOR_PROFILE", `unsupported conversion ${String(from)} -> ${String(to)}.`, options.node);
  }
  const violations = profileMetadata[from].range === "limited"
    ? limitedRangeViolations(surface)
    : Object.freeze({ lower: 0, upper: 0 });
  if (violations.lower || violations.upper) {
    surfaceError(
      "CUT_COLOR_RANGE",
      `${from} input contains ${violations.lower} channel code(s) below 16 and ${violations.upper} above 235; legal-range violations are refused, not clipped.`,
      options.node,
    );
  }
  if (from === to) return surface;
  const table = colorConversionTable(from, to), data = Buffer.allocUnsafe(surface.data.byteLength);
  for (let offset = 0; offset < data.byteLength; offset += 4) {
    data[offset] = table[surface.data[offset]];
    data[offset + 1] = table[surface.data[offset + 1]];
    data[offset + 2] = table[surface.data[offset + 2]];
    data[offset + 3] = surface.data[offset + 3];
  }
  return { data, width: surface.width, height: surface.height, alphaMode: "straight" };
}

export type LockedVideoColorMetadata = Readonly<{
  pixelFormat?: string;
  fieldOrder?: string;
  colorRange?: string;
  colorSpace?: string;
  colorTransfer?: string;
  colorPrimaries?: string;
}>;

export const referenceBt470bgSmpte170mInputContract = Object.freeze({
  id: "cut-input-bt470bg-smpte170m-limited-v1",
  version: 1 as const,
  profile: "bt470bg-smpte170m-limited" as const,
  lockedTuple: Object.freeze({
    colorRange: "tv" as const,
    colorSpace: "bt470bg" as const,
    colorTransfer: "smpte170m" as const,
    colorPrimaries: "bt470bg" as const,
  }),
  pixelFormats: Object.freeze(["yuv420p", "yuv422p", "yuv444p"] as const),
  decoderIntermediate: "straight-rgba8-full-bt470bg-smpte170m" as const,
  workingSurface: "straight-rgba8-full-srgb" as const,
  yuvExpansion: Object.freeze({ matrix: "bt601" as const, inputRange: "tv" as const, outputRange: "pc" as const }),
  primaryMatrix: Object.freeze([
    Object.freeze([1.0440432087628346, -0.04404320876283506, 0]),
    Object.freeze([0, 1, 0]),
    Object.freeze([0, 0.011793378284005201, 0.988206621715995]),
  ] as const),
  rounding: "nearest-uint8-after-clamp" as const,
});

const interpretedYuvPixelFormats = Object.freeze(["yuv420p", "yuv422p", "yuv444p"] as const);

type ReferenceInterpretedYuvTuple = Readonly<{
  range: "tv" | "pc";
  matrix: "bt709" | "bt470bg";
  transfer: "bt709" | "smpte170m";
  primaries: "bt709" | "bt470bg";
}>;

/**
 * One closed authored-interpretation contract.  Observed strings are never
 * decoder arguments: the profile lookup below is the only source of FFmpeg
 * matrix/range constants and CUT transfer/primary conversion semantics.
 */
export const referenceVideoColorInterpretationContract = Object.freeze({
  id: "cut-video-color-interpretation-v1" as const,
  version: 1 as const,
  authority: "author-declared-unverified" as const,
  profiles: Object.freeze({
    "rec709-full": Object.freeze({
      id: "cut-input-rec709-full-yuv-v1" as const,
      tuple: Object.freeze({ range: "pc", matrix: "bt709", transfer: "bt709", primaries: "bt709" } satisfies ReferenceInterpretedYuvTuple),
    }),
    "rec709-limited": Object.freeze({
      id: "cut-input-rec709-limited-yuv-v1" as const,
      tuple: Object.freeze({ range: "tv", matrix: "bt709", transfer: "bt709", primaries: "bt709" } satisfies ReferenceInterpretedYuvTuple),
    }),
    "bt470bg-smpte170m-limited": Object.freeze({
      id: referenceBt470bgSmpte170mInputContract.id,
      tuple: Object.freeze({ range: "tv", matrix: "bt470bg", transfer: "smpte170m", primaries: "bt470bg" } satisfies ReferenceInterpretedYuvTuple),
    }),
  }),
  pixelFormats: interpretedYuvPixelFormats,
  fieldOrder: "progressive" as const,
  absence: "omitted-property" as const,
});

export type ReferenceObservedVideoColor = Readonly<{
  pixelFormat: string;
  fieldOrder: "progressive";
  range?: string;
  matrix?: string;
  transfer?: string;
  primaries?: string;
}>;

export type ReferenceVideoColorInterpretation = Readonly<{
  profile: ReferenceVideoColorInterpretationProfile;
  master: ReferenceObservedVideoColor;
  proxy?: ReferenceObservedVideoColor;
}>;

export type ReferenceVideoInputColorDeclaration =
  | Readonly<{ mode: "legacy"; inputColor: "legacy" }>
  | Readonly<{ mode: "asserted"; inputColor: ReferenceVideoInputColorProfile }>
  | Readonly<{
      mode: "interpreted";
      inputColor: ReferenceVideoColorInterpretationProfile;
      interpretation: ReferenceVideoColorInterpretation;
      contract: typeof referenceVideoColorInterpretationContract.id;
      authority: typeof referenceVideoColorInterpretationContract.authority;
    }>;

const observedToken = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/u;

function closedObjectInput(node: IRNode, value: IRValue | undefined, label: string, required: readonly string[], optional: readonly string[] = []) {
  if (value?.kind !== "object") fail(node, "CUT_COLOR_INTERPRETATION_SHAPE", `${label} must be a typed record helper result.`);
  const allowed = new Set([...required, ...optional]);
  for (const field of required) if (!Object.hasOwn(value.entries, field)) fail(node, "CUT_COLOR_INTERPRETATION_SHAPE", `${label} is missing required field “${field}”.`);
  for (const field of Object.keys(value.entries)) if (!allowed.has(field)) fail(node, "CUT_COLOR_INTERPRETATION_SHAPE", `${label} contains unsupported field “${field}”.`);
  return value.entries;
}

function observedString(node: IRNode, value: IRValue | undefined, label: string) {
  if (value?.kind !== "string" || !observedToken.test(value.value)) {
    fail(node, "CUT_COLOR_INTERPRETATION_SHAPE", `${label} must be one bounded CUT-normalized selected-stream token.`);
  }
  return value.value;
}

function observedVideoColor(node: IRNode, value: IRValue | undefined, label: string): ReferenceObservedVideoColor {
  const entries = closedObjectInput(node, value, label, ["pixelFormat", "fieldOrder"], ["range", "matrix", "transfer", "primaries"]);
  const pixelFormat = observedString(node, entries.pixelFormat, `${label}.pixelFormat`);
  const fieldOrder = observedString(node, entries.fieldOrder, `${label}.fieldOrder`);
  if (!(interpretedYuvPixelFormats as readonly string[]).includes(pixelFormat)) {
    fail(node, "CUT_COLOR_INTERPRETATION_PIXEL_FORMAT", `${label}.pixelFormat=${JSON.stringify(pixelFormat)} is unsupported; authored interpretation currently requires ${interpretedYuvPixelFormats.join(", ")}.`);
  }
  if (fieldOrder !== referenceVideoColorInterpretationContract.fieldOrder) {
    fail(node, "CUT_COLOR_INTERPRETATION_SCAN", `${label}.fieldOrder=${JSON.stringify(fieldOrder)} is unsupported; authored interpretation currently requires an exact progressive selected stream.`);
  }
  return Object.freeze({
    pixelFormat,
    fieldOrder,
    ...(entries.range === undefined ? {} : { range: observedString(node, entries.range, `${label}.range`) }),
    ...(entries.matrix === undefined ? {} : { matrix: observedString(node, entries.matrix, `${label}.matrix`) }),
    ...(entries.transfer === undefined ? {} : { transfer: observedString(node, entries.transfer, `${label}.transfer`) }),
    ...(entries.primaries === undefined ? {} : { primaries: observedString(node, entries.primaries, `${label}.primaries`) }),
  });
}

function interpretationMatchesTarget(value: ReferenceObservedVideoColor, profile: ReferenceVideoColorInterpretationProfile) {
  const target = referenceVideoColorInterpretationContract.profiles[profile].tuple;
  return (interpretedYuvPixelFormats as readonly string[]).includes(value.pixelFormat)
    && value.fieldOrder === referenceVideoColorInterpretationContract.fieldOrder
    && value.range === target.range
    && value.matrix === target.matrix
    && value.transfer === target.transfer
    && value.primaries === target.primaries;
}

/** Parse the source/IR declaration without consulting media or starting tools. */
export function referenceVideoInputColorDeclaration(node: IRNode): ReferenceVideoInputColorDeclaration {
  const asserted = node.inputs.inputColor, interpreted = node.inputs.inputColorInterpretation;
  if (asserted !== undefined && interpreted !== undefined) {
    fail(node, "CUT_COLOR_INPUT_COMBINATION", "inputColor and inputColorInterpretation are mutually exclusive; inputColor remains a raw-metadata assertion.");
  }
  if (interpreted === undefined) {
    const inputColor = optionalVideoInputColorProfile(node, asserted);
    return inputColor === "legacy"
      ? Object.freeze({ mode: "legacy", inputColor })
      : Object.freeze({ mode: "asserted", inputColor });
  }
  const entries = closedObjectInput(node, interpreted, "inputColorInterpretation", ["profile", "master"], ["proxy"]);
  if (entries.profile?.kind !== "string" || !(cutVideoColorInterpretationProfiles as readonly string[]).includes(entries.profile.value)) {
    fail(node, "CUT_COLOR_INTERPRETATION_PROFILE", `inputColorInterpretation.profile must be one of: ${cutVideoColorInterpretationProfiles.join(", ")}. RGB, linear, HDR, log, ICC and OCIO interpretation are not implemented.`);
  }
  const profile = entries.profile.value as ReferenceVideoColorInterpretationProfile;
  const master = observedVideoColor(node, entries.master, "inputColorInterpretation.master");
  const proxy = entries.proxy === undefined ? undefined : observedVideoColor(node, entries.proxy, "inputColorInterpretation.proxy");
  if (interpretationMatchesTarget(master, profile) && (!proxy || interpretationMatchesTarget(proxy, profile))) {
    fail(node, "CUT_COLOR_INTERPRETATION_REDUNDANT", `every authored observed tuple already matches ${profile}; use strict inputColor: “${profile}” instead.`);
  }
  return Object.freeze({
    mode: "interpreted" as const,
    inputColor: profile,
    interpretation: Object.freeze({ profile, master, ...(proxy ? { proxy } : {}) }),
    contract: referenceVideoColorInterpretationContract.id,
    authority: referenceVideoColorInterpretationContract.authority,
  });
}

export const referenceVideoColorInterpretationWarningCode = "CUTW_COLOR_INTERPRETATION_AUTHOR_DECLARED" as const;

export type ReferenceVideoColorInterpretationWarning = Readonly<{
  severity: "warning";
  code: typeof referenceVideoColorInterpretationWarningCode;
  message: string;
  resourceId: string;
  profile: ReferenceVideoColorInterpretationProfile;
  contract: typeof referenceVideoColorInterpretationContract.id;
  authority: typeof referenceVideoColorInterpretationContract.authority;
  source: ReferenceColorErrorSource & { resourceId: string };
}>;

/**
 * Successful locking must keep the trust boundary visible. One warning is
 * emitted per resource/profile pair even when several direct nodes or stored
 * editorial operands consume the same declaration.
 */
export function referenceVideoColorInterpretationWarnings(ir: CutAVIR): readonly ReferenceVideoColorInterpretationWarning[] {
  const candidates: IRNode[] = [];
  for (const node of Object.values(ir.nodes)) {
    if (["cut.visual.video", "cut.edit.clip", "cut.edit.picture_clip"].includes(node.op)) candidates.push(node);
    if (node.op !== "cut.edit.picture_track" || node.editorial?.kind !== "picture-track" || !node.editorial.operationPlan) continue;
    const items = [
      ...node.editorial.operationPlan.baseItems,
      ...node.editorial.operationPlan.operations.flatMap((operation) => "item" in operation ? [operation.item] : []),
    ];
    for (const item of items) if (item.kind === "picture") {
      candidates.push({ ...node, op: "cut.edit.picture_clip", inputs: item.inputs, provenance: item.provenance });
    }
  }
  candidates.sort((left, right) => left.provenance.module.localeCompare(right.provenance.module)
    || left.provenance.span.start.line - right.provenance.span.start.line
    || left.provenance.span.start.column - right.provenance.span.start.column
    || left.id.localeCompare(right.id));
  const warnings = new Map<string, ReferenceVideoColorInterpretationWarning>();
  for (const node of candidates) {
    const declaration = referenceVideoInputColorDeclaration(node);
    const source = node.inputs.source;
    if (declaration.mode !== "interpreted" || source?.kind !== "resource-ref") continue;
    const key = `${source.id}\0${declaration.inputColor}`;
    if (warnings.has(key)) continue;
    warnings.set(key, Object.freeze({
      severity: "warning",
      code: referenceVideoColorInterpretationWarningCode,
      message: `VideoAsset ${JSON.stringify(source.id)} is author-interpreted as ${declaration.inputColor}; CUT locks the exact observed master/proxy tuples but does not verify that the author's interpretation is colorimetrically correct.`,
      resourceId: source.id,
      profile: declaration.inputColor,
      contract: declaration.contract,
      authority: declaration.authority,
      source: Object.freeze({ ...nodeSource(node), resourceId: source.id }),
    }));
  }
  return Object.freeze([...warnings.values()]);
}

export function referenceVideoColorProfileContractId(profile: ReferenceVideoColorInterpretationProfile) {
  return referenceVideoColorInterpretationContract.profiles[profile].id;
}

export function observedLockedVideoColor(metadata: LockedVideoColorMetadata | undefined): Readonly<{
  pixelFormat?: string;
  fieldOrder?: string;
  range?: string;
  matrix?: string;
  transfer?: string;
  primaries?: string;
}> {
  return Object.freeze({
    ...(metadata?.pixelFormat === undefined ? {} : { pixelFormat: metadata.pixelFormat }),
    ...(metadata?.fieldOrder === undefined ? {} : { fieldOrder: metadata.fieldOrder }),
    ...(metadata?.colorRange === undefined ? {} : { range: metadata.colorRange }),
    ...(metadata?.colorSpace === undefined ? {} : { matrix: metadata.colorSpace }),
    ...(metadata?.colorTransfer === undefined ? {} : { transfer: metadata.colorTransfer }),
    ...(metadata?.colorPrimaries === undefined ? {} : { primaries: metadata.colorPrimaries }),
  });
}

/** Validate one already selected master/proxy stream against an authored declaration. */
export function validateReferenceVideoColorInterpretation(
  node: IRNode,
  declaration: Extract<ReferenceVideoInputColorDeclaration, { mode: "interpreted" }>,
  metadata: LockedVideoColorMetadata | undefined,
  variant: "master" | "proxy",
  resourceHasProxy: boolean,
) {
  const authoredHasProxy = declaration.interpretation.proxy !== undefined;
  if (resourceHasProxy !== authoredHasProxy) {
    fail(
      node,
      "CUT_COLOR_INTERPRETATION_OBSERVED",
      resourceHasProxy
        ? "inputColorInterpretation must declare the exact observed proxy tuple because the VideoAsset has a proxy."
        : "inputColorInterpretation.proxy cannot be supplied because the VideoAsset has no proxy.",
    );
  }
  const expected = variant === "proxy" ? declaration.interpretation.proxy : declaration.interpretation.master;
  if (!expected) fail(node, "CUT_COLOR_INTERPRETATION_OBSERVED", `inputColorInterpretation has no exact ${variant} observation.`);
  const actual = observedLockedVideoColor(metadata);
  const fields = ["pixelFormat", "fieldOrder", "range", "matrix", "transfer", "primaries"] as const;
  const mismatches = fields.filter((field) => expected[field] !== actual[field]);
  if (mismatches.length) {
    const shown = (value: string | undefined) => value === undefined ? "<absent>" : value;
    fail(node, "CUT_COLOR_INTERPRETATION_OBSERVED", `locked ${variant} selected stream differs from the authored exact observation: ${mismatches.map((field) => `${field}=${shown(actual[field])} (authored ${shown(expected[field])})`).join("; ")}.`);
  }
  // Reassert execution bounds at the lock-selected boundary even after the
  // authored record has passed its source-only shape validation.
  if (!actual.pixelFormat || !(interpretedYuvPixelFormats as readonly string[]).includes(actual.pixelFormat)) {
    fail(node, "CUT_COLOR_INTERPRETATION_PIXEL_FORMAT", `locked ${variant} selected stream pixelFormat=${actual.pixelFormat ?? "<absent>"} is unsupported.`);
  }
  if (actual.fieldOrder !== referenceVideoColorInterpretationContract.fieldOrder) {
    fail(node, "CUT_COLOR_INTERPRETATION_SCAN", `locked ${variant} selected stream fieldOrder=${actual.fieldOrder} is unsupported; progressive is required.`);
  }
}

function isRgbPixelFormat(value: string | undefined) {
  return Boolean(value && /^(?:a?rgb|bgr|gbr|rgba|bgra|argb|abgr)/i.test(value));
}

/**
 * Assert that authored inputColor is exactly supported by the lock-selected
 * ffprobe stream. There is deliberately no fuzzy inference or HDR/log alias.
 */
export function validateLockedVideoColorMetadata(
  node: IRNode,
  profile: ReferenceVideoInputColorProfile,
  metadata: LockedVideoColorMetadata | undefined,
) {
  if (!metadata) fail(node, "CUT_COLOR_METADATA", `inputColor: “${profile}” requires locked selected-stream color metadata.`);
  if (profile === referenceBt470bgSmpte170mInputContract.profile) {
    const expected = referenceBt470bgSmpte170mInputContract.lockedTuple;
    const mismatches: string[] = [];
    if (!metadata.pixelFormat || !(referenceBt470bgSmpte170mInputContract.pixelFormats as readonly string[]).includes(metadata.pixelFormat)) {
      mismatches.push(`pixelFormat=${metadata.pixelFormat ?? "missing"} (expected ${referenceBt470bgSmpte170mInputContract.pixelFormats.join(" or ")})`);
    }
    if (metadata.colorRange !== expected.colorRange) mismatches.push(`range=${metadata.colorRange ?? "missing"} (expected ${expected.colorRange})`);
    if (metadata.colorSpace !== expected.colorSpace) mismatches.push(`matrix=${metadata.colorSpace ?? "missing"} (expected ${expected.colorSpace})`);
    if (metadata.colorTransfer !== expected.colorTransfer) mismatches.push(`transfer=${metadata.colorTransfer ?? "missing"} (expected ${expected.colorTransfer})`);
    if (metadata.colorPrimaries !== expected.colorPrimaries) mismatches.push(`primaries=${metadata.colorPrimaries ?? "missing"} (expected ${expected.colorPrimaries})`);
    if (mismatches.length) fail(node, "CUT_COLOR_METADATA", `locked selected stream does not match inputColor: “${profile}”: ${mismatches.join("; ")}.`);
    return;
  }
  const expectedTransfer = profile === "srgb" ? "iec61966-2-1" : profile === "linear-srgb" ? "linear" : "bt709";
  const expectedRange = profile === "rec709-limited" ? "tv" : "pc";
  const rgb = isRgbPixelFormat(metadata.pixelFormat);
  const expectedSpace = rgb ? new Set(["gbr", "rgb"]) : new Set(["bt709"]);
  const mismatches: string[] = [];
  if (metadata.colorPrimaries !== "bt709") mismatches.push(`primaries=${metadata.colorPrimaries ?? "missing"} (expected bt709)`);
  if (metadata.colorTransfer !== expectedTransfer) mismatches.push(`transfer=${metadata.colorTransfer ?? "missing"} (expected ${expectedTransfer})`);
  if (metadata.colorRange !== expectedRange) mismatches.push(`range=${metadata.colorRange ?? "missing"} (expected ${expectedRange})`);
  if (!metadata.colorSpace || !expectedSpace.has(metadata.colorSpace)) mismatches.push(`matrix=${metadata.colorSpace ?? "missing"} (expected ${[...expectedSpace].join(" or ")})`);
  if (profile === "linear-srgb" && !rgb) mismatches.push(`pixelFormat=${metadata.pixelFormat ?? "missing"} (linear-srgb input requires a locked RGB-family stream)`);
  if (mismatches.length) fail(node, "CUT_COLOR_METADATA", `locked selected stream does not match inputColor: “${profile}”: ${mismatches.join("; ")}.`);
}

export function optionalInputColorProfile(node: IRNode, value: IRValue | undefined): ReferenceColorProfile | "legacy" {
  if (value === undefined) return "legacy";
  if (value.kind !== "string") fail(node, "CUT_COLOR_INPUT_TYPE", "input “inputColor” must be String.");
  if (!referenceColorProfiles.includes(value.value as ReferenceColorProfile)) {
    fail(node, "CUT_COLOR_PROFILE", `input “inputColor” must be one of: ${referenceColorProfiles.join(", ")}. HDR, log, ICC and OCIO paths are refused.`);
  }
  return value.value as ReferenceColorProfile;
}

export function optionalVideoInputColorProfile(node: IRNode, value: IRValue | undefined): ReferenceVideoInputColorProfile | "legacy" {
  if (value === undefined) return "legacy";
  if (value.kind !== "string") fail(node, "CUT_COLOR_INPUT_TYPE", "input “inputColor” must be String.");
  if (!referenceVideoInputColorProfiles.includes(value.value as ReferenceVideoInputColorProfile)) {
    fail(node, "CUT_COLOR_PROFILE", `input “inputColor” must be one of: ${referenceVideoInputColorProfiles.join(", ")}. HDR, log, ICC and OCIO paths are refused.`);
  }
  return value.value as ReferenceVideoInputColorProfile;
}

/**
 * Convert the locked full-range BT.470BG/SMPTE-170M RGBA8 intermediate into
 * CUT's straight encoded-sRGB working surface. FFmpeg/libswscale owns only the
 * selected-stream YCbCr matrix/range expansion; this bounded transfer and
 * primary conversion is CUT runtime semantics.
 */
export function convertReferenceBt470bgSmpte170mInputToSrgb(
  surface: ReferenceColorSurface,
  options: { node?: IRNode } = {},
): ReferenceColorSurface {
  validateSurface(surface, options.node);
  const matrix = referenceBt470bgSmpte170mInputContract.primaryMatrix;
  const data = Buffer.alloc(surface.data.byteLength);
  for (let offset = 0; offset < data.byteLength; offset += 4) {
    const source = [
      decodeTransfer(surface.data[offset] / 255, "bt709"),
      decodeTransfer(surface.data[offset + 1] / 255, "bt709"),
      decodeTransfer(surface.data[offset + 2] / 255, "bt709"),
    ] as const;
    for (let channel = 0; channel < 3; channel += 1) {
      const linear709 = matrix[channel][0] * source[0] + matrix[channel][1] * source[1] + matrix[channel][2] * source[2];
      data[offset + channel] = Math.round(encodeTransfer(linear709, "srgb") * 255);
    }
    data[offset + 3] = surface.data[offset + 3];
  }
  return { data, width: surface.width, height: surface.height, alphaMode: "straight" };
}
