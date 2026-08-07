import { hash, stableJsonStringify } from "../core/stable";
import type { IREditorialInterval, IRPictureTimeMap, IRProvenance, IRValue } from "./ir";
import {
  addRational,
  compareRational,
  divideRational,
  multiplyRational,
  rational,
  subtractRational,
  type Rational,
  zeroRational,
} from "./rational";
import {
  pictureSpeedRampSourceOffset,
  slicePictureSpeedRamp,
} from "./picture-time-map";

export const timelineEditRelations = ["overlaps", "contained", "touches"] as const;
export type TimelineEditRelation = typeof timelineEditRelations[number];
export type TimelineEditDomain = "picture" | "audio" | "audiovisual";

export type TimelineEditAVTime = Readonly<{
  picture?: Rational;
  audio?: Rational;
}>;

export type TimelineEditAVInterval = Readonly<{
  picture?: IREditorialInterval;
  audio?: IREditorialInterval;
}>;

export type TimelineEditSelectionV1 = Readonly<{
  trackIds: readonly string[];
  originIds?: readonly string[];
  linkIds?: readonly string[];
  range?: TimelineEditAVInterval;
  relation?: TimelineEditRelation;
  /** Explicitly opt out of linked-item closure for this selection. Omission is
   * the fail-closed linked-edit law. */
  allowUnlinked?: boolean;
}>;

export type TimelineEditHandles = Readonly<{
  head: Rational;
  tail: Rational;
}>;

export type TimelineEditAudioPresentationClock = Readonly<{
  /** Duration and current slice offset in the unsliced authored clip/region
   * clock. Destination ripple does not move this clock; segmentation advances
   * sliceOffset, so fades and static processor automation never restart. */
  originDuration: Rational;
  sliceOffset: Rational;
  fadePolicy: "origin-relative";
  /**
   * Omitted on an authored origin. A copied operand records the original
   * item's identity here so every destination view continues to consume the
   * same authenticated, unsliced presentation clock.
   */
  authorityOriginId?: string;
  /**
   * Omitted for an authored or same-track origin. A cross-track copy records
   * the owning source track so the origin authority is the exact
   * (trackId, originId) pair rather than a repository-global origin spelling.
   */
  authorityTrackId?: string;
}>;

type TimelineEditMappedSource = Readonly<{
  source: IREditorialInterval;
  handles: TimelineEditHandles;
  authorityId: string;
}>;

export type TimelineEditSourceView =
  | Readonly<{
      kind: "gap";
      authorityId: string;
    }>
  | (TimelineEditMappedSource & Readonly<{
      kind: "picture";
      nodeId: string;
      timeMap: IRPictureTimeMap;
    }>)
  | (TimelineEditMappedSource & Readonly<{
      kind: "audio";
      nodeId: string;
      rate: Rational;
      fadeIn: Rational;
      fadeOut: Rational;
      presentationClock: TimelineEditAudioPresentationClock;
    }>)
  | (TimelineEditMappedSource & Readonly<{
      kind: "processed-audio";
      regionId: string;
      sourceNodeId: string;
      processorNodeIds: readonly string[];
      graphAuthorityId: string;
      rate: Rational;
      fadeIn: Rational;
      fadeOut: Rational;
      presentationClock: TimelineEditAudioPresentationClock;
      statePolicy: "single-authorized-evaluation";
    }>)
  | (TimelineEditMappedSource & Readonly<{
      kind: "nested";
      nodeId: string;
      compositionId: string;
      rate: Rational;
      sharedClock: true;
      /**
       * Structural slicing preserves every authenticated Precomp presentation
       * input. Canonical insert/overwrite is narrower: only the compiler-proven
       * static same-track shape may be copied as a new instance.
       */
      /** Omission is the legacy structural-only policy. */
      placementPolicy?: "structural-only" | "static-same-track-copy";
    }>);

export type TimelineEditItemV1 = Readonly<{
  originId: string;
  segmentId: string;
  parentSegmentId?: string;
  trackId: string;
  domain: TimelineEditDomain;
  linkId?: string;
  destination: IREditorialInterval;
  sourceView: TimelineEditSourceView;
  role?: string;
  metadata: Readonly<Record<string, string>>;
  provenance: IRProvenance;
}>;

export type TimelineEditTrackV1 = Readonly<{
  trackId: string;
  domain: TimelineEditDomain;
  order: number;
  duration: Rational;
  role?: string;
  metadata: Readonly<Record<string, string>>;
  items: readonly TimelineEditItemV1[];
}>;

export type TimelineEditPictureTransitionStyle =
  | Readonly<{ kind: "cross-dissolve" }>
  | Readonly<{ kind: "dip"; color: string }>
  | Readonly<{ kind: "wipe"; direction: "left" | "right" | "up" | "down"; softness: Rational }>
  | Readonly<{ kind: "push" | "slide"; direction: "left" | "right" | "up" | "down" }>;

export type TimelineEditAudioTransitionStyle = Readonly<{
  curve: "equal-power" | "linear";
}>;

export type TimelineEditOperandPartV1 = Readonly<{
  domain: TimelineEditDomain;
  /** Stable initial-plan source item identity. Its complete sourceView is part
   * of the plan and is cloned without reconstructing or guessing media. */
  sourceOriginId: string;
  /** Stable identity assigned to the newly placed item. */
  originId: string;
  destinationDuration: Rational;
  metadata: Readonly<Record<string, string>>;
}>;

export type TimelineEditOperandV1 = Readonly<{
  parts: readonly TimelineEditOperandPartV1[];
  /** Required for coupled multi-domain placement and assigned to every part. */
  linkId?: string;
}>;

export type TimelineEditDomainTargetsV1 = Readonly<{
  picture?: TimelineEditSelectionV1;
  audio?: TimelineEditSelectionV1;
  audiovisual?: TimelineEditSelectionV1;
}>;

type TimelineEditOperationBase = Readonly<{
  id: string;
  selection: TimelineEditSelectionV1;
  provenance: IRProvenance;
}>;

export type TimelineEditOperationV1 =
  | (TimelineEditOperationBase & Readonly<{ kind: "split"; at: TimelineEditAVTime }>)
  | (TimelineEditOperationBase & Readonly<{ kind: "trim"; keep: TimelineEditAVInterval }>)
  | (TimelineEditOperationBase & Readonly<{ kind: "ripple-delete"; range: TimelineEditAVInterval }>)
  | (TimelineEditOperationBase & Readonly<{ kind: "lift"; range: TimelineEditAVInterval }>)
  | (TimelineEditOperationBase & Readonly<{ kind: "extract"; range: TimelineEditAVInterval }>)
  | (TimelineEditOperationBase & Readonly<{ kind: "slip"; range: TimelineEditAVInterval; by: TimelineEditAVTime }>)
  | (TimelineEditOperationBase & Readonly<{ kind: "slide"; range: TimelineEditAVInterval; by: TimelineEditAVTime }>)
  | (TimelineEditOperationBase & Readonly<{ kind: "boundary-adjust"; at: TimelineEditAVTime }>)
  | Readonly<{
      id: string;
      kind: "insert";
      targets: TimelineEditDomainTargetsV1;
      at: TimelineEditAVTime;
      operand: TimelineEditOperandV1;
      provenance: IRProvenance;
    }>
  | Readonly<{
      id: string;
      kind: "overwrite";
      targets: TimelineEditDomainTargetsV1;
      at: TimelineEditAVTime;
      operand: TimelineEditOperandV1;
      provenance: IRProvenance;
    }>
  | Readonly<{
      id: string;
      kind: "transition";
      left: TimelineEditSelectionV1;
      right: TimelineEditSelectionV1;
      at: TimelineEditAVTime;
      duration: TimelineEditAVTime;
      picture?: TimelineEditPictureTransitionStyle;
      audio?: TimelineEditAudioTransitionStyle;
      provenance: IRProvenance;
    }>;

export type TimelineEditTransitionV1 = Readonly<{
  operationId: string;
  trackId: string;
  domain: "picture" | "audio";
  cut: Rational;
  duration: Rational;
  overlap: IREditorialInterval;
  outgoingSegmentId: string;
  incomingSegmentId: string;
  outgoingSource: IREditorialInterval;
  incomingSource: IREditorialInterval;
  picture?: TimelineEditPictureTransitionStyle;
  audio?: TimelineEditAudioTransitionStyle;
}>;

export type TimelineEditPlanV1 = Readonly<{
  version: 1;
  id: string;
  compositionId: string;
  sceneId: string;
  initialDuration: Rational;
  finalDuration: Rational;
  tracks: readonly TimelineEditTrackV1[];
  operations: readonly TimelineEditOperationV1[];
  provenance: IRProvenance;
}>;

export type TimelineEditExecutionV1 = Readonly<{
  version: 1;
  planId: string;
  tracks: readonly TimelineEditTrackV1[];
  transitions: readonly TimelineEditTransitionV1[];
  materializationId: string;
}>;

export type TimelineEditExecutionStageV1 = Readonly<{
  operationIndex: number;
  operationId: string;
  tracks: readonly TimelineEditTrackV1[];
}>;

export type TimelineEditExecutionSegmentObserverV1 = (
  item: TimelineEditItemV1,
) => void;

export const timelineEditLimits = Object.freeze({
  maximumTracks: 64,
  maximumItems: 4_096,
  maximumOperations: 256,
  maximumSelectionIds: 1_024,
  maximumMetadataEntries: 64,
  maximumTextBytes: 16_384,
});

export type TimelineEditErrorCode =
  | "CUT_TIMELINE_EDIT_SHAPE"
  | "CUT_TIMELINE_EDIT_REFERENCE"
  | "CUT_TIMELINE_EDIT_TIME"
  | "CUT_TIMELINE_EDIT_SELECTION"
  | "CUT_TIMELINE_EDIT_LINK"
  | "CUT_TIMELINE_EDIT_HANDLE"
  | "CUT_TIMELINE_EDIT_UNSUPPORTED"
  | "CUT_TIMELINE_EDIT_TRANSITION"
  | "CUT_TIMELINE_EDIT_RESULT"
  | "CUT_TIMELINE_EDIT_LIMIT";

export class TimelineEditError extends Error {
  constructor(
    readonly code: TimelineEditErrorCode,
    message: string,
    readonly path: string,
    readonly operationIndex?: number,
  ) {
    super(`${code}: ${message}`);
    this.name = "TimelineEditError";
  }
}

function fail(
  code: TimelineEditErrorCode,
  path: string,
  message: string,
  operationIndex?: number,
): never {
  throw new TimelineEditError(code, message, path, operationIndex);
}

function operationObject(value: IRValue, path: string) {
  if (value.kind !== "object") fail("CUT_TIMELINE_EDIT_SHAPE", path, "must lower to one closed operation record.");
  return value.entries;
}

function operationString(value: IRValue | undefined, path: string) {
  if (value?.kind !== "string") fail("CUT_TIMELINE_EDIT_SHAPE", path, "must lower to String.");
  return value.value;
}

function operationBoolean(value: IRValue | undefined, path: string) {
  if (value?.kind !== "boolean") fail("CUT_TIMELINE_EDIT_SHAPE", path, "must lower to Bool.");
  return value.value;
}

function operationTime(value: IRValue | undefined, path: string) {
  if (value?.kind !== "quantity" || value.dimension !== "time") {
    fail("CUT_TIMELINE_EDIT_TIME", path, "must lower to one exact Time.");
  }
  return value.magnitude;
}

function operationRatio(value: IRValue | undefined, path: string) {
  if (value?.kind !== "quantity" || (value.dimension !== "ratio" && value.dimension !== "scalar")) {
    fail("CUT_TIMELINE_EDIT_SHAPE", path, "must lower to one exact Ratio.");
  }
  return value.magnitude;
}

function operationInterval(value: IRValue | undefined, path: string): IREditorialInterval {
  if (value?.kind !== "range" || !value.exclusive) {
    fail("CUT_TIMELINE_EDIT_TIME", path, "must lower to one exact half-open Range<Time>.");
  }
  const start = operationTime(value.start, `${path}.start`);
  const end = operationTime(value.end, `${path}.end`);
  return positiveInterval({ start, duration: subtractRational(end, start) }, path);
}

function operationStringList(value: IRValue | undefined, path: string, required = false) {
  if (value === undefined && !required) return undefined;
  if (value?.kind !== "array" || !value.items.length) {
    fail("CUT_TIMELINE_EDIT_SELECTION", path, "must lower to one non-empty List<String>.");
  }
  return value.items.map((item, index) => operationString(item, `${path}[${index}]`));
}

function operationSelection(value: IRValue | undefined, path: string): TimelineEditSelectionV1 {
  if (value?.kind !== "object") fail("CUT_TIMELINE_EDIT_SELECTION", path, "must lower to editSelection(...).");
  const allowed = new Set(["trackIds", "originIds", "linkIds", "range", "relation", "allowUnlinked"]);
  for (const key of Object.keys(value.entries)) {
    if (!allowed.has(key)) fail("CUT_TIMELINE_EDIT_SHAPE", `${path}.${key}`, "is not part of the closed editSelection contract.");
  }
  const trackIds = operationStringList(value.entries.trackIds, `${path}.trackIds`, true)!;
  const originIds = operationStringList(value.entries.originIds, `${path}.originIds`);
  const linkIds = operationStringList(value.entries.linkIds, `${path}.linkIds`);
  const range = value.entries.range === undefined
    ? undefined
    : (() => {
        const interval = operationInterval(value.entries.range, `${path}.range`);
        return { picture: interval, audio: interval };
      })();
  const relation = value.entries.relation === undefined
    ? undefined
    : operationString(value.entries.relation, `${path}.relation`);
  if (relation !== undefined && !timelineEditRelations.includes(relation as TimelineEditRelation)) {
    fail("CUT_TIMELINE_EDIT_SHAPE", `${path}.relation`, "must be overlaps, contained, or touches.");
  }
  const allowUnlinked = value.entries.allowUnlinked === undefined
    ? undefined
    : operationBoolean(value.entries.allowUnlinked, `${path}.allowUnlinked`);
  return {
    trackIds,
    ...(originIds ? { originIds } : {}),
    ...(linkIds ? { linkIds } : {}),
    ...(range ? { range } : {}),
    ...(relation ? { relation: relation as TimelineEditRelation } : {}),
    ...(allowUnlinked !== undefined ? { allowUnlinked } : {}),
  };
}

function operationMetadata(value: IRValue | undefined, path: string) {
  if (value === undefined) return {};
  if (value.kind !== "object"
    || Object.keys(value.entries).length !== 1
    || value.entries.entries?.kind !== "array"
    || !value.entries.entries.items.length) {
    fail("CUT_TIMELINE_EDIT_SHAPE", path, "must lower to editorialMetadata(...) with a non-empty entry list.");
  }
  const entries = value.entries.entries;
  const metadata: Record<string, string> = {};
  for (const [index, entry] of entries.items.entries()) {
    const entryPath = `${path}[${index}]`;
    if (entry.kind !== "object") {
      fail("CUT_TIMELINE_EDIT_SHAPE", entryPath, "must lower to editMetadata(...).");
    }
    const fields = Object.keys(entry.entries);
    if (fields.length !== 2 || !fields.includes("key") || !fields.includes("value")) {
      fail("CUT_TIMELINE_EDIT_SHAPE", entryPath, "must contain exactly key and value.");
    }
    const key = operationString(entry.entries.key, `${entryPath}.key`);
    if (Object.hasOwn(metadata, key)) {
      fail("CUT_TIMELINE_EDIT_SHAPE", `${entryPath}.key`, "duplicates an earlier metadata key.");
    }
    metadata[key] = operationString(entry.entries.value, `${entryPath}.value`);
  }
  return metadata;
}

function operationOperand(value: IRValue | undefined, path: string): TimelineEditOperandV1 {
  if (value?.kind !== "object") {
    fail("CUT_TIMELINE_EDIT_SHAPE", path, "must lower to editOperand(...).");
  }
  for (const key of Object.keys(value.entries)) {
    if (key !== "parts" && key !== "linkId") {
      fail("CUT_TIMELINE_EDIT_SHAPE", `${path}.${key}`, "is not part of the closed editOperand contract.");
    }
  }
  const parts = value.entries.parts;
  if (parts?.kind !== "array" || !parts.items.length || parts.items.length > 3) {
    fail("CUT_TIMELINE_EDIT_SHAPE", `${path}.parts`, "must contain one through three domain-unique editOperandPart records.");
  }
  const decoded = parts.items.map((entry, index): TimelineEditOperandPartV1 => {
    const partPath = `${path}.parts[${index}]`;
    if (entry.kind !== "object") {
      fail("CUT_TIMELINE_EDIT_SHAPE", partPath, "must lower to editOperandPart(...).");
    }
    const allowed = new Set(["domain", "sourceOriginId", "originId", "duration", "metadata"]);
    for (const key of Object.keys(entry.entries)) {
      if (!allowed.has(key)) {
        fail("CUT_TIMELINE_EDIT_SHAPE", `${partPath}.${key}`, "is not part of the closed editOperandPart contract.");
      }
    }
    for (const required of ["domain", "sourceOriginId", "originId", "duration"]) {
      if (entry.entries[required] === undefined) {
        fail("CUT_TIMELINE_EDIT_SHAPE", `${partPath}.${required}`, "is required.");
      }
    }
    const domain = operationString(entry.entries.domain, `${partPath}.domain`);
    if (domain !== "picture" && domain !== "audio" && domain !== "audiovisual") {
      fail("CUT_TIMELINE_EDIT_SHAPE", `${partPath}.domain`, "must be picture, audio, or audiovisual.");
    }
    return {
      domain,
      sourceOriginId: operationString(entry.entries.sourceOriginId, `${partPath}.sourceOriginId`),
      originId: operationString(entry.entries.originId, `${partPath}.originId`),
      destinationDuration: operationTime(entry.entries.duration, `${partPath}.duration`),
      metadata: operationMetadata(entry.entries.metadata, `${partPath}.metadata`),
    };
  });
  if (new Set(decoded.map((part) => part.domain)).size !== decoded.length) {
    fail("CUT_TIMELINE_EDIT_SHAPE", `${path}.parts`, "must contain at most one part for each domain.");
  }
  return {
    parts: decoded,
    ...(value.entries.linkId === undefined
      ? {}
      : { linkId: operationString(value.entries.linkId, `${path}.linkId`) }),
  };
}

function operationAVTime(value: IRValue | undefined, path: string): TimelineEditAVTime {
  if (value?.kind !== "object") fail("CUT_TIMELINE_EDIT_TIME", path, "must lower to avTime(...).");
  const keys = Object.keys(value.entries);
  if (!keys.length || keys.some((key) => key !== "picture" && key !== "audio")) {
    fail("CUT_TIMELINE_EDIT_SHAPE", path, "must contain picture and/or audio only.");
  }
  return {
    ...(value.entries.picture ? { picture: operationTime(value.entries.picture, `${path}.picture`) } : {}),
    ...(value.entries.audio ? { audio: operationTime(value.entries.audio, `${path}.audio`) } : {}),
  };
}

function operationAVInterval(value: IRValue | undefined, path: string): TimelineEditAVInterval {
  const interval = operationInterval(value, path);
  return { picture: interval, audio: interval };
}

const publicOperationFields = Object.freeze({
  split: ["kind", "selection", "at"],
  trim: ["kind", "selection", "keep"],
  "ripple-delete": ["kind", "selection", "range"],
  lift: ["kind", "selection", "range"],
  extract: ["kind", "selection", "range"],
  slip: ["kind", "selection", "range", "by"],
  slide: ["kind", "selection", "range", "by"],
  "boundary-adjust": ["kind", "selection", "at"],
  insert: ["kind", "picture", "audio", "audiovisual", "at", "operand"],
  overwrite: ["kind", "picture", "audio", "audiovisual", "at", "operand"],
  transition: [
    "kind", "left", "right", "at", "duration", "pictureKind",
    "pictureDirection", "pictureSoftness", "pictureColor", "audioCurve",
  ],
} as const);

/**
 * Decode the exact compile-time record values emitted by @cut/edit. Public
 * operation discriminators are injected by lowering and survive into plan
 * identity; no field-shape inference is permitted.
 */
export function timelineEditOperationsFromInput(
  values: readonly IRValue[],
  provenances: readonly IRProvenance[],
): TimelineEditOperationV1[] {
  if (!values.length || values.length !== provenances.length || values.length > timelineEditLimits.maximumOperations) {
    fail(
      "CUT_TIMELINE_EDIT_LIMIT",
      "$.operations",
      `must contain 1 through ${timelineEditLimits.maximumOperations} values with one provenance each.`,
    );
  }
  return values.map((value, operationIndex): TimelineEditOperationV1 => {
    const path = `$.operations[${operationIndex}]`;
    const entries = operationObject(value, path);
    const kind = operationString(entries.kind, `${path}.kind`) as keyof typeof publicOperationFields;
    const allowed = publicOperationFields[kind];
    if (!allowed) fail("CUT_TIMELINE_EDIT_SHAPE", `${path}.kind`, "is not one supported public TimelineEdit operation.");
    for (const key of Object.keys(entries)) {
      if (!(allowed as readonly string[]).includes(key)) {
        fail("CUT_TIMELINE_EDIT_SHAPE", `${path}.${key}`, "is not part of this closed operation record.", operationIndex);
      }
    }
    for (const required of allowed) {
      const optional = (kind === "transition"
        && ["pictureKind", "pictureDirection", "pictureSoftness", "pictureColor", "audioCurve"].includes(required))
        || ((kind === "insert" || kind === "overwrite")
          && ["picture", "audio", "audiovisual"].includes(required));
      if (!optional && entries[required] === undefined) {
        fail("CUT_TIMELINE_EDIT_SHAPE", `${path}.${required}`, "is required.", operationIndex);
      }
    }
    const provenance = structuredClone(provenances[operationIndex]);
    // Operation identity is semantic, while provenance remains separately
    // preserved for diagnostics and the public evidence receipt. Moving an
    // otherwise identical TimelineEdit statement within its source file must
    // not invalidate generated origin/view ids or picture/PCM cache entries.
    const id = `operation_${hash({ version: 2, index: operationIndex, value }).slice(0, 24)}`;
    if (kind === "insert" || kind === "overwrite") {
      const targets = {
        ...(entries.picture === undefined
          ? {}
          : { picture: operationSelection(entries.picture, `${path}.picture`) }),
        ...(entries.audio === undefined
          ? {}
          : { audio: operationSelection(entries.audio, `${path}.audio`) }),
        ...(entries.audiovisual === undefined
          ? {}
          : { audiovisual: operationSelection(entries.audiovisual, `${path}.audiovisual`) }),
      };
      if (!targets.picture && !targets.audio && !targets.audiovisual) {
        fail("CUT_TIMELINE_EDIT_SELECTION", path, "must declare at least one explicit per-domain target selection.", operationIndex);
      }
      return {
        id,
        kind,
        targets,
        at: operationAVTime(entries.at, `${path}.at`),
        operand: operationOperand(entries.operand, `${path}.operand`),
        provenance,
      };
    }
    if (kind === "transition") {
      const pictureKind = entries.pictureKind === undefined
        ? undefined
        : operationString(entries.pictureKind, `${path}.pictureKind`);
      const rejectPictureField = (field: "pictureDirection" | "pictureSoftness" | "pictureColor") => {
        if (entries[field] !== undefined) {
          fail(
            "CUT_TIMELINE_EDIT_SHAPE",
            `${path}.${field}`,
            `is not valid for pictureKind ${JSON.stringify(pictureKind)}.`,
            operationIndex,
          );
        }
      };
      const direction = () => {
        const value = operationString(entries.pictureDirection, `${path}.pictureDirection`);
        if (!["left", "right", "up", "down"].includes(value)) {
          fail("CUT_TIMELINE_EDIT_SHAPE", `${path}.pictureDirection`, "must be left, right, up, or down.", operationIndex);
        }
        return value as "left" | "right" | "up" | "down";
      };
      let picture: TimelineEditPictureTransitionStyle | undefined;
      if (pictureKind === "cross-dissolve") {
        rejectPictureField("pictureDirection");
        rejectPictureField("pictureSoftness");
        rejectPictureField("pictureColor");
        picture = { kind: "cross-dissolve" };
      }
      else if (pictureKind === "dip") {
        rejectPictureField("pictureDirection");
        rejectPictureField("pictureSoftness");
        if (entries.pictureColor?.kind !== "color") {
          fail("CUT_TIMELINE_EDIT_SHAPE", `${path}.pictureColor`, "dip requires one exact Color.", operationIndex);
        }
        picture = { kind: "dip", color: entries.pictureColor.value };
      } else if (pictureKind === "wipe") {
        rejectPictureField("pictureColor");
        const softness = entries.pictureSoftness === undefined
          ? zeroRational
          : operationRatio(entries.pictureSoftness, `${path}.pictureSoftness`);
        if (compareRational(softness, zeroRational) < 0 || compareRational(softness, rational(1)) > 0) {
          fail("CUT_TIMELINE_EDIT_SHAPE", `${path}.pictureSoftness`, "must be between 0 and 1 inclusive.", operationIndex);
        }
        picture = {
          kind: "wipe",
          direction: direction(),
          softness,
        };
      } else if (pictureKind === "push" || pictureKind === "slide") {
        rejectPictureField("pictureSoftness");
        rejectPictureField("pictureColor");
        picture = {
          kind: pictureKind,
          direction: direction(),
        };
      } else if (pictureKind !== undefined) {
        fail("CUT_TIMELINE_EDIT_SHAPE", `${path}.pictureKind`, "is not a supported picture transition.", operationIndex);
      } else {
        rejectPictureField("pictureDirection");
        rejectPictureField("pictureSoftness");
        rejectPictureField("pictureColor");
      }
      const audioCurve = entries.audioCurve === undefined
        ? undefined
        : operationString(entries.audioCurve, `${path}.audioCurve`);
      if (audioCurve !== undefined && audioCurve !== "equal-power" && audioCurve !== "linear") {
        fail("CUT_TIMELINE_EDIT_SHAPE", `${path}.audioCurve`, "must be equal-power or linear.", operationIndex);
      }
      const audio: TimelineEditAudioTransitionStyle | undefined = audioCurve === undefined
        ? undefined
        : { curve: audioCurve };
      if (!picture && !audio) {
        fail("CUT_TIMELINE_EDIT_TRANSITION", path, "must declare pictureKind and/or audioCurve.", operationIndex);
      }
      return {
        id,
        kind: "transition",
        left: operationSelection(entries.left, `${path}.left`),
        right: operationSelection(entries.right, `${path}.right`),
        at: operationAVTime(entries.at, `${path}.at`),
        duration: operationAVTime(entries.duration, `${path}.duration`),
        ...(picture ? { picture } : {}),
        ...(audio ? { audio } : {}),
        provenance,
      };
    }
    const selection = operationSelection(entries.selection, `${path}.selection`);
    if (kind === "split" || kind === "boundary-adjust") {
      return { id, kind, selection, at: operationAVTime(entries.at, `${path}.at`), provenance };
    }
    if (kind === "trim") {
      return { id, kind, selection, keep: operationAVInterval(entries.keep, `${path}.keep`), provenance };
    }
    if (kind === "slip" || kind === "slide") {
      return {
        id,
        kind,
        selection,
        range: operationAVInterval(entries.range, `${path}.range`),
        by: operationAVTime(entries.by, `${path}.by`),
        provenance,
      };
    }
    return { id, kind, selection, range: operationAVInterval(entries.range, `${path}.range`), provenance };
  });
}

function sameRational(left: Rational, right: Rational) {
  return compareRational(left, right) === 0;
}

function intervalEnd(interval: IREditorialInterval) {
  return addRational(interval.start, interval.duration);
}

function sameInterval(left: IREditorialInterval, right: IREditorialInterval) {
  return sameRational(left.start, right.start)
    && sameRational(left.duration, right.duration);
}

function positiveInterval(
  interval: IREditorialInterval,
  path: string,
  operationIndex?: number,
) {
  if (compareRational(interval.start, zeroRational) < 0
    || compareRational(interval.duration, zeroRational) <= 0) {
    fail("CUT_TIMELINE_EDIT_TIME", path, "must be one positive half-open interval at or after zero.", operationIndex);
  }
  return interval;
}

function safeId(value: string, path: string) {
  if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    fail("CUT_TIMELINE_EDIT_SHAPE", path, "must be a stable identifier beginning with an ASCII letter and containing at most 128 safe characters.");
  }
  return value;
}

function safeMetadata(value: Readonly<Record<string, string>>, path: string) {
  const entries = Object.entries(value);
  if (entries.length > timelineEditLimits.maximumMetadataEntries) {
    fail("CUT_TIMELINE_EDIT_LIMIT", path, `exceeds the ${timelineEditLimits.maximumMetadataEntries}-entry metadata budget.`);
  }
  let bytes = 0;
  for (const [key, text] of entries) {
    if (!/^(?![Cc][Uu][Tt]\.)(?:[A-Za-z][A-Za-z0-9_-]*\.)+[A-Za-z][A-Za-z0-9_-]*$/u.test(key)
      || key.length > 128) {
      fail("CUT_TIMELINE_EDIT_SHAPE", `${path}.${key}`, "must be one bounded non-CUT dotted metadata namespace.");
    }
    if (typeof text !== "string" || text.length > 1_024 || /[\u0000-\u001f\u007f]/u.test(text)) {
      fail("CUT_TIMELINE_EDIT_SHAPE", `${path}.${key}`, "must be a printable String of at most 1024 characters.");
    }
    bytes += Buffer.byteLength(key, "utf8") + Buffer.byteLength(text, "utf8");
  }
  if (bytes > timelineEditLimits.maximumTextBytes) {
    fail("CUT_TIMELINE_EDIT_LIMIT", path, `exceeds the ${timelineEditLimits.maximumTextBytes}-byte text budget.`);
  }
}

function cloneInterval(interval: IREditorialInterval): IREditorialInterval {
  return { start: { ...interval.start }, duration: { ...interval.duration } };
}

function cloneTimeMap(map: IRPictureTimeMap): IRPictureTimeMap {
  return map.kind === "speed-ramp"
    ? { ...map, points: map.points.map((point) => ({ at: { ...point.at }, rate: { ...point.rate } })) }
    : map.kind === "constant"
      ? { ...map, rate: { ...map.rate } }
      : { ...map, at: { ...map.at } };
}

function cloneSourceView(view: TimelineEditSourceView): TimelineEditSourceView {
  if (view.kind === "gap") return { ...view };
  const shared = {
    ...view,
    source: cloneInterval(view.source),
    handles: { head: { ...view.handles.head }, tail: { ...view.handles.tail } },
  };
  if (view.kind === "picture") return { ...shared, kind: "picture", nodeId: view.nodeId, timeMap: cloneTimeMap(view.timeMap) };
  if (view.kind === "processed-audio") return {
    ...shared,
    kind: "processed-audio",
    regionId: view.regionId,
    sourceNodeId: view.sourceNodeId,
    processorNodeIds: [...view.processorNodeIds],
    graphAuthorityId: view.graphAuthorityId,
    rate: { ...view.rate },
    fadeIn: { ...view.fadeIn },
    fadeOut: { ...view.fadeOut },
    presentationClock: {
      originDuration: { ...view.presentationClock.originDuration },
      sliceOffset: { ...view.presentationClock.sliceOffset },
      fadePolicy: "origin-relative",
      ...(view.presentationClock.authorityOriginId
        ? { authorityOriginId: view.presentationClock.authorityOriginId }
        : {}),
      ...(view.presentationClock.authorityTrackId
        ? { authorityTrackId: view.presentationClock.authorityTrackId }
        : {}),
    },
    statePolicy: "single-authorized-evaluation",
  };
  if (view.kind === "audio") return {
    ...shared,
    kind: "audio",
    nodeId: view.nodeId,
    rate: { ...view.rate },
    fadeIn: { ...view.fadeIn },
    fadeOut: { ...view.fadeOut },
    presentationClock: {
      originDuration: { ...view.presentationClock.originDuration },
      sliceOffset: { ...view.presentationClock.sliceOffset },
      fadePolicy: "origin-relative",
      ...(view.presentationClock.authorityOriginId
        ? { authorityOriginId: view.presentationClock.authorityOriginId }
        : {}),
      ...(view.presentationClock.authorityTrackId
        ? { authorityTrackId: view.presentationClock.authorityTrackId }
        : {}),
    },
  };
  return {
    ...shared,
    kind: "nested",
    nodeId: view.nodeId,
    compositionId: view.compositionId,
    rate: { ...view.rate },
    sharedClock: true,
    placementPolicy: view.placementPolicy,
  };
}

function cloneItem(item: TimelineEditItemV1): TimelineEditItemV1 {
  return {
    ...item,
    destination: cloneInterval(item.destination),
    sourceView: cloneSourceView(item.sourceView),
    metadata: { ...item.metadata },
    provenance: structuredClone(item.provenance),
  };
}

function cloneTrack(track: TimelineEditTrackV1): TimelineEditTrackV1 {
  return {
    ...track,
    duration: { ...track.duration },
    metadata: { ...track.metadata },
    items: track.items.map(cloneItem),
  };
}

function domainTime(domain: TimelineEditDomain, value: TimelineEditAVTime, path: string, operationIndex: number) {
  const selected = domain === "audio" ? value.audio : domain === "picture" ? value.picture : value.picture ?? value.audio;
  if (!selected) fail("CUT_TIMELINE_EDIT_TIME", path, `${domain} operation requires its exact ${domain === "audio" ? "audio" : "picture"} time.`, operationIndex);
  if (domain === "audiovisual" && value.picture && value.audio && !sameRational(value.picture, value.audio)) {
    fail("CUT_TIMELINE_EDIT_UNSUPPORTED", path, "a shared-clock audiovisual operand cannot use unequal picture/audio boundaries.", operationIndex);
  }
  return selected;
}

function domainInterval(domain: TimelineEditDomain, value: TimelineEditAVInterval, path: string, operationIndex: number) {
  const selected = domain === "audio" ? value.audio : domain === "picture" ? value.picture : value.picture ?? value.audio;
  if (!selected) fail("CUT_TIMELINE_EDIT_TIME", path, `${domain} operation requires its exact ${domain === "audio" ? "audio" : "picture"} interval.`, operationIndex);
  if (domain === "audiovisual" && value.picture && value.audio && !sameInterval(value.picture, value.audio)) {
    fail("CUT_TIMELINE_EDIT_UNSUPPORTED", path, "a shared-clock audiovisual operand cannot use unequal picture/audio intervals.", operationIndex);
  }
  return positiveInterval(selected, path, operationIndex);
}

function overlap(left: IREditorialInterval, right: IREditorialInterval) {
  const start = compareRational(left.start, right.start) > 0 ? left.start : right.start;
  const end = compareRational(intervalEnd(left), intervalEnd(right)) < 0 ? intervalEnd(left) : intervalEnd(right);
  return compareRational(end, start) > 0 ? { start, duration: subtractRational(end, start) } : undefined;
}

function relationMatches(
  item: IREditorialInterval,
  range: IREditorialInterval,
  relation: TimelineEditRelation,
) {
  if (relation === "overlaps") return overlap(item, range) !== undefined;
  if (relation === "contained") {
    return compareRational(item.start, range.start) >= 0
      && compareRational(intervalEnd(item), intervalEnd(range)) <= 0;
  }
  return overlap(item, range) !== undefined
    || sameRational(item.start, intervalEnd(range))
    || sameRational(intervalEnd(item), range.start);
}

function selectedByIds(item: TimelineEditItemV1, selection: TimelineEditSelectionV1) {
  return (!selection.originIds?.length || selection.originIds.includes(item.originId))
    && (!selection.linkIds?.length || (item.linkId !== undefined && selection.linkIds.includes(item.linkId)));
}

function selectedItems(
  track: TimelineEditTrackV1,
  selection: TimelineEditSelectionV1,
  operationRange: IREditorialInterval | undefined,
) {
  const range = selection.range
    ? domainInterval(track.domain, selection.range, "$.selection.range", -1)
    : operationRange;
  return track.items.filter((item) =>
    selectedByIds(item, selection)
    && (!range || relationMatches(item.destination, range, selection.relation ?? "overlaps")));
}

function validateSelection(
  tracks: readonly TimelineEditTrackV1[],
  selection: TimelineEditSelectionV1,
  path: string,
  operationIndex: number,
) {
  if (!selection.trackIds.length) {
    fail("CUT_TIMELINE_EDIT_SELECTION", `${path}.trackIds`, "must name at least one authored track.", operationIndex);
  }
  const ids = [...selection.trackIds, ...(selection.originIds ?? []), ...(selection.linkIds ?? [])];
  if (ids.length > timelineEditLimits.maximumSelectionIds) {
    fail("CUT_TIMELINE_EDIT_LIMIT", path, `selection exceeds the ${timelineEditLimits.maximumSelectionIds}-identifier budget.`, operationIndex);
  }
  for (const [index, id] of selection.trackIds.entries()) safeId(id, `${path}.trackIds[${index}]`);
  for (const [index, id] of (selection.originIds ?? []).entries()) safeId(id, `${path}.originIds[${index}]`);
  for (const [index, id] of (selection.linkIds ?? []).entries()) safeId(id, `${path}.linkIds[${index}]`);
  if (new Set(selection.trackIds).size !== selection.trackIds.length
    || new Set(selection.originIds ?? []).size !== (selection.originIds ?? []).length
    || new Set(selection.linkIds ?? []).size !== (selection.linkIds ?? []).length) {
    fail("CUT_TIMELINE_EDIT_SELECTION", path, "selection identifiers must be unique.", operationIndex);
  }
  const available = new Set(tracks.map((track) => track.trackId));
  const foreign = selection.trackIds.find((id) => !available.has(id));
  if (foreign) fail("CUT_TIMELINE_EDIT_REFERENCE", `${path}.trackIds`, `references unknown track ${JSON.stringify(foreign)}.`, operationIndex);
  if (selection.relation !== undefined && !timelineEditRelations.includes(selection.relation)) {
    fail("CUT_TIMELINE_EDIT_SHAPE", `${path}.relation`, "must be overlaps, contained, or touches.", operationIndex);
  }
  if (selection.allowUnlinked !== undefined && typeof selection.allowUnlinked !== "boolean") {
    fail("CUT_TIMELINE_EDIT_SHAPE", `${path}.allowUnlinked`, "must be one Bool.", operationIndex);
  }
  if (selection.range) {
    if (selection.range.picture) positiveInterval(selection.range.picture, `${path}.range.picture`, operationIndex);
    if (selection.range.audio) positiveInterval(selection.range.audio, `${path}.range.audio`, operationIndex);
    if (!selection.range.picture && !selection.range.audio) fail("CUT_TIMELINE_EDIT_SHAPE", `${path}.range`, "must contain picture and/or audio.", operationIndex);
  }

  const selectedTrackIds = new Set(selection.trackIds);
  for (const linkId of selection.linkIds ?? []) {
    const owners = tracks.filter((track) => track.items.some((item) => item.linkId === linkId));
    if (!owners.length) fail("CUT_TIMELINE_EDIT_REFERENCE", `${path}.linkIds`, `references unknown link ${JSON.stringify(linkId)}.`, operationIndex);
    const omitted = owners.find((track) => !selectedTrackIds.has(track.trackId));
    if (omitted) {
      fail("CUT_TIMELINE_EDIT_LINK", path, `link ${JSON.stringify(linkId)} is also present on unselected track ${JSON.stringify(omitted.trackId)}; partial linked mutation is forbidden.`, operationIndex);
    }
  }
}

function validateSelectedLinkClosure(
  tracks: readonly TimelineEditTrackV1[],
  selection: TimelineEditSelectionV1,
  actualItems: readonly TimelineEditItemV1[],
  path: string,
  operationIndex: number,
) {
  if (selection.allowUnlinked === true) return;
  const selectedSegments = new Set(actualItems.map((item) => item.segmentId));
  const selectedLinks = new Set(
    actualItems
      .map((item) => item.linkId)
      .filter((linkId): linkId is string => linkId !== undefined),
  );
  for (const linkId of selectedLinks) {
    const ownerTracks = tracks.filter((track) =>
      track.items.some((item) => item.linkId === linkId));
    const omitted = ownerTracks.find((track) =>
      !actualItems.some((item) =>
        item.trackId === track.trackId
        && item.linkId === linkId
        && selectedSegments.has(item.segmentId)));
    if (omitted) {
      fail(
        "CUT_TIMELINE_EDIT_LINK",
        path,
        `selected item link ${JSON.stringify(linkId)} also owns an item on unselected track or range ${JSON.stringify(omitted.trackId)}; set allowUnlinked only for an intentional unlink operation.`,
        operationIndex,
      );
    }
  }
}

function selectedStructuralOperationItems(
  tracks: readonly TimelineEditTrackV1[],
  operation: Exclude<TimelineEditOperationV1, { kind: "transition" | "insert" | "overwrite" }>,
  operationIndex: number,
) {
  const selectedTrackIds = new Set(operation.selection.trackIds);
  return tracks.flatMap((track) => {
    if (!selectedTrackIds.has(track.trackId)) return [];
    if (operation.kind === "split") {
      const at = domainTime(track.domain, operation.at, `$.operations[${operationIndex}].at`, operationIndex);
      return selectedItems(track, operation.selection, undefined).filter((item) =>
        compareRational(at, item.destination.start) > 0
        && compareRational(at, intervalEnd(item.destination)) < 0);
    }
    if (operation.kind === "boundary-adjust") {
      return selectedItems(track, operation.selection, undefined)
        .filter((item) => item.sourceView.kind !== "gap");
    }
    const interval = operation.kind === "trim" ? operation.keep : operation.range;
    return selectedItems(
      track,
      operation.selection,
      domainInterval(track.domain, interval, `$.operations[${operationIndex}].range`, operationIndex),
    );
  });
}

function validateSourceView(item: TimelineEditItemV1, path: string) {
  const view = item.sourceView;
  safeId(view.authorityId, `${path}.sourceView.authorityId`);
  if (view.kind === "gap") return;
  positiveInterval(view.source, `${path}.sourceView.source`);
  if (compareRational(view.handles.head, zeroRational) < 0 || compareRational(view.handles.tail, zeroRational) < 0) {
    fail("CUT_TIMELINE_EDIT_HANDLE", `${path}.sourceView.handles`, "head and tail handles must be non-negative.");
  }
  if (view.kind === "picture") {
    safeId(view.nodeId, `${path}.sourceView.nodeId`);
    if (view.timeMap.kind === "constant" && compareRational(view.timeMap.rate, zeroRational) <= 0) {
      fail("CUT_TIMELINE_EDIT_TIME", `${path}.sourceView.timeMap.rate`, "must be positive.");
    }
  } else if (view.kind === "audio") {
    safeId(view.nodeId, `${path}.sourceView.nodeId`);
    if (compareRational(view.rate, zeroRational) <= 0) fail("CUT_TIMELINE_EDIT_TIME", `${path}.sourceView.rate`, "must be positive.");
  } else if (view.kind === "processed-audio") {
    safeId(view.regionId, `${path}.sourceView.regionId`);
    safeId(view.sourceNodeId, `${path}.sourceView.sourceNodeId`);
    safeId(view.graphAuthorityId, `${path}.sourceView.graphAuthorityId`);
    if (!view.processorNodeIds.length || new Set(view.processorNodeIds).size !== view.processorNodeIds.length) {
      fail("CUT_TIMELINE_EDIT_SHAPE", `${path}.sourceView.processorNodeIds`, "must be one non-empty unique processor identity chain.");
    }
    view.processorNodeIds.forEach((id, index) => safeId(id, `${path}.sourceView.processorNodeIds[${index}]`));
    if (compareRational(view.rate, zeroRational) <= 0) fail("CUT_TIMELINE_EDIT_TIME", `${path}.sourceView.rate`, "must be positive.");
  } else {
    safeId(view.nodeId, `${path}.sourceView.nodeId`);
    safeId(view.compositionId, `${path}.sourceView.compositionId`);
    if (view.sharedClock !== true || !sameRational(view.rate, rational(1))) {
      fail("CUT_TIMELINE_EDIT_UNSUPPORTED", path, "v1 nested presentation views require one exact shared 1:1 clock.");
    }
    if (view.placementPolicy !== undefined
      && view.placementPolicy !== "structural-only"
      && view.placementPolicy !== "static-same-track-copy") {
      fail(
        "CUT_TIMELINE_EDIT_SHAPE",
        `${path}.sourceView.placementPolicy`,
        "must be structural-only or static-same-track-copy.",
      );
    }
    if (compareRational(view.handles.head, zeroRational) !== 0
      || compareRational(view.handles.tail, zeroRational) !== 0) {
      fail("CUT_TIMELINE_EDIT_UNSUPPORTED", `${path}.sourceView.handles`, "nested Precomp operands do not admit external handles.");
    }
  }
  if (view.kind === "audio" || view.kind === "processed-audio") {
    if (view.presentationClock.authorityOriginId !== undefined) {
      safeId(
        view.presentationClock.authorityOriginId,
        `${path}.sourceView.presentationClock.authorityOriginId`,
      );
    }
    if (view.presentationClock.fadePolicy !== "origin-relative") {
      fail("CUT_TIMELINE_EDIT_SHAPE", `${path}.sourceView.presentationClock.fadePolicy`, "must be origin-relative.");
    }
    if (compareRational(view.presentationClock.originDuration, zeroRational) <= 0) {
      fail("CUT_TIMELINE_EDIT_TIME", `${path}.sourceView.presentationClock.originDuration`, "must be positive.");
    }
    if (compareRational(view.fadeIn, zeroRational) < 0
      || compareRational(view.fadeOut, zeroRational) < 0
      || compareRational(addRational(view.fadeIn, view.fadeOut), view.presentationClock.originDuration) > 0) {
      fail("CUT_TIMELINE_EDIT_TIME", `${path}.sourceView`, "origin-relative fades must be non-negative and cannot overlap beyond the authored presentation duration.");
    }
  }
}

function validateTracks(tracks: readonly TimelineEditTrackV1[], duration: Rational) {
  if (!tracks.length || tracks.length > timelineEditLimits.maximumTracks) {
    fail("CUT_TIMELINE_EDIT_LIMIT", "$.tracks", `must contain 1 through ${timelineEditLimits.maximumTracks} tracks.`);
  }
  if (new Set(tracks.map((track) => track.trackId)).size !== tracks.length) {
    fail("CUT_TIMELINE_EDIT_SHAPE", "$.tracks", "trackId values must be unique.");
  }
  if (new Set(tracks.map((track) => track.order)).size !== tracks.length) {
    fail("CUT_TIMELINE_EDIT_SHAPE", "$.tracks", "track order values must be unique.");
  }
  let totalItems = 0;
  const segmentIds = new Set<string>();
  for (const [trackIndex, track] of tracks.entries()) {
    const path = `$.tracks[${trackIndex}]`;
    safeId(track.trackId, `${path}.trackId`);
    if (!Number.isSafeInteger(track.order) || track.order < 0) fail("CUT_TIMELINE_EDIT_SHAPE", `${path}.order`, "must be a non-negative safe integer.");
    if (!sameRational(track.duration, duration)) fail("CUT_TIMELINE_EDIT_TIME", `${path}.duration`, "must equal plan initialDuration.");
    safeMetadata(track.metadata, `${path}.metadata`);
    if (!track.items.length) fail("CUT_TIMELINE_EDIT_SHAPE", `${path}.items`, "must contain explicit media or gap coverage.");
    let cursor = zeroRational;
    for (const [itemIndex, item] of track.items.entries()) {
      const itemPath = `${path}.items[${itemIndex}]`;
      totalItems += 1;
      safeId(item.originId, `${itemPath}.originId`);
      safeId(item.segmentId, `${itemPath}.segmentId`);
      if (segmentIds.has(item.segmentId)) fail("CUT_TIMELINE_EDIT_SHAPE", `${itemPath}.segmentId`, "must be globally unique.");
      segmentIds.add(item.segmentId);
      if (item.parentSegmentId !== undefined) {
        safeId(item.parentSegmentId, `${itemPath}.parentSegmentId`);
        fail(
          "CUT_TIMELINE_EDIT_SHAPE",
          `${itemPath}.parentSegmentId`,
          "initial-plan items must omit parentSegmentId; ancestry begins only when a canonical operation derives a new segment.",
        );
      }
      if (item.trackId !== track.trackId || item.domain !== track.domain) fail("CUT_TIMELINE_EDIT_SHAPE", itemPath, "item track/domain ownership disagrees with its track.");
      if (item.linkId) safeId(item.linkId, `${itemPath}.linkId`);
      positiveInterval(item.destination, `${itemPath}.destination`);
      if (!sameRational(item.destination.start, cursor)) fail("CUT_TIMELINE_EDIT_TIME", `${itemPath}.destination`, "items must provide exact contiguous track coverage in source order.");
      cursor = intervalEnd(item.destination);
      safeMetadata(item.metadata, `${itemPath}.metadata`);
      validateSourceView(item, itemPath);
      if (item.sourceView.kind === "nested" && track.domain !== "picture" && track.domain !== "audiovisual") {
        fail("CUT_TIMELINE_EDIT_SHAPE", `${itemPath}.sourceView.kind`, "nested source views require a picture or shared audiovisual track.");
      }
      if (item.sourceView.kind === "gap" && (item.linkId || item.parentSegmentId)) {
        fail("CUT_TIMELINE_EDIT_SHAPE", itemPath, "gap items cannot carry link or segment-parent identity.");
      }
    }
    if (!sameRational(cursor, duration)) fail("CUT_TIMELINE_EDIT_TIME", `${path}.items`, "items must cover the complete initial duration.");
  }
  if (totalItems > timelineEditLimits.maximumItems) {
    fail("CUT_TIMELINE_EDIT_LIMIT", "$.tracks", `base item count exceeds ${timelineEditLimits.maximumItems}.`);
  }
}

function sourceOffsetForDestination(
  item: TimelineEditItemV1,
  destinationOffset: Rational,
  operationIndex: number,
) {
  const view = item.sourceView;
  if (view.kind === "gap") return zeroRational;
  if (view.kind === "picture") {
    if (view.timeMap.kind === "freeze") return subtractRational(view.timeMap.at, view.source.start);
    if (view.timeMap.kind === "speed-ramp") return pictureSpeedRampSourceOffset(view.timeMap, destinationOffset);
    return multiplyRational(destinationOffset, view.timeMap.rate);
  }
  return multiplyRational(destinationOffset, view.rate);
}

function slicedTimeMap(
  view: Extract<TimelineEditSourceView, { kind: "picture" }>,
  destinationOffset: Rational,
  duration: Rational,
) {
  if (view.timeMap.kind === "speed-ramp") return slicePictureSpeedRamp(view.timeMap, destinationOffset, duration);
  return cloneTimeMap(view.timeMap);
}

function segmentId(parent: TimelineEditItemV1, operationId: string, label: string) {
  return `seg_${hash({
    version: 1,
    parent: parent.segmentId,
    origin: parent.originId,
    operationId,
    label,
  }).slice(0, 24)}`;
}

function segmentItem(
  item: TimelineEditItemV1,
  start: Rational,
  duration: Rational,
  operation: Pick<TimelineEditOperationV1, "id" | "provenance">,
  label: string,
  operationIndex: number,
  allowDeclaredHandles = false,
  observeSegment?: TimelineEditExecutionSegmentObserverV1,
) {
  const offset = subtractRational(start, item.destination.start);
  if (compareRational(duration, zeroRational) <= 0) {
    fail("CUT_TIMELINE_EDIT_RESULT", "$.materialization", "internal segment lies outside its parent item.", operationIndex);
  }
  const requestedEnd = addRational(offset, duration);
  if (!allowDeclaredHandles
    && (compareRational(offset, zeroRational) < 0
      || compareRational(requestedEnd, item.destination.duration) > 0)) {
    fail("CUT_TIMELINE_EDIT_RESULT", "$.materialization", "internal segment lies outside its parent item.", operationIndex);
  }
  if (allowDeclaredHandles) {
    const view = item.sourceView;
    if (view.kind === "gap" || view.kind === "nested"
      || (view.kind === "picture" && view.timeMap.kind !== "constant")) {
      fail("CUT_TIMELINE_EDIT_UNSUPPORTED", "$.materialization", "this boundary operation requires a direct constant-map media view with explicit handles.", operationIndex);
    }
  }
  const cloned = cloneItem(item);
  if (cloned.sourceView.kind === "gap") {
    const result = {
      ...cloned,
      segmentId: segmentId(item, operation.id, label),
      destination: { start, duration },
      provenance: structuredClone(operation.provenance),
    };
    observeSegment?.(Object.freeze(cloneItem(result)));
    return result;
  }
  const sourceOffset = sourceOffsetForDestination(item, offset, operationIndex);
  const sourceDuration = sourceOffsetForDestination(item, addRational(offset, duration), operationIndex);
  const mappedDuration = subtractRational(sourceDuration, sourceOffset);
  const view = cloned.sourceView;
  const mappedSource = view.kind === "picture" && view.timeMap.kind === "constant" && view.timeMap.direction === "reverse"
    ? {
        start: subtractRational(intervalEnd(view.source), addRational(sourceOffset, mappedDuration)),
        duration: mappedDuration,
      }
    : view.kind === "picture" && view.timeMap.kind === "freeze"
      ? { ...view.source }
      : { start: addRational(view.source.start, sourceOffset), duration: mappedDuration };
  const nextView: TimelineEditSourceView = view.kind === "picture"
    ? {
        ...view,
        source: mappedSource,
        handles: {
          head: subtractRational(mappedSource.start, sourceAvailableStart(view)),
          tail: subtractRational(sourceAvailableEnd(view), intervalEnd(mappedSource)),
        },
        timeMap: slicedTimeMap(view, offset, duration),
      }
    : view.kind === "nested"
      ? {
          ...view,
          source: mappedSource,
          handles: {
            head: subtractRational(mappedSource.start, sourceAvailableStart(view)),
            tail: subtractRational(sourceAvailableEnd(view), intervalEnd(mappedSource)),
          },
        }
      : {
        ...view,
        source: mappedSource,
        handles: {
          head: subtractRational(mappedSource.start, sourceAvailableStart(view)),
          tail: subtractRational(sourceAvailableEnd(view), intervalEnd(mappedSource)),
        },
        presentationClock: {
          ...view.presentationClock,
          sliceOffset: addRational(view.presentationClock.sliceOffset, offset),
        },
      };
  if (allowDeclaredHandles
    && (compareRational(mappedSource.start, sourceAvailableStart(view)) < 0
      || compareRational(intervalEnd(mappedSource), sourceAvailableEnd(view)) > 0)) {
    fail("CUT_TIMELINE_EDIT_HANDLE", "$.materialization", "boundary operation exceeds declared source handles.", operationIndex);
  }
  const result = {
    ...cloned,
    segmentId: segmentId(item, operation.id, label),
    parentSegmentId: item.segmentId,
    destination: { start, duration },
    sourceView: nextView,
    provenance: structuredClone(operation.provenance),
  };
  observeSegment?.(Object.freeze(cloneItem(result)));
  return result;
}

function gapItem(
  track: TimelineEditTrackV1,
  start: Rational,
  duration: Rational,
  operation: Pick<TimelineEditOperationV1, "id" | "provenance">,
  label: string,
): TimelineEditItemV1 {
  return {
    originId: `gap_${hash({ trackId: track.trackId, operationId: operation.id, label }).slice(0, 24)}`,
    segmentId: `seg_${hash({ trackId: track.trackId, operationId: operation.id, label, kind: "gap" }).slice(0, 24)}`,
    trackId: track.trackId,
    domain: track.domain,
    destination: { start, duration },
    sourceView: { kind: "gap", authorityId: `gap_${hash({ trackId: track.trackId, operationId: operation.id }).slice(0, 24)}` },
    metadata: {},
    provenance: structuredClone(operation.provenance),
  };
}

function reflow(items: readonly TimelineEditItemV1[]) {
  let cursor = zeroRational;
  return items.map((item) => {
    const cloned = cloneItem(item);
    const next = { ...cloned, destination: { start: cursor, duration: cloned.destination.duration } };
    cursor = addRational(cursor, cloned.destination.duration);
    return next;
  });
}

function coalesceGaps(
  track: TimelineEditTrackV1,
  items: readonly TimelineEditItemV1[],
  operation: Pick<TimelineEditOperationV1, "id" | "provenance">,
) {
  const result: TimelineEditItemV1[] = [];
  for (const item of reflow(items)) {
    const previous = result.at(-1);
    if (previous?.sourceView.kind === "gap" && item.sourceView.kind === "gap") {
      result[result.length - 1] = gapItem(
        track,
        previous.destination.start,
        addRational(previous.destination.duration, item.destination.duration),
        operation,
        `coalesced:${result.length - 1}`,
      );
    } else result.push(item);
  }
  return reflow(result);
}

function targetSelection(
  operation: Extract<TimelineEditOperationV1, { kind: "insert" | "overwrite" }>,
  domain: TimelineEditDomain,
) {
  return operation.targets[domain];
}

function validateOperandTargetSelection(
  tracks: readonly TimelineEditTrackV1[],
  selection: TimelineEditSelectionV1,
  domain: TimelineEditDomain,
  path: string,
  operationIndex: number,
) {
  validateSelection(tracks, selection, path, operationIndex);
  if (selection.trackIds.length !== 1
    || selection.originIds !== undefined
    || selection.linkIds !== undefined
    || selection.range !== undefined
    || selection.relation !== undefined) {
    fail(
      "CUT_TIMELINE_EDIT_SELECTION",
      path,
      "insert/overwrite targets must name exactly one track and may only add allowUnlinked.",
      operationIndex,
    );
  }
  const track = tracks.find((candidate) => candidate.trackId === selection.trackIds[0])!;
  if (track.domain !== domain) {
    fail("CUT_TIMELINE_EDIT_SELECTION", path, `target track ${JSON.stringify(track.trackId)} is ${track.domain}, not ${domain}.`, operationIndex);
  }
  return track;
}

function resolveOperand(
  initialTracks: readonly TimelineEditTrackV1[],
  currentTracks: readonly TimelineEditTrackV1[],
  operation: Extract<TimelineEditOperationV1, { kind: "insert" | "overwrite" }>,
  operationIndex: number,
) {
  const path = `$.operations[${operationIndex}]`;
  if (!operation.operand.parts.length || operation.operand.parts.length > 3) {
    fail("CUT_TIMELINE_EDIT_SHAPE", `${path}.operand.parts`, "must contain one through three domain-unique parts.", operationIndex);
  }
  if (new Set(operation.operand.parts.map((part) => part.domain)).size !== operation.operand.parts.length) {
    fail("CUT_TIMELINE_EDIT_SHAPE", `${path}.operand.parts`, "contains duplicate domains.", operationIndex);
  }
  if (operation.operand.parts.length > 1 && operation.operand.linkId === undefined) {
    fail("CUT_TIMELINE_EDIT_LINK", `${path}.operand.linkId`, "a coupled multi-domain operand requires one stable linkId.", operationIndex);
  }
  if (operation.operand.linkId !== undefined) {
    safeId(operation.operand.linkId, `${path}.operand.linkId`);
    if (currentTracks.some((track) => track.items.some((item) => item.linkId === operation.operand.linkId))) {
      fail("CUT_TIMELINE_EDIT_LINK", `${path}.operand.linkId`, "must be a new link identity; extending an existing link group is not implicit.", operationIndex);
    }
  }
  const targetKeys = (["picture", "audio", "audiovisual"] as const)
    .filter((domain) => targetSelection(operation, domain) !== undefined);
  if (!targetKeys.length || targetKeys.length !== operation.operand.parts.length
    || operation.operand.parts.some((part) => !targetKeys.includes(part.domain))) {
    fail("CUT_TIMELINE_EDIT_SELECTION", `${path}.targets`, "must declare exactly one matching target for every operand domain.", operationIndex);
  }
  const selections = targetKeys.map((domain) => targetSelection(operation, domain)!);
  const unlinkValues = new Set(selections.map((selection) => selection.allowUnlinked === true));
  if (unlinkValues.size > 1) {
    fail("CUT_TIMELINE_EDIT_LINK", `${path}.targets`, "coupled target selections must agree on allowUnlinked.", operationIndex);
  }
  const allowUnlinked = selections[0]?.allowUnlinked === true;
  const nextOriginIds = operation.operand.parts.map((part) => part.originId);
  if (new Set(nextOriginIds).size !== nextOriginIds.length
    || nextOriginIds.some((originId) => currentTracks.some((track) => track.items.some((item) => item.originId === originId)))) {
    fail("CUT_TIMELINE_EDIT_SHAPE", `${path}.operand.parts`, "new operand originId values must be unique and absent from current tracks.", operationIndex);
  }
  const resolved = operation.operand.parts.map((part, partIndex) => {
    const partPath = `${path}.operand.parts[${partIndex}]`;
    safeId(part.sourceOriginId, `${partPath}.sourceOriginId`);
    safeId(part.originId, `${partPath}.originId`);
    positiveInterval({ start: zeroRational, duration: part.destinationDuration }, `${partPath}.destinationDuration`, operationIndex);
    safeMetadata(part.metadata, `${partPath}.metadata`);
    const matches = initialTracks.flatMap((track) =>
      track.domain === part.domain
        ? track.items.filter((item) => item.originId === part.sourceOriginId)
        : []);
    if (matches.length !== 1 || matches[0]!.sourceView.kind === "gap") {
      fail("CUT_TIMELINE_EDIT_REFERENCE", `${partPath}.sourceOriginId`, "must identify exactly one non-gap initial-plan item in the declared domain.", operationIndex);
    }
    const source = matches[0]!;
    if (!sameRational(source.destination.duration, part.destinationDuration)) {
      fail("CUT_TIMELINE_EDIT_TIME", `${partPath}.destinationDuration`, "must exactly equal the selected source item's authored destination duration; trim or retime the source view before placement.", operationIndex);
    }
    if (source.sourceView.kind === "nested"
      && source.sourceView.placementPolicy !== "static-same-track-copy") {
      fail(
        "CUT_TIMELINE_EDIT_UNSUPPORTED",
        `${partPath}.sourceOriginId`,
        "nested Precomp insert/overwrite requires a compiler-authenticated static same-track copy authority; dynamic, effectful, child-bearing, or unsupported presentation views are structural-only.",
        operationIndex,
      );
    }
    const selection = targetSelection(operation, part.domain)!;
    const target = validateOperandTargetSelection(currentTracks, selection, part.domain, `${path}.${part.domain}`, operationIndex);
    if (source.sourceView.kind === "nested"
      && source.trackId !== target.trackId) {
      fail(
        "CUT_TIMELINE_EDIT_UNSUPPORTED",
        `${partPath}.sourceOriginId`,
        "a nested Precomp operand may currently be copied only within its owning PictureTrack; cross-track nested authority requires a separately authenticated instance/ancestor contract.",
        operationIndex,
      );
    }
    return { part, source, selection, target };
  });
  if (!allowUnlinked) {
    const sourceLinks = new Set(resolved.flatMap(({ source }) => source.linkId ? [source.linkId] : []));
    for (const linkId of sourceLinks) {
      const ownerDomains = new Set(initialTracks.flatMap((track) =>
        track.items.some((item) => item.linkId === linkId) ? [track.domain] : []));
      const suppliedDomains = new Set(resolved.flatMap(({ source, part }) =>
        source.linkId === linkId ? [part.domain] : []));
      const omitted = [...ownerDomains].find((domain) => !suppliedDomains.has(domain));
      if (omitted) {
        fail("CUT_TIMELINE_EDIT_LINK", `${path}.operand`, `source link ${JSON.stringify(linkId)} also owns omitted ${omitted} media; set allowUnlinked explicitly for a one-sided placement.`, operationIndex);
      }
    }
  }
  return { resolved, allowUnlinked };
}

function operandItem(
  target: TimelineEditTrackV1,
  source: TimelineEditItemV1,
  part: TimelineEditOperandPartV1,
  operand: TimelineEditOperandV1,
  start: Rational,
  operation: Extract<TimelineEditOperationV1, { kind: "insert" | "overwrite" }>,
  partIndex: number,
): TimelineEditItemV1 {
  const sourceView = cloneSourceView(source.sourceView);
  const authorityTrackId = timelineEditAudioPresentationOriginTrackId(source);
  const placedSourceView = sourceView.kind === "audio"
    || sourceView.kind === "processed-audio"
    ? {
        ...sourceView,
        presentationClock: {
          originDuration: sourceView.presentationClock.originDuration,
          sliceOffset: sourceView.presentationClock.sliceOffset,
          fadePolicy: "origin-relative" as const,
          authorityOriginId:
            sourceView.presentationClock.authorityOriginId ?? source.originId,
          ...(authorityTrackId === target.trackId
            ? {}
            : { authorityTrackId }),
        },
      } as TimelineEditSourceView
    : sourceView;
  return {
    ...cloneItem(source),
    originId: part.originId,
    segmentId: `seg_${hash({
      version: 1,
      operationId: operation.id,
      targetTrackId: target.trackId,
      partIndex,
      sourceAuthorityId: source.sourceView.authorityId,
    }).slice(0, 24)}`,
    parentSegmentId: source.segmentId,
    trackId: target.trackId,
    domain: target.domain,
    ...(operand.linkId === undefined ? {} : { linkId: operand.linkId }),
    destination: { start, duration: part.destinationDuration },
    sourceView: placedSourceView,
    metadata: { ...source.metadata, ...part.metadata },
    provenance: structuredClone(operation.provenance),
  };
}

/** The immutable unsliced audio clock shared by copied operands and every
 * later structural slice. Authored plans omit the explicit field and retain
 * their item origin as the compatibility identity. */
export function timelineEditAudioPresentationOriginId(
  item: TimelineEditItemV1,
) {
  const view = item.sourceView;
  return view.kind === "audio" || view.kind === "processed-audio"
    ? view.presentationClock.authorityOriginId ?? item.originId
    : item.originId;
}

/** The source track that owns the authenticated unsliced audio clock. */
export function timelineEditAudioPresentationOriginTrackId(
  item: TimelineEditItemV1,
) {
  const view = item.sourceView;
  return view.kind === "audio" || view.kind === "processed-audio"
    ? view.presentationClock.authorityTrackId ?? item.trackId
    : item.trackId;
}

/** Collision-free key for one authenticated audio presentation origin. */
export function timelineEditAudioPresentationOriginKey(
  item: TimelineEditItemV1,
) {
  return `${timelineEditAudioPresentationOriginTrackId(item)}\0${timelineEditAudioPresentationOriginId(item)}`;
}

function insertOperandTrack(
  track: TimelineEditTrackV1,
  item: TimelineEditItemV1,
  at: Rational,
  operation: Extract<TimelineEditOperationV1, { kind: "insert" }>,
  operationIndex: number,
  observeSegment?: TimelineEditExecutionSegmentObserverV1,
) {
  const tailStart = subtractRational(track.duration, item.destination.duration);
  if (compareRational(at, zeroRational) < 0 || compareRational(at, tailStart) > 0) {
    fail("CUT_TIMELINE_EDIT_TIME", `$.operations[${operationIndex}].at`, "insert must precede the explicit tail closure it consumes.", operationIndex);
  }
  const split = splitAtBoundaries(
    track,
    [at, tailStart],
    operation,
    operationIndex,
    observeSegment,
  );
  const tail = split.filter((candidate) => compareRational(candidate.destination.start, tailStart) >= 0);
  if (!tail.length || tail.some((candidate) => candidate.sourceView.kind !== "gap")) {
    fail("CUT_TIMELINE_EDIT_RESULT", `$.operations[${operationIndex}]`, "fixed-duration insert may consume only explicit tail gap coverage.", operationIndex);
  }
  const before = split.filter((candidate) => compareRational(intervalEnd(candidate.destination), at) <= 0);
  const shifted = split.filter((candidate) =>
    compareRational(candidate.destination.start, at) >= 0
    && compareRational(intervalEnd(candidate.destination), tailStart) <= 0);
  return {
    ...cloneTrack(track),
    items: coalesceGaps(track, [...before, item, ...shifted], operation),
  };
}

function overwriteOperandTrack(
  track: TimelineEditTrackV1,
  item: TimelineEditItemV1,
  at: Rational,
  operation: Extract<TimelineEditOperationV1, { kind: "overwrite" }>,
  operationIndex: number,
  observeSegment?: TimelineEditExecutionSegmentObserverV1,
) {
  const end = addRational(at, item.destination.duration);
  if (compareRational(at, zeroRational) < 0 || compareRational(end, track.duration) > 0) {
    fail("CUT_TIMELINE_EDIT_TIME", `$.operations[${operationIndex}].at`, "overwrite interval lies outside its target track.", operationIndex);
  }
  const split = splitAtBoundaries(
    track,
    [at, end],
    operation,
    operationIndex,
    observeSegment,
  );
  const retained = split.filter((candidate) =>
    compareRational(intervalEnd(candidate.destination), at) <= 0
    || compareRational(candidate.destination.start, end) >= 0);
  const before = retained.filter((candidate) => compareRational(intervalEnd(candidate.destination), at) <= 0);
  const after = retained.filter((candidate) => compareRational(candidate.destination.start, end) >= 0);
  return {
    ...cloneTrack(track),
    items: coalesceGaps(track, [...before, item, ...after], operation),
  };
}

function splitAtBoundaries(
  track: TimelineEditTrackV1,
  boundaries: readonly Rational[],
  operation: Pick<TimelineEditOperationV1, "id" | "provenance">,
  operationIndex: number,
  observeSegment?: TimelineEditExecutionSegmentObserverV1,
) {
  const sorted = [...boundaries].sort(compareRational);
  let items = track.items.map(cloneItem);
  for (const [boundaryIndex, boundary] of sorted.entries()) {
    const itemIndex = items.findIndex((item) =>
      compareRational(boundary, item.destination.start) > 0
      && compareRational(boundary, intervalEnd(item.destination)) < 0);
    if (itemIndex < 0) continue;
    const item = items[itemIndex];
    const before = segmentItem(item, item.destination.start, subtractRational(boundary, item.destination.start), operation, `split:${boundaryIndex}:before`, operationIndex, false, observeSegment);
    const after = segmentItem(item, boundary, subtractRational(intervalEnd(item.destination), boundary), operation, `split:${boundaryIndex}:after`, operationIndex, false, observeSegment);
    items = [...items.slice(0, itemIndex), before, after, ...items.slice(itemIndex + 1)];
  }
  return items;
}

function ensureSelectedCoverage(
  items: readonly TimelineEditItemV1[],
  selection: TimelineEditSelectionV1,
  range: IREditorialInterval,
  path: string,
  operationIndex: number,
) {
  const parts = items.filter((item) => overlap(item.destination, range));
  if (!parts.length) fail("CUT_TIMELINE_EDIT_SELECTION", path, "selects no material.", operationIndex);
  const unselected = parts.find((item) => !selectedByIds(item, selection));
  if (unselected) {
    fail("CUT_TIMELINE_EDIT_SELECTION", path, `range crosses unselected item ${JSON.stringify(unselected.originId)}.`, operationIndex);
  }
  let cursor = range.start;
  for (const item of parts) {
    const intersection = overlap(item.destination, range)!;
    if (!sameRational(intersection.start, cursor)) fail("CUT_TIMELINE_EDIT_RESULT", path, "selected material does not cover the operation interval contiguously.", operationIndex);
    cursor = intervalEnd(intersection);
  }
  if (!sameRational(cursor, intervalEnd(range))) fail("CUT_TIMELINE_EDIT_RESULT", path, "selected material does not cover the complete operation interval.", operationIndex);
}

function structuralTrackOperation(
  track: TimelineEditTrackV1,
  operation: Extract<TimelineEditOperationV1, { kind: "ripple-delete" | "lift" | "extract" | "trim" }>,
  operationIndex: number,
  observeSegment?: TimelineEditExecutionSegmentObserverV1,
) {
  const range = operation.kind === "trim"
    ? domainInterval(track.domain, operation.keep, `$.operations[${operationIndex}].keep`, operationIndex)
    : domainInterval(track.domain, operation.range, `$.operations[${operationIndex}].range`, operationIndex);
  if (compareRational(intervalEnd(range), track.duration) > 0) {
    fail("CUT_TIMELINE_EDIT_TIME", `$.operations[${operationIndex}]`, "range lies outside its selected track.", operationIndex);
  }
  const boundaries = [range.start, intervalEnd(range)];
  const split = splitAtBoundaries(
    track,
    boundaries,
    operation,
    operationIndex,
    observeSegment,
  );
  ensureSelectedCoverage(split, operation.selection, range, `$.operations[${operationIndex}].selection`, operationIndex);

  if (operation.kind === "trim") {
    const retained = split.filter((item) =>
      compareRational(item.destination.start, range.start) >= 0
      && compareRational(intervalEnd(item.destination), intervalEnd(range)) <= 0);
    const beforeDuration = range.start;
    const afterDuration = subtractRational(track.duration, intervalEnd(range));
    const next: TimelineEditItemV1[] = [];
    if (compareRational(beforeDuration, zeroRational) > 0) next.push(gapItem(track, zeroRational, beforeDuration, operation, "trim:head"));
    next.push(...retained);
    if (compareRational(afterDuration, zeroRational) > 0) next.push(gapItem(track, intervalEnd(range), afterDuration, operation, "trim:tail"));
    return { ...cloneTrack(track), items: coalesceGaps(track, next, operation) };
  }

  if (operation.kind === "lift") {
    const next = split.map((item) =>
      compareRational(item.destination.start, range.start) >= 0
        && compareRational(intervalEnd(item.destination), intervalEnd(range)) <= 0
        ? gapItem(track, item.destination.start, item.destination.duration, operation, `lift:${item.segmentId}`)
        : item);
    return { ...cloneTrack(track), items: coalesceGaps(track, next, operation) };
  }

  const retained = split.filter((item) =>
    compareRational(intervalEnd(item.destination), range.start) <= 0
    || compareRational(item.destination.start, intervalEnd(range)) >= 0);
  const compact = reflow(retained);
  const tail = gapItem(
    track,
    subtractRational(track.duration, range.duration),
    range.duration,
    operation,
    `${operation.kind}:tail`,
  );
  return { ...cloneTrack(track), items: coalesceGaps(track, [...compact, tail], operation) };
}

function splitTrack(
  track: TimelineEditTrackV1,
  operation: Extract<TimelineEditOperationV1, { kind: "split" }>,
  operationIndex: number,
  observeSegment?: TimelineEditExecutionSegmentObserverV1,
) {
  const at = domainTime(track.domain, operation.at, `$.operations[${operationIndex}].at`, operationIndex);
  if (compareRational(at, zeroRational) <= 0 || compareRational(at, track.duration) >= 0) {
    fail("CUT_TIMELINE_EDIT_TIME", `$.operations[${operationIndex}].at`, "must be a strict interior track time.", operationIndex);
  }
  const selected = selectedItems(track, operation.selection, undefined);
  const target = selected.find((item) =>
    compareRational(at, item.destination.start) > 0
    && compareRational(at, intervalEnd(item.destination)) < 0);
  if (!target) fail("CUT_TIMELINE_EDIT_SELECTION", `$.operations[${operationIndex}].selection`, "does not select one item strictly containing the split.", operationIndex);
  const items = splitAtBoundaries(
    track,
    [at],
    operation,
    operationIndex,
    observeSegment,
  );
  if (items.length !== track.items.length + 1) fail("CUT_TIMELINE_EDIT_RESULT", `$.operations[${operationIndex}]`, "split did not create exactly two item segments.", operationIndex);
  return { ...cloneTrack(track), items };
}

function sourceAvailableStart(view: Exclude<TimelineEditSourceView, { kind: "gap" }>) {
  return subtractRational(view.source.start, view.handles.head);
}

function sourceAvailableEnd(view: Exclude<TimelineEditSourceView, { kind: "gap" }>) {
  return addRational(intervalEnd(view.source), view.handles.tail);
}

function shiftSource(
  item: TimelineEditItemV1,
  by: Rational,
  operation: Pick<TimelineEditOperationV1, "id" | "provenance">,
  operationIndex: number,
  observeSegment?: TimelineEditExecutionSegmentObserverV1,
) {
  const view = item.sourceView;
  if (view.kind === "gap") fail("CUT_TIMELINE_EDIT_UNSUPPORTED", `$.operations[${operationIndex}]`, "cannot slip a gap.", operationIndex);
  if (view.kind === "picture" && (view.timeMap.kind === "freeze" || view.timeMap.kind === "speed-ramp")) {
    fail("CUT_TIMELINE_EDIT_UNSUPPORTED", `$.operations[${operationIndex}]`, "slip on freeze or variable picture time maps is not closed in TimelineEdit v1.", operationIndex);
  }
  if (view.kind === "nested") fail("CUT_TIMELINE_EDIT_UNSUPPORTED", `$.operations[${operationIndex}]`, "nested source slip is not closed in TimelineEdit v1.", operationIndex);
  const sourceDelta = view.kind === "picture"
    ? multiplyRational(by, (view.timeMap as Extract<IRPictureTimeMap, { kind: "constant" }>).rate)
    : multiplyRational(by, view.rate);
  const availableStart = sourceAvailableStart(view);
  const availableEnd = sourceAvailableEnd(view);
  const nextSource = { start: addRational(view.source.start, sourceDelta), duration: view.source.duration };
  if (compareRational(nextSource.start, availableStart) < 0
    || compareRational(intervalEnd(nextSource), availableEnd) > 0) {
    fail("CUT_TIMELINE_EDIT_HANDLE", `$.operations[${operationIndex}]`, "slip exceeds declared source handles.", operationIndex);
  }
  const nextView = {
    ...cloneSourceView(view),
    source: nextSource,
    handles: {
      head: subtractRational(nextSource.start, availableStart),
      tail: subtractRational(availableEnd, intervalEnd(nextSource)),
    },
    ...(view.kind === "audio" || view.kind === "processed-audio"
      ? {
          presentationClock: {
            ...view.presentationClock,
            sliceOffset: addRational(
              view.presentationClock.sliceOffset,
              by,
            ),
          },
        }
      : {}),
  } as TimelineEditSourceView;
  const result = {
    ...cloneItem(item),
    segmentId: segmentId(item, operation.id, "slip"),
    parentSegmentId: item.segmentId,
    sourceView: nextView,
    provenance: structuredClone(operation.provenance),
  };
  observeSegment?.(Object.freeze(cloneItem(result)));
  return result;
}

function slipTrack(
  track: TimelineEditTrackV1,
  operation: Extract<TimelineEditOperationV1, { kind: "slip" }>,
  operationIndex: number,
  observeSegment?: TimelineEditExecutionSegmentObserverV1,
) {
  const range = domainInterval(track.domain, operation.range, `$.operations[${operationIndex}].range`, operationIndex);
  const by = domainTime(track.domain, operation.by, `$.operations[${operationIndex}].by`, operationIndex);
  const selected = selectedItems(track, operation.selection, range)
    .filter((item) => sameInterval(item.destination, range));
  if (selected.length !== 1) fail("CUT_TIMELINE_EDIT_SELECTION", `$.operations[${operationIndex}]`, "slip must select exactly one complete item.", operationIndex);
  return {
    ...cloneTrack(track),
    items: track.items.map((item) => item.segmentId === selected[0].segmentId ? shiftSource(item, by, operation, operationIndex, observeSegment) : cloneItem(item)),
  };
}

function slideTrack(
  track: TimelineEditTrackV1,
  operation: Extract<TimelineEditOperationV1, { kind: "slide" }>,
  operationIndex: number,
  observeSegment?: TimelineEditExecutionSegmentObserverV1,
) {
  const range = domainInterval(track.domain, operation.range, `$.operations[${operationIndex}].range`, operationIndex);
  const by = domainTime(track.domain, operation.by, `$.operations[${operationIndex}].by`, operationIndex);
  const index = track.items.findIndex((item) => sameInterval(item.destination, range) && selectedByIds(item, operation.selection));
  if (index <= 0 || index >= track.items.length - 1) {
    fail("CUT_TIMELINE_EDIT_SELECTION", `$.operations[${operationIndex}]`, "slide requires one selected complete item with immediate left and right neighbors.", operationIndex);
  }
  const left = track.items[index - 1], selected = track.items[index], right = track.items[index + 1];
  const leftDuration = addRational(left.destination.duration, by);
  const rightDuration = subtractRational(right.destination.duration, by);
  if (compareRational(leftDuration, zeroRational) <= 0 || compareRational(rightDuration, zeroRational) <= 0) {
    fail("CUT_TIMELINE_EDIT_TIME", `$.operations[${operationIndex}].by`, "slide would collapse an adjacent item.", operationIndex);
  }
  if (left.sourceView.kind === "gap" || right.sourceView.kind === "gap") {
    fail("CUT_TIMELINE_EDIT_UNSUPPORTED", `$.operations[${operationIndex}]`, "v1 slide requires media neighbors with explicit source handles.", operationIndex);
  }
  const leftNext = segmentItem(left, left.destination.start, leftDuration, operation, "slide:left", operationIndex, true, observeSegment);
  const selectedNext = { ...cloneItem(selected), destination: { start: addRational(selected.destination.start, by), duration: selected.destination.duration } };
  const rightStart = addRational(right.destination.start, by);
  const rightNext = segmentItem(right, rightStart, rightDuration, operation, "slide:right", operationIndex, true, observeSegment);
  const items = track.items.map(cloneItem);
  items[index - 1] = leftNext;
  items[index] = selectedNext;
  items[index + 1] = rightNext;
  return { ...cloneTrack(track), items };
}

function boundaryTrack(
  track: TimelineEditTrackV1,
  operation: Extract<TimelineEditOperationV1, { kind: "boundary-adjust" }>,
  operationIndex: number,
  observeSegment?: TimelineEditExecutionSegmentObserverV1,
) {
  const at = domainTime(track.domain, operation.at, `$.operations[${operationIndex}].at`, operationIndex);
  const selected = selectedItems(track, operation.selection, undefined).filter((item) => item.sourceView.kind !== "gap");
  if (selected.length !== 2) fail("CUT_TIMELINE_EDIT_SELECTION", `$.operations[${operationIndex}]`, "boundary-adjust must select exactly two media items.", operationIndex);
  const [left, right] = [...selected].sort((a, b) => compareRational(a.destination.start, b.destination.start));
  if (!sameRational(intervalEnd(left.destination), right.destination.start)) {
    fail("CUT_TIMELINE_EDIT_SELECTION", `$.operations[${operationIndex}]`, "boundary-adjust items must be adjacent.", operationIndex);
  }
  if (compareRational(at, left.destination.start) <= 0 || compareRational(at, intervalEnd(right.destination)) >= 0) {
    fail("CUT_TIMELINE_EDIT_TIME", `$.operations[${operationIndex}].at`, "new boundary must remain strictly inside the adjacent pair.", operationIndex);
  }
  const leftNext = segmentItem(left, left.destination.start, subtractRational(at, left.destination.start), operation, "boundary:left", operationIndex, true, observeSegment);
  const rightNext = segmentItem(right, at, subtractRational(intervalEnd(right.destination), at), operation, "boundary:right", operationIndex, true, observeSegment);
  const items = track.items.map(cloneItem);
  items[items.findIndex((item) => item.segmentId === left.segmentId)] = leftNext;
  items[items.findIndex((item) => item.segmentId === right.segmentId)] = rightNext;
  return { ...cloneTrack(track), items };
}

function transitionSource(
  item: TimelineEditItemV1,
  side: "outgoing" | "incoming",
  halfDuration: Rational,
  operationIndex: number,
) {
  const view = item.sourceView;
  if (view.kind === "gap") fail("CUT_TIMELINE_EDIT_TRANSITION", `$.operations[${operationIndex}]`, "transition cannot consume a gap.", operationIndex);
  if (view.kind === "picture" && (view.timeMap.kind === "freeze" || view.timeMap.kind === "speed-ramp")) {
    fail("CUT_TIMELINE_EDIT_UNSUPPORTED", `$.operations[${operationIndex}]`, "v1 transitions require a constant invertible picture time map over handle intervals.", operationIndex);
  }
  if (view.kind === "nested") {
    fail("CUT_TIMELINE_EDIT_UNSUPPORTED", `$.operations[${operationIndex}]`, "nested transition handles are not closed in TimelineEdit v1.", operationIndex);
  }
  const rate = view.kind === "picture"
    ? (view.timeMap as Extract<IRPictureTimeMap, { kind: "constant" }>).rate
    : view.rate;
  const sourceAmount = multiplyRational(halfDuration, rate);
  const reverse = view.kind === "picture" && view.timeMap.kind === "constant" && view.timeMap.direction === "reverse";
  const available = side === "outgoing"
    ? reverse ? view.handles.head : view.handles.tail
    : reverse ? view.handles.tail : view.handles.head;
  if (compareRational(available, sourceAmount) < 0) {
    fail("CUT_TIMELINE_EDIT_HANDLE", `$.operations[${operationIndex}]`, `${side} transition exceeds declared source handle availability.`, operationIndex);
  }
  if (!reverse) {
    return side === "outgoing"
      ? { start: intervalEnd(view.source), duration: sourceAmount }
      : { start: subtractRational(view.source.start, sourceAmount), duration: sourceAmount };
  }
  return side === "outgoing"
    ? { start: subtractRational(view.source.start, sourceAmount), duration: sourceAmount }
    : { start: intervalEnd(view.source), duration: sourceAmount };
}

function terminalTransition(
  tracks: readonly TimelineEditTrackV1[],
  operation: Extract<TimelineEditOperationV1, { kind: "transition" }>,
  operationIndex: number,
) {
  validateSelection(tracks, operation.left, `$.operations[${operationIndex}].left`, operationIndex);
  validateSelection(tracks, operation.right, `$.operations[${operationIndex}].right`, operationIndex);
  const commonIds = operation.left.trackIds.filter((id) => operation.right.trackIds.includes(id));
  if (!commonIds.length) fail("CUT_TIMELINE_EDIT_SELECTION", `$.operations[${operationIndex}]`, "transition left/right selections must name at least one common track.", operationIndex);
  const transitions: TimelineEditTransitionV1[] = [];
  const selectedLeft: TimelineEditItemV1[] = [];
  const selectedRight: TimelineEditItemV1[] = [];
  for (const trackId of commonIds) {
    const track = tracks.find((candidate) => candidate.trackId === trackId)!;
    if (track.domain === "audiovisual") fail("CUT_TIMELINE_EDIT_UNSUPPORTED", `$.operations[${operationIndex}]`, "nested audiovisual transitions are not closed in v1.", operationIndex);
    const cut = domainTime(track.domain, operation.at, `$.operations[${operationIndex}].at`, operationIndex);
    const duration = domainTime(track.domain, operation.duration, `$.operations[${operationIndex}].duration`, operationIndex);
    if (compareRational(duration, zeroRational) <= 0) fail("CUT_TIMELINE_EDIT_TIME", `$.operations[${operationIndex}].duration`, "must be positive.", operationIndex);
    const half = divideRational(duration, rational(2));
    const left = selectedItems(track, operation.left, undefined).find((item) => sameRational(intervalEnd(item.destination), cut));
    const right = selectedItems(track, operation.right, undefined).find((item) => sameRational(item.destination.start, cut));
    if (!left || !right) fail("CUT_TIMELINE_EDIT_TRANSITION", `$.operations[${operationIndex}]`, `track ${trackId} has no selected adjacent pair at the declared cut.`, operationIndex);
    selectedLeft.push(left);
    selectedRight.push(right);
    if (track.domain === "picture" && !operation.picture) fail("CUT_TIMELINE_EDIT_TRANSITION", `$.operations[${operationIndex}].picture`, "picture track requires picture transition style.", operationIndex);
    if (track.domain === "audio" && !operation.audio) fail("CUT_TIMELINE_EDIT_TRANSITION", `$.operations[${operationIndex}].audio`, "audio track requires audio transition style.", operationIndex);
    transitions.push(Object.freeze({
      operationId: operation.id,
      trackId,
      domain: track.domain,
      cut,
      duration,
      overlap: { start: subtractRational(cut, half), duration },
      outgoingSegmentId: left.segmentId,
      incomingSegmentId: right.segmentId,
      outgoingSource: transitionSource(left, "outgoing", half, operationIndex),
      incomingSource: transitionSource(right, "incoming", half, operationIndex),
      ...(track.domain === "picture" ? { picture: operation.picture! } : { audio: operation.audio! }),
    }));
  }
  validateSelectedLinkClosure(
    tracks,
    operation.left,
    selectedLeft,
    `$.operations[${operationIndex}].left`,
    operationIndex,
  );
  validateSelectedLinkClosure(
    tracks,
    operation.right,
    selectedRight,
    `$.operations[${operationIndex}].right`,
    operationIndex,
  );
  return transitions;
}

function ensureTrackResult(track: TimelineEditTrackV1, operationIndex: number) {
  if (track.items.length > timelineEditLimits.maximumItems) {
    fail("CUT_TIMELINE_EDIT_LIMIT", `$.operations[${operationIndex}]`, `materialized item count exceeds ${timelineEditLimits.maximumItems}.`, operationIndex);
  }
  let cursor = zeroRational;
  for (const [itemIndex, item] of track.items.entries()) {
    if (!sameRational(item.destination.start, cursor)) fail("CUT_TIMELINE_EDIT_RESULT", `$.tracks.${track.trackId}.items[${itemIndex}]`, "result contains a gap or overlap.", operationIndex);
    cursor = intervalEnd(item.destination);
  }
  if (!sameRational(cursor, track.duration)) fail("CUT_TIMELINE_EDIT_RESULT", `$.tracks.${track.trackId}`, "result duration changed outside its declared fixed-duration plan.", operationIndex);
}

export function executeTimelineEditPlan(
  plan: TimelineEditPlanV1,
  observeStage?: (stage: TimelineEditExecutionStageV1) => void,
  observeSegment?: TimelineEditExecutionSegmentObserverV1,
): TimelineEditExecutionV1 {
  safeId(plan.id, "$.id");
  safeId(plan.compositionId, "$.compositionId");
  safeId(plan.sceneId, "$.sceneId");
  positiveInterval({ start: zeroRational, duration: plan.initialDuration }, "$.initialDuration");
  if (!sameRational(plan.initialDuration, plan.finalDuration)) {
    fail("CUT_TIMELINE_EDIT_UNSUPPORTED", "$.finalDuration", "TimelineEdit v1 currently requires fixed programme duration; ripple/extract close with explicit tail gaps.");
  }
  if (!plan.operations.length || plan.operations.length > timelineEditLimits.maximumOperations) {
    fail("CUT_TIMELINE_EDIT_LIMIT", "$.operations", `must contain 1 through ${timelineEditLimits.maximumOperations} operations.`);
  }
  validateTracks(plan.tracks, plan.initialDuration);
  const operationIds = new Set<string>();
  let tracks = plan.tracks.map(cloneTrack);
  const transitions: TimelineEditTransitionV1[] = [];
  const terminalTracks = new Set<string>();
  for (const [operationIndex, operation] of plan.operations.entries()) {
    safeId(operation.id, `$.operations[${operationIndex}].id`);
    if (operationIds.has(operation.id)) fail("CUT_TIMELINE_EDIT_SHAPE", `$.operations[${operationIndex}].id`, "operation ids must be unique.", operationIndex);
    operationIds.add(operation.id);
    if (operation.kind === "transition") {
      const resolved = terminalTransition(tracks, operation, operationIndex);
      for (const transition of resolved) {
        const existing = transitions.find((candidate) =>
          candidate.trackId === transition.trackId
          && overlap(candidate.overlap, transition.overlap));
        if (existing) fail("CUT_TIMELINE_EDIT_TRANSITION", `$.operations[${operationIndex}]`, `transition overlaps earlier terminal transition ${existing.operationId}.`, operationIndex);
        terminalTracks.add(transition.trackId);
        transitions.push(transition);
      }
      observeStage?.(Object.freeze({
        operationIndex,
        operationId: operation.id,
        tracks: Object.freeze(tracks.map((track) => Object.freeze(cloneTrack(track)))),
      }));
      continue;
    }
    if (operation.kind === "insert" || operation.kind === "overwrite") {
      const { resolved, allowUnlinked } = resolveOperand(
        plan.tracks,
        tracks,
        operation,
        operationIndex,
      );
      const targetIds = new Set(resolved.map(({ target }) => target.trackId));
      const terminal = [...targetIds].find((id) => terminalTracks.has(id));
      if (terminal) {
        fail("CUT_TIMELINE_EDIT_TRANSITION", `$.operations[${operationIndex}]`, `structural operation follows terminal transition on track ${terminal}.`, operationIndex);
      }
      const touched = resolved.flatMap(({ target, part }) => {
        const at = domainTime(target.domain, operation.at, `$.operations[${operationIndex}].at`, operationIndex);
        const end = operation.kind === "insert"
          ? subtractRational(target.duration, part.destinationDuration)
          : addRational(at, part.destinationDuration);
        return target.items.filter((item) =>
          item.sourceView.kind !== "gap"
          && compareRational(intervalEnd(item.destination), at) > 0
          && compareRational(item.destination.start, end) < 0);
      });
      validateSelectedLinkClosure(
        tracks,
        { trackIds: [...targetIds], ...(allowUnlinked ? { allowUnlinked: true } : {}) },
        touched,
        `$.operations[${operationIndex}].targets`,
        operationIndex,
      );
      tracks = tracks.map((track) => {
        const partIndex = resolved.findIndex(({ target }) => target.trackId === track.trackId);
        if (partIndex < 0) return cloneTrack(track);
        const { part, source } = resolved[partIndex]!;
        const at = domainTime(track.domain, operation.at, `$.operations[${operationIndex}].at`, operationIndex);
        const placed = operandItem(track, source, part, operation.operand, at, operation, partIndex);
        const next = operation.kind === "insert"
          ? insertOperandTrack(
              track,
              placed,
              at,
              operation,
              operationIndex,
              observeSegment,
            )
          : overwriteOperandTrack(
              track,
              placed,
              at,
              operation,
              operationIndex,
              observeSegment,
            );
        ensureTrackResult(next, operationIndex);
        return next;
      });
      observeStage?.(Object.freeze({
        operationIndex,
        operationId: operation.id,
        tracks: Object.freeze(tracks.map((track) => Object.freeze(cloneTrack(track)))),
      }));
      continue;
    }
    validateSelection(tracks, operation.selection, `$.operations[${operationIndex}].selection`, operationIndex);
    validateSelectedLinkClosure(
      tracks,
      operation.selection,
      selectedStructuralOperationItems(tracks, operation, operationIndex),
      `$.operations[${operationIndex}].selection`,
      operationIndex,
    );
    const selectedTrackIds = new Set(operation.selection.trackIds);
    const terminal = operation.selection.trackIds.find((id) => terminalTracks.has(id));
    if (terminal) fail("CUT_TIMELINE_EDIT_TRANSITION", `$.operations[${operationIndex}]`, `structural operation follows terminal transition on track ${terminal}.`, operationIndex);
    tracks = tracks.map((track) => {
      if (!selectedTrackIds.has(track.trackId)) return cloneTrack(track);
      let next: TimelineEditTrackV1;
      if (operation.kind === "split") {
        next = splitTrack(track, operation, operationIndex, observeSegment);
      }
      else if (operation.kind === "trim" || operation.kind === "ripple-delete" || operation.kind === "lift" || operation.kind === "extract") {
        next = structuralTrackOperation(
          track,
          operation,
          operationIndex,
          observeSegment,
        );
      } else if (operation.kind === "slip") {
        next = slipTrack(track, operation, operationIndex, observeSegment);
      }
      else if (operation.kind === "slide") {
        next = slideTrack(track, operation, operationIndex, observeSegment);
      }
      else {
        next = boundaryTrack(track, operation, operationIndex, observeSegment);
      }
      ensureTrackResult(next, operationIndex);
      return next;
    });
    observeStage?.(Object.freeze({
      operationIndex,
      operationId: operation.id,
      tracks: Object.freeze(tracks.map((track) => Object.freeze(cloneTrack(track)))),
    }));
  }
  const ordered = [...tracks].sort((left, right) => left.order - right.order || left.trackId.localeCompare(right.trackId));
  const materializationId = hash({
    format: "cut-timeline-edit-materialization",
    version: 1,
    plan: {
      id: plan.id,
      compositionId: plan.compositionId,
      sceneId: plan.sceneId,
      initialDuration: plan.initialDuration,
      finalDuration: plan.finalDuration,
      operations: plan.operations,
    },
    tracks: ordered,
    transitions,
  });
  const execution = {
    version: 1 as const,
    planId: plan.id,
    tracks: ordered.map((track) => Object.freeze(cloneTrack(track))),
    transitions: transitions.map((transition) => Object.freeze(structuredClone(transition))),
    materializationId,
  };
  // A stable serialization here is an inexpensive last guard against values
  // that are not part of the closed deterministic identity vocabulary.
  stableJsonStringify(execution);
  return Object.freeze(execution);
}
