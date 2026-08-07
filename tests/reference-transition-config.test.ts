import test from "node:test";
import assert from "node:assert/strict";
import type { CutAVIR, IRNode } from "../lib/language/ir";
import { rational } from "../lib/language/rational";
import {
  ReferenceTransitionContractError,
  referenceDirectNodeParents,
  referenceTransitionContract,
  referenceTransitionProgress,
} from "../lib/runtime/reference/transition-config";

const provenance = { module: "proof.cut", span: { start: { offset: 10, line: 2, column: 3 }, end: { offset: 20, line: 2, column: 13 } } };
const quantity = (numerator: number, denominator = 1) => ({ kind: "quantity" as const, dimension: "time", magnitude: rational(numerator, denominator), unit: "s" });

function fixture() {
  const outgoing: IRNode = { id: "a", op: "cut.edit.clip", domain: "av", ownership: "child", sceneId: "s", interval: { start: rational(0), duration: rational(1) }, inputs: {}, children: [], properties: {}, effects: ["pure"], contentHash: "a", provenance };
  const incoming: IRNode = { id: "b", op: "cut.edit.clip", domain: "av", ownership: "child", sceneId: "s", interval: { start: rational(1, 2), duration: rational(1) }, inputs: {}, children: [], properties: {}, effects: ["pure"], contentHash: "b", provenance };
  const transition: IRNode = { id: "t", op: "cut.edit.transition", domain: "av", ownership: "root", sceneId: "s", interval: { start: rational(0), duration: rational(3, 2) }, inputs: { kind: { kind: "string", value: "wipe" }, duration: quantity(1, 2), direction: { kind: "string", value: "left" }, softness: { kind: "quantity", dimension: "ratio", magnitude: rational(1, 10), unit: "ratio" } }, children: ["a", "b"], properties: {}, effects: ["pure"], contentHash: "t", provenance };
  const ir = { nodes: { a: outgoing, b: incoming, t: transition } } as unknown as CutAVIR;
  const composition = { fps: rational(4), sampleRate: 48_000 } as CutAVIR["compositions"][number];
  return { outgoing, incoming, transition, ir, composition };
}

test("generic transition contract derives one exact shared picture/audio overlap", () => {
  const { transition, ir, composition } = fixture();
  const contract = referenceTransitionContract(ir, composition, transition, referenceDirectNodeParents(ir));
  assert.deepEqual(contract.overlapStart, rational(1, 2));
  assert.deepEqual(contract.overlapDuration, rational(1, 2));
  assert.equal(referenceTransitionProgress(contract, rational(1, 2)), 0);
  assert.equal(referenceTransitionProgress(contract, rational(3, 4)), .5);
  assert.equal(referenceTransitionProgress(contract, rational(1)), 1);
  assert.deepEqual(contract.picture, { kind: "wipe", direction: "left", softness: .1, dipColor: [0, 0, 0, 1] });
});

test("loaded transition IR cannot alter overlap, ordering, ownership, grids, or conditional controls", () => {
  const cases: Array<[string, (value: ReturnType<typeof fixture>) => void]> = [
    ["exactly two", ({ transition }) => { transition.children = ["a"]; }],
    ["direct linked Clip", ({ incoming }) => { incoming.op = "cut.visual.rect"; }],
    ["ownership", ({ incoming }) => { incoming.ownership = "root"; }],
    ["must overlap", ({ incoming }) => { incoming.interval.start = rational(1); incoming.interval.duration = rational(1); }],
    ["end after", ({ incoming }) => { incoming.interval.start = rational(1, 4); incoming.interval.duration = rational(1, 2); }],
    ["exactly equal", ({ transition }) => { transition.inputs.duration = quantity(1, 4); }],
    ["parent interval", ({ transition }) => { transition.interval.duration = rational(1); }],
    ["frame grid", ({ transition, incoming }) => { incoming.interval.start = rational(1, 8); incoming.interval.duration = rational(11, 8); transition.inputs.duration = quantity(7, 8); }],
    ["at least two picture frames", ({ transition, incoming }) => { incoming.interval.start = rational(3, 4); incoming.interval.duration = rational(3, 4); transition.inputs.duration = quantity(1, 4); }],
    ["one of", ({ transition }) => { transition.inputs.kind = { kind: "string", value: "morph" }; }],
    ["only for a wipe", ({ transition }) => { transition.inputs.kind = { kind: "string", value: "slide" }; }],
    ["not meaningful", ({ transition }) => { transition.inputs.kind = { kind: "string", value: "cross-dissolve" }; delete transition.inputs.softness; }],
    ["double-apply", ({ outgoing }) => { outgoing.inputs.fadeOut = quantity(1, 2); }],
  ];
  for (const [message, mutate] of cases) {
    const value = fixture(); mutate(value);
    assert.throws(() => referenceTransitionContract(value.ir, value.composition, value.transition, referenceDirectNodeParents(value.ir)), (error) => error instanceof ReferenceTransitionContractError && error.code === "CUT_TRANSITION_CONTRACT" && error.source.line === 2 && error.message.includes(message), message);
  }
});

test("Transition Clip children cannot be shared with another direct parent", () => {
  const value = fixture();
  value.ir.nodes.other = { ...value.transition, id: "other", children: ["a", "b"], contentHash: "other" };
  assert.throws(
    () => referenceTransitionContract(value.ir, value.composition, value.transition, referenceDirectNodeParents(value.ir)),
    /one direct parent/,
  );
  assert.throws(
    () => referenceTransitionContract(value.ir, value.composition, value.transition),
    /one direct parent/,
    "low-level callers must not be able to omit the ownership invariant",
  );
});
