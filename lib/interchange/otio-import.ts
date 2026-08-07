import { createHash } from "node:crypto";
import { hash, stableJsonStringify } from "../core/stable";
import { formatCutSource } from "../language/formatter";
import { validateProjectLocator } from "../project/manifest";
import {
  addRational,
  compareRational,
  divideRational,
  multiplyRational,
  rational,
  rationalToNumber,
  subtractRational,
  type Rational,
  zeroRational,
} from "../language/rational";
import { editorialAnnotationLimits, normalizeEditorialAnnotationMetadata, type EditorialAnnotationGrid } from "../language/editorial-annotations";
import {
  CutOtioEditorialProfileError,
  reconcileCutOtioEditorialProfile,
  validateCutOtioEditorialProfile,
  type CutOtioEditorialLoss,
  type CutOtioEditorialObservation,
  type CutOtioEditorialProfile,
  type CutOtioEditorialTrack,
  type CutOtioEditorialTransition,
} from "./otio-editorial-profile";
import {
  CutOtioEditorialProfileV3Error,
  validateCutOtioEditorialProfileV3,
  type CutOtioEditorialProfileV3,
} from "./otio-editorial-profile-v3";
import {
  CutOtioEditorialProfileV4Error,
  reconcileCutOtioEditorialProfileV4,
  validateCutOtioEditorialProfileV4,
  type CutOtioEditorialNestedPlacement,
  type CutOtioEditorialProfileV4,
  type CutOtioEditorialProfileV4Observation,
} from "./otio-editorial-profile-v4";
import {
  CutOtioEditorialProfileV5Error,
  reconcileCutOtioEditorialProfileV5,
  validateCutOtioEditorialProfileV5,
  type CutOtioDirectMediaAuthority,
  type CutOtioEditorialProfileV5,
  type CutOtioEditorialProfileV5Observation,
} from "./otio-editorial-profile-v5";
import {
  CutOtioEditorialProfileV6Error,
  reconcileCutOtioEditorialProfileV6,
  validateCutOtioEditorialProfileV6,
  type CutOtioEditorialProfileV6,
  type CutOtioEditorialProfileV6Observation,
  type CutOtioPictureTimeMapAuthority,
} from "./otio-editorial-profile-v6";

type JsonRecord = Record<string, unknown>;

export type CutOtioImportLimits = {
  maxInputBytes: number;
  maxJsonDepth: number;
  maxJsonNodes: number;
  maxStringBytes: number;
  maxTotalStringBytes: number;
  maxTracks: number;
  maxTrackItems: number;
  maxClipInstances: number;
  maxResources: number;
  maxScenes: number;
  maxAnnotations: number;
  maxGeneratedNodes: number;
  maxRationalDigits: number;
  maxDurationSeconds: number;
  maxSourceTimeSeconds: number;
};

export const defaultCutOtioImportLimits: Readonly<CutOtioImportLimits> = Object.freeze({
  maxInputBytes: 64 * 1024 * 1024,
  maxJsonDepth: 128,
  maxJsonNodes: 2_000_000,
  maxStringBytes: 1024 * 1024,
  maxTotalStringBytes: 16 * 1024 * 1024,
  maxTracks: 2_048,
  maxTrackItems: 100_000,
  maxClipInstances: 100_000,
  maxResources: 100_000,
  maxScenes: 10_000,
  maxAnnotations: editorialAnnotationLimits.maximumAnnotations,
  maxGeneratedNodes: 100_000,
  maxRationalDigits: 256,
  maxDurationSeconds: 7_200,
  maxSourceTimeSeconds: 7 * 24 * 60 * 60,
});

export type CutOtioImportOptions = {
  fps?: Rational | string;
  width?: number;
  height?: number;
  sampleRate?: number;
  projectName?: string;
  timelineName?: string;
  /** Explicitly accept every precisely reported semantic omission. */
  allowLossy?: boolean;
  limits?: Partial<CutOtioImportLimits>;
};

export type CutOtioImportResource = {
  asset: string;
  kind: "video" | "audio" | "image";
  locator: string;
  expectedSha256: string | null;
};

export type CutOtioImportLoss = {
  code: "CUT_OTIO_IMPORT_NARRATION_TRANSCRIPT_UNSUPPORTED";
  category: "metadata";
  disposition: "omitted";
  path: string;
  subject: {
    kind: "clip";
    trackIndex: number;
    itemIndex: number;
    nodeOp: string | null;
    property: "transcript";
  };
  evidence: {
    inputKind: "string";
    value: string;
  };
  message: string;
} | {
  code: "CUT_OTIO_SEMANTIC_MATCH_UNSUPPORTED";
  category: "timing";
  disposition: "omitted";
  path: string;
  subject: {
    kind: "semantic-match";
    id: string;
    op: "cut.edit.match_subject" | "cut.edit.match_transition";
    authoredId: string;
  };
  evidence: {
    inputKind: "cut-otio-interchange-report";
    value: string;
  };
  message: string;
} | {
  code: string;
  category: CutOtioEditorialLoss["category"];
  disposition: CutOtioEditorialLoss["disposition"];
  path: string;
  target: CutOtioEditorialLoss["target"];
  subject: CutOtioEditorialLoss["subject"];
  evidence: {
    inputKind:
      | "cut-otio-editorial-profile"
      | "cut-otio-editorial-profile-extension";
    value: string;
  };
  message: string;
};

export type CutOtioImportReport = {
  format: "cut-otio-import-report";
  version: 1;
  status: "lossless-editorial" | "lossy-editorial";
  input: {
    sha256: string;
    schema: "Timeline.1";
    name: string;
  };
  output: {
    format: "cut-source";
    language: "0.4";
    sha256: string;
    project: string;
    timeline: string;
    duration: Rational;
    fps: Rational;
    width: number;
    height: number;
    sampleRate: number;
  };
  imported: {
    tracks: number;
    videoTracks: number;
    audioTracks: number;
    clips: number;
    gaps: number;
    linkedPairs: number;
    scenes: number;
    generatedNodes: number;
    segmentedVideoClips: number;
    implicitTrailingGaps: number;
    markers: number;
    regions: number;
  };
  sourceTracks: Array<{
    index: number;
    name: string;
    kind: "Video" | "Audio";
    clips: number;
    gaps: number;
  }>;
  resources: CutOtioImportResource[];
  guarantees: {
    timing: "exact-rational";
    sourceReferences: "project-relative-posix";
    unsupportedSemantics: "refused" | "explicitly-reported-lossy";
  };
  losses: CutOtioImportLoss[];
  editorialProfile?: {
    format: CutOtioEditorialProfile["format"];
    version: CutOtioEditorialProfile["version"];
    semanticSha256: string;
    targetScopedLosses: number;
    extension?: {
      format: CutOtioEditorialProfileV3["format"];
      version: CutOtioEditorialProfileV3["version"];
      semanticSha256: string;
      origins: number;
      views: number;
      lineageSegments: number;
      targetScopedLosses: number;
    };
    nestedExtension?: {
      format: CutOtioEditorialProfileV4["format"];
      version: CutOtioEditorialProfileV4["version"];
      semanticSha256: string;
      lineageSegments: number;
      placements: number;
    };
    directMediaExtension?: {
      format: CutOtioEditorialProfileV5["format"];
      version: CutOtioEditorialProfileV5["version"];
      semanticSha256: string;
      authorities: number;
    };
    pictureTimeMapExtension?: {
      format: CutOtioEditorialProfileV6["format"];
      version: CutOtioEditorialProfileV6["version"];
      semanticSha256: string;
      authorities: number;
    };
  };
  normalization: string[];
};

export type CutOtioImport = {
  source: string;
  report: CutOtioImportReport;
};

export type CutOtioImportErrorCode =
  | "CUT_OTIO_IMPORT_ENCODING"
  | "CUT_OTIO_IMPORT_JSON"
  | "CUT_OTIO_IMPORT_DUPLICATE_KEY"
  | "CUT_OTIO_IMPORT_LIMIT"
  | "CUT_OTIO_IMPORT_TYPE"
  | "CUT_OTIO_IMPORT_SCHEMA"
  | "CUT_OTIO_IMPORT_FIELD"
  | "CUT_OTIO_IMPORT_TIMING"
  | "CUT_OTIO_IMPORT_RESOURCE"
  | "CUT_OTIO_IMPORT_PROFILE"
  | "CUT_OTIO_IMPORT_UNSUPPORTED"
  | "CUT_OTIO_IMPORT_LOSSY_REFUSED"
  | "CUT_OTIO_IMPORT_SETTING_REQUIRED"
  | "CUT_OTIO_IMPORT_SETTING_CONFLICT";

export class CutOtioImportError extends Error {
  constructor(readonly code: CutOtioImportErrorCode, readonly path: string, message: string) {
    super(`${code} at ${path}: ${message}`);
    this.name = "CutOtioImportError";
  }
}

type ImportContext = {
  limits: CutOtioImportLimits;
  totalStringBytes: number;
  clipInstances: number;
  allowLossy: boolean;
  losses: CutOtioImportLoss[];
  editorialProfile?: {
    profile: CutOtioEditorialProfile;
    extension?: CutOtioEditorialProfileV3;
    nestedExtension?: CutOtioEditorialProfileV4;
    directMediaExtension?: CutOtioEditorialProfileV5;
    pictureTimeMapExtension?: CutOtioEditorialProfileV6;
    linkNames: Map<string, string>;
    observedTracks: Array<CutOtioEditorialObservation["tracks"][number]>;
    observedTransitions: CutOtioEditorialTransition[];
    observedNestedPlacements:
      CutOtioEditorialProfileV4Observation["placements"][number][];
    observedDirectMediaAuthorities:
      CutOtioEditorialProfileV5Observation["authorities"][number][];
    observedPictureTimeMapAuthorities:
      CutOtioEditorialProfileV6Observation["authorities"][number][];
  };
};

type ParsedClip = {
  trackIndex: number;
  itemIndex: number;
  trackKind: "Video" | "Audio";
  start: Rational;
  duration: Rational;
  sourceStart: Rational;
  locator: string;
  name: string;
  nodeOp?: string;
  resourceKind?: "video" | "audio" | "image";
  resourceId?: string;
  expectedSha256?: string;
  linkedId?: string;
  sceneId?: string;
  editorialItemId?: string;
  editorialRole?: string;
  editorialMetadata?: Readonly<Record<string, string>>;
  directMediaAuthority?: CutOtioDirectMediaAuthority;
  pictureTimeMapAuthority?: CutOtioPictureTimeMapAuthority;
};

type ParsedTrack = {
  index: number;
  name: string;
  kind: "Video" | "Audio";
  clips: ParsedClip[];
  duration: Rational;
  gaps: number;
  implicitTrailingGap: boolean;
  sceneId?: string;
};

type ParsedAnnotation = {
  kind: "marker" | "region";
  id: string;
  name: string;
  color: string;
  role: string;
  comment: string;
  grid?: EditorialAnnotationGrid;
  compositionId?: string;
  sceneId?: string;
  start: Rational;
  duration: Rational;
};

type ImportedScene = {
  id: string;
  name: string;
  start: Rational;
  duration: Rational;
};

type TimelineCutMetadata = {
  project?: string;
  compositionId?: string;
  canvas?: { width: number; height: number };
  sampleRate?: number;
  fps?: Rational;
  duration?: Rational;
  scenes?: ImportedScene[];
  editorialProfile?: CutOtioEditorialProfile;
  editorialProfileExtension?: CutOtioEditorialProfileV3;
  editorialProfileNestedExtension?: CutOtioEditorialProfileV4;
  editorialProfileDirectMediaExtension?: CutOtioEditorialProfileV5;
  editorialProfilePictureTimeMapExtension?: CutOtioEditorialProfileV6;
  editorialLinkNames?: Map<string, string>;
};

const dangerousKeys = new Set(["__proto__", "prototype", "constructor"]);
const sha256Pattern = /^[a-f0-9]{64}$/;
const otioMarkerColors: Record<string, string> = {
  RED: "#ff0000", PINK: "#ff80bf", ORANGE: "#ff8000", YELLOW: "#ffff00", GREEN: "#00ff00", CYAN: "#00ffff", BLUE: "#0000ff", PURPLE: "#8000ff", MAGENTA: "#ff00ff", BLACK: "#000000", DARK_GRAY: "#404040", GRAY: "#808080", LIGHT_GRAY: "#c0c0c0", WHITE: "#ffffff",
};

function fail(code: CutOtioImportErrorCode, path: string, message: string): never {
  throw new CutOtioImportError(code, path, message);
}

function isRecord(value: unknown): value is JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function record(value: unknown, path: string): JsonRecord {
  if (!isRecord(value)) fail("CUT_OTIO_IMPORT_TYPE", path, "must be a plain JSON object.");
  return value;
}

function closed(value: unknown, path: string, required: readonly string[], optional: readonly string[] = []) {
  const object = record(value, path), allowed = new Set([...required, ...optional]);
  for (const field of required) if (!Object.hasOwn(object, field)) fail("CUT_OTIO_IMPORT_FIELD", path, `is missing required field ${JSON.stringify(field)}.`);
  for (const field of Object.keys(object)) if (!allowed.has(field)) fail("CUT_OTIO_IMPORT_FIELD", `${path}.${field}`, "is outside CUT's supported OTIO subset.");
  return object;
}

function childPath(path: string, key: string) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function boundedString(value: unknown, path: string, context: ImportContext, allowEmpty = true) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.includes("\0")) {
    fail("CUT_OTIO_IMPORT_TYPE", path, `must be ${allowEmpty ? "a" : "a non-empty"} string without NUL bytes.`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) fail("CUT_OTIO_IMPORT_ENCODING", path, "contains an unpaired UTF-16 surrogate.");
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) fail("CUT_OTIO_IMPORT_ENCODING", path, "contains an unpaired UTF-16 surrogate.");
  }
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > context.limits.maxStringBytes) fail("CUT_OTIO_IMPORT_LIMIT", path, `exceeds maxStringBytes (${context.limits.maxStringBytes}).`);
  context.totalStringBytes += bytes;
  if (context.totalStringBytes > context.limits.maxTotalStringBytes) fail("CUT_OTIO_IMPORT_LIMIT", path, `document strings exceed maxTotalStringBytes (${context.limits.maxTotalStringBytes}).`);
  return value;
}

function validateJsonValue(value: unknown, path: string, context: ImportContext, depth = 0): void {
  if (depth > context.limits.maxJsonDepth) fail("CUT_OTIO_IMPORT_LIMIT", path, `exceeds maxJsonDepth (${context.limits.maxJsonDepth}).`);
  if (typeof value === "string") { boundedString(value, path, context); return; }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("CUT_OTIO_IMPORT_TYPE", path, "must be a finite JSON number.");
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateJsonValue(item, `${path}[${index}]`, context, depth + 1));
    return;
  }
  const object = record(value, path);
  for (const [key, item] of Object.entries(object)) {
    if (dangerousKeys.has(key)) fail("CUT_OTIO_IMPORT_FIELD", childPath(path, key), "uses a prototype-sensitive key.");
    boundedString(key, childPath(path, key), context);
    validateJsonValue(item, childPath(path, key), context, depth + 1);
  }
}

function resolveLimits(overrides: Partial<CutOtioImportLimits> | undefined): CutOtioImportLimits {
  if (overrides !== undefined && !isRecord(overrides)) fail("CUT_OTIO_IMPORT_TYPE", "$.options.limits", "must be a plain object.");
  if (overrides) for (const key of Object.keys(overrides)) if (!(key in defaultCutOtioImportLimits)) fail("CUT_OTIO_IMPORT_FIELD", `$.options.limits.${key}`, "is not a supported limit.");
  const limits = { ...defaultCutOtioImportLimits, ...overrides };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) fail("CUT_OTIO_IMPORT_LIMIT", `$.options.limits.${key}`, "must be a positive safe integer.");
  }
  return limits;
}

class JsonBoundaryScanner {
  private offset = 0;
  private nodes = 0;
  constructor(private readonly source: string, private readonly limits: CutOtioImportLimits) {}

  scan() {
    this.skipWhitespace(); this.value(0); this.skipWhitespace();
    if (this.offset !== this.source.length) this.syntax("unexpected trailing input");
  }

  private syntax(message: string): never { fail("CUT_OTIO_IMPORT_JSON", "$", `${message} at text offset ${this.offset}.`); }
  private skipWhitespace() { while (this.offset < this.source.length && /\s/.test(this.source[this.offset])) this.offset += 1; }
  private value(depth: number) {
    this.nodes += 1;
    if (this.nodes > this.limits.maxJsonNodes) fail("CUT_OTIO_IMPORT_LIMIT", "$", `JSON exceeds maxJsonNodes (${this.limits.maxJsonNodes}).`);
    if (depth > this.limits.maxJsonDepth) fail("CUT_OTIO_IMPORT_LIMIT", "$", `JSON exceeds maxJsonDepth (${this.limits.maxJsonDepth}).`);
    this.skipWhitespace(); const character = this.source[this.offset];
    if (character === "{") this.object(depth);
    else if (character === "[") this.array(depth);
    else if (character === '"') this.string();
    else if (this.source.startsWith("true", this.offset)) this.offset += 4;
    else if (this.source.startsWith("false", this.offset)) this.offset += 5;
    else if (this.source.startsWith("null", this.offset)) this.offset += 4;
    else {
      const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(this.source.slice(this.offset));
      if (!match) this.syntax("expected a JSON value");
      this.offset += match[0].length;
    }
  }
  private string() {
    const start = this.offset; this.offset += 1;
    while (this.offset < this.source.length) {
      const character = this.source[this.offset];
      if (character === '"') {
        this.offset += 1; const raw = this.source.slice(start, this.offset);
        try { return JSON.parse(raw) as string; } catch { this.syntax("invalid JSON string"); }
      }
      if (character === "\\") { this.offset += 2; continue; }
      if (character.charCodeAt(0) < 0x20) this.syntax("unescaped control character in string");
      this.offset += 1;
    }
    this.syntax("unterminated JSON string");
  }
  private object(depth: number) {
    this.offset += 1; this.skipWhitespace(); const keys = new Set<string>();
    if (this.source[this.offset] === "}") { this.offset += 1; return; }
    while (true) {
      if (this.source[this.offset] !== '"') this.syntax("expected an object key");
      const key = this.string();
      if (keys.has(key)) fail("CUT_OTIO_IMPORT_DUPLICATE_KEY", "$", `duplicate decoded object key ${JSON.stringify(key)} near text offset ${this.offset}.`);
      keys.add(key); this.skipWhitespace();
      if (this.source[this.offset] !== ":") this.syntax("expected ':' after object key");
      this.offset += 1; this.value(depth + 1); this.skipWhitespace();
      if (this.source[this.offset] === "}") { this.offset += 1; return; }
      if (this.source[this.offset] !== ",") this.syntax("expected ',' or '}'");
      this.offset += 1; this.skipWhitespace();
    }
  }
  private array(depth: number) {
    this.offset += 1; this.skipWhitespace();
    if (this.source[this.offset] === "]") { this.offset += 1; return; }
    while (true) {
      this.value(depth + 1); this.skipWhitespace();
      if (this.source[this.offset] === "]") { this.offset += 1; return; }
      if (this.source[this.offset] !== ",") this.syntax("expected ',' or ']'");
      this.offset += 1; this.skipWhitespace();
    }
  }
}

function parseInput(input: string | Uint8Array, limits: CutOtioImportLimits) {
  let source: string;
  if (typeof input === "string") source = input;
  else if (input instanceof Uint8Array) {
    try { source = new TextDecoder("utf-8", { fatal: true }).decode(input); }
    catch { fail("CUT_OTIO_IMPORT_ENCODING", "$", "input is not valid UTF-8."); }
  } else fail("CUT_OTIO_IMPORT_TYPE", "$", "loader input must be a JSON string or Uint8Array.");
  const bytes = Buffer.byteLength(source, "utf8");
  if (bytes > limits.maxInputBytes) fail("CUT_OTIO_IMPORT_LIMIT", "$", `input is ${bytes} bytes; limit is ${limits.maxInputBytes}.`);
  new JsonBoundaryScanner(source, limits).scan();
  let value: unknown;
  try { value = JSON.parse(source) as unknown; }
  catch (error) { fail("CUT_OTIO_IMPORT_JSON", "$", error instanceof Error ? error.message : "invalid JSON."); }
  return { source, value };
}

function boundedRational(value: Rational, path: string, context: ImportContext) {
  const numeratorDigits = value.numerator.startsWith("-") ? value.numerator.length - 1 : value.numerator.length;
  if (numeratorDigits > context.limits.maxRationalDigits || value.denominator.length > context.limits.maxRationalDigits) {
    fail("CUT_OTIO_IMPORT_LIMIT", path, `exact rational exceeds maxRationalDigits (${context.limits.maxRationalDigits}).`);
  }
  return value;
}

function otioTime(value: unknown, path: string, context: ImportContext): Rational {
  const object = closed(value, path, ["OTIO_SCHEMA", "value", "rate"]);
  if (object.OTIO_SCHEMA !== "RationalTime.1") fail("CUT_OTIO_IMPORT_SCHEMA", `${path}.OTIO_SCHEMA`, "must be RationalTime.1.");
  if (!Number.isSafeInteger(object.value) || Object.is(object.value, -0)) fail("CUT_OTIO_IMPORT_TIMING", `${path}.value`, "must be a non-negative or signed safe integer without negative zero.");
  if (!Number.isSafeInteger(object.rate) || Number(object.rate) <= 0) fail("CUT_OTIO_IMPORT_TIMING", `${path}.rate`, "must be a positive safe integer.");
  return boundedRational(rational(Number(object.value), Number(object.rate)), path, context);
}

function timeRange(value: unknown, path: string, context: ImportContext, allowZeroDuration = false) {
  const object = closed(value, path, ["OTIO_SCHEMA", "start_time", "duration"]);
  if (object.OTIO_SCHEMA !== "TimeRange.1") fail("CUT_OTIO_IMPORT_SCHEMA", `${path}.OTIO_SCHEMA`, "must be TimeRange.1.");
  const start = otioTime(object.start_time, `${path}.start_time`, context), duration = otioTime(object.duration, `${path}.duration`, context);
  if (compareRational(duration, zeroRational) < 0 || (!allowZeroDuration && compareRational(duration, zeroRational) === 0)) {
    fail("CUT_OTIO_IMPORT_TIMING", `${path}.duration`, `must be ${allowZeroDuration ? "non-negative" : "positive"}.`);
  }
  return { start, duration };
}

function exactMetadata(value: unknown, path: string, context: ImportContext): Rational {
  const object = closed(value, path, ["numerator", "denominator"]);
  const numerator = boundedString(object.numerator, `${path}.numerator`, context, false), denominator = boundedString(object.denominator, `${path}.denominator`, context, false);
  if (!/^-?(?:0|[1-9][0-9]*)$/.test(numerator) || numerator === "-0" || !/^[1-9][0-9]*$/.test(denominator)) {
    fail("CUT_OTIO_IMPORT_TIMING", path, "must contain canonical integer strings and a positive denominator.");
  }
  const numeratorDigits = numerator.startsWith("-") ? numerator.length - 1 : numerator.length;
  if (numeratorDigits > context.limits.maxRationalDigits || denominator.length > context.limits.maxRationalDigits) {
    fail("CUT_OTIO_IMPORT_LIMIT", path, `exact rational exceeds maxRationalDigits (${context.limits.maxRationalDigits}).`);
  }
  const parsed = boundedRational(rational(numerator, denominator), path, context);
  if (parsed.numerator !== numerator || parsed.denominator !== denominator) fail("CUT_OTIO_IMPORT_TIMING", path, "must be reduced to lowest terms.");
  return parsed;
}

function assertSameTime(actual: Rational, expected: Rational, path: string) {
  if (compareRational(actual, expected) !== 0) fail("CUT_OTIO_IMPORT_TIMING", path, `does not match the exact OTIO time ${actual.numerator}/${actual.denominator}.`);
}

function metadataObject(value: unknown, path: string, allowedCutFields: readonly string[]) {
  const metadata = record(value, path), keys = Object.keys(metadata);
  if (keys.some((key) => key !== "cut")) fail("CUT_OTIO_IMPORT_UNSUPPORTED", path, "non-CUT metadata cannot be preserved by canonical CUT source.");
  if (!Object.hasOwn(metadata, "cut")) return undefined;
  return closed(metadata.cut, `${path}.cut`, [], allowedCutFields);
}

function optionalString(object: JsonRecord | undefined, field: string, path: string, context: ImportContext) {
  if (!object || !Object.hasOwn(object, field) || object[field] === null) return undefined;
  return boundedString(object[field], `${path}.${field}`, context, false);
}

function optionalSha(object: JsonRecord | undefined, field: string, path: string, context: ImportContext) {
  const value = optionalString(object, field, path, context);
  if (value !== undefined && !sha256Pattern.test(value)) fail("CUT_OTIO_IMPORT_RESOURCE", `${path}.${field}`, "must be a lowercase SHA-256 digest or null.");
  return value;
}

function emptyArray(value: unknown, path: string) {
  if (!Array.isArray(value)) fail("CUT_OTIO_IMPORT_TYPE", path, "must be an array.");
  if (value.length) fail("CUT_OTIO_IMPORT_UNSUPPORTED", path, "effects, markers, and transitions are not in the executable import subset.");
}

function enabled(value: unknown, path: string) {
  if (value !== true) fail("CUT_OTIO_IMPORT_UNSUPPORTED", path, "disabled OTIO items are not in the executable import subset.");
}

function parseRateOption(value: Rational | string | undefined, path: string): Rational | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "object" && value !== null && typeof value.numerator === "string" && typeof value.denominator === "string") {
    try { return rational(value.numerator, value.denominator); }
    catch { fail("CUT_OTIO_IMPORT_TYPE", path, "must be a positive exact rational."); }
  }
  if (typeof value !== "string" || !/^(?:[1-9][0-9]*)(?:\/(?:[1-9][0-9]*))?$/.test(value)) fail("CUT_OTIO_IMPORT_TYPE", path, "must be a positive rational such as 24 or 30000/1001.");
  const [numerator, denominator = "1"] = value.split("/");
  return rational(numerator, denominator);
}

function exactSettingRational(metadata: Rational | undefined, option: Rational | undefined, path: string) {
  if (metadata && option && compareRational(metadata, option) !== 0) fail("CUT_OTIO_IMPORT_SETTING_CONFLICT", path, "conflicts with timeline metadata.");
  const value = metadata ?? option;
  if (!value) fail("CUT_OTIO_IMPORT_SETTING_REQUIRED", path, "is absent from OTIO metadata and must be supplied explicitly.");
  return value;
}

function exactSettingInteger(metadata: number | undefined, option: number | undefined, path: string, minimum: number, maximum: number) {
  if (metadata !== undefined && option !== undefined && metadata !== option) fail("CUT_OTIO_IMPORT_SETTING_CONFLICT", path, "conflicts with timeline metadata.");
  const value = metadata ?? option;
  if (value === undefined) fail("CUT_OTIO_IMPORT_SETTING_REQUIRED", path, "is absent from OTIO metadata and must be supplied explicitly.");
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail("CUT_OTIO_IMPORT_TYPE", path, `must be a safe integer from ${minimum} through ${maximum}.`);
  return value;
}

function importSemanticMatchLosses(value: unknown, path: string, context: ImportContext) {
  const report = record(value, path);
  if (boundedString(report.format, `${path}.format`, context, false) !== "cut-otio-interchange-report" || report.version !== 1) {
    fail("CUT_OTIO_IMPORT_TYPE", path, "must be a cut-otio-interchange-report v1 object.");
  }
  if (!Array.isArray(report.unsupportedSemantics)) {
    fail("CUT_OTIO_IMPORT_TYPE", `${path}.unsupportedSemantics`, "must be an array.");
  }
  if (report.unsupportedSemantics.length > 1_024) {
    fail("CUT_OTIO_IMPORT_LIMIT", `${path}.unsupportedSemantics`, "contains more than 1,024 reported semantics.");
  }
  report.unsupportedSemantics.forEach((rawIssue, index) => {
    const issuePath = `${path}.unsupportedSemantics[${index}]`, issue = record(rawIssue, issuePath);
    const code = boundedString(issue.code, `${issuePath}.code`, context, false);
    if (code !== "CUT_OTIO_SEMANTIC_MATCH_UNSUPPORTED") return;
    if (issue.category !== "timing" || issue.disposition !== "omitted") {
      fail("CUT_OTIO_IMPORT_TYPE", issuePath, "semantic-match loss must be a timing omission.");
    }
    const subject = record(issue.subject, `${issuePath}.subject`);
    if (subject.kind !== "semantic-match") fail("CUT_OTIO_IMPORT_TYPE", `${issuePath}.subject.kind`, "must be semantic-match.");
    const id = boundedString(subject.id, `${issuePath}.subject.id`, context, false);
    const op = boundedString(subject.op, `${issuePath}.subject.op`, context, false);
    if (op !== "cut.edit.match_subject" && op !== "cut.edit.match_transition") {
      fail("CUT_OTIO_IMPORT_TYPE", `${issuePath}.subject.op`, "must identify MatchSubject or MatchTransition.");
    }
    const authoredId = boundedString(subject.property, `${issuePath}.subject.property`, context, false);
    boundedString(issue.message, `${issuePath}.message`, context, false);
    const loss: CutOtioImportLoss = {
      code: "CUT_OTIO_SEMANTIC_MATCH_UNSUPPORTED",
      category: "timing",
      disposition: "omitted",
      path: issuePath,
      subject: { kind: "semantic-match", id, op, authoredId },
      evidence: { inputKind: "cut-otio-interchange-report", value: authoredId },
      message: `${op === "cut.edit.match_transition" ? "MatchTransition" : "MatchSubject"} ${JSON.stringify(authoredId)} was omitted by the OTIO export because this interchange subset cannot preserve retained subject identity, adjacent-scene match windows, pose/color continuity, or velocity semantics.`,
    };
    if (!context.allowLossy) {
      fail(
        "CUT_OTIO_IMPORT_LOSSY_REFUSED",
        issuePath,
        `OTIO declares omitted semantic-match record ${JSON.stringify(authoredId)}; explicit allowLossy is required to import the hard-cut representation with a machine-readable loss report.`,
      );
    }
    context.losses.push(loss);
  });
}

function editorialProfileFailure(error: unknown, path: string): never {
  if (error instanceof CutOtioEditorialProfileError
    || error instanceof CutOtioEditorialProfileV3Error
    || error instanceof CutOtioEditorialProfileV4Error
    || error instanceof CutOtioEditorialProfileV5Error
    || error instanceof CutOtioEditorialProfileV6Error) {
    const suffix = error.path === "$" ? "" : error.path.slice(1);
    fail("CUT_OTIO_IMPORT_PROFILE", `${path}${suffix}`, error.message);
  }
  fail("CUT_OTIO_IMPORT_PROFILE", path, error instanceof Error ? error.message : "contains an invalid closed CUT editorial profile.");
}

function canonicalMetadataEquals(actual: unknown, expected: unknown, path: string) {
  let actualJson: string, expectedJson: string;
  try {
    actualJson = stableJsonStringify(actual);
    expectedJson = stableJsonStringify(expected);
  } catch (error) {
    fail("CUT_OTIO_IMPORT_PROFILE", path, error instanceof Error ? error.message : "is not canonical JSON metadata.");
  }
  if (actualJson !== expectedJson) fail("CUT_OTIO_IMPORT_PROFILE", path, "does not match the declared closed CUT editorial profile.");
}

function parseEditorialLinkNames(
  value: unknown,
  path: string,
  profile: CutOtioEditorialProfile,
  context: ImportContext,
) {
  if (!Array.isArray(value) || value.length !== profile.linkGroups.length) {
    fail("CUT_OTIO_IMPORT_PROFILE", path, `must contain exactly ${profile.linkGroups.length} authored link-name mappings.`);
  }
  const groups = new Set(profile.linkGroups.map((group) => group.id)), result = new Map<string, string>();
  value.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`, item = closed(entry, entryPath, ["groupId", "linkId"]);
    const groupId = boundedString(item.groupId, `${entryPath}.groupId`, context, false);
    const linkId = boundedString(item.linkId, `${entryPath}.linkId`, context, false);
    if (!groups.has(groupId)) fail("CUT_OTIO_IMPORT_PROFILE", `${entryPath}.groupId`, "does not identify a profile link group.");
    if (result.has(groupId)) fail("CUT_OTIO_IMPORT_PROFILE", `${entryPath}.groupId`, "duplicates an authored link-name mapping.");
    if (linkId !== linkId.trim() || linkId.length > 128 || /[\u0000-\u001f\u007f]/u.test(linkId)) {
      fail("CUT_OTIO_IMPORT_PROFILE", `${entryPath}.linkId`, "must be a non-empty trimmed CUT editorial link of at most 128 characters without control characters.");
    }
    result.set(groupId, linkId);
  });
  return result;
}

function importEditorialProfileLosses(profile: CutOtioEditorialProfile, path: string, context: ImportContext) {
  profile.losses.forEach((loss, index) => {
    if (loss.target.kind !== "cut-roundtrip") return;
    const lossPath = `${path}.losses[${index}]`;
    if (!context.allowLossy) {
      fail(
        "CUT_OTIO_IMPORT_LOSSY_REFUSED",
        lossPath,
        `${loss.code} declares ${loss.disposition} ${loss.category} semantics for CUT round-trip; explicit allowLossy is required.`,
      );
    }
    context.losses.push({
      code: loss.code,
      category: loss.category,
      disposition: loss.disposition,
      path: lossPath,
      target: loss.target,
      subject: loss.subject,
      evidence: { inputKind: "cut-otio-editorial-profile", value: profile.semanticSha256 },
      message: loss.message,
    });
  });
}

function importEditorialProfileV3Losses(
  profile: CutOtioEditorialProfileV3,
  path: string,
  context: ImportContext,
) {
  profile.losses.forEach((loss, index) => {
    if (loss.target.kind !== "cut-roundtrip") return;
    const lossPath = `${path}.losses[${index}]`;
    if (!context.allowLossy) {
      fail(
        "CUT_OTIO_IMPORT_LOSSY_REFUSED",
        lossPath,
        `${loss.code} declares ${loss.disposition} ${loss.category} semantics for CUT round-trip; explicit allowLossy is required.`,
      );
    }
    context.losses.push({
      code: loss.code,
      category: loss.category,
      disposition: loss.disposition,
      path: lossPath,
      target: loss.target,
      subject: loss.subject,
      evidence: {
        inputKind: "cut-otio-editorial-profile-extension",
        value: profile.semanticSha256,
      },
      message: loss.message,
    });
  });
}

function timelineMetadata(value: unknown, path: string, context: ImportContext): TimelineCutMetadata {
  const cut = metadataObject(value, path, ["project", "build_id", "composition_id", "canvas", "sample_rate", "exact_fps", "exact_duration", "exact_scenes", "editorial_profile", "editorial_profile_extension", "editorial_profile_nested_extension", "editorial_profile_direct_media_extension", "editorial_profile_picture_time_map_extension", "editorial_link_names", "interchange_report"]);
  if (!cut) return {};
  const result: TimelineCutMetadata = {};
  if (Object.hasOwn(cut, "project")) result.project = boundedString(cut.project, `${path}.cut.project`, context, false);
  if (Object.hasOwn(cut, "build_id")) optionalSha(cut, "build_id", `${path}.cut`, context);
  if (Object.hasOwn(cut, "composition_id")) result.compositionId = exactTimelineIdentifier(boundedString(cut.composition_id, `${path}.cut.composition_id`, context, false), `${path}.cut.composition_id`);
  if (Object.hasOwn(cut, "canvas")) {
    const canvas = closed(cut.canvas, `${path}.cut.canvas`, ["width", "height"]);
    if (!Number.isSafeInteger(canvas.width) || !Number.isSafeInteger(canvas.height)) fail("CUT_OTIO_IMPORT_TYPE", `${path}.cut.canvas`, "width and height must be safe integers.");
    result.canvas = { width: Number(canvas.width), height: Number(canvas.height) };
  }
  if (Object.hasOwn(cut, "sample_rate")) {
    if (!Number.isSafeInteger(cut.sample_rate)) fail("CUT_OTIO_IMPORT_TYPE", `${path}.cut.sample_rate`, "must be a safe integer.");
    result.sampleRate = Number(cut.sample_rate);
  }
  if (Object.hasOwn(cut, "exact_fps")) result.fps = exactMetadata(cut.exact_fps, `${path}.cut.exact_fps`, context);
  if (Object.hasOwn(cut, "exact_duration")) result.duration = exactMetadata(cut.exact_duration, `${path}.cut.exact_duration`, context);
  if (Object.hasOwn(cut, "editorial_profile")) {
    let profile: CutOtioEditorialProfile;
    let extension: CutOtioEditorialProfileV3 | undefined;
    let nestedExtension: CutOtioEditorialProfileV4 | undefined;
    let directMediaExtension: CutOtioEditorialProfileV5 | undefined;
    let pictureTimeMapExtension: CutOtioEditorialProfileV6 | undefined;
    try {
      profile = validateCutOtioEditorialProfile(cut.editorial_profile);
    } catch (error) {
      editorialProfileFailure(error, `${path}.cut.editorial_profile`);
    }
    if (Object.hasOwn(cut, "editorial_profile_extension")) {
      try {
        extension = validateCutOtioEditorialProfileV3(
          profile,
          cut.editorial_profile_extension,
        );
      } catch (error) {
        editorialProfileFailure(
          error,
          `${path}.cut.editorial_profile_extension`,
        );
      }
    }
    if (Object.hasOwn(cut, "editorial_profile_nested_extension")) {
      try {
        nestedExtension = validateCutOtioEditorialProfileV4(
          profile,
          cut.editorial_profile_nested_extension,
        );
      } catch (error) {
        editorialProfileFailure(
          error,
          `${path}.cut.editorial_profile_nested_extension`,
        );
      }
    }
    if (Object.hasOwn(cut, "editorial_profile_direct_media_extension")) {
      try {
        directMediaExtension = validateCutOtioEditorialProfileV5(
          profile,
          cut.editorial_profile_direct_media_extension,
        );
      } catch (error) {
        editorialProfileFailure(
          error,
          `${path}.cut.editorial_profile_direct_media_extension`,
        );
      }
    }
    if (Object.hasOwn(cut, "editorial_profile_picture_time_map_extension")) {
      try {
        pictureTimeMapExtension = validateCutOtioEditorialProfileV6(
          profile,
          cut.editorial_profile_picture_time_map_extension,
        );
      } catch (error) {
        editorialProfileFailure(
          error,
          `${path}.cut.editorial_profile_picture_time_map_extension`,
        );
      }
    }
    if (!Object.hasOwn(cut, "editorial_link_names")) {
      fail("CUT_OTIO_IMPORT_PROFILE", `${path}.cut.editorial_link_names`, "is required whenever editorial_profile is present.");
    }
    const linkNames = parseEditorialLinkNames(cut.editorial_link_names, `${path}.cut.editorial_link_names`, profile, context);
    if (result.compositionId && result.compositionId !== profile.compositionId) {
      fail("CUT_OTIO_IMPORT_PROFILE", `${path}.cut.editorial_profile.compositionId`, "does not match composition_id.");
    }
    if (result.duration && compareRational(result.duration, profile.duration) !== 0) {
      fail("CUT_OTIO_IMPORT_PROFILE", `${path}.cut.editorial_profile.duration`, "does not match exact_duration.");
    }
    result.editorialProfile = profile;
    if (extension) result.editorialProfileExtension = extension;
    if (nestedExtension) {
      result.editorialProfileNestedExtension = nestedExtension;
    }
    if (directMediaExtension) {
      result.editorialProfileDirectMediaExtension = directMediaExtension;
    }
    if (pictureTimeMapExtension) {
      result.editorialProfilePictureTimeMapExtension = pictureTimeMapExtension;
    }
    result.editorialLinkNames = linkNames;
    context.editorialProfile = {
      profile,
      ...(extension ? { extension } : {}),
      ...(nestedExtension ? { nestedExtension } : {}),
      ...(directMediaExtension ? { directMediaExtension } : {}),
      ...(pictureTimeMapExtension ? { pictureTimeMapExtension } : {}),
      linkNames,
      observedTracks: [],
      observedTransitions: [],
      observedNestedPlacements: [],
      observedDirectMediaAuthorities: [],
      observedPictureTimeMapAuthorities: [],
    };
    importEditorialProfileLosses(
      profile,
      `${path}.cut.editorial_profile`,
      context,
    );
    if (extension) {
      importEditorialProfileV3Losses(
        extension,
        `${path}.cut.editorial_profile_extension`,
        context,
      );
    }
  } else if (Object.hasOwn(cut, "editorial_link_names")
    || Object.hasOwn(cut, "editorial_profile_extension")
    || Object.hasOwn(cut, "editorial_profile_nested_extension")
    || Object.hasOwn(cut, "editorial_profile_direct_media_extension")
    || Object.hasOwn(cut, "editorial_profile_picture_time_map_extension")) {
    const field = Object.hasOwn(cut, "editorial_profile_extension")
      ? "editorial_profile_extension"
      : Object.hasOwn(cut, "editorial_profile_nested_extension")
        ? "editorial_profile_nested_extension"
      : Object.hasOwn(cut, "editorial_profile_direct_media_extension")
        ? "editorial_profile_direct_media_extension"
      : Object.hasOwn(cut, "editorial_profile_picture_time_map_extension")
        ? "editorial_profile_picture_time_map_extension"
      : "editorial_link_names";
    fail(
      "CUT_OTIO_IMPORT_PROFILE",
      `${path}.cut.${field}`,
      "cannot appear without editorial_profile.",
    );
  }
  if (Object.hasOwn(cut, "interchange_report")) importSemanticMatchLosses(cut.interchange_report, `${path}.cut.interchange_report`, context);
  if (Object.hasOwn(cut, "exact_scenes")) {
    if (!Array.isArray(cut.exact_scenes) || cut.exact_scenes.length > context.limits.maxScenes) fail("CUT_OTIO_IMPORT_LIMIT", `${path}.cut.exact_scenes`, `must contain at most ${context.limits.maxScenes} scenes.`);
    result.scenes = cut.exact_scenes.map((entry, index) => {
      const scenePath = `${path}.cut.exact_scenes[${index}]`, scene = closed(entry, scenePath, ["id", "name", "start", "duration"]);
      const id = exactCutIdentifier(boundedString(scene.id, `${scenePath}.id`, context, false), `${scenePath}.id`);
      const name = exactCutIdentifier(boundedString(scene.name, `${scenePath}.name`, context, false), `${scenePath}.name`), start = exactMetadata(scene.start, `${scenePath}.start`, context), duration = exactMetadata(scene.duration, `${scenePath}.duration`, context);
      if (compareRational(start, zeroRational) < 0 || compareRational(duration, zeroRational) <= 0) fail("CUT_OTIO_IMPORT_TIMING", scenePath, "scene timing must be non-negative and positive respectively.");
      return { id, name, start, duration };
    });
    const sceneIds = new Set<string>(), sceneNames = new Set<string>();
    result.scenes.forEach((scene, index) => {
      if (sceneIds.has(scene.id)) fail("CUT_OTIO_IMPORT_UNSUPPORTED", `${path}.cut.exact_scenes[${index}].id`, `duplicates scene id “${scene.id}”.`);
      if (sceneNames.has(scene.name)) fail("CUT_OTIO_IMPORT_UNSUPPORTED", `${path}.cut.exact_scenes[${index}].name`, `duplicates scene name “${scene.name}”, which canonical CUT source cannot declare twice in one timeline.`);
      sceneIds.add(scene.id);
      sceneNames.add(scene.name);
    });
  }
  return result;
}

function parseAnnotation(value: unknown, path: string, context: ImportContext, index: number): ParsedAnnotation {
  const object = closed(value, path, ["OTIO_SCHEMA", "name", "metadata", "marked_range", "color", "comment"]);
  if (object.OTIO_SCHEMA !== "Marker.2") fail("CUT_OTIO_IMPORT_SCHEMA", `${path}.OTIO_SCHEMA`, "must be Marker.2.");
  const displayName = boundedString(object.name, `${path}.name`, context);
  const comment = boundedString(object.comment, `${path}.comment`, context);
  const standardColor = boundedString(object.color, `${path}.color`, context, false);
  if (!Object.hasOwn(otioMarkerColors, standardColor)) fail("CUT_OTIO_IMPORT_UNSUPPORTED", `${path}.color`, `must be a supported OTIO Marker color (${Object.keys(otioMarkerColors).join(", ")}).`);
  const marked = timeRange(object.marked_range, `${path}.marked_range`, context, true);
  if (compareRational(marked.start, zeroRational) < 0) fail("CUT_OTIO_IMPORT_TIMING", `${path}.marked_range.start_time`, "cannot be negative.");
  const cut = metadataObject(object.metadata, `${path}.metadata`, ["annotation_id", "annotation_kind", "composition_id", "scene_id", "exact_color", "role", "grid", "exact_start", "exact_duration", "source"]);
  const inferredKind = compareRational(marked.duration, zeroRational) === 0 ? "marker" : "region";
  const authoredKind = optionalString(cut, "annotation_kind", `${path}.metadata.cut`, context);
  if (authoredKind && authoredKind !== "marker" && authoredKind !== "region") fail("CUT_OTIO_IMPORT_TYPE", `${path}.metadata.cut.annotation_kind`, "must be marker or region.");
  if (authoredKind && authoredKind !== inferredKind) fail("CUT_OTIO_IMPORT_TIMING", `${path}.metadata.cut.annotation_kind`, "conflicts with whether marked_range has zero or positive duration.");
  const id = optionalString(cut, "annotation_id", `${path}.metadata.cut`, context) ?? `otio_annotation_${String(index + 1).padStart(4, "0")}`;
  const rawCompositionId = optionalString(cut, "composition_id", `${path}.metadata.cut`, context);
  const compositionId = rawCompositionId ? exactTimelineIdentifier(rawCompositionId, `${path}.metadata.cut.composition_id`) : undefined;
  const rawSceneId = optionalString(cut, "scene_id", `${path}.metadata.cut`, context);
  const sceneId = rawSceneId ? exactCutIdentifier(rawSceneId, `${path}.metadata.cut.scene_id`) : undefined;
  const exactColor = optionalString(cut, "exact_color", `${path}.metadata.cut`, context);
  const role = optionalString(cut, "role", `${path}.metadata.cut`, context) ?? "note";
  const rawGrid = optionalString(cut, "grid", `${path}.metadata.cut`, context);
  if (rawGrid && rawGrid !== "frame" && rawGrid !== "sample") fail("CUT_OTIO_IMPORT_TYPE", `${path}.metadata.cut.grid`, "must be frame or sample.");
  if (cut && Object.hasOwn(cut, "exact_start")) assertSameTime(marked.start, exactMetadata(cut.exact_start, `${path}.metadata.cut.exact_start`, context), `${path}.metadata.cut.exact_start`);
  if (cut && Object.hasOwn(cut, "exact_duration")) assertSameTime(marked.duration, exactMetadata(cut.exact_duration, `${path}.metadata.cut.exact_duration`, context), `${path}.metadata.cut.exact_duration`);
  if (cut && Object.hasOwn(cut, "source")) {
    const source = closed(cut.source, `${path}.metadata.cut.source`, ["module", "line", "column"]);
    boundedString(source.module, `${path}.metadata.cut.source.module`, context, false);
    if (!Number.isSafeInteger(source.line) || Number(source.line) < 1 || !Number.isSafeInteger(source.column) || Number(source.column) < 1) fail("CUT_OTIO_IMPORT_TYPE", `${path}.metadata.cut.source`, "line and column must be positive safe integers.");
  }
  try {
    const normalized = normalizeEditorialAnnotationMetadata({
      id,
      name: displayName || undefined,
      color: exactColor ?? otioMarkerColors[standardColor],
      role,
      comment,
      grid: rawGrid,
    });
    return { kind: inferredKind, ...normalized, grid: rawGrid as EditorialAnnotationGrid | undefined, ...(compositionId ? { compositionId } : {}), ...(sceneId ? { sceneId } : {}), start: marked.start, duration: marked.duration };
  } catch (error) {
    fail("CUT_OTIO_IMPORT_TYPE", path, error instanceof Error ? error.message : "contains invalid CUT annotation metadata.");
  }
}

function parseClip(
  value: unknown,
  path: string,
  context: ImportContext,
  trackIndex: number,
  itemIndex: number,
  trackKind: "Video" | "Audio",
  cursor: Rational,
  expectedEditorialItem?: Extract<CutOtioEditorialTrack["items"][number], { kind: "clip" }>,
): ParsedClip {
  const object = closed(value, path, ["OTIO_SCHEMA", "name", "metadata", "source_range", "effects", "markers", "enabled", "media_references", "active_media_reference_key"]);
  if (object.OTIO_SCHEMA !== "Clip.2") fail("CUT_OTIO_IMPORT_SCHEMA", `${path}.OTIO_SCHEMA`, "must be Clip.2.");
  const name = boundedString(object.name, `${path}.name`, context), range = timeRange(object.source_range, `${path}.source_range`, context);
  if (compareRational(range.start, zeroRational) < 0) fail("CUT_OTIO_IMPORT_TIMING", `${path}.source_range.start_time`, "cannot be negative.");
  if (compareRational(addRational(range.start, range.duration), rational(context.limits.maxSourceTimeSeconds)) > 0) fail("CUT_OTIO_IMPORT_LIMIT", `${path}.source_range`, `exceeds maxSourceTimeSeconds (${context.limits.maxSourceTimeSeconds}).`);
  if (!expectedEditorialItem) {
    emptyArray(object.effects, `${path}.effects`);
  } else if (expectedEditorialItem.retime.kind === "identity") {
    emptyArray(object.effects, `${path}.effects`);
  } else {
    if (!Array.isArray(object.effects) || object.effects.length !== 1) {
      fail("CUT_OTIO_IMPORT_PROFILE", `${path}.effects`, "must contain exactly one LinearTimeWarp for the declared constant retime.");
    }
    const effectPath = `${path}.effects[0]`, effect = closed(object.effects[0], effectPath, ["OTIO_SCHEMA", "name", "metadata", "effect_name", "enabled", "time_scalar"]);
    if (effect.OTIO_SCHEMA !== "LinearTimeWarp.1" || effect.effect_name !== "LinearTimeWarp") {
      fail("CUT_OTIO_IMPORT_PROFILE", `${effectPath}.OTIO_SCHEMA`, "must be a native LinearTimeWarp.1 effect.");
    }
    boundedString(effect.name, `${effectPath}.name`, context);
    enabled(effect.enabled, `${effectPath}.enabled`);
    const effectCut = metadataObject(effect.metadata, `${effectPath}.metadata`, ["direction", "exact_rate"]);
    if (!effectCut || !Object.hasOwn(effectCut, "direction") || !Object.hasOwn(effectCut, "exact_rate")) {
      fail("CUT_OTIO_IMPORT_PROFILE", `${effectPath}.metadata.cut`, "must carry direction and exact_rate.");
    }
    canonicalMetadataEquals(effectCut.direction, expectedEditorialItem.retime.direction, `${effectPath}.metadata.cut.direction`);
    canonicalMetadataEquals(effectCut.exact_rate, expectedEditorialItem.retime.rate, `${effectPath}.metadata.cut.exact_rate`);
    const expectedScalar = rationalToNumber(expectedEditorialItem.retime.rate) * (expectedEditorialItem.retime.direction === "reverse" ? -1 : 1);
    if (typeof effect.time_scalar !== "number" || !Number.isFinite(effect.time_scalar) || !Object.is(effect.time_scalar, expectedScalar)) {
      fail("CUT_OTIO_IMPORT_PROFILE", `${effectPath}.time_scalar`, "does not match the declared exact constant retime.");
    }
  }
  emptyArray(object.markers, `${path}.markers`); enabled(object.enabled, `${path}.enabled`);
  if (object.active_media_reference_key !== "DEFAULT_MEDIA") fail("CUT_OTIO_IMPORT_UNSUPPORTED", `${path}.active_media_reference_key`, "only DEFAULT_MEDIA is supported.");
  const references = closed(object.media_references, `${path}.media_references`, ["DEFAULT_MEDIA"]), reference = closed(references.DEFAULT_MEDIA, `${path}.media_references.DEFAULT_MEDIA`, ["OTIO_SCHEMA", "name", "metadata", "target_url", "available_range", "available_image_bounds"]);
  if (reference.OTIO_SCHEMA !== "ExternalReference.1") fail("CUT_OTIO_IMPORT_SCHEMA", `${path}.media_references.DEFAULT_MEDIA.OTIO_SCHEMA`, "must be ExternalReference.1.");
  boundedString(reference.name, `${path}.media_references.DEFAULT_MEDIA.name`, context);
  if (reference.available_range !== null || reference.available_image_bounds !== null) fail("CUT_OTIO_IMPORT_UNSUPPORTED", `${path}.media_references.DEFAULT_MEDIA`, "available ranges/image bounds are not preserved by the executable CUT subset.");
  const locator = boundedString(reference.target_url, `${path}.media_references.DEFAULT_MEDIA.target_url`, context, false);
  if (/[\u0000-\u001f\u007f]/.test(locator)) fail("CUT_OTIO_IMPORT_RESOURCE", `${path}.media_references.DEFAULT_MEDIA.target_url`, "cannot contain control characters.");
  try { validateProjectLocator(locator, "OTIO ExternalReference target_url"); }
  catch (error) { fail("CUT_OTIO_IMPORT_RESOURCE", `${path}.media_references.DEFAULT_MEDIA.target_url`, error instanceof Error ? error.message : String(error)); }

  const expectedDirectMediaAuthority =
    expectedEditorialItem === undefined
      ? undefined
      : context.editorialProfile?.directMediaExtension?.authorities.find(
          (authority) => authority.itemId === expectedEditorialItem.id,
        );
  const expectedPictureTimeMapAuthority =
    expectedEditorialItem === undefined
      ? undefined
      : context.editorialProfile?.pictureTimeMapExtension?.authorities.find(
          (authority) => authority.itemId === expectedEditorialItem.id,
        );
  const clipCut = metadataObject(object.metadata, `${path}.metadata`, [
    "node_id", "node_op", "media_kind", "resource_id", "resource_kind", "resource_sha256", "scene_id",
    "linked_av_id", "authored_link_id", "editorial_item_id", "editorial_item_order", "loop_iteration",
    "exact_placement", "exact_source_start", "exact_duration", "exact_destination", "exact_link",
    "exact_retime", "exact_nesting", "transcript",
    ...(expectedDirectMediaAuthority === undefined
      ? []
      : ["direct_media_authority"]),
    ...(expectedPictureTimeMapAuthority === undefined
      ? []
      : ["picture_time_map_authority"]),
    ...(expectedEditorialItem?.role === undefined ? [] : ["editorial_role"]),
    ...(expectedEditorialItem?.metadata === undefined ? [] : ["editorial_metadata"]),
  ]);
  const referenceCut = metadataObject(reference.metadata, `${path}.media_references.DEFAULT_MEDIA.metadata`, ["resource_id", "kind", "state", "sha256"]);
  const nodeOp = optionalString(clipCut, "node_op", `${path}.metadata.cut`, context), resourceId = optionalString(clipCut, "resource_id", `${path}.metadata.cut`, context), referenceResourceId = optionalString(referenceCut, "resource_id", `${path}.media_references.DEFAULT_MEDIA.metadata.cut`, context);
  if (resourceId && referenceResourceId && resourceId !== referenceResourceId) fail("CUT_OTIO_IMPORT_RESOURCE", `${path}.metadata.cut.resource_id`, "does not match the ExternalReference resource_id.");
  const mediaKind = optionalString(clipCut, "media_kind", `${path}.metadata.cut`, context);
  if (mediaKind && mediaKind !== trackKind.toLowerCase()) fail("CUT_OTIO_IMPORT_RESOURCE", `${path}.metadata.cut.media_kind`, "does not match the containing track kind.");
  const clipResourceKind = optionalString(clipCut, "resource_kind", `${path}.metadata.cut`, context), referenceKind = optionalString(referenceCut, "kind", `${path}.media_references.DEFAULT_MEDIA.metadata.cut`, context);
  if (clipResourceKind && referenceKind && clipResourceKind !== referenceKind) fail("CUT_OTIO_IMPORT_RESOURCE", `${path}.metadata.cut.resource_kind`, "does not match the ExternalReference resource kind.");
  const rawKind = clipResourceKind ?? referenceKind;
  if (rawKind && !new Set(["video", "audio", "image"]).has(rawKind)) fail("CUT_OTIO_IMPORT_RESOURCE", `${path}.metadata.cut.resource_kind`, "must be video, audio, or image for this import subset.");
  const resourceKind = rawKind as ParsedClip["resourceKind"];
  const sha = optionalSha(clipCut, "resource_sha256", `${path}.metadata.cut`, context), referenceSha = optionalSha(referenceCut, "sha256", `${path}.media_references.DEFAULT_MEDIA.metadata.cut`, context);
  if (sha && referenceSha && sha !== referenceSha) fail("CUT_OTIO_IMPORT_RESOURCE", `${path}.metadata.cut.resource_sha256`, "does not match the ExternalReference SHA-256.");
  if (clipCut && Object.hasOwn(clipCut, "exact_placement")) assertSameTime(cursor, exactMetadata(clipCut.exact_placement, `${path}.metadata.cut.exact_placement`, context), `${path}.metadata.cut.exact_placement`);
  if (clipCut && Object.hasOwn(clipCut, "exact_source_start")) assertSameTime(range.start, exactMetadata(clipCut.exact_source_start, `${path}.metadata.cut.exact_source_start`, context), `${path}.metadata.cut.exact_source_start`);
  if (clipCut && Object.hasOwn(clipCut, "exact_duration")) {
    const exactDuration = exactMetadata(clipCut.exact_duration, `${path}.metadata.cut.exact_duration`, context);
    assertSameTime(
      expectedEditorialItem?.source.duration ?? range.duration,
      exactDuration,
      `${path}.metadata.cut.exact_duration`,
    );
  }
  if (clipCut && Object.hasOwn(clipCut, "loop_iteration") && (!Number.isSafeInteger(clipCut.loop_iteration) || Number(clipCut.loop_iteration) < 0)) fail("CUT_OTIO_IMPORT_TYPE", `${path}.metadata.cut.loop_iteration`, "must be a non-negative safe integer.");
  optionalString(clipCut, "node_id", `${path}.metadata.cut`, context);
  const rawSceneId = optionalString(clipCut, "scene_id", `${path}.metadata.cut`, context);
  const sceneId = rawSceneId ? exactCutIdentifier(rawSceneId, `${path}.metadata.cut.scene_id`) : undefined;
  if (referenceCut && Object.hasOwn(referenceCut, "state") && !new Set(["locked", "unlocked"]).has(referenceCut.state as string)) fail("CUT_OTIO_IMPORT_RESOURCE", `${path}.media_references.DEFAULT_MEDIA.metadata.cut.state`, "must be locked or unlocked.");
  const linkedId = optionalString(clipCut, "linked_av_id", `${path}.metadata.cut`, context);
  let editorialItemId: string | undefined;
  let editorialRole: string | undefined;
  let editorialMetadata: Readonly<Record<string, string>> | undefined;
  let directMediaAuthority: CutOtioDirectMediaAuthority | undefined;
  let pictureTimeMapAuthority: CutOtioPictureTimeMapAuthority | undefined;
  if (expectedEditorialItem) {
    const requiredProfileFields = [
      "authored_link_id", "editorial_item_id", "editorial_item_order", "exact_destination",
      "exact_link", "exact_retime", "exact_nesting",
    ] as const;
    if (!clipCut || requiredProfileFields.some((field) => !Object.hasOwn(clipCut, field))) {
      fail("CUT_OTIO_IMPORT_PROFILE", `${path}.metadata.cut`, "is missing required closed editorial item metadata.");
    }
    editorialItemId = boundedString(clipCut.editorial_item_id, `${path}.metadata.cut.editorial_item_id`, context, false);
    if (editorialItemId !== expectedEditorialItem.id || clipCut.editorial_item_order !== expectedEditorialItem.order) {
      fail("CUT_OTIO_IMPORT_PROFILE", `${path}.metadata.cut.editorial_item_id`, "does not match the declared profile item identity/order.");
    }
    assertSameTime(range.start, expectedEditorialItem.source.start, `${path}.source_range.start_time`);
    assertSameTime(range.duration, expectedEditorialItem.destination.duration, `${path}.source_range.duration`);
    assertSameTime(cursor, expectedEditorialItem.destination.start, `${path}.metadata.cut.exact_destination.start`);
    canonicalMetadataEquals(clipCut.exact_destination, expectedEditorialItem.destination, `${path}.metadata.cut.exact_destination`);
    canonicalMetadataEquals(clipCut.exact_link, expectedEditorialItem.link, `${path}.metadata.cut.exact_link`);
    canonicalMetadataEquals(clipCut.exact_retime, expectedEditorialItem.retime, `${path}.metadata.cut.exact_retime`);
    canonicalMetadataEquals(clipCut.exact_nesting, null, `${path}.metadata.cut.exact_nesting`);
    const expectedLinkName = expectedEditorialItem.link.kind === "linked"
      ? context.editorialProfile?.linkNames.get(expectedEditorialItem.link.groupId)
      : undefined;
    const authoredLinkId = optionalString(clipCut, "authored_link_id", `${path}.metadata.cut`, context);
    if (authoredLinkId !== expectedLinkName) {
      fail("CUT_OTIO_IMPORT_PROFILE", `${path}.metadata.cut.authored_link_id`, "does not match editorial_link_names and the declared item link.");
    }
    if (expectedEditorialItem.role !== undefined) {
      if (!Object.hasOwn(clipCut, "editorial_role")) {
        fail("CUT_OTIO_IMPORT_PROFILE", `${path}.metadata.cut.editorial_role`, "is required by the declared profile item role.");
      }
      canonicalMetadataEquals(clipCut.editorial_role, expectedEditorialItem.role, `${path}.metadata.cut.editorial_role`);
      editorialRole = expectedEditorialItem.role;
    }
    if (expectedEditorialItem.metadata !== undefined) {
      if (!Object.hasOwn(clipCut, "editorial_metadata")) {
        fail("CUT_OTIO_IMPORT_PROFILE", `${path}.metadata.cut.editorial_metadata`, "is required by the declared profile item metadata.");
      }
      canonicalMetadataEquals(clipCut.editorial_metadata, expectedEditorialItem.metadata, `${path}.metadata.cut.editorial_metadata`);
      editorialMetadata = expectedEditorialItem.metadata;
    }
    if (expectedDirectMediaAuthority) {
      if (!Object.hasOwn(clipCut, "direct_media_authority")) {
        fail(
          "CUT_OTIO_IMPORT_PROFILE",
          `${path}.metadata.cut.direct_media_authority`,
          "is required by the V5 direct-media extension.",
        );
      }
      canonicalMetadataEquals(
        clipCut.direct_media_authority,
        expectedDirectMediaAuthority,
        `${path}.metadata.cut.direct_media_authority`,
      );
      if (expectedDirectMediaAuthority.resource.id
          !== (resourceId ?? referenceResourceId)
        || expectedDirectMediaAuthority.resource.kind !== resourceKind
        || expectedDirectMediaAuthority.resource.sha256
          !== (sha ?? referenceSha)) {
        fail(
          "CUT_OTIO_IMPORT_PROFILE",
          `${path}.metadata.cut.direct_media_authority.resource`,
          "does not match the native ExternalReference identity.",
        );
      }
      directMediaAuthority = expectedDirectMediaAuthority;
      context.editorialProfile!.observedDirectMediaAuthorities.push(
        expectedDirectMediaAuthority,
      );
    }
    if (expectedPictureTimeMapAuthority) {
      if (!Object.hasOwn(clipCut, "picture_time_map_authority")) {
        fail(
          "CUT_OTIO_IMPORT_PROFILE",
          `${path}.metadata.cut.picture_time_map_authority`,
          "is required by the V6 picture-time-map extension.",
        );
      }
      canonicalMetadataEquals(
        clipCut.picture_time_map_authority,
        expectedPictureTimeMapAuthority,
        `${path}.metadata.cut.picture_time_map_authority`,
      );
      if (expectedPictureTimeMapAuthority.resource.id
          !== (resourceId ?? referenceResourceId)
        || expectedPictureTimeMapAuthority.resource.sha256
          !== (sha ?? referenceSha)) {
        fail(
          "CUT_OTIO_IMPORT_PROFILE",
          `${path}.metadata.cut.picture_time_map_authority.resource`,
          "does not match the native ExternalReference identity.",
        );
      }
      pictureTimeMapAuthority = expectedPictureTimeMapAuthority;
      context.editorialProfile!.observedPictureTimeMapAuthorities.push(
        expectedPictureTimeMapAuthority,
      );
    }
  }
  if (clipCut && Object.hasOwn(clipCut, "transcript")) {
    const transcriptPath = `${path}.metadata.cut.transcript`;
    const transcript = boundedString(clipCut.transcript, transcriptPath, context, true);
    const loss: CutOtioImportLoss = {
      code: "CUT_OTIO_IMPORT_NARRATION_TRANSCRIPT_UNSUPPORTED",
      category: "metadata",
      disposition: "omitted",
      path: transcriptPath,
      subject: { kind: "clip", trackIndex, itemIndex, nodeOp: nodeOp ?? null, property: "transcript" },
      evidence: { inputKind: "string", value: transcript },
      message: "Legacy Narration transcript metadata has no executable current Narration input. The imported source omits it only under explicit lossy acceptance; use Captions for visible timed text or Marker/Region role metadata for non-rendering notes.",
    };
    if (!context.allowLossy) {
      fail(
        "CUT_OTIO_IMPORT_LOSSY_REFUSED",
        transcriptPath,
        `legacy Narration transcript metadata ${JSON.stringify(transcript)} cannot be represented by current CUT; explicit allowLossy is required to omit it with a machine-readable loss report.`,
      );
    }
    context.losses.push(loss);
  }

  context.clipInstances += 1;
  if (context.clipInstances > context.limits.maxClipInstances) fail("CUT_OTIO_IMPORT_LIMIT", path, `clip count exceeds maxClipInstances (${context.limits.maxClipInstances}).`);
  return {
    trackIndex,
    itemIndex,
    trackKind,
    start: cursor,
    duration: expectedEditorialItem?.destination.duration ?? range.duration,
    sourceStart: range.start,
    locator,
    name,
    nodeOp,
    resourceKind,
    resourceId: resourceId ?? referenceResourceId,
    expectedSha256: sha ?? referenceSha,
    linkedId,
    sceneId,
    editorialItemId,
    editorialRole,
    editorialMetadata,
    directMediaAuthority,
    pictureTimeMapAuthority,
  };
}

function parseGap(
  value: unknown,
  path: string,
  context: ImportContext,
  cursor?: Rational,
  expectedEditorialItem?: Extract<CutOtioEditorialTrack["items"][number], { kind: "gap" }>,
) {
  const object = closed(value, path, ["OTIO_SCHEMA", "name", "metadata", "source_range", "effects", "markers", "enabled"]);
  if (object.OTIO_SCHEMA !== "Gap.1") fail("CUT_OTIO_IMPORT_SCHEMA", `${path}.OTIO_SCHEMA`, "must be Gap.1.");
  boundedString(object.name, `${path}.name`, context); emptyArray(object.effects, `${path}.effects`); emptyArray(object.markers, `${path}.markers`); enabled(object.enabled, `${path}.enabled`);
  const range = timeRange(object.source_range, `${path}.source_range`, context);
  if (compareRational(range.start, zeroRational) !== 0) fail("CUT_OTIO_IMPORT_TIMING", `${path}.source_range.start_time`, "Gap source time must be zero.");
  const cut = metadataObject(object.metadata, `${path}.metadata`, [
    "editorial_item_id", "editorial_item_order", "exact_destination", "exact_link",
    "exact_retime", "exact_nesting", "exact_duration",
  ]);
  if (cut && Object.hasOwn(cut, "exact_duration")) assertSameTime(range.duration, exactMetadata(cut.exact_duration, `${path}.metadata.cut.exact_duration`, context), `${path}.metadata.cut.exact_duration`);
  if (expectedEditorialItem) {
    const required = ["editorial_item_id", "editorial_item_order", "exact_destination", "exact_link", "exact_retime", "exact_nesting"] as const;
    if (!cut || required.some((field) => !Object.hasOwn(cut, field))) {
      fail("CUT_OTIO_IMPORT_PROFILE", `${path}.metadata.cut`, "is missing required closed editorial gap metadata.");
    }
    if (cut.editorial_item_id !== expectedEditorialItem.id || cut.editorial_item_order !== expectedEditorialItem.order) {
      fail("CUT_OTIO_IMPORT_PROFILE", `${path}.metadata.cut.editorial_item_id`, "does not match the declared profile gap identity/order.");
    }
    if (!cursor) fail("CUT_OTIO_IMPORT_PROFILE", path, "lost its native destination cursor.");
    assertSameTime(cursor, expectedEditorialItem.destination.start, `${path}.metadata.cut.exact_destination.start`);
    assertSameTime(range.duration, expectedEditorialItem.destination.duration, `${path}.source_range.duration`);
    canonicalMetadataEquals(cut.exact_destination, expectedEditorialItem.destination, `${path}.metadata.cut.exact_destination`);
    canonicalMetadataEquals(cut.exact_link, expectedEditorialItem.link, `${path}.metadata.cut.exact_link`);
    canonicalMetadataEquals(cut.exact_retime, expectedEditorialItem.retime, `${path}.metadata.cut.exact_retime`);
    canonicalMetadataEquals(cut.exact_nesting, null, `${path}.metadata.cut.exact_nesting`);
  }
  return range.duration;
}

function parseEditorialTransition(
  value: unknown,
  path: string,
  context: ImportContext,
  expected: CutOtioEditorialTransition,
) {
  const object = closed(value, path, [
    "OTIO_SCHEMA", "name", "metadata", "transition_type", "in_offset", "out_offset",
    "enabled",
  ]);
  if (object.OTIO_SCHEMA !== "Transition.1" || object.transition_type !== "SMPTE_Dissolve") {
    fail("CUT_OTIO_IMPORT_PROFILE", `${path}.OTIO_SCHEMA`, "must be the native SMPTE_Dissolve Transition.1 declared by the profile.");
  }
  boundedString(object.name, `${path}.name`, context);
  enabled(object.enabled, `${path}.enabled`);
  const half = rational(expected.duration.numerator, BigInt(expected.duration.denominator) * 2n);
  assertSameTime(otioTime(object.in_offset, `${path}.in_offset`, context), half, `${path}.in_offset`);
  assertSameTime(otioTime(object.out_offset, `${path}.out_offset`, context), half, `${path}.out_offset`);
  const cut = metadataObject(object.metadata, `${path}.metadata`, [
    "editorial_transition_id", "track_id", "outgoing_item_id", "incoming_item_id",
    "exact_cut", "exact_duration", "exact_overlap", "exact_outgoing_source",
    "exact_incoming_source", "mapping",
  ]);
  if (!cut) fail("CUT_OTIO_IMPORT_PROFILE", `${path}.metadata.cut`, "is required for a profile transition.");
  canonicalMetadataEquals(cut.editorial_transition_id, expected.id, `${path}.metadata.cut.editorial_transition_id`);
  canonicalMetadataEquals(cut.track_id, expected.trackId, `${path}.metadata.cut.track_id`);
  canonicalMetadataEquals(cut.outgoing_item_id, expected.outgoingItemId, `${path}.metadata.cut.outgoing_item_id`);
  canonicalMetadataEquals(cut.incoming_item_id, expected.incomingItemId, `${path}.metadata.cut.incoming_item_id`);
  canonicalMetadataEquals(cut.exact_cut, expected.cut, `${path}.metadata.cut.exact_cut`);
  canonicalMetadataEquals(cut.exact_duration, expected.duration, `${path}.metadata.cut.exact_duration`);
  canonicalMetadataEquals(cut.exact_overlap, expected.overlap, `${path}.metadata.cut.exact_overlap`);
  canonicalMetadataEquals(cut.exact_outgoing_source, expected.outgoingSource, `${path}.metadata.cut.exact_outgoing_source`);
  canonicalMetadataEquals(cut.exact_incoming_source, expected.incomingSource, `${path}.metadata.cut.exact_incoming_source`);
  canonicalMetadataEquals(cut.mapping, expected.mapping, `${path}.metadata.cut.mapping`);
  context.editorialProfile?.observedTransitions.push(expected);
}

function parseEditorialNestedStack(
  value: unknown,
  path: string,
  context: ImportContext,
  cursor: Rational,
  expected: Extract<CutOtioEditorialTrack["items"][number], { kind: "nested-sequence" }>,
  expectedPlacement?: CutOtioEditorialNestedPlacement,
) {
  const object = closed(value, path, [
    "OTIO_SCHEMA", "name", "metadata", "source_range", "effects", "markers", "enabled", "children",
  ]);
  if (object.OTIO_SCHEMA !== "Stack.1") fail("CUT_OTIO_IMPORT_PROFILE", `${path}.OTIO_SCHEMA`, "must be Stack.1 for a declared nested sequence.");
  boundedString(object.name, `${path}.name`, context);
  emptyArray(object.effects, `${path}.effects`); emptyArray(object.markers, `${path}.markers`); enabled(object.enabled, `${path}.enabled`);
  if (!Array.isArray(object.children) || object.children.length !== 0) {
    fail("CUT_OTIO_IMPORT_PROFILE", `${path}.children`, "must remain the bounded empty native Stack placeholder declared by profile v2.");
  }
  const range = timeRange(object.source_range, `${path}.source_range`, context);
  assertSameTime(range.start, expected.source.start, `${path}.source_range.start_time`);
  assertSameTime(range.duration, expected.source.duration, `${path}.source_range.duration`);
  assertSameTime(cursor, expected.destination.start, `${path}.metadata.cut.exact_destination.start`);
  const cut = metadataObject(object.metadata, `${path}.metadata`, [
    "editorial_item_id", "editorial_item_order", "exact_destination", "exact_source",
    "exact_link", "exact_retime", "exact_nesting",
    ...(expectedPlacement?.role === undefined ? [] : ["editorial_role"]),
    ...(expectedPlacement?.metadata === undefined ? [] : ["editorial_metadata"]),
  ]);
  if (!cut) fail("CUT_OTIO_IMPORT_PROFILE", `${path}.metadata.cut`, "is required for a profile nested sequence.");
  canonicalMetadataEquals(cut.editorial_item_id, expected.id, `${path}.metadata.cut.editorial_item_id`);
  canonicalMetadataEquals(cut.editorial_item_order, expected.order, `${path}.metadata.cut.editorial_item_order`);
  canonicalMetadataEquals(cut.exact_destination, expected.destination, `${path}.metadata.cut.exact_destination`);
  canonicalMetadataEquals(cut.exact_source, expected.source, `${path}.metadata.cut.exact_source`);
  canonicalMetadataEquals(cut.exact_link, expected.link, `${path}.metadata.cut.exact_link`);
  canonicalMetadataEquals(cut.exact_retime, expected.retime, `${path}.metadata.cut.exact_retime`);
  canonicalMetadataEquals(cut.exact_nesting, expected.nesting, `${path}.metadata.cut.exact_nesting`);
  if (expectedPlacement) {
    if (expectedPlacement.role !== undefined) {
      if (!Object.hasOwn(cut, "editorial_role")) {
        fail(
          "CUT_OTIO_IMPORT_PROFILE",
          `${path}.metadata.cut.editorial_role`,
          "is required by the V4 nested-placement authority.",
        );
      }
      canonicalMetadataEquals(
        cut.editorial_role,
        expectedPlacement.role,
        `${path}.metadata.cut.editorial_role`,
      );
    }
    if (expectedPlacement.metadata !== undefined) {
      if (!Object.hasOwn(cut, "editorial_metadata")) {
        fail(
          "CUT_OTIO_IMPORT_PROFILE",
          `${path}.metadata.cut.editorial_metadata`,
          "is required by the V4 nested-placement authority.",
        );
      }
      canonicalMetadataEquals(
        cut.editorial_metadata,
        expectedPlacement.metadata,
        `${path}.metadata.cut.editorial_metadata`,
      );
    }
    context.editorialProfile?.observedNestedPlacements.push({
      itemId: expectedPlacement.itemId,
      nestingInstanceId: expectedPlacement.nestingInstanceId,
      ...(expectedPlacement.role === undefined
        ? {}
        : { role: expectedPlacement.role }),
      ...(expectedPlacement.metadata === undefined
        ? {}
        : { metadata: expectedPlacement.metadata }),
    });
  }
  return expected.destination.duration;
}

function parseTrack(value: unknown, path: string, context: ImportContext, index: number): ParsedTrack {
  const object = closed(value, path, ["OTIO_SCHEMA", "name", "metadata", "source_range", "effects", "markers", "enabled", "kind", "children"]);
  if (object.OTIO_SCHEMA !== "Track.1") fail("CUT_OTIO_IMPORT_SCHEMA", `${path}.OTIO_SCHEMA`, "must be Track.1.");
  const name = boundedString(object.name, `${path}.name`, context);
  if (object.kind !== "Video" && object.kind !== "Audio") fail("CUT_OTIO_IMPORT_UNSUPPORTED", `${path}.kind`, "must be Video or Audio.");
  const kind = object.kind;
  const expectedTrack = context.editorialProfile?.profile.tracks[index];
  if (context.editorialProfile && !expectedTrack) fail("CUT_OTIO_IMPORT_PROFILE", path, "has no corresponding declared editorial profile track.");
  if (expectedTrack && expectedTrack.kind !== kind) fail("CUT_OTIO_IMPORT_PROFILE", `${path}.kind`, "does not match the declared profile track kind.");
  if (object.source_range !== null) fail("CUT_OTIO_IMPORT_UNSUPPORTED", `${path}.source_range`, "track source ranges are not in the executable subset.");
  emptyArray(object.effects, `${path}.effects`); emptyArray(object.markers, `${path}.markers`); enabled(object.enabled, `${path}.enabled`);
  const trackCut = metadataObject(object.metadata, `${path}.metadata`, [
    "source_node_id", "source_node_op", "scene_id", "layer_index", "exact_placement",
    ...(expectedTrack ? ["editorial_track_id", "editorial_track_order", "editorial_profile_version"] : []),
    ...(expectedTrack?.role === undefined ? [] : ["editorial_role"]),
    ...(expectedTrack?.metadata === undefined ? [] : ["editorial_metadata"]),
  ]);
  optionalString(trackCut, "source_node_id", `${path}.metadata.cut`, context); optionalString(trackCut, "source_node_op", `${path}.metadata.cut`, context);
  const rawSceneId = optionalString(trackCut, "scene_id", `${path}.metadata.cut`, context);
  const sceneId = rawSceneId ? exactCutIdentifier(rawSceneId, `${path}.metadata.cut.scene_id`) : undefined;
  if (trackCut && Object.hasOwn(trackCut, "layer_index") && (!Number.isSafeInteger(trackCut.layer_index) || Number(trackCut.layer_index) < 0)) fail("CUT_OTIO_IMPORT_TYPE", `${path}.metadata.cut.layer_index`, "must be a non-negative safe integer.");
  if (expectedTrack) {
    if (!trackCut
      || trackCut.editorial_track_id !== expectedTrack.id
      || trackCut.editorial_track_order !== expectedTrack.order
      || trackCut.editorial_profile_version !== 2) {
      fail("CUT_OTIO_IMPORT_PROFILE", `${path}.metadata.cut`, "does not match the declared profile track identity/order/version.");
    }
    if (expectedTrack.role !== undefined) {
      if (!Object.hasOwn(trackCut, "editorial_role")) {
        fail("CUT_OTIO_IMPORT_PROFILE", `${path}.metadata.cut.editorial_role`, "is required by the declared profile track role.");
      }
      canonicalMetadataEquals(trackCut.editorial_role, expectedTrack.role, `${path}.metadata.cut.editorial_role`);
    }
    if (expectedTrack.metadata !== undefined) {
      if (!Object.hasOwn(trackCut, "editorial_metadata")) {
        fail("CUT_OTIO_IMPORT_PROFILE", `${path}.metadata.cut.editorial_metadata`, "is required by the declared profile track metadata.");
      }
      canonicalMetadataEquals(trackCut.editorial_metadata, expectedTrack.metadata, `${path}.metadata.cut.editorial_metadata`);
    }
  }
  if (!Array.isArray(object.children) || object.children.length > context.limits.maxTrackItems) fail("CUT_OTIO_IMPORT_LIMIT", `${path}.children`, `must contain at most ${context.limits.maxTrackItems} items.`);
  let cursor = zeroRational, gaps = 0, editorialItemIndex = 0; const clips: ParsedClip[] = [];
  const expectedTransitions = expectedTrack
    ? context.editorialProfile!.profile.transitions.filter((transition) => transition.trackId === expectedTrack.id)
    : [];
  const observedTransitionIds = new Set<string>();
  object.children.forEach((item, itemIndex) => {
    const itemPath = `${path}.children[${itemIndex}]`, itemObject = record(item, itemPath), schema = itemObject.OTIO_SCHEMA;
    if (schema === "Transition.1") {
      if (!expectedTrack) fail("CUT_OTIO_IMPORT_UNSUPPORTED", `${itemPath}.OTIO_SCHEMA`, "transitions require a validated closed CUT editorial profile.");
      const incoming = expectedTrack.items[editorialItemIndex];
      const candidates = incoming
        ? expectedTransitions.filter((transition) => transition.incomingItemId === incoming.id && !observedTransitionIds.has(transition.id))
        : [];
      if (candidates.length !== 1) fail("CUT_OTIO_IMPORT_PROFILE", itemPath, "does not identify exactly one declared transition before its incoming item.");
      parseEditorialTransition(item, itemPath, context, candidates[0]);
      observedTransitionIds.add(candidates[0].id);
      return;
    }
    const expectedItem = expectedTrack?.items[editorialItemIndex];
    if (expectedTrack && !expectedItem) fail("CUT_OTIO_IMPORT_PROFILE", itemPath, "contains more native items than the declared profile track.");
    if (schema === "Gap.1") {
      if (expectedItem && expectedItem.kind !== "gap") fail("CUT_OTIO_IMPORT_PROFILE", `${itemPath}.OTIO_SCHEMA`, "does not match the declared profile item kind.");
      cursor = boundedRational(addRational(cursor, parseGap(item, itemPath, context, cursor, expectedItem as Extract<typeof expectedItem, { kind: "gap" }> | undefined)), itemPath, context);
      gaps += 1;
    } else if (schema === "Clip.2") {
      if (expectedItem && expectedItem.kind !== "clip") fail("CUT_OTIO_IMPORT_PROFILE", `${itemPath}.OTIO_SCHEMA`, "does not match the declared profile item kind.");
      const clip = parseClip(item, itemPath, context, index, itemIndex, kind, cursor, expectedItem as Extract<typeof expectedItem, { kind: "clip" }> | undefined);
      clips.push(clip);
      cursor = boundedRational(addRational(cursor, clip.duration), itemPath, context);
    } else if (schema === "Stack.1") {
      if (!expectedItem || expectedItem.kind !== "nested-sequence") fail("CUT_OTIO_IMPORT_PROFILE", `${itemPath}.OTIO_SCHEMA`, "does not match a declared nested-sequence profile item.");
      const expectedPlacement =
        context.editorialProfile?.nestedExtension?.placements.find(
          (placement) => placement.itemId === expectedItem.id,
        );
      cursor = boundedRational(addRational(cursor, parseEditorialNestedStack(
        item,
        itemPath,
        context,
        cursor,
        expectedItem,
        expectedPlacement,
      )), itemPath, context);
    } else fail("CUT_OTIO_IMPORT_UNSUPPORTED", `${itemPath}.OTIO_SCHEMA`, `schema ${JSON.stringify(schema)} is not an executable clip, gap, transition, or profiled nested stack.`);
    editorialItemIndex += 1;
    if (compareRational(cursor, rational(context.limits.maxDurationSeconds)) > 0) fail("CUT_OTIO_IMPORT_LIMIT", itemPath, `track duration exceeds maxDurationSeconds (${context.limits.maxDurationSeconds}).`);
  });
  if (expectedTrack) {
    if (editorialItemIndex !== expectedTrack.items.length) fail("CUT_OTIO_IMPORT_PROFILE", `${path}.children`, "contains fewer native items than the declared profile track.");
    if (observedTransitionIds.size !== expectedTransitions.length) fail("CUT_OTIO_IMPORT_PROFILE", `${path}.children`, "omits one or more declared native transitions.");
    context.editorialProfile!.observedTracks.push({
      id: expectedTrack.id,
      kind: expectedTrack.kind,
      order: expectedTrack.order,
      ...(expectedTrack.role === undefined ? {} : { role: expectedTrack.role }),
      ...(expectedTrack.metadata === undefined ? {} : { metadata: expectedTrack.metadata }),
      items: expectedTrack.items.map((item) => ({
        id: item.id,
        kind: item.kind,
        order: item.order,
        destination: item.destination,
        source: item.source,
        retime: item.retime,
        nesting: item.nesting,
        ...(item.kind === "clip"
          ? (() => {
              const clip = clips.find((candidate) => candidate.editorialItemId === item.id);
              return {
                ...(clip?.editorialRole === undefined ? {} : { role: clip.editorialRole }),
                ...(clip?.editorialMetadata === undefined ? {} : { metadata: clip.editorialMetadata }),
              };
            })()
          : {}),
      })),
    });
  }
  if (trackCut && Object.hasOwn(trackCut, "exact_placement")) {
    const first = expectedTrack ? zeroRational : clips[0]?.start ?? zeroRational;
    assertSameTime(first, exactMetadata(trackCut.exact_placement, `${path}.metadata.cut.exact_placement`, context), `${path}.metadata.cut.exact_placement`);
  }
  return { index, name, kind, clips, duration: cursor, gaps, implicitTrailingGap: false, sceneId };
}

function validateTimeline(value: unknown, context: ImportContext) {
  const root = closed(value, "$", ["OTIO_SCHEMA", "name", "metadata", "global_start_time", "tracks"]);
  if (root.OTIO_SCHEMA !== "Timeline.1") fail("CUT_OTIO_IMPORT_SCHEMA", "$.OTIO_SCHEMA", "must be Timeline.1.");
  const name = boundedString(root.name, "$.name", context, false), metadata = timelineMetadata(root.metadata, "$.metadata", context);
  if (root.global_start_time !== null) fail("CUT_OTIO_IMPORT_UNSUPPORTED", "$.global_start_time", "non-zero/global timeline starts are not in the executable subset.");
  const stack = closed(root.tracks, "$.tracks", ["OTIO_SCHEMA", "name", "metadata", "source_range", "effects", "markers", "enabled", "children"]);
  if (stack.OTIO_SCHEMA !== "Stack.1") fail("CUT_OTIO_IMPORT_SCHEMA", "$.tracks.OTIO_SCHEMA", "must be Stack.1.");
  boundedString(stack.name, "$.tracks.name", context); metadataObject(stack.metadata, "$.tracks.metadata", ["ordering"]);
  if (stack.source_range !== null) fail("CUT_OTIO_IMPORT_UNSUPPORTED", "$.tracks.source_range", "stack source ranges are not in the executable subset.");
  emptyArray(stack.effects, "$.tracks.effects"); enabled(stack.enabled, "$.tracks.enabled");
  if (!Array.isArray(stack.markers) || stack.markers.length > context.limits.maxAnnotations) fail("CUT_OTIO_IMPORT_LIMIT", "$.tracks.markers", `must contain at most maxAnnotations (${context.limits.maxAnnotations}).`);
  const annotations = stack.markers.map((marker, index) => parseAnnotation(marker, `$.tracks.markers[${index}]`, context, index));
  const annotationIds = new Set<string>();
  annotations.forEach((annotation, index) => {
    if (annotationIds.has(annotation.id)) fail("CUT_OTIO_IMPORT_UNSUPPORTED", `$.tracks.markers[${index}].metadata.cut.annotation_id`, `duplicates annotation id “${annotation.id}”.`);
    annotationIds.add(annotation.id);
  });
  if (!Array.isArray(stack.children) || stack.children.length > context.limits.maxTracks) fail("CUT_OTIO_IMPORT_LIMIT", "$.tracks.children", `must contain at most ${context.limits.maxTracks} tracks.`);
  const tracks = stack.children.map((track, index) => parseTrack(track, `$.tracks.children[${index}]`, context, index));
  if (metadata.editorialProfile && tracks.length !== metadata.editorialProfile.tracks.length) {
    fail("CUT_OTIO_IMPORT_PROFILE", "$.tracks.children", "track count does not match the declared editorial profile.");
  }
  if (!tracks.length && !metadata.duration) fail("CUT_OTIO_IMPORT_SETTING_REQUIRED", "$.metadata.cut.exact_duration", "is required when an OTIO Stack has no media tracks.");
  let duration = tracks.length ? tracks.reduce((maximum, track) => compareRational(track.duration, maximum) > 0 ? track.duration : maximum, zeroRational) : metadata.duration!;
  if (compareRational(duration, zeroRational) <= 0) fail("CUT_OTIO_IMPORT_TIMING", "$.tracks", "timeline duration must be positive.");
  if (metadata.duration) { if (tracks.length) assertSameTime(duration, metadata.duration, "$.metadata.cut.exact_duration"); duration = metadata.duration; }
  if (metadata.editorialProfile) {
    assertSameTime(duration, metadata.editorialProfile.duration, "$.metadata.cut.editorial_profile.duration");
    const observed: CutOtioEditorialObservation = {
      format: "cut-otio-editorial-observation",
      version: 1,
      compositionId: metadata.editorialProfile.compositionId,
      duration,
      tracks: context.editorialProfile!.observedTracks,
      transitions: context.editorialProfile!.observedTransitions,
    };
    try {
      reconcileCutOtioEditorialProfile(metadata.editorialProfile, observed);
    } catch (error) {
      editorialProfileFailure(error, "$.metadata.cut.editorial_profile");
    }
    if (metadata.editorialProfileNestedExtension) {
      try {
        reconcileCutOtioEditorialProfileV4(
          metadata.editorialProfile,
          metadata.editorialProfileNestedExtension,
          {
            format:
              "cut-otio-editorial-nested-placement-observation",
            version: 1,
            compositionId: metadata.editorialProfile.compositionId,
            baseProfileSemanticSha256:
              metadata.editorialProfile.semanticSha256,
            placements:
              context.editorialProfile!.observedNestedPlacements,
          },
        );
      } catch (error) {
        editorialProfileFailure(
          error,
          "$.metadata.cut.editorial_profile_nested_extension",
        );
      }
    }
    if (metadata.editorialProfileDirectMediaExtension) {
      try {
        reconcileCutOtioEditorialProfileV5(
          metadata.editorialProfile,
          metadata.editorialProfileDirectMediaExtension,
          {
            format: "cut-otio-editorial-direct-media-observation",
            version: 1,
            compositionId: metadata.editorialProfile.compositionId,
            baseProfileSemanticSha256:
              metadata.editorialProfile.semanticSha256,
            authorities:
              context.editorialProfile!.observedDirectMediaAuthorities,
          },
        );
      } catch (error) {
        editorialProfileFailure(
          error,
          "$.metadata.cut.editorial_profile_direct_media_extension",
        );
      }
    }
    if (metadata.editorialProfilePictureTimeMapExtension) {
      try {
        reconcileCutOtioEditorialProfileV6(
          metadata.editorialProfile,
          metadata.editorialProfilePictureTimeMapExtension,
          {
            format: "cut-otio-editorial-picture-time-map-observation",
            version: 1,
            compositionId: metadata.editorialProfile.compositionId,
            baseProfileSemanticSha256:
              metadata.editorialProfile.semanticSha256,
            authorities:
              context.editorialProfile!
                .observedPictureTimeMapAuthorities,
          },
        );
      } catch (error) {
        editorialProfileFailure(
          error,
          "$.metadata.cut.editorial_profile_picture_time_map_extension",
        );
      }
    }
  }
  annotations.forEach((annotation, index) => {
    const end = addRational(annotation.start, annotation.duration);
    if (compareRational(end, duration) > 0) fail("CUT_OTIO_IMPORT_TIMING", `$.tracks.markers[${index}].marked_range`, "extends beyond the timeline duration.");
    if (annotation.sceneId) {
      const scene = metadata.scenes?.find((candidate) => candidate.id === annotation.sceneId);
      if (!scene) fail("CUT_OTIO_IMPORT_UNSUPPORTED", `$.tracks.markers[${index}].metadata.cut.scene_id`, "does not identify a scene in $.metadata.cut.exact_scenes, so CUT cannot preserve annotation ownership.");
      const sceneEnd = addRational(scene.start, scene.duration);
      if (compareRational(annotation.start, scene.start) < 0 || compareRational(end, sceneEnd) > 0) {
        fail("CUT_OTIO_IMPORT_TIMING", `$.tracks.markers[${index}].marked_range`, `falls outside its declared scene “${annotation.sceneId}”.`);
      }
    }
  });
  tracks.forEach((track) => {
    if (track.sceneId && !metadata.scenes?.some((scene) => scene.id === track.sceneId)) {
      fail("CUT_OTIO_IMPORT_UNSUPPORTED", `$.tracks.children[${track.index}].metadata.cut.scene_id`, "does not identify a scene in $.metadata.cut.exact_scenes, so CUT cannot preserve track ownership.");
    }
    track.clips.forEach((clip) => {
      if (track.sceneId && clip.sceneId && track.sceneId !== clip.sceneId) {
        fail("CUT_OTIO_IMPORT_UNSUPPORTED", `$.tracks.children[${track.index}].children[${clip.itemIndex}].metadata.cut.scene_id`, `does not match containing track scene ownership ${JSON.stringify(track.sceneId)}.`);
      }
      const ownerId = clip.sceneId ?? track.sceneId;
      if (!ownerId) return;
      const owner = metadata.scenes?.find((scene) => scene.id === ownerId);
      if (!owner) {
        fail("CUT_OTIO_IMPORT_UNSUPPORTED", `$.tracks.children[${track.index}].children[${clip.itemIndex}].metadata.cut.scene_id`, "does not identify a scene in $.metadata.cut.exact_scenes, so CUT cannot preserve clip ownership.");
      }
      const clipEnd = addRational(clip.start, clip.duration), sceneEnd = addRational(owner.start, owner.duration);
      if (compareRational(clip.start, owner.start) < 0 || compareRational(clipEnd, sceneEnd) > 0) {
        fail("CUT_OTIO_IMPORT_TIMING", `$.tracks.children[${track.index}].children[${clip.itemIndex}]`, `falls outside declared scene ownership ${JSON.stringify(ownerId)}.`);
      }
    });
  });
  for (const track of tracks) if (compareRational(track.duration, duration) < 0) track.implicitTrailingGap = true;
  return { name, metadata, tracks, annotations, duration };
}

function exactInteger(value: Rational, multiplier: Rational, path: string, label: string) {
  if (multiplyRational(value, multiplier).denominator !== "1") fail("CUT_OTIO_IMPORT_TIMING", path, `does not land on an exact ${label} boundary.`);
}

function compareClipStructure(left: ParsedClip[], right: ParsedClip[]) {
  if (left.length !== right.length) return false;
  return left.every((clip, index) => {
    const other = right[index];
    return compareRational(clip.start, other.start) === 0
      && compareRational(clip.duration, other.duration) === 0
      && compareRational(clip.sourceStart, other.sourceStart) === 0
      && clip.locator === other.locator
      && (clip.expectedSha256 ?? null) === (other.expectedSha256 ?? null)
      && clip.linkedId === other.linkedId;
  });
}

function linkedTrackPairs(tracks: ParsedTrack[]) {
  const groups = new Map<string, ParsedTrack[]>();
  for (const track of tracks) {
    const linkedIds = new Set(track.clips.flatMap((clip) => clip.linkedId ? [clip.linkedId] : []));
    if (!linkedIds.size) continue;
    if (linkedIds.size !== 1 || track.clips.some((clip) => clip.linkedId === undefined)) fail("CUT_OTIO_IMPORT_UNSUPPORTED", `$.tracks.children[${track.index}]`, "a linked CUT track must contain only clips from one linked audiovisual node.");
    const id = [...linkedIds][0], group = groups.get(id) ?? []; group.push(track); groups.set(id, group);
  }
  const videoToAudio = new Map<number, number>();
  for (const [id, group] of groups) {
    const video = group.filter((track) => track.kind === "Video"), audio = group.filter((track) => track.kind === "Audio");
    if (group.length !== 2 || video.length !== 1 || audio.length !== 1 || !compareClipStructure(video[0].clips, audio[0].clips)) {
      fail("CUT_OTIO_IMPORT_UNSUPPORTED", "$.tracks", `linked_av_id ${JSON.stringify(id)} does not identify one structurally identical Video/Audio track pair.`);
    }
    if (video[0].clips.some((clip) => clip.resourceKind !== "video" || clip.nodeOp !== "cut.edit.clip")) fail("CUT_OTIO_IMPORT_RESOURCE", `$.tracks.children[${video[0].index}]`, "linked CUT clips must retain cut.edit.clip and video resource metadata.");
    videoToAudio.set(video[0].index, audio[0].index);
  }
  return videoToAudio;
}

function timeKey(value: Rational) { return `${value.numerator}/${value.denominator}`; }
function timeExpression(value: Rational) {
  if (value.numerator === "0") return "0s";
  return value.denominator === "1" ? `${value.numerator}s` : `(${value.numerator}s / ${value.denominator})`;
}
function scalarExpression(value: Rational) { return value.denominator === "1" ? value.numerator : `(${value.numerator} / ${value.denominator})`; }
function editorialMetadataExpression(metadata: Readonly<Record<string, string>>) {
  const entries = Object.entries(metadata)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `editorialMetadataEntry(key: ${JSON.stringify(key)}, value: ${JSON.stringify(value)})`);
  return `editorialMetadata(entries: [${entries.join(", ")}])`;
}
function editorialArguments(value: Readonly<{ role?: string; metadata?: Readonly<Record<string, string>> }>) {
  return `${value.role === undefined ? "" : `, role: ${JSON.stringify(value.role)}`}`
    + `${value.metadata === undefined ? "" : `, metadata: ${editorialMetadataExpression(value.metadata)}`}`;
}

function exactCutIdentifier(value: string, path: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    fail("CUT_OTIO_IMPORT_UNSUPPORTED", path, `CUT-authored identifier ${JSON.stringify(value)} cannot be emitted exactly; identifiers must match /^[A-Za-z_][A-Za-z0-9_]*$/.`);
  }
  return value;
}

const unreferenceableTimelineIdentifiers = new Set(["true", "false", "null", "self", "video", "audio", "image", "font", "data", "render", "seconds"]);
const normalizedIdentifierCollisions = new Set([
  ...unreferenceableTimelineIdentifiers,
  "cut", "project", "import", "asset", "const", "component", "timeline", "scene", "export", "at", "set", "animate", "let", "for", "if", "else", "assert",
]);
function exactTimelineIdentifier(value: string, path: string) {
  exactCutIdentifier(value, path);
  if (unreferenceableTimelineIdentifiers.has(value)) {
    fail("CUT_OTIO_IMPORT_UNSUPPORTED", path, `CUT timeline identifier ${JSON.stringify(value)} cannot be declared and referenced by canonical imported source without colliding with a literal, reserved binding, or implicit core symbol.`);
  }
  return value;
}

function expectedSceneId(timelineId: string, sceneName: string, ordinal: number) {
  return `scene_${hash({ timeline: timelineId, name: sceneName, ordinal }).slice(0, 16)}`;
}

function identifier(value: string, fallback: string) {
  const normalized = value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
  const initial = normalized && /^[A-Za-z_]/.test(normalized) ? normalized : normalized ? `_${normalized}` : fallback;
  const safe = initial.length <= 80 ? initial : `${initial.slice(0, 64)}_${createHash("sha256").update(initial).digest("hex").slice(0, 12)}`;
  return normalizedIdentifierCollisions.has(safe) ? `${safe}_item` : safe;
}

function scenePartition(metadataScenes: ImportedScene[] | undefined, videoTracks: ParsedTrack[], duration: Rational, fps: Rational, context: ImportContext) {
  const boundaries = new Map<string, Rational>([[timeKey(zeroRational), zeroRational], [timeKey(duration), duration]]);
  if (metadataScenes) {
    let cursor = zeroRational;
    for (const [index, scene] of metadataScenes.entries()) {
      if (compareRational(scene.start, cursor) !== 0) fail("CUT_OTIO_IMPORT_TIMING", `$.metadata.cut.exact_scenes[${index}].start`, "scenes must be contiguous and declared in playback order.");
      cursor = addRational(scene.start, scene.duration); boundaries.set(timeKey(scene.start), scene.start); boundaries.set(timeKey(cursor), cursor);
    }
    if (compareRational(cursor, duration) !== 0) fail("CUT_OTIO_IMPORT_TIMING", "$.metadata.cut.exact_scenes", "scenes must cover the exact timeline duration.");
  }
  for (const track of videoTracks) for (const clip of track.clips) {
    boundaries.set(timeKey(clip.start), clip.start);
    const end = addRational(clip.start, clip.duration); boundaries.set(timeKey(end), end);
  }
  const ordered = [...boundaries.values()].sort(compareRational);
  if (ordered.length - 1 > context.limits.maxScenes) fail("CUT_OTIO_IMPORT_LIMIT", "$.tracks", `video boundaries generate more than ${context.limits.maxScenes} scenes.`);
  ordered.forEach((time, index) => exactInteger(time, fps, `$.derived_scene_boundaries[${index}]`, `${fps.numerator}/${fps.denominator} fps frame`));
  const exactScenes = new Map<string, ImportedScene>();
  metadataScenes?.forEach((scene) => exactScenes.set(`${timeKey(scene.start)}\0${timeKey(addRational(scene.start, scene.duration))}`, scene));
  const used = new Map<string, number>();
  const uniqueName = (raw: string, fallback: string) => {
    const base = identifier(raw, fallback), count = (used.get(base) ?? 0) + 1; used.set(base, count); return count === 1 ? base : `${base}_${count}`;
  };
  const partition = ordered.slice(0, -1).map((start, index) => {
    const end = ordered[index + 1], exactScene = exactScenes.get(`${timeKey(start)}\0${timeKey(end)}`);
    const containing = metadataScenes?.find((scene) => compareRational(scene.start, start) <= 0 && compareRational(addRational(scene.start, scene.duration), end) >= 0);
    return {
      name: exactScene?.name ?? uniqueName(containing?.name ?? `segment_${String(index + 1).padStart(3, "0")}`, `segment_${index + 1}`),
      start,
      duration: subtractRational(end, start),
      ...(exactScene ? { authoredId: exactScene.id } : {}),
    };
  });
  if (metadataScenes && (partition.length !== metadataScenes.length || partition.some((scene, index) => {
    const authored = metadataScenes[index];
    return !authored
      || scene.authoredId !== authored.id
      || scene.name !== authored.name
      || compareRational(scene.start, authored.start) !== 0
      || compareRational(scene.duration, authored.duration) !== 0;
  }))) {
    fail("CUT_OTIO_IMPORT_UNSUPPORTED", "$.metadata.cut.exact_scenes", "cannot preserve exact CUT scene IDs and names because executable picture boundaries subdivide the authored scene layout.");
  }
  return partition;
}

function clipAt(track: ParsedTrack, start: Rational, end: Rational) {
  return track.clips.find((clip) => compareRational(clip.start, start) <= 0 && compareRational(addRational(clip.start, clip.duration), end) >= 0);
}

function sceneAt(scenes: Array<{ name: string; start: Rational; duration: Rational }>, time: Rational) {
  return scenes.find((scene) => compareRational(scene.start, time) <= 0 && compareRational(time, addRational(scene.start, scene.duration)) < 0);
}

function profileAuthoringId(value: string, path: string) {
  if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    fail("CUT_OTIO_IMPORT_PROFILE", path, "cannot be emitted as a stable CUT trackId/editId.");
  }
  return value;
}

function ratioExpression(value: Rational) {
  const percent = BigInt(value.numerator) * 100n;
  return value.denominator === "1" ? `${percent}%` : `(${percent}% / ${value.denominator})`;
}

function profileTransitionExpression(transition: CutOtioEditorialTransition) {
  if (transition.mapping.kind === "audio") {
    return `audioCrossfadeAt(at: ${timeExpression(transition.cut)}, duration: ${timeExpression(transition.duration)}, curve: ${JSON.stringify(transition.mapping.curve)})`;
  }
  const style = transition.mapping.style;
  const controls = style.kind === "dip"
    ? `, color: ${style.color}`
    : style.kind === "wipe"
      ? `, direction: ${JSON.stringify(style.direction)}, softness: ${ratioExpression(style.softness)}`
      : style.kind === "push" || style.kind === "slide"
        ? `, direction: ${JSON.stringify(style.direction)}`
        : "";
  return `transitionAt(at: ${timeExpression(transition.cut)}, duration: ${timeExpression(transition.duration)}, kind: ${JSON.stringify(style.kind)}${controls})`;
}

type ProfileClipItem = Extract<CutOtioEditorialTrack["items"][number], { kind: "clip" }>;

type CanonicalLinkedTransitionPair = Readonly<{
  picture: CutOtioEditorialTransition;
  audio: CutOtioEditorialTransition;
  pictureTrack: CutOtioEditorialTrack;
  audioTrack: CutOtioEditorialTrack;
  pictureOutgoing: ProfileClipItem;
  pictureIncoming: ProfileClipItem;
  audioOutgoing: ProfileClipItem;
  audioIncoming: ProfileClipItem;
  outgoingLinkId: string;
  incomingLinkId: string;
  baseCut: Rational;
}>;

type CanonicalLinkedItemOverride = Readonly<{
  destination: Readonly<{ start: Rational; duration: Rational }>;
  source: Readonly<{ start: Rational; duration: Rational }>;
  head: Rational;
  tail: Rational;
}>;

function sameTime(left: Rational, right: Rational) {
  return compareRational(left, right) === 0;
}

function sameTimeInterval(
  left: Readonly<{ start: Rational; duration: Rational }>,
  right: Readonly<{ start: Rational; duration: Rational }>,
) {
  return sameTime(left.start, right.start) && sameTime(left.duration, right.duration);
}

function positivePart(value: Rational) {
  return compareRational(value, zeroRational) > 0 ? value : zeroRational;
}

function canonicalLinkedTransitionPlan(
  profile: CutOtioEditorialProfile,
  linkNames: ReadonlyMap<string, string>,
  settings: { fps: Rational; sampleRate: number },
) {
  const owners = new Map<string, { track: CutOtioEditorialTrack; item: ProfileClipItem }>();
  for (const track of profile.tracks) for (const item of track.items) {
    if (item.kind === "clip") owners.set(item.id, { track, item });
  }
  const segmentByItem = new Map<string, {
    groupId: string;
    segmentId: string;
    pictureItemId: string;
    audioItemId: string;
  }>();
  for (const group of profile.linkGroups) for (const segment of group.segments) {
    const value = { groupId: group.id, segmentId: segment.id, pictureItemId: segment.pictureItemId, audioItemId: segment.audioItemId };
    segmentByItem.set(segment.pictureItemId, value);
    segmentByItem.set(segment.audioItemId, value);
  }

  const usedTransitions = new Set<string>(), usedItems = new Set<string>();
  const pairs: CanonicalLinkedTransitionPair[] = [];
  for (const picture of profile.transitions.filter((transition) => transition.mapping.kind === "picture")) {
    const pictureOutgoingOwner = owners.get(picture.outgoingItemId), pictureIncomingOwner = owners.get(picture.incomingItemId);
    const outgoingSegment = segmentByItem.get(picture.outgoingItemId), incomingSegment = segmentByItem.get(picture.incomingItemId);
    if (!outgoingSegment && !incomingSegment) continue;
    if (!pictureOutgoingOwner || !pictureIncomingOwner
      || pictureOutgoingOwner.track.kind !== "Video" || pictureIncomingOwner.track.id !== pictureOutgoingOwner.track.id
      || !outgoingSegment || !incomingSegment
      || outgoingSegment.pictureItemId !== picture.outgoingItemId
      || incomingSegment.pictureItemId !== picture.incomingItemId) {
      fail("CUT_OTIO_IMPORT_PROFILE", "$.metadata.cut.editorial_profile.transitions", "a linked picture transition has ambiguous or cross-domain item ownership.");
    }
    const candidates = profile.transitions.filter((transition) =>
      transition.mapping.kind === "audio"
        && transition.outgoingItemId === outgoingSegment.audioItemId
        && transition.incomingItemId === incomingSegment.audioItemId);
    if (candidates.length !== 1) {
      fail("CUT_OTIO_IMPORT_PROFILE", "$.metadata.cut.editorial_profile.transitions", "each linked picture transition requires exactly one paired audio transition over the same outgoing/incoming link segments.");
    }
    const audio = candidates[0]!;
    const audioOutgoingOwner = owners.get(audio.outgoingItemId), audioIncomingOwner = owners.get(audio.incomingItemId);
    if (!audioOutgoingOwner || !audioIncomingOwner
      || audioOutgoingOwner.track.kind !== "Audio" || audioIncomingOwner.track.id !== audioOutgoingOwner.track.id) {
      fail("CUT_OTIO_IMPORT_PROFILE", "$.metadata.cut.editorial_profile.transitions", "the paired audio transition has ambiguous item ownership.");
    }
    const items = [
      pictureOutgoingOwner.item,
      pictureIncomingOwner.item,
      audioOutgoingOwner.item,
      audioIncomingOwner.item,
    ];
    if (items.some((item) => item.retime.kind !== "identity")
      || items.some((item) => usedItems.has(item.id))
      || usedTransitions.has(audio.id)) {
      fail("CUT_OTIO_IMPORT_PROFILE", "$.metadata.cut.editorial_profile.transitions", "paired linked transitions must be non-intersecting forward-1x item pairs.");
    }
    const start = pictureOutgoingOwner.item.destination.start;
    const end = addRational(pictureIncomingOwner.item.destination.start, pictureIncomingOwner.item.destination.duration);
    if (!sameTime(start, audioOutgoingOwner.item.destination.start)
      || !sameTime(end, addRational(audioIncomingOwner.item.destination.start, audioIncomingOwner.item.destination.duration))
      || !sameTime(addRational(pictureOutgoingOwner.item.destination.start, pictureOutgoingOwner.item.destination.duration), picture.cut)
      || !sameTime(pictureIncomingOwner.item.destination.start, picture.cut)
      || !sameTime(addRational(audioOutgoingOwner.item.destination.start, audioOutgoingOwner.item.destination.duration), audio.cut)
      || !sameTime(audioIncomingOwner.item.destination.start, audio.cut)
      || items.some((item) => !sameTime(item.destination.duration, item.source.duration))) {
      fail("CUT_OTIO_IMPORT_PROFILE", "$.metadata.cut.editorial_profile.transitions", "paired linked transitions require two exact adjacent forward-1x item pairs with common outer boundaries.");
    }
    const baseCut = divideRational(addRational(picture.cut, audio.cut), rational(2));
    if (compareRational(baseCut, start) <= 0 || compareRational(baseCut, end) >= 0) {
      fail("CUT_OTIO_IMPORT_PROFILE", "$.metadata.cut.editorial_profile.transitions", "paired transition clocks do not admit one strict common pre-edit boundary.");
    }
    exactInteger(baseCut, settings.fps, "$.metadata.cut.editorial_profile.transitions", `${settings.fps.numerator}/${settings.fps.denominator} fps frame`);
    exactInteger(baseCut, rational(settings.sampleRate), "$.metadata.cut.editorial_profile.transitions", `${settings.sampleRate} Hz sample`);
    const halfPicture = divideRational(picture.duration, rational(2)), halfAudio = divideRational(audio.duration, rational(2));
    const expectedTransition = (
      transition: CutOtioEditorialTransition,
      outgoing: ProfileClipItem,
      incoming: ProfileClipItem,
      half: Rational,
    ) => {
      const expectedOverlap = { start: subtractRational(transition.cut, half), duration: transition.duration };
      const expectedOutgoing = { start: addRational(outgoing.source.start, outgoing.source.duration), duration: half };
      const expectedIncoming = { start: subtractRational(incoming.source.start, half), duration: half };
      if (!sameTimeInterval(transition.overlap, expectedOverlap)
        || !sameTimeInterval(transition.outgoingSource, expectedOutgoing)
        || !sameTimeInterval(transition.incomingSource, expectedIncoming)) {
        fail("CUT_OTIO_IMPORT_PROFILE", "$.metadata.cut.editorial_profile.transitions", "paired transition handle receipts do not match the exact materialized item clocks.");
      }
    };
    expectedTransition(picture, pictureOutgoingOwner.item, pictureIncomingOwner.item, halfPicture);
    expectedTransition(audio, audioOutgoingOwner.item, audioIncomingOwner.item, halfAudio);
    const outgoingLinkId = linkNames.get(outgoingSegment.groupId), incomingLinkId = linkNames.get(incomingSegment.groupId);
    if (!outgoingLinkId || !incomingLinkId || outgoingLinkId === incomingLinkId) {
      fail("CUT_OTIO_IMPORT_PROFILE", "$.metadata.cut.editorial_link_names", "paired linked transitions require two distinct authenticated authored link identities.");
    }
    pairs.push({
      picture,
      audio,
      pictureTrack: pictureOutgoingOwner.track,
      audioTrack: audioOutgoingOwner.track,
      pictureOutgoing: pictureOutgoingOwner.item,
      pictureIncoming: pictureIncomingOwner.item,
      audioOutgoing: audioOutgoingOwner.item,
      audioIncoming: audioIncomingOwner.item,
      outgoingLinkId,
      incomingLinkId,
      baseCut,
    });
    usedTransitions.add(picture.id);
    usedTransitions.add(audio.id);
    items.forEach((item) => usedItems.add(item.id));
  }
  for (const transition of profile.transitions) {
    if (usedTransitions.has(transition.id)) continue;
    const outgoing = owners.get(transition.outgoingItemId)?.item, incoming = owners.get(transition.incomingItemId)?.item;
    if ((outgoing && outgoing.link.kind === "linked") || (incoming && incoming.link.kind === "linked")) {
      fail("CUT_OTIO_IMPORT_PROFILE", "$.metadata.cut.editorial_profile.transitions", "linked transition semantics must form one unambiguous paired picture/audio TimelineEdit operation.");
    }
  }

  const overrides = new Map<string, CanonicalLinkedItemOverride>();
  const overridePair = (
    outgoing: ProfileClipItem,
    incoming: ProfileClipItem,
    transition: CutOtioEditorialTransition,
    baseCut: Rational,
  ) => {
    const pairStart = outgoing.destination.start;
    const pairEnd = addRational(incoming.destination.start, incoming.destination.duration);
    const outgoingDuration = subtractRational(baseCut, pairStart);
    const incomingDuration = subtractRational(pairEnd, baseCut);
    const incomingSourceEnd = addRational(incoming.source.start, incoming.source.duration);
    const outgoingSource = { start: outgoing.source.start, duration: outgoingDuration };
    const incomingSource = { start: subtractRational(incomingSourceEnd, incomingDuration), duration: incomingDuration };
    const half = divideRational(transition.duration, rational(2));
    const outgoingTail = positivePart(addRational(subtractRational(transition.cut, baseCut), half));
    const incomingHead = positivePart(addRational(subtractRational(baseCut, transition.cut), half));
    if (compareRational(incomingSource.start, incomingHead) < 0) {
      fail("CUT_OTIO_IMPORT_PROFILE", "$.metadata.cut.editorial_profile.transitions", "reconstructed linked incoming handle would begin before source time zero.");
    }
    overrides.set(outgoing.id, {
      destination: { start: pairStart, duration: outgoingDuration },
      source: outgoingSource,
      head: zeroRational,
      tail: outgoingTail,
    });
    overrides.set(incoming.id, {
      destination: { start: baseCut, duration: incomingDuration },
      source: incomingSource,
      head: incomingHead,
      tail: zeroRational,
    });
  };
  for (const pair of pairs) {
    overridePair(pair.pictureOutgoing, pair.pictureIncoming, pair.picture, pair.baseCut);
    overridePair(pair.audioOutgoing, pair.audioIncoming, pair.audio, pair.baseCut);
  }
  return { pairs, usedTransitions, overrides };
}

function linkedTimelineEditExpression(pair: CanonicalLinkedTransitionPair, index: number) {
  const trackIds = [pair.pictureTrack.id, pair.audioTrack.id];
  const selection = (originIds: string[], linkIds: string[]) =>
    `editSelection(trackIds: ${JSON.stringify(trackIds)}, originIds: ${JSON.stringify(originIds)}, linkIds: ${JSON.stringify(linkIds)})`;
  const at = `avTime(picture: ${timeExpression(pair.picture.cut)}, audio: ${timeExpression(pair.audio.cut)})`;
  const duration = `avTime(picture: ${timeExpression(pair.picture.duration)}, audio: ${timeExpression(pair.audio.duration)})`;
  const style = pair.picture.mapping.kind === "picture" ? pair.picture.mapping.style : undefined;
  const picture = style?.kind === "dip"
    ? `, pictureKind: "dip", pictureColor: ${style.color}`
    : style?.kind === "wipe"
      ? `, pictureKind: "wipe", pictureDirection: ${JSON.stringify(style.direction)}, pictureSoftness: ${ratioExpression(style.softness)}`
      : style?.kind === "push" || style?.kind === "slide"
        ? `, pictureKind: ${JSON.stringify(style.kind)}, pictureDirection: ${JSON.stringify(style.direction)}`
        : `, pictureKind: "cross-dissolve"`;
  if (pair.audio.mapping.kind !== "audio") throw new Error("Canonical linked transition pair lost its audio mapping.");
  return `TimelineEdit(id: ${JSON.stringify(`otio-linked-transition-${index + 1}`)}, operations: [editBoundary(selection: ${selection(
    [pair.pictureOutgoing.id, pair.pictureIncoming.id, pair.audioOutgoing.id, pair.audioIncoming.id],
    [pair.outgoingLinkId, pair.incomingLinkId],
  )}, at: ${at}), editTransition(left: ${selection(
    [pair.pictureOutgoing.id, pair.audioOutgoing.id],
    [pair.outgoingLinkId],
  )}, right: ${selection(
    [pair.pictureIncoming.id, pair.audioIncoming.id],
    [pair.incomingLinkId],
  )}, at: ${at}, duration: ${duration}${picture}, audioCurve: ${JSON.stringify(pair.audio.mapping.curve)})]);`;
}

function linkedSplitProfileShape(profile: CutOtioEditorialProfile) {
  if (profile.linkedCuts.length !== 1 || profile.transitions.length || profile.tracks.length !== 2 || profile.linkGroups.length !== 1) return undefined;
  const cut = profile.linkedCuts[0], group = profile.linkGroups[0];
  if (cut.groupId !== group.id || group.segments.length !== 2) return undefined;
  const owners = new Map(profile.tracks.flatMap((track) => track.items.map((item) => [item.id, { track, item }] as const)));
  const pictureOutgoing = owners.get(cut.picture.outgoingItemId), pictureIncoming = owners.get(cut.picture.incomingItemId);
  const audioOutgoing = owners.get(cut.audio.outgoingItemId), audioIncoming = owners.get(cut.audio.incomingItemId);
  if (!pictureOutgoing || !pictureIncoming || !audioOutgoing || !audioIncoming
    || pictureOutgoing.track.kind !== "Video" || pictureIncoming.track.id !== pictureOutgoing.track.id
    || audioOutgoing.track.kind !== "Audio" || audioIncoming.track.id !== audioOutgoing.track.id
    || pictureOutgoing.item.kind !== "clip" || pictureIncoming.item.kind !== "clip"
    || audioOutgoing.item.kind !== "clip" || audioIncoming.item.kind !== "clip"
    || pictureOutgoing.track.items.length !== 2 || audioOutgoing.track.items.length !== 2) return undefined;
  return {
    cut,
    group,
    pictureOutgoing: pictureOutgoing.item,
    pictureIncoming: pictureIncoming.item,
    audioOutgoing: audioOutgoing.item,
    audioIncoming: audioIncoming.item,
  };
}

function makeLinkedSplitProfileSource(
  timeline: ReturnType<typeof validateTimeline>,
  settings: { project: string; timeline: string; fps: Rational; width: number; height: number; sampleRate: number },
  context: ImportContext,
  shape: NonNullable<ReturnType<typeof linkedSplitProfileShape>>,
) {
  const profile = timeline.metadata.editorialProfile!;
  const scenes = timeline.metadata.scenes;
  if (scenes && (scenes.length !== 1 || compareRational(scenes[0].start, zeroRational) !== 0 || compareRational(scenes[0].duration, timeline.duration) !== 0)) {
    fail("CUT_OTIO_IMPORT_PROFILE", "$.metadata.cut.exact_scenes", "J/L profile import requires one authored scene spanning the exact composition.");
  }
  const scene = scenes?.[0] ?? { id: expectedSceneId(settings.timeline, "only", 0), name: "only", start: zeroRational, duration: timeline.duration };
  const parsed = new Map<string, ParsedClip>();
  timeline.tracks.forEach((track) => track.clips.forEach((clip) => {
    if (!clip.editorialItemId) fail("CUT_OTIO_IMPORT_PROFILE", "$.tracks", "J/L native clip lost its profile item identity.");
    parsed.set(clip.editorialItemId, clip);
  }));
  const pair = (
    picture: typeof shape.pictureOutgoing,
    audio: typeof shape.audioOutgoing,
    label: "outgoing" | "incoming",
  ) => {
    const pictureClip = parsed.get(picture.id), audioClip = parsed.get(audio.id);
    if (!pictureClip || !audioClip) fail("CUT_OTIO_IMPORT_PROFILE", "$.tracks", `native OTIO omits the ${label} J/L segment.`);
    if (pictureClip.locator !== audioClip.locator
      || (pictureClip.expectedSha256 ?? null) !== (audioClip.expectedSha256 ?? null)
      || pictureClip.resourceKind !== "video"
      || audioClip.resourceKind !== "video") {
      fail("CUT_OTIO_IMPORT_PROFILE", "$.tracks", `${label} J/L picture/audio members must retain one identical VideoAsset reference.`);
    }
    const pictureEnd = addRational(picture.source.start, picture.source.duration);
    const audioEnd = addRational(audio.source.start, audio.source.duration);
    const start = compareRational(picture.source.start, audio.source.start) <= 0 ? picture.source.start : audio.source.start;
    const end = compareRational(pictureEnd, audioEnd) >= 0 ? pictureEnd : audioEnd;
    if (label === "outgoing" && compareRational(picture.source.start, audio.source.start) !== 0) {
      fail("CUT_OTIO_IMPORT_PROFILE", "$.metadata.cut.editorial_profile.linkedCuts", "outgoing J/L source members must share their original source start.");
    }
    if (label === "incoming" && compareRational(pictureEnd, audioEnd) !== 0) {
      fail("CUT_OTIO_IMPORT_PROFILE", "$.metadata.cut.editorial_profile.linkedCuts", "incoming J/L source members must share their original source end.");
    }
    return {
      locator: pictureClip.locator,
      expectedSha256: pictureClip.expectedSha256 ?? null,
      source: { start, duration: subtractRational(end, start) },
    };
  };
  const outgoing = pair(shape.pictureOutgoing, shape.audioOutgoing, "outgoing");
  const incoming = pair(shape.pictureIncoming, shape.audioIncoming, "incoming");
  const overlapStart = compareRational(shape.cut.picture.at, shape.cut.audio.at) < 0 ? shape.cut.picture.at : shape.cut.audio.at;
  const overlapEnd = compareRational(shape.cut.picture.at, shape.cut.audio.at) > 0 ? shape.cut.picture.at : shape.cut.audio.at;
  const overlap = subtractRational(overlapEnd, overlapStart);
  if (compareRational(outgoing.source.duration, overlapEnd) !== 0
    || compareRational(incoming.source.duration, subtractRational(profile.duration, overlapStart)) !== 0) {
    fail("CUT_OTIO_IMPORT_PROFILE", "$.metadata.cut.editorial_profile.linkedCuts", "does not map to two exact original overlapping CUT Clip intervals.");
  }
  exactInteger(overlapStart, settings.fps, "$.metadata.cut.editorial_profile.linkedCuts", `${settings.fps.numerator}/${settings.fps.denominator} fps frame`);
  exactInteger(overlapStart, rational(settings.sampleRate), "$.metadata.cut.editorial_profile.linkedCuts", `${settings.sampleRate} Hz sample`);
  exactInteger(overlapEnd, settings.fps, "$.metadata.cut.editorial_profile.linkedCuts", `${settings.fps.numerator}/${settings.fps.denominator} fps frame`);
  exactInteger(overlapEnd, rational(settings.sampleRate), "$.metadata.cut.editorial_profile.linkedCuts", `${settings.sampleRate} Hz sample`);

  const resources = new Map<string, {
    asset: string;
    kind: "video";
    locator: string;
    expectedSha256: string | null;
    constructor: "video";
    assetType: "VideoAsset";
  }>();
  const resourceFor = (segment: typeof outgoing) => {
    let resource = resources.get(segment.locator);
    if (!resource) {
      resource = {
        asset: `video_${String(resources.size + 1).padStart(3, "0")}`,
        kind: "video",
        locator: segment.locator,
        expectedSha256: segment.expectedSha256,
        constructor: "video",
        assetType: "VideoAsset",
      };
      resources.set(segment.locator, resource);
    } else if (resource.expectedSha256 !== segment.expectedSha256) {
      fail("CUT_OTIO_IMPORT_RESOURCE", "$.tracks", "the same J/L asset locator has conflicting SHA-256 metadata.");
    }
    return resource;
  };
  const outgoingAsset = resourceFor(outgoing), incomingAsset = resourceFor(incoming);
  const originalClip = (segment: typeof outgoing, asset: typeof outgoingAsset) =>
    `Clip(source: ${asset.asset}, range: ${timeExpression(segment.source.start)} ..< ${timeExpression(addRational(segment.source.start, segment.source.duration))}, duration: ${timeExpression(segment.source.duration)});`;
  const splitName = shape.cut.kind === "j-cut" ? "JCut" : "LCut";
  const split = `${splitName}(overlap: ${timeExpression(overlap)}) {\n      at 0s { ${originalClip(outgoing, outgoingAsset)} }\n      at ${timeExpression(overlapStart)} { ${originalClip(incoming, incomingAsset)} }\n    }`;

  const annotationStatement = (annotation: ParsedAnnotation, start: Rational) => {
    const common = `id: ${JSON.stringify(annotation.id)}, name: ${JSON.stringify(annotation.name)}, color: ${annotation.color}, role: ${JSON.stringify(annotation.role)}, comment: ${JSON.stringify(annotation.comment)}, grid: ${JSON.stringify(annotation.grid)}`;
    return annotation.kind === "marker"
      ? `Marker(${common}, at: ${timeExpression(start)});`
      : `Region(${common}, range: ${timeExpression(start)} ..< ${timeExpression(addRational(start, annotation.duration))});`;
  };
  const timelineAnnotations: string[] = [], sceneAnnotations: string[] = [];
  timeline.annotations.forEach((annotation, index) => {
    if (annotation.sceneId && annotation.sceneId !== scene.id) fail("CUT_OTIO_IMPORT_PROFILE", `$.tracks.markers[${index}]`, "does not belong to the one J/L profile scene.");
    (annotation.sceneId ? sceneAnnotations : timelineAnnotations).push(
      annotationStatement(annotation, annotation.sceneId ? subtractRational(annotation.start, scene.start) : annotation.start),
    );
  });
  const imports = new Set(["Clip", splitName]);
  if (timeline.annotations.some((annotation) => annotation.kind === "marker")) imports.add("Marker");
  if (timeline.annotations.some((annotation) => annotation.kind === "region")) imports.add("Region");
  const importLine = `import { ${[...imports].sort().join(", ")} } from "@cut/edit";`;
  const resourceList = [...resources.values()];
  const assets = resourceList.map((resource) => `asset ${resource.asset}: VideoAsset = video(${JSON.stringify(resource.locator)});`).join("\n");
  const sceneBody = [...sceneAnnotations, split].map((line) => `    ${line}`).join("\n");
  const timelineBody = [
    ...timelineAnnotations.map((line) => `  ${line}`),
    `  scene ${scene.name}(duration: ${timeExpression(scene.duration)}) {\n${sceneBody}\n  }`,
  ].join("\n");
  const source = `cut 0.4;\nproject ${JSON.stringify(settings.project)};\n\n${importLine}\n\n${assets}\n\ntimeline ${settings.timeline}(duration: ${timeExpression(timeline.duration)}, fps: ${scalarExpression(settings.fps)}, width: ${settings.width}px, height: ${settings.height}px, sampleRate: ${settings.sampleRate}hz) {\n${timelineBody}\n}\n\nexport out = render(${settings.timeline}, width: ${settings.width}px, height: ${settings.height}px, codec: "h264");\n`;
  if (Buffer.byteLength(source, "utf8") > context.limits.maxInputBytes) fail("CUT_OTIO_IMPORT_LIMIT", "$.output", "generated CUT source exceeds maxInputBytes.");
  return {
    source,
    scenes: [scene],
    resources: resourceList.map(({ asset, kind, locator, expectedSha256 }) => ({ asset, kind, locator, expectedSha256 })),
    generatedNodes: 3,
    segmentedVideoClips: 0,
    linkedPairs: 2,
    markers: timeline.annotations.filter((annotation) => annotation.kind === "marker").length,
    regions: timeline.annotations.filter((annotation) => annotation.kind === "region").length,
  };
}

function makeEditorialProfileSource(
  timeline: ReturnType<typeof validateTimeline>,
  settings: { project: string; timeline: string; fps: Rational; width: number; height: number; sampleRate: number },
  context: ImportContext,
) {
  const profile = timeline.metadata.editorialProfile;
  if (!profile || !context.editorialProfile) throw new Error("Profile source builder requires validated editorial profile state.");
  const linkedSplit = linkedSplitProfileShape(profile);
  if (linkedSplit) return makeLinkedSplitProfileSource(timeline, settings, context, linkedSplit);
  const authoredScenes = timeline.metadata.scenes;
  if (authoredScenes && (authoredScenes.length !== 1
    || compareRational(authoredScenes[0].start, zeroRational) !== 0
    || compareRational(authoredScenes[0].duration, timeline.duration) !== 0)) {
    fail("CUT_OTIO_IMPORT_PROFILE", "$.metadata.cut.exact_scenes", "profile import requires one authored scene spanning the exact composition.");
  }
  const scene = authoredScenes?.[0] ?? {
    id: expectedSceneId(settings.timeline, "only", 0),
    name: "only",
    start: zeroRational,
    duration: timeline.duration,
  };
  exactInteger(timeline.duration, settings.fps, "$.metadata.cut.editorial_profile.duration", `${settings.fps.numerator}/${settings.fps.denominator} fps frame`);
  exactInteger(timeline.duration, rational(settings.sampleRate), "$.metadata.cut.editorial_profile.duration", `${settings.sampleRate} Hz sample`);

  const clipsByItemId = new Map<string, ParsedClip>();
  timeline.tracks.forEach((track) => track.clips.forEach((clip) => {
    if (!clip.editorialItemId) fail("CUT_OTIO_IMPORT_PROFILE", `$.tracks.children[${track.index}].children[${clip.itemIndex}]`, "lost its editorial item identity.");
    if (clipsByItemId.has(clip.editorialItemId)) fail("CUT_OTIO_IMPORT_PROFILE", "$.tracks", "duplicates a native editorial clip identity.");
    clipsByItemId.set(clip.editorialItemId, clip);
  }));

  type ResourceState = CutOtioImportResource & {
    constructor: "video" | "audio";
    assetType: "VideoAsset" | "AudioAsset";
  };
  const resources = new Map<string, ResourceState>(), itemAssets = new Map<string, ResourceState>();
  const counters = { video: 0, audio: 0 };
  const usedNames = new Set([settings.timeline]);
  for (const track of profile.tracks) for (const item of track.items) {
    if (item.kind !== "clip") continue;
    const clip = clipsByItemId.get(item.id);
    if (!clip) fail("CUT_OTIO_IMPORT_PROFILE", "$.tracks", `native OTIO omits declared clip ${JSON.stringify(item.id)}.`);
    const kind = track.kind === "Video" ? "video" : "audio";
    if (clip.resourceKind && clip.resourceKind !== kind) {
      fail("CUT_OTIO_IMPORT_RESOURCE", `$.tracks.children[${clip.trackIndex}].children[${clip.itemIndex}]`, `profile ${track.kind} clip must reference ${kind} media.`);
    }
    const authorityResourceId = clip.directMediaAuthority?.resource.id
      ?? clip.pictureTimeMapAuthority?.resource.id;
    const key = `${kind}\0${clip.locator}`;
    let resource = resources.get(key);
    if (!resource) {
      if (resources.size >= context.limits.maxResources) fail("CUT_OTIO_IMPORT_LIMIT", "$.tracks", `resource count exceeds maxResources (${context.limits.maxResources}).`);
      let asset: string;
      if (authorityResourceId !== undefined) {
        asset = exactCutIdentifier(
          authorityResourceId,
          `$.tracks.children[${clip.trackIndex}].children[${clip.itemIndex}].metadata.cut.direct_media_authority.resource.id`,
        );
        if (usedNames.has(asset)) {
          fail(
            "CUT_OTIO_IMPORT_PROFILE",
            `$.tracks.children[${clip.trackIndex}].children[${clip.itemIndex}].metadata.cut.direct_media_authority.resource.id`,
            "collides with another imported top-level CUT identifier.",
          );
        }
      } else {
        do {
          counters[kind] += 1;
          asset = `${kind}_${String(counters[kind]).padStart(3, "0")}`;
        } while (usedNames.has(asset));
      }
      usedNames.add(asset);
      resource = {
        asset,
        kind,
        locator: clip.locator,
        expectedSha256: clip.expectedSha256 ?? null,
        constructor: kind,
        assetType: kind === "video" ? "VideoAsset" : "AudioAsset",
      };
      resources.set(key, resource);
    } else if (resource.expectedSha256 && clip.expectedSha256 && resource.expectedSha256 !== clip.expectedSha256) {
      fail("CUT_OTIO_IMPORT_RESOURCE", `$.tracks.children[${clip.trackIndex}].children[${clip.itemIndex}]`, "the same asset locator has conflicting SHA-256 metadata.");
    } else if (authorityResourceId !== undefined
      && authorityResourceId !== resource.asset) {
      fail(
        "CUT_OTIO_IMPORT_PROFILE",
        `$.tracks.children[${clip.trackIndex}].children[${clip.itemIndex}].metadata.cut.direct_media_authority.resource.id`,
        "does not match the exact V5/V6 resource identity already assigned to this locator.",
      );
    }
    itemAssets.set(item.id, resource);
  }

  const linkNames = context.editorialProfile.linkNames;
  for (const group of profile.linkGroups) {
    if (!linkNames.has(group.id)) fail("CUT_OTIO_IMPORT_PROFILE", "$.metadata.cut.editorial_link_names", `omits link group ${JSON.stringify(group.id)}.`);
  }
  if (profile.linkedCuts.length) {
    fail("CUT_OTIO_IMPORT_PROFILE", "$.metadata.cut.editorial_profile.linkedCuts", "linked J/L cuts require the dedicated J/L native profile shape.");
  }
  const linkedTransitionPlan = canonicalLinkedTransitionPlan(profile, linkNames, settings);

  const handles = new Map<string, { head?: Rational; tail?: Rational }>();
  profile.transitions.forEach((transition) => {
    if (linkedTransitionPlan.usedTransitions.has(transition.id)) return;
    const outgoing = handles.get(transition.outgoingItemId) ?? {};
    if (outgoing.tail) fail("CUT_OTIO_IMPORT_PROFILE", "$.metadata.cut.editorial_profile.transitions", "declares multiple outgoing handles for one item.");
    outgoing.tail = transition.outgoingSource.duration;
    handles.set(transition.outgoingItemId, outgoing);
    const incoming = handles.get(transition.incomingItemId) ?? {};
    if (incoming.head) fail("CUT_OTIO_IMPORT_PROFILE", "$.metadata.cut.editorial_profile.transitions", "declares multiple incoming handles for one item.");
    incoming.head = transition.incomingSource.duration;
    handles.set(transition.incomingItemId, incoming);
  });
  for (const authority of
    timeline.metadata.editorialProfileDirectMediaExtension?.authorities ?? []) {
    handles.set(authority.itemId, {
      ...(compareRational(
        authority.declaredHandles.head,
        zeroRational,
      ) > 0
        ? { head: authority.declaredHandles.head }
        : {}),
      ...(compareRational(
        authority.declaredHandles.tail,
        zeroRational,
      ) > 0
        ? { tail: authority.declaredHandles.tail }
        : {}),
    });
  }
  const linkArgument = (item: Extract<CutOtioEditorialTrack["items"][number], { kind: "clip" }>) =>
    item.link.kind === "linked" ? `, link: ${JSON.stringify(linkNames.get(item.link.groupId))}` : "";
  const handleArguments = (itemId: string) => {
    const declared = handles.get(itemId);
    if (timeline.metadata.editorialProfileDirectMediaExtension?.authorities
      .some((authority) => authority.itemId === itemId)) {
      return `${declared?.head ? `, headHandle: ${timeExpression(declared.head)}` : ""}${declared?.tail ? `, tailHandle: ${timeExpression(declared.tail)}` : ""}`;
    }
    const override = linkedTransitionPlan.overrides.get(itemId);
    if (override) {
      return `${compareRational(override.head, zeroRational) > 0 ? `, headHandle: ${timeExpression(override.head)}` : ""}${compareRational(override.tail, zeroRational) > 0 ? `, tailHandle: ${timeExpression(override.tail)}` : ""}`;
    }
    return `${declared?.head ? `, headHandle: ${timeExpression(declared.head)}` : ""}${declared?.tail ? `, tailHandle: ${timeExpression(declared.tail)}` : ""}`;
  };
  const pictureTimeMapArguments = (itemId: string) => {
    const authority = timeline.metadata
      .editorialProfilePictureTimeMapExtension?.authorities.find(
        (candidate) => candidate.itemId === itemId,
      );
    if (!authority) return undefined;
    const map = authority.timeMap;
    const frameSelection = "frameSelection" in map
      && map.frameSelection !== undefined
      && map.frameSelection !== "floor"
      ? `, frameSelection: ${JSON.stringify(map.frameSelection)}`
      : "";
    if (map.kind === "constant") {
      const playback = map.direction === "reverse"
        ? ', playback: "reverse"'
        : "";
      const rate = compareRational(map.rate, rational(1)) === 0
        ? ""
        : `, rate: ${scalarExpression(map.rate)}`;
      return `${playback}${rate}${frameSelection}`;
    }
    if (map.kind === "freeze") {
      return `, playback: "freeze", freezeAt: ${timeExpression(map.at)}${frameSelection}`;
    }
    return `, speedRamp: [${map.points.map((point) =>
      `speedPoint(at: ${timeExpression(point.at)}, rate: ${scalarExpression(point.rate)})`).join(", ")}]${frameSelection}`;
  };

  const trackStatements: string[] = [];
  for (const track of profile.tracks) {
    profileAuthoringId(track.id, `$.metadata.cut.editorial_profile.tracks[${track.order}].id`);
    const transitions = profile.transitions.filter((transition) =>
      transition.trackId === track.id && !linkedTransitionPlan.usedTransitions.has(transition.id));
    const edits = transitions.length
      ? `sourceDuration: ${timeExpression(profile.duration)}, edits: [${transitions.map(profileTransitionExpression).join(", ")}], `
      : "";
    if (track.kind === "Video") {
      const items = track.items.map((item) => {
        if (item.kind === "gap" || item.kind === "nested-sequence") {
          return `Gap(duration: ${timeExpression(item.destination.duration)});`;
        }
        const asset = itemAssets.get(item.id);
        if (!asset) throw new Error(`Profile item ${item.id} lost its imported asset.`);
        profileAuthoringId(item.id, `$.metadata.cut.editorial_profile.tracks[${track.order}].items[${item.order}].id`);
        const override = linkedTransitionPlan.overrides.get(item.id);
        const source = override?.source ?? item.source, destination = override?.destination ?? item.destination;
        const sourceEnd = addRational(source.start, source.duration);
        const retime = pictureTimeMapArguments(item.id)
          ?? (item.retime.kind === "identity"
            ? ""
            : `, playback: ${JSON.stringify(item.retime.direction === "reverse" ? "reverse" : "normal")}, rate: ${scalarExpression(item.retime.rate)}`);
        return `PictureClip(source: ${asset.asset}, range: ${timeExpression(source.start)} ..< ${timeExpression(sourceEnd)}, duration: ${timeExpression(destination.duration)}${handleArguments(item.id)}${retime}${linkArgument(item)}, editId: ${JSON.stringify(item.id)}${editorialArguments(item)});`;
      });
      trackStatements.push(`Sequence(duration: ${timeExpression(profile.duration)}) {\n      PictureTrack(${edits}trackId: ${JSON.stringify(track.id)}${editorialArguments(track)}) {\n${items.map((item) => `        ${item}`).join("\n")}\n      }\n    }`);
    } else {
      const items = track.items.map((item) => {
        if (item.kind === "gap") {
          return `AudioGap(destination: ${timeExpression(item.destination.start)} ..< ${timeExpression(addRational(item.destination.start, item.destination.duration))});`;
        }
        if (item.kind === "nested-sequence") fail("CUT_OTIO_IMPORT_PROFILE", "$.metadata.cut.editorial_profile", "nested sequences cannot appear on Audio tracks.");
        const asset = itemAssets.get(item.id);
        if (!asset) throw new Error(`Profile item ${item.id} lost its imported asset.`);
        profileAuthoringId(item.id, `$.metadata.cut.editorial_profile.tracks[${track.order}].items[${item.order}].id`);
        const override = linkedTransitionPlan.overrides.get(item.id);
        const source = override?.source ?? item.source, destination = override?.destination ?? item.destination;
        const sourceEnd = addRational(source.start, source.duration);
        const destinationEnd = addRational(destination.start, destination.duration);
        if (item.retime.kind === "constant") {
          if (item.retime.direction !== "forward") {
            fail(
              "CUT_OTIO_IMPORT_PROFILE",
              `$.metadata.cut.editorial_profile.tracks[${track.order}].items[${item.order}].retime`,
              "reverse constant audio retime has no executable CUT AudioRegion reconstruction.",
            );
          }
          return `AudioRegion(destination: ${timeExpression(destination.start)} ..< ${timeExpression(destinationEnd)}${handleArguments(item.id)}${linkArgument(item)}, editId: ${JSON.stringify(item.id)}${editorialArguments(item)}) {\n        TimeStretch(sourceDuration: ${timeExpression(source.duration)}, duration: ${timeExpression(destination.duration)}, pitch: 0, quality: "draft") {\n          AudioClip(source: ${asset.asset}, range: ${timeExpression(source.start)} ..< ${timeExpression(sourceEnd)});\n        }\n      }`;
        }
        return `AudioClip(source: ${asset.asset}, range: ${timeExpression(source.start)} ..< ${timeExpression(sourceEnd)}, destination: ${timeExpression(destination.start)} ..< ${timeExpression(destinationEnd)}${handleArguments(item.id)}${linkArgument(item)}, editId: ${JSON.stringify(item.id)}${editorialArguments(item)});`;
      });
      trackStatements.push(`AudioTrack(${edits}trackId: ${JSON.stringify(track.id)}${editorialArguments(track)}) {\n${items.map((item) => `      ${item}`).join("\n")}\n    }`);
    }
  }

  const annotationStatement = (annotation: ParsedAnnotation, start: Rational) => {
    const common = `id: ${JSON.stringify(annotation.id)}, name: ${JSON.stringify(annotation.name)}, color: ${annotation.color}, role: ${JSON.stringify(annotation.role)}, comment: ${JSON.stringify(annotation.comment)}, grid: ${JSON.stringify(annotation.grid)}`;
    return annotation.kind === "marker"
      ? `Marker(${common}, at: ${timeExpression(start)});`
      : `Region(${common}, range: ${timeExpression(start)} ..< ${timeExpression(addRational(start, annotation.duration))});`;
  };
  const timelineAnnotations: string[] = [], sceneAnnotations: string[] = [];
  timeline.annotations.forEach((annotation, index) => {
    if (annotation.sceneId && annotation.sceneId !== scene.id) {
      fail("CUT_OTIO_IMPORT_PROFILE", `$.tracks.markers[${index}].metadata.cut.scene_id`, "does not match the one profiled scene.");
    }
    (annotation.sceneId ? sceneAnnotations : timelineAnnotations).push(
      annotationStatement(annotation, annotation.sceneId ? subtractRational(annotation.start, scene.start) : annotation.start),
    );
  });

  const editImports = new Set<string>();
  const videoTracks = profile.tracks.filter((track) => track.kind === "Video");
  const audioTracks = profile.tracks.filter((track) => track.kind === "Audio");
  if (videoTracks.length) {
    editImports.add("Sequence");
    editImports.add("PictureTrack");
  }
  if (videoTracks.some((track) => track.items.some((item) => item.kind === "clip"))) {
    editImports.add("PictureClip");
  }
  if (timeline.metadata.editorialProfilePictureTimeMapExtension?.authorities
    .some((authority) => authority.timeMap.kind === "speed-ramp")) {
    editImports.add("speedPoint");
  }
  if (videoTracks.some((track) => track.items.some((item) =>
    item.kind === "gap" || item.kind === "nested-sequence"))) {
    editImports.add("Gap");
  }
  if (audioTracks.length) editImports.add("AudioTrack");
  if (audioTracks.some((track) => track.items.some((item) => item.kind === "gap"))) {
    editImports.add("AudioGap");
  }
  const hasRetimedAudio = audioTracks.some((track) => track.items.some((item) =>
    item.kind === "clip" && item.retime.kind === "constant"));
  if (hasRetimedAudio) editImports.add("AudioRegion");
  if (profile.tracks.some((track) => track.metadata !== undefined
    || track.items.some((item) => item.kind === "clip" && item.metadata !== undefined))) {
    editImports.add("editorialMetadata");
    editImports.add("editorialMetadataEntry");
  }
  if (profile.tracks.some((track) => track.kind === "Audio" && track.items.some((item) => item.kind === "clip"))) editImports.add("AudioClip");
  if (profile.transitions.some((transition) =>
    transition.mapping.kind === "picture" && !linkedTransitionPlan.usedTransitions.has(transition.id))) editImports.add("transitionAt");
  if (profile.transitions.some((transition) =>
    transition.mapping.kind === "audio" && !linkedTransitionPlan.usedTransitions.has(transition.id))) editImports.add("audioCrossfadeAt");
  if (linkedTransitionPlan.pairs.length) {
    for (const name of ["TimelineEdit", "editBoundary", "editSelection", "editTransition", "avTime"]) editImports.add(name);
  }
  if (timeline.annotations.some((annotation) => annotation.kind === "marker")) editImports.add("Marker");
  if (timeline.annotations.some((annotation) => annotation.kind === "region")) editImports.add("Region");
  const audioClip = editImports.delete("AudioClip");
  const audioImports = [
    audioClip ? "AudioClip" : "",
    hasRetimedAudio ? "TimeStretch" : "",
  ].filter(Boolean);
  const imports = [
    editImports.size ? `import { ${[...editImports].sort().join(", ")} } from "@cut/edit";` : "",
    audioImports.length ? `import { ${audioImports.join(", ")} } from "@cut/audio";` : "",
  ].filter(Boolean).join("\n");
  const resourceList = [...resources.values()];
  const assets = resourceList.map((resource) =>
    `asset ${resource.asset}: ${resource.assetType} = ${resource.constructor}(${JSON.stringify(resource.locator)});`).join("\n");
  const linkedTransitionStatements = linkedTransitionPlan.pairs.map(linkedTimelineEditExpression);
  const sceneBody = [...sceneAnnotations, ...trackStatements, ...linkedTransitionStatements].map((line) => `    ${line}`).join("\n");
  const timelineBody = [
    ...timelineAnnotations.map((line) => `  ${line}`),
    `  scene ${scene.name}(duration: ${timeExpression(scene.duration)}) {\n${sceneBody}\n  }`,
  ].join("\n");
  const source = `cut 0.4;\nproject ${JSON.stringify(settings.project)};\n\n${imports}${imports ? "\n\n" : ""}${assets}${assets ? "\n\n" : ""}timeline ${settings.timeline}(duration: ${timeExpression(timeline.duration)}, fps: ${scalarExpression(settings.fps)}, width: ${settings.width}px, height: ${settings.height}px, sampleRate: ${settings.sampleRate}hz) {\n${timelineBody}\n}\n\nexport out = render(${settings.timeline}, width: ${settings.width}px, height: ${settings.height}px, codec: "h264");\n`;
  if (Buffer.byteLength(source, "utf8") > context.limits.maxInputBytes) fail("CUT_OTIO_IMPORT_LIMIT", "$.output", "generated CUT source exceeds maxInputBytes.");
  const nestedLosses = profile.tracks.reduce((total, track) => total + track.items.filter((item) => item.kind === "nested-sequence").length, 0);
  return {
    source,
    scenes: [scene],
    resources: resourceList.map(({ asset, kind, locator, expectedSha256 }) => ({ asset, kind, locator, expectedSha256 })),
    generatedNodes: profile.tracks.reduce((total, track) =>
      total + track.items.length + 1 + track.items.filter((item) =>
        track.kind === "Audio" && item.kind === "clip" && item.retime.kind === "constant").length * 2, 0)
      + linkedTransitionPlan.pairs.length,
    segmentedVideoClips: 0,
    linkedPairs: profile.linkGroups.reduce((total, group) => total + group.segments.length, 0),
    markers: timeline.annotations.filter((annotation) => annotation.kind === "marker").length,
    regions: timeline.annotations.filter((annotation) => annotation.kind === "region").length,
    nestedLosses,
  };
}

function makeSource(timeline: ReturnType<typeof validateTimeline>, settings: { project: string; timeline: string; fps: Rational; width: number; height: number; sampleRate: number }, context: ImportContext) {
  const pairs = linkedTrackPairs(timeline.tracks), pairedAudio = new Set(pairs.values());
  const videoTracks = timeline.tracks.filter((track) => track.kind === "Video"), audioTracks = timeline.tracks.filter((track) => track.kind === "Audio" && !pairedAudio.has(track.index));
  const scenes = scenePartition(timeline.metadata.scenes, videoTracks, timeline.duration, settings.fps, context);
  const usedTopLevelNames = new Set([settings.timeline]);
  const importedLocalNames = new Map<string, string>();
  const localSymbol = (authored: string) => {
    const existing = importedLocalNames.get(authored);
    if (existing) return existing;
    let candidate = authored, suffix = 0;
    while (usedTopLevelNames.has(candidate)) {
      suffix += 1;
      candidate = `Cut${authored}${suffix === 1 ? "" : suffix}`;
    }
    usedTopLevelNames.add(candidate);
    importedLocalNames.set(authored, candidate);
    return candidate;
  };
  exactInteger(timeline.duration, settings.fps, "$.duration", `${settings.fps.numerator}/${settings.fps.denominator} fps frame`);
  exactInteger(timeline.duration, rational(settings.sampleRate), "$.duration", `${settings.sampleRate} Hz sample`);
  const annotations = timeline.annotations.map((annotation, index) => {
    const boundaries = annotation.kind === "marker" ? [annotation.start] : [annotation.start, addRational(annotation.start, annotation.duration)];
    const landsOn = (grid: EditorialAnnotationGrid) => {
      const rate = grid === "frame" ? settings.fps : rational(settings.sampleRate);
      return boundaries.every((boundary) => multiplyRational(boundary, rate).denominator === "1");
    };
    const grid = annotation.grid ?? (landsOn("frame") ? "frame" : landsOn("sample") ? "sample" : undefined);
    if (!grid) fail("CUT_OTIO_IMPORT_TIMING", `$.tracks.markers[${index}].marked_range`, "does not land exactly on either the timeline frame grid or audio sample grid.");
    if (!landsOn(grid)) fail("CUT_OTIO_IMPORT_TIMING", `$.tracks.markers[${index}].marked_range`, `does not land on its authored ${grid} grid.`);
    return { ...annotation, grid };
  });

  type ResourceState = CutOtioImportResource & { constructor: "video" | "audio" | "image"; assetType: "VideoAsset" | "AudioAsset" | "ImageAsset" };
  const resources = new Map<string, ResourceState>(), counters = { video: 0, audio: 0, image: 0 };
  const resourceForClip = (kind: "video" | "audio" | "image", clip: ParsedClip) => {
    const key = `${kind}\0${clip.locator}`, existing = resources.get(key);
    if (existing) {
      if (existing.expectedSha256 && clip.expectedSha256 && existing.expectedSha256 !== clip.expectedSha256) fail("CUT_OTIO_IMPORT_RESOURCE", `$.tracks.children[${clip.trackIndex}].children[${clip.itemIndex}]`, "the same asset locator has conflicting SHA-256 metadata.");
      if (!existing.expectedSha256 && clip.expectedSha256) existing.expectedSha256 = clip.expectedSha256;
      return existing;
    }
    if (resources.size >= context.limits.maxResources) fail("CUT_OTIO_IMPORT_LIMIT", "$.tracks", `resource count exceeds maxResources (${context.limits.maxResources}).`);
    let asset: string;
    do {
      counters[kind] += 1;
      asset = `${kind}_${String(counters[kind]).padStart(3, "0")}`;
    } while (usedTopLevelNames.has(asset));
    usedTopLevelNames.add(asset);
    const state: ResourceState = { asset, kind, locator: clip.locator, expectedSha256: clip.expectedSha256 ?? null, constructor: kind, assetType: kind === "video" ? "VideoAsset" : kind === "audio" ? "AudioAsset" : "ImageAsset" };
    resources.set(key, state); return state;
  };

  const sceneLines = new Map<string, string[]>(scenes.map((scene) => [scene.name, []]));
  let generatedNodes = 0, segmentedVideoClips = 0;
  for (const scene of scenes) {
    const end = addRational(scene.start, scene.duration), lines = sceneLines.get(scene.name)!;
    for (const track of videoTracks) {
      const clip = clipAt(track, scene.start, end); if (!clip) continue;
      const originalEnd = addRational(clip.start, clip.duration), isSegment = compareRational(clip.start, scene.start) !== 0 || compareRational(originalEnd, end) !== 0;
      if (isSegment) segmentedVideoClips += 1;
      const offset = subtractRational(scene.start, clip.start), sourceStart = addRational(clip.sourceStart, offset), sourceEnd = addRational(sourceStart, scene.duration);
      let statement: string;
      if (pairs.has(track.index)) {
        exactInteger(scene.start, rational(settings.sampleRate), `$.tracks.children[${track.index}]`, `${settings.sampleRate} Hz sample`);
        exactInteger(scene.duration, rational(settings.sampleRate), `$.tracks.children[${track.index}]`, `${settings.sampleRate} Hz sample`);
        exactInteger(sourceStart, settings.fps, `$.tracks.children[${track.index}]`, `${settings.fps.numerator}/${settings.fps.denominator} fps frame`);
        exactInteger(sourceStart, rational(settings.sampleRate), `$.tracks.children[${track.index}]`, `${settings.sampleRate} Hz sample`);
        exactInteger(sourceEnd, settings.fps, `$.tracks.children[${track.index}]`, `${settings.fps.numerator}/${settings.fps.denominator} fps frame`);
        exactInteger(sourceEnd, rational(settings.sampleRate), `$.tracks.children[${track.index}]`, `${settings.sampleRate} Hz sample`);
        const asset = resourceForClip("video", clip); statement = `${localSymbol("Clip")}(source: ${asset.asset}, range: ${timeExpression(sourceStart)} ..< ${timeExpression(sourceEnd)}, duration: ${timeExpression(scene.duration)});`;
      } else if (clip.resourceKind === "image" || clip.nodeOp === "cut.visual.image") {
        if (compareRational(clip.sourceStart, zeroRational) !== 0) fail("CUT_OTIO_IMPORT_TIMING", `$.tracks.children[${track.index}].children[${clip.itemIndex}]`, "image clips must start at source time zero.");
        const asset = resourceForClip("image", clip); statement = `${localSymbol("Image")}(source: ${asset.asset});`;
      } else {
        if (clip.resourceKind && clip.resourceKind !== "video") fail("CUT_OTIO_IMPORT_RESOURCE", `$.tracks.children[${track.index}].children[${clip.itemIndex}]`, "a Video track clip must reference video or image media.");
        const asset = resourceForClip("video", clip); statement = `${localSymbol("Video")}(source: ${asset.asset}, range: ${timeExpression(sourceStart)} ..< ${timeExpression(sourceEnd)});`;
      }
      lines.push(statement); generatedNodes += 1;
    }
  }

  for (const track of audioTracks) for (const clip of track.clips) {
    if (clip.resourceKind && clip.resourceKind !== "audio") fail("CUT_OTIO_IMPORT_RESOURCE", `$.tracks.children[${track.index}].children[${clip.itemIndex}]`, "an independent Audio track clip must reference audio media.");
    const end = addRational(clip.start, clip.duration), sourceEnd = addRational(clip.sourceStart, clip.duration);
    exactInteger(clip.start, rational(settings.sampleRate), `$.tracks.children[${track.index}].children[${clip.itemIndex}]`, `${settings.sampleRate} Hz sample`);
    exactInteger(end, rational(settings.sampleRate), `$.tracks.children[${track.index}].children[${clip.itemIndex}]`, `${settings.sampleRate} Hz sample`);
    exactInteger(clip.sourceStart, rational(settings.sampleRate), `$.tracks.children[${track.index}].children[${clip.itemIndex}]`, `${settings.sampleRate} Hz sample`);
    exactInteger(sourceEnd, rational(settings.sampleRate), `$.tracks.children[${track.index}].children[${clip.itemIndex}]`, `${settings.sampleRate} Hz sample`);
    const scene = sceneAt(scenes, clip.start); if (!scene) fail("CUT_OTIO_IMPORT_TIMING", `$.tracks.children[${track.index}].children[${clip.itemIndex}]`, "clip starts outside the generated CUT scene partition.");
    const local = subtractRational(clip.start, scene.start), asset = resourceForClip("audio", clip);
    const component = clip.nodeOp === "cut.documentary.narration" ? "Narration" : "AudioClip";
    const statement = `${localSymbol(component)}(source: ${asset.asset}, range: ${timeExpression(clip.sourceStart)} ..< ${timeExpression(sourceEnd)});`;
    sceneLines.get(scene.name)!.push(compareRational(local, zeroRational) === 0 ? statement : `at ${timeExpression(local)} { ${statement} }`); generatedNodes += 1;
  }
  if (generatedNodes > context.limits.maxGeneratedNodes) fail("CUT_OTIO_IMPORT_LIMIT", "$.tracks", `generated CUT node count exceeds maxGeneratedNodes (${context.limits.maxGeneratedNodes}).`);

  const resourceList = [...resources.values()];
  const visualImports = new Set<string>(), audioImports = new Set<string>(), editImports = new Set<string>(), documentaryImports = new Set<string>();
  if (videoTracks.some((track) => pairs.has(track.index))) editImports.add("Clip");
  if (annotations.some((annotation) => annotation.kind === "marker")) editImports.add("Marker");
  if (annotations.some((annotation) => annotation.kind === "region")) editImports.add("Region");
  for (const resource of resourceList) {
    if (resource.kind === "video") visualImports.add("Video");
    else if (resource.kind === "image") visualImports.add("Image");
  }
  if (audioTracks.some((track) => track.clips.some((clip) => clip.nodeOp !== "cut.documentary.narration"))) audioImports.add("AudioClip");
  if (audioTracks.some((track) => track.clips.some((clip) => clip.nodeOp === "cut.documentary.narration"))) documentaryImports.add("Narration");
  // A linked resource uses Clip rather than Video even though it is a VideoAsset.
  if (!videoTracks.some((track) => !pairs.has(track.index) && track.clips.some((clip) => clip.resourceKind !== "image" && clip.nodeOp !== "cut.visual.image"))) visualImports.delete("Video");

  const importedNames = (names: Set<string>) => [...names].sort().map((name) => {
    const local = localSymbol(name);
    return local === name ? name : `${name} as ${local}`;
  }).join(", ");
  const imports = [
    visualImports.size ? `import { ${importedNames(visualImports)} } from "cut:visual";` : "",
    audioImports.size ? `import { ${importedNames(audioImports)} } from "@cut/audio";` : "",
    editImports.size ? `import { ${importedNames(editImports)} } from "@cut/edit";` : "",
    documentaryImports.size ? `import { ${importedNames(documentaryImports)} } from "@cut/documentary";` : "",
  ].filter(Boolean).join("\n");
  const assets = resourceList.map((resource) => `asset ${resource.asset}: ${resource.assetType} = ${resource.constructor}(${JSON.stringify(resource.locator)});`).join("\n");
  const annotationStatement = (annotation: (typeof annotations)[number], start: Rational) => {
    const common = `id: ${JSON.stringify(annotation.id)}, name: ${JSON.stringify(annotation.name)}, color: ${annotation.color}, role: ${JSON.stringify(annotation.role)}, comment: ${JSON.stringify(annotation.comment)}, grid: ${JSON.stringify(annotation.grid)}`;
    return annotation.kind === "marker"
      ? `${localSymbol("Marker")}(${common}, at: ${timeExpression(start)});`
      : `${localSymbol("Region")}(${common}, range: ${timeExpression(start)} ..< ${timeExpression(addRational(start, annotation.duration))});`;
  };
  const timelineAnnotationSource: string[] = [];
  annotations.forEach((annotation, index) => {
    if (!annotation.sceneId) {
      timelineAnnotationSource.push(`  ${annotationStatement(annotation, annotation.start)}`);
      return;
    }
    const authoredScene = timeline.metadata.scenes?.find((scene) => scene.id === annotation.sceneId);
    const emittedScene = authoredScene && scenes.find((scene) => compareRational(scene.start, authoredScene.start) === 0 && compareRational(scene.duration, authoredScene.duration) === 0);
    if (!authoredScene || !emittedScene) {
      fail("CUT_OTIO_IMPORT_UNSUPPORTED", `$.tracks.markers[${index}].metadata.cut.scene_id`, "cannot preserve scene ownership because the executable media partition subdivides or replaces the authored scene.");
    }
    sceneLines.get(emittedScene.name)!.push(annotationStatement(annotation, subtractRational(annotation.start, authoredScene.start)));
  });
  const sceneSource = scenes.map((scene) => {
    const body = sceneLines.get(scene.name)!;
    return `  scene ${scene.name}(duration: ${timeExpression(scene.duration)}) {\n${body.length ? body.map((line) => `    ${line}`).join("\n") : ""}\n  }`;
  }).join("\n\n");
  const annotationSource = timelineAnnotationSource.join("\n");
  const timelineBody = [annotationSource, sceneSource].filter(Boolean).join("\n\n");
  const source = `cut 0.4;\nproject ${JSON.stringify(settings.project)};\n\n${imports}${imports ? "\n\n" : ""}${assets}${assets ? "\n\n" : ""}timeline ${settings.timeline}(duration: ${timeExpression(timeline.duration)}, fps: ${scalarExpression(settings.fps)}, width: ${settings.width}px, height: ${settings.height}px, sampleRate: ${settings.sampleRate}hz) {\n${timelineBody}\n}\n\nexport out = render(${settings.timeline}, width: ${settings.width}px, height: ${settings.height}px, codec: "h264");\n`;
  if (Buffer.byteLength(source, "utf8") > context.limits.maxInputBytes) fail("CUT_OTIO_IMPORT_LIMIT", "$.output", "generated CUT source exceeds maxInputBytes.");
  return { source, scenes, resources: resourceList.map(({ asset, kind, locator, expectedSha256 }) => ({ asset, kind, locator, expectedSha256 })), generatedNodes, segmentedVideoClips, linkedPairs: pairs.size, markers: annotations.filter((annotation) => annotation.kind === "marker").length, regions: annotations.filter((annotation) => annotation.kind === "region").length };
}

/**
 * Import CUT's deliberately small executable OTIO editorial subset to canonical
 * typed CUT 0.4 source. Unsupported effects, markers, transitions, disabled
 * items, URI/absolute references, non-integral OTIO times, and ambiguous linked
 * A/V are hard errors rather than silent flattening.
 */
export function importOtioTimeline(input: string | Uint8Array, options: CutOtioImportOptions = {}): CutOtioImport {
  if (!isRecord(options)) fail("CUT_OTIO_IMPORT_TYPE", "$.options", "must be a plain object.");
  const optionKeys = new Set(["fps", "width", "height", "sampleRate", "projectName", "timelineName", "allowLossy", "limits"]);
  for (const key of Object.keys(options)) if (!optionKeys.has(key)) fail("CUT_OTIO_IMPORT_FIELD", `$.options.${key}`, "is not a supported importer option.");
  if (options.allowLossy !== undefined && typeof options.allowLossy !== "boolean") fail("CUT_OTIO_IMPORT_TYPE", "$.options.allowLossy", "must be a boolean.");
  const limits = resolveLimits(options.limits), parsed = parseInput(input, limits), context: ImportContext = { limits, totalStringBytes: 0, clipInstances: 0, allowLossy: options.allowLossy ?? false, losses: [] };
  validateJsonValue(parsed.value, "$", context);
  // The complete document already passed the aggregate string budget. Reset
  // the counter before typed-field validation so fields are not charged twice.
  context.totalStringBytes = 0;
  const timeline = validateTimeline(parsed.value, context), optionFps = parseRateOption(options.fps, "$.options.fps"), fps = exactSettingRational(timeline.metadata.fps, optionFps, "$.options.fps");
  if (compareRational(fps, rational(1)) < 0 || compareRational(fps, rational(120)) > 0) fail("CUT_OTIO_IMPORT_TYPE", "$.options.fps", "must be from 1 through 120 fps.");
  const width = exactSettingInteger(timeline.metadata.canvas?.width, options.width, "$.options.width", 1, 4_096), height = exactSettingInteger(timeline.metadata.canvas?.height, options.height, "$.options.height", 1, 4_096);
  if (width * height > 16_777_216) fail("CUT_OTIO_IMPORT_LIMIT", "$.options", "canvas exceeds the reference runtime's 16,777,216-pixel limit.");
  const sampleRate = exactSettingInteger(timeline.metadata.sampleRate, options.sampleRate, "$.options.sampleRate", 8_000, 192_000);
  const project = boundedString(options.projectName ?? timeline.metadata.project ?? timeline.name, "$.options.projectName", context, false);
  if (!project.trim()) fail("CUT_OTIO_IMPORT_TYPE", "$.options.projectName", "must contain non-whitespace text.");
  let authoredCompositionId = timeline.metadata.compositionId ?? timeline.metadata.editorialProfile?.compositionId;
  timeline.annotations.forEach((annotation, index) => {
    if (!annotation.compositionId) return;
    if (authoredCompositionId && annotation.compositionId !== authoredCompositionId) {
      fail("CUT_OTIO_IMPORT_SETTING_CONFLICT", `$.tracks.markers[${index}].metadata.cut.composition_id`, `does not match CUT composition identifier ${JSON.stringify(authoredCompositionId)}.`);
    }
    authoredCompositionId = annotation.compositionId;
  });
  let timelineName: string;
  if (authoredCompositionId) {
    if (options.timelineName !== undefined) {
      const requested = exactTimelineIdentifier(boundedString(options.timelineName, "$.options.timelineName", context, false), "$.options.timelineName");
      if (requested !== authoredCompositionId) fail("CUT_OTIO_IMPORT_SETTING_CONFLICT", "$.options.timelineName", `must exactly match CUT composition identifier ${JSON.stringify(authoredCompositionId)}.`);
    }
    timelineName = authoredCompositionId;
  } else {
    const requestedTimelineName = boundedString(options.timelineName ?? timeline.name, "$.options.timelineName", context, false);
    timelineName = identifier(requestedTimelineName, "main");
  }
  timeline.metadata.scenes?.forEach((scene, index) => {
    const expected = expectedSceneId(timelineName, scene.name, index);
    if (scene.id !== expected) {
      fail("CUT_OTIO_IMPORT_UNSUPPORTED", `$.metadata.cut.exact_scenes[${index}].id`, `cannot preserve scene ownership: ${JSON.stringify(scene.id)} is not the canonical CUT scene id ${JSON.stringify(expected)} for timeline ${JSON.stringify(timelineName)}, scene ${JSON.stringify(scene.name)}, ordinal ${index}.`);
    }
  });
  const built = timeline.metadata.editorialProfile
    ? makeEditorialProfileSource(timeline, { project, timeline: timelineName, fps, width, height, sampleRate }, context)
    : makeSource(timeline, { project, timeline: timelineName, fps, width, height, sampleRate }, context);
  const source = formatCutSource(built.source);
  const inputSha256 = createHash("sha256").update(Buffer.from(parsed.source, "utf8")).digest("hex"), outputSha256 = createHash("sha256").update(source).digest("hex");
  const videoTracks = timeline.tracks.filter((track) => track.kind === "Video").length, audioTracks = timeline.tracks.length - videoTracks;
  const implicitTrailingGaps = timeline.tracks.filter((track) => track.implicitTrailingGap).length;
  const report: CutOtioImportReport = {
    format: "cut-otio-import-report",
    version: 1,
    status: context.losses.length ? "lossy-editorial" : "lossless-editorial",
    input: { sha256: inputSha256, schema: "Timeline.1", name: timeline.name },
    output: { format: "cut-source", language: "0.4", sha256: outputSha256, project, timeline: timelineName, duration: timeline.duration, fps, width, height, sampleRate },
    imported: {
      tracks: timeline.tracks.length,
      videoTracks,
      audioTracks,
      clips: context.clipInstances,
      gaps: timeline.tracks.reduce((sum, track) => sum + track.gaps, 0),
      linkedPairs: built.linkedPairs,
      scenes: built.scenes.length,
      generatedNodes: built.generatedNodes,
      segmentedVideoClips: built.segmentedVideoClips,
      implicitTrailingGaps,
      markers: built.markers,
      regions: built.regions,
    },
    sourceTracks: timeline.tracks.map((track) => ({ index: track.index, name: track.name, kind: track.kind, clips: track.clips.length, gaps: track.gaps })),
    resources: built.resources,
    guarantees: { timing: "exact-rational", sourceReferences: "project-relative-posix", unsupportedSemantics: context.losses.length ? "explicitly-reported-lossy" : "refused" },
    losses: context.losses,
    ...(timeline.metadata.editorialProfile ? {
      editorialProfile: {
        format: timeline.metadata.editorialProfile.format,
        version: timeline.metadata.editorialProfile.version,
        semanticSha256: timeline.metadata.editorialProfile.semanticSha256,
        targetScopedLosses: timeline.metadata.editorialProfile.losses.length,
        ...(timeline.metadata.editorialProfileExtension ? {
          extension: {
            format: timeline.metadata.editorialProfileExtension.format,
            version: timeline.metadata.editorialProfileExtension.version,
            semanticSha256:
              timeline.metadata.editorialProfileExtension.semanticSha256,
            origins:
              timeline.metadata.editorialProfileExtension.audioOrigins.length,
            views:
              timeline.metadata.editorialProfileExtension.audioOrigins.reduce(
                (total, origin) => total + origin.views.length,
                0,
              ),
            lineageSegments:
              timeline.metadata.editorialProfileExtension.audioOrigins.reduce(
                (total, origin) =>
                  total + origin.lineageSegments.length,
                0,
              ),
            targetScopedLosses:
              timeline.metadata.editorialProfileExtension.losses.length,
          },
        } : {}),
        ...(timeline.metadata.editorialProfileNestedExtension ? {
          nestedExtension: {
            format:
              timeline.metadata.editorialProfileNestedExtension.format,
            version:
              timeline.metadata.editorialProfileNestedExtension.version,
            semanticSha256:
              timeline.metadata.editorialProfileNestedExtension.semanticSha256,
            lineageSegments:
              timeline.metadata.editorialProfileNestedExtension
                .lineageSegments.length,
            placements:
              timeline.metadata.editorialProfileNestedExtension
                .placements.length,
          },
        } : {}),
        ...(timeline.metadata.editorialProfileDirectMediaExtension ? {
          directMediaExtension: {
            format:
              timeline.metadata.editorialProfileDirectMediaExtension.format,
            version:
              timeline.metadata.editorialProfileDirectMediaExtension.version,
            semanticSha256:
              timeline.metadata.editorialProfileDirectMediaExtension
                .semanticSha256,
            authorities:
              timeline.metadata.editorialProfileDirectMediaExtension
                .authorities.length,
          },
        } : {}),
        ...(timeline.metadata.editorialProfilePictureTimeMapExtension ? {
          pictureTimeMapExtension: {
            format:
              timeline.metadata.editorialProfilePictureTimeMapExtension.format,
            version:
              timeline.metadata.editorialProfilePictureTimeMapExtension.version,
            semanticSha256:
              timeline.metadata.editorialProfilePictureTimeMapExtension
                .semanticSha256,
            authorities:
              timeline.metadata.editorialProfilePictureTimeMapExtension
                .authorities.length,
          },
        } : {}),
      },
    } : {}),
    normalization: [
      ...(timeline.metadata.editorialProfile ? [
        "The closed CUT editorial profile was reconciled against native OTIO Track/Clip/Gap/Transition/LinearTimeWarp/Stack structure before executable source generation.",
        "Profile track/item identities, explicit links, transitions, constant retimes, and materialized trim/split boundaries are emitted as canonical CUT editorial source.",
        ...(timeline.metadata.editorialProfileExtension ? [
          "The V3 origin-clock extension was authenticated against the exact V2 profile and native item timings before source generation; current unsupported processor-graph reconstruction remains an explicit allow-lossy receipt.",
        ] : []),
        ...(timeline.metadata.editorialProfileNestedExtension ? [
          "The V4 nested-placement extension was authenticated against the exact V2 profile, TimelineEdit lineage, and native Stack role/metadata before the explicitly lossy Gap reconstruction.",
        ] : []),
        ...(timeline.metadata.editorialProfileDirectMediaExtension ? [
          "The V5 direct-media extension was authenticated against the exact V2 profile and native Clip/ExternalReference metadata; imported direct PictureClip/AudioClip source recreates declared surplus handles without claiming processed, nested, transcript-origin, or generic-OTIO reconstruction.",
        ] : []),
        ...(timeline.metadata.editorialProfilePictureTimeMapExtension ? [
          "The V6 picture-time-map extension was authenticated against the exact V2 profile and native Clip/ExternalReference metadata; imported direct PictureClip source recreates the final exact constant-sampling, freeze, or speed-ramp law without claiming TimelineEdit operation lineage or generic-OTIO portability.",
        ] : []),
      ] : [
        "OTIO Stack/Track/Clip/Gap structure is lowered to exact CUT scenes and at-block placements.",
        "Video clips crossing another picture edit boundary are split into exact adjacent source ranges.",
      ]),
      "Track and clip display names remain in this report; canonical CUT source names resources deterministically by first use.",
      "Resource bytes are not trusted at import time; cut lock re-probes and content-locks every project-relative locator before execution.",
      ...(context.losses.some((loss) => loss.code === "CUT_OTIO_IMPORT_NARRATION_TRANSCRIPT_UNSUPPORTED") ? ["Legacy Narration transcript metadata was omitted only because allowLossy was explicit; every exact omitted string remains in losses[].evidence.value."] : []),
      ...(context.losses.some((loss) => loss.code === "CUT_OTIO_SEMANTIC_MATCH_UNSUPPORTED") ? ["Semantic-match declarations and transitions were already omitted by the OTIO export; import preserved each authored id as an explicit loss and emitted only the hard-cut representation under allowLossy."] : []),
      ...(built.markers || built.regions ? ["OTIO Stack Marker.2 values are lowered to explicit CUT Marker/Region statements; source-location metadata is validated but regenerated from canonical imported source."] : []),
      ...(implicitTrailingGaps ? ["Shorter OTIO tracks receive an implicit empty tail to the Stack duration."] : []),
    ],
  };
  // Prove the report is canonical-JSON serializable at the public boundary.
  stableJsonStringify(report);
  return { source, report };
}
