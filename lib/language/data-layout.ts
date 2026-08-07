import { hash, stableStringify } from "../core/stable";
import type { IRValue } from "./ir";
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

export const cutBarLayoutLimits = Object.freeze({
  maximumItems: 512,
  maximumKeyCodePoints: 128,
  maximumLabelCodePoints: 256,
  maximumLabelUtf8Bytes: 1_024,
  maximumAbsoluteValue: rational(1_000_000_000_000),
  maximumAbsoluteCoordinate: rational(65_536),
  maximumDimension: rational(65_536),
  maximumRationalDigits: 256,
  minimumBarWidth: rational(1, 2),
  maximumFormatDecimals: 6,
  maximumFormatSuffixBytes: 16,
  maximumFormattedBytes: 128,
});

export type CutDataLayoutErrorCode =
  | "CUT_DATA_KEY_TYPE"
  | "CUT_DATA_KEY_VALUE"
  | "CUT_DATA_KEY_DUPLICATE"
  | "CUT_BAR_LAYOUT_TYPE"
  | "CUT_BAR_LAYOUT_FIELD"
  | "CUT_BAR_LAYOUT_DOMAIN"
  | "CUT_BAR_LAYOUT_GEOMETRY"
  | "CUT_BAR_LAYOUT_LIMIT"
  | "CUT_BAR_LAYOUT_IDENTITY"
  | "CUT_BAR_TARGET_TYPE"
  | "CUT_BAR_TARGET_DUPLICATE"
  | "CUT_BAR_TARGET_COVERAGE"
  | "CUT_BAR_TARGET_NOOP"
  | "CUT_DATA_FORMAT_TYPE"
  | "CUT_DATA_FORMAT_RANGE";

export class CutDataLayoutError extends Error {
  constructor(
    readonly code: CutDataLayoutErrorCode,
    readonly path: string,
    message: string,
  ) {
    super(`${code}: ${message} at ${path}.`);
    this.name = "CutDataLayoutError";
  }
}

export type CutKeyedNumber = Readonly<{
  key: string;
  label: string;
  value: Rational;
}>;

export type CutMarkTarget = Readonly<{
  key: string;
  x: Rational;
  y: Rational;
}>;

export type CutBarMark = Readonly<{
  key: string;
  label: string;
  value: Rational;
  index: number;
  x: Rational;
  y: Rational;
  width: Rational;
  height: Rational;
  left: Rational;
  top: Rational;
  right: Rational;
  bottom: Rational;
  baselineY: Rational;
}>;

export type CutBarMarkTransform = Readonly<CutBarMark & {
  targetX: Rational;
  targetY: Rational;
}>;

export type CutBarLayout = Readonly<{
  format: "cut-bar-layout";
  version: 1;
  id: string;
  data: readonly CutKeyedNumber[];
  frame: Readonly<{
    x: Rational;
    y: Rational;
    width: Rational;
    height: Rational;
    padding: Rational;
  }>;
  plot: Readonly<{
    left: Rational;
    top: Rational;
    width: Rational;
    height: Rational;
  }>;
  domain: Readonly<{
    minimum: Rational;
    maximum: Rational;
    baseline: Rational;
  }>;
  gap: Rational;
  marks: readonly CutBarMark[];
}>;

type LayoutInput = Readonly<{
  data: readonly CutKeyedNumber[];
  x: Rational;
  y: Rational;
  width: Rational;
  height: Rational;
  minimum: Rational;
  maximum: Rational;
  gap: Rational;
  padding: Rational;
}>;

type LayoutPaths = Readonly<{
  root: string;
  data: string;
  x: string;
  y: string;
  width: string;
  height: string;
  minimum: string;
  maximum: string;
  gap: string;
  padding: string;
}>;

const barLayoutInputFields = ["data", "x", "y", "width", "height", "min", "max", "gap", "padding"] as const;
const barLayoutFields = ["format", "version", "id", "data", "frame", "plot", "domain", "gap", "marks"] as const;
const keyedNumberFields = ["key", "label", "value"] as const;
const markTargetFields = ["key", "x", "y"] as const;
const frameFields = ["x", "y", "width", "height", "padding"] as const;
const plotFields = ["left", "top", "width", "height"] as const;
const domainFields = ["minimum", "maximum", "baseline"] as const;
const markFields = ["key", "label", "value", "index", "x", "y", "width", "height", "left", "top", "right", "bottom", "baselineY"] as const;
const keyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
const maximumRatioGap = rational(19, 20);
const half = rational(1, 2);
const one = rational(1);

function fail(code: CutDataLayoutErrorCode, path: string, message: string): never {
  throw new CutDataLayoutError(code, path, message);
}

function childPath(parent: string, field: string) {
  return /^[$A-Za-z_][A-Za-z0-9_$]*$/u.test(field) ? `${parent}.${field}` : `${parent}[${JSON.stringify(field)}]`;
}

function strictObject(
  value: IRValue,
  path: string,
  fields: readonly string[],
  code: CutDataLayoutErrorCode,
) {
  if (value.kind !== "object") fail(code, path, "must be an object value");
  const allowed = new Set(fields);
  for (const key of Object.keys(value.entries)) {
    if (!allowed.has(key)) fail(code, childPath(path, key), `unknown field ${JSON.stringify(key)} is not executable`);
  }
  for (const field of fields) {
    if (!Object.hasOwn(value.entries, field)) fail(code, childPath(path, field), "required field is missing");
  }
  return value.entries;
}

function exactString(value: IRValue, path: string, code: CutDataLayoutErrorCode) {
  if (value.kind !== "string") fail(code, path, "must be a String");
  return value.value;
}

function exactScalarInteger(value: IRValue, path: string, code: CutDataLayoutErrorCode) {
  const magnitude = exactQuantity(value, "scalar", "scalar", path, code);
  if (magnitude.denominator !== "1") fail(code, path, "must be an exact integer Number");
  const result = Number(magnitude.numerator);
  if (!Number.isSafeInteger(result)) fail(code, path, "must fit the safe-integer budget");
  return result;
}

function digitCount(value: string) {
  return value.startsWith("-") ? value.length - 1 : value.length;
}

function canonicalRational(value: Rational, path: string, code: CutDataLayoutErrorCode) {
  if (!/^-?(?:0|[1-9]\d*)$/u.test(value.numerator)
    || value.numerator === "-0"
    || !/^[1-9]\d*$/u.test(value.denominator)) {
    fail(code, path, "must use canonical signed numerator and positive denominator strings");
  }
  if (digitCount(value.numerator) > cutBarLayoutLimits.maximumRationalDigits
    || value.denominator.length > cutBarLayoutLimits.maximumRationalDigits) {
    fail("CUT_BAR_LAYOUT_LIMIT", path, `exact rational exceeds the ${cutBarLayoutLimits.maximumRationalDigits}-digit budget`);
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

function exactQuantity(
  value: IRValue,
  dimension: string,
  unit: string,
  path: string,
  code: CutDataLayoutErrorCode,
) {
  if (value.kind !== "quantity" || value.dimension !== dimension || value.unit !== unit) {
    fail(code, path, `must be a canonical ${dimension} quantity in ${unit}`);
  }
  return canonicalRational(value.magnitude, childPath(path, "magnitude"), code);
}

function boundedResult(value: Rational, path: string) {
  return canonicalRational(value, path, "CUT_BAR_LAYOUT_GEOMETRY");
}

function add(left: Rational, right: Rational, path: string) {
  return boundedResult(addRational(left, right), path);
}

function subtract(left: Rational, right: Rational, path: string) {
  return boundedResult(subtractRational(left, right), path);
}

function multiply(left: Rational, right: Rational, path: string) {
  return boundedResult(multiplyRational(left, right), path);
}

function divide(left: Rational, right: Rational, path: string) {
  if (compareRational(right, zeroRational) === 0) fail("CUT_BAR_LAYOUT_DOMAIN", path, "cannot divide by an empty domain or item count");
  return boundedResult(divideRational(left, right), path);
}

function absolute(value: Rational) {
  return BigInt(value.numerator) < 0n ? rational(-BigInt(value.numerator), value.denominator) : value;
}

function minimum(left: Rational, right: Rational) {
  return compareRational(left, right) <= 0 ? left : right;
}

function maximum(left: Rational, right: Rational) {
  return compareRational(left, right) >= 0 ? left : right;
}

function scalarValue(value: Rational): IRValue {
  return { kind: "quantity", dimension: "scalar", magnitude: { ...value }, unit: "scalar" };
}

function lengthValue(value: Rational): IRValue {
  return { kind: "quantity", dimension: "length", magnitude: { ...value }, unit: "px" };
}

function ratioValue(value: Rational): IRValue {
  return { kind: "quantity", dimension: "ratio", magnitude: { ...value }, unit: "ratio" };
}

function stringValue(value: string): IRValue {
  return { kind: "string", value };
}

function objectValue(entries: Record<string, IRValue>): IRValue {
  return { kind: "object", entries };
}

function arrayValue(items: IRValue[]): IRValue {
  return { kind: "array", items };
}

function wellFormedUnicode(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function validateKey(key: string, path: string) {
  if (!keyPattern.test(key) || [...key].length > cutBarLayoutLimits.maximumKeyCodePoints) {
    fail("CUT_DATA_KEY_VALUE", path, "must be 1..128 ASCII letters, digits, dots, underscores, colons, or hyphens and begin with a letter or digit");
  }
}

function validateLabel(label: string, path: string) {
  const codePoints = [...label].length;
  if (!wellFormedUnicode(label)
    || codePoints < 1
    || codePoints > cutBarLayoutLimits.maximumLabelCodePoints
    || Buffer.byteLength(label, "utf8") > cutBarLayoutLimits.maximumLabelUtf8Bytes
    || /[\u0000-\u001f\u007f-\u009f]/u.test(label)) {
    fail("CUT_DATA_KEY_VALUE", path, "must be non-empty well-formed display text without control characters and within the label budget");
  }
}

function withinAbsolute(value: Rational, bound: Rational) {
  return compareRational(absolute(value), bound) <= 0;
}

export function decodeCutKeyedNumber(value: IRValue, path = "$"): CutKeyedNumber {
  const entries = strictObject(value, path, keyedNumberFields, "CUT_DATA_KEY_TYPE");
  const key = exactString(entries.key, childPath(path, "key"), "CUT_DATA_KEY_TYPE");
  const label = exactString(entries.label, childPath(path, "label"), "CUT_DATA_KEY_TYPE");
  const number = exactQuantity(entries.value, "scalar", "scalar", childPath(path, "value"), "CUT_DATA_KEY_TYPE");
  validateKey(key, childPath(path, "key"));
  validateLabel(label, childPath(path, "label"));
  if (!withinAbsolute(number, cutBarLayoutLimits.maximumAbsoluteValue)) {
    fail("CUT_DATA_KEY_VALUE", childPath(path, "value"), "must remain within +/-1000000000000");
  }
  return Object.freeze({ key, label, value: number });
}

export function decodeCutMarkTarget(value: IRValue, path = "$"): CutMarkTarget {
  const entries = strictObject(value, path, markTargetFields, "CUT_BAR_TARGET_TYPE");
  const key = exactString(entries.key, childPath(path, "key"), "CUT_BAR_TARGET_TYPE");
  const x = exactQuantity(entries.x, "length", "px", childPath(path, "x"), "CUT_BAR_TARGET_TYPE");
  const y = exactQuantity(entries.y, "length", "px", childPath(path, "y"), "CUT_BAR_TARGET_TYPE");
  validateKey(key, childPath(path, "key"));
  if (!withinAbsolute(x, cutBarLayoutLimits.maximumAbsoluteCoordinate)) {
    fail("CUT_BAR_TARGET_TYPE", childPath(path, "x"), "must remain within +/-65536px");
  }
  if (!withinAbsolute(y, cutBarLayoutLimits.maximumAbsoluteCoordinate)) {
    fail("CUT_BAR_TARGET_TYPE", childPath(path, "y"), "must remain within +/-65536px");
  }
  return Object.freeze({ key, x, y });
}

function decodeKeyedNumbers(value: IRValue, path: string) {
  if (value.kind !== "array") fail("CUT_BAR_LAYOUT_TYPE", path, "must be a List<KeyedNumber>");
  if (value.items.length < 1) fail("CUT_BAR_LAYOUT_DOMAIN", path, "must contain at least one datum");
  if (value.items.length > cutBarLayoutLimits.maximumItems) {
    fail("CUT_BAR_LAYOUT_LIMIT", path, `exceeds the ${cutBarLayoutLimits.maximumItems}-datum budget`);
  }
  const seen = new Map<string, number>();
  return Object.freeze(value.items.map((item, index) => {
    const decoded = decodeCutKeyedNumber(item, `${path}[${index}]`);
    const previous = seen.get(decoded.key);
    if (previous !== undefined) {
      fail("CUT_DATA_KEY_DUPLICATE", `${path}[${index}].key`, `duplicates key ${JSON.stringify(decoded.key)} first declared at ${path}[${previous}].key`);
    }
    seen.set(decoded.key, index);
    return decoded;
  }));
}

function decodeLayoutInput(value: IRValue, path: string): { input: LayoutInput; paths: LayoutPaths } {
  const entries = strictObject(value, path, barLayoutInputFields, "CUT_BAR_LAYOUT_TYPE");
  const paths: LayoutPaths = {
    root: path,
    data: childPath(path, "data"),
    x: childPath(path, "x"),
    y: childPath(path, "y"),
    width: childPath(path, "width"),
    height: childPath(path, "height"),
    minimum: childPath(path, "min"),
    maximum: childPath(path, "max"),
    gap: childPath(path, "gap"),
    padding: childPath(path, "padding"),
  };
  return {
    paths,
    input: {
      data: decodeKeyedNumbers(entries.data, paths.data),
      x: exactQuantity(entries.x, "length", "px", paths.x, "CUT_BAR_LAYOUT_TYPE"),
      y: exactQuantity(entries.y, "length", "px", paths.y, "CUT_BAR_LAYOUT_TYPE"),
      width: exactQuantity(entries.width, "length", "px", paths.width, "CUT_BAR_LAYOUT_TYPE"),
      height: exactQuantity(entries.height, "length", "px", paths.height, "CUT_BAR_LAYOUT_TYPE"),
      minimum: exactQuantity(entries.min, "scalar", "scalar", paths.minimum, "CUT_BAR_LAYOUT_TYPE"),
      maximum: exactQuantity(entries.max, "scalar", "scalar", paths.maximum, "CUT_BAR_LAYOUT_TYPE"),
      gap: exactQuantity(entries.gap, "ratio", "ratio", paths.gap, "CUT_BAR_LAYOUT_TYPE"),
      padding: exactQuantity(entries.padding, "length", "px", paths.padding, "CUT_BAR_LAYOUT_TYPE"),
    },
  };
}

function encodeKeyedNumber(value: CutKeyedNumber) {
  return objectValue({ key: stringValue(value.key), label: stringValue(value.label), value: scalarValue(value.value) });
}

function encodeMark(value: CutBarMark) {
  return objectValue({
    key: stringValue(value.key),
    label: stringValue(value.label),
    value: scalarValue(value.value),
    index: scalarValue(rational(value.index)),
    x: lengthValue(value.x),
    y: lengthValue(value.y),
    width: lengthValue(value.width),
    height: lengthValue(value.height),
    left: lengthValue(value.left),
    top: lengthValue(value.top),
    right: lengthValue(value.right),
    bottom: lengthValue(value.bottom),
    baselineY: lengthValue(value.baselineY),
  });
}

function encodeMarkTransform(value: CutBarMarkTransform) {
  const mark = encodeMark(value);
  if (mark.kind !== "object") throw new Error("Internal CUT bar transform mark is not an object.");
  return objectValue({
    ...mark.entries,
    targetX: lengthValue(value.targetX),
    targetY: lengthValue(value.targetY),
  });
}

function semanticLayoutValue(layout: Omit<CutBarLayout, "id">) {
  return objectValue({
    format: stringValue(layout.format),
    version: scalarValue(rational(layout.version)),
    data: arrayValue(layout.data.map(encodeKeyedNumber)),
    frame: objectValue({
      x: lengthValue(layout.frame.x),
      y: lengthValue(layout.frame.y),
      width: lengthValue(layout.frame.width),
      height: lengthValue(layout.frame.height),
      padding: lengthValue(layout.frame.padding),
    }),
    plot: objectValue({
      left: lengthValue(layout.plot.left),
      top: lengthValue(layout.plot.top),
      width: lengthValue(layout.plot.width),
      height: lengthValue(layout.plot.height),
    }),
    domain: objectValue({
      minimum: scalarValue(layout.domain.minimum),
      maximum: scalarValue(layout.domain.maximum),
      baseline: scalarValue(layout.domain.baseline),
    }),
    gap: ratioValue(layout.gap),
    marks: arrayValue(layout.marks.map(encodeMark)),
  });
}

export function cutBarLayoutIrValue(layout: CutBarLayout): IRValue {
  const semantic = semanticLayoutValue(layout);
  if (semantic.kind !== "object") throw new Error("Internal CUT bar layout semantic value is not an object.");
  return objectValue({
    format: semantic.entries.format,
    version: semantic.entries.version,
    id: stringValue(layout.id),
    data: semantic.entries.data,
    frame: semantic.entries.frame,
    plot: semantic.entries.plot,
    domain: semantic.entries.domain,
    gap: semantic.entries.gap,
    marks: semantic.entries.marks,
  });
}

function buildLayout(input: LayoutInput, paths: LayoutPaths): CutBarLayout {
  if (!withinAbsolute(input.x, cutBarLayoutLimits.maximumAbsoluteCoordinate)) {
    fail("CUT_BAR_LAYOUT_GEOMETRY", paths.x, "must remain within +/-65536px");
  }
  if (!withinAbsolute(input.y, cutBarLayoutLimits.maximumAbsoluteCoordinate)) {
    fail("CUT_BAR_LAYOUT_GEOMETRY", paths.y, "must remain within +/-65536px");
  }
  if (compareRational(input.width, zeroRational) <= 0 || compareRational(input.width, cutBarLayoutLimits.maximumDimension) > 0) {
    fail("CUT_BAR_LAYOUT_GEOMETRY", paths.width, "must be greater than 0px and at most 65536px");
  }
  if (compareRational(input.height, zeroRational) <= 0 || compareRational(input.height, cutBarLayoutLimits.maximumDimension) > 0) {
    fail("CUT_BAR_LAYOUT_GEOMETRY", paths.height, "must be greater than 0px and at most 65536px");
  }
  if (compareRational(input.padding, zeroRational) < 0) fail("CUT_BAR_LAYOUT_GEOMETRY", paths.padding, "cannot be negative");
  if (compareRational(multiply(input.padding, rational(2), paths.padding), input.width) >= 0
    || compareRational(multiply(input.padding, rational(2), paths.padding), input.height) >= 0) {
    fail("CUT_BAR_LAYOUT_GEOMETRY", paths.padding, "must leave positive plot width and height");
  }
  if (compareRational(input.gap, zeroRational) < 0 || compareRational(input.gap, maximumRatioGap) >= 0) {
    fail("CUT_BAR_LAYOUT_GEOMETRY", paths.gap, "must be at least 0% and less than 95%");
  }
  if (!withinAbsolute(input.minimum, cutBarLayoutLimits.maximumAbsoluteValue)) {
    fail("CUT_BAR_LAYOUT_DOMAIN", paths.minimum, "must remain within +/-1000000000000");
  }
  if (!withinAbsolute(input.maximum, cutBarLayoutLimits.maximumAbsoluteValue)) {
    fail("CUT_BAR_LAYOUT_DOMAIN", paths.maximum, "must remain within +/-1000000000000");
  }
  if (compareRational(input.minimum, input.maximum) >= 0) {
    fail("CUT_BAR_LAYOUT_DOMAIN", paths.maximum, "must be strictly greater than min");
  }
  input.data.forEach((datum, index) => {
    if (compareRational(datum.value, input.minimum) < 0 || compareRational(datum.value, input.maximum) > 0) {
      fail("CUT_BAR_LAYOUT_DOMAIN", `${paths.data}[${index}].value`, "lies outside the explicit [min, max] domain");
    }
  });

  const left = subtract(subtract(input.x, divide(input.width, rational(2), paths.width), paths.x), zeroRational, paths.x);
  const top = subtract(subtract(input.y, divide(input.height, rational(2), paths.height), paths.y), zeroRational, paths.y);
  const right = add(left, input.width, paths.width);
  const bottom = add(top, input.height, paths.height);
  for (const [edge, value] of [["left", left], ["right", right], ["top", top], ["bottom", bottom]] as const) {
    if (!withinAbsolute(value, cutBarLayoutLimits.maximumAbsoluteCoordinate)) {
      fail("CUT_BAR_LAYOUT_GEOMETRY", paths.root, `frame ${edge} edge exceeds +/-65536px`);
    }
  }
  const plotLeft = add(left, input.padding, paths.padding);
  const plotTop = add(top, input.padding, paths.padding);
  const plotWidth = subtract(input.width, multiply(input.padding, rational(2), paths.padding), paths.width);
  const plotHeight = subtract(input.height, multiply(input.padding, rational(2), paths.padding), paths.height);
  const domainSpan = subtract(input.maximum, input.minimum, paths.maximum);
  const baseline = maximum(input.minimum, minimum(input.maximum, zeroRational));
  const mapY = (value: Rational, path: string) => add(
    plotTop,
    multiply(divide(subtract(input.maximum, value, path), domainSpan, path), plotHeight, path),
    path,
  );
  const baselineY = mapY(baseline, paths.maximum);
  const count = rational(input.data.length);
  const slot = divide(plotWidth, count, paths.data);
  const barWidth = multiply(slot, subtract(one, input.gap, paths.gap), paths.gap);
  if (compareRational(barWidth, cutBarLayoutLimits.minimumBarWidth) < 0) {
    fail("CUT_BAR_LAYOUT_GEOMETRY", paths.gap, "produces bars narrower than the exact 0.5px minimum");
  }
  const marks = Object.freeze(input.data.map((datum, index): CutBarMark => {
    const markPath = `${paths.data}[${index}]`;
    const centerX = add(plotLeft, multiply(slot, add(rational(index), half, markPath), markPath), markPath);
    const valueY = mapY(datum.value, `${markPath}.value`);
    const markTop = minimum(valueY, baselineY);
    const markBottom = maximum(valueY, baselineY);
    // A value exactly on the selected baseline intentionally retains a 0px
    // mark. A later renderer must keep it transparent rather than inventing a
    // minimum-height data mark; the stable key/value still remain available
    // to labels, joins, inspect, and semantic diff.
    const markHeight = subtract(markBottom, markTop, markPath);
    const markLeft = subtract(centerX, divide(barWidth, rational(2), markPath), markPath);
    const markRight = add(markLeft, barWidth, markPath);
    const centerY = add(markTop, divide(markHeight, rational(2), markPath), markPath);
    return Object.freeze({
      key: datum.key,
      label: datum.label,
      value: datum.value,
      index,
      x: centerX,
      y: centerY,
      width: barWidth,
      height: markHeight,
      left: markLeft,
      top: markTop,
      right: markRight,
      bottom: markBottom,
      baselineY,
    });
  }));
  const withoutId = Object.freeze({
    format: "cut-bar-layout" as const,
    version: 1 as const,
    data: input.data,
    frame: Object.freeze({ x: input.x, y: input.y, width: input.width, height: input.height, padding: input.padding }),
    plot: Object.freeze({ left: plotLeft, top: plotTop, width: plotWidth, height: plotHeight }),
    domain: Object.freeze({ minimum: input.minimum, maximum: input.maximum, baseline }),
    gap: input.gap,
    marks,
  });
  const id = hash(semanticLayoutValue(withoutId));
  return Object.freeze({ ...withoutId, id });
}

export function deriveCutBarLayout(value: IRValue, path = "$") {
  const { input, paths } = decodeLayoutInput(value, path);
  return cutBarLayoutIrValue(buildLayout(input, paths));
}

function decodeLayoutFrame(value: IRValue, path: string) {
  const entries = strictObject(value, path, frameFields, "CUT_BAR_LAYOUT_FIELD");
  return Object.freeze({
    x: exactQuantity(entries.x, "length", "px", `${path}.x`, "CUT_BAR_LAYOUT_FIELD"),
    y: exactQuantity(entries.y, "length", "px", `${path}.y`, "CUT_BAR_LAYOUT_FIELD"),
    width: exactQuantity(entries.width, "length", "px", `${path}.width`, "CUT_BAR_LAYOUT_FIELD"),
    height: exactQuantity(entries.height, "length", "px", `${path}.height`, "CUT_BAR_LAYOUT_FIELD"),
    padding: exactQuantity(entries.padding, "length", "px", `${path}.padding`, "CUT_BAR_LAYOUT_FIELD"),
  });
}

function decodeLayoutPlot(value: IRValue, path: string) {
  const entries = strictObject(value, path, plotFields, "CUT_BAR_LAYOUT_FIELD");
  return Object.freeze({
    left: exactQuantity(entries.left, "length", "px", `${path}.left`, "CUT_BAR_LAYOUT_FIELD"),
    top: exactQuantity(entries.top, "length", "px", `${path}.top`, "CUT_BAR_LAYOUT_FIELD"),
    width: exactQuantity(entries.width, "length", "px", `${path}.width`, "CUT_BAR_LAYOUT_FIELD"),
    height: exactQuantity(entries.height, "length", "px", `${path}.height`, "CUT_BAR_LAYOUT_FIELD"),
  });
}

function decodeLayoutDomain(value: IRValue, path: string) {
  const entries = strictObject(value, path, domainFields, "CUT_BAR_LAYOUT_FIELD");
  return Object.freeze({
    minimum: exactQuantity(entries.minimum, "scalar", "scalar", `${path}.minimum`, "CUT_BAR_LAYOUT_FIELD"),
    maximum: exactQuantity(entries.maximum, "scalar", "scalar", `${path}.maximum`, "CUT_BAR_LAYOUT_FIELD"),
    baseline: exactQuantity(entries.baseline, "scalar", "scalar", `${path}.baseline`, "CUT_BAR_LAYOUT_FIELD"),
  });
}

function decodeLayoutMark(value: IRValue, path: string): CutBarMark {
  const entries = strictObject(value, path, markFields, "CUT_BAR_LAYOUT_FIELD");
  const key = exactString(entries.key, `${path}.key`, "CUT_BAR_LAYOUT_FIELD");
  const label = exactString(entries.label, `${path}.label`, "CUT_BAR_LAYOUT_FIELD");
  validateKey(key, `${path}.key`);
  validateLabel(label, `${path}.label`);
  return Object.freeze({
    key,
    label,
    value: exactQuantity(entries.value, "scalar", "scalar", `${path}.value`, "CUT_BAR_LAYOUT_FIELD"),
    index: exactScalarInteger(entries.index, `${path}.index`, "CUT_BAR_LAYOUT_FIELD"),
    x: exactQuantity(entries.x, "length", "px", `${path}.x`, "CUT_BAR_LAYOUT_FIELD"),
    y: exactQuantity(entries.y, "length", "px", `${path}.y`, "CUT_BAR_LAYOUT_FIELD"),
    width: exactQuantity(entries.width, "length", "px", `${path}.width`, "CUT_BAR_LAYOUT_FIELD"),
    height: exactQuantity(entries.height, "length", "px", `${path}.height`, "CUT_BAR_LAYOUT_FIELD"),
    left: exactQuantity(entries.left, "length", "px", `${path}.left`, "CUT_BAR_LAYOUT_FIELD"),
    top: exactQuantity(entries.top, "length", "px", `${path}.top`, "CUT_BAR_LAYOUT_FIELD"),
    right: exactQuantity(entries.right, "length", "px", `${path}.right`, "CUT_BAR_LAYOUT_FIELD"),
    bottom: exactQuantity(entries.bottom, "length", "px", `${path}.bottom`, "CUT_BAR_LAYOUT_FIELD"),
    baselineY: exactQuantity(entries.baselineY, "length", "px", `${path}.baselineY`, "CUT_BAR_LAYOUT_FIELD"),
  });
}

function withoutLayoutId(value: IRValue) {
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

export function decodeCutBarLayout(value: IRValue, path = "$"): CutBarLayout {
  const entries = strictObject(value, path, barLayoutFields, "CUT_BAR_LAYOUT_TYPE");
  const format = exactString(entries.format, `${path}.format`, "CUT_BAR_LAYOUT_FIELD");
  if (format !== "cut-bar-layout") fail("CUT_BAR_LAYOUT_FIELD", `${path}.format`, "must be exactly \"cut-bar-layout\"");
  const version = exactScalarInteger(entries.version, `${path}.version`, "CUT_BAR_LAYOUT_FIELD");
  if (version !== 1) fail("CUT_BAR_LAYOUT_FIELD", `${path}.version`, "must be exactly version 1");
  const id = exactString(entries.id, `${path}.id`, "CUT_BAR_LAYOUT_FIELD");
  if (!digestPattern.test(id)) fail("CUT_BAR_LAYOUT_IDENTITY", `${path}.id`, "must be a lowercase SHA-256 digest");
  const data = decodeKeyedNumbers(entries.data, `${path}.data`);
  const frame = decodeLayoutFrame(entries.frame, `${path}.frame`);
  const plot = decodeLayoutPlot(entries.plot, `${path}.plot`);
  const domain = decodeLayoutDomain(entries.domain, `${path}.domain`);
  const gap = exactQuantity(entries.gap, "ratio", "ratio", `${path}.gap`, "CUT_BAR_LAYOUT_FIELD");
  if (entries.marks.kind !== "array") fail("CUT_BAR_LAYOUT_FIELD", `${path}.marks`, "must be a List<BarMark>");
  if (entries.marks.items.length !== data.length) fail("CUT_BAR_LAYOUT_FIELD", `${path}.marks`, "must contain exactly one mark per datum");
  const marks = Object.freeze(entries.marks.items.map((item, index) => decodeLayoutMark(item, `${path}.marks[${index}]`)));

  const expected = buildLayout(
    {
      data,
      x: frame.x,
      y: frame.y,
      width: frame.width,
      height: frame.height,
      minimum: domain.minimum,
      maximum: domain.maximum,
      gap,
      padding: frame.padding,
    },
    {
      root: path,
      data: `${path}.data`,
      x: `${path}.frame.x`,
      y: `${path}.frame.y`,
      width: `${path}.frame.width`,
      height: `${path}.frame.height`,
      minimum: `${path}.domain.minimum`,
      maximum: `${path}.domain.maximum`,
      gap: `${path}.gap`,
      padding: `${path}.frame.padding`,
    },
  );
  const actual: CutBarLayout = Object.freeze({ format: "cut-bar-layout", version: 1, id, data, frame, plot, domain, gap, marks });
  const difference = firstDifference(withoutLayoutId(cutBarLayoutIrValue(expected)), withoutLayoutId(cutBarLayoutIrValue(actual)), path);
  if (difference) fail("CUT_BAR_LAYOUT_IDENTITY", difference, "does not match geometry derived from retained data and layout inputs");
  if (id !== expected.id) fail("CUT_BAR_LAYOUT_IDENTITY", `${path}.id`, `does not match canonical layout identity ${expected.id}`);
  return expected;
}

export function joinCutBarLayoutTargets(layoutValue: IRValue, targetsValue: IRValue, path = "$"): IRValue {
  const layout = decodeCutBarLayout(layoutValue, childPath(path, "layout"));
  const targetsPath = childPath(path, "targets");
  if (targetsValue.kind !== "array") fail("CUT_BAR_TARGET_TYPE", targetsPath, "must be a List<MarkTarget>");
  if (targetsValue.items.length > cutBarLayoutLimits.maximumItems) {
    fail("CUT_BAR_LAYOUT_LIMIT", targetsPath, `exceeds the ${cutBarLayoutLimits.maximumItems}-target budget`);
  }
  const byKey = new Map<string, { target: CutMarkTarget; index: number }>();
  targetsValue.items.forEach((item, index) => {
    const target = decodeCutMarkTarget(item, `${targetsPath}[${index}]`);
    const previous = byKey.get(target.key);
    if (previous) {
      fail("CUT_BAR_TARGET_DUPLICATE", `${targetsPath}[${index}].key`, `duplicates key ${JSON.stringify(target.key)} first declared at ${targetsPath}[${previous.index}].key`);
    }
    byKey.set(target.key, { target, index });
  });
  const keys = new Set(layout.marks.map((mark) => mark.key));
  for (const [key, target] of byKey) {
    if (!keys.has(key)) fail("CUT_BAR_TARGET_COVERAGE", `${targetsPath}[${target.index}].key`, `does not match any layout key`);
  }
  const missing = layout.marks.filter((mark) => !byKey.has(mark.key)).map((mark) => mark.key);
  if (missing.length) fail("CUT_BAR_TARGET_COVERAGE", targetsPath, `is missing targets for keys ${missing.map((key) => JSON.stringify(key)).join(", ")}`);
  const ordered = layout.marks.map((mark) => byKey.get(mark.key)!.target);
  if (!ordered.some((target, index) => compareRational(target.x, layout.marks[index].x) !== 0 || compareRational(target.y, layout.marks[index].y) !== 0)) {
    fail("CUT_BAR_TARGET_NOOP", targetsPath, "maps every key to its existing source center and cannot produce a spatial change");
  }
  return arrayValue(ordered.map((target, index) => encodeMarkTransform({
    ...layout.marks[index],
    targetX: target.x,
    targetY: target.y,
  })));
}

function exactFormatValue(value: IRValue, path: string) {
  const result = exactQuantity(value, "scalar", "scalar", path, "CUT_DATA_FORMAT_TYPE");
  if (!withinAbsolute(result, cutBarLayoutLimits.maximumAbsoluteValue)) {
    fail("CUT_DATA_FORMAT_RANGE", path, "must remain within +/-1000000000000");
  }
  return result;
}

/** Locale-independent fixed decimal formatting. Ties round away from zero. */
export function formatCutNumber(
  value: IRValue,
  decimals: IRValue,
  suffix: IRValue,
  path = "$",
): IRValue {
  const number = exactFormatValue(value, childPath(path, "value"));
  const places = exactScalarInteger(decimals, childPath(path, "decimals"), "CUT_DATA_FORMAT_TYPE");
  if (places < 0 || places > cutBarLayoutLimits.maximumFormatDecimals) {
    fail("CUT_DATA_FORMAT_RANGE", childPath(path, "decimals"), `must be from 0 through ${cutBarLayoutLimits.maximumFormatDecimals}`);
  }
  const suffixText = exactString(suffix, childPath(path, "suffix"), "CUT_DATA_FORMAT_TYPE");
  if (!/^[\x20-\x7e]*$/u.test(suffixText) || Buffer.byteLength(suffixText, "utf8") > cutBarLayoutLimits.maximumFormatSuffixBytes) {
    fail("CUT_DATA_FORMAT_RANGE", childPath(path, "suffix"), `must be at most ${cutBarLayoutLimits.maximumFormatSuffixBytes} printable ASCII bytes`);
  }
  const negative = BigInt(number.numerator) < 0n;
  const numerator = negative ? -BigInt(number.numerator) : BigInt(number.numerator);
  const denominator = BigInt(number.denominator);
  const scale = 10n ** BigInt(places);
  const scaled = numerator * scale;
  let rounded = scaled / denominator;
  const remainder = scaled % denominator;
  if (remainder * 2n >= denominator) rounded += 1n;
  const whole = rounded / scale;
  const fraction = places ? `.${String(rounded % scale).padStart(places, "0")}` : "";
  const sign = negative && rounded !== 0n ? "-" : "";
  const result = `${sign}${whole}${fraction}${suffixText}`;
  if (Buffer.byteLength(result, "utf8") > cutBarLayoutLimits.maximumFormattedBytes) {
    fail("CUT_DATA_FORMAT_RANGE", path, `formatted result exceeds ${cutBarLayoutLimits.maximumFormattedBytes} bytes`);
  }
  return stringValue(result);
}
