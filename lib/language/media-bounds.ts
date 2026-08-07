import type { CutAVIR, IRNode, IRValue } from "./ir";
import { addRational, compareRational, multiplyRational, rational, subtractRational, type Rational, zeroRational } from "./rational";
import { referenceVideoInputColorConfig, referenceVideoInputConfig } from "../runtime/reference/video-config";
import type { LockedVideoColorMetadata } from "../runtime/reference/color-management";
import type { IRPictureEditItem } from "./picture-edit-operations";
import type { AudioEditItem } from "./audio-edit-operations";
import type { CutDecodedVideoCadence } from "./video-cadence";
import type { CutDecodedAudioSamples } from "./audio-sample-witness";
import { linkedAvPresentationPlan } from "./media-presentation";

export type LockedSelectedMedia = {
  video?: { streamIndex: number; duration: Rational; durationSource?: "stream" | "decoded-video-cadence"; decodedVideoCadence?: CutDecodedVideoCadence; start?: Rational; timeBase: Rational; frameRate: Rational; width: number; height: number; color?: LockedVideoColorMetadata; variant?: "master" | "proxy" };
  audio?: { streamIndex: number; duration: Rational; durationSource?: "stream" | "decoded-audio-samples"; decodedAudioSamples?: CutDecodedAudioSamples; timeBase: Rational; sampleRate: number };
};

export class CutMediaBoundsError extends Error {
  readonly source: { module: string; line: number; column: number; nodeId: string };

  constructor(readonly code: "CUT_MEDIA_SOURCE_GRID" | "CUT_MEDIA_SOURCE_DURATION", readonly node: IRNode, message: string) {
    const { module, span } = node.provenance;
    super(`${code}: ${message} at ${module}:${span.start.line}:${span.start.column}.`);
    this.name = "CutMediaBoundsError";
    this.source = { module, line: span.start.line, column: span.start.column, nodeId: node.id };
  }
}

function location(node: IRNode) {
  return `${node.provenance.module}:${node.provenance.span.start.line}:${node.provenance.span.start.column}`;
}

function exactRational(value: Rational, label: string, node: IRNode) {
  if (!value || typeof value.numerator !== "string" || typeof value.denominator !== "string") {
    throw new Error(`${label} at ${location(node)} must carry a canonical exact rational.`);
  }
  try {
    const canonical = rational(value.numerator, value.denominator);
    if (canonical.numerator !== value.numerator || canonical.denominator !== value.denominator) {
      throw new Error("not canonical");
    }
    return canonical;
  } catch {
    throw new Error(`${label} at ${location(node)} must carry a canonical exact rational.`);
  }
}

function time(value: IRValue | undefined, label: string, node: IRNode) {
  if (value?.kind !== "quantity" || value.dimension !== "time") {
    throw new Error(`${label} at ${location(node)} must be an exact Time quantity.`);
  }
  return exactRational(value.magnitude, label, node);
}

function assertLinkedSourceGrid(node: IRNode, streams: LockedSelectedMedia, value: Rational, label: string) {
  const video = streams.video;
  if (!video) return;
  if (!video.frameRate || compareRational(video.frameRate, zeroRational) <= 0) {
    throw new CutMediaBoundsError("CUT_MEDIA_SOURCE_GRID", node, "selected picture stream has no positive exact frame rate");
  }
  if (multiplyRational(value, video.frameRate).denominator !== "1") {
    throw new CutMediaBoundsError("CUT_MEDIA_SOURCE_GRID", node, `${label} does not land on the selected picture stream's ${video.frameRate.numerator}/${video.frameRate.denominator} fps frame grid`);
  }
}

function selectedSource(node: IRNode, selected: ReadonlyMap<string, LockedSelectedMedia>, label: string) {
  const source = node.inputs.source;
  if (source?.kind !== "resource-ref") {
    throw new Error(`${label} source at ${location(node)} must reference locked media.`);
  }
  return selected.get(source.id);
}

function sourceRange(node: IRNode, label: string) {
  const range = node.inputs.range;
  if (range === undefined) return undefined;
  if (range.kind !== "range") {
    throw new Error(`${label} range at ${location(node)} must be an exact Range<Time>.`);
  }
  const start = time(range.start, `${label} source-range start`, node);
  const end = time(range.end, `${label} source-range end`, node);
  if (compareRational(start, zeroRational) < 0 || compareRational(end, start) <= 0) {
    throw new Error(`${label} source range at ${location(node)} must be positive and cannot begin before zero.`);
  }
  return { start, end };
}

function assertRangeWithin(node: IRNode, label: string, available: Rational, range: { start: Rational; end: Rational }) {
  const sourceBound = label === "Linked Clip" ? "picture" : "source";
  if (compareRational(range.end, available) > 0) {
    throw new Error(`${label} source range at ${location(node)} ends at ${range.end.numerator}/${range.end.denominator}s, beyond the selected ${sourceBound} bound ${available.numerator}/${available.denominator}s.`);
  }
  if (compareRational(range.start, available) >= 0) {
    throw new Error(`${label} source range at ${location(node)} begins outside the selected ${sourceBound} bound.`);
  }
}

function assertImplicitDurationWithin(node: IRNode, label: string, available: Rational, sourceLabel: string) {
  const duration = exactRational(node.interval.duration, `${label} duration`, node);
  if (compareRational(duration, zeroRational) <= 0) {
    throw new Error(`${label} duration at ${location(node)} must be positive.`);
  }
  if (compareRational(duration, available) > 0) {
    const verb = sourceLabel.endsWith("streams") ? "provide" : "provides";
    throw new Error(`${label} at ${location(node)} needs ${duration.numerator}/${duration.denominator}s, but selected ${sourceLabel} ${verb} only ${available.numerator}/${available.denominator}s.`);
  }
}

function assertAudioSourceBounds(node: IRNode, selected: ReadonlyMap<string, LockedSelectedMedia>, label: string) {
  const streams = selectedSource(node, selected, label);
  if (!streams?.audio) {
    throw new CutMediaBoundsError("CUT_MEDIA_SOURCE_DURATION", node, `${label} source has no exact lock-selected audio duration`);
  }
  const range = sourceRange(node, label);
  if (range) {
    assertRangeWithin(node, label, streams.audio.duration, range);
    const handle = (name: "headHandle" | "tailHandle") => {
      const input = node.inputs[name];
      if (input === undefined) return zeroRational;
      const result = time(input, `${label} ${name}`, node);
      if (compareRational(result, zeroRational) < 0) throw new Error(`${label} ${name} at ${location(node)} cannot be negative.`);
      return result;
    };
    const headHandle = handle("headHandle"), tailHandle = handle("tailHandle");
    const available = { start: subtractRational(range.start, headHandle), end: addRational(range.end, tailHandle) };
    if (compareRational(available.start, zeroRational) < 0) throw new Error(`${label} headHandle at ${location(node)} extends before source time zero.`);
    assertRangeWithin(node, `${label} available media`, streams.audio.duration, available);
    for (const [boundary, value, amount] of [
      ["available source start", available.start, headHandle],
      ["available source end", available.end, tailHandle],
    ] as const) {
      if (compareRational(amount, zeroRational) === 0) continue;
      if (multiplyRational(value, rational(streams.audio.sampleRate)).denominator !== "1") {
        throw new CutMediaBoundsError("CUT_MEDIA_SOURCE_GRID", node, `${boundary} does not land on the selected audio stream's ${streams.audio.sampleRate} Hz sample grid`);
      }
    }
  }
  else assertImplicitDurationWithin(node, label, streams.audio.duration, "audio stream");
}

function assertVideoSourceBounds(ir: CutAVIR, node: IRNode, selected: ReadonlyMap<string, LockedSelectedMedia>) {
  const streams = selectedSource(node, selected, "Video");
  if (!streams?.video) throw new Error(`Video source at ${location(node)} has no selected video stream in cut.lock.`);
  // This is the same closed input evaluator used by reference preflight and
  // decoding. Locking supplies its already-validated selection explicitly;
  // embedded resource metadata does not exist until after this gate passes.
  referenceVideoInputConfig(ir, node, streams.video);
}

function assertAnalysisSourceBounds(node: IRNode, selected: ReadonlyMap<string, LockedSelectedMedia>) {
  const label = node.op === "cut.data.waveform" ? "Waveform" : "Spectrogram";
  const streams = selectedSource(node, selected, label);
  if (!streams?.audio) {
    throw new CutMediaBoundsError("CUT_MEDIA_SOURCE_DURATION", node, `${label} source has no exact lock-selected audio duration`);
  }
  const range = sourceRange(node, label);
  if (range) assertRangeWithin(node, label, streams.audio.duration, range);
  const start = range?.start ?? zeroRational, end = range?.end ?? streams.audio.duration;
  for (const [boundary, value] of [["start", start], ["end", end]] as const) {
    if (multiplyRational(value, rational(streams.audio.sampleRate)).denominator !== "1") {
      throw new CutMediaBoundsError("CUT_MEDIA_SOURCE_GRID", node, `${label} source-range ${boundary} does not land on the selected audio stream's ${streams.audio.sampleRate} Hz sample grid`);
    }
  }
}

function assertLinkedClipBounds(ir: CutAVIR, node: IRNode, selected: ReadonlyMap<string, LockedSelectedMedia>, destinationSampleRate: number) {
  const label = "Linked Clip";
  const streams = selectedSource(node, selected, label);
  if (!streams?.video) {
    throw new Error(`Linked Clip source at ${location(node)} has no selected video stream in cut.lock.`);
  }
  if (!streams.audio) {
    throw new CutMediaBoundsError("CUT_MEDIA_SOURCE_DURATION", node, "Linked Clip source has no exact lock-selected source-audio duration; use Video for picture-only media or provide audio with an exact stream duration");
  }
  if (!streams.video.decodedVideoCadence) {
    throw new CutMediaBoundsError("CUT_MEDIA_SOURCE_GRID", node, "Linked Clip requires a decoded-video-cadence witness; unproved VFR picture cannot be trimmed with linked frame/sample semantics");
  }
  if (!streams.video.start || !streams.audio.decodedAudioSamples) {
    throw new CutMediaBoundsError("CUT_MEDIA_SOURCE_DURATION", node, "Linked Clip requires exact selected video-start and decoded-audio presentation witnesses");
  }
  referenceVideoInputColorConfig(ir, node, streams.video);
  const range = sourceRange(node, label);
  let pictureSourceStart = zeroRational;
  if (range) {
    assertRangeWithin(node, label, streams.video.duration, range);
    if (compareRational(subtractRational(range.end, range.start), node.interval.duration) < 0) {
      throw new CutMediaBoundsError("CUT_MEDIA_SOURCE_DURATION", node, "Linked Clip source range is shorter than its destination; implicit picture hold or time stretching is forbidden");
    }
    pictureSourceStart = range.start;
    assertLinkedSourceGrid(node, streams, range.start, "source-range start");
    assertLinkedSourceGrid(node, streams, range.end, "source-range end");
    assertLinkedSourceGrid(node, streams, addRational(range.start, node.interval.duration), "source playback end");
  } else {
    assertImplicitDurationWithin(node, label, streams.video.duration, "picture stream");
    assertLinkedSourceGrid(node, streams, zeroRational, "implicit source-range start");
    assertLinkedSourceGrid(node, streams, node.interval.duration, "implicit source-range end");
  }
  linkedAvPresentationPlan({
    node,
    variant: streams.video.variant ?? "master",
    videoAnchor: streams.video.start,
    audioWitness: streams.audio.decodedAudioSamples,
    audioDuration: streams.audio.duration,
    pictureSourceStart,
    pictureDuration: node.interval.duration,
    destinationSampleRate,
  });
}

function linkedClipComposition(ir: CutAVIR, node: IRNode) {
  if (node.sceneId) {
    const composition = ir.compositions.find((candidate) => candidate.sceneIds.includes(node.sceneId!));
    if (composition) return composition;
  }
  for (const composition of ir.compositions) {
    const pending = [
      ...composition.rootVisualIds,
      ...composition.rootAudioIds,
      ...composition.rootAVIds,
      ...composition.items.flatMap((item) => item.kind === "node" ? [item.id] : []),
    ];
    const visited = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (id === node.id) return composition;
      if (visited.has(id)) continue;
      visited.add(id);
      const current = ir.nodes[id];
      if (current) pending.push(...current.children);
    }
  }
  throw new CutMediaBoundsError("CUT_MEDIA_SOURCE_DURATION", node, "Linked Clip does not belong to one executable composition");
}

function assertPictureClipBounds(ir: CutAVIR, node: IRNode, selected: ReadonlyMap<string, LockedSelectedMedia>) {
  const label = "PictureClip";
  const streams = selectedSource(node, selected, label);
  if (!streams?.video) throw new Error(`PictureClip source at ${location(node)} has no selected video stream in cut.lock.`);
  if (!streams.video.decodedVideoCadence) throw new CutMediaBoundsError("CUT_MEDIA_SOURCE_GRID", node, "PictureClip requires a decoded-video-cadence witness for deterministic source-frame mapping");
  referenceVideoInputColorConfig(ir, node, streams.video);
  const range = sourceRange(node, label);
  if (!range) throw new Error(`PictureClip range at ${location(node)} must be an explicit exact Range<Time>.`);
  assertRangeWithin(node, label, streams.video.duration, range);
  const handle = (name: "headHandle" | "tailHandle") => {
    const input = node.inputs[name];
    if (input === undefined) return zeroRational;
    const result = time(input, `PictureClip ${name}`, node);
    if (compareRational(result, zeroRational) < 0) throw new Error(`PictureClip ${name} at ${location(node)} cannot be negative.`);
    return result;
  };
  const headHandle = handle("headHandle"), tailHandle = handle("tailHandle");
  const available = { start: subtractRational(range.start, headHandle), end: addRational(range.end, tailHandle) };
  if (compareRational(available.start, zeroRational) < 0) throw new Error(`PictureClip headHandle at ${location(node)} extends before source time zero.`);
  assertRangeWithin(node, "PictureClip available media", streams.video.duration, available);
  if (compareRational(headHandle, zeroRational) === 0 && compareRational(tailHandle, zeroRational) === 0) return;
  const video = streams.video;
  if (!video.frameRate || compareRational(video.frameRate, zeroRational) <= 0) {
    throw new CutMediaBoundsError("CUT_MEDIA_SOURCE_GRID", node, "selected PictureClip stream has no positive exact frame rate");
  }
  const extendedBoundaries: Array<readonly [string, Rational]> = [];
  if (compareRational(headHandle, zeroRational) > 0) extendedBoundaries.push(["available source start", available.start]);
  if (compareRational(tailHandle, zeroRational) > 0) extendedBoundaries.push(["available source end", available.end]);
  for (const [boundary, value] of extendedBoundaries) {
    if (multiplyRational(value, video.frameRate).denominator !== "1") {
      throw new CutMediaBoundsError("CUT_MEDIA_SOURCE_GRID", node, `${boundary} does not land on the selected picture stream's ${video.frameRate.numerator}/${video.frameRate.denominator} fps frame grid`);
    }
  }
}

function operationPlanItemNode(track: IRNode, item: IRPictureEditItem, index: number): IRNode {
  return {
    id: `${track.id}_operation_source_${index}`,
    op: item.kind === "picture" ? "cut.edit.picture_clip" : "cut.edit.gap",
    domain: "visual",
    ownership: "detached",
    ...(track.sceneId ? { sceneId: track.sceneId } : {}),
    interval: item.destination,
    inputs: item.inputs,
    children: [],
    properties: {},
    effects: ["pure"],
    contentHash: "0".repeat(64),
    provenance: item.provenance,
  };
}

function audioOperationPlanItemNode(track: IRNode, item: Extract<AudioEditItem, { kind: "clip" }>, index: number): IRNode {
  const timeValue = (value: Rational): IRValue => ({ kind: "quantity", dimension: "time", magnitude: value, unit: "s" });
  return {
    id: `${track.id}_audio_operation_source_${index}`,
    op: "cut.audio.clip",
    domain: "audio",
    ownership: "detached",
    ...(track.sceneId ? { sceneId: track.sceneId } : {}),
    interval: item.destination,
    inputs: {
      source: { kind: "resource-ref", id: item.inputs.resourceId },
      range: { kind: "range", start: timeValue(item.source.start), end: timeValue(addRational(item.source.start, item.source.duration)), exclusive: true },
      ...(item.inputs.headHandle ? { headHandle: timeValue(item.inputs.headHandle) } : {}),
      ...(item.inputs.tailHandle ? { tailHandle: timeValue(item.inputs.tailHandle) } : {}),
    },
    children: [],
    properties: {},
    effects: ["pure"],
    contentHash: "0".repeat(64),
    provenance: item.provenance,
  };
}

/**
 * Validate every executable source range against the media streams selected
 * and frozen by cut.lock. This runs before semantic determinism is declared
 * and again immediately before reference rendering.
 */
export function assertLockedMediaSourceBounds(ir: CutAVIR, selected: ReadonlyMap<string, LockedSelectedMedia>) {
  for (const node of Object.values(ir.nodes)) {
    if (node.op === "cut.edit.clip") assertLinkedClipBounds(ir, node, selected, linkedClipComposition(ir, node).sampleRate);
    else if (node.op === "cut.edit.picture_clip") assertPictureClipBounds(ir, node, selected);
    else if (node.op === "cut.audio.clip") assertAudioSourceBounds(node, selected, "Audio Clip");
    else if (node.op === "cut.documentary.narration") assertAudioSourceBounds(node, selected, "Narration");
    else if (node.op === "cut.visual.video") assertVideoSourceBounds(ir, node, selected);
    else if (node.op === "cut.data.waveform" || node.op === "cut.data.spectrogram") assertAnalysisSourceBounds(node, selected);
    if (node.editorial?.kind === "picture-track" && node.editorial.operationPlan) {
      const planItems = [
        ...node.editorial.operationPlan.baseItems,
        ...node.editorial.operationPlan.operations.flatMap((operation) => "item" in operation ? [operation.item] : []),
      ];
      planItems.forEach((item, index) => { if (item.kind === "picture") assertPictureClipBounds(ir, operationPlanItemNode(node, item, index), selected); });
    }
    if (node.editorial?.kind === "audio-track" && node.editorial.operationPlan) {
      const planItems = [
        ...node.editorial.operationPlan.baseItems,
        ...node.editorial.operationPlan.operations.flatMap((operation) => "item" in operation ? [operation.item] : []),
      ];
      planItems.forEach((item, index) => { if (item.kind === "clip") assertAudioSourceBounds(audioOperationPlanItemNode(node, item, index), selected, "Audio Clip"); });
    }
  }
}

/** @deprecated Prefer assertLockedMediaSourceBounds for all source kernels. */
export const assertLinkedClipSourceBounds = assertLockedMediaSourceBounds;
