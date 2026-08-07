import assert from "node:assert/strict";
import test from "node:test";
import { hash, stableStringify } from "../lib/core/stable";
import {
  CutDataLayoutError,
  cutBarLayoutLimits,
  decodeCutBarLayout,
  decodeCutKeyedNumber,
  decodeCutMarkTarget,
  deriveCutBarLayout,
  formatCutNumber,
  joinCutBarLayoutTargets,
  type CutDataLayoutErrorCode,
} from "../lib/language/data-layout";
import type { IRValue } from "../lib/language/ir";
import { rational, type Rational } from "../lib/language/rational";

function scalar(numerator: bigint | number | string, denominator: bigint | number | string = 1): IRValue {
  return { kind: "quantity", dimension: "scalar", magnitude: rational(numerator, denominator), unit: "scalar" };
}

function px(numerator: bigint | number | string, denominator: bigint | number | string = 1): IRValue {
  return { kind: "quantity", dimension: "length", magnitude: rational(numerator, denominator), unit: "px" };
}

function ratio(numerator: bigint | number | string, denominator: bigint | number | string = 1): IRValue {
  return { kind: "quantity", dimension: "ratio", magnitude: rational(numerator, denominator), unit: "ratio" };
}

function string(value: string): IRValue { return { kind: "string", value }; }
function object(entries: Record<string, IRValue>): IRValue { return { kind: "object", entries }; }
function array(items: IRValue[]): IRValue { return { kind: "array", items }; }

function datum(key: string, label: string, value: number): IRValue {
  return object({ key: string(key), label: string(label), value: scalar(value) });
}

function target(key: string, x: number | Rational, y: number | Rational): IRValue {
  const quantity = (value: number | Rational) => typeof value === "number"
    ? px(value)
    : { kind: "quantity" as const, dimension: "length", magnitude: value, unit: "px" };
  return object({ key: string(key), x: quantity(x), y: quantity(y) });
}

function input(data: IRValue[] = [datum("a", "A", 18), datum("b", "B", 32), datum("c", "C", 26), datum("d", "D", 44)]): IRValue {
  return object({
    data: array(data),
    x: px(310),
    y: px(290),
    width: px(520),
    height: px(240),
    min: scalar(0),
    max: scalar(50),
    gap: ratio(3, 10),
    padding: px(0),
  });
}

function expectError(work: () => unknown, code: CutDataLayoutErrorCode, path?: string | RegExp, message?: RegExp) {
  assert.throws(work, (error: unknown) => {
    assert.ok(error instanceof CutDataLayoutError);
    assert.equal(error.code, code);
    if (typeof path === "string") assert.equal(error.path, path);
    else if (path) assert.match(error.path, path);
    if (message) assert.match(error.message, message);
    return true;
  });
}

function clone<T>(value: T): T { return structuredClone(value); }

test("keyed bar layout derives exact public mark geometry and a stable tagged identity", () => {
  const first = deriveCutBarLayout(input(), "$.layoutCall");
  const second = deriveCutBarLayout(input(), "$.otherSourceSpan");
  assert.equal(stableStringify(first), stableStringify(second), "source path must not enter semantic identity");

  const layout = decodeCutBarLayout(first, "$.node.inputs.layout");
  assert.equal(layout.format, "cut-bar-layout");
  assert.equal(layout.version, 1);
  assert.match(layout.id, /^[a-f0-9]{64}$/u);
  assert.deepEqual(layout.marks.map((mark) => mark.key), ["a", "b", "c", "d"]);
  assert.deepEqual(layout.marks.map((mark) => mark.x), [rational(115), rational(245), rational(375), rational(505)]);
  assert.deepEqual(layout.marks.map((mark) => mark.width), Array.from({ length: 4 }, () => rational(91)));
  assert.deepEqual(layout.domain, { minimum: rational(0), maximum: rational(50), baseline: rational(0) });
  assert.deepEqual(layout.plot, { left: rational(50), top: rational(170), width: rational(520), height: rational(240) });
  assert.deepEqual(layout.marks[0] && {
    top: layout.marks[0].top,
    bottom: layout.marks[0].bottom,
    height: layout.marks[0].height,
    y: layout.marks[0].y,
  }, {
    top: rational(1_618, 5),
    bottom: rational(410),
    height: rational(432, 5),
    y: rational(1_834, 5),
  });
});

test("strict keyed-number and target decoders reject unknown fields, unsafe keys, controls, types, and noncanonical rationals", () => {
  const extra = datum("a", "A", 1);
  assert.equal(extra.kind, "object");
  extra.entries.ignored = scalar(1);
  expectError(() => decodeCutKeyedNumber(extra, "$.datum"), "CUT_DATA_KEY_TYPE", "$.datum.ignored", /unknown field/);

  expectError(
    () => decodeCutKeyedNumber(object({ key: string("bad key"), label: string("A"), value: scalar(1) }), "$.datum"),
    "CUT_DATA_KEY_VALUE",
    "$.datum.key",
  );
  expectError(
    () => decodeCutKeyedNumber(object({ key: string("a"), label: string("line\nbreak"), value: scalar(1) }), "$.datum"),
    "CUT_DATA_KEY_VALUE",
    "$.datum.label",
  );
  expectError(
    () => decodeCutKeyedNumber(object({ key: string("a"), label: string("A"), value: px(1) }), "$.datum"),
    "CUT_DATA_KEY_TYPE",
    "$.datum.value",
  );
  const noncanonical: IRValue = { kind: "quantity", dimension: "length", magnitude: { numerator: "2", denominator: "2" }, unit: "px" };
  expectError(
    () => decodeCutMarkTarget(object({ key: string("a"), x: noncanonical, y: px(1) }), "$.target"),
    "CUT_BAR_TARGET_TYPE",
    "$.target.x.magnitude",
    /reduced/,
  );
});

test("layout input is closed and duplicate keys fail at their exact list path", () => {
  const unknown = input();
  assert.equal(unknown.kind, "object");
  unknown.entries.privateGeometry = px(1);
  expectError(() => deriveCutBarLayout(unknown, "$.call"), "CUT_BAR_LAYOUT_TYPE", "$.call.privateGeometry", /unknown field/);

  expectError(
    () => deriveCutBarLayout(input([datum("same", "First", 1), datum("same", "Second", 2)]), "$.call"),
    "CUT_DATA_KEY_DUPLICATE",
    "$.call.data[1].key",
    /first declared/,
  );
});

test("domain, frame, padding, gap, and minimum visible-width boundaries fail instead of clamping", () => {
  const reversed = input();
  assert.equal(reversed.kind, "object");
  reversed.entries.min = scalar(50);
  reversed.entries.max = scalar(0);
  expectError(() => deriveCutBarLayout(reversed, "$.call"), "CUT_BAR_LAYOUT_DOMAIN", "$.call.max");

  const outside = input();
  assert.equal(outside.kind, "object");
  outside.entries.max = scalar(40);
  expectError(() => deriveCutBarLayout(outside, "$.call"), "CUT_BAR_LAYOUT_DOMAIN", "$.call.data[3].value");

  const padding = input();
  assert.equal(padding.kind, "object");
  padding.entries.padding = px(120);
  expectError(() => deriveCutBarLayout(padding, "$.call"), "CUT_BAR_LAYOUT_GEOMETRY", "$.call.padding");

  const gap = input();
  assert.equal(gap.kind, "object");
  gap.entries.gap = ratio(19, 20);
  expectError(() => deriveCutBarLayout(gap, "$.call"), "CUT_BAR_LAYOUT_GEOMETRY", "$.call.gap");

  const thin = input();
  assert.equal(thin.kind, "object");
  thin.entries.width = px(2);
  expectError(() => deriveCutBarLayout(thin, "$.call"), "CUT_BAR_LAYOUT_GEOMETRY", "$.call.gap", /0\.5px/);

  const escapedFrame = input();
  assert.equal(escapedFrame.kind, "object");
  escapedFrame.entries.x = px(65_536);
  expectError(() => deriveCutBarLayout(escapedFrame, "$.call"), "CUT_BAR_LAYOUT_GEOMETRY", "$.call", /right edge/);
});

test("layout budgets reject oversized collections and exact rational amplification", () => {
  const many = Array.from({ length: cutBarLayoutLimits.maximumItems + 1 }, (_, index) => datum(`k${index}`, `Item ${index}`, 1));
  expectError(() => deriveCutBarLayout(input(many), "$.call"), "CUT_BAR_LAYOUT_LIMIT", "$.call.data");

  const hugeDenominator = `1${"0".repeat(cutBarLayoutLimits.maximumRationalDigits)}`;
  const hostile = input();
  assert.equal(hostile.kind, "object");
  hostile.entries.gap = { kind: "quantity", dimension: "ratio", magnitude: { numerator: "1", denominator: hugeDenominator }, unit: "ratio" };
  expectError(() => deriveCutBarLayout(hostile, "$.call"), "CUT_BAR_LAYOUT_LIMIT", "$.call.gap.magnitude");
});

test("loaded layouts reject unknown fields, stale ids, and re-hashed invented geometry", () => {
  const original = deriveCutBarLayout(input());

  const unknown = clone(original);
  assert.equal(unknown.kind, "object");
  unknown.entries.hidden = string("private");
  expectError(() => decodeCutBarLayout(unknown, "$.layout"), "CUT_BAR_LAYOUT_TYPE", "$.layout.hidden");

  const stale = clone(original);
  assert.equal(stale.kind, "object");
  stale.entries.id = string("0".repeat(64));
  expectError(() => decodeCutBarLayout(stale, "$.layout"), "CUT_BAR_LAYOUT_IDENTITY", "$.layout.id", /canonical layout identity/);

  const invented = clone(original);
  assert.equal(invented.kind, "object");
  assert.equal(invented.entries.marks.kind, "array");
  const firstMark = invented.entries.marks.items[0];
  assert.equal(firstMark.kind, "object");
  firstMark.entries.x = px(116);
  const semantic = clone(invented);
  assert.equal(semantic.kind, "object");
  delete semantic.entries.id;
  invented.entries.id = string(hash(semantic));
  expectError(() => decodeCutBarLayout(invented, "$.layout"), "CUT_BAR_LAYOUT_IDENTITY", "$.layout.marks[0].x", /derived/);

  const staleFromChangedData = clone(original);
  assert.equal(staleFromChangedData.kind, "object");
  assert.equal(staleFromChangedData.entries.data.kind, "array");
  const changedDatum = staleFromChangedData.entries.data.items[0];
  assert.equal(changedDatum.kind, "object");
  changedDatum.entries.value = scalar(19);
  const changedDataSemantic = clone(staleFromChangedData);
  assert.equal(changedDataSemantic.kind, "object");
  delete changedDataSemantic.entries.id;
  staleFromChangedData.entries.id = string(hash(changedDataSemantic));
  expectError(
    () => decodeCutBarLayout(staleFromChangedData, "$.layout"),
    "CUT_BAR_LAYOUT_IDENTITY",
    /^\$\.layout\.marks\[0\]/u,
    /derived/,
  );
});

test("a datum on the exact baseline intentionally retains a keyed zero-height mark", () => {
  const layout = decodeCutBarLayout(deriveCutBarLayout(input([
    datum("zero", "Zero", 0),
    datum("ten", "Ten", 10),
  ])));
  assert.equal(layout.marks[0].key, "zero");
  assert.deepEqual(layout.marks[0].height, rational(0));
  assert.deepEqual(layout.marks[0].top, layout.marks[0].baselineY);
  assert.deepEqual(layout.marks[0].bottom, layout.marks[0].baselineY);
  assert.ok(BigInt(layout.marks[1].height.numerator) > 0n);
});

test("target joining is keyed, exact-set, source-order canonical, and reorder invariant", () => {
  const layoutValue = deriveCutBarLayout(input());
  const ordered = array([
    target("a", 630, 180), target("b", 815, 180), target("c", 630, 390), target("d", 815, 390),
  ]);
  const shuffled = array([
    target("d", 815, 390), target("b", 815, 180), target("a", 630, 180), target("c", 630, 390),
  ]);
  const first = joinCutBarLayoutTargets(layoutValue, ordered, "$.transform");
  const second = joinCutBarLayoutTargets(layoutValue, shuffled, "$.transform");
  assert.equal(stableStringify(first), stableStringify(second));
  assert.equal(first.kind, "array");
  assert.deepEqual(first.items.map((item) => {
    assert.equal(item.kind, "object");
    assert.equal(item.entries.key.kind, "string");
    return item.entries.key.value;
  }), ["a", "b", "c", "d"]);
  const firstMove = first.items[0];
  assert.equal(firstMove.kind, "object");
  assert.deepEqual(Object.keys(firstMove.entries), [
    "key", "label", "value", "index", "x", "y", "width", "height",
    "left", "top", "right", "bottom", "baselineY", "targetX", "targetY",
  ]);
  assert.deepEqual(firstMove.entries.x, layoutValue.kind === "object"
    && layoutValue.entries.marks.kind === "array"
    && layoutValue.entries.marks.items[0].kind === "object"
    ? layoutValue.entries.marks.items[0].entries.x
    : undefined);
  assert.deepEqual(firstMove.entries.targetX, px(630));
  assert.deepEqual(firstMove.entries.targetY, px(180));
});

test("target joining rejects duplicates, unknowns, missing keys, and an all-stationary mapping", () => {
  const layoutValue = deriveCutBarLayout(input());
  expectError(
    () => joinCutBarLayoutTargets(layoutValue, array([target("a", 1, 1), target("a", 2, 2)]), "$.move"),
    "CUT_BAR_TARGET_DUPLICATE",
    "$.move.targets[1].key",
  );
  expectError(
    () => joinCutBarLayoutTargets(layoutValue, array([target("a", 1, 1), target("b", 2, 2), target("c", 3, 3), target("z", 4, 4)]), "$.move"),
    "CUT_BAR_TARGET_COVERAGE",
    "$.move.targets[3].key",
  );
  expectError(
    () => joinCutBarLayoutTargets(layoutValue, array([target("a", 1, 1)]), "$.move"),
    "CUT_BAR_TARGET_COVERAGE",
    "$.move.targets",
    /missing targets/,
  );

  const layout = decodeCutBarLayout(layoutValue);
  const stationary = array(layout.marks.map((mark) => target(mark.key, mark.x, mark.y)));
  expectError(
    () => joinCutBarLayoutTargets(layoutValue, stationary, "$.move"),
    "CUT_BAR_TARGET_NOOP",
    "$.move.targets",
  );
});

test("number formatting is exact, locale-independent, bounded, and rounds ties away from zero", () => {
  assert.deepEqual(formatCutNumber(scalar(201, 200), scalar(2), string("")), string("1.01"));
  assert.deepEqual(formatCutNumber(scalar(-201, 200), scalar(2), string("")), string("-1.01"));
  assert.deepEqual(formatCutNumber(scalar(-1, 10_000), scalar(2), string("%")), string("0.00%"));
  assert.deepEqual(formatCutNumber(scalar(123_456_789, 1_000), scalar(3), string(" units")), string("123456.789 units"));

  expectError(() => formatCutNumber(scalar(1), scalar(7), string(""), "$.format"), "CUT_DATA_FORMAT_RANGE", "$.format.decimals");
  expectError(() => formatCutNumber(scalar(1), scalar(2), string("€"), "$.format"), "CUT_DATA_FORMAT_RANGE", "$.format.suffix");
  expectError(() => formatCutNumber(px(1), scalar(2), string(""), "$.format"), "CUT_DATA_FORMAT_TYPE", "$.format.value");
  expectError(() => formatCutNumber(scalar(1), scalar(1, 2), string(""), "$.format"), "CUT_DATA_FORMAT_TYPE", "$.format.decimals");
});
