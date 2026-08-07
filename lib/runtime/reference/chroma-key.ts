import type { CutAVIR, IRComposition, IRNode, IRValue } from "../../language/ir";
import { addRational, compareRational, rational, rationalToNumber, zeroRational } from "../../language/rational";
import type { RgbaCompositeResult, RgbaSurface } from "./compositing";

export type ReferenceChromaKeyErrorCode =
  | "CUT_CHROMA_KEY_GRAPH"
  | "CUT_CHROMA_KEY_INPUT_TYPE"
  | "CUT_CHROMA_KEY_COLOR"
  | "CUT_CHROMA_KEY_COLOR_SPACE"
  | "CUT_CHROMA_KEY_RANGE"
  | "CUT_CHROMA_KEY_NOOP"
  | "CUT_CHROMA_KEY_RESOURCE_LIMIT"
  | "CUT_CHROMA_KEY_SURFACE";

export class ReferenceChromaKeyError extends Error {
  readonly source: { module: string; line: number; column: number; nodeId: string };

  constructor(readonly code: ReferenceChromaKeyErrorCode, readonly node: IRNode, message: string) {
    const { module, span } = node.provenance;
    super(`${code}: ${node.op} at ${module}:${span.start.line}:${span.start.column} ${message}`);
    this.name = "ReferenceChromaKeyError";
    this.source = { module, line: span.start.line, column: span.start.column, nodeId: node.id };
  }
}

export const referenceChromaKeyLimits = Object.freeze({
  minimumNonzeroRatio: 1 / 255,
  maximumMatteWindow: 1 / 2,
  minimumNormalizedKeyChroma: 1 / 10,
  maximumCanvasPixels: 16_777_216,
  maximumNodesPerComposition: 64,
  maximumAggregatePixelsPerComposition: 67_108_864,
});

export type ReferenceChromaKeyConfig = Readonly<{
  key: readonly [red: number, green: number, blue: number];
  keyCb: number;
  keyCr: number;
  tolerance: number;
  softness: number;
  spill: number;
}>;

export type ReferenceChromaKeyExecutionOptions = Readonly<{
  /** @internal Allocation seam used to prove validation precedes output allocation. */
  allocateOutput?: (bytes: number) => Uint8Array;
}>;

const chromaKeyInputs = new Set(["key", "tolerance", "softness", "spill"]);
const minimumNonzeroRatio = rational(1, 255);
const maximumMatteWindow = rational(1, 2);

function fail(node: IRNode, code: ReferenceChromaKeyErrorCode, message: string): never {
  throw new ReferenceChromaKeyError(code, node, message);
}

function ratio(
  node: IRNode,
  name: "tolerance" | "softness" | "spill",
  value: IRValue | undefined,
  fallback: number,
) {
  if (value === undefined) return { exact: rational(Math.round(fallback * 100), 100), value: fallback };
  if (value.kind !== "quantity" || value.dimension !== "ratio" || value.unit !== "ratio") {
    fail(node, "CUT_CHROMA_KEY_INPUT_TYPE", `input “${name}” must be a canonical Ratio.`);
  }
  try {
    if (compareRational(value.magnitude, zeroRational) < 0 || compareRational(value.magnitude, rational(1)) > 0) {
      fail(node, "CUT_CHROMA_KEY_RANGE", `input “${name}” must be from 0% through 100%, inclusive.`);
    }
    if (compareRational(value.magnitude, zeroRational) > 0 && compareRational(value.magnitude, minimumNonzeroRatio) < 0) {
      fail(node, "CUT_CHROMA_KEY_RANGE", `input “${name}” must be 0% or at least 1/255 (${(100 / 255).toFixed(6)}%) so it can affect the 8-bit reference boundary.`);
    }
    const number = rationalToNumber(value.magnitude);
    if (!Number.isFinite(number)) fail(node, "CUT_CHROMA_KEY_RANGE", `input “${name}” must resolve to a finite Ratio.`);
    return { exact: value.magnitude, value: number };
  } catch (error) {
    if (error instanceof ReferenceChromaKeyError) throw error;
    fail(node, "CUT_CHROMA_KEY_INPUT_TYPE", `input “${name}” must contain a canonical exact rational.`);
  }
}

function encodedChroma(red: number, green: number, blue: number) {
  const luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  return {
    cb: (blue - luma) / 1.8556,
    cr: (red - luma) / 1.5748,
  };
}

function keyColor(node: IRNode, value: IRValue | undefined) {
  if (value?.kind !== "color" || !/^#[0-9a-f]{6}$/i.test(value.value)) {
    fail(node, "CUT_CHROMA_KEY_COLOR", "input “key” must be one opaque six-digit CUT color literal; alpha-bearing and non-color keys are refused.");
  }
  const key = [
    Number.parseInt(value.value.slice(1, 3), 16) / 255,
    Number.parseInt(value.value.slice(3, 5), 16) / 255,
    Number.parseInt(value.value.slice(5, 7), 16) / 255,
  ] as const;
  const { cb, cr } = encodedChroma(...key);
  const normalizedChroma = Math.hypot(cb, cr) / Math.sqrt(0.5);
  if (normalizedChroma < referenceChromaKeyLimits.minimumNormalizedKeyChroma) {
    fail(node, "CUT_CHROMA_KEY_COLOR", `input “key” has normalized chroma ${normalizedChroma.toFixed(6)}; reliable chroma keys require at least ${referenceChromaKeyLimits.minimumNormalizedKeyChroma.toFixed(1)} away from neutral.`);
  }
  return { key, keyCb: cb, keyCr: cr };
}

type ChromaKeySurfaceSpace = "srgb" | "linear-srgb" | "rec709-full" | "rec709-limited";
const chromaKeySurfaceSpaces = new Set<ChromaKeySurfaceSpace>(["srgb", "linear-srgb", "rec709-full", "rec709-limited"]);

/**
 * ChromaKey consumes encoded-sRGB bytes. Until retained surfaces carry color
 * metadata, prove that no non-sRGB ColorConvert output crosses an intervening
 * visual consumer or the key boundary. An explicit outer conversion back to
 * sRGB is accepted because its output bytes have the required encoding.
 */
export function validateReferenceChromaKeyInputColorSpace(ir: CutAVIR, keyNode: IRNode) {
  const visiting = new Set<string>(), memo = new Map<string, ChromaKeySurfaceSpace>();
  const failSpace = (message: string): never => fail(keyNode, "CUT_CHROMA_KEY_COLOR_SPACE", message);
  const outputSpace = (nodeId: string): ChromaKeySurfaceSpace => {
    const cached = memo.get(nodeId);
    if (cached) return cached;
    if (visiting.has(nodeId)) failSpace(`cannot prove encoded-sRGB input through a visual cycle at ${nodeId}.`);
    const node = ir.nodes[nodeId];
    if (!node) fail(keyNode, "CUT_CHROMA_KEY_GRAPH", `input-space proof references missing node ${nodeId}.`);
    visiting.add(nodeId);

    if (node.op === "cut.visual.color_convert") {
      if (node.children.length !== 1) failSpace(`ColorConvert ${node.id} must have exactly one child before its output space can be proven.`);
      outputSpace(node.children[0]);
      const to = node.inputs.to;
      if (to?.kind !== "string" || !chromaKeySurfaceSpaces.has(to.value as ChromaKeySurfaceSpace)) {
        return failSpace(`ColorConvert ${node.id} has no supported closed output color space.`);
      }
      const result = to.value as ChromaKeySurfaceSpace;
      visiting.delete(nodeId); memo.set(nodeId, result); return result;
    }

    const childIds = [...node.children];
    if (node.op === "cut.visual.precomp" || node.op === "cut.edit.nested_sequence") {
      const source = node.inputs.source;
      if (source?.kind !== "timeline-ref") return failSpace(`${node.op} ${node.id} has no provable source composition.`);
      const composition = ir.compositions.find((candidate) => candidate.id === source.id);
      if (!composition) return failSpace(`${node.op} ${node.id} references missing source composition ${source.id}.`);
      childIds.push(...composition.rootVisualIds, ...composition.rootAVIds);
      for (const sceneId of composition.sceneIds) {
        const scene = ir.scenes[sceneId];
        if (scene) childIds.push(...scene.rootVisualIds, ...scene.rootAVIds);
      }
    }
    for (const childId of childIds) {
      const child = ir.nodes[childId];
      if (!child || (child.domain !== "visual" && child.domain !== "av")) continue;
      const childSpace = outputSpace(childId);
      if (childSpace !== "srgb") {
        failSpace(`${node.op} ${node.id} would consume ${childSpace} bytes from ${child.op}; retained-surface color metadata is not propagated, so convert back to srgb before this wrapper.`);
      }
    }
    visiting.delete(nodeId); memo.set(nodeId, "srgb"); return "srgb";
  };

  const childSpace = outputSpace(keyNode.children[0]);
  if (childSpace !== "srgb") {
    failSpace(`requires straight encoded-sRGB child bytes; child ${keyNode.children[0]} produces ${childSpace}. Add ColorConvert(from: "${childSpace}", to: "srgb") before ChromaKey.`);
  }
}

/** Close the public ChromaKey graph and all static controls before cache lookup. */
export function referenceChromaKeyConfig(ir: CutAVIR, node: IRNode): ReferenceChromaKeyConfig | undefined {
  if (node.op !== "cut.visual.chroma_key") return undefined;
  for (const input of Object.keys(node.inputs)) {
    if (!chromaKeyInputs.has(input)) fail(node, "CUT_CHROMA_KEY_INPUT_TYPE", `does not execute input “${input}”; refusing a silent no-op.`);
  }
  const property = Object.keys(node.properties)[0];
  if (property !== undefined) fail(node, "CUT_CHROMA_KEY_INPUT_TYPE", `does not execute property “${property}”; refusing a silent no-op.`);
  if (node.domain !== "visual") fail(node, "CUT_CHROMA_KEY_GRAPH", `must have visual domain; found ${node.domain}.`);
  if (node.children.length !== 1) fail(node, "CUT_CHROMA_KEY_GRAPH", `requires exactly one visual child; found ${node.children.length}.`);
  const child = ir.nodes[node.children[0]];
  if (!child || child.domain !== "visual") fail(node, "CUT_CHROMA_KEY_GRAPH", `child ${node.children[0]} must resolve to one visual node.`);
  validateReferenceChromaKeyInputColorSpace(ir, node);

  const parsedKey = keyColor(node, node.inputs.key);
  const tolerance = ratio(node, "tolerance", node.inputs.tolerance, 0.12);
  const softness = ratio(node, "softness", node.inputs.softness, 0.08);
  const spill = ratio(node, "spill", node.inputs.spill, 0.5);
  try {
    if (compareRational(addRational(tolerance.exact, softness.exact), maximumMatteWindow) > 0) {
      fail(node, "CUT_CHROMA_KEY_RANGE", "inputs “tolerance” + “softness” must not exceed 50% of the normalized chroma-distance envelope.");
    }
    if (compareRational(spill.exact, zeroRational) > 0
      && compareRational(tolerance.exact, zeroRational) === 0
      && compareRational(softness.exact, zeroRational) === 0) {
      fail(node, "CUT_CHROMA_KEY_NOOP", "nonzero “spill” needs a positive tolerance or softness band; exact-only removed pixels have no retained color to despill.");
    }
  } catch (error) {
    if (error instanceof ReferenceChromaKeyError) throw error;
    fail(node, "CUT_CHROMA_KEY_INPUT_TYPE", "ratio controls must contain canonical exact rationals.");
  }
  return Object.freeze({
    ...parsedKey,
    tolerance: tolerance.value,
    softness: softness.value,
    spill: spill.value,
  });
}

function canvasPixels(node: IRNode, width: number, height: number) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    fail(node, "CUT_CHROMA_KEY_RESOURCE_LIMIT", "canvas dimensions must be positive safe integers.");
  }
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > referenceChromaKeyLimits.maximumCanvasPixels) {
    fail(node, "CUT_CHROMA_KEY_RESOURCE_LIMIT", `canvas exceeds the ${referenceChromaKeyLimits.maximumCanvasPixels}-pixel ChromaKey budget.`);
  }
  return pixels;
}

/** Bound every reachable key pass for one composition before frame allocation. */
export function validateReferenceChromaKeyCompositionBudget(
  nodes: readonly IRNode[],
  width: number,
  height: number,
) {
  if (!nodes.length) return;
  const pixels = canvasPixels(nodes[0], width, height);
  if (nodes.length > referenceChromaKeyLimits.maximumNodesPerComposition) {
    fail(nodes[referenceChromaKeyLimits.maximumNodesPerComposition], "CUT_CHROMA_KEY_RESOURCE_LIMIT", `composition exceeds the ${referenceChromaKeyLimits.maximumNodesPerComposition}-ChromaKey-node limit.`);
  }
  const aggregate = pixels * nodes.length;
  if (!Number.isSafeInteger(aggregate) || aggregate > referenceChromaKeyLimits.maximumAggregatePixelsPerComposition) {
    fail(nodes[0], "CUT_CHROMA_KEY_RESOURCE_LIMIT", `composition requires ${aggregate} key-pixel passes; limit is ${referenceChromaKeyLimits.maximumAggregatePixelsPerComposition}.`);
  }
}

/** Resolve only executable child-reachable key wrappers for one composition. */
export function referenceChromaKeyNodesForComposition(ir: CutAVIR, composition: IRComposition) {
  const pending = [...composition.rootVisualIds, ...composition.rootAVIds];
  for (const sceneId of composition.sceneIds) {
    const scene = ir.scenes[sceneId];
    if (scene) pending.push(...scene.rootVisualIds, ...scene.rootAVIds);
  }
  const visited = new Set<string>(), result: IRNode[] = [];
  while (pending.length) {
    const id = pending.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = ir.nodes[id];
    if (!node) continue;
    if (node.op === "cut.visual.chroma_key") result.push(node);
    pending.push(...node.children);
  }
  return result.sort((left, right) => left.id.localeCompare(right.id));
}

function alphaMode(node: IRNode, surface: RgbaSurface) {
  const mode = surface.alphaMode ?? "straight";
  if (mode !== "straight" && mode !== "premultiplied") fail(node, "CUT_CHROMA_KEY_SURFACE", "surface alphaMode must be straight or premultiplied.");
  return mode;
}

function validateSurface(node: IRNode, surface: RgbaSurface) {
  if (!surface || typeof surface !== "object" || !(surface.data instanceof Uint8Array)) {
    fail(node, "CUT_CHROMA_KEY_SURFACE", "input must be an RGBA Uint8Array or Buffer surface.");
  }
  const pixels = canvasPixels(node, surface.width, surface.height);
  if (surface.data.byteLength !== pixels * 4) fail(node, "CUT_CHROMA_KEY_SURFACE", "RGBA buffer length must equal width × height × 4.");
  return alphaMode(node, surface);
}

const clampUnit = (value: number) => value <= 0 ? 0 : value >= 1 ? 1 : value;
const toByte = (value: number) => Math.round(clampUnit(value) * 255);

function straightEncoded(code: number, alpha: number, mode: "straight" | "premultiplied") {
  if (mode === "straight") return code / 255;
  return alpha <= 0 ? 0 : clampUnit((code / 255) / alpha);
}

function srgbToLinear(value: number) {
  const encoded = clampUnit(value);
  return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value: number) {
  const linear = clampUnit(value);
  return linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
}

function smoothstep(value: number) {
  const bounded = clampUnit(value);
  return bounded * bounded * (3 - 2 * bounded);
}

export function referenceChromaKeyKeepCoverage(distance: number, tolerance: number, softness: number) {
  if (distance <= tolerance) return 0;
  if (softness === 0 || distance >= tolerance + softness) return 1;
  return smoothstep((distance - tolerance) / softness);
}

export function referenceChromaKeySpillProximity(distance: number, tolerance: number, softness: number) {
  const outer = tolerance + softness, band = Math.max(tolerance, softness);
  if (distance <= outer) return 1;
  if (distance >= outer + band) return 0;
  return 1 - smoothstep((distance - outer) / band);
}

/**
 * Execute one validated, full-canvas ChromaKey pass. Key distance is measured
 * on unassociated encoded-sRGB Rec.709 Cb/Cr. Despill alone uses linear sRGB.
 */
export function applyReferenceChromaKey(
  node: IRNode,
  config: ReferenceChromaKeyConfig,
  surface: RgbaSurface,
  options: ReferenceChromaKeyExecutionOptions = {},
): RgbaCompositeResult {
  const mode = validateSurface(node, surface);
  const output = (options.allocateOutput ?? ((bytes) => new Uint8Array(bytes)))(surface.data.byteLength);
  if (!(output instanceof Uint8Array) || output.byteLength !== surface.data.byteLength) {
    fail(node, "CUT_CHROMA_KEY_SURFACE", "output allocator must return one exact-length Uint8Array.");
  }
  for (let offset = 0; offset < output.length; offset += 4) {
    const sourceAlphaByte = surface.data[offset + 3];
    if (sourceAlphaByte === 0) continue;
    const sourceAlpha = sourceAlphaByte / 255;
    const red = straightEncoded(surface.data[offset], sourceAlpha, mode);
    const green = straightEncoded(surface.data[offset + 1], sourceAlpha, mode);
    const blue = straightEncoded(surface.data[offset + 2], sourceAlpha, mode);
    const { cb, cr } = encodedChroma(red, green, blue);
    const distance = clampUnit(Math.hypot(cb - config.keyCb, cr - config.keyCr) / Math.SQRT2);
    const keep = referenceChromaKeyKeepCoverage(distance, config.tolerance, config.softness);
    const outputAlpha = Math.round(sourceAlphaByte * keep);
    if (outputAlpha === 0) continue;
    output[offset + 3] = outputAlpha;

    const despill = config.spill === 0
      ? 0
      : config.spill * referenceChromaKeySpillProximity(distance, config.tolerance, config.softness);
    if (despill === 0) {
      output[offset] = mode === "straight" ? surface.data[offset] : toByte(red);
      output[offset + 1] = mode === "straight" ? surface.data[offset + 1] : toByte(green);
      output[offset + 2] = mode === "straight" ? surface.data[offset + 2] : toByte(blue);
      continue;
    }

    const linear = [srgbToLinear(red), srgbToLinear(green), srgbToLinear(blue)];
    const luma = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
    output[offset] = toByte(linearToSrgb(linear[0] * (1 - despill) + luma * despill));
    output[offset + 1] = toByte(linearToSrgb(linear[1] * (1 - despill) + luma * despill));
    output[offset + 2] = toByte(linearToSrgb(linear[2] * (1 - despill) + luma * despill));
  }
  return { data: output, width: surface.width, height: surface.height, alphaMode: "straight" };
}
