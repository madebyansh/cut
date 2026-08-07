import assert from "node:assert/strict";
import test from "node:test";
import { hash } from "../lib/core/stable";
import type { IRValue } from "../lib/language/ir";
import {
  CutResponsiveStackError,
  cutResponsiveStackLimits,
  decodeCutResponsiveStackPlan,
  deriveCutResponsiveStackPlan,
  type CutResponsiveStackErrorCode,
} from "../lib/language/responsive-layout";
import { rational, type Rational } from "../lib/language/rational";
import {
  referenceResponsiveStackExecution,
  referenceResponsiveStackRasterBoundary,
  referenceResponsiveStackRasterPolicy,
  referenceResponsiveStackRasterSlots,
} from "../lib/runtime/reference/responsive-layout";

function scalar(numerator: bigint | number | string, denominator: bigint | number | string = 1): IRValue {
  return { kind: "quantity", dimension: "scalar", magnitude: rational(numerator, denominator), unit: "scalar" };
}

function ratio(numerator: bigint | number | string, denominator: bigint | number | string = 1): IRValue {
  return { kind: "quantity", dimension: "ratio", magnitude: rational(numerator, denominator), unit: "ratio" };
}

function px(numerator: bigint | number | string, denominator: bigint | number | string = 1): IRValue {
  return { kind: "quantity", dimension: "length", magnitude: rational(numerator, denominator), unit: "px" };
}

function object(entries: Record<string, IRValue>): IRValue { return { kind: "object", entries }; }
function array(items: IRValue[]): IRValue { return { kind: "array", items }; }
function string(value: string): IRValue { return { kind: "string", value }; }

function input(weights: Array<number | Rational> = [2, 1], safeX: Rational = rational(1, 20), safeY: Rational = rational(1, 10), gap: Rational = rational(40)) {
  const exact = (value: number | Rational) => typeof value === "number" ? rational(value) : value;
  return object({
    weights: array(weights.map((weight) => scalar(exact(weight).numerator, exact(weight).denominator))),
    safeX: ratio(safeX.numerator, safeX.denominator),
    safeY: ratio(safeY.numerator, safeY.denominator),
    gap: px(gap.numerator, gap.denominator),
  });
}

function expectError(work: () => unknown, code: CutResponsiveStackErrorCode, path?: string | RegExp, message?: RegExp) {
  assert.throws(work, (error: unknown) => {
    assert.ok(error instanceof CutResponsiveStackError);
    assert.equal(error.code, code);
    if (typeof path === "string") assert.equal(error.path, path);
    else if (path) assert.match(error.path, path);
    if (message) assert.match(error.message, message);
    return true;
  });
}

function plan(width: number, height: number, value = input(), path = "$.call") {
  return decodeCutResponsiveStackPlan(deriveCutResponsiveStackPlan(value, { width, height }, path), "$.plan");
}

function resignInvented(value: IRValue) {
  assert.equal(value.kind, "object");
  const semantic = structuredClone(value);
  assert.equal(semantic.kind, "object");
  delete semantic.entries.id;
  value.entries.id = string(hash(semantic));
}

test("landscape planning derives exact safe bounds, gap, weighted slots, and closure", () => {
  const result = plan(1_920, 1_080);
  assert.equal(result.axis, "horizontal");
  assert.deepEqual(result.context, { width: rational(1_920), height: rational(1_080) });
  assert.deepEqual(result.content, {
    left: rational(96),
    top: rational(108),
    right: rational(1_824),
    bottom: rational(972),
    width: rational(1_728),
    height: rational(864),
  });
  assert.deepEqual(result.slots.map((slot) => ({
    left: slot.left,
    top: slot.top,
    right: slot.right,
    bottom: slot.bottom,
    width: slot.width,
    height: slot.height,
  })), [
    {
      left: rational(96), top: rational(108), right: rational(3_664, 3), bottom: rational(972),
      width: rational(3_376, 3), height: rational(864),
    },
    {
      left: rational(3_784, 3), top: rational(108), right: rational(1_824), bottom: rational(972),
      width: rational(1_688, 3), height: rational(864),
    },
  ]);
  assert.equal(result.slots[0].right.denominator, "3", "planning must retain subpixel boundaries instead of early rounding");
  assert.deepEqual(result.slots.at(-1)?.right, result.content.right, "weighted partition must close exactly");
});

test("one authored plan input reflows square and portrait contexts vertically instead of scaling a landscape row", () => {
  const square = plan(1_080, 1_080), portrait = plan(1_080, 1_920);
  for (const result of [square, portrait]) {
    assert.equal(result.axis, "vertical");
    assert.ok(result.slots[0].top.numerator !== result.slots[1].top.numerator);
    assert.deepEqual(result.slots.map((slot) => slot.width), result.slots.map(() => result.content.width));
    assert.deepEqual(result.slots.at(-1)?.bottom, result.content.bottom);
  }
  assert.notEqual(square.id, portrait.id, "active composition dimensions must enter semantic identity");
  assert.notDeepEqual(square.slots[0].height, portrait.slots[0].height, "slot-local layout height must actually reflow");
});

test("semantic identity ignores source location but binds context, weights, safe area, and gap", () => {
  const first = plan(1_920, 1_080, input(), "$.firstCall"), second = plan(1_920, 1_080, input(), "$.movedCall");
  assert.equal(first.id, second.id);
  assert.notEqual(first.id, plan(1_921, 1_080).id);
  assert.notEqual(first.id, plan(1_920, 1_080, input([1, 2])).id);
  assert.notEqual(first.id, plan(1_920, 1_080, input([2, 1], rational(1, 25))).id);
  assert.notEqual(first.id, plan(1_920, 1_080, input([2, 1], rational(1, 20), rational(1, 10), rational(41))).id);
});

test("planner rejects unknown fields, wrong units, empty/oversized lists, nonpositive weights, and hostile rationals", () => {
  const unknown = input();
  assert.equal(unknown.kind, "object");
  unknown.entries.invented = scalar(1);
  expectError(() => deriveCutResponsiveStackPlan(unknown, { width: 100, height: 100 }, "$.call"), "CUT_RESPONSIVE_STACK_PLAN_TYPE", "$.call.invented", /unknown field/);

  const wrongUnit = input();
  assert.equal(wrongUnit.kind, "object");
  wrongUnit.entries.safeX = px(1);
  expectError(() => deriveCutResponsiveStackPlan(wrongUnit, { width: 100, height: 100 }, "$.call"), "CUT_RESPONSIVE_STACK_PLAN_TYPE", "$.call.safeX");

  expectError(() => deriveCutResponsiveStackPlan(input([]), { width: 100, height: 100 }, "$.call"), "CUT_RESPONSIVE_STACK_SHAPE", "$.call.weights");
  expectError(
    () => deriveCutResponsiveStackPlan(input(Array.from({ length: cutResponsiveStackLimits.maximumChildren + 1 }, () => 1)), { width: 100, height: 100 }, "$.call"),
    "CUT_RESPONSIVE_STACK_LIMIT",
    "$.call.weights",
  );
  expectError(() => deriveCutResponsiveStackPlan(input([1, 0]), { width: 100, height: 100 }, "$.call"), "CUT_RESPONSIVE_STACK_BOUNDS", "$.call.weights[1]");

  const noncanonical = input();
  assert.equal(noncanonical.kind, "object");
  assert.equal(noncanonical.entries.weights.kind, "array");
  noncanonical.entries.weights.items[0] = { kind: "quantity", dimension: "scalar", magnitude: { numerator: "2", denominator: "2" }, unit: "scalar" };
  expectError(() => deriveCutResponsiveStackPlan(noncanonical, { width: 100, height: 100 }, "$.call"), "CUT_RESPONSIVE_STACK_PLAN_TYPE", "$.call.weights[0].magnitude", /reduced/);

  const huge = input();
  assert.equal(huge.kind, "object");
  huge.entries.safeX = { kind: "quantity", dimension: "ratio", magnitude: { numerator: "1", denominator: `1${"0".repeat(cutResponsiveStackLimits.maximumRationalDigits)}` }, unit: "ratio" };
  expectError(() => deriveCutResponsiveStackPlan(huge, { width: 100, height: 100 }, "$.call"), "CUT_RESPONSIVE_STACK_LIMIT", "$.call.safeX.magnitude");
});

test("context, safe-area, gap-collapse, and inert one-child gap boundaries fail closed", () => {
  for (const [width, height] of [[0, 100], [100.5, 100], [100, 65_537]]) {
    expectError(() => deriveCutResponsiveStackPlan(input(), { width, height }, "$.call"), "CUT_RESPONSIVE_STACK_CONTEXT", /^\$\.call\.context\.(?:width|height)$/u);
  }
  expectError(() => deriveCutResponsiveStackPlan(input([1, 1], half), { width: 100, height: 100 }, "$.call"), "CUT_RESPONSIVE_STACK_BOUNDS", "$.call.safeX");
  expectError(() => deriveCutResponsiveStackPlan(input([1, 1], rational(0), rational(0), rational(100)), { width: 100, height: 100 }, "$.call"), "CUT_RESPONSIVE_STACK_BOUNDS", "$.call.gap", /leave positive/);
  expectError(() => deriveCutResponsiveStackPlan(input([1], rational(0), rational(0), rational(1)), { width: 100, height: 100 }, "$.call"), "CUT_RESPONSIVE_STACK_NOOP", "$.call.gap", /one-child/);
});

const half = rational(1, 2);

test("loaded plans reject unknowns, stale ids, and re-signed invented geometry", () => {
  const original = deriveCutResponsiveStackPlan(input(), { width: 1_920, height: 1_080 });

  const unknown = structuredClone(original);
  assert.equal(unknown.kind, "object");
  unknown.entries.privateHint = string("landscape");
  expectError(() => decodeCutResponsiveStackPlan(unknown, "$.plan"), "CUT_RESPONSIVE_STACK_PLAN_TYPE", "$.plan.privateHint");

  const stale = structuredClone(original);
  assert.equal(stale.kind, "object");
  stale.entries.id = string("0".repeat(64));
  expectError(() => decodeCutResponsiveStackPlan(stale, "$.plan"), "CUT_RESPONSIVE_STACK_IDENTITY", "$.plan.id", /canonical/);

  const invented = structuredClone(original);
  assert.equal(invented.kind, "object");
  assert.equal(invented.entries.slots.kind, "array");
  const slot = invented.entries.slots.items[0];
  assert.equal(slot.kind, "object");
  slot.entries.width = px(999);
  resignInvented(invented);
  expectError(() => decodeCutResponsiveStackPlan(invented, "$.plan"), "CUT_RESPONSIVE_STACK_IDENTITY", "$.plan.slots[0].width", /derived/);
});

test("execution binds exact local layout contexts to child input identities", () => {
  const value = deriveCutResponsiveStackPlan(input(), { width: 1_920, height: 1_080 });
  const children = [
    { semanticIdentity: "a".repeat(64), minimumWidth: rational(640), minimumHeight: rational(320) },
    { semanticIdentity: "b".repeat(64), minimumWidth: rational(320), minimumHeight: rational(320) },
  ];
  const execution = referenceResponsiveStackExecution(value, children, "$.stack");
  assert.equal(execution.axis, "horizontal");
  assert.equal(execution.rasterPolicy, referenceResponsiveStackRasterPolicy);
  assert.deepEqual(execution.assignments.map((assignment) => assignment.localLayoutContext), execution.assignments.map((assignment) => ({
    originX: rational(0),
    originY: rational(0),
    width: rational(assignment.rasterSlot.width),
    height: rational(assignment.rasterSlot.height),
  })));
  assert.deepEqual(execution.assignments.map((assignment) => assignment.rasterSlot), [
    { left: 96, top: 108, right: 1_221, bottom: 972, width: 1_125, height: 864 },
    { left: 1_261, top: 108, right: 1_824, bottom: 972, width: 563, height: 864 },
  ]);
  assert.match(execution.semanticIdentity, /^[a-f0-9]{64}$/u);

  const looserMinimums = children.map((child) => ({ ...child, minimumWidth: rational(0), minimumHeight: rational(0) }));
  assert.equal(
    referenceResponsiveStackExecution(value, looserMinimums, "$.moved").semanticIdentity,
    execution.semanticIdentity,
    "validation-only minimums and source paths must not enter successful pixel identity",
  );
});

test("the one documented edge quantizer is monotone, tie-defined, and rejects raster-inert positive gaps", () => {
  assert.equal(referenceResponsiveStackRasterBoundary(rational(1, 3)), 0);
  assert.equal(referenceResponsiveStackRasterBoundary(rational(1, 2)), 1);
  assert.equal(referenceResponsiveStackRasterBoundary(rational(2, 3)), 1);
  const raster = referenceResponsiveStackRasterSlots(
    deriveCutResponsiveStackPlan(input(), { width: 1_920, height: 1_080 }),
    "$.plan",
  );
  assert.equal(raster[0].right <= raster[1].left, true);

  expectError(
    () => referenceResponsiveStackRasterSlots(
      deriveCutResponsiveStackPlan(input([1, 1], rational(0), rational(0), rational(1, 10)), { width: 100, height: 100 }),
      "$.plan",
    ),
    "CUT_RESPONSIVE_STACK_NOOP",
    "$.plan.gap",
    /quantizes to 0px/,
  );
});

test("execution rejects child-count drift, unbound identities, noncanonical constraints, and overflow", () => {
  const value = deriveCutResponsiveStackPlan(input(), { width: 1_920, height: 1_080 });
  expectError(() => referenceResponsiveStackExecution(value, [], "$.stack"), "CUT_RESPONSIVE_STACK_GRAPH", "$.stack.children", /exactly 2/);
  expectError(() => referenceResponsiveStackExecution(value, [
    { semanticIdentity: "not-a-digest", minimumWidth: rational(0), minimumHeight: rational(0) },
    { semanticIdentity: "b".repeat(64), minimumWidth: rational(0), minimumHeight: rational(0) },
  ], "$.stack"), "CUT_RESPONSIVE_STACK_SHAPE", "$.stack.children[0].semanticIdentity");
  expectError(() => referenceResponsiveStackExecution(value, [
    { semanticIdentity: "a".repeat(64), minimumWidth: { numerator: "2", denominator: "2" }, minimumHeight: rational(0) },
    { semanticIdentity: "b".repeat(64), minimumWidth: rational(0), minimumHeight: rational(0) },
  ], "$.stack"), "CUT_RESPONSIVE_STACK_SHAPE", "$.stack.children[0].minimumWidth", /canonical/);
  expectError(() => referenceResponsiveStackExecution(value, [
    { semanticIdentity: "a".repeat(64), minimumWidth: rational(2_000), minimumHeight: rational(0) },
    { semanticIdentity: "b".repeat(64), minimumWidth: rational(0), minimumHeight: rational(0) },
  ], "$.stack"), "CUT_RESPONSIVE_STACK_OVERFLOW", "$.stack.children[0].minimumWidth", /reflow/);

  const huge = `1${"0".repeat(cutResponsiveStackLimits.maximumRationalDigits)}`;
  expectError(() => referenceResponsiveStackExecution(value, [
    { semanticIdentity: "a".repeat(64), minimumWidth: { numerator: huge, denominator: "1" }, minimumHeight: rational(0) },
    { semanticIdentity: "b".repeat(64), minimumWidth: rational(0), minimumHeight: rational(0) },
  ], "$.stack"), "CUT_RESPONSIVE_STACK_LIMIT", "$.stack.children[0].minimumWidth");
});
