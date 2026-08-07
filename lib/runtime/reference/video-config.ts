import type { CutAVIR, IRComposition, IRNode, IRValue } from "../../language/ir";
import {
  compareRational,
  divideRational,
  multiplyRational,
  rational,
  subtractRational,
  type Rational,
  zeroRational,
} from "../../language/rational";
import {
  referenceVideoInputColorDeclaration,
  validateLockedVideoColorMetadata,
  validateReferenceVideoColorInterpretation,
  type LockedVideoColorMetadata,
  type ReferenceVideoInputColorDeclaration,
  type ReferenceVideoInputColorProfile,
} from "./color-management";
import { referenceMediaProfileResourceState } from "./media-profile-state";
import type { CutDecodedVideoCadence } from "../../language/video-cadence";
import { referenceNormalizedCrop, type ReferenceNormalizedCrop } from "./shape-config";

export type ReferenceVideoConfigErrorCode =
  | "CUT_VIDEO_SOURCE"
  | "CUT_VIDEO_INPUT_TYPE"
  | "CUT_VIDEO_INPUT_ENUM"
  | "CUT_VIDEO_INPUT_COMBINATION"
  | "CUT_VIDEO_VALUE_RANGE"
  | "CUT_VIDEO_TIME_GRID";

export type ReferenceVideoConfigSource = {
  module: string;
  line: number;
  column: number;
  nodeId: string;
};

export class ReferenceVideoConfigError extends Error {
  constructor(
    readonly code: ReferenceVideoConfigErrorCode,
    readonly nodeId: string,
    message: string,
    readonly source: ReferenceVideoConfigSource | { nodeId: string } = { nodeId },
  ) {
    super(`${code}: ${message}`);
    this.name = "ReferenceVideoConfigError";
  }
}

export type ReferenceVideoSelection = {
  streamIndex: number;
  duration: Rational;
  durationSource?: "stream" | "decoded-video-cadence";
  start?: Rational;
  timeBase: Rational;
  frameRate: Rational;
  decodedVideoCadence?: CutDecodedVideoCadence;
  color?: LockedVideoColorMetadata;
  /** Required by picture decoding; optional only for the narrow color-metadata
   * assertion helper, which never opens or sizes video pixels. */
  width?: number;
  height?: number;
  variant?: "master" | "proxy";
};

type ClosedReferenceVideoSelection = ReferenceVideoSelection & {
  durationSource: "stream" | "decoded-video-cadence";
  start: Rational;
};

export type ReferenceVideoInputConfig = {
  kind: "video";
  resourceId: string;
  streamIndex: number;
  sourceStart: Rational;
  sourceEnd: Rational;
  sourceDuration: Rational;
  selectedDuration: Rational;
  selectedDurationSource: "stream" | "decoded-video-cadence";
  selectedStart: Rational;
  selectedTimeBase: Rational;
  selectedFrameRate: Rational;
  decodedVideoCadence?: CutDecodedVideoCadence;
  fit: "cover" | "contain" | "fill";
  crop?: ReferenceNormalizedCrop;
  nativeWidth: number;
  nativeHeight: number;
  /** `contain` exposes uncovered pixels as alpha 0; CUT never invents black bars inside the layer. */
  containBackground: "transparent";
  loop: boolean;
  endBehavior: "error" | "hold";
  /** Legacy omission preserves the pre-managed decoder path exactly. */
  inputColor: ReferenceVideoInputColorProfile | "legacy";
};

/**
 * The locked color interpretation shared by every public video-consuming
 * kernel. Editorial clips own different time-mapping semantics from Video,
 * but they must not fall back to a second implicit decoder color path.
 */
export type ReferenceVideoInputColorConfig = Readonly<{
  resourceId: string;
  streamIndex: number;
  inputColor: ReferenceVideoInputColorProfile | "legacy";
  mode: ReferenceVideoInputColorDeclaration["mode"];
  declaration: ReferenceVideoInputColorDeclaration;
}>;

export type ReferenceVideoConfig = ReferenceVideoInputConfig & {
  decodeDuration: Rational;
};

export type ReferenceVideoStaticInputConfig = Readonly<{
  resourceId: string;
  fit: "cover" | "contain" | "fill";
  crop?: ReferenceNormalizedCrop;
  loop: boolean;
  endBehavior: "error" | "hold";
  sourceRange?: Readonly<{ start: Rational; end: Rational }>;
  inputColorDeclaration: ReferenceVideoInputColorDeclaration;
}>;

function source(node: IRNode): ReferenceVideoConfigSource {
  return {
    module: node.provenance.module,
    line: node.provenance.span.start.line,
    column: node.provenance.span.start.column,
    nodeId: node.id,
  };
}

function location(node: IRNode) {
  return `${node.provenance.module}:${node.provenance.span.start.line}:${node.provenance.span.start.column}`;
}

function videoConsumerName(node: IRNode) {
  if (node.op === "cut.edit.picture_clip") return "PictureClip";
  if (node.op === "cut.edit.clip") return "Clip";
  return "Video";
}

function fail(node: IRNode, code: ReferenceVideoConfigErrorCode, message: string): never {
  throw new ReferenceVideoConfigError(code, node.id, `${videoConsumerName(node)} at ${location(node)} ${message}`, source(node));
}

function canonicalRational(node: IRNode, value: unknown, label: string, code: ReferenceVideoConfigErrorCode) {
  if (!value || typeof value !== "object") fail(node, code, `${label} must carry a canonical exact rational.`);
  const candidate = value as { numerator?: unknown; denominator?: unknown };
  if (
    typeof candidate.numerator !== "string"
    || typeof candidate.denominator !== "string"
    || !/^-?(?:0|[1-9]\d*)$/.test(candidate.numerator)
    || !/^[1-9]\d*$/.test(candidate.denominator)
    || candidate.numerator.length > 256
    || candidate.denominator.length > 256
  ) fail(node, code, `${label} must carry a canonical exact rational.`);
  try {
    const exact = rational(candidate.numerator, candidate.denominator);
    if (exact.numerator !== candidate.numerator || exact.denominator !== candidate.denominator) throw new Error("non-canonical");
    return exact;
  } catch {
    fail(node, code, `${label} must carry a canonical exact rational.`);
  }
}

function exactTime(node: IRNode, value: IRValue | undefined, label: string) {
  if (value?.kind !== "quantity" || value.dimension !== "time" || value.unit !== "s") {
    fail(node, "CUT_VIDEO_INPUT_TYPE", `${label} must be a canonical Time quantity in seconds.`);
  }
  return canonicalRational(node, value.magnitude, label, "CUT_VIDEO_INPUT_TYPE");
}

function booleanInput(node: IRNode, name: string, fallback: boolean) {
  const value = node.inputs[name];
  if (value === undefined) return fallback;
  if (value.kind !== "boolean") fail(node, "CUT_VIDEO_INPUT_TYPE", `input “${name}” must be Boolean.`);
  return value.value;
}

function stringInput<T extends string>(node: IRNode, name: string, values: readonly T[], fallback: T): T {
  const value = node.inputs[name];
  if (value === undefined) return fallback;
  if (value.kind !== "string") fail(node, "CUT_VIDEO_INPUT_TYPE", `input “${name}” must be String.`);
  if (!values.includes(value.value as T)) fail(node, "CUT_VIDEO_INPUT_ENUM", `input “${name}” must be one of: ${values.join(", ")}.`);
  return value.value as T;
}

function embeddedSelection(ir: CutAVIR, node: IRNode, resourceId: string): ClosedReferenceVideoSelection {
  const metadata = ir.resources[resourceId]?.metadata;
  const probe = metadata?.probe as {
    kind?: unknown;
    selected?: { video?: Partial<ReferenceVideoSelection> };
    identity?: { streams?: Array<{ index?: unknown; type?: unknown; start?: unknown; timeBase?: unknown; frameRate?: unknown; averageFrameRate?: unknown; width?: unknown; height?: unknown; pixelFormat?: unknown; fieldOrder?: unknown; colorRange?: unknown; colorSpace?: unknown; colorTransfer?: unknown; colorPrimaries?: unknown }> };
  } | undefined;
  const selected = probe?.kind === "media" ? probe.selected?.video : undefined;
  if (!selected) fail(node, "CUT_VIDEO_SOURCE", `resource ${resourceId} has no lock-selected video stream.`);
  const streamIndex = selected.streamIndex;
  if (!Number.isSafeInteger(streamIndex) || (streamIndex as number) < 0) fail(node, "CUT_VIDEO_SOURCE", `resource ${resourceId} has an invalid lock-selected video stream index.`);
  const duration = canonicalRational(node, selected.duration, `resource ${resourceId} selected duration`, "CUT_VIDEO_SOURCE");
  const timeBase = canonicalRational(node, selected.timeBase, `resource ${resourceId} selected time base`, "CUT_VIDEO_SOURCE");
  if (compareRational(duration, zeroRational) <= 0 || compareRational(timeBase, zeroRational) <= 0) {
    fail(node, "CUT_VIDEO_SOURCE", `resource ${resourceId} must have positive selected duration and time base.`);
  }
  const stream = probe?.identity?.streams?.find((candidate) => candidate.index === streamIndex && candidate.type === "video");
  if (!stream) fail(node, "CUT_VIDEO_SOURCE", `resource ${resourceId} selected stream ${streamIndex} is not a locked video stream.`);
  const streamTimeBase = canonicalRational(node, stream.timeBase, `resource ${resourceId} stream ${streamIndex} time base`, "CUT_VIDEO_SOURCE");
  if (compareRational(streamTimeBase, timeBase) !== 0) fail(node, "CUT_VIDEO_SOURCE", `resource ${resourceId} selected time base does not match video stream ${streamIndex}.`);
  const streamFrameRate = canonicalRational(node, stream.frameRate, `resource ${resourceId} stream ${streamIndex} frame rate`, "CUT_VIDEO_SOURCE");
  const frameRate = canonicalRational(node, selected.frameRate ?? stream.frameRate, `resource ${resourceId} selected frame rate`, "CUT_VIDEO_SOURCE");
  if (compareRational(streamFrameRate, zeroRational) <= 0 || compareRational(frameRate, zeroRational) <= 0) fail(node, "CUT_VIDEO_SOURCE", `resource ${resourceId} video stream ${streamIndex} must have a positive exact frame rate.`);
  const durationSource = selected.durationSource === undefined || selected.durationSource === "stream" ? "stream" : selected.durationSource === "decoded-video-cadence" ? selected.durationSource : undefined;
  if (!durationSource) fail(node, "CUT_VIDEO_SOURCE", `resource ${resourceId} selected video duration authority is invalid.`);
  if (stream.start === undefined) fail(node, "CUT_VIDEO_SOURCE", `resource ${resourceId} selected video stream requires an exact non-negative start.`);
  const start = canonicalRational(node, stream.start, `resource ${resourceId} stream ${streamIndex} start`, "CUT_VIDEO_SOURCE");
  if (compareRational(start, zeroRational) < 0) fail(node, "CUT_VIDEO_SOURCE", `resource ${resourceId} selected video stream requires an exact non-negative start.`);
  if (divideRational(start, timeBase).denominator !== "1") fail(node, "CUT_VIDEO_SOURCE", `resource ${resourceId} selected video stream start must land on its exact codec time base.`);
  const bounded = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 128 ? value : undefined;
  const width = stream.width, height = stream.height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || Number(width) < 1 || Number(height) < 1) {
    fail(node, "CUT_VIDEO_SOURCE", `resource ${resourceId} video stream ${streamIndex} requires positive locked native dimensions.`);
  }
  return {
    streamIndex: streamIndex as number,
    duration,
    durationSource,
    start,
    timeBase,
    frameRate,
    width: Number(width),
    height: Number(height),
    decodedVideoCadence: selected.decodedVideoCadence,
    color: {
      pixelFormat: bounded(stream.pixelFormat),
      fieldOrder: bounded(stream.fieldOrder),
      colorRange: bounded(stream.colorRange),
      colorSpace: bounded(stream.colorSpace),
      colorTransfer: bounded(stream.colorTransfer),
      colorPrimaries: bounded(stream.colorPrimaries),
    },
    variant: metadata?.activeMediaVariant === undefined
      ? "master"
      : referenceMediaProfileResourceState(ir, resourceId)?.selected ?? "master",
  };
}

function checkedSelection(node: IRNode, selection: ReferenceVideoSelection): ClosedReferenceVideoSelection {
  if (!Number.isSafeInteger(selection.streamIndex) || selection.streamIndex < 0) fail(node, "CUT_VIDEO_SOURCE", "selected video stream index must be a non-negative safe integer.");
  const duration = canonicalRational(node, selection.duration, "selected video duration", "CUT_VIDEO_SOURCE");
  const durationSource = selection.durationSource === undefined || selection.durationSource === "stream" ? "stream" : selection.durationSource === "decoded-video-cadence" ? selection.durationSource : undefined;
  if (!durationSource) fail(node, "CUT_VIDEO_SOURCE", "selected video duration authority must be stream or decoded-video-cadence.");
  if (selection.start === undefined) fail(node, "CUT_VIDEO_SOURCE", "selected video stream requires an exact non-negative start.");
  const start = canonicalRational(node, selection.start, "selected video stream start", "CUT_VIDEO_SOURCE");
  const timeBase = canonicalRational(node, selection.timeBase, "selected video time base", "CUT_VIDEO_SOURCE");
  const frameRate = canonicalRational(node, selection.frameRate, "selected video frame rate", "CUT_VIDEO_SOURCE");
  if (compareRational(duration, zeroRational) <= 0 || compareRational(timeBase, zeroRational) <= 0 || compareRational(frameRate, zeroRational) <= 0) fail(node, "CUT_VIDEO_SOURCE", "selected video duration, time base, and frame rate must be positive.");
  if (compareRational(start, zeroRational) < 0) fail(node, "CUT_VIDEO_SOURCE", "selected video stream requires an exact non-negative start.");
  if (divideRational(start, timeBase).denominator !== "1") fail(node, "CUT_VIDEO_SOURCE", "selected video stream start must land on its exact codec time base.");
  const variant = selection.variant === undefined || selection.variant === "master" || selection.variant === "proxy" ? selection.variant : undefined;
  if (selection.variant !== undefined && variant === undefined) fail(node, "CUT_VIDEO_SOURCE", "selected video variant must be master or proxy.");
  const dimensionsSupplied = selection.width !== undefined || selection.height !== undefined;
  if (dimensionsSupplied && (!Number.isSafeInteger(selection.width) || !Number.isSafeInteger(selection.height) || Number(selection.width) < 1 || Number(selection.height) < 1)) {
    fail(node, "CUT_VIDEO_SOURCE", "selected video override native dimensions must be supplied together as positive safe integers.");
  }
  return { streamIndex: selection.streamIndex, duration, durationSource, start, timeBase, frameRate, ...(dimensionsSupplied ? { width: Number(selection.width), height: Number(selection.height) } : {}), decodedVideoCadence: selection.decodedVideoCadence, color: selection.color, ...(variant ? { variant } : {}) };
}

function selectedVideo(ir: CutAVIR, node: IRNode, override?: ReferenceVideoSelection) {
  const authored = node.inputs.source;
  if (authored?.kind !== "resource-ref") fail(node, "CUT_VIDEO_SOURCE", "requires input “source”: VideoAsset resource reference.");
  const resource = ir.resources[authored.id];
  if (!resource || resource.kind !== "video") fail(node, "CUT_VIDEO_SOURCE", `input “source” must reference a video resource; received ${resource?.kind ?? "missing resource"}.`);
  const selected = override ? checkedSelection(node, override) : embeddedSelection(ir, node, authored.id);
  return { resourceId: authored.id, ...selected };
}

function resourceHasAuthoredProxy(ir: CutAVIR, node: IRNode, resourceId: string) {
  const resource = ir.resources[resourceId];
  if (resource?.proxy) return true;
  const metadata = resource?.metadata as { activeMediaVariant?: unknown; authoredProxy?: unknown } | undefined;
  if (metadata?.activeMediaVariant === undefined && metadata?.authoredProxy === undefined) return false;
  const authority = referenceMediaProfileResourceState(ir, resourceId);
  if (!authority) fail(node, "CUT_VIDEO_SOURCE", `resource ${resourceId} carries media-profile evidence without invocation-local authority.`);
  return authority.authoredProxy;
}

const videoInputColorOps = new Set(["cut.visual.video", "cut.edit.clip", "cut.edit.picture_clip"]);

/**
 * Validate and close the color meaning of Video, linked Clip, and PictureClip
 * against the same lock-selected stream metadata. Omission remains the exact
 * legacy decoder behavior for backwards compatibility.
 */
export function referenceVideoInputColorConfig(
  ir: CutAVIR,
  node: IRNode,
  selectionOverride?: ReferenceVideoSelection,
): ReferenceVideoInputColorConfig | undefined {
  if (!videoInputColorOps.has(node.op)) return undefined;
  const selected = selectedVideo(ir, node, selectionOverride);
  const declaration = referenceVideoInputColorDeclaration(node);
  if (declaration.mode === "asserted") validateLockedVideoColorMetadata(node, declaration.inputColor, selected.color);
  if (declaration.mode === "interpreted") {
    const resourceHasProxy = resourceHasAuthoredProxy(ir, node, selected.resourceId);
    validateReferenceVideoColorInterpretation(node, declaration, selected.color, selected.variant ?? "master", resourceHasProxy);
  }
  return Object.freeze({
    resourceId: selected.resourceId,
    streamIndex: selected.streamIndex,
    inputColor: declaration.inputColor,
    mode: declaration.mode,
    declaration,
  });
}

function sourceRange(node: IRNode, selected: ReferenceVideoSelection) {
  const authored = node.inputs.range;
  if (authored === undefined) return { start: zeroRational, end: selected.duration, explicit: false };
  if (authored.kind !== "range") fail(node, "CUT_VIDEO_INPUT_TYPE", "input “range” must be Range<Time>.");
  if (!authored.exclusive) fail(node, "CUT_VIDEO_INPUT_COMBINATION", "input “range” must use the half-open start ..< end form.");
  const start = exactTime(node, authored.start, "source-range start"), end = exactTime(node, authored.end, "source-range end");
  if (compareRational(start, zeroRational) < 0 || compareRational(end, start) <= 0) {
    fail(node, "CUT_VIDEO_VALUE_RANGE", "source range must be positive and cannot begin before zero.");
  }
  if (compareRational(end, selected.duration) > 0) {
    fail(node, "CUT_VIDEO_VALUE_RANGE", `source range ends at ${end.numerator}/${end.denominator}s, beyond the selected source bound ${selected.duration.numerator}/${selected.duration.denominator}s.`);
  }
  for (const [label, value] of [["start", start], ["end", end]] as const) {
    if (multiplyRational(value, selected.frameRate).denominator !== "1") {
      fail(node, "CUT_VIDEO_TIME_GRID", `source-range ${label} does not land on the selected ${selected.frameRate.numerator}/${selected.frameRate.denominator} fps source frame grid.`);
    }
  }
  return { start, end, explicit: true };
}

/** Parse every Video input whose meaning does not depend on a selected stream
 * or native probe. `cut check` uses this before lock; exact duration/frame-grid
 * bounds and decoded cadence remain properties of the locked planner. */
export function referenceVideoStaticInputConfig(ir: CutAVIR, node: IRNode): ReferenceVideoStaticInputConfig | undefined {
  if (node.op !== "cut.visual.video") return undefined;
  const authoredSource = node.inputs.source;
  if (authoredSource?.kind !== "resource-ref") fail(node, "CUT_VIDEO_SOURCE", "requires input “source”: VideoAsset resource reference.");
  const resource = ir.resources[authoredSource.id];
  if (!resource || resource.kind !== "video") fail(node, "CUT_VIDEO_SOURCE", `input “source” must reference a video resource; received ${resource?.kind ?? "missing resource"}.`);
  const fit = stringInput(node, "fit", ["cover", "contain", "fill"] as const, "cover");
  const crop = referenceNormalizedCrop(node, node.inputs.crop);
  const loop = booleanInput(node, "loop", false);
  const endBehavior = stringInput(node, "endBehavior", ["error", "hold"] as const, "error");
  const authoredRange = node.inputs.range;
  let sourceRange: Readonly<{ start: Rational; end: Rational }> | undefined;
  if (authoredRange !== undefined) {
    if (authoredRange.kind !== "range") fail(node, "CUT_VIDEO_INPUT_TYPE", "input “range” must be Range<Time>.");
    if (!authoredRange.exclusive) fail(node, "CUT_VIDEO_INPUT_COMBINATION", "input “range” must use the half-open start ..< end form.");
    const start = exactTime(node, authoredRange.start, "source-range start");
    const end = exactTime(node, authoredRange.end, "source-range end");
    if (compareRational(start, zeroRational) < 0 || compareRational(end, start) <= 0) {
      fail(node, "CUT_VIDEO_VALUE_RANGE", "source range must be positive and cannot begin before zero.");
    }
    sourceRange = Object.freeze({ start, end });
  }
  if (loop && sourceRange) {
    fail(node, "CUT_VIDEO_INPUT_COMBINATION", "cannot combine loop: true with an explicit range until exact trimmed-range looping is implemented.");
  }
  if (loop && node.inputs.endBehavior !== undefined) {
    fail(node, "CUT_VIDEO_INPUT_COMBINATION", "cannot combine loop: true with endBehavior because a looping source has no authored end to hold or reject.");
  }
  const inputColorDeclaration = referenceVideoInputColorDeclaration(node);
  return Object.freeze({
    resourceId: authoredSource.id,
    fit,
    ...(crop ? { crop } : {}),
    loop,
    endBehavior,
    ...(sourceRange ? { sourceRange } : {}),
    inputColorDeclaration,
  });
}

/**
 * Close the source/range/playback contract. Lock application and the reference
 * renderer call this same function so accepted Video inputs cannot acquire a
 * second, backend-only interpretation.
 */
export function referenceVideoInputConfig(
  ir: CutAVIR,
  node: IRNode,
  selectionOverride?: ReferenceVideoSelection,
): ReferenceVideoInputConfig | undefined {
  if (node.op !== "cut.visual.video") return undefined;
  const selected = selectedVideo(ir, node, selectionOverride);
  if (!Number.isSafeInteger(selected.width) || !Number.isSafeInteger(selected.height) || Number(selected.width) < 1 || Number(selected.height) < 1) {
    fail(node, "CUT_VIDEO_SOURCE", `resource ${selected.resourceId} requires positive selected native video dimensions before picture decoding.`);
  }
  const color = referenceVideoInputColorConfig(ir, node, selected);
  if (!color) throw new Error("Internal CUT Video input-color configuration mismatch.");
  const range = sourceRange(node, selected);
  const fit = stringInput(node, "fit", ["cover", "contain", "fill"] as const, "cover");
  const crop = referenceNormalizedCrop(node, node.inputs.crop);
  const loop = booleanInput(node, "loop", false);
  const endBehavior = stringInput(node, "endBehavior", ["error", "hold"] as const, "error");
  if ((range.explicit || loop) && !selected.decodedVideoCadence) {
    fail(node, "CUT_VIDEO_SOURCE", "explicit trimming and looping require a locked decoded-video-cadence witness; unproved VFR media is supported only as an untrimmed Video source.");
  }
  if (loop && range.explicit) {
    fail(node, "CUT_VIDEO_INPUT_COMBINATION", "cannot combine loop: true with an explicit range until exact trimmed-range looping is implemented.");
  }
  if (loop && node.inputs.endBehavior !== undefined) {
    fail(node, "CUT_VIDEO_INPUT_COMBINATION", "cannot combine loop: true with endBehavior because a looping source has no authored end to hold or reject.");
  }
  const sourceDuration = subtractRational(range.end, range.start);
  if (!loop && endBehavior === "error" && compareRational(sourceDuration, node.interval.duration) < 0) {
    fail(node, "CUT_VIDEO_VALUE_RANGE", `needs ${node.interval.duration.numerator}/${node.interval.duration.denominator}s, but selected video stream provides only ${sourceDuration.numerator}/${sourceDuration.denominator}s; use endBehavior: “hold” to freeze the final frame.`);
  }
  return Object.freeze({
    kind: "video" as const,
    resourceId: selected.resourceId,
    streamIndex: selected.streamIndex,
    sourceStart: range.start,
    sourceEnd: range.end,
    sourceDuration,
    selectedDuration: selected.duration,
    selectedDurationSource: selected.durationSource,
    selectedStart: selected.start,
    selectedTimeBase: selected.timeBase,
    selectedFrameRate: selected.frameRate,
    decodedVideoCadence: selected.decodedVideoCadence,
    fit,
    ...(crop ? { crop } : {}),
    nativeWidth: Number(selected.width),
    nativeHeight: Number(selected.height),
    containBackground: "transparent" as const,
    loop,
    endBehavior,
    inputColor: color.inputColor,
  });
}

/** Add destination-frame-grid semantics needed by the picture runtime. */
export function referenceVideoConfig(
  ir: CutAVIR,
  composition: IRComposition,
  node: IRNode,
  selectionOverride?: ReferenceVideoSelection,
): ReferenceVideoConfig | undefined {
  const input = referenceVideoInputConfig(ir, node, selectionOverride);
  if (!input) return undefined;
  for (const [label, value] of [["destination start", node.interval.start], ["destination duration", node.interval.duration]] as const) {
    const exact = canonicalRational(node, value, label, "CUT_VIDEO_INPUT_TYPE");
    if (label === "destination duration" ? compareRational(exact, zeroRational) <= 0 : compareRational(exact, zeroRational) < 0) {
      fail(node, "CUT_VIDEO_VALUE_RANGE", `${label} must be ${label === "destination duration" ? "positive" : "non-negative"}.`);
    }
    if (multiplyRational(exact, composition.fps).denominator !== "1") {
      fail(node, "CUT_VIDEO_TIME_GRID", `${label} does not land on the ${composition.fps.numerator}/${composition.fps.denominator} fps destination frame grid.`);
    }
  }
  const decodeDuration = input.loop || compareRational(input.sourceDuration, node.interval.duration) >= 0
    ? node.interval.duration
    : input.sourceDuration;
  return Object.freeze({ ...input, decodeDuration });
}
