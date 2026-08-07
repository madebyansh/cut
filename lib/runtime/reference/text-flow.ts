import type { CutAVIR, IRComposition, IRNode, IRValue } from "../../language/ir";
import { cutBuiltinPackageVersion } from "../../version";
import { hash } from "../../core/stable";
import {
  addRational,
  compareRational,
  divideRational,
  multiplyRational,
  rational,
  rationalToNumber,
  subtractRational,
  type Rational,
  zeroRational,
} from "../../language/rational";
import { easeReferenceProgress, parseReferenceEasing, type ReferenceEasing } from "./easing";
import {
  lockedGlyphAdvance,
  lockedGlyphCount,
  lockedGlyphIdOutline,
  lockedGlyphUnits,
  type LockedGlyphUnit,
  type LockedOpenTypeFont,
} from "./locked-font";
import {
  referenceComplexTextBackendContract,
  referenceComplexTextLineBidi,
  shapeReferenceComplexText,
  type ReferenceComplexTextCluster,
  type ReferenceComplexTextBackendIdentity,
  type ReferenceComplexTextFont,
  type ReferenceComplexTextShapingResult,
} from "./complex-text-shaping";
import type { ReferenceTextLayoutContext } from "./text-config";

export type ReferenceFlowTextColor = { color: string; opacity: number };
export type ReferenceFlowTextUnitKind = "line" | "word" | "glyph" | "cluster";
export type ReferenceFlowTextUnitOrder = "logical" | "visual";
export type ReferenceFlowTextShapingConfig = Readonly<{
  paragraphDirection: "ltr" | "rtl";
  language: string;
  fallbackFontIds: readonly string[];
  policy: "harfbuzz-bidi-whole-token-v1";
  backendIdentity: ReferenceComplexTextBackendIdentity;
}>;
export type ReferenceTextSpan = {
  id: string;
  content: string;
  fontId: string;
  size: number;
  color: ReferenceFlowTextColor;
  tracking: number;
  baselineShift: number;
};

export type ReferenceTextUnitPose = {
  x: number;
  y: number;
  opacity: number;
  scale: number;
  rotation: number;
};

const identityPose: ReferenceTextUnitPose = Object.freeze({ x: 0, y: 0, opacity: 1, scale: 1, rotation: 0 });
const intrinsicLinear: IRValue = Object.freeze({ kind: "symbol", name: "cut:intrinsic#linear" });

export type ReferenceTextUnitMotion = {
  span: string;
  by: ReferenceFlowTextUnitKind;
  order?: ReferenceFlowTextUnitOrder;
  start: number;
  count?: number;
  at: Rational;
  each: Rational;
  duration: Rational;
  from: ReferenceTextUnitPose;
  to: ReferenceTextUnitPose;
  easing: IRValue;
  parsedEasing: ReferenceEasing;
  before: "base" | "from";
  beforeAuthored: boolean;
};

export type ReferenceFlowTextConfig = {
  nodeId: string;
  fontId: string;
  fontIds: readonly string[];
  fontResources: readonly Readonly<{ id: string; locator: string; sha256?: string }>[];
  baseStyle: Omit<ReferenceTextSpan, "id" | "content">;
  spans: readonly ReferenceTextSpan[];
  shaping?: ReferenceFlowTextShapingConfig;
  motions: readonly ReferenceTextUnitMotion[];
  layoutX: number;
  baselineY: number;
  maxWidth: number;
  lineHeight: number;
  maxLines: number;
  align: "start" | "middle" | "end";
};

type PreparedGlyph = {
  pathData: string;
  fontId: string;
  spanIndex: number;
  lineIndex: number;
  wordIndex: number;
  glyphIndex: number;
  clusterId?: string;
  clusterLogicalIndex?: number;
  clusterVisualIndex?: number;
  clusterStart?: number;
  clusterEnd?: number;
  translateX: number;
  translateY: number;
  bounds: { left: number; right: number; top: number; bottom: number };
  color: ReferenceFlowTextColor;
};

type PreparedUnit = {
  glyphs: readonly number[];
  pivotX: number;
  pivotY: number;
};

type PreparedMotion = Omit<ReferenceTextUnitMotion, "count"> & {
  count: number;
  selector: string;
  selected: readonly PreparedUnit[];
};

export type PreparedReferenceFlowText = {
  sourceNode: IRNode;
  config: ReferenceFlowTextConfig;
  glyphs: readonly PreparedGlyph[];
  motions: readonly PreparedMotion[];
  schedules: ReadonlyMap<number, readonly { selector: string; unit: PreparedUnit; start: Rational; end: Rational; from: ReferenceTextUnitPose; to: ReferenceTextUnitPose; easing: IRValue; before: "base" | "from"; beforeAuthored: boolean }[]>;
  lineCount: number;
  wordCount: number;
  outlineCommands: number;
  outlineBytes: number;
  complexShaping?: Readonly<{
    backendIntegrity: string;
    backend: ReferenceComplexTextBackendIdentity;
    clusterCount: number;
    visualClusterIds: readonly string[];
    fontChain: readonly Readonly<{ id: string; locator: string; sha256: string; byteLength: number; unitsPerEm: number }>[];
  }>;
};

export const referenceFlowTextLimits = Object.freeze({
  maxNodesPerComposition: 128,
  maxSpansPerNode: 64,
  maxMotionsPerNode: 256,
  maxUnitsPerNode: 2_048,
  maxCodePointsPerNode: 4_096,
  maxOutlineCommandsPerNode: 100_000,
  maxOutlineBytesPerNode: 4 * 1024 * 1024,
  maxScheduleAssignmentsPerNode: 16_384,
  maxAbsoluteCoordinate: 65_536,
  maxFontSize: 4_096,
  maxTracking: 1_024,
  maxBaselineShift: 4_096,
  maxLines: 64,
});

export type ReferenceFlowTextErrorCode =
  | "CUT_FLOW_TEXT_INPUT_TYPE"
  | "CUT_FLOW_TEXT_INPUT_ENUM"
  | "CUT_FLOW_TEXT_INPUT_SHAPE"
  | "CUT_FLOW_TEXT_VALUE_RANGE"
  | "CUT_FLOW_TEXT_RESOURCE"
  | "CUT_FLOW_TEXT_SHAPING"
  | "CUT_FLOW_TEXT_SELECTION"
  | "CUT_FLOW_TEXT_MOTION"
  | "CUT_FLOW_TEXT_BUDGET";

export class ReferenceFlowTextError extends Error {
  readonly source: { module: string; line: number; column: number; nodeId: string };

  constructor(readonly code: ReferenceFlowTextErrorCode, readonly nodeId: string, node: IRNode, message: string) {
    const { module, span } = node.provenance;
    super(`${code}: FlowText at ${module}:${span.start.line}:${span.start.column} ${message}`);
    this.name = "ReferenceFlowTextError";
    this.source = { module, line: span.start.line, column: span.start.column, nodeId };
  }
}

function fail(node: IRNode, code: ReferenceFlowTextErrorCode, message: string): never {
  throw new ReferenceFlowTextError(code, node.id, node, message);
}

function closedObject(node: IRNode, value: IRValue | undefined, label: string, required: readonly string[], optional: readonly string[]) {
  if (value?.kind !== "object") fail(node, "CUT_FLOW_TEXT_INPUT_TYPE", `${label} must be a typed record.`);
  const allowed = new Set([...required, ...optional]), actual = Object.keys(value.entries);
  const unknown = actual.find((key) => !allowed.has(key)), missing = required.find((key) => !Object.hasOwn(value.entries, key));
  if (unknown || missing) fail(node, "CUT_FLOW_TEXT_INPUT_SHAPE", `${label} must contain ${required.join(", ")} and may contain only: ${optional.join(", ") || "no optional fields"}.`);
  return value.entries;
}

function exactArray(node: IRNode, value: IRValue | undefined, label: string, minimum: number, maximum: number) {
  if (value?.kind !== "array") fail(node, "CUT_FLOW_TEXT_INPUT_TYPE", `${label} must be a typed List.`);
  if (value.items.length < minimum || value.items.length > maximum) fail(node, "CUT_FLOW_TEXT_BUDGET", `${label} must contain ${minimum} through ${maximum} items.`);
  return value.items;
}

function string(node: IRNode, value: IRValue | undefined, label: string) {
  if (value?.kind !== "string") fail(node, "CUT_FLOW_TEXT_INPUT_TYPE", `${label} must be a String.`);
  return value.value;
}

function quantity(node: IRNode, value: IRValue | undefined, label: string, dimension: "length" | "ratio" | "scalar" | "angle" | "time") {
  const unit = { length: "px", ratio: "ratio", scalar: "scalar", angle: "deg", time: "s" }[dimension];
  if (value?.kind !== "quantity" || value.dimension !== dimension || value.unit !== unit) fail(node, "CUT_FLOW_TEXT_INPUT_TYPE", `${label} must be a canonical ${dimension} quantity in ${unit}.`);
  return value;
}

function number(node: IRNode, value: IRValue | undefined, label: string, dimension: "length" | "ratio" | "scalar" | "angle") {
  const result = rationalToNumber(quantity(node, value, label, dimension).magnitude);
  if (!Number.isFinite(result)) fail(node, "CUT_FLOW_TEXT_VALUE_RANGE", `${label} must be finite.`);
  return result;
}

function integer(node: IRNode, value: IRValue | undefined, label: string, minimum: number, maximum: number) {
  const exact = quantity(node, value, label, "scalar").magnitude;
  if (exact.denominator !== "1") fail(node, "CUT_FLOW_TEXT_VALUE_RANGE", `${label} must be a whole Number.`);
  const result = Number(exact.numerator);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) fail(node, "CUT_FLOW_TEXT_VALUE_RANGE", `${label} must be a whole Number from ${minimum} through ${maximum}.`);
  return result;
}

function color(node: IRNode, value: IRValue | undefined, label: string): ReferenceFlowTextColor {
  if (value?.kind !== "color" || !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/.test(value.value)) fail(node, "CUT_FLOW_TEXT_INPUT_TYPE", `${label} must be a canonical lowercase Color.`);
  const opacity = value.value.length === 9 ? Number.parseInt(value.value.slice(7), 16) / 255 : 1;
  if (opacity === 0) fail(node, "CUT_FLOW_TEXT_VALUE_RANGE", `${label} cannot be fully transparent; omit or change the visible span instead of authoring inert paint.`);
  return { color: value.value.slice(0, 7), opacity };
}

function pose(node: IRNode, value: IRValue | undefined, label: string): ReferenceTextUnitPose {
  const entry = closedObject(node, value, label, [], ["x", "y", "opacity", "scale", "rotation"]);
  const result = {
    x: entry.x === undefined ? 0 : number(node, entry.x, `${label}.x`, "length"),
    y: entry.y === undefined ? 0 : number(node, entry.y, `${label}.y`, "length"),
    opacity: entry.opacity === undefined ? 1 : number(node, entry.opacity, `${label}.opacity`, "ratio"),
    scale: entry.scale === undefined ? 1 : number(node, entry.scale, `${label}.scale`, "scalar"),
    rotation: entry.rotation === undefined ? 0 : number(node, entry.rotation, `${label}.rotation`, "angle"),
  };
  if (Math.abs(result.x) > referenceFlowTextLimits.maxAbsoluteCoordinate || Math.abs(result.y) > referenceFlowTextLimits.maxAbsoluteCoordinate) fail(node, "CUT_FLOW_TEXT_VALUE_RANGE", `${label} x/y must be within ±${referenceFlowTextLimits.maxAbsoluteCoordinate}px.`);
  if (result.opacity < 0 || result.opacity > 1) fail(node, "CUT_FLOW_TEXT_VALUE_RANGE", `${label}.opacity must be between 0% and 100%.`);
  if (result.scale < 0 || result.scale > 8) fail(node, "CUT_FLOW_TEXT_VALUE_RANGE", `${label}.scale must be from 0 through 8.`);
  if (Math.abs(result.rotation) > 360_000) fail(node, "CUT_FLOW_TEXT_VALUE_RANGE", `${label}.rotation must be within ±360000deg.`);
  const identity = { x: 0, y: 0, opacity: 1, scale: 1, rotation: 0 } as const;
  for (const name of Object.keys(entry) as Array<keyof typeof identity>) if (result[name] === identity[name]) fail(node, "CUT_FLOW_TEXT_INPUT_SHAPE", `${label}.${name} redundantly authors its identity value; omit that field.`);
  return result;
}

function samePose(left: ReferenceTextUnitPose, right: ReferenceTextUnitPose) {
  return left.x === right.x && left.y === right.y && left.opacity === right.opacity && left.scale === right.scale && left.rotation === right.rotation;
}

function closedEasing(node: IRNode, value: IRValue | undefined, label: string) {
  const curve = value ?? intrinsicLinear;
  if (curve.kind === "symbol") {
    const supported = new Set(["cut:intrinsic#linear", ...["linear", "inCubic", "outCubic", "inOutCubic"].map((name) => `@cut/motion@${cutBuiltinPackageVersion}#${name}`)]);
    if (!supported.has(curve.name)) {
      fail(node, "CUT_FLOW_TEXT_INPUT_TYPE", `${label} must be an exact locked @cut/motion easing symbol or supported typed easing call.`);
    }
    return curve;
  }
  if (curve.kind !== "call" || curve.effect !== "pure" || !["cut.motion.cubic_bezier", "cut.motion.spring"].includes(curve.op)) {
    fail(node, "CUT_FLOW_TEXT_INPUT_TYPE", `${label} must be a typed @cut/motion Easing value; strings, nulls, forged symbols, and unrelated calls are refused.`);
  }
  const names = curve.op === "cut.motion.cubic_bezier" ? ["x1", "y1", "x2", "y2"] : ["mass", "stiffness", "damping"];
  if (curve.positional.length > names.length || Object.keys(curve.named).some((name) => !names.includes(name))) {
    fail(node, "CUT_FLOW_TEXT_INPUT_SHAPE", `${label} has unsupported easing arguments.`);
  }
  for (let index = 0; index < curve.positional.length; index += 1) {
    if (Object.hasOwn(curve.named, names[index])) fail(node, "CUT_FLOW_TEXT_INPUT_SHAPE", `${label} supplies easing argument ${names[index]} twice.`);
  }
  if (curve.op === "cut.motion.cubic_bezier" && names.some((name, index) => curve.positional[index] === undefined && curve.named[name] === undefined)) {
    fail(node, "CUT_FLOW_TEXT_INPUT_SHAPE", `${label} cubicBezier requires x1, y1, x2, and y2.`);
  }
  return curve;
}

const complexFlowTextLanguagePattern = /^[a-z]{2,8}(?:-[a-z0-9]{1,8}){0,3}$/u;
const complexFlowTextForbiddenBidiControl = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const complexFlowTextForbiddenControl = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u;

function validateComplexFlowTextContent(node: IRNode, content: string, label: string) {
  if (complexFlowTextForbiddenControl.test(content) || complexFlowTextForbiddenBidiControl.test(content) || content.includes("\r") || content.includes("\t")) {
    fail(node, "CUT_FLOW_TEXT_SHAPING", `${label} contains a control, bidi override/isolate, tab, or carriage return; textShaping accepts visible Unicode, ASCII space, and LF only.`);
  }
  if ([...content].some((character) => /\p{Z}/u.test(character) && character !== " ")) {
    fail(node, "CUT_FLOW_TEXT_SHAPING", `${label} contains non-ASCII spacing; deterministic wrapping accepts U+0020 as its only soft-wrap separator.`);
  }
  for (let index = 0; index < content.length; index += 1) {
    const unit = content.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = content.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail(node, "CUT_FLOW_TEXT_SHAPING", `${label} contains an unpaired high surrogate at UTF-16 index ${index}.`);
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      fail(node, "CUT_FLOW_TEXT_SHAPING", `${label} contains an unpaired low surrogate at UTF-16 index ${index}.`);
    }
  }
}

function shaping(
  node: IRNode,
  ir: CutAVIR,
  primaryFontId: string,
): ReferenceFlowTextShapingConfig | undefined {
  if (node.inputs.shaping === undefined) return undefined;
  const backendIdentity = ir.features?.complexTextShaping;
  if (!backendIdentity) {
    fail(node, "CUT_FLOW_TEXT_SHAPING", "shaped FlowText requires the exact complex-text feature authority in typed IR.");
  }
  const entry = closedObject(
    node,
    node.inputs.shaping,
    "shaping",
    ["paragraphDirection", "language", "fallbackFonts"],
    [],
  );
  const paragraphDirection = string(node, entry.paragraphDirection, "shaping.paragraphDirection");
  if (paragraphDirection !== "ltr" && paragraphDirection !== "rtl") {
    fail(node, "CUT_FLOW_TEXT_INPUT_ENUM", `shaping.paragraphDirection must be exactly one of: ltr, rtl.`);
  }
  const language = string(node, entry.language, "shaping.language");
  if (!complexFlowTextLanguagePattern.test(language)) {
    fail(node, "CUT_FLOW_TEXT_INPUT_SHAPE", `shaping.language must be a canonical lowercase bounded BCP-47 subset such as en, ar, or hi-deva.`);
  }
  const fallbackFontIds = exactArray(
    node,
    entry.fallbackFonts,
    "shaping.fallbackFonts",
    1,
    7,
  ).map((value, index) => {
    if (value.kind !== "resource-ref" || ir.resources[value.id]?.kind !== "font") {
      fail(node, "CUT_FLOW_TEXT_RESOURCE", `shaping.fallbackFonts[${index}] must reference one explicit locked FontAsset.`);
    }
    return value.id;
  });
  if (fallbackFontIds.includes(primaryFontId)) {
    fail(node, "CUT_FLOW_TEXT_INPUT_SHAPE", `shaping.fallbackFonts cannot repeat the primary FlowText.font.`);
  }
  if (new Set(fallbackFontIds).size !== fallbackFontIds.length) {
    fail(node, "CUT_FLOW_TEXT_INPUT_SHAPE", `shaping.fallbackFonts cannot repeat a FontAsset id.`);
  }
  const hashes = new Set<string>();
  for (const id of [primaryFontId, ...fallbackFontIds]) {
    const resource = ir.resources[id];
    if (!resource || resource.kind !== "font") fail(node, "CUT_FLOW_TEXT_RESOURCE", `textShaping face ${id} is not a FontAsset.`);
    if (resource.sha256 && hashes.has(resource.sha256)) fail(node, "CUT_FLOW_TEXT_INPUT_SHAPE", `textShaping face ${id} repeats locked bytes already present in the ordered face chain.`);
    if (resource.sha256) hashes.add(resource.sha256);
  }
  return Object.freeze({
    paragraphDirection,
    language,
    fallbackFontIds: Object.freeze(fallbackFontIds),
    policy: "harfbuzz-bidi-whole-token-v1",
    backendIdentity,
  });
}

function span(
  node: IRNode,
  ir: CutAVIR,
  value: IRValue,
  index: number,
  base: Omit<ReferenceTextSpan, "id" | "content">,
  complex: boolean,
): ReferenceTextSpan {
  const entry = closedObject(node, value, `spans[${index}]`, ["id", "content"], ["font", "size", "color", "tracking", "baselineShift"]);
  const id = string(node, entry.id, `spans[${index}].id`);
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id)) fail(node, "CUT_FLOW_TEXT_INPUT_SHAPE", `spans[${index}].id must match [a-z][a-z0-9_-]{0,63}.`);
  const content = string(node, entry.content, `spans[${index}].content`);
  if (!content || !/[^\p{Z}\p{C}]/u.test(content)) fail(node, "CUT_FLOW_TEXT_INPUT_SHAPE", `spans[${index}].content must contain visible text.`);
  if (!complex && !/^[\x20-\x7e\n]+$/.test(content)) {
    fail(node, "CUT_FLOW_TEXT_SHAPING", `spans[${index}].content is outside FlowText's current printable-ASCII plus LF shaping boundary; bidi, combining marks, complex scripts, tabs, controls, and fallback fail closed.`);
  }
  if (complex) validateComplexFlowTextContent(node, content, `spans[${index}].content`);
  let fontId = base.fontId;
  if (entry.font !== undefined) {
    if (complex) fail(node, "CUT_FLOW_TEXT_INPUT_SHAPE", `spans[${index}].font is unsupported under textShaping; the primary plus ordered fallbackFonts chain owns face selection.`);
    if (entry.font.kind !== "resource-ref" || ir.resources[entry.font.id]?.kind !== "font") {
      fail(node, "CUT_FLOW_TEXT_RESOURCE", `spans[${index}].font must reference an explicit locked FontAsset; host fallback and synthetic faces are forbidden.`);
    }
    fontId = entry.font.id;
    if (fontId === base.fontId) fail(node, "CUT_FLOW_TEXT_INPUT_SHAPE", `spans[${index}].font redundantly repeats the FlowText base font.`);
    const baseResource = ir.resources[base.fontId], overrideResource = ir.resources[fontId];
    if (baseResource?.sha256 && overrideResource?.sha256 && baseResource.sha256 === overrideResource.sha256) {
      fail(node, "CUT_FLOW_TEXT_INPUT_SHAPE", `spans[${index}].font resolves to the same locked bytes as the FlowText base font; omit the redundant face override.`);
    }
  }
  const size = entry.size === undefined ? base.size : number(node, entry.size, `spans[${index}].size`, "length"), tracking = entry.tracking === undefined ? base.tracking : number(node, entry.tracking, `spans[${index}].tracking`, "length"), baselineShift = entry.baselineShift === undefined ? base.baselineShift : number(node, entry.baselineShift, `spans[${index}].baselineShift`, "length");
  if (complex && tracking !== 0) fail(node, "CUT_FLOW_TEXT_SHAPING", `spans[${index}].tracking must be omitted or zero under textShaping; arbitrary post-shaping letter spacing would split shaped-cluster positioning.`);
  if (size < 1 || size > referenceFlowTextLimits.maxFontSize) fail(node, "CUT_FLOW_TEXT_VALUE_RANGE", `spans[${index}].size must be from 1 through ${referenceFlowTextLimits.maxFontSize}px.`);
  if (Math.abs(tracking) > referenceFlowTextLimits.maxTracking) fail(node, "CUT_FLOW_TEXT_VALUE_RANGE", `spans[${index}].tracking must be within ±${referenceFlowTextLimits.maxTracking}px.`);
  if (Math.abs(baselineShift) > referenceFlowTextLimits.maxBaselineShift) fail(node, "CUT_FLOW_TEXT_VALUE_RANGE", `spans[${index}].baselineShift must be within ±${referenceFlowTextLimits.maxBaselineShift}px.`);
  const resolvedColor = entry.color === undefined ? base.color : color(node, entry.color, `spans[${index}].color`);
  if (entry.size !== undefined && size === base.size) fail(node, "CUT_FLOW_TEXT_INPUT_SHAPE", `spans[${index}].size redundantly repeats the FlowText base size.`);
  if (entry.tracking !== undefined && tracking === base.tracking) fail(node, "CUT_FLOW_TEXT_INPUT_SHAPE", `spans[${index}].tracking redundantly repeats the FlowText base tracking.`);
  if (entry.baselineShift !== undefined && baselineShift === base.baselineShift) fail(node, "CUT_FLOW_TEXT_INPUT_SHAPE", `spans[${index}].baselineShift redundantly repeats the FlowText base baselineShift.`);
  if (entry.color !== undefined && resolvedColor.color === base.color.color && resolvedColor.opacity === base.color.opacity) fail(node, "CUT_FLOW_TEXT_INPUT_SHAPE", `spans[${index}].color redundantly repeats the FlowText base color.`);
  return { id, content, fontId, size, color: resolvedColor, tracking, baselineShift };
}

function motion(node: IRNode, value: IRValue, index: number, complex: boolean): ReferenceTextUnitMotion {
  const entry = closedObject(node, value, `motions[${index}]`, ["span", "by", "duration"], ["order", "start", "count", "at", "each", "from", "to", "easing", "before"]);
  const by = string(node, entry.by, `motions[${index}].by`);
  if (by !== "line" && by !== "word" && by !== "glyph" && by !== "cluster") fail(node, "CUT_FLOW_TEXT_INPUT_ENUM", `motions[${index}].by must be exactly one of: line, word, glyph, cluster.`);
  if (!complex && by === "cluster") fail(node, "CUT_FLOW_TEXT_SHAPING", `motions[${index}].by “cluster” requires an executing textShaping profile.`);
  if (complex && by === "glyph") fail(node, "CUT_FLOW_TEXT_SELECTION", `motions[${index}].by “glyph” is forbidden under textShaping because it could split a shaped cluster; select cluster, word, or line.`);
  let order: ReferenceFlowTextUnitOrder | undefined;
  if (entry.order !== undefined) {
    order = string(node, entry.order, `motions[${index}].order`) as ReferenceFlowTextUnitOrder;
    if (order !== "logical" && order !== "visual") fail(node, "CUT_FLOW_TEXT_INPUT_ENUM", `motions[${index}].order must be exactly one of: logical, visual.`);
    if (!complex || by !== "cluster") fail(node, "CUT_FLOW_TEXT_INPUT_SHAPE", `motions[${index}].order may be authored only for a cluster selector under textShaping.`);
    if (order === "logical") fail(node, "CUT_FLOW_TEXT_INPUT_SHAPE", `motions[${index}].order redundantly authors “logical”; omission already selects shaped clusters in logical source order.`);
  }
  const easing = closedEasing(node, entry.easing, `motions[${index}].easing`);
  let parsedEasing: ReferenceEasing;
  try { parsedEasing = parseReferenceEasing(easing); }
  catch (error) { fail(node, "CUT_FLOW_TEXT_INPUT_ENUM", `motions[${index}].easing ${error instanceof Error ? error.message : String(error)}`); }
  const at = entry.at === undefined ? zeroRational : quantity(node, entry.at, `motions[${index}].at`, "time").magnitude;
  const each = entry.each === undefined ? zeroRational : quantity(node, entry.each, `motions[${index}].each`, "time").magnitude;
  const duration = quantity(node, entry.duration, `motions[${index}].duration`, "time").magnitude;
  if (compareRational(at, zeroRational) < 0 || compareRational(each, zeroRational) < 0 || compareRational(duration, zeroRational) <= 0) fail(node, "CUT_FLOW_TEXT_MOTION", `motions[${index}] requires non-negative at/each and positive duration.`);
  const from = entry.from === undefined ? identityPose : pose(node, entry.from, `motions[${index}].from`), to = entry.to === undefined ? identityPose : pose(node, entry.to, `motions[${index}].to`);
  if (samePose(from, to)) fail(node, "CUT_FLOW_TEXT_MOTION", `motions[${index}] has identical from/to poses and would be inert.`);
  if (from.opacity === 0 && to.opacity === 0) fail(node, "CUT_FLOW_TEXT_MOTION", `motions[${index}] keeps opacity at zero, so its other pose fields cannot affect pixels.`);
  if (from.scale === 0 && to.scale === 0) fail(node, "CUT_FLOW_TEXT_MOTION", `motions[${index}] keeps scale at zero, so its other pose fields cannot affect glyph pixels.`);
  const before = entry.before === undefined ? "base" : string(node, entry.before, `motions[${index}].before`);
  if (before !== "base" && before !== "from") fail(node, "CUT_FLOW_TEXT_INPUT_ENUM", `motions[${index}].before must be exactly one of: base, from.`);
  if (entry.before !== undefined && before === "base") fail(node, "CUT_FLOW_TEXT_INPUT_SHAPE", `motions[${index}] redundantly authors before: “base”; omission already uses the base pose before its first sample.`);
  if (before === "from" && samePose(from, identityPose)) fail(node, "CUT_FLOW_TEXT_MOTION", `motions[${index}] redundantly authors before: “from” with an identity from pose; omit before.`);
  return {
    span: string(node, entry.span, `motions[${index}].span`),
    by,
    ...(order ? { order } : {}),
    start: entry.start === undefined ? 0 : integer(node, entry.start, `motions[${index}].start`, 0, referenceFlowTextLimits.maxUnitsPerNode - 1),
    ...(entry.count === undefined ? {} : { count: integer(node, entry.count, `motions[${index}].count`, 1, referenceFlowTextLimits.maxUnitsPerNode) }),
    at,
    each,
    duration,
    from,
    to,
    easing,
    parsedEasing,
    before,
    beforeAuthored: entry.before !== undefined,
  };
}

/** Parse one closed public FlowText IR contract before any font bytes or frame work. */
export function referenceFlowTextConfig(
  node: IRNode,
  ir: CutAVIR,
  composition: IRComposition,
  layoutContext?: ReferenceTextLayoutContext,
): ReferenceFlowTextConfig | undefined {
  if (node.op !== "cut.visual.flow_text") return undefined;
  const font = node.inputs.font;
  if (font?.kind !== "resource-ref" || ir.resources[font.id]?.kind !== "font") fail(node, "CUT_FLOW_TEXT_RESOURCE", `font must reference one explicit locked FontAsset; textSpan may select other explicit locked faces, but implicit fallback and synthetic faces are forbidden.`);
  const shapingConfig = shaping(node, ir, font.id);
  const baseSize = number(node, node.inputs.size, "size", "length"), baseTracking = node.inputs.tracking === undefined ? 0 : number(node, node.inputs.tracking, "tracking", "length"), baseBaselineShift = node.inputs.baselineShift === undefined ? 0 : number(node, node.inputs.baselineShift, "baselineShift", "length");
  if (baseSize < 1 || baseSize > referenceFlowTextLimits.maxFontSize) fail(node, "CUT_FLOW_TEXT_VALUE_RANGE", `size must be from 1 through ${referenceFlowTextLimits.maxFontSize}px.`);
  if (Math.abs(baseTracking) > referenceFlowTextLimits.maxTracking) fail(node, "CUT_FLOW_TEXT_VALUE_RANGE", `tracking must be within ±${referenceFlowTextLimits.maxTracking}px.`);
  if (shapingConfig && baseTracking !== 0) fail(node, "CUT_FLOW_TEXT_SHAPING", `tracking must be omitted or zero under textShaping; arbitrary post-shaping letter spacing would split shaped-cluster positioning.`);
  if (Math.abs(baseBaselineShift) > referenceFlowTextLimits.maxBaselineShift) fail(node, "CUT_FLOW_TEXT_VALUE_RANGE", `baselineShift must be within ±${referenceFlowTextLimits.maxBaselineShift}px.`);
  const baseStyle = { fontId: font.id, size: baseSize, color: color(node, node.inputs.color, "color"), tracking: baseTracking, baselineShift: baseBaselineShift };
  const spans = exactArray(node, node.inputs.spans, "spans", 1, referenceFlowTextLimits.maxSpansPerNode).map((value, index) => span(node, ir, value, index, baseStyle, Boolean(shapingConfig)));
  if (!spans.some((item) => item.fontId === font.id)) {
    fail(node, "CUT_FLOW_TEXT_INPUT_SHAPE", `FlowText.font has no inheriting span because every textSpan overrides it; keep one inherited run or make the intended primary face the FlowText base.`);
  }
  const ids = new Set<string>();
  for (const item of spans) { if (ids.has(item.id)) fail(node, "CUT_FLOW_TEXT_INPUT_SHAPE", `span id “${item.id}” is duplicated; motion targeting requires unique stable identities.`); ids.add(item.id); }
  const content = spans.map((item) => item.content).join("");
  if ([...content].length > referenceFlowTextLimits.maxCodePointsPerNode) fail(node, "CUT_FLOW_TEXT_BUDGET", `combined span content exceeds ${referenceFlowTextLimits.maxCodePointsPerNode} code points.`);
  if (/^(?: |\n)|(?: |\n)$| {2}| \n|\n |\n\n/.test(content)) fail(node, "CUT_FLOW_TEXT_INPUT_SHAPE", `combined span content must use single interior spaces and non-empty LF-separated lines; leading, trailing, repeated, or line-adjacent whitespace is refused so reflow identity stays explicit.`);
  const sameStyle = (left: ReferenceTextSpan, right: ReferenceTextSpan) => left.fontId === right.fontId && left.size === right.size && left.tracking === right.tracking && left.baselineShift === right.baselineShift && left.color.color === right.color.color && left.color.opacity === right.color.opacity;
  for (let index = 1; index < spans.length; index += 1) {
    const left = spans[index - 1].content.at(-1)!, right = spans[index].content[0]!;
    if (shapingConfig && left !== " " && left !== "\n" && right !== " " && right !== "\n") {
      fail(node, "CUT_FLOW_TEXT_SHAPING", `span boundary “${spans[index - 1].id}”/“${spans[index].id}” bisects one complex shaping token; shaped-cluster ownership requires boundaries at ASCII space or LF.`);
    }
    if (left !== " " && left !== "\n" && right !== " " && right !== "\n" && spans[index - 1].fontId !== spans[index].fontId) {
      fail(node, "CUT_FLOW_TEXT_SHAPING", `span boundary “${spans[index - 1].id}”/“${spans[index].id}” changes locked face inside one non-whitespace shaped run; move the face change to whitespace. CUT will not split contextual shaping or synthesize a fallback run.`);
    }
    if (left !== " " && left !== "\n" && right !== " " && right !== "\n" && !sameStyle(spans[index - 1], spans[index])) {
      fail(node, "CUT_FLOW_TEXT_SHAPING", `span boundary “${spans[index - 1].id}”/“${spans[index].id}” splits a non-whitespace run with different styles; move the boundary to whitespace so shaping identity is not silently lost.`);
    }
  }
  const maximumSize = Math.max(...spans.map((item) => item.size));
  const localView = layoutContext
    ? {
        minX: -layoutContext.originX,
        minY: -layoutContext.originY,
        maxX: layoutContext.width - layoutContext.originX,
        maxY: layoutContext.height - layoutContext.originY,
      }
    : undefined;
  const numeric = (name: "layoutX" | "baselineY" | "maxWidth" | "lineHeight", fallback: number) => node.inputs[name] === undefined ? fallback : number(node, node.inputs[name], name, "length");
  const layoutX = numeric("layoutX", localView ? (localView.minX + localView.maxX) / 2 : 96);
  const baselineY = numeric("baselineY", localView ? (localView.minY + localView.maxY) / 2 : maximumSize);
  if ([layoutX, baselineY].some((item) => Math.abs(item) > referenceFlowTextLimits.maxAbsoluteCoordinate)) fail(node, "CUT_FLOW_TEXT_VALUE_RANGE", `layoutX/baselineY must be within ±${referenceFlowTextLimits.maxAbsoluteCoordinate}px.`);
  const align = node.inputs.align === undefined ? "start" : string(node, node.inputs.align, "align");
  if (align !== "start" && align !== "middle" && align !== "end") fail(node, "CUT_FLOW_TEXT_INPUT_ENUM", `align must be exactly one of: start, middle, end.`);
  const localDefaultMaxWidth = localView
    ? align === "start"
      ? localView.maxX - layoutX
      : align === "end"
        ? layoutX - localView.minX
        : Math.min(layoutX - localView.minX, localView.maxX - layoutX) * 2
    : undefined;
  const maxWidth = numeric("maxWidth", Math.max(1, localDefaultMaxWidth ?? composition.width - layoutX - 80));
  const lineHeight = numeric("lineHeight", maximumSize * 1.08);
  if (maxWidth < 1 || maxWidth > referenceFlowTextLimits.maxAbsoluteCoordinate) fail(node, "CUT_FLOW_TEXT_VALUE_RANGE", `maxWidth must be from 1 through ${referenceFlowTextLimits.maxAbsoluteCoordinate}px.`);
  if (lineHeight < maximumSize * .5 || lineHeight > maximumSize * 4) fail(node, "CUT_FLOW_TEXT_VALUE_RANGE", `lineHeight must be from 0.5× through 4× the largest span size.`);
  const maxLines = node.inputs.maxLines === undefined
    ? Math.min(referenceFlowTextLimits.maxLines, Math.max(1, Math.floor(((localView?.maxY ?? composition.height) - baselineY + maximumSize) / lineHeight)))
    : integer(node, node.inputs.maxLines, "maxLines", 1, referenceFlowTextLimits.maxLines);
  const motions = node.inputs.motions === undefined ? [] : exactArray(node, node.inputs.motions, "motions", 1, referenceFlowTextLimits.maxMotionsPerNode).map((value, index) => motion(node, value, index, Boolean(shapingConfig)));
  for (const authored of motions) if (!ids.has(authored.span)) fail(node, "CUT_FLOW_TEXT_SELECTION", `motion references unknown stable span id “${authored.span}”.`);
  const fontIds = Object.freeze(shapingConfig
    ? [font.id, ...shapingConfig.fallbackFontIds]
    : [...new Set(spans.map((item) => item.fontId))]);
  const fontResources = Object.freeze(fontIds.map((id) => {
    const resource = ir.resources[id];
    if (!resource || resource.kind !== "font") fail(node, "CUT_FLOW_TEXT_RESOURCE", `resolved face ${id} is not a FontAsset.`);
    return Object.freeze({ id, locator: resource.locator, ...(resource.sha256 ? { sha256: resource.sha256 } : {}) });
  }));
  return {
    nodeId: node.id,
    fontId: font.id,
    fontIds,
    fontResources,
    baseStyle,
    spans,
    ...(shapingConfig ? { shaping: shapingConfig } : {}),
    motions,
    layoutX,
    baselineY,
    maxWidth,
    lineHeight,
    maxLines,
    align,
  };
}

type Word = {
  shaped: ReturnType<typeof lockedGlyphUnits>;
  glyphSpanIndices: readonly number[];
  style: ReferenceTextSpan;
  x: number;
  lineIndex: number;
  wordIndex: number;
};

function unitBounds(glyphs: readonly PreparedGlyph[], indices: readonly number[]): PreparedUnit {
  const selected = indices.map((index) => glyphs[index]);
  const left = Math.min(...selected.map((glyph) => glyph.bounds.left)), right = Math.max(...selected.map((glyph) => glyph.bounds.right));
  const top = Math.min(...selected.map((glyph) => glyph.bounds.top)), bottom = Math.max(...selected.map((glyph) => glyph.bounds.bottom));
  return { glyphs: indices, pivotX: (left + right) / 2, pivotY: (top + bottom) / 2 };
}

function selectorUnits(
  node: IRNode,
  glyphs: readonly PreparedGlyph[],
  spanIndex: number,
  by: ReferenceFlowTextUnitKind,
  order: ReferenceFlowTextUnitOrder = "logical",
) {
  const selected = glyphs.map((glyph, index) => ({ glyph, index })).filter(({ glyph }) => glyph.spanIndex === spanIndex);
  if (by === "glyph") return selected.map(({ index }) => unitBounds(glyphs, [index]));
  if (by === "cluster") {
    const groups = new Map<string, { indices: number[]; logical: number; visual: number }>();
    for (const { glyph, index } of selected) {
      if (glyph.clusterId === undefined || glyph.clusterLogicalIndex === undefined || glyph.clusterVisualIndex === undefined) {
        fail(node, "CUT_FLOW_TEXT_SELECTION", "internal shaped-cluster metadata is missing.");
      }
      const group = groups.get(glyph.clusterId) ?? {
        indices: [],
        logical: glyph.clusterLogicalIndex,
        visual: glyph.clusterVisualIndex,
      };
      group.indices.push(index);
      groups.set(glyph.clusterId, group);
    }
    return [...groups.values()]
      .sort((left, right) => (order === "visual" ? left.visual - right.visual : left.logical - right.logical))
      .map(({ indices }) => unitBounds(glyphs, indices));
  }
  const groups = new Map<number, number[]>();
  for (const { glyph, index } of selected) {
    const key = by === "word" ? glyph.wordIndex : glyph.lineIndex;
    const group = groups.get(key) ?? []; group.push(index); groups.set(key, group);
  }
  return [...groups.entries()].sort(([left], [right]) => left - right).map(([, indices]) => unitBounds(glyphs, indices));
}

function hasInteriorOutputFrame(start: Rational, end: Rational, fps: Rational) {
  const scaled = multiplyRational(start, fps), numerator = BigInt(scaled.numerator), denominator = BigInt(scaled.denominator);
  const next = numerator / denominator + 1n;
  return compareRational(divideRational(rational(next), fps), end) < 0;
}

export type ReferenceFlowTextFonts = LockedOpenTypeFont | ReadonlyMap<string, LockedOpenTypeFont>;

function preparedFace(
  node: IRNode,
  config: ReferenceFlowTextConfig,
  fonts: ReferenceFlowTextFonts,
  fontId: string,
) {
  const expected = config.fontResources.find((item) => item.id === fontId);
  if (!expected) fail(node, "CUT_FLOW_TEXT_RESOURCE", `resolved span face ${fontId} is absent from the closed FlowText font set.`);
  const prepared = typeof (fonts as ReadonlyMap<string, LockedOpenTypeFont>).get === "function"
    ? (fonts as ReadonlyMap<string, LockedOpenTypeFont>).get(fontId)
    : fontId === config.fontId ? fonts as LockedOpenTypeFont : undefined;
  if (!prepared) fail(node, "CUT_FLOW_TEXT_RESOURCE", `locked FontAsset ${fontId} was not prepared; CUT will not use host fallback or synthesize a face.`);
  if (prepared.locator !== expected.locator || (expected.sha256 !== undefined && prepared.sha256 !== expected.sha256)) {
    fail(node, "CUT_FLOW_TEXT_RESOURCE", `prepared face ${fontId} does not match its locked locator/hash identity.`);
  }
  return prepared;
}

function prepareFlowTextMotionSchedules(
  node: IRNode,
  config: ReferenceFlowTextConfig,
  glyphs: readonly PreparedGlyph[],
  composition: IRComposition,
) {
  const schedules = new Map<number, Array<{ selector: string; unit: PreparedUnit; start: Rational; end: Rational; from: ReferenceTextUnitPose; to: ReferenceTextUnitPose; easing: IRValue; before: "base" | "from"; beforeAuthored: boolean }>>();
  const preparedMotions: PreparedMotion[] = [];
  let scheduleAssignments = 0;
  for (const authored of config.motions) {
    const spanIndex = config.spans.findIndex((span) => span.id === authored.span);
    const units = selectorUnits(node, glyphs, spanIndex, authored.by, authored.order);
    const count = authored.count ?? units.length - authored.start;
    const endIndex = authored.start + count;
    if (count < 1) fail(node, "CUT_FLOW_TEXT_SELECTION", `motion starts at ${authored.start} in span “${authored.span}”, which has only ${units.length} stable ${authored.by} units; omitted count cannot select an empty remainder.`);
    if (endIndex > units.length) fail(node, "CUT_FLOW_TEXT_SELECTION", `motion selects ${authored.by} units [${authored.start}, ${endIndex}) in span “${authored.span}”, which has ${units.length} stable ${authored.by} units.`);
    const selected = units.slice(authored.start, endIndex);
    const selector = `${authored.span}:${authored.by}:${authored.order ?? "logical"}:${authored.start}:${count}`;
    const hasPreStartInterval = compareRational(authored.at, zeroRational) > 0 || (selected.length > 1 && compareRational(authored.each, zeroRational) > 0);
    if (authored.before === "base" && !samePose(authored.from, identityPose) && hasPreStartInterval) {
      fail(node, "CUT_FLOW_TEXT_MOTION", `motion selector ${selector} has delayed units but a non-identity from pose with the default base pre-start state; author before: “from” to hold the entrance pose without a start-time jump.`);
    }
    if (authored.beforeAuthored && authored.before === "from" && compareRational(authored.at, zeroRational) === 0 && (selected.length === 1 || compareRational(authored.each, zeroRational) === 0)) {
      fail(node, "CUT_FLOW_TEXT_MOTION", `motion selector ${selector} authors before: “from” but every selected unit starts at local 0s, so no pre-start interval can execute that choice; omit before.`);
    }
    selected.forEach((unit, offset) => {
      const start = addRational(authored.at, multiplyRational(authored.each, rational(offset)));
      const end = addRational(start, authored.duration);
      if (compareRational(end, node.interval.duration) > 0) fail(node, "CUT_FLOW_TEXT_MOTION", `motion selector ${selector} ends after the FlowText node's exact local interval.`);
      if (!hasInteriorOutputFrame(start, end, composition.fps)) fail(node, "CUT_FLOW_TEXT_MOTION", `motion selector ${selector} unit ${offset} has no exact output-frame sample strictly inside its interval, so easing would be unobservable.`);
      for (const glyphIndex of unit.glyphs) {
        scheduleAssignments += 1;
        if (scheduleAssignments > referenceFlowTextLimits.maxScheduleAssignmentsPerNode) fail(node, "CUT_FLOW_TEXT_BUDGET", `motion schedule exceeds ${referenceFlowTextLimits.maxScheduleAssignmentsPerNode} shaped-glyph assignments.`);
        const existing = schedules.get(glyphIndex) ?? [];
        if (existing.some((item) => item.selector !== selector)) fail(node, "CUT_FLOW_TEXT_SELECTION", `one shaped glyph is selected by incompatible unit selectors; selectors may repeat only when their exact span/by/order/start/count identity matches.`);
        existing.push({ selector, unit, start, end, from: authored.from, to: authored.to, easing: authored.easing, before: authored.before, beforeAuthored: authored.beforeAuthored });
        schedules.set(glyphIndex, existing);
      }
    });
    preparedMotions.push({ ...authored, count, selector, selected });
  }
  for (const sequence of schedules.values()) {
    sequence.sort((left, right) => compareRational(left.start, right.start));
    for (let index = 1; index < sequence.length; index += 1) {
      const previous = sequence[index - 1], next = sequence[index];
      if (compareRational(next.start, previous.end) < 0) fail(node, "CUT_FLOW_TEXT_MOTION", `repeated unit motions overlap in exact local time.`);
      if (!samePose(previous.to, next.from)) fail(node, "CUT_FLOW_TEXT_MOTION", `repeated unit motions must be pose-continuous: the previous to pose must equal the next from pose.`);
      if (next.beforeAuthored) fail(node, "CUT_FLOW_TEXT_MOTION", `before may be authored only on the first motion for one exact selector; later state is already owned by prior pose continuity.`);
    }
  }
  return { schedules, preparedMotions };
}

/** Resolve wrapping, shaped glyph identity, selectors, pivots, and exact motion schedules from explicit locked faces. */
export function prepareReferenceFlowText(node: IRNode, config: ReferenceFlowTextConfig, fonts: ReferenceFlowTextFonts, composition: IRComposition): PreparedReferenceFlowText {
  try {
    const fontFor = (style: ReferenceTextSpan) => preparedFace(node, config, fonts, style.fontId);
    const characters = config.spans.flatMap((item, spanIndex) => [...item.content].map((value) => ({ value, spanIndex }))), combined = characters.map(({ value }) => value).join("");
    const tokens = [...combined.matchAll(/\n| |[^ \n]+/g)].map((match) => {
      const value = match[0], selected = characters.slice(match.index, match.index + value.length);
      const segments: Array<{ spanIndex: number; value: string }> = [];
      for (const character of selected) {
        const previous = segments.at(-1);
        if (previous?.spanIndex === character.spanIndex) previous.value += character.value;
        else segments.push({ spanIndex: character.spanIndex, value: character.value });
      }
      return { kind: value === "\n" ? "newline" as const : value === " " ? "space" as const : "word" as const, value, segments };
    });
    const lines: Array<{ words: Word[]; width: number }> = [];
    let current: { words: Word[]; width: number } = { words: [], width: 0 }, pendingSpace: { spanIndex: number; width: number } | undefined;
    let wordIndex = 0, outlineCommands = 0, outlineBytes = 0;
    const finishLine = () => { if (!current.words.length) fail(node, "CUT_FLOW_TEXT_INPUT_SHAPE", `explicit/reflowed empty lines are unsupported.`); lines.push(current); current = { words: [], width: 0 }; pendingSpace = undefined; };
    for (const token of tokens) {
      if (token.kind === "space") {
        const spanIndex = token.segments[0].spanIndex, style = config.spans[spanIndex];
        pendingSpace = { spanIndex, width: lockedGlyphAdvance(fontFor(style), " ", style.size, style.tracking) };
        continue;
      }
      if (token.kind === "newline") { finishLine(); continue; }
      const style = config.spans[token.segments[0].spanIndex], remainingCommands = referenceFlowTextLimits.maxOutlineCommandsPerNode - outlineCommands, remainingBytes = referenceFlowTextLimits.maxOutlineBytesPerNode - outlineBytes;
      if (remainingCommands < 1 || remainingBytes < 1) fail(node, "CUT_FLOW_TEXT_BUDGET", `locked outlines exceed the per-node preparation budget.`);
      const face = fontFor(style);
      const shaped = lockedGlyphUnits(face, token.value, style.size, { maxCommands: remainingCommands, maxPathBytes: remainingBytes }, style.tracking);
      const counts = token.segments.map((segment) => lockedGlyphCount(face, segment.value, style.size, style.tracking));
      if (counts.reduce((total, count) => total + count, 0) !== shaped.units.length) {
        fail(node, "CUT_FLOW_TEXT_SHAPING", `equal-style span boundary inside word “${token.value}” changes contextual/ligature glyph selection; move that boundary to whitespace so stable span ownership is provable.`);
      }
      const glyphSpanIndices = token.segments.flatMap((segment, index) => Array.from({ length: counts[index] }, () => segment.spanIndex));
      outlineCommands += shaped.commands; outlineBytes += shaped.pathBytes;
      if (shaped.advance > config.maxWidth + 1e-7) fail(node, "CUT_FLOW_TEXT_SHAPING", `word “${token.value}” cannot fit maxWidth; FlowText refuses character splitting because it would destabilize word/glyph selection.`);
      let prefix = current.words.length ? pendingSpace?.width ?? 0 : 0;
      if (current.words.length && current.width + prefix + shaped.advance > config.maxWidth + 1e-7) { finishLine(); prefix = 0; }
      const word: Word = { shaped, glyphSpanIndices, style, x: current.width + prefix, lineIndex: lines.length, wordIndex: wordIndex++ };
      current.words.push(word); current.width = word.x + shaped.advance; pendingSpace = undefined;
    }
    finishLine();
    if (lines.length > config.maxLines) fail(node, "CUT_FLOW_TEXT_SHAPING", `layout needs ${lines.length} lines but maxLines is ${config.maxLines}; FlowText refuses silent truncation because it would invalidate stable unit selection.`);

    const glyphs: PreparedGlyph[] = [];
    lines.forEach((line, lineIndex) => {
      const lineStart = config.align === "start" ? config.layoutX : config.align === "middle" ? config.layoutX - line.width / 2 : config.layoutX - line.width;
      line.words.forEach((word) => {
        const translateX = lineStart + word.x, translateY = config.baselineY + lineIndex * config.lineHeight - word.style.baselineShift;
        word.shaped.units.forEach((glyph: LockedGlyphUnit, shapedIndex) => {
          const spanIndex = word.glyphSpanIndices[shapedIndex], style = config.spans[spanIndex];
          glyphs.push({
            pathData: glyph.pathData,
            fontId: style.fontId,
            spanIndex,
            lineIndex,
            wordIndex: word.wordIndex,
            glyphIndex: glyphs.filter((candidate) => candidate.spanIndex === spanIndex).length,
            translateX,
            translateY,
            bounds: { left: translateX + glyph.x1, right: translateX + glyph.x2, top: translateY + glyph.y1, bottom: translateY + glyph.y2 },
            color: style.color,
          });
        });
      });
    });
    if (!glyphs.length || glyphs.length > referenceFlowTextLimits.maxUnitsPerNode) fail(node, "CUT_FLOW_TEXT_BUDGET", `layout must resolve 1 through ${referenceFlowTextLimits.maxUnitsPerNode} shaped glyphs.`);

    const { schedules, preparedMotions } = prepareFlowTextMotionSchedules(node, config, glyphs, composition);
    return { sourceNode: node, config, glyphs, motions: preparedMotions, schedules, lineCount: lines.length, wordCount: wordIndex, outlineCommands, outlineBytes };
  } catch (error) {
    if (error instanceof ReferenceFlowTextError) throw error;
    fail(node, "CUT_FLOW_TEXT_SHAPING", error instanceof Error ? error.message : String(error));
  }
}

export type ReferenceFlowTextFontBytes = ReadonlyMap<string, Uint8Array>;

type ComplexSpanRange = Readonly<{ start: number; end: number; index: number; style: ReferenceTextSpan }>;
type ComplexWordRange = Readonly<{ start: number; end: number; index: number }>;
type ComplexLineCluster = Readonly<{
  cluster: ReferenceComplexTextCluster;
  result: ReferenceComplexTextShapingResult;
  paragraphText: string;
  paragraphStart: number;
  globalStart: number;
  globalEnd: number;
  span: ComplexSpanRange;
  wordIndex: number;
  fontUnitsPerEm: number;
  width: number;
  id: string;
  visible: boolean;
}>;
type ComplexLine = Readonly<{
  lineIndex: number;
  width: number;
  clusters: readonly ComplexLineCluster[];
}>;

function complexSpanRanges(config: ReferenceFlowTextConfig) {
  let cursor = 0;
  return config.spans.map((style, index) => {
    const range = Object.freeze({ start: cursor, end: cursor + style.content.length, index, style });
    cursor = range.end;
    return range;
  });
}

function complexSpanForRange(node: IRNode, ranges: readonly ComplexSpanRange[], start: number, end: number) {
  const span = ranges.find((candidate) => start >= candidate.start && end <= candidate.end);
  if (!span) fail(node, "CUT_FLOW_TEXT_SHAPING", `shaped cluster ${start}...${end} crosses an authored textSpan boundary.`);
  return span;
}

function complexLineStart(config: ReferenceFlowTextConfig, width: number) {
  if (config.align === "middle") return config.layoutX - width / 2;
  const rtl = config.shaping?.paragraphDirection === "rtl";
  if (config.align === "start") return rtl ? config.layoutX - width : config.layoutX;
  return rtl ? config.layoutX : config.layoutX - width;
}

/**
 * Prepare the additive complex-text profile. HarfBuzz decides glyph
 * substitution/positioning and cluster identity; opentype.js is used only to
 * materialize the already-selected locked glyph IDs into deterministic paths.
 */
export async function prepareReferenceComplexFlowText(
  node: IRNode,
  config: ReferenceFlowTextConfig,
  fonts: ReadonlyMap<string, LockedOpenTypeFont>,
  bytes: ReferenceFlowTextFontBytes,
  composition: IRComposition,
): Promise<PreparedReferenceFlowText> {
  try {
    const shaping = config.shaping;
    if (!shaping) fail(node, "CUT_FLOW_TEXT_SHAPING", "complex preparation requires an authored textShaping profile.");
    const fontInputs: ReferenceComplexTextFont[] = config.fontResources.map((resource) => {
      const fontBytes = bytes.get(resource.id), parsed = fonts.get(resource.id);
      if (!fontBytes || !parsed) fail(node, "CUT_FLOW_TEXT_RESOURCE", `locked textShaping FontAsset ${resource.id} was not prepared.`);
      if (!resource.sha256 || parsed.sha256 !== resource.sha256) fail(node, "CUT_FLOW_TEXT_RESOURCE", `textShaping FontAsset ${resource.id} lacks or differs from its locked SHA-256 identity.`);
      return Object.freeze({
        id: resource.id,
        locator: resource.locator,
        bytes: Uint8Array.from(fontBytes),
        sha256: resource.sha256,
      });
    });
    const combined = config.spans.map((item) => item.content).join("");
    const spans = complexSpanRanges(config);
    const paragraphs: Array<{ text: string; start: number }> = [];
    let paragraphStart = 0;
    for (const text of combined.split("\n")) {
      if (!text) fail(node, "CUT_FLOW_TEXT_INPUT_SHAPE", "explicit empty paragraphs are unsupported.");
      paragraphs.push({ text, start: paragraphStart });
      paragraphStart += text.length + 1;
    }
    if (paragraphs.length > 16) fail(node, "CUT_FLOW_TEXT_BUDGET", "textShaping supports at most 16 explicit LF-delimited paragraphs per node.");

    const shapedParagraphs: Array<{ text: string; start: number; result: ReferenceComplexTextShapingResult }> = [];
    const wordRanges: ComplexWordRange[] = [];
    let wordIndex = 0;
    for (const paragraph of paragraphs) {
      const result = await shapeReferenceComplexText({
        text: paragraph.text,
        direction: shaping.paragraphDirection,
        language: shaping.language,
        fonts: fontInputs,
      }, {
        maximumTextCodeUnits: Math.min(16_384, paragraph.text.length),
        maximumTokens: Math.min(4_096, Math.max(1, paragraph.text.length)),
        maximumFonts: Math.max(1, fontInputs.length),
        maximumFontBytes: referenceFlowTextLimits.maxOutlineBytesPerNode * 4,
        maximumAggregateFontBytes: referenceFlowTextLimits.maxOutlineBytesPerNode * 8,
        maximumGlyphs: referenceFlowTextLimits.maxUnitsPerNode,
        maximumClusters: referenceFlowTextLimits.maxUnitsPerNode,
      });
      if (
        result.backend.integrity !== shaping.backendIdentity.integrity
        || hash(result.backend) !== hash(shaping.backendIdentity)
      ) {
        fail(node, "CUT_FLOW_TEXT_SHAPING", "executing complex-text backend identity differs from the feature authority bound by IR and cut.lock.");
      }
      shapedParagraphs.push({ ...paragraph, result });
      for (const token of result.tokens) {
        if (paragraph.text.slice(token.start, token.end) === " ") continue;
        wordRanges.push(Object.freeze({
          start: paragraph.start + token.start,
          end: paragraph.start + token.end,
          index: wordIndex++,
        }));
      }
    }

    type LineRange = { paragraph: typeof shapedParagraphs[number]; start: number; end: number };
    const lineRanges: LineRange[] = [];
    for (const paragraph of shapedParagraphs) {
      const clusterByToken = (start: number, end: number) => paragraph.result.logicalClusters.filter((cluster) => cluster.start >= start && cluster.end <= end);
      const tokenWidth = (start: number, end: number) => clusterByToken(start, end).reduce((total, cluster) => {
        const globalStart = paragraph.start + cluster.start, globalEnd = paragraph.start + cluster.end;
        const span = complexSpanForRange(node, spans, globalStart, globalEnd);
        const font = paragraph.result.fontChain.find((candidate) => candidate.id === cluster.fontId);
        if (!font) fail(node, "CUT_FLOW_TEXT_RESOURCE", `shaped cluster selected unknown face ${cluster.fontId}.`);
        return total + cluster.xAdvance * span.style.size / font.unitsPerEm;
      }, 0);
      let currentStart: number | undefined, currentEnd = 0, currentWidth = 0, pendingSpaceWidth = 0;
      const finish = () => {
        if (currentStart === undefined || currentEnd <= currentStart) fail(node, "CUT_FLOW_TEXT_INPUT_SHAPE", "complex wrapping produced an empty line.");
        lineRanges.push({ paragraph, start: currentStart, end: currentEnd });
        currentStart = undefined;
        currentEnd = 0;
        currentWidth = 0;
        pendingSpaceWidth = 0;
      };
      for (const token of paragraph.result.tokens) {
        const value = paragraph.text.slice(token.start, token.end);
        const width = tokenWidth(token.start, token.end);
        if (value === " ") {
          pendingSpaceWidth = width;
          continue;
        }
        if (!(width > 0) || width > config.maxWidth + 1e-7) {
          fail(node, "CUT_FLOW_TEXT_SHAPING", `whole shaping token “${value}” cannot fit maxWidth; character/cluster splitting is forbidden.`);
        }
        const prefix = currentStart === undefined ? 0 : pendingSpaceWidth;
        if (currentStart !== undefined && currentWidth + prefix + width > config.maxWidth + 1e-7) finish();
        if (currentStart === undefined) currentStart = token.start;
        currentEnd = token.end;
        currentWidth = (currentWidth === 0 ? 0 : currentWidth + prefix) + width;
        pendingSpaceWidth = 0;
      }
      finish();
    }
    if (lineRanges.length > config.maxLines) fail(node, "CUT_FLOW_TEXT_SHAPING", `layout needs ${lineRanges.length} lines but maxLines is ${config.maxLines}; silent truncation is forbidden.`);

    const lines: ComplexLine[] = [];
    const usedNonWhitespaceFonts = new Set<string>();
    for (const [lineIndex, range] of lineRanges.entries()) {
      const bidi = referenceComplexTextLineBidi(
        range.paragraph.text,
        shaping.paragraphDirection,
        range.start,
        range.end,
      );
      const visualRanks = new Map(bidi.visualCodeUnitOrder.map((logical, index) => [logical, index]));
      const selected = range.paragraph.result.logicalClusters
        .filter((cluster) => cluster.start >= range.start && cluster.end <= range.end)
        .map((cluster) => {
          const globalStart = range.paragraph.start + cluster.start;
          const globalEnd = range.paragraph.start + cluster.end;
          const span = complexSpanForRange(node, spans, globalStart, globalEnd);
          const word = wordRanges.find((candidate) => globalStart >= candidate.start && globalEnd <= candidate.end);
          const font = range.paragraph.result.fontChain.find((candidate) => candidate.id === cluster.fontId);
          if (!font) fail(node, "CUT_FLOW_TEXT_RESOURCE", `shaped cluster selected unknown face ${cluster.fontId}.`);
          const width = cluster.xAdvance * span.style.size / font.unitsPerEm;
          const id = hash({
            kind: "cut-flow-text-shaped-cluster-v1",
            nodeContentHash: node.contentHash,
            source: { start: globalStart, end: globalEnd },
            fontSha256: cluster.fontSha256,
            direction: shaping.paragraphDirection,
            language: shaping.language,
            backendIntegrity: range.paragraph.result.backend.integrity,
            glyphs: cluster.glyphs,
          });
          return {
            cluster,
            result: range.paragraph.result,
            paragraphText: range.paragraph.text,
            paragraphStart: range.paragraph.start,
            globalStart,
            globalEnd,
            span,
            wordIndex: word?.index ?? -1,
            fontUnitsPerEm: font.unitsPerEm,
            width,
            id,
            visible: range.paragraph.text.slice(cluster.start, cluster.end) !== " ",
            rank: Math.min(...Array.from({ length: cluster.end - cluster.start }, (_, offset) => visualRanks.get(cluster.start + offset) ?? Number.MAX_SAFE_INTEGER)),
          };
        })
        .sort((left, right) => left.rank - right.rank || left.globalStart - right.globalStart);
      const visible = selected.filter((item) => item.visible);
      visible.forEach((item) => usedNonWhitespaceFonts.add(item.cluster.fontId));
      const lineWidth = selected.reduce((total, item) => total + item.width, 0);
      lines.push(Object.freeze({
        lineIndex,
        width: lineWidth,
        clusters: Object.freeze(selected.map((item) => Object.freeze({
          ...item,
          cluster: item.cluster,
          result: item.result,
          id: item.id,
        }))),
      }));
    }
    for (const fontId of config.fontIds) {
      if (!usedNonWhitespaceFonts.has(fontId)) fail(node, "CUT_FLOW_TEXT_INPUT_SHAPE", `textShaping face ${fontId} is unused by every visible token; remove the misleading no-op face from the chain.`);
    }

    const logicalClusters = lines.flatMap((line) => line.clusters).filter((cluster) => cluster.visible).sort((left, right) => left.globalStart - right.globalStart || left.globalEnd - right.globalEnd);
    const logicalIndex = new Map(logicalClusters.map((cluster, index) => [cluster.id, index]));
    const visualClusters = lines.flatMap((line) => line.clusters).filter((cluster) => cluster.visible);
    const visualIndex = new Map(visualClusters.map((cluster, index) => [cluster.id, index]));
    const glyphs: PreparedGlyph[] = [];
    let outlineCommands = 0, outlineBytes = 0;
    for (const line of lines) {
      let cursor = complexLineStart(config, line.width);
      for (const item of line.clusters) {
        if (!item.visible) {
          cursor += item.width;
          continue;
        }
        const parsed = fonts.get(item.cluster.fontId);
        if (!parsed || parsed.sha256 !== item.cluster.fontSha256) fail(node, "CUT_FLOW_TEXT_RESOURCE", `shaped cluster face ${item.cluster.fontId} differs from its prepared locked outline face.`);
        const scale = item.span.style.size / item.fontUnitsPerEm;
        const baseline = config.baselineY + line.lineIndex * config.lineHeight - item.span.style.baselineShift;
        let glyphCursor = cursor;
        for (const shapedGlyph of item.cluster.glyphs) {
          const remainingCommands = referenceFlowTextLimits.maxOutlineCommandsPerNode - outlineCommands;
          const remainingBytes = referenceFlowTextLimits.maxOutlineBytesPerNode - outlineBytes;
          if (remainingCommands < 1 || remainingBytes < 1) fail(node, "CUT_FLOW_TEXT_BUDGET", "complex glyph outlines exceed the per-node preparation budget.");
          const outline = lockedGlyphIdOutline(
            parsed,
            shapedGlyph.glyphId,
            glyphCursor + shapedGlyph.xOffset * scale,
            baseline - shapedGlyph.yOffset * scale,
            item.span.style.size,
            { maxCommands: remainingCommands, maxPathBytes: remainingBytes },
          );
          outlineCommands += outline.commands;
          outlineBytes += outline.pathBytes;
          if (outline.commands > 0) {
            glyphs.push({
              pathData: outline.pathData,
              fontId: item.cluster.fontId,
              spanIndex: item.span.index,
              lineIndex: line.lineIndex,
              wordIndex: item.wordIndex,
              glyphIndex: glyphs.filter((candidate) => candidate.spanIndex === item.span.index).length,
              clusterId: item.id,
              clusterLogicalIndex: logicalIndex.get(item.id)!,
              clusterVisualIndex: visualIndex.get(item.id)!,
              clusterStart: item.globalStart,
              clusterEnd: item.globalEnd,
              translateX: 0,
              translateY: 0,
              bounds: { left: outline.x1, right: outline.x2, top: outline.y1, bottom: outline.y2 },
              color: item.span.style.color,
            });
          }
          glyphCursor += shapedGlyph.xAdvance * scale;
        }
        cursor += item.width;
      }
    }
    if (!glyphs.length || glyphs.length > referenceFlowTextLimits.maxUnitsPerNode) fail(node, "CUT_FLOW_TEXT_BUDGET", `layout must resolve 1 through ${referenceFlowTextLimits.maxUnitsPerNode} visible shaped glyphs.`);
    const { schedules, preparedMotions } = prepareFlowTextMotionSchedules(node, config, glyphs, composition);
    const backend = shapedParagraphs[0]!.result.backend;
    if (shapedParagraphs.some((paragraph) => paragraph.result.backend.integrity !== backend.integrity)) fail(node, "CUT_FLOW_TEXT_SHAPING", "complex-text backend identity changed during one preparation.");
    const fontChain = shapedParagraphs[0]!.result.fontChain;
    return {
      sourceNode: node,
      config,
      glyphs,
      motions: preparedMotions,
      schedules,
      lineCount: lines.length,
      wordCount: wordIndex,
      outlineCommands,
      outlineBytes,
      complexShaping: Object.freeze({
        backendIntegrity: backend.integrity,
        backend,
        clusterCount: logicalClusters.length,
        visualClusterIds: Object.freeze(visualClusters.map((cluster) => cluster.id)),
        fontChain,
      }),
    };
  } catch (error) {
    if (error instanceof ReferenceFlowTextError) throw error;
    fail(node, "CUT_FLOW_TEXT_SHAPING", error instanceof Error ? error.message : String(error));
  }
}

function interpolatePose(left: ReferenceTextUnitPose, right: ReferenceTextUnitPose, progress: number): ReferenceTextUnitPose {
  const mix = (a: number, b: number) => a + (b - a) * progress;
  return { x: mix(left.x, right.x), y: mix(left.y, right.y), opacity: mix(left.opacity, right.opacity), scale: mix(left.scale, right.scale), rotation: mix(left.rotation, right.rotation) };
}

function poseAt(node: IRNode, sequence: PreparedReferenceFlowText["schedules"] extends ReadonlyMap<number, infer T> ? T | undefined : never, time: Rational) {
  if (!sequence?.length) return { pose: identityPose, pivot: undefined as PreparedUnit | undefined };
  let previous = sequence[0];
  if (compareRational(time, previous.start) < 0) return { pose: previous.before === "from" ? previous.from : identityPose, pivot: previous.unit };
  for (const item of sequence) {
    if (compareRational(time, item.start) < 0) return { pose: previous.to, pivot: previous.unit };
    if (compareRational(time, item.end) <= 0) {
      const raw = rationalToNumber(divideRational(subtractRational(time, item.start), subtractRational(item.end, item.start)));
      try { return { pose: interpolatePose(item.from, item.to, easeReferenceProgress(raw, item.easing)), pivot: item.unit }; }
      catch (error) { fail(node, "CUT_FLOW_TEXT_MOTION", `easing failed at exact local time ${time.numerator}/${time.denominator}s: ${error instanceof Error ? error.message : String(error)}`); }
    }
    previous = item;
  }
  return { pose: previous.to, pivot: previous.unit };
}

function finite(value: number) {
  if (!Number.isFinite(value)) throw new Error("FlowText produced a non-finite SVG transform.");
  return Number(value.toFixed(6));
}

function validateExecutedPose(node: IRNode, pose: ReferenceTextUnitPose, localTime: Rational) {
  if (![pose.x, pose.y, pose.opacity, pose.scale, pose.rotation].every(Number.isFinite)) fail(node, "CUT_FLOW_TEXT_MOTION", `motion produced a non-finite pose at exact local time ${localTime.numerator}/${localTime.denominator}s.`);
  if (Math.abs(pose.x) > referenceFlowTextLimits.maxAbsoluteCoordinate || Math.abs(pose.y) > referenceFlowTextLimits.maxAbsoluteCoordinate) fail(node, "CUT_FLOW_TEXT_MOTION", `easing overshoot moved a unit beyond ±${referenceFlowTextLimits.maxAbsoluteCoordinate}px at exact local time ${localTime.numerator}/${localTime.denominator}s.`);
  if (pose.opacity < 0 || pose.opacity > 1) fail(node, "CUT_FLOW_TEXT_MOTION", `easing overshoot produced opacity outside 0% through 100% at exact local time ${localTime.numerator}/${localTime.denominator}s.`);
  if (pose.scale < 0 || pose.scale > 8) fail(node, "CUT_FLOW_TEXT_MOTION", `easing overshoot produced scale outside 0 through 8 at exact local time ${localTime.numerator}/${localTime.denominator}s.`);
  if (Math.abs(pose.rotation) > 360_000) fail(node, "CUT_FLOW_TEXT_MOTION", `easing overshoot produced rotation outside ±360000deg at exact local time ${localTime.numerator}/${localTime.denominator}s.`);
}

/** Frame-local deterministic SVG; all text is already locked outline data.
 * A nonzero rasterOffset is used only by LocalSpace and translates the whole
 * authored-local layout exactly once at its bounded raster boundary. */
export function referenceFlowTextSvg(
  prepared: PreparedReferenceFlowText,
  localTime: Rational,
  width: number,
  height: number,
  rasterOffset?: Readonly<{ x: number; y: number }>,
) {
  const paths = prepared.glyphs.map((glyph, index) => {
    const { pose, pivot } = poseAt(prepared.sourceNode, prepared.schedules.get(index), localTime), pivotX = pivot?.pivotX ?? 0, pivotY = pivot?.pivotY ?? 0;
    validateExecutedPose(prepared.sourceNode, pose, localTime);
    const transform = [
      `translate(${finite(pose.x)} ${finite(pose.y)})`,
      `translate(${finite(pivotX)} ${finite(pivotY)})`,
      `rotate(${finite(pose.rotation)})`,
      `scale(${finite(pose.scale)})`,
      `translate(${finite(-pivotX)} ${finite(-pivotY)})`,
      `translate(${finite(glyph.translateX)} ${finite(glyph.translateY)})`,
    ].join(" ");
    return `<path d="${glyph.pathData}" fill="${glyph.color.color}" fill-opacity="${finite(glyph.color.opacity * pose.opacity)}" transform="${transform}"/>`;
  }).join("");
  const translated = rasterOffset && (rasterOffset.x !== 0 || rasterOffset.y !== 0)
    ? `<g transform="translate(${finite(rasterOffset.x)} ${finite(rasterOffset.y)})">${paths}</g>`
    : paths;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${translated}</svg>`;
}

export function referenceFlowTextInspect(config: ReferenceFlowTextConfig) {
  const legacy = {
    contract: "cut-reference-flow-text-v2",
    fontId: config.fontId,
    fonts: config.fontResources.map((font) => ({ id: font.id, locator: font.locator, sha256: font.sha256 ?? "unlocked" })),
    baseStyle: config.baseStyle,
    spans: config.spans.map((span, index) => ({ id: span.id, index, codePoints: [...span.content].length, fontId: span.fontId, sizePx: span.size, trackingPx: span.tracking, baselineShiftPx: span.baselineShift, color: span.color })),
    layout: { layoutX: config.layoutX, baselineY: config.baselineY, maxWidth: config.maxWidth, lineHeight: config.lineHeight, maxLines: config.maxLines, align: config.align },
    lineMetrics: {
      baseline: "one-authored-baseline-grid-for-all-explicit-faces",
      lineAdvance: "authored-lineHeight-or-largest-span-size-times-1.08",
      glyphMetrics: "per-face-locked-outline-at-authored-size",
      whitespaceAdvance: "face-of-span-owning-space",
    },
    motions: config.motions.map((motion) => ({ span: motion.span, by: motion.by, start: motion.start, count: motion.count ?? "all-remaining", at: motion.at, each: motion.each, duration: motion.duration, easing: motion.parsedEasing, before: motion.before })),
    shapingBoundary: "printable-ascii-lf-explicit-locked-face-per-whitespace-run-no-fallback-v2",
    outerMotionCoordinates: ["x", "y"],
    outerMotionAuthoring: "component-input-or-set-animate",
  };
  if (!config.shaping) return legacy;
  return {
    ...legacy,
    contract: "cut-reference-flow-text-v3-complex",
    shaping: {
      paragraphDirection: config.shaping.paragraphDirection,
      language: config.shaping.language,
      primaryFontId: config.fontId,
      fallbackFontIds: [...config.shaping.fallbackFontIds],
      policy: config.shaping.policy,
      backend: referenceComplexTextBackendContract,
      backendIdentity: config.shaping.backendIdentity,
      selectors: {
        atomicUnit: "harfbuzz-monotone-grapheme-cluster",
        defaultOrder: "logical",
        admittedOrders: ["logical", "visual"],
        glyphSelector: "forbidden",
      },
      normalization: "none",
      hostFontFallback: false,
    },
    motions: config.motions.map((motion) => ({
      span: motion.span,
      by: motion.by,
      ...(motion.by === "cluster" ? { order: motion.order ?? "logical" } : {}),
      start: motion.start,
      count: motion.count ?? "all-remaining",
      at: motion.at,
      each: motion.each,
      duration: motion.duration,
      easing: motion.parsedEasing,
      before: motion.before,
    })),
    shapingBoundary: "harfbuzz-14.2.1-bidi-13-explicit-direction-whole-token-fallback-cluster-atomic-v1",
  };
}
