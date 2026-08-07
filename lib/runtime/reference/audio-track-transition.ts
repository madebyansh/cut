import { boundedDiagnosticString, stableJsonStringify } from "../../core/stable";
import type { AudioEditCrossfadeCurve, AudioEditRegionItem, AudioEditTrackTransition } from "../../language/audio-edit-operations";
import type { CutAVIR, IRComposition, IREditorialInterval, IRNode, IRProvenance } from "../../language/ir";
import type { LockedResourceProbe } from "../../language/lock";
import { addRational, compareRational, divideRational, multiplyRational, rational, subtractRational, type Rational, zeroRational } from "../../language/rational";
import { authorizeReferenceAudioRegion, authorizeReferenceAudioRegions, type ReferenceAudioRegionPlan } from "./audio-region";
import { referenceTimelineEditTrackOwnership } from "./timeline-edit";

export type ReferenceAudioTrackTransitionCode =
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

export class ReferenceAudioTrackTransitionError extends Error {
  readonly source: { module: string; line: number; column: number; nodeId: string };

  constructor(readonly code: ReferenceAudioTrackTransitionCode, readonly nodeId: string, message: string, provenance: IRProvenance) {
    super(`${code}: ${message} at ${provenance.module}:${provenance.span.start.line}:${provenance.span.start.column}.`);
    this.name = "ReferenceAudioTrackTransitionError";
    this.source = { module: provenance.module, line: provenance.span.start.line, column: provenance.span.start.column, nodeId };
  }
}

export type ReferenceAudioTrackEnvelope = {
  side: "incoming" | "outgoing";
  curve: AudioEditCrossfadeCurve;
  startSample: number;
  durationSamples: number;
};

type ReferenceAudioTrackItemRenderPlanBase = {
  nodeId: string;
  resourceId: string;
  streamIndex: number;
  sourceSampleRate: number;
  source: IREditorialInterval;
  destination: IREditorialInterval;
  destinationSamples: number;
  envelopes: ReferenceAudioTrackEnvelope[];
};

export type ReferenceAudioTrackItemRenderPlan = ReferenceAudioTrackItemRenderPlanBase & (
  | { kind: "clip" }
  | {
      kind: "region";
      sourceNodeId: string;
      processorNodeIds: readonly string[];
      authorizationHash: string;
    }
  | {
      kind: "timeline-view";
      originKind: "processed-audio";
      originNodeId: string;
      regionNodeId: string;
      sourceNodeId: string;
      processorNodeIds: readonly string[];
      authorizationHash: string;
      rate: Rational;
    }
  | {
      kind: "timeline-view";
      originKind: "direct-audio";
      originNodeId: string;
      sourceNodeId: string;
      rate: Rational;
    }
);

type AudioTrack = IRNode & { editorial: Extract<NonNullable<IRNode["editorial"]>, { kind: "audio-track" }> };

function fail(track: IRNode, code: ReferenceAudioTrackTransitionCode, message: string, provenance = track.provenance): never {
  throw new ReferenceAudioTrackTransitionError(code, track.id, message, provenance);
}

function end(interval: IREditorialInterval) { return addRational(interval.start, interval.duration); }
function same(left: Rational, right: Rational) { return compareRational(left, right) === 0; }
function sameInterval(left: IREditorialInterval, right: IREditorialInterval) { return same(left.start, right.start) && same(left.duration, right.duration); }

function exactSamples(
  track: IRNode,
  value: Rational,
  sampleRate: number,
  label: string,
  provenance: IRProvenance,
  code: ReferenceAudioTrackTransitionCode = "CUT_AUDIO_EDIT_TIME",
) {
  const exact = multiplyRational(value, rational(sampleRate));
  if (exact.denominator !== "1") fail(track, code, `${label} does not land on the ${sampleRate} Hz sample grid`, provenance);
  const result = Number(exact.numerator);
  if (!Number.isSafeInteger(result) || result < 0) fail(track, code === "CUT_AUDIO_EDIT_TIME" ? "CUT_AUDIO_EDIT_LIMIT" : code, `${label} has an unsafe sample count`, provenance);
  return result;
}

function timeInput(track: IRNode, node: IRNode, name: "headHandle" | "tailHandle", provenance: IRProvenance) {
  const value = node.inputs[name];
  if (value === undefined) return zeroRational;
  if (value.kind !== "quantity" || value.dimension !== "time" || value.unit !== "s") fail(track, "CUT_AUDIO_EDIT_SHAPE", `${node.id}.${name} must be an exact Time in seconds`, provenance);
  if (compareRational(value.magnitude, zeroRational) < 0) fail(track, "CUT_AUDIO_EDIT_TIME", `${node.id}.${name} cannot be negative`, provenance);
  return value.magnitude;
}

function exactTimelineTimeInput(
  track: IRNode,
  node: IRNode,
  name: "sliceOffset" | "originDuration" | "headHandle" | "tailHandle",
) {
  const value = node.inputs[name];
  if (value?.kind !== "quantity" || value.dimension !== "time" || value.unit !== "s") {
    fail(track, "CUT_AUDIO_REGION_CROSSFADE_PLAN", `${node.id}.${name} must be an exact Time in seconds`, node.provenance);
  }
  if (compareRational(value.magnitude, zeroRational) < 0
    || (name === "originDuration" && compareRational(value.magnitude, zeroRational) === 0)) {
    fail(track, "CUT_AUDIO_REGION_CROSSFADE_HANDLE", `${node.id}.${name} is outside its positive timeline-audio domain`, node.provenance);
  }
  return value.magnitude;
}

function exactTimelineRate(track: IRNode, node: IRNode) {
  const value = node.inputs.rate;
  if (value?.kind !== "quantity" || value.dimension !== "scalar"
    || compareRational(value.magnitude, zeroRational) <= 0) {
    fail(track, "CUT_AUDIO_REGION_CROSSFADE_PLAN", `${node.id}.rate must be one exact positive scalar`, node.provenance);
  }
  return value.magnitude;
}

function exactTimelineRange(
  track: IRNode,
  node: IRNode,
  name: "source" | "range" | "evaluationSource",
) {
  const value = node.inputs[name];
  if (value?.kind !== "range" || !value.exclusive
    || value.start.kind !== "quantity" || value.start.dimension !== "time" || value.start.unit !== "s"
    || value.end.kind !== "quantity" || value.end.dimension !== "time" || value.end.unit !== "s"
    || compareRational(value.end.magnitude, value.start.magnitude) <= 0) {
    fail(track, "CUT_AUDIO_REGION_CROSSFADE_PLAN", `${node.id}.${name} must be one positive exact half-open source-clock range`, node.provenance);
  }
  return {
    start: value.start.magnitude,
    duration: subtractRational(value.end.magnitude, value.start.magnitude),
  };
}

function exactTimelineSource(track: IRNode, node: IRNode) {
  return exactTimelineRange(track, node, "source");
}

function resourceSelection(
  ir: CutAVIR,
  track: IRNode,
  node: IRNode,
  provenance: IRProvenance,
  codes: Readonly<{ shape: ReferenceAudioTrackTransitionCode; unsupported: ReferenceAudioTrackTransitionCode }> = {
    shape: "CUT_AUDIO_EDIT_SHAPE",
    unsupported: "CUT_AUDIO_EDIT_UNSUPPORTED",
  },
) {
  const source = node.inputs.source;
  if (source?.kind !== "resource-ref" || ir.resources[source.id]?.kind !== "audio") fail(track, codes.shape, `${node.id} must reference an AudioAsset`, provenance);
  const probe = ir.resources[source.id].metadata?.probe as LockedResourceProbe | undefined;
  const selected = probe?.kind === "media" ? probe.selected.audio : undefined;
  const stream = probe?.kind === "media" && selected
    ? probe.identity.streams.find((candidate) => candidate.type === "audio" && candidate.index === selected.streamIndex)
    : undefined;
  if (!selected || !stream?.sampleRate || !Number.isSafeInteger(stream.sampleRate) || stream.sampleRate < 1) {
    fail(track, codes.unsupported, `${node.id} selected locked audio stream needs a positive exact sample rate`, provenance);
  }
  return { resourceId: source.id, streamIndex: selected.streamIndex, sampleRate: stream.sampleRate, duration: selected.duration };
}

function zeroLeafFade(track: IRNode, leaf: IRNode, name: "fadeIn" | "fadeOut", provenance: IRProvenance) {
  const value = leaf.inputs[name];
  if (value === undefined) return;
  if (value.kind !== "quantity" || value.dimension !== "time" || value.unit !== "s" || !same(value.magnitude, zeroRational)) {
    fail(track, "CUT_AUDIO_REGION_CROSSFADE_PLAN", `${leaf.id}.${name} must be exact zero because the processed transition envelope owns overlap gain`, provenance);
  }
}

function relativeInterval(track: IRNode, interval: IREditorialInterval) {
  return { start: subtractRational(interval.start, track.interval.start), duration: interval.duration };
}

function sameStringArray(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function closedTransition(track: IRNode, value: NonNullable<AudioTrack["editorial"]["transitions"]>[number], index: number, regionMode = false) {
  const code: ReferenceAudioTrackTransitionCode = regionMode ? "CUT_AUDIO_REGION_CROSSFADE_PLAN" : "CUT_AUDIO_EDIT_SHAPE";
  const allowed = new Set(["cut", "duration", "overlap", "outgoingNodeId", "incomingNodeId", "outgoingSource", "incomingSource", "curve", "provenance"]);
  const extra = Object.keys(value).find((key) => !allowed.has(key));
  if (extra) fail(track, code, `audio transition ${index} has unknown field ${boundedDiagnosticString(extra)}`, value.provenance);
  if (value.curve !== "linear" && value.curve !== "equal-power") {
    const curve: unknown = value.curve;
    const received = typeof curve === "string"
      ? boundedDiagnosticString(curve)
      : curve === null ? "null" : Array.isArray(curve) ? "an array" : typeof curve === "object" ? "an object" : `a ${typeof curve}`;
    fail(track, regionMode ? "CUT_AUDIO_REGION_CROSSFADE_PLAN" : "CUT_AUDIO_EDIT_UNSUPPORTED", `audio transition ${index} has unsupported curve ${received}`, value.provenance);
  }
}

function expectedTransition(track: AudioTrack, transition: AudioEditTrackTransition) {
  return {
    cut: addRational(track.interval.start, transition.cut),
    duration: transition.duration,
    overlap: { start: addRational(track.interval.start, transition.overlap.start), duration: transition.overlap.duration },
    outgoingNodeId: track.children[transition.outgoingIndex],
    incomingNodeId: track.children[transition.incomingIndex],
    outgoingSource: transition.outgoingSource,
    incomingSource: transition.incomingSource,
    curve: transition.curve,
  };
}

function timelineViewOrigin(ir: CutAVIR, view: IRNode | undefined) {
  if (!view || view.op !== "cut.edit.timeline_audio_view") return undefined;
  const reference = view.inputs.origin;
  if (reference?.kind !== "node-ref") return undefined;
  const origin = ir.nodes[reference.id];
  const sourceRoot = origin?.op === "cut.edit.timeline_audio_origin"
    && origin.ownership === "reference"
    && origin.children.length === 1
    ? ir.nodes[origin.children[0]!]
    : undefined;
  if (!origin || !sourceRoot) return undefined;
  if (sourceRoot.op === "cut.edit.audio_region") {
    return { kind: "processed-audio" as const, origin, region: sourceRoot };
  }
  if (sourceRoot.op === "cut.audio.clip") {
    return { kind: "direct-audio" as const, origin, source: sourceRoot };
  }
  return undefined;
}

function referenceTimelineAudioViewTransitionPlans(
  ir: CutAVIR,
  composition: IRComposition,
  track: AudioTrack,
  expected: readonly AudioEditTrackTransition[],
): ReferenceAudioTrackItemRenderPlan[] {
  const encoded = track.editorial.transitions ?? [];
  if (!expected.length || encoded.length !== expected.length) {
    fail(track, "CUT_AUDIO_REGION_CROSSFADE_PLAN", `materialized retimed audio transition count ${encoded.length} does not equal replayed count ${expected.length}`);
  }
  if (ir.linkedEdits?.some((transaction) => transaction.audioTrackId === track.id)) {
    fail(track, "CUT_AUDIO_REGION_CROSSFADE_PLAN", "retimed TimelineEdit crossfades cannot also participate in a legacy linked-edit transaction");
  }
  const viewContracts = new Map<string, {
    view: IRNode;
    origin: IRNode;
    region: IRNode;
    authorization: ReferenceAudioRegionPlan;
    source: IREditorialInterval;
    originSource: IREditorialInterval;
    evaluationSource: IREditorialInterval;
    rate: Rational;
  }>();
  const authorizationByRegion = new Map<string, ReferenceAudioRegionPlan>();
  for (const [index, item] of track.editorial.items.entries()) {
    const view = ir.nodes[item.nodeId], ancestry = view ? timelineViewOrigin(ir, view) : undefined;
    if (!view || !ancestry || ancestry.kind !== "processed-audio"
      || item.kind !== "audio" || !item.source || !item.sourceNodeId
      || track.children[index] !== item.nodeId) {
      fail(track, "CUT_AUDIO_REGION_CROSSFADE_TOPOLOGY", `retimed transition item ${index} is not one authenticated timeline audio view`);
    }
    let authorization = authorizationByRegion.get(ancestry.region.id);
    if (!authorization) {
      authorization = authorizeReferenceAudioRegion(ir, composition, ancestry.region);
      authorizationByRegion.set(ancestry.region.id, authorization);
    }
    const rate = exactTimelineRate(track, view);
    const source = exactTimelineSource(track, view);
    const sliceOffset = exactTimelineTimeInput(track, view, "sliceOffset");
    const originDuration = exactTimelineTimeInput(track, view, "originDuration");
    const originSource = {
      start: authorization.sourceRange.start,
      duration: authorization.sourceRange.duration,
    };
    const evaluationSource = ancestry.origin.inputs.evaluationSource === undefined
      ? originSource
      : exactTimelineRange(track, ancestry.origin, "evaluationSource");
    const evaluationPolicy = ancestry.origin.inputs.evaluationPolicy;
    if (ancestry.origin.inputs.evaluationSource !== undefined
      && (evaluationPolicy?.kind !== "string"
        || evaluationPolicy.value !== "full-declared-handle-domain-v1")) {
      fail(track, "CUT_AUDIO_REGION_CROSSFADE_PLAN", `${ancestry.origin.id} lost its full declared-handle evaluation policy`, ancestry.origin.provenance);
    }
    if (!sameInterval(source, item.source)
      || item.sourceNodeId !== authorization.sourceNodeId
      || !sameInterval(originSource, authorization.sourceRange)
      || !same(originSource.duration, multiplyRational(originDuration, rate))
      || compareRational(sliceOffset, zeroRational) < 0
      || compareRational(
        addRational(sliceOffset, item.destination.duration),
        originDuration,
      ) > 0
      || !same(multiplyRational(item.destination.duration, rate), item.source.duration)) {
      fail(track, "CUT_AUDIO_REGION_CROSSFADE_PLAN", `${view.id} does not reconcile its source clock, rate, unsliced origin, and authenticated AudioRegion leaf`);
    }
    viewContracts.set(view.id, {
      view,
      ...ancestry,
      authorization,
      source,
      originSource,
      evaluationSource,
      rate,
    });
  }

  const headByNode = new Map<string, typeof encoded[number]>();
  const tailByNode = new Map<string, typeof encoded[number]>();
  for (const [index, transition] of encoded.entries()) {
    closedTransition(track, transition, index, true);
    const projected = { ...transition } as Record<string, unknown>;
    delete projected.provenance;
    if (stableJsonStringify(projected) !== stableJsonStringify(expectedTransition(track, expected[index]!))) {
      fail(track, "CUT_AUDIO_REGION_CROSSFADE_PLAN", `materialized retimed audio transition ${index} does not equal the post-structural operation result`, expected[index]?.provenance ?? transition.provenance);
    }
    const samples = exactSamples(track, transition.duration, composition.sampleRate, `retimed audio transition ${index} duration`, transition.provenance, "CUT_AUDIO_REGION_CROSSFADE_HANDLE");
    if (samples < 2 || samples % 2 !== 0) {
      fail(track, "CUT_AUDIO_REGION_CROSSFADE_HANDLE", `retimed audio transition ${index} must span an even integer number of at least two destination samples`, transition.provenance);
    }
    const half = rational(samples / 2, composition.sampleRate);
    if (!sameInterval(transition.overlap, {
      start: subtractRational(transition.cut, half),
      duration: transition.duration,
    })) {
      fail(track, "CUT_AUDIO_REGION_CROSSFADE_PLAN", `retimed audio transition ${index} is not exactly centered on its cut`, transition.provenance);
    }
    const outgoingIndex = track.editorial.items.findIndex((item) => item.nodeId === transition.outgoingNodeId);
    const incomingIndex = track.editorial.items.findIndex((item) => item.nodeId === transition.incomingNodeId);
    if (outgoingIndex < 0 || incomingIndex !== outgoingIndex + 1) {
      fail(track, "CUT_AUDIO_REGION_CROSSFADE_TOPOLOGY", `retimed audio transition ${index} does not own adjacent ordered views`, transition.provenance);
    }
    const outgoingItem = track.editorial.items[outgoingIndex]!;
    const incomingItem = track.editorial.items[incomingIndex]!;
    const outgoing = viewContracts.get(outgoingItem.nodeId);
    const incoming = viewContracts.get(incomingItem.nodeId);
    if (!outgoing || !incoming || !outgoingItem.source || !incomingItem.source
      || !same(end(outgoingItem.destination), transition.cut)
      || !same(incomingItem.destination.start, transition.cut)) {
      fail(track, "CUT_AUDIO_REGION_CROSSFADE_TOPOLOGY", `retimed audio transition ${index} lost its exact adjacent cut`, transition.provenance);
    }
    const outgoingSourceDuration = multiplyRational(half, outgoing.rate);
    const incomingSourceDuration = multiplyRational(half, incoming.rate);
    if (!sameInterval(transition.outgoingSource, {
      start: end(outgoingItem.source),
      duration: outgoingSourceDuration,
    }) || !sameInterval(transition.incomingSource, {
      start: subtractRational(incomingItem.source.start, incomingSourceDuration),
      duration: incomingSourceDuration,
    })) {
      fail(track, "CUT_AUDIO_REGION_CROSSFADE_PLAN", `retimed audio transition ${index} does not convert destination handles through each exact constant rate`, transition.provenance);
    }
    const outgoingTail = exactTimelineTimeInput(track, outgoing.view, "tailHandle");
    const incomingHead = exactTimelineTimeInput(track, incoming.view, "headHandle");
    if (compareRational(outgoingTail, outgoingSourceDuration) < 0
      || compareRational(incomingHead, incomingSourceDuration) < 0) {
      fail(track, "CUT_AUDIO_REGION_CROSSFADE_HANDLE", `retimed audio transition ${index} exceeds declared source-clock handle availability`, transition.provenance);
    }
    for (const [contract, consumed, side] of [
      [outgoing, transition.outgoingSource, "outgoing"],
      [incoming, transition.incomingSource, "incoming"],
    ] as const) {
      if (compareRational(consumed.start, contract.evaluationSource.start) < 0
        || compareRational(end(consumed), end(contract.evaluationSource)) > 0) {
        fail(track, "CUT_AUDIO_REGION_CROSSFADE_HANDLE", `${side} retimed handle would require media outside the single authenticated origin evaluation`, transition.provenance);
      }
      exactSamples(track, consumed.start, contract.authorization.source.sourceSampleRate, `${side} retimed handle start`, transition.provenance, "CUT_AUDIO_REGION_CROSSFADE_HANDLE");
      exactSamples(track, end(consumed), contract.authorization.source.sourceSampleRate, `${side} retimed handle end`, transition.provenance, "CUT_AUDIO_REGION_CROSSFADE_HANDLE");
    }
    if (tailByNode.has(transition.outgoingNodeId) || headByNode.has(transition.incomingNodeId)) {
      fail(track, "CUT_AUDIO_REGION_CROSSFADE_TOPOLOGY", `retimed audio transition ${index} duplicates consumed handle ownership`, transition.provenance);
    }
    tailByNode.set(transition.outgoingNodeId, transition);
    headByNode.set(transition.incomingNodeId, transition);
    for (const previous of encoded.slice(0, index)) {
      if (compareRational(previous.overlap.start, end(transition.overlap)) < 0
        && compareRational(transition.overlap.start, end(previous.overlap)) < 0) {
        fail(track, "CUT_AUDIO_REGION_CROSSFADE_TOPOLOGY", `retimed audio transition ${index} overlaps another transition window`, transition.provenance);
      }
    }
  }

  return track.editorial.items.flatMap<ReferenceAudioTrackItemRenderPlan>((item) => {
    if (item.kind !== "audio" || !item.source) return [];
    const contract = viewContracts.get(item.nodeId);
    if (!contract) fail(track, "CUT_AUDIO_REGION_CROSSFADE_PLAN", `${item.nodeId} lost its authenticated retimed view`, track.provenance);
    const head = headByNode.get(item.nodeId);
    const tail = tailByNode.get(item.nodeId);
    const headDestination = head ? divideRational(head.incomingSource.duration, contract.rate) : zeroRational;
    const tailDestination = tail ? divideRational(tail.outgoingSource.duration, contract.rate) : zeroRational;
    const source = {
      start: head?.incomingSource.start ?? item.source.start,
      duration: addRational(addRational(item.source.duration, head?.incomingSource.duration ?? zeroRational), tail?.outgoingSource.duration ?? zeroRational),
    };
    const destination = {
      start: subtractRational(item.destination.start, headDestination),
      duration: addRational(addRational(item.destination.duration, headDestination), tailDestination),
    };
    if (!same(multiplyRational(destination.duration, contract.rate), source.duration)) {
      fail(track, "CUT_AUDIO_REGION_CROSSFADE_PLAN", `${item.nodeId} extended source and destination clocks diverged`, track.provenance);
    }
    const destinationSamples = exactSamples(track, destination.duration, composition.sampleRate, `${item.nodeId} extended retimed destination duration`, contract.view.provenance, "CUT_AUDIO_REGION_CROSSFADE_HANDLE");
    const envelopes: ReferenceAudioTrackEnvelope[] = [];
    if (head) envelopes.push({
      side: "incoming",
      curve: head.curve,
      startSample: 0,
      durationSamples: exactSamples(track, head.duration, composition.sampleRate, `${item.nodeId} incoming retimed envelope`, head.provenance, "CUT_AUDIO_REGION_CROSSFADE_HANDLE"),
    });
    if (tail) envelopes.push({
      side: "outgoing",
      curve: tail.curve,
      startSample: destinationSamples - exactSamples(track, tail.duration, composition.sampleRate, `${item.nodeId} outgoing retimed envelope`, tail.provenance, "CUT_AUDIO_REGION_CROSSFADE_HANDLE"),
      durationSamples: exactSamples(track, tail.duration, composition.sampleRate, `${item.nodeId} outgoing retimed envelope`, tail.provenance, "CUT_AUDIO_REGION_CROSSFADE_HANDLE"),
    });
    return [{
      kind: "timeline-view",
      originKind: "processed-audio",
      nodeId: item.nodeId,
      resourceId: contract.authorization.source.resourceId,
      streamIndex: contract.authorization.source.streamIndex,
      sourceSampleRate: contract.authorization.source.sourceSampleRate,
      source,
      destination,
      destinationSamples,
      envelopes,
      originNodeId: contract.origin.id,
      regionNodeId: contract.region.id,
      sourceNodeId: contract.authorization.sourceNodeId,
      processorNodeIds: contract.authorization.processorNodeIds,
      authorizationHash: contract.authorization.authorizationHash,
      rate: contract.rate,
    }];
  });
}

/**
 * Direct faded TimelineEdit transitions must consume the same immutable
 * origin evaluation as every structural view. Rendering the materialized
 * views as ordinary AudioClips would restart or discard authored fades, so
 * this preflight closes the direct origin/view topology and derives only the
 * transition-specific source and destination windows.
 */
function referenceTimelineDirectAudioViewTransitionPlans(
  ir: CutAVIR,
  composition: IRComposition,
  track: AudioTrack,
  expected: readonly AudioEditTrackTransition[],
): ReferenceAudioTrackItemRenderPlan[] {
  const encoded = track.editorial.transitions ?? [];
  if (!expected.length || encoded.length !== expected.length) {
    fail(track, "CUT_AUDIO_EDIT_RESULT", `materialized direct-audio transition count ${encoded.length} does not equal replayed count ${expected.length}`);
  }
  if (ir.linkedEdits?.some((transaction) => transaction.audioTrackId === track.id)) {
    fail(track, "CUT_AUDIO_EDIT_UNSUPPORTED", "direct faded TimelineEdit crossfades cannot also participate in a legacy linked-edit transaction");
  }
  const contracts = new Map<string, {
    view: IRNode;
    origin: IRNode;
    source: IRNode;
    selection: ReturnType<typeof resourceSelection>;
    viewSource: IREditorialInterval;
    evaluationSource: IREditorialInterval;
    rate: Rational;
  }>();
  for (const [index, item] of track.editorial.items.entries()) {
    const view = ir.nodes[item.nodeId];
    const ancestry = timelineViewOrigin(ir, view);
    if (!view || !ancestry || ancestry.kind !== "direct-audio"
      || item.kind !== "audio" || !item.source
      || item.sourceNodeId !== ancestry.source.id
      || track.children[index] !== item.nodeId) {
      fail(track, "CUT_AUDIO_EDIT_UNSUPPORTED", `direct faded transition item ${index} is not one authenticated direct timeline audio view`);
    }
    const kind = ancestry.origin.inputs.originKind;
    if (kind?.kind !== "string" || kind.value !== "direct-audio") {
      fail(track, "CUT_AUDIO_EDIT_RESULT", `${ancestry.origin.id} lost its direct-audio origin kind`, ancestry.origin.provenance);
    }
    const rate = exactTimelineRate(track, view);
    if (!same(rate, rational(1))) {
      fail(track, "CUT_AUDIO_EDIT_UNSUPPORTED", `${view.id} direct faded transition requires one exact 1x source clock`, view.provenance);
    }
    const viewSource = exactTimelineSource(track, view);
    const originSource = exactTimelineRange(track, ancestry.source, "range");
    const originDuration = exactTimelineTimeInput(track, view, "originDuration");
    const sliceOffset = exactTimelineTimeInput(track, view, "sliceOffset");
    const evaluationSource = ancestry.origin.inputs.evaluationSource === undefined
      ? originSource
      : exactTimelineRange(track, ancestry.origin, "evaluationSource");
    const policy = ancestry.origin.inputs.evaluationPolicy;
    if (ancestry.origin.inputs.evaluationSource !== undefined
      && (policy?.kind !== "string" || policy.value !== "selected-source-union-v1")) {
      fail(track, "CUT_AUDIO_EDIT_RESULT", `${ancestry.origin.id} lost its selected direct-audio evaluation policy`, ancestry.origin.provenance);
    }
    if (!sameInterval(viewSource, item.source)
      || !same(originSource.duration, multiplyRational(originDuration, rate))
      || compareRational(sliceOffset, zeroRational) < 0
      || compareRational(addRational(sliceOffset, item.destination.duration), originDuration) > 0
      || !same(multiplyRational(item.destination.duration, rate), item.source.duration)
      || compareRational(viewSource.start, evaluationSource.start) < 0
      || compareRational(end(viewSource), end(evaluationSource)) > 0) {
      fail(track, "CUT_AUDIO_EDIT_RESULT", `${view.id} does not reconcile its source clock, origin fade clock, and authenticated direct evaluation`, view.provenance);
    }
    const selection = resourceSelection(ir, track, ancestry.source, ancestry.source.provenance);
    for (const [label, value] of [
      ["evaluation start", evaluationSource.start],
      ["evaluation end", end(evaluationSource)],
    ] as const) {
      exactSamples(track, value, selection.sampleRate, `${ancestry.origin.id} ${label}`, ancestry.origin.provenance);
    }
    contracts.set(view.id, {
      view,
      origin: ancestry.origin,
      source: ancestry.source,
      selection,
      viewSource,
      evaluationSource,
      rate,
    });
  }

  const headByNode = new Map<string, typeof encoded[number]>();
  const tailByNode = new Map<string, typeof encoded[number]>();
  for (const [index, transition] of encoded.entries()) {
    closedTransition(track, transition, index);
    const projected = { ...transition } as Record<string, unknown>;
    delete projected.provenance;
    if (stableJsonStringify(projected) !== stableJsonStringify(expectedTransition(track, expected[index]!))) {
      fail(track, "CUT_AUDIO_EDIT_RESULT", `materialized direct-audio transition ${index} does not equal the post-structural operation result`, expected[index]?.provenance ?? transition.provenance);
    }
    const samples = exactSamples(track, transition.duration, composition.sampleRate, `direct-audio transition ${index} duration`, transition.provenance);
    if (samples < 2 || samples % 2 !== 0) {
      fail(track, "CUT_AUDIO_EDIT_TIME", `direct-audio transition ${index} must span an even integer number of at least two destination samples`, transition.provenance);
    }
    const half = rational(samples / 2, composition.sampleRate);
    if (!sameInterval(transition.overlap, {
      start: subtractRational(transition.cut, half),
      duration: transition.duration,
    })) {
      fail(track, "CUT_AUDIO_EDIT_RESULT", `direct-audio transition ${index} is not exactly centered on its cut`, transition.provenance);
    }
    const outgoingIndex = track.editorial.items.findIndex((item) => item.nodeId === transition.outgoingNodeId);
    const incomingIndex = track.editorial.items.findIndex((item) => item.nodeId === transition.incomingNodeId);
    if (outgoingIndex < 0 || incomingIndex !== outgoingIndex + 1) {
      fail(track, "CUT_AUDIO_EDIT_UNSUPPORTED", `direct-audio transition ${index} does not own adjacent ordered views`, transition.provenance);
    }
    const outgoingItem = track.editorial.items[outgoingIndex]!;
    const incomingItem = track.editorial.items[incomingIndex]!;
    const outgoing = contracts.get(outgoingItem.nodeId);
    const incoming = contracts.get(incomingItem.nodeId);
    if (!outgoing || !incoming || !outgoingItem.source || !incomingItem.source
      || !same(end(outgoingItem.destination), transition.cut)
      || !same(incomingItem.destination.start, transition.cut)) {
      fail(track, "CUT_AUDIO_EDIT_UNSUPPORTED", `direct-audio transition ${index} lost its exact adjacent cut`, transition.provenance);
    }
    const outgoingSourceDuration = multiplyRational(half, outgoing.rate);
    const incomingSourceDuration = multiplyRational(half, incoming.rate);
    if (!sameInterval(transition.outgoingSource, {
      start: end(outgoingItem.source),
      duration: outgoingSourceDuration,
    }) || !sameInterval(transition.incomingSource, {
      start: subtractRational(incomingItem.source.start, incomingSourceDuration),
      duration: incomingSourceDuration,
    })) {
      fail(track, "CUT_AUDIO_EDIT_RESULT", `direct-audio transition ${index} does not convert destination handles through each exact source clock`, transition.provenance);
    }
    const outgoingTail = exactTimelineTimeInput(track, outgoing.view, "tailHandle");
    const incomingHead = exactTimelineTimeInput(track, incoming.view, "headHandle");
    if (compareRational(outgoingTail, outgoingSourceDuration) < 0
      || compareRational(incomingHead, incomingSourceDuration) < 0) {
      fail(track, "CUT_AUDIO_EDIT_TIME", `direct-audio transition ${index} exceeds declared source-clock handle availability`, transition.provenance);
    }
    for (const [contract, consumed, side] of [
      [outgoing, transition.outgoingSource, "outgoing"],
      [incoming, transition.incomingSource, "incoming"],
    ] as const) {
      if (compareRational(consumed.start, contract.evaluationSource.start) < 0
        || compareRational(end(consumed), end(contract.evaluationSource)) > 0) {
        fail(track, "CUT_AUDIO_EDIT_TIME", `${side} direct-audio handle exceeds its authenticated origin evaluation`, transition.provenance);
      }
      exactSamples(track, consumed.start, contract.selection.sampleRate, `${side} direct-audio handle start`, transition.provenance);
      exactSamples(track, end(consumed), contract.selection.sampleRate, `${side} direct-audio handle end`, transition.provenance);
    }
    if (tailByNode.has(transition.outgoingNodeId) || headByNode.has(transition.incomingNodeId)) {
      fail(track, "CUT_AUDIO_EDIT_NOOP", `direct-audio transition ${index} duplicates consumed handle ownership`, transition.provenance);
    }
    tailByNode.set(transition.outgoingNodeId, transition);
    headByNode.set(transition.incomingNodeId, transition);
    for (const previous of encoded.slice(0, index)) {
      if (compareRational(previous.overlap.start, end(transition.overlap)) < 0
        && compareRational(transition.overlap.start, end(previous.overlap)) < 0) {
        fail(track, "CUT_AUDIO_EDIT_UNSUPPORTED", `direct-audio transition ${index} overlaps another transition window`, transition.provenance);
      }
    }
  }

  return track.editorial.items.flatMap<ReferenceAudioTrackItemRenderPlan>((item) => {
    if (item.kind !== "audio" || !item.source) return [];
    const contract = contracts.get(item.nodeId);
    if (!contract) fail(track, "CUT_AUDIO_EDIT_RESULT", `${item.nodeId} lost its authenticated direct-audio view`, track.provenance);
    const head = headByNode.get(item.nodeId);
    const tail = tailByNode.get(item.nodeId);
    const headDestination = head ? divideRational(head.incomingSource.duration, contract.rate) : zeroRational;
    const tailDestination = tail ? divideRational(tail.outgoingSource.duration, contract.rate) : zeroRational;
    const source = {
      start: head?.incomingSource.start ?? item.source.start,
      duration: addRational(addRational(item.source.duration, head?.incomingSource.duration ?? zeroRational), tail?.outgoingSource.duration ?? zeroRational),
    };
    const destination = {
      start: subtractRational(item.destination.start, headDestination),
      duration: addRational(addRational(item.destination.duration, headDestination), tailDestination),
    };
    if (!same(multiplyRational(destination.duration, contract.rate), source.duration)) {
      fail(track, "CUT_AUDIO_EDIT_RESULT", `${item.nodeId} direct-audio extended source and destination clocks diverged`, track.provenance);
    }
    const destinationSamples = exactSamples(track, destination.duration, composition.sampleRate, `${item.nodeId} extended direct-audio destination duration`, contract.view.provenance);
    const envelopes: ReferenceAudioTrackEnvelope[] = [];
    if (head) envelopes.push({
      side: "incoming",
      curve: head.curve,
      startSample: 0,
      durationSamples: exactSamples(track, head.duration, composition.sampleRate, `${item.nodeId} incoming direct-audio envelope`, head.provenance),
    });
    if (tail) envelopes.push({
      side: "outgoing",
      curve: tail.curve,
      startSample: destinationSamples - exactSamples(track, tail.duration, composition.sampleRate, `${item.nodeId} outgoing direct-audio envelope`, tail.provenance),
      durationSamples: exactSamples(track, tail.duration, composition.sampleRate, `${item.nodeId} outgoing direct-audio envelope`, tail.provenance),
    });
    return [{
      kind: "timeline-view",
      originKind: "direct-audio",
      nodeId: item.nodeId,
      resourceId: contract.selection.resourceId,
      streamIndex: contract.selection.streamIndex,
      sourceSampleRate: contract.selection.sampleRate,
      source,
      destination,
      destinationSamples,
      envelopes,
      originNodeId: contract.origin.id,
      sourceNodeId: contract.source.id,
      rate: contract.rate,
    }];
  });
}

/**
 * Reconcile loaded transition metadata against post-structural execution and
 * derive exact extended-source render plans. Both validation and rendering
 * call this contract, so hostile IR cannot bypass it through a direct render.
 */
export function referenceAudioTrackTransitionPlans(
  ir: CutAVIR,
  composition: IRComposition,
  track: AudioTrack,
  expected: readonly AudioEditTrackTransition[],
): ReferenceAudioTrackItemRenderPlan[] {
  const operationPlan = track.editorial.operationPlan;
  const timelineOwnership = referenceTimelineEditTrackOwnership(ir, track);
  const timelineProcessedAudioViewMode = operationPlan === undefined
    && timelineOwnership?.domain === "audio"
    && expected.length > 0
    && expected.every((transition) =>
      timelineViewOrigin(ir, ir.nodes[track.children[transition.outgoingIndex] ?? ""]!)?.kind === "processed-audio"
      && timelineViewOrigin(ir, ir.nodes[track.children[transition.incomingIndex] ?? ""]!)?.kind === "processed-audio");
  if (timelineProcessedAudioViewMode) {
    return referenceTimelineAudioViewTransitionPlans(ir, composition, track, expected);
  }
  const timelineDirectAudioViewMode = operationPlan === undefined
    && timelineOwnership?.domain === "audio"
    && expected.length > 0
    && expected.every((transition) =>
      timelineViewOrigin(ir, ir.nodes[track.children[transition.outgoingIndex] ?? ""]!)?.kind === "direct-audio"
      && timelineViewOrigin(ir, ir.nodes[track.children[transition.incomingIndex] ?? ""]!)?.kind === "direct-audio");
  if (timelineDirectAudioViewMode) {
    return referenceTimelineDirectAudioViewTransitionPlans(ir, composition, track, expected);
  }
  const timelineRegionMode = operationPlan === undefined
    && timelineOwnership?.domain === "audio"
    && expected.length > 0
    && expected.every((transition) =>
      ir.nodes[track.children[transition.outgoingIndex] ?? ""]?.op === "cut.edit.audio_region"
      && ir.nodes[track.children[transition.incomingIndex] ?? ""]?.op === "cut.edit.audio_region");
  const regionMode = operationPlan?.version === 2 || timelineRegionMode;
  const shapeCode: ReferenceAudioTrackTransitionCode = regionMode ? "CUT_AUDIO_REGION_CROSSFADE_PLAN" : "CUT_AUDIO_EDIT_SHAPE";
  const timeCode: ReferenceAudioTrackTransitionCode = regionMode ? "CUT_AUDIO_REGION_CROSSFADE_HANDLE" : "CUT_AUDIO_EDIT_TIME";
  const resultCode: ReferenceAudioTrackTransitionCode = regionMode ? "CUT_AUDIO_REGION_CROSSFADE_PLAN" : "CUT_AUDIO_EDIT_RESULT";
  const topologyCode: ReferenceAudioTrackTransitionCode = regionMode ? "CUT_AUDIO_REGION_CROSSFADE_TOPOLOGY" : "CUT_AUDIO_EDIT_UNSUPPORTED";
  const encoded = track.editorial.transitions ?? [];
  if (encoded.length !== expected.length) fail(track, resultCode, `materialized audio transition count ${encoded.length} does not equal replayed count ${expected.length}`);
  if (regionMode && !encoded.length) fail(track, "CUT_AUDIO_REGION_CROSSFADE_PLAN", "processed AudioRegion transition authority must contain at least one materialized crossfade");
  if (!encoded.length) return [];

  if (regionMode && ir.linkedEdits?.some((transaction) => transaction.audioTrackId === track.id)) {
    fail(track, "CUT_AUDIO_REGION_CROSSFADE_PLAN", "processed AudioRegion crossfades cannot participate in a linked-edit transaction", operationPlan?.operations[0]?.provenance ?? track.provenance);
  }

  const regionAuthorizations = new Map<string, ReferenceAudioRegionPlan>();
  const regionBaseByNode = new Map<string, AudioEditRegionItem>();
  if (regionMode) {
    if (track.children.length !== track.editorial.items.length
      || (operationPlan?.version === 2 && operationPlan.baseItems.length !== track.editorial.items.length)) {
      fail(track, "CUT_AUDIO_REGION_CROSSFADE_PLAN", "processed transition authority must preserve exactly one base item for every authored AudioRegion child");
    }
    let batchedAuthorizations: ReadonlyMap<string, ReferenceAudioRegionPlan>;
    try {
      batchedAuthorizations = authorizeReferenceAudioRegions(ir, composition, track.children);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown closed-graph authorization failure";
      fail(track, "CUT_AUDIO_REGION_CROSSFADE_PLAN", `processed AudioRegion graph authorization failed: ${detail}`, operationPlan?.version === 2 ? operationPlan.baseItems[0]?.provenance ?? track.provenance : track.provenance);
    }
    const baseItems: readonly AudioEditRegionItem[] = operationPlan?.version === 2
      ? operationPlan.baseItems
      : track.editorial.items.map((item, index): AudioEditRegionItem => {
          const region = ir.nodes[item.nodeId];
          if (item.kind !== "audio" || !item.source || !item.sourceNodeId
            || !region || region.op !== "cut.edit.audio_region") {
            fail(track, "CUT_AUDIO_REGION_CROSSFADE_PLAN", `TimelineEdit processed base item ${index} does not identify one AudioRegion`, track.provenance);
          }
          const authorized = batchedAuthorizations.get(region.id);
          if (!authorized) fail(track, "CUT_AUDIO_REGION_CROSSFADE_PLAN", `TimelineEdit AudioRegion ${region.id} has no closed-graph authorization`, region.provenance);
          return {
            origin: item.editId ?? `timeline:${index}`,
            kind: "region",
            regionId: region.id,
            sourceNodeId: authorized.sourceNodeId,
            processorNodeIds: [...authorized.processorNodeIds],
            destination: relativeInterval(track, item.destination),
            source: { ...item.source },
            inputs: {
              resourceId: authorized.source.resourceId,
              ...(item.linkId ? { linkId: item.linkId } : {}),
              ...(compareRational(authorized.headHandle, zeroRational) > 0 ? { headHandle: authorized.headHandle } : {}),
              ...(compareRational(authorized.tailHandle, zeroRational) > 0 ? { tailHandle: authorized.tailHandle } : {}),
            },
            provenance: region.provenance,
          };
        });
    for (const [index, base] of baseItems.entries()) {
      const item = track.editorial.items[index], region = ir.nodes[item?.nodeId];
      if (!item || item.kind !== "audio" || !item.source || !item.sourceNodeId || track.children[index] !== item.nodeId
        || !region || region.op !== "cut.edit.audio_region" || base.kind !== "region" || base.regionId !== region.id) {
        fail(track, "CUT_AUDIO_REGION_CROSSFADE_PLAN", `processed base item ${index} does not identify its exact authored AudioRegion topology`, base.provenance);
      }
      const authorized = batchedAuthorizations.get(region.id);
      if (!authorized) fail(track, "CUT_AUDIO_REGION_CROSSFADE_PLAN", `AudioRegion ${region.id} has no batched closed-graph authorization`, base.provenance);
      const leaf = ir.nodes[authorized.sourceNodeId];
      if (!leaf || base.sourceNodeId !== authorized.sourceNodeId
        || !sameStringArray(base.processorNodeIds, authorized.processorNodeIds)
        || !sameInterval(base.destination, relativeInterval(track, item.destination))
        || !sameInterval(base.source, item.source)
        || base.inputs.resourceId !== authorized.source.resourceId
        || base.inputs.linkId !== authorized.linkId
        || !same(base.inputs.headHandle ?? zeroRational, authorized.headHandle)
        || !same(base.inputs.tailHandle ?? zeroRational, authorized.tailHandle)
        || stableJsonStringify(base.provenance) !== stableJsonStringify(region.provenance)) {
        fail(track, "CUT_AUDIO_REGION_CROSSFADE_PLAN", `processed base item ${index} disagrees with the live region, source, processor order, handles, link, or timing`, base.provenance);
      }
      const automated = [leaf, ...authorized.processorNodeIds.map((id) => ir.nodes[id])]
        .find((node) => node && Object.keys(node.properties).length > 0);
      if (automated) {
        fail(track, "CUT_AUDIO_REGION_CROSSFADE_AUTOMATION", `processed transition chain ${automated.id} must be static and cannot carry property automation`, automated.provenance);
      }
      zeroLeafFade(track, leaf, "fadeIn", leaf.provenance);
      zeroLeafFade(track, leaf, "fadeOut", leaf.provenance);
      const selection = resourceSelection(ir, track, leaf, leaf.provenance, {
        shape: "CUT_AUDIO_REGION_CROSSFADE_PLAN",
        unsupported: "CUT_AUDIO_REGION_CROSSFADE_HANDLE",
      });
      const availableStart = subtractRational(base.source.start, authorized.headHandle);
      const availableEnd = addRational(end(base.source), authorized.tailHandle);
      if (compareRational(availableStart, zeroRational) < 0 || compareRational(availableEnd, selection.duration) > 0) {
        fail(track, "CUT_AUDIO_REGION_CROSSFADE_HANDLE", `${region.id} declared source handles exceed the locked selected audio stream`, base.provenance);
      }
      for (const [label, value] of [["declared available start", availableStart], ["declared available end", availableEnd]] as const) {
        exactSamples(track, value, selection.sampleRate, `${region.id} ${label}`, base.provenance, "CUT_AUDIO_REGION_CROSSFADE_HANDLE");
      }
      regionAuthorizations.set(region.id, authorized);
      regionBaseByNode.set(region.id, base);
    }
  }

  const headByNode = new Map<string, typeof encoded[number]>(), tailByNode = new Map<string, typeof encoded[number]>();
  for (const [index, transition] of encoded.entries()) {
    closedTransition(track, transition, index, regionMode);
    const projected = { ...transition } as Record<string, unknown>;
    delete projected.provenance;
    if (stableJsonStringify(projected) !== stableJsonStringify(expectedTransition(track, expected[index]))) {
      fail(track, resultCode, `materialized audio transition ${index} does not equal the post-structural operation result`, expected[index]?.provenance ?? transition.provenance);
    }
    const samples = exactSamples(track, transition.duration, composition.sampleRate, `audio transition ${index} duration`, transition.provenance, timeCode);
    if (samples < 2 || samples % 2 !== 0) fail(track, timeCode, `audio transition ${index} must span an even integer number of at least two destination samples`, transition.provenance);
    const halfSamples = samples / 2;
    const overlapStart = subtractRational(transition.cut, rational(halfSamples, composition.sampleRate));
    if (!sameInterval(transition.overlap, { start: overlapStart, duration: transition.duration })) fail(track, resultCode, `audio transition ${index} overlap is not exactly centered on its cut`, transition.provenance);
    const outgoingIndex = track.editorial.items.findIndex((item) => item.nodeId === transition.outgoingNodeId);
    const incomingIndex = track.editorial.items.findIndex((item) => item.nodeId === transition.incomingNodeId);
    if (outgoingIndex < 0 || incomingIndex !== outgoingIndex + 1) fail(track, topologyCode, `audio transition ${index} does not own adjacent ordered track items`, transition.provenance);
    const outgoingItem = track.editorial.items[outgoingIndex], incomingItem = track.editorial.items[incomingIndex];
    if (outgoingItem.kind !== "audio" || incomingItem.kind !== "audio" || !outgoingItem.source || !incomingItem.source) fail(track, topologyCode, `audio transition ${index} requires two adjacent audio items`, transition.provenance);
    if (!same(end(outgoingItem.destination), transition.cut) || !same(incomingItem.destination.start, transition.cut)) fail(track, topologyCode, `audio transition ${index} cut is not the exact hard cut between its items`, transition.provenance);
    const outgoingNode = ir.nodes[transition.outgoingNodeId], incomingNode = ir.nodes[transition.incomingNodeId];
    const expectedOp = regionMode ? "cut.edit.audio_region" : "cut.audio.clip";
    if (!outgoingNode || !incomingNode || outgoingNode.op !== expectedOp || incomingNode.op !== expectedOp) fail(track, topologyCode, `audio transition ${index} references missing or incompatible children`, transition.provenance);
    if (regionMode && outgoingItem.linkId !== undefined && outgoingItem.linkId === incomingItem.linkId) {
      fail(track, "CUT_AUDIO_REGION_CROSSFADE_TOPOLOGY", `audio transition ${index} cannot crossfade two members of the same passive picture link`, transition.provenance);
    }
    const half = rational(halfSamples, composition.sampleRate);
    if (!sameInterval(transition.outgoingSource, { start: end(outgoingItem.source), duration: half })
      || !sameInterval(transition.incomingSource, { start: subtractRational(incomingItem.source.start, half), duration: half })) {
      fail(track, resultCode, `audio transition ${index} source handles do not extend the visible source intervals exactly`, transition.provenance);
    }
    const outgoingTail = regionMode ? regionAuthorizations.get(outgoingNode.id)?.tailHandle : timeInput(track, outgoingNode, "tailHandle", transition.provenance);
    const incomingHead = regionMode ? regionAuthorizations.get(incomingNode.id)?.headHandle : timeInput(track, incomingNode, "headHandle", transition.provenance);
    if (!outgoingTail || !incomingHead || compareRational(outgoingTail, half) < 0 || compareRational(incomingHead, half) < 0) {
      fail(track, timeCode, `audio transition ${index} exceeds declared source handle availability`, transition.provenance);
    }
    for (const [node, item, source] of [[outgoingNode, outgoingItem, transition.outgoingSource], [incomingNode, incomingItem, transition.incomingSource]] as const) {
      const sourceNode = regionMode ? ir.nodes[item.sourceNodeId!] : node;
      if (!sourceNode) fail(track, resultCode, `${node.id} is missing its selected source leaf`, transition.provenance);
      const selected = resourceSelection(ir, track, sourceNode, transition.provenance, { shape: shapeCode, unsupported: timeCode });
      exactSamples(track, source.start, selected.sampleRate, `${node.id} consumed handle start`, transition.provenance, timeCode);
      exactSamples(track, end(source), selected.sampleRate, `${node.id} consumed handle end`, transition.provenance, timeCode);
      if (compareRational(source.start, zeroRational) < 0 || compareRational(end(source), selected.duration) > 0) fail(track, timeCode, `${node.id} consumed handle lies outside the locked selected audio stream`, transition.provenance);
    }
    if (tailByNode.has(transition.outgoingNodeId) || headByNode.has(transition.incomingNodeId)) fail(track, regionMode ? "CUT_AUDIO_REGION_CROSSFADE_TOPOLOGY" : "CUT_AUDIO_EDIT_NOOP", `audio transition ${index} duplicates consumed handle ownership`, transition.provenance);
    tailByNode.set(transition.outgoingNodeId, transition);
    headByNode.set(transition.incomingNodeId, transition);
    for (const previous of encoded.slice(0, index)) {
      if (compareRational(previous.overlap.start, end(transition.overlap)) < 0 && compareRational(transition.overlap.start, end(previous.overlap)) < 0) {
        fail(track, topologyCode, `audio transition ${index} overlaps another transition window`, transition.provenance);
      }
    }
  }

  return track.editorial.items.flatMap<ReferenceAudioTrackItemRenderPlan>((item): ReferenceAudioTrackItemRenderPlan[] => {
    if (item.kind !== "audio" || !item.source) return [];
    const node = ir.nodes[item.nodeId];
    if (!node) fail(track, resultCode, `audio item ${item.nodeId} is missing`, track.provenance);
    const authorized = regionMode ? regionAuthorizations.get(node.id) : undefined;
    const sourceNode = authorized ? ir.nodes[authorized.sourceNodeId] : node;
    if (!sourceNode) fail(track, resultCode, `audio item ${item.nodeId} source leaf is missing`, track.provenance);
    const selection = resourceSelection(ir, track, sourceNode, node.provenance, { shape: shapeCode, unsupported: timeCode });
    const head = headByNode.get(item.nodeId), tail = tailByNode.get(item.nodeId);
    const headDuration = head?.incomingSource.duration ?? zeroRational, tailDuration = tail?.outgoingSource.duration ?? zeroRational;
    const source = {
      start: head?.incomingSource.start ?? item.source.start,
      duration: addRational(addRational(item.source.duration, headDuration), tailDuration),
    };
    const destination = {
      start: subtractRational(item.destination.start, headDuration),
      duration: addRational(addRational(item.destination.duration, headDuration), tailDuration),
    };
    const destinationSamples = exactSamples(track, destination.duration, composition.sampleRate, `${node.id} extended destination duration`, node.provenance, timeCode);
    const envelopes: ReferenceAudioTrackEnvelope[] = [];
    if (head) envelopes.push({ side: "incoming", curve: head.curve, startSample: 0, durationSamples: exactSamples(track, head.duration, composition.sampleRate, `${node.id} incoming envelope`, head.provenance, timeCode) });
    if (tail) envelopes.push({
      side: "outgoing",
      curve: tail.curve,
      startSample: destinationSamples - exactSamples(track, tail.duration, composition.sampleRate, `${node.id} outgoing envelope`, tail.provenance, timeCode),
      durationSamples: exactSamples(track, tail.duration, composition.sampleRate, `${node.id} outgoing envelope`, tail.provenance, timeCode),
    });
    const common: ReferenceAudioTrackItemRenderPlanBase = { nodeId: item.nodeId, resourceId: selection.resourceId, streamIndex: selection.streamIndex, sourceSampleRate: selection.sampleRate, source, destination, destinationSamples, envelopes };
    if (!regionMode) return [{ ...common, kind: "clip" }];
    if (!authorized || !regionBaseByNode.has(node.id)) fail(track, "CUT_AUDIO_REGION_CROSSFADE_PLAN", `${node.id} has no reconciled processed region base item`, node.provenance);
    return [{ ...common, kind: "region", sourceNodeId: authorized.sourceNodeId, processorNodeIds: authorized.processorNodeIds, authorizationHash: authorized.authorizationHash }];
  });
}

/** Exact CUT-owned scalar envelope at output sample k, with p = k / N. */
export function referenceAudioCrossfadeGain(curve: AudioEditCrossfadeCurve, side: "incoming" | "outgoing", k: number, sampleCount: number) {
  if (!Number.isSafeInteger(k) || !Number.isSafeInteger(sampleCount) || sampleCount < 2 || k < 0 || k >= sampleCount) throw new RangeError("audio crossfade sample must satisfy 0 <= k < N and N >= 2");
  const p = k / sampleCount;
  if (curve === "linear") return side === "incoming" ? p : 1 - p;
  return side === "incoming" ? Math.sin(Math.PI * p / 2) : Math.cos(Math.PI * p / 2);
}

/** The backend expression is generated from the same p=k/N contract. */
export function referenceAudioCrossfadeEnvelopeExpression(envelope: ReferenceAudioTrackEnvelope) {
  const k = `(n-${envelope.startSample})`, p = `(${k}/${envelope.durationSamples})`;
  const gain = envelope.curve === "linear"
    ? envelope.side === "incoming" ? p : `(1-${p})`
    : envelope.side === "incoming" ? `sin(PI*${p}/2)` : `cos(PI*${p}/2)`;
  return `if(between(n,${envelope.startSample},${envelope.startSample + envelope.durationSamples - 1}),${gain},1)`;
}
