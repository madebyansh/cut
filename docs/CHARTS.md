# Deterministic charts

Status: executable bounded CUT 0.4 alpha vertical. The chart runtime is a
general visual primitive, not an automatic infographic designer and not by
itself evidence that a film has passed creative review.

`@cut/data` exposes two different public chart paths:

- `Chart` draws one authored list of exact numbers. It is the small choice for
  unlabeled bars, lines, and areas.
- `SeriesChart` evaluates locked typed tables through a checked query, lays out
  categorical, date, linear, or logarithmic axes, shapes labels with a locked
  font, resolves collisions and legends, and draws one or more named series.

Neither path reads system fonts, asks a model to interpret data, or accepts a
hidden SQL/JavaScript/JSON render plan.

## Scalar `Chart`

```cut
cut 0.4;
project "quarterly range";
import { Chart } from "@cut/data";
import { linear } from "@cut/motion";

timeline main(duration: 2s, fps: 30, width: 1080px, height: 1080px) {
  scene result(duration: 2s) {
    Chart(
      values: [-4, 2, 9, 6], kind: "area",
      width: 820px, height: 520px, min: -5, max: 10,
      primary: #7c3aed, secondary: #f59e0b, background: #fafaf9,
      showAxes: true, axisColor: #292524, strokeWidth: 6px,
      reveal: 0%
    ) as chart;
    animate chart.reveal from 0% to 100% over 1200ms ease linear;
  }
}

export out = render(main, width: 1080px, height: 1080px, codec: "h264");
```

`values` accepts 1-512 exact finite numbers; line and area need at least two.
`min` and `max` are an optional increasing pair containing every value. CUT
otherwise derives a domain which includes zero. Bars preserve positive,
negative, and true zero geometry. `primary` and `secondary` paint the series;
`background` is optional and transparent when omitted. `showAxes` controls the
zero/left axes, `gap` is bar-only, and `strokeWidth` is line/area-only.
`reveal` is sampled on the exact output-frame clock. Values outside `0%..100%`
fail, while derived easing overshoot saturates deterministically. Ordinary
retained `x`, `y`, `opacity`, `scale`, and `rotation` transforms also execute.

`Chart` deliberately has no tick text, category labels, legend, or data
binding. Use `SeriesChart` when those semantics belong to the chart rather
than to separately authored layers.

## Typed table and query API

The following are the actual public `@cut/data` signatures. `String.maxBytes`
is required for string fields and rejected for number, Boolean, and date
fields. Every schema has a non-empty ordered composite key.

```text
tableField(name: String, type: "number" | "string" | "boolean" | "date", maxBytes?: Number) -> TableField
tableSchema(fields: List<TableField>, key: List<String>) -> TableSchema
tableSource(name: String, source: DataAsset, schema: TableSchema) -> TableSource

tableCompare(field: String, operator: "eq" | "ne" | "lt" | "lte" | "gt" | "gte", value: Any) -> TablePredicate
tableLogic(op: "and" | "or", items: List<TablePredicate>) -> TablePredicate
tableNot(item: TablePredicate) -> TablePredicate
tableFilter(id: String, input: String, where: TablePredicate) -> TableStep

tableJoinKey(left: String, right: String) -> TableJoinKey
tableSelect(from: "left" | "right", field: String, as: String) -> TableSelection
tableJoin(id: String, left: String, right: String, on: List<TableJoinKey>, select: List<TableSelection>, key: List<String>) -> TableStep

tableGroupKey(field: String, as: String) -> TableGroupKey
tableGroup(id: String, input: String, by: List<TableGroupKey>) -> TableStep
tableAggregateValue(as: String, method: "count" | "sum" | "mean" | "min" | "max", field?: String) -> TableAggregateValue
tableAggregate(id: String, input: String, values: List<TableAggregateValue>) -> TableStep
tableSortKey(field: String, direction: "asc" | "desc") -> TableSortKey
tableSort(id: String, input: String, by: List<TableSortKey>) -> TableStep
tableSeriesValue(field: String, as: String) -> TableSeriesValue
tableSeries(id: String, input: String, x: String, values: List<TableSeriesValue>) -> TableStep
tableQuery(sources: List<TableSource>, steps: List<TableStep>, result: String) -> TableQuery
```

Queries are closed, bounded, and type-checked. A step may refer only to an
earlier source or step. Joins are inner equi-joins with an explicit projection
and key. Aggregation supports exact count, sum, mean, min, and max. Sorts are
stable. There is no expression callback, arbitrary code, SQL, or `eval` path.

Each `DataAsset` is strict UTF-8 `cut-table` version 1. It contains the same
closed schema and rows whose fields exactly match that schema. Numeric cells
are canonical reduced rationals such as
`{"numerator":"5","denominator":"2"}`; dates are real
`YYYY-MM-DD` Gregorian dates. `cut lock` binds each resource path, byte count,
and SHA-256; the checked query binds its declared schema and runtime requires
an exact file-schema match. Check/render refuses unlocked, stale, malformed,
wrong-schema, or mutated bytes.

### Copyable joined multi-series example

This example demonstrates a joined multi-series query and reusable chart
component. It can be combined with declarations, reveal animation and locked
fixture tables in an ordinary CUT project.

```cut
import {
  SeriesChart, chartFrame, chartSeries, dataCategoricalScale, dataLinearScale,
  tableAggregate, tableAggregateValue, tableField, tableGroup, tableGroupKey,
  tableJoin, tableJoinKey, tableQuery, tableSchema, tableSelect, tableSeries,
  tableSeriesValue, tableSort, tableSortKey, tableSource
} from "@cut/data";

asset observations: DataAsset = data("assets/observations.cut-table.json");
asset neighborhoods: DataAsset = data("assets/neighborhoods.cut-table.json");
asset face: FontAsset = font("assets/Geist-Regular.ttf");

const observationsSchema: TableSchema = tableSchema(fields: [
  tableField(name: "id", type: "string", maxBytes: 32),
  tableField(name: "neighborhood_id", type: "string", maxBytes: 32),
  tableField(name: "heat", type: "number"),
  tableField(name: "canopy", type: "number")
], key: ["id"]);

const neighborhoodsSchema: TableSchema = tableSchema(fields: [
  tableField(name: "id", type: "string", maxBytes: 32),
  tableField(name: "label", type: "string", maxBytes: 64)
], key: ["id"]);

const evidence: TableQuery = tableQuery(sources: [
  tableSource(name: "observations", source: observations, schema: observationsSchema),
  tableSource(name: "neighborhoods", source: neighborhoods, schema: neighborhoodsSchema)
], steps: [
  tableJoin(
    id: "labeled", left: "observations", right: "neighborhoods",
    on: [tableJoinKey(left: "neighborhood_id", right: "id")],
    select: [
      tableSelect(from: "left", field: "id", as: "observation_id"),
      tableSelect(from: "right", field: "label", as: "neighborhood"),
      tableSelect(from: "left", field: "heat", as: "heat"),
      tableSelect(from: "left", field: "canopy", as: "canopy")
    ], key: ["observation_id"]
  ),
  tableGroup(id: "by_neighborhood", input: "labeled", by: [
    tableGroupKey(field: "neighborhood", as: "neighborhood")
  ]),
  tableAggregate(id: "means", input: "by_neighborhood", values: [
    tableAggregateValue(as: "mean_heat", method: "mean", field: "heat"),
    tableAggregateValue(as: "mean_canopy", method: "mean", field: "canopy")
  ]),
  tableSort(id: "hottest_first", input: "means", by: [
    tableSortKey(field: "mean_heat", direction: "desc")
  ]),
  tableSeries(id: "ward_series", input: "hottest_first", x: "neighborhood", values: [
    tableSeriesValue(field: "mean_heat", as: "mean_heat"),
    tableSeriesValue(field: "mean_canopy", as: "mean_canopy")
  ])
], result: "ward_series");

SeriesChart(
  query: evidence, font: face,
  frame: chartFrame(
    x: 110px, y: 188px, width: 760px, height: 235px,
    legendX: 110px, legendY: 463px, legendWidth: 760px,
    legendRows: 2, tickGap: 8px
  ),
  xScale: dataCategoricalScale(order: "first-seen"),
  yScale: dataLinearScale(min: 0, max: 100, ticks: 6, decimals: 0, trimTrailingZeros: true),
  series: [
    chartSeries(field: "mean_heat", name: "afternoon heat index", color: #ef5a3c),
    chartSeries(field: "mean_canopy", name: "tree canopy", color: #2a9d8f)
  ],
  kind: "bar", labelSize: 14px,
  axisColor: #182335, gridColor: #b9b4a755, background: #fff6df,
  strokeWidth: 2px, pointRadius: 4px, showLegend: true,
  reveal: 100%
);
```

## `SeriesChart` scales, frame, and style

```text
dataLinearScale(min: Number, max: Number, ticks: Number, decimals: Number, trimTrailingZeros: Boolean) -> DataScale
dataLogScale(min: Number, max: Number, decimals: Number, trimTrailingZeros: Boolean) -> DataScale
dataCategoricalScale(order: "first-seen") -> DataScale
dataDateScale(min: String, max: String, interval: "day" | "month" | "year", step: Number, format: "iso-date" | "year-month" | "year") -> DataScale

chartSeries(field: String, name: String, color: Color) -> ChartSeries
chartFrame(x: Length, y: Length, width: Length, height: Length, legendX: Length, legendY: Length, legendWidth: Length, legendRows: Number, tickGap: Length) -> ChartFrame

SeriesChart(
  query: TableQuery, font: FontAsset, frame: ChartFrame,
  xScale: DataScale, yScale: DataScale, series: List<ChartSeries>,
  kind: "bar" | "line" | "area", labelSize: Length,
  axisColor: Color, gridColor: Color, background: Color,
  strokeWidth: Length, pointRadius: Length, showLegend: Boolean,
  reveal?: Ratio, opacity?: Ratio, scale?: Number, rotation?: Angle
) -> Visual
```

Linear mapping and ticks use exact rational arithmetic. Categorical axes
preserve first-seen order. Date axes use explicit proleptic-Gregorian domains
and drift-free day/month/year stepping. Log axes require positive domains and
values and use CUT's versioned deterministic fixed-point logarithm rather than
the host's floating-point `log`. Decimal tick labels are locale-free and use a
specified rounding rule. Duplicate formatted labels fail instead of producing
an ambiguous axis.

The authored `chartFrame` makes responsive composition explicit: plot and
legend geometry are ordinary composition coordinates, not an automatic
breakpoint system. The same component may receive different frames for
16:9, 9:16, and 1:1 outputs. The public responsive-chart tests use one
date-keyed query and log scale across landscape, portrait and square timelines
without a title-specific runtime path.

All tick and legend text is shaped into retained outlines from the declared
locked `FontAsset`. There is no browser/system-font fallback. Collision
thinning keeps mandatory axis endpoints and deterministically removes
interior labels that do not fit; impossible endpoints fail. Legends preserve
series order and flow within the authored width and row limit.

`kind` changes real mark geometry: line draws stroked paths and points, area
adds a baseline fill, and bar draws grouped rectangles. For bars,
`strokeWidth` is the border and `pointRadius` is the corner radius. Grid,
legend visibility, colors, and reveal are executable controls, not metadata.
The background paints only the declared plot rectangle; the chart retains the
full composition coordinate system for labels and legend but cannot cover
unrelated layers outside the plot.

## Preparation, identity, inspect, and cache behavior

Static preparation performs locked-byte verification, query validation and
evaluation, exact mark/tick geometry, locked-font shaping and measurement,
collision resolution, legend flow, and outline retention once. Per-frame
rendering samples only the exact `reveal` ratio, derives the visible mark clip,
and emits the deterministic frame. Animating reveal therefore does not rerun
the query or reshape fonts for every frame.

The public compiler lowers every constructor into closed typed IR. `cut
inspect` can report the component, query structure, resource references,
signals, and semantic identities; source paths are not smuggled into a private
render document. Formatting and comments do not change semantic identity.
Prepared identity separately binds locked table/font resources, query result,
scale/mark geometry, typography/measurement, resolved layout, complete style,
and the versioned chart algorithm. Reveal enters only frame identity. These
identities participate in normal inspect/diff and scene-cache behavior, so a
table, font, scale, style, or reveal change invalidates the affected chart
while an unrelated scene remains reusable.

Determinism here is semantic/pixel-plan determinism under the locked CUT
runtime and toolchain. It is not a claim that independently encoded video
containers are byte-identical across every codec build.

## Stable diagnostics and work limits

Scalar `Chart` retains `CUT_CHART_INPUT_TYPE`, `CUT_CHART_VALUE_RANGE`,
`CUT_CHART_COMBINATION`, and `CUT_CHART_LIMIT` for its smaller public
contract.

Public source/check errors retain source locations. Table/resource/schema/cell
failures use stable `CUT_TABLE_*` codes; checked-plan/type/cardinality failures
use `CUT_QUERY_*`; scale/layout failures use `CUT_DATA_LAYOUT_*`; retained
chart failures use `CUT_SERIES_CHART_*`. Important chart codes include:

- `CUT_SERIES_CHART_RESOURCE_STATE` and
  `CUT_SERIES_CHART_RESOURCE_INTEGRITY` for missing lock state or mismatched
  table/font identity;
- `CUT_SERIES_CHART_QUERY` and `CUT_SERIES_CHART_UNKNOWN_FIELD` for a query or
  displayed series field that cannot execute;
- `CUT_SERIES_CHART_STYLE`, `CUT_SERIES_CHART_GEOMETRY`, and
  `CUT_SERIES_CHART_NOOP` for ignored, invisible, colliding, or out-of-bounds
  authored state;
- `CUT_SERIES_CHART_REVEAL` for progress outside the exact unit interval;
- `CUT_SERIES_CHART_IDENTITY` for stale prepared/query/font identity; and
- `CUT_SERIES_CHART_LIMIT` for bounded-work exhaustion.

The current retained `SeriesChart` ceiling is 512 marks, 8 locked table
sources, 4 MiB per table, 8 MiB total table bytes, 4 MiB of font bytes,
200,000 outline commands, 4 MiB of outline paths, 8 MiB of SVG, and 16,384 px
per canvas axis. Public chart execution further caps a source at 4,096 rows
and 65,536 cells and a result at 8,192 cells. JSON structure, fields, query
steps/predicates, join rows, groups, rational digits, font glyphs, boundary
depth, and boundary node count are also bounded before large allocation.

Unknown arguments and closed-record fields fail. Accepted arguments may not be
silently ignored. Fully transparent or background-equivalent visible paint,
all-zero-height bars, invalid domains, impossible label/legend layout, stale
hashes, and over-budget work fail rather than producing misleading output.

## Deliberate limits

This alpha supports unstacked bar, line, and area charts. It does not yet
provide stacked/group-normalized semantics, scatter/bubble plots, pies/donuts,
histograms, mixed mark kinds in one component, secondary axes, uncertainty
bands, arbitrary formula columns, locale-sensitive formatting, interactive
tooltips, or accessibility metadata. It does not infer units, choose a color
system, discover a story, rewrite labels, place surrounding annotations, or
guarantee a responsive composition automatically. Authors must still design
the frame, scale domains, series names, visual hierarchy, accessibility
alternative, pacing, and relationship to the surrounding scene.

Categorical and date axes, deterministic log scales, data-bound tick labels,
locked-font outlines, collision thinning, legends, and multiple named series
are executable `SeriesChart` semantics. They must not be claimed for the
smaller scalar `Chart`, and their existence is not a creative-pass claim.

Executable evidence is in `tests/data-series-chart-language.test.ts`,
`tests/reference-series-chart-core.test.ts`,
`tests/reference-series-chart-public-studies.test.ts`,
`tests/reference-chart.test.ts`, and the two studies linked above. The
separate code-authored keyed-bar layout for ordinary `Rect` nodes remains
documented in
[Public keyed bar layout](DATA_LAYOUT.md).
