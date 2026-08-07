import { createHash } from "node:crypto";
import { stableJsonStringify } from "../core/stable";
import {
  addRational,
  compareRational,
  divideRational,
  multiplyRational,
  rational,
  subtractRational,
  type Rational,
  zeroRational,
} from "../language/rational";

export const cutOtioEditorialProfileFormat = "cut-otio-editorial-profile" as const;
export const cutOtioEditorialProfileVersion = 2 as const;
export const cutOtioEditorialObservationFormat = "cut-otio-editorial-observation" as const;

export type CutOtioEditorialProfileLimits = Readonly<{
  maximumTracks: number;
  maximumItems: number;
  maximumLinkGroups: number;
  maximumLinkedCuts: number;
  maximumTransitions: number;
  maximumLosses: number;
  maximumNestingDepth: number;
  maximumRationalDigits: number;
  maximumStringBytes: number;
}>;

export const cutOtioEditorialProfileLimits: CutOtioEditorialProfileLimits = Object.freeze({
  maximumTracks: 256,
  maximumItems: 100_000,
  maximumLinkGroups: 50_000,
  maximumLinkedCuts: 50_000,
  maximumTransitions: 50_000,
  maximumLosses: 100_000,
  maximumNestingDepth: 16,
  maximumRationalDigits: 128,
  maximumStringBytes: 4_096,
});

export type CutOtioExactInterval = Readonly<{
  start: Rational;
  duration: Rational;
}>;

export type CutOtioEditorialLink =
  | Readonly<{ kind: "unlinked" }>
  | Readonly<{ kind: "linked"; groupId: string; segmentId: string }>;

export type CutOtioEditorialRetime =
  | Readonly<{ kind: "identity" }>
  | Readonly<{ kind: "constant"; direction: "forward" | "reverse"; rate: Rational }>;

export type CutOtioEditorialNesting = Readonly<{
  instanceId: string;
  compositionId: string;
  sourceRange: CutOtioExactInterval;
  semanticSha256: string;
  depth: number;
  ancestry: readonly string[];
}>;

export type CutOtioEditorialMetadata = Readonly<Record<string, string>>;

type CutOtioEditorialItemBase = Readonly<{
  id: string;
  order: number;
  destination: CutOtioExactInterval;
}>;

export type CutOtioEditorialClipItem = CutOtioEditorialItemBase & Readonly<{
  kind: "clip";
  source: CutOtioExactInterval;
  link: CutOtioEditorialLink;
  retime: CutOtioEditorialRetime;
  nesting: null;
  role?: string;
  metadata?: CutOtioEditorialMetadata;
}>;

export type CutOtioEditorialGapItem = CutOtioEditorialItemBase & Readonly<{
  kind: "gap";
  source: null;
  link: Readonly<{ kind: "unlinked" }>;
  retime: Readonly<{ kind: "identity" }>;
  nesting: null;
}>;

export type CutOtioEditorialNestedItem = CutOtioEditorialItemBase & Readonly<{
  kind: "nested-sequence";
  source: CutOtioExactInterval;
  link: Readonly<{ kind: "unlinked" }>;
  retime: Readonly<{ kind: "identity" }>;
  nesting: CutOtioEditorialNesting;
}>;

export type CutOtioEditorialItem =
  | CutOtioEditorialClipItem
  | CutOtioEditorialGapItem
  | CutOtioEditorialNestedItem;

export type CutOtioEditorialTrack = Readonly<{
  id: string;
  kind: "Video" | "Audio";
  order: number;
  role?: string;
  metadata?: CutOtioEditorialMetadata;
  items: readonly CutOtioEditorialItem[];
}>;

export type CutOtioEditorialLinkGroup = Readonly<{
  id: string;
  kind: "linked-av";
  segments: readonly Readonly<{
    id: string;
    pictureItemId: string;
    audioItemId: string;
  }>[];
}>;

export type CutOtioEditorialLinkedCut = Readonly<{
  id: string;
  kind: "j-cut" | "l-cut";
  groupId: string;
  picture: Readonly<{
    outgoingItemId: string;
    incomingItemId: string;
    at: Rational;
  }>;
  audio: Readonly<{
    outgoingItemId: string;
    incomingItemId: string;
    at: Rational;
  }>;
}>;

export type CutOtioPictureTransitionStyle =
  | Readonly<{ kind: "cross-dissolve" }>
  | Readonly<{ kind: "dip"; color: string }>
  | Readonly<{ kind: "wipe"; direction: "left" | "right" | "up" | "down"; softness: Rational }>
  | Readonly<{ kind: "push" | "slide"; direction: "left" | "right" | "up" | "down" }>;

export type CutOtioEditorialTransitionMapping =
  | Readonly<{ kind: "picture"; style: CutOtioPictureTransitionStyle }>
  | Readonly<{ kind: "audio"; curve: "equal-power" | "linear" }>;

export type CutOtioEditorialTransition = Readonly<{
  id: string;
  trackId: string;
  outgoingItemId: string;
  incomingItemId: string;
  cut: Rational;
  duration: Rational;
  overlap: CutOtioExactInterval;
  outgoingSource: CutOtioExactInterval;
  incomingSource: CutOtioExactInterval;
  mapping: CutOtioEditorialTransitionMapping;
}>;

export type CutOtioEditorialLossTarget =
  | Readonly<{ kind: "cut-roundtrip" | "generic-otio" }>
  | Readonly<{ kind: "adapter"; id: string }>;

export type CutOtioEditorialLoss = Readonly<{
  code: string;
  category: "effect" | "linkage" | "metadata" | "nesting" | "retime" | "timing" | "transaction" | "transition";
  disposition: "approximated" | "dropped" | "metadata-required" | "unsupported";
  target: CutOtioEditorialLossTarget;
  subject: Readonly<{
    kind: "composition" | "track" | "item" | "link-group" | "linked-cut" | "transition" | "nesting";
    id: string;
  }>;
  message: string;
}>;

export type CutOtioEditorialProfileBody = Readonly<{
  format: typeof cutOtioEditorialProfileFormat;
  version: typeof cutOtioEditorialProfileVersion;
  compositionId: string;
  duration: Rational;
  tracks: readonly CutOtioEditorialTrack[];
  linkGroups: readonly CutOtioEditorialLinkGroup[];
  linkedCuts: readonly CutOtioEditorialLinkedCut[];
  transitions: readonly CutOtioEditorialTransition[];
  losses: readonly CutOtioEditorialLoss[];
}>;

export type CutOtioEditorialProfile = CutOtioEditorialProfileBody & Readonly<{
  semanticSha256: string;
}>;

export type CutOtioEditorialObservationItem = Readonly<{
  id: string;
  kind: CutOtioEditorialItem["kind"];
  order: number;
  destination: CutOtioExactInterval;
  source: CutOtioExactInterval | null;
  retime: CutOtioEditorialRetime;
  nesting: CutOtioEditorialNesting | null;
  role?: string;
  metadata?: CutOtioEditorialMetadata;
}>;

export type CutOtioEditorialObservation = Readonly<{
  format: typeof cutOtioEditorialObservationFormat;
  version: 1;
  compositionId: string;
  duration: Rational;
  tracks: readonly Readonly<{
    id: string;
    kind: "Video" | "Audio";
    order: number;
    role?: string;
    metadata?: CutOtioEditorialMetadata;
    items: readonly CutOtioEditorialObservationItem[];
  }>[];
  transitions: readonly CutOtioEditorialTransition[];
}>;

export type CutOtioEditorialReconciliation = Readonly<{
  format: "cut-otio-editorial-reconciliation";
  version: 1;
  status: "pass";
  semanticSha256: string;
  compositionId: string;
  tracks: number;
  items: number;
  linkGroups: number;
  linkedCuts: number;
  transitions: number;
  nestingInstances: number;
  targetScopedLosses: number;
}>;

export type CutOtioEditorialProfileErrorCode =
  | "CUT_OTIO_PROFILE_BUDGET"
  | "CUT_OTIO_PROFILE_DUPLICATE"
  | "CUT_OTIO_PROFILE_HASH"
  | "CUT_OTIO_PROFILE_ID"
  | "CUT_OTIO_PROFILE_MISSING_FIELD"
  | "CUT_OTIO_PROFILE_RATIONAL"
  | "CUT_OTIO_PROFILE_RECONCILIATION"
  | "CUT_OTIO_PROFILE_REFERENCE"
  | "CUT_OTIO_PROFILE_TIMING"
  | "CUT_OTIO_PROFILE_TYPE"
  | "CUT_OTIO_PROFILE_UNKNOWN_FIELD"
  | "CUT_OTIO_PROFILE_VERSION";

export class CutOtioEditorialProfileError extends Error {
  constructor(
    readonly code: CutOtioEditorialProfileErrorCode,
    readonly path: string,
    message: string,
  ) {
    super(`${code} at ${path}: ${message}`);
    this.name = "CutOtioEditorialProfileError";
  }
}

type JsonRecord = Record<string, unknown>;
type ItemOwner = Readonly<{
  track: CutOtioEditorialTrack;
  index: number;
  item: CutOtioEditorialItem;
}>;

const idPattern = /^[A-Za-z_][A-Za-z0-9._:-]{0,127}$/u;
const adapterIdPattern = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;
const lossCodePattern = /^CUT_OTIO_[A-Z0-9_]+$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
const integerPattern = /^-?(?:0|[1-9][0-9]*)$/u;
const positiveIntegerPattern = /^[1-9][0-9]*$/u;
const directions = new Set(["left", "right", "up", "down"]);
const pictureRoles = new Set(["primary", "b-roll", "overlay", "graphics", "captions", "reference", "custom"]);
const audioRoles = new Set(["dialogue", "narration", "music", "ambience", "sfx", "sync", "custom"]);
const editorialMetadataKeyPattern = /^(?![Cc][Uu][Tt]\.)(?:[A-Za-z][A-Za-z0-9_-]*\.)+[A-Za-z][A-Za-z0-9_-]*$/u;
const lossCategories = new Set(["effect", "linkage", "metadata", "nesting", "retime", "timing", "transaction", "transition"]);
const lossDispositions = new Set(["approximated", "dropped", "metadata-required", "unsupported"]);

function fail(code: CutOtioEditorialProfileErrorCode, path: string, message: string): never {
  throw new CutOtioEditorialProfileError(code, path, message);
}

function dataRecord(value: unknown, path: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("CUT_OTIO_PROFILE_TYPE", path, "must be a plain object.");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail("CUT_OTIO_PROFILE_TYPE", path, "must have a plain or null prototype.");
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") fail("CUT_OTIO_PROFILE_TYPE", path, "cannot contain symbol keys.");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) fail("CUT_OTIO_PROFILE_TYPE", `${path}.${key}`, "must be an enumerable data property.");
  }
  return value as JsonRecord;
}

function closed(value: unknown, path: string, fields: readonly string[]) {
  const result = dataRecord(value, path), allowed = new Set(fields);
  for (const field of fields) {
    if (!Object.hasOwn(result, field)) fail("CUT_OTIO_PROFILE_MISSING_FIELD", `${path}.${field}`, "is required.");
  }
  for (const field of Object.keys(result)) {
    if (!allowed.has(field)) fail("CUT_OTIO_PROFILE_UNKNOWN_FIELD", `${path}.${field}`, `is not part of ${cutOtioEditorialProfileFormat} v${cutOtioEditorialProfileVersion}.`);
  }
  return result;
}

function closedWithOptional(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[],
) {
  const result = dataRecord(value, path), allowed = new Set([...required, ...optional]);
  for (const field of required) {
    if (!Object.hasOwn(result, field)) fail("CUT_OTIO_PROFILE_MISSING_FIELD", `${path}.${field}`, "is required.");
  }
  for (const field of Object.keys(result)) {
    if (!allowed.has(field)) fail("CUT_OTIO_PROFILE_UNKNOWN_FIELD", `${path}.${field}`, `is not part of ${cutOtioEditorialProfileFormat} v${cutOtioEditorialProfileVersion}.`);
  }
  return result;
}

function list(value: unknown, path: string, maximum: number, minimum = 0) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail("CUT_OTIO_PROFILE_TYPE", path, "must be a plain array.");
  if (value.length < minimum || value.length > maximum) fail("CUT_OTIO_PROFILE_BUDGET", path, `must contain from ${minimum} through ${maximum} entries.`);
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) fail("CUT_OTIO_PROFILE_TYPE", `${path}[${index}]`, "cannot be a sparse array slot.");
  }
  return value as unknown[];
}

function boundedText(value: unknown, path: string, allowEmpty = false) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.includes("\0")) {
    fail("CUT_OTIO_PROFILE_TYPE", path, `must be ${allowEmpty ? "a" : "a non-empty"} string without NUL.`);
  }
  if (Buffer.byteLength(value, "utf8") > cutOtioEditorialProfileLimits.maximumStringBytes) {
    fail("CUT_OTIO_PROFILE_BUDGET", path, `exceeds ${cutOtioEditorialProfileLimits.maximumStringBytes} UTF-8 bytes.`);
  }
  return value;
}

function id(value: unknown, path: string) {
  const result = boundedText(value, path);
  if (!idPattern.test(result)) fail("CUT_OTIO_PROFILE_ID", path, "must be a canonical CUT editorial identifier.");
  return result;
}

function editorialRole(value: unknown, path: string, trackKind: "Video" | "Audio") {
  const role = boundedText(value, path);
  if (!(trackKind === "Video" ? pictureRoles : audioRoles).has(role)) {
    fail(
      "CUT_OTIO_PROFILE_TYPE",
      path,
      `must be one closed ${trackKind === "Video" ? "picture" : "audio"} editorial role.`,
    );
  }
  return role;
}

function editorialMetadata(value: unknown, path: string): CutOtioEditorialMetadata {
  const object = dataRecord(value, path), entries = Object.entries(object);
  if (entries.length < 1 || entries.length > 64) {
    fail("CUT_OTIO_PROFILE_BUDGET", path, "must contain from 1 through 64 namespaced entries.");
  }
  const result: Record<string, string> = {};
  let bytes = 0;
  for (const [key, raw] of entries) {
    if (!editorialMetadataKeyPattern.test(key) || key.length > 128) {
      fail("CUT_OTIO_PROFILE_TYPE", `${path}.${key}`, "must use one bounded non-CUT dotted metadata namespace.");
    }
    if (typeof raw !== "string" || raw.length > 1_024 || /[\u0000-\u001f\u007f]/u.test(raw)) {
      fail("CUT_OTIO_PROFILE_TYPE", `${path}.${key}`, "must be a printable String of at most 1024 characters.");
    }
    bytes += Buffer.byteLength(key, "utf8") + Buffer.byteLength(raw, "utf8");
    if (bytes > 16_384) {
      fail("CUT_OTIO_PROFILE_BUDGET", path, "exceeds the 16384-byte UTF-8 editorial metadata ceiling.");
    }
    result[key] = raw;
  }
  return result;
}

function digest(value: unknown, path: string) {
  const result = boundedText(value, path);
  if (!digestPattern.test(result)) fail("CUT_OTIO_PROFILE_TYPE", path, "must be a lowercase 64-character SHA-256 digest.");
  return result;
}

function exactInteger(value: unknown, path: string, maximum: number, minimum = 0) {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    fail("CUT_OTIO_PROFILE_BUDGET", path, `must be a safe integer from ${minimum} through ${maximum}.`);
  }
  return Number(value);
}

function exactRational(value: unknown, path: string, sign: "any" | "non-negative" | "positive" = "any"): Rational {
  const item = closed(value, path, ["numerator", "denominator"]);
  if (typeof item.numerator !== "string" || !integerPattern.test(item.numerator)
    || typeof item.denominator !== "string" || !positiveIntegerPattern.test(item.denominator)) {
    fail("CUT_OTIO_PROFILE_RATIONAL", path, "must contain canonical base-10 integer strings and a positive denominator.");
  }
  if (item.numerator.length > cutOtioEditorialProfileLimits.maximumRationalDigits
    || item.denominator.length > cutOtioEditorialProfileLimits.maximumRationalDigits) {
    fail("CUT_OTIO_PROFILE_BUDGET", path, `exceeds ${cutOtioEditorialProfileLimits.maximumRationalDigits} rational digits.`);
  }
  let canonical: Rational;
  try {
    canonical = rational(item.numerator, item.denominator);
  } catch {
    fail("CUT_OTIO_PROFILE_RATIONAL", path, "is not a valid exact rational.");
  }
  if (canonical.numerator !== item.numerator || canonical.denominator !== item.denominator) {
    fail("CUT_OTIO_PROFILE_RATIONAL", path, "must already be reduced with a positive denominator and no signed zero.");
  }
  const zeroComparison = compareRational(canonical, zeroRational);
  if ((sign === "non-negative" && zeroComparison < 0) || (sign === "positive" && zeroComparison <= 0)) {
    fail("CUT_OTIO_PROFILE_RATIONAL", path, `must be ${sign}.`);
  }
  return canonical;
}

function exactInterval(value: unknown, path: string): CutOtioExactInterval {
  const item = closed(value, path, ["start", "duration"]);
  return {
    start: exactRational(item.start, `${path}.start`, "non-negative"),
    duration: exactRational(item.duration, `${path}.duration`, "positive"),
  };
}

function intervalEnd(value: CutOtioExactInterval) {
  return addRational(value.start, value.duration);
}

function sameRational(left: Rational, right: Rational) {
  return compareRational(left, right) === 0;
}

function sameInterval(left: CutOtioExactInterval, right: CutOtioExactInterval) {
  return sameRational(left.start, right.start) && sameRational(left.duration, right.duration);
}

function parseLink(value: unknown, path: string): CutOtioEditorialLink {
  const item = dataRecord(value, path);
  if (item.kind === "unlinked") {
    closed(item, path, ["kind"]);
    return { kind: "unlinked" };
  }
  if (item.kind === "linked") {
    const linked = closed(item, path, ["kind", "groupId", "segmentId"]);
    return { kind: "linked", groupId: id(linked.groupId, `${path}.groupId`), segmentId: id(linked.segmentId, `${path}.segmentId`) };
  }
  fail("CUT_OTIO_PROFILE_TYPE", `${path}.kind`, "must be exactly \"linked\" or \"unlinked\".");
}

function parseRetime(value: unknown, path: string): CutOtioEditorialRetime {
  const item = dataRecord(value, path);
  if (item.kind === "identity") {
    closed(item, path, ["kind"]);
    return { kind: "identity" };
  }
  if (item.kind === "constant") {
    const constant = closed(item, path, ["kind", "direction", "rate"]);
    if (constant.direction !== "forward" && constant.direction !== "reverse") {
      fail("CUT_OTIO_PROFILE_TYPE", `${path}.direction`, "must be exactly \"forward\" or \"reverse\".");
    }
    const rate = exactRational(constant.rate, `${path}.rate`, "positive");
    if (constant.direction === "forward" && sameRational(rate, rational(1))) {
      fail("CUT_OTIO_PROFILE_TIMING", `${path}.rate`, "forward constant retime must not encode the identity rate.");
    }
    return { kind: "constant", direction: constant.direction, rate };
  }
  fail("CUT_OTIO_PROFILE_TYPE", `${path}.kind`, "must be exactly \"identity\" or \"constant\".");
}

function parseNesting(value: unknown, path: string): CutOtioEditorialNesting {
  const item = closed(value, path, ["instanceId", "compositionId", "sourceRange", "semanticSha256", "depth", "ancestry"]);
  const depth = exactInteger(item.depth, `${path}.depth`, cutOtioEditorialProfileLimits.maximumNestingDepth, 1);
  const ancestry = list(item.ancestry, `${path}.ancestry`, cutOtioEditorialProfileLimits.maximumNestingDepth + 1, 2)
    .map((entry, index) => id(entry, `${path}.ancestry[${index}]`));
  if (ancestry.length !== depth + 1) fail("CUT_OTIO_PROFILE_REFERENCE", `${path}.ancestry`, "must contain exactly depth + 1 composition identifiers.");
  if (new Set(ancestry).size !== ancestry.length) fail("CUT_OTIO_PROFILE_REFERENCE", `${path}.ancestry`, "cannot repeat a composition identifier or declare a nesting cycle.");
  const compositionId = id(item.compositionId, `${path}.compositionId`);
  if (ancestry.at(-1) !== compositionId) fail("CUT_OTIO_PROFILE_REFERENCE", `${path}.compositionId`, "must equal the final ancestry identifier.");
  return {
    instanceId: id(item.instanceId, `${path}.instanceId`),
    compositionId,
    sourceRange: exactInterval(item.sourceRange, `${path}.sourceRange`),
    semanticSha256: digest(item.semanticSha256, `${path}.semanticSha256`),
    depth,
    ancestry,
  };
}

function parseItem(value: unknown, path: string, trackKind: "Video" | "Audio"): CutOtioEditorialItem {
  const item = closedWithOptional(
    value,
    path,
    ["id", "kind", "order", "destination", "source", "link", "retime", "nesting"],
    ["role", "metadata"],
  );
  const itemId = id(item.id, `${path}.id`);
  const order = exactInteger(item.order, `${path}.order`, cutOtioEditorialProfileLimits.maximumItems - 1);
  const destination = exactInterval(item.destination, `${path}.destination`);
  const link = parseLink(item.link, `${path}.link`);
  const retime = parseRetime(item.retime, `${path}.retime`);
  if (item.kind === "gap") {
    if (item.role !== undefined || item.metadata !== undefined) {
      fail("CUT_OTIO_PROFILE_TYPE", path, "a gap cannot carry clip role or metadata.");
    }
    if (item.source !== null || item.nesting !== null || link.kind !== "unlinked" || retime.kind !== "identity") {
      fail("CUT_OTIO_PROFILE_TYPE", path, "a gap requires null source/nesting, explicit unlinked identity semantics.");
    }
    return { id: itemId, kind: "gap", order, destination, source: null, link, retime, nesting: null };
  }
  if (item.kind === "clip") {
    if (item.source === null || item.nesting !== null) fail("CUT_OTIO_PROFILE_TYPE", path, "a clip requires an exact source and null nesting.");
    return {
      id: itemId,
      kind: "clip",
      order,
      destination,
      source: exactInterval(item.source, `${path}.source`),
      link,
      retime,
      nesting: null,
      ...(item.role === undefined ? {} : { role: editorialRole(item.role, `${path}.role`, trackKind) }),
      ...(item.metadata === undefined ? {} : { metadata: editorialMetadata(item.metadata, `${path}.metadata`) }),
    };
  }
  if (item.kind === "nested-sequence") {
    if (item.role !== undefined || item.metadata !== undefined) {
      fail("CUT_OTIO_PROFILE_TYPE", path, "a nested-sequence item cannot carry direct clip role or metadata.");
    }
    if (trackKind !== "Video") fail("CUT_OTIO_PROFILE_TYPE", `${path}.kind`, "nested-sequence is supported only on Video tracks.");
    if (item.source === null || item.nesting === null || link.kind !== "unlinked" || retime.kind !== "identity") {
      fail("CUT_OTIO_PROFILE_TYPE", path, "a nested sequence requires source/nesting, explicit unlinked identity semantics.");
    }
    return {
      id: itemId,
      kind: "nested-sequence",
      order,
      destination,
      source: exactInterval(item.source, `${path}.source`),
      link,
      retime,
      nesting: parseNesting(item.nesting, `${path}.nesting`),
    };
  }
  fail("CUT_OTIO_PROFILE_TYPE", `${path}.kind`, "must be exactly \"clip\", \"gap\", or \"nested-sequence\".");
}

function parseTrack(value: unknown, path: string): CutOtioEditorialTrack {
  const item = closedWithOptional(value, path, ["id", "kind", "order", "items"], ["role", "metadata"]);
  if (item.kind !== "Video" && item.kind !== "Audio") fail("CUT_OTIO_PROFILE_TYPE", `${path}.kind`, "must be exactly \"Video\" or \"Audio\".");
  const trackKind = item.kind as "Video" | "Audio";
  const items = list(item.items, `${path}.items`, cutOtioEditorialProfileLimits.maximumItems)
    .map((entry, index) => parseItem(entry, `${path}.items[${index}]`, trackKind));
  return {
    id: id(item.id, `${path}.id`),
    kind: trackKind,
    order: exactInteger(item.order, `${path}.order`, cutOtioEditorialProfileLimits.maximumTracks - 1),
    ...(item.role === undefined ? {} : { role: editorialRole(item.role, `${path}.role`, trackKind) }),
    ...(item.metadata === undefined ? {} : { metadata: editorialMetadata(item.metadata, `${path}.metadata`) }),
    items,
  };
}

function parseLinkGroup(value: unknown, path: string): CutOtioEditorialLinkGroup {
  const item = closed(value, path, ["id", "kind", "segments"]);
  if (item.kind !== "linked-av") fail("CUT_OTIO_PROFILE_TYPE", `${path}.kind`, "must be exactly \"linked-av\".");
  const segments = list(item.segments, `${path}.segments`, cutOtioEditorialProfileLimits.maximumItems, 1).map((entry, index) => {
    const segmentPath = `${path}.segments[${index}]`;
    const segment = closed(entry, segmentPath, ["id", "pictureItemId", "audioItemId"]);
    return {
      id: id(segment.id, `${segmentPath}.id`),
      pictureItemId: id(segment.pictureItemId, `${segmentPath}.pictureItemId`),
      audioItemId: id(segment.audioItemId, `${segmentPath}.audioItemId`),
    };
  });
  return { id: id(item.id, `${path}.id`), kind: "linked-av", segments };
}

function parseLinkedCutSide(value: unknown, path: string) {
  const item = closed(value, path, ["outgoingItemId", "incomingItemId", "at"]);
  return {
    outgoingItemId: id(item.outgoingItemId, `${path}.outgoingItemId`),
    incomingItemId: id(item.incomingItemId, `${path}.incomingItemId`),
    at: exactRational(item.at, `${path}.at`, "non-negative"),
  };
}

function parseLinkedCut(value: unknown, path: string): CutOtioEditorialLinkedCut {
  const item = closed(value, path, ["id", "kind", "groupId", "picture", "audio"]);
  if (item.kind !== "j-cut" && item.kind !== "l-cut") fail("CUT_OTIO_PROFILE_TYPE", `${path}.kind`, "must be exactly \"j-cut\" or \"l-cut\".");
  return {
    id: id(item.id, `${path}.id`),
    kind: item.kind,
    groupId: id(item.groupId, `${path}.groupId`),
    picture: parseLinkedCutSide(item.picture, `${path}.picture`),
    audio: parseLinkedCutSide(item.audio, `${path}.audio`),
  };
}

function parsePictureStyle(value: unknown, path: string): CutOtioPictureTransitionStyle {
  const item = dataRecord(value, path);
  if (item.kind === "cross-dissolve") {
    closed(item, path, ["kind"]);
    return { kind: "cross-dissolve" };
  }
  if (item.kind === "dip") {
    const dip = closed(item, path, ["kind", "color"]);
    return { kind: "dip", color: boundedText(dip.color, `${path}.color`) };
  }
  if (item.kind === "wipe") {
    const wipe = closed(item, path, ["kind", "direction", "softness"]);
    if (typeof wipe.direction !== "string" || !directions.has(wipe.direction)) fail("CUT_OTIO_PROFILE_TYPE", `${path}.direction`, "must be left, right, up, or down.");
    const softness = exactRational(wipe.softness, `${path}.softness`, "non-negative");
    if (compareRational(softness, rational(1)) > 0) fail("CUT_OTIO_PROFILE_TIMING", `${path}.softness`, "must be between zero and one.");
    return { kind: "wipe", direction: wipe.direction as "left" | "right" | "up" | "down", softness };
  }
  if (item.kind === "push" || item.kind === "slide") {
    const directional = closed(item, path, ["kind", "direction"]);
    if (typeof directional.direction !== "string" || !directions.has(directional.direction)) fail("CUT_OTIO_PROFILE_TYPE", `${path}.direction`, "must be left, right, up, or down.");
    return { kind: item.kind, direction: directional.direction as "left" | "right" | "up" | "down" };
  }
  fail("CUT_OTIO_PROFILE_TYPE", `${path}.kind`, "is not a supported CUT picture transition style.");
}

function parseTransitionMapping(value: unknown, path: string): CutOtioEditorialTransitionMapping {
  const item = dataRecord(value, path);
  if (item.kind === "picture") {
    const picture = closed(item, path, ["kind", "style"]);
    return { kind: "picture", style: parsePictureStyle(picture.style, `${path}.style`) };
  }
  if (item.kind === "audio") {
    const audio = closed(item, path, ["kind", "curve"]);
    if (audio.curve !== "equal-power" && audio.curve !== "linear") fail("CUT_OTIO_PROFILE_TYPE", `${path}.curve`, "must be exactly \"equal-power\" or \"linear\".");
    return { kind: "audio", curve: audio.curve };
  }
  fail("CUT_OTIO_PROFILE_TYPE", `${path}.kind`, "must be exactly \"picture\" or \"audio\".");
}

function parseTransition(value: unknown, path: string): CutOtioEditorialTransition {
  const item = closed(value, path, [
    "id", "trackId", "outgoingItemId", "incomingItemId", "cut", "duration",
    "overlap", "outgoingSource", "incomingSource", "mapping",
  ]);
  return {
    id: id(item.id, `${path}.id`),
    trackId: id(item.trackId, `${path}.trackId`),
    outgoingItemId: id(item.outgoingItemId, `${path}.outgoingItemId`),
    incomingItemId: id(item.incomingItemId, `${path}.incomingItemId`),
    cut: exactRational(item.cut, `${path}.cut`, "non-negative"),
    duration: exactRational(item.duration, `${path}.duration`, "positive"),
    overlap: exactInterval(item.overlap, `${path}.overlap`),
    outgoingSource: exactInterval(item.outgoingSource, `${path}.outgoingSource`),
    incomingSource: exactInterval(item.incomingSource, `${path}.incomingSource`),
    mapping: parseTransitionMapping(item.mapping, `${path}.mapping`),
  };
}

function parseLossTarget(value: unknown, path: string): CutOtioEditorialLossTarget {
  const item = dataRecord(value, path);
  if (item.kind === "cut-roundtrip" || item.kind === "generic-otio") {
    closed(item, path, ["kind"]);
    return { kind: item.kind };
  }
  if (item.kind === "adapter") {
    const adapter = closed(item, path, ["kind", "id"]);
    const adapterId = boundedText(adapter.id, `${path}.id`);
    if (!adapterIdPattern.test(adapterId)) fail("CUT_OTIO_PROFILE_ID", `${path}.id`, "must be a canonical adapter identifier.");
    return { kind: "adapter", id: adapterId };
  }
  fail("CUT_OTIO_PROFILE_TYPE", `${path}.kind`, "must be cut-roundtrip, generic-otio, or adapter.");
}

function parseLoss(value: unknown, path: string): CutOtioEditorialLoss {
  const item = closed(value, path, ["code", "category", "disposition", "target", "subject", "message"]);
  const code = boundedText(item.code, `${path}.code`);
  if (!lossCodePattern.test(code)) fail("CUT_OTIO_PROFILE_TYPE", `${path}.code`, "must be a CUT_OTIO_* diagnostic code.");
  if (typeof item.category !== "string" || !lossCategories.has(item.category)) fail("CUT_OTIO_PROFILE_TYPE", `${path}.category`, "is not a supported loss category.");
  if (typeof item.disposition !== "string" || !lossDispositions.has(item.disposition)) fail("CUT_OTIO_PROFILE_TYPE", `${path}.disposition`, "is not a supported loss disposition.");
  const subject = closed(item.subject, `${path}.subject`, ["kind", "id"]);
  const subjectKinds = new Set(["composition", "track", "item", "link-group", "linked-cut", "transition", "nesting"]);
  if (typeof subject.kind !== "string" || !subjectKinds.has(subject.kind)) fail("CUT_OTIO_PROFILE_TYPE", `${path}.subject.kind`, "is not a supported subject kind.");
  return {
    code,
    category: item.category as CutOtioEditorialLoss["category"],
    disposition: item.disposition as CutOtioEditorialLoss["disposition"],
    target: parseLossTarget(item.target, `${path}.target`),
    subject: { kind: subject.kind as CutOtioEditorialLoss["subject"]["kind"], id: id(subject.id, `${path}.subject.id`) },
    message: boundedText(item.message, `${path}.message`),
  };
}

function parseBody(value: unknown): CutOtioEditorialProfileBody {
  const profile = closed(value, "$", ["format", "version", "compositionId", "duration", "tracks", "linkGroups", "linkedCuts", "transitions", "losses"]);
  if (profile.format !== cutOtioEditorialProfileFormat || profile.version !== cutOtioEditorialProfileVersion) {
    fail("CUT_OTIO_PROFILE_VERSION", "$", `requires ${cutOtioEditorialProfileFormat} v${cutOtioEditorialProfileVersion}.`);
  }
  const tracks = list(profile.tracks, "$.tracks", cutOtioEditorialProfileLimits.maximumTracks, 1)
    .map((entry, index) => parseTrack(entry, `$.tracks[${index}]`));
  const itemCount = tracks.reduce((total, track) => total + track.items.length, 0);
  if (itemCount > cutOtioEditorialProfileLimits.maximumItems) fail("CUT_OTIO_PROFILE_BUDGET", "$.tracks", `contains more than ${cutOtioEditorialProfileLimits.maximumItems} total items.`);
  return {
    format: cutOtioEditorialProfileFormat,
    version: cutOtioEditorialProfileVersion,
    compositionId: id(profile.compositionId, "$.compositionId"),
    duration: exactRational(profile.duration, "$.duration", "positive"),
    tracks,
    linkGroups: list(profile.linkGroups, "$.linkGroups", cutOtioEditorialProfileLimits.maximumLinkGroups)
      .map((entry, index) => parseLinkGroup(entry, `$.linkGroups[${index}]`)),
    linkedCuts: list(profile.linkedCuts, "$.linkedCuts", cutOtioEditorialProfileLimits.maximumLinkedCuts)
      .map((entry, index) => parseLinkedCut(entry, `$.linkedCuts[${index}]`)),
    transitions: list(profile.transitions, "$.transitions", cutOtioEditorialProfileLimits.maximumTransitions)
      .map((entry, index) => parseTransition(entry, `$.transitions[${index}]`)),
    losses: list(profile.losses, "$.losses", cutOtioEditorialProfileLimits.maximumLosses)
      .map((entry, index) => parseLoss(entry, `$.losses[${index}]`)),
  };
}

function registerIdentity(registry: Map<string, string>, value: string, path: string, kind: string) {
  const previous = registry.get(value);
  if (previous) fail("CUT_OTIO_PROFILE_DUPLICATE", path, `${kind} identifier ${JSON.stringify(value)} is already owned by ${previous}.`);
  registry.set(value, `${kind} at ${path}`);
}

function linkedItem(item: CutOtioEditorialItem, path: string): Extract<CutOtioEditorialItem, { kind: "clip" }> & { link: Extract<CutOtioEditorialLink, { kind: "linked" }> } {
  if (item.kind !== "clip" || item.link.kind !== "linked") fail("CUT_OTIO_PROFILE_REFERENCE", path, "must reference an explicitly linked clip item.");
  return item as Extract<CutOtioEditorialItem, { kind: "clip" }> & { link: Extract<CutOtioEditorialLink, { kind: "linked" }> };
}

function assertTrackPair(
  owners: Map<string, ItemOwner>,
  outgoingId: string,
  incomingId: string,
  kind: "Video" | "Audio",
  at: Rational,
  path: string,
) {
  const outgoing = owners.get(outgoingId), incoming = owners.get(incomingId);
  if (!outgoing) fail("CUT_OTIO_PROFILE_REFERENCE", `${path}.outgoingItemId`, `references unknown item ${JSON.stringify(outgoingId)}.`);
  if (!incoming) fail("CUT_OTIO_PROFILE_REFERENCE", `${path}.incomingItemId`, `references unknown item ${JSON.stringify(incomingId)}.`);
  if (outgoing.track.kind !== kind || incoming.track.kind !== kind || outgoing.track.id !== incoming.track.id) {
    fail("CUT_OTIO_PROFILE_REFERENCE", path, `must reference two items on the same ${kind} track.`);
  }
  if (incoming.index !== outgoing.index + 1) fail("CUT_OTIO_PROFILE_REFERENCE", path, "must reference directly adjacent outgoing and incoming items.");
  if (!sameRational(intervalEnd(outgoing.item.destination), at) || !sameRational(incoming.item.destination.start, at)) {
    fail("CUT_OTIO_PROFILE_TIMING", `${path}.at`, "must equal the outgoing destination end and incoming destination start.");
  }
  return { outgoing, incoming };
}

function mappedHandleDuration(item: CutOtioEditorialItem, destinationDuration: Rational, path: string) {
  if (item.kind !== "clip") fail("CUT_OTIO_PROFILE_REFERENCE", path, "transition handles require ordinary clip items.");
  if (item.retime.kind === "identity") return destinationDuration;
  if (item.retime.direction === "reverse") fail("CUT_OTIO_PROFILE_TIMING", path, "transition handles on reverse constant retimes are not supported by profile v2.");
  return multiplyRational(destinationDuration, item.retime.rate);
}

function validateTransition(
  transition: CutOtioEditorialTransition,
  index: number,
  tracks: Map<string, CutOtioEditorialTrack>,
  owners: Map<string, ItemOwner>,
) {
  const path = `$.transitions[${index}]`, track = tracks.get(transition.trackId);
  if (!track) fail("CUT_OTIO_PROFILE_REFERENCE", `${path}.trackId`, `references unknown track ${JSON.stringify(transition.trackId)}.`);
  const expectedKind = transition.mapping.kind === "picture" ? "Video" : "Audio";
  if (track.kind !== expectedKind) fail("CUT_OTIO_PROFILE_REFERENCE", `${path}.mapping.kind`, `does not match ${track.kind} track ${JSON.stringify(track.id)}.`);
  const pair = assertTrackPair(owners, transition.outgoingItemId, transition.incomingItemId, expectedKind, transition.cut, path);
  if (pair.outgoing.track.id !== track.id) fail("CUT_OTIO_PROFILE_REFERENCE", `${path}.trackId`, "does not own the referenced transition items.");
  if (pair.outgoing.item.kind !== "clip" || pair.incoming.item.kind !== "clip") {
    fail("CUT_OTIO_PROFILE_REFERENCE", path, "transition endpoints must be ordinary clips, not gaps or nested sequences.");
  }
  const half = divideRational(transition.duration, rational(2));
  const expectedOverlap = { start: subtractRational(transition.cut, half), duration: transition.duration };
  if (compareRational(expectedOverlap.start, zeroRational) < 0 || !sameInterval(transition.overlap, expectedOverlap)) {
    fail("CUT_OTIO_PROFILE_TIMING", `${path}.overlap`, "must be the exact centered overlap around the hard cut.");
  }
  if (compareRational(half, pair.outgoing.item.destination.duration) > 0 || compareRational(half, pair.incoming.item.destination.duration) > 0) {
    fail("CUT_OTIO_PROFILE_TIMING", `${path}.duration`, "centered overlap exceeds one of the adjacent destination intervals.");
  }
  const outgoingDuration = mappedHandleDuration(pair.outgoing.item, half, `${path}.outgoingSource`);
  const incomingDuration = mappedHandleDuration(pair.incoming.item, half, `${path}.incomingSource`);
  if (!sameRational(transition.outgoingSource.duration, outgoingDuration)
    || !sameRational(transition.outgoingSource.start, intervalEnd(pair.outgoing.item.source))) {
    fail("CUT_OTIO_PROFILE_TIMING", `${path}.outgoingSource`, "must be the exact source tail handle immediately after the outgoing visible source.");
  }
  if (!sameRational(transition.incomingSource.duration, incomingDuration)
    || !sameRational(intervalEnd(transition.incomingSource), pair.incoming.item.source.start)) {
    fail("CUT_OTIO_PROFILE_TIMING", `${path}.incomingSource`, "must be the exact source head handle immediately before the incoming visible source.");
  }
}

function validateRelationships(body: CutOtioEditorialProfileBody) {
  const identities = new Map<string, string>(), tracks = new Map<string, CutOtioEditorialTrack>(), owners = new Map<string, ItemOwner>();
  registerIdentity(identities, body.compositionId, "$.compositionId", "composition");
  body.tracks.forEach((track, trackIndex) => {
    const path = `$.tracks[${trackIndex}]`;
    if (track.order !== trackIndex) fail("CUT_OTIO_PROFILE_REFERENCE", `${path}.order`, "must exactly equal the native OTIO track array index.");
    registerIdentity(identities, track.id, `${path}.id`, "track");
    tracks.set(track.id, track);
    let cursor = zeroRational;
    track.items.forEach((item, itemIndex) => {
      const itemPath = `${path}.items[${itemIndex}]`;
      if (item.order !== itemIndex) fail("CUT_OTIO_PROFILE_REFERENCE", `${itemPath}.order`, "must exactly equal the native OTIO child array index.");
      registerIdentity(identities, item.id, `${itemPath}.id`, "item");
      owners.set(item.id, { track, index: itemIndex, item });
      if (!sameRational(item.destination.start, cursor)) {
        fail("CUT_OTIO_PROFILE_TIMING", `${itemPath}.destination.start`, "must equal the preceding item end; every gap must be explicit.");
      }
      cursor = intervalEnd(item.destination);
      if (compareRational(cursor, body.duration) > 0) fail("CUT_OTIO_PROFILE_TIMING", `${itemPath}.destination`, "extends beyond the composition duration.");
      if (item.kind === "clip") {
        const expectedSourceDuration = item.retime.kind === "identity"
          ? item.destination.duration
          : multiplyRational(item.destination.duration, item.retime.rate);
        if (!sameRational(item.source.duration, expectedSourceDuration)) {
          fail("CUT_OTIO_PROFILE_TIMING", `${itemPath}.source.duration`, "must equal destination duration multiplied by the exact constant rate.");
        }
      } else if (item.kind === "nested-sequence") {
        registerIdentity(identities, item.nesting.instanceId, `${itemPath}.nesting.instanceId`, "nesting instance");
        if (!sameInterval(item.source, item.nesting.sourceRange)) fail("CUT_OTIO_PROFILE_TIMING", `${itemPath}.nesting.sourceRange`, "must exactly equal the nested item source interval.");
        if (item.nesting.ancestry[0] !== body.compositionId) fail("CUT_OTIO_PROFILE_REFERENCE", `${itemPath}.nesting.ancestry[0]`, "must name the root profile composition.");
        if (!sameRational(item.source.duration, item.destination.duration)) fail("CUT_OTIO_PROFILE_TIMING", `${itemPath}.source.duration`, "identity nested source and destination durations must match.");
      }
    });
    if (!sameRational(cursor, body.duration)) fail("CUT_OTIO_PROFILE_TIMING", `${path}.items`, "must span the exact composition duration, including explicit trailing gaps.");
  });

  const linkedMembers = new Set<string>(), groups = new Map<string, CutOtioEditorialLinkGroup>();
  body.linkGroups.forEach((group, groupIndex) => {
    const path = `$.linkGroups[${groupIndex}]`;
    registerIdentity(identities, group.id, `${path}.id`, "link group");
    groups.set(group.id, group);
    group.segments.forEach((segment, segmentIndex) => {
      const segmentPath = `${path}.segments[${segmentIndex}]`;
      registerIdentity(identities, segment.id, `${segmentPath}.id`, "link segment");
      const pictureOwner = owners.get(segment.pictureItemId), audioOwner = owners.get(segment.audioItemId);
      if (!pictureOwner) fail("CUT_OTIO_PROFILE_REFERENCE", `${segmentPath}.pictureItemId`, `references unknown item ${JSON.stringify(segment.pictureItemId)}.`);
      if (!audioOwner) fail("CUT_OTIO_PROFILE_REFERENCE", `${segmentPath}.audioItemId`, `references unknown item ${JSON.stringify(segment.audioItemId)}.`);
      if (pictureOwner.track.kind !== "Video" || audioOwner.track.kind !== "Audio") {
        fail("CUT_OTIO_PROFILE_REFERENCE", segmentPath, "must pair one Video clip and one Audio clip.");
      }
      const picture = linkedItem(pictureOwner.item, `${segmentPath}.pictureItemId`);
      const audio = linkedItem(audioOwner.item, `${segmentPath}.audioItemId`);
      for (const [member, memberPath] of [[picture, `${segmentPath}.pictureItemId`], [audio, `${segmentPath}.audioItemId`]] as const) {
        if (member.link.groupId !== group.id || member.link.segmentId !== segment.id) {
          fail("CUT_OTIO_PROFILE_REFERENCE", memberPath, "item link metadata does not match this group and segment.");
        }
        if (linkedMembers.has(member.id)) fail("CUT_OTIO_PROFILE_DUPLICATE", memberPath, `linked item ${JSON.stringify(member.id)} belongs to more than one segment.`);
        linkedMembers.add(member.id);
      }
    });
  });
  for (const [itemId, owner] of owners) {
    if (owner.item.kind === "clip" && owner.item.link.kind === "linked" && !linkedMembers.has(itemId)) {
      fail("CUT_OTIO_PROFILE_REFERENCE", `$.tracks[${owner.track.order}].items[${owner.index}].link`, "does not have one matching link-group segment.");
    }
  }

  const linkedCuts = new Map<string, CutOtioEditorialLinkedCut>();
  body.linkedCuts.forEach((cut, cutIndex) => {
    const path = `$.linkedCuts[${cutIndex}]`;
    registerIdentity(identities, cut.id, `${path}.id`, "linked cut");
    linkedCuts.set(cut.id, cut);
    if (!groups.has(cut.groupId)) fail("CUT_OTIO_PROFILE_REFERENCE", `${path}.groupId`, `references unknown link group ${JSON.stringify(cut.groupId)}.`);
    const picture = assertTrackPair(owners, cut.picture.outgoingItemId, cut.picture.incomingItemId, "Video", cut.picture.at, `${path}.picture`);
    const audio = assertTrackPair(owners, cut.audio.outgoingItemId, cut.audio.incomingItemId, "Audio", cut.audio.at, `${path}.audio`);
    const pictureOutgoing = linkedItem(picture.outgoing.item, `${path}.picture.outgoingItemId`);
    const pictureIncoming = linkedItem(picture.incoming.item, `${path}.picture.incomingItemId`);
    const audioOutgoing = linkedItem(audio.outgoing.item, `${path}.audio.outgoingItemId`);
    const audioIncoming = linkedItem(audio.incoming.item, `${path}.audio.incomingItemId`);
    const members = [pictureOutgoing, pictureIncoming, audioOutgoing, audioIncoming];
    if (members.some((member) => member.link.groupId !== cut.groupId)) fail("CUT_OTIO_PROFILE_REFERENCE", `${path}.groupId`, "does not own all four linked-cut endpoint items.");
    if (pictureOutgoing.link.segmentId !== audioOutgoing.link.segmentId
      || pictureIncoming.link.segmentId !== audioIncoming.link.segmentId
      || pictureOutgoing.link.segmentId === pictureIncoming.link.segmentId) {
      fail("CUT_OTIO_PROFILE_REFERENCE", path, "outgoing and incoming A/V endpoints must identify two corresponding, distinct link segments.");
    }
    const ordering = compareRational(cut.picture.at, cut.audio.at);
    if ((cut.kind === "j-cut" && ordering <= 0) || (cut.kind === "l-cut" && ordering >= 0)) {
      fail("CUT_OTIO_PROFILE_TIMING", path, cut.kind === "j-cut"
        ? "requires the audio cut before the picture cut."
        : "requires the picture cut before the audio cut.");
    }
  });

  const transitions = new Map<string, CutOtioEditorialTransition>();
  body.transitions.forEach((transition, transitionIndex) => {
    const path = `$.transitions[${transitionIndex}]`;
    registerIdentity(identities, transition.id, `${path}.id`, "transition");
    transitions.set(transition.id, transition);
    validateTransition(transition, transitionIndex, tracks, owners);
  });
  for (const track of body.tracks) {
    const ordered = body.transitions
      .filter((transition) => transition.trackId === track.id)
      .sort((left, right) => compareRational(left.overlap.start, right.overlap.start));
    for (let index = 1; index < ordered.length; index += 1) {
      if (compareRational(ordered[index].overlap.start, intervalEnd(ordered[index - 1].overlap)) < 0) {
        fail("CUT_OTIO_PROFILE_TIMING", "$.transitions", `transition ${JSON.stringify(ordered[index].id)} overlaps another transition on track ${JSON.stringify(track.id)}.`);
      }
    }
  }

  const lossIdentities = new Set<string>();
  body.losses.forEach((loss, lossIndex) => {
    const path = `$.losses[${lossIndex}]`, target = loss.target.kind === "adapter" ? `adapter:${loss.target.id}` : loss.target.kind;
    const identity = stableJsonStringify({ code: loss.code, target, subject: loss.subject, disposition: loss.disposition });
    if (lossIdentities.has(identity)) fail("CUT_OTIO_PROFILE_DUPLICATE", path, "duplicates a target-scoped loss identity.");
    lossIdentities.add(identity);
    let exists = false;
    if (loss.subject.kind === "composition") exists = loss.subject.id === body.compositionId;
    else if (loss.subject.kind === "track") exists = tracks.has(loss.subject.id);
    else if (loss.subject.kind === "item") exists = owners.has(loss.subject.id);
    else if (loss.subject.kind === "link-group") exists = groups.has(loss.subject.id);
    else if (loss.subject.kind === "linked-cut") exists = linkedCuts.has(loss.subject.id);
    else if (loss.subject.kind === "transition") exists = transitions.has(loss.subject.id);
    else {
      exists = [...owners.values()].some((owner) => owner.item.kind === "nested-sequence" && owner.item.nesting.instanceId === loss.subject.id);
    }
    if (!exists) fail("CUT_OTIO_PROFILE_REFERENCE", `${path}.subject.id`, `does not identify an existing ${loss.subject.kind}.`);
  });
}

function canonicalClone<T>(value: T): T {
  return JSON.parse(stableJsonStringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value as Record<string, unknown>).forEach(deepFreeze);
  }
  return value;
}

function bodyFromProfile(profile: CutOtioEditorialProfile): CutOtioEditorialProfileBody {
  return {
    format: profile.format,
    version: profile.version,
    compositionId: profile.compositionId,
    duration: profile.duration,
    tracks: profile.tracks,
    linkGroups: profile.linkGroups,
    linkedCuts: profile.linkedCuts,
    transitions: profile.transitions,
    losses: profile.losses,
  };
}

function sortedById<T extends { id: string }>(values: readonly T[]) {
  return [...values].sort((left, right) => left.id.localeCompare(right.id));
}

function semanticProjection(body: CutOtioEditorialProfileBody) {
  return {
    ...body,
    linkGroups: sortedById(body.linkGroups).map((group) => ({ ...group, segments: sortedById(group.segments) })),
    linkedCuts: sortedById(body.linkedCuts),
    transitions: sortedById(body.transitions),
    losses: [...body.losses].sort((left, right) => stableJsonStringify(left).localeCompare(stableJsonStringify(right))),
  };
}

function semanticHash(body: CutOtioEditorialProfileBody) {
  return createHash("sha256").update(stableJsonStringify(semanticProjection(body))).digest("hex");
}

/**
 * Validate, canonicalize, hash, and freeze a profile body before embedding it
 * into OTIO metadata. Callers cannot supply their own digest to this path.
 */
export function createCutOtioEditorialProfile(value: unknown): CutOtioEditorialProfile {
  const body = parseBody(value);
  validateRelationships(body);
  const canonical = canonicalClone(body);
  return deepFreeze({ ...canonical, semanticSha256: semanticHash(canonical) });
}

/**
 * Parse an embedded profile. The declared semantic hash is mandatory and any
 * shape, reference, timing, or digest disagreement is a hard refusal.
 */
export function validateCutOtioEditorialProfile(value: unknown): CutOtioEditorialProfile {
  const profile = closed(value, "$", [
    "format", "version", "compositionId", "duration", "tracks", "linkGroups",
    "linkedCuts", "transitions", "losses", "semanticSha256",
  ]);
  const body = parseBody({
    format: profile.format,
    version: profile.version,
    compositionId: profile.compositionId,
    duration: profile.duration,
    tracks: profile.tracks,
    linkGroups: profile.linkGroups,
    linkedCuts: profile.linkedCuts,
    transitions: profile.transitions,
    losses: profile.losses,
  });
  validateRelationships(body);
  const expected = semanticHash(body), observed = digest(profile.semanticSha256, "$.semanticSha256");
  if (observed !== expected) fail("CUT_OTIO_PROFILE_HASH", "$.semanticSha256", `does not match canonical editorial semantics; expected ${expected}.`);
  return deepFreeze({ ...canonicalClone(body), semanticSha256: observed });
}

export function cutOtioEditorialSemanticSha256(profile: CutOtioEditorialProfile) {
  return semanticHash(bodyFromProfile(profile));
}

function observationFromValidatedProfile(profile: CutOtioEditorialProfile): CutOtioEditorialObservation {
  return deepFreeze(canonicalClone({
    format: cutOtioEditorialObservationFormat,
    version: 1 as const,
    compositionId: profile.compositionId,
    duration: profile.duration,
    tracks: profile.tracks.map((track) => ({
      id: track.id,
      kind: track.kind,
      order: track.order,
      ...(track.role === undefined ? {} : { role: track.role }),
      ...(track.metadata === undefined ? {} : { metadata: track.metadata }),
      items: track.items.map((item) => ({
        id: item.id,
        kind: item.kind,
        order: item.order,
        destination: item.destination,
        source: item.source,
        retime: item.retime,
        nesting: item.nesting,
        ...(item.kind === "clip" && item.role !== undefined ? { role: item.role } : {}),
        ...(item.kind === "clip" && item.metadata !== undefined ? { metadata: item.metadata } : {}),
      })),
    })),
    transitions: profile.transitions,
  }));
}

/**
 * Produce the exact closed projection an OTIO adapter must observe from native
 * Track/Clip/Gap/Transition/TimeEffect/Stack objects before importing links.
 */
export function cutOtioEditorialObservationFromProfile(value: unknown): CutOtioEditorialObservation {
  return observationFromValidatedProfile(validateCutOtioEditorialProfile(value));
}

function parseObservationItem(value: unknown, path: string, trackKind: "Video" | "Audio"): CutOtioEditorialObservationItem {
  const item = closedWithOptional(
    value,
    path,
    ["id", "kind", "order", "destination", "source", "retime", "nesting"],
    ["role", "metadata"],
  );
  if (item.kind !== "clip" && item.kind !== "gap" && item.kind !== "nested-sequence") {
    fail("CUT_OTIO_PROFILE_TYPE", `${path}.kind`, "must be exactly \"clip\", \"gap\", or \"nested-sequence\".");
  }
  if (item.kind === "nested-sequence" && trackKind !== "Video") fail("CUT_OTIO_PROFILE_TYPE", `${path}.kind`, "nested-sequence is supported only on Video tracks.");
  const source = item.source === null ? null : exactInterval(item.source, `${path}.source`);
  const nesting = item.nesting === null ? null : parseNesting(item.nesting, `${path}.nesting`);
  if (item.kind === "gap" && (source !== null || nesting !== null)) fail("CUT_OTIO_PROFILE_TYPE", path, "a native gap must have null source and nesting.");
  if (item.kind === "clip" && (source === null || nesting !== null)) fail("CUT_OTIO_PROFILE_TYPE", path, "a native clip must have source and null nesting.");
  if (item.kind === "nested-sequence" && (source === null || nesting === null)) fail("CUT_OTIO_PROFILE_TYPE", path, "a native nested sequence must have source and nesting.");
  if (item.kind !== "clip" && (item.role !== undefined || item.metadata !== undefined)) {
    fail("CUT_OTIO_PROFILE_TYPE", path, "only native clip observations may carry editorial role or metadata.");
  }
  return {
    id: id(item.id, `${path}.id`),
    kind: item.kind,
    order: exactInteger(item.order, `${path}.order`, cutOtioEditorialProfileLimits.maximumItems - 1),
    destination: exactInterval(item.destination, `${path}.destination`),
    source,
    retime: parseRetime(item.retime, `${path}.retime`),
    nesting,
    ...(item.role === undefined ? {} : { role: editorialRole(item.role, `${path}.role`, trackKind) }),
    ...(item.metadata === undefined ? {} : { metadata: editorialMetadata(item.metadata, `${path}.metadata`) }),
  };
}

function parseObservation(value: unknown): CutOtioEditorialObservation {
  const observation = closed(value, "$", ["format", "version", "compositionId", "duration", "tracks", "transitions"]);
  if (observation.format !== cutOtioEditorialObservationFormat || observation.version !== 1) {
    fail("CUT_OTIO_PROFILE_VERSION", "$", `requires ${cutOtioEditorialObservationFormat} v1.`);
  }
  const tracks = list(observation.tracks, "$.tracks", cutOtioEditorialProfileLimits.maximumTracks, 1).map((entry, trackIndex) => {
    const path = `$.tracks[${trackIndex}]`, track = closedWithOptional(entry, path, ["id", "kind", "order", "items"], ["role", "metadata"]);
    if (track.kind !== "Video" && track.kind !== "Audio") fail("CUT_OTIO_PROFILE_TYPE", `${path}.kind`, "must be exactly \"Video\" or \"Audio\".");
    const trackKind = track.kind as "Video" | "Audio";
    return {
      id: id(track.id, `${path}.id`),
      kind: trackKind,
      order: exactInteger(track.order, `${path}.order`, cutOtioEditorialProfileLimits.maximumTracks - 1),
      ...(track.role === undefined ? {} : { role: editorialRole(track.role, `${path}.role`, trackKind) }),
      ...(track.metadata === undefined ? {} : { metadata: editorialMetadata(track.metadata, `${path}.metadata`) }),
      items: list(track.items, `${path}.items`, cutOtioEditorialProfileLimits.maximumItems)
        .map((item, itemIndex) => parseObservationItem(item, `${path}.items[${itemIndex}]`, trackKind)),
    };
  });
  if (tracks.reduce((total, track) => total + track.items.length, 0) > cutOtioEditorialProfileLimits.maximumItems) {
    fail("CUT_OTIO_PROFILE_BUDGET", "$.tracks", `contains more than ${cutOtioEditorialProfileLimits.maximumItems} total items.`);
  }
  return {
    format: cutOtioEditorialObservationFormat,
    version: 1,
    compositionId: id(observation.compositionId, "$.compositionId"),
    duration: exactRational(observation.duration, "$.duration", "positive"),
    tracks,
    transitions: list(observation.transitions, "$.transitions", cutOtioEditorialProfileLimits.maximumTransitions)
      .map((entry, index) => parseTransition(entry, `$.transitions[${index}]`)),
  };
}

function firstDifference(expected: unknown, observed: unknown, path = "$"): string | null {
  if (Object.is(expected, observed)) return null;
  if (Array.isArray(expected) && Array.isArray(observed)) {
    if (expected.length !== observed.length) return `${path}.length`;
    for (let index = 0; index < expected.length; index += 1) {
      const difference = firstDifference(expected[index], observed[index], `${path}[${index}]`);
      if (difference) return difference;
    }
    return null;
  }
  if (expected && observed && typeof expected === "object" && typeof observed === "object"
    && !Array.isArray(expected) && !Array.isArray(observed)) {
    const expectedKeys = Object.keys(expected as JsonRecord).sort(), observedKeys = Object.keys(observed as JsonRecord).sort();
    if (expectedKeys.length !== observedKeys.length) return path;
    for (let index = 0; index < expectedKeys.length; index += 1) {
      if (expectedKeys[index] !== observedKeys[index]) return path;
      const key = expectedKeys[index];
      const difference = firstDifference((expected as JsonRecord)[key], (observed as JsonRecord)[key], `${path}.${key}`);
      if (difference) return difference;
    }
    return null;
  }
  return path;
}

/**
 * Reconcile embedded CUT metadata against an independently parsed native OTIO
 * observation. A declared profile mismatch is always refused; it is never
 * converted into a lossy generic import.
 */
export function reconcileCutOtioEditorialProfile(
  profileValue: unknown,
  observationValue: unknown,
): CutOtioEditorialReconciliation {
  const profile = validateCutOtioEditorialProfile(profileValue);
  const observed = parseObservation(observationValue);
  const expected = observationFromValidatedProfile(profile);
  const difference = firstDifference(expected, observed);
  if (difference) fail("CUT_OTIO_PROFILE_RECONCILIATION", difference, "native OTIO structure does not match the declared CUT editorial profile.");
  return deepFreeze({
    format: "cut-otio-editorial-reconciliation",
    version: 1,
    status: "pass",
    semanticSha256: profile.semanticSha256,
    compositionId: profile.compositionId,
    tracks: profile.tracks.length,
    items: profile.tracks.reduce((total, track) => total + track.items.length, 0),
    linkGroups: profile.linkGroups.length,
    linkedCuts: profile.linkedCuts.length,
    transitions: profile.transitions.length,
    nestingInstances: profile.tracks.reduce((total, track) => total + track.items.filter((item) => item.kind === "nested-sequence").length, 0),
    targetScopedLosses: profile.losses.length,
  });
}
