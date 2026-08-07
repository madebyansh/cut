import assert from "node:assert/strict";
import test from "node:test";
import type { IRProvenance, IRValue } from "../lib/language/ir";
import {
  audioEditOperationsFromInput,
  audioEditMaterializationIdentity,
  audioEditMaterializedNodeId,
  AudioEditOperationError,
  type AudioEditClipInputs,
  type AudioEditItem,
  type AudioEditOperation,
  type AudioEditOperationPlan,
  executeAudioEditOperationPlan,
  sameAudioEditOperationPlan,
  validateAudioEditOperationPlan,
} from "../lib/language/audio-edit-operations";
import { addRational, compareRational, rational, type Rational, zeroRational } from "../lib/language/rational";

function provenance(line = 1): IRProvenance {
  return {
    module: "audio-edit.test.cut",
    span: {
      start: { offset: line - 1, line, column: 1 },
      end: { offset: line, line, column: 2 },
    },
  };
}

function interval(start: Rational | number, duration: Rational | number) {
  return { start: typeof start === "number" ? rational(start) : start, duration: typeof duration === "number" ? rational(duration) : duration };
}

function clip(
  origin: string,
  destinationStart: Rational | number,
  duration: Rational | number,
  sourceStart: Rational | number,
  resourceId = origin.replace(/[^a-z0-9]/giu, "_") || "resource",
  linkId?: string,
  extras: Partial<AudioEditClipInputs> = {},
): AudioEditItem {
  return {
    origin,
    kind: "clip",
    destination: interval(destinationStart, duration),
    source: interval(sourceStart, duration),
    inputs: { resourceId, ...(linkId ? { linkId } : {}), ...extras },
    provenance: provenance(),
  };
}

function gap(origin: string, destinationStart: Rational | number, duration: Rational | number): AudioEditItem {
  return { origin, kind: "gap", destination: interval(destinationStart, duration), inputs: {}, provenance: provenance() };
}

function baseItems(): AudioEditItem[] {
  return [
    clip("base:0", 0, 1, 2, "a", "take-a"),
    clip("base:1", 1, 1, 4, "b", "take-b"),
    gap("base:2", 2, 1),
  ];
}

function plan(operations: AudioEditOperation[], items = baseItems(), sourceDuration: Rational = rational(3)): AudioEditOperationPlan {
  return { version: 1, sourceDuration, baseItems: items, operations };
}

function operationItem(index: number, duration: Rational | number, sourceStart: Rational | number, resourceId = "x", linkId = "take-x") {
  return clip(`operation:${index}`, 0, duration, sourceStart, resourceId, linkId);
}

function operationGap(index: number, duration: Rational | number) {
  return gap(`operation:${index}`, 0, duration);
}

function number(value: Rational) { return Number(value.numerator) / Number(value.denominator); }

function summary(items: readonly AudioEditItem[]) {
  return items.map((item) => ({
    kind: item.kind,
    destination: [number(item.destination.start), number(item.destination.duration)],
    source: item.kind === "clip" ? [number(item.source.start), number(item.source.duration)] : undefined,
    resourceId: item.kind === "clip" ? item.inputs.resourceId : undefined,
    linkId: item.kind === "clip" ? item.inputs.linkId : undefined,
  }));
}

function assertInvariants(items: readonly AudioEditItem[]) {
  assert.ok(items.length > 0);
  let cursor = zeroRational;
  for (const [index, item] of items.entries()) {
    assert.equal(compareRational(item.destination.start, cursor), 0, `item ${index} is not contiguous`);
    assert.ok(compareRational(item.destination.duration, zeroRational) > 0, `item ${index} is not positive`);
    if (index) assert.ok(!(items[index - 1].kind === "gap" && item.kind === "gap"), `item ${index} is uncoalesced silence`);
    if (item.kind === "clip") {
      assert.ok(compareRational(item.source.start, zeroRational) >= 0, `item ${index} has negative source time`);
      assert.equal(compareRational(item.source.duration, item.destination.duration), 0, `item ${index} lost one-to-one time`);
      assert.ok(item.inputs.resourceId.length > 0);
    } else assert.deepEqual(item.inputs, {});
    cursor = addRational(cursor, item.destination.duration);
  }
}

function hasError(code: AudioEditOperationError["code"], path?: RegExp) {
  return (error: unknown) => error instanceof AudioEditOperationError && error.code === code && (!path || path.test(error.path));
}

test("the pure audio algebra materializes every bounded structural operation with exact one-to-one time", () => {
  const p = provenance();
  const cases: Array<{ name: string; operation: AudioEditOperation; expected: ReturnType<typeof summary> }> = [
    {
      name: "split",
      operation: { kind: "split", at: rational(1, 2), provenance: p },
      expected: [
        { kind: "clip", destination: [0, .5], source: [2, .5], resourceId: "a", linkId: "take-a" },
        { kind: "clip", destination: [.5, .5], source: [2.5, .5], resourceId: "a", linkId: "take-a" },
        { kind: "clip", destination: [1, 1], source: [4, 1], resourceId: "b", linkId: "take-b" },
        { kind: "gap", destination: [2, 1], source: undefined, resourceId: undefined, linkId: undefined },
      ],
    },
    {
      name: "trim",
      operation: { kind: "trim", keep: interval(rational(1, 4), rational(1, 2)), provenance: p },
      expected: [
        { kind: "gap", destination: [0, .25], source: undefined, resourceId: undefined, linkId: undefined },
        { kind: "clip", destination: [.25, .5], source: [2.25, .5], resourceId: "a", linkId: "take-a" },
        { kind: "gap", destination: [.75, .25], source: undefined, resourceId: undefined, linkId: undefined },
        { kind: "clip", destination: [1, 1], source: [4, 1], resourceId: "b", linkId: "take-b" },
        { kind: "gap", destination: [2, 1], source: undefined, resourceId: undefined, linkId: undefined },
      ],
    },
    {
      name: "ripple insert",
      operation: { kind: "ripple-insert", at: rational(1), item: operationItem(0, rational(1, 2), 7), provenance: p },
      expected: [
        { kind: "clip", destination: [0, 1], source: [2, 1], resourceId: "a", linkId: "take-a" },
        { kind: "clip", destination: [1, .5], source: [7, .5], resourceId: "x", linkId: "take-x" },
        { kind: "clip", destination: [1.5, 1], source: [4, 1], resourceId: "b", linkId: "take-b" },
        { kind: "gap", destination: [2.5, 1], source: undefined, resourceId: undefined, linkId: undefined },
      ],
    },
    {
      name: "ripple delete",
      operation: { kind: "ripple-delete", range: interval(rational(1, 2), rational(1)), provenance: p },
      expected: [
        { kind: "clip", destination: [0, .5], source: [2, .5], resourceId: "a", linkId: "take-a" },
        { kind: "clip", destination: [.5, .5], source: [4.5, .5], resourceId: "b", linkId: "take-b" },
        { kind: "gap", destination: [1, 1], source: undefined, resourceId: undefined, linkId: undefined },
      ],
    },
    {
      name: "overwrite",
      operation: { kind: "overwrite", range: interval(rational(1, 2), rational(1)), item: operationItem(0, 1, 7), provenance: p },
      expected: [
        { kind: "clip", destination: [0, .5], source: [2, .5], resourceId: "a", linkId: "take-a" },
        { kind: "clip", destination: [.5, 1], source: [7, 1], resourceId: "x", linkId: "take-x" },
        { kind: "clip", destination: [1.5, .5], source: [4.5, .5], resourceId: "b", linkId: "take-b" },
        { kind: "gap", destination: [2, 1], source: undefined, resourceId: undefined, linkId: undefined },
      ],
    },
    {
      name: "replace",
      operation: { kind: "replace", range: interval(1, 1), item: operationItem(0, rational(1, 2), 7), provenance: p },
      expected: [
        { kind: "clip", destination: [0, 1], source: [2, 1], resourceId: "a", linkId: "take-a" },
        { kind: "clip", destination: [1, .5], source: [7, .5], resourceId: "x", linkId: "take-x" },
        { kind: "gap", destination: [1.5, 1], source: undefined, resourceId: undefined, linkId: undefined },
      ],
    },
    {
      name: "lift",
      operation: { kind: "lift", range: interval(rational(1, 2), rational(1)), provenance: p },
      expected: [
        { kind: "clip", destination: [0, .5], source: [2, .5], resourceId: "a", linkId: "take-a" },
        { kind: "gap", destination: [.5, 1], source: undefined, resourceId: undefined, linkId: undefined },
        { kind: "clip", destination: [1.5, .5], source: [4.5, .5], resourceId: "b", linkId: "take-b" },
        { kind: "gap", destination: [2, 1], source: undefined, resourceId: undefined, linkId: undefined },
      ],
    },
    {
      name: "extract",
      operation: { kind: "extract", range: interval(rational(1, 2), rational(1)), provenance: p },
      expected: [
        { kind: "clip", destination: [0, .5], source: [2, .5], resourceId: "a", linkId: "take-a" },
        { kind: "clip", destination: [.5, .5], source: [4.5, .5], resourceId: "b", linkId: "take-b" },
        { kind: "gap", destination: [1, 1], source: undefined, resourceId: undefined, linkId: undefined },
      ],
    },
    {
      name: "positive slip",
      operation: { kind: "slip", range: interval(0, 1), by: rational(1, 2), provenance: p },
      expected: [
        { kind: "clip", destination: [0, 1], source: [2.5, 1], resourceId: "a", linkId: "take-a" },
        { kind: "clip", destination: [1, 1], source: [4, 1], resourceId: "b", linkId: "take-b" },
        { kind: "gap", destination: [2, 1], source: undefined, resourceId: undefined, linkId: undefined },
      ],
    },
    {
      name: "negative slip",
      operation: { kind: "slip", range: interval(0, 1), by: rational(-1, 2), provenance: p },
      expected: [
        { kind: "clip", destination: [0, 1], source: [1.5, 1], resourceId: "a", linkId: "take-a" },
        { kind: "clip", destination: [1, 1], source: [4, 1], resourceId: "b", linkId: "take-b" },
        { kind: "gap", destination: [2, 1], source: undefined, resourceId: undefined, linkId: undefined },
      ],
    },
    {
      name: "positive slide",
      operation: { kind: "slide", range: interval(1, 1), by: rational(1, 2), provenance: p },
      expected: [
        { kind: "clip", destination: [0, 1.5], source: [2, 1.5], resourceId: "a", linkId: "take-a" },
        { kind: "clip", destination: [1.5, 1], source: [4, 1], resourceId: "b", linkId: "take-b" },
        { kind: "gap", destination: [2.5, .5], source: undefined, resourceId: undefined, linkId: undefined },
      ],
    },
    {
      name: "negative slide",
      operation: { kind: "slide", range: interval(1, 1), by: rational(-1, 2), provenance: p },
      expected: [
        { kind: "clip", destination: [0, .5], source: [2, .5], resourceId: "a", linkId: "take-a" },
        { kind: "clip", destination: [.5, 1], source: [4, 1], resourceId: "b", linkId: "take-b" },
        { kind: "gap", destination: [1.5, 1.5], source: undefined, resourceId: undefined, linkId: undefined },
      ],
    },
  ];

  for (const entry of cases) {
    const result = executeAudioEditOperationPlan(plan([entry.operation]));
    assert.deepEqual(summary(result.items), entry.expected, entry.name);
    assertInvariants(result.items);
    assert.equal(result.materializationId, executeAudioEditOperationPlan(structuredClone(plan([entry.operation]))).materializationId, entry.name);
  }
});

test("inserted, trimmed, and lifted silence is explicit and deterministically coalesced", () => {
  const p = provenance();
  const inserted = executeAudioEditOperationPlan(plan([
    { kind: "ripple-insert", at: rational(2), item: operationGap(0, rational(1, 2)), provenance: p },
  ]));
  assert.deepEqual(summary(inserted.items).slice(-1), [
    { kind: "gap", destination: [2, 1.5], source: undefined, resourceId: undefined, linkId: undefined },
  ]);
  assertInvariants(inserted.items);

  const lifted = executeAudioEditOperationPlan(plan([{ kind: "lift", range: interval(1, 2), provenance: p }]));
  assert.deepEqual(summary(lifted.items), [
    { kind: "clip", destination: [0, 1], source: [2, 1], resourceId: "a", linkId: "take-a" },
    { kind: "gap", destination: [1, 2], source: undefined, resourceId: undefined, linkId: undefined },
  ]);
  assertInvariants(lifted.items);
});

test("link metadata survives structural edits without implying coupled picture edits", () => {
  const p = provenance();
  const operations: AudioEditOperation[] = [
    { kind: "split", at: rational(1, 2), provenance: p },
    { kind: "slip", range: interval(1, 1), by: rational(1, 2), provenance: p },
  ];
  const result = executeAudioEditOperationPlan(plan(operations));
  assert.deepEqual(result.items.filter((item) => item.kind === "clip").map((item) => item.inputs.linkId), ["take-a", "take-a", "take-b"]);
  assert.equal(result.items.filter((item) => item.kind === "clip" && item.inputs.linkId === "take-a").length, 2, "split linkId is a preserved relationship group, not a unique segment key");
  assert.ok(!("picture" in audioEditMaterializationIdentity(result.items)));
});

test("slide compensates both neighboring clip source intervals without changing the target source", () => {
  const p = provenance();
  const items = [
    clip("base:0", 0, 1, 10, "previous", "previous-link"),
    clip("base:1", 1, 1, 20, "target", "target-link"),
    clip("base:2", 2, 1, 30, "next", "next-link"),
  ];
  const positive = executeAudioEditOperationPlan(plan([{ kind: "slide", range: interval(1, 1), by: rational(1, 4), provenance: p }], items));
  assert.deepEqual(summary(positive.items), [
    { kind: "clip", destination: [0, 1.25], source: [10, 1.25], resourceId: "previous", linkId: "previous-link" },
    { kind: "clip", destination: [1.25, 1], source: [20, 1], resourceId: "target", linkId: "target-link" },
    { kind: "clip", destination: [2.25, .75], source: [30.25, .75], resourceId: "next", linkId: "next-link" },
  ]);
  const negative = executeAudioEditOperationPlan(plan([{ kind: "slide", range: interval(1, 1), by: rational(-1, 4), provenance: p }], items));
  assert.deepEqual(summary(negative.items), [
    { kind: "clip", destination: [0, .75], source: [10, .75], resourceId: "previous", linkId: "previous-link" },
    { kind: "clip", destination: [.75, 1], source: [20, 1], resourceId: "target", linkId: "target-link" },
    { kind: "clip", destination: [1.75, 1.25], source: [29.75, 1.25], resourceId: "next", linkId: "next-link" },
  ]);
  assertInvariants(positive.items); assertInvariants(negative.items);
});

test("neutral controls canonicalize away while nonzero fades, retimes, and overlaps fail closed", () => {
  const p = provenance();
  const neutral = baseItems();
  assert.equal(neutral[0].kind, "clip");
  if (neutral[0].kind === "clip") neutral[0].inputs = { ...neutral[0].inputs, fadeIn: rational(0), fadeOut: rational(0), rate: rational(1), overlap: rational(0) };
  const validated = validateAudioEditOperationPlan(plan([{ kind: "split", at: rational(1, 2), provenance: p }], neutral));
  assert.deepEqual(validated.baseItems[0].inputs, { resourceId: "a", linkId: "take-a" });

  const unsupported = (name: "fadeIn" | "fadeOut" | "rate" | "overlap", amount: Rational) => {
    const items = baseItems();
    assert.equal(items[0].kind, "clip");
    if (items[0].kind === "clip") items[0].inputs[name] = amount;
    assert.throws(() => validateAudioEditOperationPlan(plan([{ kind: "split", at: rational(1, 2), provenance: p }], items)), hasError("CUT_AUDIO_EDIT_UNSUPPORTED", new RegExp(`inputs\\.${name}$`)));
  };
  unsupported("fadeIn", rational(1, 100));
  unsupported("fadeOut", rational(1, 100));
  unsupported("rate", rational(2));
  unsupported("overlap", rational(1, 100));

  const mismatched = baseItems();
  assert.equal(mismatched[0].kind, "clip");
  if (mismatched[0].kind === "clip") mismatched[0].source.duration = rational(2);
  assert.throws(() => validateAudioEditOperationPlan(plan([{ kind: "split", at: rational(1, 2), provenance: p }], mismatched)), hasError("CUT_AUDIO_EDIT_UNSUPPORTED", /baseItems\[0\]$/));
});

test("zero, redundant, ambiguous, out-of-bounds, and destructive operations are refused", () => {
  const p = provenance();
  const refuses: Array<{ value: AudioEditOperationPlan; code: AudioEditOperationError["code"]; path?: RegExp }> = [
    { value: plan([{ kind: "split", at: rational(1), provenance: p }]), code: "CUT_AUDIO_EDIT_NOOP", path: /\.at$/ },
    { value: plan([{ kind: "split", at: rational(5, 2), provenance: p }]), code: "CUT_AUDIO_EDIT_UNSUPPORTED", path: /\.at$/ },
    { value: plan([{ kind: "split", at: rational(-1), provenance: p }]), code: "CUT_AUDIO_EDIT_TIME", path: /\.at$/ },
    { value: plan([{ kind: "trim", keep: interval(0, 1), provenance: p }]), code: "CUT_AUDIO_EDIT_NOOP" },
    { value: plan([{ kind: "slip", range: interval(0, 1), by: rational(0), provenance: p }]), code: "CUT_AUDIO_EDIT_NOOP", path: /\.by$/ },
    { value: plan([{ kind: "slip", range: interval(0, 1), by: rational(-3), provenance: p }]), code: "CUT_AUDIO_EDIT_TIME", path: /\.by$/ },
    { value: plan([{ kind: "slide", range: interval(1, 1), by: rational(0), provenance: p }]), code: "CUT_AUDIO_EDIT_NOOP" },
    { value: plan([{ kind: "slide", range: interval(0, 1), by: rational(1, 2), provenance: p }]), code: "CUT_AUDIO_EDIT_UNSUPPORTED", path: /\.range$/ },
    { value: plan([{ kind: "slide", range: interval(1, 1), by: rational(1), provenance: p }]), code: "CUT_AUDIO_EDIT_TIME", path: /\.by$/ },
    { value: plan([{ kind: "overwrite", range: interval(0, rational(1, 2)), item: operationItem(0, 1, 7), provenance: p }]), code: "CUT_AUDIO_EDIT_TIME" },
    { value: plan([{ kind: "overwrite", range: interval(0, 1), item: clip("operation:0", 0, 1, 2, "a", "take-a"), provenance: p }]), code: "CUT_AUDIO_EDIT_NOOP" },
    { value: plan([{ kind: "replace", range: interval(rational(1, 2), 1), item: operationItem(0, 1, 7), provenance: p }]), code: "CUT_AUDIO_EDIT_UNSUPPORTED", path: /\.range$/ },
    { value: plan([{ kind: "replace", range: interval(0, 1), item: clip("operation:0", 0, 1, 2, "a", "take-a"), provenance: p }]), code: "CUT_AUDIO_EDIT_NOOP" },
    { value: plan([{ kind: "ripple-delete", range: interval(0, 3), provenance: p }]), code: "CUT_AUDIO_EDIT_RESULT" },
    { value: plan([{ kind: "lift", range: interval(2, 1), provenance: p }]), code: "CUT_AUDIO_EDIT_NOOP" },
    { value: plan([
      { kind: "slip", range: interval(0, 1), by: rational(1, 2), provenance: p },
      { kind: "slip", range: interval(0, 1), by: rational(-1, 2), provenance: p },
    ]), code: "CUT_AUDIO_EDIT_NOOP", path: /operations$/ },
  ];
  for (const entry of refuses) assert.throws(() => executeAudioEditOperationPlan(entry.value), hasError(entry.code, entry.path), JSON.stringify(entry.value.operations));

  const followingAtZero = [
    gap("base:0", 0, 1),
    clip("base:1", 1, 1, 2, "target"),
    clip("base:2", 2, 1, 0, "next"),
  ];
  assert.throws(
    () => executeAudioEditOperationPlan(plan([{ kind: "slide", range: interval(1, 1), by: rational(-1, 2), provenance: p }], followingAtZero)),
    hasError("CUT_AUDIO_EDIT_TIME", /\.by$/),
  );
});

test("the validator is closed against hostile plans, items, inputs, provenance, and exact rationals", () => {
  const p = provenance(), valid = plan([{ kind: "split", at: rational(1, 2), provenance: p }]);
  const mutate = (change: (value: Record<string, unknown>) => void) => {
    const value = structuredClone(valid) as unknown as Record<string, unknown>;
    change(value);
    return value;
  };

  assert.throws(() => validateAudioEditOperationPlan(mutate((value) => { value.ignored = true; })), hasError("CUT_AUDIO_EDIT_SHAPE", /ignored$/));
  assert.throws(() => validateAudioEditOperationPlan(mutate((value) => {
    const items = value.baseItems as Array<Record<string, unknown>>;
    (items[0].inputs as Record<string, unknown>).gain = rational(1);
  })), hasError("CUT_AUDIO_EDIT_SHAPE", /inputs\.gain$/));
  assert.throws(() => validateAudioEditOperationPlan(mutate((value) => {
    (value.operations as Array<Record<string, unknown>>)[0].ignored = true;
  })), hasError("CUT_AUDIO_EDIT_SHAPE", /operations\[0\]\.ignored$/));
  assert.throws(() => validateAudioEditOperationPlan(mutate((value) => {
    (value.operations as Array<Record<string, unknown>>)[0].kind = "phase-warp";
  })), hasError("CUT_AUDIO_EDIT_SHAPE", /\.kind$/));
  assert.throws(() => validateAudioEditOperationPlan(mutate((value) => {
    (value.operations as Array<Record<string, unknown>>)[0].at = { numerator: "2", denominator: "4" };
  })), hasError("CUT_AUDIO_EDIT_SHAPE", /\.at$/));
  assert.throws(() => validateAudioEditOperationPlan(mutate((value) => {
    (value.operations as Array<Record<string, unknown>>)[0].at = { numerator: "1", denominator: "0" };
  })), hasError("CUT_AUDIO_EDIT_SHAPE", /denominator$/));
  assert.throws(() => validateAudioEditOperationPlan(mutate((value) => {
    (value.baseItems as Array<Record<string, unknown>>)[1].origin = "base:7";
  })), hasError("CUT_AUDIO_EDIT_SHAPE", /origin$/));
  assert.throws(() => validateAudioEditOperationPlan(mutate((value) => {
    const items = value.baseItems as Array<Record<string, unknown>>;
    (items[1].destination as { start: Rational }).start = rational(3, 2);
  })), hasError("CUT_AUDIO_EDIT_SHAPE", /destination\.start$/));
  assert.throws(() => validateAudioEditOperationPlan(mutate((value) => {
    const items = value.baseItems as Array<Record<string, unknown>>;
    items[2] = gap("base:2", 2, rational(1, 2)) as unknown as Record<string, unknown>;
    value.sourceDuration = rational(3);
  })), hasError("CUT_AUDIO_EDIT_SHAPE", /sourceDuration$/));
  assert.throws(() => validateAudioEditOperationPlan(mutate((value) => {
    const items = value.baseItems as Array<Record<string, unknown>>;
    items[1] = gap("base:1", 1, 1) as unknown as Record<string, unknown>;
  })), hasError("CUT_AUDIO_EDIT_SHAPE", /baseItems\[2\]$/));
  assert.throws(() => validateAudioEditOperationPlan(mutate((value) => {
    const operations = value.operations as Array<Record<string, unknown>>;
    operations[0] = { kind: "ripple-insert", at: rational(1), item: operationItem(4, rational(1, 2), 7), provenance: p };
  })), hasError("CUT_AUDIO_EDIT_SHAPE", /item\.origin$/));
  assert.throws(() => validateAudioEditOperationPlan(mutate((value) => {
    const operations = value.operations as Array<Record<string, unknown>>;
    const item = operationItem(0, rational(1, 2), 7);
    item.destination.start = rational(1);
    operations[0] = { kind: "ripple-insert", at: rational(1), item, provenance: p };
  })), hasError("CUT_AUDIO_EDIT_SHAPE", /item\.destination\.start$/));
  assert.throws(() => validateAudioEditOperationPlan(mutate((value) => {
    const first = (value.baseItems as Array<Record<string, unknown>>)[0];
    const provenanceValue = first.provenance as Record<string, unknown>;
    (provenanceValue.span as { end: { line: number } }).end.line = 0;
  })), hasError("CUT_AUDIO_EDIT_SHAPE", /\.line$/));

  const accessor = structuredClone(valid) as unknown as Record<string, unknown>;
  Object.defineProperty(accessor, "version", { enumerable: true, get: () => 1 });
  assert.throws(() => validateAudioEditOperationPlan(accessor), hasError("CUT_AUDIO_EDIT_SHAPE", /version$/));
  const exotic = Object.assign(Object.create({ inherited: true }), structuredClone(valid));
  assert.throws(() => validateAudioEditOperationPlan(exotic), hasError("CUT_AUDIO_EDIT_SHAPE", /^\$$/));
  const materialized = executeAudioEditOperationPlan(valid).items as Array<AudioEditItem & { ignored?: boolean }>;
  materialized[0].ignored = true;
  assert.throws(() => audioEditMaterializationIdentity(materialized), hasError("CUT_AUDIO_EDIT_SHAPE", /items\[0\]\.ignored$/));
});

test("operation, item, rational, and provenance budgets cover base and intermediate expansion", () => {
  const p = provenance();
  assert.throws(
    () => validateAudioEditOperationPlan(plan([
      { kind: "split", at: rational(1, 2), provenance: p },
      { kind: "split", at: rational(3, 2), provenance: p },
    ]), { maxOperations: 1 }),
    hasError("CUT_AUDIO_EDIT_LIMIT", /operations$/),
  );
  assert.throws(() => validateAudioEditOperationPlan(plan([{ kind: "split", at: rational(1, 2), provenance: p }]), { maxItems: 2 }), hasError("CUT_AUDIO_EDIT_LIMIT", /baseItems$/));
  assert.throws(
    () => executeAudioEditOperationPlan(
      plan([{ kind: "split", at: rational(1, 2), provenance: p }], [clip("base:0", 0, 1, 2, "a"), gap("base:1", 1, 1)], rational(2)),
      { maxItems: 2 },
    ),
    hasError("CUT_AUDIO_EDIT_LIMIT", /operations\[0\]$/),
  );
  assert.throws(
    () => validateAudioEditOperationPlan(plan([{ kind: "split", at: rational(1, 11), provenance: p }]), { maxRationalDigits: 1 }),
    hasError("CUT_AUDIO_EDIT_LIMIT"),
  );
  const expanded = structuredClone(plan([{ kind: "split", at: rational(1, 2), provenance: p }]));
  expanded.operations[0].provenance.expandedFrom = [
    { module: "a.cut", span: provenance().span, symbol: "a" },
    { module: "b.cut", span: provenance().span, symbol: "b" },
  ];
  assert.throws(() => validateAudioEditOperationPlan(expanded, { maxProvenanceFrames: 1 }), hasError("CUT_AUDIO_EDIT_LIMIT", /expandedFrom$/));
});

test("canonical plan and materialization identity ignore provenance and neutral spelling but preserve resources and links", () => {
  const first = plan([{ kind: "split", at: rational(1, 2), provenance: provenance(1) }]);
  const second = structuredClone(first);
  second.operations[0].provenance = provenance(90);
  second.baseItems.forEach((item) => { item.provenance = provenance(70); });
  assert.equal(sameAudioEditOperationPlan(first, second), true);

  assert.equal(second.baseItems[0].kind, "clip");
  if (second.baseItems[0].kind === "clip") second.baseItems[0].inputs.fadeIn = rational(0);
  assert.equal(sameAudioEditOperationPlan(first, second), true);

  assert.equal(second.baseItems[0].kind, "clip");
  if (second.baseItems[0].kind === "clip") second.baseItems[0].inputs.linkId = "different-link";
  assert.equal(sameAudioEditOperationPlan(first, second), false);

  const a = executeAudioEditOperationPlan(first), b = executeAudioEditOperationPlan(structuredClone(first));
  assert.equal(a.materializationId, b.materializationId);
  assert.equal(a.materializationId, `audio_edit_${a.materializationId.slice("audio_edit_".length)}`);
  assert.deepEqual(audioEditMaterializationIdentity(a.items), audioEditMaterializationIdentity(b.items));
  assert.equal(audioEditMaterializedNodeId("track", 0, a.items[0]), audioEditMaterializedNodeId("track", 0, b.items[0]));
  assert.notEqual(audioEditMaterializedNodeId("track", 0, a.items[0]), audioEditMaterializedNodeId("track", 1, a.items[0]));
});

test("closed audio-prefixed public calls decode to the typed algebra without leaking generic picture operations", () => {
  const time = (value: Rational): IRValue => ({ kind: "quantity", dimension: "time", magnitude: value, unit: "s" });
  const range = (start: Rational, end: Rational): IRValue => ({ kind: "range", start: time(start), end: time(end), exclusive: true });
  const call = (op: string, positional: IRValue[] = [], named: Record<string, IRValue> = {}): IRValue => ({ kind: "call", op, positional, named, effect: "pure" });
  const editAudio = call("cut.edit.audio_value.clip", [
    { kind: "resource-ref", id: "locked_audio" },
    range(rational(5), rational(6)),
  ]);
  const editSilence = call("cut.edit.audio_value.gap", [time(rational(1, 2))]);
  const calls: IRValue[] = [
    call("cut.edit.audio_operation.split", [time(rational(1, 2))]),
    call("cut.edit.audio_operation.trim", [range(rational(1, 4), rational(3, 4))]),
    call("cut.edit.audio_operation.ripple_insert", [time(rational(1)), editAudio]),
    call("cut.edit.audio_operation.ripple_delete", [range(rational(1), rational(3, 2))]),
    call("cut.edit.audio_operation.overwrite", [range(rational(1), rational(3, 2)), editSilence]),
    call("cut.edit.audio_operation.replace", [range(rational(1), rational(2)), editAudio]),
    call("cut.edit.audio_operation.lift", [range(rational(1), rational(2))]),
    call("cut.edit.audio_operation.extract", [range(rational(1), rational(2))]),
    call("cut.edit.audio_operation.slip", [range(rational(1), rational(2)), time(rational(-1, 4))]),
    call("cut.edit.audio_operation.slide", [range(rational(1), rational(2)), time(rational(1, 4))]),
  ];
  const decoded = audioEditOperationsFromInput({ kind: "array", items: calls }, calls.map((_, index) => provenance(index + 1)));
  assert.deepEqual(decoded.map((operation) => operation.kind), [
    "split", "trim", "ripple-insert", "ripple-delete", "overwrite", "replace", "lift", "extract", "slip", "slide",
  ]);
  const inserted = decoded[2];
  assert.equal(inserted.kind, "ripple-insert");
  if (inserted.kind !== "ripple-insert") return;
  assert.equal(inserted.item.kind, "clip");
  if (inserted.item.kind === "clip") {
    assert.equal(inserted.item.inputs.resourceId, "locked_audio");
    assert.deepEqual(inserted.item.source, interval(5, 1));
    assert.deepEqual(inserted.item.destination, interval(0, 1));
  }

  assert.throws(
    () => audioEditOperationsFromInput({ kind: "array", items: [] }, []),
    hasError("CUT_AUDIO_EDIT_SHAPE", /operations$/),
  );
  assert.throws(
    () => audioEditOperationsFromInput({ kind: "array", items: [call("cut.edit.operation.split", [time(rational(1, 2))])] }, [provenance()]),
    hasError("CUT_AUDIO_EDIT_SHAPE", /\.op$/),
  );
  assert.throws(
    () => audioEditOperationsFromInput({ kind: "array", items: [call("cut.edit.audio_operation.split", [time(rational(1, 2))], { at: time(rational(1, 2)) })] }, [provenance()]),
    hasError("CUT_AUDIO_EDIT_SHAPE", /\.at$/),
  );
  const wrongSource = call("cut.edit.audio_value.clip", [{ kind: "node-ref", id: "not_audio" }, range(rational(0), rational(1))]);
  assert.throws(
    () => audioEditOperationsFromInput({ kind: "array", items: [call("cut.edit.audio_operation.ripple_insert", [time(rational(0)), wrongSource])] }, [provenance()]),
    hasError("CUT_AUDIO_EDIT_SHAPE", /\.source$/),
  );
});

function pseudoRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
}

test("deterministic property sweep preserves exact-rational coverage and source mapping across all operations", () => {
  const denominators = [7, 11, 97, 1_001, 48_000];
  for (let seed = 1; seed <= 250; seed += 1) {
    const random = pseudoRandom(seed), denominator = denominators[random() % denominators.length];
    const a = rational(1 + random() % 20, denominator), b = rational(1 + random() % 20, denominator), c = rational(1 + random() % 20, denominator);
    const ab = addRational(a, b), total = addRational(ab, c), p = provenance(seed);
    const items = [
      clip("base:0", zeroRational, a, rational(10), "a", "link-a"),
      clip("base:1", a, b, rational(20), "b", "link-b"),
      clip("base:2", ab, c, rational(30), "c", "link-c"),
    ];
    const mode = random() % 10;
    let operation: AudioEditOperation;
    if (mode === 0) operation = { kind: "split", at: addRational(a, rational(b.numerator, BigInt(b.denominator) * 2n)), provenance: p };
    else if (mode === 1) operation = { kind: "trim", keep: { start: addRational(a, rational(b.numerator, BigInt(b.denominator) * 4n)), duration: rational(BigInt(b.numerator), BigInt(b.denominator) * 2n) }, provenance: p };
    else if (mode === 2) operation = { kind: "ripple-insert", at: a, item: operationItem(0, rational(1, denominator), 40), provenance: p };
    else if (mode === 3) operation = { kind: "ripple-delete", range: { start: a, duration: b }, provenance: p };
    else if (mode === 4) operation = { kind: "overwrite", range: { start: a, duration: b }, item: operationItem(0, b, 40), provenance: p };
    else if (mode === 5) operation = { kind: "replace", range: { start: a, duration: b }, item: operationItem(0, rational(1, denominator), 40), provenance: p };
    else if (mode === 6) operation = { kind: "lift", range: { start: a, duration: b }, provenance: p };
    else if (mode === 7) operation = { kind: "extract", range: { start: a, duration: b }, provenance: p };
    else if (mode === 8) operation = { kind: "slip", range: { start: a, duration: b }, by: rational(random() % 2 ? 1 : -1, denominator), provenance: p };
    else {
      const maximum = compareRational(a, c) < 0 ? a : c;
      const by = rational(BigInt(maximum.numerator), BigInt(maximum.denominator) * 2n);
      operation = { kind: "slide", range: { start: a, duration: b }, by, provenance: p };
    }
    const input = plan([operation], items, total);
    const first = executeAudioEditOperationPlan(input), replay = executeAudioEditOperationPlan(structuredClone(input));
    assertInvariants(first.items);
    assert.equal(first.materializationId, replay.materializationId, `seed ${seed}`);
    assert.deepEqual(first.items.map((item) => item.kind === "clip" ? item.inputs.linkId : undefined), replay.items.map((item) => item.kind === "clip" ? item.inputs.linkId : undefined));
  }
});
