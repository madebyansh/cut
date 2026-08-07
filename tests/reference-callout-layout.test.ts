import assert from "node:assert/strict";
import test from "node:test";

import {
  referenceCalloutCandidateRect,
  referenceCalloutRectsCollide,
  resolveReferenceCalloutLayout,
  type ReferenceCalloutLayoutEntry,
} from "../lib/runtime/reference/callout-layout";

function entry(
  id: string,
  overrides: Partial<ReferenceCalloutLayoutEntry> = {},
): ReferenceCalloutLayoutEntry {
  return Object.freeze({
    id,
    sourceOrder: Object.freeze([0]),
    priority: 0,
    anchor: Object.freeze({ x: 100, y: 100 }),
    width: 40,
    height: 20,
    placements: Object.freeze(["right", "left", "above", "below"] as const),
    offset: 10,
    safeArea: 8,
    opacity: 1,
    leader: "none",
    ...overrides,
  });
}

test("generic callout geometry keeps half-open edge contact non-colliding", () => {
  const right = referenceCalloutCandidateRect({ x: 100, y: 100 }, 40, 20, 10, "right");
  assert.deepEqual(right, {
    left: 110,
    top: 90,
    right: 150,
    bottom: 110,
    width: 40,
    height: 20,
  });
  assert.equal(referenceCalloutRectsCollide(right, {
    left: 150,
    top: 90,
    right: 190,
    bottom: 110,
    width: 40,
    height: 20,
  }), false);
});

test("priority, source order and authored fallback order deterministically resolve collisions", () => {
  const plan = resolveReferenceCalloutLayout({ width: 320, height: 180 }, [
    entry("source-second", { sourceOrder: [0, 1], anchor: { x: 90, y: 90 } }),
    entry("priority-first", { priority: 10, sourceOrder: [9], anchor: { x: 90, y: 90 } }),
    entry("source-first", { sourceOrder: [0, 0], anchor: { x: 90, y: 90 } }),
  ]);
  assert.deepEqual(plan.resolutionOrder, ["priority-first", "source-first", "source-second"]);
  assert.deepEqual(plan.paintOrder, ["source-second", "source-first", "priority-first"]);
  assert.deepEqual(plan.decisions.map((decision) => ({
    id: decision.id,
    placement: decision.chosenPlacement,
    collisionWith: decision.candidates.at(-1)?.collisionWith,
  })), [
    { id: "priority-first", placement: "right", collisionWith: undefined },
    { id: "source-first", placement: "left", collisionWith: undefined },
    { id: "source-second", placement: "above", collisionWith: undefined },
  ]);
  assert.equal(plan.work.candidateCollisionTests, 7);
});

test("safe-area rejection, collision overflow, opacity and offscreen anchors skip explicitly", () => {
  const plan = resolveReferenceCalloutLayout({ width: 200, height: 120 }, [
    entry("occupant", {
      priority: 10,
      anchor: { x: 100, y: 60 },
      width: 120,
      height: 80,
      placements: ["right"],
      offset: 1,
      safeArea: 0,
    }),
    entry("overflow", {
      anchor: { x: 100, y: 60 },
      width: 120,
      height: 80,
      placements: ["right", "left"],
      offset: 1,
      safeArea: 0,
    }),
    entry("transparent", { opacity: 0 }),
    entry("offscreen", { anchor: { x: 200, y: 60 } }),
  ]);
  assert.deepEqual(plan.decisions.map((decision) => [decision.id, decision.status, decision.reason]), [
    ["occupant", "hidden", "collision-overflow"],
    ["overflow", "hidden", "collision-overflow"],
    ["transparent", "hidden", "opacity-zero"],
    ["offscreen", "hidden", "anchor-offscreen"],
  ]);
  assert.equal(plan.work.acceptedEntries, 0);
});

test("none, straight and elbow leaders are explicit and bounded", () => {
  const plan = resolveReferenceCalloutLayout({ width: 640, height: 360 }, [
    entry("none", { priority: 3, anchor: { x: 100, y: 80 }, leader: "none" }),
    entry("straight", {
      priority: 2,
      anchor: { x: 100, y: 180 },
      leader: "straight",
      leaderColor: "#ffffff",
      leaderWidth: 2,
    }),
    entry("elbow", {
      priority: 1,
      anchor: { x: 100, y: 280 },
      leader: "elbow",
      leaderColor: "#ffcc33",
      leaderWidth: 3,
    }),
  ]);
  assert.equal(plan.decisions[0]?.leader, undefined);
  assert.deepEqual(plan.decisions[1]?.leader?.vertices, [
    { x: 100, y: 180 },
    { x: 110, y: 180 },
  ]);
  assert.deepEqual(plan.decisions[2]?.leader?.vertices, [
    { x: 100, y: 280 },
    { x: 105, y: 280 },
    { x: 105, y: 285 },
    { x: 110, y: 285 },
  ]);
  assert.equal(plan.work.leaderSegments, 4);
});

test("planner rejects duplicate identities and enforces bounded entry/collision work", () => {
  assert.throws(
    () => resolveReferenceCalloutLayout({ width: 320, height: 180 }, [entry("same"), entry("same")]),
    /non-empty and unique/u,
  );
  assert.throws(
    () => resolveReferenceCalloutLayout(
      { width: 320, height: 180 },
      [entry("a"), entry("b")],
      { maximumEntries: 1 },
    ),
    /maximum is 1/u,
  );
  assert.throws(
    () => resolveReferenceCalloutLayout(
      { width: 320, height: 180 },
      [
        entry("a", { priority: 1, placements: ["right"] }),
        entry("b", { placements: ["right"] }),
      ],
      { maximumCandidateCollisionTests: 0 },
    ),
    /exceeds 0 candidate collision tests/u,
  );
});
