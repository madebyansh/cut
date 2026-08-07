import { createHash } from "node:crypto";
import bidiFactory from "bidi-js";
import {
  collectInstalledComplexTextBackendIdentity,
  referenceComplexTextBackendContract,
  type ReferenceComplexTextBackendIdentity,
} from "../../language/dependency-identity";

export type ReferenceComplexTextShapingLimits = Readonly<{
  maximumTextCodeUnits: number;
  maximumTokens: number;
  maximumFonts: number;
  maximumFontBytes: number;
  maximumAggregateFontBytes: number;
  maximumGlyphs: number;
  maximumClusters: number;
}>;

export const referenceComplexTextShapingLimits:
  ReferenceComplexTextShapingLimits = Object.freeze({
  maximumTextCodeUnits: 16_384,
  maximumTokens: 4_096,
  maximumFonts: 8,
  maximumFontBytes: 16 * 1024 * 1024,
  maximumAggregateFontBytes: 32 * 1024 * 1024,
  maximumGlyphs: 65_536,
  maximumClusters: 32_768,
});

export type ReferenceComplexTextDirection = "ltr" | "rtl";

export type ReferenceComplexTextFont = Readonly<{
  id: string;
  locator: string;
  bytes: Uint8Array;
  sha256: string;
}>;

export type ReferenceComplexTextGlyph = Readonly<{
  glyphId: number;
  flags: number;
  xAdvance: number;
  yAdvance: number;
  xOffset: number;
  yOffset: number;
}>;

export type ReferenceComplexTextCluster = Readonly<{
  id: string;
  logicalIndex: number;
  visualIndex: number;
  start: number;
  end: number;
  bidiLevel: number;
  fontId: string;
  fontSha256: string;
  glyphs: readonly ReferenceComplexTextGlyph[];
  xAdvance: number;
  yAdvance: number;
}>;

export type ReferenceComplexTextShapingResult = Readonly<{
  format: "cut-reference-complex-text-shaping";
  version: 1;
  backend: ReferenceComplexTextBackendIdentity;
  textSha256: string;
  direction: ReferenceComplexTextDirection;
  language: string;
  glyphCount: number;
  fontChain: readonly Readonly<{
    id: string;
    locator: string;
    sha256: string;
    byteLength: number;
    unitsPerEm: number;
  }>[];
  tokens: readonly Readonly<{
    start: number;
    end: number;
    fontId: string;
    fontSha256: string;
  }>[];
  logicalClusters: readonly ReferenceComplexTextCluster[];
  visualClusterIds: readonly string[];
}>;

export type { ReferenceComplexTextBackendIdentity } from "../../language/dependency-identity";

export type ReferenceComplexTextShapingErrorCode =
  | "CUT_COMPLEX_TEXT_BACKEND"
  | "CUT_COMPLEX_TEXT_BIDI"
  | "CUT_COMPLEX_TEXT_BUDGET"
  | "CUT_COMPLEX_TEXT_FALLBACK"
  | "CUT_COMPLEX_TEXT_INPUT"
  | "CUT_COMPLEX_TEXT_RESOURCE";

export class ReferenceComplexTextShapingError extends Error {
  readonly code: ReferenceComplexTextShapingErrorCode;

  constructor(code: ReferenceComplexTextShapingErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "ReferenceComplexTextShapingError";
    this.code = code;
  }
}

type HarfBuzz = typeof import(
  "harfbuzzjs",
  { with: { "resolution-mode": "import" } }
);

type BidiEmbeddingLevels = Readonly<{
  levels: Uint8Array;
  paragraphs: readonly Readonly<{ start: number; end: number; level: number }>[];
}>;

type BidiApi = Readonly<{
  getEmbeddingLevels(
    text: string,
    direction: ReferenceComplexTextDirection,
  ): BidiEmbeddingLevels;
  getReorderSegments(
    text: string,
    embedding: BidiEmbeddingLevels,
    start?: number,
    end?: number,
  ): readonly (readonly [number, number])[];
  getMirroredCharactersMap(
    text: string,
    embedding: BidiEmbeddingLevels,
    start?: number,
    end?: number,
  ): ReadonlyMap<number, string>;
}>;

type BidiFactory = () => BidiApi;

type PreparedFont = Readonly<{
  id: string;
  locator: string;
  sha256: string;
  byteLength: number;
  bytes: Uint8Array;
  blob: InstanceType<HarfBuzz["Blob"]>;
  face: InstanceType<HarfBuzz["Face"]>;
  font: InstanceType<HarfBuzz["Font"]>;
}>;

type Token = Readonly<{
  start: number;
  end: number;
  font: PreparedFont;
}>;

type MutableCluster = {
  start: number;
  end: number;
  bidiLevel: number;
  font: PreparedFont;
  glyphs: ReferenceComplexTextGlyph[];
};

export { referenceComplexTextBackendContract } from "../../language/dependency-identity";

const fontIdPattern = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/u;
const fontLocatorPattern =
  /^(?!\/)(?![A-Za-z]:)(?!.*\\)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?:[^/]+\/)*[^/]+\.(?:ttf|otf)$/iu;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const languagePattern = /^[a-z]{2,8}(?:-[a-z0-9]{1,8}){0,3}$/u;
const forbiddenBidiControl =
  /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const controlCharacter = /[\u0000-\u001f\u007f-\u009f]/u;
const noncharacter =
  /[\ufdd0-\ufdef\ufffe\uffff]|\u{1fffe}|\u{1ffff}|\u{2fffe}|\u{2ffff}|\u{3fffe}|\u{3ffff}|\u{4fffe}|\u{4ffff}|\u{5fffe}|\u{5ffff}|\u{6fffe}|\u{6ffff}|\u{7fffe}|\u{7ffff}|\u{8fffe}|\u{8ffff}|\u{9fffe}|\u{9ffff}|\u{afffe}|\u{affff}|\u{bfffe}|\u{bffff}|\u{cfffe}|\u{cffff}|\u{dfffe}|\u{dffff}|\u{efffe}|\u{effff}|\u{ffffe}|\u{fffff}|\u{10fffe}|\u{10ffff}/u;
function fail(
  code: ReferenceComplexTextShapingErrorCode,
  detail: string,
): never {
  throw new ReferenceComplexTextShapingError(code, detail);
}

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

function installedBackendIdentity() {
  try {
    return collectInstalledComplexTextBackendIdentity();
  } catch (error) {
    fail(
      "CUT_COMPLEX_TEXT_BACKEND",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function validateDirection(
  value: unknown,
): asserts value is ReferenceComplexTextDirection {
  if (value !== "ltr" && value !== "rtl") {
    fail(
      "CUT_COMPLEX_TEXT_INPUT",
      'direction must be exactly "ltr" or "rtl".',
    );
  }
}

function validateText(text: unknown, limit: number): asserts text is string {
  if (typeof text !== "string" || text.length < 1) {
    fail("CUT_COMPLEX_TEXT_INPUT", "text must be a non-empty string.");
  }
  if (text.length > limit) {
    fail(
      "CUT_COMPLEX_TEXT_BUDGET",
      `text exceeds the ${limit}-UTF-16-code-unit budget.`,
    );
  }
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        fail(
          "CUT_COMPLEX_TEXT_INPUT",
          `text contains an unpaired high surrogate at UTF-16 index ${index}.`,
        );
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      fail(
        "CUT_COMPLEX_TEXT_INPUT",
        `text contains an unpaired low surrogate at UTF-16 index ${index}.`,
      );
    }
  }
  if (controlCharacter.test(text)) {
    fail(
      "CUT_COMPLEX_TEXT_INPUT",
      "text contains a C0/C1 control; this single-paragraph wrapper admits U+0020 as its only whitespace.",
    );
  }
  if (forbiddenBidiControl.test(text)) {
    fail(
      "CUT_COMPLEX_TEXT_INPUT",
      "text contains an explicit bidi formatting/isolate control; use the declared paragraph direction.",
    );
  }
  if (noncharacter.test(text)) {
    fail("CUT_COMPLEX_TEXT_INPUT", "text contains a Unicode noncharacter.");
  }
}

function validateLanguage(language: unknown): asserts language is string {
  if (typeof language !== "string" || !languagePattern.test(language)) {
    fail(
      "CUT_COMPLEX_TEXT_INPUT",
      "language must be a canonical lowercase BCP-47 subset such as en, ar, or hi-deva.",
    );
  }
}

function limited(
  value: unknown,
  key: keyof ReferenceComplexTextShapingLimits,
) {
  const ceiling = referenceComplexTextShapingLimits[key];
  if (
    value === undefined
    || !Number.isSafeInteger(value)
    || (value as number) < 1
    || (value as number) > ceiling
  ) {
    fail(
      "CUT_COMPLEX_TEXT_BUDGET",
      `${key} must be a positive safe integer no greater than ${ceiling}.`,
    );
  }
  return value as number;
}

function resolvedLimits(
  requested: Partial<ReferenceComplexTextShapingLimits> | undefined,
) {
  if (requested === undefined) return referenceComplexTextShapingLimits;
  const unknown = Object.keys(requested).filter(
    (key) => !(key in referenceComplexTextShapingLimits),
  );
  if (unknown.length) {
    fail(
      "CUT_COMPLEX_TEXT_BUDGET",
      `unknown shaping limit ${unknown.join(", ")}.`,
    );
  }
  return Object.freeze(
    Object.fromEntries(
      Object.keys(referenceComplexTextShapingLimits).map((key) => [
        key,
        limited(
          requested[key as keyof ReferenceComplexTextShapingLimits]
            ?? referenceComplexTextShapingLimits[
              key as keyof ReferenceComplexTextShapingLimits
            ],
          key as keyof ReferenceComplexTextShapingLimits,
        ),
      ]),
    ) as ReferenceComplexTextShapingLimits,
  );
}

function codePointSpans(text: string, start: number, end: number) {
  const spans: Array<Readonly<{ start: number; end: number; codePoint: number }>> =
    [];
  for (let index = start; index < end;) {
    const codePoint = text.codePointAt(index)!;
    const width = codePoint > 0xffff ? 2 : 1;
    spans.push(Object.freeze({ start: index, end: index + width, codePoint }));
    index += width;
  }
  return spans;
}

function coverageCodePoint(codePoint: number) {
  return codePoint !== 0x200c && codePoint !== 0x200d;
}

function tokenRanges(text: string) {
  const ranges: Array<Readonly<{ start: number; end: number }>> = [];
  const pattern = / +|[^ ]+/gu;
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    ranges.push(Object.freeze({ start, end: start + match[0].length }));
  }
  return ranges;
}

function tokenFont(
  text: string,
  range: Readonly<{ start: number; end: number }>,
  fonts: readonly PreparedFont[],
) {
  const codePoints = codePointSpans(text, range.start, range.end)
    .map((entry) => entry.codePoint)
    .filter(coverageCodePoint);
  for (const font of fonts) {
    if (codePoints.every((codePoint) => font.font.nominalGlyph(codePoint) !== undefined)) {
      return font;
    }
  }
  const missing = codePoints.find((codePoint) =>
    fonts.every((font) => font.font.nominalGlyph(codePoint) === undefined)
  );
  const label = missing === undefined
    ? "one whole token"
    : `U+${missing.toString(16).toUpperCase().padStart(4, "0")}`;
  fail(
    "CUT_COMPLEX_TEXT_FALLBACK",
    `${label} has no complete face in the explicit locked fallback chain; host fallback is forbidden.`,
  );
}

function bidiRuns(
  text: string,
  token: Readonly<{ start: number; end: number }>,
  levels: Uint8Array,
) {
  const points = codePointSpans(text, token.start, token.end);
  const runs: Array<Readonly<{ start: number; end: number; level: number }>> = [];
  let start = points[0]!.start;
  let end = points[0]!.end;
  let level = levels[start]!;
  for (const point of points.slice(1)) {
    const pointLevel = levels[point.start]!;
    if (pointLevel === level) {
      end = point.end;
      continue;
    }
    runs.push(Object.freeze({ start, end, level }));
    start = point.start;
    end = point.end;
    level = pointLevel;
  }
  runs.push(Object.freeze({ start, end, level }));
  return runs;
}

function visualCodeUnitRanks(
  text: string,
  embedding: BidiEmbeddingLevels,
  bidi: BidiApi,
) {
  const order = Array.from({ length: text.length }, (_, index) => index);
  for (const [start, end] of bidi.getReorderSegments(text, embedding)) {
    if (
      !Number.isSafeInteger(start)
      || !Number.isSafeInteger(end)
      || start < 0
      || end < start
      || end >= text.length
    ) {
      fail(
        "CUT_COMPLEX_TEXT_BIDI",
        `bidi-js produced invalid reorder segment ${start}...${end}.`,
      );
    }
    for (let left = start, right = end; left < right; left += 1, right -= 1) {
      [order[left], order[right]] = [order[right]!, order[left]!];
    }
  }
  const ranks = new Uint32Array(text.length);
  order.forEach((logical, visual) => {
    ranks[logical] = visual;
  });
  return ranks;
}

export function referenceComplexTextLineBidi(
  text: string,
  direction: ReferenceComplexTextDirection,
  start: number,
  end: number,
) {
  validateDirection(direction);
  validateText(text, referenceComplexTextShapingLimits.maximumTextCodeUnits);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > text.length) {
    fail("CUT_COMPLEX_TEXT_BIDI", `line range must be a non-empty half-open UTF-16 interval inside the text.`);
  }
  installedBackendIdentity();
  const bidi = (bidiFactory as BidiFactory)();
  const embedding = bidi.getEmbeddingLevels(text, direction);
  if (!(embedding.levels instanceof Uint8Array) || embedding.levels.length !== text.length) {
    fail("CUT_COMPLEX_TEXT_BIDI", "bidi-js did not return one embedding level per UTF-16 code unit.");
  }
  const order = Array.from({ length: text.length }, (_, index) => index);
  for (const [leftBound, rightBound] of bidi.getReorderSegments(text, embedding, start, end - 1)) {
    if (leftBound < start || rightBound >= end || leftBound > rightBound) {
      fail("CUT_COMPLEX_TEXT_BIDI", `bidi-js produced an out-of-line reorder segment ${leftBound}...${rightBound}.`);
    }
    for (let left = leftBound, right = rightBound; left < right; left += 1, right -= 1) {
      [order[left], order[right]] = [order[right]!, order[left]!];
    }
  }
  return immutable({
    start,
    end,
    levels: [...embedding.levels.slice(start, end)],
    visualCodeUnitOrder: order.slice(start, end),
  });
}

function immutable<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach((entry) => immutable(entry));
    return Object.freeze(value);
  }
  if (
    value !== null
    && typeof value === "object"
    && !(value instanceof Uint8Array)
  ) {
    Object.values(value as Record<string, unknown>).forEach((entry) =>
      immutable(entry)
    );
    return Object.freeze(value);
  }
  return value;
}

let backendPromise:
  | Promise<Readonly<{ hb: HarfBuzz; bidi: BidiApi; identity: ReferenceComplexTextBackendIdentity }>>
  | undefined;

async function loadedBackend() {
  if (backendPromise === undefined) {
    backendPromise = (async () => {
      const identity = installedBackendIdentity();
      const hb = await import("harfbuzzjs");
      const bidi = (bidiFactory as BidiFactory)();
      const runtimeVersion = hb.versionString();
      if (runtimeVersion !== "14.2.1") {
        fail(
          "CUT_COMPLEX_TEXT_BACKEND",
          `HarfBuzz runtime version ${runtimeVersion} differs from pinned 14.2.1.`,
        );
      }
      return Object.freeze({ hb, bidi, identity });
    })();
  }
  const backend = await backendPromise;
  const currentIdentity = installedBackendIdentity();
  if (currentIdentity.integrity !== backend.identity.integrity) {
    fail("CUT_COMPLEX_TEXT_BACKEND", "installed complex-text backend bytes changed after initialization.");
  }
  return backend;
}

export async function referenceComplexTextBackendIdentity() {
  return (await loadedBackend()).identity;
}

export function referenceComplexTextBidi(
  text: string,
  direction: ReferenceComplexTextDirection,
) {
  validateDirection(direction);
  validateText(text, referenceComplexTextShapingLimits.maximumTextCodeUnits);
  installedBackendIdentity();
  const bidi = (bidiFactory as BidiFactory)();
  const embedding = bidi.getEmbeddingLevels(text, direction);
  if (
    !(embedding.levels instanceof Uint8Array)
    || embedding.levels.length !== text.length
  ) {
    fail(
      "CUT_COMPLEX_TEXT_BIDI",
      "bidi-js did not return one embedding level per UTF-16 code unit.",
    );
  }
  const ranks = visualCodeUnitRanks(text, embedding, bidi);
  return immutable({
    levels: [...embedding.levels],
    visualCodeUnitOrder: [...ranks]
      .map((rank, logicalIndex) => ({ rank, logicalIndex }))
      .sort((left, right) => left.rank - right.rank)
      .map((entry) => entry.logicalIndex),
    paragraphs: embedding.paragraphs.map((paragraph) => ({ ...paragraph })),
  });
}

export async function shapeReferenceComplexText(
  input: Readonly<{
    text: string;
    direction: ReferenceComplexTextDirection;
    language: string;
    fonts: readonly ReferenceComplexTextFont[];
  }>,
  requestedLimits?: Partial<ReferenceComplexTextShapingLimits>,
): Promise<ReferenceComplexTextShapingResult> {
  const limits = resolvedLimits(requestedLimits);
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("CUT_COMPLEX_TEXT_INPUT", "shaping input must be an object.");
  }
  validateDirection(input.direction);
  validateLanguage(input.language);
  validateText(input.text, limits.maximumTextCodeUnits);
  if (
    !Array.isArray(input.fonts)
    || input.fonts.length < 1
    || input.fonts.length > limits.maximumFonts
  ) {
    fail(
      "CUT_COMPLEX_TEXT_BUDGET",
      `fonts must contain 1...${limits.maximumFonts} explicit locked faces.`,
    );
  }

  let aggregateBytes = 0;
  const seenIds = new Set<string>();
  const seenHashes = new Set<string>();
  const fontSnapshots = input.fonts.map((font, index) => {
    if (!font || typeof font !== "object" || Array.isArray(font)) {
      fail("CUT_COMPLEX_TEXT_RESOURCE", `fonts[${index}] must be an object.`);
    }
    if (typeof font.id !== "string" || !fontIdPattern.test(font.id)) {
      fail(
        "CUT_COMPLEX_TEXT_RESOURCE",
        `fonts[${index}].id must be a stable CUT identifier.`,
      );
    }
    if (seenIds.has(font.id)) {
      fail(
        "CUT_COMPLEX_TEXT_RESOURCE",
        `font id ${font.id} appears more than once.`,
      );
    }
    seenIds.add(font.id);
    if (
      typeof font.locator !== "string"
      || !fontLocatorPattern.test(font.locator)
    ) {
      fail(
        "CUT_COMPLEX_TEXT_RESOURCE",
        `font ${font.id} must use a project-relative .ttf/.otf locator.`,
      );
    }
    if (!(font.bytes instanceof Uint8Array)) {
      fail(
        "CUT_COMPLEX_TEXT_RESOURCE",
        `font ${font.id} bytes must be a Uint8Array.`,
      );
    }
    if (font.bytes.byteLength < 12 || font.bytes.byteLength > limits.maximumFontBytes) {
      fail(
        "CUT_COMPLEX_TEXT_BUDGET",
        `font ${font.id} must contain 12...${limits.maximumFontBytes} bytes.`,
      );
    }
    aggregateBytes += font.bytes.byteLength;
    if (aggregateBytes > limits.maximumAggregateFontBytes) {
      fail(
        "CUT_COMPLEX_TEXT_BUDGET",
        `font bytes exceed the ${limits.maximumAggregateFontBytes}-byte aggregate budget.`,
      );
    }
    if (typeof font.sha256 !== "string" || !sha256Pattern.test(font.sha256)) {
      fail(
        "CUT_COMPLEX_TEXT_RESOURCE",
        `font ${font.id} sha256 must be lowercase hexadecimal.`,
      );
    }
    const bytes = Uint8Array.from(font.bytes);
    const actualSha256 = sha256(bytes);
    if (actualSha256 !== font.sha256) {
      fail(
        "CUT_COMPLEX_TEXT_RESOURCE",
        `font ${font.id} bytes hash ${actualSha256} differs from locked ${font.sha256}.`,
      );
    }
    if (seenHashes.has(actualSha256)) {
      fail(
        "CUT_COMPLEX_TEXT_RESOURCE",
        `font ${font.id} repeats locked bytes already present in the fallback chain.`,
      );
    }
    seenHashes.add(actualSha256);
    return Object.freeze({
      id: font.id,
      locator: font.locator,
      sha256: actualSha256,
      bytes,
    });
  });

  const { hb, bidi, identity } = await loadedBackend();
  const preparedFonts: PreparedFont[] = fontSnapshots.map((font) => {
    let blob: InstanceType<HarfBuzz["Blob"]>;
    let face: InstanceType<HarfBuzz["Face"]>;
    let hbFont: InstanceType<HarfBuzz["Font"]>;
    try {
      const data = font.bytes.buffer.slice(
        font.bytes.byteOffset,
        font.bytes.byteOffset + font.bytes.byteLength,
      ) as ArrayBuffer;
      blob = new hb.Blob(data);
      face = new hb.Face(blob, 0);
      hbFont = new hb.Font(face);
      hbFont.setScale(face.upem, face.upem);
    } catch (error) {
      fail(
        "CUT_COMPLEX_TEXT_RESOURCE",
        `font ${font.id} cannot be prepared by the pinned HarfBuzz backend: ${
          error instanceof Error ? error.message : String(error)
        }.`,
      );
    }
    if (
      !Number.isSafeInteger(face.upem)
      || face.upem < 16
      || face.upem > 16_384
    ) {
      fail(
        "CUT_COMPLEX_TEXT_RESOURCE",
        `font ${font.id} unitsPerEm is outside 16...16384.`,
      );
    }
    return Object.freeze({
      ...font,
      byteLength: font.bytes.byteLength,
      blob,
      face,
      font: hbFont,
    });
  });

  const embedding = bidi.getEmbeddingLevels(input.text, input.direction);
  if (
    !(embedding.levels instanceof Uint8Array)
    || embedding.levels.length !== input.text.length
  ) {
    fail(
      "CUT_COMPLEX_TEXT_BIDI",
      "bidi-js did not return one embedding level per UTF-16 code unit.",
    );
  }
  const ranges = tokenRanges(input.text);
  const mirroredCharacters = bidi.getMirroredCharactersMap(input.text, embedding);
  if (ranges.length > limits.maximumTokens) {
    fail(
      "CUT_COMPLEX_TEXT_BUDGET",
      `text produces ${ranges.length} tokens above the ${limits.maximumTokens}-token budget.`,
    );
  }
  const tokens: Token[] = ranges.map((range) =>
    Object.freeze({
      ...range,
      font: tokenFont(input.text, range, preparedFonts),
    })
  );

  const clusterByKey = new Map<string, MutableCluster>();
  let glyphCount = 0;
  for (const token of tokens) {
    for (const run of bidiRuns(input.text, token, embedding.levels)) {
      const buffer = new hb.Buffer();
      for (const point of codePointSpans(input.text, run.start, run.end)) {
        const mirrored = run.level % 2 === 1 ? mirroredCharacters.get(point.start) : undefined;
        const codePoint = mirrored?.codePointAt(0) ?? point.codePoint;
        buffer.add(codePoint, point.start);
      }
      buffer.setDirection(
        run.level % 2 === 0 ? hb.Direction.LTR : hb.Direction.RTL,
      );
      buffer.setLanguage(input.language);
      buffer.setClusterLevel(hb.ClusterLevel.MONOTONE_GRAPHEMES);
      buffer.guessSegmentProperties();
      let shaped: ReturnType<typeof buffer.getGlyphInfosAndPositions>;
      try {
        hb.shape(token.font.font, buffer);
        shaped = buffer.getGlyphInfosAndPositions();
      } catch (error) {
        fail(
          "CUT_COMPLEX_TEXT_RESOURCE",
          `font ${token.font.id} failed shaping at ${run.start}...${run.end}: ${
            error instanceof Error ? error.message : String(error)
          }.`,
        );
      } finally {
        buffer.reset();
      }
      if (shaped.some((glyph) => glyph.codepoint === 0)) {
        fail(
          "CUT_COMPLEX_TEXT_FALLBACK",
          `font ${token.font.id} shaped a missing .notdef glyph inside ${run.start}...${run.end}.`,
        );
      }
      if (shaped.some((glyph) => !Number.isSafeInteger(glyph.codepoint)
        || !Number.isSafeInteger(glyph.cluster)
        || ![glyph.xAdvance, glyph.yAdvance, glyph.xOffset, glyph.yOffset].every(Number.isSafeInteger))) {
        fail(
          "CUT_COMPLEX_TEXT_BACKEND",
          `HarfBuzz returned a non-integer or unsafe glyph record inside ${run.start}...${run.end}.`,
        );
      }
      glyphCount += shaped.length;
      if (glyphCount > limits.maximumGlyphs) {
        fail(
          "CUT_COMPLEX_TEXT_BUDGET",
          `shaping produced more than ${limits.maximumGlyphs} glyphs.`,
        );
      }
      const clusterStarts = [...new Set(shaped.map((glyph) => glyph.cluster))]
        .sort((left, right) => left - right);
      if (
        clusterStarts.some((start) => start < run.start || start >= run.end)
      ) {
        fail(
          "CUT_COMPLEX_TEXT_BACKEND",
          `HarfBuzz produced a cluster outside ${run.start}...${run.end}.`,
        );
      }
      for (let index = 0; index < clusterStarts.length; index += 1) {
        const start = clusterStarts[index]!;
        const end = clusterStarts[index + 1] ?? run.end;
        const key = `${start}:${end}:${token.font.id}`;
        const glyphs = shaped
          .filter((glyph) => glyph.cluster === start)
          .map((glyph) =>
            Object.freeze({
              glyphId: glyph.codepoint,
              flags: glyph.flags,
              xAdvance: glyph.xAdvance ?? 0,
              yAdvance: glyph.yAdvance ?? 0,
              xOffset: glyph.xOffset ?? 0,
              yOffset: glyph.yOffset ?? 0,
            })
          );
        const existing = clusterByKey.get(key);
        if (existing) {
          existing.glyphs.push(...glyphs);
        } else {
          clusterByKey.set(key, {
            start,
            end,
            bidiLevel: embedding.levels[start]!,
            font: token.font,
            glyphs,
          });
        }
      }
    }
  }

  if (clusterByKey.size > limits.maximumClusters) {
    fail(
      "CUT_COMPLEX_TEXT_BUDGET",
      `shaping produced ${clusterByKey.size} clusters above the ${limits.maximumClusters}-cluster budget.`,
    );
  }
  const ranks = visualCodeUnitRanks(input.text, embedding, bidi);
  const logical = [...clusterByKey.values()].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  const visualRank = (cluster: MutableCluster) => {
    let rank = Number.POSITIVE_INFINITY;
    for (let index = cluster.start; index < cluster.end; index += 1) {
      rank = Math.min(rank, ranks[index]!);
    }
    return rank;
  };
  const visualOrder = [...logical].sort(
    (left, right) =>
      visualRank(left) - visualRank(right)
      || left.start - right.start,
  );
  const visualIndices = new Map(
    visualOrder.map((cluster, index) => [cluster, index]),
  );
  const textSha256 = sha256(input.text);
  const logicalClusters = logical.map((cluster, logicalIndex) => {
    const glyphs = Object.freeze(cluster.glyphs.slice());
    const id = sha256(
      JSON.stringify({
        textSha256,
        start: cluster.start,
        end: cluster.end,
        fontSha256: cluster.font.sha256,
        direction: input.direction,
        language: input.language,
        backendIntegrity: identity.integrity,
      }),
    );
    return immutable({
      id,
      logicalIndex,
      visualIndex: visualIndices.get(cluster)!,
      start: cluster.start,
      end: cluster.end,
      bidiLevel: cluster.bidiLevel,
      fontId: cluster.font.id,
      fontSha256: cluster.font.sha256,
      glyphs,
      xAdvance: glyphs.reduce((sum, glyph) => sum + glyph.xAdvance, 0),
      yAdvance: glyphs.reduce((sum, glyph) => sum + glyph.yAdvance, 0),
    }) as ReferenceComplexTextCluster;
  });
  const ids = new Map(logical.map((cluster, index) => [
    cluster,
    logicalClusters[index]!.id,
  ]));

  return immutable({
    format: "cut-reference-complex-text-shaping",
    version: 1,
    backend: identity,
    textSha256,
    direction: input.direction,
    language: input.language,
    glyphCount,
    fontChain: preparedFonts.map((font) => ({
      id: font.id,
      locator: font.locator,
      sha256: font.sha256,
      byteLength: font.byteLength,
      unitsPerEm: font.face.upem,
    })),
    tokens: tokens.map((token) => ({
      start: token.start,
      end: token.end,
      fontId: token.font.id,
      fontSha256: token.font.sha256,
    })),
    logicalClusters,
    visualClusterIds: visualOrder.map((cluster) => ids.get(cluster)!),
  });
}
