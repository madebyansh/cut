import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import sharp from "sharp";
import { CutTableQueryError, validateCutTableQueryPlan, type CutLockedTableInput } from "../lib/language/table-query";
import { rational } from "../lib/language/rational";
import type { CutDataSeriesLayoutSpec } from "../lib/runtime/reference/data-series-layout";
import {
  CutSeriesChartError,
  cutSeriesChartStyleFromAdapter,
  executeCutRetainedSeriesChart,
  prepareReferenceSeriesChart,
  referenceSeriesChartFrame,
  referenceSeriesChartSvg,
  type CutLockedSeriesChartFontBytes,
  type CutSeriesChartReveal,
  type CutSeriesChartStyle,
} from "../lib/runtime/reference/series-chart";

type Json = null | boolean | number | string | Json[] | { [name: string]: Json };

const exact = (numerator: number | string, denominator: number | string = 1) => ({ numerator: String(numerator), denominator: String(denominator) });
const fontFixture = readFileSync("examples/fixtures/Geist-Regular.ttf");

function lockedTable(id: string, document: Json): CutLockedTableInput {
  const bytes = Buffer.from(JSON.stringify(document), "utf8");
  return {
    resource: {
      id,
      kind: "data",
      state: "locked",
      lockVersion: 2,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength,
    },
    bytes,
  };
}

function lockedFont(bytes: Uint8Array = fontFixture): CutLockedSeriesChartFontBytes {
  return {
    kind: "locked-bytes",
    resource: {
      id: "geist_regular",
      kind: "font",
      state: "locked",
      lockVersion: 2,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength,
      locator: "examples/fixtures/Geist-Regular.ttf",
    },
    bytes,
  };
}

const categorySchema = {
  fields: [
    { name: "id", type: { kind: "string", maxBytes: 16 } },
    { name: "category", type: { kind: "string", maxBytes: 32 } },
    { name: "current", type: { kind: "number" } },
    { name: "target", type: { kind: "number" } },
  ],
  key: ["id"],
};

const categoryDocument = {
  format: "cut-table",
  version: 1,
  schema: categorySchema,
  rows: [
    { id: "n", category: "North", current: exact(20), target: exact(35) },
    { id: "s", category: "South", current: exact(55), target: exact(50) },
    { id: "w", category: "West", current: exact(80), target: exact(70) },
  ],
} as Json;

function categoryPlan() {
  return {
    format: "cut-query-plan",
    version: 1,
    sources: [{ name: "facts", resourceId: "category_data", schema: categorySchema }],
    steps: [{
      id: "series",
      op: "series",
      input: "facts",
      x: "category",
      values: [{ field: "current", as: "current" }, { field: "target", as: "target" }],
    }],
    result: "series",
  };
}

function categoryLayout(): CutDataSeriesLayoutSpec {
  return {
    format: "cut-data-series-layout-spec",
    version: 1,
    plot: { x: 80, y: 24, width: 360, height: 150 },
    xScale: { kind: "categorical", order: "first-seen" },
    yScale: {
      kind: "linear",
      domain: { min: rational(0), max: rational(100) },
      ticks: { count: 3, format: { kind: "decimal", fractionDigits: 0, trimTrailingZeros: true } },
    },
    series: [{ field: "current", name: "Current" }, { field: "target", name: "Target" }],
    tickLabelGapSubpx: 128,
    legend: { x: 80, y: 220, maxWidth: 360, itemGap: 16, rowGap: 6, swatchSize: 12, swatchGap: 6, maxRows: 2 },
  };
}

function categoryStyle(overrides: Partial<CutSeriesChartStyle> = {}): CutSeriesChartStyle {
  const base: CutSeriesChartStyle = {
    format: "cut-series-chart-style",
    version: 1,
    kind: "line",
    canvas: { width: 520, height: 270, background: "#ffffff" },
    text: { fontSizeSubpx: 896, trackingSubpx: 0, axisLabelFill: "#111827", legendLabelFill: "#111827" },
    axes: { stroke: "#6b7280", strokeWidthSubpx: 64, tickLengthSubpx: 320, labelGapSubpx: 192 },
    grid: { stroke: "#e5e7eb", strokeWidthSubpx: 64 },
    showLegend: true,
    series: [
      { field: "current", stroke: "#2563eb", strokeWidthSubpx: 128, pointRadiusSubpx: 192 },
      { field: "target", stroke: "#dc2626", strokeWidthSubpx: 128, pointRadiusSubpx: 192 },
    ],
  };
  return { ...base, ...overrides } as CutSeriesChartStyle;
}

function reveal(numerator = 1, denominator = 1): CutSeriesChartReveal {
  return { format: "cut-series-chart-reveal", version: 1, progress: rational(numerator, denominator) };
}

function categoryInputs() {
  return [lockedTable("category_data", categoryDocument)];
}

function executeCategory(
  resources: unknown = categoryInputs(),
  style: unknown = categoryStyle(),
  revealValue: unknown = reveal(),
  font: unknown = lockedFont(),
  layout: unknown = categoryLayout(),
) {
  return executeCutRetainedSeriesChart(categoryPlan(), resources, layout, font, style, revealValue);
}

test("locked tables, typed query, exact layout, font outlines, and SVG form one deterministic retained result", async () => {
  const first = executeCategory(), second = executeCategory();
  assert.deepEqual(second, first);
  assert.equal(first.algorithm, "cut-retained-series-chart-v1");
  assert.equal(first.queryResult.kind, "series");
  assert.equal(first.geometryPlan.marks.length, 6);
  assert.equal(first.reveal.visibleMarks, 6);
  assert.equal(first.resources[0].tableId, first.queryResult.sources[0].tableId);
  assert.equal(first.measurementReceipt.font.sha256, first.font.sha256);
  assert.equal(first.measurementReceipt.font.shaperIdentity, first.font.shaperIdentity);
  assert.match(first.id, /^[a-f0-9]{64}$/u);
  assert.match(first.svgSha256, /^[a-f0-9]{64}$/u);
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.style) && Object.isFrozen(first.reveal.clip));
  assert.doesNotMatch(first.svg, /<text|font-family|@font-face|application\/json/iu);
  assert.match(first.svg, /<path /u);
  assert.equal(Buffer.byteLength(first.svg, "utf8"), first.work.svgBytes);
  const png = await sharp(Buffer.from(first.svg, "utf8")).png().toBuffer();
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], "the standalone outline SVG is pixel-ready");
});

test("static preparation accepts a checked plan and reveal enters only deterministic frame identity", () => {
  const checked = validateCutTableQueryPlan(categoryPlan());
  const prepared = prepareReferenceSeriesChart(checked, categoryInputs(), categoryLayout(), lockedFont(), categoryStyle());
  const hidden = referenceSeriesChartFrame(prepared, reveal(0)), half = referenceSeriesChartFrame(prepared, reveal(1, 2)), full = referenceSeriesChartFrame(prepared, reveal());
  assert.equal(hidden.preparedId, prepared.id);
  assert.equal(half.preparedId, prepared.id);
  assert.equal(full.preparedId, prepared.id);
  assert.equal(prepared.id, prepareReferenceSeriesChart(checked, categoryInputs(), categoryLayout(), lockedFont(), categoryStyle()).id);
  assert.equal(hidden.reveal.visibleMarks, 0);
  assert.ok(half.reveal.visibleMarks > 0 && half.reveal.visibleMarks < full.reveal.visibleMarks);
  assert.notEqual(hidden.id, half.id);
  assert.notEqual(half.id, full.id);
  assert.equal(referenceSeriesChartSvg(prepared, reveal()), full.svg);
  assert.match(prepared.resourceIdentity, /^[a-f0-9]{64}$/u);
  assert.equal(prepared.styleIdentity, prepared.style.id);
  assert.match(prepared.contentIdentity, /^[a-f0-9]{64}$/u);

  const stale = structuredClone(checked);
  (stale as { id: string }).id = "0".repeat(64);
  assert.throws(
    () => prepareReferenceSeriesChart(stale, categoryInputs(), categoryLayout(), lockedFont(), categoryStyle()),
    (error: unknown) => error instanceof CutSeriesChartError && error.code === "CUT_SERIES_CHART_IDENTITY",
  );
});

test("a different date-keyed data schema executes through the same public-adapter-shaped API", () => {
  const schema = {
    fields: [
      { name: "id", type: { kind: "string", maxBytes: 16 } },
      { name: "day", type: { kind: "date" } },
      { name: "humidity", type: { kind: "number" } },
    ],
    key: ["id"],
  };
  const document = {
    format: "cut-table",
    version: 1,
    schema,
    rows: [
      { id: "d1", day: "2026-07-01", humidity: exact(40) },
      { id: "d2", day: "2026-07-02", humidity: exact(60) },
      { id: "d3", day: "2026-07-03", humidity: exact(50) },
    ],
  } as Json;
  const plan = {
    format: "cut-query-plan",
    version: 1,
    sources: [{ name: "weather", resourceId: "weather_data", schema }],
    steps: [{ id: "series", op: "series", input: "weather", x: "day", values: [{ field: "humidity", as: "humidity" }] }],
    result: "series",
  };
  const layout: CutDataSeriesLayoutSpec = {
    format: "cut-data-series-layout-spec",
    version: 1,
    plot: { x: 80, y: 24, width: 360, height: 150 },
    xScale: { kind: "date", domain: { min: "2026-07-01", max: "2026-07-03" }, ticks: { interval: "day", step: 1, format: "iso-date" } },
    yScale: { kind: "linear", domain: { min: rational(0), max: rational(100) }, ticks: { count: 3, format: { kind: "fraction" } } },
    series: [{ field: "humidity", name: "Humidity" }],
    tickLabelGapSubpx: 64,
    legend: { x: 80, y: 220, maxWidth: 360, itemGap: 16, rowGap: 6, swatchSize: 12, swatchGap: 6, maxRows: 1 },
  };
  const style: CutSeriesChartStyle = {
    ...categoryStyle(),
    series: [{ field: "humidity", stroke: "#047857", strokeWidthSubpx: 128, pointRadiusSubpx: 192 }],
  };
  const result = executeCutRetainedSeriesChart(plan, [lockedTable("weather_data", document)], layout, lockedFont(), style, reveal());
  const category = executeCategory();
  assert.equal(result.queryResult.schema.x.type.kind, "date");
  assert.deepEqual(result.geometryPlan.scales.x.ticks.map((tick) => tick.label), ["2026-07-01", "2026-07-02", "2026-07-03"]);
  assert.notEqual(result.queryResult.id, category.queryResult.id);
  assert.notEqual(result.geometryPlan.id, category.geometryPlan.id);
  assert.notEqual(result.id, category.id);
});

test("resource hashes, missing or mutated inputs, and caller aliases cannot bypass locked identity", () => {
  const staleTable = categoryInputs();
  staleTable[0] = { ...staleTable[0], resource: { ...staleTable[0].resource, sha256: "0".repeat(64) } };
  assert.throws(() => executeCategory(staleTable), (error: unknown) => error instanceof CutTableQueryError && error.code === "CUT_TABLE_RESOURCE_INTEGRITY");

  assert.throws(() => executeCategory([]), (error: unknown) => error instanceof CutSeriesChartError && error.code === "CUT_SERIES_CHART_LIMIT");

  const staleFont = lockedFont();
  const forgedFont = { ...staleFont, resource: { ...staleFont.resource, sha256: "0".repeat(64) } };
  assert.throws(() => executeCategory(categoryInputs(), categoryStyle(), reveal(), forgedFont), (error: unknown) => error instanceof CutSeriesChartError && error.code === "CUT_SERIES_CHART_RESOURCE_INTEGRITY");

  const tableInput = categoryInputs(), fontInput = lockedFont(), mutableStyle = structuredClone(categoryStyle()), mutableLayout = structuredClone(categoryLayout());
  const retained = executeCategory(tableInput, mutableStyle, reveal(), fontInput, mutableLayout);
  const stableSvg = retained.svg, stableId = retained.id;
  tableInput[0].bytes[0] ^= 0xff;
  fontInput.bytes[12] ^= 0xff;
  (mutableStyle.series[0] as { stroke: string }).stroke = "#000000";
  (mutableLayout.plot as { width: number }).width += 1;
  assert.equal(retained.svg, stableSvg);
  assert.equal(retained.id, stableId);
  assert.equal(retained.style.series[0].stroke, "#2563eb");
  assert.equal(retained.geometryPlan.plot.width, 360);
});

test("reveal is exact and executable, while invisible and unknown style controls fail instead of becoming no-ops", () => {
  const hidden = executeCategory(categoryInputs(), categoryStyle(), reveal(0)), half = executeCategory(categoryInputs(), categoryStyle(), reveal(1, 2)), full = executeCategory();
  assert.equal(hidden.reveal.visibleMarks, 0);
  assert.ok(half.reveal.visibleMarks > 0 && half.reveal.visibleMarks < full.reveal.visibleMarks);
  assert.equal(full.reveal.visibleMarks, full.reveal.totalMarks);
  assert.notEqual(hidden.reveal.id, full.reveal.id);
  assert.notEqual(hidden.svg, full.svg);
  assert.notEqual(half.id, full.id);

  const invisible = categoryStyle({
    series: [
      { field: "current", stroke: "#ffffff", strokeWidthSubpx: 128, pointRadiusSubpx: 192 },
      { field: "target", stroke: "#dc2626", strokeWidthSubpx: 128, pointRadiusSubpx: 192 },
    ],
  });
  assert.throws(() => executeCategory(categoryInputs(), invisible), (error: unknown) => error instanceof CutSeriesChartError && error.code === "CUT_SERIES_CHART_NOOP");
  assert.throws(
    () => executeCategory(categoryInputs(), { ...categoryStyle(), browserFont: "sans-serif" }),
    (error: unknown) => error instanceof CutSeriesChartError && error.code === "CUT_SERIES_CHART_UNKNOWN_FIELD",
  );
  assert.throws(() => executeCategory(categoryInputs(), categoryStyle(), { ...reveal(), progress: rational(2) }), (error: unknown) => error instanceof CutSeriesChartError && error.code === "CUT_SERIES_CHART_REVEAL");
});

test("bar, line, area, grid, legend, and adapter style fields all execute visibly", () => {
  const linePrepared = prepareReferenceSeriesChart(categoryPlan(), categoryInputs(), categoryLayout(), lockedFont(), categoryStyle());
  const line = referenceSeriesChartFrame(linePrepared, reveal());
  const areaPrepared = prepareReferenceSeriesChart(categoryPlan(), categoryInputs(), categoryLayout(), lockedFont(), categoryStyle({ kind: "area" }));
  const area = referenceSeriesChartFrame(areaPrepared, reveal());
  const barPrepared = prepareReferenceSeriesChart(categoryPlan(), categoryInputs(), categoryLayout(), lockedFont(), categoryStyle({ kind: "bar" }));
  const bar = referenceSeriesChartFrame(barPrepared, reveal());
  assert.match(line.svg, /<circle /u);
  assert.doesNotMatch(line.svg, /fill-opacity="0\.25"/u);
  assert.match(area.svg, /fill-opacity="0\.25"/u);
  assert.match(area.svg, /<circle /u);
  assert.match(bar.svg, /<rect x="[^"]+" y="[^"]+" width="[^"]+" height="[^"]+" rx="3" fill="#2563eb" stroke="#2563eb" stroke-width="2"/u);
  assert.doesNotMatch(bar.svg, /<circle /u);
  assert.match(line.svg, /stroke="#e5e7eb" stroke-width="1"/u, "grid style is painted");
  assert.match(line.svg, /<rect x="80" y="24" width="360" height="150" fill="#ffffff"\/>/u, "background paint is retained to the declared plot instead of covering unrelated composition layers");
  assert.doesNotMatch(line.svg, /<rect width="520" height="270" fill="#ffffff"\/>/u);
  assert.notEqual(linePrepared.styleIdentity, areaPrepared.styleIdentity);
  assert.notEqual(areaPrepared.styleIdentity, barPrepared.styleIdentity);
  assert.notEqual(line.svgSha256, area.svgSha256);
  assert.notEqual(area.svgSha256, bar.svgSha256);

  const withoutLegendPrepared = prepareReferenceSeriesChart(categoryPlan(), categoryInputs(), categoryLayout(), lockedFont(), categoryStyle({ showLegend: false }));
  const withoutLegend = referenceSeriesChartFrame(withoutLegendPrepared, reveal());
  const firstLegendRun = linePrepared.outlines.find((item) => item.requestId === linePrepared.geometryPlan.series[0].measurementId)!;
  assert.match(line.svg, new RegExp(`d="${firstLegendRun.run.pathData.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}"`, "u"));
  assert.doesNotMatch(withoutLegend.svg, new RegExp(`d="${firstLegendRun.run.pathData.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}"`, "u"));
  assert.equal(withoutLegend.visibleLabels, line.visibleLabels - linePrepared.geometryPlan.series.length);

  const adapted = cutSeriesChartStyleFromAdapter({
    series: [{ field: "current", color: "#2563eb" }, { field: "target", color: "#dc2626" }],
    kind: "area",
    labelSize: 14,
    axisColor: "#111827",
    gridColor: "#e5e7eb",
    background: "#ffffff",
    strokeWidth: 2,
    pointRadius: 3,
    showLegend: true,
  }, { width: 520, height: 270 });
  assert.equal(adapted.kind, "area");
  assert.equal(adapted.text.fontSizeSubpx, 896);
  assert.equal(adapted.series[0].stroke, "#2563eb");
  assert.match(executeCategory(categoryInputs(), adapted).svg, /fill-opacity="0\.25"/u);
});

test("locked label measurement identity changes with typography but leaves typed query and mark geometry local", () => {
  const normal = executeCategory(), tracked = executeCategory(categoryInputs(), {
    ...categoryStyle(),
    text: { ...categoryStyle().text, trackingSubpx: 32 },
  });
  assert.equal(tracked.queryResult.id, normal.queryResult.id);
  assert.equal(tracked.geometryPlan.id, normal.geometryPlan.id);
  assert.notEqual(tracked.style.id, normal.style.id);
  assert.notEqual(tracked.font.shaperIdentity, normal.font.shaperIdentity);
  assert.notEqual(tracked.measurementReceipt.id, normal.measurementReceipt.id);
  assert.notEqual(tracked.resolvedLayout.id, normal.resolvedLayout.id);
  assert.notEqual(tracked.svgSha256, normal.svgSha256);
});

test("mark and outline work is bounded before retained SVG allocation", () => {
  const rows = Array.from({ length: 257 }, (_, index) => ({ id: `r${index}`, category: `c${index % 3}`, current: exact(index % 100), target: exact((index + 1) % 100) }));
  const document = { format: "cut-table", version: 1, schema: categorySchema, rows } as Json;
  assert.throws(
    () => executeCutRetainedSeriesChart(categoryPlan(), [lockedTable("category_data", document)], categoryLayout(), lockedFont(), categoryStyle(), reveal()),
    (error: unknown) => error instanceof CutSeriesChartError && error.code === "CUT_SERIES_CHART_LIMIT",
  );
});
