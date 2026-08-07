import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";
import { hash } from "../../core/stable";
import {
  evaluateCutTableQuery,
  loadCutTableFromLockedResource,
  validateCutTableQueryPlan,
  type CutCheckedTableQueryPlan,
  type CutEvaluatedTableQuery,
  type CutLockedTableInput,
  type CutTableQueryLimits,
  type CutTableQueryPlan,
} from "../../language/table-query";
import {
  addRational,
  compareRational,
  multiplyRational,
  rational,
  subtractRational,
  type Rational,
  zeroRational,
} from "../../language/rational";
import {
  createCutDataSeriesGeometryPlan,
  createCutLockedTextMeasurementReceipt,
  resolveCutDataSeriesLayout,
  type CutDataSeriesGeometryPlan,
  type CutDataSeriesLayoutSpec,
  type CutDataSeriesResolvedLayout,
  type CutLockedTextMeasurementReceipt,
} from "./data-series-layout";
import {
  lockedFontBytesIdentity,
  lockedFontEngineIdentity,
  lockedGlyphRun,
  parseLockedOpenTypeFont,
  type LockedGlyphRun,
  type LockedOpenTypeFont,
} from "./locked-font";

export const cutSeriesChartAlgorithmVersion = "cut-retained-series-chart-v1" as const;

export const cutSeriesChartLimits = Object.freeze({
  maxMarks: 512,
  maxSources: 8,
  maxDataBytesPerSource: 4 * 1024 * 1024,
  maxTotalDataBytes: 8 * 1024 * 1024,
  maxRowsPerSource: 4_096,
  maxCellsPerSource: 65_536,
  maxResultCells: 8_192,
  maxFontBytes: 4 * 1024 * 1024,
  maxFontGlyphs: 65_536,
  maxOutlineCommands: 200_000,
  maxOutlinePathBytes: 4 * 1024 * 1024,
  maxSvgBytes: 8 * 1024 * 1024,
  maxCanvasAxisPx: 16_384,
  maxBoundaryDepth: 32,
  maxBoundaryNodes: 16_384,
});

export type CutSeriesChartErrorCode =
  | "CUT_SERIES_CHART_TYPE"
  | "CUT_SERIES_CHART_UNKNOWN_FIELD"
  | "CUT_SERIES_CHART_QUERY"
  | "CUT_SERIES_CHART_RESOURCE_STATE"
  | "CUT_SERIES_CHART_RESOURCE_INTEGRITY"
  | "CUT_SERIES_CHART_FONT"
  | "CUT_SERIES_CHART_STYLE"
  | "CUT_SERIES_CHART_REVEAL"
  | "CUT_SERIES_CHART_NOOP"
  | "CUT_SERIES_CHART_GEOMETRY"
  | "CUT_SERIES_CHART_LIMIT"
  | "CUT_SERIES_CHART_IDENTITY";

export class CutSeriesChartError extends Error {
  constructor(
    readonly code: CutSeriesChartErrorCode,
    readonly path: string,
    message: string,
  ) {
    super(`${code}: ${message} at ${path}.`);
    this.name = "CutSeriesChartError";
  }
}

export type CutSeriesChartStyle = Readonly<{
  format: "cut-series-chart-style";
  version: 1;
  kind: "bar" | "line" | "area";
  canvas: Readonly<{ width: number; height: number; background: string }>;
  text: Readonly<{
    fontSizeSubpx: number;
    trackingSubpx: number;
    axisLabelFill: string;
    legendLabelFill: string;
  }>;
  axes: Readonly<{
    stroke: string;
    strokeWidthSubpx: number;
    tickLengthSubpx: number;
    labelGapSubpx: number;
  }>;
  grid: Readonly<{ stroke: string; strokeWidthSubpx: number }>;
  showLegend: boolean;
  series: readonly Readonly<{
    field: string;
    stroke: string;
    strokeWidthSubpx: number;
    pointRadiusSubpx: number;
  }>[];
}>;

export type CutResolvedSeriesChartStyle = CutSeriesChartStyle & Readonly<{ id: string }>;

/** Structural style emitted by the public SeriesChart configuration layer. */
export type CutSeriesChartAdapterStyle = Readonly<{
  series: readonly Readonly<{ field: string; color: string }>[];
  kind: "bar" | "line" | "area";
  labelSize: number;
  axisColor: string;
  gridColor: string;
  background: string;
  strokeWidth: number;
  pointRadius: number;
  showLegend: boolean;
}>;

export type CutSeriesChartReveal = Readonly<{
  format: "cut-series-chart-reveal";
  version: 1;
  progress: Readonly<Rational>;
}>;

export type CutResolvedSeriesChartReveal = CutSeriesChartReveal & Readonly<{
  id: string;
  visibleMarks: number;
  totalMarks: number;
  clip: Readonly<{ x: Rational; y: Rational; width: Rational; height: Rational }>;
}>;

export type CutLockedSeriesChartFontBytes = Readonly<{
  kind: "locked-bytes";
  resource: Readonly<{
    id: string;
    kind: "font";
    state: "locked";
    lockVersion: 2;
    sha256: string;
    bytes: number;
    locator: string;
  }>;
  bytes: Uint8Array;
}>;

/** Trusted internal fast path for the direct result of parseLockedOpenTypeFont. */
export type CutParsedSeriesChartFont = Readonly<{
  kind: "parsed";
  resourceId: string;
  font: LockedOpenTypeFont;
}>;

export type CutSeriesChartFontInput = CutLockedSeriesChartFontBytes | CutParsedSeriesChartFont;

export type CutSeriesChartResourceIdentity = Readonly<{
  resourceId: string;
  sha256: string;
  bytes: number;
  tableId: string;
  schemaId: string;
}>;

export type CutSeriesChartFontIdentity = Readonly<{
  resourceId: string;
  sha256: string;
  bytes: number;
  locator: string;
  faceIndex: 0;
  engine: typeof lockedFontEngineIdentity;
  shaperIdentity: string;
}>;

export type CutPreparedSeriesChartOutline = Readonly<{
  requestId: string;
  text: string;
  run: Readonly<LockedGlyphRun>;
}>;

export type CutPreparedReferenceSeriesChart = Readonly<{
  format: "cut-prepared-reference-series-chart";
  version: 1;
  algorithm: typeof cutSeriesChartAlgorithmVersion;
  id: string;
  resourceIdentity: string;
  styleIdentity: string;
  contentIdentity: string;
  resources: readonly CutSeriesChartResourceIdentity[];
  checkedPlan: CutCheckedTableQueryPlan;
  queryResult: Extract<CutEvaluatedTableQuery, { kind: "series" }>;
  geometryPlan: CutDataSeriesGeometryPlan;
  measurementReceipt: CutLockedTextMeasurementReceipt;
  resolvedLayout: CutDataSeriesResolvedLayout;
  outlines: readonly CutPreparedSeriesChartOutline[];
  font: CutSeriesChartFontIdentity;
  style: CutResolvedSeriesChartStyle;
  work: Readonly<{
    marks: number;
    measurementRuns: number;
    outlineCommands: number;
    outlinePathBytes: number;
  }>;
}>;

export type PreparedReferenceSeriesChart = CutPreparedReferenceSeriesChart;

export type CutReferenceSeriesChartFrame = Readonly<{
  format: "cut-reference-series-chart-frame";
  version: 1;
  algorithm: typeof cutSeriesChartAlgorithmVersion;
  id: string;
  preparedId: string;
  reveal: CutResolvedSeriesChartReveal;
  visibleLabels: number;
  svgBytes: number;
  svg: string;
  svgSha256: string;
}>;

/** Convenience one-shot bundle retained for tests and non-animated callers. */
export type CutRetainedSeriesChart = Readonly<{
  format: "cut-retained-series-chart";
  version: 1;
  algorithm: typeof cutSeriesChartAlgorithmVersion;
  id: string;
  preparedId: string;
  resourceIdentity: string;
  styleIdentity: string;
  contentIdentity: string;
  resources: readonly CutSeriesChartResourceIdentity[];
  checkedPlan: CutCheckedTableQueryPlan;
  queryResult: Extract<CutEvaluatedTableQuery, { kind: "series" }>;
  geometryPlan: CutDataSeriesGeometryPlan;
  measurementReceipt: CutLockedTextMeasurementReceipt;
  resolvedLayout: CutDataSeriesResolvedLayout;
  outlines: readonly CutPreparedSeriesChartOutline[];
  font: CutSeriesChartFontIdentity;
  style: CutResolvedSeriesChartStyle;
  reveal: CutResolvedSeriesChartReveal;
  work: Readonly<{
    marks: number;
    measurementRuns: number;
    visibleLabels: number;
    outlineCommands: number;
    outlinePathBytes: number;
    svgBytes: number;
  }>;
  svg: string;
  svgSha256: string;
}>;

type JsonRecord = Record<string, unknown>;
type BoundaryContext = { active: WeakSet<object>; nodes: number };
type PreparedFont = Readonly<{
  resourceId: string;
  font: LockedOpenTypeFont;
}>;
type PreparedRun = CutPreparedSeriesChartOutline;

const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
const colorPattern = /^#[a-f0-9]{6}(?:[a-f0-9]{2})?$/u;
const integerPattern = /^-?(?:0|[1-9][0-9]*)$/u;
const positiveIntegerPattern = /^(?:0|[1-9][0-9]*)$/u;

function fail(code: CutSeriesChartErrorCode, path: string, message: string): never {
  throw new CutSeriesChartError(code, path, message);
}

function child(path: string, name: string) {
  return identifierPattern.test(name) ? `${path}.${name}` : `${path}[${JSON.stringify(name)}]`;
}

function indexPath(path: string, index: number) { return `${path}[${index}]`; }

function wellFormed(value: string) {
  return Array.from(value).every((character) => {
    const point = character.codePointAt(0)!;
    return point < 0xd800 || point > 0xdfff;
  });
}

function snapshotBoundary(
  value: unknown,
  path: string,
  context: BoundaryContext = { active: new WeakSet<object>(), nodes: 0 },
  depth = 0,
): unknown {
  context.nodes += 1;
  if (context.nodes > cutSeriesChartLimits.maxBoundaryNodes) fail("CUT_SERIES_CHART_LIMIT", path, `boundary graph exceeds ${cutSeriesChartLimits.maxBoundaryNodes} values`);
  if (depth > cutSeriesChartLimits.maxBoundaryDepth) fail("CUT_SERIES_CHART_LIMIT", path, `boundary graph exceeds depth ${cutSeriesChartLimits.maxBoundaryDepth}`);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (!wellFormed(value)) fail("CUT_SERIES_CHART_TYPE", path, "must contain well-formed Unicode");
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("CUT_SERIES_CHART_TYPE", path, "numbers must be finite");
    return value;
  }
  if (typeof value !== "object") fail("CUT_SERIES_CHART_TYPE", path, "must contain data values only");
  if (nodeTypes.isProxy(value)) fail("CUT_SERIES_CHART_TYPE", path, "proxies are forbidden at the closed data boundary");
  if (context.active.has(value)) fail("CUT_SERIES_CHART_TYPE", path, "cyclic aliases are forbidden at the closed data boundary");
  context.active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) fail("CUT_SERIES_CHART_TYPE", path, "must be a direct ordinary array");
      let indices = 0;
      for (const key of Reflect.ownKeys(value)) {
        if (key === "length") continue;
        if (typeof key === "symbol") fail("CUT_SERIES_CHART_TYPE", path, "symbol-keyed array properties are forbidden");
        if (!positiveIntegerPattern.test(key) || Number(key) >= value.length) fail("CUT_SERIES_CHART_TYPE", child(path, key), "array contains a non-index property");
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail("CUT_SERIES_CHART_TYPE", indexPath(path, Number(key)), "array entries must be enumerable data properties");
        indices += 1;
      }
      if (indices !== value.length) fail("CUT_SERIES_CHART_TYPE", path, "array must be dense and cannot contain holes");
      return Object.freeze(Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))! as PropertyDescriptor & { value: unknown };
        return snapshotBoundary(descriptor.value, indexPath(path, index), context, depth + 1);
      }));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail("CUT_SERIES_CHART_TYPE", path, "must be a direct ordinary object");
    const result: JsonRecord = Object.create(null) as JsonRecord;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === "symbol") fail("CUT_SERIES_CHART_TYPE", path, "symbol-keyed properties are forbidden");
      if (key === "__proto__" || key === "prototype" || key === "constructor") fail("CUT_SERIES_CHART_TYPE", child(path, key), "is an unsafe data key");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail("CUT_SERIES_CHART_TYPE", child(path, key), "properties must be enumerable data properties");
      result[key] = snapshotBoundary(descriptor.value, child(path, key), context, depth + 1);
    }
    return Object.freeze(result);
  } finally {
    context.active.delete(value);
  }
}

function directRecord(value: unknown, path: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeTypes.isProxy(value)) fail("CUT_SERIES_CHART_TYPE", path, "must be a direct ordinary object");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail("CUT_SERIES_CHART_TYPE", path, "must be a direct ordinary object");
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") fail("CUT_SERIES_CHART_TYPE", path, "symbol-keyed properties are forbidden");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail("CUT_SERIES_CHART_TYPE", child(path, key), "properties must be enumerable data properties");
  }
  return value as JsonRecord;
}

function closed(value: unknown, path: string, required: readonly string[]) {
  const object = directRecord(value, path), allowed = new Set(required);
  for (const key of Object.keys(object)) if (!allowed.has(key)) fail("CUT_SERIES_CHART_UNKNOWN_FIELD", child(path, key), "is not part of the closed contract");
  for (const key of required) if (!Object.hasOwn(object, key)) fail("CUT_SERIES_CHART_TYPE", child(path, key), "required field is missing");
  return object;
}

function directArrayValues(value: unknown, path: string) {
  if (!Array.isArray(value) || nodeTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) fail("CUT_SERIES_CHART_TYPE", path, "must be a direct ordinary array");
  let indices = 0;
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (typeof key === "symbol" || !positiveIntegerPattern.test(key) || Number(key) >= value.length) fail("CUT_SERIES_CHART_TYPE", path, "array contains an unsupported own property");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail("CUT_SERIES_CHART_TYPE", indexPath(path, Number(key)), "array entries must be enumerable data properties");
    indices += 1;
  }
  if (indices !== value.length) fail("CUT_SERIES_CHART_TYPE", path, "array must be dense and cannot contain holes");
  return Object.freeze(Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))! as PropertyDescriptor & { value: unknown };
    return descriptor.value;
  }));
}

function closedSnapshot(value: unknown, path: string, required: readonly string[]) {
  const snapshot = snapshotBoundary(value, path);
  return closed(snapshot, path, required);
}

function exactString(value: unknown, path: string) {
  if (typeof value !== "string" || !wellFormed(value)) fail("CUT_SERIES_CHART_TYPE", path, "must be a well-formed string");
  return value;
}

function identifier(value: unknown, path: string) {
  const result = exactString(value, path);
  if (!identifierPattern.test(result) || result === "__proto__" || result === "prototype" || result === "constructor") fail("CUT_SERIES_CHART_TYPE", path, "must be a safe CUT identifier");
  return result;
}

function digest(value: unknown, path: string) {
  const result = exactString(value, path);
  if (!digestPattern.test(result)) fail("CUT_SERIES_CHART_TYPE", path, "must be a lowercase SHA-256 digest");
  return result;
}

function integer(value: unknown, path: string, minimum: number, maximum: number, code: CutSeriesChartErrorCode = "CUT_SERIES_CHART_STYLE") {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || Number(value) < minimum || Number(value) > maximum) fail(code, path, `must be a safe integer from ${minimum} through ${maximum}`);
  return Number(value);
}

function color(value: unknown, path: string) {
  const result = exactString(value, path);
  if (!colorPattern.test(result)) fail("CUT_SERIES_CHART_STYLE", path, "must be a lowercase six- or eight-digit sRGB hex color");
  if (result.length === 9 && result.endsWith("00")) fail("CUT_SERIES_CHART_NOOP", path, "must not be fully transparent");
  return result;
}

function normalizedColor(value: string) { return value.length === 7 ? `${value}ff` : value; }

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
  return value;
}

function queryLimits(): Partial<CutTableQueryLimits> {
  return {
    maxInputBytes: cutSeriesChartLimits.maxDataBytesPerSource,
    maxTotalInputBytes: cutSeriesChartLimits.maxTotalDataBytes,
    maxFields: 64,
    maxRowsPerSource: cutSeriesChartLimits.maxRowsPerSource,
    maxCellsPerSource: cutSeriesChartLimits.maxCellsPerSource,
    maxSources: cutSeriesChartLimits.maxSources,
    maxJoinRows: cutSeriesChartLimits.maxRowsPerSource,
    maxGroups: cutSeriesChartLimits.maxRowsPerSource,
    maxResultRows: cutSeriesChartLimits.maxMarks,
    maxResultCells: cutSeriesChartLimits.maxResultCells,
  };
}

function prepareFont(value: unknown): PreparedFont {
  const source = closed(value, "$.font", ["kind", ...(directRecord(value, "$.font").kind === "locked-bytes" ? ["resource", "bytes"] : ["resourceId", "font"])]);
  if (source.kind === "locked-bytes") {
    const resource = closed(source.resource, "$.font.resource", ["id", "kind", "state", "lockVersion", "sha256", "bytes", "locator"]);
    const resourceId = identifier(resource.id, "$.font.resource.id");
    if (resource.kind !== "font" || resource.state !== "locked" || resource.lockVersion !== 2) fail("CUT_SERIES_CHART_RESOURCE_STATE", "$.font.resource", "requires a locked FontAsset with cut.lock v3 state");
    const sha256 = digest(resource.sha256, "$.font.resource.sha256");
    const byteLength = integer(resource.bytes, "$.font.resource.bytes", 1, cutSeriesChartLimits.maxFontBytes, "CUT_SERIES_CHART_LIMIT");
    const locator = exactString(resource.locator, "$.font.resource.locator");
    if (Buffer.byteLength(locator, "utf8") > 1_024 || !/\.(?:ttf|otf)$/iu.test(locator)) fail("CUT_SERIES_CHART_FONT", "$.font.resource.locator", "must be a bounded .ttf or .otf locator");
    const supplied = source.bytes;
    const directBytes = !nodeTypes.isProxy(supplied)
      && ((Buffer.isBuffer(supplied) && Object.getPrototypeOf(supplied) === Buffer.prototype)
        || (supplied instanceof Uint8Array && Object.getPrototypeOf(supplied) === Uint8Array.prototype));
    if (!directBytes) fail("CUT_SERIES_CHART_TYPE", "$.font.bytes", "must be a direct ordinary Uint8Array or Buffer");
    const ordinary = supplied as Uint8Array;
    if (typeof SharedArrayBuffer !== "undefined" && ordinary.buffer instanceof SharedArrayBuffer) fail("CUT_SERIES_CHART_TYPE", "$.font.bytes", "SharedArrayBuffer-backed bytes are forbidden");
    let bytes: Buffer;
    try { bytes = Buffer.from(new Uint8Array(ordinary)); }
    catch { fail("CUT_SERIES_CHART_TYPE", "$.font.bytes", "must have an attached ordinary ArrayBuffer"); }
    if (bytes.byteLength !== byteLength) fail("CUT_SERIES_CHART_RESOURCE_INTEGRITY", "$.font.bytes", `actual byte length ${bytes.byteLength} does not match locked length ${byteLength}`);
    if (lockedFontBytesIdentity(bytes) !== sha256) fail("CUT_SERIES_CHART_RESOURCE_INTEGRITY", "$.font.resource.sha256", "locked font byte digest does not match the supplied bytes");
    try {
      const font = parseLockedOpenTypeFont(bytes, locator, { maxBytes: cutSeriesChartLimits.maxFontBytes, maxGlyphs: cutSeriesChartLimits.maxFontGlyphs });
      if (font.sha256 !== sha256 || font.byteLength !== byteLength) fail("CUT_SERIES_CHART_IDENTITY", "$.font", "parsed font identity does not match its locked resource");
      return Object.freeze({ resourceId, font });
    } catch (error) {
      if (error instanceof CutSeriesChartError) throw error;
      fail("CUT_SERIES_CHART_FONT", "$.font.bytes", error instanceof Error ? error.message : String(error));
    }
  }
  if (source.kind !== "parsed") fail("CUT_SERIES_CHART_TYPE", "$.font.kind", "must be locked-bytes or parsed");
  const resourceId = identifier(source.resourceId, "$.font.resourceId"), valueFont = source.font;
  if (!valueFont || typeof valueFont !== "object" || nodeTypes.isProxy(valueFont)) fail("CUT_SERIES_CHART_FONT", "$.font.font", "must be a direct parsed locked font");
  const font = valueFont as LockedOpenTypeFont;
  if (font.engine !== lockedFontEngineIdentity || !digestPattern.test(font.sha256)
    || !Number.isSafeInteger(font.byteLength) || font.byteLength < 1 || font.byteLength > cutSeriesChartLimits.maxFontBytes
    || typeof font.locator !== "string" || !/\.(?:ttf|otf)$/iu.test(font.locator)
    || !font.font || typeof font.font !== "object") {
    fail("CUT_SERIES_CHART_FONT", "$.font.font", "must be the bounded fixed-engine result of parseLockedOpenTypeFont");
  }
  return Object.freeze({ resourceId, font });
}

function prepareStyle(value: unknown, plan: CutDataSeriesGeometryPlan): CutResolvedSeriesChartStyle {
  const root = closedSnapshot(value, "$.style", ["format", "version", "kind", "canvas", "text", "axes", "grid", "showLegend", "series"]);
  if (root.format !== "cut-series-chart-style" || root.version !== 1) fail("CUT_SERIES_CHART_STYLE", "$.style", "must be cut-series-chart-style v1");
  if (root.kind !== "bar" && root.kind !== "line" && root.kind !== "area") fail("CUT_SERIES_CHART_STYLE", "$.style.kind", "must be bar, line, or area");
  const kind = root.kind;
  const canvasValue = closed(root.canvas, "$.style.canvas", ["width", "height", "background"]);
  const canvas = Object.freeze({
    width: integer(canvasValue.width, "$.style.canvas.width", 1, cutSeriesChartLimits.maxCanvasAxisPx),
    height: integer(canvasValue.height, "$.style.canvas.height", 1, cutSeriesChartLimits.maxCanvasAxisPx),
    background: color(canvasValue.background, "$.style.canvas.background"),
  });
  const textValue = closed(root.text, "$.style.text", ["fontSizeSubpx", "trackingSubpx", "axisLabelFill", "legendLabelFill"]);
  const text = Object.freeze({
    fontSizeSubpx: integer(textValue.fontSizeSubpx, "$.style.text.fontSizeSubpx", 64, 32_768),
    trackingSubpx: integer(textValue.trackingSubpx, "$.style.text.trackingSubpx", 0, 4_096),
    axisLabelFill: color(textValue.axisLabelFill, "$.style.text.axisLabelFill"),
    legendLabelFill: color(textValue.legendLabelFill, "$.style.text.legendLabelFill"),
  });
  const axesValue = closed(root.axes, "$.style.axes", ["stroke", "strokeWidthSubpx", "tickLengthSubpx", "labelGapSubpx"]);
  const axes = Object.freeze({
    stroke: color(axesValue.stroke, "$.style.axes.stroke"),
    strokeWidthSubpx: integer(axesValue.strokeWidthSubpx, "$.style.axes.strokeWidthSubpx", 1, 4_096),
    tickLengthSubpx: integer(axesValue.tickLengthSubpx, "$.style.axes.tickLengthSubpx", 1, 4_096),
    labelGapSubpx: integer(axesValue.labelGapSubpx, "$.style.axes.labelGapSubpx", 0, 4_096),
  });
  const gridValue = closed(root.grid, "$.style.grid", ["stroke", "strokeWidthSubpx"]);
  const grid = Object.freeze({
    stroke: color(gridValue.stroke, "$.style.grid.stroke"),
    strokeWidthSubpx: integer(gridValue.strokeWidthSubpx, "$.style.grid.strokeWidthSubpx", 1, 4_096),
  });
  if (typeof root.showLegend !== "boolean") fail("CUT_SERIES_CHART_STYLE", "$.style.showLegend", "must be Boolean");
  const showLegend = root.showLegend;
  if (!Array.isArray(root.series)) fail("CUT_SERIES_CHART_STYLE", "$.style.series", "must be an array");
  if (root.series.length !== plan.series.length) fail("CUT_SERIES_CHART_STYLE", "$.style.series", `must contain exactly ${plan.series.length} entries in geometry-plan order`);
  const series = Object.freeze(root.series.map((item, index) => {
    const path = indexPath("$.style.series", index), entry = closed(item, path, ["field", "stroke", "strokeWidthSubpx", "pointRadiusSubpx"]);
    const field = identifier(entry.field, child(path, "field"));
    if (field !== plan.series[index].field) fail("CUT_SERIES_CHART_STYLE", child(path, "field"), `must be ${JSON.stringify(plan.series[index].field)} to match geometry-plan order`);
    return Object.freeze({
      field,
      stroke: color(entry.stroke, child(path, "stroke")),
      strokeWidthSubpx: integer(entry.strokeWidthSubpx, child(path, "strokeWidthSubpx"), 1, 4_096),
      pointRadiusSubpx: integer(entry.pointRadiusSubpx, child(path, "pointRadiusSubpx"), 1, 4_096),
    });
  }));
  const background = normalizedColor(canvas.background);
  if (normalizedColor(axes.stroke) === background || normalizedColor(grid.stroke) === background || normalizedColor(text.axisLabelFill) === background
    || (showLegend && normalizedColor(text.legendLabelFill) === background)) {
    fail("CUT_SERIES_CHART_NOOP", "$.style", "axes, grid, and rendered locked-outline labels must contrast with the canvas background");
  }
  if (!showLegend && normalizedColor(text.legendLabelFill) !== normalizedColor(text.axisLabelFill)) fail("CUT_SERIES_CHART_NOOP", "$.style.text.legendLabelFill", "must equal axisLabelFill when the legend is disabled so it cannot carry ignored style state");
  const invisibleSeries = series.findIndex((item) => normalizedColor(item.stroke) === background);
  if (invisibleSeries >= 0) fail("CUT_SERIES_CHART_NOOP", indexPath("$.style.series", invisibleSeries), "series stroke and points must contrast with the canvas background");
  const body: CutSeriesChartStyle = deepFreeze({ format: "cut-series-chart-style", version: 1, kind, canvas, text, axes, grid, showLegend, series });
  return deepFreeze({ ...body, id: hash({ format: "cut-series-chart-style-identity", version: 1, style: body }) });
}

/** Convert the checked public configuration style into the core's exact,
 * closed subpixel style without importing compiler or IR modules here. */
export function cutSeriesChartStyleFromAdapter(
  styleValue: CutSeriesChartAdapterStyle | unknown,
  canvasValue: Readonly<{ width: number; height: number }> | unknown,
): CutSeriesChartStyle {
  const source = closedSnapshot(styleValue, "$.adapterStyle", ["series", "kind", "labelSize", "axisColor", "gridColor", "background", "strokeWidth", "pointRadius", "showLegend"]);
  const canvas = closedSnapshot(canvasValue, "$.canvas", ["width", "height"]);
  if (source.kind !== "bar" && source.kind !== "line" && source.kind !== "area") fail("CUT_SERIES_CHART_STYLE", "$.adapterStyle.kind", "must be bar, line, or area");
  if (typeof source.showLegend !== "boolean") fail("CUT_SERIES_CHART_STYLE", "$.adapterStyle.showLegend", "must be Boolean");
  const labelSize = integer(source.labelSize, "$.adapterStyle.labelSize", 6, 256), strokeWidth = integer(source.strokeWidth, "$.adapterStyle.strokeWidth", 1, 128), pointRadius = integer(source.pointRadius, "$.adapterStyle.pointRadius", 1, 128);
  const width = integer(canvas.width, "$.canvas.width", 1, cutSeriesChartLimits.maxCanvasAxisPx), height = integer(canvas.height, "$.canvas.height", 1, cutSeriesChartLimits.maxCanvasAxisPx);
  if (!Array.isArray(source.series) || source.series.length < 1 || source.series.length > 64) fail("CUT_SERIES_CHART_STYLE", "$.adapterStyle.series", "must contain 1 through 64 entries");
  const series = Object.freeze(source.series.map((item, index) => {
    const path = indexPath("$.adapterStyle.series", index), entry = closed(item, path, ["field", "color"]);
    return Object.freeze({ field: identifier(entry.field, child(path, "field")), stroke: color(entry.color, child(path, "color")), strokeWidthSubpx: strokeWidth * 64, pointRadiusSubpx: pointRadius * 64 });
  }));
  const axisColor = color(source.axisColor, "$.adapterStyle.axisColor");
  return deepFreeze({
    format: "cut-series-chart-style",
    version: 1,
    kind: source.kind,
    canvas: { width, height, background: color(source.background, "$.adapterStyle.background") },
    text: { fontSizeSubpx: labelSize * 64, trackingSubpx: 0, axisLabelFill: axisColor, legendLabelFill: axisColor },
    axes: { stroke: axisColor, strokeWidthSubpx: 64, tickLengthSubpx: 4 * 64, labelGapSubpx: 3 * 64 },
    grid: { stroke: color(source.gridColor, "$.adapterStyle.gridColor"), strokeWidthSubpx: 64 },
    showLegend: source.showLegend,
    series,
  });
}

function prepareReveal(value: unknown) {
  const root = closedSnapshot(value, "$.reveal", ["format", "version", "progress"]);
  if (root.format !== "cut-series-chart-reveal" || root.version !== 1) fail("CUT_SERIES_CHART_REVEAL", "$.reveal", "must be cut-series-chart-reveal v1");
  const progressValue = closed(root.progress, "$.reveal.progress", ["numerator", "denominator"]);
  const numerator = exactString(progressValue.numerator, "$.reveal.progress.numerator"), denominator = exactString(progressValue.denominator, "$.reveal.progress.denominator");
  if (!integerPattern.test(numerator) || !positiveIntegerPattern.test(denominator) || denominator === "0") fail("CUT_SERIES_CHART_REVEAL", "$.reveal.progress", "must be a canonical exact rational");
  if ((numerator.startsWith("-") ? numerator.length - 1 : numerator.length) > 128 || denominator.length > 128) fail("CUT_SERIES_CHART_LIMIT", "$.reveal.progress", "exact reveal exceeds the 128-digit rational budget");
  const progress = rational(numerator, denominator);
  if (progress.numerator !== numerator || progress.denominator !== denominator) fail("CUT_SERIES_CHART_REVEAL", "$.reveal.progress", "must be reduced with a positive denominator and canonical integers");
  if (compareRational(progress, zeroRational) < 0 || compareRational(progress, rational(1)) > 0) fail("CUT_SERIES_CHART_REVEAL", "$.reveal.progress", "must lie in the closed interval 0 through 1");
  const body: CutSeriesChartReveal = deepFreeze({ format: "cut-series-chart-reveal", version: 1, progress });
  return deepFreeze({ ...body, id: hash({ format: "cut-series-chart-reveal-identity", version: 1, reveal: body }) });
}

function prepareRuns(plan: CutDataSeriesGeometryPlan, preparedFont: PreparedFont, style: CutResolvedSeriesChartStyle) {
  const fontSize = style.text.fontSizeSubpx / 64, tracking = style.text.trackingSubpx / 64;
  let commands = 0, pathBytes = 0;
  const runs: PreparedRun[] = [];
  for (const request of plan.measurementRequests) {
    const remainingCommands = cutSeriesChartLimits.maxOutlineCommands - commands;
    const remainingBytes = cutSeriesChartLimits.maxOutlinePathBytes - pathBytes;
    if (remainingCommands < 1 || remainingBytes < 1) fail("CUT_SERIES_CHART_LIMIT", "$.layout.measurementRequests", "locked label outlines exhaust the aggregate budget");
    let run: LockedGlyphRun;
    try {
      run = lockedGlyphRun(preparedFont.font, request.text, fontSize, { maxCommands: remainingCommands, maxPathBytes: remainingBytes }, tracking);
    } catch (error) {
      fail("CUT_SERIES_CHART_FONT", child("$.layout.measurementRequests", request.id), error instanceof Error ? error.message : String(error));
    }
    commands += run.commands;
    pathBytes += run.pathBytes;
    runs.push(Object.freeze({ requestId: request.id, text: request.text, run: Object.freeze(run) }));
  }
  return Object.freeze({ runs: Object.freeze(runs), commands, pathBytes });
}

function halfEvenFixed(value: Rational, places = 6) {
  const negative = value.numerator.startsWith("-") && value.numerator !== "0", numerator = BigInt(value.numerator), denominator = BigInt(value.denominator);
  const scale = 10n ** BigInt(places), absolute = numerator < 0n ? -numerator : numerator;
  let quotient = absolute * scale / denominator;
  const remainder = absolute * scale % denominator, doubled = remainder * 2n;
  if (doubled > denominator || (doubled === denominator && quotient % 2n === 1n)) quotient += 1n;
  const digits = quotient.toString().padStart(places + 1, "0"), integer = digits.slice(0, -places) || "0";
  const fraction = digits.slice(-places).replace(/0+$/u, "");
  const result = fraction ? `${integer}.${fraction}` : integer;
  return negative && result !== "0" ? `-${result}` : result;
}

function finite(value: number) {
  if (!Number.isFinite(value)) fail("CUT_SERIES_CHART_GEOMETRY", "$", "font layout produced a non-finite SVG coordinate");
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

function subpx(value: number) { return halfEvenFixed(rational(value, 64)); }

function ensureBounds(left: number, top: number, right: number, bottom: number, style: CutResolvedSeriesChartStyle, path: string) {
  if (![left, top, right, bottom].every(Number.isFinite) || left < -1e-7 || top < -1e-7 || right > style.canvas.width + 1e-7 || bottom > style.canvas.height + 1e-7) {
    fail("CUT_SERIES_CHART_GEOMETRY", path, "locked outline or mark lies outside the declared canvas");
  }
}

function renderSvg(
  plan: CutDataSeriesGeometryPlan,
  resolved: CutDataSeriesResolvedLayout,
  runItems: readonly PreparedRun[],
  style: CutResolvedSeriesChartStyle,
  reveal: ReturnType<typeof prepareReveal>,
) {
  const runs = new Map(runItems.map((item) => [item.requestId, item.run]));
  const plotRight = plan.plot.x + plan.plot.width, plotBottom = plan.plot.y + plan.plot.height;
  const maximumMarkPaddingSubpx = style.series.reduce((maximum, item) => Math.max(maximum, item.pointRadiusSubpx, Math.ceil(item.strokeWidthSubpx / 2)), 0) + 64;
  const padding = rational(maximumMarkPaddingSubpx, 64);
  const clip = deepFreeze({
    x: rational(plan.plot.x * 64 - maximumMarkPaddingSubpx, 64),
    y: rational(plan.plot.y * 64 - maximumMarkPaddingSubpx, 64),
    width: multiplyRational(rational(plan.plot.width * 64 + maximumMarkPaddingSubpx * 2, 64), reveal.progress),
    height: rational(plan.plot.height * 64 + maximumMarkPaddingSubpx * 2, 64),
  });
  const clipEnd = rational(
    BigInt(clip.x.numerator) * BigInt(clip.width.denominator) + BigInt(clip.width.numerator) * BigInt(clip.x.denominator),
    BigInt(clip.x.denominator) * BigInt(clip.width.denominator),
  );
  const visibleMarks = compareRational(reveal.progress, zeroRational) === 0 ? 0 : plan.marks.filter((mark) => compareRational(mark.x, clipEnd) <= 0).length;
  ensureBounds(plan.plot.x - Number(padding.numerator) / Number(padding.denominator), plan.plot.y - Number(padding.numerator) / Number(padding.denominator), plotRight + Number(padding.numerator) / Number(padding.denominator), plotBottom + Number(padding.numerator) / Number(padding.denominator), style, "$.layout.plot");

  const axisStrokeWidth = subpx(style.axes.strokeWidthSubpx), tickLength = rational(style.axes.tickLengthSubpx, 64);
  const gridStrokeWidth = subpx(style.grid.strokeWidthSubpx);
  const grid = `<path d="${[
    ...plan.scales.x.ticks.map((tick) => `M${halfEvenFixed(tick.coordinate)},${plan.plot.y}V${plotBottom}`),
    ...plan.scales.y.ticks.map((tick) => `M${plan.plot.x},${halfEvenFixed(tick.coordinate)}H${plotRight}`),
  ].join("")}" fill="none" stroke="${style.grid.stroke}" stroke-width="${gridStrokeWidth}"/>`;
  const xAxis = `<path d="M${plan.plot.x},${plotBottom}H${plotRight}" fill="none" stroke="${style.axes.stroke}" stroke-width="${axisStrokeWidth}"/>`;
  const yAxis = `<path d="M${plan.plot.x},${plan.plot.y}V${plotBottom}" fill="none" stroke="${style.axes.stroke}" stroke-width="${axisStrokeWidth}"/>`;
  const xTicks = plan.scales.x.ticks.map((tick) => `<path d="M${halfEvenFixed(tick.coordinate)},${plotBottom}V${halfEvenFixed(rational(BigInt(plotBottom) * 64n + BigInt(style.axes.tickLengthSubpx), 64))}" fill="none" stroke="${style.axes.stroke}" stroke-width="${axisStrokeWidth}"/>`).join("");
  const yTicks = plan.scales.y.ticks.map((tick) => `<path d="M${halfEvenFixed(rational(BigInt(plan.plot.x) * 64n - BigInt(style.axes.tickLengthSubpx), 64))},${halfEvenFixed(tick.coordinate)}H${plan.plot.x}" fill="none" stroke="${style.axes.stroke}" stroke-width="${axisStrokeWidth}"/>`).join("");

  let visibleLabels = 0;
  const xVisibility = new Map(resolved.axes.x.map((item) => [item.tickId, item.visible]));
  const xLabels = plan.scales.x.ticks.flatMap((tick) => {
    if (!xVisibility.get(tick.id)) return [];
    const run = runs.get(tick.measurementId)!;
    const center = Number(halfEvenFixed(tick.coordinate));
    const x = center - (run.x1 + run.x2) / 2;
    const top = plotBottom + Number(tickLength.numerator) / Number(tickLength.denominator) + style.axes.labelGapSubpx / 64;
    const baseline = top - run.y1;
    ensureBounds(x + run.x1, baseline + run.y1, x + run.x2, baseline + run.y2, style, child("$.layout.xLabels", tick.id));
    visibleLabels += 1;
    return [`<path d="${run.pathData}" fill="${style.text.axisLabelFill}" transform="translate(${finite(x)} ${finite(baseline)})"/>`];
  }).join("");
  const yVisibility = new Map(resolved.axes.y.map((item) => [item.tickId, item.visible]));
  const yLabels = plan.scales.y.ticks.flatMap((tick) => {
    if (!yVisibility.get(tick.id)) return [];
    const run = runs.get(tick.measurementId)!;
    const center = Number(halfEvenFixed(tick.coordinate));
    const x = plan.plot.x - style.axes.tickLengthSubpx / 64 - style.axes.labelGapSubpx / 64 - run.x2;
    const baseline = center - (run.y1 + run.y2) / 2;
    ensureBounds(x + run.x1, baseline + run.y1, x + run.x2, baseline + run.y2, style, child("$.layout.yLabels", tick.id));
    visibleLabels += 1;
    return [`<path d="${run.pathData}" fill="${style.text.axisLabelFill}" transform="translate(${finite(x)} ${finite(baseline)})"/>`];
  }).join("");

  const styleByField = new Map(style.series.map((item) => [item.field, item]));
  if (style.kind === "bar" && plan.marks.every((mark) => compareRational(mark.y, rational(plotBottom)) === 0)) fail("CUT_SERIES_CHART_NOOP", "$.layout.marks", "bar values all map to a zero-height baseline");
  const distinctXCount = new Set(plan.marks.map((mark) => `${mark.x.numerator}/${mark.x.denominator}`)).size;
  const barWidth = rational(BigInt(plan.plot.width) * 4n, BigInt(distinctXCount * plan.series.length * 5));
  const groupWidth = multiplyRational(barWidth, rational(plan.series.length));
  const marks = plan.series.map((series, seriesIndex) => {
    const seriesStyle = styleByField.get(series.field)!, points = plan.marks.filter((mark) => mark.seriesField === series.field);
    if (style.kind === "bar") {
      if (compareRational(rational(seriesStyle.pointRadiusSubpx, 64), multiplyRational(barWidth, rational(1, 2))) > 0) fail("CUT_SERIES_CHART_STYLE", child("$.style.series", series.field), "bar pointRadius must not exceed half the computed bar width");
      return points.map((mark) => {
        const rawStart = subtractRational(mark.x, multiplyRational(groupWidth, rational(1, 2))), minimumStart = rational(plan.plot.x), maximumStart = subtractRational(rational(plotRight), groupWidth);
        const groupStart = compareRational(rawStart, minimumStart) < 0 ? minimumStart : compareRational(rawStart, maximumStart) > 0 ? maximumStart : rawStart;
        const x = addRational(groupStart, multiplyRational(barWidth, rational(seriesIndex)));
        const height = subtractRational(rational(plotBottom), mark.y);
        return `<rect x="${halfEvenFixed(x)}" y="${halfEvenFixed(mark.y)}" width="${halfEvenFixed(barWidth)}" height="${halfEvenFixed(height)}" rx="${subpx(seriesStyle.pointRadiusSubpx)}" fill="${seriesStyle.stroke}" stroke="${seriesStyle.stroke}" stroke-width="${subpx(seriesStyle.strokeWidthSubpx)}"/>`;
      }).join("");
    }
    const path = points.map((mark, index) => `${index ? "L" : "M"}${halfEvenFixed(mark.x)},${halfEvenFixed(mark.y)}`).join("");
    const area = style.kind === "area" ? `<path d="${path}L${halfEvenFixed(points.at(-1)!.x)},${plotBottom}L${halfEvenFixed(points[0].x)},${plotBottom}Z" fill="${seriesStyle.stroke}" fill-opacity="0.25"/>` : "";
    const line = `<path d="${path}" fill="none" stroke="${seriesStyle.stroke}" stroke-width="${subpx(seriesStyle.strokeWidthSubpx)}" stroke-linecap="round" stroke-linejoin="round"/>`;
    const circles = points.map((mark) => `<circle cx="${halfEvenFixed(mark.x)}" cy="${halfEvenFixed(mark.y)}" r="${subpx(seriesStyle.pointRadiusSubpx)}" fill="${seriesStyle.stroke}"/>`).join("");
    return `${area}${line}${circles}`;
  }).join("");

  const seriesById = new Map(plan.series.map((item) => [item.id, item]));
  const legend = style.showLegend ? resolved.legend.map((placement) => {
    const series = seriesById.get(placement.seriesId)!, seriesStyle = styleByField.get(series.field)!, run = runs.get(placement.measurementId)!;
    const x = placement.xSubpx / 64, y = placement.ySubpx / 64, height = placement.heightSubpx / 64;
    const swatch = plan.legend.swatchSize, labelX = x + swatch + plan.legend.swatchGap - run.x1;
    const baseline = y + height / 2 - (run.y1 + run.y2) / 2;
    ensureBounds(x, y, x + placement.widthSubpx / 64, y + height, style, child("$.layout.legend", series.field));
    ensureBounds(labelX + run.x1, baseline + run.y1, labelX + run.x2, baseline + run.y2, style, child("$.layout.legend", series.field));
    visibleLabels += 1;
    const swatchY = y + height / 2;
    return `<path d="M${finite(x)},${finite(swatchY)}H${finite(x + swatch)}" fill="none" stroke="${seriesStyle.stroke}" stroke-width="${subpx(seriesStyle.strokeWidthSubpx)}" stroke-linecap="round"/><path d="${run.pathData}" fill="${style.text.legendLabelFill}" transform="translate(${finite(labelX)} ${finite(baseline)})"/>`;
  }).join("") : "";
  const clipId = `cut-series-chart-reveal-${hash({ planId: plan.id, styleId: style.id, revealId: reveal.id }).slice(0, 16)}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${style.canvas.width}" height="${style.canvas.height}" viewBox="0 0 ${style.canvas.width} ${style.canvas.height}"><defs><clipPath id="${clipId}"><rect x="${halfEvenFixed(clip.x)}" y="${halfEvenFixed(clip.y)}" width="${halfEvenFixed(clip.width)}" height="${halfEvenFixed(clip.height)}"/></clipPath></defs><rect x="${plan.plot.x}" y="${plan.plot.y}" width="${plan.plot.width}" height="${plan.plot.height}" fill="${style.canvas.background}"/>${grid}${xAxis}${yAxis}${xTicks}${yTicks}<g clip-path="url(#${clipId})">${marks}</g>${xLabels}${yLabels}${legend}</svg>`;
  return Object.freeze({ svg, clip, visibleMarks, visibleLabels });
}

function checkedQueryPlan(planValue: unknown, limits: Partial<CutTableQueryLimits>) {
  const snapshot = snapshotBoundary(planValue, "$.plan"), root = directRecord(snapshot, "$.plan");
  if (root.format !== "cut-checked-query-plan") return validateCutTableQueryPlan(snapshot, { limits });
  const checked = closed(root, "$.plan", ["format", "version", "id", "plan", "output"]);
  if (checked.version !== 1) fail("CUT_SERIES_CHART_QUERY", "$.plan.version", "must be checked query plan v1");
  const rechecked = validateCutTableQueryPlan(checked.plan, { limits });
  if (checked.id !== rechecked.id || hash(checked.output) !== hash(rechecked.output)) fail("CUT_SERIES_CHART_IDENTITY", "$.plan", "checked query plan identity or proved output is stale");
  return rechecked;
}

/**
 * Perform all static work once: locked table loading, checked query execution,
 * exact geometry, fixed-font shaping, measurement, collision, and identity.
 * Reveal is intentionally absent so animation frames never reshape labels.
 */
export function prepareReferenceSeriesChart(
  planValue: CutTableQueryPlan | CutCheckedTableQueryPlan | unknown,
  resourcesValue: readonly CutLockedTableInput[] | unknown,
  layoutValue: CutDataSeriesLayoutSpec | unknown,
  fontValue: CutSeriesChartFontInput | unknown,
  styleValue: CutSeriesChartStyle | unknown,
): CutPreparedReferenceSeriesChart {
  const resourceInputs = directArrayValues(resourcesValue, "$.resources");
  if (resourceInputs.length < 1 || resourceInputs.length > cutSeriesChartLimits.maxSources) fail("CUT_SERIES_CHART_LIMIT", "$.resources", `must contain 1..${cutSeriesChartLimits.maxSources} locked inputs`);
  const limits = queryLimits();
  const loaded = resourceInputs.map((input) => loadCutTableFromLockedResource(input, { limits }));
  const totalBytes = loaded.reduce((sum, table) => sum + table.resource.bytes, 0);
  if (totalBytes > cutSeriesChartLimits.maxTotalDataBytes) fail("CUT_SERIES_CHART_LIMIT", "$.resources", `locked table bytes exceed ${cutSeriesChartLimits.maxTotalDataBytes}`);
  const checkedPlan = checkedQueryPlan(planValue, limits);
  if (checkedPlan.output.kind !== "series") fail("CUT_SERIES_CHART_QUERY", "$.plan.result", "must be a checked terminal series query");
  const evaluated = evaluateCutTableQuery(checkedPlan.plan, resourceInputs, { limits });
  if (evaluated.kind !== "series" || evaluated.planId !== checkedPlan.id) fail("CUT_SERIES_CHART_IDENTITY", "$.query", "evaluated series does not bind the checked plan identity");
  const geometryPlan = createCutDataSeriesGeometryPlan(evaluated, layoutValue);
  if (geometryPlan.marks.length < 1) fail("CUT_SERIES_CHART_NOOP", "$.layout.marks", "chart execution must produce at least one mark");
  if (geometryPlan.marks.length > cutSeriesChartLimits.maxMarks) fail("CUT_SERIES_CHART_LIMIT", "$.layout.marks", `chart would produce ${geometryPlan.marks.length} marks; limit is ${cutSeriesChartLimits.maxMarks}`);
  const style = prepareStyle(styleValue, geometryPlan), preparedFont = prepareFont(fontValue);
  const shaperIdentity = hash({
    format: "cut-series-chart-shaper-identity",
    version: 1,
    engine: lockedFontEngineIdentity,
    fontSha256: preparedFont.font.sha256,
    faceIndex: 0,
    fontSizeSubpx: style.text.fontSizeSubpx,
    trackingSubpx: style.text.trackingSubpx,
    measurement: "locked-outline-logical-bounds-ceil-subpixel-v1",
    pathPrecision: 4,
  });
  const preparedRuns = prepareRuns(geometryPlan, preparedFont, style);
  const measurements = preparedRuns.runs.map((item) => Object.freeze({
    id: item.requestId,
    widthSubpx: Math.max(1, Math.ceil(item.run.width * 64)),
    heightSubpx: Math.max(1, Math.ceil((item.run.y2 - item.run.y1) * 64)),
  }));
  const fontIdentity = deepFreeze({
    resourceId: preparedFont.resourceId,
    sha256: preparedFont.font.sha256,
    bytes: preparedFont.font.byteLength,
    locator: preparedFont.font.locator,
    faceIndex: 0 as const,
    engine: lockedFontEngineIdentity,
    shaperIdentity,
  });
  const measurementReceipt = createCutLockedTextMeasurementReceipt(geometryPlan, {
    resourceId: fontIdentity.resourceId,
    sha256: fontIdentity.sha256,
    faceIndex: fontIdentity.faceIndex,
    shaperIdentity,
  }, measurements);
  const resolvedLayout = resolveCutDataSeriesLayout(geometryPlan, measurementReceipt);
  const loadedByResource = new Map(loaded.map((table) => [table.resource.id, table]));
  const resources = Object.freeze([...new Set(checkedPlan.plan.sources.map((source) => source.resourceId))].map((resourceId) => {
    const table = loadedByResource.get(resourceId);
    if (!table) fail("CUT_SERIES_CHART_IDENTITY", "$.resources", `loaded identity is missing for ${resourceId}`);
    return Object.freeze({ resourceId, sha256: table.resource.sha256, bytes: table.resource.bytes, tableId: table.id, schemaId: table.schemaId });
  }));
  for (const source of evaluated.sources) {
    const resourceId = checkedPlan.plan.sources.find((candidate) => candidate.name === source.name)!.resourceId;
    if (loadedByResource.get(resourceId)?.id !== source.tableId) fail("CUT_SERIES_CHART_IDENTITY", "$.query.sources", "query source identity differs from the explicitly loaded locked table");
  }
  const work = deepFreeze({
    marks: geometryPlan.marks.length,
    measurementRuns: preparedRuns.runs.length,
    outlineCommands: preparedRuns.commands,
    outlinePathBytes: preparedRuns.pathBytes,
  });
  // Prove every reveal-independent geometry/style branch once. Frame calls do
  // no parsing, querying, shaping, measuring, or collision work.
  const validationReveal = prepareReveal({ format: "cut-series-chart-reveal", version: 1, progress: rational(1) });
  const validationSvg = renderSvg(geometryPlan, resolvedLayout, preparedRuns.runs, style, validationReveal).svg;
  const validationSvgBytes = Buffer.byteLength(validationSvg, "utf8");
  if (validationSvgBytes > cutSeriesChartLimits.maxSvgBytes) fail("CUT_SERIES_CHART_LIMIT", "$.svg", `SVG is ${validationSvgBytes} bytes; limit is ${cutSeriesChartLimits.maxSvgBytes}`);
  const resourceIdentity = hash({ format: "cut-series-chart-resource-identity", version: 1, resources, font: { resourceId: fontIdentity.resourceId, sha256: fontIdentity.sha256, bytes: fontIdentity.bytes, locator: fontIdentity.locator, faceIndex: 0, engine: fontIdentity.engine } });
  const contentIdentity = hash({
    format: "cut-series-chart-content-identity",
    version: 1,
    checkedPlanId: checkedPlan.id,
    queryResultId: evaluated.id,
    geometryPlanId: geometryPlan.id,
    measurementReceiptId: measurementReceipt.id,
    resolvedLayoutId: resolvedLayout.id,
    outlineIdentity: hash(preparedRuns.runs),
    fontSha256: fontIdentity.sha256,
    shaperIdentity,
  });
  const styleIdentity = style.id;
  const identity = deepFreeze({
    format: "cut-prepared-reference-series-chart-identity",
    version: 1,
    algorithm: cutSeriesChartAlgorithmVersion,
    resourceIdentity,
    styleIdentity,
    contentIdentity,
    work,
  });
  return deepFreeze({
    format: "cut-prepared-reference-series-chart",
    version: 1,
    algorithm: cutSeriesChartAlgorithmVersion,
    id: hash(identity),
    resourceIdentity,
    styleIdentity,
    contentIdentity,
    resources,
    checkedPlan,
    queryResult: evaluated,
    geometryPlan,
    measurementReceipt,
    resolvedLayout,
    outlines: preparedRuns.runs,
    font: fontIdentity,
    style,
    work,
  });
}

/** Prepare alias following the CUT-prefixed naming used by lower layers. */
export const prepareCutRetainedSeriesChart = prepareReferenceSeriesChart;

function assertPreparedIdentity(prepared: CutPreparedReferenceSeriesChart) {
  if (!prepared || typeof prepared !== "object" || prepared.format !== "cut-prepared-reference-series-chart" || prepared.version !== 1 || prepared.algorithm !== cutSeriesChartAlgorithmVersion || !Object.isFrozen(prepared)) fail("CUT_SERIES_CHART_IDENTITY", "$.prepared", "must be the immutable output of prepareReferenceSeriesChart");
  const expectedResourceIdentity = hash({
    format: "cut-series-chart-resource-identity",
    version: 1,
    resources: prepared.resources,
    font: { resourceId: prepared.font.resourceId, sha256: prepared.font.sha256, bytes: prepared.font.bytes, locator: prepared.font.locator, faceIndex: 0, engine: prepared.font.engine },
  });
  const expectedContentIdentity = hash({
    format: "cut-series-chart-content-identity",
    version: 1,
    checkedPlanId: prepared.checkedPlan.id,
    queryResultId: prepared.queryResult.id,
    geometryPlanId: prepared.geometryPlan.id,
    measurementReceiptId: prepared.measurementReceipt.id,
    resolvedLayoutId: prepared.resolvedLayout.id,
    outlineIdentity: hash(prepared.outlines),
    fontSha256: prepared.font.sha256,
    shaperIdentity: prepared.font.shaperIdentity,
  });
  const { id: styleId, ...styleBody } = prepared.style;
  const expectedStyleIdentity = hash({ format: "cut-series-chart-style-identity", version: 1, style: styleBody });
  const work = prepared.work;
  const expected = hash({
    format: "cut-prepared-reference-series-chart-identity",
    version: 1,
    algorithm: cutSeriesChartAlgorithmVersion,
    resourceIdentity: prepared.resourceIdentity,
    styleIdentity: prepared.styleIdentity,
    contentIdentity: prepared.contentIdentity,
    work,
  });
  if (prepared.resourceIdentity !== expectedResourceIdentity || prepared.contentIdentity !== expectedContentIdentity
    || prepared.styleIdentity !== expectedStyleIdentity || styleId !== prepared.styleIdentity || prepared.id !== expected) {
    fail("CUT_SERIES_CHART_IDENTITY", "$.prepared.id", "prepared chart identity is stale");
  }
}

/** Render one deterministic reveal frame from retained static work. */
export function referenceSeriesChartFrame(
  prepared: CutPreparedReferenceSeriesChart,
  revealValue: CutSeriesChartReveal | unknown,
): CutReferenceSeriesChartFrame {
  assertPreparedIdentity(prepared);
  const reveal = prepareReveal(revealValue);
  const rendered = renderSvg(prepared.geometryPlan, prepared.resolvedLayout, prepared.outlines, prepared.style, reveal);
  const svgBytes = Buffer.byteLength(rendered.svg, "utf8");
  if (svgBytes > cutSeriesChartLimits.maxSvgBytes) fail("CUT_SERIES_CHART_LIMIT", "$.svg", `SVG is ${svgBytes} bytes; limit is ${cutSeriesChartLimits.maxSvgBytes}`);
  const revealResolved: CutResolvedSeriesChartReveal = deepFreeze({
    ...reveal,
    visibleMarks: rendered.visibleMarks,
    totalMarks: prepared.geometryPlan.marks.length,
    clip: rendered.clip,
  });
  const svgSha256 = createHash("sha256").update(rendered.svg, "utf8").digest("hex");
  const identity = deepFreeze({
    format: "cut-reference-series-chart-frame-identity",
    version: 1,
    algorithm: cutSeriesChartAlgorithmVersion,
    preparedId: prepared.id,
    revealId: revealResolved.id,
    revealClip: revealResolved.clip,
    visibleMarks: revealResolved.visibleMarks,
    visibleLabels: rendered.visibleLabels,
    svgBytes,
    svgSha256,
  });
  return deepFreeze({
    format: "cut-reference-series-chart-frame",
    version: 1,
    algorithm: cutSeriesChartAlgorithmVersion,
    id: hash(identity),
    preparedId: prepared.id,
    reveal: revealResolved,
    visibleLabels: rendered.visibleLabels,
    svgBytes,
    svg: rendered.svg,
    svgSha256,
  });
}

/** Deterministic SVG-only retained renderer used by the visual runtime. */
export function referenceSeriesChartSvg(prepared: CutPreparedReferenceSeriesChart, revealValue: CutSeriesChartReveal | unknown) {
  return referenceSeriesChartFrame(prepared, revealValue).svg;
}

/** One-shot convenience wrapper for tests and static callers. */
export function executeCutRetainedSeriesChart(
  planValue: CutTableQueryPlan | CutCheckedTableQueryPlan | unknown,
  resourcesValue: readonly CutLockedTableInput[] | unknown,
  layoutValue: CutDataSeriesLayoutSpec | unknown,
  fontValue: CutSeriesChartFontInput | unknown,
  styleValue: CutSeriesChartStyle | unknown,
  revealValue: CutSeriesChartReveal | unknown,
): CutRetainedSeriesChart {
  const prepared = prepareReferenceSeriesChart(planValue, resourcesValue, layoutValue, fontValue, styleValue);
  const frame = referenceSeriesChartFrame(prepared, revealValue);
  const work = deepFreeze({ ...prepared.work, visibleLabels: frame.visibleLabels, svgBytes: frame.svgBytes });
  return deepFreeze({
    format: "cut-retained-series-chart",
    version: 1,
    algorithm: cutSeriesChartAlgorithmVersion,
    id: hash({ format: "cut-retained-series-chart-identity", version: 1, preparedId: prepared.id, frameId: frame.id }),
    preparedId: prepared.id,
    resourceIdentity: prepared.resourceIdentity,
    styleIdentity: prepared.styleIdentity,
    contentIdentity: prepared.contentIdentity,
    resources: prepared.resources,
    checkedPlan: prepared.checkedPlan,
    queryResult: prepared.queryResult,
    geometryPlan: prepared.geometryPlan,
    measurementReceipt: prepared.measurementReceipt,
    resolvedLayout: prepared.resolvedLayout,
    outlines: prepared.outlines,
    font: prepared.font,
    style: prepared.style,
    reveal: frame.reveal,
    work,
    svg: frame.svg,
    svgSha256: frame.svgSha256,
  });
}
