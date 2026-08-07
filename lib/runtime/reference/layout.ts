import type { IRComposition, IRNode, IRValue } from "../../language/ir";
import { rationalToNumber } from "../../language/rational";

export const referenceStackDirections = ["horizontal", "vertical"] as const;
export const referenceStackAlignments = ["start", "center", "end"] as const;
export const referenceStackDistributions = ["start", "center", "end", "space-between", "space-around", "space-evenly"] as const;

export type ReferenceStackDirection = typeof referenceStackDirections[number];
export type ReferenceStackAlignment = typeof referenceStackAlignments[number];
export type ReferenceStackDistribution = typeof referenceStackDistributions[number];

export type ReferenceStackConfig = {
  direction: ReferenceStackDirection;
  gap: number;
  align: ReferenceStackAlignment;
  distribution: ReferenceStackDistribution;
  padding: number;
  safeArea: number;
  width: number;
  height: number;
  canvasWidth: number;
  canvasHeight: number;
};

export type ReferenceAlphaBounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
};

export type ReferenceStackPlacement = { x: number; y: number };

export const referenceStackDiagnosticCode = "CUT_LAYOUT_STACK_INVALID" as const;

export class ReferenceStackConfigError extends Error {
  readonly code = referenceStackDiagnosticCode;

  constructor(readonly nodeId: string, readonly source: string, detail: string) {
    super(`${referenceStackDiagnosticCode}: Reference kernel cut.visual.stack at ${source} ${detail}`);
    this.name = "ReferenceStackConfigError";
  }
}

const maximumLayoutCoordinate = 65_536;

function location(node: IRNode) {
  return `${node.provenance.module}:${node.provenance.span.start.line}:${node.provenance.span.start.column}`;
}

function fail(node: IRNode, message: string): never {
  throw new ReferenceStackConfigError(node.id, location(node), message);
}

function stringInput<T extends string>(node: IRNode, name: string, value: IRValue | undefined, fallback: T, allowed: readonly T[]): T {
  if (value === undefined) return fallback;
  if (value.kind !== "string" || !allowed.includes(value.value as T)) fail(node, `input “${name}” must be one of: ${allowed.join(", ")}.`);
  return value.value as T;
}

function lengthInput(node: IRNode, name: string, value: IRValue | undefined, fallback: number, positive = false) {
  if (value === undefined) return fallback;
  if (value.kind !== "quantity" || value.dimension !== "length" || value.unit !== "px") fail(node, `input “${name}” must be an exact Length in px.`);
  const result = rationalToNumber(value.magnitude);
  if (!Number.isFinite(result) || result < (positive ? Number.EPSILON : 0) || result > maximumLayoutCoordinate) {
    fail(node, `input “${name}” must be ${positive ? "greater than 0px" : "at least 0px"} and at most ${maximumLayoutCoordinate}px.`);
  }
  return result;
}

/**
 * Resolve the closed Stack input contract. Layout inputs are static in 0.4;
 * only the ordinary container transform properties are signal-driven.
 */
export function referenceStackConfig(node: IRNode, composition: IRComposition): ReferenceStackConfig | undefined {
  if (node.op !== "cut.visual.stack") return undefined;
  const direction = stringInput(node, "direction", node.inputs.direction, "vertical", referenceStackDirections);
  const align = stringInput(node, "align", node.inputs.align, "center", referenceStackAlignments);
  const distribution = stringInput(node, "distribution", node.inputs.distribution, "center", referenceStackDistributions);
  const gap = lengthInput(node, "gap", node.inputs.gap, 0);
  const padding = lengthInput(node, "padding", node.inputs.padding, 0);
  const safeArea = lengthInput(node, "safeArea", node.inputs.safeArea, 0);
  const width = lengthInput(node, "width", node.inputs.width, composition.width, true);
  const height = lengthInput(node, "height", node.inputs.height, composition.height, true);
  const inset = padding + safeArea;
  if (inset * 2 >= width || inset * 2 >= height) fail(node, "padding + safeArea must leave a positive content rectangle.");
  return { direction, gap, align, distribution, padding, safeArea, width, height, canvasWidth: composition.width, canvasHeight: composition.height };
}

/** Exact non-zero-alpha bounds. Fully transparent surfaces have a zero-size
 * anchor at the canvas center, so every authored child still participates in
 * ordering and gap calculation without inventing visible geometry. */
export function referenceAlphaBounds(surface: { data: Uint8Array; width: number; height: number }): ReferenceAlphaBounds {
  if (!Number.isSafeInteger(surface.width) || !Number.isSafeInteger(surface.height) || surface.width < 1 || surface.height < 1 || surface.data.byteLength !== surface.width * surface.height * 4) {
    throw new Error("CUT Stack measurement requires a valid straight-alpha RGBA surface.");
  }
  let left = surface.width, top = surface.height, right = -1, bottom = -1;
  for (let y = 0; y < surface.height; y += 1) {
    for (let x = 0; x < surface.width; x += 1) {
      if (surface.data[(y * surface.width + x) * 4 + 3] === 0) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  if (right < left || bottom < top) {
    const centerX = surface.width / 2, centerY = surface.height / 2;
    return { left: centerX, right: centerX, top: centerY, bottom: centerY, width: 0, height: 0, centerX, centerY };
  }
  const width = right - left + 1, height = bottom - top + 1;
  return { left, top, right, bottom, width, height, centerX: left + width / 2, centerY: top + height / 2 };
}

function distributedCenters(sizes: readonly number[], start: number, length: number, gap: number, distribution: ReferenceStackDistribution) {
  if (!sizes.length) return [];
  const totalSize = sizes.reduce((sum, size) => sum + size, 0);
  let spacing = gap, cursor = start;
  const packed = totalSize + gap * Math.max(0, sizes.length - 1);
  if (distribution === "center") cursor += (length - packed) / 2;
  else if (distribution === "end") cursor += length - packed;
  else if (distribution === "space-between") {
    if (sizes.length === 1) cursor += (length - totalSize) / 2;
    else spacing = Math.max(gap, (length - totalSize) / (sizes.length - 1));
  } else if (distribution === "space-around") {
    spacing = Math.max(gap, (length - totalSize) / sizes.length);
    cursor += spacing / 2;
  } else if (distribution === "space-evenly") {
    spacing = Math.max(gap, (length - totalSize) / (sizes.length + 1));
    cursor += spacing;
  }
  return sizes.map((size) => {
    const center = cursor + size / 2;
    cursor += size + spacing;
    return center;
  });
}

/** Compute translations from current rendered bounds into the Stack frame. */
export function referenceStackPlacements(bounds: readonly ReferenceAlphaBounds[], config: ReferenceStackConfig): ReferenceStackPlacement[] {
  const inset = config.padding + config.safeArea;
  const frameLeft = (config.canvasWidth - config.width) / 2 + inset;
  const frameTop = (config.canvasHeight - config.height) / 2 + inset;
  const contentWidth = config.width - inset * 2, contentHeight = config.height - inset * 2;
  const horizontal = config.direction === "horizontal";
  const mainSizes = bounds.map((item) => horizontal ? item.width : item.height);
  const mainCenters = distributedCenters(mainSizes, horizontal ? frameLeft : frameTop, horizontal ? contentWidth : contentHeight, config.gap, config.distribution);
  return bounds.map((item, index) => {
    const crossSize = horizontal ? item.height : item.width;
    const crossStart = horizontal ? frameTop : frameLeft;
    const crossLength = horizontal ? contentHeight : contentWidth;
    const crossCenter = config.align === "start" ? crossStart + crossSize / 2
      : config.align === "end" ? crossStart + crossLength - crossSize / 2
        : crossStart + crossLength / 2;
    const targetX = horizontal ? mainCenters[index] : crossCenter;
    const targetY = horizontal ? crossCenter : mainCenters[index];
    return { x: targetX - item.centerX, y: targetY - item.centerY };
  });
}
