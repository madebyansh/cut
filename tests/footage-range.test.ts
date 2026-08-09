import assert from "node:assert/strict";
import test from "node:test";
import { rational } from "../lib/language/rational";
import {
  ceilFootageTimeToGrid,
  clampFootageHandles,
  floorFootageTimeToGrid,
  planFootageChunkRanges,
} from "../lib/footage/range";

test("footage range math floors and ceils exact times to the selected stream grid", () => {
  const grid = rational(1, 24);
  assert.deepEqual(floorFootageTimeToGrid(rational(7, 100), grid), rational(1, 24));
  assert.deepEqual(ceilFootageTimeToGrid(rational(7, 100), grid), rational(1, 12));
  assert.deepEqual(floorFootageTimeToGrid(rational(-7, 100), grid), rational(-1, 12));
});

test("footage chunk planning creates sorted exact half-open source ranges without a tail past duration", () => {
  assert.deepEqual(
    planFootageChunkRanges({ duration: rational(10), chunkDuration: rational(3), overlap: rational(1), grid: rational(1) }),
    [
      { semantics: "half-open", start: rational(0), end: rational(3) },
      { semantics: "half-open", start: rational(2), end: rational(5) },
      { semantics: "half-open", start: rational(4), end: rational(7) },
      { semantics: "half-open", start: rational(6), end: rational(9) },
      { semantics: "half-open", start: rational(8), end: rational(10) },
    ],
  );
});

test("footage handles clamp at source bounds and report the effective exact handles", () => {
  assert.deepEqual(
    clampFootageHandles({
      range: { semantics: "half-open", start: rational(1, 24), end: rational(2, 24) }, duration: rational(3, 24),
      requested: { head: rational(2, 24), tail: rational(2, 24) }, grid: rational(1, 24),
    }),
    {
      requested: { head: rational(1, 12), tail: rational(1, 12) }, effective: { head: rational(1, 24), tail: rational(1, 24) },
      range: { semantics: "half-open", start: rational(0), end: rational(1, 8) },
    },
  );
});
