import type { CutAVIR, IRComposition, IRNode, IRValue } from "../../language/ir";
import { rationalToNumber } from "../../language/rational";

export type ReferenceTextAlign = "start" | "middle" | "end";
export type ReferenceTextColor = { color: string; opacity: number };

/** A bounded local layout context supplied by an executable materialization
 * boundary. Ordinary Text keeps its composition-relative defaults when this
 * is absent; coordinates remain authored-local until the owning boundary's
 * one documented raster translation. */
export type ReferenceTextLayoutContext = Readonly<{
  kind: "local-space" | "responsive-slot";
  width: number;
  height: number;
  originX: number;
  originY: number;
}>;

export type ReferenceTextConfig = {
  nodeId: string;
  fontId: string;
  content: string;
  size: number;
  color: ReferenceTextColor;
  x: number;
  y: number;
  align: ReferenceTextAlign;
  maxWidth: number;
  lineHeight: number;
  maxLines: number;
  tracking: number;
  shadowColor: ReferenceTextColor;
  shadowOpacity: number;
  shadowBlur: number;
};

export const referenceTextLimits = Object.freeze({
  maxNodesPerComposition: 256,
  maxFontBytes: 16 * 1024 * 1024,
  maxFontGlyphs: 100_000,
  maxCodePoints: 4_096,
  maxLines: 64,
  maxOutlineCommandsPerNode: 100_000,
  maxOutlineBytesPerNode: 4 * 1024 * 1024,
  maxSessionOutlineCommands: 2_000_000,
  maxSessionOutlineBytes: 32 * 1024 * 1024,
  maxSessionResourceBytes: 64 * 1024 * 1024,
  maxAbsoluteCoordinate: 65_536,
  maxFontSize: 4_096,
  maxTracking: 1_024,
  maxShadowBlur: 1_024,
});

export type ReferenceTextConfigErrorCode =
  | "CUT_TEXT_INPUT_TYPE"
  | "CUT_TEXT_INPUT_ENUM"
  | "CUT_TEXT_INPUT_COMBINATION"
  | "CUT_TEXT_VALUE_RANGE"
  | "CUT_TEXT_RESOURCE"
  | "CUT_TEXT_BUDGET";

export class ReferenceTextConfigError extends Error {
  readonly source?: Readonly<{ module: string; line: number; column: number; nodeId: string }>;

  constructor(
    readonly code: ReferenceTextConfigErrorCode,
    readonly nodeId: string,
    message: string,
    source?: Readonly<{ module: string; line: number; column: number; nodeId: string }>,
  ) {
    super(`${code}: ${message}`);
    this.name = "ReferenceTextConfigError";
    this.source = source;
  }
}

function location(node: IRNode) {
  return `${node.provenance.module}:${node.provenance.span.start.line}:${node.provenance.span.start.column}`;
}

export function referenceTextFailure(node: IRNode, code: ReferenceTextConfigErrorCode, message: string): never {
  const { module, span } = node.provenance;
  throw new ReferenceTextConfigError(
    code,
    node.id,
    `Text at ${location(node)} ${message}`,
    Object.freeze({ module, line: span.start.line, column: span.start.column, nodeId: node.id }),
  );
}

function quantity(node: IRNode, name: string, value: IRValue | undefined, dimension: "length" | "ratio" | "scalar", fallback: number) {
  if (value === undefined) return fallback;
  if (value.kind !== "quantity" || value.dimension !== dimension) referenceTextFailure(node, "CUT_TEXT_INPUT_TYPE", `input “${name}” must be a ${dimension} quantity.`);
  const number = rationalToNumber(value.magnitude);
  if (!Number.isFinite(number)) referenceTextFailure(node, "CUT_TEXT_VALUE_RANGE", `input “${name}” must be finite.`);
  return number;
}

function string(node: IRNode, name: string, value: IRValue | undefined, fallback?: string) {
  if (value === undefined) {
    if (fallback === undefined) referenceTextFailure(node, "CUT_TEXT_INPUT_TYPE", `requires input “${name}”: String.`);
    return fallback;
  }
  if (value.kind !== "string") referenceTextFailure(node, "CUT_TEXT_INPUT_TYPE", `input “${name}” must be a String.`);
  return value.value;
}

function color(node: IRNode, name: string, value: IRValue | undefined, fallback: string): ReferenceTextColor {
  if (value === undefined) value = { kind: "color", value: fallback };
  if (value.kind !== "color" || !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/.test(value.value)) {
    referenceTextFailure(node, "CUT_TEXT_INPUT_TYPE", `input “${name}” must be a canonical lowercase Color.`);
  }
  return { color: value.value.slice(0, 7), opacity: value.value.length === 9 ? Number.parseInt(value.value.slice(7), 16) / 255 : 1 };
}

/** One strict executable Text contract shared by preflight and preparation. */
export function referenceTextConfig(
  node: IRNode,
  ir: CutAVIR,
  composition: IRComposition,
  layoutContext?: ReferenceTextLayoutContext,
): ReferenceTextConfig | undefined {
  if (node.op !== "cut.visual.text") return undefined;
  const content = string(node, "content", node.inputs.content);
  if ([...content].length > referenceTextLimits.maxCodePoints) referenceTextFailure(node, "CUT_TEXT_BUDGET", `content exceeds the ${referenceTextLimits.maxCodePoints}-code-point render budget.`);
  const font = node.inputs.font;
  if (font?.kind !== "resource-ref") referenceTextFailure(node, "CUT_TEXT_RESOURCE", "requires a locked FontAsset; host font fallback is forbidden.");
  if (ir.resources[font.id]?.kind !== "font") referenceTextFailure(node, "CUT_TEXT_RESOURCE", "input “font” must reference a FontAsset.");

  const size = quantity(node, "size", node.inputs.size, "length", 64);
  if (size < 1 || size > referenceTextLimits.maxFontSize) referenceTextFailure(node, "CUT_TEXT_VALUE_RANGE", `input “size” must be from 1 through ${referenceTextLimits.maxFontSize}px.`);
  const localView = layoutContext
    ? {
        minX: -layoutContext.originX,
        minY: -layoutContext.originY,
        maxX: layoutContext.width - layoutContext.originX,
        maxY: layoutContext.height - layoutContext.originY,
      }
    : undefined;
  const x = quantity(node, "x", node.inputs.x, "length", localView ? (localView.minX + localView.maxX) / 2 : 96);
  const y = quantity(node, "y", node.inputs.y, "length", localView ? (localView.minY + localView.maxY) / 2 : composition.height * .5);
  if (Math.abs(x) > referenceTextLimits.maxAbsoluteCoordinate || Math.abs(y) > referenceTextLimits.maxAbsoluteCoordinate) referenceTextFailure(node, "CUT_TEXT_VALUE_RANGE", `input “x” and “y” must be within ±${referenceTextLimits.maxAbsoluteCoordinate}px.`);
  const align = string(node, "align", node.inputs.align, "start");
  if (align !== "start" && align !== "middle" && align !== "end") referenceTextFailure(node, "CUT_TEXT_INPUT_ENUM", "input “align” must be exactly one of: start, middle, end.");
  const localDefaultMaxWidth = localView
    ? align === "start"
      ? localView.maxX - x
      : align === "end"
        ? x - localView.minX
        : Math.min(x - localView.minX, localView.maxX - x) * 2
    : undefined;
  const maxWidth = quantity(node, "maxWidth", node.inputs.maxWidth, "length", Math.max(1, localDefaultMaxWidth ?? composition.width - x - 80));
  if (maxWidth < 1 || maxWidth > referenceTextLimits.maxAbsoluteCoordinate) referenceTextFailure(node, "CUT_TEXT_VALUE_RANGE", `input “maxWidth” must be from 1 through ${referenceTextLimits.maxAbsoluteCoordinate}px.`);
  const lineHeight = quantity(node, "lineHeight", node.inputs.lineHeight, "length", size * 1.08);
  if (lineHeight < size * .5 || lineHeight > size * 4) referenceTextFailure(node, "CUT_TEXT_VALUE_RANGE", "input “lineHeight” must be from 0.5× through 4× the font size.");
  const defaultMaxLines = Math.max(1, Math.min(referenceTextLimits.maxLines, Math.floor(((localView?.maxY ?? composition.height) - y + size) / lineHeight)));
  const maxLines = quantity(node, "maxLines", node.inputs.maxLines, "scalar", defaultMaxLines);
  if (!Number.isSafeInteger(maxLines) || maxLines < 1 || maxLines > referenceTextLimits.maxLines) referenceTextFailure(node, "CUT_TEXT_VALUE_RANGE", `input “maxLines” must be a whole number from 1 through ${referenceTextLimits.maxLines}.`);

  if (node.inputs.tracking !== undefined && node.inputs.letterSpacing !== undefined) {
    referenceTextFailure(node, "CUT_TEXT_INPUT_COMBINATION", "inputs “tracking” and “letterSpacing” are aliases; supply exactly one.");
  }
  const trackingName = node.inputs.tracking === undefined ? "letterSpacing" : "tracking";
  const tracking = quantity(node, trackingName, node.inputs.tracking ?? node.inputs.letterSpacing, "length", 0);
  if (Math.abs(tracking) > referenceTextLimits.maxTracking) referenceTextFailure(node, "CUT_TEXT_VALUE_RANGE", `input “${trackingName}” must be within ±${referenceTextLimits.maxTracking}px.`);

  const shadowInputs = ["shadowColor", "shadowOpacity", "shadowBlur"] as const;
  const suppliedShadowInputs = shadowInputs.filter((name) => node.inputs[name] !== undefined);
  if (suppliedShadowInputs.length !== 0 && suppliedShadowInputs.length !== shadowInputs.length) {
    referenceTextFailure(node, "CUT_TEXT_INPUT_COMBINATION", "shadowColor, shadowOpacity, and shadowBlur must be supplied together so no shadow input becomes a no-op.");
  }
  const shadowOpacity = quantity(node, "shadowOpacity", node.inputs.shadowOpacity, "ratio", 0);
  if (shadowOpacity < 0 || shadowOpacity > 1) referenceTextFailure(node, "CUT_TEXT_VALUE_RANGE", "input “shadowOpacity” must be between 0% and 100%.");
  const shadowBlur = quantity(node, "shadowBlur", node.inputs.shadowBlur, "length", 0);
  if (shadowBlur < 0 || shadowBlur > referenceTextLimits.maxShadowBlur) referenceTextFailure(node, "CUT_TEXT_VALUE_RANGE", `input “shadowBlur” must be from 0 through ${referenceTextLimits.maxShadowBlur}px.`);

  return {
    nodeId: node.id,
    fontId: font.id,
    content,
    size,
    color: color(node, "color", node.inputs.color, "#ffffff"),
    x,
    y,
    align,
    maxWidth,
    lineHeight,
    maxLines,
    tracking,
    shadowColor: color(node, "shadowColor", node.inputs.shadowColor, "#000000"),
    shadowOpacity,
    shadowBlur,
  };
}
