import type { CutAVIR, IRComposition, IRNode, IRValue } from "../../language/ir";
import { rationalToNumber } from "../../language/rational";
import { ReferenceVisualConfigError, type ReferenceVisualConfigErrorCode } from "./visual-config";

/**
 * Deliberately finite even when a shape is mostly outside the canvas. This
 * keeps SVG/raster allocations and coordinate arithmetic bounded while still
 * allowing an authored shape to be substantially larger than a 4K canvas.
 */
export const referenceShapeLimits = Object.freeze({
  maximumDimension: 65_536,
  maximumCircleRadius: 32_768,
});

export type ReferenceSolidPaint = Readonly<{ kind: "solid"; color: string }>;
export type ReferenceGradientPaint = Readonly<{ kind: "linear-gradient"; from: string; to: string }>;
export type ReferenceShapePaint = ReferenceSolidPaint | ReferenceGradientPaint;

export type ReferenceRectConfig = Readonly<{
  kind: "rect";
  width: number;
  height: number;
  radius: number;
  paint: ReferenceShapePaint;
}>;

export type ReferenceCircleConfig = Readonly<{
  kind: "circle";
  radius: number;
  paint: ReferenceSolidPaint;
}>;

export type ReferenceNormalizedCrop = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type ReferenceImageConfig = Readonly<{
  kind: "image";
  sourceId: string;
  fit: "cover" | "contain" | "fill";
  crop?: ReferenceNormalizedCrop;
}>;

export type ReferenceShapeNodeConfig = ReferenceRectConfig | ReferenceCircleConfig | ReferenceImageConfig;

function location(node: IRNode) {
  return `${node.provenance.module}:${node.provenance.span.start.line}:${node.provenance.span.start.column}`;
}

function fail(node: IRNode, code: ReferenceVisualConfigErrorCode, message: string): never {
  throw new ReferenceVisualConfigError(code, node.id, `${node.op} at ${location(node)} ${message}`);
}

function finiteQuantity(
  node: IRNode,
  input: string,
  value: IRValue | undefined,
  dimension: "length" | "ratio",
  required: boolean,
) {
  if (value === undefined) {
    if (required) fail(node, "CUT_VISUAL_INPUT_TYPE", `requires input “${input}”: ${dimension}.`);
    return undefined;
  }
  if (value.kind !== "quantity" || value.dimension !== dimension) {
    fail(node, "CUT_VISUAL_INPUT_TYPE", `input “${input}” must be a ${dimension} quantity.`);
  }
  const result = rationalToNumber(value.magnitude);
  if (!Number.isFinite(result)) fail(node, "CUT_VISUAL_VALUE_RANGE", `input “${input}” must be finite.`);
  return result;
}

function boundedPositiveLength(node: IRNode, input: string, value: IRValue | undefined, maximum: number) {
  const result = finiteQuantity(node, input, value, "length", true)!;
  if (result <= 0 || result > maximum) {
    fail(node, "CUT_VISUAL_VALUE_RANGE", `input “${input}” must be greater than 0px and at most ${maximum}px.`);
  }
  return result;
}

function canonicalColor(node: IRNode, input: string, value: IRValue | undefined, fallback?: string) {
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    fail(node, "CUT_VISUAL_INPUT_TYPE", `requires input “${input}”: Color.`);
  }
  if (value.kind !== "color" || !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/.test(value.value)) {
    fail(node, "CUT_VISUAL_INPUT_TYPE", `input “${input}” must be a canonical lowercase #RRGGBB or #RRGGBBAA Color IR value.`);
  }
  return value.value;
}

function rectPaint(node: IRNode): ReferenceShapePaint {
  const from = node.inputs.gradientFrom;
  const to = node.inputs.gradientTo;
  if ((from === undefined) !== (to === undefined)) {
    fail(node, "CUT_VISUAL_INPUT_COMBINATION", "requires gradientFrom and gradientTo to be supplied together.");
  }
  if (from !== undefined && to !== undefined) {
    if (node.inputs.fill !== undefined) {
      fail(node, "CUT_VISUAL_INPUT_COMBINATION", "does not permit fill together with gradientFrom/gradientTo; choose one paint model.");
    }
    return Object.freeze({
      kind: "linear-gradient",
      from: canonicalColor(node, "gradientFrom", from),
      to: canonicalColor(node, "gradientTo", to),
    });
  }
  return Object.freeze({ kind: "solid", color: canonicalColor(node, "fill", node.inputs.fill, "#ffffff") });
}

export function referenceNormalizedCrop(node: IRNode, value: IRValue | undefined): ReferenceNormalizedCrop | undefined {
  if (value === undefined) return undefined;
  if (value.kind !== "object") fail(node, "CUT_VISUAL_INPUT_TYPE", "input “crop” must be a NormalizedCrop object.");
  const keys = Object.keys(value.entries).sort();
  if (keys.join("\0") !== "height\0width\0x\0y") {
    fail(node, "CUT_VISUAL_INPUT_TYPE", "input “crop” must contain exactly x, y, width, and height.");
  }
  const component = (name: "x" | "y" | "width" | "height") => {
    const result = finiteQuantity(node, `crop.${name}`, value.entries[name], "ratio", true)!;
    if (result < 0 || result > 1 || ((name === "width" || name === "height") && result === 0)) {
      fail(
        node,
        "CUT_VISUAL_VALUE_RANGE",
        `input “crop.${name}” must be ${name === "width" || name === "height" ? "greater than 0 and " : ""}at most 100%.`,
      );
    }
    return result;
  };
  const crop = Object.freeze({ x: component("x"), y: component("y"), width: component("width"), height: component("height") });
  if (crop.x + crop.width > 1 || crop.y + crop.height > 1) {
    fail(node, "CUT_VISUAL_VALUE_RANGE", "input “crop” must remain entirely inside the normalized source bounds.");
  }
  if (crop.x === 0 && crop.y === 0 && crop.width === 1 && crop.height === 1) {
    fail(node, "CUT_VISUAL_INPUT_COMBINATION", "input “crop” selects the complete source and cannot affect pixels; remove the no-op crop.");
  }
  return crop;
}

function rectConfig(node: IRNode): ReferenceRectConfig {
  const width = boundedPositiveLength(node, "width", node.inputs.width, referenceShapeLimits.maximumDimension);
  const height = boundedPositiveLength(node, "height", node.inputs.height, referenceShapeLimits.maximumDimension);
  const radius = finiteQuantity(node, "radius", node.inputs.radius, "length", false) ?? 0;
  const maximumRadius = Math.min(width, height) / 2;
  if (radius < 0 || radius > maximumRadius) {
    fail(node, "CUT_VISUAL_VALUE_RANGE", `input “radius” must be between 0px and ${maximumRadius}px for this rectangle.`);
  }
  return Object.freeze({ kind: "rect", width, height, radius, paint: rectPaint(node) });
}

function circleConfig(node: IRNode): ReferenceCircleConfig {
  const radius = boundedPositiveLength(node, "radius", node.inputs.radius, referenceShapeLimits.maximumCircleRadius);
  return Object.freeze({
    kind: "circle",
    radius,
    paint: Object.freeze({ kind: "solid", color: canonicalColor(node, "fill", node.inputs.fill, "#ffffff") }),
  });
}

function imageConfig(ir: CutAVIR, node: IRNode): ReferenceImageConfig {
  const source = node.inputs.source;
  if (source?.kind !== "resource-ref") fail(node, "CUT_VISUAL_INPUT_TYPE", "requires input “source”: ImageAsset resource reference.");
  const resource = ir.resources[source.id];
  if (!resource || resource.kind !== "image") {
    fail(node, "CUT_VISUAL_INPUT_TYPE", `input “source” must reference an image resource; received ${resource?.kind ?? "missing resource"}.`);
  }
  const authoredFit = node.inputs.fit;
  if (authoredFit !== undefined && authoredFit.kind !== "string") fail(node, "CUT_VISUAL_INPUT_TYPE", "input “fit” must be a String.");
  const fit = authoredFit?.kind === "string" ? authoredFit.value : "cover";
  if (fit !== "cover" && fit !== "contain" && fit !== "fill") {
    fail(node, "CUT_VISUAL_INPUT_ENUM", "input “fit” must be one of: cover, contain, fill.");
  }
  const crop = referenceNormalizedCrop(node, node.inputs.crop);
  return Object.freeze({ kind: "image", sourceId: source.id, fit, ...(crop ? { crop } : {}) });
}

/**
 * Close the loaded-IR boundary for leaf shapes and images. Returning the
 * executable values lets validation and rendering share the same semantics.
 */
export function referenceShapeNodeConfig(ir: CutAVIR, _composition: IRComposition, node: IRNode): ReferenceShapeNodeConfig | undefined {
  if (node.op === "cut.visual.rect") return rectConfig(node);
  if (node.op === "cut.visual.circle") return circleConfig(node);
  if (node.op === "cut.visual.image") return imageConfig(ir, node);
  return undefined;
}
