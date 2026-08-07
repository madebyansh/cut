import type { CutAVIR, IRComposition, IRNode, IRPictureTimeMap } from "../../language/ir";
import type { LockedResourceProbe } from "../../language/lock";
import { hash, stableJsonStringify } from "../../core/stable";
import {
  PictureTimeMapInputError,
  authoredPictureTimeMap,
  pictureSpeedRampSourceOffset,
  pictureTimeMapSourceRange,
} from "../../language/picture-time-map";
import {
  addRational,
  compareRational,
  divideRational,
  multiplyRational,
  rational,
  subtractRational,
  type Rational,
  zeroRational,
} from "../../language/rational";
import {
  referencePictureFrameBlendPhaseUnits,
  referencePictureFrameBlendPolicyIdentity,
} from "./picture-frame-blend";

export const referencePictureTimeMapLimits = Object.freeze({
  maximumReverseSourceFrames: 3_600,
  maximumReverseCanvasBytes: 512 * 1024 * 1024,
});

export const referencePictureTimeMapFrameEvidenceContract = Object.freeze({
  format: "cut-reference-picture-time-map-frame" as const,
  version: 1 as const,
  sampleClock: "exact-decoder-frame-phase+locked-source-frame-time" as const,
  outputBinding: "decoded-rgba-sha256" as const,
});

export const referencePictureTimeMapFrameEvidenceLimits = Object.freeze({
  maximumReceiptsPerRendererFrame: 4_096,
});

export type ReferencePictureTimeMapConfig = {
  kind: "picture-time-map";
  resourceId: string;
  streamIndex: number;
  map: IRPictureTimeMap;
  sourceStart: Rational;
  sourceEnd: Rational;
  sourceDuration: Rational;
  selectedDuration: Rational;
  selectedDurationSource: "stream" | "decoded-video-cadence";
  selectedStart: Rational;
  selectedTimeBase: Rational;
  selectedFrameRate: Rational;
  destinationFrameRate: Rational;
  sourceFrameCount: number;
  decodeStart: Rational;
  decodeDuration: Rational;
  consumedHeadHandle?: Rational;
  consumedTailHandle?: Rational;
  reverseDecode: boolean;
  frameBlendPolicyIdentity?: string;
};

export type ReferencePictureDecoderSample = Readonly<{
  firstFrame: number;
  secondFrame: number;
  phaseQ16: number;
  exactFrame: Rational;
  frameSelection: "floor" | "nearest" | "frame-blend";
  frameBlendPolicyIdentity?: string;
}>;

export type ReferencePictureTimeMapExecutionPathEntry = Readonly<{
  compositionId: string;
  instanceNodeId: string;
  sourceCompositionId: string;
}>;

export type ReferencePictureTimeMapFrameRequest =
  | Readonly<{
      kind: "destination-frame";
      destinationFrame: number;
    }>
  | Readonly<{
      kind: "absolute-source-time";
      sourceTime: Rational;
    }>;

export type ReferencePictureTimeMapFrameEvidence = Readonly<{
  format: typeof referencePictureTimeMapFrameEvidenceContract.format;
  version: typeof referencePictureTimeMapFrameEvidenceContract.version;
  compositionId: string;
  nodeId: string;
  resourceId: string;
  streamIndex: number;
  outputFrame: string;
  executionPath: readonly ReferencePictureTimeMapExecutionPathEntry[];
  configIdentity: string;
  request:
    | Readonly<{
        kind: "destination-frame";
        destinationFrame: number;
        destinationTime: Rational;
      }>
    | Readonly<{
        kind: "absolute-source-time";
        sourceTime: Rational;
      }>;
  sample: Readonly<{
    exactDecoderFrame: Rational;
    firstDecoderFrame: number;
    secondDecoderFrame: number;
    phaseQ16: number;
    frameSelection: "floor" | "nearest" | "frame-blend";
    firstLockedSourceTime: Rational;
    secondLockedSourceTime: Rational;
    frameBlendPolicyIdentity?: string;
  }>;
  decodedOutput: Readonly<{
    width: number;
    height: number;
    rgbaBytes: number;
    rgbaSha256: string;
  }>;
  executionIdentity: string;
}>;

export class ReferencePictureTimeMapFrameEvidenceError extends Error {
  readonly code = "CUT_EDIT_PICTURE_TIME_EVIDENCE" as const;

  constructor(readonly detail: string) {
    super(`CUT_EDIT_PICTURE_TIME_EVIDENCE: ${detail}`);
    this.name = "ReferencePictureTimeMapFrameEvidenceError";
  }
}

export class ReferencePictureTimeMapError extends Error {
  readonly code = "CUT_EDIT_PICTURE_TIME_MAP" as const;
  readonly source: { module: string; line: number; column: number; nodeId: string };

  constructor(readonly nodeId: string, node: IRNode, readonly detail: string) {
    super(`CUT_EDIT_PICTURE_TIME_MAP: ${detail} at ${node.provenance.module}:${node.provenance.span.start.line}:${node.provenance.span.start.column}.`);
    this.name = "ReferencePictureTimeMapError";
    this.source = {
      module: node.provenance.module,
      line: node.provenance.span.start.line,
      column: node.provenance.span.start.column,
      nodeId,
    };
  }
}

function fail(node: IRNode, message: string): never {
  throw new ReferencePictureTimeMapError(node.id, node, message);
}

function canonicalRational(node: IRNode, value: unknown, label: string) {
  if (!value || typeof value !== "object") fail(node, `${label} must carry a canonical exact rational`);
  const candidate = value as { numerator?: unknown; denominator?: unknown };
  if (
    typeof candidate.numerator !== "string"
    || typeof candidate.denominator !== "string"
    || !/^-?(?:0|[1-9]\d*)$/.test(candidate.numerator)
    || !/^[1-9]\d*$/.test(candidate.denominator)
    || candidate.numerator.length > 256
    || candidate.denominator.length > 256
  ) fail(node, `${label} must carry a canonical exact rational`);
  try {
    const exact = rational(candidate.numerator, candidate.denominator);
    if (exact.numerator !== candidate.numerator || exact.denominator !== candidate.denominator) throw new Error("non-canonical");
    return exact;
  } catch {
    fail(node, `${label} must carry a canonical exact rational`);
  }
}

function safeInteger(node: IRNode, value: Rational, label: string) {
  if (value.denominator !== "1") fail(node, `${label} must be an exact integer`);
  const integer = BigInt(value.numerator);
  if (integer < 0n || integer > BigInt(Number.MAX_SAFE_INTEGER)) fail(node, `${label} exceeds the safe executable integer range`);
  return Number(integer);
}

function selectedPicture(ir: CutAVIR, node: IRNode) {
  const source = node.inputs.source;
  if (source?.kind !== "resource-ref") fail(node, "PictureClip source must reference a locked VideoAsset");
  const resource = ir.resources[source.id];
  if (!resource || resource.kind !== "video") fail(node, `PictureClip source must reference a video resource; received ${resource?.kind ?? "missing resource"}`);
  const probe = resource.metadata?.probe as LockedResourceProbe | undefined;
  const selected = probe?.kind === "media" ? probe.selected.video : undefined;
  if (!selected || !Number.isSafeInteger(selected.streamIndex) || selected.streamIndex < 0) fail(node, "PictureClip source has no valid lock-selected video stream");
  if (!selected.decodedVideoCadence) fail(node, "PictureClip requires a locked decoded-video-cadence witness; variable or unproved frame cadence cannot drive deterministic frame-index time mapping");
  const stream = probe?.kind === "media"
    ? probe.identity.streams.find((candidate) => candidate.index === selected.streamIndex && candidate.type === "video")
    : undefined;
  if (!stream) fail(node, `PictureClip lock-selected stream ${selected.streamIndex} is not a video stream`);
  const duration = canonicalRational(node, selected.duration, "PictureClip selected video duration");
  const durationSource = selected.durationSource === "stream" || selected.durationSource === "decoded-video-cadence" ? selected.durationSource : undefined;
  if (!durationSource) fail(node, "PictureClip selected video duration authority is invalid");
  const timeBase = canonicalRational(node, selected.timeBase, "PictureClip selected video time base");
  const streamTimeBase = canonicalRational(node, stream.timeBase, "PictureClip selected stream time base");
  const frameRate = canonicalRational(node, selected.frameRate ?? stream.frameRate, "PictureClip selected frame rate");
  if (stream.start === undefined) fail(node, "PictureClip selected video stream requires one exact non-negative start");
  const start = canonicalRational(node, stream.start, "PictureClip selected stream start");
  if (compareRational(duration, zeroRational) <= 0 || compareRational(timeBase, zeroRational) <= 0 || compareRational(frameRate, zeroRational) <= 0) {
    fail(node, "PictureClip selected duration, time base, and frame rate must be positive");
  }
  if (compareRational(timeBase, streamTimeBase) !== 0) fail(node, "PictureClip selected time base does not match its locked video stream");
  if (compareRational(start, zeroRational) < 0) fail(node, "PictureClip selected video stream requires one exact non-negative start");
  if (divideRational(start, timeBase).denominator !== "1") fail(node, "PictureClip selected video stream start must land on its exact codec time base");
  return { resourceId: source.id, streamIndex: selected.streamIndex, duration, durationSource, start, timeBase, frameRate };
}

function exactSourceBoundary(node: IRNode, value: Rational, selected: ReturnType<typeof selectedPicture>, label: string) {
  if (multiplyRational(value, selected.frameRate).denominator !== "1") {
    fail(node, `${label} does not land on the locked source stream's ${selected.frameRate.numerator}/${selected.frameRate.denominator} fps frame boundary`);
  }
}

function authoredHandle(node: IRNode, name: "headHandle" | "tailHandle") {
  const value = node.inputs[name];
  if (value === undefined) return zeroRational;
  if (value.kind !== "quantity" || value.dimension !== "time" || value.unit !== "s") fail(node, `PictureClip ${name} must be a canonical exact Time value`);
  const exact = canonicalRational(node, value.magnitude, `PictureClip ${name}`);
  if (compareRational(exact, zeroRational) < 0) fail(node, `PictureClip ${name} cannot be negative`);
  return exact;
}

function consumedHandles(ir: CutAVIR, node: IRNode) {
  let head = zeroRational, tail = zeroRational, headUses = 0, tailUses = 0;
  for (const track of Object.values(ir.nodes)) {
    if (track.editorial?.kind !== "picture-track") continue;
    for (const transition of track.editorial.transitions ?? []) {
      if (transition.incomingNodeId === node.id) { head = transition.incomingSource.duration; headUses += 1; }
      if (transition.outgoingNodeId === node.id) { tail = transition.outgoingSource.duration; tailUses += 1; }
    }
  }
  if (headUses > 1 || tailUses > 1) fail(node, "PictureClip cannot supply the same source-handle side to multiple PictureTrack transitions");
  return { head, tail };
}

/**
 * Close PictureClip source selection, exact time mapping, frame-grid and bounded
 * reverse-buffer semantics before the reference backend starts decoding.
 */
export function referencePictureTimeMapConfig(ir: CutAVIR, composition: IRComposition, node: IRNode): ReferencePictureTimeMapConfig | undefined {
  if (node.op !== "cut.edit.picture_clip") return undefined;
  let map: IRPictureTimeMap;
  let sourceRange: ReturnType<typeof pictureTimeMapSourceRange>;
  try {
    map = authoredPictureTimeMap(node.inputs, node.interval.duration);
    sourceRange = pictureTimeMapSourceRange(node.inputs, (message) => { throw new PictureTimeMapInputError(message); });
  } catch (error) {
    if (!(error instanceof PictureTimeMapInputError)) throw error;
    fail(node, error.message);
  }
  const selected = selectedPicture(ir, node);
  if (compareRational(sourceRange.end, selected.duration) > 0) {
    fail(node, `PictureClip source range ends at ${sourceRange.end.numerator}/${sourceRange.end.denominator}s, beyond the selected source bound ${selected.duration.numerator}/${selected.duration.denominator}s`);
  }
  exactSourceBoundary(node, sourceRange.start, selected, "PictureClip source-range start");
  exactSourceBoundary(node, sourceRange.end, selected, "PictureClip source-range end");
  const declaredHead = authoredHandle(node, "headHandle"), declaredTail = authoredHandle(node, "tailHandle");
  const availableStart = subtractRational(sourceRange.start, declaredHead), availableEnd = addRational(sourceRange.end, declaredTail);
  if (compareRational(availableStart, zeroRational) < 0) fail(node, "PictureClip headHandle extends before source time zero");
  if (compareRational(availableEnd, selected.duration) > 0) fail(node, `PictureClip tailHandle extends beyond the selected source bound ${selected.duration.numerator}/${selected.duration.denominator}s`);
  exactSourceBoundary(node, availableStart, selected, "PictureClip available source start");
  exactSourceBoundary(node, availableEnd, selected, "PictureClip available source end");
  const consumed = consumedHandles(ir, node);
  if (compareRational(consumed.head, declaredHead) > 0 || compareRational(consumed.tail, declaredTail) > 0) fail(node, "PictureTrack transition consumes more source handle than this PictureClip declares available");
  const consumedStart = subtractRational(sourceRange.start, consumed.head), consumedEnd = addRational(sourceRange.end, consumed.tail);
  exactSourceBoundary(node, consumedStart, selected, "PictureClip consumed source start");
  exactSourceBoundary(node, consumedEnd, selected, "PictureClip consumed source end");
  const destinationFrames = safeInteger(node, multiplyRational(node.interval.duration, composition.fps), "PictureClip destination frame count");
  if (destinationFrames < 1) fail(node, "PictureClip destination must contain at least one frame");
  if (map.kind === "speed-ramp") {
    for (const [index, point] of map.points.entries()) {
      if (multiplyRational(point.at, composition.fps).denominator !== "1") {
        fail(node, `PictureClip speedRamp point ${index + 1} does not land on the ${composition.fps.numerator}/${composition.fps.denominator} fps destination frame grid`);
      }
    }
  }

  const sourceFrameDuration = divideRational(rational(1), selected.frameRate);
  let decodeStart = consumedStart;
  let decodeDuration = subtractRational(consumedEnd, consumedStart);
  let sourceFrameCount = safeInteger(node, multiplyRational(decodeDuration, selected.frameRate), "PictureClip source frame count");
  const reverseDecode = map.kind === "constant" && map.direction === "reverse";
  if (map.kind === "freeze") {
    exactSourceBoundary(node, map.at, selected, "PictureClip freezeAt");
    if (compareRational(map.at, sourceRange.start) < 0 || compareRational(map.at, sourceRange.end) >= 0) fail(node, "PictureClip freezeAt must select a frame inside its half-open source range");
    decodeStart = map.at;
    decodeDuration = sourceFrameDuration;
    sourceFrameCount = 1;
  }
  if (sourceFrameCount < 1) fail(node, "PictureClip source range must contain at least one locked source frame");
  if (reverseDecode) {
    if (sourceFrameCount > referencePictureTimeMapLimits.maximumReverseSourceFrames) {
      fail(node, `PictureClip reverse source exceeds the ${referencePictureTimeMapLimits.maximumReverseSourceFrames}-frame reference limit`);
    }
    const canvasBytes = BigInt(composition.width) * BigInt(composition.height) * 4n * BigInt(sourceFrameCount);
    if (canvasBytes > BigInt(referencePictureTimeMapLimits.maximumReverseCanvasBytes)) {
      fail(node, `PictureClip reverse canvas buffer exceeds the ${referencePictureTimeMapLimits.maximumReverseCanvasBytes}-byte reference limit`);
    }
  }
  const config = {
    kind: "picture-time-map" as const,
    resourceId: selected.resourceId,
    streamIndex: selected.streamIndex,
    map,
    sourceStart: sourceRange.start,
    sourceEnd: sourceRange.end,
    sourceDuration: sourceRange.duration,
    selectedDuration: selected.duration,
    selectedDurationSource: selected.durationSource,
    selectedStart: selected.start,
    selectedTimeBase: selected.timeBase,
    selectedFrameRate: selected.frameRate,
    destinationFrameRate: composition.fps,
    sourceFrameCount,
    decodeStart,
    decodeDuration,
    consumedHeadHandle: consumed.head,
    consumedTailHandle: consumed.tail,
    reverseDecode,
    ...(frameSelection(map) === "frame-blend"
      ? { frameBlendPolicyIdentity: referencePictureFrameBlendPolicyIdentity }
      : {}),
  };
  // Prove the last destination sample stays inside the planned source-frame
  // buffer before any backend command is constructed.
  referencePictureDecoderFrame(config, destinationFrames - 1);
  return Object.freeze(config);
}

function frameSelection(map: IRPictureTimeMap) {
  return map.frameSelection ?? "floor";
}

/**
 * Select one discrete source frame from an exact non-negative frame phase.
 *
 * `nearest` rounds only when the fractional part is strictly greater than one
 * half. Exact half ties stay on the preceding frame, so the policy is stable
 * without a host floating-point rounding mode. The final result is clamped to
 * the last frame inside the caller's half-open source authority.
 */
function selectedFrame(exactFrame: Rational, selection: "floor" | "nearest", maximumExclusive: bigint) {
  if (maximumExclusive < 1n) throw new Error("PictureClip frame-selection authority contains no source frame.");
  const numerator = BigInt(exactFrame.numerator), denominator = BigInt(exactFrame.denominator);
  if (numerator < 0n) throw new Error("PictureClip exact source-frame phase cannot be negative.");
  let frame = numerator / denominator;
  if (selection === "nearest") {
    const remainder = numerator % denominator;
    if (remainder * 2n > denominator) frame += 1n;
  }
  if (frame >= maximumExclusive) frame = maximumExclusive - 1n;
  if (frame > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("PictureClip mapped source frame exceeds the safe executable integer range.");
  return Number(frame);
}

function q16Phase(exactFrame: Rational) {
  const numerator = BigInt(exactFrame.numerator), denominator = BigInt(exactFrame.denominator);
  if (numerator < 0n || denominator < 1n) throw new Error("PictureClip exact source-frame phase must be non-negative.");
  const remainder = numerator % denominator;
  const units = BigInt(referencePictureFrameBlendPhaseUnits);
  return Number((2n * remainder * units + denominator) / (2n * denominator));
}

function decoderSample(
  config: ReferencePictureTimeMapConfig,
  exactFrame: Rational,
  maximumExclusive: bigint,
): ReferencePictureDecoderSample {
  if (maximumExclusive < 1n || maximumExclusive > BigInt(config.sourceFrameCount)) {
    throw new Error("PictureClip source authority lies outside its decoded frame plan.");
  }
  const selection = frameSelection(config.map);
  if (selection !== "frame-blend") {
    const frame = selectedFrame(exactFrame, selection, maximumExclusive);
    return Object.freeze({
      firstFrame: frame,
      secondFrame: frame,
      phaseQ16: 0,
      exactFrame,
      frameSelection: selection,
    });
  }
  if (config.frameBlendPolicyIdentity !== referencePictureFrameBlendPolicyIdentity) {
    throw new Error("PictureClip frame-blend policy identity does not match the executable reference contract.");
  }
  const numerator = BigInt(exactFrame.numerator), denominator = BigInt(exactFrame.denominator);
  if (numerator < 0n) throw new Error("PictureClip exact source-frame phase cannot be negative.");
  const firstExact = numerator / denominator;
  const last = maximumExclusive - 1n;
  const first = firstExact > last ? last : firstExact;
  const second = first >= last ? last : first + 1n;
  if (second > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("PictureClip mapped source frame exceeds the safe executable integer range.");
  }
  return Object.freeze({
    firstFrame: Number(first),
    secondFrame: Number(second),
    phaseQ16: first === second ? 0 : q16Phase(exactFrame),
    exactFrame,
    frameSelection: "frame-blend",
    frameBlendPolicyIdentity: referencePictureFrameBlendPolicyIdentity,
  });
}

/** Map a destination frame to one or two monotonic raw-decoder frames. */
export function referencePictureDecoderSample(config: ReferencePictureTimeMapConfig, destinationFrame: number) {
  if (!Number.isSafeInteger(destinationFrame) || destinationFrame < 0) throw new Error("PictureClip destination frame must be a non-negative safe integer.");
  if (config.map.kind === "freeze") {
    return decoderSample(config, zeroRational, 1n);
  }
  const destinationTime = divideRational(rational(destinationFrame), config.destinationFrameRate);
  const sourceTime = config.map.kind === "speed-ramp"
    ? pictureSpeedRampSourceOffset(config.map, destinationTime)
    : multiplyRational(destinationTime, config.map.rate);
  const exactFrame = multiplyRational(addRational(config.consumedHeadHandle ?? zeroRational, sourceTime), config.selectedFrameRate);
  const coreEnd = multiplyRational(
    addRational(config.consumedHeadHandle ?? zeroRational, config.sourceDuration),
    config.selectedFrameRate,
  );
  if (coreEnd.denominator !== "1") throw new Error("PictureClip core source authority does not end on an exact source frame.");
  const coreEndFrame = BigInt(coreEnd.numerator);
  if (coreEndFrame < 1n || coreEndFrame > BigInt(config.sourceFrameCount)) {
    throw new Error("PictureClip core source authority lies outside its decoded frame plan.");
  }
  const sample = decoderSample(config, exactFrame, coreEndFrame);
  if (sample.firstFrame < 0 || sample.secondFrame >= config.sourceFrameCount) {
    throw new Error(`PictureClip destination frame ${destinationFrame} maps outside its ${config.sourceFrameCount}-frame source plan.`);
  }
  return sample;
}

/** Compatibility scalar for discrete policies. Frame blend returns its first
 * source frame; execution must consume referencePictureDecoderSample instead. */
export function referencePictureDecoderFrame(config: ReferencePictureTimeMapConfig, destinationFrame: number) {
  return referencePictureDecoderSample(config, destinationFrame).firstFrame;
}

/** Map an absolute source timestamp inside the consumed decoder window. */
export function referencePictureDecoderSampleAtSourceTime(config: ReferencePictureTimeMapConfig, sourceTime: Rational) {
  const offset = subtractRational(sourceTime, config.decodeStart);
  if (compareRational(offset, zeroRational) < 0 || compareRational(offset, config.decodeDuration) >= 0) {
    throw new Error(`PictureClip source time ${sourceTime.numerator}/${sourceTime.denominator}s lies outside its consumed decoder window.`);
  }
  const exactFrame = multiplyRational(offset, config.selectedFrameRate);
  const sample = decoderSample(config, exactFrame, BigInt(config.sourceFrameCount));
  if (sample.firstFrame < 0 || sample.secondFrame >= config.sourceFrameCount) throw new Error("PictureClip source time maps outside its decoded frame plan.");
  return sample;
}

export function referencePictureDecoderFrameAtSourceTime(config: ReferencePictureTimeMapConfig, sourceTime: Rational) {
  return referencePictureDecoderSampleAtSourceTime(config, sourceTime).firstFrame;
}

function evidenceFailure(message: string): never {
  throw new ReferencePictureTimeMapFrameEvidenceError(message);
}

function nonEmptyIdentity(value: string, label: string) {
  if (typeof value !== "string" || !value.length || value.length > 512) {
    evidenceFailure(`${label} must be a non-empty string no longer than 512 characters.`);
  }
  return value;
}

function canonicalOutputFrame(value: string) {
  if (!/^(?:0|[1-9]\d*)$/.test(value) || value.length > 32) {
    evidenceFailure("outputFrame must be one bounded canonical non-negative integer string.");
  }
  return value;
}

function canonicalSha256(value: string, label: string) {
  if (!/^[a-f0-9]{64}$/.test(value)) evidenceFailure(`${label} must be one lowercase SHA-256 digest.`);
  return value;
}

function canonicalExecutionPath(
  value: readonly ReferencePictureTimeMapExecutionPathEntry[],
) {
  if (!Array.isArray(value) || value.length > 16) {
    evidenceFailure("executionPath exceeds the 16-level nested-composition limit.");
  }
  return Object.freeze(value.map((entry, index) => Object.freeze({
    compositionId: nonEmptyIdentity(entry.compositionId, `executionPath[${index}].compositionId`),
    instanceNodeId: nonEmptyIdentity(entry.instanceNodeId, `executionPath[${index}].instanceNodeId`),
    sourceCompositionId: nonEmptyIdentity(entry.sourceCompositionId, `executionPath[${index}].sourceCompositionId`),
  })));
}

function frameEvidenceBody(
  evidence: Omit<ReferencePictureTimeMapFrameEvidence, "executionIdentity">,
) {
  return evidence;
}

function evidenceIdentity(
  evidence: Omit<ReferencePictureTimeMapFrameEvidence, "executionIdentity">,
) {
  return hash(frameEvidenceBody(evidence));
}

function assertSelfConsistentEvidence(evidence: ReferencePictureTimeMapFrameEvidence) {
  const { executionIdentity, ...body } = evidence;
  canonicalSha256(executionIdentity, "executionIdentity");
  if (evidenceIdentity(body) !== executionIdentity) {
    evidenceFailure("executionIdentity does not match the exact typed-time frame receipt.");
  }
}

/** Exact identity of the immutable planner configuration used by frame
 * selection. Callers retain this identity at prepare time and compare it
 * before every decoder request, so a post-prepare map mutation cannot silently
 * become executable. */
export function referencePictureTimeMapConfigIdentity(
  config: ReferencePictureTimeMapConfig,
) {
  return hash({
    format: "cut-reference-picture-time-map-config",
    version: 1,
    config,
  });
}

function lockedSourceFrameTime(
  config: ReferencePictureTimeMapConfig,
  decoderFrame: number,
) {
  if (!Number.isSafeInteger(decoderFrame)
    || decoderFrame < 0
    || decoderFrame >= config.sourceFrameCount) {
    evidenceFailure("selected decoder frame lies outside the authenticated decode plan.");
  }
  const originalFrame = config.reverseDecode
    ? config.sourceFrameCount - 1 - decoderFrame
    : decoderFrame;
  return addRational(
    config.decodeStart,
    divideRational(rational(originalFrame), config.selectedFrameRate),
  );
}

function checkedDecodedOutput(
  width: number,
  height: number,
  rgbaSha256: string,
) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || width < 1 || height < 1) {
    evidenceFailure("decoded output dimensions must be positive safe integers.");
  }
  const rgbaBytes = width * height * 4;
  if (!Number.isSafeInteger(rgbaBytes) || rgbaBytes < 4) {
    evidenceFailure("decoded output RGBA byte count exceeds the safe executable range.");
  }
  return Object.freeze({
    width,
    height,
    rgbaBytes,
    rgbaSha256: canonicalSha256(rgbaSha256, "decodedOutput.rgbaSha256"),
  });
}

/**
 * Construct the closed per-frame execution receipt from the same exact
 * request that selects decoder bytes. This is deliberately separate from the
 * static decoder-plan receipt: it proves which typed map, source frames and
 * Q16 phase actually produced one decoded RGBA surface.
 */
export function referencePictureTimeMapFrameEvidence(input: Readonly<{
  compositionId: string;
  nodeId: string;
  outputFrame: string;
  executionPath?: readonly ReferencePictureTimeMapExecutionPathEntry[];
  config: ReferencePictureTimeMapConfig;
  request: ReferencePictureTimeMapFrameRequest;
  width: number;
  height: number;
  rgbaSha256: string;
}>): ReferencePictureTimeMapFrameEvidence {
  const request = input.request.kind === "destination-frame"
    ? Object.freeze({
        kind: "destination-frame" as const,
        destinationFrame: input.request.destinationFrame,
        destinationTime: divideRational(
          rational(input.request.destinationFrame),
          input.config.destinationFrameRate,
        ),
      })
    : Object.freeze({
        kind: "absolute-source-time" as const,
        sourceTime: input.request.sourceTime,
      });
  const selected = input.request.kind === "destination-frame"
    ? referencePictureDecoderSample(input.config, input.request.destinationFrame)
    : referencePictureDecoderSampleAtSourceTime(input.config, input.request.sourceTime);
  const sample = Object.freeze({
    exactDecoderFrame: selected.exactFrame,
    firstDecoderFrame: selected.firstFrame,
    secondDecoderFrame: selected.secondFrame,
    phaseQ16: selected.phaseQ16,
    frameSelection: selected.frameSelection,
    firstLockedSourceTime: lockedSourceFrameTime(input.config, selected.firstFrame),
    secondLockedSourceTime: lockedSourceFrameTime(input.config, selected.secondFrame),
    ...(selected.frameBlendPolicyIdentity
      ? { frameBlendPolicyIdentity: selected.frameBlendPolicyIdentity }
      : {}),
  });
  const body = Object.freeze({
    format: referencePictureTimeMapFrameEvidenceContract.format,
    version: referencePictureTimeMapFrameEvidenceContract.version,
    compositionId: nonEmptyIdentity(input.compositionId, "compositionId"),
    nodeId: nonEmptyIdentity(input.nodeId, "nodeId"),
    resourceId: nonEmptyIdentity(input.config.resourceId, "resourceId"),
    streamIndex: input.config.streamIndex,
    outputFrame: canonicalOutputFrame(input.outputFrame),
    executionPath: canonicalExecutionPath(input.executionPath ?? []),
    configIdentity: referencePictureTimeMapConfigIdentity(input.config),
    request,
    sample,
    decodedOutput: checkedDecodedOutput(
      input.width,
      input.height,
      input.rgbaSha256,
    ),
  });
  if (!Number.isSafeInteger(body.streamIndex) || body.streamIndex < 0) {
    evidenceFailure("streamIndex must be a non-negative safe integer.");
  }
  return Object.freeze({
    ...body,
    executionIdentity: evidenceIdentity(body),
  });
}

/** Recompute a serialized receipt from the authenticated planner input and
 * exact decoded bytes. Unknown fields, stale samples, policy substitutions,
 * path transplantation and output-hash edits all fail the exact comparison. */
export function validateReferencePictureTimeMapFrameEvidence(
  evidence: ReferencePictureTimeMapFrameEvidence,
  input: Parameters<typeof referencePictureTimeMapFrameEvidence>[0],
) {
  assertSelfConsistentEvidence(evidence);
  const expected = referencePictureTimeMapFrameEvidence(input);
  if (stableJsonStringify(evidence) !== stableJsonStringify(expected)) {
    evidenceFailure("serialized receipt does not match the authenticated typed-time execution.");
  }
  return evidence;
}

/** Prefix a successfully validated child-renderer receipt with one exact
 * Precomp/NestedSequence instance path. The child receipt remains immutable;
 * the parent identity is recomputed over the full path. */
export function prefixReferencePictureTimeMapFrameEvidence(
  evidence: ReferencePictureTimeMapFrameEvidence,
  prefix: ReferencePictureTimeMapExecutionPathEntry,
) {
  assertSelfConsistentEvidence(evidence);
  const { executionIdentity, ...prior } = evidence;
  void executionIdentity;
  const body = Object.freeze({
    ...prior,
    executionPath: canonicalExecutionPath([prefix, ...evidence.executionPath]),
  });
  return Object.freeze({
    ...body,
    executionIdentity: evidenceIdentity(body),
  });
}
