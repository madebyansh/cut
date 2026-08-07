import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  lockedGlyphIdOutline,
  parseLockedOpenTypeFont,
  type LockedGlyphRunLimits,
} from "../lib/runtime/reference/locked-font";

const fixturePath = resolve("examples/fixtures/Geist-Regular.ttf");
const limits: LockedGlyphRunLimits = { maxCommands: 1_000, maxPathBytes: 64_000 };

async function fixture() {
  const bytes = await readFile(fixturePath);
  const font = parseLockedOpenTypeFont(bytes, "assets/Geist-Regular.ttf", {
    maxBytes: 8 * 1024 * 1024,
    maxGlyphs: 100_000,
  });
  return { bytes, font };
}

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

test("locked glyph-id outlines bind exact locked glyph selection, fractional placement, and scale", async () => {
  const { font } = await fixture(), glyphIndex = font.font.charToGlyphIndex("A");
  const outline = lockedGlyphIdOutline(font, glyphIndex, 17.25, 93.5, 41.75, limits);
  assert.deepEqual(outline, {
    fontSha256: "bde046ddd9f20be35b0bd56cc79eb752b967fb6661a3fe76cb067bb09f871d76",
    glyphIndex: 1,
    originX: 17.25,
    baselineY: 93.5,
    size: 41.75,
    pathData: "M22.0095 93.5000L18.0850 93.5000L28.7730 63.8575L33.6160 63.8575L44.3040 93.5000L40.3795 93.5000L37.4153 85.0665L24.9738 85.0665L22.0095 93.5000ZM31.1945 66.9887L26.1845 81.5595L36.2045 81.5595L31.1945 66.9887Z",
    commands: 15,
    pathBytes: 210,
    x1: 18.085,
    x2: 44.304,
    y1: 63.8575,
    y2: 93.5,
  });
  assert.equal(sha256(outline.pathData), "1e2a3b3163287426f4f336e232bb8ea4285dc323fb32a1d0d22a27c92ec5db26");
  assert.equal(Object.isFrozen(outline), true);

  const translated = lockedGlyphIdOutline(font, glyphIndex, 27.25, 113.5, 41.75, limits);
  assert.equal(translated.x1, outline.x1 + 10);
  assert.equal(translated.x2, outline.x2 + 10);
  assert.equal(translated.y1, outline.y1 + 20);
  assert.equal(translated.y2, outline.y2 + 20);
  assert.equal(translated.commands, outline.commands);

  const doubled = lockedGlyphIdOutline(font, glyphIndex, 17.25, 93.5, 83.5, limits);
  assert.ok(Math.abs((doubled.x2 - doubled.x1) - 2 * (outline.x2 - outline.x1)) < 1e-9);
  assert.ok(Math.abs((doubled.y2 - doubled.y1) - 2 * (outline.y2 - outline.y1)) < 1e-9);
  assert.equal(doubled.commands, outline.commands);
});

test("locked glyph-id outlines represent valid empty locked glyphs without host fallback", async () => {
  const { font } = await fixture(), glyphIndex = font.font.charToGlyphIndex(" ");
  assert.notEqual(glyphIndex, 0);
  const outline = lockedGlyphIdOutline(font, glyphIndex, -12.5, 8.25, 48, limits);
  assert.equal(outline.glyphIndex, glyphIndex);
  assert.equal(outline.pathData, "");
  assert.equal(outline.commands, 0);
  assert.equal(outline.pathBytes, 0);
  assert.deepEqual([outline.x1, outline.x2, outline.y1, outline.y2], [-12.5, -12.5, 8.25, 8.25]);
});

test("locked glyph-id outline budgets reject before accepting positioned geometry", async () => {
  const { font } = await fixture(), glyphIndex = font.font.charToGlyphIndex("A");
  const accepted = lockedGlyphIdOutline(font, glyphIndex, 17.25, 93.5, 41.75, limits);
  assert.throws(
    () => lockedGlyphIdOutline(font, glyphIndex, 17.25, 93.5, 41.75, { ...limits, maxCommands: accepted.commands - 1 }),
    /exceeds the 14-command outline budget/,
  );
  assert.throws(
    () => lockedGlyphIdOutline(font, glyphIndex, 17.25, 93.5, 41.75, { ...limits, maxPathBytes: accepted.pathBytes - 1 }),
    /exceeds the 209-byte SVG-path budget/,
  );
  for (const invalid of [
    { maxCommands: 0, maxPathBytes: 1 },
    { maxCommands: 1, maxPathBytes: 0 },
    { maxCommands: 1.5, maxPathBytes: 1 },
  ]) {
    assert.throws(() => lockedGlyphIdOutline(font, glyphIndex, 0, 0, 12, invalid), /limits must be positive safe integers/);
  }
});

test("locked glyph-id outlines fail closed for notdef, forged ids, placement, and scale", async () => {
  const { font } = await fixture(), glyphIndex = font.font.charToGlyphIndex("A");
  for (const invalid of [0, -1, 1.5, Number.NaN, font.font.numGlyphs, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => lockedGlyphIdOutline(font, invalid, 0, 0, 12, limits), /\.notdef and out-of-range glyphs are forbidden/);
  }
  for (const [x, y] of [[Number.NaN, 0], [0, Number.POSITIVE_INFINITY]]) {
    assert.throws(() => lockedGlyphIdOutline(font, glyphIndex, x, y, 12, limits), /finite delivery-space coordinates/);
  }
  for (const size of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => lockedGlyphIdOutline(font, glyphIndex, 0, 0, size, limits), /positive finite number/);
  }
});

test("locked glyph-id outline extraction is deterministic and does not expose or mutate caller state", async () => {
  const { bytes, font } = await fixture(), beforeBytes = Buffer.from(bytes), glyphIndex = font.font.charToGlyphIndex("f");
  const sourceCommands = JSON.stringify(font.font.glyphs.get(glyphIndex).path.commands);
  const first = lockedGlyphIdOutline(font, glyphIndex, 3.125, 72.75, 52.5, limits);
  const second = lockedGlyphIdOutline(font, glyphIndex, 3.125, 72.75, 52.5, limits);
  assert.deepEqual(second, first);
  assert.notEqual(second, first);
  assert.equal(JSON.stringify(font.font.glyphs.get(glyphIndex).path.commands), sourceCommands);
  assert.deepEqual(bytes, beforeBytes);
  assert.equal(font.sha256, sha256(bytes));
  assert.throws(() => Object.assign(first, { pathData: "mutated" }), TypeError);
  assert.notEqual(second.pathData, "mutated");
});
