import assert from "node:assert/strict";
import test from "node:test";
import { parseCutLanguage } from "../lib/language/parser";
import { checkCutModule } from "../lib/language/checker";
import { compileCutModule, CutCompileError } from "../lib/language/compiler";
import type { IRValue } from "../lib/language/ir";
import { builtinPackageImplementationFiles, builtinPackages } from "../lib/language/packages";

function source(replacement = "") {
  const base = `cut 0.4;
project "public typed series chart";

import {
  SeriesChart, chartFrame, chartSeries, dataCategoricalScale, dataLinearScale,
  tableAggregate, tableAggregateValue, tableField, tableGroup, tableGroupKey,
  tableQuery, tableSchema, tableSeries, tableSeriesValue, tableSort, tableSortKey,
  tableSource
} from "@cut/data";

asset facts: DataAsset = data("assets/facts.cut-table.json");
asset face: FontAsset = font("assets/Geist-Regular.ttf");

const schema: TableSchema = tableSchema(
  fields: [
    tableField(name: "region", type: "string", maxBytes: 64),
    tableField(name: "amount", type: "number")
  ],
  key: ["region"]
);

const query: TableQuery = tableQuery(
  sources: [tableSource(name: "facts", source: facts, schema: schema)],
  steps: [
    tableGroup(id: "grouped", input: "facts", by: [tableGroupKey(field: "region", as: "region")]),
    tableAggregate(id: "totals", input: "grouped", values: [tableAggregateValue(as: "total", method: "sum", field: "amount")]),
    tableSort(id: "ordered", input: "totals", by: [tableSortKey(field: "region", direction: "asc")]),
    tableSeries(id: "series", input: "ordered", x: "region", values: [tableSeriesValue(field: "total", as: "total")])
  ],
  result: "series"
);

timeline main(duration: 1s, fps: 24, width: 640px, height: 360px, sampleRate: 48khz) {
  scene proof(duration: 1s) {
    SeriesChart(
      query: query,
      font: face,
      frame: chartFrame(x: 90px, y: 40px, width: 460px, height: 220px, legendX: 90px, legendY: 290px, legendWidth: 460px, legendRows: 2, tickGap: 8px),
      xScale: dataCategoricalScale(order: "first-seen"),
      yScale: dataLinearScale(min: 0, max: 100, ticks: 5, decimals: 0, trimTrailingZeros: true),
      series: [chartSeries(field: "total", name: "Total", color: #e85d3f)],
      kind: "bar", labelSize: 14px, axisColor: #273043, gridColor: #d8dbe2,
      background: #f8f4eb, strokeWidth: 3px, pointRadius: 4px, showLegend: true,
      reveal: 100%
    );
  }
}

export out = render(main);`;
  return replacement ? base.replace("field: \"amount\")", replacement) : base;
}

function parsed(text = source()) {
  const result = parseCutLanguage(text);
  assert.ok(result.module, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.diagnostics, []);
  return result.module;
}

function nestedCalls(value: IRValue): string[] {
  if (value.kind === "call") return [value.op, ...value.positional.flatMap(nestedCalls), ...Object.values(value.named).flatMap(nestedCalls)];
  if (value.kind === "array") return value.items.flatMap(nestedCalls);
  if (value.kind === "object") return Object.values(value.entries).flatMap(nestedCalls);
  if (value.kind === "range") return [...nestedCalls(value.start), ...nestedCalls(value.end)];
  if (value.kind === "unary") return nestedCalls(value.value);
  if (value.kind === "binary") return [...nestedCalls(value.left), ...nestedCalls(value.right)];
  if (value.kind === "member") return nestedCalls(value.object);
  if (value.kind === "index") return [...nestedCalls(value.object), ...nestedCalls(value.index)];
  return [];
}

test("@cut/data publishes typed table/query/scale helpers and executable SeriesChart closure", () => {
  const symbols = builtinPackages.get("@cut/data")?.symbols;
  assert.ok(symbols);
  assert.deepEqual({ returns: symbols.tableQuery.returns, lowering: symbols.tableQuery.lowering }, { returns: "TableQuery", lowering: "data-query-plan" });
  assert.deepEqual({ returns: symbols.tableJoin.returns, lowering: symbols.tableJoin.lowering }, { returns: "TableStep", lowering: "data-query-record" });
  assert.deepEqual({ returns: symbols.SeriesChart.returns, native: symbols.SeriesChart.native }, { returns: "Visual", native: "cut.data.series_chart" });
  const files = builtinPackageImplementationFiles("@cut/data");
  assert.ok(files.includes("language/table-query"));
  assert.ok(files.includes("runtime/reference/data-series-layout"));
});

test("public source type-checks and lowers query intent into typed IR without helper calls or hidden plan bytes", () => {
  const parsedModule = parsed(), check = checkCutModule(parsedModule);
  assert.deepEqual(check.diagnostics, []);
  const ir = compileCutModule(parsedModule).ir;
  const node = Object.values(ir.nodes).find((candidate) => candidate.op === "cut.data.series_chart");
  assert.ok(node);
  assert.equal(node.inputs.query?.kind, "object");
  if (node.inputs.query?.kind !== "object") return;
  assert.deepEqual(node.inputs.query.entries.format, { kind: "string", value: "cut-query-plan" });
  assert.equal(node.inputs.query.entries.sources?.kind, "array");
  assert.equal(node.inputs.query.entries.steps?.kind, "array");
  assert.deepEqual(nestedCalls(node.inputs.query), [], "query helpers must become closed typed IR, not deferred calls");
  const serialized = JSON.stringify(node.inputs.query);
  assert.doesNotMatch(serialized, /assets\/facts/u, "query IR binds the resource identity, not a hidden path or document");
  assert.doesNotMatch(serialized, /sql|eval|javascript/iu);
});

test("query type failures retain the core stable code and point into the authored helper tree", () => {
  const parsedModule = parsed(source('field: "missing")'));
  assert.throws(() => compileCutModule(parsedModule), (error: unknown) => {
    assert.ok(error instanceof CutCompileError);
    const diagnostic = error.result.diagnostics.find((candidate) => candidate.code === "CUT_QUERY_PLAN_FIELD");
    assert.ok(diagnostic, JSON.stringify(error.result.diagnostics));
    assert.match(diagnostic.message, /missing/u);
    assert.ok(diagnostic.span.start.offset < diagnostic.span.end.offset);
    return true;
  });
});
