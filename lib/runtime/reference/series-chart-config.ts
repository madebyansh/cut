import type { CutAVIR, IRComposition, IRNode, IRValue } from "../../language/ir";
import { cutTableQueryPlanFromIr } from "../../language/table-query-ir";
import { CutTableQueryError, type CutCheckedTableQueryPlan, type CutExactNumber } from "../../language/table-query";
import { rationalToNumber } from "../../language/rational";
import type { CutDataScaleSpec, CutDataSeriesLayoutSpec } from "./data-series-layout";

export type ReferenceSeriesChartKind = "bar" | "line" | "area";

export type ReferenceSeriesChartConfig = Readonly<{
  nodeId: string;
  query: CutCheckedTableQueryPlan;
  sourceIds: readonly string[];
  fontId: string;
  layout: CutDataSeriesLayoutSpec;
  series: readonly Readonly<{ field: string; name: string; color: string }>[];
  kind: ReferenceSeriesChartKind;
  labelSize: number;
  axisColor: string;
  gridColor: string;
  background: string;
  strokeWidth: number;
  pointRadius: number;
  showLegend: boolean;
}>;

export type ReferenceSeriesChartErrorCode =
  | "CUT_SERIES_CHART_TYPE"
  | "CUT_SERIES_CHART_UNKNOWN_FIELD"
  | "CUT_SERIES_CHART_INPUT"
  | "CUT_SERIES_CHART_RESOURCE"
  | "CUT_SERIES_CHART_RESOURCE_STATE"
  | "CUT_SERIES_CHART_RESOURCE_INTEGRITY"
  | "CUT_SERIES_CHART_QUERY"
  | "CUT_SERIES_CHART_LAYOUT"
  | "CUT_SERIES_CHART_STYLE"
  | "CUT_SERIES_CHART_REVEAL"
  | "CUT_SERIES_CHART_FONT"
  | "CUT_SERIES_CHART_GEOMETRY"
  | "CUT_SERIES_CHART_IDENTITY"
  | "CUT_SERIES_CHART_LIMIT"
  | "CUT_SERIES_CHART_NOOP";

export class ReferenceSeriesChartError extends Error {
  readonly source: { module: string; line: number; column: number; nodeId: string };

  constructor(readonly code: ReferenceSeriesChartErrorCode, readonly node: IRNode, message: string) {
    const { module, span } = node.provenance;
    super(`${code}: SeriesChart ${message} at ${module}:${span.start.line}:${span.start.column}.`);
    this.name = "ReferenceSeriesChartError";
    this.source = { module, line: span.start.line, column: span.start.column, nodeId: node.id };
  }
}

function fail(node: IRNode, code: ReferenceSeriesChartErrorCode, message: string): never {
  throw new ReferenceSeriesChartError(code, node, message);
}

function object(node: IRNode, value: IRValue | undefined, path: string) {
  if (value?.kind !== "object") fail(node, "CUT_SERIES_CHART_INPUT", `${path} must be a closed typed record`);
  return value.entries;
}

function closed(node: IRNode, value: IRValue | undefined, path: string, required: readonly string[]) {
  const entries = object(node, value, path), allowed = new Set(required);
  for (const name of Object.keys(entries)) if (!allowed.has(name)) fail(node, "CUT_SERIES_CHART_INPUT", `${path}.${name} is not part of the closed public contract`);
  for (const name of required) if (!Object.hasOwn(entries, name)) fail(node, "CUT_SERIES_CHART_INPUT", `${path}.${name} is required`);
  return entries;
}

function string(node: IRNode, value: IRValue | undefined, path: string) {
  if (value?.kind !== "string" || !value.value.length || Buffer.byteLength(value.value, "utf8") > 1_024) fail(node, "CUT_SERIES_CHART_INPUT", `${path} must be a non-empty bounded String`);
  return value.value;
}

function boolean(node: IRNode, value: IRValue | undefined, path: string) {
  if (value?.kind !== "boolean") fail(node, "CUT_SERIES_CHART_INPUT", `${path} must be Boolean`);
  return value.value;
}

function scalar(node: IRNode, value: IRValue | undefined, path: string): CutExactNumber {
  if (value?.kind !== "quantity" || value.dimension !== "scalar" || value.unit !== "scalar") fail(node, "CUT_SERIES_CHART_INPUT", `${path} must be an exact Number`);
  return Object.freeze({ ...value.magnitude });
}

function integer(node: IRNode, value: IRValue | undefined, path: string, minimum: number, maximum: number) {
  const exact = scalar(node, value, path);
  if (exact.denominator !== "1") fail(node, "CUT_SERIES_CHART_INPUT", `${path} must be a whole Number`);
  const result = Number(exact.numerator);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) fail(node, "CUT_SERIES_CHART_LIMIT", `${path} must be from ${minimum} through ${maximum}`);
  return result;
}

function length(node: IRNode, value: IRValue | undefined, path: string, minimum: number, maximum: number) {
  if (value?.kind !== "quantity" || value.dimension !== "length" || value.unit !== "px") fail(node, "CUT_SERIES_CHART_INPUT", `${path} must be a Length in px`);
  if (value.magnitude.denominator !== "1") fail(node, "CUT_SERIES_CHART_LAYOUT", `${path} must be a whole delivery pixel in this first retained chart vertical`);
  const result = Number(value.magnitude.numerator);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) fail(node, "CUT_SERIES_CHART_LIMIT", `${path} must be from ${minimum}px through ${maximum}px`);
  return result;
}

function color(node: IRNode, value: IRValue | undefined, path: string) {
  if (value?.kind !== "color" || !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/u.test(value.value)) fail(node, "CUT_SERIES_CHART_STYLE", `${path} must be a canonical lowercase color`);
  if (value.value.length === 9 && value.value.endsWith("00")) fail(node, "CUT_SERIES_CHART_NOOP", `${path} cannot be fully transparent`);
  return value.value;
}

function numberFormat(node: IRNode, value: IRValue | undefined, path: string) {
  const entries = closed(node, value, path, ["kind", "fractionDigits", "trimTrailingZeros"]);
  if (string(node, entries.kind, `${path}.kind`) !== "decimal") fail(node, "CUT_SERIES_CHART_INPUT", `${path}.kind must be decimal`);
  return Object.freeze({
    kind: "decimal" as const,
    fractionDigits: integer(node, entries.fractionDigits, `${path}.fractionDigits`, 0, 12),
    trimTrailingZeros: boolean(node, entries.trimTrailingZeros, `${path}.trimTrailingZeros`),
  });
}

function scale(node: IRNode, value: IRValue | undefined, path: string, axis: "x" | "y"): CutDataScaleSpec {
  const entries = object(node, value, path), kind = string(node, entries.kind, `${path}.kind`);
  if (kind === "linear") {
    const exact = closed(node, value, path, ["kind", "domain", "ticks"]), domain = closed(node, exact.domain, `${path}.domain`, ["min", "max"]), ticks = closed(node, exact.ticks, `${path}.ticks`, ["count", "format"]);
    return Object.freeze({ kind, domain: Object.freeze({ min: scalar(node, domain.min, `${path}.domain.min`), max: scalar(node, domain.max, `${path}.domain.max`) }), ticks: Object.freeze({ count: integer(node, ticks.count, `${path}.ticks.count`, 2, 256), format: numberFormat(node, ticks.format, `${path}.ticks.format`) }) });
  }
  if (kind === "log") {
    const exact = closed(node, value, path, ["kind", "domain", "ticks"]), domain = closed(node, exact.domain, `${path}.domain`, ["min", "max"]), ticks = closed(node, exact.ticks, `${path}.ticks`, ["format"]);
    return Object.freeze({ kind, domain: Object.freeze({ min: scalar(node, domain.min, `${path}.domain.min`), max: scalar(node, domain.max, `${path}.domain.max`) }), ticks: Object.freeze({ format: numberFormat(node, ticks.format, `${path}.ticks.format`) }) });
  }
  if (kind === "categorical") {
    if (axis === "y") fail(node, "CUT_SERIES_CHART_LAYOUT", "input yScale cannot be categorical");
    const exact = closed(node, value, path, ["kind", "order"]);
    if (string(node, exact.order, `${path}.order`) !== "first-seen") fail(node, "CUT_SERIES_CHART_INPUT", `${path}.order must be first-seen`);
    return Object.freeze({ kind, order: "first-seen" as const });
  }
  if (kind === "date") {
    if (axis === "y") fail(node, "CUT_SERIES_CHART_LAYOUT", "input yScale cannot be date");
    const exact = closed(node, value, path, ["kind", "domain", "ticks"]), domain = closed(node, exact.domain, `${path}.domain`, ["min", "max"]), ticks = closed(node, exact.ticks, `${path}.ticks`, ["interval", "step", "format"]);
    const interval = string(node, ticks.interval, `${path}.ticks.interval`), format = string(node, ticks.format, `${path}.ticks.format`);
    if (!(["day", "month", "year"] as const).includes(interval as "day")) fail(node, "CUT_SERIES_CHART_INPUT", `${path}.ticks.interval is unsupported`);
    if (!(["iso-date", "year-month", "year"] as const).includes(format as "year")) fail(node, "CUT_SERIES_CHART_INPUT", `${path}.ticks.format is unsupported`);
    return Object.freeze({ kind, domain: Object.freeze({ min: string(node, domain.min, `${path}.domain.min`), max: string(node, domain.max, `${path}.domain.max`) }), ticks: Object.freeze({ interval: interval as "day" | "month" | "year", step: integer(node, ticks.step, `${path}.ticks.step`, 1, 10_000), format: format as "iso-date" | "year-month" | "year" }) });
  }
  fail(node, "CUT_SERIES_CHART_INPUT", `${path}.kind must be linear, log, categorical, or date`);
}

function series(node: IRNode, value: IRValue | undefined) {
  if (value?.kind !== "array" || value.items.length < 1 || value.items.length > 16) fail(node, "CUT_SERIES_CHART_LIMIT", "input series must contain 1 through 16 entries");
  const fields = new Set<string>(), names = new Set<string>();
  return Object.freeze(value.items.map((item, index) => {
    const path = `input series[${index}]`, entries = closed(node, item, path, ["field", "name", "color"]);
    const field = string(node, entries.field, `${path}.field`), name = string(node, entries.name, `${path}.name`);
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(field) || fields.has(field)) fail(node, "CUT_SERIES_CHART_QUERY", `${path}.field must be a unique query identifier`);
    if (names.has(name)) fail(node, "CUT_SERIES_CHART_STYLE", `${path}.name must be unique`);
    fields.add(field); names.add(name);
    return Object.freeze({ field, name, color: color(node, entries.color, `${path}.color`) });
  }));
}

/** Validate the complete static public SeriesChart contract. Locked bytes and
 * font outlines are intentionally prepared later, after verified resource
 * resolution; this function is safe for compile/check and hostile IR loads. */
export function referenceSeriesChartConfig(ir: CutAVIR, node: IRNode, composition: IRComposition): ReferenceSeriesChartConfig | undefined {
  if (node.op !== "cut.data.series_chart") return undefined;
  let query: CutCheckedTableQueryPlan;
  try { query = cutTableQueryPlanFromIr(node.inputs.query); }
  catch (error) {
    if (error instanceof CutTableQueryError) fail(node, "CUT_SERIES_CHART_QUERY", `${error.message}`);
    throw error;
  }
  if (query.output.kind !== "series") fail(node, "CUT_SERIES_CHART_QUERY", "input query must end in a tableSeries step");
  const sourceIds = Object.freeze(query.plan.sources.map((source) => source.resourceId));
  for (const sourceId of sourceIds) {
    const resource = ir.resources[sourceId];
    if (!resource || resource.kind !== "data") fail(node, "CUT_SERIES_CHART_RESOURCE", `query source ${sourceId} is not a DataAsset`);
  }
  const font = node.inputs.font;
  if (font?.kind !== "resource-ref" || ir.resources[font.id]?.kind !== "font") fail(node, "CUT_SERIES_CHART_RESOURCE", "input font must reference one FontAsset");
  const frame = closed(node, node.inputs.frame, "input frame", ["x", "y", "width", "height", "legendX", "legendY", "legendWidth", "legendRows", "tickGap"]);
  const plot = Object.freeze({
    x: length(node, frame.x, "input frame.x", -65_536, 65_536),
    y: length(node, frame.y, "input frame.y", -65_536, 65_536),
    width: length(node, frame.width, "input frame.width", 1, 16_384),
    height: length(node, frame.height, "input frame.height", 1, 16_384),
  });
  if (plot.x + plot.width < 1 || plot.y + plot.height < 1 || plot.x >= composition.width || plot.y >= composition.height) fail(node, "CUT_SERIES_CHART_NOOP", "input frame plot lies completely outside the composition canvas");
  const labelSize = length(node, node.inputs.labelSize, "input labelSize", 6, 256), chartSeries = series(node, node.inputs.series);
  const layout: CutDataSeriesLayoutSpec = Object.freeze({
    format: "cut-data-series-layout-spec",
    version: 1,
    plot,
    xScale: scale(node, node.inputs.xScale, "input xScale", "x"),
    yScale: scale(node, node.inputs.yScale, "input yScale", "y") as CutDataSeriesLayoutSpec["yScale"],
    series: Object.freeze(chartSeries.map(({ field, name }) => Object.freeze({ field, name }))),
    tickLabelGapSubpx: length(node, frame.tickGap, "input frame.tickGap", 0, 128) * 64,
    legend: Object.freeze({
      x: length(node, frame.legendX, "input frame.legendX", -65_536, 65_536),
      y: length(node, frame.legendY, "input frame.legendY", -65_536, 65_536),
      maxWidth: length(node, frame.legendWidth, "input frame.legendWidth", 1, 16_384),
      itemGap: labelSize,
      rowGap: Math.max(2, Math.floor(labelSize / 2)),
      swatchSize: labelSize,
      swatchGap: Math.max(2, Math.floor(labelSize / 2)),
      maxRows: integer(node, frame.legendRows, "input frame.legendRows", 1, 64),
    }),
  });
  const kind = string(node, node.inputs.kind, "input kind");
  if (!(["bar", "line", "area"] as const).includes(kind as ReferenceSeriesChartKind)) fail(node, "CUT_SERIES_CHART_INPUT", "input kind must be bar, line, or area");
  const config: ReferenceSeriesChartConfig = Object.freeze({
    nodeId: node.id,
    query,
    sourceIds,
    fontId: font.id,
    layout,
    series: chartSeries,
    kind: kind as ReferenceSeriesChartKind,
    labelSize,
    axisColor: color(node, node.inputs.axisColor, "input axisColor"),
    gridColor: color(node, node.inputs.gridColor, "input gridColor"),
    background: color(node, node.inputs.background, "input background"),
    strokeWidth: length(node, node.inputs.strokeWidth, "input strokeWidth", 1, 128),
    pointRadius: length(node, node.inputs.pointRadius, "input pointRadius", 1, 128),
    showLegend: boolean(node, node.inputs.showLegend, "input showLegend"),
  });
  const numeric = [plot.x, plot.y, plot.width, plot.height, config.labelSize, config.strokeWidth, config.pointRadius];
  if (!numeric.every(Number.isSafeInteger)) fail(node, "CUT_SERIES_CHART_LIMIT", "contains an unsafe geometry integer");
  return config;
}

/** Stable utility for tests/inspect: turn an exact property into a bounded
 * number without changing source/cache identity. */
export function referenceSeriesChartExactNumber(value: CutExactNumber) { return rationalToNumber(value); }
