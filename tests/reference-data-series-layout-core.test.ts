import assert from "node:assert/strict";
import test from "node:test";
import { hash } from "../lib/core/stable";
import type {
  CutEvaluatedTableQuery,
  CutExactNumber,
  CutQuerySeriesPoint,
  CutQuerySeriesSchema,
} from "../lib/language/table-query";
import { compareRational, rational, type Rational } from "../lib/language/rational";
import {
  createCutDataSeriesGeometryPlan,
  createCutLockedTextMeasurementReceipt,
  CutDataSeriesLayoutError,
  resolveCutDataSeriesLayout,
  type CutDataSeriesGeometryPlan,
  type CutDataSeriesLayoutSpec,
} from "../lib/runtime/reference/data-series-layout";

const digest = (character: string) => character.repeat(64);
const number = (numerator: number | string | bigint, denominator: number | string | bigint = 1): CutExactNumber => Object.freeze(rational(numerator, denominator));
const keyType = Object.freeze({ kind: "string" as const, maxBytes: 64 });

function query(
  xType: CutQuerySeriesSchema["x"]["type"],
  points: readonly Readonly<{ id: string; x: CutQuerySeriesPoint["x"]; values: Readonly<Record<string, CutExactNumber>> }>[] ,
  valueNames = ["primary", "secondary"],
): Extract<CutEvaluatedTableQuery, { kind: "series" }> {
  const schema: CutQuerySeriesSchema = Object.freeze({
    key: Object.freeze([{ name: "id", type: keyType }]),
    x: Object.freeze({ name: "x", type: xType }),
    values: Object.freeze(valueNames.map((name) => Object.freeze({ name, type: Object.freeze({ kind: "number" as const }) }))),
  });
  const normalizedPoints = Object.freeze(points.map((point) => Object.freeze({
    key: Object.freeze({ id: point.id }),
    x: point.x,
    values: Object.freeze({ ...point.values }),
  })));
  const planId = digest("a"), sources = Object.freeze([{ name: "facts", tableId: digest("b") }]);
  const identity = { format: "cut-query-result-identity", version: 1, kind: "series", planId, sources, schema, points: normalizedPoints };
  return Object.freeze({
    format: "cut-query-result",
    version: 1,
    kind: "series",
    id: hash(identity),
    planId,
    sources,
    schema,
    points: normalizedPoints,
  });
}

function linearSpec(overrides: Partial<CutDataSeriesLayoutSpec> = {}): CutDataSeriesLayoutSpec {
  return Object.freeze({
    format: "cut-data-series-layout-spec",
    version: 1,
    plot: Object.freeze({ x: 10, y: 20, width: 200, height: 100 }),
    xScale: Object.freeze({
      kind: "linear" as const,
      domain: Object.freeze({ min: number(0), max: number(1) }),
      ticks: Object.freeze({ count: 3, format: Object.freeze({ kind: "fraction" as const }) }),
    }),
    yScale: Object.freeze({
      kind: "linear" as const,
      domain: Object.freeze({ min: number(0), max: number(100) }),
      ticks: Object.freeze({ count: 3, format: Object.freeze({ kind: "decimal" as const, fractionDigits: 0, trimTrailingZeros: true }) }),
    }),
    series: Object.freeze([
      Object.freeze({ field: "primary", name: "Primary" }),
      Object.freeze({ field: "secondary", name: "Secondary" }),
    ]),
    tickLabelGapSubpx: 128,
    legend: Object.freeze({ x: 10, y: 130, maxWidth: 180, itemGap: 8, rowGap: 4, swatchSize: 10, swatchGap: 4, maxRows: 4 }),
    ...overrides,
  });
}

function baseLinearQuery() {
  return query(
    Object.freeze({ kind: "number" as const }),
    [
      { id: "a", x: number(0), values: { primary: number(0), secondary: number(100) } },
      { id: "b", x: number(1, 2), values: { primary: number(50), secondary: number(50) } },
      { id: "c", x: number(1), values: { primary: number(100), secondary: number(0) } },
    ],
  );
}

function measurements(plan: CutDataSeriesGeometryPlan, widthSubpx = 640, heightSubpx = 640) {
  return plan.measurementRequests.map((request) => ({ id: request.id, widthSubpx, heightSubpx }));
}

function receipt(plan: CutDataSeriesGeometryPlan, widthSubpx = 640, heightSubpx = 640) {
  return createCutLockedTextMeasurementReceipt(
    plan,
    { resourceId: "locked_font", sha256: digest("c"), faceIndex: 0, shaperIdentity: digest("d") },
    measurements(plan, widthSubpx, heightSubpx),
  );
}

function expectCode(code: CutDataSeriesLayoutError["code"], path?: RegExp) {
  return (error: unknown) => error instanceof CutDataSeriesLayoutError
    && error.code === code
    && (path === undefined || path.test(error.path));
}

test("linear geometry maps exact rational marks, ticks, and two named series without rendering", () => {
  const plan = createCutDataSeriesGeometryPlan(baseLinearQuery(), linearSpec());
  assert.equal(plan.format, "cut-data-series-geometry-plan");
  assert.equal(plan.algorithm, "cut-data-series-layout-v1");
  assert.deepEqual(plan.scales.x.ticks.map((tick) => tick.label), ["0", "1/2", "1"]);
  assert.deepEqual(plan.scales.y.ticks.map((tick) => tick.label), ["0", "50", "100"]);
  assert.deepEqual(plan.series.map((item) => [item.field, item.name]), [["primary", "Primary"], ["secondary", "Secondary"]]);
  assert.equal(plan.marks.length, 6);
  assert.deepEqual(plan.marks.filter((mark) => mark.seriesField === "primary").map((mark) => mark.x), [rational(10), rational(110), rational(210)]);
  assert.deepEqual(plan.marks.filter((mark) => mark.seriesField === "primary").map((mark) => mark.y), [rational(120), rational(70), rational(20)]);
  assert.equal(plan.measurementRequests.length, 8);
  assert.deepEqual(createCutDataSeriesGeometryPlan(baseLinearQuery(), linearSpec()), plan, "phase one is deterministic and deeply immutable");
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.marks));
});

test("a terminal series may use the same typed field as its key and x role", () => {
  const schema: CutQuerySeriesSchema = Object.freeze({
    key: Object.freeze([{ name: "day", type: keyType }]),
    x: Object.freeze({ name: "day", type: keyType }),
    values: Object.freeze([{ name: "signal", type: Object.freeze({ kind: "number" as const }) }]),
  });
  const points = Object.freeze([
    Object.freeze({ key: Object.freeze({ day: "one" }), x: "one", values: Object.freeze({ signal: number(2) }) }),
    Object.freeze({ key: Object.freeze({ day: "two" }), x: "two", values: Object.freeze({ signal: number(4) }) }),
  ]);
  const planId = digest("e"), sources = Object.freeze([{ name: "facts", tableId: digest("f") }]);
  const data = Object.freeze({
    format: "cut-query-result" as const,
    version: 1 as const,
    kind: "series" as const,
    id: hash({ format: "cut-query-result-identity", version: 1, kind: "series", planId, sources, schema, points }),
    planId,
    sources,
    schema,
    points,
  });
  const geometry = createCutDataSeriesGeometryPlan(data, linearSpec({
    xScale: Object.freeze({ kind: "categorical", order: "first-seen" }),
    yScale: Object.freeze({ kind: "linear", domain: Object.freeze({ min: number(0), max: number(4) }), ticks: Object.freeze({ count: 3, format: Object.freeze({ kind: "fraction" }) }) }),
    series: Object.freeze([{ field: "signal", name: "Signal" }]),
  }));
  assert.deepEqual(geometry.scales.x.ticks.map((tick) => tick.label), ["one", "two"]);
  assert.equal(geometry.marks.length, 2);
});

test("categorical order is stable first-seen order and repeated categories share one exact band center", () => {
  const data = query(
    Object.freeze({ kind: "string" as const, maxBytes: 64 }),
    [
      { id: "one", x: "beta", values: { primary: number(1) } },
      { id: "two", x: "alpha", values: { primary: number(2) } },
      { id: "three", x: "beta", values: { primary: number(3) } },
      { id: "four", x: "gamma", values: { primary: number(4) } },
    ],
    ["primary"],
  );
  const spec = linearSpec({
    xScale: Object.freeze({ kind: "categorical", order: "first-seen" }),
    yScale: Object.freeze({ kind: "linear", domain: Object.freeze({ min: number(0), max: number(5) }), ticks: Object.freeze({ count: 2, format: Object.freeze({ kind: "fraction" }) }) }),
    series: Object.freeze([{ field: "primary", name: "Observed" }]),
  });
  const plan = createCutDataSeriesGeometryPlan(data, spec);
  assert.deepEqual(plan.scales.x.ticks.map((tick) => tick.label), ["beta", "alpha", "gamma"]);
  assert.deepEqual(plan.marks.map((mark) => mark.x), [rational(130, 3), rational(110), rational(130, 3), rational(530, 3)]);
});

test("date ticks use explicit proleptic-Gregorian month stepping and preserve the original anchor day", () => {
  const data = query(
    Object.freeze({ kind: "date" as const }),
    [
      { id: "jan", x: "2023-01-31", values: { primary: number(1) } },
      { id: "feb", x: "2023-02-28", values: { primary: number(2) } },
      { id: "mar", x: "2023-03-31", values: { primary: number(3) } },
    ],
    ["primary"],
  );
  const spec = linearSpec({
    xScale: Object.freeze({
      kind: "date",
      domain: Object.freeze({ min: "2023-01-31", max: "2023-03-31" }),
      ticks: Object.freeze({ interval: "month", step: 1, format: "iso-date" }),
    }),
    yScale: Object.freeze({ kind: "linear", domain: Object.freeze({ min: number(0), max: number(4) }), ticks: Object.freeze({ count: 2, format: Object.freeze({ kind: "fraction" }) }) }),
    series: Object.freeze([{ field: "primary", name: "Calendar" }]),
  });
  const plan = createCutDataSeriesGeometryPlan(data, spec);
  assert.deepEqual(plan.scales.x.ticks.map((tick) => tick.label), ["2023-01-31", "2023-02-28", "2023-03-31"]);
  for (let index = 1; index < plan.scales.x.ticks.length; index += 1) {
    assert.equal(compareRational(plan.scales.x.ticks[index - 1].coordinate, plan.scales.x.ticks[index].coordinate), -1);
  }
  assert.deepEqual(plan.marks.map((mark) => mark.x), plan.scales.x.ticks.map((tick) => tick.coordinate));
});

test("log scales are positive-only, decade ticks are deterministic, and interior mapping is monotonic", () => {
  const data = query(
    Object.freeze({ kind: "number" as const }),
    [
      { id: "a", x: number(1, 10), values: { primary: number(1, 10) } },
      { id: "b", x: number(1), values: { primary: number(1) } },
      { id: "c", x: number(10), values: { primary: number(10) } },
      { id: "d", x: number(1_000), values: { primary: number(1_000) } },
    ],
    ["primary"],
  );
  const logarithmic = Object.freeze({ kind: "log" as const, domain: Object.freeze({ min: number(1, 10), max: number(1_000) }), ticks: Object.freeze({ format: Object.freeze({ kind: "fraction" as const }) }) });
  const spec = linearSpec({ xScale: logarithmic, yScale: logarithmic, series: Object.freeze([{ field: "primary", name: "Log" }]) });
  const plan = createCutDataSeriesGeometryPlan(data, spec);
  assert.deepEqual(plan.scales.x.ticks.map((tick) => tick.label), ["1/10", "1", "10", "100", "1000"]);
  assert.deepEqual(plan.marks[0].x, rational(10));
  assert.deepEqual(plan.marks.at(-1)!.x, rational(210));
  for (let index = 1; index < plan.marks.length; index += 1) assert.equal(compareRational(plan.marks[index - 1].x, plan.marks[index].x), -1);
  assert.deepEqual(createCutDataSeriesGeometryPlan(data, spec), plan);

  const invalidDomain = structuredClone(spec) as unknown as Record<string, unknown>;
  (invalidDomain.xScale as { domain: { min: Rational } }).domain.min = rational(0);
  assert.throws(() => createCutDataSeriesGeometryPlan(data, invalidDomain), expectCode("CUT_DATA_LAYOUT_DOMAIN", /xScale.*min/u));

  const invalidValue = query(Object.freeze({ kind: "number" }), [{ id: "zero", x: number(0), values: { primary: number(1) } }], ["primary"]);
  assert.throws(() => createCutDataSeriesGeometryPlan(invalidValue, spec), expectCode("CUT_DATA_LAYOUT_DOMAIN", /points\[0\]\.x/u));
});

test("exact formatting uses rational arithmetic and half-even decimal rounding", () => {
  const data = query(
    Object.freeze({ kind: "number" as const }),
    [
      { id: "low", x: number(1, 2), values: { primary: number(0) } },
      { id: "high", x: number(5, 2), values: { primary: number(1) } },
    ],
    ["primary"],
  );
  const spec = linearSpec({
    xScale: Object.freeze({
      kind: "linear",
      domain: Object.freeze({ min: number(1, 2), max: number(5, 2) }),
      ticks: Object.freeze({ count: 2, format: Object.freeze({ kind: "decimal", fractionDigits: 0, trimTrailingZeros: true }) }),
    }),
    yScale: Object.freeze({ kind: "linear", domain: Object.freeze({ min: number(0), max: number(1) }), ticks: Object.freeze({ count: 2, format: Object.freeze({ kind: "fraction" }) }) }),
    series: Object.freeze([{ field: "primary", name: "Exact" }]),
  });
  const plan = createCutDataSeriesGeometryPlan(data, spec);
  assert.deepEqual(plan.scales.x.ticks.map((tick) => tick.label), ["0", "2"], "0.5 and 2.5 both round to the even integer");
  assert.deepEqual(plan.marks.map((mark) => mark.x), [rational(10), rational(210)]);
});

test("locked-font phase deterministically thins axis collisions and canonically orders measurement receipts", () => {
  const data = query(
    Object.freeze({ kind: "number" as const }),
    Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, x: number(index, 4), values: { primary: number(index) } })),
    ["primary"],
  );
  const spec = linearSpec({
    plot: Object.freeze({ x: 0, y: 0, width: 100, height: 100 }),
    xScale: Object.freeze({ kind: "linear", domain: Object.freeze({ min: number(0), max: number(1) }), ticks: Object.freeze({ count: 5, format: Object.freeze({ kind: "fraction" }) }) }),
    yScale: Object.freeze({ kind: "linear", domain: Object.freeze({ min: number(0), max: number(4) }), ticks: Object.freeze({ count: 2, format: Object.freeze({ kind: "fraction" }) }) }),
    series: Object.freeze([{ field: "primary", name: "Series" }]),
    tickLabelGapSubpx: 0,
  });
  const plan = createCutDataSeriesGeometryPlan(data, spec), measured = measurements(plan, 2_560, 640);
  const firstReceipt = createCutLockedTextMeasurementReceipt(plan, { resourceId: "locked_font", sha256: digest("c"), faceIndex: 0, shaperIdentity: digest("d") }, measured);
  const reversedReceipt = createCutLockedTextMeasurementReceipt(plan, { resourceId: "locked_font", sha256: digest("c"), faceIndex: 0, shaperIdentity: digest("d") }, [...measured].reverse());
  assert.deepEqual(reversedReceipt, firstReceipt, "receipt identity is insensitive to caller array order");
  const layout = resolveCutDataSeriesLayout(plan, firstReceipt);
  assert.deepEqual(layout.axes.x.map((item) => item.visible), [true, false, true, false, true]);
  assert.deepEqual(resolveCutDataSeriesLayout(plan, firstReceipt), layout);
});

test("legend wrapping is bounded, ordered, and driven only by supplied measurement extents", () => {
  const plan = createCutDataSeriesGeometryPlan(baseLinearQuery(), linearSpec({
    legend: Object.freeze({ x: 10, y: 130, maxWidth: 70, itemGap: 8, rowGap: 4, swatchSize: 10, swatchGap: 4, maxRows: 2 }),
  }));
  const measured = measurements(plan, 640, 640).map((item) => plan.series.some((series) => series.measurementId === item.id) ? { ...item, widthSubpx: 2_560 } : item);
  const layout = resolveCutDataSeriesLayout(plan, createCutLockedTextMeasurementReceipt(
    plan,
    { resourceId: "locked_font", sha256: digest("c"), faceIndex: 0, shaperIdentity: digest("d") },
    measured,
  ));
  assert.deepEqual(layout.legend.map((item) => item.row), [0, 1]);
  assert.equal(layout.legend[0].xSubpx, 640);
  assert.equal(layout.legend[1].xSubpx, 640);
  assert.ok(layout.legend[1].ySubpx > layout.legend[0].ySubpx);
});

test("identity stays localized across legend names and measurement-only revisions", () => {
  const data = baseLinearQuery(), first = createCutDataSeriesGeometryPlan(data, linearSpec());
  const renamed = createCutDataSeriesGeometryPlan(data, linearSpec({
    series: Object.freeze([{ field: "primary", name: "Signal" }, { field: "secondary", name: "Baseline" }]),
  }));
  assert.notEqual(first.id, renamed.id);
  assert.deepEqual(first.marks.map((mark) => mark.id), renamed.marks.map((mark) => mark.id), "legend copy cannot invalidate mark geometry");
  assert.equal(first.scales.x.id, renamed.scales.x.id);
  assert.equal(first.scales.y.id, renamed.scales.y.id);

  const narrow = resolveCutDataSeriesLayout(first, receipt(first, 320, 640));
  const wide = resolveCutDataSeriesLayout(first, receipt(first, 640, 640));
  assert.notEqual(narrow.id, wide.id);
  assert.equal(narrow.planId, wide.planId);
  assert.equal(first.id, narrow.planId);
});

test("closed contracts reject unknown fields, empty/no-op input, invalid domains, stale identities, and impossible endpoints", () => {
  const data = baseLinearQuery();
  const unknown = { ...linearSpec(), privateTemplate: "hidden" };
  assert.throws(() => createCutDataSeriesGeometryPlan(data, unknown), expectCode("CUT_DATA_LAYOUT_UNKNOWN_FIELD", /privateTemplate/u));

  const equalDomain = structuredClone(linearSpec()) as unknown as Record<string, unknown>;
  (equalDomain.xScale as { domain: { max: Rational } }).domain.max = rational(0);
  assert.throws(() => createCutDataSeriesGeometryPlan(data, equalDomain), expectCode("CUT_DATA_LAYOUT_DOMAIN", /xScale.*domain/u));

  const emptySchema = data.schema, emptySources = data.sources, emptyIdentity = {
    format: "cut-query-result-identity", version: 1, kind: "series", planId: data.planId, sources: emptySources, schema: emptySchema, points: [],
  };
  const empty = { ...data, id: hash(emptyIdentity), points: [] };
  assert.throws(() => createCutDataSeriesGeometryPlan(empty, linearSpec()), expectCode("CUT_DATA_LAYOUT_NOOP", /points/u));

  const tooManyCategories = query(
    Object.freeze({ kind: "string" as const, maxBytes: 64 }),
    Array.from({ length: 257 }, (_, index) => ({ id: `k${index}`, x: `category-${index}`, values: { primary: number(index) } })),
    ["primary"],
  );
  assert.throws(
    () => createCutDataSeriesGeometryPlan(tooManyCategories, linearSpec({
      xScale: Object.freeze({ kind: "categorical", order: "first-seen" }),
      yScale: Object.freeze({ kind: "linear", domain: Object.freeze({ min: number(0), max: number(256) }), ticks: Object.freeze({ count: 2, format: Object.freeze({ kind: "fraction" }) }) }),
      series: Object.freeze([{ field: "primary", name: "Categories" }]),
    })),
    expectCode("CUT_DATA_LAYOUT_LIMIT", /points/u),
  );

  const duplicateDateLabels = query(
    Object.freeze({ kind: "date" as const }),
    [
      { id: "d1", x: "2023-01-01", values: { primary: number(1) } },
      { id: "d2", x: "2023-01-03", values: { primary: number(2) } },
    ],
    ["primary"],
  );
  assert.throws(
    () => createCutDataSeriesGeometryPlan(duplicateDateLabels, linearSpec({
      xScale: Object.freeze({ kind: "date", domain: Object.freeze({ min: "2023-01-01", max: "2023-01-03" }), ticks: Object.freeze({ interval: "day", step: 1, format: "year" }) }),
      yScale: Object.freeze({ kind: "linear", domain: Object.freeze({ min: number(0), max: number(3) }), ticks: Object.freeze({ count: 2, format: Object.freeze({ kind: "fraction" }) }) }),
      series: Object.freeze([{ field: "primary", name: "Dates" }]),
    })),
    expectCode("CUT_DATA_LAYOUT_LABEL", /xScale.*ticks/u),
  );

  const plan = createCutDataSeriesGeometryPlan(data, linearSpec());
  const stale = structuredClone(plan);
  (stale.plot as { width: number }).width += 1;
  assert.throws(() => createCutLockedTextMeasurementReceipt(stale, { resourceId: "locked_font", sha256: digest("c"), faceIndex: 0, shaperIdentity: digest("d") }, measurements(plan)), expectCode("CUT_DATA_LAYOUT_IDENTITY", /plan\.id/u));

  assert.throws(
    () => createCutLockedTextMeasurementReceipt(plan, { resourceId: "locked_font", sha256: digest("c"), faceIndex: 0, shaperIdentity: digest("d") }, measurements(plan).slice(1)),
    expectCode("CUT_DATA_LAYOUT_MEASUREMENT", /measurements/u),
  );

  const unknownMeasurement = measurements(plan);
  assert.throws(
    () => createCutLockedTextMeasurementReceipt(
      plan,
      { resourceId: "locked_font", sha256: digest("c"), faceIndex: 0, shaperIdentity: digest("d") },
      unknownMeasurement.map((item, index) => index === 0 ? { ...item, browserWidth: item.widthSubpx } : item),
    ),
    expectCode("CUT_DATA_LAYOUT_UNKNOWN_FIELD", /browserWidth/u),
  );

  const colliding = resolveCutDataSeriesLayout.bind(undefined, plan, receipt(plan, 20_000, 640));
  assert.throws(colliding, expectCode("CUT_DATA_LAYOUT_COLLISION", /measurements/u));
});

test("every JavaScript data boundary rejects executable and exotic shapes without invoking supplied code", () => {
  let queryGetterCalls = 0;
  const accessorQuery = structuredClone(baseLinearQuery()) as unknown as Record<string, unknown>;
  Object.defineProperty(accessorQuery, "id", {
    configurable: true,
    enumerable: true,
    get() { queryGetterCalls += 1; return digest("a"); },
  });
  assert.throws(() => createCutDataSeriesGeometryPlan(accessorQuery, linearSpec()), expectCode("CUT_DATA_LAYOUT_TYPE", /query\.id/u));
  assert.equal(queryGetterCalls, 0, "query getter was rejected by descriptor without execution");

  let seriesGetterCalls = 0;
  const accessorSpec = structuredClone(linearSpec()) as unknown as { series: unknown[] };
  Object.defineProperty(accessorSpec.series, "0", {
    configurable: true,
    enumerable: true,
    get() { seriesGetterCalls += 1; return { field: "primary", name: "Primary" }; },
  });
  assert.throws(() => createCutDataSeriesGeometryPlan(baseLinearQuery(), accessorSpec), expectCode("CUT_DATA_LAYOUT_TYPE", /spec\.series\[0\]/u));
  assert.equal(seriesGetterCalls, 0, "array getter was rejected by descriptor without execution");

  let proxyTrapCalls = 0;
  const proxySpec = new Proxy(structuredClone(linearSpec()), {
    get(target, property, receiver) { proxyTrapCalls += 1; return Reflect.get(target, property, receiver); },
    getOwnPropertyDescriptor(target, property) { proxyTrapCalls += 1; return Reflect.getOwnPropertyDescriptor(target, property); },
    getPrototypeOf(target) { proxyTrapCalls += 1; return Reflect.getPrototypeOf(target); },
    ownKeys(target) { proxyTrapCalls += 1; return Reflect.ownKeys(target); },
  });
  assert.throws(() => createCutDataSeriesGeometryPlan(baseLinearQuery(), proxySpec), expectCode("CUT_DATA_LAYOUT_TYPE", /^\$\.spec$/u));
  assert.equal(proxyTrapCalls, 0, "proxy recognition did not invoke a proxy trap");

  const symbolSpec = structuredClone(linearSpec()) as unknown as Record<PropertyKey, unknown>;
  symbolSpec[Symbol("hidden")] = true;
  assert.throws(() => createCutDataSeriesGeometryPlan(baseLinearQuery(), symbolSpec), expectCode("CUT_DATA_LAYOUT_TYPE", /^\$\.spec$/u));

  const nonEnumerableSpec = structuredClone(linearSpec()) as unknown as Record<string, unknown>;
  Object.defineProperty(nonEnumerableSpec, "hidden", { enumerable: false, value: true });
  assert.throws(() => createCutDataSeriesGeometryPlan(baseLinearQuery(), nonEnumerableSpec), expectCode("CUT_DATA_LAYOUT_TYPE", /spec\.hidden/u));

  const sparseSpec = structuredClone(linearSpec()) as unknown as { series: unknown[] };
  const sparseSeries = new Array<unknown>(2);
  sparseSeries[0] = { field: "primary", name: "Primary" };
  sparseSpec.series = sparseSeries;
  assert.throws(() => createCutDataSeriesGeometryPlan(baseLinearQuery(), sparseSpec), expectCode("CUT_DATA_LAYOUT_TYPE", /spec\.series/u));

  class SeriesArray extends Array<unknown> {}
  const subclassSpec = structuredClone(linearSpec()) as unknown as { series: unknown[] };
  subclassSpec.series = new SeriesArray(...subclassSpec.series);
  assert.throws(() => createCutDataSeriesGeometryPlan(baseLinearQuery(), subclassSpec), expectCode("CUT_DATA_LAYOUT_TYPE", /spec\.series/u));

  const extendedArraySpec = structuredClone(linearSpec()) as unknown as { series: unknown[] & Record<string, unknown> };
  extendedArraySpec.series.metadata = "hidden";
  assert.throws(() => createCutDataSeriesGeometryPlan(baseLinearQuery(), extendedArraySpec), expectCode("CUT_DATA_LAYOUT_TYPE", /metadata/u));

  const exoticSpec = structuredClone(linearSpec()) as unknown as { legend: Record<string, unknown> };
  exoticSpec.legend = Object.assign(Object.create({ inherited: true }) as Record<string, unknown>, exoticSpec.legend);
  assert.throws(() => createCutDataSeriesGeometryPlan(baseLinearQuery(), exoticSpec), expectCode("CUT_DATA_LAYOUT_TYPE", /spec\.legend/u));

  const cyclicSpec = structuredClone(linearSpec()) as unknown as { legend: Record<string, unknown> };
  cyclicSpec.legend.self = cyclicSpec.legend;
  assert.throws(() => createCutDataSeriesGeometryPlan(baseLinearQuery(), cyclicSpec), expectCode("CUT_DATA_LAYOUT_TYPE", /spec\.legend\.self/u));

  const plan = createCutDataSeriesGeometryPlan(baseLinearQuery(), linearSpec());
  let planGetterCalls = 0;
  const accessorPlan = structuredClone(plan) as unknown as Record<string, unknown>;
  Object.defineProperty(accessorPlan, "id", {
    configurable: true,
    enumerable: true,
    get() { planGetterCalls += 1; return plan.id; },
  });
  assert.throws(
    () => createCutLockedTextMeasurementReceipt(accessorPlan as unknown as CutDataSeriesGeometryPlan, { resourceId: "locked_font", sha256: digest("c"), faceIndex: 0, shaperIdentity: digest("d") }, measurements(plan)),
    expectCode("CUT_DATA_LAYOUT_TYPE", /plan\.id/u),
  );
  assert.equal(planGetterCalls, 0, "geometry-plan getter was rejected without execution");

  let planProxyTrapCalls = 0;
  const planProxy = new Proxy(structuredClone(plan), {
    get(target, property, receiver) { planProxyTrapCalls += 1; return Reflect.get(target, property, receiver); },
    ownKeys(target) { planProxyTrapCalls += 1; return Reflect.ownKeys(target); },
  });
  assert.throws(
    () => createCutLockedTextMeasurementReceipt(planProxy, { resourceId: "locked_font", sha256: digest("c"), faceIndex: 0, shaperIdentity: digest("d") }, measurements(plan)),
    expectCode("CUT_DATA_LAYOUT_TYPE", /^\$\.plan$/u),
  );
  assert.equal(planProxyTrapCalls, 0, "geometry-plan proxy traps were not invoked");

  let fontGetterCalls = 0;
  const accessorFont: Record<string, unknown> = { resourceId: "locked_font", sha256: digest("c"), faceIndex: 0, shaperIdentity: digest("d") };
  Object.defineProperty(accessorFont, "resourceId", {
    configurable: true,
    enumerable: true,
    get() { fontGetterCalls += 1; return "locked_font"; },
  });
  assert.throws(() => createCutLockedTextMeasurementReceipt(plan, accessorFont, measurements(plan)), expectCode("CUT_DATA_LAYOUT_TYPE", /font\.resourceId/u));
  assert.equal(fontGetterCalls, 0, "font getter was rejected without execution");

  let measurementGetterCalls = 0;
  const accessorMeasurements = structuredClone(measurements(plan));
  Object.defineProperty(accessorMeasurements, "0", {
    configurable: true,
    enumerable: true,
    get() { measurementGetterCalls += 1; return measurements(plan)[0]; },
  });
  assert.throws(() => createCutLockedTextMeasurementReceipt(plan, { resourceId: "locked_font", sha256: digest("c"), faceIndex: 0, shaperIdentity: digest("d") }, accessorMeasurements), expectCode("CUT_DATA_LAYOUT_TYPE", /measurements\[0\]/u));
  assert.equal(measurementGetterCalls, 0, "measurement-array getter was rejected without execution");

  const validReceipt = receipt(plan);
  let receiptGetterCalls = 0;
  const accessorReceipt = structuredClone(validReceipt) as unknown as Record<string, unknown>;
  Object.defineProperty(accessorReceipt, "id", {
    configurable: true,
    enumerable: true,
    get() { receiptGetterCalls += 1; return validReceipt.id; },
  });
  assert.throws(() => resolveCutDataSeriesLayout(plan, accessorReceipt as unknown as typeof validReceipt), expectCode("CUT_DATA_LAYOUT_TYPE", /receipt\.id/u));
  assert.equal(receiptGetterCalls, 0, "receipt getter was rejected without execution");

  let receiptProxyTrapCalls = 0;
  const receiptProxy = new Proxy(structuredClone(validReceipt), {
    get(target, property, receiver) { receiptProxyTrapCalls += 1; return Reflect.get(target, property, receiver); },
    ownKeys(target) { receiptProxyTrapCalls += 1; return Reflect.ownKeys(target); },
  });
  assert.throws(() => resolveCutDataSeriesLayout(plan, receiptProxy), expectCode("CUT_DATA_LAYOUT_TYPE", /^\$\.receipt$/u));
  assert.equal(receiptProxyTrapCalls, 0, "receipt proxy traps were not invoked");
});

test("accepted plans, receipts, and layouts are immutable snapshots independent of caller aliases", () => {
  const mutableQuery = structuredClone(baseLinearQuery());
  const mutableSpec = structuredClone(linearSpec());
  const sharedZero = { numerator: "0", denominator: "1" };
  const queryAlias = mutableQuery as unknown as { points: Array<{ x: unknown; values: Record<string, { numerator: string; denominator: string }> }> };
  const specAlias = mutableSpec as unknown as { xScale: { domain: { min: unknown } }; plot: { width: number } };
  queryAlias.points[0].x = sharedZero;
  queryAlias.points[0].values.primary = sharedZero;
  specAlias.xScale.domain.min = sharedZero;

  const plan = createCutDataSeriesGeometryPlan(mutableQuery, mutableSpec);
  const acceptedPlanJson = JSON.stringify(plan);
  const acceptedPlanId = plan.id;
  sharedZero.numerator = "999";
  queryAlias.points[1].values.primary.numerator = "999";
  specAlias.plot.width = 1;
  assert.equal(JSON.stringify(plan), acceptedPlanJson);
  assert.equal(plan.id, acceptedPlanId);
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.marks[0].key) && Object.isFrozen(plan.scales.x.ticks));

  const mutablePlan = structuredClone(plan);
  const mutableFont = { resourceId: "locked_font", sha256: digest("c"), faceIndex: 0, shaperIdentity: digest("d") };
  const mutableMeasurements = structuredClone(measurements(plan));
  const lockedReceipt = createCutLockedTextMeasurementReceipt(mutablePlan, mutableFont, mutableMeasurements);
  const acceptedReceiptJson = JSON.stringify(lockedReceipt);
  (mutablePlan as unknown as { plot: { width: number } }).plot.width = 1;
  mutableFont.resourceId = "changed_font";
  mutableMeasurements[0].widthSubpx = 1;
  assert.equal(JSON.stringify(lockedReceipt), acceptedReceiptJson);
  assert.ok(Object.isFrozen(lockedReceipt) && Object.isFrozen(lockedReceipt.font) && Object.isFrozen(lockedReceipt.measurements));

  const mutableResolvePlan = structuredClone(plan);
  const mutableResolveReceipt = structuredClone(lockedReceipt);
  const layout = resolveCutDataSeriesLayout(mutableResolvePlan, mutableResolveReceipt);
  const acceptedLayoutJson = JSON.stringify(layout);
  (mutableResolvePlan as unknown as { legend: { x: number } }).legend.x = 9_999;
  (mutableResolveReceipt as unknown as { measurements: Array<{ heightSubpx: number }> }).measurements[0].heightSubpx = 1;
  assert.equal(JSON.stringify(layout), acceptedLayoutJson);
  assert.ok(Object.isFrozen(layout) && Object.isFrozen(layout.axes.x) && Object.isFrozen(layout.legend));

  const reorderedReceipt = structuredClone(lockedReceipt);
  const reorderedAlias = reorderedReceipt as unknown as { id: string; measurements: Array<unknown> };
  reorderedAlias.measurements.reverse();
  const reorderedBody = Object.fromEntries(Object.entries(reorderedReceipt).filter(([name]) => name !== "id"));
  reorderedAlias.id = hash(reorderedBody);
  assert.throws(() => resolveCutDataSeriesLayout(plan, reorderedReceipt), expectCode("CUT_DATA_LAYOUT_MEASUREMENT", /receipt\.measurements\[0\]/u));
});
