import assert from "node:assert/strict";
import test from "node:test";
import {
  assertEditorialMarkerTime,
  assertEditorialRegionRange,
  EditorialAnnotationError,
  editorialAnnotationMetadataBytes,
  editorialAnnotationLimits,
  normalizeEditorialAnnotationMetadata,
} from "../lib/language/editorial-annotations";
import { rational } from "../lib/language/rational";

const frameClock = { fps: rational(24), sampleRate: 48_000, duration: rational(10) };

test("editorial annotation metadata has bounded executable defaults", () => {
  const metadata = normalizeEditorialAnnotationMetadata({ id: "chapter.1" });
  assert.deepEqual(metadata, {
    id: "chapter.1",
    name: "chapter.1",
    color: "#808080",
    role: "note",
    comment: "",
    grid: "frame",
  });
  assert.equal(editorialAnnotationMetadataBytes(metadata), 34, "metadata budget counts authored/default UTF-8 value bytes; fixed schema field names are bounded separately");
  assert.ok(editorialAnnotationMetadataBytes(metadata) < editorialAnnotationLimits.maximumTotalMetadataBytes);
});

test("editorial annotation metadata keeps Unicode while refusing unsafe or unbounded values", () => {
  assert.deepEqual(normalizeEditorialAnnotationMetadata({
    id: "dialogue-a",
    name: "Dialogue 🎙️",
    color: "#AABBCCDD",
    role: "transcript",
    comment: "Speaker changes here.",
    grid: "sample",
  }), {
    id: "dialogue-a",
    name: "Dialogue 🎙️",
    color: "#aabbccdd",
    role: "transcript",
    comment: "Speaker changes here.",
    grid: "sample",
  });
  assert.throws(
    () => normalizeEditorialAnnotationMetadata({ id: "1 invalid" }),
    (error: unknown) => error instanceof EditorialAnnotationError && error.code === "CUT_ANNOTATION_ID",
  );
  assert.throws(
    () => normalizeEditorialAnnotationMetadata({ id: "safe", comment: "x".repeat(editorialAnnotationLimits.maximumCommentBytes + 1) }),
    (error: unknown) => error instanceof EditorialAnnotationError && error.code === "CUT_ANNOTATION_METADATA",
  );
  assert.throws(
    () => normalizeEditorialAnnotationMetadata({ id: "safe", name: "\ud800" }),
    (error: unknown) => error instanceof EditorialAnnotationError && error.code === "CUT_ANNOTATION_METADATA",
  );
  assert.throws(
    () => normalizeEditorialAnnotationMetadata({ id: "safe", role: "render-me" }),
    (error: unknown) => error instanceof EditorialAnnotationError && error.code === "CUT_ANNOTATION_ROLE",
  );
});

test("marker and region boundaries honor their authored exact grid", () => {
  const frame = normalizeEditorialAnnotationMetadata({ id: "frame", grid: "frame" });
  const sample = normalizeEditorialAnnotationMetadata({ id: "sample", grid: "sample" });
  assert.doesNotThrow(() => assertEditorialMarkerTime(rational(1, 24), frame, frameClock));
  assert.throws(
    () => assertEditorialMarkerTime(rational(1, 48), frame, frameClock),
    (error: unknown) => error instanceof EditorialAnnotationError && error.code === "CUT_ANNOTATION_TIMING" && /frame boundary/.test(error.message),
  );
  assert.doesNotThrow(() => assertEditorialMarkerTime(rational(1, 48_000), sample, frameClock));
  assert.throws(
    () => assertEditorialMarkerTime(rational(1, 96_000), sample, frameClock),
    (error: unknown) => error instanceof EditorialAnnotationError && error.code === "CUT_ANNOTATION_TIMING" && /sample boundary/.test(error.message),
  );
  assert.doesNotThrow(() => assertEditorialRegionRange(rational(1), rational(2), frame, frameClock));
  assert.throws(
    () => assertEditorialRegionRange(rational(1), rational(0), frame, frameClock),
    (error: unknown) => error instanceof EditorialAnnotationError && error.code === "CUT_ANNOTATION_TIMING" && /positive/.test(error.message),
  );
  assert.throws(
    () => assertEditorialRegionRange(rational(9), rational(2), frame, frameClock),
    (error: unknown) => error instanceof EditorialAnnotationError && error.code === "CUT_ANNOTATION_TIMING" && /outside/.test(error.message),
  );
});
