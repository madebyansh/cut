import { hash, stableJsonStringify } from "../core/stable";
import type { IRProvenance, IRValue } from "./ir";
import { addRational, compareRational, divideRational, rational, subtractRational, type Rational, zeroRational } from "./rational";

export type AudioEditInterval = { start: Rational; duration: Rational };

/**
 * Stage-1 AudioTrack edits deliberately own only neutral clip controls. This
 * makes unsupported fades, retimes, and overlaps explicit at the algebra
 * boundary instead of silently flattening them while structural edits run.
 */
export type AudioEditClipInputs = {
  resourceId: string;
  /**
   * Relationship-group metadata, not a unique segment identifier. Splitting a
   * clip intentionally preserves this value on every resulting segment.
   * Integration must evolve scene link validation (or derive separate segment
   * identity) instead of dropping or silently renaming the authored group.
   */
  linkId?: string;
  fadeIn?: Rational;
  fadeOut?: Rational;
  rate?: Rational;
  overlap?: Rational;
  /** Declared source media available immediately before/after the visible range. */
  headHandle?: Rational;
  tailHandle?: Rational;
};

export type AudioEditClipItem = {
  origin: string;
  kind: "clip";
  destination: AudioEditInterval;
  source: AudioEditInterval;
  inputs: AudioEditClipInputs;
  linkSegmentId?: string;
  provenance: IRProvenance;
};

export type AudioEditGapItem = {
  origin: string;
  kind: "gap";
  destination: AudioEditInterval;
  inputs: Record<string, never>;
  provenance: IRProvenance;
};

/**
 * One closed processed-region operand. Version 2 plans never slice or
 * materialize these items: they only resolve crossfades against the authored
 * hard-cut topology. Keeping the outer/leaf/processor identities beside the
 * visible ranges makes loaded-IR replay capable of detecting graph swaps.
 */
export type AudioEditRegionItem = {
  origin: string;
  kind: "region";
  regionId: string;
  sourceNodeId: string;
  processorNodeIds: string[];
  destination: AudioEditInterval;
  source: AudioEditInterval;
  inputs: AudioEditClipInputs;
  provenance: IRProvenance;
};

export type AudioEditItem = AudioEditClipItem | AudioEditGapItem | AudioEditRegionItem;

export type AudioEditOperation =
  | { kind: "split"; at: Rational; provenance: IRProvenance }
  | { kind: "trim"; keep: AudioEditInterval; transactionId?: string; provenance: IRProvenance }
  | { kind: "ripple-insert"; at: Rational; item: AudioEditItem; transactionId?: string; provenance: IRProvenance }
  | { kind: "ripple-delete"; range: AudioEditInterval; transactionId?: string; transactionVersion?: 1 | 2; linkSegmentIds?: { before: string; after: string }; provenance: IRProvenance }
  | { kind: "overwrite"; range: AudioEditInterval; item: AudioEditItem; provenance: IRProvenance }
  | { kind: "replace"; range: AudioEditInterval; item: AudioEditItem; provenance: IRProvenance }
  | { kind: "lift"; range: AudioEditInterval; provenance: IRProvenance }
  | { kind: "extract"; range: AudioEditInterval; provenance: IRProvenance }
  | { kind: "slip"; range: AudioEditInterval; by: Rational; provenance: IRProvenance }
  | { kind: "slide"; range: AudioEditInterval; by: Rational; provenance: IRProvenance }
  | { kind: "crossfade"; at: Rational; duration: Rational; curve: AudioEditCrossfadeCurve; provenance: IRProvenance };

export const audioEditCrossfadeCurves = ["equal-power", "linear"] as const;
export type AudioEditCrossfadeCurve = typeof audioEditCrossfadeCurves[number];

/** A crossfade resolved against the fully materialized structural timeline. */
export type AudioEditTrackTransition = {
  cut: Rational;
  duration: Rational;
  overlap: AudioEditInterval;
  outgoingIndex: number;
  incomingIndex: number;
  outgoingOrigin: string;
  incomingOrigin: string;
  outgoingSource: AudioEditInterval;
  incomingSource: AudioEditInterval;
  curve: AudioEditCrossfadeCurve;
  provenance: IRProvenance;
};

export type AudioEditOperationPlanV1 = {
  version: 1;
  sourceDuration: Rational;
  /** Runtime canonicalization closes this to clip/gap variants only. */
  baseItems: AudioEditItem[];
  operations: AudioEditOperation[];
};

export type AudioEditOperationPlanV2 = {
  version: 2;
  sourceDuration: Rational;
  baseItems: AudioEditRegionItem[];
  /** Version 2 is intentionally transition-only; every entry is crossfade. */
  operations: Array<Extract<AudioEditOperation, { kind: "crossfade" }>>;
};

export type AudioEditOperationPlan = AudioEditOperationPlanV1 | AudioEditOperationPlanV2;

export type AudioEditMaterializationIdentity = {
  version: 1;
  duration: Rational;
  items: Array<
    | { kind: "gap"; destination: AudioEditInterval }
    | { kind: "clip"; destination: AudioEditInterval; source: AudioEditInterval; inputs: Pick<AudioEditClipInputs, "resourceId" | "linkId">; linkSegmentId?: string }
  >;
};

export type AudioEditExecution = {
  items: AudioEditItem[];
  transitions: AudioEditTrackTransition[];
  duration: Rational;
  materializationId: string;
};

export type AudioEditExecutionStep = Readonly<{
  operationIndex: number;
  operation: AudioEditOperation;
  items: readonly AudioEditItem[];
}>;

export type AudioEditOperationErrorKind =
  | "shape"
  | "time"
  | "no-op"
  | "unsupported"
  | "result"
  | "limit"
  | "region-topology"
  | "region-handle"
  | "region-automation"
  | "region-plan";
export type AudioEditOperationErrorCode =
  | "CUT_AUDIO_EDIT_SHAPE"
  | "CUT_AUDIO_EDIT_TIME"
  | "CUT_AUDIO_EDIT_NOOP"
  | "CUT_AUDIO_EDIT_UNSUPPORTED"
  | "CUT_AUDIO_EDIT_RESULT"
  | "CUT_AUDIO_EDIT_LIMIT"
  | "CUT_AUDIO_REGION_CROSSFADE_TOPOLOGY"
  | "CUT_AUDIO_REGION_CROSSFADE_HANDLE"
  | "CUT_AUDIO_REGION_CROSSFADE_AUTOMATION"
  | "CUT_AUDIO_REGION_CROSSFADE_PLAN";

const errorCodes: Record<AudioEditOperationErrorKind, AudioEditOperationErrorCode> = {
  shape: "CUT_AUDIO_EDIT_SHAPE",
  time: "CUT_AUDIO_EDIT_TIME",
  "no-op": "CUT_AUDIO_EDIT_NOOP",
  unsupported: "CUT_AUDIO_EDIT_UNSUPPORTED",
  result: "CUT_AUDIO_EDIT_RESULT",
  limit: "CUT_AUDIO_EDIT_LIMIT",
  "region-topology": "CUT_AUDIO_REGION_CROSSFADE_TOPOLOGY",
  "region-handle": "CUT_AUDIO_REGION_CROSSFADE_HANDLE",
  "region-automation": "CUT_AUDIO_REGION_CROSSFADE_AUTOMATION",
  "region-plan": "CUT_AUDIO_REGION_CROSSFADE_PLAN",
};

export class AudioEditOperationError extends Error {
  readonly code: AudioEditOperationErrorCode;

  constructor(
    readonly kind: AudioEditOperationErrorKind,
    message: string,
    readonly path = "$",
    readonly operationIndex?: number,
  ) {
    const code = errorCodes[kind];
    super(`${code} at ${path}: ${message}`);
    this.name = "AudioEditOperationError";
    this.code = code;
  }
}

export type AudioEditOperationLimits = {
  maxOperations: number;
  maxItems: number;
  maxRationalDigits: number;
  maxStringBytes: number;
  maxProvenanceFrames: number;
};

export const defaultAudioEditOperationLimits: Readonly<AudioEditOperationLimits> = Object.freeze({
  maxOperations: 256,
  maxItems: 10_000,
  // These evidence/value ceilings intentionally match the canonical CutAVIR
  // v3 schema and strict loader. A document accepted at the public IR boundary
  // must not become invalid merely because the audio plan is replayed.
  maxRationalDigits: 256,
  maxStringBytes: 1024 * 1024,
  maxProvenanceFrames: 256,
});

type UnknownRecord = Record<string, unknown>;

function fail(kind: AudioEditOperationErrorKind, path: string, message: string, operationIndex?: number): never {
  throw new AudioEditOperationError(kind, message, path, operationIndex);
}

function limits(value: Partial<AudioEditOperationLimits> | undefined): AudioEditOperationLimits {
  const result = { ...defaultAudioEditOperationLimits, ...value };
  for (const [name, amount] of Object.entries(result)) {
    if (!Number.isSafeInteger(amount) || amount < 1) fail("limit", `$.limits.${name}`, "must be a positive safe integer.");
  }
  return result;
}

function ownRecord(value: unknown, path: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("shape", path, "must be a plain object.");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail("shape", path, "must have a plain JSON object prototype.");
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") fail("shape", path, "cannot contain symbol keys.");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) fail("shape", `${path}.${key}`, "accessor properties are not accepted.");
  }
  return value as UnknownRecord;
}

function closed(value: unknown, path: string, required: readonly string[], optional: readonly string[] = []): UnknownRecord {
  const object = ownRecord(value, path), allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => !Object.hasOwn(object, key));
  if (missing.length) fail("shape", path, `is missing required field(s): ${missing.join(", ")}.`);
  const extras = Object.keys(object).filter((key) => !allowed.has(key));
  if (extras.length) fail("shape", `${path}.${extras[0]}`, `unknown field ${JSON.stringify(extras[0])}.`);
  return object;
}

function array(value: unknown, path: string, maximum: number) {
  if (!Array.isArray(value)) fail("shape", path, "must be an array.");
  if (value.length > maximum) fail("limit", path, `exceeds the ${maximum}-entry budget.`);
  return value;
}

function safeInteger(value: unknown, path: string, minimum: number) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) fail("shape", path, `must be a safe integer >= ${minimum}.`);
  return value;
}

function text(value: unknown, path: string, activeLimits: AudioEditOperationLimits) {
  if (typeof value !== "string" || !value.length || value.includes("\0")) {
    fail("shape", path, "must be a non-empty string without NUL bytes.");
  }
  if (new TextEncoder().encode(value).byteLength > activeLimits.maxStringBytes) fail("limit", path, `exceeds the ${activeLimits.maxStringBytes}-byte string budget.`);
  return value;
}

function safeEntityId(value: unknown, path: string, activeLimits: AudioEditOperationLimits) {
  const id = text(value, path, activeLimits);
  if (id !== id.trim() || id.length > 512 || /[\u0000-\u001f\u007f]/u.test(id) || ["__proto__", "prototype", "constructor"].includes(id)) {
    fail("shape", path, "must be a non-empty safe CUT entity id of at most 512 characters without control characters.");
  }
  return id;
}

function exactRational(value: unknown, path: string, activeLimits: AudioEditOperationLimits): Rational {
  const object = closed(value, path, ["numerator", "denominator"]);
  if (typeof object.numerator !== "string" || !/^-?(?:0|[1-9]\d*)$/u.test(object.numerator) || object.numerator === "-0") {
    fail("shape", `${path}.numerator`, "must be a canonical base-10 integer string.");
  }
  if (typeof object.denominator !== "string" || !/^[1-9]\d*$/u.test(object.denominator)) {
    fail("shape", `${path}.denominator`, "must be a canonical positive base-10 integer string.");
  }
  const numeratorDigits = object.numerator.replace("-", "").length;
  if (numeratorDigits > activeLimits.maxRationalDigits || object.denominator.length > activeLimits.maxRationalDigits) {
    fail("limit", path, `rational exceeds the ${activeLimits.maxRationalDigits}-digit component budget.`);
  }
  const canonical = rational(object.numerator, object.denominator);
  if (canonical.numerator !== object.numerator || canonical.denominator !== object.denominator) fail("shape", path, "must be reduced to canonical form.");
  return canonical;
}

function positiveRational(value: unknown, path: string, activeLimits: AudioEditOperationLimits) {
  const result = exactRational(value, path, activeLimits);
  if (compareRational(result, zeroRational) <= 0) fail("time", path, "must be positive.");
  return result;
}

function interval(value: unknown, path: string, activeLimits: AudioEditOperationLimits): AudioEditInterval {
  const object = closed(value, path, ["start", "duration"]);
  const start = exactRational(object.start, `${path}.start`, activeLimits);
  const duration = positiveRational(object.duration, `${path}.duration`, activeLimits);
  if (compareRational(start, zeroRational) < 0) fail("time", `${path}.start`, "cannot be negative.");
  return { start, duration };
}

function sourcePosition(value: unknown, path: string) {
  const object = closed(value, path, ["offset", "line", "column"]);
  return {
    offset: safeInteger(object.offset, `${path}.offset`, 0),
    line: safeInteger(object.line, `${path}.line`, 1),
    column: safeInteger(object.column, `${path}.column`, 1),
  };
}

function sourceSpan(value: unknown, path: string) {
  const object = closed(value, path, ["start", "end"]);
  const start = sourcePosition(object.start, `${path}.start`), end = sourcePosition(object.end, `${path}.end`);
  if (end.offset < start.offset || end.line < start.line || (end.line === start.line && end.column < start.column)) {
    fail("shape", path, "end position cannot precede start position.");
  }
  return { start, end };
}

function provenance(value: unknown, path: string, activeLimits: AudioEditOperationLimits): IRProvenance {
  const object = closed(value, path, ["module", "span"], ["symbol", "expandedFrom"]);
  const moduleName = text(object.module, `${path}.module`, activeLimits), span = sourceSpan(object.span, `${path}.span`);
  const symbol = Object.hasOwn(object, "symbol") ? text(object.symbol, `${path}.symbol`, activeLimits) : undefined;
  let expandedFrom: IRProvenance["expandedFrom"];
  if (Object.hasOwn(object, "expandedFrom")) {
    expandedFrom = array(object.expandedFrom, `${path}.expandedFrom`, activeLimits.maxProvenanceFrames).map((frame, index) => {
      const framePath = `${path}.expandedFrom[${index}]`, record = closed(frame, framePath, ["module", "span", "symbol"]);
      return {
        module: text(record.module, `${framePath}.module`, activeLimits),
        span: sourceSpan(record.span, `${framePath}.span`),
        symbol: text(record.symbol, `${framePath}.symbol`, activeLimits),
      };
    });
  }
  return { module: moduleName, span, ...(symbol ? { symbol } : {}), ...(expandedFrom?.length ? { expandedFrom } : {}) };
}

function sameRational(left: Rational, right: Rational) { return compareRational(left, right) === 0; }
function intervalEnd(value: AudioEditInterval) { return addRational(value.start, value.duration); }
function sameInterval(left: AudioEditInterval, right: AudioEditInterval) { return sameRational(left.start, right.start) && sameRational(left.duration, right.duration); }

function clipInputs(value: unknown, path: string, activeLimits: AudioEditOperationLimits): AudioEditClipInputs {
  const object = closed(value, path, ["resourceId"], ["linkId", "fadeIn", "fadeOut", "rate", "overlap", "headHandle", "tailHandle"]);
  const resourceId = text(object.resourceId, `${path}.resourceId`, activeLimits);
  const linkId = Object.hasOwn(object, "linkId") ? text(object.linkId, `${path}.linkId`, activeLimits) : undefined;
  for (const name of ["fadeIn", "fadeOut", "overlap"] as const) {
    if (!Object.hasOwn(object, name)) continue;
    const amount = exactRational(object[name], `${path}.${name}`, activeLimits);
    if (compareRational(amount, zeroRational) < 0) fail("time", `${path}.${name}`, "cannot be negative.");
    if (!sameRational(amount, zeroRational)) fail("unsupported", `${path}.${name}`, `${name} must be zero in the bounded AudioTrack edit algebra; preserve the processor graph outside this operation plan.`);
  }
  if (Object.hasOwn(object, "rate")) {
    const rate = exactRational(object.rate, `${path}.rate`, activeLimits);
    if (compareRational(rate, zeroRational) <= 0) fail("time", `${path}.rate`, "must be positive.");
    if (!sameRational(rate, rational(1))) fail("unsupported", `${path}.rate`, "retimed audio is not accepted by the one-to-one AudioTrack edit algebra.");
  }
  const handles: Partial<Pick<AudioEditClipInputs, "headHandle" | "tailHandle">> = {};
  for (const name of ["headHandle", "tailHandle"] as const) {
    if (!Object.hasOwn(object, name)) continue;
    const amount = exactRational(object[name], `${path}.${name}`, activeLimits);
    if (compareRational(amount, zeroRational) < 0) fail("time", `${path}.${name}`, "cannot be negative.");
    if (!sameRational(amount, zeroRational)) handles[name] = amount;
  }
  // Neutral controls are canonicalized away. Omitted and explicit neutral
  // values therefore have one materialization identity.
  return { resourceId, ...(linkId ? { linkId } : {}), ...handles };
}

function canonicalItem(
  value: unknown,
  path: string,
  activeLimits: AudioEditOperationLimits,
  expectedOrigin?: string,
): AudioEditItem {
  const discriminator = ownRecord(value, path).kind;
  if (discriminator !== "clip" && discriminator !== "gap") fail("shape", `${path}.kind`, "must be exactly clip or gap.");
  const object = discriminator === "clip"
    ? closed(value, path, ["origin", "kind", "destination", "source", "inputs", "provenance"], ["linkSegmentId"])
    : closed(value, path, ["origin", "kind", "destination", "inputs", "provenance"]);
  const origin = text(object.origin, `${path}.origin`, activeLimits);
  if (expectedOrigin !== undefined && origin !== expectedOrigin) fail("shape", `${path}.origin`, `must be the canonical origin ${JSON.stringify(expectedOrigin)}.`);
  const destination = interval(object.destination, `${path}.destination`, activeLimits);
  const itemProvenance = provenance(object.provenance, `${path}.provenance`, activeLimits);
  if (discriminator === "gap") {
    closed(object.inputs, `${path}.inputs`, []);
    return { origin, kind: "gap", destination, inputs: {}, provenance: itemProvenance };
  }
  const source = interval(object.source, `${path}.source`, activeLimits);
  if (!sameRational(source.duration, destination.duration)) {
    fail("unsupported", path, "clip source and destination durations must match exactly; fades, retimes, and overlaps require a later explicit algebra.");
  }
  // This pure layer has no locked media probe. It proves non-negative exact
  // mapping; integration remains responsible for checking every materialized
  // source end against the selected locked stream's sample-domain upper bound.
  const inputs = clipInputs(object.inputs, `${path}.inputs`, activeLimits);
  const linkSegmentId = Object.hasOwn(object, "linkSegmentId")
    ? safeEntityId(object.linkSegmentId, `${path}.linkSegmentId`, activeLimits)
    : undefined;
  if (linkSegmentId && !inputs.linkId) fail("shape", `${path}.linkSegmentId`, "requires authored linkId relationship metadata.");
  return { origin, kind: "clip", destination, source, inputs, ...(linkSegmentId ? { linkSegmentId } : {}), provenance: itemProvenance };
}

function canonicalRegionItem(
  value: unknown,
  path: string,
  activeLimits: AudioEditOperationLimits,
  expectedOrigin?: string,
): AudioEditRegionItem {
  const object = closed(value, path, [
    "origin",
    "kind",
    "regionId",
    "sourceNodeId",
    "processorNodeIds",
    "destination",
    "source",
    "inputs",
    "provenance",
  ]);
  if (object.kind !== "region") fail("region-plan", `${path}.kind`, "version 2 base items must be processed AudioRegions.");
  const origin = text(object.origin, `${path}.origin`, activeLimits);
  if (expectedOrigin !== undefined && origin !== expectedOrigin) fail("region-plan", `${path}.origin`, `must be the canonical origin ${JSON.stringify(expectedOrigin)}.`);
  const regionId = safeEntityId(object.regionId, `${path}.regionId`, activeLimits);
  const sourceNodeId = safeEntityId(object.sourceNodeId, `${path}.sourceNodeId`, activeLimits);
  const processorNodeIds = array(object.processorNodeIds, `${path}.processorNodeIds`, 32)
    .map((id, index) => safeEntityId(id, `${path}.processorNodeIds[${index}]`, activeLimits));
  if (new Set(processorNodeIds).size !== processorNodeIds.length
    || processorNodeIds.includes(regionId)
    || processorNodeIds.includes(sourceNodeId)
    || regionId === sourceNodeId) {
    fail("region-plan", `${path}.processorNodeIds`, "region, source leaf, and ordered processor identities must be distinct.");
  }
  const destination = interval(object.destination, `${path}.destination`, activeLimits);
  const source = interval(object.source, `${path}.source`, activeLimits);
  if (!sameRational(source.duration, destination.duration)) {
    fail("region-topology", path, "AudioRegion visible source and destination durations must match exactly; retime is unsupported.");
  }
  const rawInputs = closed(object.inputs, `${path}.inputs`, ["resourceId"], ["linkId", "headHandle", "tailHandle"]);
  const resourceId = safeEntityId(rawInputs.resourceId, `${path}.inputs.resourceId`, activeLimits);
  const linkId = Object.hasOwn(rawInputs, "linkId") ? text(rawInputs.linkId, `${path}.inputs.linkId`, activeLimits) : undefined;
  const handles: Partial<Pick<AudioEditClipInputs, "headHandle" | "tailHandle">> = {};
  for (const name of ["headHandle", "tailHandle"] as const) {
    if (!Object.hasOwn(rawInputs, name)) continue;
    const amount = exactRational(rawInputs[name], `${path}.inputs.${name}`, activeLimits);
    if (compareRational(amount, zeroRational) < 0) fail("region-handle", `${path}.inputs.${name}`, `${name} cannot be negative.`);
    if (!sameRational(amount, zeroRational)) handles[name] = amount;
  }
  return {
    origin,
    kind: "region",
    regionId,
    sourceNodeId,
    processorNodeIds,
    destination,
    source,
    inputs: { resourceId, ...(linkId ? { linkId } : {}), ...handles },
    provenance: provenance(object.provenance, `${path}.provenance`, activeLimits),
  };
}

function canonicalOperationItem(value: unknown, path: string, index: number, activeLimits: AudioEditOperationLimits) {
  const item = canonicalItem(value, path, activeLimits, `operation:${index}`);
  if (!sameRational(item.destination.start, zeroRational)) {
    fail("shape", `${path}.destination.start`, "operation items use a zero-based local destination interval.", index);
  }
  return item;
}

function canonicalOperation(value: unknown, index: number, activeLimits: AudioEditOperationLimits): AudioEditOperation {
  const path = `$.operations[${index}]`, object = ownRecord(value, path), kind = object.kind;
  if (typeof kind !== "string") fail("shape", `${path}.kind`, "must name an AudioTrack edit operation.", index);
  const operationProvenance = () => provenance(object.provenance, `${path}.provenance`, activeLimits);
  const transactionId = () => {
    const id = object.transactionId === undefined
      ? undefined
      : text(object.transactionId, `${path}.transactionId`, activeLimits);
    if (id !== undefined && (!id || id.length > 512 || /[\u0000-\u001f\u007f]/.test(id) || ["__proto__", "prototype", "constructor"].includes(id))) {
      fail("shape", `${path}.transactionId`, "must be a non-empty safe CUT entity id of at most 512 characters without control characters.", index);
    }
    return id;
  };
  const linkSegmentIds = () => {
    if (!Object.hasOwn(object, "linkSegmentIds")) return undefined;
    const ids = closed(object.linkSegmentIds, `${path}.linkSegmentIds`, ["before", "after"]);
    const before = safeEntityId(ids.before, `${path}.linkSegmentIds.before`, activeLimits);
    const after = safeEntityId(ids.after, `${path}.linkSegmentIds.after`, activeLimits);
    if (before === after) fail("shape", `${path}.linkSegmentIds`, "before and after segment ids must be distinct.", index);
    return { before, after };
  };
  if (kind === "split") {
    closed(value, path, ["kind", "at", "provenance"]);
    return { kind, at: exactRational(object.at, `${path}.at`, activeLimits), provenance: operationProvenance() };
  }
  if (kind === "trim") {
    closed(value, path, ["kind", "keep", "provenance"], ["transactionId"]);
    const id = transactionId();
    return { kind, keep: interval(object.keep, `${path}.keep`, activeLimits), ...(id ? { transactionId: id } : {}), provenance: operationProvenance() };
  }
  if (kind === "ripple-insert") {
    closed(value, path, ["kind", "at", "item", "provenance"], ["transactionId"]);
    const id = transactionId();
    return {
      kind,
      at: exactRational(object.at, `${path}.at`, activeLimits),
      item: canonicalOperationItem(object.item, `${path}.item`, index, activeLimits),
      ...(id ? { transactionId: id } : {}),
      provenance: operationProvenance(),
    };
  }
  if (kind === "overwrite" || kind === "replace") {
    closed(value, path, ["kind", "range", "item", "provenance"]);
    return {
      kind,
      range: interval(object.range, `${path}.range`, activeLimits),
      item: canonicalOperationItem(object.item, `${path}.item`, index, activeLimits),
      provenance: operationProvenance(),
    };
  }
  if (kind === "ripple-delete") {
    closed(value, path, ["kind", "range", "provenance"], ["transactionId", "transactionVersion", "linkSegmentIds"]);
    const id = transactionId();
    const transactionVersion = Object.hasOwn(object, "transactionVersion")
      ? safeInteger(object.transactionVersion, `${path}.transactionVersion`, 1)
      : undefined;
    if (transactionVersion !== undefined && transactionVersion !== 1 && transactionVersion !== 2) {
      fail("shape", `${path}.transactionVersion`, "must be exactly 1 or 2.", index);
    }
    const segmentIds = linkSegmentIds();
    if (!id && (transactionVersion !== undefined || segmentIds)) fail("shape", path, "linked ripple transaction metadata requires one correlated transactionId.", index);
    if (id && transactionVersion === undefined) fail("shape", `${path}.transactionVersion`, "is required with a correlated transactionId.", index);
    if (transactionVersion === 1 && segmentIds) fail("shape", `${path}.linkSegmentIds`, "is not allowed for transactionVersion 1.", index);
    if (transactionVersion === 2 && !segmentIds) fail("shape", `${path}.linkSegmentIds`, "is required for transactionVersion 2.", index);
    return { kind, range: interval(object.range, `${path}.range`, activeLimits), ...(id ? { transactionId: id, transactionVersion: transactionVersion as 1 | 2 } : {}), ...(segmentIds ? { linkSegmentIds: segmentIds } : {}), provenance: operationProvenance() };
  }
  if (kind === "lift" || kind === "extract") {
    closed(value, path, ["kind", "range", "provenance"]);
    return { kind, range: interval(object.range, `${path}.range`, activeLimits), provenance: operationProvenance() };
  }
  if (kind === "slip" || kind === "slide") {
    closed(value, path, ["kind", "range", "by", "provenance"]);
    return {
      kind,
      range: interval(object.range, `${path}.range`, activeLimits),
      by: exactRational(object.by, `${path}.by`, activeLimits),
      provenance: operationProvenance(),
    };
  }
  if (kind === "crossfade") {
    const operation = closed(value, path, ["kind", "at", "duration", "curve", "provenance"]);
    const curve = operation.curve;
    if (typeof curve !== "string" || !audioEditCrossfadeCurves.includes(curve as AudioEditCrossfadeCurve)) {
      fail("unsupported", `${path}.curve`, `must be one of: ${audioEditCrossfadeCurves.join(", ")}.`, index);
    }
    return {
      kind,
      at: exactRational(operation.at, `${path}.at`, activeLimits),
      duration: positiveRational(operation.duration, `${path}.duration`, activeLimits),
      curve: curve as AudioEditCrossfadeCurve,
      provenance: operationProvenance(),
    };
  }
  fail("shape", `${path}.kind`, `unsupported AudioTrack edit operation ${JSON.stringify(kind)}.`, index);
}

function assertBaseCoverage(items: readonly AudioEditItem[], sourceDuration: Rational) {
  let cursor = zeroRational;
  for (const [index, item] of items.entries()) {
    if (!sameRational(item.destination.start, cursor)) fail("shape", `$.baseItems[${index}].destination.start`, "base items must be non-overlapping and contiguous from zero.");
    if (index > 0 && items[index - 1].kind === "gap" && item.kind === "gap") fail("shape", `$.baseItems[${index}]`, "adjacent silence must be represented by one coalesced gap.");
    cursor = intervalEnd(item.destination);
  }
  if (!sameRational(cursor, sourceDuration)) fail("shape", "$.sourceDuration", "base items must fill sourceDuration exactly.");
}

function irTime(value: IRValue | undefined, path: string, operationIndex: number) {
  if (value?.kind !== "quantity" || value.dimension !== "time" || value.unit !== "s") {
    fail("shape", path, "must reduce to a canonical exact Time in seconds.", operationIndex);
  }
  return value.magnitude;
}

function irPositiveTime(value: IRValue | undefined, path: string, operationIndex: number) {
  const result = irTime(value, path, operationIndex);
  if (compareRational(result, zeroRational) <= 0) fail("time", path, "must be positive.", operationIndex);
  return result;
}

function irRange(value: IRValue | undefined, path: string, operationIndex: number): AudioEditInterval {
  if (value?.kind !== "range" || !value.exclusive) {
    fail("shape", path, "must reduce to an exact half-open Range<Time>; use start ..< end.", operationIndex);
  }
  const start = irTime(value.start, `${path}.start`, operationIndex), end = irTime(value.end, `${path}.end`, operationIndex);
  if (compareRational(start, zeroRational) < 0 || compareRational(end, start) <= 0) {
    fail("time", path, "must be positive and cannot begin before zero.", operationIndex);
  }
  return { start, duration: subtractRational(end, start) };
}

function irCallArguments(value: IRValue, op: string, names: readonly string[], operationIndex: number) {
  const path = `$.operations[${operationIndex}]`;
  if (value.kind !== "call" || value.op !== op) fail("shape", path, "must be a supported audio edit operation call.", operationIndex);
  if (value.positional.length > names.length) fail("shape", path, `${op} received too many positional arguments.`, operationIndex);
  for (const key of Object.keys(value.named)) {
    if (!names.includes(key)) fail("shape", `${path}.${key}`, `${op} received unknown argument ${JSON.stringify(key)}.`, operationIndex);
  }
  const result: Record<string, IRValue> = {};
  value.positional.forEach((item, index) => { result[names[index]] = item; });
  for (const [key, item] of Object.entries(value.named)) {
    if (Object.hasOwn(result, key)) fail("shape", `${path}.${key}`, `${op} received argument ${JSON.stringify(key)} more than once.`, operationIndex);
    result[key] = item;
  }
  return result;
}

function irString(value: IRValue | undefined, path: string, operationIndex: number) {
  if (value?.kind !== "string") fail("shape", path, "must reduce to a String literal.", operationIndex);
  return value.value;
}

function irOperationItem(value: IRValue | undefined, operationIndex: number, itemProvenance: IRProvenance): AudioEditItem {
  const path = `$.operations[${operationIndex}].item`, origin = `operation:${operationIndex}`;
  if (!value || value.kind !== "call") fail("shape", path, "must be editAudio(...) or editSilence(...).", operationIndex);
  if (value.op === "cut.edit.audio_value.gap") {
    const args = irCallArguments(value, value.op, ["duration"], operationIndex);
    const duration = irPositiveTime(args.duration, `${path}.duration`, operationIndex);
    return { origin, kind: "gap", destination: { start: zeroRational, duration }, inputs: {}, provenance: itemProvenance };
  }
  if (value.op !== "cut.edit.audio_value.clip") fail("shape", path, "must be editAudio(...) or editSilence(...).", operationIndex);
  const args = irCallArguments(value, value.op, ["source", "range"], operationIndex);
  if (args.source?.kind !== "resource-ref") fail("shape", `${path}.source`, "editAudio source must resolve to an AudioAsset.", operationIndex);
  const source = irRange(args.range, `${path}.range`, operationIndex);
  return {
    origin,
    kind: "clip",
    destination: { start: zeroRational, duration: source.duration },
    source,
    inputs: { resourceId: args.source.id },
    provenance: itemProvenance,
  };
}

/**
 * Decode only the closed audio-prefixed public call vocabulary into the typed
 * operation algebra. The calls are compile-time operands and must disappear
 * before runtime node execution.
 */
export function audioEditOperationsFromInput(value: IRValue | undefined, provenances: readonly IRProvenance[]): AudioEditOperation[] {
  if (value?.kind !== "array" || !value.items.length) fail("shape", "$.operations", "AudioTrack edits must be a non-empty List<AudioEdit>.");
  if (value.items.length !== provenances.length) fail("shape", "$.operations", "AudioTrack edit source provenance must cover every operation.");
  return value.items.map((operation, index): AudioEditOperation => {
    const path = `$.operations[${index}]`, itemProvenance = provenances[index];
    if (operation.kind !== "call") fail("shape", path, "must be a supported audio edit operation call.", index);
    const unaryTime = (op: string, argument: string) => irCallArguments(operation, op, [argument], index);
    if (operation.op === "cut.edit.audio_operation.split") {
      const args = unaryTime(operation.op, "at");
      return { kind: "split", at: irTime(args.at, `${path}.at`, index), provenance: itemProvenance };
    }
    if (operation.op === "cut.edit.audio_operation.trim") {
      const args = unaryTime(operation.op, "keep");
      return { kind: "trim", keep: irRange(args.keep, `${path}.keep`, index), provenance: itemProvenance };
    }
    if (operation.op === "cut.edit.audio_operation.ripple_insert") {
      const args = irCallArguments(operation, operation.op, ["at", "item"], index);
      return { kind: "ripple-insert", at: irTime(args.at, `${path}.at`, index), item: irOperationItem(args.item, index, itemProvenance), provenance: itemProvenance };
    }
    if (operation.op === "cut.edit.audio_operation.ripple_delete") {
      const args = unaryTime(operation.op, "range");
      return { kind: "ripple-delete", range: irRange(args.range, `${path}.range`, index), provenance: itemProvenance };
    }
    if (operation.op === "cut.edit.audio_operation.overwrite" || operation.op === "cut.edit.audio_operation.replace") {
      const args = irCallArguments(operation, operation.op, ["range", "item"], index);
      return {
        kind: operation.op.endsWith("overwrite") ? "overwrite" : "replace",
        range: irRange(args.range, `${path}.range`, index),
        item: irOperationItem(args.item, index, itemProvenance),
        provenance: itemProvenance,
      };
    }
    if (operation.op === "cut.edit.audio_operation.lift" || operation.op === "cut.edit.audio_operation.extract") {
      const args = unaryTime(operation.op, "range"), range = irRange(args.range, `${path}.range`, index);
      return operation.op.endsWith("lift")
        ? { kind: "lift", range, provenance: itemProvenance }
        : { kind: "extract", range, provenance: itemProvenance };
    }
    if (operation.op === "cut.edit.audio_operation.slip" || operation.op === "cut.edit.audio_operation.slide") {
      const args = irCallArguments(operation, operation.op, ["range", "by"], index);
      const range = irRange(args.range, `${path}.range`, index), by = irTime(args.by, `${path}.by`, index);
      return operation.op.endsWith("slip")
        ? { kind: "slip", range, by, provenance: itemProvenance }
        : { kind: "slide", range, by, provenance: itemProvenance };
    }
    if (operation.op === "cut.edit.audio_operation.crossfade") {
      const args = irCallArguments(operation, operation.op, ["at", "duration", "curve"], index);
      const curve = args.curve === undefined ? "equal-power" : irString(args.curve, `${path}.curve`, index);
      if (!audioEditCrossfadeCurves.includes(curve as AudioEditCrossfadeCurve)) {
        fail("unsupported", `${path}.curve`, `audioCrossfadeAt curve must be one of: ${audioEditCrossfadeCurves.join(", ")}.`, index);
      }
      return {
        kind: "crossfade",
        at: irTime(args.at, `${path}.at`, index),
        duration: irPositiveTime(args.duration, `${path}.duration`, index),
        curve: curve as AudioEditCrossfadeCurve,
        provenance: itemProvenance,
      };
    }
    fail("shape", `${path}.op`, `unsupported AudioTrack edit operation ${JSON.stringify(operation.op)}.`, index);
  });
}

export function validateAudioEditOperationPlan(
  value: unknown,
  requestedLimits?: Partial<AudioEditOperationLimits>,
): AudioEditOperationPlan {
  const activeLimits = limits(requestedLimits), object = closed(value, "$", ["version", "sourceDuration", "baseItems", "operations"]);
  if (object.version !== 1 && object.version !== 2) fail("shape", "$.version", "must be exactly 1 or 2.");
  const sourceDuration = positiveRational(object.sourceDuration, "$.sourceDuration", activeLimits);
  const baseValues = array(object.baseItems, "$.baseItems", activeLimits.maxItems);
  if (!baseValues.length) fail("shape", "$.baseItems", "must contain at least one item.");
  const operationValues = array(object.operations, "$.operations", activeLimits.maxOperations);
  if (!operationValues.length) fail("shape", "$.operations", "must contain at least one operation.");
  const operations = operationValues.map((operation, index) => canonicalOperation(operation, index, activeLimits));
  if (object.version === 2) {
    const baseItems = baseValues.map((item, index) => canonicalRegionItem(item, `$.baseItems[${index}]`, activeLimits, `base:${index}`));
    const allNodeIds = baseItems.flatMap((item) => [item.regionId, item.sourceNodeId, ...item.processorNodeIds]);
    if (new Set(allNodeIds).size !== allNodeIds.length) {
      fail("region-topology", "$.baseItems", "AudioRegion transition items must own disjoint outer, processor, and source-leaf identities.");
    }
    const structuralIndex = operations.findIndex((operation) => operation.kind !== "crossfade");
    if (structuralIndex >= 0) {
      fail("region-plan", `$.operations[${structuralIndex}]`, "AudioRegion operation-plan version 2 is transition-only and refuses structural edits.", structuralIndex);
    }
    assertBaseCoverage(baseItems, sourceDuration);
    return { version: 2, sourceDuration, baseItems, operations: operations as AudioEditOperationPlanV2["operations"] };
  }
  const baseItems = baseValues.map((item, index) => canonicalItem(item, `$.baseItems[${index}]`, activeLimits, `base:${index}`));
  assertBaseCoverage(baseItems, sourceDuration);
  return { version: 1, sourceDuration, baseItems, operations };
}

function cloneItem(item: AudioEditItem): AudioEditItem {
  return item.kind === "gap"
    ? { ...item, destination: { ...item.destination }, inputs: {}, provenance: structuredClone(item.provenance) }
    : {
        ...item,
        destination: { ...item.destination },
        source: { ...item.source },
        inputs: { ...item.inputs },
        ...(item.kind === "region" ? { processorNodeIds: [...item.processorNodeIds] } : {}),
        provenance: structuredClone(item.provenance),
      };
}

function segment(
  item: AudioEditItem,
  start: Rational,
  duration: Rational,
  path = "$.result",
  operationProvenance?: IRProvenance,
): AudioEditItem {
  const offset = subtractRational(start, item.destination.start);
  if (compareRational(offset, zeroRational) < 0
    || compareRational(addRational(offset, duration), item.destination.duration) > 0
    || compareRational(duration, zeroRational) <= 0) {
    fail("result", path, "internal segment lies outside its source item.");
  }
  if (item.kind === "gap") return {
    ...cloneItem(item),
    destination: { start, duration },
    ...(operationProvenance ? { provenance: structuredClone(operationProvenance) } : {}),
  };
  const cloned = cloneItem(item) as AudioEditClipItem;
  return {
    ...cloned,
    destination: { start, duration },
    source: { start: addRational(item.source.start, offset), duration },
    ...(operationProvenance ? { provenance: structuredClone(operationProvenance) } : {}),
  };
}

function totalDuration(items: readonly AudioEditItem[]) { return items.length ? intervalEnd(items.at(-1)!.destination) : zeroRational; }

function reflow(items: readonly AudioEditItem[]) {
  let cursor = zeroRational;
  return items.map((item) => {
    const next = cloneItem(item);
    next.destination = { start: cursor, duration: item.destination.duration };
    cursor = addRational(cursor, item.destination.duration);
    return next;
  });
}

function gap(start: Rational, duration: Rational, itemProvenance: IRProvenance, origin: string): AudioEditGapItem {
  return { origin, kind: "gap", destination: { start, duration }, inputs: {}, provenance: structuredClone(itemProvenance) };
}

function enforceItems(items: readonly AudioEditItem[], activeLimits: AudioEditOperationLimits, path: string) {
  if (!items.length) fail("result", path, "must retain a positive explicit track.");
  if (items.length > activeLimits.maxItems) fail("limit", path, `materialization exceeds the ${activeLimits.maxItems}-item budget.`);
}

function coalesceGaps(items: readonly AudioEditItem[], activeLimits: AudioEditOperationLimits, path: string) {
  const result: AudioEditItem[] = [];
  for (const item of reflow(items)) {
    const previous = result.at(-1);
    if (previous?.kind === "gap" && item.kind === "gap") {
      previous.destination.duration = addRational(previous.destination.duration, item.destination.duration);
    } else result.push(cloneItem(item));
  }
  const normalized = reflow(result);
  enforceItems(normalized, activeLimits, path);
  return normalized;
}

function boundary(
  items: readonly AudioEditItem[],
  at: Rational,
  operationIndex: number,
  activeLimits: AudioEditOperationLimits,
  operationProvenance: IRProvenance,
) {
  const path = `$.operations[${operationIndex}]`, duration = totalDuration(items);
  if (compareRational(at, zeroRational) < 0 || compareRational(at, duration) > 0) fail("time", `${path}.at`, "edit point lies outside the current track.", operationIndex);
  const index = items.findIndex((item) => compareRational(at, item.destination.start) > 0 && compareRational(at, intervalEnd(item.destination)) < 0);
  if (index < 0) return { items: items.map(cloneItem), changed: false };
  const item = items[index], left = subtractRational(at, item.destination.start), right = subtractRational(intervalEnd(item.destination), at);
  const result = [
    ...items.slice(0, index).map(cloneItem),
    segment(item, item.destination.start, left, path, operationProvenance),
    segment(item, at, right, path, operationProvenance),
    ...items.slice(index + 1).map(cloneItem),
  ];
  enforceItems(result, activeLimits, path);
  return { items: result, changed: true };
}

function ranged(
  items: readonly AudioEditItem[],
  range: AudioEditInterval,
  operationIndex: number,
  activeLimits: AudioEditOperationLimits,
  operationProvenance: IRProvenance,
) {
  const path = `$.operations[${operationIndex}].range`, duration = totalDuration(items), end = intervalEnd(range);
  if (compareRational(range.start, zeroRational) < 0 || compareRational(end, duration) > 0) fail("time", path, "edit range lies outside the current track.", operationIndex);
  const startBoundary = boundary(items, range.start, operationIndex, activeLimits, operationProvenance);
  const endBoundary = boundary(startBoundary.items, end, operationIndex, activeLimits, operationProvenance);
  const inside = endBoundary.items.filter((item) => compareRational(item.destination.start, range.start) >= 0 && compareRational(intervalEnd(item.destination), end) <= 0);
  if (!inside.length) fail("no-op", path, "edit range selects no timeline material.", operationIndex);
  return { items: endBoundary.items, inside };
}

function markLinkedRippleSegments(
  items: AudioEditItem[],
  inside: readonly AudioEditItem[],
  ids: { before: string; after: string },
  operationIndex: number,
) {
  const path = `$.operations[${operationIndex}].range`;
  if (inside.length !== 1 || inside[0].kind !== "clip") {
    fail("unsupported", path, "partial LinkedRippleDelete must select exactly one direct AudioClip interior.", operationIndex);
  }
  const selectedIndex = items.indexOf(inside[0]);
  const before = items[selectedIndex - 1], after = items[selectedIndex + 1], selected = inside[0];
  const sameLinkedOrigin = (candidate: AudioEditItem | undefined): candidate is AudioEditClipItem => candidate?.kind === "clip"
    && candidate.origin === selected.origin
    && Boolean(selected.inputs.linkId)
    && candidate.inputs.linkId === selected.inputs.linkId;
  if (!sameLinkedOrigin(before) || !sameLinkedOrigin(after) || before.linkSegmentId !== undefined || selected.linkSegmentId !== undefined || after.linkSegmentId !== undefined) {
    fail("unsupported", path, "partial LinkedRippleDelete range must be strictly inside one unsegmented linked AudioClip and leave positive before/after fragments.", operationIndex);
  }
  before.linkSegmentId = ids.before;
  after.linkSegmentId = ids.after;
}

function semanticItem(item: AudioEditItem): AudioEditMaterializationIdentity["items"][number] {
  if (item.kind === "gap") return { kind: "gap", destination: item.destination };
  if (item.kind === "region") fail("region-plan", "$.items", "processed AudioRegions are transition-only and cannot be structurally materialized.");
  return {
    kind: "clip",
    destination: item.destination,
    source: item.source,
    inputs: { resourceId: item.inputs.resourceId, ...(item.inputs.linkId ? { linkId: item.inputs.linkId } : {}) },
    ...(item.linkSegmentId ? { linkSegmentId: item.linkSegmentId } : {}),
  };
}

function semanticRegionItem(item: AudioEditRegionItem) {
  return {
    kind: "region" as const,
    regionId: item.regionId,
    sourceNodeId: item.sourceNodeId,
    processorNodeIds: [...item.processorNodeIds],
    destination: item.destination,
    source: item.source,
    inputs: { ...item.inputs },
  };
}

function relativeItems(items: readonly AudioEditItem[], start: Rational) {
  return items.map((item) => {
    const copy = cloneItem(item);
    copy.destination.start = subtractRational(copy.destination.start, start);
    return copy;
  });
}

function sameSemanticItems(left: readonly AudioEditItem[], right: readonly AudioEditItem[]) {
  return stableJsonStringify(left.map(semanticItem)) === stableJsonStringify(right.map(semanticItem));
}

function exactClipTarget(items: readonly AudioEditItem[], range: AudioEditInterval, operation: "slip" | "slide", operationIndex: number) {
  const rangeEnd = intervalEnd(range), duration = totalDuration(items), path = `$.operations[${operationIndex}].range`;
  if (compareRational(range.start, zeroRational) < 0 || compareRational(rangeEnd, duration) > 0) fail("time", path, `${operation} range lies outside the current track.`, operationIndex);
  const index = items.findIndex((item) => sameInterval(item.destination, range));
  if (index < 0 || items[index].kind !== "clip") {
    fail("unsupported", path, `${operation} range must identify exactly one current clip; gaps, partial selections, and edit-boundary crossings are ambiguous.`, operationIndex);
  }
  return index;
}

function slipClip(item: AudioEditItem, by: Rational, operationIndex: number, operationProvenance: IRProvenance): AudioEditClipItem {
  if (item.kind !== "clip") fail("result", `$.operations[${operationIndex}]`, "internal slip target is not a clip.", operationIndex);
  const start = addRational(item.source.start, by);
  if (compareRational(start, zeroRational) < 0) fail("time", `$.operations[${operationIndex}].by`, "slip would move the source range before zero.", operationIndex);
  return { ...cloneItem(item), source: { start, duration: item.source.duration }, provenance: structuredClone(operationProvenance) } as AudioEditClipItem;
}

function resizeTail(item: AudioEditItem, duration: Rational, operationIndex: number, operationProvenance: IRProvenance): AudioEditItem {
  const path = `$.operations[${operationIndex}].by`;
  if (compareRational(duration, zeroRational) <= 0) fail("time", path, "slide cannot consume an adjacent item completely.", operationIndex);
  if (sameRational(duration, item.destination.duration)) return cloneItem(item);
  if (compareRational(duration, item.destination.duration) < 0) return segment(item, item.destination.start, duration, path, operationProvenance);
  if (item.kind === "gap") return gap(item.destination.start, duration, operationProvenance, item.origin);
  return {
    ...cloneItem(item),
    destination: { start: item.destination.start, duration },
    source: { start: item.source.start, duration },
    provenance: structuredClone(operationProvenance),
  } as AudioEditClipItem;
}

function resizeHead(item: AudioEditItem, duration: Rational, operationIndex: number, operationProvenance: IRProvenance): AudioEditItem {
  const path = `$.operations[${operationIndex}].by`;
  if (compareRational(duration, zeroRational) <= 0) fail("time", path, "slide cannot consume an adjacent item completely.", operationIndex);
  if (sameRational(duration, item.destination.duration)) return cloneItem(item);
  if (compareRational(duration, item.destination.duration) < 0) {
    const removed = subtractRational(item.destination.duration, duration);
    return segment(item, addRational(item.destination.start, removed), duration, path, operationProvenance);
  }
  const extension = subtractRational(duration, item.destination.duration), destination = { start: subtractRational(item.destination.start, extension), duration };
  if (item.kind === "gap") return gap(destination.start, duration, operationProvenance, item.origin);
  const sourceStart = subtractRational(item.source.start, extension);
  if (compareRational(sourceStart, zeroRational) < 0) fail("time", path, "slide would extend the following clip before source time zero.", operationIndex);
  return {
    ...cloneItem(item),
    destination,
    source: { start: sourceStart, duration },
    provenance: structuredClone(operationProvenance),
  } as AudioEditClipItem;
}

function assertResult(items: readonly AudioEditItem[], activeLimits: AudioEditOperationLimits) {
  enforceItems(items, activeLimits, "$.result.items");
  let cursor = zeroRational;
  for (const [index, item] of items.entries()) {
    if (!sameRational(item.destination.start, cursor) || compareRational(item.destination.duration, zeroRational) <= 0) {
      fail("result", `$.result.items[${index}].destination`, "materialized coverage is not positive and contiguous.");
    }
    if (index && items[index - 1].kind === "gap" && item.kind === "gap") fail("result", `$.result.items[${index}]`, "materialized silence was not coalesced.");
    if (item.kind === "clip" || item.kind === "region") {
      if (compareRational(item.source.start, zeroRational) < 0 || !sameRational(item.source.duration, item.destination.duration)) {
        fail(item.kind === "region" ? "region-topology" : "result", `$.result.items[${index}].source`, `${item.kind === "region" ? "AudioRegion" : "materialized clip"} lost one-to-one non-negative source mapping.`);
      }
    }
    cursor = intervalEnd(item.destination);
  }
}

function nonNegativeHandle(item: AudioEditClipItem | AudioEditRegionItem, name: "headHandle" | "tailHandle", operationIndex: number) {
  const value = item.inputs[name] ?? zeroRational;
  if (compareRational(value, zeroRational) < 0) fail("time", `$.operations[${operationIndex}].${name}`, `${name} cannot be negative.`, operationIndex);
  return value;
}

function resolveAudioTrackCrossfade(
  items: readonly AudioEditItem[],
  operation: Extract<AudioEditOperation, { kind: "crossfade" }>,
  operationIndex: number,
  resolved: readonly AudioEditTrackTransition[],
  regionPlan = false,
): AudioEditTrackTransition {
  const path = `$.operations[${operationIndex}]`, total = totalDuration(items), half = divideRational(operation.duration, rational(2));
  if (compareRational(operation.at, zeroRational) <= 0 || compareRational(operation.at, total) >= 0) {
    fail(regionPlan ? "region-topology" : "unsupported", `${path}.at`, "audioCrossfadeAt must identify an internal hard cut; track-edge crossfades are not defined.", operationIndex);
  }
  const incomingIndex = items.findIndex((item) => sameRational(item.destination.start, operation.at));
  if (incomingIndex <= 0) {
    const containing = items.some((item) => compareRational(operation.at, item.destination.start) > 0 && compareRational(operation.at, intervalEnd(item.destination)) < 0);
    fail(regionPlan ? "region-topology" : containing ? "unsupported" : "no-op", `${path}.at`, containing
      ? "audioCrossfadeAt is ambiguous inside a clip; audioSplit it first or target an existing hard cut."
      : "audioCrossfadeAt does not identify an existing hard cut after the complete structural edit list.", operationIndex);
  }
  const outgoingIndex = incomingIndex - 1, outgoing = items[outgoingIndex], incoming = items[incomingIndex];
  const expectedKind = regionPlan ? "region" : "clip";
  if (outgoing.kind !== expectedKind || incoming.kind !== expectedKind) {
    fail(regionPlan ? "region-topology" : "unsupported", `${path}.at`, regionPlan
      ? "processed audioCrossfadeAt requires two exactly adjacent AudioRegions; direct AudioClips, gaps, and mixed pairs are refused."
      : "audioCrossfadeAt requires two adjacent AudioClips; explicit silence cannot provide transition media.", operationIndex);
  }
  const outgoingMedia = outgoing as AudioEditClipItem | AudioEditRegionItem;
  const incomingMedia = incoming as AudioEditClipItem | AudioEditRegionItem;
  if (!regionPlan && (outgoingMedia.inputs.linkId !== undefined || incomingMedia.inputs.linkId !== undefined)) {
    fail("unsupported", `${path}.at`, "audioCrossfadeAt on linked picture/audio is refused until CUT can preserve one coupled edit transaction.", operationIndex);
  }
  if (regionPlan && outgoingMedia.inputs.linkId !== undefined && outgoingMedia.inputs.linkId === incomingMedia.inputs.linkId) {
    fail("region-topology", `${path}.at`, "adjacent transitioned AudioRegions must not reuse one picture-link identity; passive links remain distinct and unchanged.", operationIndex);
  }
  if (outgoingMedia.inputs.rate !== undefined || incomingMedia.inputs.rate !== undefined || outgoingMedia.inputs.overlap !== undefined || incomingMedia.inputs.overlap !== undefined) {
    fail("unsupported", `${path}.at`, "audioCrossfadeAt v1 requires adjacent forward 1x, non-overlapped clips; retime and pre-overlapped material are ambiguous.", operationIndex);
  }
  const hasManualFade = (item: AudioEditClipItem | AudioEditRegionItem) => [item.inputs.fadeIn, item.inputs.fadeOut].some((value) => value !== undefined && compareRational(value, zeroRational) !== 0);
  if (hasManualFade(outgoingMedia) || hasManualFade(incomingMedia)) {
    fail("unsupported", `${path}.at`, "audioCrossfadeAt refuses nonzero manual fades on either adjacent clip; the crossfade owns the complete overlap envelope.", operationIndex);
  }
  if (compareRational(half, outgoing.destination.duration) > 0 || compareRational(half, incoming.destination.duration) > 0) {
    fail(regionPlan ? "region-topology" : "time", `${path}.duration`, "centered audio crossfade cannot extend beyond either adjacent visible clip interval.", operationIndex);
  }
  const outgoingAvailable = nonNegativeHandle(outgoingMedia, "tailHandle", operationIndex);
  const incomingAvailable = nonNegativeHandle(incomingMedia, "headHandle", operationIndex);
  if (compareRational(outgoingAvailable, half) < 0 || compareRational(incomingAvailable, half) < 0) {
    fail(regionPlan ? "region-handle" : "time", `${path}.duration`, `audioCrossfadeAt requires at least ${half.numerator}/${half.denominator}s outgoing tailHandle and incoming headHandle.`, operationIndex);
  }
  const incomingSourceStart = subtractRational(incomingMedia.source.start, half);
  if (compareRational(incomingSourceStart, zeroRational) < 0) {
    fail(regionPlan ? "region-handle" : "time", `${path}.duration`, "audioCrossfadeAt incoming headHandle would begin before source time zero.", operationIndex);
  }
  const candidate: AudioEditTrackTransition = {
    cut: operation.at,
    duration: operation.duration,
    overlap: { start: subtractRational(operation.at, half), duration: operation.duration },
    outgoingIndex,
    incomingIndex,
    outgoingOrigin: outgoingMedia.origin,
    incomingOrigin: incomingMedia.origin,
    outgoingSource: { start: intervalEnd(outgoingMedia.source), duration: half },
    incomingSource: { start: incomingSourceStart, duration: half },
    curve: operation.curve,
    provenance: operation.provenance,
  };
  for (const previous of resolved) {
    if (sameRational(previous.cut, candidate.cut)) fail(regionPlan ? "region-topology" : "no-op", `${path}.at`, "audioCrossfadeAt duplicates a crossfade at the same resolved hard cut.", operationIndex);
    const previousEnd = intervalEnd(previous.overlap), candidateEnd = intervalEnd(candidate.overlap);
    if (compareRational(previous.overlap.start, candidateEnd) < 0 && compareRational(candidate.overlap.start, previousEnd) < 0) {
      fail(regionPlan ? "region-topology" : "unsupported", `${path}.duration`, "audioCrossfadeAt window intersects another resolved crossfade; touching half-open windows are permitted but overlapping windows are not.", operationIndex);
    }
  }
  return candidate;
}

function canonicalMaterializedItems(value: unknown, activeLimits: AudioEditOperationLimits) {
  const values = array(value, "$.items", activeLimits.maxItems);
  if (!values.length) fail("result", "$.items", "materialization must contain at least one item.");
  const items = values.map((item, index) => canonicalItem(item, `$.items[${index}]`, activeLimits));
  assertResult(items, activeLimits);
  return items;
}

export function audioEditMaterializationIdentity(
  value: unknown,
  requestedLimits?: Partial<AudioEditOperationLimits>,
): AudioEditMaterializationIdentity {
  const items = canonicalMaterializedItems(value, limits(requestedLimits));
  return { version: 1, duration: totalDuration(items), items: items.map(semanticItem) };
}

export function audioEditMaterializationId(value: unknown, requestedLimits?: Partial<AudioEditOperationLimits>) {
  return `audio_edit_${hash(stableJsonStringify(audioEditMaterializationIdentity(value, requestedLimits))).slice(0, 24)}`;
}

export function audioEditMaterializedNodeId(
  trackId: string,
  index: number,
  value: unknown,
  requestedLimits?: Partial<AudioEditOperationLimits>,
) {
  const identity = semanticItem(canonicalItem(value, "$.item", limits(requestedLimits)));
  // Materialized siblings may be semantically identical (for example two
  // adjacent uses of the same source interval). Their position in the ordered
  // track is therefore required to keep node identities unique and stable.
  return `node_${hash({ trackId, index, item: identity }).slice(0, 16)}`;
}

export function audioEditOperationExecutableIdentity(
  value: unknown,
  requestedLimits?: Partial<AudioEditOperationLimits>,
) {
  const plan = validateAudioEditOperationPlan(value, requestedLimits);
  const stripItem = (item: AudioEditItem) => ({ ...(item.kind === "region" ? semanticRegionItem(item) : semanticItem(item)), origin: item.origin });
  return {
    version: plan.version,
    sourceDuration: plan.sourceDuration,
    baseItems: plan.baseItems.map(stripItem),
    operations: plan.operations.map((operation) => {
      const rest = { ...operation };
      delete (rest as { provenance?: IRProvenance }).provenance;
      return "item" in rest ? { ...rest, item: stripItem(rest.item) } : rest;
    }),
  };
}

export function sameAudioEditOperationPlan(
  left: unknown,
  right: unknown,
  requestedLimits?: Partial<AudioEditOperationLimits>,
) {
  return stableJsonStringify(audioEditOperationExecutableIdentity(left, requestedLimits))
    === stableJsonStringify(audioEditOperationExecutableIdentity(right, requestedLimits));
}

export function executeAudioEditOperationPlan(
  value: unknown,
  requestedLimits?: Partial<AudioEditOperationLimits>,
  visitStep?: (step: AudioEditExecutionStep) => void,
): AudioEditExecution {
  const activeLimits = limits(requestedLimits), plan = validateAudioEditOperationPlan(value, activeLimits);
  if (plan.version === 2) {
    const items = plan.baseItems.map((item) => cloneItem(item) as AudioEditRegionItem);
    assertResult(items, activeLimits);
    const transitions: AudioEditTrackTransition[] = [];
    for (const [operationIndex, operation] of plan.operations.entries()) {
      transitions.push(resolveAudioTrackCrossfade(items, operation, operationIndex, transitions, true));
    }
    return {
      items,
      transitions,
      duration: plan.sourceDuration,
      materializationId: `audio_region_edit_${hash(stableJsonStringify(items.map(semanticRegionItem))).slice(0, 24)}`,
    };
  }
  let items = plan.baseItems.map(cloneItem);
  const original = items.map(cloneItem);
  const transitions: AudioEditTrackTransition[] = [];

  for (const [operationIndex, operation] of plan.operations.entries()) {
    const operationPath = `$.operations[${operationIndex}]`;
    // Crossfades decorate the complete post-structural timeline. Resolving
    // them only after every structural operation prevents stale cut ownership
    // and makes source order independent of declaration order.
    if (operation.kind === "crossfade") continue;
    const completeStep = () => {
      // Intermediate states are executable editorial states, not disposable
      // algebra scratch. Validate their structural contract and expose a
      // synchronous read-only view so the locked-media runtime can reject a
      // transient source overrun even if a later edit happens to remove it.
      assertResult(items, activeLimits);
      visitStep?.({ operationIndex, operation, items });
    };
    if (operation.kind === "split") {
      const duration = totalDuration(items);
      if (compareRational(operation.at, zeroRational) < 0 || compareRational(operation.at, duration) > 0) {
        fail("time", `${operationPath}.at`, "split point lies outside the current track.", operationIndex);
      }
      const containing = items.find((item) => compareRational(operation.at, item.destination.start) > 0 && compareRational(operation.at, intervalEnd(item.destination)) < 0);
      if (!containing) fail("no-op", `${operationPath}.at`, "split must be strictly inside one current clip.", operationIndex);
      if (containing.kind !== "clip") fail("unsupported", `${operationPath}.at`, "splitting explicit silence is not meaningful.", operationIndex);
      items = boundary(items, operation.at, operationIndex, activeLimits, operation.provenance).items;
      completeStep();
      continue;
    }
    if (operation.kind === "trim") {
      const end = intervalEnd(operation.keep);
      const targetIndex = items.findIndex((item) => item.kind === "clip"
        && compareRational(operation.keep.start, item.destination.start) >= 0
        && compareRational(end, intervalEnd(item.destination)) <= 0);
      if (targetIndex < 0) fail("time", `${operationPath}.keep`, "trim keep range must lie within exactly one current clip.", operationIndex);
      const target = items[targetIndex];
      if (sameInterval(operation.keep, target.destination)) fail("no-op", `${operationPath}.keep`, "trim keep range equals the complete clip.", operationIndex);
      const replacement: AudioEditItem[] = [];
      if (compareRational(operation.keep.start, target.destination.start) > 0) {
        replacement.push(gap(target.destination.start, subtractRational(operation.keep.start, target.destination.start), operation.provenance, `trim:${operationIndex}:head`));
      }
      replacement.push(segment(target, operation.keep.start, operation.keep.duration, operationPath, operation.provenance));
      if (compareRational(end, intervalEnd(target.destination)) < 0) {
        replacement.push(gap(end, subtractRational(intervalEnd(target.destination), end), operation.provenance, `trim:${operationIndex}:tail`));
      }
      items = coalesceGaps([...items.slice(0, targetIndex), ...replacement, ...items.slice(targetIndex + 1)], activeLimits, operationPath);
      completeStep();
      continue;
    }
    if (operation.kind === "ripple-insert") {
      const duration = totalDuration(items);
      if (compareRational(operation.at, zeroRational) < 0 || compareRational(operation.at, duration) > 0) fail("time", `${operationPath}.at`, "ripple insert point lies outside the current track.", operationIndex);
      const split = boundary(items, operation.at, operationIndex, activeLimits, operation.provenance).items;
      const insertion = cloneItem(operation.item);
      insertion.destination.start = zeroRational;
      const index = split.findIndex((item) => compareRational(item.destination.start, operation.at) >= 0);
      items = coalesceGaps(index < 0 ? [...split, insertion] : [...split.slice(0, index), insertion, ...split.slice(index)], activeLimits, operationPath);
      completeStep();
      continue;
    }
    if (operation.kind === "ripple-delete" || operation.kind === "extract") {
      const selected = ranged(items, operation.range, operationIndex, activeLimits, operation.provenance);
      if (operation.kind === "ripple-delete" && operation.linkSegmentIds) {
        markLinkedRippleSegments(selected.items, selected.inside, operation.linkSegmentIds, operationIndex);
      }
      const retained = selected.items.filter((item) => !selected.inside.includes(item));
      if (!retained.length) fail("result", `${operationPath}.range`, `${operation.kind} cannot remove the complete positive track.`, operationIndex);
      items = coalesceGaps(retained, activeLimits, operationPath);
      completeStep();
      continue;
    }
    if (operation.kind === "lift") {
      const selected = ranged(items, operation.range, operationIndex, activeLimits, operation.provenance);
      if (selected.inside.every((item) => item.kind === "gap")) fail("no-op", `${operationPath}.range`, "lift range already contains only explicit silence.", operationIndex);
      const first = selected.items.indexOf(selected.inside[0]), last = selected.items.indexOf(selected.inside.at(-1)!);
      items = coalesceGaps([
        ...selected.items.slice(0, first),
        gap(operation.range.start, operation.range.duration, operation.provenance, `lift:${operationIndex}`),
        ...selected.items.slice(last + 1),
      ], activeLimits, operationPath);
      completeStep();
      continue;
    }
    if (operation.kind === "overwrite") {
      if (!sameRational(operation.range.duration, operation.item.destination.duration)) fail("time", `${operationPath}.item.destination.duration`, "overwrite item duration must equal its destination range exactly.", operationIndex);
      const selected = ranged(items, operation.range, operationIndex, activeLimits, operation.provenance);
      const first = selected.items.indexOf(selected.inside[0]), last = selected.items.indexOf(selected.inside.at(-1)!);
      const replacement = cloneItem(operation.item); replacement.destination.start = zeroRational;
      if (sameSemanticItems(relativeItems(selected.inside, operation.range.start), [replacement])) fail("no-op", operationPath, "overwrite material is semantically identical to the selected range.", operationIndex);
      items = coalesceGaps([...selected.items.slice(0, first), replacement, ...selected.items.slice(last + 1)], activeLimits, operationPath);
      completeStep();
      continue;
    }
    if (operation.kind === "slip") {
      if (sameRational(operation.by, zeroRational)) fail("no-op", `${operationPath}.by`, "slip by zero is a no-op.", operationIndex);
      const index = exactClipTarget(items, operation.range, "slip", operationIndex);
      items = [...items.slice(0, index).map(cloneItem), slipClip(items[index], operation.by, operationIndex, operation.provenance), ...items.slice(index + 1).map(cloneItem)];
      completeStep();
      continue;
    }
    if (operation.kind === "slide") {
      if (sameRational(operation.by, zeroRational)) fail("no-op", `${operationPath}.by`, "slide by zero is a no-op.", operationIndex);
      const index = exactClipTarget(items, operation.range, "slide", operationIndex);
      if (index === 0 || index === items.length - 1) fail("unsupported", `${operationPath}.range`, "slide requires one explicit adjacent clip or gap on each side; track-edge slides are ambiguous.", operationIndex);
      const previous = resizeTail(items[index - 1], addRational(items[index - 1].destination.duration, operation.by), operationIndex, operation.provenance);
      const next = resizeHead(items[index + 1], subtractRational(items[index + 1].destination.duration, operation.by), operationIndex, operation.provenance);
      items = coalesceGaps([
        ...items.slice(0, index - 1),
        previous,
        items[index],
        next,
        ...items.slice(index + 2),
      ], activeLimits, operationPath);
      completeStep();
      continue;
    }

    const selected = ranged(items, operation.range, operationIndex, activeLimits, operation.provenance);
    if (selected.inside.length !== 1 || selected.inside[0].kind !== "clip" || !sameInterval(selected.inside[0].destination, operation.range)) {
      fail("unsupported", `${operationPath}.range`, "replace range must identify exactly one current clip; use overwrite for an arbitrary range.", operationIndex);
    }
    const index = selected.items.indexOf(selected.inside[0]), replacement = cloneItem(operation.item); replacement.destination.start = zeroRational;
    if (sameSemanticItems(relativeItems(selected.inside, operation.range.start), [replacement])) fail("no-op", operationPath, "replace material is semantically identical to the selected clip.", operationIndex);
    items = coalesceGaps([...selected.items.slice(0, index), replacement, ...selected.items.slice(index + 1)], activeLimits, operationPath);
    completeStep();
  }

  assertResult(items, activeLimits);
  for (const [operationIndex, operation] of plan.operations.entries()) {
    if (operation.kind === "crossfade") transitions.push(resolveAudioTrackCrossfade(items, operation, operationIndex, transitions));
  }
  if (!transitions.length && sameSemanticItems(original, items)) fail("no-op", "$.operations", "the complete operation list materializes the same AudioTrack as its source items.");
  const duration = totalDuration(items);
  return { items, transitions, duration, materializationId: audioEditMaterializationId(items, activeLimits) };
}
