import test from "node:test";
import assert from "node:assert/strict";
import {
  AudioEditOperationError,
  executeAudioEditOperationPlan,
  validateAudioEditOperationPlan,
  type AudioEditOperationPlan,
} from "../lib/language/audio-edit-operations";
import type { IRProvenance } from "../lib/language/ir";
import { executePictureTrackOperationPlan, type IRPictureTrackOperationPlan } from "../lib/language/picture-edit-operations";
import { rational, zeroRational } from "../lib/language/rational";

const provenance: IRProvenance = {
  module: "linked-ripple-algebra.test.cut",
  span: { start: { offset: 0, line: 1, column: 1 }, end: { offset: 1, line: 1, column: 2 } },
};
const duration = rational(4), transactionId = "linked_edit_drop";

function picturePlan(): IRPictureTrackOperationPlan {
  return {
    version: 1,
    sourceDuration: duration,
    baseItems: [{
      origin: "base:0",
      kind: "picture",
      destination: { start: zeroRational, duration },
      source: { start: zeroRational, duration },
      inputs: {},
      provenance,
    }],
    operations: [{
      kind: "ripple-insert",
      at: duration,
      item: {
        origin: "operation:0",
        kind: "gap",
        destination: { start: zeroRational, duration },
        inputs: { duration: { kind: "quantity", dimension: "time", magnitude: duration, unit: "s" } },
        provenance,
      },
      transactionId,
      provenance,
    }, {
      kind: "ripple-delete",
      range: { start: zeroRational, duration },
      transactionId,
      transactionVersion: 1,
      provenance,
    }],
  };
}

function audioPlan(): AudioEditOperationPlan {
  return {
    version: 1,
    sourceDuration: duration,
    baseItems: [{
      origin: "base:0",
      kind: "clip",
      destination: { start: zeroRational, duration },
      source: { start: zeroRational, duration },
      inputs: { resourceId: "voice", linkId: "drop" },
      provenance,
    }],
    operations: [{
      kind: "ripple-insert",
      at: duration,
      item: { origin: "operation:0", kind: "gap", destination: { start: zeroRational, duration }, inputs: {}, provenance },
      transactionId,
      provenance,
    }, {
      kind: "ripple-delete",
      range: { start: zeroRational, duration },
      transactionId,
      transactionVersion: 1,
      provenance,
    }],
  };
}

test("insert-first then ripple-delete executes a complete picture/audio removal as fixed-duration gap and silence", () => {
  const picture = executePictureTrackOperationPlan(picturePlan());
  assert.deepEqual(picture.items.map((item) => [item.kind, item.destination]), [["gap", { start: zeroRational, duration }]]);

  const canonicalAudio = validateAudioEditOperationPlan(audioPlan());
  assert.equal(canonicalAudio.operations[0].kind, "ripple-insert");
  assert.equal(canonicalAudio.operations[1].kind, "ripple-delete");
  assert.ok(canonicalAudio.operations.every((operation) => "transactionId" in operation && operation.transactionId === transactionId));
  const audio = executeAudioEditOperationPlan(canonicalAudio);
  assert.deepEqual(audio.items.map((item) => [item.kind, item.destination]), [["gap", { start: zeroRational, duration }]]);
  assert.deepEqual(audio.duration, duration);
});

test("the closed audio algebra rejects transaction metadata on an unrelated operation", () => {
  const hostile = structuredClone(audioPlan()) as unknown as { operations: Array<Record<string, unknown>> };
  hostile.operations = [{ kind: "lift", range: { start: rational(0), duration: rational(1) }, transactionId, provenance }];
  assert.throws(
    () => validateAudioEditOperationPlan(hostile),
    (error: unknown) => error instanceof AudioEditOperationError && error.code === "CUT_AUDIO_EDIT_SHAPE" && /transactionId/.test(error.message),
  );
});
