import { parse as parseOpenType, type Font, type RenderOptions } from "opentype.js";
import { createHash } from "node:crypto";

export const lockedFontEngineIdentity = "opentype.js@1.3.4" as const;

export type LockedOpenTypeFont = {
  font: Font;
  engine: typeof lockedFontEngineIdentity;
  locator: string;
  byteLength: number;
  sha256: string;
};

export type LockedGlyphRun = {
  pathData: string;
  commands: number;
  pathBytes: number;
  x1: number;
  x2: number;
  y1: number;
  y2: number;
  /** Advance from the fixed shaper, including requested tracking. */
  advance: number;
  width: number;
};

/** One glyph selected by the same fixed shaper used by `lockedGlyphRun`.
 * Coordinates and path data are relative to the authored run origin. A
 * ligature is therefore one unit; a Unicode code point is not silently
 * substituted for shaped-glyph identity. */
export type LockedGlyphUnit = {
  glyphIndex: number;
  pathData: string;
  commands: number;
  pathBytes: number;
  x1: number;
  x2: number;
  y1: number;
  y2: number;
  originX: number;
};

export type LockedGlyphUnits = {
  units: readonly LockedGlyphUnit[];
  advance: number;
  commands: number;
  pathBytes: number;
};

/**
 * One already-selected glyph outline at an already-resolved delivery-space
 * baseline position. This record contains only frozen primitive values: it
 * never exposes opentype.js's mutable Glyph or Path objects to a compositor.
 */
export type LockedGlyphIdOutline = Readonly<{
  fontSha256: string;
  glyphIndex: number;
  originX: number;
  baselineY: number;
  size: number;
  pathData: string;
  commands: number;
  pathBytes: number;
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}>;

export type LockedFontParseLimits = {
  maxBytes: number;
  maxGlyphs: number;
};

export type LockedGlyphRunLimits = {
  maxCommands: number;
  maxPathBytes: number;
};

const renderOptions: RenderOptions = { kerning: true, features: { liga: true, rlig: true } };
const unsupportedSfntTables = new Map([
  ["fvar", "variable-font axes"],
  ["gvar", "variable TrueType outlines"],
  ["CFF2", "variable CFF2 outlines"],
  ["COLR", "layered color glyphs"],
  ["CPAL", "color palettes"],
  ["CBDT", "color bitmap glyphs"],
  ["CBLC", "color bitmap locations"],
  ["sbix", "Apple bitmap glyphs"],
  ["SVG ", "SVG glyphs"],
  ["EBDT", "embedded bitmap glyphs"],
  ["EBLC", "embedded bitmap locations"],
]);

export function lockedFontBytesIdentity(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function parseLockedOpenTypeFont(bytes: Buffer, locator: string, limits: LockedFontParseLimits): LockedOpenTypeFont {
  if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 1 || !Number.isSafeInteger(limits.maxGlyphs) || limits.maxGlyphs < 1) throw new Error("Locked OpenType parser limits must be positive safe integers.");
  if (bytes.byteLength > limits.maxBytes) throw new Error(`locked font exceeds the ${limits.maxBytes}-byte font budget.`);
  if (bytes.byteLength < 12) throw new Error("locked font is too short to contain an sfnt header.");
  if (!/\.(?:ttf|otf)$/i.test(locator)) throw new Error("locked font must use a .ttf or .otf locator; WOFF, collections, and system-font fallback are unsupported.");
  const signature = bytes.subarray(0, 4);
  if (!signature.equals(Buffer.from([0, 1, 0, 0])) && signature.toString("ascii") !== "OTTO") throw new Error("locked font does not have a supported TrueType or OpenType/CFF sfnt signature.");
  const tableCount = bytes.readUInt16BE(4), directoryBytes = 12 + tableCount * 16;
  if (tableCount < 1 || tableCount > 4_096 || !Number.isSafeInteger(directoryBytes) || directoryBytes > bytes.byteLength) throw new Error("locked font has an invalid or over-budget sfnt table directory.");
  for (let offset = 12; offset < directoryBytes; offset += 16) {
    const tag = bytes.toString("ascii", offset, offset + 4), unsupported = unsupportedSfntTables.get(tag);
    if (unsupported) throw new Error(`locked font contains unsupported ${tag.trim()} ${unsupported}; use a fixed-instance monochrome outline TTF/OTF.`);
  }
  let font: Font;
  try {
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    font = parseOpenType(arrayBuffer);
  } catch (error) {
    throw new Error(`locked font cannot be parsed by ${lockedFontEngineIdentity}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Number.isSafeInteger(font.numGlyphs) || font.numGlyphs < 1 || font.numGlyphs > limits.maxGlyphs) throw new Error(`locked font glyph count must be from 1 through ${limits.maxGlyphs}.`);
  if (!Number.isSafeInteger(font.unitsPerEm) || font.unitsPerEm < 16 || font.unitsPerEm > 16_384) throw new Error("locked font unitsPerEm is outside the supported 16...16384 range.");
  return { font, engine: lockedFontEngineIdentity, locator, byteLength: bytes.byteLength, sha256: lockedFontBytesIdentity(bytes) };
}

export function assertLockedFontCoverage(font: LockedOpenTypeFont, text: string) {
  for (const character of text) {
    if (font.font.charToGlyphIndex(character) === 0) throw new Error(`locked font has no glyph for U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}; font fallback is forbidden.`);
  }
}

/** Measure exactly the same fixed shaping path used by `lockedGlyphRun`, without allocating outlines. */
export function lockedGlyphAdvance(font: LockedOpenTypeFont, text: string, size: number, tracking = 0) {
  if (!Number.isFinite(size) || size <= 0) throw new Error("Locked glyph advance size must be a positive finite number.");
  if (!Number.isFinite(tracking)) throw new Error("Locked glyph advance tracking must be finite.");
  assertLockedFontCoverage(font, text);
  const options: RenderOptions = tracking === 0 ? renderOptions : { ...renderOptions, letterSpacing: tracking / size };
  const advance = font.font.getAdvanceWidth(text, size, options);
  if (!Number.isFinite(advance) || advance < 0) throw new Error("locked font produced a non-finite or negative advance.");
  return advance;
}

/** Count the glyphs selected by the same fixed shaping configuration without
 * allocating paths. FlowText uses this only to prove that an equal-style span
 * boundary does not bisect a contextual/ligature substitution. */
export function lockedGlyphCount(font: LockedOpenTypeFont, text: string, size: number, tracking = 0) {
  if (!Number.isFinite(size) || size <= 0) throw new Error("Locked glyph count size must be a positive finite number.");
  if (!Number.isFinite(tracking)) throw new Error("Locked glyph count tracking must be finite.");
  if (!text || /\s/u.test(text)) throw new Error("Locked glyph count requires one non-whitespace shaped run.");
  assertLockedFontCoverage(font, text);
  const options: RenderOptions = tracking === 0 ? renderOptions : { ...renderOptions, letterSpacing: tracking / size };
  let count = 0;
  const advance = font.font.forEachGlyph(text, 0, 0, size, options, (glyph) => {
    if (glyph.index === 0) throw new Error("locked font shaping selected the missing .notdef glyph; font fallback is forbidden.");
    count += 1;
  });
  if (!Number.isSafeInteger(count) || count < 1 || !Number.isFinite(advance) || advance <= 0) throw new Error("locked font produced an empty or unsafe shaped glyph count.");
  return count;
}

/**
 * Select and count the exact glyph run before concatenating outlines. Throwing
 * from the callback stops a repeated complex glyph before getPath can expand it
 * across the whole line.
 */
/**
 * Turn one already-decided line into explicit outline geometry. `tracking` is
 * an additive pixel advance after every shaped glyph, matching opentype.js's
 * `letterSpacing` option without ever delegating shaping to SVG or the host.
 */
export function lockedGlyphRun(font: LockedOpenTypeFont, text: string, size: number, limits: LockedGlyphRunLimits, tracking = 0): LockedGlyphRun {
  if (!Number.isFinite(size) || size <= 0) throw new Error("Locked glyph-run size must be a positive finite number.");
  if (!Number.isFinite(tracking)) throw new Error("Locked glyph-run tracking must be finite.");
  if (!Number.isSafeInteger(limits.maxCommands) || limits.maxCommands < 1 || !Number.isSafeInteger(limits.maxPathBytes) || limits.maxPathBytes < 1) throw new Error("Locked glyph-run limits must be positive safe integers.");
  assertLockedFontCoverage(font, text);
  const options: RenderOptions = tracking === 0 ? renderOptions : { ...renderOptions, letterSpacing: tracking / size };
  let selectedCommands = 0;
  const advance = font.font.forEachGlyph(text, 0, 0, size, options, (glyph) => {
    if (glyph.index === 0) throw new Error("locked font shaping selected the missing .notdef glyph; font fallback is forbidden.");
    const commands = glyph.path.commands.length;
    if (!Number.isSafeInteger(commands) || commands < 0) throw new Error("locked font selected an unsafe glyph outline.");
    selectedCommands += commands;
    if (!Number.isSafeInteger(selectedCommands) || selectedCommands > limits.maxCommands) throw new Error(`locked glyph run exceeds the ${limits.maxCommands}-command outline budget.`);
  });
  const path = font.font.getPath(text, 0, 0, size, options), bounds = path.getBoundingBox(), commands = path.commands.length;
  const values = [bounds.x1, bounds.x2, bounds.y1, bounds.y2, advance];
  if (!values.every(Number.isFinite)) throw new Error("locked font produced non-finite outline metrics.");
  if (!Number.isSafeInteger(commands) || commands < 1 || commands > limits.maxCommands) throw new Error("locked font produced an empty or over-budget combined outline.");
  const x1 = Math.min(0, bounds.x1), x2 = Math.max(advance, bounds.x2), width = x2 - x1;
  if (!(width > 0)) throw new Error("locked font produced a zero-width outline.");
  const pathData = path.toPathData(4), pathBytes = Buffer.byteLength(pathData, "utf8");
  if (pathBytes > limits.maxPathBytes) throw new Error(`locked glyph run exceeds the ${limits.maxPathBytes}-byte SVG-path budget.`);
  return { pathData, commands, pathBytes, x1, x2, y1: bounds.y1, y2: bounds.y2, advance, width };
}

/**
 * Resolve the stable shaped glyph units for a non-whitespace run. This uses
 * one `forEachGlyph` call, so kerning and ligature selection are identical to
 * the full locked run. It exists for FlowText unit selection; callers must not
 * infer a one-to-one code-point mapping.
 */
export function lockedGlyphUnits(font: LockedOpenTypeFont, text: string, size: number, limits: LockedGlyphRunLimits, tracking = 0): LockedGlyphUnits {
  if (!Number.isFinite(size) || size <= 0) throw new Error("Locked glyph-unit size must be a positive finite number.");
  if (!Number.isFinite(tracking)) throw new Error("Locked glyph-unit tracking must be finite.");
  if (!Number.isSafeInteger(limits.maxCommands) || limits.maxCommands < 1 || !Number.isSafeInteger(limits.maxPathBytes) || limits.maxPathBytes < 1) throw new Error("Locked glyph-unit limits must be positive safe integers.");
  if (!text || /\s/u.test(text)) throw new Error("Locked glyph units require one non-whitespace shaped run.");
  assertLockedFontCoverage(font, text);
  const options: RenderOptions = tracking === 0 ? renderOptions : { ...renderOptions, letterSpacing: tracking / size };
  const units: LockedGlyphUnit[] = [];
  let commands = 0, pathBytes = 0;
  const advance = font.font.forEachGlyph(text, 0, 0, size, options, (glyph, x, y, fontSize, glyphOptions) => {
    if (glyph.index === 0) throw new Error("locked font shaping selected the missing .notdef glyph; font fallback is forbidden.");
    const path = glyph.getPath(x, y, fontSize, glyphOptions, font.font), bounds = path.getBoundingBox(), count = path.commands.length;
    if (!Number.isSafeInteger(count) || count < 1) throw new Error("locked font produced an empty or unsafe selected glyph outline.");
    commands += count;
    if (!Number.isSafeInteger(commands) || commands > limits.maxCommands) throw new Error(`locked glyph units exceed the ${limits.maxCommands}-command outline budget.`);
    const pathData = path.toPathData(4), bytes = Buffer.byteLength(pathData, "utf8");
    pathBytes += bytes;
    if (!Number.isSafeInteger(pathBytes) || pathBytes > limits.maxPathBytes) throw new Error(`locked glyph units exceed the ${limits.maxPathBytes}-byte SVG-path budget.`);
    const metrics = [x, bounds.x1, bounds.x2, bounds.y1, bounds.y2];
    if (!metrics.every(Number.isFinite)) throw new Error("locked font produced non-finite selected glyph metrics.");
    units.push({ glyphIndex: glyph.index, pathData, commands: count, pathBytes: bytes, x1: bounds.x1, x2: bounds.x2, y1: bounds.y1, y2: bounds.y2, originX: x });
  });
  if (!Number.isFinite(advance) || advance <= 0 || !units.length) throw new Error("locked font produced an empty or non-positive shaped glyph run.");
  return { units, advance, commands, pathBytes };
}

/**
 * Materialize one glyph whose numeric ID was selected by an authenticated
 * external shaper. `originX` and `baselineY` are the caller's already-resolved
 * delivery-space placement; this function performs no character lookup,
 * substitution, fallback, or host-font access.
 *
 * Glyph zero is rejected because accepting `.notdef` here would turn missing
 * coverage into a silent fallback. A valid glyph with no outline (for example
 * a locked space glyph) remains representable as an empty path. Command work
 * is checked on the locked source outline before the positioned path and SVG
 * string are materialized.
 */
export function lockedGlyphIdOutline(
  font: LockedOpenTypeFont,
  glyphIndex: number,
  originX: number,
  baselineY: number,
  size: number,
  limits: LockedGlyphRunLimits,
): LockedGlyphIdOutline {
  if (!Number.isSafeInteger(glyphIndex) || glyphIndex < 1 || glyphIndex >= font.font.numGlyphs) {
    throw new Error(`locked glyph id must be a safe integer from 1 through ${font.font.numGlyphs - 1}; .notdef and out-of-range glyphs are forbidden.`);
  }
  if (![originX, baselineY].every(Number.isFinite)) throw new Error("Locked glyph-id placement must use finite delivery-space coordinates.");
  if (!Number.isFinite(size) || size <= 0) throw new Error("Locked glyph-id outline size must be a positive finite number.");
  if (!Number.isSafeInteger(limits.maxCommands) || limits.maxCommands < 1 || !Number.isSafeInteger(limits.maxPathBytes) || limits.maxPathBytes < 1) {
    throw new Error("Locked glyph-id outline limits must be positive safe integers.");
  }
  const glyph = font.font.glyphs.get(glyphIndex);
  if (!glyph || glyph.index !== glyphIndex) throw new Error("locked font could not resolve the selected glyph id exactly.");
  const sourceCommands = glyph.path.commands.length;
  if (!Number.isSafeInteger(sourceCommands) || sourceCommands < 0) throw new Error("locked font selected an unsafe glyph-id outline.");
  if (sourceCommands > limits.maxCommands) throw new Error(`locked glyph-id outline exceeds the ${limits.maxCommands}-command outline budget.`);
  const path = glyph.getPath(originX, baselineY, size, undefined, font.font), commands = path.commands.length;
  if (!Number.isSafeInteger(commands) || commands < 0 || commands !== sourceCommands) throw new Error("locked font produced an inconsistent positioned glyph-id outline.");
  const pathData = path.toPathData(4), pathBytes = Buffer.byteLength(pathData, "utf8");
  if (!Number.isSafeInteger(pathBytes) || pathBytes > limits.maxPathBytes) throw new Error(`locked glyph-id outline exceeds the ${limits.maxPathBytes}-byte SVG-path budget.`);
  const bounds = path.getBoundingBox();
  const [x1, x2, y1, y2] = commands === 0
    ? [originX, originX, baselineY, baselineY]
    : [bounds.x1, bounds.x2, bounds.y1, bounds.y2];
  if (![x1, x2, y1, y2].every(Number.isFinite)) throw new Error("locked font produced non-finite positioned glyph-id metrics.");
  return Object.freeze({
    fontSha256: font.sha256,
    glyphIndex,
    originX,
    baselineY,
    size,
    pathData,
    commands,
    pathBytes,
    x1,
    x2,
    y1,
    y2,
  });
}
