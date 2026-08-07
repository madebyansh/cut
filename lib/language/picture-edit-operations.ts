import { hash, stableJsonStringify } from "../core/stable";
import type { IREditorialInterval, IRPictureTimeMap, IRProvenance, IRValue } from "./ir";
import {
  authoredPictureTimeMap,
  canonicalPictureTimeMapInputs,
  isDefaultPictureTimeMap,
  pictureSpeedRampInput,
  pictureSpeedRampSourceOffset,
  PictureTimeMapInputError,
  slicePictureSpeedRamp,
} from "./picture-time-map";
import { addRational, compareRational, divideRational, multiplyRational, rational, subtractRational, type Rational, zeroRational } from "./rational";
import { editClipParameterNames } from "./picture-edit-signature";
import { cutTranscriptPictureSegmentIdentity } from "./transcript-contract";

export type IRPictureEditItem = {
  origin: string;
  kind: "picture" | "gap";
  destination: IREditorialInterval;
  inputs: Record<string, IRValue>;
  provenance: IRProvenance;
  source?: IREditorialInterval;
  timeMap?: IRPictureTimeMap;
  linkSegmentId?: string;
};

export const pictureTrackTransitionKinds = ["cross-dissolve", "dip", "wipe", "push", "slide"] as const;
export const pictureTrackTransitionDirections = ["left", "right", "up", "down"] as const;
export type IRPictureTrackTransitionKind = typeof pictureTrackTransitionKinds[number];
export type IRPictureTrackTransitionDirection = typeof pictureTrackTransitionDirections[number];

export type IRPictureTrackTransitionStyle =
  | { kind: "cross-dissolve" }
  | { kind: "dip"; color: string }
  | { kind: "wipe"; direction: IRPictureTrackTransitionDirection; softness: Rational }
  | { kind: "push" | "slide"; direction: IRPictureTrackTransitionDirection };

/**
 * A transition resolved against the post-edit item list. Source intervals are
 * the exact handle samples consumed by the centered overlap, not the total
 * handle availability declared on either clip.
 */
export type IRPictureTrackTransition = {
  cut: Rational;
  duration: Rational;
  overlap: IREditorialInterval;
  outgoingIndex: number;
  incomingIndex: number;
  outgoingOrigin: string;
  incomingOrigin: string;
  outgoingSource: IREditorialInterval;
  incomingSource: IREditorialInterval;
  style: IRPictureTrackTransitionStyle;
  provenance: IRProvenance;
};

export type IRPictureTrackOperation =
  | { kind: "split"; at: Rational; provenance: IRProvenance }
  | { kind: "trim"; keep: IREditorialInterval; transactionId?: string; provenance: IRProvenance }
  | { kind: "ripple-insert"; at: Rational; item: IRPictureEditItem; transactionId?: string; provenance: IRProvenance }
  | { kind: "ripple-delete"; range: IREditorialInterval; transactionId?: string; transactionVersion?: 1 | 2; linkSegmentIds?: { before: string; after: string }; provenance: IRProvenance }
  | { kind: "overwrite"; range: IREditorialInterval; item: IRPictureEditItem; provenance: IRProvenance }
  | { kind: "replace"; range: IREditorialInterval; item: IRPictureEditItem; provenance: IRProvenance }
  | { kind: "lift"; range: IREditorialInterval; provenance: IRProvenance }
  | { kind: "extract"; range: IREditorialInterval; provenance: IRProvenance }
  | { kind: "slip"; range: IREditorialInterval; by: Rational; provenance: IRProvenance }
  | { kind: "slide"; range: IREditorialInterval; by: Rational; provenance: IRProvenance }
  | { kind: "transition"; at: Rational; duration: Rational; style: IRPictureTrackTransitionStyle; provenance: IRProvenance };

export type IRPictureTrackOperationPlan = {
  version: 1;
  sourceDuration: Rational;
  baseItems: IRPictureEditItem[];
  operations: IRPictureTrackOperation[];
};

export type IRPictureTrackExecution = {
  items: IRPictureEditItem[];
  transitions: IRPictureTrackTransition[];
};

function refreshedTranscriptPictureSegment(
  item: IRPictureEditItem,
): IRPictureEditItem {
  if (item.kind !== "picture" || !item.source) return item;
  const origin = item.inputs.transcriptPictureOriginIdentity;
  if (origin?.kind !== "string") return item;
  const segmentIdentity = cutTranscriptPictureSegmentIdentity({
    transcriptPictureOriginIdentity: origin.value,
    sourceRange: item.source,
    destinationRange: item.destination,
    timeMap: item.timeMap ?? {
      kind: "constant",
      direction: "forward",
      rate: rational(1),
    },
  });
  return {
    ...item,
    inputs: {
      ...item.inputs,
      transcriptPictureSegmentIdentity: {
        kind: "string",
        value: segmentIdentity,
      },
    },
  };
}

export type PictureEditOperationErrorKind = "shape" | "time" | "no-op" | "unsupported" | "result";

export class PictureEditOperationError extends Error {
  constructor(readonly kind: PictureEditOperationErrorKind, message: string, readonly operationIndex?: number) {
    super(message);
    this.name = "PictureEditOperationError";
  }
}

function timeValue(value: Rational): IRValue {
  return { kind: "quantity", dimension: "time", magnitude: value, unit: "s" };
}

function exactTime(value: IRValue | undefined, label: string, operationIndex?: number) {
  if (value?.kind !== "quantity" || value.dimension !== "time") throw new PictureEditOperationError("shape", `${label} must be an exact Time value.`, operationIndex);
  return value.magnitude;
}

function positiveDuration(value: Rational, label: string, operationIndex?: number) {
  if (compareRational(value, zeroRational) <= 0) throw new PictureEditOperationError("time", `${label} must be positive.`, operationIndex);
  return value;
}

function nonNegativeTimeInput(inputs: Record<string, IRValue>, name: "headHandle" | "tailHandle", label: string, operationIndex?: number) {
  const value = inputs[name];
  if (value === undefined) return zeroRational;
  const exact = exactTime(value, label, operationIndex);
  if (compareRational(exact, zeroRational) < 0) throw new PictureEditOperationError("time", `${label} cannot be negative.`, operationIndex);
  return exact;
}

function exactString(value: IRValue | undefined, label: string, operationIndex: number) {
  if (value?.kind !== "string") throw new PictureEditOperationError("shape", `${label} must be a String literal.`, operationIndex);
  return value.value;
}

function exactRatio(value: IRValue | undefined, label: string, operationIndex: number) {
  if (value?.kind !== "quantity" || value.dimension !== "ratio") throw new PictureEditOperationError("shape", `${label} must be a Ratio value.`, operationIndex);
  if (compareRational(value.magnitude, zeroRational) < 0 || compareRational(value.magnitude, rational(1)) > 0) {
    throw new PictureEditOperationError("time", `${label} must be in [0%, 100%].`, operationIndex);
  }
  return value.magnitude;
}

function transitionStyle(args: Record<string, IRValue>, operationIndex: number): IRPictureTrackTransitionStyle {
  const kind = exactString(args.kind, "transitionAt kind", operationIndex) as IRPictureTrackTransitionKind;
  if (!pictureTrackTransitionKinds.includes(kind)) {
    throw new PictureEditOperationError("unsupported", `transitionAt kind must be one of: ${pictureTrackTransitionKinds.join(", ")}.`, operationIndex);
  }
  const direction = (args.direction === undefined ? "left" : exactString(args.direction, "transitionAt direction", operationIndex)) as IRPictureTrackTransitionDirection;
  if (!pictureTrackTransitionDirections.includes(direction)) {
    throw new PictureEditOperationError("unsupported", `transitionAt direction must be one of: ${pictureTrackTransitionDirections.join(", ")}.`, operationIndex);
  }
  if ((kind === "cross-dissolve" || kind === "dip") && args.direction !== undefined) {
    throw new PictureEditOperationError("no-op", `transitionAt direction is not meaningful for ${kind}.`, operationIndex);
  }
  if (kind !== "wipe" && args.softness !== undefined) {
    throw new PictureEditOperationError("no-op", `transitionAt softness is valid only for wipe.`, operationIndex);
  }
  if (kind !== "dip" && args.color !== undefined) {
    throw new PictureEditOperationError("no-op", `transitionAt color is valid only for dip.`, operationIndex);
  }
  if (kind === "cross-dissolve") return { kind };
  if (kind === "dip") {
    if (args.color !== undefined && args.color.kind !== "color") throw new PictureEditOperationError("shape", "transitionAt color must be a Color value.", operationIndex);
    return { kind, color: args.color?.kind === "color" ? args.color.value : "#000000ff" };
  }
  if (kind === "wipe") return { kind, direction, softness: args.softness === undefined ? zeroRational : exactRatio(args.softness, "transitionAt softness", operationIndex) };
  return { kind, direction };
}

function exactRange(value: IRValue | undefined, label: string, operationIndex?: number): IREditorialInterval {
  if (value?.kind !== "range" || !value.exclusive) throw new PictureEditOperationError("shape", `${label} must be an exact half-open Range<Time>; use start ..< end.`, operationIndex);
  const start = exactTime(value.start, `${label} start`, operationIndex), end = exactTime(value.end, `${label} end`, operationIndex);
  if (compareRational(start, zeroRational) < 0 || compareRational(end, start) <= 0) throw new PictureEditOperationError("time", `${label} must be positive and cannot begin before zero.`, operationIndex);
  return { start, duration: subtractRational(end, start) };
}

function intervalEnd(interval: IREditorialInterval) { return addRational(interval.start, interval.duration); }
function sameRational(left: Rational, right: Rational) { return compareRational(left, right) === 0; }
function sameInterval(left: IREditorialInterval, right: IREditorialInterval) { return sameRational(left.start, right.start) && sameRational(left.duration, right.duration); }

function callArguments(value: IRValue, op: string, names: readonly string[], operationIndex: number) {
  if (value.kind !== "call" || value.op !== op) throw new PictureEditOperationError("shape", `edit ${operationIndex + 1} must be a supported @cut/edit operation call.`, operationIndex);
  if (value.positional.length > names.length) throw new PictureEditOperationError("shape", `${op} received too many positional arguments.`, operationIndex);
  for (const key of Object.keys(value.named)) if (!names.includes(key)) throw new PictureEditOperationError("shape", `${op} received unknown argument “${key}”.`, operationIndex);
  const result: Record<string, IRValue> = {};
  value.positional.forEach((item, index) => { result[names[index]] = item; });
  for (const [key, item] of Object.entries(value.named)) {
    if (Object.hasOwn(result, key)) throw new PictureEditOperationError("shape", `${op} received argument “${key}” more than once.`, operationIndex);
    result[key] = item;
  }
  return result;
}

function operationItem(value: IRValue | undefined, operationIndex: number, provenance: IRProvenance): IRPictureEditItem {
  if (!value || value.kind !== "call") throw new PictureEditOperationError("shape", `edit ${operationIndex + 1} item must be editClip(...) or editGap(...).`, operationIndex);
  const origin = `operation:${operationIndex}`;
  if (value.op === "cut.edit.value.gap") {
    const args = callArguments(value, value.op, ["duration"], operationIndex);
    const duration = positiveDuration(exactTime(args.duration, "editGap duration", operationIndex), "editGap duration", operationIndex);
    return { origin, kind: "gap", destination: { start: zeroRational, duration }, inputs: { duration: timeValue(duration) }, provenance };
  }
  if (value.op !== "cut.edit.value.clip") throw new PictureEditOperationError("shape", `edit ${operationIndex + 1} item must be editClip(...) or editGap(...).`, operationIndex);
  // New optional fields append to the positional ABI. Reordering existing
  // slots would make previously valid 0.3 source silently mean something else.
  const args = callArguments(value, value.op, editClipParameterNames, operationIndex);
  if (args.source?.kind !== "resource-ref") throw new PictureEditOperationError("shape", "editClip source must resolve to a VideoAsset.", operationIndex);
  const source = exactRange(args.range, "editClip range", operationIndex);
  const duration = positiveDuration(exactTime(args.duration, "editClip duration", operationIndex), "editClip duration", operationIndex);
  nonNegativeTimeInput(args, "headHandle", "editClip headHandle", operationIndex);
  nonNegativeTimeInput(args, "tailHandle", "editClip tailHandle", operationIndex);
  let timeMap: IRPictureTimeMap;
  try { timeMap = authoredPictureTimeMap(args, duration); }
  catch (error) {
    if (!(error instanceof PictureTimeMapInputError)) throw error;
    throw new PictureEditOperationError("time", error.message, operationIndex);
  }
  const inputs = canonicalPictureTimeMapInputs(args, timeMap);
  return {
    origin,
    kind: "picture",
    destination: { start: zeroRational, duration },
    source,
    ...(!isDefaultPictureTimeMap(timeMap) ? { timeMap } : {}),
    inputs,
    provenance,
  };
}

export function pictureEditOperationsFromInput(value: IRValue | undefined, provenances: readonly IRProvenance[]): IRPictureTrackOperation[] {
  if (value?.kind !== "array" || !value.items.length) throw new PictureEditOperationError("shape", "PictureTrack edits must be a non-empty List<PictureEdit>.");
  if (value.items.length !== provenances.length) throw new PictureEditOperationError("shape", "PictureTrack edit source provenance does not cover every operation.");
  return value.items.map((operation, index): IRPictureTrackOperation => {
    const provenance = provenances[index];
    if (operation.kind !== "call") throw new PictureEditOperationError("shape", `edit ${index + 1} must be a supported @cut/edit operation call.`, index);
    if (operation.op === "cut.edit.operation.split") {
      const args = callArguments(operation, operation.op, ["at"], index);
      return { kind: "split", at: exactTime(args.at, "split at", index), provenance };
    }
    if (operation.op === "cut.edit.operation.trim") {
      const args = callArguments(operation, operation.op, ["keep"], index);
      return { kind: "trim", keep: exactRange(args.keep, "trim keep", index), provenance };
    }
    if (operation.op === "cut.edit.operation.ripple_insert") {
      const args = callArguments(operation, operation.op, ["at", "item"], index);
      return { kind: "ripple-insert", at: exactTime(args.at, "rippleInsert at", index), item: operationItem(args.item, index, provenance), provenance };
    }
    if (operation.op === "cut.edit.operation.ripple_delete") {
      const args = callArguments(operation, operation.op, ["range"], index);
      return { kind: "ripple-delete", range: exactRange(args.range, "rippleDelete range", index), provenance };
    }
    if (operation.op === "cut.edit.operation.overwrite") {
      const args = callArguments(operation, operation.op, ["range", "item"], index);
      return { kind: "overwrite", range: exactRange(args.range, "overwrite range", index), item: operationItem(args.item, index, provenance), provenance };
    }
    if (operation.op === "cut.edit.operation.replace") {
      const args = callArguments(operation, operation.op, ["range", "item"], index);
      return { kind: "replace", range: exactRange(args.range, "replace range", index), item: operationItem(args.item, index, provenance), provenance };
    }
    if (operation.op === "cut.edit.operation.lift") {
      const args = callArguments(operation, operation.op, ["range"], index);
      return { kind: "lift", range: exactRange(args.range, "lift range", index), provenance };
    }
    if (operation.op === "cut.edit.operation.extract") {
      const args = callArguments(operation, operation.op, ["range"], index);
      return { kind: "extract", range: exactRange(args.range, "extract range", index), provenance };
    }
    if (operation.op === "cut.edit.operation.slip") {
      const args = callArguments(operation, operation.op, ["range", "by"], index);
      return { kind: "slip", range: exactRange(args.range, "slip range", index), by: exactTime(args.by, "slip by", index), provenance };
    }
    if (operation.op === "cut.edit.operation.slide") {
      const args = callArguments(operation, operation.op, ["range", "by"], index);
      return { kind: "slide", range: exactRange(args.range, "slide range", index), by: exactTime(args.by, "slide by", index), provenance };
    }
    if (operation.op === "cut.edit.operation.transition_at") {
      const args = callArguments(operation, operation.op, ["at", "duration", "kind", "direction", "softness", "color"], index);
      const duration = positiveDuration(exactTime(args.duration, "transitionAt duration", index), "transitionAt duration", index);
      return { kind: "transition", at: exactTime(args.at, "transitionAt at", index), duration, style: transitionStyle(args, index), provenance };
    }
    throw new PictureEditOperationError("shape", `edit ${index + 1} uses unsupported operation ${operation.op}.`, index);
  });
}

function cloneTimeMap(value: IRPictureTimeMap | undefined): IRPictureTimeMap | undefined {
  if (!value) return undefined;
  if (value.kind === "freeze") return { kind: "freeze", at: value.at, ...(value.frameSelection ? { frameSelection: value.frameSelection } : {}) };
  if (value.kind === "speed-ramp") return { ...value, points: value.points.map((point) => ({ ...point })) };
  return { ...value, rate: value.rate };
}

function segment(item: IRPictureEditItem, start: Rational, duration: Rational): IRPictureEditItem {
  const offset = subtractRational(start, item.destination.start);
  if (compareRational(offset, zeroRational) < 0 || compareRational(addRational(offset, duration), item.destination.duration) > 0 || compareRational(duration, zeroRational) <= 0) {
    throw new PictureEditOperationError("result", "internal edit segment lies outside its source item.");
  }
  if (item.kind === "gap") return { ...item, destination: { start, duration }, inputs: { duration: timeValue(duration) } };
  if (!item.source) throw new PictureEditOperationError("result", "picture edit item is missing its source interval.");
  const map = item.timeMap;
  let source: IREditorialInterval;
  let segmentedMap: IRPictureTimeMap;
  if (map?.kind === "freeze") {
    source = item.source;
    segmentedMap = cloneTimeMap(map)!;
  }
  else if (map?.kind === "speed-ramp") {
    const sourceStartOffset = pictureSpeedRampSourceOffset(map, offset);
    const sourceEndOffset = pictureSpeedRampSourceOffset(map, addRational(offset, duration));
    source = {
      start: addRational(item.source.start, sourceStartOffset),
      duration: subtractRational(sourceEndOffset, sourceStartOffset),
    };
    segmentedMap = slicePictureSpeedRamp(map, offset, duration);
  }
  else {
    const rate = map?.kind === "constant" ? map.rate : { numerator: "1", denominator: "1" };
    const sourceDuration = multiplyRational(duration, rate), sourceOffset = multiplyRational(offset, rate);
    if (map?.kind === "constant" && map.direction === "reverse") {
      const sourceEnd = intervalEnd(item.source);
      source = { start: subtractRational(sourceEnd, addRational(sourceOffset, sourceDuration)), duration: sourceDuration };
    } else source = { start: addRational(item.source.start, sourceOffset), duration: sourceDuration };
    segmentedMap = map ? cloneTimeMap(map)! : { kind: "constant", direction: "forward", rate: { numerator: "1", denominator: "1" } };
  }
  const rawInputs: Record<string, IRValue> = {
    ...item.inputs,
    duration: timeValue(duration),
    range: { kind: "range", start: timeValue(source.start), end: timeValue(intervalEnd(source)), exclusive: true } as IRValue,
    ...(segmentedMap.kind === "speed-ramp" ? { speedRamp: pictureSpeedRampInput(segmentedMap) } : {}),
  };
  const inputs = canonicalPictureTimeMapInputs(rawInputs, segmentedMap);
  return {
    ...item,
    destination: { start, duration },
    source,
    ...(!isDefaultPictureTimeMap(segmentedMap) ? { timeMap: segmentedMap } : { timeMap: undefined }),
    inputs,
  };
}

function totalDuration(items: readonly IRPictureEditItem[]) { return items.length ? intervalEnd(items.at(-1)!.destination) : zeroRational; }

function reflow(items: readonly IRPictureEditItem[]) {
  let cursor = zeroRational;
  return items.map((item) => {
    const next = segment(item, item.destination.start, item.destination.duration);
    next.destination = { start: cursor, duration: item.destination.duration };
    cursor = addRational(cursor, item.destination.duration);
    return next;
  });
}

function boundary(items: readonly IRPictureEditItem[], at: Rational, operationIndex: number) {
  const total = totalDuration(items);
  if (compareRational(at, zeroRational) < 0 || compareRational(at, total) > 0) throw new PictureEditOperationError("time", `edit point lies outside the current 0s ..< ${total.numerator}/${total.denominator}s track.`, operationIndex);
  const index = items.findIndex((item) => compareRational(at, item.destination.start) > 0 && compareRational(at, intervalEnd(item.destination)) < 0);
  if (index < 0) return { items: [...items], changed: false };
  const item = items[index], leftDuration = subtractRational(at, item.destination.start), rightDuration = subtractRational(intervalEnd(item.destination), at);
  return { items: [...items.slice(0, index), segment(item, item.destination.start, leftDuration), segment(item, at, rightDuration), ...items.slice(index + 1)], changed: true };
}

function ranged(items: readonly IRPictureEditItem[], range: IREditorialInterval, operationIndex: number) {
  const total = totalDuration(items), end = intervalEnd(range);
  if (compareRational(range.start, zeroRational) < 0 || compareRational(end, total) > 0) throw new PictureEditOperationError("time", "edit range lies outside the current track duration.", operationIndex);
  const startBoundary = boundary(items, range.start, operationIndex), endBoundary = boundary(startBoundary.items, end, operationIndex);
  const inside = endBoundary.items.filter((item) => compareRational(item.destination.start, range.start) >= 0 && compareRational(intervalEnd(item.destination), end) <= 0);
  if (!inside.length) throw new PictureEditOperationError("no-op", "edit range selects no timeline material.", operationIndex);
  return { items: endBoundary.items, inside, end };
}

function semanticItem(item: IRPictureEditItem) {
  return { kind: item.kind, destination: item.destination, inputs: item.inputs, ...(item.source ? { source: item.source } : {}), ...(item.timeMap ? { timeMap: item.timeMap } : {}), ...(item.linkSegmentId ? { linkSegmentId: item.linkSegmentId } : {}) };
}

function sameSemanticItems(left: readonly IRPictureEditItem[], right: readonly IRPictureEditItem[]) {
  return stableJsonStringify(left.map(semanticItem)) === stableJsonStringify(right.map(semanticItem));
}

function linkedRippleSegmentIds(
  operation: Extract<IRPictureTrackOperation, { kind: "ripple-delete" }>,
  operationIndex: number,
) {
  if (!operation.transactionId) {
    if (operation.transactionVersion !== undefined || operation.linkSegmentIds !== undefined) {
      throw new PictureEditOperationError("shape", "linked ripple transaction metadata requires one correlated transactionId.", operationIndex);
    }
    return undefined;
  }
  if (operation.transactionVersion !== 1 && operation.transactionVersion !== 2) {
    throw new PictureEditOperationError("shape", "linked ripple transactionId requires transactionVersion 1 or 2.", operationIndex);
  }
  if (operation.transactionVersion === 1) {
    if (operation.linkSegmentIds !== undefined) {
      throw new PictureEditOperationError("shape", "linked ripple transactionVersion 1 cannot declare survivor segment identity.", operationIndex);
    }
    return undefined;
  }
  if (operation.linkSegmentIds === undefined) {
    throw new PictureEditOperationError("shape", "linked ripple transactionVersion 2 requires before/after survivor segment identity.", operationIndex);
  }
  const safe = (value: string) => Boolean(value)
    && value === value.trim()
    && value.length <= 512
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && !["__proto__", "prototype", "constructor"].includes(value);
  if (!safe(operation.linkSegmentIds.before) || !safe(operation.linkSegmentIds.after)) {
    throw new PictureEditOperationError("shape", "linked ripple before/after segment ids must be distinct safe CUT entity ids.", operationIndex);
  }
  if (operation.linkSegmentIds.before === operation.linkSegmentIds.after) {
    throw new PictureEditOperationError("shape", "linked ripple before/after segment ids must be distinct.", operationIndex);
  }
  return operation.linkSegmentIds;
}

function markLinkedRippleSegments(
  items: IRPictureEditItem[],
  inside: readonly IRPictureEditItem[],
  ids: { before: string; after: string },
  operationIndex: number,
) {
  if (inside.length !== 1 || inside[0].kind !== "picture") {
    throw new PictureEditOperationError("unsupported", "partial LinkedRippleDelete must select exactly one direct PictureClip interior.", operationIndex);
  }
  const selectedIndex = items.indexOf(inside[0]);
  const before = items[selectedIndex - 1], after = items[selectedIndex + 1], selected = inside[0];
  const link = selected.inputs.link;
  const sameLinkedOrigin = (candidate: IRPictureEditItem | undefined) => candidate?.kind === "picture"
    && candidate.origin === selected.origin
    && candidate.inputs.link?.kind === "string"
    && link?.kind === "string"
    && candidate.inputs.link.value === link.value;
  if (!sameLinkedOrigin(before) || !sameLinkedOrigin(after) || before.linkSegmentId !== undefined || selected.linkSegmentId !== undefined || after.linkSegmentId !== undefined) {
    throw new PictureEditOperationError("unsupported", "partial LinkedRippleDelete range must be strictly inside one unsegmented linked PictureClip and leave positive before/after fragments.", operationIndex);
  }
  before.linkSegmentId = ids.before;
  after.linkSegmentId = ids.after;
}

function atZero(item: IRPictureEditItem): IRPictureEditItem {
  return { ...item, destination: { start: zeroRational, duration: item.destination.duration } };
}

function gap(start: Rational, duration: Rational, provenance: IRProvenance, origin: string): IRPictureEditItem {
  return { origin, kind: "gap", destination: { start, duration }, inputs: { duration: timeValue(duration) }, provenance };
}

function sourceRangeValue(source: IREditorialInterval): IRValue {
  return { kind: "range", start: timeValue(source.start), end: timeValue(intervalEnd(source)), exclusive: true };
}

function resizedPictureItem(
  item: IRPictureEditItem,
  destination: IREditorialInterval,
  source: IREditorialInterval,
  freezeAt = item.timeMap?.kind === "freeze" ? item.timeMap.at : undefined,
  operationIndex?: number,
): IRPictureEditItem {
  if (item.kind !== "picture" || !item.source) throw new PictureEditOperationError("result", "internal picture resize requires one sourced PictureClip.", operationIndex);
  if (compareRational(destination.duration, zeroRational) <= 0 || compareRational(source.start, zeroRational) < 0 || compareRational(source.duration, zeroRational) <= 0) {
    throw new PictureEditOperationError("time", "picture edit would move a source or destination boundary before zero.", operationIndex);
  }
  const inputs: Record<string, IRValue> = {
    ...item.inputs,
    duration: timeValue(destination.duration),
    range: sourceRangeValue(source),
    ...(freezeAt ? { freezeAt: timeValue(freezeAt) } : {}),
  };
  let timeMap: IRPictureTimeMap;
  try { timeMap = authoredPictureTimeMap(inputs, destination.duration); }
  catch (error) {
    if (!(error instanceof PictureTimeMapInputError)) throw error;
    throw new PictureEditOperationError("time", error.message, operationIndex);
  }
  return {
    ...item,
    destination,
    source,
    ...(!isDefaultPictureTimeMap(timeMap) ? { timeMap } : {}),
    inputs: canonicalPictureTimeMapInputs(inputs, timeMap),
  };
}

function slipItem(item: IRPictureEditItem, by: Rational, operationIndex: number): IRPictureEditItem {
  if (item.kind !== "picture" || !item.source) throw new PictureEditOperationError("unsupported", "slip range must exactly identify one current PictureClip; gaps and partial selections are not slip operands.", operationIndex);
  const source = { start: addRational(item.source.start, by), duration: item.source.duration };
  const freezeAt = item.timeMap?.kind === "freeze" ? addRational(item.timeMap.at, by) : undefined;
  return resizedPictureItem(item, { ...item.destination }, source, freezeAt, operationIndex);
}

function resizeTail(item: IRPictureEditItem, duration: Rational, operationIndex: number): IRPictureEditItem {
  if (compareRational(duration, zeroRational) <= 0) throw new PictureEditOperationError("time", "slide cannot consume an adjacent item completely; leave a positive exact duration.", operationIndex);
  const comparison = compareRational(duration, item.destination.duration);
  if (comparison === 0) return item;
  if (comparison < 0) return segment(item, item.destination.start, duration);
  if (item.kind === "gap") return gap(item.destination.start, duration, item.provenance, item.origin);
  if (!item.source) throw new PictureEditOperationError("result", "slide adjacent PictureClip is missing its source interval.", operationIndex);
  const extension = subtractRational(duration, item.destination.duration);
  if (item.timeMap?.kind === "freeze") return resizedPictureItem(item, { start: item.destination.start, duration }, item.source, undefined, operationIndex);
  if (item.timeMap?.kind === "speed-ramp") {
    const lastRate = item.timeMap.points.at(-1)!.rate;
    const map: Extract<IRPictureTimeMap, { kind: "speed-ramp" }> = {
      ...item.timeMap,
      points: [...item.timeMap.points.map((point) => ({ ...point })), { at: duration, rate: lastRate }],
    };
    const sourceExtension = multiplyRational(extension, lastRate);
    const source = { start: item.source.start, duration: addRational(item.source.duration, sourceExtension) };
    return resizedPictureItem({ ...item, timeMap: map, inputs: { ...item.inputs, speedRamp: pictureSpeedRampInput(map) } }, { start: item.destination.start, duration }, source, undefined, operationIndex);
  }
  const rate = item.timeMap?.kind === "constant" ? item.timeMap.rate : { numerator: "1", denominator: "1" };
  const sourceExtension = multiplyRational(extension, rate);
  const reverse = item.timeMap?.kind === "constant" && item.timeMap.direction === "reverse";
  const source = reverse
    ? { start: subtractRational(item.source.start, sourceExtension), duration: addRational(item.source.duration, sourceExtension) }
    : { start: item.source.start, duration: addRational(item.source.duration, sourceExtension) };
  return resizedPictureItem(item, { start: item.destination.start, duration }, source, undefined, operationIndex);
}

function resizeHead(item: IRPictureEditItem, duration: Rational, operationIndex: number): IRPictureEditItem {
  if (compareRational(duration, zeroRational) <= 0) throw new PictureEditOperationError("time", "slide cannot consume an adjacent item completely; leave a positive exact duration.", operationIndex);
  const comparison = compareRational(duration, item.destination.duration);
  if (comparison === 0) return item;
  if (comparison < 0) {
    const removed = subtractRational(item.destination.duration, duration);
    return segment(item, addRational(item.destination.start, removed), duration);
  }
  const extension = subtractRational(duration, item.destination.duration), destination = { start: subtractRational(item.destination.start, extension), duration };
  if (item.kind === "gap") return gap(destination.start, duration, item.provenance, item.origin);
  if (!item.source) throw new PictureEditOperationError("result", "slide adjacent PictureClip is missing its source interval.", operationIndex);
  if (item.timeMap?.kind === "freeze") return resizedPictureItem(item, destination, item.source, undefined, operationIndex);
  if (item.timeMap?.kind === "speed-ramp") {
    const firstRate = item.timeMap.points[0].rate;
    const map: Extract<IRPictureTimeMap, { kind: "speed-ramp" }> = {
      ...item.timeMap,
      points: [
        { at: zeroRational, rate: firstRate },
        ...item.timeMap.points.map((point) => ({ at: addRational(point.at, extension), rate: point.rate })),
      ],
    };
    const sourceExtension = multiplyRational(extension, firstRate);
    const source = { start: subtractRational(item.source.start, sourceExtension), duration: addRational(item.source.duration, sourceExtension) };
    return resizedPictureItem({ ...item, timeMap: map, inputs: { ...item.inputs, speedRamp: pictureSpeedRampInput(map) } }, destination, source, undefined, operationIndex);
  }
  const rate = item.timeMap?.kind === "constant" ? item.timeMap.rate : { numerator: "1", denominator: "1" };
  const sourceExtension = multiplyRational(extension, rate);
  const reverse = item.timeMap?.kind === "constant" && item.timeMap.direction === "reverse";
  const source = reverse
    ? { start: item.source.start, duration: addRational(item.source.duration, sourceExtension) }
    : { start: subtractRational(item.source.start, sourceExtension), duration: addRational(item.source.duration, sourceExtension) };
  return resizedPictureItem(item, destination, source, undefined, operationIndex);
}

function coalesceGaps(items: readonly IRPictureEditItem[]) {
  const result: IRPictureEditItem[] = [];
  for (const item of reflow(items)) {
    const previous = result.at(-1);
    if (previous?.kind === "gap" && item.kind === "gap") {
      const duration = addRational(previous.destination.duration, item.destination.duration);
      result[result.length - 1] = gap(previous.destination.start, duration, previous.provenance, previous.origin);
    } else result.push(item);
  }
  return reflow(result);
}

function exactPictureTarget(items: readonly IRPictureEditItem[], range: IREditorialInterval, operation: "slip" | "slide", operationIndex: number) {
  const trackDuration = totalDuration(items), rangeEnd = intervalEnd(range);
  if (compareRational(range.start, zeroRational) < 0 || compareRational(rangeEnd, trackDuration) > 0) {
    throw new PictureEditOperationError("time", `${operation} range lies outside the current track duration.`, operationIndex);
  }
  const targetIndex = items.findIndex((item) => sameInterval(item.destination, range));
  if (targetIndex < 0 || items[targetIndex].kind !== "picture") {
    throw new PictureEditOperationError("unsupported", `${operation} range must exactly identify one current PictureClip; gaps, partial selections, and ranges crossing edit boundaries are ambiguous.`, operationIndex);
  }
  return targetIndex;
}

function ensurePlanBase(plan: IRPictureTrackOperationPlan) {
  if (plan.version !== 1 || !plan.baseItems.length || !plan.operations.length) throw new PictureEditOperationError("shape", "PictureTrack operation plan must contain a non-empty v1 base and operation list.");
  let cursor = zeroRational;
  for (const [index, item] of plan.baseItems.entries()) {
    if (item.origin !== `base:${index}`) throw new PictureEditOperationError("shape", `base item ${index} has non-canonical origin identity.`);
    if (!sameRational(item.destination.start, cursor) || compareRational(item.destination.duration, zeroRational) <= 0) throw new PictureEditOperationError("shape", `base item ${index} is not a positive contiguous source interval.`);
    cursor = intervalEnd(item.destination);
  }
  if (!sameRational(cursor, plan.sourceDuration)) throw new PictureEditOperationError("shape", "base items do not fill sourceDuration exactly.");
  plan.operations.forEach((operation, index) => {
    if ("item" in operation && operation.item.origin !== `operation:${index}`) throw new PictureEditOperationError("shape", `operation ${index + 1} has non-canonical item origin identity.`, index);
  });
}

function resolvePictureTrackTransition(
  items: readonly IRPictureEditItem[],
  operation: Extract<IRPictureTrackOperation, { kind: "transition" }>,
  operationIndex: number,
  resolved: readonly IRPictureTrackTransition[],
): IRPictureTrackTransition {
  const total = totalDuration(items), half = divideRational(operation.duration, rational(2));
  if (compareRational(operation.at, zeroRational) <= 0 || compareRational(operation.at, total) >= 0) {
    throw new PictureEditOperationError("unsupported", "transitionAt must identify an internal hard cut; track-edge transitions are not defined.", operationIndex);
  }
  const incomingIndex = items.findIndex((item) => sameRational(item.destination.start, operation.at));
  if (incomingIndex <= 0) {
    const containing = items.some((item) => compareRational(operation.at, item.destination.start) > 0 && compareRational(operation.at, intervalEnd(item.destination)) < 0);
    throw new PictureEditOperationError(containing ? "unsupported" : "no-op", containing
      ? "transitionAt is ambiguous inside a clip; split it first or target an existing hard cut."
      : "transitionAt does not identify an existing hard cut after the complete structural edit list.", operationIndex);
  }
  const outgoingIndex = incomingIndex - 1, outgoing = items[outgoingIndex], incoming = items[incomingIndex];
  if (outgoing.kind !== "picture" || incoming.kind !== "picture" || !outgoing.source || !incoming.source) {
    throw new PictureEditOperationError("unsupported", "transitionAt requires two adjacent PictureClips; a Gap cannot provide transition media.", operationIndex);
  }
  if (outgoing.inputs.link !== undefined || incoming.inputs.link !== undefined) {
    throw new PictureEditOperationError("unsupported", "transitionAt on linked picture/audio is refused until CUT can preserve the coupled audio edit explicitly.", operationIndex);
  }
  const forwardOne = (item: IRPictureEditItem) => !item.timeMap || (item.timeMap.kind === "constant" && item.timeMap.direction === "forward" && sameRational(item.timeMap.rate, rational(1)));
  if (!forwardOne(outgoing) || !forwardOne(incoming)) {
    throw new PictureEditOperationError("unsupported", "transitionAt v1 requires adjacent forward 1x clips; freeze, reverse, variable speed, and non-1x handle mapping are not yet defined.", operationIndex);
  }
  if (compareRational(half, outgoing.destination.duration) > 0 || compareRational(half, incoming.destination.duration) > 0) {
    throw new PictureEditOperationError("time", "transitionAt centered overlap cannot extend beyond either adjacent visible clip interval.", operationIndex);
  }
  const outgoingAvailable = nonNegativeTimeInput(outgoing.inputs, "tailHandle", "outgoing PictureClip tailHandle", operationIndex);
  const incomingAvailable = nonNegativeTimeInput(incoming.inputs, "headHandle", "incoming PictureClip headHandle", operationIndex);
  if (compareRational(outgoingAvailable, half) < 0 || compareRational(incomingAvailable, half) < 0) {
    throw new PictureEditOperationError("time", `transitionAt duration requires at least ${half.numerator}/${half.denominator}s outgoing tailHandle and incoming headHandle.`, operationIndex);
  }
  const incomingSourceStart = subtractRational(incoming.source.start, half);
  if (compareRational(incomingSourceStart, zeroRational) < 0) {
    throw new PictureEditOperationError("time", "transitionAt incoming headHandle would begin before source time zero.", operationIndex);
  }
  const candidate: IRPictureTrackTransition = {
    cut: operation.at,
    duration: operation.duration,
    overlap: { start: subtractRational(operation.at, half), duration: operation.duration },
    outgoingIndex,
    incomingIndex,
    outgoingOrigin: outgoing.origin,
    incomingOrigin: incoming.origin,
    outgoingSource: { start: intervalEnd(outgoing.source), duration: half },
    incomingSource: { start: incomingSourceStart, duration: half },
    style: operation.style,
    provenance: operation.provenance,
  };
  for (const previous of resolved) {
    if (sameRational(previous.cut, candidate.cut)) {
      throw new PictureEditOperationError("no-op", "transitionAt duplicates an already declared transition at the same resolved hard cut.", operationIndex);
    }
    const previousEnd = intervalEnd(previous.overlap), candidateEnd = intervalEnd(candidate.overlap);
    if (compareRational(previous.overlap.start, candidateEnd) < 0 && compareRational(candidate.overlap.start, previousEnd) < 0) {
      throw new PictureEditOperationError("unsupported", "transitionAt overlap intersects another resolved PictureTrack transition; shorten or move one transition so every output frame has one unambiguous owner.", operationIndex);
    }
  }
  return candidate;
}

export function executePictureTrackOperationPlan(plan: IRPictureTrackOperationPlan): IRPictureTrackExecution {
  ensurePlanBase(plan);
  let items = plan.baseItems.map((item) => ({ ...item, destination: { ...item.destination }, inputs: { ...item.inputs }, ...(item.source ? { source: { ...item.source } } : {}), ...(item.timeMap ? { timeMap: cloneTimeMap(item.timeMap) } : {}) }));
  const original = items;
  const transitions: IRPictureTrackTransition[] = [];
  for (const [operationIndex, operation] of plan.operations.entries()) {
    // Transitions decorate the completely materialized structural timeline.
    // Delaying their resolution makes subsequent structural operations safe:
    // a changed or removed cut fails at the authored transition span instead
    // of leaving stale node indexes or silently moving media ownership.
    if (operation.kind === "transition") continue;
    if (operation.kind === "split") {
      const containing = items.find((item) => compareRational(operation.at, item.destination.start) > 0 && compareRational(operation.at, intervalEnd(item.destination)) < 0);
      if (!containing) throw new PictureEditOperationError("no-op", "split must be strictly inside one current PictureClip.", operationIndex);
      if (containing.kind !== "picture") throw new PictureEditOperationError("unsupported", "split on Gap is not meaningful; split a PictureClip or remove the redundant edit.", operationIndex);
      items = boundary(items, operation.at, operationIndex).items;
      continue;
    }
    if (operation.kind === "trim") {
      const end = intervalEnd(operation.keep), targetIndex = items.findIndex((item) => item.kind === "picture" && compareRational(operation.keep.start, item.destination.start) >= 0 && compareRational(end, intervalEnd(item.destination)) <= 0);
      if (targetIndex < 0) throw new PictureEditOperationError("time", "trim keep range must lie within exactly one current PictureClip.", operationIndex);
      const target = items[targetIndex];
      if (sameInterval(operation.keep, target.destination)) throw new PictureEditOperationError("no-op", "trim keep range equals the whole PictureClip.", operationIndex);
      const replacement: IRPictureEditItem[] = [];
      if (compareRational(operation.keep.start, target.destination.start) > 0) replacement.push(gap(target.destination.start, subtractRational(operation.keep.start, target.destination.start), operation.provenance, `trim:${operationIndex}:head`));
      replacement.push(segment(target, operation.keep.start, operation.keep.duration));
      if (compareRational(end, intervalEnd(target.destination)) < 0) replacement.push(gap(end, subtractRational(intervalEnd(target.destination), end), operation.provenance, `trim:${operationIndex}:tail`));
      items = coalesceGaps([...items.slice(0, targetIndex), ...replacement, ...items.slice(targetIndex + 1)]);
      continue;
    }
    if (operation.kind === "ripple-insert") {
      const at = operation.at, current = totalDuration(items);
      if (compareRational(at, zeroRational) < 0 || compareRational(at, current) > 0) throw new PictureEditOperationError("time", "rippleInsert point lies outside the current track duration.", operationIndex);
      const split = boundary(items, at, operationIndex).items, insertion = segment(operation.item, zeroRational, operation.item.destination.duration);
      const index = split.findIndex((item) => compareRational(item.destination.start, at) >= 0);
      items = reflow(index < 0 ? [...split, insertion] : [...split.slice(0, index), insertion, ...split.slice(index)]);
      continue;
    }
    if (operation.kind === "ripple-delete" || operation.kind === "extract") {
      const selected = ranged(items, operation.range, operationIndex);
      if (operation.kind === "ripple-delete") {
        const segmentIds = linkedRippleSegmentIds(operation, operationIndex);
        if (segmentIds) markLinkedRippleSegments(selected.items, selected.inside, segmentIds, operationIndex);
      }
      const retained = selected.items.filter((item) => !selected.inside.includes(item));
      if (!retained.length) throw new PictureEditOperationError("result", `${operation.kind === "extract" ? "extract" : "rippleDelete"} cannot remove the entire positive track.`, operationIndex);
      items = reflow(retained);
      continue;
    }
    if (operation.kind === "lift") {
      const selected = ranged(items, operation.range, operationIndex);
      if (selected.inside.every((item) => item.kind === "gap")) throw new PictureEditOperationError("no-op", "lift range already contains only explicit Gap material.", operationIndex);
      const first = selected.items.indexOf(selected.inside[0]), last = selected.items.indexOf(selected.inside.at(-1)!);
      items = coalesceGaps([...selected.items.slice(0, first), gap(operation.range.start, operation.range.duration, operation.provenance, `lift:${operationIndex}`), ...selected.items.slice(last + 1)]);
      continue;
    }
    if (operation.kind === "overwrite") {
      if (!sameRational(operation.range.duration, operation.item.destination.duration)) throw new PictureEditOperationError("time", "overwrite item duration must exactly equal the overwritten destination range.", operationIndex);
      const selected = ranged(items, operation.range, operationIndex), first = selected.items.indexOf(selected.inside[0]), last = selected.items.indexOf(selected.inside.at(-1)!);
      const replacement = segment(operation.item, zeroRational, operation.item.destination.duration);
      if (selected.inside.length === 1 && sameSemanticItems([atZero(selected.inside[0])], [replacement])) throw new PictureEditOperationError("no-op", "overwrite item is semantically identical to the selected material.", operationIndex);
      items = reflow([...selected.items.slice(0, first), replacement, ...selected.items.slice(last + 1)]);
      continue;
    }
    if (operation.kind === "slip") {
      if (sameRational(operation.by, zeroRational)) throw new PictureEditOperationError("no-op", "slip by 0s is a no-op.", operationIndex);
      const targetIndex = exactPictureTarget(items, operation.range, "slip", operationIndex);
      items = [...items.slice(0, targetIndex), slipItem(items[targetIndex], operation.by, operationIndex), ...items.slice(targetIndex + 1)];
      continue;
    }
    if (operation.kind === "slide") {
      if (sameRational(operation.by, zeroRational)) throw new PictureEditOperationError("no-op", "slide by 0s is a no-op.", operationIndex);
      const targetIndex = exactPictureTarget(items, operation.range, "slide", operationIndex);
      if (targetIndex === 0 || targetIndex === items.length - 1) {
        throw new PictureEditOperationError("unsupported", "slide requires one explicit adjacent PictureClip or Gap on each side; track-edge slides are ambiguous.", operationIndex);
      }
      const previous = items[targetIndex - 1], target = items[targetIndex], next = items[targetIndex + 1];
      const previousDuration = addRational(previous.destination.duration, operation.by);
      const nextDuration = subtractRational(next.destination.duration, operation.by);
      const adjustedPrevious = resizeTail(previous, previousDuration, operationIndex);
      const adjustedNext = resizeHead(next, nextDuration, operationIndex);
      items = reflow([
        ...items.slice(0, targetIndex - 1),
        adjustedPrevious,
        target,
        adjustedNext,
        ...items.slice(targetIndex + 2),
      ]);
      continue;
    }
    const selected = ranged(items, operation.range, operationIndex);
    if (selected.inside.length !== 1 || selected.inside[0].kind !== "picture" || !sameInterval(selected.inside[0].destination, operation.range)) {
      throw new PictureEditOperationError("time", "replace range must exactly identify one current PictureClip; use overwrite for an arbitrary range.", operationIndex);
    }
    const index = selected.items.indexOf(selected.inside[0]), replacement = segment(operation.item, zeroRational, operation.item.destination.duration);
    if (sameSemanticItems([atZero(selected.inside[0])], [replacement])) throw new PictureEditOperationError("no-op", "replace item is semantically identical to the selected PictureClip.", operationIndex);
    items = reflow([...selected.items.slice(0, index), replacement, ...selected.items.slice(index + 1)]);
  }
  for (const [operationIndex, operation] of plan.operations.entries()) {
    if (operation.kind === "transition") transitions.push(resolvePictureTrackTransition(items, operation, operationIndex, transitions));
  }
  if (!transitions.length && sameSemanticItems(original, items)) throw new PictureEditOperationError("no-op", "the complete PictureTrack edit list materializes the same timeline as its source items.");
  return {
    items: items.map(refreshedTranscriptPictureSegment),
    transitions,
  };
}

function executableItem(item: IRPictureEditItem) {
  const inputs = { ...item.inputs };
  // Handles declare available media. The exact consumed source intervals live
  // on the resolved transition, so surplus availability is structural rather
  // than executable identity and must not invalidate rendered caches.
  delete inputs.headHandle;
  delete inputs.tailHandle;
  return { origin: item.origin, kind: item.kind, destination: item.destination, inputs, ...(item.source ? { source: item.source } : {}), ...(item.timeMap ? { timeMap: item.timeMap } : {}), ...(item.linkSegmentId ? { linkSegmentId: item.linkSegmentId } : {}) };
}

export function pictureEditMaterializedNodeId(trackId: string, index: number, item: IRPictureEditItem) {
  void index;
  return `node_${hash({ trackId, item: executableItem(item) }).slice(0, 16)}`;
}

export function pictureEditOperationExecutableIdentity(plan: IRPictureTrackOperationPlan) {
  const strip = (item: IRPictureEditItem) => executableItem(item);
  return {
    version: plan.version,
    sourceDuration: plan.sourceDuration,
    baseItems: plan.baseItems.map(strip),
    operations: plan.operations.map((operation) => {
      const rest = { ...operation };
      delete (rest as { provenance?: IRProvenance }).provenance;
      return "item" in rest ? { ...rest, item: strip(rest.item) } : rest;
    }),
  };
}

export function samePictureEditOperationPlan(left: IRPictureTrackOperationPlan, right: IRPictureTrackOperationPlan) {
  return stableJsonStringify(pictureEditOperationExecutableIdentity(left)) === stableJsonStringify(pictureEditOperationExecutableIdentity(right));
}
