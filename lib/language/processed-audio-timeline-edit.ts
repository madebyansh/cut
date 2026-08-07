import { hash } from "../core/stable";

export const processedAudioTimelineEditLimits = Object.freeze({
  maximumAuthorities: 64,
  maximumItems: 1_024,
  maximumOperations: 256,
  maximumTransitions: 128,
  maximumStringBytes: 4_096,
  maximumTimelineSamples: 2 ** 40,
});

export type ProcessedAudioSampleInterval = Readonly<{
  start: number;
  end: number;
}>;

export type ProcessedAudioFadeLaw = Readonly<{
  kind: "linear" | "equal-power";
  interval: ProcessedAudioSampleInterval;
}>;

export type ProcessedAudioPresentationLaw = Readonly<{
  fadeIn?: ProcessedAudioFadeLaw;
  fadeOut?: ProcessedAudioFadeLaw;
}>;

export type ProcessedAudioGraphAuthorityContentV1 = Readonly<{
  version: 1;
  graphIdentity: string;
  sourceIdentity: string;
  processorChainIdentity: string;
  sampleRate: number;
  sourceSampleCount: number;
  stateModel: "stateless" | "stateful";
}>;

export type ProcessedAudioGraphAuthorityV1 =
  ProcessedAudioGraphAuthorityContentV1
  & Readonly<{ authorityIdentity: string }>;

export type ProcessedAudioItemV1 = Readonly<{
  kind: "processed";
  id: string;
  authorityIdentity: string;
  destination: ProcessedAudioSampleInterval;
  source: ProcessedAudioSampleInterval;
  availableSource: ProcessedAudioSampleInterval;
  timeMap: Readonly<
    | { kind: "identity" }
    | { kind: "constant"; numerator: number; denominator: number }
  >;
  presentation: ProcessedAudioPresentationLaw;
  linkId?: string;
}>;

export type ProcessedAudioGapV1 = Readonly<{
  kind: "gap";
  id: string;
  destination: ProcessedAudioSampleInterval;
}>;

export type ProcessedAudioTimelineItemV1 = ProcessedAudioItemV1 | ProcessedAudioGapV1;

export type ProcessedAudioTimelineOperationV1 =
  | Readonly<{ kind: "split"; itemId: string; atSample: number }>
  | Readonly<{ kind: "trim"; itemId: string; keep: ProcessedAudioSampleInterval }>
  | Readonly<{ kind: "lift"; range: ProcessedAudioSampleInterval }>
  | Readonly<{ kind: "extract"; range: ProcessedAudioSampleInterval }>
  | Readonly<{ kind: "slip"; itemId: string; bySamples: number }>
  | Readonly<{ kind: "slide"; itemId: string; bySamples: number }>
  | Readonly<{
    kind: "boundary-adjust";
    leftItemId: string;
    rightItemId: string;
    bySamples: number;
  }>
  | Readonly<{
    kind: "jl-transition";
    outgoingItemId: string;
    incomingItemId: string;
    pictureCutSample: number;
    audioCutSample: number;
    durationSamples: number;
    curve: "linear" | "equal-power";
  }>;

export type ProcessedAudioTimelinePlanV1 = Readonly<{
  version: 1;
  durationSamples: number;
  authorities: readonly ProcessedAudioGraphAuthorityV1[];
  items: readonly ProcessedAudioTimelineItemV1[];
  operations: readonly ProcessedAudioTimelineOperationV1[];
}>;

export type ProcessedAudioGraphEvaluationReceiptV1 = Readonly<{
  authorityIdentity: string;
  graphIdentity: string;
  sourceSampleCount: number;
  pcmIdentity: string;
}>;

export type ProcessedAudioTimelineTransitionV1 = Readonly<{
  kind: "jl-transition";
  outgoingItemId: string;
  incomingItemId: string;
  pictureCutSample: number;
  audioCutSample: number;
  durationSamples: number;
  curve: "linear" | "equal-power";
  outgoingHandle: ProcessedAudioSampleInterval;
  incomingHandle: ProcessedAudioSampleInterval;
}>;

export type ProcessedAudioTimelineLineageV1 = Readonly<{
  itemId: string;
  originItemId: string;
  operationIndex: number;
  operationKind: ProcessedAudioTimelineOperationV1["kind"];
}>;

export type ProcessedAudioSampleWitnessV1 = Readonly<{
  itemId: string;
  authorityIdentity: string;
  pcmIdentity: string;
  source: ProcessedAudioSampleInterval;
  destination: ProcessedAudioSampleInterval;
  presentationIdentity: string;
  witnessIdentity: string;
}>;

export type ProcessedAudioTimelineStageV1 = Readonly<{
  version: 1;
  inputIdentity: string;
  stageIdentity: string;
  durationSamples: number;
  items: readonly ProcessedAudioTimelineItemV1[];
  transitions: readonly ProcessedAudioTimelineTransitionV1[];
  lineage: readonly ProcessedAudioTimelineLineageV1[];
  sampleWitnesses: readonly ProcessedAudioSampleWitnessV1[];
  graphEvaluations: readonly Readonly<{
    authorityIdentity: string;
    pcmIdentity: string;
    count: 1;
  }>[];
}>;

export type ProcessedAudioTimelineEditErrorCode =
  | "CUT_PROCESSED_AUDIO_EDIT_SHAPE"
  | "CUT_PROCESSED_AUDIO_EDIT_TIME"
  | "CUT_PROCESSED_AUDIO_EDIT_AUTHORITY"
  | "CUT_PROCESSED_AUDIO_EDIT_UNSUPPORTED"
  | "CUT_PROCESSED_AUDIO_EDIT_RESULT"
  | "CUT_PROCESSED_AUDIO_EDIT_LIMIT";

export class ProcessedAudioTimelineEditError extends Error {
  constructor(
    readonly code: ProcessedAudioTimelineEditErrorCode,
    readonly path: string,
    message: string,
  ) {
    super(`${code} at ${path}: ${message}`);
    this.name = "ProcessedAudioTimelineEditError";
  }
}

type UnknownRecord = Record<string, unknown>;

function fail(
  code: ProcessedAudioTimelineEditErrorCode,
  path: string,
  message: string,
): never {
  throw new ProcessedAudioTimelineEditError(code, path, message);
}

function ownRecord(value: unknown, path: string): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("CUT_PROCESSED_AUDIO_EDIT_SHAPE", path, "must be an object.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("CUT_PROCESSED_AUDIO_EDIT_SHAPE", path, "must have an ordinary or null prototype.");
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      fail("CUT_PROCESSED_AUDIO_EDIT_SHAPE", path, "symbol keys are not accepted.");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      fail("CUT_PROCESSED_AUDIO_EDIT_SHAPE", `${path}.${key}`, "accessor properties are not accepted.");
    }
  }
  return value as UnknownRecord;
}

function closed(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): UnknownRecord {
  const object = ownRecord(value, path);
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(object, key)) {
      fail("CUT_PROCESSED_AUDIO_EDIT_SHAPE", path, `is missing required field ${JSON.stringify(key)}.`);
    }
  }
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      fail("CUT_PROCESSED_AUDIO_EDIT_SHAPE", `${path}.${key}`, "is not part of the closed v1 contract.");
    }
  }
  return object;
}

function array(value: unknown, path: string, maximum: number): unknown[] {
  if (!Array.isArray(value)) fail("CUT_PROCESSED_AUDIO_EDIT_SHAPE", path, "must be an array.");
  if (value.length > maximum) {
    fail("CUT_PROCESSED_AUDIO_EDIT_LIMIT", path, `exceeds the ${maximum}-entry budget.`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) {
      fail("CUT_PROCESSED_AUDIO_EDIT_SHAPE", `${path}[${index}]`, "must be one dense data entry; accessors and holes are not accepted.");
    }
  }
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length) {
      fail("CUT_PROCESSED_AUDIO_EDIT_SHAPE", path, "contains a non-index own property.");
    }
  }
  return value;
}

function safeInteger(value: unknown, path: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    fail("CUT_PROCESSED_AUDIO_EDIT_TIME", path, `must be a safe integer >= ${minimum}.`);
  }
  if (value > processedAudioTimelineEditLimits.maximumTimelineSamples) {
    fail(
      "CUT_PROCESSED_AUDIO_EDIT_LIMIT",
      path,
      `exceeds maximumTimelineSamples=${processedAudioTimelineEditLimits.maximumTimelineSamples}.`,
    );
  }
  return value;
}

function signedInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value === 0) {
    fail("CUT_PROCESSED_AUDIO_EDIT_TIME", path, "must be a nonzero safe integer.");
  }
  if (Math.abs(value) > processedAudioTimelineEditLimits.maximumTimelineSamples) {
    fail("CUT_PROCESSED_AUDIO_EDIT_LIMIT", path, "exceeds the signed sample budget.");
  }
  return value;
}

function text(value: unknown, path: string): string {
  if (
    typeof value !== "string"
    || !value.length
    || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)
    || ["__proto__", "prototype", "constructor"].includes(value)
  ) {
    fail("CUT_PROCESSED_AUDIO_EDIT_SHAPE", path, "must be a non-empty safe identifier.");
  }
  if (new TextEncoder().encode(value).byteLength > processedAudioTimelineEditLimits.maximumStringBytes) {
    fail("CUT_PROCESSED_AUDIO_EDIT_LIMIT", path, "exceeds the identifier byte budget.");
  }
  return value;
}

function sha256(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    fail("CUT_PROCESSED_AUDIO_EDIT_SHAPE", path, "must be one lowercase SHA-256 value.");
  }
  return value;
}

function interval(value: unknown, path: string, allowEmpty = false): ProcessedAudioSampleInterval {
  const object = closed(value, path, ["start", "end"]);
  const start = safeInteger(object.start, `${path}.start`);
  const end = safeInteger(object.end, `${path}.end`);
  if (allowEmpty ? end < start : end <= start) {
    fail("CUT_PROCESSED_AUDIO_EDIT_TIME", path, allowEmpty ? "must not run backwards." : "must be positive.");
  }
  return Object.freeze({ start, end });
}

function inside(inner: ProcessedAudioSampleInterval, outer: ProcessedAudioSampleInterval): boolean {
  return inner.start >= outer.start && inner.end <= outer.end;
}

function intersects(left: ProcessedAudioSampleInterval, right: ProcessedAudioSampleInterval): boolean {
  return left.start < right.end && right.start < left.end;
}

function duration(value: ProcessedAudioSampleInterval): number {
  return value.end - value.start;
}

function authorityContent(
  value: ProcessedAudioGraphAuthorityContentV1,
): ProcessedAudioGraphAuthorityContentV1 {
  return {
    version: 1,
    graphIdentity: value.graphIdentity,
    sourceIdentity: value.sourceIdentity,
    processorChainIdentity: value.processorChainIdentity,
    sampleRate: value.sampleRate,
    sourceSampleCount: value.sourceSampleCount,
    stateModel: value.stateModel,
  };
}

export function processedAudioGraphAuthorityIdentity(
  value: ProcessedAudioGraphAuthorityContentV1,
): string {
  return hash({
    contract: "cut-processed-audio-graph-authority-v1",
    ...authorityContent(value),
  });
}

function validateAuthority(value: unknown, path: string): ProcessedAudioGraphAuthorityV1 {
  const object = closed(value, path, [
    "version",
    "graphIdentity",
    "sourceIdentity",
    "processorChainIdentity",
    "sampleRate",
    "sourceSampleCount",
    "stateModel",
    "authorityIdentity",
  ]);
  if (object.version !== 1) fail("CUT_PROCESSED_AUDIO_EDIT_SHAPE", `${path}.version`, "must equal 1.");
  if (object.stateModel !== "stateless" && object.stateModel !== "stateful") {
    fail("CUT_PROCESSED_AUDIO_EDIT_SHAPE", `${path}.stateModel`, "must be stateless or stateful.");
  }
  const content: ProcessedAudioGraphAuthorityContentV1 = {
    version: 1,
    graphIdentity: sha256(object.graphIdentity, `${path}.graphIdentity`),
    sourceIdentity: sha256(object.sourceIdentity, `${path}.sourceIdentity`),
    processorChainIdentity: sha256(object.processorChainIdentity, `${path}.processorChainIdentity`),
    sampleRate: safeInteger(object.sampleRate, `${path}.sampleRate`, 1),
    sourceSampleCount: safeInteger(object.sourceSampleCount, `${path}.sourceSampleCount`, 1),
    stateModel: object.stateModel,
  };
  const authorityIdentity = sha256(object.authorityIdentity, `${path}.authorityIdentity`);
  if (processedAudioGraphAuthorityIdentity(content) !== authorityIdentity) {
    fail("CUT_PROCESSED_AUDIO_EDIT_AUTHORITY", `${path}.authorityIdentity`, "does not authenticate the graph authority content.");
  }
  return Object.freeze({ ...content, authorityIdentity });
}

function validateFade(value: unknown, path: string): ProcessedAudioFadeLaw {
  const object = closed(value, path, ["kind", "interval"]);
  if (object.kind !== "linear" && object.kind !== "equal-power") {
    fail("CUT_PROCESSED_AUDIO_EDIT_SHAPE", `${path}.kind`, "must be linear or equal-power.");
  }
  return Object.freeze({ kind: object.kind, interval: interval(object.interval, `${path}.interval`) });
}

function validatePresentation(value: unknown, path: string): ProcessedAudioPresentationLaw {
  const object = closed(value, path, [], ["fadeIn", "fadeOut"]);
  return Object.freeze({
    ...(object.fadeIn === undefined ? {} : { fadeIn: validateFade(object.fadeIn, `${path}.fadeIn`) }),
    ...(object.fadeOut === undefined ? {} : { fadeOut: validateFade(object.fadeOut, `${path}.fadeOut`) }),
  });
}

function validateItem(value: unknown, path: string): ProcessedAudioTimelineItemV1 {
  const base = ownRecord(value, path);
  if (base.kind === "gap") {
    const object = closed(value, path, ["kind", "id", "destination"]);
    return Object.freeze({
      kind: "gap",
      id: text(object.id, `${path}.id`),
      destination: interval(object.destination, `${path}.destination`),
    });
  }
  if (base.kind !== "processed") {
    fail("CUT_PROCESSED_AUDIO_EDIT_SHAPE", `${path}.kind`, "must be processed or gap.");
  }
  const object = closed(value, path, [
    "kind",
    "id",
    "authorityIdentity",
    "destination",
    "source",
    "availableSource",
    "timeMap",
    "presentation",
  ], ["linkId"]);
  const destination = interval(object.destination, `${path}.destination`);
  const source = interval(object.source, `${path}.source`);
  const availableSource = interval(object.availableSource, `${path}.availableSource`);
  if (!inside(source, availableSource)) {
    fail("CUT_PROCESSED_AUDIO_EDIT_TIME", `${path}.source`, "must lie within availableSource.");
  }
  const timeMap = ownRecord(object.timeMap, `${path}.timeMap`);
  let canonicalTimeMap: ProcessedAudioItemV1["timeMap"];
  if (timeMap.kind === "identity") {
    closed(object.timeMap, `${path}.timeMap`, ["kind"]);
    canonicalTimeMap = Object.freeze({ kind: "identity" });
  } else if (timeMap.kind === "constant") {
    const closedMap = closed(object.timeMap, `${path}.timeMap`, ["kind", "numerator", "denominator"]);
    canonicalTimeMap = Object.freeze({
      kind: "constant",
      numerator: safeInteger(closedMap.numerator, `${path}.timeMap.numerator`, 1),
      denominator: safeInteger(closedMap.denominator, `${path}.timeMap.denominator`, 1),
    });
  } else {
    fail("CUT_PROCESSED_AUDIO_EDIT_SHAPE", `${path}.timeMap.kind`, "must be identity or constant.");
  }
  if (canonicalTimeMap.kind === "identity" && duration(source) !== duration(destination)) {
    fail("CUT_PROCESSED_AUDIO_EDIT_TIME", path, "identity-mapped source and destination durations must match.");
  }
  return Object.freeze({
    kind: "processed",
    id: text(object.id, `${path}.id`),
    authorityIdentity: sha256(object.authorityIdentity, `${path}.authorityIdentity`),
    destination,
    source,
    availableSource,
    timeMap: canonicalTimeMap,
    presentation: validatePresentation(object.presentation, `${path}.presentation`),
    ...(object.linkId === undefined ? {} : { linkId: text(object.linkId, `${path}.linkId`) }),
  });
}

function validateOperation(value: unknown, path: string): ProcessedAudioTimelineOperationV1 {
  const base = ownRecord(value, path);
  switch (base.kind) {
    case "split": {
      const object = closed(value, path, ["kind", "itemId", "atSample"]);
      return Object.freeze({ kind: "split", itemId: text(object.itemId, `${path}.itemId`), atSample: safeInteger(object.atSample, `${path}.atSample`) });
    }
    case "trim": {
      const object = closed(value, path, ["kind", "itemId", "keep"]);
      return Object.freeze({ kind: "trim", itemId: text(object.itemId, `${path}.itemId`), keep: interval(object.keep, `${path}.keep`) });
    }
    case "lift":
    case "extract": {
      const object = closed(value, path, ["kind", "range"]);
      return Object.freeze({ kind: base.kind, range: interval(object.range, `${path}.range`) });
    }
    case "slip":
    case "slide": {
      const object = closed(value, path, ["kind", "itemId", "bySamples"]);
      return Object.freeze({ kind: base.kind, itemId: text(object.itemId, `${path}.itemId`), bySamples: signedInteger(object.bySamples, `${path}.bySamples`) });
    }
    case "boundary-adjust": {
      const object = closed(value, path, ["kind", "leftItemId", "rightItemId", "bySamples"]);
      return Object.freeze({
        kind: "boundary-adjust",
        leftItemId: text(object.leftItemId, `${path}.leftItemId`),
        rightItemId: text(object.rightItemId, `${path}.rightItemId`),
        bySamples: signedInteger(object.bySamples, `${path}.bySamples`),
      });
    }
    case "jl-transition": {
      const object = closed(value, path, [
        "kind",
        "outgoingItemId",
        "incomingItemId",
        "pictureCutSample",
        "audioCutSample",
        "durationSamples",
        "curve",
      ]);
      if (object.curve !== "linear" && object.curve !== "equal-power") {
        fail("CUT_PROCESSED_AUDIO_EDIT_SHAPE", `${path}.curve`, "must be linear or equal-power.");
      }
      return Object.freeze({
        kind: "jl-transition",
        outgoingItemId: text(object.outgoingItemId, `${path}.outgoingItemId`),
        incomingItemId: text(object.incomingItemId, `${path}.incomingItemId`),
        pictureCutSample: safeInteger(object.pictureCutSample, `${path}.pictureCutSample`),
        audioCutSample: safeInteger(object.audioCutSample, `${path}.audioCutSample`),
        durationSamples: safeInteger(object.durationSamples, `${path}.durationSamples`, 1),
        curve: object.curve,
      });
    }
    default:
      fail("CUT_PROCESSED_AUDIO_EDIT_SHAPE", `${path}.kind`, "is not a closed v1 operation.");
  }
}

export function validateProcessedAudioTimelinePlanV1(value: unknown): ProcessedAudioTimelinePlanV1 {
  const object = closed(value, "$", ["version", "durationSamples", "authorities", "items", "operations"]);
  if (object.version !== 1) fail("CUT_PROCESSED_AUDIO_EDIT_SHAPE", "$.version", "must equal 1.");
  const durationSamples = safeInteger(object.durationSamples, "$.durationSamples", 1);
  const authorities = array(object.authorities, "$.authorities", processedAudioTimelineEditLimits.maximumAuthorities)
    .map((entry, index) => validateAuthority(entry, `$.authorities[${index}]`));
  const authorityIds = new Set<string>();
  for (const [index, authority] of authorities.entries()) {
    if (authorityIds.has(authority.authorityIdentity)) {
      fail("CUT_PROCESSED_AUDIO_EDIT_AUTHORITY", `$.authorities[${index}].authorityIdentity`, "is duplicated.");
    }
    authorityIds.add(authority.authorityIdentity);
  }
  const items = array(object.items, "$.items", processedAudioTimelineEditLimits.maximumItems)
    .map((entry, index) => validateItem(entry, `$.items[${index}]`))
    .sort((left, right) => left.destination.start - right.destination.start || left.id.localeCompare(right.id));
  if (!items.length) fail("CUT_PROCESSED_AUDIO_EDIT_SHAPE", "$.items", "must contain at least one item.");
  const itemIds = new Set<string>();
  let cursor = 0;
  for (const [index, item] of items.entries()) {
    if (itemIds.has(item.id)) fail("CUT_PROCESSED_AUDIO_EDIT_RESULT", `$.items[${index}].id`, "is duplicated.");
    itemIds.add(item.id);
    if (item.destination.start !== cursor) {
      fail("CUT_PROCESSED_AUDIO_EDIT_TIME", `$.items[${index}].destination.start`, "items must tile the track contiguously from zero.");
    }
    cursor = item.destination.end;
    if (item.kind === "processed" && !authorityIds.has(item.authorityIdentity)) {
      fail("CUT_PROCESSED_AUDIO_EDIT_AUTHORITY", `$.items[${index}].authorityIdentity`, "does not name a declared authority.");
    }
  }
  if (cursor !== durationSamples) {
    fail("CUT_PROCESSED_AUDIO_EDIT_TIME", "$.durationSamples", "must equal the tiled item duration.");
  }
  const operations = array(object.operations, "$.operations", processedAudioTimelineEditLimits.maximumOperations)
    .map((entry, index) => validateOperation(entry, `$.operations[${index}]`));
  if (operations.filter((operation) => operation.kind === "jl-transition").length > processedAudioTimelineEditLimits.maximumTransitions) {
    fail("CUT_PROCESSED_AUDIO_EDIT_LIMIT", "$.operations", "exceeds the transition budget.");
  }
  return Object.freeze({
    version: 1,
    durationSamples,
    authorities: Object.freeze(authorities),
    items: Object.freeze(items),
    operations: Object.freeze(operations),
  });
}

function generatedId(originItemId: string, operationIndex: number, role: string, item: ProcessedAudioTimelineItemV1): string {
  return `processed_audio_view_${hash({
    contract: "cut-processed-audio-presentation-view-v1",
    originItemId,
    operationIndex,
    role,
    kind: item.kind,
    destination: item.destination,
    ...(item.kind === "processed" ? {
      authorityIdentity: item.authorityIdentity,
      source: item.source,
      presentation: item.presentation,
      linkId: item.linkId,
    } : {}),
  }).slice(0, 24)}`;
}

function unsupportedItem(item: ProcessedAudioTimelineItemV1, authorityById: ReadonlyMap<string, ProcessedAudioGraphAuthorityV1>, path: string): asserts item is ProcessedAudioItemV1 {
  if (item.kind !== "processed") {
    fail("CUT_PROCESSED_AUDIO_EDIT_UNSUPPORTED", path, "operation requires processed media, not a gap.");
  }
  const authority = authorityById.get(item.authorityIdentity);
  if (!authority) fail("CUT_PROCESSED_AUDIO_EDIT_AUTHORITY", path, "references a missing authority.");
  if (authority.stateModel !== "stateless") {
    fail("CUT_PROCESSED_AUDIO_EDIT_UNSUPPORTED", path, "stateful processor graphs cannot be structurally sliced without an explicit causal-history contract.");
  }
  if (item.timeMap.kind !== "identity") {
    fail("CUT_PROCESSED_AUDIO_EDIT_UNSUPPORTED", path, "retimed processor views cannot be structurally edited by the identity-clock v1 adapter.");
  }
}

function sliceItem(
  item: ProcessedAudioTimelineItemV1,
  destination: ProcessedAudioSampleInterval,
  operationIndex: number,
  role: string,
  authorityById: ReadonlyMap<string, ProcessedAudioGraphAuthorityV1>,
): ProcessedAudioTimelineItemV1 {
  if (!inside(destination, item.destination)) {
    fail("CUT_PROCESSED_AUDIO_EDIT_RESULT", `$.operations[${operationIndex}]`, "slice lies outside its current item.");
  }
  if (item.kind === "gap") {
    const result: ProcessedAudioGapV1 = { kind: "gap", id: "", destination };
    return Object.freeze({ ...result, id: generatedId(item.id, operationIndex, role, result) });
  }
  unsupportedItem(item, authorityById, `$.operations[${operationIndex}]`);
  const offset = destination.start - item.destination.start;
  const source = Object.freeze({ start: item.source.start + offset, end: item.source.start + offset + duration(destination) });
  const result: ProcessedAudioItemV1 = {
    ...item,
    id: "",
    destination,
    source,
  };
  return Object.freeze({ ...result, id: generatedId(item.id, operationIndex, role, result) });
}

function gap(
  destination: ProcessedAudioSampleInterval,
  operationIndex: number,
  role: string,
): ProcessedAudioGapV1 {
  const result: ProcessedAudioGapV1 = { kind: "gap", id: "", destination };
  return Object.freeze({ ...result, id: generatedId("gap", operationIndex, role, result) });
}

function shiftedItem(item: ProcessedAudioTimelineItemV1, bySamples: number): ProcessedAudioTimelineItemV1 {
  return Object.freeze({
    ...item,
    destination: Object.freeze({
      start: item.destination.start + bySamples,
      end: item.destination.end + bySamples,
    }),
  });
}

function coalesceGaps(items: readonly ProcessedAudioTimelineItemV1[]): ProcessedAudioTimelineItemV1[] {
  const result: ProcessedAudioTimelineItemV1[] = [];
  for (const item of items) {
    const previous = result.at(-1);
    if (previous?.kind === "gap" && item.kind === "gap" && previous.destination.end === item.destination.start) {
      result[result.length - 1] = Object.freeze({
        kind: "gap",
        id: `processed_audio_gap_${hash({ left: previous.id, right: item.id }).slice(0, 24)}`,
        destination: Object.freeze({ start: previous.destination.start, end: item.destination.end }),
      });
    } else {
      result.push(item);
    }
  }
  return result;
}

function itemIndex(items: readonly ProcessedAudioTimelineItemV1[], itemId: string, path: string): number {
  const index = items.findIndex((item) => item.id === itemId);
  if (index < 0) fail("CUT_PROCESSED_AUDIO_EDIT_RESULT", path, `does not identify a current item: ${JSON.stringify(itemId)}.`);
  return index;
}

function ensureSource(
  item: ProcessedAudioItemV1,
  source: ProcessedAudioSampleInterval,
  path: string,
): void {
  if (!inside(source, item.availableSource)) {
    fail("CUT_PROCESSED_AUDIO_EDIT_TIME", path, "would exceed authenticated source/handle availability.");
  }
}

function executeStructuralOperations(
  plan: ProcessedAudioTimelinePlanV1,
): {
  items: ProcessedAudioTimelineItemV1[];
  durationSamples: number;
  transitions: ProcessedAudioTimelineTransitionV1[];
  lineage: ProcessedAudioTimelineLineageV1[];
} {
  const authorityById = new Map(plan.authorities.map((authority) => [authority.authorityIdentity, authority]));
  let items = [...plan.items];
  let durationSamples = plan.durationSamples;
  const transitions: ProcessedAudioTimelineTransitionV1[] = [];
  const lineage: ProcessedAudioTimelineLineageV1[] = [];

  const record = (
    operationIndex: number,
    operation: ProcessedAudioTimelineOperationV1,
    originItemId: string,
    result: readonly ProcessedAudioTimelineItemV1[],
  ) => {
    for (const item of result) {
      lineage.push(Object.freeze({
        itemId: item.id,
        originItemId,
        operationIndex,
        operationKind: operation.kind,
      }));
    }
  };

  for (const [operationIndex, operation] of plan.operations.entries()) {
    const path = `$.operations[${operationIndex}]`;
    if (operation.kind === "split") {
      const index = itemIndex(items, operation.itemId, `${path}.itemId`);
      const target = items[index];
      if (operation.atSample <= target.destination.start || operation.atSample >= target.destination.end) {
        fail("CUT_PROCESSED_AUDIO_EDIT_TIME", `${path}.atSample`, "must be strictly inside the selected item.");
      }
      const left = sliceItem(target, Object.freeze({ start: target.destination.start, end: operation.atSample }), operationIndex, "before", authorityById);
      const right = sliceItem(target, Object.freeze({ start: operation.atSample, end: target.destination.end }), operationIndex, "after", authorityById);
      items.splice(index, 1, left, right);
      record(operationIndex, operation, target.id, [left, right]);
      continue;
    }

    if (operation.kind === "trim") {
      const index = itemIndex(items, operation.itemId, `${path}.itemId`);
      const target = items[index];
      if (!inside(operation.keep, target.destination) || (
        operation.keep.start === target.destination.start && operation.keep.end === target.destination.end
      )) {
        fail("CUT_PROCESSED_AUDIO_EDIT_TIME", `${path}.keep`, "must be one proper positive subrange of the selected item.");
      }
      const replacement: ProcessedAudioTimelineItemV1[] = [];
      if (target.destination.start < operation.keep.start) replacement.push(gap(Object.freeze({ start: target.destination.start, end: operation.keep.start }), operationIndex, "trim-leading"));
      const kept = sliceItem(target, operation.keep, operationIndex, "trim-kept", authorityById);
      replacement.push(kept);
      if (operation.keep.end < target.destination.end) replacement.push(gap(Object.freeze({ start: operation.keep.end, end: target.destination.end }), operationIndex, "trim-trailing"));
      items.splice(index, 1, ...replacement);
      items = coalesceGaps(items);
      record(operationIndex, operation, target.id, replacement);
      continue;
    }

    if (operation.kind === "lift" || operation.kind === "extract") {
      if (operation.range.end > durationSamples) fail("CUT_PROCESSED_AUDIO_EDIT_TIME", `${path}.range`, "exceeds the current timeline.");
      const next: ProcessedAudioTimelineItemV1[] = [];
      for (const item of items) {
        if (!intersects(item.destination, operation.range)) {
          next.push(operation.kind === "extract" && item.destination.start >= operation.range.end
            ? shiftedItem(item, -duration(operation.range))
            : item);
          continue;
        }
        if (item.destination.start < operation.range.start) {
          const before = sliceItem(item, Object.freeze({ start: item.destination.start, end: operation.range.start }), operationIndex, "range-before", authorityById);
          next.push(before);
          record(operationIndex, operation, item.id, [before]);
        }
        if (item.destination.end > operation.range.end) {
          let after = sliceItem(item, Object.freeze({ start: operation.range.end, end: item.destination.end }), operationIndex, "range-after", authorityById);
          if (operation.kind === "extract") after = shiftedItem(after, -duration(operation.range));
          next.push(after);
          record(operationIndex, operation, item.id, [after]);
        }
      }
      if (operation.kind === "lift") next.push(gap(operation.range, operationIndex, "lift"));
      items = coalesceGaps(next.sort((left, right) => left.destination.start - right.destination.start || left.id.localeCompare(right.id)));
      if (operation.kind === "extract") durationSamples -= duration(operation.range);
      continue;
    }

    if (operation.kind === "slip") {
      const index = itemIndex(items, operation.itemId, `${path}.itemId`);
      const target = items[index];
      unsupportedItem(target, authorityById, path);
      const source = Object.freeze({
        start: target.source.start + operation.bySamples,
        end: target.source.end + operation.bySamples,
      });
      ensureSource(target, source, path);
      const result = Object.freeze({
        ...target,
        id: generatedId(target.id, operationIndex, "slip", { ...target, source }),
        source,
      });
      items[index] = result;
      record(operationIndex, operation, target.id, [result]);
      continue;
    }

    if (operation.kind === "boundary-adjust") {
      const leftIndex = itemIndex(items, operation.leftItemId, `${path}.leftItemId`);
      const rightIndex = itemIndex(items, operation.rightItemId, `${path}.rightItemId`);
      if (rightIndex !== leftIndex + 1 || items[leftIndex].destination.end !== items[rightIndex].destination.start) {
        fail("CUT_PROCESSED_AUDIO_EDIT_RESULT", path, "must select one adjacent boundary.");
      }
      const left = items[leftIndex], right = items[rightIndex];
      unsupportedItem(left, authorityById, path);
      unsupportedItem(right, authorityById, path);
      const boundary = left.destination.end + operation.bySamples;
      if (boundary <= left.destination.start || boundary >= right.destination.end) {
        fail("CUT_PROCESSED_AUDIO_EDIT_TIME", `${path}.bySamples`, "would exhaust an adjacent item.");
      }
      const leftSource = Object.freeze({ start: left.source.start, end: left.source.end + operation.bySamples });
      const rightSource = Object.freeze({ start: right.source.start + operation.bySamples, end: right.source.end });
      ensureSource(left, leftSource, path);
      ensureSource(right, rightSource, path);
      const adjustedLeft = Object.freeze({
        ...left,
        id: generatedId(left.id, operationIndex, "boundary-left", { ...left, source: leftSource }),
        destination: Object.freeze({ start: left.destination.start, end: boundary }),
        source: leftSource,
      });
      const adjustedRight = Object.freeze({
        ...right,
        id: generatedId(right.id, operationIndex, "boundary-right", { ...right, source: rightSource }),
        destination: Object.freeze({ start: boundary, end: right.destination.end }),
        source: rightSource,
      });
      items.splice(leftIndex, 2, adjustedLeft, adjustedRight);
      record(operationIndex, operation, left.id, [adjustedLeft]);
      record(operationIndex, operation, right.id, [adjustedRight]);
      continue;
    }

    if (operation.kind === "slide") {
      const index = itemIndex(items, operation.itemId, `${path}.itemId`);
      if (index === 0 || index === items.length - 1) {
        fail("CUT_PROCESSED_AUDIO_EDIT_UNSUPPORTED", path, "slide requires one processed neighbor on each side.");
      }
      const previous = items[index - 1], target = items[index], next = items[index + 1];
      unsupportedItem(previous, authorityById, path);
      unsupportedItem(target, authorityById, path);
      unsupportedItem(next, authorityById, path);
      const newStart = target.destination.start + operation.bySamples;
      const newEnd = target.destination.end + operation.bySamples;
      if (newStart <= previous.destination.start || newEnd >= next.destination.end) {
        fail("CUT_PROCESSED_AUDIO_EDIT_TIME", `${path}.bySamples`, "would exhaust an adjacent item.");
      }
      const previousSource = Object.freeze({ start: previous.source.start, end: previous.source.end + operation.bySamples });
      const nextSource = Object.freeze({ start: next.source.start + operation.bySamples, end: next.source.end });
      ensureSource(previous, previousSource, path);
      ensureSource(next, nextSource, path);
      const adjustedPrevious = Object.freeze({
        ...previous,
        id: generatedId(previous.id, operationIndex, "slide-previous", { ...previous, source: previousSource }),
        destination: Object.freeze({ start: previous.destination.start, end: newStart }),
        source: previousSource,
      });
      const adjustedTarget = Object.freeze({
        ...target,
        id: generatedId(target.id, operationIndex, "slide-target", target),
        destination: Object.freeze({ start: newStart, end: newEnd }),
      });
      const adjustedNext = Object.freeze({
        ...next,
        id: generatedId(next.id, operationIndex, "slide-next", { ...next, source: nextSource }),
        destination: Object.freeze({ start: newEnd, end: next.destination.end }),
        source: nextSource,
      });
      items.splice(index - 1, 3, adjustedPrevious, adjustedTarget, adjustedNext);
      record(operationIndex, operation, previous.id, [adjustedPrevious]);
      record(operationIndex, operation, target.id, [adjustedTarget]);
      record(operationIndex, operation, next.id, [adjustedNext]);
      continue;
    }

    const outgoingIndex = itemIndex(items, operation.outgoingItemId, `${path}.outgoingItemId`);
    const incomingIndex = itemIndex(items, operation.incomingItemId, `${path}.incomingItemId`);
    if (incomingIndex !== outgoingIndex + 1) fail("CUT_PROCESSED_AUDIO_EDIT_RESULT", path, "transition items must be adjacent.");
    const outgoing = items[outgoingIndex], incoming = items[incomingIndex];
    unsupportedItem(outgoing, authorityById, path);
    unsupportedItem(incoming, authorityById, path);
    if (outgoing.destination.end !== operation.audioCutSample || incoming.destination.start !== operation.audioCutSample) {
      fail("CUT_PROCESSED_AUDIO_EDIT_TIME", `${path}.audioCutSample`, "must equal the exact audio boundary.");
    }
    if (operation.durationSamples % 2 !== 0) {
      fail("CUT_PROCESSED_AUDIO_EDIT_TIME", `${path}.durationSamples`, "must be even so both half-handles are exact.");
    }
    const half = operation.durationSamples / 2;
    const outgoingHandle = Object.freeze({ start: outgoing.source.end, end: outgoing.source.end + half });
    const incomingHandle = Object.freeze({ start: incoming.source.start - half, end: incoming.source.start });
    ensureSource(outgoing, outgoingHandle, path);
    ensureSource(incoming, incomingHandle, path);
    if (transitions.some((candidate) => candidate.audioCutSample === operation.audioCutSample)) {
      fail("CUT_PROCESSED_AUDIO_EDIT_RESULT", path, "duplicates an existing terminal transition.");
    }
    transitions.push(Object.freeze({
      ...operation,
      outgoingHandle,
      incomingHandle,
    }));
  }

  let cursor = 0;
  for (const item of items) {
    if (item.destination.start !== cursor) {
      fail("CUT_PROCESSED_AUDIO_EDIT_RESULT", "$.operations", "materialized items no longer tile the timeline.");
    }
    cursor = item.destination.end;
  }
  if (cursor !== durationSamples) {
    fail("CUT_PROCESSED_AUDIO_EDIT_RESULT", "$.operations", "materialized duration disagrees with the timeline.");
  }
  return { items, durationSamples, transitions, lineage };
}

function canonicalPlanIdentity(plan: ProcessedAudioTimelinePlanV1): string {
  return hash({
    contract: "cut-processed-audio-timeline-edit-input-v1",
    version: plan.version,
    durationSamples: plan.durationSamples,
    authorities: plan.authorities,
    items: plan.items,
    operations: plan.operations,
  });
}

/**
 * Validate and execute the complete structural transaction before evaluating a
 * graph. Thus malformed timing, unsupported state/retime, handle underflow and
 * topology errors cannot partially evaluate or publish one side. After the
 * candidate succeeds, each authenticated processor graph is evaluated exactly
 * once and every surviving view receives an exact immutable slice witness.
 */
export async function stageProcessedAudioTimelineEditV1(
  value: unknown,
  evaluateGraph: (
    authority: ProcessedAudioGraphAuthorityV1,
  ) => Promise<ProcessedAudioGraphEvaluationReceiptV1> | ProcessedAudioGraphEvaluationReceiptV1,
): Promise<ProcessedAudioTimelineStageV1> {
  const plan = validateProcessedAudioTimelinePlanV1(value);
  const structural = executeStructuralOperations(plan);
  const usedAuthorityIds = [...new Set(
    structural.items.flatMap((item) => item.kind === "processed" ? [item.authorityIdentity] : []),
  )].sort();
  const authorityById = new Map(plan.authorities.map((authority) => [authority.authorityIdentity, authority]));
  const evaluationByAuthority = new Map<string, ProcessedAudioGraphEvaluationReceiptV1>();
  for (const authorityIdentity of usedAuthorityIds) {
    const authority = authorityById.get(authorityIdentity)!;
    const raw = await evaluateGraph(authority);
    const receipt = closed(raw, `evaluation(${authorityIdentity})`, [
      "authorityIdentity",
      "graphIdentity",
      "sourceSampleCount",
      "pcmIdentity",
    ]);
    if (receipt.authorityIdentity !== authorityIdentity
      || receipt.graphIdentity !== authority.graphIdentity
      || receipt.sourceSampleCount !== authority.sourceSampleCount) {
      fail("CUT_PROCESSED_AUDIO_EDIT_AUTHORITY", `evaluation(${authorityIdentity})`, "does not match the authenticated graph authority.");
    }
    const canonical: ProcessedAudioGraphEvaluationReceiptV1 = Object.freeze({
      authorityIdentity,
      graphIdentity: sha256(receipt.graphIdentity, `evaluation(${authorityIdentity}).graphIdentity`),
      sourceSampleCount: safeInteger(receipt.sourceSampleCount, `evaluation(${authorityIdentity}).sourceSampleCount`, 1),
      pcmIdentity: sha256(receipt.pcmIdentity, `evaluation(${authorityIdentity}).pcmIdentity`),
    });
    evaluationByAuthority.set(authorityIdentity, canonical);
  }
  const sampleWitnesses = structural.items.flatMap((item): ProcessedAudioSampleWitnessV1[] => {
    if (item.kind !== "processed") return [];
    const receipt = evaluationByAuthority.get(item.authorityIdentity)!;
    const presentationIdentity = hash({
      contract: "cut-processed-audio-presentation-law-v1",
      presentation: item.presentation,
    });
    const witness: Omit<ProcessedAudioSampleWitnessV1, "witnessIdentity"> = {
      itemId: item.id,
      authorityIdentity: item.authorityIdentity,
      pcmIdentity: receipt.pcmIdentity,
      source: item.source,
      destination: item.destination,
      presentationIdentity,
    };
    return [Object.freeze({
      ...witness,
      witnessIdentity: hash({
        contract: "cut-processed-audio-sample-witness-v1",
        ...witness,
      }),
    })];
  });
  const inputIdentity = canonicalPlanIdentity(plan);
  const graphEvaluations = usedAuthorityIds.map((authorityIdentity) => Object.freeze({
    authorityIdentity,
    pcmIdentity: evaluationByAuthority.get(authorityIdentity)!.pcmIdentity,
    count: 1 as const,
  }));
  const stageContent = {
    contract: "cut-processed-audio-timeline-stage-v1",
    inputIdentity,
    durationSamples: structural.durationSamples,
    items: structural.items,
    transitions: structural.transitions,
    lineage: structural.lineage,
    sampleWitnesses,
    graphEvaluations,
  };
  return Object.freeze({
    version: 1,
    inputIdentity,
    stageIdentity: hash(stageContent),
    durationSamples: structural.durationSamples,
    items: Object.freeze(structural.items),
    transitions: Object.freeze(structural.transitions),
    lineage: Object.freeze(structural.lineage),
    sampleWitnesses: Object.freeze(sampleWitnesses),
    graphEvaluations: Object.freeze(graphEvaluations),
  });
}
