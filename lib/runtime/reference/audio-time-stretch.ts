import { readFile, writeFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import type { CutAVIR, IRComposition, IRNode, IRValue } from "../../language/ir";
import type { LockedResourceProbe } from "../../language/lock";
import { addRational, compareRational, divideRational, multiplyRational, rational, rationalToNumber, subtractRational, zeroRational, type Rational } from "../../language/rational";

export const referenceTimeStretchQualities = ["draft", "balanced"] as const;
export type ReferenceTimeStretchQuality = typeof referenceTimeStretchQualities[number];

export const referenceTimeStretchLimits = Object.freeze({
  minimumDurationRatio: 0.5,
  maximumDurationRatio: 2,
  minimumPitchSemitones: -12,
  maximumPitchSemitones: 12,
  maximumNodesPerComposition: 8,
  maximumSourceSamplesPerNode: 2_000_000,
  maximumDestinationSamplesPerNode: 2_000_000,
  maximumIntermediateSamplesPerNode: 4_000_000,
  maximumTotalDestinationSamples: 8_000_000,
  maximumFftWorkPerComposition: 400_000_000,
});

const qualityConfig = Object.freeze({
  draft: { windowSize: 512, analysisHop: 128 },
  balanced: { windowSize: 1_024, analysisHop: 256 },
} satisfies Record<ReferenceTimeStretchQuality, { windowSize: number; analysisHop: number }>);

export type ReferenceTimeStretchErrorCode =
  | "CUT_AUDIO_TIME_STRETCH_TYPE"
  | "CUT_AUDIO_TIME_STRETCH_VALUE_RANGE"
  | "CUT_AUDIO_TIME_STRETCH_SAMPLE_GRID"
  | "CUT_AUDIO_TIME_STRETCH_QUALITY"
  | "CUT_AUDIO_TIME_STRETCH_GRAPH"
  | "CUT_AUDIO_TIME_STRETCH_SOURCE"
  | "CUT_AUDIO_TIME_STRETCH_RESOURCE";

export class ReferenceTimeStretchError extends Error {
  readonly source: { module: string; line: number; column: number; nodeId: string };

  constructor(readonly code: ReferenceTimeStretchErrorCode, readonly nodeId: string, node: IRNode, message: string) {
    super(`${code}: ${message}`);
    this.name = "ReferenceTimeStretchError";
    this.source = {
      module: node.provenance.module,
      line: node.provenance.span.start.line,
      column: node.provenance.span.start.column,
      nodeId,
    };
  }
}

export type ReferenceTimeStretchPlan = {
  kind: "time-stretch";
  nodeId: string;
  childId: string;
  sampleRate: number;
  placementSamples: number;
  sourceSamples: number;
  destinationSamples: number;
  intermediateSamples: number;
  durationRatio: number;
  pitchSemitones: number;
  pitchFactor: number;
  quality: ReferenceTimeStretchQuality;
  windowSize: number;
  analysisHop: number;
  fftWork: number;
  audioRegionId?: string;
};

export type ReferenceTimeStretchSource = {
  path: string;
  format: "raw-stereo-f32le";
  channels: 2;
  sampleRate: number;
  placementSamples: number;
  renderedSamples: number;
  timelineOriginNodeId?: string;
};

export type ReferenceTimeStretchPreparation = {
  sources: Map<string, ReferenceTimeStretchSource>;
  cleanup: () => Promise<void>;
};

export type ReferenceTimelineTimeStretchChildEvaluation = Readonly<{
  version: 1;
  timelineOriginNodeId: string;
  childNodeId: string;
  source: Readonly<{ start: Rational; duration: Rational }>;
  presentationSourceZero: Rational;
  originSourceDuration: Rational;
}>;

type RenderTimeStretchChild = (
  childId: string,
  output: string,
  startSample: number,
  endSample: number,
  allowExtendedCompositionRange: boolean,
  timelineEvaluation?: ReferenceTimelineTimeStretchChildEvaluation,
) => Promise<void>;

function fail(node: IRNode, code: ReferenceTimeStretchErrorCode, message: string): never {
  const location = `${node.provenance.module}:${node.provenance.span.start.line}:${node.provenance.span.start.column}`;
  throw new ReferenceTimeStretchError(code, node.id, node, `TimeStretch at ${location} ${message}`);
}

function boundedIoCode(error: unknown) {
  const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "UNKNOWN";
  return /^[A-Z0-9_]{1,64}$/u.test(code) ? code : "UNKNOWN";
}

function exactSamples(node: IRNode, value: Rational, sampleRate: number, label: string) {
  const samples = multiplyRational(value, rational(sampleRate));
  if (samples.denominator !== "1") fail(node, "CUT_AUDIO_TIME_STRETCH_SAMPLE_GRID", `${label} does not land on the ${sampleRate} Hz sample boundary.`);
  const count = Number(samples.numerator);
  if (!Number.isSafeInteger(count) || count < 0) fail(node, "CUT_AUDIO_TIME_STRETCH_VALUE_RANGE", `${label} has an unsafe sample count.`);
  return count;
}

function quantity(node: IRNode, value: IRValue | undefined, dimension: string, label: string, fallback?: Rational) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (value?.kind !== "quantity" || value.dimension !== dimension) {
    fail(node, "CUT_AUDIO_TIME_STRETCH_TYPE", `${label} must be an exact ${dimension === "time" ? "Time" : "Number"} quantity.`);
  }
  return value.magnitude;
}

function quality(node: IRNode, value: IRValue | undefined): ReferenceTimeStretchQuality {
  if (value === undefined) return "balanced";
  if (value.kind !== "string") fail(node, "CUT_AUDIO_TIME_STRETCH_TYPE", "quality must be a String.");
  if (!referenceTimeStretchQualities.includes(value.value as ReferenceTimeStretchQuality)) {
    fail(node, "CUT_AUDIO_TIME_STRETCH_QUALITY", `quality must be one of: ${referenceTimeStretchQualities.join(", ")}.`);
  }
  return value.value as ReferenceTimeStretchQuality;
}

function nearestPositiveInteger(value: number) {
  if (!Number.isFinite(value) || value <= 0) return Number.NaN;
  return Math.floor(value + 0.5);
}

function analysisFrameCount(samples: number, windowSize: number, hop: number) {
  if (samples < windowSize) return 0;
  const remaining = samples - windowSize;
  return Math.floor(remaining / hop) + 1 + (remaining % hop === 0 ? 0 : 1);
}

function owningAudioRegion(ir: CutAVIR, node: IRNode) {
  const visited = new Set<string>([node.id]);
  let current = node;
  for (let depth = 0; depth <= 33; depth += 1) {
    const parents = Object.values(ir.nodes).filter((candidate) => candidate.children.includes(current.id));
    if (parents.length !== 1) return undefined;
    const parent = parents[0];
    if (parent.op === "cut.edit.audio_region") return parent;
    if (visited.has(parent.id)) return undefined;
    visited.add(parent.id); current = parent;
  }
  return undefined;
}

/** Reduce one public TimeStretch node to an exact bounded DSP plan. */
export function compileReferenceTimeStretchPlan(ir: CutAVIR, composition: IRComposition, node: IRNode): ReferenceTimeStretchPlan {
  if (node.op !== "cut.audio.time_stretch") fail(node, "CUT_AUDIO_TIME_STRETCH_GRAPH", `cannot compile kernel ${node.op}.`);
  if (node.domain !== "audio") fail(node, "CUT_AUDIO_TIME_STRETCH_GRAPH", `must have audio domain, found ${node.domain}.`);
  const allowed = new Set(["sourceDuration", "duration", "pitch", "quality"]);
  const unknown = Object.keys(node.inputs).filter((name) => !allowed.has(name));
  if (unknown.length) fail(node, "CUT_AUDIO_TIME_STRETCH_GRAPH", `has unsupported input${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`);
  if (node.children.length !== 1) fail(node, "CUT_AUDIO_TIME_STRETCH_GRAPH", `requires exactly one audio child; found ${node.children.length}.`);
  const child = ir.nodes[node.children[0]];
  if (!child || child.domain !== "audio") fail(node, "CUT_AUDIO_TIME_STRETCH_GRAPH", "must reference one existing audio child.");
  if (Object.keys(node.properties).length) fail(node, "CUT_AUDIO_TIME_STRETCH_GRAPH", "has no settable or animatable properties in this slice.");

  const sourceDuration = quantity(node, node.inputs.sourceDuration, "time", "sourceDuration");
  const destinationDuration = quantity(node, node.inputs.duration, "time", "duration");
  const audioRegion = owningAudioRegion(ir, node);
  if (compareRational(sourceDuration, zeroRational) <= 0) fail(node, "CUT_AUDIO_TIME_STRETCH_VALUE_RANGE", "sourceDuration must be positive.");
  if (compareRational(destinationDuration, zeroRational) <= 0) fail(node, "CUT_AUDIO_TIME_STRETCH_VALUE_RANGE", "duration must be positive.");
  if (!audioRegion && compareRational(sourceDuration, node.interval.duration) > 0) fail(node, "CUT_AUDIO_TIME_STRETCH_VALUE_RANGE", "sourceDuration exceeds the owning interval.");
  if (compareRational(destinationDuration, node.interval.duration) > 0) fail(node, "CUT_AUDIO_TIME_STRETCH_VALUE_RANGE", "duration exceeds the owning interval.");
  if (audioRegion && (compareRational(destinationDuration, audioRegion.interval.duration) !== 0
    || compareRational(node.interval.start, audioRegion.interval.start) !== 0
    || compareRational(node.interval.duration, audioRegion.interval.duration) !== 0
    || node.sceneId !== audioRegion.sceneId)) {
    fail(node, "CUT_AUDIO_TIME_STRETCH_GRAPH", "inside AudioRegion must own exactly the outer destination interval and scene.");
  }
  const sourceSamples = exactSamples(node, sourceDuration, composition.sampleRate, "sourceDuration");
  const destinationSamples = exactSamples(node, destinationDuration, composition.sampleRate, "duration");
  const durationRatio = destinationSamples / sourceSamples;
  if (!Number.isFinite(durationRatio) || durationRatio < referenceTimeStretchLimits.minimumDurationRatio || durationRatio > referenceTimeStretchLimits.maximumDurationRatio) {
    fail(node, "CUT_AUDIO_TIME_STRETCH_VALUE_RANGE", `destination/source duration ratio must stay between ${referenceTimeStretchLimits.minimumDurationRatio} and ${referenceTimeStretchLimits.maximumDurationRatio}; received ${durationRatio}.`);
  }

  const pitchSemitones = rationalToNumber(quantity(node, node.inputs.pitch, "scalar", "pitch", zeroRational));
  if (!Number.isFinite(pitchSemitones) || pitchSemitones < referenceTimeStretchLimits.minimumPitchSemitones || pitchSemitones > referenceTimeStretchLimits.maximumPitchSemitones) {
    fail(node, "CUT_AUDIO_TIME_STRETCH_VALUE_RANGE", `pitch must stay between ${referenceTimeStretchLimits.minimumPitchSemitones} and +${referenceTimeStretchLimits.maximumPitchSemitones} semitones.`);
  }
  const selectedQuality = quality(node, node.inputs.quality), config = qualityConfig[selectedQuality];
  const minimumSamples = config.windowSize * 4;
  if (sourceSamples < minimumSamples || destinationSamples < minimumSamples) {
    fail(node, "CUT_AUDIO_TIME_STRETCH_VALUE_RANGE", `${selectedQuality} quality requires sourceDuration and duration to contain at least ${minimumSamples} samples.`);
  }
  if (sourceSamples > referenceTimeStretchLimits.maximumSourceSamplesPerNode) fail(node, "CUT_AUDIO_TIME_STRETCH_RESOURCE", `sourceDuration exceeds the ${referenceTimeStretchLimits.maximumSourceSamplesPerNode}-sample per-node limit.`);
  if (destinationSamples > referenceTimeStretchLimits.maximumDestinationSamplesPerNode) fail(node, "CUT_AUDIO_TIME_STRETCH_RESOURCE", `duration exceeds the ${referenceTimeStretchLimits.maximumDestinationSamplesPerNode}-sample per-node limit.`);

  const pitchFactor = 2 ** (pitchSemitones / 12);
  const intermediateSamples = nearestPositiveInteger(destinationSamples * pitchFactor);
  if (!Number.isSafeInteger(intermediateSamples) || intermediateSamples <= config.windowSize || intermediateSamples > referenceTimeStretchLimits.maximumIntermediateSamplesPerNode) {
    fail(node, "CUT_AUDIO_TIME_STRETCH_RESOURCE", `pitch/time plan requires an invalid or over-budget ${intermediateSamples}-sample intermediate; maximum is ${referenceTimeStretchLimits.maximumIntermediateSamplesPerNode}.`);
  }

  const scene = node.sceneId ? ir.scenes[node.sceneId] : undefined;
  if (node.sceneId && (!scene || !composition.sceneIds.includes(node.sceneId))) fail(node, "CUT_AUDIO_TIME_STRETCH_GRAPH", "belongs to a missing or different composition scene.");
  const placement = addRational(scene?.start ?? zeroRational, node.interval.start);
  const placementSamples = exactSamples(node, placement, composition.sampleRate, "destination placement");
  const compositionSamples = exactSamples(node, composition.duration, composition.sampleRate, "composition duration");
  if (!audioRegion && placementSamples + sourceSamples > compositionSamples) fail(node, "CUT_AUDIO_TIME_STRETCH_VALUE_RANGE", "source interval exceeds the composition sample range.");
  if (placementSamples + destinationSamples > compositionSamples) fail(node, "CUT_AUDIO_TIME_STRETCH_VALUE_RANGE", "destination interval exceeds the composition sample range.");

  const frames = analysisFrameCount(sourceSamples, config.windowSize, config.analysisHop);
  const fftWork = frames * config.windowSize * Math.log2(config.windowSize) * 4;
  if (!Number.isSafeInteger(fftWork) || fftWork <= 0 || fftWork > referenceTimeStretchLimits.maximumFftWorkPerComposition) {
    fail(node, "CUT_AUDIO_TIME_STRETCH_RESOURCE", `FFT work ${fftWork} exceeds the ${referenceTimeStretchLimits.maximumFftWorkPerComposition}-unit composition ceiling.`);
  }
  return {
    kind: "time-stretch",
    nodeId: node.id,
    childId: child.id,
    sampleRate: composition.sampleRate,
    placementSamples,
    sourceSamples,
    destinationSamples,
    intermediateSamples,
    durationRatio,
    pitchSemitones,
    pitchFactor,
    quality: selectedQuality,
    windowSize: config.windowSize,
    analysisHop: config.analysisHop,
    fftWork,
    ...(audioRegion ? { audioRegionId: audioRegion.id } : {}),
  };
}

function valueNodeReferences(value: IRValue, result: Set<string>) {
  if (value.kind === "node-ref") result.add(value.id);
  else if (value.kind === "array") value.items.forEach((item) => valueNodeReferences(item, result));
  else if (value.kind === "object") Object.values(value.entries).forEach((item) => valueNodeReferences(item, result));
  else if (value.kind === "range") { valueNodeReferences(value.start, result); valueNodeReferences(value.end, result); }
  else if (value.kind === "unary") valueNodeReferences(value.value, result);
  else if (value.kind === "binary") { valueNodeReferences(value.left, result); valueNodeReferences(value.right, result); }
  else if (value.kind === "member") valueNodeReferences(value.object, result);
  else if (value.kind === "index") { valueNodeReferences(value.object, result); valueNodeReferences(value.index, result); }
  else if (value.kind === "call") {
    value.positional.forEach((item) => valueNodeReferences(item, result));
    Object.values(value.named).forEach((item) => valueNodeReferences(item, result));
  }
}

function nodeEdges(node: IRNode) {
  const references = new Set<string>(node.children);
  Object.values(node.inputs).forEach((value) => valueNodeReferences(value, references));
  for (const value of Object.values(node.properties)) if (!("signal" in value)) valueNodeReferences(value, references);
  return [...references];
}

function descendantsContainTimeStretch(ir: CutAVIR, node: IRNode) {
  const pending = nodeEdges(node), visited = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const child = ir.nodes[id];
    if (!child) continue;
    if (child.op === "cut.audio.time_stretch") return true;
    pending.push(...nodeEdges(child));
  }
  return false;
}

export function reachableReferenceTimeStretchNodeIds(ir: CutAVIR, rootIds: readonly string[]) {
  const pending = [...rootIds], visited = new Set<string>(), result = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = ir.nodes[id];
    if (!node) throw new Error(`Audio graph references missing node ${id}.`);
    if (node.op === "cut.audio.time_stretch") {
      result.add(id);
      continue;
    }
    // A Limiter child is rendered through a separate exact-f32 processor
    // boundary; any TimeStretch below it belongs to that recursive invocation.
    if (node.op === "cut.audio.limiter" || node.op === "cut.audio.tempo_delay") continue;
    pending.push(...nodeEdges(node));
  }
  return [...result].sort();
}

export function validateReferenceTimeStretchPlans(ir: CutAVIR, composition: IRComposition, nodeIds: readonly string[]) {
  const ids = [...new Set(nodeIds)].sort();
  if (ids.length > referenceTimeStretchLimits.maximumNodesPerComposition) {
    const owner = ir.nodes[ids[0]];
    if (!owner) throw new Error(`CUT TimeStretch graph references missing node ${ids[0]}.`);
    fail(owner, "CUT_AUDIO_TIME_STRETCH_RESOURCE", `graph contains ${ids.length} TimeStretch nodes; maximum is ${referenceTimeStretchLimits.maximumNodesPerComposition}.`);
  }
  const plans = ids.map((id) => {
    const node = ir.nodes[id];
    if (!node) throw new Error(`CUT TimeStretch graph references missing node ${id}.`);
    if (descendantsContainTimeStretch(ir, node)) fail(node, "CUT_AUDIO_TIME_STRETCH_GRAPH", "cannot contain another TimeStretch in this bounded slice.");
    return compileReferenceTimeStretchPlan(ir, composition, node);
  });
  const outputSamples = plans.reduce((sum, plan) => sum + plan.destinationSamples, 0);
  if (!Number.isSafeInteger(outputSamples) || outputSamples > referenceTimeStretchLimits.maximumTotalDestinationSamples) {
    const owner = ir.nodes[ids[0]]!;
    fail(owner, "CUT_AUDIO_TIME_STRETCH_RESOURCE", `graph requires ${outputSamples} destination samples; maximum is ${referenceTimeStretchLimits.maximumTotalDestinationSamples}.`);
  }
  const fftWork = plans.reduce((sum, plan) => sum + plan.fftWork, 0);
  if (!Number.isSafeInteger(fftWork) || fftWork > referenceTimeStretchLimits.maximumFftWorkPerComposition) {
    const owner = ir.nodes[ids[0]]!;
    fail(owner, "CUT_AUDIO_TIME_STRETCH_RESOURCE", `graph requires ${fftWork} FFT work units; maximum is ${referenceTimeStretchLimits.maximumFftWorkPerComposition}.`);
  }
  return plans;
}

function exactTimelineTimeInput(node: IRNode, name: string) {
  const value = node.inputs[name];
  if (value?.kind !== "quantity" || value.dimension !== "time" || value.unit !== "s") {
    fail(node, "CUT_AUDIO_TIME_STRETCH_GRAPH", `${name} must remain one exact Time quantity.`);
  }
  return value.magnitude;
}

function exactTimelineRateInput(node: IRNode) {
  const value = node.inputs.rate;
  if (value?.kind !== "quantity" || value.dimension !== "scalar"
    || compareRational(value.magnitude, zeroRational) <= 0) {
    fail(node, "CUT_AUDIO_TIME_STRETCH_GRAPH", "rate must remain one exact positive scalar.");
  }
  return value.magnitude;
}

function exactTimelineEvaluationSource(node: IRNode) {
  const value = node.inputs.evaluationSource;
  if (value?.kind !== "range" || !value.exclusive
    || value.start.kind !== "quantity" || value.start.dimension !== "time" || value.start.unit !== "s"
    || value.end.kind !== "quantity" || value.end.dimension !== "time" || value.end.unit !== "s") {
    fail(node, "CUT_AUDIO_TIME_STRETCH_GRAPH", "evaluationSource must remain one exact half-open Time range.");
  }
  const duration = subtractRational(value.end.magnitude, value.start.magnitude);
  if (compareRational(value.start.magnitude, zeroRational) < 0
    || compareRational(duration, zeroRational) <= 0) {
    fail(node, "CUT_AUDIO_TIME_STRETCH_VALUE_RANGE", "evaluationSource must be positive and cannot begin before zero.");
  }
  return Object.freeze({ start: value.start.magnitude, duration });
}

function exactAudioClipSource(node: IRNode) {
  const value = node.inputs.range;
  if (node.op !== "cut.audio.clip" || value?.kind !== "range" || !value.exclusive
    || value.start.kind !== "quantity" || value.start.dimension !== "time" || value.start.unit !== "s"
    || value.end.kind !== "quantity" || value.end.dimension !== "time" || value.end.unit !== "s") {
    fail(node, "CUT_AUDIO_TIME_STRETCH_GRAPH", "timeline external-handle evaluation requires one exact AudioClip source range.");
  }
  const duration = subtractRational(value.end.magnitude, value.start.magnitude);
  if (compareRational(value.start.magnitude, zeroRational) < 0
    || compareRational(duration, zeroRational) <= 0) {
    fail(node, "CUT_AUDIO_TIME_STRETCH_VALUE_RANGE", "AudioClip source range must be positive and cannot begin before zero.");
  }
  return Object.freeze({ start: value.start.magnitude, duration });
}

function directStructuralParents(ir: CutAVIR, nodeId: string) {
  return Object.values(ir.nodes).filter((candidate) => candidate.children.includes(nodeId));
}

function timelineTimeStretchEvaluation(
  ir: CutAVIR,
  composition: IRComposition,
  plan: ReferenceTimeStretchPlan,
): Readonly<{
  plan: ReferenceTimeStretchPlan;
  child: ReferenceTimelineTimeStretchChildEvaluation;
}> | undefined {
  if (!plan.audioRegionId) return undefined;
  const region = ir.nodes[plan.audioRegionId];
  if (!region) fail(ir.nodes[plan.nodeId]!, "CUT_AUDIO_TIME_STRETCH_GRAPH", "lost its owning AudioRegion.");
  const parents = directStructuralParents(ir, region.id);
  if (parents.length !== 1 || parents[0]?.op !== "cut.edit.timeline_audio_origin") return undefined;
  const origin = parents[0];
  if (origin.inputs.evaluationSource === undefined) return undefined;
  const originKind = origin.inputs.originKind;
  const evaluationPolicy = origin.inputs.evaluationPolicy;
  if (originKind?.kind !== "string" || originKind.value !== "processed-audio"
    || evaluationPolicy?.kind !== "string"
    || evaluationPolicy.value !== "full-declared-handle-domain-v1") {
    fail(origin, "CUT_AUDIO_TIME_STRETCH_GRAPH", "retimed timeline evaluation requires one processed full-declared-handle origin.");
  }
  const child = ir.nodes[plan.childId];
  if (!child || child.op !== "cut.audio.clip" || child.children.length !== 0) {
    fail(ir.nodes[plan.nodeId]!, "CUT_AUDIO_TIME_STRETCH_GRAPH", "retimed external handles require TimeStretch to be the innermost processor directly above one AudioClip.");
  }
  const source = exactAudioClipSource(child);
  const evaluationSource = exactTimelineEvaluationSource(origin);
  const rate = exactTimelineRateInput(origin);
  const originDuration = exactTimelineTimeInput(origin, "originDuration");
  const presentationZero = exactTimelineTimeInput(origin, "presentationZero");
  const expectedRate = divideRational(source.duration, originDuration);
  const presentationSourceZero = subtractRational(source.start, evaluationSource.start);
  if (compareRational(rate, expectedRate) !== 0
    || compareRational(presentationSourceZero, multiplyRational(presentationZero, rate)) !== 0
    || plan.sourceSamples !== exactSamples(child, source.duration, composition.sampleRate, "authored source duration")
    || plan.destinationSamples !== exactSamples(child, originDuration, composition.sampleRate, "authored destination duration")) {
    fail(origin, "CUT_AUDIO_TIME_STRETCH_GRAPH", "retimed timeline rate, presentation zero, and authored TimeStretch durations no longer agree.");
  }
  const evaluationEnd = addRational(evaluationSource.start, evaluationSource.duration);
  const sourceEnd = addRational(source.start, source.duration);
  if (compareRational(evaluationSource.start, source.start) > 0
    || compareRational(evaluationEnd, sourceEnd) < 0) {
    fail(origin, "CUT_AUDIO_TIME_STRETCH_VALUE_RANGE", "retimed evaluationSource no longer contains the complete authored AudioClip source.");
  }
  const sourceInput = child.inputs.source;
  const resource = sourceInput?.kind === "resource-ref" ? ir.resources[sourceInput.id] : undefined;
  const probe = resource?.metadata?.probe as LockedResourceProbe | undefined;
  const selected = probe?.kind === "media" ? probe.selected.audio : undefined;
  const stream = probe?.kind === "media" && selected
    ? probe.identity.streams.find((candidate) => candidate.type === "audio" && candidate.index === selected.streamIndex)
    : undefined;
  if (!selected || !stream?.sampleRate) {
    fail(child, "CUT_AUDIO_TIME_STRETCH_SOURCE", "retimed evaluation lost its lock-selected native audio stream.");
  }
  exactSamples(child, evaluationSource.start, stream.sampleRate, "evaluation source start");
  exactSamples(child, evaluationEnd, stream.sampleRate, "evaluation source end");

  const sourceSamples = exactSamples(origin, evaluationSource.duration, composition.sampleRate, "expanded sourceDuration");
  const destinationDuration = divideRational(evaluationSource.duration, rate);
  const destinationSamples = exactSamples(origin, destinationDuration, composition.sampleRate, "expanded duration");
  const durationRatio = destinationSamples / sourceSamples;
  if (!Number.isFinite(durationRatio)
    || durationRatio < referenceTimeStretchLimits.minimumDurationRatio
    || durationRatio > referenceTimeStretchLimits.maximumDurationRatio
    || sourceSamples > referenceTimeStretchLimits.maximumSourceSamplesPerNode
    || destinationSamples > referenceTimeStretchLimits.maximumDestinationSamplesPerNode) {
    fail(origin, "CUT_AUDIO_TIME_STRETCH_RESOURCE", "expanded retimed handle domain exceeds the TimeStretch duration or sample ceilings.");
  }
  const intermediateSamples = nearestPositiveInteger(destinationSamples * plan.pitchFactor);
  if (!Number.isSafeInteger(intermediateSamples)
    || intermediateSamples <= plan.windowSize
    || intermediateSamples > referenceTimeStretchLimits.maximumIntermediateSamplesPerNode) {
    fail(origin, "CUT_AUDIO_TIME_STRETCH_RESOURCE", "expanded retimed handle domain exceeds the TimeStretch intermediate ceiling.");
  }
  const frames = analysisFrameCount(sourceSamples, plan.windowSize, plan.analysisHop);
  const fftWork = frames * plan.windowSize * Math.log2(plan.windowSize) * 4;
  if (!Number.isSafeInteger(fftWork) || fftWork <= 0
    || fftWork > referenceTimeStretchLimits.maximumFftWorkPerComposition) {
    fail(origin, "CUT_AUDIO_TIME_STRETCH_RESOURCE", "expanded retimed handle domain exceeds the TimeStretch FFT-work ceiling.");
  }
  return Object.freeze({
    plan: {
      ...plan,
      placementSamples: 0,
      sourceSamples,
      destinationSamples,
      intermediateSamples,
      durationRatio,
      fftWork,
    },
    child: Object.freeze({
      version: 1,
      timelineOriginNodeId: origin.id,
      childNodeId: child.id,
      source: evaluationSource,
      presentationSourceZero,
      originSourceDuration: source.duration,
    }),
  });
}

function fft(real: Float64Array, imaginary: Float64Array, inverse: boolean) {
  const length = real.length;
  for (let index = 1, reversed = 0; index < length; index += 1) {
    let bit = length >> 1;
    for (; reversed & bit; bit >>= 1) reversed ^= bit;
    reversed ^= bit;
    if (index < reversed) {
      [real[index], real[reversed]] = [real[reversed], real[index]];
      [imaginary[index], imaginary[reversed]] = [imaginary[reversed], imaginary[index]];
    }
  }
  for (let size = 2; size <= length; size *= 2) {
    const angle = (inverse ? 2 : -2) * Math.PI / size;
    const stepReal = Math.cos(angle), stepImaginary = Math.sin(angle), half = size / 2;
    for (let start = 0; start < length; start += size) {
      let twiddleReal = 1, twiddleImaginary = 0;
      for (let offset = 0; offset < half; offset += 1) {
        const even = start + offset, odd = even + half;
        const oddReal = real[odd] * twiddleReal - imaginary[odd] * twiddleImaginary;
        const oddImaginary = real[odd] * twiddleImaginary + imaginary[odd] * twiddleReal;
        real[odd] = real[even] - oddReal;
        imaginary[odd] = imaginary[even] - oddImaginary;
        real[even] += oddReal;
        imaginary[even] += oddImaginary;
        const nextReal = twiddleReal * stepReal - twiddleImaginary * stepImaginary;
        twiddleImaginary = twiddleReal * stepImaginary + twiddleImaginary * stepReal;
        twiddleReal = nextReal;
      }
    }
  }
  if (inverse) for (let index = 0; index < length; index += 1) {
    real[index] /= length;
    imaginary[index] /= length;
  }
}

function frameStarts(samples: number, windowSize: number, hop: number) {
  const last = samples - windowSize, starts: number[] = [];
  for (let start = 0; start <= last; start += hop) starts.push(start);
  if (starts.at(-1) !== last) starts.push(last);
  return starts;
}

function principalPhase(value: number) {
  return value - 2 * Math.PI * Math.round(value / (2 * Math.PI));
}

function phaseVocoderChannel(input: Float64Array, outputSamples: number, windowSize: number, analysisHop: number) {
  if (input.length === outputSamples) return Float64Array.from(input);
  const inputStarts = frameStarts(input.length, windowSize, analysisHop);
  const scale = (outputSamples - windowSize) / (input.length - windowSize);
  const outputStarts = inputStarts.map((start, index) => index === inputStarts.length - 1 ? outputSamples - windowSize : Math.floor(start * scale + 0.5));
  const output = new Float64Array(outputSamples), normalization = new Float64Array(outputSamples);
  const window = Float64Array.from({ length: windowSize }, (_, index) => Math.sin(Math.PI * (index + 0.5) / windowSize));
  const bins = windowSize / 2 + 1, previousPhase = new Float64Array(bins), synthesisPhase = new Float64Array(bins);
  let previousInputStart = 0, previousOutputStart = 0;

  for (let frame = 0; frame < inputStarts.length; frame += 1) {
    const inputStart = inputStarts[frame], outputStart = outputStarts[frame];
    const real = new Float64Array(windowSize), imaginary = new Float64Array(windowSize);
    for (let index = 0; index < windowSize; index += 1) real[index] = input[inputStart + index] * window[index];
    fft(real, imaginary, false);
    const inputDelta = frame === 0 ? 0 : inputStart - previousInputStart;
    const outputDelta = frame === 0 ? 0 : outputStart - previousOutputStart;
    for (let bin = 0; bin < bins; bin += 1) {
      const magnitude = Math.hypot(real[bin], imaginary[bin]), phase = Math.atan2(imaginary[bin], real[bin]);
      if (frame === 0) synthesisPhase[bin] = phase;
      else {
        const omega = 2 * Math.PI * bin / windowSize;
        const deviation = principalPhase(phase - previousPhase[bin] - omega * inputDelta);
        synthesisPhase[bin] += (omega + deviation / inputDelta) * outputDelta;
      }
      previousPhase[bin] = phase;
      real[bin] = magnitude * Math.cos(synthesisPhase[bin]);
      imaginary[bin] = magnitude * Math.sin(synthesisPhase[bin]);
      if (bin > 0 && bin < windowSize / 2) {
        real[windowSize - bin] = real[bin];
        imaginary[windowSize - bin] = -imaginary[bin];
      }
    }
    imaginary[0] = 0;
    imaginary[windowSize / 2] = 0;
    fft(real, imaginary, true);
    for (let index = 0; index < windowSize; index += 1) {
      const destination = outputStart + index, weight = window[index];
      output[destination] += real[index] * weight;
      normalization[destination] += weight * weight;
    }
    previousInputStart = inputStart;
    previousOutputStart = outputStart;
  }
  for (let index = 0; index < output.length; index += 1) output[index] = normalization[index] > 1e-12 ? output[index] / normalization[index] : 0;
  return output;
}

function resampleLinear(input: Float64Array, outputSamples: number) {
  if (input.length === outputSamples) return input;
  const output = new Float64Array(outputSamples), ratio = input.length / outputSamples;
  for (let index = 0; index < outputSamples; index += 1) {
    const position = Math.min(input.length - 1, index * ratio), lower = Math.floor(position), upper = Math.min(input.length - 1, lower + 1), fraction = position - lower;
    output[index] = input[lower] + (input[upper] - input[lower]) * fraction;
  }
  return output;
}

export function processReferenceTimeStretch(
  left: Float64Array,
  right: Float64Array,
  plan: ReferenceTimeStretchPlan,
) {
  if (left.length !== plan.sourceSamples || right.length !== plan.sourceSamples) throw new Error(`TimeStretch ${plan.nodeId} received an unexpected source sample count.`);
  if (plan.sourceSamples === plan.destinationSamples && plan.pitchSemitones === 0) {
    return { left: Float64Array.from(left), right: Float64Array.from(right) };
  }
  const intermediateLeft = phaseVocoderChannel(left, plan.intermediateSamples, plan.windowSize, plan.analysisHop);
  const intermediateRight = phaseVocoderChannel(right, plan.intermediateSamples, plan.windowSize, plan.analysisHop);
  return {
    left: resampleLinear(intermediateLeft, plan.destinationSamples),
    right: resampleLinear(intermediateRight, plan.destinationSamples),
  };
}

function decodeRawStereoF32Le(buffer: Buffer, plan: ReferenceTimeStretchPlan, node: IRNode) {
  const expectedBytes = plan.sourceSamples * 8;
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) {
    fail(node, "CUT_AUDIO_TIME_STRETCH_RESOURCE", `child raw stereo f32le byte count is unsafe for ${plan.sourceSamples} frames.`);
  }
  if (buffer.byteLength !== expectedBytes) {
    fail(node, "CUT_AUDIO_TIME_STRETCH_SOURCE", `child raw stereo f32le must contain exactly ${expectedBytes} bytes for ${plan.sourceSamples} frames at ${plan.sampleRate} Hz; observed ${buffer.byteLength}.`);
  }
  const left = new Float64Array(plan.sourceSamples), right = new Float64Array(plan.sourceSamples);
  for (let frame = 0; frame < plan.sourceSamples; frame += 1) for (const channel of [0, 1] as const) {
    const value = buffer.readFloatLE(frame * 8 + channel * 4);
    if (!Number.isFinite(value)) {
      const label = Number.isNaN(value) ? "NaN" : value > 0 ? "+Infinity" : "-Infinity";
      fail(node, "CUT_AUDIO_TIME_STRETCH_SOURCE", `child raw stereo f32le sample at frame ${frame}, ${channel === 0 ? "left" : "right"} channel is ${label}; TimeStretch requires finite intermediate samples.`);
    }
    (channel === 0 ? left : right)[frame] = value;
  }
  return { left, right };
}

function encodeRawStereoF32Le(samples: { left: Float64Array; right: Float64Array }, plan: ReferenceTimeStretchPlan, node: IRNode) {
  if (samples.left.length !== plan.destinationSamples || samples.right.length !== plan.destinationSamples) {
    fail(node, "CUT_AUDIO_TIME_STRETCH_SOURCE", `DSP output must contain exactly ${plan.destinationSamples} frames per channel; observed left=${samples.left.length}, right=${samples.right.length}.`);
  }
  const frames = samples.left.length, dataBytes = frames * 8;
  if (!Number.isSafeInteger(dataBytes) || dataBytes < 0) fail(node, "CUT_AUDIO_TIME_STRETCH_RESOURCE", "DSP raw stereo f32le output exceeds the safe byte-count limit.");
  const buffer = Buffer.allocUnsafe(dataBytes);
  for (let frame = 0; frame < frames; frame += 1) {
    for (const channel of [0, 1] as const) {
      const sample = (channel === 0 ? samples.left : samples.right)[frame];
      const encoded = Math.fround(sample);
      if (!Number.isFinite(sample) || !Number.isFinite(encoded)) {
        fail(node, "CUT_AUDIO_TIME_STRETCH_SOURCE", `DSP output sample at frame ${frame}, ${channel === 0 ? "left" : "right"} channel cannot be represented as finite f32le.`);
      }
      buffer.writeFloatLE(encoded, frame * 8 + channel * 4);
    }
  }
  return buffer;
}

export async function prepareReferenceTimeStretchSources(
  ir: CutAVIR,
  composition: IRComposition,
  rootIds: readonly string[],
  renderChild: RenderTimeStretchChild,
): Promise<ReferenceTimeStretchPreparation> {
  const ids = reachableReferenceTimeStretchNodeIds(ir, rootIds);
  if (!ids.length) return { sources: new Map(), cleanup: async () => undefined };
  const authoredPlans = validateReferenceTimeStretchPlans(ir, composition, ids);
  const plans = authoredPlans.map((plan) => {
    const timeline = timelineTimeStretchEvaluation(ir, composition, plan);
    return timeline ?? Object.freeze({ plan, child: undefined });
  });
  const expandedOutputSamples = plans.reduce((sum, entry) => sum + entry.plan.destinationSamples, 0);
  const expandedFftWork = plans.reduce((sum, entry) => sum + entry.plan.fftWork, 0);
  if (!Number.isSafeInteger(expandedOutputSamples)
    || expandedOutputSamples > referenceTimeStretchLimits.maximumTotalDestinationSamples
    || !Number.isSafeInteger(expandedFftWork)
    || expandedFftWork > referenceTimeStretchLimits.maximumFftWorkPerComposition) {
    const owner = ir.nodes[ids[0]]!;
    fail(owner, "CUT_AUDIO_TIME_STRETCH_RESOURCE", "expanded timeline handle evaluation exceeds the aggregate TimeStretch sample or FFT-work ceiling.");
  }
  const directory = await mkdtemp(resolve(tmpdir(), "cut-time-stretch-")), sources = new Map<string, ReferenceTimeStretchSource>();
  try {
    for (const [index, entry] of plans.entries()) {
      const { plan, child } = entry;
      const prefix = `stretch-${String(index).padStart(3, "0")}`;
      const childPath = resolve(directory, `${prefix}-child.f32le`), outputPath = resolve(directory, `${prefix}.f32le`);
      await renderChild(
        plan.childId,
        childPath,
        plan.placementSamples,
        plan.placementSamples + plan.sourceSamples,
        plan.audioRegionId !== undefined,
        child,
      );
      const node = ir.nodes[plan.nodeId];
      if (!node) throw new Error(`CUT TimeStretch preparation references missing node ${plan.nodeId}.`);
      const expectedChildBytes = plan.sourceSamples * 8;
      let observedChildBytes: number;
      try {
        observedChildBytes = (await stat(childPath)).size;
      } catch (error) {
        fail(node, "CUT_AUDIO_TIME_STRETCH_SOURCE", `child raw stereo f32le is missing or unreadable (${boundedIoCode(error)}).`);
      }
      if (observedChildBytes !== expectedChildBytes) {
        fail(node, "CUT_AUDIO_TIME_STRETCH_SOURCE", `child raw stereo f32le must contain exactly ${expectedChildBytes} bytes for ${plan.sourceSamples} frames at ${plan.sampleRate} Hz; observed ${observedChildBytes}.`);
      }
      let childBytes: Buffer;
      try {
        childBytes = await readFile(childPath);
      } catch (error) {
        fail(node, "CUT_AUDIO_TIME_STRETCH_SOURCE", `child raw stereo f32le could not be read after validation (${boundedIoCode(error)}).`);
      }
      const decoded = decodeRawStereoF32Le(childBytes, plan, node);
      const processed = processReferenceTimeStretch(decoded.left, decoded.right, plan);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, encodeRawStereoF32Le(processed, plan, node), { flag: "wx" });
      sources.set(plan.nodeId, {
        path: outputPath,
        format: "raw-stereo-f32le",
        channels: 2,
        sampleRate: plan.sampleRate,
        placementSamples: plan.placementSamples,
        renderedSamples: plan.destinationSamples,
        ...(child ? { timelineOriginNodeId: child.timelineOriginNodeId } : {}),
      });
    }
    return { sources, cleanup: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
