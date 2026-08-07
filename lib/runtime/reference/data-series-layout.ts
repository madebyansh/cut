import { types as nodeTypes } from "node:util";
import { hash } from "../../core/stable";
import type {
  CutEvaluatedTableQuery,
  CutExactNumber,
  CutQuerySeriesPoint,
  CutQuerySeriesSchema,
  CutTableCell,
  CutTableField,
  CutTableFieldType,
} from "../../language/table-query";
import {
  addRational,
  compareRational,
  divideRational,
  multiplyRational,
  rational,
  subtractRational,
  type Rational,
  zeroRational,
} from "../../language/rational";

export const cutDataSeriesLayoutAlgorithmVersion = "cut-data-series-layout-v1" as const;
export const cutDataSeriesTextMeasurementUnit = "subpixel-1/64" as const;

export const cutDataSeriesLayoutLimits = Object.freeze({
  maxPoints: 100_000,
  maxSeries: 64,
  maxKeyFields: 128,
  maxMarks: 500_000,
  maxTicksPerAxis: 256,
  maxMeasurements: 640,
  maxLabelBytes: 1_024,
  maxSchemaStringBytes: 1_048_576,
  maxRationalDigits: 128,
  maxCanvasAxisPx: 16_384,
  maxAbsoluteOriginPx: 65_536,
  maxMeasurementSubpx: 16_384 * 64,
  maxLegendRows: 64,
  maxDateStep: 10_000,
  logFractionBits: 80,
  logSeriesTerms: 48,
  maxBoundaryDepth: 64,
  maxBoundaryNodes: 16_000_000,
  maxBoundaryStringBytes: 1_048_576,
  maxBoundaryTotalStringBytes: 32 * 1_048_576,
});

export type CutDataSeriesLayoutErrorCode =
  | "CUT_DATA_LAYOUT_TYPE"
  | "CUT_DATA_LAYOUT_UNKNOWN_FIELD"
  | "CUT_DATA_LAYOUT_ENUM"
  | "CUT_DATA_LAYOUT_SCHEMA"
  | "CUT_DATA_LAYOUT_IDENTITY"
  | "CUT_DATA_LAYOUT_DOMAIN"
  | "CUT_DATA_LAYOUT_RANGE"
  | "CUT_DATA_LAYOUT_LIMIT"
  | "CUT_DATA_LAYOUT_NOOP"
  | "CUT_DATA_LAYOUT_LABEL"
  | "CUT_DATA_LAYOUT_MEASUREMENT"
  | "CUT_DATA_LAYOUT_COLLISION";

export class CutDataSeriesLayoutError extends Error {
  constructor(
    readonly code: CutDataSeriesLayoutErrorCode,
    readonly path: string,
    message: string,
  ) {
    super(`${code}: ${message} at ${path}.`);
    this.name = "CutDataSeriesLayoutError";
  }
}

export type CutDataNumberFormat =
  | Readonly<{ kind: "fraction" }>
  | Readonly<{ kind: "decimal"; fractionDigits: number; trimTrailingZeros: boolean }>;

export type CutDataScaleSpec =
  | Readonly<{
      kind: "linear";
      domain: Readonly<{ min: CutExactNumber; max: CutExactNumber }>;
      ticks: Readonly<{ count: number; format: CutDataNumberFormat }>;
    }>
  | Readonly<{
      kind: "log";
      domain: Readonly<{ min: CutExactNumber; max: CutExactNumber }>;
      ticks: Readonly<{ format: CutDataNumberFormat }>;
    }>
  | Readonly<{ kind: "categorical"; order: "first-seen" }>
  | Readonly<{
      kind: "date";
      domain: Readonly<{ min: string; max: string }>;
      ticks: Readonly<{
        interval: "day" | "month" | "year";
        step: number;
        format: "iso-date" | "year-month" | "year";
      }>;
    }>;

export type CutDataSeriesLayoutSpec = Readonly<{
  format: "cut-data-series-layout-spec";
  version: 1;
  plot: Readonly<{ x: number; y: number; width: number; height: number }>;
  xScale: CutDataScaleSpec;
  yScale: Extract<CutDataScaleSpec, { kind: "linear" | "log" }>;
  series: readonly Readonly<{ field: string; name: string }>[];
  tickLabelGapSubpx: number;
  legend: Readonly<{
    x: number;
    y: number;
    maxWidth: number;
    itemGap: number;
    rowGap: number;
    swatchSize: number;
    swatchGap: number;
    maxRows: number;
  }>;
}>;

export type CutDataScaleValue =
  | Readonly<{ kind: "number"; value: CutExactNumber }>
  | Readonly<{ kind: "string"; value: string }>
  | Readonly<{ kind: "date"; value: string }>;

export type CutDataAxisTick = Readonly<{
  id: string;
  axis: "x" | "y";
  index: number;
  value: CutDataScaleValue;
  coordinate: Readonly<Rational>;
  label: string;
  measurementId: string;
}>;

export type CutDataMeasurementRequest = Readonly<{
  id: string;
  role: "x-axis-label" | "y-axis-label" | "legend-label";
  text: string;
}>;

export type CutDataSeriesMark = Readonly<{
  id: string;
  pointIndex: number;
  seriesField: string;
  key: Readonly<Record<string, CutTableCell>>;
  xValue: CutTableCell;
  value: CutExactNumber;
  x: Readonly<Rational>;
  y: Readonly<Rational>;
}>;

export type CutDataSeriesGeometryPlan = Readonly<{
  format: "cut-data-series-geometry-plan";
  version: 1;
  algorithm: typeof cutDataSeriesLayoutAlgorithmVersion;
  id: string;
  queryResultId: string;
  plot: Readonly<{ x: number; y: number; width: number; height: number }>;
  scales: Readonly<{
    x: Readonly<{ kind: CutDataScaleSpec["kind"]; id: string; ticks: readonly CutDataAxisTick[] }>;
    y: Readonly<{ kind: "linear" | "log"; id: string; ticks: readonly CutDataAxisTick[] }>;
  }>;
  series: readonly Readonly<{ field: string; name: string; id: string; measurementId: string }>[];
  marks: readonly CutDataSeriesMark[];
  measurementRequests: readonly CutDataMeasurementRequest[];
  tickLabelGapSubpx: number;
  legend: CutDataSeriesLayoutSpec["legend"];
}>;

export type CutLockedFontMeasurementIdentity = Readonly<{
  resourceId: string;
  sha256: string;
  faceIndex: number;
  shaperIdentity: string;
}>;

export type CutLockedTextMeasurement = Readonly<{
  id: string;
  widthSubpx: number;
  heightSubpx: number;
}>;

export type CutLockedTextMeasurementReceipt = Readonly<{
  format: "cut-locked-text-measurements";
  version: 1;
  id: string;
  planId: string;
  unit: typeof cutDataSeriesTextMeasurementUnit;
  font: CutLockedFontMeasurementIdentity;
  measurements: readonly CutLockedTextMeasurement[];
}>;

export type CutDataSeriesResolvedLayout = Readonly<{
  format: "cut-data-series-resolved-layout";
  version: 1;
  algorithm: typeof cutDataSeriesLayoutAlgorithmVersion;
  id: string;
  planId: string;
  measurementReceiptId: string;
  axes: Readonly<{
    x: readonly Readonly<{
      tickId: string;
      visible: boolean;
      reason?: "collision-thinned";
      intervalSubpx: Readonly<{ start: Rational; end: Rational }>;
    }>[];
    y: readonly Readonly<{
      tickId: string;
      visible: boolean;
      reason?: "collision-thinned";
      intervalSubpx: Readonly<{ start: Rational; end: Rational }>;
    }>[];
  }>;
  legend: readonly Readonly<{
    seriesId: string;
    measurementId: string;
    row: number;
    xSubpx: number;
    ySubpx: number;
    widthSubpx: number;
    heightSubpx: number;
  }>[];
}>;

type JsonRecord = Record<string, unknown>;
type BoundarySnapshotContext = { active: WeakSet<object>; nodes: number; stringBytes: number };

function fail(code: CutDataSeriesLayoutErrorCode, path: string, message: string): never {
  throw new CutDataSeriesLayoutError(code, path, message);
}

function child(path: string, name: string) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name) ? `${path}.${name}` : `${path}[${JSON.stringify(name)}]`;
}

function indexPath(path: string, index: number) { return `${path}[${index}]`; }

/**
 * Copy an untrusted JavaScript data graph without invoking any supplied code.
 * Only own enumerable data properties on direct ordinary objects/arrays cross
 * this boundary. The immutable snapshot, never the caller's aliases, is used
 * for all subsequent validation and identity work.
 */
function snapshotBoundary(
  value: unknown,
  path: string,
  context: BoundarySnapshotContext = { active: new WeakSet<object>(), nodes: 0, stringBytes: 0 },
  depth = 0,
): unknown {
  context.nodes += 1;
  if (context.nodes > cutDataSeriesLayoutLimits.maxBoundaryNodes) fail("CUT_DATA_LAYOUT_LIMIT", path, `boundary graph exceeds ${cutDataSeriesLayoutLimits.maxBoundaryNodes} values`);
  if (depth > cutDataSeriesLayoutLimits.maxBoundaryDepth) fail("CUT_DATA_LAYOUT_LIMIT", path, `boundary graph exceeds depth ${cutDataSeriesLayoutLimits.maxBoundaryDepth}`);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes > cutDataSeriesLayoutLimits.maxBoundaryStringBytes) fail("CUT_DATA_LAYOUT_LIMIT", path, `boundary string exceeds ${cutDataSeriesLayoutLimits.maxBoundaryStringBytes} UTF-8 bytes`);
    context.stringBytes += bytes;
    if (context.stringBytes > cutDataSeriesLayoutLimits.maxBoundaryTotalStringBytes) fail("CUT_DATA_LAYOUT_LIMIT", path, `boundary graph strings exceed ${cutDataSeriesLayoutLimits.maxBoundaryTotalStringBytes} UTF-8 bytes`);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("CUT_DATA_LAYOUT_TYPE", path, "numbers must be finite");
    return value;
  }
  if (typeof value !== "object") fail("CUT_DATA_LAYOUT_TYPE", path, "must contain data values only");
  if (nodeTypes.isProxy(value)) fail("CUT_DATA_LAYOUT_TYPE", path, "proxies are forbidden at the closed data boundary");
  if (context.active.has(value)) fail("CUT_DATA_LAYOUT_TYPE", path, "cyclic aliases are forbidden at the closed data boundary");
  context.active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) fail("CUT_DATA_LAYOUT_TYPE", path, "must be a direct ordinary array, not an array subclass");
      let indices = 0;
      for (const key of Reflect.ownKeys(value)) {
        if (key === "length") continue;
        if (typeof key === "symbol") fail("CUT_DATA_LAYOUT_TYPE", path, "symbol-keyed array properties are forbidden at the closed data boundary");
        if (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length) fail("CUT_DATA_LAYOUT_TYPE", child(path, key), "array contains a non-index own property");
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor)) fail("CUT_DATA_LAYOUT_TYPE", indexPath(path, Number(key)), "array accessors are forbidden at the closed data boundary");
        if (!descriptor.enumerable) fail("CUT_DATA_LAYOUT_TYPE", indexPath(path, Number(key)), "array elements must be enumerable data properties");
        indices += 1;
      }
      if (indices !== value.length) fail("CUT_DATA_LAYOUT_TYPE", path, "array must be dense and cannot contain holes");
      const result = Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))!;
        return snapshotBoundary((descriptor as PropertyDescriptor & { value: unknown }).value, indexPath(path, index), context, depth + 1);
      });
      return Object.freeze(result);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail("CUT_DATA_LAYOUT_TYPE", path, "must be a direct ordinary object");
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === "symbol") fail("CUT_DATA_LAYOUT_TYPE", path, "symbol-keyed properties are forbidden at the closed data boundary");
      if (key === "__proto__" || key === "prototype" || key === "constructor") fail("CUT_DATA_LAYOUT_TYPE", child(path, key), "is an unsafe data key");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) fail("CUT_DATA_LAYOUT_TYPE", child(path, key), "accessor properties are forbidden at the closed data boundary");
      if (!descriptor.enumerable) fail("CUT_DATA_LAYOUT_TYPE", child(path, key), "non-enumerable properties are forbidden at the closed data boundary");
      result[key] = snapshotBoundary(descriptor.value, child(path, key), context, depth + 1);
    }
    return Object.freeze(result);
  } finally {
    context.active.delete(value);
  }
}

function record(value: unknown, path: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("CUT_DATA_LAYOUT_TYPE", path, "must be an object");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail("CUT_DATA_LAYOUT_TYPE", path, "must have an ordinary or null prototype");
  const result = value as JsonRecord;
  for (const name of Object.keys(result)) if (name === "__proto__" || name === "prototype" || name === "constructor") {
    fail("CUT_DATA_LAYOUT_TYPE", child(path, name), "is an unsafe data key");
  }
  return result;
}

function closed(value: unknown, path: string, required: readonly string[], optional: readonly string[] = []) {
  const result = record(value, path), allowed = new Set([...required, ...optional]);
  for (const name of Object.keys(result)) if (!allowed.has(name)) fail("CUT_DATA_LAYOUT_UNKNOWN_FIELD", child(path, name), "is not part of the closed contract");
  for (const name of required) if (!Object.hasOwn(result, name)) fail("CUT_DATA_LAYOUT_TYPE", path, `is missing required field ${JSON.stringify(name)}`);
  return result;
}

function array(value: unknown, path: string) {
  if (!Array.isArray(value)) fail("CUT_DATA_LAYOUT_TYPE", path, "must be an array");
  return value;
}

function string(value: unknown, path: string, allowEmpty = false) {
  if (typeof value !== "string") fail("CUT_DATA_LAYOUT_TYPE", path, "must be a string");
  if (!allowEmpty && value.length === 0) fail("CUT_DATA_LAYOUT_TYPE", path, "must not be empty");
  if (!Array.from(value).every((character) => {
    const point = character.codePointAt(0)!;
    return point < 0xd800 || point > 0xdfff;
  })) fail("CUT_DATA_LAYOUT_TYPE", path, "must contain well-formed Unicode");
  return value;
}

function boundedLabel(value: unknown, path: string) {
  const result = string(value, path);
  const bytes = Buffer.byteLength(result, "utf8");
  if (bytes > cutDataSeriesLayoutLimits.maxLabelBytes) fail("CUT_DATA_LAYOUT_LIMIT", path, `label is ${bytes} UTF-8 bytes; limit is ${cutDataSeriesLayoutLimits.maxLabelBytes}`);
  return result;
}

function integer(value: unknown, path: string, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || Number(value) < minimum || Number(value) > maximum) {
    fail("CUT_DATA_LAYOUT_RANGE", path, `must be a safe integer from ${minimum} through ${maximum}`);
  }
  return Number(value);
}

function enumValue<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) fail("CUT_DATA_LAYOUT_ENUM", path, `must be one of: ${allowed.join(", ")}`);
  return value as T;
}

function digest(value: unknown, path: string) {
  const result = string(value, path);
  if (!/^[a-f0-9]{64}$/u.test(result)) fail("CUT_DATA_LAYOUT_TYPE", path, "must be a lowercase SHA-256 digest");
  return result;
}

function identifier(value: unknown, path: string) {
  const result = string(value, path);
  if (!/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/u.test(result)) fail("CUT_DATA_LAYOUT_TYPE", path, "must be a bounded identifier");
  return result;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const childValue of Object.values(value as Record<string, unknown>)) deepFreeze(childValue);
  }
  return value;
}

function exactNumber(value: unknown, path: string): CutExactNumber {
  const object = closed(value, path, ["numerator", "denominator"]);
  if (typeof object.numerator !== "string" || !/^(?:0|-?[1-9][0-9]*)$/u.test(object.numerator)) {
    fail("CUT_DATA_LAYOUT_TYPE", child(path, "numerator"), "must be a canonical integer string");
  }
  if (typeof object.denominator !== "string" || !/^[1-9][0-9]*$/u.test(object.denominator)) {
    fail("CUT_DATA_LAYOUT_TYPE", child(path, "denominator"), "must be a canonical positive integer string");
  }
  const digits = object.numerator.startsWith("-") ? object.numerator.length - 1 : object.numerator.length;
  if (digits > cutDataSeriesLayoutLimits.maxRationalDigits || object.denominator.length > cutDataSeriesLayoutLimits.maxRationalDigits) {
    fail("CUT_DATA_LAYOUT_LIMIT", path, `exact number exceeds ${cutDataSeriesLayoutLimits.maxRationalDigits} digits`);
  }
  const canonical = rational(object.numerator, object.denominator);
  if (canonical.numerator !== object.numerator || canonical.denominator !== object.denominator) {
    fail("CUT_DATA_LAYOUT_TYPE", path, "must be reduced canonical rational form");
  }
  return Object.freeze({ ...canonical });
}

function leapYear(year: number) { return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0); }
function daysInMonth(year: number, month: number) { return [31, leapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]; }

type CivilDate = Readonly<{ year: number; month: number; day: number }>;

function parseDate(value: unknown, path: string): CivilDate & { text: string } {
  const text = string(value, path), match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(text);
  if (!match) fail("CUT_DATA_LAYOUT_TYPE", path, "must be a strict Gregorian date in YYYY-MM-DD form");
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) fail("CUT_DATA_LAYOUT_RANGE", path, "must be a real proleptic-Gregorian date");
  return Object.freeze({ year, month, day, text });
}

function dateOrdinal(date: CivilDate) {
  let year = date.year;
  year -= date.month <= 2 ? 1 : 0;
  const era = Math.floor(year / 400), yearOfEra = year - era * 400;
  const shiftedMonth = date.month + (date.month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * shiftedMonth + 2) / 5) + date.day - 1;
  return era * 146_097 + yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
}

function civilFromOrdinal(ordinal: number): CivilDate {
  const era = Math.floor(ordinal / 146_097), dayOfEra = ordinal - era * 146_097;
  const yearOfEra = Math.floor((dayOfEra - Math.floor(dayOfEra / 1_460) + Math.floor(dayOfEra / 36_524) - Math.floor(dayOfEra / 146_096)) / 365);
  let year = yearOfEra + era * 400;
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const shiftedMonth = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * shiftedMonth + 2) / 5) + 1;
  const month = shiftedMonth + (shiftedMonth < 10 ? 3 : -9);
  year += month <= 2 ? 1 : 0;
  return Object.freeze({ year, month, day });
}

function dateText(date: CivilDate) {
  return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

function addCalendarStep(start: CivilDate, interval: "day" | "month" | "year", count: number): CivilDate {
  if (interval === "day") return civilFromOrdinal(dateOrdinal(start) + count);
  if (interval === "month") {
    const total = start.year * 12 + start.month - 1 + count, year = Math.floor(total / 12), month = total - year * 12 + 1;
    return Object.freeze({ year, month, day: Math.min(start.day, daysInMonth(year, month)) });
  }
  const year = start.year + count;
  return Object.freeze({ year, month: start.month, day: Math.min(start.day, daysInMonth(year, start.month)) });
}

function fieldType(value: unknown, path: string): CutTableFieldType {
  const object = record(value, path), kind = enumValue(object.kind, child(path, "kind"), ["number", "string", "boolean", "date"] as const);
  if (kind === "string") {
    closed(object, path, ["kind", "maxBytes"]);
    return Object.freeze({ kind, maxBytes: integer(object.maxBytes, child(path, "maxBytes"), 1, cutDataSeriesLayoutLimits.maxSchemaStringBytes) });
  }
  closed(object, path, ["kind"]);
  return Object.freeze({ kind });
}

function field(value: unknown, path: string): CutTableField {
  const object = closed(value, path, ["name", "type"]);
  return Object.freeze({ name: identifier(object.name, child(path, "name")), type: fieldType(object.type, child(path, "type")) });
}

function cell(value: unknown, type: CutTableFieldType, path: string): CutTableCell {
  if (type.kind === "number") return exactNumber(value, path);
  if (type.kind === "boolean") {
    if (typeof value !== "boolean") fail("CUT_DATA_LAYOUT_TYPE", path, "must be Boolean");
    return value;
  }
  if (type.kind === "date") return parseDate(value, path).text;
  const result = string(value, path, true), bytes = Buffer.byteLength(result, "utf8");
  if (bytes > type.maxBytes) fail("CUT_DATA_LAYOUT_LIMIT", path, `string is ${bytes} bytes; schema limit is ${type.maxBytes}`);
  return result;
}

function seriesSchema(value: unknown, path: string): CutQuerySeriesSchema {
  const object = closed(value, path, ["key", "x", "values"]);
  const keyItems = array(object.key, child(path, "key"));
  if (keyItems.length < 1 || keyItems.length > cutDataSeriesLayoutLimits.maxKeyFields) fail("CUT_DATA_LAYOUT_SCHEMA", child(path, "key"), `must contain 1..${cutDataSeriesLayoutLimits.maxKeyFields} key fields`);
  const valueItems = array(object.values, child(path, "values"));
  if (valueItems.length < 1 || valueItems.length > cutDataSeriesLayoutLimits.maxSeries) fail("CUT_DATA_LAYOUT_SCHEMA", child(path, "values"), `must contain 1..${cutDataSeriesLayoutLimits.maxSeries} numeric fields`);
  const key = keyItems.map((item, index) => field(item, indexPath(child(path, "key"), index)));
  const x = field(object.x, child(path, "x"));
  const values = valueItems.map((item, index) => field(item, indexPath(child(path, "values"), index)));
  if (x.type.kind === "boolean") fail("CUT_DATA_LAYOUT_SCHEMA", child(path, "x.type.kind"), "Boolean x fields are not a scale domain");
  const keyNames = new Set<string>();
  for (const item of key) {
    if (keyNames.has(item.name)) fail("CUT_DATA_LAYOUT_SCHEMA", child(path, "key"), `duplicates field ${JSON.stringify(item.name)}`);
    keyNames.add(item.name);
  }
  // A terminal series commonly uses its primary key as x. That is one field
  // in two semantic roles, not an ambiguous duplicate: points still carry the
  // value once in `key` and once in the explicitly typed `x` slot. Value
  // aliases remain disjoint from both roles so chart field selection is never
  // ambiguous.
  const matchingKey = key.find((item) => item.name === x.name);
  if (matchingKey && (matchingKey.type.kind !== x.type.kind
    || (matchingKey.type.kind === "string" && (x.type.kind !== "string" || matchingKey.type.maxBytes !== x.type.maxBytes)))) {
    fail("CUT_DATA_LAYOUT_SCHEMA", child(path, "x"), `must match the type of key field ${JSON.stringify(x.name)}`);
  }
  const valueNames = new Set<string>();
  for (const item of values) {
    if (item.name === x.name || keyNames.has(item.name) || valueNames.has(item.name)) {
      fail("CUT_DATA_LAYOUT_SCHEMA", child(path, "values"), `duplicates field ${JSON.stringify(item.name)}`);
    }
    valueNames.add(item.name);
  }
  for (const item of values) if (item.type.kind !== "number") fail("CUT_DATA_LAYOUT_SCHEMA", path, `series value ${item.name} must be numeric`);
  return deepFreeze({ key, x, values });
}

function typedCellIdentity(type: CutTableFieldType, value: CutTableCell) {
  if (type.kind === "number") return ["number", (value as Rational).numerator, (value as Rational).denominator];
  return [type.kind, value];
}

function validateQuerySeries(value: unknown): Extract<CutEvaluatedTableQuery, { kind: "series" }> {
  const path = "$.query", object = closed(value, path, ["format", "version", "kind", "id", "planId", "sources", "schema", "points"]);
  if (object.format !== "cut-query-result" || object.version !== 1 || object.kind !== "series") fail("CUT_DATA_LAYOUT_TYPE", path, "must be a cut-query-result v1 series");
  const id = digest(object.id, child(path, "id")), planId = digest(object.planId, child(path, "planId"));
  const sourceItems = array(object.sources, child(path, "sources"));
  if (sourceItems.length < 1 || sourceItems.length > 32) fail("CUT_DATA_LAYOUT_LIMIT", child(path, "sources"), "must contain 1..32 source identities");
  const sources = sourceItems.map((item, index) => {
    const sourcePath = indexPath(child(path, "sources"), index), source = closed(item, sourcePath, ["name", "tableId"]);
    return Object.freeze({ name: identifier(source.name, child(sourcePath, "name")), tableId: digest(source.tableId, child(sourcePath, "tableId")) });
  });
  const schema = seriesSchema(object.schema, child(path, "schema"));
  const pointItems = array(object.points, child(path, "points"));
  if (pointItems.length < 1) fail("CUT_DATA_LAYOUT_NOOP", child(path, "points"), "an empty series has no marks or scale evidence");
  if (pointItems.length > cutDataSeriesLayoutLimits.maxPoints) fail("CUT_DATA_LAYOUT_LIMIT", child(path, "points"), `contains ${pointItems.length} points; limit is ${cutDataSeriesLayoutLimits.maxPoints}`);
  const keyIdentities = new Set<string>();
  const points: CutQuerySeriesPoint[] = pointItems.map((item, pointIndex) => {
    const pointPath = indexPath(child(path, "points"), pointIndex), point = closed(item, pointPath, ["key", "x", "values"]);
    const keyObject = closed(point.key, child(pointPath, "key"), schema.key.map((item) => item.name));
    const key: Record<string, CutTableCell> = Object.create(null) as Record<string, CutTableCell>;
    for (const item of schema.key) key[item.name] = cell(keyObject[item.name], item.type, child(child(pointPath, "key"), item.name));
    const identity = JSON.stringify(schema.key.map((item) => typedCellIdentity(item.type, key[item.name])));
    if (keyIdentities.has(identity)) fail("CUT_DATA_LAYOUT_SCHEMA", child(pointPath, "key"), "duplicates a typed point key");
    keyIdentities.add(identity);
    const valuesObject = closed(point.values, child(pointPath, "values"), schema.values.map((item) => item.name));
    const values: Record<string, CutExactNumber> = Object.create(null) as Record<string, CutExactNumber>;
    for (const item of schema.values) values[item.name] = exactNumber(valuesObject[item.name], child(child(pointPath, "values"), item.name));
    return deepFreeze({ key, x: cell(point.x, schema.x.type, child(pointPath, "x")), values });
  });
  const expected = hash({ format: "cut-query-result-identity", version: 1, kind: "series", planId, sources, schema, points });
  if (id !== expected) fail("CUT_DATA_LAYOUT_IDENTITY", child(path, "id"), `does not match canonical query series identity ${expected}`);
  return deepFreeze({ format: "cut-query-result", version: 1, kind: "series", id, planId, sources, schema, points });
}

function numberFormat(value: unknown, path: string): CutDataNumberFormat {
  const object = record(value, path), kind = enumValue(object.kind, child(path, "kind"), ["fraction", "decimal"] as const);
  if (kind === "fraction") { closed(object, path, ["kind"]); return Object.freeze({ kind }); }
  closed(object, path, ["kind", "fractionDigits", "trimTrailingZeros"]);
  if (typeof object.trimTrailingZeros !== "boolean") fail("CUT_DATA_LAYOUT_TYPE", child(path, "trimTrailingZeros"), "must be Boolean");
  return Object.freeze({
    kind,
    fractionDigits: integer(object.fractionDigits, child(path, "fractionDigits"), 0, 12),
    trimTrailingZeros: object.trimTrailingZeros,
  });
}

function numberDomain(value: unknown, path: string) {
  const object = closed(value, path, ["min", "max"]), min = exactNumber(object.min, child(path, "min")), max = exactNumber(object.max, child(path, "max"));
  if (compareRational(min, max) >= 0) fail("CUT_DATA_LAYOUT_DOMAIN", path, "requires min < max");
  return Object.freeze({ min, max });
}

function scaleSpec(value: unknown, path: string): CutDataScaleSpec {
  const object = record(value, path), kind = enumValue(object.kind, child(path, "kind"), ["linear", "log", "categorical", "date"] as const);
  if (kind === "categorical") {
    closed(object, path, ["kind", "order"]);
    return Object.freeze({ kind, order: enumValue(object.order, child(path, "order"), ["first-seen"] as const) });
  }
  if (kind === "linear") {
    closed(object, path, ["kind", "domain", "ticks"]);
    const ticks = closed(object.ticks, child(path, "ticks"), ["count", "format"]);
    return deepFreeze({
      kind,
      domain: numberDomain(object.domain, child(path, "domain")),
      ticks: {
        count: integer(ticks.count, child(child(path, "ticks"), "count"), 2, cutDataSeriesLayoutLimits.maxTicksPerAxis),
        format: numberFormat(ticks.format, child(child(path, "ticks"), "format")),
      },
    });
  }
  if (kind === "log") {
    closed(object, path, ["kind", "domain", "ticks"]);
    const domain = numberDomain(object.domain, child(path, "domain")), ticks = closed(object.ticks, child(path, "ticks"), ["format"]);
    if (compareRational(domain.min, zeroRational) <= 0) fail("CUT_DATA_LAYOUT_DOMAIN", child(path, "domain.min"), "logarithmic domains must be strictly positive");
    return deepFreeze({ kind, domain, ticks: { format: numberFormat(ticks.format, child(child(path, "ticks"), "format")) } });
  }
  closed(object, path, ["kind", "domain", "ticks"]);
  const domainObject = closed(object.domain, child(path, "domain"), ["min", "max"]);
  const min = parseDate(domainObject.min, child(child(path, "domain"), "min")).text;
  const max = parseDate(domainObject.max, child(child(path, "domain"), "max")).text;
  if (dateOrdinal(parseDate(min, path)) >= dateOrdinal(parseDate(max, path))) fail("CUT_DATA_LAYOUT_DOMAIN", child(path, "domain"), "requires min before max");
  const ticks = closed(object.ticks, child(path, "ticks"), ["interval", "step", "format"]);
  return deepFreeze({
    kind,
    domain: { min, max },
    ticks: {
      interval: enumValue(ticks.interval, child(child(path, "ticks"), "interval"), ["day", "month", "year"] as const),
      step: integer(ticks.step, child(child(path, "ticks"), "step"), 1, cutDataSeriesLayoutLimits.maxDateStep),
      format: enumValue(ticks.format, child(child(path, "ticks"), "format"), ["iso-date", "year-month", "year"] as const),
    },
  });
}

function layoutSpec(value: unknown, schema: CutQuerySeriesSchema): CutDataSeriesLayoutSpec {
  const path = "$.spec", object = closed(value, path, ["format", "version", "plot", "xScale", "yScale", "series", "tickLabelGapSubpx", "legend"]);
  if (object.format !== "cut-data-series-layout-spec" || object.version !== 1) fail("CUT_DATA_LAYOUT_TYPE", path, "must be a cut-data-series-layout-spec v1 document");
  const plotObject = closed(object.plot, child(path, "plot"), ["x", "y", "width", "height"]);
  const plot = Object.freeze({
    x: integer(plotObject.x, child(child(path, "plot"), "x"), -cutDataSeriesLayoutLimits.maxAbsoluteOriginPx, cutDataSeriesLayoutLimits.maxAbsoluteOriginPx),
    y: integer(plotObject.y, child(child(path, "plot"), "y"), -cutDataSeriesLayoutLimits.maxAbsoluteOriginPx, cutDataSeriesLayoutLimits.maxAbsoluteOriginPx),
    width: integer(plotObject.width, child(child(path, "plot"), "width"), 1, cutDataSeriesLayoutLimits.maxCanvasAxisPx),
    height: integer(plotObject.height, child(child(path, "plot"), "height"), 1, cutDataSeriesLayoutLimits.maxCanvasAxisPx),
  });
  const xScale = scaleSpec(object.xScale, child(path, "xScale"));
  const yScale = scaleSpec(object.yScale, child(path, "yScale"));
  if (yScale.kind !== "linear" && yScale.kind !== "log") fail("CUT_DATA_LAYOUT_SCHEMA", child(path, "yScale.kind"), "yScale must be linear or log");
  const expectedX = schema.x.type.kind;
  if ((expectedX === "number" && xScale.kind !== "linear" && xScale.kind !== "log")
    || (expectedX === "string" && xScale.kind !== "categorical")
    || (expectedX === "date" && xScale.kind !== "date")) {
    fail("CUT_DATA_LAYOUT_SCHEMA", child(path, "xScale.kind"), `does not match query x type ${expectedX}`);
  }
  const available = new Set(schema.values.map((item) => item.name)), selected = new Set<string>(), names = new Set<string>();
  const seriesItems = array(object.series, child(path, "series"));
  if (seriesItems.length < 1 || seriesItems.length > cutDataSeriesLayoutLimits.maxSeries) fail("CUT_DATA_LAYOUT_LIMIT", child(path, "series"), `must contain 1..${cutDataSeriesLayoutLimits.maxSeries} named series`);
  const series = seriesItems.map((item, index) => {
    const itemPath = indexPath(child(path, "series"), index), seriesObject = closed(item, itemPath, ["field", "name"]);
    const fieldName = identifier(seriesObject.field, child(itemPath, "field")), name = boundedLabel(seriesObject.name, child(itemPath, "name"));
    if (!available.has(fieldName)) fail("CUT_DATA_LAYOUT_SCHEMA", child(itemPath, "field"), `does not name a numeric query series field`);
    if (selected.has(fieldName)) fail("CUT_DATA_LAYOUT_SCHEMA", child(itemPath, "field"), `duplicates selected field ${fieldName}`);
    if (names.has(name)) fail("CUT_DATA_LAYOUT_SCHEMA", child(itemPath, "name"), `duplicates legend name ${JSON.stringify(name)}`);
    selected.add(fieldName); names.add(name);
    return Object.freeze({ field: fieldName, name });
  });
  const legendObject = closed(object.legend, child(path, "legend"), ["x", "y", "maxWidth", "itemGap", "rowGap", "swatchSize", "swatchGap", "maxRows"]);
  const legend = Object.freeze({
    x: integer(legendObject.x, child(child(path, "legend"), "x"), -cutDataSeriesLayoutLimits.maxAbsoluteOriginPx, cutDataSeriesLayoutLimits.maxAbsoluteOriginPx),
    y: integer(legendObject.y, child(child(path, "legend"), "y"), -cutDataSeriesLayoutLimits.maxAbsoluteOriginPx, cutDataSeriesLayoutLimits.maxAbsoluteOriginPx),
    maxWidth: integer(legendObject.maxWidth, child(child(path, "legend"), "maxWidth"), 1, cutDataSeriesLayoutLimits.maxCanvasAxisPx),
    itemGap: integer(legendObject.itemGap, child(child(path, "legend"), "itemGap"), 0, 1_024),
    rowGap: integer(legendObject.rowGap, child(child(path, "legend"), "rowGap"), 0, 1_024),
    swatchSize: integer(legendObject.swatchSize, child(child(path, "legend"), "swatchSize"), 1, 1_024),
    swatchGap: integer(legendObject.swatchGap, child(child(path, "legend"), "swatchGap"), 0, 1_024),
    maxRows: integer(legendObject.maxRows, child(child(path, "legend"), "maxRows"), 1, cutDataSeriesLayoutLimits.maxLegendRows),
  });
  return deepFreeze({
    format: "cut-data-series-layout-spec",
    version: 1,
    plot,
    xScale,
    yScale,
    series,
    tickLabelGapSubpx: integer(object.tickLabelGapSubpx, child(path, "tickLabelGapSubpx"), 0, 8_192),
    legend,
  });
}

function roundRatioHalfEven(numerator: bigint, denominator: bigint) {
  const negative = numerator < 0n, absolute = negative ? -numerator : numerator;
  let quotient = absolute / denominator;
  const remainder = absolute % denominator, doubled = remainder * 2n;
  if (doubled > denominator || (doubled === denominator && quotient % 2n === 1n)) quotient += 1n;
  return negative ? -quotient : quotient;
}

function formatNumber(value: Rational, format: CutDataNumberFormat) {
  if (format.kind === "fraction") return value.denominator === "1" ? value.numerator : `${value.numerator}/${value.denominator}`;
  const scale = 10n ** BigInt(format.fractionDigits);
  const rounded = roundRatioHalfEven(BigInt(value.numerator) * scale, BigInt(value.denominator));
  const negative = rounded < 0n, digits = (negative ? -rounded : rounded).toString().padStart(format.fractionDigits + 1, "0");
  if (format.fractionDigits === 0) return `${negative ? "-" : ""}${digits}`;
  const split = digits.length - format.fractionDigits;
  let fraction = digits.slice(split);
  if (format.trimTrailingZeros) fraction = fraction.replace(/0+$/u, "");
  return `${negative ? "-" : ""}${digits.slice(0, split)}${fraction ? `.${fraction}` : ""}`;
}

function formatDate(value: string, format: "iso-date" | "year-month" | "year") {
  return format === "iso-date" ? value : format === "year-month" ? value.slice(0, 7) : value.slice(0, 4);
}

function linearValues(domain: Readonly<{ min: Rational; max: Rational }>, count: number) {
  const extent = subtractRational(domain.max, domain.min), denominator = rational(count - 1);
  return Object.freeze(Array.from({ length: count }, (_, index) => addRational(domain.min, divideRational(multiplyRational(extent, rational(index)), denominator))));
}

function comparePositiveToPower10(value: Rational, exponent: number) {
  const numerator = BigInt(value.numerator), denominator = BigInt(value.denominator);
  return exponent >= 0
    ? numerator === denominator * 10n ** BigInt(exponent) ? 0 : numerator < denominator * 10n ** BigInt(exponent) ? -1 : 1
    : numerator * 10n ** BigInt(-exponent) === denominator ? 0 : numerator * 10n ** BigInt(-exponent) < denominator ? -1 : 1;
}

function floorLog10(value: Rational) {
  const numeratorDigits = value.numerator.length, denominatorDigits = value.denominator.length;
  let exponent = numeratorDigits - denominatorDigits;
  if (comparePositiveToPower10(value, exponent) < 0) exponent -= 1;
  while (comparePositiveToPower10(value, exponent + 1) >= 0) exponent += 1;
  return exponent;
}

function power10(exponent: number) {
  return exponent >= 0 ? rational(10n ** BigInt(exponent)) : rational(1, 10n ** BigInt(-exponent));
}

function logTickValues(domain: Readonly<{ min: Rational; max: Rational }>) {
  const minimumExponent = floorLog10(domain.min) + (comparePositiveToPower10(domain.min, floorLog10(domain.min)) === 0 ? 0 : 1);
  const maximumExponent = floorLog10(domain.max), result: Rational[] = [domain.min];
  for (let exponent = minimumExponent; exponent <= maximumExponent; exponent += 1) {
    const value = power10(exponent);
    if (compareRational(value, domain.min) > 0 && compareRational(value, domain.max) < 0) result.push(value);
    if (result.length >= cutDataSeriesLayoutLimits.maxTicksPerAxis) fail("CUT_DATA_LAYOUT_LIMIT", "$.spec", `log scale exceeds ${cutDataSeriesLayoutLimits.maxTicksPerAxis} ticks`);
  }
  if (compareRational(result.at(-1)!, domain.max) !== 0) result.push(domain.max);
  return Object.freeze(result);
}

const logScale = 1n << BigInt(cutDataSeriesLayoutLimits.logFractionBits);

function fixedMultiply(left: bigint, right: bigint) { return roundRatioHalfEven(left * right, logScale); }

function fixedAtanhSeries(z: bigint) {
  const square = fixedMultiply(z, z);
  let term = z, sum = 0n;
  for (let index = 0; index < cutDataSeriesLayoutLimits.logSeriesTerms; index += 1) {
    sum += roundRatioHalfEven(term, BigInt(index * 2 + 1));
    term = fixedMultiply(term, square);
  }
  return 2n * sum;
}

const fixedLn2 = fixedAtanhSeries(roundRatioHalfEven(logScale, 3n));

function bitLength(value: bigint) { return value.toString(2).length; }

function fixedLn(value: Rational) {
  let numerator = BigInt(value.numerator), denominator = BigInt(value.denominator);
  if (numerator <= 0n) throw new Error("Internal logarithm requires a positive rational.");
  let exponent = bitLength(numerator) - bitLength(denominator);
  if (exponent >= 0) {
    if (numerator < denominator << BigInt(exponent)) exponent -= 1;
  } else if (numerator << BigInt(-exponent) < denominator) exponent -= 1;
  if (exponent >= 0) denominator <<= BigInt(exponent);
  else numerator <<= BigInt(-exponent);
  const z = roundRatioHalfEven((numerator - denominator) * logScale, numerator + denominator);
  return fixedAtanhSeries(z) + BigInt(exponent) * fixedLn2;
}

function linearProgress(value: Rational, domain: Readonly<{ min: Rational; max: Rational }>) {
  return divideRational(subtractRational(value, domain.min), subtractRational(domain.max, domain.min));
}

function logProgress(value: Rational, domain: Readonly<{ min: Rational; max: Rational }>) {
  if (compareRational(value, domain.min) === 0) return zeroRational;
  if (compareRational(value, domain.max) === 0) return rational(1);
  const minimum = fixedLn(domain.min), maximum = fixedLn(domain.max), current = fixedLn(value);
  if (minimum === maximum) fail("CUT_DATA_LAYOUT_RANGE", "$.spec", `log domain is narrower than the deterministic ${cutDataSeriesLayoutLimits.logFractionBits}-bit mapping precision`);
  const progress = rational(current - minimum, maximum - minimum);
  if (compareRational(progress, zeroRational) < 0 || compareRational(progress, rational(1)) > 0) fail("CUT_DATA_LAYOUT_RANGE", "$.query", "log mapping escaped its declared domain");
  return progress;
}

function mapHorizontal(plot: CutDataSeriesLayoutSpec["plot"], progress: Rational) {
  return addRational(rational(plot.x), multiplyRational(rational(plot.width), progress));
}

function mapVertical(plot: CutDataSeriesLayoutSpec["plot"], progress: Rational) {
  return addRational(rational(plot.y), multiplyRational(rational(plot.height), subtractRational(rational(1), progress)));
}

function dateValues(scale: Extract<CutDataScaleSpec, { kind: "date" }>) {
  const start = parseDate(scale.domain.min, "$.spec.xScale.domain.min"), end = parseDate(scale.domain.max, "$.spec.xScale.domain.max");
  const result = [start.text];
  for (let index = 1; ; index += 1) {
    const next = addCalendarStep(start, scale.ticks.interval, index * scale.ticks.step), ordinal = dateOrdinal(next);
    if (ordinal >= dateOrdinal(end)) break;
    if (next.year < 0 || next.year > 9_999) fail("CUT_DATA_LAYOUT_RANGE", "$.spec.xScale.ticks", "calendar tick exceeds four-digit year range");
    result.push(dateText(next));
    if (result.length >= cutDataSeriesLayoutLimits.maxTicksPerAxis) fail("CUT_DATA_LAYOUT_LIMIT", "$.spec.xScale.ticks", `exceeds ${cutDataSeriesLayoutLimits.maxTicksPerAxis} ticks`);
  }
  if (result.at(-1) !== end.text) result.push(end.text);
  return Object.freeze(result);
}

function assertUniqueLabels(labels: readonly string[], path: string) {
  const seen = new Set<string>();
  for (const label of labels) {
    boundedLabel(label, path);
    if (seen.has(label)) fail("CUT_DATA_LAYOUT_LABEL", path, `tick formatter produces duplicate label ${JSON.stringify(label)}`);
    seen.add(label);
  }
}

function valueWithin(value: Rational, domain: Readonly<{ min: Rational; max: Rational }>, path: string, log = false) {
  if (log && compareRational(value, zeroRational) <= 0) fail("CUT_DATA_LAYOUT_DOMAIN", path, "logarithmic values must be strictly positive");
  if (compareRational(value, domain.min) < 0 || compareRational(value, domain.max) > 0) fail("CUT_DATA_LAYOUT_DOMAIN", path, "falls outside the explicit scale domain");
}

function planAxis(
  axis: "x" | "y",
  scale: CutDataScaleSpec,
  plot: CutDataSeriesLayoutSpec["plot"],
  points: readonly CutQuerySeriesPoint[],
) {
  let values: CutDataScaleValue[], labels: string[], coordinates: Rational[];
  if (scale.kind === "categorical") {
    const categories: string[] = [], seen = new Set<string>();
    for (const point of points) {
      const category = point.x as string;
      if (!seen.has(category)) {
        if (categories.length >= cutDataSeriesLayoutLimits.maxTicksPerAxis) fail("CUT_DATA_LAYOUT_LIMIT", "$.query.points", `categorical scale exceeds ${cutDataSeriesLayoutLimits.maxTicksPerAxis} categories`);
        seen.add(category); categories.push(category);
      }
    }
    values = categories.map((value) => ({ kind: "string", value } as const)); labels = categories;
    coordinates = categories.map((_, index) => mapHorizontal(plot, rational(index * 2 + 1, categories.length * 2)));
  } else if (scale.kind === "date") {
    const candidates = dateValues(scale), minimum = dateOrdinal(parseDate(scale.domain.min, "$.spec.xScale.domain.min")), extent = dateOrdinal(parseDate(scale.domain.max, "$.spec.xScale.domain.max")) - minimum;
    values = candidates.map((value) => ({ kind: "date", value } as const));
    labels = candidates.map((value) => formatDate(value, scale.ticks.format));
    coordinates = candidates.map((value) => mapHorizontal(plot, rational(dateOrdinal(parseDate(value, "$.spec.xScale")) - minimum, extent)));
  } else {
    const candidates = scale.kind === "linear" ? linearValues(scale.domain, scale.ticks.count) : logTickValues(scale.domain);
    values = candidates.map((value) => ({ kind: "number", value } as const));
    labels = candidates.map((value) => formatNumber(value, scale.ticks.format));
    coordinates = candidates.map((value) => {
      const progress = scale.kind === "linear" ? linearProgress(value, scale.domain) : logProgress(value, scale.domain);
      return axis === "x" ? mapHorizontal(plot, progress) : mapVertical(plot, progress);
    });
  }
  assertUniqueLabels(labels, `$.spec.${axis}Scale.ticks`);
  const scaleId = hash({ algorithm: cutDataSeriesLayoutAlgorithmVersion, axis, scale, plot: axis === "x" ? { x: plot.x, width: plot.width } : { y: plot.y, height: plot.height }, candidates: values });
  const ticks = values.map((value, index): CutDataAxisTick => {
    const tickIdentity = { scaleId, axis, index, value, coordinate: coordinates[index], label: labels[index] };
    const id = hash({ format: "cut-data-axis-tick", version: 1, ...tickIdentity });
    return deepFreeze({ id, axis, index, value, coordinate: coordinates[index], label: labels[index], measurementId: hash({ format: "cut-data-measurement-request", version: 1, role: `${axis}-axis-label`, tickId: id, text: labels[index] }) });
  });
  return deepFreeze({ kind: scale.kind, id: scaleId, ticks });
}

function xCoordinate(point: CutQuerySeriesPoint, pointIndex: number, scale: CutDataScaleSpec, plot: CutDataSeriesLayoutSpec["plot"], categories: readonly string[]) {
  if (scale.kind === "categorical") {
    const index = categories.indexOf(point.x as string);
    if (index < 0) throw new Error("Internal category index is missing.");
    return mapHorizontal(plot, rational(index * 2 + 1, categories.length * 2));
  }
  if (scale.kind === "date") {
    const value = dateOrdinal(parseDate(point.x, indexPath("$.query.points", pointIndex))), minimum = dateOrdinal(parseDate(scale.domain.min, "$.spec.xScale.domain.min")), maximum = dateOrdinal(parseDate(scale.domain.max, "$.spec.xScale.domain.max"));
    if (value < minimum || value > maximum) fail("CUT_DATA_LAYOUT_DOMAIN", child(indexPath("$.query.points", pointIndex), "x"), "falls outside the explicit date domain");
    return mapHorizontal(plot, rational(value - minimum, maximum - minimum));
  }
  const value = point.x as CutExactNumber;
  valueWithin(value, scale.domain, child(indexPath("$.query.points", pointIndex), "x"), scale.kind === "log");
  return mapHorizontal(plot, scale.kind === "linear" ? linearProgress(value, scale.domain) : logProgress(value, scale.domain));
}

function yCoordinate(value: CutExactNumber, pointIndex: number, fieldName: string, scale: Extract<CutDataScaleSpec, { kind: "linear" | "log" }>, plot: CutDataSeriesLayoutSpec["plot"]) {
  valueWithin(value, scale.domain, child(child(indexPath("$.query.points", pointIndex), "values"), fieldName), scale.kind === "log");
  return mapVertical(plot, scale.kind === "linear" ? linearProgress(value, scale.domain) : logProgress(value, scale.domain));
}

function planCell(value: unknown, path: string): CutTableCell {
  if (typeof value === "string") return string(value, path, true);
  if (typeof value === "boolean") return value;
  return exactNumber(value, path);
}

function geometryTick(value: unknown, path: string, axis: "x" | "y", scaleKind: CutDataScaleSpec["kind"], expectedIndex: number): CutDataAxisTick {
  const object = closed(value, path, ["id", "axis", "index", "value", "coordinate", "label", "measurementId"]);
  const tickAxis = enumValue(object.axis, child(path, "axis"), ["x", "y"] as const);
  if (tickAxis !== axis) fail("CUT_DATA_LAYOUT_SCHEMA", child(path, "axis"), `must be ${axis} for this scale`);
  const index = integer(object.index, child(path, "index"), 0, cutDataSeriesLayoutLimits.maxTicksPerAxis - 1);
  if (index !== expectedIndex) fail("CUT_DATA_LAYOUT_SCHEMA", child(path, "index"), `must equal canonical tick position ${expectedIndex}`);
  const valuePath = child(path, "value"), valueObject = record(object.value, valuePath), kind = enumValue(valueObject.kind, child(valuePath, "kind"), ["number", "string", "date"] as const);
  if ((scaleKind === "linear" || scaleKind === "log") && kind !== "number") fail("CUT_DATA_LAYOUT_SCHEMA", child(valuePath, "kind"), `${scaleKind} ticks require numeric values`);
  if (scaleKind === "categorical" && kind !== "string") fail("CUT_DATA_LAYOUT_SCHEMA", child(valuePath, "kind"), "categorical ticks require string values");
  if (scaleKind === "date" && kind !== "date") fail("CUT_DATA_LAYOUT_SCHEMA", child(valuePath, "kind"), "date ticks require date values");
  let typedValue: CutDataScaleValue;
  if (kind === "number") {
    closed(valueObject, valuePath, ["kind", "value"]);
    typedValue = Object.freeze({ kind, value: exactNumber(valueObject.value, child(valuePath, "value")) });
  } else if (kind === "date") {
    closed(valueObject, valuePath, ["kind", "value"]);
    typedValue = Object.freeze({ kind, value: parseDate(valueObject.value, child(valuePath, "value")).text });
  } else {
    closed(valueObject, valuePath, ["kind", "value"]);
    typedValue = Object.freeze({ kind, value: boundedLabel(valueObject.value, child(valuePath, "value")) });
  }
  return deepFreeze({
    id: digest(object.id, child(path, "id")),
    axis,
    index,
    value: typedValue,
    coordinate: exactNumber(object.coordinate, child(path, "coordinate")),
    label: boundedLabel(object.label, child(path, "label")),
    measurementId: digest(object.measurementId, child(path, "measurementId")),
  });
}

function geometryScale(value: unknown, path: string, axis: "x" | "y") {
  const object = closed(value, path, ["kind", "id", "ticks"]), kind = enumValue(object.kind, child(path, "kind"), ["linear", "log", "categorical", "date"] as const);
  if (axis === "y" && kind !== "linear" && kind !== "log") fail("CUT_DATA_LAYOUT_SCHEMA", child(path, "kind"), "y geometry must be linear or log");
  const tickItems = array(object.ticks, child(path, "ticks"));
  if (tickItems.length < 1 || tickItems.length > cutDataSeriesLayoutLimits.maxTicksPerAxis) fail("CUT_DATA_LAYOUT_LIMIT", child(path, "ticks"), `must contain 1..${cutDataSeriesLayoutLimits.maxTicksPerAxis} ticks`);
  const ticks = tickItems.map((item, index) => geometryTick(item, indexPath(child(path, "ticks"), index), axis, kind, index));
  const ids = new Set<string>(), measurements = new Set<string>();
  for (const tick of ticks) {
    if (ids.has(tick.id)) fail("CUT_DATA_LAYOUT_SCHEMA", child(path, "ticks"), `duplicates tick id ${tick.id}`);
    if (measurements.has(tick.measurementId)) fail("CUT_DATA_LAYOUT_SCHEMA", child(path, "ticks"), `duplicates measurement id ${tick.measurementId}`);
    ids.add(tick.id); measurements.add(tick.measurementId);
  }
  return deepFreeze({ kind, id: digest(object.id, child(path, "id")), ticks });
}

function geometryLegend(value: unknown, path: string): CutDataSeriesLayoutSpec["legend"] {
  const object = closed(value, path, ["x", "y", "maxWidth", "itemGap", "rowGap", "swatchSize", "swatchGap", "maxRows"]);
  return Object.freeze({
    x: integer(object.x, child(path, "x"), -cutDataSeriesLayoutLimits.maxAbsoluteOriginPx, cutDataSeriesLayoutLimits.maxAbsoluteOriginPx),
    y: integer(object.y, child(path, "y"), -cutDataSeriesLayoutLimits.maxAbsoluteOriginPx, cutDataSeriesLayoutLimits.maxAbsoluteOriginPx),
    maxWidth: integer(object.maxWidth, child(path, "maxWidth"), 1, cutDataSeriesLayoutLimits.maxCanvasAxisPx),
    itemGap: integer(object.itemGap, child(path, "itemGap"), 0, 1_024),
    rowGap: integer(object.rowGap, child(path, "rowGap"), 0, 1_024),
    swatchSize: integer(object.swatchSize, child(path, "swatchSize"), 1, 1_024),
    swatchGap: integer(object.swatchGap, child(path, "swatchGap"), 0, 1_024),
    maxRows: integer(object.maxRows, child(path, "maxRows"), 1, cutDataSeriesLayoutLimits.maxLegendRows),
  });
}

function validateGeometryPlanSnapshot(value: unknown): CutDataSeriesGeometryPlan {
  const path = "$.plan", object = closed(value, path, ["format", "version", "algorithm", "id", "queryResultId", "plot", "scales", "series", "marks", "measurementRequests", "tickLabelGapSubpx", "legend"]);
  if (object.format !== "cut-data-series-geometry-plan" || object.version !== 1 || object.algorithm !== cutDataSeriesLayoutAlgorithmVersion) fail("CUT_DATA_LAYOUT_TYPE", path, "must be a cut-data-series-geometry-plan v1 for the current algorithm");
  const plotObject = closed(object.plot, child(path, "plot"), ["x", "y", "width", "height"]), plot = Object.freeze({
    x: integer(plotObject.x, child(child(path, "plot"), "x"), -cutDataSeriesLayoutLimits.maxAbsoluteOriginPx, cutDataSeriesLayoutLimits.maxAbsoluteOriginPx),
    y: integer(plotObject.y, child(child(path, "plot"), "y"), -cutDataSeriesLayoutLimits.maxAbsoluteOriginPx, cutDataSeriesLayoutLimits.maxAbsoluteOriginPx),
    width: integer(plotObject.width, child(child(path, "plot"), "width"), 1, cutDataSeriesLayoutLimits.maxCanvasAxisPx),
    height: integer(plotObject.height, child(child(path, "plot"), "height"), 1, cutDataSeriesLayoutLimits.maxCanvasAxisPx),
  });
  const scalesObject = closed(object.scales, child(path, "scales"), ["x", "y"]), x = geometryScale(scalesObject.x, child(child(path, "scales"), "x"), "x"), y = geometryScale(scalesObject.y, child(child(path, "scales"), "y"), "y");
  const seriesItems = array(object.series, child(path, "series"));
  if (seriesItems.length < 1 || seriesItems.length > cutDataSeriesLayoutLimits.maxSeries) fail("CUT_DATA_LAYOUT_LIMIT", child(path, "series"), `must contain 1..${cutDataSeriesLayoutLimits.maxSeries} series`);
  const fields = new Set<string>(), names = new Set<string>(), seriesIds = new Set<string>(), seriesMeasurements = new Set<string>();
  const series = seriesItems.map((item, index) => {
    const itemPath = indexPath(child(path, "series"), index), entry = closed(item, itemPath, ["field", "name", "id", "measurementId"]);
    const field = identifier(entry.field, child(itemPath, "field")), name = boundedLabel(entry.name, child(itemPath, "name")), id = digest(entry.id, child(itemPath, "id")), measurementId = digest(entry.measurementId, child(itemPath, "measurementId"));
    if (fields.has(field) || names.has(name) || seriesIds.has(id) || seriesMeasurements.has(measurementId)) fail("CUT_DATA_LAYOUT_SCHEMA", itemPath, "series fields, names, ids, and measurement ids must be unique");
    fields.add(field); names.add(name); seriesIds.add(id); seriesMeasurements.add(measurementId);
    return Object.freeze({ field, name, id, measurementId });
  });
  const markItems = array(object.marks, child(path, "marks"));
  if (markItems.length < 1 || markItems.length > cutDataSeriesLayoutLimits.maxMarks) fail("CUT_DATA_LAYOUT_LIMIT", child(path, "marks"), `must contain 1..${cutDataSeriesLayoutLimits.maxMarks} marks`);
  const markIds = new Set<string>();
  const marks = markItems.map((item, index): CutDataSeriesMark => {
    const itemPath = indexPath(child(path, "marks"), index), entry = closed(item, itemPath, ["id", "pointIndex", "seriesField", "key", "xValue", "value", "x", "y"]), id = digest(entry.id, child(itemPath, "id"));
    if (markIds.has(id)) fail("CUT_DATA_LAYOUT_SCHEMA", child(itemPath, "id"), "duplicates a mark id");
    markIds.add(id);
    const seriesField = identifier(entry.seriesField, child(itemPath, "seriesField"));
    if (!fields.has(seriesField)) fail("CUT_DATA_LAYOUT_SCHEMA", child(itemPath, "seriesField"), "does not name a declared series");
    const keyObject = record(entry.key, child(itemPath, "key")), key: Record<string, CutTableCell> = Object.create(null) as Record<string, CutTableCell>;
    const keyNames = Object.keys(keyObject);
    if (keyNames.length < 1 || keyNames.length > cutDataSeriesLayoutLimits.maxKeyFields) fail("CUT_DATA_LAYOUT_LIMIT", child(itemPath, "key"), `must contain 1..${cutDataSeriesLayoutLimits.maxKeyFields} fields`);
    for (const name of keyNames) key[identifier(name, child(itemPath, "key"))] = planCell(keyObject[name], child(child(itemPath, "key"), name));
    const xValue = planCell(entry.xValue, child(itemPath, "xValue"));
    if (typeof xValue === "boolean") fail("CUT_DATA_LAYOUT_SCHEMA", child(itemPath, "xValue"), "Boolean is not a supported x scale value");
    return deepFreeze({
      id,
      pointIndex: integer(entry.pointIndex, child(itemPath, "pointIndex"), 0, cutDataSeriesLayoutLimits.maxPoints - 1),
      seriesField,
      key,
      xValue,
      value: exactNumber(entry.value, child(itemPath, "value")),
      x: exactNumber(entry.x, child(itemPath, "x")),
      y: exactNumber(entry.y, child(itemPath, "y")),
    });
  });
  const requestItems = array(object.measurementRequests, child(path, "measurementRequests"));
  if (requestItems.length > cutDataSeriesLayoutLimits.maxMeasurements) fail("CUT_DATA_LAYOUT_LIMIT", child(path, "measurementRequests"), `exceeds ${cutDataSeriesLayoutLimits.maxMeasurements} requests`);
  const requestIds = new Set<string>();
  const measurementRequests = requestItems.map((item, index): CutDataMeasurementRequest => {
    const itemPath = indexPath(child(path, "measurementRequests"), index), entry = closed(item, itemPath, ["id", "role", "text"]), id = digest(entry.id, child(itemPath, "id"));
    if (requestIds.has(id)) fail("CUT_DATA_LAYOUT_SCHEMA", child(itemPath, "id"), "duplicates a measurement request");
    requestIds.add(id);
    return Object.freeze({ id, role: enumValue(entry.role, child(itemPath, "role"), ["x-axis-label", "y-axis-label", "legend-label"] as const), text: boundedLabel(entry.text, child(itemPath, "text")) });
  });
  const expectedRequests = new Map<string, { role: CutDataMeasurementRequest["role"]; text: string }>();
  for (const tick of x.ticks) expectedRequests.set(tick.measurementId, { role: "x-axis-label", text: tick.label });
  for (const tick of y.ticks) expectedRequests.set(tick.measurementId, { role: "y-axis-label", text: tick.label });
  for (const item of series) expectedRequests.set(item.measurementId, { role: "legend-label", text: item.name });
  if (expectedRequests.size !== measurementRequests.length) fail("CUT_DATA_LAYOUT_SCHEMA", child(path, "measurementRequests"), "does not contain exactly one request per tick and series");
  for (const request of measurementRequests) {
    const expected = expectedRequests.get(request.id);
    if (!expected || expected.role !== request.role || expected.text !== request.text) fail("CUT_DATA_LAYOUT_SCHEMA", child(path, "measurementRequests"), `request ${request.id} does not match its owning tick or series`);
  }
  const body = deepFreeze({
    format: "cut-data-series-geometry-plan" as const,
    version: 1 as const,
    algorithm: cutDataSeriesLayoutAlgorithmVersion,
    queryResultId: digest(object.queryResultId, child(path, "queryResultId")),
    plot,
    scales: { x, y: y as CutDataSeriesGeometryPlan["scales"]["y"] },
    series,
    marks,
    measurementRequests,
    tickLabelGapSubpx: integer(object.tickLabelGapSubpx, child(path, "tickLabelGapSubpx"), 0, 8_192),
    legend: geometryLegend(object.legend, child(path, "legend")),
  });
  const id = digest(object.id, child(path, "id")), expectedId = hash(body);
  if (id !== expectedId) fail("CUT_DATA_LAYOUT_IDENTITY", child(path, "id"), `does not match canonical geometry plan identity ${expectedId}`);
  return deepFreeze({ ...body, id });
}

/**
 * Phase one: validate a typed query-series result and produce exact scale,
 * tick, mark, legend, and text-measurement intent. No font or raster backend
 * participates in this phase.
 */
export function createCutDataSeriesGeometryPlan(queryValue: unknown, specValue: unknown): CutDataSeriesGeometryPlan {
  const query = validateQuerySeries(snapshotBoundary(queryValue, "$.query"));
  const spec = layoutSpec(snapshotBoundary(specValue, "$.spec"), query.schema);
  const markCount = BigInt(query.points.length) * BigInt(spec.series.length);
  if (markCount > BigInt(cutDataSeriesLayoutLimits.maxMarks)) fail("CUT_DATA_LAYOUT_LIMIT", "$.spec.series", `would create ${markCount} marks; limit is ${cutDataSeriesLayoutLimits.maxMarks}`);
  const x = planAxis("x", spec.xScale, spec.plot, query.points), y = planAxis("y", spec.yScale, spec.plot, query.points);
  const categories = x.ticks.map((tick) => tick.value.kind === "string" ? tick.value.value : "");
  const series = spec.series.map((item) => {
    const identity = { querySchema: query.schema.values.find((field) => field.name === item.field), field: item.field, name: item.name };
    const id = hash({ format: "cut-data-series-metadata", version: 1, ...identity });
    return Object.freeze({ ...item, id, measurementId: hash({ format: "cut-data-measurement-request", version: 1, role: "legend-label", seriesId: id, text: item.name }) });
  });
  const marks = query.points.flatMap((point, pointIndex) => series.map((item): CutDataSeriesMark => {
    const value = point.values[item.field], markX = xCoordinate(point, pointIndex, spec.xScale, spec.plot, categories), markY = yCoordinate(value, pointIndex, item.field, spec.yScale, spec.plot);
    const identity = { pointIndex, seriesField: item.field, key: point.key, xValue: point.x, value, x: markX, y: markY, xScaleId: x.id, yScaleId: y.id };
    return deepFreeze({ id: hash({ format: "cut-data-series-mark", version: 1, ...identity }), pointIndex, seriesField: item.field, key: point.key, xValue: point.x, value, x: markX, y: markY });
  }));
  const measurementRequests = [
    ...x.ticks.map((tick) => Object.freeze({ id: tick.measurementId, role: "x-axis-label" as const, text: tick.label })),
    ...y.ticks.map((tick) => Object.freeze({ id: tick.measurementId, role: "y-axis-label" as const, text: tick.label })),
    ...series.map((item) => Object.freeze({ id: item.measurementId, role: "legend-label" as const, text: item.name })),
  ];
  if (measurementRequests.length > cutDataSeriesLayoutLimits.maxMeasurements) fail("CUT_DATA_LAYOUT_LIMIT", "$.spec", `requires ${measurementRequests.length} text measurements; limit is ${cutDataSeriesLayoutLimits.maxMeasurements}`);
  const body = deepFreeze({
    format: "cut-data-series-geometry-plan" as const,
    version: 1 as const,
    algorithm: cutDataSeriesLayoutAlgorithmVersion,
    queryResultId: query.id,
    plot: spec.plot,
    scales: { x, y: y as CutDataSeriesGeometryPlan["scales"]["y"] },
    series,
    marks,
    measurementRequests,
    tickLabelGapSubpx: spec.tickLabelGapSubpx,
    legend: spec.legend,
  });
  return deepFreeze({ ...body, id: hash(body) });
}

function fontIdentity(value: unknown, path: string): CutLockedFontMeasurementIdentity {
  const object = closed(value, path, ["resourceId", "sha256", "faceIndex", "shaperIdentity"]);
  return Object.freeze({
    resourceId: identifier(object.resourceId, child(path, "resourceId")),
    sha256: digest(object.sha256, child(path, "sha256")),
    faceIndex: integer(object.faceIndex, child(path, "faceIndex"), 0, 65_535),
    shaperIdentity: digest(object.shaperIdentity, child(path, "shaperIdentity")),
  });
}

function lockedTextMeasurements(value: unknown, path: string): readonly CutLockedTextMeasurement[] {
  const items = array(value, path);
  if (items.length > cutDataSeriesLayoutLimits.maxMeasurements) fail("CUT_DATA_LAYOUT_LIMIT", path, `exceeds ${cutDataSeriesLayoutLimits.maxMeasurements} measurements`);
  const seen = new Set<string>();
  return Object.freeze(items.map((item, index): CutLockedTextMeasurement => {
    const itemPath = indexPath(path, index), object = closed(item, itemPath, ["id", "widthSubpx", "heightSubpx"]), id = digest(object.id, child(itemPath, "id"));
    if (seen.has(id)) fail("CUT_DATA_LAYOUT_MEASUREMENT", child(itemPath, "id"), "duplicates a measurement request");
    seen.add(id);
    return Object.freeze({
      id,
      widthSubpx: integer(object.widthSubpx, child(itemPath, "widthSubpx"), 1, cutDataSeriesLayoutLimits.maxMeasurementSubpx),
      heightSubpx: integer(object.heightSubpx, child(itemPath, "heightSubpx"), 1, cutDataSeriesLayoutLimits.maxMeasurementSubpx),
    });
  }));
}

function validateMeasurementReceiptSnapshot(value: unknown): CutLockedTextMeasurementReceipt {
  const path = "$.receipt", object = closed(value, path, ["format", "version", "id", "planId", "unit", "font", "measurements"]);
  if (object.format !== "cut-locked-text-measurements" || object.version !== 1) fail("CUT_DATA_LAYOUT_TYPE", path, "must be a cut-locked-text-measurements v1 receipt");
  if (object.unit !== cutDataSeriesTextMeasurementUnit) fail("CUT_DATA_LAYOUT_MEASUREMENT", child(path, "unit"), `must be ${cutDataSeriesTextMeasurementUnit}`);
  const body = deepFreeze({
    format: "cut-locked-text-measurements" as const,
    version: 1 as const,
    planId: digest(object.planId, child(path, "planId")),
    unit: cutDataSeriesTextMeasurementUnit,
    font: fontIdentity(object.font, child(path, "font")),
    measurements: lockedTextMeasurements(object.measurements, child(path, "measurements")),
  });
  const id = digest(object.id, child(path, "id")), expectedId = hash(body);
  if (id !== expectedId) fail("CUT_DATA_LAYOUT_IDENTITY", child(path, "id"), `does not match canonical measurement receipt identity ${expectedId}`);
  return deepFreeze({ ...body, id });
}

/** Bind external locked-font measurements to exactly one phase-one plan. */
export function createCutLockedTextMeasurementReceipt(
  plan: CutDataSeriesGeometryPlan,
  fontValue: unknown,
  measurementsValue: unknown,
): CutLockedTextMeasurementReceipt {
  const validatedPlan = validateGeometryPlanSnapshot(snapshotBoundary(plan, "$.plan"));
  const font = fontIdentity(snapshotBoundary(fontValue, "$.font"), "$.font");
  const decoded = lockedTextMeasurements(snapshotBoundary(measurementsValue, "$.measurements"), "$.measurements");
  if (decoded.length !== validatedPlan.measurementRequests.length) fail("CUT_DATA_LAYOUT_MEASUREMENT", "$.measurements", `must contain exactly ${validatedPlan.measurementRequests.length} requested measurements`);
  const requested = new Set(validatedPlan.measurementRequests.map((item) => item.id));
  for (let index = 0; index < decoded.length; index += 1) {
    if (!requested.has(decoded[index].id)) fail("CUT_DATA_LAYOUT_MEASUREMENT", child(indexPath("$.measurements", index), "id"), "was not requested by this geometry plan");
  }
  const byId = new Map(decoded.map((item) => [item.id, item]));
  const measurements = validatedPlan.measurementRequests.map((request) => byId.get(request.id)!);
  const body = deepFreeze({
    format: "cut-locked-text-measurements" as const,
    version: 1 as const,
    planId: validatedPlan.id,
    unit: cutDataSeriesTextMeasurementUnit,
    font,
    measurements,
  });
  return deepFreeze({ ...body, id: hash(body) });
}

function intervalFor(tick: CutDataAxisTick, measurement: CutLockedTextMeasurement) {
  const center = multiplyRational(tick.coordinate, rational(64));
  const extent = rational(tick.axis === "x" ? measurement.widthSubpx : measurement.heightSubpx, 2);
  return Object.freeze({ start: subtractRational(center, extent), end: addRational(center, extent) });
}

function overlaps(left: Readonly<{ start: Rational; end: Rational }>, right: Readonly<{ start: Rational; end: Rational }>, gap: number) {
  return compareRational(addRational(left.end, rational(gap)), right.start) > 0;
}

function resolveAxis(
  ticks: readonly CutDataAxisTick[],
  measurements: ReadonlyMap<string, CutLockedTextMeasurement>,
  gap: number,
) {
  const entries = ticks.map((tick) => ({ tick, interval: intervalFor(tick, measurements.get(tick.measurementId)!) }))
    .sort((left, right) => compareRational(left.tick.coordinate, right.tick.coordinate) || left.tick.index - right.tick.index);
  const visible = new Set<string>();
  if (entries.length === 1) visible.add(entries[0].tick.id);
  else if (entries.length > 1) {
    const first = entries[0], last = entries.at(-1)!;
    if (overlaps(first.interval, last.interval, gap)) fail("CUT_DATA_LAYOUT_COLLISION", "$.measurements", `axis endpoint labels ${first.tick.id} and ${last.tick.id} cannot both fit`);
    visible.add(first.tick.id); visible.add(last.tick.id);
    let previous = first;
    for (const candidate of entries.slice(1, -1)) {
      if (!overlaps(previous.interval, candidate.interval, gap) && !overlaps(candidate.interval, last.interval, gap)) {
        visible.add(candidate.tick.id); previous = candidate;
      }
    }
  }
  const byId = new Map(entries.map((item) => [item.tick.id, item.interval]));
  return Object.freeze(ticks.map((tick) => deepFreeze({
    tickId: tick.id,
    visible: visible.has(tick.id),
    ...(visible.has(tick.id) ? {} : { reason: "collision-thinned" as const }),
    intervalSubpx: byId.get(tick.id)!,
  })));
}

function resolveLegend(plan: CutDataSeriesGeometryPlan, measurements: ReadonlyMap<string, CutLockedTextMeasurement>) {
  const originX = plan.legend.x * 64, originY = plan.legend.y * 64, maximumWidth = plan.legend.maxWidth * 64;
  const swatch = plan.legend.swatchSize * 64, swatchGap = plan.legend.swatchGap * 64, itemGap = plan.legend.itemGap * 64, rowGap = plan.legend.rowGap * 64;
  let row = 0, cursorX = 0, cursorY = 0, rowHeight = 0;
  const placements: Array<CutDataSeriesResolvedLayout["legend"][number]> = [];
  for (const item of plan.series) {
    const measurement = measurements.get(item.measurementId)!;
    const width = swatch + swatchGap + measurement.widthSubpx, height = Math.max(swatch, measurement.heightSubpx);
    if (width > maximumWidth) fail("CUT_DATA_LAYOUT_COLLISION", "$.measurements", `legend item ${item.id} is wider than the declared legend width`);
    if (cursorX > 0 && cursorX + itemGap + width > maximumWidth) {
      cursorY += rowHeight + rowGap; cursorX = 0; rowHeight = 0; row += 1;
    }
    if (row >= plan.legend.maxRows) fail("CUT_DATA_LAYOUT_COLLISION", "$.measurements", `legend needs more than ${plan.legend.maxRows} rows`);
    if (cursorX > 0) cursorX += itemGap;
    placements.push(Object.freeze({ seriesId: item.id, measurementId: item.measurementId, row, xSubpx: originX + cursorX, ySubpx: originY + cursorY, widthSubpx: width, heightSubpx: height }));
    cursorX += width;
    rowHeight = Math.max(rowHeight, height);
  }
  return Object.freeze(placements);
}

/**
 * Phase two: deterministically thin colliding axis labels and place legend
 * items from an identity-bound locked-font measurement receipt. This returns
 * layout metadata only; it does not shape text or render pixels.
 */
export function resolveCutDataSeriesLayout(
  plan: CutDataSeriesGeometryPlan,
  receipt: CutLockedTextMeasurementReceipt,
): CutDataSeriesResolvedLayout {
  const validatedPlan = validateGeometryPlanSnapshot(snapshotBoundary(plan, "$.plan"));
  const validatedReceipt = validateMeasurementReceiptSnapshot(snapshotBoundary(receipt, "$.receipt"));
  if (validatedReceipt.planId !== validatedPlan.id) fail("CUT_DATA_LAYOUT_MEASUREMENT", "$.receipt.planId", "does not bind this geometry plan");
  if (validatedReceipt.measurements.length !== validatedPlan.measurementRequests.length) fail("CUT_DATA_LAYOUT_MEASUREMENT", "$.receipt.measurements", "must contain each request exactly once");
  for (let index = 0; index < validatedPlan.measurementRequests.length; index += 1) {
    if (validatedReceipt.measurements[index].id !== validatedPlan.measurementRequests[index].id) fail("CUT_DATA_LAYOUT_MEASUREMENT", indexPath("$.receipt.measurements", index), "must use canonical geometry-plan request order");
  }
  const measurements = new Map(validatedReceipt.measurements.map((item) => [item.id, item]));
  const axes = deepFreeze({
    x: resolveAxis(validatedPlan.scales.x.ticks, measurements, validatedPlan.tickLabelGapSubpx),
    y: resolveAxis(validatedPlan.scales.y.ticks, measurements, validatedPlan.tickLabelGapSubpx),
  });
  const legend = resolveLegend(validatedPlan, measurements);
  const body = deepFreeze({
    format: "cut-data-series-resolved-layout" as const,
    version: 1 as const,
    algorithm: cutDataSeriesLayoutAlgorithmVersion,
    planId: validatedPlan.id,
    measurementReceiptId: validatedReceipt.id,
    axes,
    legend,
  });
  return deepFreeze({ ...body, id: hash(body) });
}
