import { hash, stableStringify } from "../core/stable";
import type { IRComposition, IRValue } from "./ir";
import {
  addRational,
  compareRational,
  divideRational,
  multiplyRational,
  rational,
  subtractRational,
  type Rational,
  zeroRational,
} from "./rational";

export const cutResponsiveStackAlgorithmVersion = "cut-responsive-stack-plan-v1" as const;
export const cutResponsiveSlotMediaContextAlgorithmVersion = "cut-responsive-slot-media-context-v1" as const;

export const cutResponsiveStackLimits = Object.freeze({
  maximumChildren: 64,
  maximumCompositionAxisPx: 65_536,
  maximumGapPx: 65_536,
  maximumWeight: rational(1_000_000),
  maximumRationalDigits: 256,
});

export type CutResponsiveStackErrorCode =
  | "CUT_RESPONSIVE_STACK_CONTEXT"
  | "CUT_RESPONSIVE_STACK_PLAN_TYPE"
  | "CUT_RESPONSIVE_STACK_SHAPE"
  | "CUT_RESPONSIVE_STACK_BOUNDS"
  | "CUT_RESPONSIVE_STACK_GRAPH"
  | "CUT_RESPONSIVE_STACK_OVERFLOW"
  | "CUT_RESPONSIVE_STACK_UNSUPPORTED"
  | "CUT_RESPONSIVE_STACK_NOOP"
  | "CUT_RESPONSIVE_STACK_IDENTITY"
  | "CUT_RESPONSIVE_STACK_LIMIT";

export class CutResponsiveStackError extends Error {
  constructor(
    readonly code: CutResponsiveStackErrorCode,
    readonly path: string,
    detail: string,
  ) {
    super(`${code}: ${detail} at ${path}.`);
    this.name = "CutResponsiveStackError";
  }
}

export type CutResponsiveStackAxis = "horizontal" | "vertical";

export type CutResponsiveStackRect = Readonly<{
  left: Rational;
  top: Rational;
  right: Rational;
  bottom: Rational;
  width: Rational;
  height: Rational;
}>;

export type CutResponsiveStackSlot = Readonly<CutResponsiveStackRect & {
  index: number;
  weight: Rational;
}>;

export type CutResponsiveStackPlan = Readonly<{
  format: "cut-responsive-stack-plan";
  version: 1;
  algorithm: typeof cutResponsiveStackAlgorithmVersion;
  id: string;
  context: Readonly<{ width: Rational; height: Rational }>;
  weights: readonly Rational[];
  safeX: Rational;
  safeY: Rational;
  gap: Rational;
  axis: CutResponsiveStackAxis;
  content: CutResponsiveStackRect;
  slots: readonly CutResponsiveStackSlot[];
}>;

export type CutResponsiveSlotMediaRasterSlot = Readonly<{
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}>;

/**
 * Compiler-owned typed context for the one MediaCamera2D branch admitted
 * directly by ResponsiveSlot. The record is persisted in ordinary CutAVIR so
 * graph identity, semantic diff, strict loading, and runtimes all observe the
 * same exact/raster geometry. It is never a public constructor argument.
 */
export type CutResponsiveSlotMediaContext = Readonly<{
  format: "cut-responsive-slot-media-context";
  version: 1;
  algorithm: typeof cutResponsiveSlotMediaContextAlgorithmVersion;
  contextIdentity: string;
  planIdentity: string;
  stackNodeId: string;
  slotNodeId: string;
  index: number;
  exactSlot: CutResponsiveStackSlot;
  rasterSlot: CutResponsiveSlotMediaRasterSlot;
  localContext: Readonly<{
    originX: Rational;
    originY: Rational;
    width: Rational;
    height: Rational;
  }>;
}>;

type PlanInput = Readonly<{
  weights: readonly Rational[];
  safeX: Rational;
  safeY: Rational;
  gap: Rational;
}>;

type PlanPaths = Readonly<{
  root: string;
  weights: string;
  safeX: string;
  safeY: string;
  gap: string;
  context: string;
}>;

const inputFields = ["weights", "safeX", "safeY", "gap"] as const;
const planFields = ["format", "version", "algorithm", "id", "context", "weights", "safeX", "safeY", "gap", "axis", "content", "slots"] as const;
const contextFields = ["width", "height"] as const;
const rectFields = ["left", "top", "right", "bottom", "width", "height"] as const;
const slotFields = ["index", "weight", ...rectFields] as const;
const responsiveSlotMediaContextFields = [
  "format",
  "version",
  "algorithm",
  "contextIdentity",
  "planIdentity",
  "stackNodeId",
  "slotNodeId",
  "index",
  "exactSlot",
  "rasterSlot",
  "localContext",
] as const;
const digestPattern = /^[a-f0-9]{64}$/u;
const half = rational(1, 2);
const one = rational(1);

function fail(code: CutResponsiveStackErrorCode, path: string, detail: string): never {
  throw new CutResponsiveStackError(code, path, detail);
}

function childPath(parent: string, field: string) {
  return /^[$A-Za-z_][A-Za-z0-9_$]*$/u.test(field) ? `${parent}.${field}` : `${parent}[${JSON.stringify(field)}]`;
}

function strictObject(value: IRValue, path: string, fields: readonly string[], code: CutResponsiveStackErrorCode) {
  if (value.kind !== "object") fail(code, path, "must be a typed record");
  const allowed = new Set(fields);
  for (const key of Object.keys(value.entries)) {
    if (!allowed.has(key)) fail(code, childPath(path, key), `unknown field ${JSON.stringify(key)} is not executable`);
  }
  for (const field of fields) {
    if (!Object.hasOwn(value.entries, field)) fail(code, childPath(path, field), "required field is missing");
  }
  return value.entries;
}

function digitCount(value: string) {
  return value.startsWith("-") ? value.length - 1 : value.length;
}

function canonicalRational(value: Rational, path: string, code: CutResponsiveStackErrorCode) {
  if (!/^-?(?:0|[1-9]\d*)$/u.test(value.numerator)
    || value.numerator === "-0"
    || !/^[1-9]\d*$/u.test(value.denominator)) {
    fail(code, path, "must use canonical signed numerator and positive denominator strings");
  }
  if (digitCount(value.numerator) > cutResponsiveStackLimits.maximumRationalDigits
    || value.denominator.length > cutResponsiveStackLimits.maximumRationalDigits) {
    fail("CUT_RESPONSIVE_STACK_LIMIT", path, `exact rational exceeds the ${cutResponsiveStackLimits.maximumRationalDigits}-digit budget`);
  }
  let reduced: Rational;
  try {
    reduced = rational(value.numerator, value.denominator);
  } catch {
    fail(code, path, "contains an invalid exact rational");
  }
  if (reduced.numerator !== value.numerator || reduced.denominator !== value.denominator) {
    fail(code, path, "must be reduced to canonical exact rational form");
  }
  return Object.freeze({ ...reduced });
}

function quantity(
  value: IRValue,
  dimension: "scalar" | "ratio" | "length",
  unit: "scalar" | "ratio" | "px",
  path: string,
  code: CutResponsiveStackErrorCode,
) {
  if (value.kind !== "quantity" || value.dimension !== dimension || value.unit !== unit) {
    fail(code, path, `must be an exact ${dimension} quantity in ${unit}`);
  }
  return canonicalRational(value.magnitude, `${path}.magnitude`, code);
}

function scalarInteger(value: IRValue, path: string, code: CutResponsiveStackErrorCode) {
  const result = quantity(value, "scalar", "scalar", path, code);
  if (result.denominator !== "1") fail(code, path, "must be an exact integer Number");
  const number = Number(result.numerator);
  if (!Number.isSafeInteger(number)) fail(code, path, "must fit the safe-integer budget");
  return number;
}

function exactString(value: IRValue, path: string, code: CutResponsiveStackErrorCode) {
  if (value.kind !== "string") fail(code, path, "must be a String");
  return value.value;
}

function bounded(value: Rational, path: string) {
  return canonicalRational(value, path, "CUT_RESPONSIVE_STACK_BOUNDS");
}

function add(left: Rational, right: Rational, path: string) {
  return bounded(addRational(left, right), path);
}

function subtract(left: Rational, right: Rational, path: string) {
  return bounded(subtractRational(left, right), path);
}

function multiply(left: Rational, right: Rational, path: string) {
  return bounded(multiplyRational(left, right), path);
}

function divide(left: Rational, right: Rational, path: string) {
  if (compareRational(right, zeroRational) === 0) fail("CUT_RESPONSIVE_STACK_BOUNDS", path, "cannot divide by zero");
  return bounded(divideRational(left, right), path);
}

function stringValue(value: string): IRValue { return { kind: "string", value }; }
function scalarValue(value: Rational): IRValue { return { kind: "quantity", dimension: "scalar", magnitude: value, unit: "scalar" }; }
function ratioValue(value: Rational): IRValue { return { kind: "quantity", dimension: "ratio", magnitude: value, unit: "ratio" }; }
function lengthValue(value: Rational): IRValue { return { kind: "quantity", dimension: "length", magnitude: value, unit: "px" }; }
function arrayValue(items: IRValue[]): IRValue { return { kind: "array", items }; }
function objectValue(entries: Record<string, IRValue>): IRValue { return { kind: "object", entries }; }

function encodeRect(rect: CutResponsiveStackRect) {
  return objectValue({
    left: lengthValue(rect.left),
    top: lengthValue(rect.top),
    right: lengthValue(rect.right),
    bottom: lengthValue(rect.bottom),
    width: lengthValue(rect.width),
    height: lengthValue(rect.height),
  });
}

function encodeSlot(slot: CutResponsiveStackSlot) {
  const rect = encodeRect(slot);
  if (rect.kind !== "object") throw new Error("Internal CUT responsive slot encoding is not an object.");
  return objectValue({
    index: scalarValue(rational(slot.index)),
    weight: scalarValue(slot.weight),
    ...rect.entries,
  });
}

function encodeRasterSlot(slot: CutResponsiveSlotMediaRasterSlot) {
  return objectValue({
    left: lengthValue(rational(slot.left)),
    top: lengthValue(rational(slot.top)),
    right: lengthValue(rational(slot.right)),
    bottom: lengthValue(rational(slot.bottom)),
    width: lengthValue(rational(slot.width)),
    height: lengthValue(rational(slot.height)),
  });
}

function semanticResponsiveSlotMediaContextValue(
  context: Omit<CutResponsiveSlotMediaContext, "contextIdentity">,
) {
  return objectValue({
    format: stringValue(context.format),
    version: scalarValue(rational(context.version)),
    algorithm: stringValue(context.algorithm),
    planIdentity: stringValue(context.planIdentity),
    stackNodeId: stringValue(context.stackNodeId),
    slotNodeId: stringValue(context.slotNodeId),
    index: scalarValue(rational(context.index)),
    exactSlot: encodeSlot(context.exactSlot),
    rasterSlot: encodeRasterSlot(context.rasterSlot),
    localContext: objectValue({
      originX: lengthValue(context.localContext.originX),
      originY: lengthValue(context.localContext.originY),
      width: lengthValue(context.localContext.width),
      height: lengthValue(context.localContext.height),
    }),
  });
}

export function cutResponsiveSlotMediaContextIrValue(context: CutResponsiveSlotMediaContext): IRValue {
  const semantic = semanticResponsiveSlotMediaContextValue(context);
  if (semantic.kind !== "object") throw new Error("Internal CUT responsive media context encoding is not an object.");
  return objectValue({
    format: semantic.entries.format,
    version: semantic.entries.version,
    algorithm: semantic.entries.algorithm,
    contextIdentity: stringValue(context.contextIdentity),
    planIdentity: semantic.entries.planIdentity,
    stackNodeId: semantic.entries.stackNodeId,
    slotNodeId: semantic.entries.slotNodeId,
    index: semantic.entries.index,
    exactSlot: semantic.entries.exactSlot,
    rasterSlot: semantic.entries.rasterSlot,
    localContext: semantic.entries.localContext,
  });
}

function semanticPlanValue(plan: Omit<CutResponsiveStackPlan, "id">): IRValue {
  return objectValue({
    format: stringValue(plan.format),
    version: scalarValue(rational(plan.version)),
    algorithm: stringValue(plan.algorithm),
    context: objectValue({ width: lengthValue(plan.context.width), height: lengthValue(plan.context.height) }),
    weights: arrayValue(plan.weights.map(scalarValue)),
    safeX: ratioValue(plan.safeX),
    safeY: ratioValue(plan.safeY),
    gap: lengthValue(plan.gap),
    axis: stringValue(plan.axis),
    content: encodeRect(plan.content),
    slots: arrayValue(plan.slots.map(encodeSlot)),
  });
}

export function cutResponsiveStackPlanIrValue(plan: CutResponsiveStackPlan): IRValue {
  const semantic = semanticPlanValue(plan);
  if (semantic.kind !== "object") throw new Error("Internal CUT responsive plan encoding is not an object.");
  return objectValue({
    format: semantic.entries.format,
    version: semantic.entries.version,
    algorithm: semantic.entries.algorithm,
    id: stringValue(plan.id),
    context: semantic.entries.context,
    weights: semantic.entries.weights,
    safeX: semantic.entries.safeX,
    safeY: semantic.entries.safeY,
    gap: semantic.entries.gap,
    axis: semantic.entries.axis,
    content: semantic.entries.content,
    slots: semantic.entries.slots,
  });
}

function compositionContext(
  composition: Pick<IRComposition, "width" | "height">,
  path: string,
) {
  for (const [name, value] of [["width", composition.width], ["height", composition.height]] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > cutResponsiveStackLimits.maximumCompositionAxisPx) {
      fail(
        "CUT_RESPONSIVE_STACK_CONTEXT",
        `${path}.${name}`,
        `active composition ${name} must be a whole pixel from 1px through ${cutResponsiveStackLimits.maximumCompositionAxisPx}px`,
      );
    }
  }
  return Object.freeze({ width: rational(composition.width), height: rational(composition.height) });
}

function decodePlanInput(value: IRValue, path: string): { input: PlanInput; paths: PlanPaths } {
  const entries = strictObject(value, path, inputFields, "CUT_RESPONSIVE_STACK_PLAN_TYPE");
  if (entries.weights.kind !== "array") {
    fail("CUT_RESPONSIVE_STACK_PLAN_TYPE", `${path}.weights`, "must be a List<Number>");
  }
  if (entries.weights.items.length < 1) {
    fail("CUT_RESPONSIVE_STACK_SHAPE", `${path}.weights`, "must contain at least one child weight");
  }
  if (entries.weights.items.length > cutResponsiveStackLimits.maximumChildren) {
    fail("CUT_RESPONSIVE_STACK_LIMIT", `${path}.weights`, `exceeds the ${cutResponsiveStackLimits.maximumChildren}-child budget`);
  }
  const weights = Object.freeze(entries.weights.items.map((item, index) => quantity(
    item,
    "scalar",
    "scalar",
    `${path}.weights[${index}]`,
    "CUT_RESPONSIVE_STACK_PLAN_TYPE",
  )));
  return {
    input: Object.freeze({
      weights,
      safeX: quantity(entries.safeX, "ratio", "ratio", `${path}.safeX`, "CUT_RESPONSIVE_STACK_PLAN_TYPE"),
      safeY: quantity(entries.safeY, "ratio", "ratio", `${path}.safeY`, "CUT_RESPONSIVE_STACK_PLAN_TYPE"),
      gap: quantity(entries.gap, "length", "px", `${path}.gap`, "CUT_RESPONSIVE_STACK_PLAN_TYPE"),
    }),
    paths: Object.freeze({
      root: path,
      weights: `${path}.weights`,
      safeX: `${path}.safeX`,
      safeY: `${path}.safeY`,
      gap: `${path}.gap`,
      context: `${path}.context`,
    }),
  };
}

function buildPlan(
  input: PlanInput,
  context: Readonly<{ width: Rational; height: Rational }>,
  paths: PlanPaths,
): CutResponsiveStackPlan {
  let weightTotal = zeroRational;
  input.weights.forEach((weight, index) => {
    if (compareRational(weight, zeroRational) <= 0 || compareRational(weight, cutResponsiveStackLimits.maximumWeight) > 0) {
      fail(
        "CUT_RESPONSIVE_STACK_BOUNDS",
        `${paths.weights}[${index}]`,
        `must be greater than 0 and at most ${cutResponsiveStackLimits.maximumWeight.numerator}`,
      );
    }
    weightTotal = add(weightTotal, weight, `${paths.weights}[${index}]`);
  });
  for (const [name, safe, path] of [["safeX", input.safeX, paths.safeX], ["safeY", input.safeY, paths.safeY]] as const) {
    if (compareRational(safe, zeroRational) < 0 || compareRational(safe, half) >= 0) {
      fail("CUT_RESPONSIVE_STACK_BOUNDS", path, `${name} must be at least 0% and less than 50%`);
    }
  }
  if (compareRational(input.gap, zeroRational) < 0 || compareRational(input.gap, rational(cutResponsiveStackLimits.maximumGapPx)) > 0) {
    fail("CUT_RESPONSIVE_STACK_BOUNDS", paths.gap, `must be at least 0px and at most ${cutResponsiveStackLimits.maximumGapPx}px`);
  }
  if (input.weights.length === 1 && compareRational(input.gap, zeroRational) !== 0) {
    fail("CUT_RESPONSIVE_STACK_NOOP", paths.gap, "does not execute for a one-child responsive stack; use 0px");
  }

  const safeLeft = multiply(context.width, input.safeX, paths.safeX);
  const safeTop = multiply(context.height, input.safeY, paths.safeY);
  const contentWidth = multiply(context.width, subtract(one, multiply(input.safeX, rational(2), paths.safeX), paths.safeX), paths.safeX);
  const contentHeight = multiply(context.height, subtract(one, multiply(input.safeY, rational(2), paths.safeY), paths.safeY), paths.safeY);
  if (compareRational(contentWidth, zeroRational) <= 0 || compareRational(contentHeight, zeroRational) <= 0) {
    fail("CUT_RESPONSIVE_STACK_BOUNDS", paths.root, "safe-area inputs must leave a positive content rectangle");
  }
  const safeRight = add(safeLeft, contentWidth, paths.safeX);
  const safeBottom = add(safeTop, contentHeight, paths.safeY);
  const content = Object.freeze({
    left: safeLeft,
    top: safeTop,
    right: safeRight,
    bottom: safeBottom,
    width: contentWidth,
    height: contentHeight,
  });
  const axis: CutResponsiveStackAxis = compareRational(context.width, context.height) > 0 ? "horizontal" : "vertical";
  const mainLength = axis === "horizontal" ? contentWidth : contentHeight;
  const totalGap = multiply(input.gap, rational(Math.max(0, input.weights.length - 1)), paths.gap);
  const distributable = subtract(mainLength, totalGap, paths.gap);
  if (compareRational(distributable, zeroRational) <= 0) {
    fail("CUT_RESPONSIVE_STACK_BOUNDS", paths.gap, `must leave positive ${axis} space for every weighted child`);
  }

  let cursor = axis === "horizontal" ? content.left : content.top;
  const slots = Object.freeze(input.weights.map((weight, index): CutResponsiveStackSlot => {
    const slotPath = `${paths.weights}[${index}]`;
    const main = multiply(distributable, divide(weight, weightTotal, slotPath), slotPath);
    if (compareRational(main, zeroRational) <= 0) {
      fail("CUT_RESPONSIVE_STACK_BOUNDS", slotPath, "must produce a positive exact slot");
    }
    const width = axis === "horizontal" ? main : content.width;
    const height = axis === "horizontal" ? content.height : main;
    const left = axis === "horizontal" ? cursor : content.left;
    const top = axis === "horizontal" ? content.top : cursor;
    const right = add(left, width, slotPath);
    const bottom = add(top, height, slotPath);
    cursor = add(axis === "horizontal" ? right : bottom, index + 1 < input.weights.length ? input.gap : zeroRational, paths.gap);
    return Object.freeze({ index, weight, left, top, right, bottom, width, height });
  }));
  const expectedEnd = axis === "horizontal" ? content.right : content.bottom;
  const actualEnd = slots.length
    ? (axis === "horizontal" ? slots[slots.length - 1].right : slots[slots.length - 1].bottom)
    : cursor;
  if (compareRational(actualEnd, expectedEnd) !== 0) {
    throw new Error("Internal CUT responsive planner failed exact end closure.");
  }
  const withoutId = Object.freeze({
    format: "cut-responsive-stack-plan" as const,
    version: 1 as const,
    algorithm: cutResponsiveStackAlgorithmVersion,
    context,
    weights: input.weights,
    safeX: input.safeX,
    safeY: input.safeY,
    gap: input.gap,
    axis,
    content,
    slots,
  });
  const id = hash(semanticPlanValue(withoutId));
  return Object.freeze({ ...withoutId, id });
}

/**
 * Derive a context-bound responsive plan. Width and height come from the
 * active composition, not from author-supplied duplicate dimensions.
 */
export function deriveCutResponsiveStackPlan(
  value: IRValue,
  composition: Pick<IRComposition, "width" | "height">,
  path = "$",
) {
  const { input, paths } = decodePlanInput(value, path);
  return cutResponsiveStackPlanIrValue(buildPlan(input, compositionContext(composition, paths.context), paths));
}

function withoutId(value: IRValue) {
  if (value.kind !== "object") return value;
  return objectValue(Object.fromEntries(Object.entries(value.entries).filter(([key]) => key !== "id")));
}

function firstDifference(expected: IRValue, actual: IRValue, path: string): string | undefined {
  if (expected.kind !== actual.kind) return path;
  if (expected.kind === "array" && actual.kind === "array") {
    if (expected.items.length !== actual.items.length) return path;
    for (let index = 0; index < expected.items.length; index += 1) {
      const difference = firstDifference(expected.items[index], actual.items[index], `${path}[${index}]`);
      if (difference) return difference;
    }
    return undefined;
  }
  if (expected.kind === "object" && actual.kind === "object") {
    const expectedKeys = Object.keys(expected.entries).sort();
    const actualKeys = Object.keys(actual.entries).sort();
    if (stableStringify(expectedKeys) !== stableStringify(actualKeys)) return path;
    for (const key of expectedKeys) {
      const difference = firstDifference(expected.entries[key], actual.entries[key], childPath(path, key));
      if (difference) return difference;
    }
    return undefined;
  }
  return stableStringify(expected) === stableStringify(actual) ? undefined : path;
}

function inputFromPlan(entries: Record<string, IRValue>, path: string) {
  return decodePlanInput(objectValue({
    weights: entries.weights,
    safeX: entries.safeX,
    safeY: entries.safeY,
    gap: entries.gap,
  }), path);
}

/** Decode and re-derive a plan so hostile or stale loaded geometry cannot pass. */
export function decodeCutResponsiveStackPlan(value: IRValue, path = "$" ) {
  const entries = strictObject(value, path, planFields, "CUT_RESPONSIVE_STACK_PLAN_TYPE");
  if (exactString(entries.format, `${path}.format`, "CUT_RESPONSIVE_STACK_PLAN_TYPE") !== "cut-responsive-stack-plan") {
    fail("CUT_RESPONSIVE_STACK_PLAN_TYPE", `${path}.format`, "must be exactly \"cut-responsive-stack-plan\"");
  }
  if (scalarInteger(entries.version, `${path}.version`, "CUT_RESPONSIVE_STACK_PLAN_TYPE") !== 1) {
    fail("CUT_RESPONSIVE_STACK_PLAN_TYPE", `${path}.version`, "must be exactly version 1");
  }
  if (exactString(entries.algorithm, `${path}.algorithm`, "CUT_RESPONSIVE_STACK_PLAN_TYPE") !== cutResponsiveStackAlgorithmVersion) {
    fail("CUT_RESPONSIVE_STACK_PLAN_TYPE", `${path}.algorithm`, `must be exactly ${JSON.stringify(cutResponsiveStackAlgorithmVersion)}`);
  }
  const id = exactString(entries.id, `${path}.id`, "CUT_RESPONSIVE_STACK_IDENTITY");
  if (!digestPattern.test(id)) fail("CUT_RESPONSIVE_STACK_IDENTITY", `${path}.id`, "must be a lowercase SHA-256 digest");
  const contextEntries = strictObject(entries.context, `${path}.context`, contextFields, "CUT_RESPONSIVE_STACK_PLAN_TYPE");
  const width = quantity(contextEntries.width, "length", "px", `${path}.context.width`, "CUT_RESPONSIVE_STACK_PLAN_TYPE");
  const height = quantity(contextEntries.height, "length", "px", `${path}.context.height`, "CUT_RESPONSIVE_STACK_PLAN_TYPE");
  if (width.denominator !== "1" || height.denominator !== "1") {
    fail("CUT_RESPONSIVE_STACK_CONTEXT", `${path}.context`, "retained composition dimensions must be whole pixels");
  }
  const parsed = inputFromPlan(entries, path);
  const expected = buildPlan(
    parsed.input,
    compositionContext({ width: Number(width.numerator), height: Number(height.numerator) }, `${path}.context`),
    { ...parsed.paths, context: `${path}.context` },
  );
  const expectedValue = cutResponsiveStackPlanIrValue(expected);
  const difference = firstDifference(withoutId(expectedValue), withoutId(value), path);
  if (difference) {
    fail("CUT_RESPONSIVE_STACK_IDENTITY", difference, "does not match geometry derived from retained inputs and composition context");
  }
  if (id !== expected.id) {
    fail("CUT_RESPONSIVE_STACK_IDENTITY", `${path}.id`, `does not match canonical plan identity ${expected.id}`);
  }
  return expected;
}

function responsiveMediaRasterBoundary(value: Rational, path: string) {
  const canonical = canonicalRational(value, path, "CUT_RESPONSIVE_STACK_BOUNDS");
  if (compareRational(canonical, zeroRational) < 0) {
    fail("CUT_RESPONSIVE_STACK_BOUNDS", path, "responsive media raster edges must be non-negative");
  }
  const numerator = BigInt(canonical.numerator);
  const denominator = BigInt(canonical.denominator);
  const rounded = (2n * numerator + denominator) / (2n * denominator);
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail("CUT_RESPONSIVE_STACK_LIMIT", path, "responsive media raster edge exceeds the safe-integer budget");
  }
  const result = Number(rounded);
  if (result > cutResponsiveStackLimits.maximumCompositionAxisPx) {
    fail(
      "CUT_RESPONSIVE_STACK_BOUNDS",
      path,
      `responsive media raster edge exceeds ${cutResponsiveStackLimits.maximumCompositionAxisPx}px`,
    );
  }
  return result;
}

function responsiveMediaRasterSlots(
  plan: CutResponsiveStackPlan,
  path: string,
) {
  const raster = Object.freeze(plan.slots.map((slot, index): CutResponsiveSlotMediaRasterSlot => {
    const slotPath = `${path}.slots[${index}]`;
    const left = responsiveMediaRasterBoundary(slot.left, `${slotPath}.left`);
    const top = responsiveMediaRasterBoundary(slot.top, `${slotPath}.top`);
    const right = responsiveMediaRasterBoundary(slot.right, `${slotPath}.right`);
    const bottom = responsiveMediaRasterBoundary(slot.bottom, `${slotPath}.bottom`);
    const width = right - left;
    const height = bottom - top;
    if (width < 1 || height < 1) {
      fail(
        "CUT_RESPONSIVE_STACK_BOUNDS",
        slotPath,
        "exact positive responsive media slot collapses below one whole pixel",
      );
    }
    return Object.freeze({ left, top, right, bottom, width, height });
  }));
  for (let index = 1; index < raster.length; index += 1) {
    const previous = raster[index - 1];
    const current = raster[index];
    const gap = plan.axis === "horizontal"
      ? current.left - previous.right
      : current.top - previous.bottom;
    if (gap < 0) {
      fail("CUT_RESPONSIVE_STACK_BOUNDS", `${path}.slots[${index}]`, "quantized responsive media slots overlap");
    }
    if (compareRational(plan.gap, zeroRational) > 0 && gap === 0) {
      fail(
        "CUT_RESPONSIVE_STACK_NOOP",
        `${path}.gap`,
        "positive exact gap quantizes to 0px for this responsive media context",
      );
    }
  }
  return raster;
}

function responsiveSlotMediaContext(
  plan: CutResponsiveStackPlan,
  stackNodeId: string,
  slotNodeId: string,
  index: number,
  path: string,
): CutResponsiveSlotMediaContext {
  if (!Number.isSafeInteger(index) || index < 0 || index >= plan.slots.length) {
    fail(
      "CUT_RESPONSIVE_STACK_GRAPH",
      `${path}.index`,
      `responsive media slot index must select one of ${plan.slots.length} retained slots`,
    );
  }
  const exactSlot = plan.slots[index];
  const rasterSlot = responsiveMediaRasterSlots(plan, path)[index];
  const withoutIdentity = Object.freeze({
    format: "cut-responsive-slot-media-context" as const,
    version: 1 as const,
    algorithm: cutResponsiveSlotMediaContextAlgorithmVersion,
    planIdentity: plan.id,
    stackNodeId,
    slotNodeId,
    index,
    exactSlot,
    rasterSlot,
    localContext: Object.freeze({
      originX: zeroRational,
      originY: zeroRational,
      width: rational(rasterSlot.width),
      height: rational(rasterSlot.height),
    }),
  });
  return Object.freeze({
    ...withoutIdentity,
    contextIdentity: hash(semanticResponsiveSlotMediaContextValue(withoutIdentity)),
  });
}

/**
 * Bind one retained ResponsiveStack slot to explicit structural node ids.
 * Compilers call this only after lowering the direct Stack -> Slot -> Camera
 * ancestry; source code has no parameter through which it can inject the
 * resulting record.
 */
export function deriveCutResponsiveSlotMediaContext(
  planValue: IRValue,
  binding: Readonly<{ stackNodeId: string; slotNodeId: string; index: number }>,
  path = "$",
) {
  const plan = decodeCutResponsiveStackPlan(planValue, `${path}.plan`);
  return cutResponsiveSlotMediaContextIrValue(responsiveSlotMediaContext(
    plan,
    binding.stackNodeId,
    binding.slotNodeId,
    binding.index,
    path,
  ));
}

/**
 * Strictly decode and rederive a compiler-owned responsive media context.
 * Callers must supply the actual structural ancestry; a re-signed stale or
 * transplanted record therefore cannot manufacture a different slot.
 */
export function decodeCutResponsiveSlotMediaContext(
  value: IRValue,
  planValue: IRValue,
  binding: Readonly<{ stackNodeId: string; slotNodeId: string; index: number }>,
  path = "$",
) {
  const entries = strictObject(
    value,
    path,
    responsiveSlotMediaContextFields,
    "CUT_RESPONSIVE_STACK_PLAN_TYPE",
  );
  if (exactString(entries.format, `${path}.format`, "CUT_RESPONSIVE_STACK_PLAN_TYPE") !== "cut-responsive-slot-media-context") {
    fail("CUT_RESPONSIVE_STACK_PLAN_TYPE", `${path}.format`, "must be exactly \"cut-responsive-slot-media-context\"");
  }
  if (scalarInteger(entries.version, `${path}.version`, "CUT_RESPONSIVE_STACK_PLAN_TYPE") !== 1) {
    fail("CUT_RESPONSIVE_STACK_PLAN_TYPE", `${path}.version`, "must be exactly version 1");
  }
  if (exactString(entries.algorithm, `${path}.algorithm`, "CUT_RESPONSIVE_STACK_PLAN_TYPE")
    !== cutResponsiveSlotMediaContextAlgorithmVersion) {
    fail(
      "CUT_RESPONSIVE_STACK_PLAN_TYPE",
      `${path}.algorithm`,
      `must be exactly ${JSON.stringify(cutResponsiveSlotMediaContextAlgorithmVersion)}`,
    );
  }
  const contextIdentity = exactString(
    entries.contextIdentity,
    `${path}.contextIdentity`,
    "CUT_RESPONSIVE_STACK_IDENTITY",
  );
  if (!digestPattern.test(contextIdentity)) {
    fail("CUT_RESPONSIVE_STACK_IDENTITY", `${path}.contextIdentity`, "must be a lowercase SHA-256 digest");
  }
  const expected = deriveCutResponsiveSlotMediaContext(planValue, binding, path);
  const withoutContextIdentity = (candidate: IRValue) => candidate.kind === "object"
    ? objectValue(Object.fromEntries(
      Object.entries(candidate.entries).filter(([key]) => key !== "contextIdentity"),
    ))
    : candidate;
  const difference = firstDifference(
    withoutContextIdentity(expected),
    withoutContextIdentity(value),
    path,
  );
  if (difference) {
    fail(
      "CUT_RESPONSIVE_STACK_IDENTITY",
      difference,
      "does not match the context derived from ResponsiveStack plan and structural slot ancestry",
    );
  }
  if (expected.kind !== "object"
    || expected.entries.contextIdentity.kind !== "string"
    || contextIdentity !== expected.entries.contextIdentity.value) {
    fail(
      "CUT_RESPONSIVE_STACK_IDENTITY",
      `${path}.contextIdentity`,
      "does not match the canonical responsive slot media context identity",
    );
  }
  const plan = decodeCutResponsiveStackPlan(planValue, `${path}.plan`);
  return responsiveSlotMediaContext(plan, binding.stackNodeId, binding.slotNodeId, binding.index, path);
}

/** Exposed for execution validation without converting exact slots to floats. */
export function cutResponsiveStackRectFields() {
  return Object.freeze({ rect: rectFields, slot: slotFields });
}
