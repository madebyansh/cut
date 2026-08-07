import assert from "node:assert/strict";
import test from "node:test";
import {
  CutTranscriptPictureSnapError,
  cutTranscriptPictureCoverRange,
  cutTranscriptPictureSnapContract,
  cutTranscriptPictureVideoSourceRange,
} from "../lib/language/transcript-contract";
import { rational } from "../lib/language/rational";

test("transcript picture cover range selects the exact intersecting source frames", () => {
  assert.deepEqual(
    cutTranscriptPictureCoverRange(
      { start: rational(1, 10), duration: rational(1, 2) },
      rational(24),
      rational(1),
    ),
    {
      start: rational(1, 12),
      duration: rational(13, 24),
      firstFrame: "2",
      frameCount: "13",
      frameRate: rational(24),
      contract: cutTranscriptPictureSnapContract,
    },
  );

  assert.deepEqual(
    cutTranscriptPictureCoverRange(
      { start: rational(1, 4), duration: rational(1, 2) },
      rational(24),
      rational(1),
    ),
    {
      start: rational(1, 4),
      duration: rational(1, 2),
      firstFrame: "6",
      frameCount: "12",
      frameRate: rational(24),
      contract: cutTranscriptPictureSnapContract,
    },
  );

  const twoEdgePartials = cutTranscriptPictureCoverRange(
    { start: rational(33, 800), duration: rational(1, 1_200) },
    rational(24),
    rational(1),
  );
  assert.deepEqual(twoEdgePartials, {
    start: rational(0),
    duration: rational(1, 12),
    firstFrame: "0",
    frameCount: "2",
    frameRate: rational(24),
    contract: cutTranscriptPictureSnapContract,
  });
  const extra = {
    numerator: (
      BigInt(twoEdgePartials.duration.numerator) * 1_200n
      - BigInt(twoEdgePartials.duration.denominator)
    ).toString(),
    denominator: (
      BigInt(twoEdgePartials.duration.denominator) * 1_200n
    ).toString(),
  };
  assert.ok(
    BigInt(extra.numerator) * 24n > BigInt(extra.denominator),
    "two partial edges can exceed one frame total",
  );
  assert.ok(
    BigInt(extra.numerator) * 12n < BigInt(extra.denominator),
    "two partial edges remain strictly below two frames total",
  );
});

test("transcript picture cover range fails instead of reading past media", () => {
  assert.throws(
    () => cutTranscriptPictureCoverRange(
      { start: rational(23, 24), duration: rational(1, 48) },
      rational(24),
      rational(47, 48),
    ),
    (error: unknown) => error instanceof CutTranscriptPictureSnapError
      && error.code === "CUT_TRANSCRIPT_PICTURE_TIME"
      && /extend beyond/u.test(error.message),
  );
  assert.throws(
    () => cutTranscriptPictureCoverRange(
      { start: rational(-1, 48), duration: rational(1, 24) },
      rational(24),
      rational(1),
    ),
    (error: unknown) => error instanceof CutTranscriptPictureSnapError
      && error.code === "CUT_TRANSCRIPT_PICTURE_TIME",
  );
});

test("transcript picture translates exact positive and negative presentation deltas before frame cover", () => {
  const positive = cutTranscriptPictureVideoSourceRange(
    { start: rational(1, 10), duration: rational(1, 2) },
    rational(1, 4),
    rational(3),
  );
  assert.deepEqual(positive, {
    start: rational(7, 20),
    duration: rational(1, 2),
  });
  assert.deepEqual(
    cutTranscriptPictureCoverRange(positive, rational(24), rational(3)),
    {
      start: rational(1, 3),
      duration: rational(13, 24),
      firstFrame: "8",
      frameCount: "13",
      frameRate: rational(24),
      contract: cutTranscriptPictureSnapContract,
    },
  );

  const negative = cutTranscriptPictureVideoSourceRange(
    { start: rational(1, 2), duration: rational(1, 2) },
    rational(-1, 4),
    rational(3),
  );
  assert.deepEqual(negative, {
    start: rational(1, 4),
    duration: rational(1, 2),
  });
  assert.deepEqual(
    cutTranscriptPictureCoverRange(negative, rational(24), rational(3)),
    {
      start: rational(1, 4),
      duration: rational(1, 2),
      firstFrame: "6",
      frameCount: "12",
      frameRate: rational(24),
      contract: cutTranscriptPictureSnapContract,
    },
  );
});

test("transcript picture presentation translation requires complete decoded-video coverage", () => {
  assert.throws(
    () => cutTranscriptPictureVideoSourceRange(
      { start: rational(1, 10), duration: rational(1, 2) },
      rational(-1, 4),
      rational(3),
    ),
    (error: unknown) => error instanceof CutTranscriptPictureSnapError
      && error.code === "CUT_TRANSCRIPT_PICTURE_TIME"
      && /before decoded frame zero/u.test(error.message),
  );
  assert.throws(
    () => cutTranscriptPictureVideoSourceRange(
      { start: rational(5, 2), duration: rational(1, 2) },
      rational(1, 4),
      rational(3),
    ),
    (error: unknown) => error instanceof CutTranscriptPictureSnapError
      && error.code === "CUT_TRANSCRIPT_PICTURE_TIME"
      && /beyond decoded-video duration/u.test(error.message),
  );
});
