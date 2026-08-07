import type { CutAVIR, IRNode, IRValue } from "../../language/ir";
import { rationalToNumber } from "../../language/rational";
import {
  rgbaMaskMaximumCanvasPixels,
  rgbaMaskMaximumRadiusPx,
  rgbaMaskModes,
  type RgbaMaskMode,
} from "./compositing";

export type ReferenceMaskErrorCode =
  | "CUT_MASK_GRAPH"
  | "CUT_MASK_INPUT_TYPE"
  | "CUT_MASK_MODE"
  | "CUT_MASK_VALUE_RANGE"
  | "CUT_MASK_RESOURCE_LIMIT";

export class ReferenceMaskError extends Error {
  readonly source: { module: string; line: number; column: number; nodeId: string };

  constructor(readonly code: ReferenceMaskErrorCode, readonly node: IRNode, message: string) {
    const { module, span } = node.provenance;
    super(`${code}: ${node.op} at ${module}:${span.start.line}:${span.start.column} ${message}`);
    this.name = "ReferenceMaskError";
    this.source = { module, line: span.start.line, column: span.start.column, nodeId: node.id };
  }
}

/**
 * The CPU backend uses exact integer-pixel neighborhoods. This avoids native
 * library rounding becoming language semantics and bounds morphology/feather
 * work before any coverage-plane allocation.
 */
export const referenceMaskLimits = Object.freeze({
  maximumExpansionPx: rgbaMaskMaximumRadiusPx,
  maximumFeatherPx: rgbaMaskMaximumRadiusPx,
  maximumCanvasPixels: rgbaMaskMaximumCanvasPixels,
});

export type ReferenceMaskConfig = Readonly<{
  mode: RgbaMaskMode;
  invert: boolean;
  featherPx: number;
  expandPx: number;
}>;

const maskInputs = new Set(["mode", "invert", "feather", "expand", "x", "y", "scale", "rotation", "opacity"]);
const maskProperties = new Set(["opacity", "x", "y", "scale", "rotation"]);

function fail(node: IRNode, code: ReferenceMaskErrorCode, message: string): never {
  throw new ReferenceMaskError(code, node, message);
}

function exactIntegerPx(
  node: IRNode,
  name: "feather" | "expand",
  value: IRValue | undefined,
  minimum: number,
  maximum: number,
) {
  if (value === undefined) return 0;
  if (value.kind !== "quantity" || value.dimension !== "length" || value.unit !== "px") {
    fail(node, "CUT_MASK_INPUT_TYPE", `input “${name}” must be a canonical pixel Length.`);
  }
  try {
    const numerator = BigInt(value.magnitude.numerator), denominator = BigInt(value.magnitude.denominator);
    if (denominator <= 0n) fail(node, "CUT_MASK_INPUT_TYPE", `input “${name}” must have a positive exact denominator.`);
    if (numerator % denominator !== 0n) {
      fail(node, "CUT_MASK_VALUE_RANGE", `input “${name}” must resolve to an exact integer pixel radius in the CPU reference backend.`);
    }
  } catch (error) {
    if (error instanceof ReferenceMaskError) throw error;
    fail(node, "CUT_MASK_INPUT_TYPE", `input “${name}” must contain a canonical exact rational.`);
  }
  const result = rationalToNumber(value.magnitude);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    fail(node, "CUT_MASK_VALUE_RANGE", `input “${name}” must be an exact integer from ${minimum}px through ${maximum}px, inclusive.`);
  }
  return result;
}

function mode(node: IRNode, value: IRValue | undefined): RgbaMaskMode {
  if (value === undefined) return "alpha";
  if (value.kind !== "string") fail(node, "CUT_MASK_INPUT_TYPE", "input “mode” must be a String literal.");
  if (!rgbaMaskModes.includes(value.value as RgbaMaskMode)) {
    fail(node, "CUT_MASK_MODE", `input “mode” must be one of: ${rgbaMaskModes.join(", ")}.`);
  }
  return value.value as RgbaMaskMode;
}

function invert(node: IRNode, value: IRValue | undefined) {
  if (value === undefined) return false;
  if (value.kind !== "boolean") fail(node, "CUT_MASK_INPUT_TYPE", "input “invert” must be Boolean.");
  return value.value;
}

/** Close the public Mask graph and every executable input before frame work. */
export function referenceMaskConfig(ir: CutAVIR, node: IRNode): ReferenceMaskConfig | undefined {
  if (node.op !== "cut.visual.mask") return undefined;
  for (const input of Object.keys(node.inputs)) {
    if (!maskInputs.has(input)) fail(node, "CUT_MASK_INPUT_TYPE", `does not execute input “${input}”; refusing a silent no-op.`);
  }
  for (const property of Object.keys(node.properties)) {
    if (!maskProperties.has(property)) fail(node, "CUT_MASK_INPUT_TYPE", `does not execute property “${property}”; refusing a silent no-op.`);
  }
  if (node.domain !== "visual") fail(node, "CUT_MASK_GRAPH", `must have visual domain; found ${node.domain}.`);
  if (node.children.length !== 2) {
    fail(node, "CUT_MASK_GRAPH", `requires exactly two visual children: target, then matte; found ${node.children.length}.`);
  }
  for (const [index, childId] of node.children.entries()) {
    const child = ir.nodes[childId];
    if (!child || child.domain !== "visual") {
      fail(node, "CUT_MASK_GRAPH", `${index === 0 ? "target" : "matte"} child ${childId} must resolve to a visual node.`);
    }
  }
  return Object.freeze({
    mode: mode(node, node.inputs.mode),
    invert: invert(node, node.inputs.invert),
    featherPx: exactIntegerPx(node, "feather", node.inputs.feather, 0, referenceMaskLimits.maximumFeatherPx),
    expandPx: exactIntegerPx(node, "expand", node.inputs.expand, -referenceMaskLimits.maximumExpansionPx, referenceMaskLimits.maximumExpansionPx),
  });
}

/** Validate the surface budget independently of native image libraries. */
export function validateReferenceMaskCanvas(node: IRNode, width: number, height: number) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    fail(node, "CUT_MASK_RESOURCE_LIMIT", "canvas dimensions must be positive safe integers.");
  }
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > referenceMaskLimits.maximumCanvasPixels) {
    fail(node, "CUT_MASK_RESOURCE_LIMIT", `canvas exceeds the ${referenceMaskLimits.maximumCanvasPixels}-pixel mask budget.`);
  }
}
