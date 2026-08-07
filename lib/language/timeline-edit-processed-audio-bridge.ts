import { hash } from "../core/stable";
import {
  stageProcessedAudioTimelineEditV1,
  validateProcessedAudioTimelinePlanV1,
  type ProcessedAudioGraphAuthorityV1,
  type ProcessedAudioGraphEvaluationReceiptV1,
  type ProcessedAudioPresentationLaw,
  type ProcessedAudioTimelinePlanV1,
  type ProcessedAudioTimelineStageV1,
} from "./processed-audio-timeline-edit";
import {
  executeTimelineEditPlan,
  type TimelineEditExecutionV1,
  type TimelineEditItemV1,
  type TimelineEditOperationV1,
  type TimelineEditPlanV1,
  type TimelineEditSourceView,
  type TimelineEditTrackV1,
} from "./timeline-edit-operations";
import { compareRational, type Rational } from "./rational";

export const timelineEditProcessedAudioBridgeLimits = Object.freeze({
  maximumBindings: 64,
  maximumProcessedTracks: 64,
  maximumCorrelations: 4_096,
});

export type TimelineEditProcessedAudioBindingContentV1 = Readonly<{
  version: 1;
  timelineAuthorityId: string;
  graphAuthorityId: string;
  regionId: string;
  sourceNodeId: string;
  processorNodeIds: readonly string[];
  processedAuthorityIdentity: string;
}>;

export type TimelineEditProcessedAudioAuthorityBindingV1 =
  TimelineEditProcessedAudioBindingContentV1
  & Readonly<{
    bindingIdentity: string;
    authority: ProcessedAudioGraphAuthorityV1;
  }>;

export type TimelineEditProcessedAudioSegmentCorrelationV1 = Readonly<{
  trackId: string;
  originId: string;
  segmentId: string;
  processedItemId: string;
  authorityIdentity: string;
  source: Readonly<{ start: number; end: number }>;
  destination: Readonly<{ start: number; end: number }>;
  presentationOffsetSamples: number;
  fadeAuthorityIdentity: string;
}>;

export type TimelineEditProcessedAudioTransitionCorrelationV1 = Readonly<{
  operationId: string;
  trackId: string;
  outgoingSegmentId: string;
  incomingSegmentId: string;
  outgoingProcessedItemId: string;
  incomingProcessedItemId: string;
  pictureCutSample?: number;
  audioCutSample: number;
  pictureDurationSamples?: number;
  audioDurationSamples: number;
  outgoingSource: Readonly<{ start: number; end: number }>;
  incomingSource: Readonly<{ start: number; end: number }>;
  curve: "linear" | "equal-power";
}>;

export type TimelineEditProcessedAudioTrackStageV1 = Readonly<{
  trackId: string;
  timelineTrackMaterializationIdentity: string;
  processedStage: ProcessedAudioTimelineStageV1;
  segments: readonly TimelineEditProcessedAudioSegmentCorrelationV1[];
}>;

export type TimelineEditProcessedAudioBridgeStageV1 = Readonly<{
  version: 1;
  timelinePlanId: string;
  timelineMaterializationId: string;
  bridgeIdentity: string;
  sampleRate: number;
  tracks: readonly TimelineEditProcessedAudioTrackStageV1[];
  transitions: readonly TimelineEditProcessedAudioTransitionCorrelationV1[];
  graphEvaluations: readonly Readonly<{
    authorityIdentity: string;
    pcmIdentity: string;
    count: 1;
  }>[];
}>;

export type TimelineEditProcessedAudioBridgeErrorCode =
  | "CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_SHAPE"
  | "CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_GRID"
  | "CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_AUTHORITY"
  | "CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_CORRELATION"
  | "CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_UNSUPPORTED"
  | "CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_LIMIT";

export class TimelineEditProcessedAudioBridgeError extends Error {
  constructor(
    readonly code: TimelineEditProcessedAudioBridgeErrorCode,
    readonly path: string,
    message: string,
  ) {
    super(`${code} at ${path}: ${message}`);
    this.name = "TimelineEditProcessedAudioBridgeError";
  }
}

type UnknownRecord = Record<string, unknown>;

function fail(
  code: TimelineEditProcessedAudioBridgeErrorCode,
  path: string,
  message: string,
): never {
  throw new TimelineEditProcessedAudioBridgeError(code, path, message);
}

function ownRecord(value: unknown, path: string): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_SHAPE", path, "must be an object.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_SHAPE", path, "must have an ordinary or null prototype.");
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") fail("CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_SHAPE", path, "symbol keys are not accepted.");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      fail("CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_SHAPE", `${path}.${key}`, "accessor properties are not accepted.");
    }
  }
  return value as UnknownRecord;
}

function closed(value: unknown, path: string, required: readonly string[]): UnknownRecord {
  const object = ownRecord(value, path);
  const allowed = new Set(required);
  for (const key of required) {
    if (!Object.hasOwn(object, key)) fail("CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_SHAPE", path, `is missing ${JSON.stringify(key)}.`);
  }
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) fail("CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_SHAPE", `${path}.${key}`, "is not part of the closed v1 binding.");
  }
  return object;
}

function safeText(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.length || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_SHAPE", path, "must be one non-empty bounded identifier.");
  }
  if (Buffer.byteLength(value, "utf8") > 4_096) fail("CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_LIMIT", path, "exceeds 4096 UTF-8 bytes.");
  return value;
}

function sha256(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    fail("CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_SHAPE", path, "must be one lowercase SHA-256 value.");
  }
  return value;
}

function denseTextArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 256) {
    fail("CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_SHAPE", path, "must contain 1 through 256 processor node identifiers.");
  }
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) {
      fail("CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_SHAPE", `${path}[${index}]`, "must be one dense data entry.");
    }
    result.push(safeText(descriptor.value, `${path}[${index}]`));
  }
  if (new Set(result).size !== result.length) fail("CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_SHAPE", path, "must not contain duplicates.");
  return result;
}

export function timelineEditProcessedAudioBindingIdentity(
  value: TimelineEditProcessedAudioBindingContentV1,
): string {
  return hash({
    contract: "cut-timeline-edit-processed-audio-binding-v1",
    version: 1,
    timelineAuthorityId: value.timelineAuthorityId,
    graphAuthorityId: value.graphAuthorityId,
    regionId: value.regionId,
    sourceNodeId: value.sourceNodeId,
    processorNodeIds: value.processorNodeIds,
    processedAuthorityIdentity: value.processedAuthorityIdentity,
  });
}

function validateBinding(value: unknown, path: string): TimelineEditProcessedAudioAuthorityBindingV1 {
  const object = closed(value, path, [
    "version",
    "timelineAuthorityId",
    "graphAuthorityId",
    "regionId",
    "sourceNodeId",
    "processorNodeIds",
    "processedAuthorityIdentity",
    "bindingIdentity",
    "authority",
  ]);
  if (object.version !== 1) fail("CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_SHAPE", `${path}.version`, "must equal 1.");
  const authority = ownRecord(object.authority, `${path}.authority`) as unknown as ProcessedAudioGraphAuthorityV1;
  const content: TimelineEditProcessedAudioBindingContentV1 = {
    version: 1,
    timelineAuthorityId: safeText(object.timelineAuthorityId, `${path}.timelineAuthorityId`),
    graphAuthorityId: safeText(object.graphAuthorityId, `${path}.graphAuthorityId`),
    regionId: safeText(object.regionId, `${path}.regionId`),
    sourceNodeId: safeText(object.sourceNodeId, `${path}.sourceNodeId`),
    processorNodeIds: Object.freeze(denseTextArray(object.processorNodeIds, `${path}.processorNodeIds`)),
    processedAuthorityIdentity: sha256(object.processedAuthorityIdentity, `${path}.processedAuthorityIdentity`),
  };
  const bindingIdentity = sha256(object.bindingIdentity, `${path}.bindingIdentity`);
  if (authority.authorityIdentity !== content.processedAuthorityIdentity) {
    fail("CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_AUTHORITY", `${path}.authority`, "does not carry processedAuthorityIdentity.");
  }
  if (timelineEditProcessedAudioBindingIdentity(content) !== bindingIdentity) {
    fail("CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_AUTHORITY", `${path}.bindingIdentity`, "does not authenticate the TimelineEdit-to-graph binding.");
  }
  return Object.freeze({ ...content, bindingIdentity, authority });
}

function exactSamples(value: Rational, sampleRate: number, path: string): number {
  let numerator: bigint;
  let denominator: bigint;
  try {
    numerator = BigInt(value.numerator) * BigInt(sampleRate);
    denominator = BigInt(value.denominator);
  } catch {
    fail("CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_GRID", path, "is not one exact rational time.");
  }
  if (denominator <= 0n || numerator % denominator !== 0n) {
    fail("CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_GRID", path, `does not land on the ${sampleRate} Hz sample grid.`);
  }
  const result = numerator / denominator;
  if (result < 0n || result > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail("CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_GRID", path, "falls outside the safe non-negative sample clock.");
  }
  return Number(result);
}

function sampleInterval(
  value: { start: Rational; duration: Rational },
  sampleRate: number,
  path: string,
): Readonly<{ start: number; end: number }> {
  const start = exactSamples(value.start, sampleRate, `${path}.start`);
  const length = exactSamples(value.duration, sampleRate, `${path}.duration`);
  if (length <= 0 || start + length > Number.MAX_SAFE_INTEGER) {
    fail("CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_GRID", path, "must be one positive safe sample interval.");
  }
  return Object.freeze({ start, end: start + length });
}

function sameRational(left: Rational, right: Rational): boolean {
  return compareRational(left, right) === 0;
}

type OriginAuthority = Readonly<{
  trackId: string;
  originId: string;
  binding: TimelineEditProcessedAudioAuthorityBindingV1;
  originDurationSamples: number;
  originalSource: Readonly<{ start: number; end: number }>;
  availableSource: Readonly<{ start: number; end: number }>;
  fadeInSamples: number;
  fadeOutSamples: number;
  fadeAuthorityIdentity: string;
}>;

function processedView(
  item: TimelineEditItemV1,
  path: string,
): Extract<TimelineEditSourceView, { kind: "processed-audio" }> {
  if (item.sourceView.kind !== "processed-audio") {
    fail("CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_UNSUPPORTED", path, "must remain a processed-audio view; direct audio cannot be flattened into this bridge.");
  }
  return item.sourceView;
}

function assertViewBinding(
  view: Extract<TimelineEditSourceView, { kind: "processed-audio" }>,
  binding: TimelineEditProcessedAudioAuthorityBindingV1,
  path: string,
): void {
  if (view.authorityId !== binding.timelineAuthorityId
    || view.graphAuthorityId !== binding.graphAuthorityId
    || view.regionId !== binding.regionId
    || view.sourceNodeId !== binding.sourceNodeId
    || view.processorNodeIds.length !== binding.processorNodeIds.length
    || view.processorNodeIds.some((id, index) => id !== binding.processorNodeIds[index])) {
    fail("CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_AUTHORITY", path, "does not match its authenticated graph binding.");
  }
  if (view.statePolicy !== "single-authorized-evaluation") {
    fail("CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_AUTHORITY", `${path}.statePolicy`, "must require one authorized graph evaluation.");
  }
  if (!sameRational(view.rate, { numerator: "1", denominator: "1" })) {
    fail("CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_UNSUPPORTED", `${path}.rate`, "retimed processed audio is not closed by the identity-clock bridge.");
  }
  if (view.presentationClock.fadePolicy !== "origin-relative") {
    fail("CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_AUTHORITY", `${path}.presentationClock.fadePolicy`, "must be origin-relative.");
  }
}

function bindingKey(view: Extract<TimelineEditSourceView, { kind: "processed-audio" }>): string {
  return `${view.graphAuthorityId}\u0000${view.regionId}\u0000${view.sourceNodeId}`;
}

function fadePresentation(
  origin: OriginAuthority,
  destination: Readonly<{ start: number; end: number }>,
  presentationOffsetSamples: number,
  path: string,
): ProcessedAudioPresentationLaw {
  const originBase = destination.start - presentationOffsetSamples;
  const candidate = {
    fadeIn: origin.fadeInSamples > 0
      ? { kind: "linear" as const, interval: { start: originBase, end: originBase + origin.fadeInSamples } }
      : undefined,
    fadeOut: origin.fadeOutSamples > 0
      ? {
          kind: "linear" as const,
          interval: {
            start: originBase + origin.originDurationSamples - origin.fadeOutSamples,
            end: originBase + origin.originDurationSamples,
          },
        }
      : undefined,
  };
  const visible = (fade: typeof candidate.fadeIn) => fade && fade.interval.start < destination.end && destination.start < fade.interval.end;
  for (const [name, fade] of [["fadeIn", candidate.fadeIn], ["fadeOut", candidate.fadeOut]] as const) {
    if (visible(fade) && fade!.interval.start < 0) {
      fail("CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_UNSUPPORTED", path, `${name} crosses sample zero and cannot be clipped without changing its origin-clock envelope.`);
    }
  }
  return Object.freeze({
    ...(visible(candidate.fadeIn) ? { fadeIn: Object.freeze(candidate.fadeIn!) } : {}),
    ...(visible(candidate.fadeOut) ? { fadeOut: Object.freeze(candidate.fadeOut!) } : {}),
  });
}

function transitionOperation(
  plan: TimelineEditPlanV1,
  operationId: string,
): Extract<TimelineEditOperationV1, { kind: "transition" }> {
  const operation = plan.operations.find((candidate) => candidate.id === operationId);
  if (!operation || operation.kind !== "transition") {
    fail("CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_CORRELATION", "$.operations", `cannot correlate terminal transition ${JSON.stringify(operationId)}.`);
  }
  return operation;
}

/**
 * TimelineEdit remains the only edit algebra. This bridge first executes that
 * canonical plan, then converts only its final authenticated processed-audio
 * presentation views into zero-operation sample-domain witness stages.
 */
export async function stageTimelineEditProcessedAudioBridgeV1(
  plan: TimelineEditPlanV1,
  sampleRate: number,
  rawBindings: readonly unknown[],
  evaluateGraph: (
    authority: ProcessedAudioGraphAuthorityV1,
  ) => Promise<ProcessedAudioGraphEvaluationReceiptV1> | ProcessedAudioGraphEvaluationReceiptV1,
): Promise<TimelineEditProcessedAudioBridgeStageV1> {
  if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) {
    fail("CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_GRID", "$.sampleRate", "must be one positive safe integer.");
  }
  if (!Array.isArray(rawBindings) || !rawBindings.length || rawBindings.length > timelineEditProcessedAudioBridgeLimits.maximumBindings) {
    fail("CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_LIMIT", "$.bindings", `must contain 1 through ${timelineEditProcessedAudioBridgeLimits.maximumBindings} bindings.`);
  }
  const bindings = rawBindings.map((value, index) => validateBinding(value, `$.bindings[${index}]`));
  const bindingIds = new Set<string>();
  const bindingByKey = new Map<string, TimelineEditProcessedAudioAuthorityBindingV1>();
  for (const [index, binding] of bindings.entries()) {
    if (bindingIds.has(binding.bindingIdentity)) fail("CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_AUTHORITY", `$.bindings[${index}]`, "duplicates a binding.");
    bindingIds.add(binding.bindingIdentity);
    if (binding.authority.sampleRate !== sampleRate) {
      fail("CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_GRID", `$.bindings[${index}].authority.sampleRate`, "must equal the canonical destination sample rate.");
    }
    const key = `${binding.graphAuthorityId}\u0000${binding.regionId}\u0000${binding.sourceNodeId}`;
    if (bindingByKey.has(key)) fail("CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_AUTHORITY", `$.bindings[${index}]`, "duplicates a TimelineEdit graph binding.");
    bindingByKey.set(key, binding);
  }

  const execution: TimelineEditExecutionV1 = executeTimelineEditPlan(plan);
  const inputProcessedTracks = plan.tracks.filter((track) => track.items.some((item) => item.sourceView.kind === "processed-audio"));
  if (!inputProcessedTracks.length || inputProcessedTracks.length > timelineEditProcessedAudioBridgeLimits.maximumProcessedTracks) {
    fail("CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_LIMIT", "$.tracks", "must contain a bounded processed-audio track.");
  }
  if (inputProcessedTracks.some((track) => track.domain !== "audio")) {
    fail("CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_UNSUPPORTED", "$.tracks", "processed-audio bridge accepts audio-domain tracks only.");
  }
  const processedTrackIds = new Set(inputProcessedTracks.map((track) => track.trackId));
  const origins = new Map<string, OriginAuthority>();
  for (const track of inputProcessedTracks) {
    for (const [itemIndex, item] of track.items.entries()) {
      if (item.sourceView.kind === "gap") continue;
      const view = processedView(item, `$.tracks.${track.trackId}.items[${itemIndex}]`);
      const binding = bindingByKey.get(bindingKey(view));
      if (!binding) fail("CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_AUTHORITY", `$.tracks.${track.trackId}.items[${itemIndex}]`, "has no authenticated graph binding.");
      assertViewBinding(view, binding, `$.tracks.${track.trackId}.items[${itemIndex}].sourceView`);
      const originalDestination = sampleInterval(item.destination, sampleRate, `$.tracks.${track.trackId}.items[${itemIndex}].destination`);
      const originDurationSamples = exactSamples(
        view.presentationClock.originDuration,
        sampleRate,
        `$.tracks.${track.trackId}.items[${itemIndex}].sourceView.presentationClock.originDuration`,
      );
      const initialSliceOffset = exactSamples(
        view.presentationClock.sliceOffset,
        sampleRate,
        `$.tracks.${track.trackId}.items[${itemIndex}].sourceView.presentationClock.sliceOffset`,
      );
      const originalSource = sampleInterval(view.source, sampleRate, `$.tracks.${track.trackId}.items[${itemIndex}].sourceView.source`);
      if (initialSliceOffset !== 0
        || originDurationSamples !== originalDestination.end - originalDestination.start
        || originalDestination.end - originalDestination.start !== originalSource.end - originalSource.start) {
        fail("CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_UNSUPPORTED", `$.tracks.${track.trackId}.items[${itemIndex}]`, "requires one identity source clock.");
      }
      const head = exactSamples(view.handles.head, sampleRate, `$.tracks.${track.trackId}.items[${itemIndex}].sourceView.handles.head`);
      const tail = exactSamples(view.handles.tail, sampleRate, `$.tracks.${track.trackId}.items[${itemIndex}].sourceView.handles.tail`);
      const availableSource = Object.freeze({ start: originalSource.start - head, end: originalSource.end + tail });
      if (availableSource.start < 0 || availableSource.end > binding.authority.sourceSampleCount) {
        fail("CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_GRID", `$.tracks.${track.trackId}.items[${itemIndex}].sourceView.handles`, "exceed authenticated source bounds.");
      }
      const fadeInSamples = exactSamples(view.fadeIn, sampleRate, `$.tracks.${track.trackId}.items[${itemIndex}].sourceView.fadeIn`);
      const fadeOutSamples = exactSamples(view.fadeOut, sampleRate, `$.tracks.${track.trackId}.items[${itemIndex}].sourceView.fadeOut`);
      if (fadeInSamples + fadeOutSamples > originDurationSamples) {
        fail("CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_GRID", `$.tracks.${track.trackId}.items[${itemIndex}].sourceView`, "fade intervals exceed the origin presentation.");
      }
      const origin: OriginAuthority = Object.freeze({
        trackId: track.trackId,
        originId: item.originId,
        binding,
        originDurationSamples,
        originalSource,
        availableSource,
        fadeInSamples,
        fadeOutSamples,
        fadeAuthorityIdentity: hash({
          contract: "cut-timeline-edit-origin-fade-authority-v1",
          trackId: track.trackId,
          originId: item.originId,
          bindingIdentity: binding.bindingIdentity,
          originDurationSamples,
          fadeInSamples,
          fadeOutSamples,
        }),
      });
      const key = `${track.trackId}\u0000${item.originId}`;
      if (origins.has(key)) fail("CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_CORRELATION", `$.tracks.${track.trackId}`, "reuses one processed originId.");
      origins.set(key, origin);
    }
  }
  const converted: Array<{
    track: TimelineEditTrackV1;
    plan: ProcessedAudioTimelinePlanV1;
    segments: TimelineEditProcessedAudioSegmentCorrelationV1[];
  }> = [];
  for (const track of execution.tracks.filter((candidate) => processedTrackIds.has(candidate.trackId))) {
    const segments: TimelineEditProcessedAudioSegmentCorrelationV1[] = [];
    const items: ProcessedAudioTimelinePlanV1["items"][number][] = [];
    for (const [itemIndex, item] of track.items.entries()) {
      const destination = sampleInterval(item.destination, sampleRate, `execution.tracks.${track.trackId}.items[${itemIndex}].destination`);
      if (item.sourceView.kind === "gap") {
        items.push(Object.freeze({
          kind: "gap",
          id: `timeline_gap_${hash({ trackId: track.trackId, segmentId: item.segmentId }).slice(0, 24)}`,
          destination,
        }));
        continue;
      }
      const view = processedView(item, `execution.tracks.${track.trackId}.items[${itemIndex}]`);
      const origin = origins.get(`${track.trackId}\u0000${item.originId}`);
      if (!origin) fail("CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_CORRELATION", `execution.tracks.${track.trackId}.items[${itemIndex}]`, "has no frozen origin authority.");
      assertViewBinding(view, origin.binding, `execution.tracks.${track.trackId}.items[${itemIndex}].sourceView`);
      const source = sampleInterval(view.source, sampleRate, `execution.tracks.${track.trackId}.items[${itemIndex}].sourceView.source`);
      if (!insideSamples(source, origin.availableSource)) {
        fail("CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_GRID", `execution.tracks.${track.trackId}.items[${itemIndex}].sourceView.source`, "exceeds origin handle authority.");
      }
      const presentationOffsetSamples = exactSamples(
        view.presentationClock.sliceOffset,
        sampleRate,
        `execution.tracks.${track.trackId}.items[${itemIndex}].sourceView.presentationClock.sliceOffset`,
      );
      const outputOriginDuration = exactSamples(
        view.presentationClock.originDuration,
        sampleRate,
        `execution.tracks.${track.trackId}.items[${itemIndex}].sourceView.presentationClock.originDuration`,
      );
      if (outputOriginDuration !== origin.originDurationSamples) {
        fail("CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_CORRELATION", `execution.tracks.${track.trackId}.items[${itemIndex}].sourceView.presentationClock`, "changes the authenticated origin duration.");
      }
      const presentation = fadePresentation(origin, destination, presentationOffsetSamples, `execution.tracks.${track.trackId}.items[${itemIndex}]`);
      const processedItemId = `timeline_processed_${hash({
        trackId: track.trackId,
        segmentId: item.segmentId,
        originId: item.originId,
      }).slice(0, 24)}`;
      items.push(Object.freeze({
        kind: "processed",
        id: processedItemId,
        authorityIdentity: origin.binding.authority.authorityIdentity,
        destination,
        source,
        availableSource: origin.availableSource,
        timeMap: Object.freeze({ kind: "identity" as const }),
        presentation,
        ...(item.linkId ? { linkId: item.linkId } : {}),
      }));
      segments.push(Object.freeze({
        trackId: track.trackId,
        originId: item.originId,
        segmentId: item.segmentId,
        processedItemId,
        authorityIdentity: origin.binding.authority.authorityIdentity,
        source,
        destination,
        presentationOffsetSamples,
        fadeAuthorityIdentity: origin.fadeAuthorityIdentity,
      }));
    }
    if (segments.length + items.filter((item) => item.kind === "gap").length !== items.length) {
      fail("CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_CORRELATION", `execution.tracks.${track.trackId}`, "did not correlate every final item.");
    }
    const authorities = [...new Map(
      segments.map((segment) => {
        const origin = origins.get(`${track.trackId}\u0000${segment.originId}`)!;
        return [segment.authorityIdentity, origin.binding.authority] as const;
      }),
    ).values()];
    const processedPlan: ProcessedAudioTimelinePlanV1 = {
      version: 1,
      durationSamples: exactSamples(track.duration, sampleRate, `execution.tracks.${track.trackId}.duration`),
      authorities,
      items,
      operations: [],
    };
    validateProcessedAudioTimelinePlanV1(processedPlan);
    converted.push({ track, plan: processedPlan, segments });
  }
  if (converted.reduce((sum, entry) => sum + entry.segments.length, 0) > timelineEditProcessedAudioBridgeLimits.maximumCorrelations) {
    fail("CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_LIMIT", "execution.tracks", "exceeds the segment-correlation budget.");
  }

  const evaluationCache = new Map<string, Promise<ProcessedAudioGraphEvaluationReceiptV1>>();
  const cachedEvaluation = (authority: ProcessedAudioGraphAuthorityV1) => {
    let pending = evaluationCache.get(authority.authorityIdentity);
    if (!pending) {
      pending = Promise.resolve(evaluateGraph(authority));
      evaluationCache.set(authority.authorityIdentity, pending);
    }
    return pending;
  };
  const trackStages: TimelineEditProcessedAudioTrackStageV1[] = [];
  for (const entry of converted) {
    const processedStage = await stageProcessedAudioTimelineEditV1(entry.plan, cachedEvaluation);
    trackStages.push(Object.freeze({
      trackId: entry.track.trackId,
      timelineTrackMaterializationIdentity: hash({
        contract: "cut-timeline-edit-track-materialization-v1",
        timelineMaterializationId: execution.materializationId,
        track: entry.track,
      }),
      processedStage,
      segments: Object.freeze(entry.segments),
    }));
  }
  const segmentByTrackAndId = new Map(trackStages.flatMap((track) =>
    track.segments.map((segment) => [`${track.trackId}\u0000${segment.segmentId}`, segment] as const)));
  const transitions = execution.transitions
    .filter((transition) => processedTrackIds.has(transition.trackId))
    .map((transition): TimelineEditProcessedAudioTransitionCorrelationV1 => {
      if (transition.domain !== "audio" || !transition.audio) {
        fail("CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_UNSUPPORTED", `execution.transitions.${transition.operationId}`, "processed-audio transition must remain audio-domain.");
      }
      const outgoing = segmentByTrackAndId.get(`${transition.trackId}\u0000${transition.outgoingSegmentId}`);
      const incoming = segmentByTrackAndId.get(`${transition.trackId}\u0000${transition.incomingSegmentId}`);
      if (!outgoing || !incoming) fail("CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_CORRELATION", `execution.transitions.${transition.operationId}`, "cannot correlate processed transition endpoints.");
      const operation = transitionOperation(plan, transition.operationId);
      if (!operation.at.audio || !operation.duration.audio) {
        fail("CUT_TIMELINE_PROCESSED_AUDIO_BRIDGE_GRID", `$.operations.${operation.id}`, "processed transition requires exact audio clock fields.");
      }
      return Object.freeze({
        operationId: transition.operationId,
        trackId: transition.trackId,
        outgoingSegmentId: transition.outgoingSegmentId,
        incomingSegmentId: transition.incomingSegmentId,
        outgoingProcessedItemId: outgoing.processedItemId,
        incomingProcessedItemId: incoming.processedItemId,
        ...(operation.at.picture ? { pictureCutSample: exactSamples(operation.at.picture, sampleRate, `$.operations.${operation.id}.at.picture`) } : {}),
        audioCutSample: exactSamples(operation.at.audio, sampleRate, `$.operations.${operation.id}.at.audio`),
        ...(operation.duration.picture ? { pictureDurationSamples: exactSamples(operation.duration.picture, sampleRate, `$.operations.${operation.id}.duration.picture`) } : {}),
        audioDurationSamples: exactSamples(operation.duration.audio, sampleRate, `$.operations.${operation.id}.duration.audio`),
        outgoingSource: sampleInterval(transition.outgoingSource, sampleRate, `execution.transitions.${transition.operationId}.outgoingSource`),
        incomingSource: sampleInterval(transition.incomingSource, sampleRate, `execution.transitions.${transition.operationId}.incomingSource`),
        curve: transition.audio.curve,
      });
    });
  const graphEvaluations = [...evaluationCache.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([authorityIdentity, pending]) => ({ authorityIdentity, pending }));
  const settledEvaluations = await Promise.all(graphEvaluations.map(async ({ authorityIdentity, pending }) => {
    const receipt = await pending;
    return Object.freeze({ authorityIdentity, pcmIdentity: receipt.pcmIdentity, count: 1 as const });
  }));
  const content = {
    contract: "cut-timeline-edit-processed-audio-bridge-stage-v1",
    timelinePlanId: plan.id,
    timelineMaterializationId: execution.materializationId,
    sampleRate,
    tracks: trackStages,
    transitions,
    graphEvaluations: settledEvaluations,
  };
  return Object.freeze({
    version: 1,
    timelinePlanId: plan.id,
    timelineMaterializationId: execution.materializationId,
    bridgeIdentity: hash(content),
    sampleRate,
    tracks: Object.freeze(trackStages),
    transitions: Object.freeze(transitions),
    graphEvaluations: Object.freeze(settledEvaluations),
  });
}

function insideSamples(
  inner: Readonly<{ start: number; end: number }>,
  outer: Readonly<{ start: number; end: number }>,
): boolean {
  return inner.start >= outer.start && inner.end <= outer.end;
}
