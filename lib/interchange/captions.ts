import {
  compareRational,
  decimalRational,
  rational,
  type Rational,
  zeroRational,
} from "../language/rational";

/** Closed authored appearance bounds shared by source checking, compiler
 * lowering, and the reference renderer. Keeping this contract here prevents
 * an accepted CUT program from discovering a stricter font-size rule only at
 * first-frame execution. */
export const cutCaptionAppearanceLimits = Object.freeze({
  minimumSizePx: 12,
  maximumSizePx: 256,
});

export type CaptionLineSetting = {
  value: Rational;
  unit: "line" | "percent";
  align?: "start" | "center" | "end";
};

export type CaptionPositionSetting = {
  value: Rational;
  align?: "line-left" | "center" | "line-right";
};

/** Horizontal WebVTT cue settings supported losslessly by CUT. */
export type WebVttHorizontalSettings = {
  line?: CaptionLineSetting;
  position?: CaptionPositionSetting;
  size?: Rational;
  align?: "start" | "center" | "end" | "left" | "right";
};

export type CaptionCue = {
  id: string;
  start: Rational;
  end: Rational;
  lines: string[];
  settings?: WebVttHorizontalSettings;
};

export type CaptionTrack = {
  format: "cut-caption-track";
  version: 1;
  cues: CaptionCue[];
};

export type CaptionLimits = {
  maxBytes: number;
  maxCues: number;
  maxLines: number;
  maxLinesPerCue: number;
  maxCueTextBytes: number;
  maxTextBytes: number;
};

export const defaultCaptionLimits: Readonly<CaptionLimits> = {
  maxBytes: 16 * 1024 * 1024,
  maxCues: 100_000,
  maxLines: 200_000,
  maxLinesPerCue: 16,
  maxCueTextBytes: 64 * 1024,
  maxTextBytes: 8 * 1024 * 1024,
};

export type CaptionErrorCode =
  | "CUT_CAPTION_BUDGET"
  | "CUT_CAPTION_ENCODING"
  | "CUT_CAPTION_FORMAT"
  | "CUT_CAPTION_ID"
  | "CUT_CAPTION_MARKUP"
  | "CUT_CAPTION_OVERLAP"
  | "CUT_CAPTION_SETTING"
  | "CUT_CAPTION_TEXT"
  | "CUT_CAPTION_TIME"
  | "CUT_CAPTION_UNSUPPORTED";

export class CaptionInterchangeError extends Error {
  constructor(readonly code: CaptionErrorCode, message: string) { super(message); }
}

const encoder = new TextEncoder();
const lineAlignments = new Set(["start", "center", "end"]);
const positionAlignments = new Set(["line-left", "center", "line-right"]);
const textAlignments = new Set(["start", "center", "end", "left", "right"]);
const unsafeText = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff\ufffe\uffff]/u;
const unsafeDocument = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff\ufffe\uffff]/u;
const characterReference = /&(?:#\d+|#x[\da-f]+|amp|lt|gt|lrm|rlm|nbsp);/iu;

function fail(code: CaptionErrorCode, message: string): never { throw new CaptionInterchangeError(code, message); }

function bytes(value: string) { return encoder.encode(value).byteLength; }

function objectValue(value: unknown, path: string, code: CaptionErrorCode): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code, `${path} must be an object.`);
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, code: CaptionErrorCode) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key)).sort();
  if (unknown.length) fail(code, `${path} contains unsupported field “${unknown[0]}”.`);
}

function limits(overrides: Partial<CaptionLimits> = {}): CaptionLimits {
  const resolved = { ...defaultCaptionLimits, ...overrides };
  for (const [name, value] of Object.entries(resolved) as Array<[keyof CaptionLimits, number]>) {
    if (!Number.isSafeInteger(value) || value < 1 || value > defaultCaptionLimits[name]) fail("CUT_CAPTION_BUDGET", `${name} must be an integer from 1 through ${defaultCaptionLimits[name]}.`);
  }
  return resolved;
}

function hasUnpairedSurrogate(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function decodeInput(input: string | Uint8Array, limit: CaptionLimits) {
  const byteLength = typeof input === "string" ? bytes(input) : input.byteLength;
  if (byteLength > limit.maxBytes) fail("CUT_CAPTION_BUDGET", `Caption input exceeds maxBytes (${limit.maxBytes}).`);
  let value: string;
  try { value = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true }).decode(input); }
  catch { fail("CUT_CAPTION_ENCODING", "Caption input is not valid UTF-8."); }
  if (hasUnpairedSurrogate(value)) fail("CUT_CAPTION_ENCODING", "Caption input contains an unpaired UTF-16 surrogate.");
  if (value.startsWith("\ufeff")) value = value.slice(1);
  if (value.includes("\ufeff")) fail("CUT_CAPTION_ENCODING", "A UTF-8 BOM is valid only at the start of a caption file.");
  value = value.replaceAll("\r\n", "\n");
  if (value.includes("\r")) fail("CUT_CAPTION_FORMAT", "Bare carriage returns are not supported; use LF or CRLF line endings.");
  if (unsafeDocument.test(value)) fail("CUT_CAPTION_TEXT", "Caption input contains an unsafe control character outside a line break.");
  return value;
}

function splitDocument(value: string, limit: CaptionLimits) {
  let newlines = 0;
  for (let index = value.indexOf("\n"); index >= 0; index = value.indexOf("\n", index + 1)) newlines += 1;
  const maximumDocumentLines = limit.maxLines + limit.maxCues * 4 + 16;
  if (newlines + 1 > maximumDocumentLines) fail("CUT_CAPTION_BUDGET", `Caption input exceeds its structural line budget (${maximumDocumentLines}).`);
  return value.split("\n");
}

function canonicalRational(value: unknown, path: string, code: CaptionErrorCode = "CUT_CAPTION_TIME"): Rational {
  const record = objectValue(value, path, code);
  rejectUnknownKeys(record, ["numerator", "denominator"], path, code);
  const candidate = record as Rational;
  if (typeof candidate.numerator !== "string" || typeof candidate.denominator !== "string" || !/^-?\d+$/.test(candidate.numerator) || !/^\d+$/.test(candidate.denominator)) fail(code, `${path} must use integer rational strings.`);
  if (candidate.numerator.length > 32 || candidate.denominator.length > 32) fail("CUT_CAPTION_BUDGET", `${path} exceeds the 32-digit rational budget.`);
  let normalized: Rational;
  try { normalized = rational(candidate.numerator, candidate.denominator); }
  catch { fail(code, `${path} has an invalid rational denominator.`); }
  if (candidate.numerator !== normalized.numerator || candidate.denominator !== normalized.denominator) fail(code, `${path} must be a reduced canonical rational.`);
  return normalized;
}

function milliseconds(value: Rational, path: string) {
  const normalized = canonicalRational(value, path);
  const numerator = BigInt(normalized.numerator) * 1000n;
  const denominator = BigInt(normalized.denominator);
  if (numerator % denominator !== 0n) fail("CUT_CAPTION_TIME", `${path} is not exactly representable in milliseconds.`);
  const result = numerator / denominator;
  if (result < 0n) fail("CUT_CAPTION_TIME", `${path} cannot be negative.`);
  if (result > 3_599_999_999_999n) fail("CUT_CAPTION_TIME", `${path} exceeds the supported 999999-hour range.`);
  return result;
}

function parseVttTimestamp(value: string, path: string) {
  const match = /^(?:(\d{2,6}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/.exec(value);
  if (!match) fail("CUT_CAPTION_TIME", `${path} must be MM:SS.mmm or HH:MM:SS.mmm with exact milliseconds.`);
  const hours = BigInt(match[1] ?? "0"), minutes = BigInt(match[2]), seconds = BigInt(match[3]), millis = BigInt(match[4]);
  return rational(((hours * 60n + minutes) * 60n + seconds) * 1000n + millis, 1000);
}

function parseSrtTimestamp(value: string, path: string) {
  const match = /^(\d{2,6}):([0-5]\d):([0-5]\d),(\d{3})$/.exec(value);
  if (!match) fail("CUT_CAPTION_TIME", `${path} must be HH:MM:SS,mmm with exact milliseconds.`);
  const hours = BigInt(match[1]), minutes = BigInt(match[2]), seconds = BigInt(match[3]), millis = BigInt(match[4]);
  return rational(((hours * 60n + minutes) * 60n + seconds) * 1000n + millis, 1000);
}

function timestamp(value: Rational, separator: "." | ",", path: string) {
  const total = milliseconds(value, path);
  const millis = total % 1000n;
  const secondsTotal = total / 1000n;
  const seconds = secondsTotal % 60n;
  const minutesTotal = secondsTotal / 60n;
  const minutes = minutesTotal % 60n;
  const hours = minutesTotal / 60n;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}${separator}${String(millis).padStart(3, "0")}`;
}

function percentage(value: string, path: string) {
  const match = /^(0|[1-9]\d{0,2})(?:\.(\d{1,3}))?%$/.exec(value);
  if (!match) fail("CUT_CAPTION_SETTING", `${path} must be a percentage with at most three decimal places.`);
  const result = decimalRational(`${match[1]}${match[2] ? `.${match[2]}` : ""}`);
  if (compareRational(result, rational(100)) > 0) fail("CUT_CAPTION_SETTING", `${path} must be from 0% through 100%.`);
  return result;
}

function percentageText(value: Rational, path: string) {
  const normalized = canonicalRational(value, path, "CUT_CAPTION_SETTING");
  if (compareRational(normalized, zeroRational) < 0 || compareRational(normalized, rational(100)) > 0) fail("CUT_CAPTION_SETTING", `${path} must be from 0% through 100%.`);
  const thousandthsNumerator = BigInt(normalized.numerator) * 1000n;
  const denominator = BigInt(normalized.denominator);
  if (thousandthsNumerator % denominator !== 0n) fail("CUT_CAPTION_SETTING", `${path} needs more than three decimal places.`);
  const thousandths = thousandthsNumerator / denominator;
  const integer = thousandths / 1000n;
  const fraction = String(thousandths % 1000n).padStart(3, "0").replace(/0+$/, "");
  return `${integer}${fraction ? `.${fraction}` : ""}%`;
}

function parseSettings(source: string, path: string): WebVttHorizontalSettings | undefined {
  if (!source) return undefined;
  const settings: WebVttHorizontalSettings = {};
  const seen = new Set<string>();
  for (const token of source.split(/\s+/)) {
    const colon = token.indexOf(":");
    if (colon <= 0 || colon === token.length - 1) fail("CUT_CAPTION_SETTING", `${path} contains malformed setting “${token}”.`);
    const name = token.slice(0, colon), rawValue = token.slice(colon + 1);
    if (seen.has(name)) fail("CUT_CAPTION_SETTING", `${path} repeats setting “${name}”.`);
    seen.add(name);
    if (name === "vertical" || name === "region") fail("CUT_CAPTION_UNSUPPORTED", `${path} uses unsupported ${name} semantics.`);
    if (name === "line") {
      const [rawLine, rawAlign, ...extra] = rawValue.split(",");
      if (extra.length || (rawAlign && !lineAlignments.has(rawAlign))) fail("CUT_CAPTION_SETTING", `${path}.line has an invalid line alignment.`);
      if (rawLine.endsWith("%")) settings.line = { value: percentage(rawLine, `${path}.line`), unit: "percent", ...(rawAlign ? { align: rawAlign as CaptionLineSetting["align"] } : {}) };
      else {
        if (!/^-?(0|[1-9]\d{0,3})$/.test(rawLine)) fail("CUT_CAPTION_SETTING", `${path}.line must be an integer from -9999 through 9999 or a percentage.`);
        settings.line = { value: rational(rawLine), unit: "line", ...(rawAlign ? { align: rawAlign as CaptionLineSetting["align"] } : {}) };
      }
    } else if (name === "position") {
      const [rawPosition, rawAlign, ...extra] = rawValue.split(",");
      if (extra.length || (rawAlign && !positionAlignments.has(rawAlign))) fail("CUT_CAPTION_SETTING", `${path}.position has an invalid position alignment.`);
      settings.position = { value: percentage(rawPosition, `${path}.position`), ...(rawAlign ? { align: rawAlign as CaptionPositionSetting["align"] } : {}) };
    } else if (name === "size") {
      if (rawValue.includes(",")) fail("CUT_CAPTION_SETTING", `${path}.size cannot have an alignment.`);
      settings.size = percentage(rawValue, `${path}.size`);
    } else if (name === "align") {
      if (!textAlignments.has(rawValue)) fail("CUT_CAPTION_SETTING", `${path}.align is invalid.`);
      settings.align = rawValue as WebVttHorizontalSettings["align"];
    } else fail("CUT_CAPTION_UNSUPPORTED", `${path} uses unsupported setting “${name}”.`);
  }
  return settings;
}

function settingText(settings: WebVttHorizontalSettings | undefined, path: string) {
  if (settings === undefined) return "";
  const settingRecord = objectValue(settings, path, "CUT_CAPTION_SETTING");
  rejectUnknownKeys(settingRecord, ["line", "position", "size", "align"], path, "CUT_CAPTION_SETTING");
  if (!Object.keys(settingRecord).length) fail("CUT_CAPTION_SETTING", `${path} is empty and must be omitted.`);
  const tokens: string[] = [];
  if (settings.line) {
    const lineRecord = objectValue(settings.line, `${path}.line`, "CUT_CAPTION_SETTING");
    rejectUnknownKeys(lineRecord, ["value", "unit", "align"], `${path}.line`, "CUT_CAPTION_SETTING");
    const line = settings.line;
    if (line.unit !== "line" && line.unit !== "percent") fail("CUT_CAPTION_SETTING", `${path}.line.unit must be “line” or “percent”.`);
    const value = line.unit === "percent" ? percentageText(line.value, `${path}.line.value`) : (() => {
      const exact = canonicalRational(line.value, `${path}.line.value`, "CUT_CAPTION_SETTING");
      if (exact.denominator !== "1" || BigInt(exact.numerator) < -9999n || BigInt(exact.numerator) > 9999n) fail("CUT_CAPTION_SETTING", `${path}.line.value must be an integer from -9999 through 9999.`);
      return exact.numerator;
    })();
    if (line.align && !lineAlignments.has(line.align)) fail("CUT_CAPTION_SETTING", `${path}.line.align is invalid.`);
    tokens.push(`line:${value}${line.align ? `,${line.align}` : ""}`);
  }
  if (settings.position) {
    const positionRecord = objectValue(settings.position, `${path}.position`, "CUT_CAPTION_SETTING");
    rejectUnknownKeys(positionRecord, ["value", "align"], `${path}.position`, "CUT_CAPTION_SETTING");
    if (settings.position.align && !positionAlignments.has(settings.position.align)) fail("CUT_CAPTION_SETTING", `${path}.position.align is invalid.`);
    tokens.push(`position:${percentageText(settings.position.value, `${path}.position.value`)}${settings.position.align ? `,${settings.position.align}` : ""}`);
  }
  if (settings.size) tokens.push(`size:${percentageText(settings.size, `${path}.size`)}`);
  if (settings.align) {
    if (!textAlignments.has(settings.align)) fail("CUT_CAPTION_SETTING", `${path}.align is invalid.`);
    tokens.push(`align:${settings.align}`);
  }
  return tokens.join(" ");
}

function validateId(id: unknown, path: string, srt: boolean) {
  if (typeof id !== "string" || !id || id !== id.trim() || id.includes("-->") || unsafeText.test(id)) fail("CUT_CAPTION_ID", `${path} must be a non-empty safe identifier without surrounding whitespace.`);
  if (bytes(id) > 1024) fail("CUT_CAPTION_BUDGET", `${path} exceeds 1024 UTF-8 bytes.`);
  if (srt && !/^[1-9]\d*$/.test(id)) fail("CUT_CAPTION_ID", `${path} must be a positive canonical decimal identifier for SRT.`);
  return id;
}

function validateLine(line: unknown, path: string) {
  if (typeof line !== "string" || !line || line.trim().length === 0) fail("CUT_CAPTION_TEXT", `${path} must be a non-empty caption line.`);
  if (hasUnpairedSurrogate(line) || unsafeText.test(line)) fail("CUT_CAPTION_TEXT", `${path} contains an unsafe control character.`);
  if (line.includes("<") || line.includes(">") || characterReference.test(line) || /\{\\[^}]+\}/u.test(line)) fail("CUT_CAPTION_MARKUP", `${path} contains unsupported caption markup; CUT does not render or strip tags.`);
  return line;
}

function validateCueSettings(settings: WebVttHorizontalSettings | undefined, path: string) {
  settingText(settings, path);
}

function validateTrackInternal(track: CaptionTrack, limit: CaptionLimits, srt: boolean) {
  if (!track || typeof track !== "object" || track.format !== "cut-caption-track" || track.version !== 1 || !Array.isArray(track.cues)) fail("CUT_CAPTION_FORMAT", "Expected a CUT caption track v1.");
  rejectUnknownKeys(track as unknown as Record<string, unknown>, ["format", "version", "cues"], "CaptionTrack", "CUT_CAPTION_FORMAT");
  if (track.cues.length > limit.maxCues) fail("CUT_CAPTION_BUDGET", `Caption track exceeds maxCues (${limit.maxCues}).`);
  const ids = new Set<string>();
  let previousEnd = zeroRational, lineCount = 0, textBytes = 0, semanticBytes = 0;
  track.cues.forEach((cue, index) => {
    const path = `cues[${index}]`;
    if (!cue || typeof cue !== "object") fail("CUT_CAPTION_FORMAT", `${path} must be an object.`);
    rejectUnknownKeys(cue as unknown as Record<string, unknown>, ["id", "start", "end", "lines", "settings"], path, "CUT_CAPTION_FORMAT");
    validateId(cue.id, `${path}.id`, srt);
    if (ids.has(cue.id)) fail("CUT_CAPTION_ID", `Duplicate caption cue id “${cue.id}”.`);
    ids.add(cue.id);
    canonicalRational(cue.start, `${path}.start`);
    canonicalRational(cue.end, `${path}.end`);
    milliseconds(cue.start, `${path}.start`);
    milliseconds(cue.end, `${path}.end`);
    if (compareRational(cue.end, cue.start) <= 0) fail("CUT_CAPTION_TIME", `${path} must have a positive duration.`);
    if (index > 0 && compareRational(cue.start, previousEnd) < 0) fail("CUT_CAPTION_OVERLAP", `${path} overlaps or precedes the prior cue; CaptionTrack v1 has no overlap lane semantics.`);
    previousEnd = cue.end;
    if (!Array.isArray(cue.lines) || cue.lines.length < 1) fail("CUT_CAPTION_TEXT", `${path}.lines must contain at least one line.`);
    if (cue.lines.length > limit.maxLinesPerCue) fail("CUT_CAPTION_BUDGET", `${path} exceeds maxLinesPerCue (${limit.maxLinesPerCue}).`);
    const cueBytes = cue.lines.reduce((sum, line, lineIndex) => sum + bytes(validateLine(line, `${path}.lines[${lineIndex}]`)), 0);
    if (cueBytes > limit.maxCueTextBytes) fail("CUT_CAPTION_BUDGET", `${path} exceeds maxCueTextBytes (${limit.maxCueTextBytes}).`);
    lineCount += cue.lines.length;
    textBytes += cueBytes;
    semanticBytes += bytes(cue.id) + cueBytes;
    if (lineCount > limit.maxLines) fail("CUT_CAPTION_BUDGET", `Caption track exceeds maxLines (${limit.maxLines}).`);
    if (textBytes > limit.maxTextBytes) fail("CUT_CAPTION_BUDGET", `Caption track exceeds maxTextBytes (${limit.maxTextBytes}).`);
    if (semanticBytes > limit.maxBytes) fail("CUT_CAPTION_BUDGET", `Caption identifiers and text exceed maxBytes (${limit.maxBytes}).`);
    validateCueSettings(cue.settings, `${path}.settings`);
    if (srt && cue.settings && Object.keys(cue.settings).length) fail("CUT_CAPTION_UNSUPPORTED", `${path} has WebVTT settings that SRT cannot preserve.`);
  });
  return track;
}

export function validateCaptionTrack(track: CaptionTrack, overrides: Partial<CaptionLimits> = {}) {
  return validateTrackInternal(track, limits(overrides), false);
}

function blocks(lines: string[], start: number) {
  const result: string[][] = [];
  let current: string[] = [];
  for (let index = start; index <= lines.length; index += 1) {
    const line = index < lines.length ? lines[index] : "";
    if (line === "") {
      if (current.length) { result.push(current); current = []; }
    } else current.push(line);
  }
  return result;
}

function cueFromBlock(block: string[], index: number, format: "vtt" | "srt"): CaptionCue {
  if (block.length < 3) fail("CUT_CAPTION_FORMAT", `${format.toUpperCase()} cue ${index + 1} needs an identifier, timing line, and payload.`);
  const id = validateId(block[0], `${format.toUpperCase()} cue ${index + 1} id`, format === "srt");
  const timing = block[1];
  let start: Rational, end: Rational, settings: WebVttHorizontalSettings | undefined;
  if (format === "vtt") {
    const match = /^(\S+)\s+-->\s+(\S+)(?:\s+(.+))?$/.exec(timing);
    if (!match) fail("CUT_CAPTION_TIME", `WEBVTT cue ${index + 1} has a malformed timing line.`);
    start = parseVttTimestamp(match[1], `WEBVTT cue ${index + 1} start`);
    end = parseVttTimestamp(match[2], `WEBVTT cue ${index + 1} end`);
    settings = parseSettings(match[3] ?? "", `WEBVTT cue ${index + 1} settings`);
  } else {
    const match = /^(\S+)\s+-->\s+(\S+)$/.exec(timing);
    if (!match) fail("CUT_CAPTION_TIME", `SRT cue ${index + 1} has a malformed timing line or unsupported settings.`);
    start = parseSrtTimestamp(match[1], `SRT cue ${index + 1} start`);
    end = parseSrtTimestamp(match[2], `SRT cue ${index + 1} end`);
  }
  return { id, start, end, lines: block.slice(2), ...(settings ? { settings } : {}) };
}

export function parseWebVtt(input: string | Uint8Array, overrides: Partial<CaptionLimits> = {}): CaptionTrack {
  const limit = limits(overrides), source = decodeInput(input, limit), lines = splitDocument(source, limit);
  if (lines[0] !== "WEBVTT") fail("CUT_CAPTION_FORMAT", "WEBVTT input must begin with the exact WEBVTT header.");
  if (lines.length < 2 || lines[1] !== "") fail("CUT_CAPTION_UNSUPPORTED", "WEBVTT header metadata is outside CUT's preserved subset.");
  const cueBlocks = blocks(lines, 2);
  if (cueBlocks.length > limit.maxCues) fail("CUT_CAPTION_BUDGET", `Caption track exceeds maxCues (${limit.maxCues}).`);
  for (const block of cueBlocks) {
    if (/^(?:STYLE|REGION)(?:\s|$)/.test(block[0]) || /^NOTE(?:\s|$)/.test(block[0])) fail("CUT_CAPTION_UNSUPPORTED", `WEBVTT ${block[0].split(/\s/, 1)[0]} blocks are outside CUT's preserved subset.`);
  }
  const track: CaptionTrack = { format: "cut-caption-track", version: 1, cues: cueBlocks.map((block, index) => cueFromBlock(block, index, "vtt")) };
  return validateTrackInternal(track, limit, false);
}

export function parseSubRip(input: string | Uint8Array, overrides: Partial<CaptionLimits> = {}): CaptionTrack {
  const limit = limits(overrides), source = decodeInput(input, limit), lines = splitDocument(source, limit), cueBlocks = blocks(lines, 0);
  if (cueBlocks.length > limit.maxCues) fail("CUT_CAPTION_BUDGET", `Caption track exceeds maxCues (${limit.maxCues}).`);
  const track: CaptionTrack = { format: "cut-caption-track", version: 1, cues: cueBlocks.map((block, index) => cueFromBlock(block, index, "srt")) };
  return validateTrackInternal(track, limit, true);
}

export function serializeWebVtt(track: CaptionTrack, overrides: Partial<CaptionLimits> = {}) {
  const limit = limits(overrides);
  validateTrackInternal(track, limit, false);
  const cueBlocks = track.cues.map((cue, index) => {
    const settings = settingText(cue.settings, `cues[${index}].settings`);
    const timing = `${timestamp(cue.start, ".", `cues[${index}].start`)} --> ${timestamp(cue.end, ".", `cues[${index}].end`)}${settings ? ` ${settings}` : ""}`;
    return [cue.id, timing, ...cue.lines].join("\n");
  });
  const output = `WEBVTT\n\n${cueBlocks.join("\n\n")}${cueBlocks.length ? "\n" : ""}`;
  if (bytes(output) > limit.maxBytes) fail("CUT_CAPTION_BUDGET", `Serialized WEBVTT exceeds maxBytes (${limit.maxBytes}).`);
  return output;
}

export function serializeSubRip(track: CaptionTrack, overrides: Partial<CaptionLimits> = {}) {
  const limit = limits(overrides);
  validateTrackInternal(track, limit, true);
  const cueBlocks = track.cues.map((cue, index) => [
    cue.id,
    `${timestamp(cue.start, ",", `cues[${index}].start`)} --> ${timestamp(cue.end, ",", `cues[${index}].end`)}`,
    ...cue.lines,
  ].join("\r\n"));
  const output = `${cueBlocks.join("\r\n\r\n")}${cueBlocks.length ? "\r\n" : ""}`;
  if (bytes(output) > limit.maxBytes) fail("CUT_CAPTION_BUDGET", `Serialized SRT exceeds maxBytes (${limit.maxBytes}).`);
  return output;
}
