import sharp from "sharp";
import type { IRNode, IRValue } from "../../language/ir";
import { rationalToNumber } from "../../language/rational";
import { compositeRgba, type RgbaSurface } from "./compositing";

/**
 * The CPU reference backend deliberately keeps this budget small. A radius is
 * the Gaussian standard deviation used by libvips, not a CSS blur radius.
 */
export const referenceVisualEffectLimits = Object.freeze({
  maximumGaussianSigmaPx: 64,
  maximumSharpenSigmaPx: 16,
  maximumOffsetPx: 4_096,
  maximumCanvasPixels: 16_777_216,
  maximumGrainSizePx: 64,
  maximumSeed: 0xffff_ffff,
  maximumFrameIndex: 0xffff_ffff,
  grainMaximumCodeValueExcursion: 64,
});

export type ReferenceVisualEffectConfig =
  | { kind: "blur"; radius: number }
  | { kind: "shadow"; x: number; y: number; radius: number; color: string; opacity: number }
  | { kind: "glow"; radius: number; color: string; opacity: number }
  | { kind: "vignette"; amount: number; radius: number; softness: number; color: string }
  | { kind: "sharpen"; radius: number; amount: number }
  | { kind: "grain"; amount: number; size: number; seed: number; mode: "static" | "temporal"; monochrome: boolean }
  | { kind: "duotone"; shadows: string; highlights: string; amount: number };

export type ReferenceVisualEffectErrorCode =
  | "CUT_VISUAL_EFFECT_SHAPE"
  | "CUT_VISUAL_EFFECT_INPUT"
  | "CUT_VISUAL_EFFECT_RANGE"
  | "CUT_VISUAL_EFFECT_COLOR"
  | "CUT_VISUAL_EFFECT_FRAME"
  | "CUT_VISUAL_EFFECT_SURFACE";

export class ReferenceVisualEffectError extends Error {
  constructor(
    readonly code: ReferenceVisualEffectErrorCode,
    readonly nodeId: string | undefined,
    message: string,
    readonly source?: Readonly<{ module: string; line: number; column: number; nodeId: string }>,
  ) {
    super(`${code}: ${message}`);
    this.name = "ReferenceVisualEffectError";
  }
}

type MutableSurface = { data: Buffer; width: number; height: number };
type RgbaColor = readonly [red: number, green: number, blue: number, alpha: number];

const visualEffectOps = new Set([
  "cut.visual.blur", "cut.visual.shadow", "cut.visual.glow", "cut.visual.vignette",
  "cut.visual.sharpen", "cut.visual.grain", "cut.visual.duotone",
]);
const srgbToLinearBytes = Float64Array.from({ length: 256 }, (_, value) => {
  const encoded = value / 255;
  return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
});

function location(node: IRNode) {
  return `${node.provenance.module}:${node.provenance.span.start.line}:${node.provenance.span.start.column}`;
}

function fail(node: IRNode, detail: string, code: ReferenceVisualEffectErrorCode = "CUT_VISUAL_EFFECT_INPUT"): never {
  const { module, span } = node.provenance;
  throw new ReferenceVisualEffectError(
    code,
    node.id,
    `Reference effect ${node.op} at ${location(node)} ${detail}`,
    Object.freeze({ module, line: span.start.line, column: span.start.column, nodeId: node.id }),
  );
}

function directFail(code: ReferenceVisualEffectErrorCode, detail: string): never {
  throw new ReferenceVisualEffectError(code, undefined, detail);
}

function finiteQuantity(node: IRNode, name: string, value: IRValue | undefined, dimension: string, unit: string, required: boolean) {
  if (value === undefined) {
    if (required) fail(node, `requires input “${name}”.`, "CUT_VISUAL_EFFECT_INPUT");
    return undefined;
  }
  if (value.kind !== "quantity" || value.dimension !== dimension || value.unit !== unit) {
    fail(node, `input “${name}” must be a ${dimension} quantity in ${unit}.`, "CUT_VISUAL_EFFECT_INPUT");
  }
  const number = rationalToNumber(value.magnitude);
  if (!Number.isFinite(number)) fail(node, `input “${name}” must be finite.`, "CUT_VISUAL_EFFECT_RANGE");
  return number;
}

function bounded(node: IRNode, name: string, value: number, minimum: number, maximum: number) {
  if (value < minimum || value > maximum) fail(node, `input “${name}” must be between ${minimum} and ${maximum}.`, "CUT_VISUAL_EFFECT_RANGE");
  return value;
}

function gaussianRadius(node: IRNode, name: string, value: IRValue | undefined, fallback?: number, maximum: number = referenceVisualEffectLimits.maximumGaussianSigmaPx) {
  const number = finiteQuantity(node, name, value, "length", "px", fallback === undefined);
  const radius = number ?? fallback!;
  bounded(node, name, radius, 0, maximum);
  if (radius > 0 && radius < 0.3) fail(node, `input “${name}” must be 0px or at least 0.3px because the bounded libvips Gaussian kernel cannot execute a smaller sigma.`, "CUT_VISUAL_EFFECT_RANGE");
  return radius;
}

function ratio(node: IRNode, name: string, value: IRValue | undefined, fallback: number, positive = false) {
  const result = finiteQuantity(node, name, value, "ratio", "ratio", false) ?? fallback;
  bounded(node, name, result, 0, 1);
  if (positive && result === 0) fail(node, `input “${name}” must be greater than 0 and at most 1.`, "CUT_VISUAL_EFFECT_RANGE");
  return result;
}

function color(node: IRNode, name: string, value: IRValue | undefined, fallback: string) {
  if (value === undefined) return fallback;
  if (value.kind !== "color" || !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(value.value)) fail(node, `input “${name}” must be a six- or eight-digit CUT color literal.`, "CUT_VISUAL_EFFECT_COLOR");
  return value.value.toLowerCase();
}

function integerOffset(node: IRNode, name: string, value: IRValue | undefined, fallback: number, maximumMagnitude: number) {
  const result = finiteQuantity(node, name, value, "length", "px", false) ?? fallback;
  if (!Number.isSafeInteger(result)) fail(node, `input “${name}” must resolve to an exact integer pixel offset in the CPU reference backend.`, "CUT_VISUAL_EFFECT_RANGE");
  return bounded(node, name, result, -maximumMagnitude, maximumMagnitude);
}

function exactScalarInteger(node: IRNode, name: string, value: IRValue | undefined, fallback: number, minimum: number, maximum: number) {
  const result = finiteQuantity(node, name, value, "scalar", "scalar", false) ?? fallback;
  if (!Number.isSafeInteger(result)) fail(node, `input “${name}” must resolve to an exact integer.`, "CUT_VISUAL_EFFECT_RANGE");
  return bounded(node, name, result, minimum, maximum);
}

function exactPixelSize(node: IRNode, name: string, value: IRValue | undefined, fallback: number) {
  const result = finiteQuantity(node, name, value, "length", "px", false) ?? fallback;
  if (!Number.isSafeInteger(result)) fail(node, `input “${name}” must resolve to an exact integer pixel size.`, "CUT_VISUAL_EFFECT_RANGE");
  return bounded(node, name, result, 1, referenceVisualEffectLimits.maximumGrainSizePx);
}

function booleanInput(node: IRNode, name: string, value: IRValue | undefined, fallback: boolean) {
  if (value === undefined) return fallback;
  if (value.kind !== "boolean") fail(node, `input “${name}” must be Boolean.`, "CUT_VISUAL_EFFECT_INPUT");
  return value.value;
}

function stringInput<T extends string>(node: IRNode, name: string, value: IRValue | undefined, fallback: T, values: readonly T[]): T {
  if (value === undefined) return fallback;
  if (value.kind !== "string" || !values.includes(value.value as T)) fail(node, `input “${name}” must be one of ${values.join(", ")}.`, "CUT_VISUAL_EFFECT_INPUT");
  return value.value as T;
}

function opaqueColor(node: IRNode, name: string, value: IRValue | undefined, fallback: string) {
  const result = color(node, name, value, fallback);
  if (!/^#[0-9a-f]{6}$/i.test(result)) fail(node, `input “${name}” must be an opaque six-digit CUT color; Duotone preserves source alpha rather than consuming swatch alpha.`, "CUT_VISUAL_EFFECT_COLOR");
  return result;
}

/**
 * Parse and bound every executable parameter before a cache lookup or native
 * image operation. Undefined means this node is not a visual-effect kernel.
 */
export function referenceVisualEffectConfig(node: IRNode): ReferenceVisualEffectConfig | undefined {
  if (!visualEffectOps.has(node.op)) return undefined;
  if (node.children.length !== 1) fail(node, `requires exactly one visual child; found ${node.children.length}.`, "CUT_VISUAL_EFFECT_SHAPE");
  if (node.op === "cut.visual.blur") return { kind: "blur", radius: gaussianRadius(node, "radius", node.inputs.radius) };
  if (node.op === "cut.visual.shadow") return {
    kind: "shadow",
    x: integerOffset(node, "x", node.inputs.x, 0, referenceVisualEffectLimits.maximumOffsetPx),
    y: integerOffset(node, "y", node.inputs.y, 8, referenceVisualEffectLimits.maximumOffsetPx),
    radius: gaussianRadius(node, "radius", node.inputs.radius, 12),
    color: color(node, "color", node.inputs.color, "#000000"),
    opacity: ratio(node, "opacity", node.inputs.opacity, 0.5),
  };
  if (node.op === "cut.visual.glow") return {
    kind: "glow",
    radius: gaussianRadius(node, "radius", node.inputs.radius, 16),
    color: color(node, "color", node.inputs.color, "#ffffff"),
    opacity: ratio(node, "opacity", node.inputs.opacity, 0.5),
  };
  if (node.op === "cut.visual.vignette") return {
    kind: "vignette",
    amount: ratio(node, "amount", node.inputs.amount, 0.4),
    radius: ratio(node, "radius", node.inputs.radius, 0.5),
    softness: ratio(node, "softness", node.inputs.softness, 0.5, true),
    color: color(node, "color", node.inputs.color, "#000000"),
  };
  if (node.op === "cut.visual.sharpen") return {
    kind: "sharpen",
    radius: gaussianRadius(node, "radius", node.inputs.radius, 1, referenceVisualEffectLimits.maximumSharpenSigmaPx),
    amount: ratio(node, "amount", node.inputs.amount, 1),
  };
  if (node.op === "cut.visual.grain") return {
    kind: "grain",
    amount: ratio(node, "amount", node.inputs.amount, 0.08),
    size: exactPixelSize(node, "size", node.inputs.size, 1),
    seed: exactScalarInteger(node, "seed", node.inputs.seed, 0, 0, referenceVisualEffectLimits.maximumSeed),
    mode: stringInput(node, "mode", node.inputs.mode, "static", ["static", "temporal"] as const),
    monochrome: booleanInput(node, "monochrome", node.inputs.monochrome, true),
  };
  if (node.op === "cut.visual.duotone") return {
    kind: "duotone",
    shadows: opaqueColor(node, "shadows", node.inputs.shadows, "#000000"),
    highlights: opaqueColor(node, "highlights", node.inputs.highlights, "#ffffff"),
    amount: ratio(node, "amount", node.inputs.amount, 1),
  };
  fail(node, "has no executable visual-effect configuration.", "CUT_VISUAL_EFFECT_INPUT");
}

function validateSurface(surface: RgbaSurface) {
  if (!(surface.data instanceof Uint8Array)) directFail("CUT_VISUAL_EFFECT_SURFACE", "CUT visual effect input data must be an RGBA Uint8Array or Buffer.");
  if (!Number.isSafeInteger(surface.width) || !Number.isSafeInteger(surface.height) || surface.width < 1 || surface.height < 1) directFail("CUT_VISUAL_EFFECT_SURFACE", "CUT visual effect dimensions must be positive safe integers.");
  const pixels = surface.width * surface.height;
  if (!Number.isSafeInteger(pixels) || pixels > referenceVisualEffectLimits.maximumCanvasPixels) directFail("CUT_VISUAL_EFFECT_SURFACE", "CUT visual effect input exceeds the 16,777,216-pixel CPU budget.");
  if (surface.data.byteLength !== pixels * 4) directFail("CUT_VISUAL_EFFECT_SURFACE", "CUT visual effect RGBA buffer length must equal width x height x 4.");
  if (surface.alphaMode && surface.alphaMode !== "straight") directFail("CUT_VISUAL_EFFECT_SURFACE", "CUT visual effects require a straight-alpha RGBA boundary; premultiplied surfaces must be converted before the effect chain.");
}

function validateExecutableConfig(config: ReferenceVisualEffectConfig) {
  const radius = config.kind === "blur" || config.kind === "shadow" || config.kind === "glow" || config.kind === "sharpen" ? config.radius : undefined;
  const maximumRadius = config.kind === "sharpen" ? referenceVisualEffectLimits.maximumSharpenSigmaPx : referenceVisualEffectLimits.maximumGaussianSigmaPx;
  if (radius !== undefined && (!Number.isFinite(radius) || radius < 0 || radius > maximumRadius || radius > 0 && radius < 0.3)) {
    directFail("CUT_VISUAL_EFFECT_RANGE", `CUT visual effect radius must be 0 or a finite Gaussian sigma from 0.3 through ${maximumRadius} pixels.`);
  }
  if (config.kind === "shadow") {
    if (!Number.isSafeInteger(config.x) || !Number.isSafeInteger(config.y) || Math.abs(config.x) > referenceVisualEffectLimits.maximumOffsetPx || Math.abs(config.y) > referenceVisualEffectLimits.maximumOffsetPx) directFail("CUT_VISUAL_EFFECT_RANGE", "CUT shadow offsets must be exact integers from -4096 through 4096 pixels.");
  }
  if (config.kind === "shadow" || config.kind === "glow") {
    if (!Number.isFinite(config.opacity) || config.opacity < 0 || config.opacity > 1) directFail("CUT_VISUAL_EFFECT_RANGE", "CUT halo opacity must be a finite ratio from 0 through 1.");
    parseColor(config.color);
  }
  if (config.kind === "vignette") {
    if (![config.amount, config.radius, config.softness].every(Number.isFinite) || config.amount < 0 || config.amount > 1 || config.radius < 0 || config.radius > 1 || config.softness <= 0 || config.softness > 1) directFail("CUT_VISUAL_EFFECT_RANGE", "CUT vignette amount/radius must be finite ratios from 0 through 1 and softness must be greater than 0 through 1.");
    parseColor(config.color);
  }
  if (config.kind === "sharpen" && (!Number.isFinite(config.amount) || config.amount < 0 || config.amount > 1)) directFail("CUT_VISUAL_EFFECT_RANGE", "CUT sharpen amount must be a finite ratio from 0 through 1.");
  if (config.kind === "grain") {
    if (!Number.isFinite(config.amount) || config.amount < 0 || config.amount > 1) directFail("CUT_VISUAL_EFFECT_RANGE", "CUT grain amount must be a finite ratio from 0 through 1.");
    if (!Number.isSafeInteger(config.size) || config.size < 1 || config.size > referenceVisualEffectLimits.maximumGrainSizePx) directFail("CUT_VISUAL_EFFECT_RANGE", `CUT grain size must be an exact integer from 1 through ${referenceVisualEffectLimits.maximumGrainSizePx} pixels.`);
    if (!Number.isSafeInteger(config.seed) || config.seed < 0 || config.seed > referenceVisualEffectLimits.maximumSeed) directFail("CUT_VISUAL_EFFECT_RANGE", `CUT grain seed must be an exact integer from 0 through ${referenceVisualEffectLimits.maximumSeed}.`);
    if (config.mode !== "static" && config.mode !== "temporal") directFail("CUT_VISUAL_EFFECT_INPUT", "CUT grain mode must be static or temporal.");
    if (typeof config.monochrome !== "boolean") directFail("CUT_VISUAL_EFFECT_INPUT", "CUT grain monochrome must be Boolean.");
  }
  if (config.kind === "duotone") {
    if (!Number.isFinite(config.amount) || config.amount < 0 || config.amount > 1) directFail("CUT_VISUAL_EFFECT_RANGE", "CUT duotone amount must be a finite ratio from 0 through 1.");
    if (!/^#[0-9a-f]{6}$/i.test(config.shadows) || !/^#[0-9a-f]{6}$/i.test(config.highlights)) directFail("CUT_VISUAL_EFFECT_COLOR", "CUT duotone endpoints must be opaque six-digit colors.");
  }
}

function parseColor(value: string): RgbaColor {
  const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(value);
  if (!match) directFail("CUT_VISUAL_EFFECT_COLOR", `Invalid bounded CUT effect color “${value}”.`);
  return [Number.parseInt(match[1].slice(0, 2), 16), Number.parseInt(match[1].slice(2, 4), 16), Number.parseInt(match[1].slice(4, 6), 16), match[2] ? Number.parseInt(match[2], 16) : 255];
}

const codeValueScale16 = 257;

/**
 * Convert the public straight 8-bit boundary to associated 16-bit encoded
 * sRGB. Keeping sixteen bits is semantically important: independent 8-bit
 * numerator/coverage filtering can turn a neutral low-coverage pixel black or
 * white when it is unassociated again.
 */
function premultiplyEncodedSrgb16(surface: RgbaSurface) {
  const output = new Uint16Array(surface.width * surface.height * 4);
  for (let offset = 0; offset < output.length; offset += 4) {
    const alpha = surface.data[offset + 3] * codeValueScale16;
    output[offset] = Math.round(surface.data[offset] * alpha / 255);
    output[offset + 1] = Math.round(surface.data[offset + 1] * alpha / 255);
    output[offset + 2] = Math.round(surface.data[offset + 2] * alpha / 255);
    output[offset + 3] = alpha;
  }
  return output;
}

/**
 * libvips performs the Gaussian in associated-alpha space and returns
 * unassociated rgb16 samples. The explicit rgb16 pipeline prevents the native
 * pipeline from collapsing the low-coverage numerator and alpha to unrelated
 * 8-bit integers before that division.
 */
async function gaussianStraightSrgb16(surface: RgbaSurface, radius: number) {
  const premultiplied = premultiplyEncodedSrgb16(surface);
  const { data, info } = await sharp(premultiplied, {
    raw: { width: surface.width, height: surface.height, channels: 4, premultiplied: true },
  })
    .pipelineColourspace("rgb16")
    .blur(radius)
    .toColourspace("rgb16")
    .raw({ depth: "ushort" })
    .toBuffer({ resolveWithObject: true });
  if (info.width !== surface.width || info.height !== surface.height || info.channels !== 4 || data.byteLength !== surface.width * surface.height * 8) {
    directFail("CUT_VISUAL_EFFECT_SURFACE", "CUT Gaussian backend returned an invalid four-channel rgb16 surface.");
  }
  return new Uint16Array(data.buffer, data.byteOffset, data.byteLength / Uint16Array.BYTES_PER_ELEMENT);
}

async function gaussianBlur(surface: RgbaSurface, radius: number): Promise<MutableSurface> {
  if (radius === 0) return { data: Buffer.from(surface.data), width: surface.width, height: surface.height };
  const blurred = await gaussianStraightSrgb16(surface, radius), output = Buffer.alloc(surface.data.byteLength);
  for (let offset = 0; offset < output.length; offset += 4) {
    const alpha = Math.max(0, Math.min(255, Math.round(blurred[offset + 3] / codeValueScale16)));
    output[offset + 3] = alpha;
    if (alpha === 0) continue;
    output[offset] = Math.max(0, Math.min(255, Math.round(blurred[offset] / codeValueScale16)));
    output[offset + 1] = Math.max(0, Math.min(255, Math.round(blurred[offset + 1] / codeValueScale16)));
    output[offset + 2] = Math.max(0, Math.min(255, Math.round(blurred[offset + 2] / codeValueScale16)));
  }
  return { data: output, width: surface.width, height: surface.height };
}

/**
 * Alpha-aware unsharp mask. A single associated rgb16 Gaussian keeps filtered
 * color and coverage coupled until libvips recovers the unassociated
 * neighborhood. The source alpha plane is copied byte-for-byte. Fully
 * transparent pixels retain their hidden RGB. If an extremely low-coverage
 * neighborhood falls below one 16-bit alpha code, the source color is left
 * unchanged instead of manufacturing contrast from an undefined division.
 */
async function sharpen(surface: RgbaSurface, radius: number, amount: number): Promise<MutableSurface> {
  if (radius === 0 || amount === 0) return { data: Buffer.from(surface.data), width: surface.width, height: surface.height };
  const blurred = await gaussianStraightSrgb16(surface, radius);
  const output = Buffer.from(surface.data);
  for (let offset = 0; offset < output.length; offset += 4) {
    if (surface.data[offset + 3] === 0 || blurred[offset + 3] === 0) continue;
    for (let channel = 0; channel < 3; channel += 1) {
      const neighborhood = Math.max(0, Math.min(255, blurred[offset + channel] / codeValueScale16));
      const sharpened = surface.data[offset + channel] + amount * (surface.data[offset + channel] - neighborhood);
      output[offset + channel] = Math.max(0, Math.min(255, Math.round(sharpened)));
    }
  }
  return { data: output, width: surface.width, height: surface.height };
}

async function blurredAlpha(surface: RgbaSurface, radius: number) {
  const alpha = Buffer.alloc(surface.width * surface.height);
  for (let source = 3, target = 0; source < surface.data.byteLength; source += 4, target += 1) alpha[target] = surface.data[source];
  if (radius === 0) return alpha;
  // libvips promotes a raw single-band image to sRGB after blur unless the
  // band is selected explicitly. Keep this a one-byte coverage plane so pixel
  // indexing cannot silently drift to RGB triplets.
  return sharp(alpha, { raw: { width: surface.width, height: surface.height, channels: 1 } }).blur(radius).extractChannel(0).raw().toBuffer();
}

async function halo(surface: RgbaSurface, radius: number, x: number, y: number, colorValue: string, opacity: number): Promise<MutableSurface> {
  const coverage = await blurredAlpha(surface, radius), [red, green, blue, colorAlpha] = parseColor(colorValue), output = Buffer.alloc(surface.data.byteLength);
  const multiplier = opacity * colorAlpha / 255;
  for (let targetY = 0; targetY < surface.height; targetY += 1) {
    const sourceY = targetY - y;
    if (sourceY < 0 || sourceY >= surface.height) continue;
    for (let targetX = 0; targetX < surface.width; targetX += 1) {
      const sourceX = targetX - x;
      if (sourceX < 0 || sourceX >= surface.width) continue;
      const alpha = Math.round(coverage[sourceY * surface.width + sourceX] * multiplier), offset = (targetY * surface.width + targetX) * 4;
      output[offset] = red; output[offset + 1] = green; output[offset + 2] = blue; output[offset + 3] = alpha;
    }
  }
  return { data: output, width: surface.width, height: surface.height };
}

function linearToSrgb(value: number) {
  const bounded = Math.max(0, Math.min(1, value));
  return bounded <= 0.0031308 ? bounded * 12.92 : 1.055 * bounded ** (1 / 2.4) - 0.055;
}

function smoothstep(value: number) {
  const bounded = Math.max(0, Math.min(1, value));
  return bounded * bounded * (3 - 2 * bounded);
}

function vignette(surface: RgbaSurface, config: Extract<ReferenceVisualEffectConfig, { kind: "vignette" }>): MutableSurface {
  const [red, green, blue, colorAlpha] = parseColor(config.color), tint = [srgbToLinearBytes[red], srgbToLinearBytes[green], srgbToLinearBytes[blue]], output = Buffer.from(surface.data);
  const centerX = surface.width / 2, centerY = surface.height / 2, halfWidth = surface.width / 2, halfHeight = surface.height / 2;
  for (let y = 0; y < surface.height; y += 1) {
    for (let x = 0; x < surface.width; x += 1) {
      const offset = (y * surface.width + x) * 4;
      if (surface.data[offset + 3] === 0) continue;
      const normalizedX = (x + 0.5 - centerX) / halfWidth, normalizedY = (y + 0.5 - centerY) / halfHeight;
      const distance = Math.min(1, Math.hypot(normalizedX, normalizedY) / Math.SQRT2);
      const coverage = config.amount * (colorAlpha / 255) * smoothstep((distance - config.radius) / config.softness);
      for (let channel = 0; channel < 3; channel += 1) {
        const mixed = srgbToLinearBytes[surface.data[offset + channel]] * (1 - coverage) + tint[channel] * coverage;
        output[offset + channel] = Math.round(linearToSrgb(mixed) * 255);
      }
    }
  }
  return { data: output, width: surface.width, height: surface.height };
}

function mix32(value: number) {
  let mixed = value >>> 0;
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x7feb_352d);
  mixed = Math.imul(mixed ^ (mixed >>> 15), 0x846c_a68b);
  return (mixed ^ (mixed >>> 16)) >>> 0;
}

function grainSample(seed: number, cellX: number, cellY: number, frame: number, channel: number) {
  let state = seed >>> 0;
  state = mix32(state ^ Math.imul((cellX + 1) >>> 0, 0x9e37_79b1));
  state = mix32(state ^ Math.imul((cellY + 1) >>> 0, 0x85eb_ca77));
  state = mix32(state ^ Math.imul((frame + 1) >>> 0, 0xc2b2_ae3d));
  state = mix32(state ^ Math.imul((channel + 1) >>> 0, 0x27d4_eb2f));
  return state / 0xffff_ffff * 2 - 1;
}

function grain(surface: RgbaSurface, config: Extract<ReferenceVisualEffectConfig, { kind: "grain" }>, frame: number): MutableSurface {
  if (config.amount === 0) return { data: Buffer.from(surface.data), width: surface.width, height: surface.height };
  const output = Buffer.from(surface.data), phase = config.mode === "temporal" ? frame : 0;
  const amplitude = config.amount * referenceVisualEffectLimits.grainMaximumCodeValueExcursion;
  const cellRows = Math.ceil(surface.height / config.size);
  const cellColumns = Math.ceil(surface.width / config.size);
  for (let cellY = 0; cellY < cellRows; cellY += 1) {
    const firstY = cellY * config.size;
    const lastY = Math.min(surface.height, firstY + config.size);
    for (let cellX = 0; cellX < cellColumns; cellX += 1) {
      const firstX = cellX * config.size;
      const lastX = Math.min(surface.width, firstX + config.size);
      let redNoise = 0, greenNoise = 0, blueNoise = 0, sampled = false;
      for (let y = firstY; y < lastY; y += 1) {
        for (let x = firstX; x < lastX; x += 1) {
          const offset = (y * surface.width + x) * 4;
          if (surface.data[offset + 3] === 0) continue;
          if (!sampled) {
            // Grain is constant within one authored cell. Compute its
            // deterministic sample once per nonempty cell rather than
            // repeating the same integer hash for every covered pixel.
            // Channel zero is also the monochrome sample, so color grain needs
            // exactly three samples rather than four. Deferring until the
            // first covered pixel preserves the old transparent-cell bypass.
            redNoise = grainSample(config.seed, cellX, cellY, phase, 0);
            greenNoise = config.monochrome ? redNoise : grainSample(config.seed, cellX, cellY, phase, 1);
            blueNoise = config.monochrome ? redNoise : grainSample(config.seed, cellX, cellY, phase, 2);
            sampled = true;
          }
          output[offset] = Math.max(0, Math.min(255, Math.round(surface.data[offset] + redNoise * amplitude)));
          output[offset + 1] = Math.max(0, Math.min(255, Math.round(surface.data[offset + 1] + greenNoise * amplitude)));
          output[offset + 2] = Math.max(0, Math.min(255, Math.round(surface.data[offset + 2] + blueNoise * amplitude)));
        }
      }
    }
  }
  return { data: output, width: surface.width, height: surface.height };
}

function duotone(surface: RgbaSurface, config: Extract<ReferenceVisualEffectConfig, { kind: "duotone" }>): MutableSurface {
  if (config.amount === 0) return { data: Buffer.from(surface.data), width: surface.width, height: surface.height };
  const shadows = parseColor(config.shadows).slice(0, 3).map((value) => srgbToLinearBytes[value]);
  const highlights = parseColor(config.highlights).slice(0, 3).map((value) => srgbToLinearBytes[value]);
  const output = Buffer.from(surface.data);
  for (let offset = 0; offset < output.length; offset += 4) {
    if (surface.data[offset + 3] === 0) continue;
    const source = [
      srgbToLinearBytes[surface.data[offset]],
      srgbToLinearBytes[surface.data[offset + 1]],
      srgbToLinearBytes[surface.data[offset + 2]],
    ];
    const luminance = source[0] * 0.2126 + source[1] * 0.7152 + source[2] * 0.0722;
    for (let channel = 0; channel < 3; channel += 1) {
      const mapped = shadows[channel] * (1 - luminance) + highlights[channel] * luminance;
      const mixed = source[channel] * (1 - config.amount) + mapped * config.amount;
      output[offset + channel] = Math.round(linearToSrgb(mixed) * 255);
    }
  }
  return { data: output, width: surface.width, height: surface.height };
}

/** Execute one already-validated unary effect without changing canvas size. */
export async function applyReferenceVisualEffect(config: ReferenceVisualEffectConfig, surface: RgbaSurface, context: { frame?: number } = {}): Promise<MutableSurface> {
  validateSurface(surface); validateExecutableConfig(config);
  if (config.kind === "blur") return gaussianBlur(surface, config.radius);
  if (config.kind === "vignette") return vignette(surface, config);
  if (config.kind === "sharpen") return sharpen(surface, config.radius, config.amount);
  if (config.kind === "grain") {
    const frame = config.mode === "temporal" ? context.frame : 0;
    if (!Number.isSafeInteger(frame) || frame! < 0 || frame! > referenceVisualEffectLimits.maximumFrameIndex) directFail("CUT_VISUAL_EFFECT_FRAME", `CUT temporal grain needs an exact output-frame index from 0 through ${referenceVisualEffectLimits.maximumFrameIndex}.`);
    return grain(surface, config, frame!);
  }
  if (config.kind === "duotone") return duotone(surface, config);
  const haloSurface = await halo(surface, config.radius, config.kind === "shadow" ? config.x : 0, config.kind === "shadow" ? config.y : 0, config.color, config.opacity);
  const result = compositeRgba(haloSurface, surface);
  return { data: Buffer.from(result.data), width: result.width, height: result.height };
}
